/**
 * Stop Loss and Target Mapper for the Isagi Engine Signal Bot.
 *
 * Calculates precise stop-loss levels based on wick clusters identified
 * within a lookback window of candles. Uses zone classification to determine
 * the appropriate buffer (1 pip for Chop_Zone, 2 pips for Expansion_Zone).
 *
 * Also handles target projection into open liquidity pockets, adjusting
 * targets before volume blocks, and calculating TP1/TP2 with validation.
 *
 * For XAU/USD: 1 pip = 0.1 price units, so 5 pips = 0.5 price units.
 */

import type { Candle } from '../types/candle.js';
import type { RawSignal } from '../types/signal.js';
import type {
  LiquidityPocket,
  WickCluster,
  ZoneClassification,
} from '../types/zone.js';

/** 1 pip in XAU/USD price units */
const PIP = 0.1;

/** Minimum liquidity pocket width in pips */
const MIN_POCKET_WIDTH_PIPS = 5;

/** Minimum reward-to-risk ratio for signal validity */
const MIN_REWARD_RISK = 1.5;

/** Volume block threshold multiplier (150% of 20-period average) */
const VOLUME_BLOCK_MULTIPLIER = 1.5;

/** TP1 distance fraction (35% of distance to TP2) */
const TP1_FRACTION = 0.35;

/** Target levels computed for a signal */
export interface TargetLevels {
  rUnit: number;
  tp1: number;
  tp2: number;
  isValid: boolean;
}

export interface StopLossTargetMapper {
  calculateStopLoss(
    signal: RawSignal,
    recentCandles: Candle[],
    zoneType: ZoneClassification,
  ): number;
  findWickCluster(
    candles: Candle[],
    direction: 'high' | 'low',
    lookback: number,
  ): WickCluster | null;
  findLiquidityPocket(
    candles: Candle[],
    direction: 'up' | 'down',
    avgVolume: number,
  ): LiquidityPocket | null;
  calculateTargets(
    entry: number,
    stopLoss: number,
    zoneTargetR: number,
    candles: Candle[],
    avgVolume: number,
  ): TargetLevels;
}

/**
 * Creates a StopLossTargetMapper instance.
 */
export function createStopLossTargetMapper(): StopLossTargetMapper {
  return {
    calculateStopLoss(
      signal: RawSignal,
      recentCandles: Candle[],
      zoneType: ZoneClassification,
    ): number {
      const direction = signal.direction === 'short' ? 'high' : 'low';
      const cluster = this.findWickCluster(recentCandles, direction, 20);

      if (!cluster) {
        // Fallback: use extreme of available candles within lookback
        const lookbackCandles = recentCandles.slice(-20);
        if (direction === 'high') {
          const highestHigh = Math.max(...lookbackCandles.map((c) => c.high));
          const buffer = zoneType === 'chop_zone' ? PIP : 2 * PIP;
          return highestHigh + buffer;
        } else {
          const lowestLow = Math.min(...lookbackCandles.map((c) => c.low));
          const buffer = zoneType === 'chop_zone' ? PIP : 2 * PIP;
          return lowestLow - buffer;
        }
      }

      const buffer = zoneType === 'chop_zone' ? PIP : 2 * PIP;

      if (signal.direction === 'short') {
        // SL above the highest wick cluster of swing high
        return cluster.price + buffer;
      } else {
        // SL below the lowest wick cluster of swing low
        return cluster.price - buffer;
      }
    },

    findWickCluster(
      candles: Candle[],
      direction: 'high' | 'low',
      lookback: number,
    ): WickCluster | null {
      // Take the most recent `lookback` candles
      const relevantCandles = candles.slice(-lookback);

      if (relevantCandles.length === 0) {
        return null;
      }

      // Collect wick values based on direction
      // For shorts (direction='high'): use candle high values (top wicks)
      // For longs (direction='low'): use candle low values (bottom wicks)
      const wickValues: number[] = relevantCandles.map((c) =>
        direction === 'high' ? c.high : c.low,
      );

      // Find all clusters of 3+ wicks within a 1-pip (0.1) vertical range
      const clusters: WickCluster[] = [];

      // Sort wick values for efficient cluster detection
      const sortedWicks = [...wickValues].sort((a, b) => a - b);

      // Use a sliding window approach on sorted values to find clusters.
      // For each starting position, find the maximum window of wicks within 1 pip.
      const usedStartIndices = new Set<number>();

      for (let i = 0; i < sortedWicks.length; i++) {
        if (usedStartIndices.has(i)) continue;

        const windowStart = sortedWicks[i];
        const windowEnd = windowStart + PIP;

        // Count wicks within the 1-pip range starting from this wick
        let count = 0;
        let maxInWindow = windowStart;
        let lastJ = i;

        for (let j = i; j < sortedWicks.length; j++) {
          if (sortedWicks[j] <= windowEnd) {
            count++;
            maxInWindow = sortedWicks[j];
            lastJ = j;
          } else {
            break;
          }
        }

        if (count >= 3) {
          const range = maxInWindow - windowStart;
          // Calculate the price level as the midpoint of the cluster range
          const price = windowStart + range / 2;

          clusters.push({
            price,
            wickCount: count,
            range,
          });

          // Mark all indices in this cluster as used to avoid sub-cluster duplicates
          for (let k = i; k <= lastJ; k++) {
            usedStartIndices.add(k);
          }
        }
      }

      if (clusters.length === 0) {
        return null;
      }

      // If multiple clusters exist, use the one closest to the swing extreme:
      // - Highest for shorts (direction='high')
      // - Lowest for longs (direction='low')
      if (direction === 'high') {
        // For shorts: pick cluster with highest price (closest to swing high)
        return clusters.reduce((best, current) =>
          current.price > best.price ? current : best,
        );
      } else {
        // For longs: pick cluster with lowest price (closest to swing low)
        return clusters.reduce((best, current) =>
          current.price < best.price ? current : best,
        );
      }
    },

    /**
     * Finds the nearest open liquidity pocket in the given direction.
     *
     * A liquidity pocket is a contiguous price zone of at least 5 pips width (0.5 price units)
     * where no candle has volume exceeding 150% of the average volume.
     *
     * The function analyzes candle price ranges to identify zones without volume blocks.
     *
     * @param candles - Recent candle history to analyze
     * @param direction - 'up' for longs (find pocket above), 'down' for shorts (find pocket below)
     * @param avgVolume - 20-period average volume for comparison
     * @returns The nearest liquidity pocket or null if none found
     */
    findLiquidityPocket(
      candles: Candle[],
      direction: 'up' | 'down',
      avgVolume: number,
    ): LiquidityPocket | null {
      if (candles.length === 0 || avgVolume <= 0) {
        return null;
      }

      const volumeBlockThreshold = avgVolume * VOLUME_BLOCK_MULTIPLIER;

      // Identify volume blocks: candles where volume exceeds 150% of average
      const volumeBlocks: Array<{ low: number; high: number }> = [];
      for (const candle of candles) {
        if (candle.volume > volumeBlockThreshold) {
          volumeBlocks.push({ low: candle.low, high: candle.high });
        }
      }

      // Determine the overall price range from candles
      const overallLow = Math.min(...candles.map((c) => c.low));
      const overallHigh = Math.max(...candles.map((c) => c.high));

      return findPocketInDirection(
        volumeBlocks,
        overallLow,
        overallHigh,
        direction,
      );
    },

    /**
     * Calculates target levels (TP1, TP2) with volume block adjustment and validation.
     *
     * Steps:
     * 1. Calculate R_Unit = |entry - stopLoss|
     * 2. Project initial target at zoneTargetR × R_Unit in signal direction
     * 3. Check for volume blocks between entry and initial target
     * 4. If volume block found, adjust target to nearest pocket before the block
     * 5. TP2 = adjusted target
     * 6. TP1 = entry + 0.35 × (TP2 - entry) for longs, entry - 0.35 × (entry - TP2) for shorts
     * 7. If |TP2 - entry| < 1.5 × rUnit → isValid = false
     *
     * @param entry - Entry price
     * @param stopLoss - Stop-loss price
     * @param zoneTargetR - Target R-multiple based on zone (1.5R, 2.0R, or 3.0R)
     * @param candles - Recent candle history for volume block detection
     * @param avgVolume - 20-period average volume
     * @returns Target levels with validity flag
     */
    calculateTargets(
      entry: number,
      stopLoss: number,
      zoneTargetR: number,
      candles: Candle[],
      avgVolume: number,
    ): TargetLevels {
      // Step 1: Calculate R_Unit
      const rUnit = Math.abs(entry - stopLoss);

      // Determine direction based on entry vs stop-loss
      const isLong = entry > stopLoss;

      // Step 2: Project initial target
      const initialTargetDistance = zoneTargetR * rUnit;
      const initialTarget = isLong
        ? entry + initialTargetDistance
        : entry - initialTargetDistance;

      // Step 3 & 4: Find volume blocks and adjust target
      let adjustedTarget = initialTarget;

      if (candles.length > 0 && avgVolume > 0) {
        const volumeBlockThreshold = avgVolume * VOLUME_BLOCK_MULTIPLIER;

        // Find the first volume block between entry and the projected target
        const firstBlockPrice = findFirstVolumeBlockBetween(
          candles,
          entry,
          initialTarget,
          volumeBlockThreshold,
          isLong,
        );

        if (firstBlockPrice !== null) {
          // Adjust target to the nearest open liquidity pocket before the block
          const direction = isLong ? 'up' : 'down';

          // Get candles between entry and the block for pocket detection
          const pocketCandles = filterCandlesBetween(
            candles,
            entry,
            firstBlockPrice,
            isLong,
          );

          const pocket = this.findLiquidityPocket(
            pocketCandles.length > 0 ? pocketCandles : candles,
            direction,
            avgVolume,
          );

          if (pocket) {
            // Place target at the far edge of the pocket (closer to initial target direction)
            if (isLong) {
              // Use the endPrice (upper edge) of pocket, but must be before block
              const pocketEdge = Math.min(pocket.endPrice, firstBlockPrice);
              if (pocketEdge > entry) {
                adjustedTarget = pocketEdge;
              } else {
                adjustedTarget = firstBlockPrice - PIP;
              }
            } else {
              // Use the startPrice (lower edge) of pocket, but must be before block
              const pocketEdge = Math.max(pocket.startPrice, firstBlockPrice);
              if (pocketEdge < entry) {
                adjustedTarget = pocketEdge;
              } else {
                adjustedTarget = firstBlockPrice + PIP;
              }
            }
          } else {
            // No pocket found; place target just before the volume block
            if (isLong) {
              adjustedTarget = firstBlockPrice - PIP;
            } else {
              adjustedTarget = firstBlockPrice + PIP;
            }
          }
        }
      }

      // Step 5: TP2 = adjusted target
      const tp2 = adjustedTarget;

      // Step 6: Calculate TP1 (35% of distance from entry to TP2)
      const tp1 = isLong
        ? entry + TP1_FRACTION * (tp2 - entry)
        : entry - TP1_FRACTION * (entry - tp2);

      // Step 7: Validate minimum reward-to-risk
      const rewardDistance = Math.abs(tp2 - entry);
      const isValid = rewardDistance >= MIN_REWARD_RISK * rUnit;

      return {
        rUnit,
        tp1,
        tp2,
        isValid,
      };
    },
  };
}

/**
 * Finds liquidity pockets (gaps between volume blocks) in the specified direction.
 *
 * Merges overlapping volume blocks and identifies gaps of >= 5 pips width
 * between them. Returns the nearest pocket in the given direction.
 *
 * @param volumeBlocks - Price ranges of volume blocks
 * @param overallLow - Lowest price in the candle data
 * @param overallHigh - Highest price in the candle data
 * @param direction - 'up' or 'down'
 * @returns Nearest liquidity pocket or null
 */
function findPocketInDirection(
  volumeBlocks: Array<{ low: number; high: number }>,
  overallLow: number,
  overallHigh: number,
  direction: 'up' | 'down',
): LiquidityPocket | null {
  if (volumeBlocks.length === 0) {
    // No volume blocks at all: entire price range is an open pocket
    const widthPips = (overallHigh - overallLow) / PIP;
    if (widthPips >= MIN_POCKET_WIDTH_PIPS) {
      return {
        startPrice: overallLow,
        endPrice: overallHigh,
        width: widthPips,
      };
    }
    return null;
  }

  // Merge overlapping/adjacent volume blocks to create solid block zones
  const mergedBlocks = mergeVolumeBlocks(volumeBlocks);

  // Find gaps between merged blocks (these are potential liquidity pockets)
  const pockets: LiquidityPocket[] = [];

  // Check gap below first block
  if (mergedBlocks[0].low > overallLow) {
    const gapWidthPips = (mergedBlocks[0].low - overallLow) / PIP;
    if (gapWidthPips >= MIN_POCKET_WIDTH_PIPS) {
      pockets.push({
        startPrice: overallLow,
        endPrice: mergedBlocks[0].low,
        width: gapWidthPips,
      });
    }
  }

  // Check gaps between blocks
  for (let i = 0; i < mergedBlocks.length - 1; i++) {
    const gapStart = mergedBlocks[i].high;
    const gapEnd = mergedBlocks[i + 1].low;
    const gapWidthPips = (gapEnd - gapStart) / PIP;
    if (gapWidthPips >= MIN_POCKET_WIDTH_PIPS) {
      pockets.push({
        startPrice: gapStart,
        endPrice: gapEnd,
        width: gapWidthPips,
      });
    }
  }

  // Check gap above last block
  const lastBlock = mergedBlocks[mergedBlocks.length - 1];
  if (lastBlock.high < overallHigh) {
    const gapWidthPips = (overallHigh - lastBlock.high) / PIP;
    if (gapWidthPips >= MIN_POCKET_WIDTH_PIPS) {
      pockets.push({
        startPrice: lastBlock.high,
        endPrice: overallHigh,
        width: gapWidthPips,
      });
    }
  }

  if (pockets.length === 0) return null;

  if (direction === 'up') {
    // Return the first (lowest start price) pocket for 'up' direction
    return pockets[0];
  } else {
    // Return the last (highest start price) pocket for 'down' direction
    return pockets[pockets.length - 1];
  }
}

/**
 * Merges overlapping or adjacent volume blocks into contiguous zones.
 * Returns blocks sorted by low price ascending.
 */
function mergeVolumeBlocks(
  blocks: Array<{ low: number; high: number }>,
): Array<{ low: number; high: number }> {
  if (blocks.length === 0) return [];

  const sorted = [...blocks].sort((a, b) => a.low - b.low);
  const merged: Array<{ low: number; high: number }> = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];

    if (current.low <= last.high) {
      // Overlapping or adjacent: merge
      last.high = Math.max(last.high, current.high);
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

/**
 * Finds the first volume block between entry and target in the signal direction.
 *
 * @returns The price level of the near edge of the first volume block, or null if none found
 */
function findFirstVolumeBlockBetween(
  candles: Candle[],
  entry: number,
  target: number,
  volumeBlockThreshold: number,
  isLong: boolean,
): number | null {
  // Find candles with volume exceeding threshold between entry and target
  const blockCandles: Candle[] = [];

  for (const candle of candles) {
    if (candle.volume <= volumeBlockThreshold) continue;

    if (isLong) {
      // For longs: look for blocks above entry and before target
      if (candle.low > entry && candle.low < target) {
        blockCandles.push(candle);
      }
    } else {
      // For shorts: look for blocks below entry and above target
      if (candle.high < entry && candle.high > target) {
        blockCandles.push(candle);
      }
    }
  }

  if (blockCandles.length === 0) return null;

  if (isLong) {
    // Return the nearest (lowest low) block above entry
    const nearest = blockCandles.reduce((min, c) =>
      c.low < min.low ? c : min,
    );
    return nearest.low;
  } else {
    // Return the nearest (highest high) block below entry
    const nearest = blockCandles.reduce((max, c) =>
      c.high > max.high ? c : max,
    );
    return nearest.high;
  }
}

/**
 * Filters candles whose price range falls between entry and a boundary price.
 */
function filterCandlesBetween(
  candles: Candle[],
  entry: number,
  boundary: number,
  isLong: boolean,
): Candle[] {
  return candles.filter((c) => {
    if (isLong) {
      // Candles with any part of their range between entry and boundary (above entry)
      return c.high > entry && c.low < boundary;
    } else {
      // Candles with any part of their range between boundary and entry (below entry)
      return c.low < entry && c.high > boundary;
    }
  });
}
