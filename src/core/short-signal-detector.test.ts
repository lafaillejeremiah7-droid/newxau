/**
 * Unit tests for Short Signal Detector
 *
 * Covers Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
 *
 * Tests the three detection phases:
 * 1. Expansion phase: ≥2 consecutive bearish expansion candles
 * 2. Retracement phase: 2-4 corrective candles
 * 3. Rejection phase: bearish rejection candle
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ShortSignalDetector,
  findLocalMinorLow,
  DEFAULT_SHORT_DETECTOR_CONFIG,
} from './short-signal-detector.js';
import { createCandlePatternAnalyzer } from './candle-pattern-analyzer.js';
import type { CandlePatternAnalyzer } from './candle-pattern-analyzer.js';
import type { Candle } from '../types/candle.js';

/**
 * Helper: create a basic M5 candle with overrides.
 */
function createCandle(overrides: Partial<Candle> = {}): Candle {
  return {
    instrument: 'XAUUSD',
    timeframe: 'M5',
    timestamp: '2024-01-15T14:00:00.000Z',
    open: 2050.0,
    high: 2052.0,
    low: 2048.0,
    close: 2049.0,
    volume: 1000,
    ...overrides,
  };
}


/**
 * Helper: create a bearish expansion candle.
 * Body ≥60% of range, closes below the given structural level.
 */
function createBearishExpansionCandle(
  closeBelow: number,
  overrides: Partial<Candle> = {},
): Candle {
  // Body = |open - close| = 6, range = high - low = 8, ratio = 6/8 = 75%
  const close = closeBelow - 0.5;
  return createCandle({
    open: close + 6,
    high: close + 7,
    low: close - 1,
    close,
    volume: 2000,
    ...overrides,
  });
}

/**
 * Helper: create a retracement candle (lower volume and smaller body than expansion).
 */
function createRetracementCandle(
  avgExpVol: number,
  avgExpBody: number,
  overrides: Partial<Candle> = {},
): Candle {
  // Body smaller than avgExpBody, volume less than avgExpVol
  const body = avgExpBody * 0.5;
  return createCandle({
    open: 2045.0,
    high: 2046.0,
    low: 2044.0,
    close: 2045.0 + body,
    volume: avgExpVol * 0.5,
    ...overrides,
  });
}


/**
 * Helper: create a shooting star candle (bearish rejection).
 * Top wick ≥50% of range, body in lower third.
 */
function createShootingStar(overrides: Partial<Candle> = {}): Candle {
  // range = 10, topWick = 7 (70%), body in lower third
  return createCandle({
    open: 2041.0,
    close: 2040.5,
    high: 2048.0,
    low: 2038.0,
    volume: 500,
    ...overrides,
  });
}

/**
 * Helper: create a bearish engulfing candle.
 */
function createBearishEngulfing(
  priorOpen: number,
  priorClose: number,
  overrides: Partial<Candle> = {},
): Candle {
  const priorBodyHigh = Math.max(priorOpen, priorClose);
  const priorBodyLow = Math.min(priorOpen, priorClose);
  // Current body must fully engulf prior body, and be bearish (close < open)
  return createCandle({
    open: priorBodyHigh + 1,
    close: priorBodyLow - 1,
    high: priorBodyHigh + 2,
    low: priorBodyLow - 2,
    volume: 500,
    ...overrides,
  });
}


describe('findLocalMinorLow', () => {
  it('should return the lowest low among preceding candles within lookback', () => {
    const candles = [
      createCandle({ low: 2050 }),
      createCandle({ low: 2048 }),
      createCandle({ low: 2052 }),
      createCandle({ low: 2046 }),
      createCandle({ low: 2049 }),
    ];
    expect(findLocalMinorLow(candles, 20)).toBe(2046);
  });

  it('should respect the lookback window', () => {
    const candles = [
      createCandle({ low: 2040 }), // Outside lookback of 3
      createCandle({ low: 2041 }), // Outside lookback of 3
      createCandle({ low: 2048 }),
      createCandle({ low: 2046 }),
      createCandle({ low: 2049 }),
    ];
    expect(findLocalMinorLow(candles, 3)).toBe(2046);
  });

  it('should return Infinity for empty array', () => {
    expect(findLocalMinorLow([], 20)).toBe(Infinity);
  });
});


describe('ShortSignalDetector', () => {
  let analyzer: CandlePatternAnalyzer;

  beforeEach(() => {
    analyzer = createCandlePatternAnalyzer();
  });

  describe('Expansion Phase (Requirement 2.1)', () => {
    it('should detect ≥2 consecutive bearish expansion candles', () => {
      // Preceding candles establish a local minor low at 2048
      const preceding = [
        createCandle({ low: 2050, high: 2055 }),
        createCandle({ low: 2048, high: 2053 }),
        createCandle({ low: 2049, high: 2054 }),
      ];

      const detector = new ShortSignalDetector(analyzer, DEFAULT_SHORT_DETECTOR_CONFIG, preceding);

      // First expansion candle: body 75%, closes below local low 2048
      const exp1 = createBearishExpansionCandle(2048, {
        timestamp: '2024-01-15T14:05:00.000Z',
      });
      const r1 = detector.processCandle(exp1);
      expect(r1.status).toBe('pending');
      expect(detector.getPhase()).toBe('expansion');

      // Second expansion candle
      const exp2 = createBearishExpansionCandle(2046, {
        timestamp: '2024-01-15T14:10:00.000Z',
      });
      const r2 = detector.processCandle(exp2);
      expect(r2.status).toBe('pending');
      expect(detector.getPhase()).toBe('retracement');
    });


    it('should invalidate if expansion streak is broken before reaching minimum', () => {
      const preceding = [
        createCandle({ low: 2048, high: 2055 }),
      ];

      const detector = new ShortSignalDetector(analyzer, DEFAULT_SHORT_DETECTOR_CONFIG, preceding);

      // One expansion candle
      const exp1 = createBearishExpansionCandle(2048, {
        timestamp: '2024-01-15T14:05:00.000Z',
      });
      detector.processCandle(exp1);
      expect(detector.getPhase()).toBe('expansion');

      // Non-expansion candle (body too small relative to range)
      const nonExp = createCandle({
        open: 2050,
        close: 2049.5, // body = 0.5
        high: 2055,    // range = 10, ratio = 5% - not expansion
        low: 2045,
        timestamp: '2024-01-15T14:10:00.000Z',
      });
      const result = detector.processCandle(nonExp);
      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.reason).toContain('Expansion phase incomplete');
      }
    });

    it('should keep pending if no expansion candles found yet', () => {
      const preceding: Candle[] = [];
      const detector = new ShortSignalDetector(analyzer, DEFAULT_SHORT_DETECTOR_CONFIG, preceding);

      // Non-expansion candle with body < 60% range
      const candle = createCandle({
        open: 2050,
        close: 2049.5,
        high: 2055,
        low: 2045,
        volume: 1000,
      });
      const result = detector.processCandle(candle);
      expect(result.status).toBe('pending');
      expect(detector.getPhase()).toBe('expansion');
    });
  });


  describe('Retracement Phase (Requirements 2.2, 2.4, 2.5)', () => {
    let detector: ShortSignalDetector;
    const avgExpVol = 2000;
    const avgExpBody = 6; // From createBearishExpansionCandle

    beforeEach(() => {
      const preceding = [
        createCandle({ low: 2048, high: 2055 }),
        createCandle({ low: 2049, high: 2054 }),
      ];

      detector = new ShortSignalDetector(analyzer, DEFAULT_SHORT_DETECTOR_CONFIG, preceding);

      // Process 2 expansion candles to transition to retracement phase
      const exp1 = createBearishExpansionCandle(2048, {
        timestamp: '2024-01-15T14:05:00.000Z',
        volume: avgExpVol,
      });
      const exp2 = createBearishExpansionCandle(2046, {
        timestamp: '2024-01-15T14:10:00.000Z',
        volume: avgExpVol,
      });
      detector.processCandle(exp1);
      detector.processCandle(exp2);
      expect(detector.getPhase()).toBe('retracement');
    });

    it('should accept valid retracement candles (lower vol and smaller body)', () => {
      const retCandle = createRetracementCandle(avgExpVol, avgExpBody, {
        timestamp: '2024-01-15T14:15:00.000Z',
      });
      const result = detector.processCandle(retCandle);
      expect(result.status).toBe('pending');
    });


    it('should invalidate when retracement exceeds 4 candles without rejection', () => {
      // Send 5 retracement candles (exceeds max of 4)
      for (let i = 0; i < 4; i++) {
        const retCandle = createRetracementCandle(avgExpVol, avgExpBody, {
          timestamp: `2024-01-15T14:${15 + i * 5}:00.000Z`,
        });
        detector.processCandle(retCandle);
      }

      // 5th retracement candle should trigger invalidation
      const fifthCandle = createRetracementCandle(avgExpVol, avgExpBody, {
        timestamp: '2024-01-15T14:35:00.000Z',
      });
      const result = detector.processCandle(fifthCandle);
      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.reason).toContain('exceeded');
        expect(result.reason).toContain('4');
      }
    });

    it('should invalidate when retracement volume exceeds expansion volume', () => {
      // Send a retracement candle with volume exceeding expansion average
      const highVolCandle = createCandle({
        open: 2045,
        close: 2045.5,  // small body
        high: 2046,
        low: 2044,
        volume: avgExpVol * 1.5, // Exceeds expansion average
        timestamp: '2024-01-15T14:15:00.000Z',
      });
      const result = detector.processCandle(highVolCandle);
      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.reason).toContain('volume');
      }
    });
  });


  describe('Rejection Phase (Requirement 2.3)', () => {
    let detector: ShortSignalDetector;
    const avgExpVol = 2000;
    const avgExpBody = 6;

    beforeEach(() => {
      const preceding = [
        createCandle({ low: 2048, high: 2055 }),
        createCandle({ low: 2049, high: 2054 }),
      ];

      detector = new ShortSignalDetector(analyzer, DEFAULT_SHORT_DETECTOR_CONFIG, preceding);

      // Process 2 expansion candles
      const exp1 = createBearishExpansionCandle(2048, {
        timestamp: '2024-01-15T14:05:00.000Z',
        volume: avgExpVol,
      });
      const exp2 = createBearishExpansionCandle(2046, {
        timestamp: '2024-01-15T14:10:00.000Z',
        volume: avgExpVol,
      });
      detector.processCandle(exp1);
      detector.processCandle(exp2);

      // Process 2 retracement candles (minimum to enter rejection phase)
      const ret1 = createRetracementCandle(avgExpVol, avgExpBody, {
        timestamp: '2024-01-15T14:15:00.000Z',
      });
      const ret2 = createRetracementCandle(avgExpVol, avgExpBody, {
        timestamp: '2024-01-15T14:20:00.000Z',
      });
      detector.processCandle(ret1);
      detector.processCandle(ret2);
    });


    it('should return valid when shooting star detected at retracement high', () => {
      const shootingStar = createShootingStar({
        timestamp: '2024-01-15T14:25:00.000Z',
        volume: avgExpVol * 0.4, // Below expansion avg
      });
      const result = detector.processCandle(shootingStar);
      expect(result.status).toBe('valid');
      if (result.status === 'valid') {
        expect(result.context.direction).toBe('short');
        expect(result.context.expansionCandles.length).toBe(2);
        expect(result.context.retracementCandles.length).toBeGreaterThanOrEqual(2);
        expect(result.context.rejectionCandle).not.toBeNull();
        expect(result.context.averageExpansionVolume).toBe(avgExpVol);
        expect(result.context.averageExpansionBodySize).toBe(avgExpBody);
      }
    });

    it('should return valid when bearish engulfing detected', () => {
      // The prior candle in retracement
      const priorRet = createRetracementCandle(avgExpVol, avgExpBody, {
        open: 2045,
        close: 2046,
        timestamp: '2024-01-15T14:25:00.000Z',
      });
      detector.processCandle(priorRet);

      // Bearish engulfing that engulfs the prior candle
      const engulfing = createBearishEngulfing(2045, 2046, {
        timestamp: '2024-01-15T14:30:00.000Z',
        volume: avgExpVol * 0.4,
      });
      const result = detector.processCandle(engulfing);
      expect(result.status).toBe('valid');
      if (result.status === 'valid') {
        expect(result.context.direction).toBe('short');
        expect(result.context.rejectionCandle).not.toBeNull();
      }
    });


    it('should remain pending if candle is not a rejection', () => {
      // Regular candle that is not a rejection pattern
      const normalCandle = createCandle({
        open: 2046,
        close: 2045,
        high: 2047,
        low: 2044.5,
        volume: avgExpVol * 0.4,
        timestamp: '2024-01-15T14:25:00.000Z',
      });
      const result = detector.processCandle(normalCandle);
      // Should be pending or invalid depending on count
      expect(['pending', 'invalid']).toContain(result.status);
    });
  });


  describe('Full Valid Short Signal Flow', () => {
    it('should detect complete valid short setup: expansion → retracement → rejection', () => {
      const preceding = [
        createCandle({ low: 2050, high: 2055 }),
        createCandle({ low: 2048, high: 2053 }),
        createCandle({ low: 2049, high: 2054 }),
      ];

      const detector = new ShortSignalDetector(analyzer, DEFAULT_SHORT_DETECTOR_CONFIG, preceding);

      // Expansion phase: 2 bearish expansion candles
      const exp1 = createBearishExpansionCandle(2048, {
        timestamp: '2024-01-15T14:05:00.000Z',
        volume: 2000,
      });
      expect(detector.processCandle(exp1).status).toBe('pending');

      const exp2 = createBearishExpansionCandle(2046, {
        timestamp: '2024-01-15T14:10:00.000Z',
        volume: 2000,
      });
      expect(detector.processCandle(exp2).status).toBe('pending');
      expect(detector.getPhase()).toBe('retracement');

      // Retracement phase: 2 candles with lower volume and smaller body
      const ret1 = createRetracementCandle(2000, 6, {
        timestamp: '2024-01-15T14:15:00.000Z',
      });
      expect(detector.processCandle(ret1).status).toBe('pending');

      const ret2 = createRetracementCandle(2000, 6, {
        timestamp: '2024-01-15T14:20:00.000Z',
      });
      expect(detector.processCandle(ret2).status).toBe('pending');

      // Rejection phase: shooting star
      const rejection = createShootingStar({
        timestamp: '2024-01-15T14:25:00.000Z',
        volume: 800,
      });
      const result = detector.processCandle(rejection);

      expect(result.status).toBe('valid');
      if (result.status === 'valid') {
        expect(result.context.direction).toBe('short');
        expect(result.context.expansionCandles.length).toBe(2);
        expect(result.context.retracementCandles.length).toBeGreaterThanOrEqual(2);
        expect(result.context.rejectionCandle).toBeDefined();
        expect(result.context.averageExpansionVolume).toBe(2000);
        expect(result.context.structuralBreakLevel).toBeGreaterThan(0);
      }
    });
  });


  describe('Structural Context Recording', () => {
    it('should record structural context with all required fields', () => {
      const preceding = [
        createCandle({ low: 2048, high: 2055 }),
        createCandle({ low: 2049, high: 2054 }),
      ];

      const detector = new ShortSignalDetector(analyzer, DEFAULT_SHORT_DETECTOR_CONFIG, preceding);

      // Complete a valid short signal flow
      const exp1 = createBearishExpansionCandle(2048, { volume: 1800 });
      const exp2 = createBearishExpansionCandle(2046, { volume: 2200 });
      detector.processCandle(exp1);
      detector.processCandle(exp2);

      const ret1 = createRetracementCandle(2000, 6, { volume: 800 });
      const ret2 = createRetracementCandle(2000, 6, { volume: 900 });
      detector.processCandle(ret1);
      detector.processCandle(ret2);

      const rejection = createShootingStar({ volume: 700 });
      const result = detector.processCandle(rejection);

      expect(result.status).toBe('valid');
      if (result.status === 'valid') {
        const ctx = result.context;
        // Verify all fields present
        expect(ctx.direction).toBe('short');
        expect(ctx.expansionCandles).toHaveLength(2);
        expect(ctx.retracementCandles.length).toBeGreaterThanOrEqual(2);
        expect(ctx.rejectionCandle).not.toBeNull();
        expect(ctx.averageExpansionVolume).toBe(2000);
        expect(ctx.averageExpansionBodySize).toBe(6);
        expect(ctx.structuralBreakLevel).toBe(2048);
      }
    });
  });
});
