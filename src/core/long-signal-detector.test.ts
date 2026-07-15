/**
 * Unit tests for the Long Signal Detector.
 *
 * Tests the detection of bullish signal structures:
 * - Expansion phase (>=2 consecutive bullish expansion candles)
 * - Retracement phase (2-4 candles with lower volume/range)
 * - Rejection phase (hammer or bullish engulfing at retracement low)
 * - Invalidation conditions
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createLongSignalDetector } from './long-signal-detector.js';
import { createCandlePatternAnalyzer } from './candle-pattern-analyzer.js';
import type { Candle } from '../types/candle.js';
import type { ILongSignalDetector } from './long-signal-detector.js';

/** Helper to create a candle with defaults */
function makeCandle(
  overrides: Partial<Candle> & Pick<Candle, 'open' | 'high' | 'low' | 'close'>
): Candle {
  return {
    instrument: 'XAUUSD',
    timeframe: 'M5',
    timestamp: '2024-01-01T12:00:00.000Z',
    volume: 100,
    ...overrides,
  };
}


describe('LongSignalDetector', () => {
  let detector: ILongSignalDetector;
  const analyzer = createCandlePatternAnalyzer();

  beforeEach(() => {
    detector = createLongSignalDetector(analyzer);
  });

  /**
   * Helper: Creates preceding candles with highs below a given level.
   * These provide the "preceding 10 candles" context for expansion detection.
   */
  function makePrecedingCandles(highestHigh: number, count = 10): Candle[] {
    return Array.from({ length: count }, (_, i) =>
      makeCandle({
        open: highestHigh - 20,
        high: highestHigh - (count - i),
        low: highestHigh - 30,
        close: highestHigh - 15,
        volume: 100,
        timestamp: `2024-01-01T12:${String(i).padStart(2, '0')}:00.000Z`,
      })
    );
  }

  /**
   * Helper: Creates a bullish expansion candle that closes above highestHigh.
   * Body >= 60% of range.
   */
  function makeExpansionCandle(
    closingAbove: number,
    volume = 200
  ): Candle {
    // Body = close - open, Range = high - low
    // Make body >= 60% of range
    const open = closingAbove - 8;
    const close = closingAbove + 2;
    const high = close + 1;
    const low = open - 2;
    // Body = 10, Range = 13, ratio = 10/13 ~ 0.77 >= 0.60
    return makeCandle({ open, high, low, close, volume });
  }



  describe('Expansion Phase', () => {
    it('should remain pending after 1 expansion candle', () => {
      const preceding = makePrecedingCandles(2000);
      const expansion1 = makeExpansionCandle(2000, 200);
      const result = detector.processCandle(expansion1, preceding);
      expect(result.status).toBe('pending');
      expect(detector.getPhase()).toBe('expansion');
    });

    it('should remain pending after 2 expansion candles (waiting for retracement)', () => {
      const preceding = makePrecedingCandles(2000);
      const expansion1 = makeExpansionCandle(2000, 200);
      detector.processCandle(expansion1, preceding);

      // Second expansion must close above the highest high including the first expansion
      const expansion2 = makeExpansionCandle(expansion1.high, 250);
      const result = detector.processCandle(expansion2, preceding);
      expect(result.status).toBe('pending');
    });

    it('should invalidate when first candle is not an expansion candle', () => {
      const preceding = makePrecedingCandles(2000);
      // A candle with body < 60% of range (non-expansion)
      const nonExpansion = makeCandle({
        open: 1995,
        high: 2010,
        low: 1990,
        close: 1997,
        volume: 100,
      });
      const result = detector.processCandle(nonExpansion, preceding);
      expect(result.status).toBe('invalid');
      expect(result).toHaveProperty('reason', 'insufficient_expansion_candles');
    });

    it('should invalidate if only 1 expansion then non-expansion', () => {
      const preceding = makePrecedingCandles(2000);
      const expansion1 = makeExpansionCandle(2000, 200);
      detector.processCandle(expansion1, preceding);

      // Bearish candle (not expansion) after only 1 expansion
      const nonExpansion = makeCandle({
        open: 2005,
        high: 2006,
        low: 1990,
        close: 1991,
        volume: 50,
      });
      const result = detector.processCandle(nonExpansion, preceding);
      expect(result.status).toBe('invalid');
      expect(result).toHaveProperty('reason', 'insufficient_expansion_candles');
    });
  });


  describe('Retracement Phase', () => {
    it('should transition to retracement after 2+ expansion candles', () => {
      const preceding = makePrecedingCandles(2000);
      const expansion1 = makeExpansionCandle(2000, 200);
      detector.processCandle(expansion1, preceding);

      const expansion2 = makeExpansionCandle(expansion1.high, 250);
      detector.processCandle(expansion2, preceding);

      // Now send a retracement candle (volume and range below expansion averages)
      // Avg volume = (200+250)/2 = 225, avg range = ~13 for both
      const retrace = makeCandle({
        open: 2010,
        high: 2012,
        low: 2008,
        close: 2009,
        volume: 80,
      });
      const result = detector.processCandle(retrace, preceding);
      expect(result.status).toBe('pending');
      expect(detector.getPhase()).toBe('retracement');
    });

    it('should invalidate if retracement exceeds 4 candles', () => {
      const preceding = makePrecedingCandles(2000);
      const expansion1 = makeExpansionCandle(2000, 200);
      detector.processCandle(expansion1, preceding);
      const expansion2 = makeExpansionCandle(expansion1.high, 200);
      detector.processCandle(expansion2, preceding);

      // Send 5 retracement candles (exceeds max of 4)
      for (let i = 0; i < 5; i++) {
        const retrace = makeCandle({
          open: 2010 - i,
          high: 2011 - i,
          low: 2008 - i,
          close: 2009 - i,
          volume: 50,
        });
        const result = detector.processCandle(retrace, preceding);
        if (i === 4) {
          expect(result.status).toBe('invalid');
          expect(result).toHaveProperty('reason', 'retracement_exceeded_4_candles');
        }
      }
    });

    it('should invalidate if retracement avg volume exceeds expansion avg', () => {
      const preceding = makePrecedingCandles(2000);
      const expansion1 = makeExpansionCandle(2000, 100);
      detector.processCandle(expansion1, preceding);
      const expansion2 = makeExpansionCandle(expansion1.high, 100);
      detector.processCandle(expansion2, preceding);

      // Avg expansion volume = 100
      // Send retracement candle with high volume (>100 avg)
      // Need range < expansion average to qualify as retracement
      const retrace = makeCandle({
        open: 2010,
        high: 2011,
        low: 2009,
        close: 2009.5,
        volume: 150, // Above expansion avg of 100 - won't be retracement
      });
      const result = detector.processCandle(retrace, preceding);
      // This candle doesn't qualify as retracement (volume too high)
      // And it's not a rejection either, so with < 2 retracement candles, invalid
      expect(result.status).toBe('invalid');
    });
  });


  describe('Rejection Phase', () => {
    it('should detect valid long signal with hammer rejection', () => {
      const preceding = makePrecedingCandles(2000);
      const expansion1 = makeExpansionCandle(2000, 200);
      detector.processCandle(expansion1, preceding);
      const expansion2 = makeExpansionCandle(expansion1.high, 200);
      detector.processCandle(expansion2, preceding);

      // 2 retracement candles (volume < 200, range < ~13)
      const retrace1 = makeCandle({
        open: 2008,
        high: 2009,
        low: 2006,
        close: 2007,
        volume: 80,
      });
      detector.processCandle(retrace1, preceding);
      const retrace2 = makeCandle({
        open: 2007,
        high: 2008,
        low: 2005,
        close: 2006,
        volume: 70,
      });
      detector.processCandle(retrace2, preceding);

      // Hammer rejection at retracement low
      // Bottom wick >= 2x body
      const hammer = makeCandle({
        open: 2006,
        high: 2008,
        low: 1998,
        close: 2007,
        volume: 60,
      });
      // body = 1, bottom wick = 2006 - 1998 = 8, 8 >= 2*1 OK
      const result = detector.processCandle(hammer, preceding);
      expect(result.status).toBe('valid');
      if (result.status === 'valid') {
        expect(result.context.rejectionType).toBe('hammer');
        expect(result.context.expansionCandleCount).toBe(2);
        expect(result.context.retracementCandleCount).toBe(2);
        expect(result.context.breakoutLevel).toBeGreaterThan(0);
      }
    });

    it('should detect valid long signal with bullish engulfing rejection', () => {
      const preceding = makePrecedingCandles(2000);
      const expansion1 = makeExpansionCandle(2000, 200);
      detector.processCandle(expansion1, preceding);
      const expansion2 = makeExpansionCandle(expansion1.high, 200);
      detector.processCandle(expansion2, preceding);

      // 2 retracement candles
      const retrace1 = makeCandle({
        open: 2008,
        high: 2009,
        low: 2006,
        close: 2007,
        volume: 80,
      });
      detector.processCandle(retrace1, preceding);
      const retrace2 = makeCandle({
        open: 2007,
        high: 2008,
        low: 2005,
        close: 2006,
        volume: 70,
      });
      detector.processCandle(retrace2, preceding);

      // Bullish engulfing at retracement low
      // Must engulf prior candle body [2006, 2007]
      const engulfing = makeCandle({
        open: 2005,
        high: 2010,
        low: 2004,
        close: 2008,
        volume: 90,
      });
      const result = detector.processCandle(engulfing, preceding);
      expect(result.status).toBe('valid');
      if (result.status === 'valid') {
        expect(result.context.rejectionType).toBe('bullish_engulfing');
        expect(result.context.expansionCandleCount).toBe(2);
        expect(result.context.retracementCandleCount).toBe(2);
      }
    });


    it('should record correct context on valid detection', () => {
      const preceding = makePrecedingCandles(2000);
      const expansion1 = makeExpansionCandle(2000, 180);
      detector.processCandle(expansion1, preceding);
      const expansion2 = makeExpansionCandle(expansion1.high, 220);
      detector.processCandle(expansion2, preceding);
      const expansion3 = makeExpansionCandle(expansion2.high, 200);
      detector.processCandle(expansion3, preceding);

      // 3 retracement candles
      const retrace1 = makeCandle({
        open: 2010, high: 2011, low: 2008, close: 2009, volume: 60,
      });
      detector.processCandle(retrace1, preceding);
      const retrace2 = makeCandle({
        open: 2009, high: 2010, low: 2007, close: 2008, volume: 55,
      });
      detector.processCandle(retrace2, preceding);
      const retrace3 = makeCandle({
        open: 2008, high: 2009, low: 2006, close: 2007, volume: 50,
      });
      detector.processCandle(retrace3, preceding);

      // Hammer rejection
      const hammer = makeCandle({
        open: 2007, high: 2008, low: 1998, close: 2007.5, volume: 45,
      });
      const result = detector.processCandle(hammer, preceding);
      expect(result.status).toBe('valid');
      if (result.status === 'valid') {
        expect(result.context.expansionCandleCount).toBe(3);
        expect(result.context.retracementCandleCount).toBe(3);
        expect(result.context.rejectionType).toBe('hammer');
        expect(result.context.breakoutLevel).toBe(expansion3.close);
        expect(result.context.expansionCandles).toHaveLength(3);
        expect(result.context.retracementCandles).toHaveLength(3);
        expect(result.context.rejectionCandle).toBeDefined();
        expect(result.context.averageExpansionVolume).toBe(200);
        expect(result.context.averageExpansionRange).toBeGreaterThan(0);
      }
    });

    it('should invalidate when no rejection candle after valid retracement', () => {
      const preceding = makePrecedingCandles(2000);
      const expansion1 = makeExpansionCandle(2000, 200);
      detector.processCandle(expansion1, preceding);
      const expansion2 = makeExpansionCandle(expansion1.high, 200);
      detector.processCandle(expansion2, preceding);

      // 2 retracement candles
      const retrace1 = makeCandle({
        open: 2008, high: 2009, low: 2006, close: 2007, volume: 80,
      });
      detector.processCandle(retrace1, preceding);
      const retrace2 = makeCandle({
        open: 2007, high: 2008, low: 2005, close: 2006, volume: 70,
      });
      detector.processCandle(retrace2, preceding);

      // Non-rejection candle (neither hammer nor bullish engulfing)
      // A bearish candle with no special pattern, volume too high for retracement
      const nonRejection = makeCandle({
        open: 2010, high: 2015, low: 2005, close: 2006, volume: 300,
      });
      const result = detector.processCandle(nonRejection, preceding);
      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.reason).toBe('no_rejection_candle_at_retracement_low');
      }
    });
  });


  describe('Reset', () => {
    it('should reset state to expansion phase', () => {
      const preceding = makePrecedingCandles(2000);
      const expansion1 = makeExpansionCandle(2000, 200);
      detector.processCandle(expansion1, preceding);
      expect(detector.getPhase()).toBe('expansion');

      detector.reset();
      expect(detector.getPhase()).toBe('expansion');
    });

    it('should allow new detection after reset', () => {
      const preceding = makePrecedingCandles(2000);
      // Trigger an invalid state
      const nonExpansion = makeCandle({
        open: 1995, high: 2010, low: 1990, close: 1997, volume: 100,
      });
      detector.processCandle(nonExpansion, preceding);

      // After reset, start fresh
      detector.reset();
      const expansion1 = makeExpansionCandle(2000, 200);
      const result = detector.processCandle(expansion1, preceding);
      expect(result.status).toBe('pending');
    });
  });

  describe('Edge Cases', () => {
    it('should handle expansion candle that does not close above highest high', () => {
      const preceding = makePrecedingCandles(2050); // High of 2050
      // Candle with good body ratio but close doesn't exceed 2050
      const candle = makeCandle({
        open: 2035, high: 2048, low: 2033, close: 2045, volume: 200,
      });
      const result = detector.processCandle(candle, preceding);
      expect(result.status).toBe('invalid');
    });

    it('should handle empty preceding candles (first candle scenario)', () => {
      // With no preceding candles, highest high is -Infinity
      // Any bullish expansion candle should close above -Infinity
      const candle = makeCandle({
        open: 2000, high: 2012, low: 1998, close: 2010, volume: 200,
      });
      const result = detector.processCandle(candle, []);
      expect(result.status).toBe('pending');
    });

    it('should handle candle with zero range', () => {
      const preceding = makePrecedingCandles(2000);
      const doji = makeCandle({
        open: 2005, high: 2005, low: 2005, close: 2005, volume: 100,
      });
      const result = detector.processCandle(doji, preceding);
      expect(result.status).toBe('invalid');
    });

    it('should accept exactly 4 retracement candles before rejection', () => {
      const preceding = makePrecedingCandles(2000);
      const expansion1 = makeExpansionCandle(2000, 200);
      detector.processCandle(expansion1, preceding);
      const expansion2 = makeExpansionCandle(expansion1.high, 200);
      detector.processCandle(expansion2, preceding);

      // 4 retracement candles (max allowed)
      for (let i = 0; i < 4; i++) {
        const retrace = makeCandle({
          open: 2008 - i, high: 2009 - i, low: 2006 - i,
          close: 2007 - i, volume: 50,
        });
        detector.processCandle(retrace, preceding);
      }

      // Hammer rejection on the next candle
      const hammer = makeCandle({
        open: 2003, high: 2005, low: 1995, close: 2004, volume: 40,
      });
      const result = detector.processCandle(hammer, preceding);
      expect(result.status).toBe('valid');
      if (result.status === 'valid') {
        expect(result.context.retracementCandleCount).toBe(4);
        expect(result.context.rejectionType).toBe('hammer');
      }
    });
  });
});
