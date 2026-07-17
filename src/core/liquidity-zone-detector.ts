/**
 * Liquidity Zone Detector for the Isagi Engine Signal Bot.
 *
 * Identifies H1 and M15 structural highs and lows as liquidity zones.
 * A structural high is a candle whose high is higher than the previous and next candle highs (swing high).
 * A structural low is a candle whose low is lower than the previous and next candle lows (swing low).
 *
 * Zones are defined by the candle's own high-low range (configurable approach).
 * Maintains the last N zones per timeframe (default 10) and removes older ones.
 */

import { Candle } from '../types/candle.js';
import { LiquidityZone } from '../types/zone.js';

/** Configuration for the liquidity zone detector */
export interface LiquidityZoneDetectorConfig {
  /** Maximum number of zones to maintain per timeframe */
  maxZonesPerTimeframe: number;
}

const DEFAULT_CONFIG: LiquidityZoneDetectorConfig = {
  maxZonesPerTimeframe: 10,
};

/** Interface for the Liquidity Zone Detector */
export interface ILiquidityZoneDetector {
  updateZones(candle: Candle): void;
  getActiveZones(): LiquidityZone[];
  isWithinZone(price: number): LiquidityZone | null;
}

/**
 * LiquidityZoneDetector identifies H1 and M15 structural highs/lows
 * and maintains active liquidity zones based on swing points.
 */
export class LiquidityZoneDetector implements ILiquidityZoneDetector {
  private readonly config: LiquidityZoneDetectorConfig;

  /** Rolling buffer of recent candles per timeframe for swing detection */
  private h1Candles: Candle[] = [];
  private m15Candles: Candle[] = [];

  /** Active zones per timeframe */
  private h1Zones: LiquidityZone[] = [];
  private m15Zones: LiquidityZone[] = [];

  /** Counter for generating unique zone IDs */
  private zoneIdCounter = 0;

  constructor(config: Partial<LiquidityZoneDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Process a new candle and update zones if applicable.
   * Only H1 and M15 candles are processed; M1 and M5 are ignored.
   */
  updateZones(candle: Candle): void {
    if (candle.timeframe === 'H1') {
      this.h1Candles.push(candle);
      this.detectSwingPoints(this.h1Candles, 'H1');
    } else if (candle.timeframe === 'M15') {
      this.m15Candles.push(candle);
      this.detectSwingPoints(this.m15Candles, 'M15');
    }
    // Ignore M1 and M5 candles
  }

  /**
   * Returns all currently active zones (both H1 and M15).
   */
  getActiveZones(): LiquidityZone[] {
    return [...this.h1Zones, ...this.m15Zones];
  }

  /**
   * Checks if a given price falls within any active zone.
   * Returns the first matching zone, or null if no zone contains the price.
   */
  isWithinZone(price: number): LiquidityZone | null {
    const allZones = this.getActiveZones();
    for (const zone of allZones) {
      if (price >= zone.lowerBoundary && price <= zone.upperBoundary) {
        return zone;
      }
    }
    return null;
  }

  /**
   * Detect swing highs and swing lows from the candle buffer.
   * A swing high: candle[i].high > candle[i-1].high AND candle[i].high > candle[i+1].high
   * A swing low: candle[i].low < candle[i-1].low AND candle[i].low < candle[i+1].low
   *
   * We check the second-to-last candle (needs one candle after it to confirm).
   */
  private detectSwingPoints(
    candles: Candle[],
    timeframe: 'H1' | 'M15'
  ): void {
    // Need at least 3 candles to detect a swing point
    if (candles.length < 3) {
      return;
    }

    // Check the candle at index length-2 (second to last) — it now has both a left and right neighbor
    const idx = candles.length - 2;
    const prev = candles[idx - 1];
    const current = candles[idx];
    const next = candles[idx + 1];

    // Check for structural high (swing high)
    if (current.high > prev.high && current.high > next.high) {
      const zone = this.createZone(current, timeframe, 'structural_high');
      this.addZone(zone, timeframe);
    }

    // Check for structural low (swing low)
    if (current.low < prev.low && current.low < next.low) {
      const zone = this.createZone(current, timeframe, 'structural_low');
      this.addZone(zone, timeframe);
    }
  }

  /**
   * Create a LiquidityZone from a swing candle.
   * Zone boundaries are defined by the candle's high-low range.
   */
  private createZone(
    candle: Candle,
    timeframe: 'H1' | 'M15',
    type: 'structural_high' | 'structural_low'
  ): LiquidityZone {
    this.zoneIdCounter++;

    return {
      id: `zone-${timeframe}-${type}-${this.zoneIdCounter}`,
      timeframe,
      type,
      upperBoundary: candle.high,
      lowerBoundary: candle.low,
      identifiedAt: candle.timestamp,
    };
  }

  /**
   * Add a zone to the appropriate timeframe list, maintaining max capacity.
   * Removes the oldest zone if the list exceeds maxZonesPerTimeframe.
   */
  private addZone(zone: LiquidityZone, timeframe: 'H1' | 'M15'): void {
    const zones = timeframe === 'H1' ? this.h1Zones : this.m15Zones;
    zones.push(zone);

    // Remove oldest zones if exceeding max capacity
    while (zones.length > this.config.maxZonesPerTimeframe) {
      zones.shift();
    }
  }
}
