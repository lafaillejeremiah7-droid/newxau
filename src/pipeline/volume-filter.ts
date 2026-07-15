/**
 * Volume Filter and Zone Classifier for the Isagi Engine Signal Bot.
 *
 * Rejects signals when current M5 volume is below the 20-period SMA,
 * and classifies the market as Expansion_Zone or Chop_Zone based on
 * the volume trend of the last 5 closed M5 candles.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5
 */

import type { ZoneClassification } from '../types/zone.js';

/** Result of the volume filter evaluation */
export interface VolumeFilterResult {
  passed: boolean;
  rejected: boolean;
  rejectionReason: string | null;
  zoneClassification: ZoneClassification;
  targetRMultiple: number; // 1.5, 2.0, or 3.0
  partialProfitAt: number | null; // 0.35 for expansion, null for chop
}

/** Volume Filter interface */
export interface VolumeFilter {
  evaluate(
    currentVolume: number,
    sma20Volume: number,
    lastFiveVolumes: number[],
  ): VolumeFilterResult;
}

/**
 * Counts the number of sequentially increasing consecutive pairs
 * in the given volume array.
 *
 * "Sequentially increasing" means: looking at consecutive pairs,
 * count pairs where volume[i+1] > volume[i].
 */
function countIncreasingPairs(volumes: number[]): number {
  let count = 0;
  for (let i = 0; i < volumes.length - 1; i++) {
    if (volumes[i + 1] > volumes[i]) {
      count++;
    }
  }
  return count;
}

/**
 * Counts the number of sequentially decreasing consecutive pairs
 * in the given volume array.
 *
 * "Sequentially decreasing" means: looking at consecutive pairs,
 * count pairs where volume[i+1] < volume[i].
 */
function countDecreasingPairs(volumes: number[]): number {
  let count = 0;
  for (let i = 0; i < volumes.length - 1; i++) {
    if (volumes[i + 1] < volumes[i]) {
      count++;
    }
  }
  return count;
}

/**
 * Creates a VolumeFilter instance.
 *
 * Logic:
 * 1. If currentVolume < sma20Volume → reject (passed=false, reason="Volume below 20-period SMA")
 * 2. If volume passed AND ≥3 of last 5 volumes are sequentially increasing → Expansion_Zone (3.0R, partial at 35%)
 * 3. If volume passed AND ≥3 of last 5 volumes are sequentially decreasing → Chop_Zone (1.5R, full exit)
 * 4. If volume passed AND neither condition met → Chop_Zone default (2.0R, full exit)
 */
export function createVolumeFilter(): VolumeFilter {
  return {
    evaluate(
      currentVolume: number,
      sma20Volume: number,
      lastFiveVolumes: number[],
    ): VolumeFilterResult {
      // Step 1: Reject if current volume is below the 20-period SMA
      if (currentVolume < sma20Volume) {
        return {
          passed: false,
          rejected: true,
          rejectionReason: 'Volume below 20-period SMA',
          zoneClassification: 'chop_zone',
          targetRMultiple: 2.0,
          partialProfitAt: null,
        };
      }

      // Volume passed - classify the zone based on last 5 candle volumes
      // With 5 candles, there are 4 consecutive pairs to evaluate
      const increasingPairs = countIncreasingPairs(lastFiveVolumes);
      const decreasingPairs = countDecreasingPairs(lastFiveVolumes);

      // Step 2: Expansion_Zone - ≥3 pairs show sequentially increasing volume
      if (increasingPairs >= 3) {
        return {
          passed: true,
          rejected: false,
          rejectionReason: null,
          zoneClassification: 'expansion_zone',
          targetRMultiple: 3.0,
          partialProfitAt: 0.35,
        };
      }

      // Step 3: Chop_Zone - ≥3 pairs show sequentially decreasing volume
      if (decreasingPairs >= 3) {
        return {
          passed: true,
          rejected: false,
          rejectionReason: null,
          zoneClassification: 'chop_zone',
          targetRMultiple: 1.5,
          partialProfitAt: null,
        };
      }

      // Step 4: Default - neither condition met → Chop_Zone, 2.0R, full exit
      return {
        passed: true,
        rejected: false,
        rejectionReason: null,
        zoneClassification: 'chop_zone',
        targetRMultiple: 2.0,
        partialProfitAt: null,
      };
    },
  };
}
