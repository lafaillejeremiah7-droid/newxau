/**
 * Tests for Stop Loss and Target Mapper - Task 8.2
 * Target projection, liquidity pocket detection, and target calculation.
 *
 * Validates: Requirements 5.3, 5.4, 5.5, 5.6
 */

import { describe, it, expect } from 'vitest';
import { createStopLossTargetMapper } from './stop-loss-target-mapper.js';
import type { Candle } from '../types/candle.js';

/** Helper to create a candle with specific properties */
function makeCandle(overrides: Partial<Candle> = {}): Candle {
  return {
    instrument: 'XAUUSD',
    timeframe: 'M5',
    timestamp: '2024-01-01T12:00:00.000Z',
    open: 2000.0,
    high: 2001.0,
    low: 1999.0,
    close: 2000.5,
    volume: 100,
    ...overrides,
  };
}

describe('StopLossTargetMapper - findLiquidityPocket', () => {
  const mapper = createStopLossTargetMapper();

  it('returns null for empty candles array', () => {
    const result = mapper.findLiquidityPocket([], 'up', 100);
    expect(result).toBeNull();
  });

  it('returns null for zero average volume', () => {
    const candles = [makeCandle()];
    const result = mapper.findLiquidityPocket(candles, 'up', 0);
    expect(result).toBeNull();
  });

  it('returns entire range as pocket when no volume blocks exist', () => {
    // Candles spanning 1.0 price units (10 pips) with low volume
    const candles = [
      makeCandle({ low: 2000.0, high: 2000.5, volume: 50 }),
      makeCandle({ low: 2000.3, high: 2000.8, volume: 60 }),
      makeCandle({ low: 2000.5, high: 2001.0, volume: 40 }),
    ];
    // avgVolume = 100, so 150% threshold = 150; no candle exceeds it
    const result = mapper.findLiquidityPocket(candles, 'up', 100);
    expect(result).not.toBeNull();
    expect(result!.startPrice).toBe(2000.0);
    expect(result!.endPrice).toBe(2001.0);
    expect(result!.width).toBe(10); // 10 pips
  });

  it('returns null when entire range is blocked by volume', () => {
    // Single candle spanning less than 5 pips with high volume
    const candles = [makeCandle({ low: 2000.0, high: 2000.3, volume: 200 })];
    const result = mapper.findLiquidityPocket(candles, 'up', 100);
    expect(result).toBeNull();
  });

  it('finds pocket above a volume block for up direction', () => {
    const candles = [
      // Low-volume area below (2000.0 - 2000.3)
      makeCandle({ low: 2000.0, high: 2000.3, volume: 50 }),
      // Volume block (2000.3 - 2000.6) - exceeds 150% of avg
      makeCandle({ low: 2000.3, high: 2000.6, volume: 200 }),
      // Low-volume area above (2000.6 - 2001.5)
      makeCandle({ low: 2000.6, high: 2001.5, volume: 50 }),
    ];

    const result = mapper.findLiquidityPocket(candles, 'up', 100);
    expect(result).not.toBeNull();
    // The first pocket found (lowest) for 'up' direction
    // Gap below block: 2000.0 to 2000.3 = 3 pips (too small)
    // Gap above block: 2000.6 to 2001.5 = 9 pips (valid)
    expect(result!.startPrice).toBe(2000.6);
    expect(result!.endPrice).toBe(2001.5);
    expect(result!.width).toBeCloseTo(9, 5);
  });

  it('finds pocket below a volume block for down direction', () => {
    const candles = [
      // Low-volume area below (1999.0 - 1999.8)
      makeCandle({ low: 1999.0, high: 1999.8, volume: 50 }),
      // Volume block (1999.8 - 2000.2) - exceeds 150% of avg
      makeCandle({ low: 1999.8, high: 2000.2, volume: 200 }),
      // Low-volume area above (2000.2 - 2000.5)
      makeCandle({ low: 2000.2, high: 2000.5, volume: 50 }),
    ];

    const result = mapper.findLiquidityPocket(candles, 'down', 100);
    expect(result).not.toBeNull();
    // Gap below block: 1999.0 to 1999.8 = 8 pips (valid)
    // Gap above block: 2000.2 to 2000.5 = 3 pips (too small)
    // For 'down' direction, return the last (highest) pocket
    expect(result!.startPrice).toBe(1999.0);
    expect(result!.endPrice).toBe(1999.8);
    expect(result!.width).toBeCloseTo(8, 5);
  });

  it('requires minimum 5 pips width for a valid pocket', () => {
    // Only small gaps (< 5 pips = 0.5 price units) between blocks
    const candles = [
      makeCandle({ low: 2000.0, high: 2000.2, volume: 200 }),
      makeCandle({ low: 2000.5, high: 2000.7, volume: 200 }),
      makeCandle({ low: 2001.0, high: 2001.2, volume: 200 }),
    ];
    // Gaps: 2000.2 to 2000.5 = 3 pips, 2000.7 to 2001.0 = 3 pips
    // Below first block: 0 pips, Above last block: 0 pips
    const result = mapper.findLiquidityPocket(candles, 'up', 100);
    expect(result).toBeNull();
  });

  it('merges overlapping volume blocks', () => {
    const candles = [
      // Open pocket below (1999.0 - 1999.5)
      makeCandle({ low: 1999.0, high: 1999.5, volume: 50 }),
      // Overlapping volume blocks (1999.5 - 2000.5)
      makeCandle({ low: 1999.5, high: 2000.0, volume: 200 }),
      makeCandle({ low: 1999.8, high: 2000.5, volume: 200 }),
      // Open pocket above (2000.5 - 2001.5)
      makeCandle({ low: 2000.5, high: 2001.5, volume: 50 }),
    ];

    const result = mapper.findLiquidityPocket(candles, 'up', 100);
    expect(result).not.toBeNull();
    // Merged block: 1999.5 to 2000.5
    // Gap below: 1999.0 to 1999.5 = 5 pips (exactly valid!)
    // Gap above: 2000.5 to 2001.5 = 10 pips
    // For 'up', returns first (lowest) pocket
    expect(result!.startPrice).toBe(1999.0);
    expect(result!.endPrice).toBe(1999.5);
    expect(result!.width).toBeCloseTo(5, 5);
  });
});

describe('StopLossTargetMapper - calculateTargets', () => {
  const mapper = createStopLossTargetMapper();

  describe('R_Unit calculation', () => {
    it('calculates R_Unit as absolute distance between entry and stop-loss (long)', () => {
      const entry = 2000.0;
      const stopLoss = 1999.0; // 10 pips below
      const result = mapper.calculateTargets(entry, stopLoss, 2.0, [], 0);
      expect(result.rUnit).toBeCloseTo(1.0, 5); // 10 pips = 1.0 price units
    });

    it('calculates R_Unit as absolute distance between entry and stop-loss (short)', () => {
      const entry = 2000.0;
      const stopLoss = 2001.0; // 10 pips above
      const result = mapper.calculateTargets(entry, stopLoss, 2.0, [], 0);
      expect(result.rUnit).toBeCloseTo(1.0, 5);
    });
  });

  describe('target projection without volume blocks', () => {
    it('projects TP2 at zoneTargetR × rUnit for long signal', () => {
      const entry = 2000.0;
      const stopLoss = 1999.0; // rUnit = 1.0
      // No candles/no volume data → no adjustment
      const result = mapper.calculateTargets(entry, stopLoss, 3.0, [], 0);
      // TP2 = 2000 + 3.0 * 1.0 = 2003.0
      expect(result.tp2).toBeCloseTo(2003.0, 5);
    });

    it('projects TP2 at zoneTargetR × rUnit for short signal', () => {
      const entry = 2000.0;
      const stopLoss = 2001.0; // rUnit = 1.0
      const result = mapper.calculateTargets(entry, stopLoss, 2.0, [], 0);
      // TP2 = 2000 - 2.0 * 1.0 = 1998.0
      expect(result.tp2).toBeCloseTo(1998.0, 5);
    });
  });

  describe('TP1 calculation (35% of distance to TP2)', () => {
    it('calculates TP1 = entry + 0.35 × (TP2 - entry) for longs', () => {
      const entry = 2000.0;
      const stopLoss = 1999.0; // rUnit = 1.0
      const result = mapper.calculateTargets(entry, stopLoss, 3.0, [], 0);
      // TP2 = 2003.0, TP1 = 2000 + 0.35 * (2003 - 2000) = 2000 + 1.05 = 2001.05
      expect(result.tp1).toBeCloseTo(2001.05, 5);
    });

    it('calculates TP1 = entry - 0.35 × (entry - TP2) for shorts', () => {
      const entry = 2000.0;
      const stopLoss = 2001.0; // rUnit = 1.0
      const result = mapper.calculateTargets(entry, stopLoss, 3.0, [], 0);
      // TP2 = 1997.0, TP1 = 2000 - 0.35 * (2000 - 1997) = 2000 - 1.05 = 1998.95
      expect(result.tp1).toBeCloseTo(1998.95, 5);
    });
  });

  describe('signal validity (minimum 1.5R)', () => {
    it('marks signal as valid when target >= 1.5R', () => {
      const entry = 2000.0;
      const stopLoss = 1999.0; // rUnit = 1.0
      const result = mapper.calculateTargets(entry, stopLoss, 2.0, [], 0);
      // |TP2 - entry| = 2.0 >= 1.5 * 1.0 → valid
      expect(result.isValid).toBe(true);
    });

    it('marks signal as valid when target exactly equals 1.5R', () => {
      const entry = 2000.0;
      const stopLoss = 1999.0; // rUnit = 1.0
      const result = mapper.calculateTargets(entry, stopLoss, 1.5, [], 0);
      // |TP2 - entry| = 1.5 >= 1.5 * 1.0 → valid
      expect(result.isValid).toBe(true);
    });

    it('marks signal as invalid when target < 1.5R after adjustment', () => {
      const entry = 2000.0;
      const stopLoss = 1999.0; // rUnit = 1.0
      // Volume block very close to entry forces adjustment below 1.5R
      const candles = [
        makeCandle({ low: 2000.5, high: 2001.0, volume: 200 }),
      ];
      const avgVolume = 100;
      const result = mapper.calculateTargets(
        entry,
        stopLoss,
        3.0,
        candles,
        avgVolume,
      );
      // Block at 2000.5, target adjusted to 2000.5 - 0.1 = 2000.4
      // |2000.4 - 2000| = 0.4 < 1.5 * 1.0 = 1.5 → invalid
      expect(result.isValid).toBe(false);
    });
  });

  describe('target adjustment for volume blocks', () => {
    it('adjusts target before volume block for long signal', () => {
      const entry = 2000.0;
      const stopLoss = 1999.0; // rUnit = 1.0, initial target = 2003.0

      // Volume block at 2001.5 - 2002.0
      const candles = [
        makeCandle({ low: 1999.5, high: 2001.0, volume: 50 }),
        makeCandle({ low: 2001.5, high: 2002.0, volume: 200 }), // volume block
        makeCandle({ low: 2002.5, high: 2003.5, volume: 50 }),
      ];
      const avgVolume = 100;

      const result = mapper.calculateTargets(
        entry,
        stopLoss,
        3.0,
        candles,
        avgVolume,
      );
      // Block at low=2001.5. Target should be adjusted before this block.
      // TP2 should be < 2001.5
      expect(result.tp2).toBeLessThan(2001.5);
    });

    it('adjusts target before volume block for short signal', () => {
      const entry = 2000.0;
      const stopLoss = 2001.0; // rUnit = 1.0, initial target = 1997.0

      // Volume block at 1998.0 - 1998.5
      const candles = [
        makeCandle({ low: 1997.0, high: 1997.5, volume: 50 }),
        makeCandle({ low: 1998.0, high: 1998.5, volume: 200 }), // volume block
        makeCandle({ low: 1999.0, high: 2000.5, volume: 50 }),
      ];
      const avgVolume = 100;

      const result = mapper.calculateTargets(
        entry,
        stopLoss,
        3.0,
        candles,
        avgVolume,
      );
      // Block at high=1998.5. Target should be adjusted before (above) this block.
      expect(result.tp2).toBeGreaterThan(1998.5);
    });

    it('does not adjust target when no volume block exists between entry and target', () => {
      const entry = 2000.0;
      const stopLoss = 1999.0; // rUnit = 1.0
      // All candles have low volume
      const candles = [
        makeCandle({ low: 2000.5, high: 2001.5, volume: 50 }),
        makeCandle({ low: 2001.5, high: 2002.5, volume: 60 }),
        makeCandle({ low: 2002.5, high: 2003.5, volume: 70 }),
      ];
      const avgVolume = 100;

      const result = mapper.calculateTargets(
        entry,
        stopLoss,
        3.0,
        candles,
        avgVolume,
      );
      // No blocks → target stays at initial projection (2003.0)
      expect(result.tp2).toBeCloseTo(2003.0, 5);
      expect(result.isValid).toBe(true);
    });

    it('uses initial target when volume block is beyond projected target', () => {
      const entry = 2000.0;
      const stopLoss = 1999.0; // rUnit = 1.0, initial target = 2002.0 (2R)
      // Volume block beyond the projected target
      const candles = [
        makeCandle({ low: 2003.0, high: 2004.0, volume: 200 }), // block beyond target
        makeCandle({ low: 2000.5, high: 2001.5, volume: 50 }),
      ];
      const avgVolume = 100;

      const result = mapper.calculateTargets(
        entry,
        stopLoss,
        2.0,
        candles,
        avgVolume,
      );
      // Block at 2003.0, but target is 2002.0 → no adjustment needed
      expect(result.tp2).toBeCloseTo(2002.0, 5);
      expect(result.isValid).toBe(true);
    });
  });

  describe('combined TP1/TP2/validity scenarios', () => {
    it('computes correct values for expansion zone long (3.0R)', () => {
      const entry = 2000.0;
      const stopLoss = 1999.5; // rUnit = 0.5
      const result = mapper.calculateTargets(entry, stopLoss, 3.0, [], 0);
      // rUnit = 0.5
      // TP2 = 2000 + 3.0 * 0.5 = 2001.5
      // TP1 = 2000 + 0.35 * (2001.5 - 2000) = 2000 + 0.525 = 2000.525
      // |TP2 - entry| = 1.5 >= 1.5 * 0.5 = 0.75 → valid
      expect(result.rUnit).toBeCloseTo(0.5, 5);
      expect(result.tp2).toBeCloseTo(2001.5, 5);
      expect(result.tp1).toBeCloseTo(2000.525, 5);
      expect(result.isValid).toBe(true);
    });

    it('computes correct values for chop zone short (1.5R)', () => {
      const entry = 2000.0;
      const stopLoss = 2000.5; // rUnit = 0.5
      const result = mapper.calculateTargets(entry, stopLoss, 1.5, [], 0);
      // rUnit = 0.5
      // TP2 = 2000 - 1.5 * 0.5 = 1999.25
      // TP1 = 2000 - 0.35 * (2000 - 1999.25) = 2000 - 0.2625 = 1999.7375
      // |TP2 - entry| = 0.75 >= 1.5 * 0.5 = 0.75 → valid (exactly 1.5R)
      expect(result.rUnit).toBeCloseTo(0.5, 5);
      expect(result.tp2).toBeCloseTo(1999.25, 5);
      expect(result.tp1).toBeCloseTo(1999.7375, 5);
      expect(result.isValid).toBe(true);
    });
  });
});
