/**
 * Unit tests for the Entry Signal Generator module.
 *
 * Tests the logic for:
 * - Generating entry signals when close is within structural window
 * - Rejecting signals when close is outside structural window
 * - Boundary inclusivity (close exactly on boundary → valid)
 * - Signal record completeness (all required fields present)
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */

import { describe, it, expect } from 'vitest';
import {
  createEntrySignalGenerator,
  type EntrySignalGeneratorInput,
} from './entry-signal-generator.js';
import type { Candle } from '../types/candle.js';

/** Helper to create a test candle */
function makeCandle(overrides: Partial<Candle> = {}): Candle {
  return {
    instrument: 'XAUUSD',
    timeframe: 'M5',
    timestamp: '2024-01-15T14:30:00.000Z',
    open: 2050.0,
    high: 2052.0,
    low: 2048.0,
    close: 2049.5,
    volume: 150,
    ...overrides,
  };
}

/** Helper to create a default input for the generator */
function makeInput(
  overrides: Partial<EntrySignalGeneratorInput> = {},
): EntrySignalGeneratorInput {
  return {
    rejectionCandle: makeCandle(),
    direction: 'short',
    structuralWindowUpper: 2051.0,
    structuralWindowLower: 2048.0,
    liquidityZoneLevel: 2052.5,
    rejectionCandleType: 'shooting_star',
    expansionCandles: [makeCandle({ close: 2047.0 }), makeCandle({ close: 2045.0 })],
    retracementCandles: [makeCandle({ close: 2048.5 }), makeCandle({ close: 2049.0 })],
    observationCandles: [makeCandle(), makeCandle(), makeCandle()],
    ...overrides,
  };
}

describe('Entry Signal Generator', () => {
  const generator = createEntrySignalGenerator();

  describe('Signal generation within structural window', () => {
    it('should generate a valid signal when close is within the window', () => {
      // Close at 2049.5, window [2048, 2051] → within
      const input = makeInput({
        rejectionCandle: makeCandle({ close: 2049.5 }),
        structuralWindowLower: 2048.0,
        structuralWindowUpper: 2051.0,
      });

      const result = generator.evaluate(input);

      expect(result.valid).toBe(true);
      expect(result.signal).not.toBeNull();
      expect(result.rejectionReason).toBeNull();
    });

    it('should set entry price to the rejection candle close price (Req 4.1)', () => {
      const input = makeInput({
        rejectionCandle: makeCandle({ close: 2050.0 }),
      });

      const result = generator.evaluate(input);

      expect(result.signal!.entryPrice).toBe(2050.0);
    });

    it('should generate signal for long direction within window', () => {
      const input = makeInput({
        rejectionCandle: makeCandle({ close: 2049.0 }),
        direction: 'long',
        structuralWindowLower: 2047.0,
        structuralWindowUpper: 2050.0,
        rejectionCandleType: 'hammer',
      });

      const result = generator.evaluate(input);

      expect(result.valid).toBe(true);
      expect(result.signal!.direction).toBe('long');
      expect(result.signal!.rejectionCandleType).toBe('hammer');
    });

    it('should generate signal for short direction within window', () => {
      const input = makeInput({
        rejectionCandle: makeCandle({ close: 2050.0 }),
        direction: 'short',
        structuralWindowLower: 2048.0,
        structuralWindowUpper: 2052.0,
        rejectionCandleType: 'shooting_star',
      });

      const result = generator.evaluate(input);

      expect(result.valid).toBe(true);
      expect(result.signal!.direction).toBe('short');
    });
  });

  describe('Boundary inclusivity (Req 4.4)', () => {
    it('should treat close exactly on upper boundary as within window', () => {
      const input = makeInput({
        rejectionCandle: makeCandle({ close: 2051.0 }),
        structuralWindowLower: 2048.0,
        structuralWindowUpper: 2051.0,
      });

      const result = generator.evaluate(input);

      expect(result.valid).toBe(true);
      expect(result.signal).not.toBeNull();
    });

    it('should treat close exactly on lower boundary as within window', () => {
      const input = makeInput({
        rejectionCandle: makeCandle({ close: 2048.0 }),
        structuralWindowLower: 2048.0,
        structuralWindowUpper: 2051.0,
      });

      const result = generator.evaluate(input);

      expect(result.valid).toBe(true);
      expect(result.signal).not.toBeNull();
    });

    it('should generate signal when close equals both boundaries (single-point window)', () => {
      const input = makeInput({
        rejectionCandle: makeCandle({ close: 2050.0 }),
        structuralWindowLower: 2050.0,
        structuralWindowUpper: 2050.0,
      });

      const result = generator.evaluate(input);

      expect(result.valid).toBe(true);
      expect(result.signal).not.toBeNull();
    });
  });

  describe('Signal rejection when outside window (Req 4.2)', () => {
    it('should reject when close is above the upper boundary', () => {
      const input = makeInput({
        rejectionCandle: makeCandle({ close: 2053.0 }),
        structuralWindowLower: 2048.0,
        structuralWindowUpper: 2051.0,
        direction: 'short',
      });

      const result = generator.evaluate(input);

      expect(result.valid).toBe(false);
      expect(result.signal).toBeNull();
      expect(result.rejectionReason).not.toBeNull();
    });

    it('should reject when close is below the lower boundary', () => {
      const input = makeInput({
        rejectionCandle: makeCandle({ close: 2046.0 }),
        structuralWindowLower: 2048.0,
        structuralWindowUpper: 2051.0,
        direction: 'long',
      });

      const result = generator.evaluate(input);

      expect(result.valid).toBe(false);
      expect(result.signal).toBeNull();
      expect(result.rejectionReason).not.toBeNull();
    });

    it('should include close price and window boundaries in rejection reason', () => {
      const input = makeInput({
        rejectionCandle: makeCandle({ close: 2055.5 }),
        structuralWindowLower: 2048.0,
        structuralWindowUpper: 2051.0,
        direction: 'short',
      });

      const result = generator.evaluate(input);

      expect(result.rejectionReason).toContain('2055.5');
      expect(result.rejectionReason).toContain('2048');
      expect(result.rejectionReason).toContain('2051');
    });

    it('should include direction in rejection reason', () => {
      const input = makeInput({
        rejectionCandle: makeCandle({ close: 2046.0 }),
        structuralWindowLower: 2048.0,
        structuralWindowUpper: 2051.0,
        direction: 'long',
      });

      const result = generator.evaluate(input);

      expect(result.rejectionReason).toContain('long');
    });

    it('should reject short signal when close is just above the upper boundary', () => {
      const input = makeInput({
        rejectionCandle: makeCandle({ close: 2051.01 }),
        structuralWindowLower: 2048.0,
        structuralWindowUpper: 2051.0,
        direction: 'short',
      });

      const result = generator.evaluate(input);

      expect(result.valid).toBe(false);
    });

    it('should reject long signal when close is just below the lower boundary', () => {
      const input = makeInput({
        rejectionCandle: makeCandle({ close: 2047.99 }),
        structuralWindowLower: 2048.0,
        structuralWindowUpper: 2051.0,
        direction: 'long',
      });

      const result = generator.evaluate(input);

      expect(result.valid).toBe(false);
    });
  });

  describe('Signal record completeness (Req 4.3)', () => {
    it('should record all required fields in the signal', () => {
      const input = makeInput({
        rejectionCandle: makeCandle({
          close: 2049.5,
          timestamp: '2024-01-15T14:30:00.000Z',
        }),
        direction: 'short',
        structuralWindowLower: 2048.0,
        structuralWindowUpper: 2051.0,
        liquidityZoneLevel: 2052.5,
        rejectionCandleType: 'shooting_star',
      });

      const result = generator.evaluate(input);
      const signal = result.signal!;

      // Timestamp (UTC)
      expect(signal.timestamp).toBe('2024-01-15T14:30:00.000Z');
      // Entry price
      expect(signal.entryPrice).toBe(2049.5);
      // Direction
      expect(signal.direction).toBe('short');
      // Liquidity zone level
      expect(signal.liquidityZoneLevel).toBe(2052.5);
      // Window boundaries
      expect(signal.structuralWindowUpper).toBe(2051.0);
      expect(signal.structuralWindowLower).toBe(2048.0);
      // Rejection pattern type
      expect(signal.rejectionCandleType).toBe('shooting_star');
    });

    it('should generate a unique ID for each signal', () => {
      const input = makeInput();

      const result1 = generator.evaluate(input);
      const result2 = generator.evaluate(input);

      expect(result1.signal!.id).toBeDefined();
      expect(result2.signal!.id).toBeDefined();
      expect(result1.signal!.id).not.toBe(result2.signal!.id);
    });

    it('should include expansion candles in the signal', () => {
      const expansionCandles = [
        makeCandle({ close: 2047.0 }),
        makeCandle({ close: 2045.0 }),
      ];
      const input = makeInput({ expansionCandles });

      const result = generator.evaluate(input);

      expect(result.signal!.expansionCandles).toEqual(expansionCandles);
    });

    it('should include retracement candles in the signal', () => {
      const retracementCandles = [
        makeCandle({ close: 2048.5 }),
        makeCandle({ close: 2049.0 }),
      ];
      const input = makeInput({ retracementCandles });

      const result = generator.evaluate(input);

      expect(result.signal!.retracementCandles).toEqual(retracementCandles);
    });

    it('should include observation candles in the signal', () => {
      const observationCandles = [
        makeCandle({ close: 2050.0 }),
        makeCandle({ close: 2050.5 }),
        makeCandle({ close: 2050.2 }),
      ];
      const input = makeInput({ observationCandles });

      const result = generator.evaluate(input);

      expect(result.signal!.observationCandles).toEqual(observationCandles);
    });

    it('should use the candle timestamp as the signal timestamp', () => {
      const input = makeInput({
        rejectionCandle: makeCandle({ timestamp: '2024-03-20T15:45:00.000Z' }),
      });

      const result = generator.evaluate(input);

      expect(result.signal!.timestamp).toBe('2024-03-20T15:45:00.000Z');
    });
  });

  describe('Different rejection candle types', () => {
    it('should handle shooting_star type', () => {
      const input = makeInput({ rejectionCandleType: 'shooting_star' });
      const result = generator.evaluate(input);
      expect(result.signal!.rejectionCandleType).toBe('shooting_star');
    });

    it('should handle hammer type', () => {
      const input = makeInput({
        rejectionCandleType: 'hammer',
        direction: 'long',
      });
      const result = generator.evaluate(input);
      expect(result.signal!.rejectionCandleType).toBe('hammer');
    });

    it('should handle bearish_engulfing type', () => {
      const input = makeInput({ rejectionCandleType: 'bearish_engulfing' });
      const result = generator.evaluate(input);
      expect(result.signal!.rejectionCandleType).toBe('bearish_engulfing');
    });

    it('should handle bullish_engulfing type', () => {
      const input = makeInput({
        rejectionCandleType: 'bullish_engulfing',
        direction: 'long',
      });
      const result = generator.evaluate(input);
      expect(result.signal!.rejectionCandleType).toBe('bullish_engulfing');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty expansion/retracement/observation arrays', () => {
      const input = makeInput({
        expansionCandles: [],
        retracementCandles: [],
        observationCandles: [],
      });

      const result = generator.evaluate(input);

      expect(result.valid).toBe(true);
      expect(result.signal!.expansionCandles).toEqual([]);
      expect(result.signal!.retracementCandles).toEqual([]);
      expect(result.signal!.observationCandles).toEqual([]);
    });

    it('should handle very tight structural window', () => {
      const input = makeInput({
        rejectionCandle: makeCandle({ close: 2050.005 }),
        structuralWindowLower: 2050.0,
        structuralWindowUpper: 2050.01,
      });

      const result = generator.evaluate(input);

      expect(result.valid).toBe(true);
    });

    it('should handle very wide structural window', () => {
      const input = makeInput({
        rejectionCandle: makeCandle({ close: 2050.0 }),
        structuralWindowLower: 2000.0,
        structuralWindowUpper: 2100.0,
      });

      const result = generator.evaluate(input);

      expect(result.valid).toBe(true);
    });

    it('should correctly reject with floating point close just outside boundary', () => {
      // Close is 2051.001, upper is 2051.0 → outside
      const input = makeInput({
        rejectionCandle: makeCandle({ close: 2051.001 }),
        structuralWindowLower: 2048.0,
        structuralWindowUpper: 2051.0,
      });

      const result = generator.evaluate(input);

      expect(result.valid).toBe(false);
    });
  });
});
