/**
 * Unit tests for the Candle Pattern Analyzer.
 *
 * Tests specific candle examples for:
 * - Shooting star detection (bearish rejection)
 * - Hammer detection (bullish rejection)
 * - Bearish engulfing detection
 * - Bullish engulfing detection
 * - Expansion candle detection
 * - Body ratio calculation
 * - Wick ratio calculation
 */

import { describe, it, expect } from 'vitest';
import { createCandlePatternAnalyzer } from './candle-pattern-analyzer.js';
import type { Candle } from '../types/candle.js';

/** Helper to create a candle with defaults for convenience */
function makeCandle(overrides: Partial<Candle> & Pick<Candle, 'open' | 'high' | 'low' | 'close'>): Candle {
  return {
    instrument: 'XAUUSD',
    timeframe: 'M5',
    timestamp: '2024-01-01T12:00:00.000Z',
    volume: 100,
    ...overrides,
  };
}

describe('CandlePatternAnalyzer', () => {
  const analyzer = createCandlePatternAnalyzer();

  describe('getBodyRatio', () => {
    it('should return body/range ratio for a normal candle', () => {
      // Body = |2000 - 1990| = 10, Range = 2005 - 1985 = 20, Ratio = 0.5
      const candle = makeCandle({ open: 2000, high: 2005, low: 1985, close: 1990 });
      expect(analyzer.getBodyRatio(candle)).toBeCloseTo(0.5);
    });

    it('should return 1.0 for a full-body candle (no wicks)', () => {
      const candle = makeCandle({ open: 2000, high: 2010, low: 2000, close: 2010 });
      expect(analyzer.getBodyRatio(candle)).toBeCloseTo(1.0);
    });

    it('should return 0 when range is 0 (doji with high === low)', () => {
      const candle = makeCandle({ open: 2000, high: 2000, low: 2000, close: 2000 });
      expect(analyzer.getBodyRatio(candle)).toBe(0);
    });

    it('should return small ratio for a doji-like candle with wicks', () => {
      // Body = |2000 - 2001| = 1, Range = 2010 - 1990 = 20, Ratio = 0.05
      const candle = makeCandle({ open: 2000, high: 2010, low: 1990, close: 2001 });
      expect(analyzer.getBodyRatio(candle)).toBeCloseTo(0.05);
    });
  });

  describe('getWickRatio', () => {
    it('should return correct top wick ratio', () => {
      // Top wick = high - max(open, close) = 2020 - 2010 = 10
      // Range = 2020 - 1990 = 30, Ratio = 10/30 ≈ 0.333
      const candle = makeCandle({ open: 2000, high: 2020, low: 1990, close: 2010 });
      expect(analyzer.getWickRatio(candle, 'top')).toBeCloseTo(10 / 30);
    });

    it('should return correct bottom wick ratio', () => {
      // Bottom wick = min(open, close) - low = 2000 - 1990 = 10
      // Range = 2020 - 1990 = 30, Ratio = 10/30 ≈ 0.333
      const candle = makeCandle({ open: 2000, high: 2020, low: 1990, close: 2010 });
      expect(analyzer.getWickRatio(candle, 'bottom')).toBeCloseTo(10 / 30);
    });

    it('should return 0 when range is 0', () => {
      const candle = makeCandle({ open: 2000, high: 2000, low: 2000, close: 2000 });
      expect(analyzer.getWickRatio(candle, 'top')).toBe(0);
      expect(analyzer.getWickRatio(candle, 'bottom')).toBe(0);
    });

    it('should return 0 for top wick on a candle with no top wick', () => {
      // Bullish candle where close = high (no top wick)
      const candle = makeCandle({ open: 2000, high: 2010, low: 1995, close: 2010 });
      expect(analyzer.getWickRatio(candle, 'top')).toBe(0);
    });
  });

  describe('isRejectionCandle - Shooting Star', () => {
    it('should detect a shooting star (top wick ≥50% range, body in lower third)', () => {
      // Range = 2030 - 2000 = 30
      // Body: open=2005, close=2002 → body in lower third (2000 to 2010)
      // Top wick = 2030 - 2005 = 25, which is 25/30 ≈ 83% > 50%
      // Body top = 2005, lower third boundary = 2000 + 30/3 = 2010 → 2005 ≤ 2010 ✓
      const candle = makeCandle({ open: 2005, high: 2030, low: 2000, close: 2002 });
      const result = analyzer.isRejectionCandle(candle, 'bearish');
      expect(result.isRejection).toBe(true);
      expect(result.pattern).toBe('shooting_star');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should NOT detect shooting star when top wick < 50% of range', () => {
      // Range = 2020 - 2000 = 20
      // Top wick = 2020 - 2015 = 5, which is 5/20 = 25% < 50%
      const candle = makeCandle({ open: 2010, high: 2020, low: 2000, close: 2015 });
      const result = analyzer.isRejectionCandle(candle, 'bearish');
      expect(result.isRejection).toBe(false);
      expect(result.pattern).toBeNull();
    });

    it('should NOT detect shooting star when body is NOT in lower third', () => {
      // Range = 2030 - 2000 = 30
      // Top wick = 2030 - 2020 = 10, which is 10/30 ≈ 33% < 50%? No, let's fix:
      // Make top wick big but body in middle
      // open=2015, close=2020, high=2030, low=2000
      // Top wick = 2030 - 2020 = 10 → 10/30 = 33% < 50%
      // Let's create: open=2018, close=2015, high=2030, low=2000
      // Top wick = 2030 - 2018 = 12 → 12/30 = 40% < 50%
      // Need bigger wick: open=2012, close=2015, high=2030, low=2000
      // Top wick = 2030 - 2015 = 15 → 15/30 = 50% ✓
      // Body top = max(2012, 2015) = 2015, lower third boundary = 2000 + 10 = 2010
      // 2015 > 2010 → body NOT in lower third
      const candle = makeCandle({ open: 2012, high: 2030, low: 2000, close: 2015 });
      const result = analyzer.isRejectionCandle(candle, 'bearish');
      expect(result.isRejection).toBe(false);
      expect(result.pattern).toBeNull();
    });

    it('should NOT detect shooting star when looking for bullish direction', () => {
      // Valid shooting star but checking bullish direction
      const candle = makeCandle({ open: 2005, high: 2030, low: 2000, close: 2002 });
      const result = analyzer.isRejectionCandle(candle, 'bullish');
      expect(result.pattern).not.toBe('shooting_star');
    });
  });

  describe('isRejectionCandle - Hammer', () => {
    it('should detect a hammer (bottom wick ≥ 2× body)', () => {
      // Body = |2018 - 2020| = 2
      // Bottom wick = min(2018, 2020) - 2010 = 2018 - 2010 = 8
      // 8 ≥ 2 × 2 = 4 ✓
      const candle = makeCandle({ open: 2018, high: 2021, low: 2010, close: 2020 });
      const result = analyzer.isRejectionCandle(candle, 'bullish');
      expect(result.isRejection).toBe(true);
      expect(result.pattern).toBe('hammer');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should detect a hammer with exactly 2× body', () => {
      // Body = |2008 - 2010| = 2
      // Bottom wick = min(2008, 2010) - 2004 = 2008 - 2004 = 4
      // 4 ≥ 2 × 2 = 4 ✓ (exactly 2×)
      const candle = makeCandle({ open: 2008, high: 2011, low: 2004, close: 2010 });
      const result = analyzer.isRejectionCandle(candle, 'bullish');
      expect(result.isRejection).toBe(true);
      expect(result.pattern).toBe('hammer');
    });

    it('should NOT detect a hammer when bottom wick < 2× body', () => {
      // Body = |2000 - 2010| = 10
      // Bottom wick = min(2000, 2010) - 1995 = 2000 - 1995 = 5
      // 5 < 2 × 10 = 20 ✗
      const candle = makeCandle({ open: 2000, high: 2015, low: 1995, close: 2010 });
      const result = analyzer.isRejectionCandle(candle, 'bullish');
      expect(result.isRejection).toBe(false);
    });

    it('should NOT detect a hammer when body is zero (doji)', () => {
      const candle = makeCandle({ open: 2000, high: 2005, low: 1990, close: 2000 });
      const result = analyzer.isRejectionCandle(candle, 'bullish');
      // A doji with no body should not be a hammer
      expect(result.pattern).not.toBe('hammer');
    });

    it('should NOT detect hammer when looking for bearish direction', () => {
      // Valid hammer but checking bearish direction
      const candle = makeCandle({ open: 2018, high: 2021, low: 2010, close: 2020 });
      const result = analyzer.isRejectionCandle(candle, 'bearish');
      expect(result.pattern).not.toBe('hammer');
    });
  });

  describe('isRejectionCandle - Bearish Engulfing', () => {
    it('should detect bearish engulfing (body engulfs prior, bearish close)', () => {
      // Prior: open=2010, close=2015 → body range [2010, 2015]
      // Current: open=2018, close=2008 → body range [2008, 2018], close < open (bearish)
      // Current body [2008, 2018] engulfs prior body [2010, 2015] ✓
      const priorCandle = makeCandle({ open: 2010, high: 2016, low: 2009, close: 2015 });
      const candle = makeCandle({ open: 2018, high: 2019, low: 2007, close: 2008 });
      const result = analyzer.isRejectionCandle(candle, 'bearish', priorCandle);
      expect(result.isRejection).toBe(true);
      expect(result.pattern).toBe('bearish_engulfing');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should NOT detect bearish engulfing when close > open (bullish)', () => {
      const priorCandle = makeCandle({ open: 2010, high: 2016, low: 2009, close: 2015 });
      // Bullish candle (close > open) cannot be bearish engulfing
      const candle = makeCandle({ open: 2008, high: 2019, low: 2007, close: 2018 });
      const result = analyzer.isRejectionCandle(candle, 'bearish', priorCandle);
      expect(result.pattern).not.toBe('bearish_engulfing');
    });

    it('should NOT detect bearish engulfing when body does not fully engulf prior', () => {
      // Prior: open=2005, close=2020 → body range [2005, 2020]
      // Current: open=2018, close=2008 → body range [2008, 2018]
      // Current body [2008, 2018] does NOT engulf prior body [2005, 2020] (prior is bigger)
      const priorCandle = makeCandle({ open: 2005, high: 2022, low: 2004, close: 2020 });
      const candle = makeCandle({ open: 2018, high: 2019, low: 2007, close: 2008 });
      const result = analyzer.isRejectionCandle(candle, 'bearish', priorCandle);
      expect(result.pattern).not.toBe('bearish_engulfing');
    });

    it('should NOT detect bearish engulfing without a prior candle', () => {
      const candle = makeCandle({ open: 2018, high: 2019, low: 2007, close: 2008 });
      const result = analyzer.isRejectionCandle(candle, 'bearish');
      expect(result.pattern).not.toBe('bearish_engulfing');
    });
  });

  describe('isRejectionCandle - Bullish Engulfing', () => {
    it('should detect bullish engulfing (body engulfs prior, bullish close)', () => {
      // Prior: open=2015, close=2010 → body range [2010, 2015]
      // Current: open=2008, close=2018 → body range [2008, 2018], close > open (bullish)
      // Current body [2008, 2018] engulfs prior body [2010, 2015] ✓
      const priorCandle = makeCandle({ open: 2015, high: 2016, low: 2009, close: 2010 });
      const candle = makeCandle({ open: 2008, high: 2019, low: 2007, close: 2018 });
      const result = analyzer.isRejectionCandle(candle, 'bullish', priorCandle);
      expect(result.isRejection).toBe(true);
      expect(result.pattern).toBe('bullish_engulfing');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should NOT detect bullish engulfing when close < open (bearish)', () => {
      const priorCandle = makeCandle({ open: 2015, high: 2016, low: 2009, close: 2010 });
      // Bearish candle (close < open) cannot be bullish engulfing
      const candle = makeCandle({ open: 2018, high: 2019, low: 2007, close: 2008 });
      const result = analyzer.isRejectionCandle(candle, 'bullish', priorCandle);
      expect(result.pattern).not.toBe('bullish_engulfing');
    });

    it('should NOT detect bullish engulfing without a prior candle', () => {
      const candle = makeCandle({ open: 2008, high: 2019, low: 2007, close: 2018 });
      const result = analyzer.isRejectionCandle(candle, 'bullish');
      expect(result.pattern).not.toBe('bullish_engulfing');
    });

    it('should detect bullish engulfing with exact engulfment (equal boundaries)', () => {
      // Prior: open=2010, close=2015 → body range [2010, 2015]
      // Current: open=2010, close=2015 → body range [2010, 2015], exactly matches
      // Body engulfs with >= (not strictly >)
      const priorCandle = makeCandle({ open: 2010, high: 2016, low: 2009, close: 2015 });
      const candle = makeCandle({ open: 2010, high: 2016, low: 2009, close: 2015 });
      const result = analyzer.isRejectionCandle(candle, 'bullish', priorCandle);
      expect(result.isRejection).toBe(true);
      expect(result.pattern).toBe('bullish_engulfing');
    });
  });

  describe('isExpansionCandle', () => {
    it('should detect bearish expansion candle (body ≥60% range, breaks below level)', () => {
      // Open=2020, Close=2005, High=2022, Low=2003
      // Body = |2020 - 2005| = 15, Range = 2022 - 2003 = 19
      // Body ratio = 15/19 ≈ 0.79 ≥ 0.60 ✓
      // Close (2005) < priorStructuralLevel (2010) ✓
      const candle = makeCandle({ open: 2020, high: 2022, low: 2003, close: 2005 });
      expect(analyzer.isExpansionCandle(candle, 2010, 'bearish')).toBe(true);
    });

    it('should detect bullish expansion candle (body ≥60% range, breaks above level)', () => {
      // Open=2000, Close=2018, High=2020, Low=1998
      // Body = |2000 - 2018| = 18, Range = 2020 - 1998 = 22
      // Body ratio = 18/22 ≈ 0.82 ≥ 0.60 ✓
      // Close (2018) > priorStructuralLevel (2015) ✓
      const candle = makeCandle({ open: 2000, high: 2020, low: 1998, close: 2018 });
      expect(analyzer.isExpansionCandle(candle, 2015, 'bullish')).toBe(true);
    });

    it('should reject expansion candle when body < 60% of range', () => {
      // Body = |2010 - 2005| = 5, Range = 2020 - 2000 = 20
      // Body ratio = 5/20 = 0.25 < 0.60 ✗
      const candle = makeCandle({ open: 2010, high: 2020, low: 2000, close: 2005 });
      expect(analyzer.isExpansionCandle(candle, 2010, 'bearish')).toBe(false);
    });

    it('should reject expansion candle when it does NOT break the structural level (bearish)', () => {
      // Body ratio is good, but close is above the structural level
      // Open=2020, Close=2012, High=2022, Low=2010
      // Body = 8, Range = 12, Ratio = 0.67 ≥ 0.60 ✓
      // Close (2012) >= priorStructuralLevel (2010) — NOT below ✗
      const candle = makeCandle({ open: 2020, high: 2022, low: 2010, close: 2012 });
      expect(analyzer.isExpansionCandle(candle, 2010, 'bearish')).toBe(false);
    });

    it('should reject expansion candle when it does NOT break the structural level (bullish)', () => {
      // Body ratio is good, but close is below the structural level
      // Open=2000, Close=2008, High=2010, Low=1998
      // Body = 8, Range = 12, Ratio = 0.67 ≥ 0.60 ✓
      // Close (2008) <= priorStructuralLevel (2010) — NOT above ✗
      const candle = makeCandle({ open: 2000, high: 2010, low: 1998, close: 2008 });
      expect(analyzer.isExpansionCandle(candle, 2010, 'bullish')).toBe(false);
    });

    it('should return false for a candle with zero range', () => {
      const candle = makeCandle({ open: 2000, high: 2000, low: 2000, close: 2000 });
      expect(analyzer.isExpansionCandle(candle, 2000, 'bearish')).toBe(false);
      expect(analyzer.isExpansionCandle(candle, 2000, 'bullish')).toBe(false);
    });

    it('should detect expansion candle at exactly 60% body ratio', () => {
      // Body = 6, Range = 10, Ratio = 0.60 ≥ 0.60 ✓ (boundary)
      // Open=2010, Close=2004, High=2010, Low=2000
      const candle = makeCandle({ open: 2010, high: 2010, low: 2000, close: 2004 });
      expect(analyzer.isExpansionCandle(candle, 2005, 'bearish')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should return no rejection when range is zero', () => {
      const candle = makeCandle({ open: 2000, high: 2000, low: 2000, close: 2000 });
      const resultBearish = analyzer.isRejectionCandle(candle, 'bearish');
      const resultBullish = analyzer.isRejectionCandle(candle, 'bullish');
      expect(resultBearish.isRejection).toBe(false);
      expect(resultBullish.isRejection).toBe(false);
    });

    it('should prioritize shooting star over bearish engulfing when both conditions met', () => {
      // A candle that is both a shooting star AND could be bearish engulfing
      // Shooting star is checked first
      const priorCandle = makeCandle({ open: 2003, high: 2006, low: 2001, close: 2004 });
      const candle = makeCandle({ open: 2005, high: 2030, low: 2000, close: 2002 });
      const result = analyzer.isRejectionCandle(candle, 'bearish', priorCandle);
      expect(result.isRejection).toBe(true);
      expect(result.pattern).toBe('shooting_star');
    });

    it('should prioritize hammer over bullish engulfing when both conditions met', () => {
      // A candle that is both a hammer AND could be bullish engulfing
      const priorCandle = makeCandle({ open: 2010, high: 2011, low: 2009, close: 2009 });
      // Hammer: bottom wick ≥ 2× body
      // open=2008, close=2010, high=2011, low=2000
      // body = 2, bottom wick = 2008 - 2000 = 8, 8 >= 2*2 ✓
      // Also bullish engulfing: body [2008, 2010] engulfs [2009, 2010]
      const candle = makeCandle({ open: 2008, high: 2011, low: 2000, close: 2010 });
      const result = analyzer.isRejectionCandle(candle, 'bullish', priorCandle);
      expect(result.isRejection).toBe(true);
      expect(result.pattern).toBe('hammer');
    });
  });
});
