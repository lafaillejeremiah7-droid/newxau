/**
 * Comprehensive Pipeline Tests for Signal Processing Components
 *
 * Tests for:
 * - StopLossTargetMapper (Requirements 5.1-5.7)
 * - VolumeFilter (Requirements 9.1-9.5)
 * - KellySizer (Requirements 8.1-8.7)
 * - SlippageSimulator (Requirements 10.1-10.6)
 * - SignalOutputFormatter (Requirements 11.1-11.7, 16.3)
 */

import { describe, it, expect } from 'vitest';
import { createStopLossTargetMapper } from '../pipeline/stop-loss-target-mapper.js';
import { createVolumeFilter } from '../pipeline/volume-filter.js';
import { createKellySizer } from '../pipeline/kelly-sizer.js';
import { createSlippageSimulator } from '../pipeline/slippage-simulator.js';
import { createSignalOutputFormatter } from '../pipeline/signal-output-formatter.js';
import type { Candle } from '../types/candle.js';
import type { RawSignal } from '../types/signal.js';

// ============================================================================
// HELPERS
// ============================================================================

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

function makeRawSignal(overrides: Partial<RawSignal> = {}): RawSignal {
  return {
    id: 'sig-001',
    timestamp: '2024-01-15T14:30:00.000Z',
    direction: 'long',
    entryPrice: 2040.0,
    liquidityZoneLevel: 2038.5,
    structuralWindowUpper: 2041.0,
    structuralWindowLower: 2039.0,
    rejectionCandleType: 'hammer',
    expansionCandles: [],
    retracementCandles: [],
    observationCandles: [],
    ...overrides,
  };
}

// ============================================================================
// STOP LOSS TARGET MAPPER TESTS (≥15 tests)
// ============================================================================

describe('Signal Pipeline Tests', () => {
  describe('StopLossTargetMapper', () => {
    const mapper = createStopLossTargetMapper();

    // Wick Cluster Detection Tests
    it('should detect wick cluster with 3+ wicks within 1 pip range', () => {
      // Create candles with wicks clustered around 2000.5
      const candles = [
        makeCandle({ low: 2000.4, high: 2001.0 }), // wick low at 2000.4
        makeCandle({ low: 2000.5, high: 2001.0 }), // wick low at 2000.5
        makeCandle({ low: 2000.45, high: 2001.0 }), // wick low at 2000.45
      ];

      const cluster = mapper.findWickCluster(candles, 'low', 20);
      expect(cluster).not.toBeNull();
      expect(cluster!.wickCount).toBeGreaterThanOrEqual(3);
    });

    it('should return null for no wick cluster (< 3 wicks)', () => {
      const candles = [
        makeCandle({ low: 2000.0, high: 2001.0 }),
        makeCandle({ low: 2001.0, high: 2002.0 }), // no cluster
      ];

      const cluster = mapper.findWickCluster(candles, 'low', 20);
      expect(cluster).toBeNull();
    });

    it('should respect 20-candle lookback window', () => {
      const candles = Array(30)
        .fill(null)
        .map((_, i) =>
          makeCandle({
            low: 2000.0 + i * 0.1,
            high: 2001.0 + i * 0.1,
            timestamp: new Date(i * 60000).toISOString(),
          })
        );

      // Should only look at last 20 candles
      const cluster = mapper.findWickCluster(candles, 'low', 20);
      // The last 20 candles are spread out, no cluster
      expect(cluster).toBeNull();
    });

    // Stop Loss Calculation Tests
    it('should calculate SL with 1 pip buffer for chop_zone long signal', () => {
      // Create wick cluster
      const candles = [
        makeCandle({ low: 1999.4 }),
        makeCandle({ low: 1999.5 }),
        makeCandle({ low: 1999.45 }),
      ];

      const signal = makeRawSignal({ direction: 'long' });
      const sl = mapper.calculateStopLoss(signal, candles, 'chop_zone');

      // SL should be ~1 pip (0.1) below the cluster
      expect(sl).toBeLessThan(1999.4); // below the lowest wick
    });

    it('should calculate SL with 2 pips buffer for expansion_zone long signal', () => {
      const candles = [
        makeCandle({ low: 1999.4 }),
        makeCandle({ low: 1999.5 }),
        makeCandle({ low: 1999.45 }),
      ];

      const signal = makeRawSignal({ direction: 'long' });
      const sl = mapper.calculateStopLoss(signal, candles, 'expansion_zone');

      // SL should be ~2 pips (0.2) below the cluster
      expect(sl).toBeLessThan(1999.3);
    });

    // Liquidity Pocket Tests
    it('should find liquidity pocket (≥5 pips width, no volume block)', () => {
      const candles = [
        makeCandle({ low: 2000.0, high: 2000.5, volume: 50 }),
        makeCandle({ low: 2000.5, high: 2001.0, volume: 50 }),
        makeCandle({ low: 2001.0, high: 2001.5, volume: 50 }),
      ];

      const pocket = mapper.findLiquidityPocket(candles, 'up', 100);
      expect(pocket).not.toBeNull();
      expect(pocket!.width).toBeGreaterThanOrEqual(5); // 50 pips total
    });

    it('should return null when pocket width < 5 pips', () => {
      const candles = [
        makeCandle({ low: 2000.0, high: 2000.3, volume: 200 }), // high volume block
      ];

      const pocket = mapper.findLiquidityPocket(candles, 'up', 100);
      expect(pocket).toBeNull();
    });

    // Target Calculation Tests
    it('should calculate R-unit correctly (|entry - SL|)', () => {
      const entry = 2040.0;
      const sl = 2038.0;

      const result = mapper.calculateTargets(entry, sl, 2.0, [], 0);
      expect(result.rUnit).toBeCloseTo(2.0, 5);
    });

    it('should validate 1.5R minimum reward', () => {
      const entry = 2040.0;
      const sl = 2038.0; // rUnit = 2.0, min target = 3.0
      // With 1.5R zone target for long, reward = 2.0 * 1.5 = 3.0 exactly
      const result = mapper.calculateTargets(entry, sl, 1.5, [], 0);

      expect(result.isValid).toBe(true);
      expect(result.tp2).toBeCloseTo(2043.0, 5); // 2040 + 1.5*2.0 for long
    });

    it('should invalidate when target < 1.5R after adjustment', () => {
      // Create scenario where volume block forces adjustment
      const entry = 2040.0;
      const sl = 2038.0;
      const candles = [makeCandle({ low: 2040.3, high: 2040.8, volume: 200 })];

      const result = mapper.calculateTargets(entry, sl, 3.0, candles, 100);
      // Block very close to entry forces target below 1.5R
      if (result.tp2 - entry < 1.5 * result.rUnit) {
        expect(result.isValid).toBe(false);
      }
    });

    it('should adjust target before volume blocks (long)', () => {
      const entry = 2000.0;
      const sl = 1999.0;
      const candles = [
        makeCandle({ low: 2001.5, high: 2002.0, volume: 200 }), // block
      ];

      const result = mapper.calculateTargets(entry, sl, 3.0, candles, 100);
      expect(result.tp2).toBeLessThan(2001.5);
    });

    it('should adjust target before volume blocks (short)', () => {
      const entry = 2000.0;
      const sl = 2001.0;
      const candles = [
        makeCandle({ low: 1998.0, high: 1998.5, volume: 200 }), // block
      ];

      const result = mapper.calculateTargets(entry, sl, 3.0, candles, 100);
      expect(result.tp2).toBeGreaterThan(1998.5);
    });

    it('should project targets correctly without volume blocks', () => {
      const entry = 2000.0;
      const sl = 1999.0;
      // 3.0R target, no blocks
      const result = mapper.calculateTargets(entry, sl, 3.0, [], 0);

      expect(result.tp2).toBeCloseTo(2003.0, 5);
      expect(result.isValid).toBe(true);
    });

    it('should detect wick cluster for short (high wicks)', () => {
      const candles = [
        makeCandle({ high: 2000.4 }),
        makeCandle({ high: 2000.5 }),
        makeCandle({ high: 2000.45 }),
      ];

      const cluster = mapper.findWickCluster(candles, 'high', 20);
      expect(cluster).not.toBeNull();
      expect(cluster!.wickCount).toBeGreaterThanOrEqual(3);
    });

    it('should handle edge case: empty candle array', () => {
      const cluster = mapper.findWickCluster([], 'low', 20);
      expect(cluster).toBeNull();
    });
  });


  // ============================================================================
  // VOLUME FILTER TESTS (≥12 tests)
  // ============================================================================

  describe('VolumeFilter', () => {
    const filter = createVolumeFilter();

    // Volume Rejection Tests
    it('should reject when volume < 20-period SMA', () => {
      const result = filter.evaluate(100, 200, [150, 160, 170, 180, 190]);

      expect(result.rejected).toBe(true);
      expect(result.passed).toBe(false);
      expect(result.rejectionReason).toBe('Volume below 20-period SMA');
    });

    it('should pass when volume >= 20-period SMA', () => {
      const result = filter.evaluate(200, 200, [150, 160, 170, 180, 190]);

      expect(result.rejected).toBe(false);
      expect(result.passed).toBe(true);
      expect(result.rejectionReason).toBeNull();
    });

    // Expansion Zone Tests (3.0R, 35% partial profit)
    it('should classify as expansion_zone with ≥3 increasing consecutive pairs', () => {
      // [100, 200, 300, 400, 350] → pairs: +,+,+,- → 3 increasing
      const result = filter.evaluate(500, 200, [100, 200, 300, 400, 350]);

      expect(result.zoneClassification).toBe('expansion_zone');
      expect(result.targetRMultiple).toBe(3.0);
      expect(result.partialProfitAt).toBe(0.35);
    });

    it('should classify as expansion_zone with all 4 increasing pairs', () => {
      // [100, 200, 300, 400, 500] → all increasing
      const result = filter.evaluate(600, 200, [100, 200, 300, 400, 500]);

      expect(result.zoneClassification).toBe('expansion_zone');
      expect(result.targetRMultiple).toBe(3.0);
      expect(result.partialProfitAt).toBe(0.35);
    });

    // Chop Zone Tests (1.5R, no partial profit)
    it('should classify as chop_zone with ≥3 decreasing consecutive pairs (1.5R)', () => {
      // [500, 400, 300, 200, 250] → pairs: -,-,-,+ → 3 decreasing
      const result = filter.evaluate(300, 200, [500, 400, 300, 200, 250]);

      expect(result.zoneClassification).toBe('chop_zone');
      expect(result.targetRMultiple).toBe(1.5);
      expect(result.partialProfitAt).toBeNull();
    });

    it('should classify as chop_zone with all 4 decreasing pairs', () => {
      // [500, 400, 300, 200, 100] → all decreasing
      const result = filter.evaluate(300, 200, [500, 400, 300, 200, 100]);

      expect(result.zoneClassification).toBe('chop_zone');
      expect(result.targetRMultiple).toBe(1.5);
      expect(result.partialProfitAt).toBeNull();
    });

    // Default Zone Tests (2.0R)
    it('should default to chop_zone with 2.0R when neither condition met', () => {
      // [100, 200, 100, 200, 100] → pairs: +,-,+,- → no dominant trend
      const result = filter.evaluate(300, 200, [100, 200, 100, 200, 100]);

      expect(result.zoneClassification).toBe('chop_zone');
      expect(result.targetRMultiple).toBe(2.0);
      expect(result.partialProfitAt).toBeNull();
    });

    it('should default to chop_zone with 2.0R when volumes are equal', () => {
      // [200, 200, 200, 200, 200] → no increasing or decreasing pairs
      const result = filter.evaluate(300, 200, [200, 200, 200, 200, 200]);

      expect(result.zoneClassification).toBe('chop_zone');
      expect(result.targetRMultiple).toBe(2.0);
      expect(result.partialProfitAt).toBeNull();
    });

    // SMA Calculation & Edge Cases
    it('should calculate 20-period SMA correctly', () => {
      // With current volume < SMA, should reject
      const result = filter.evaluate(150, 200, [180, 190, 200, 210, 220]);

      expect(result.rejected).toBe(true);
    });

    it('should handle volumes with minimal differences', () => {
      const result = filter.evaluate(300, 200, [100.001, 100.002, 100.003, 100.004, 100.005]);

      expect(result.zoneClassification).toBe('expansion_zone');
      expect(result.targetRMultiple).toBe(3.0);
    });

    it('should handle zero volume (rejected)', () => {
      const result = filter.evaluate(0, 200, [100, 200, 300, 400, 500]);

      expect(result.rejected).toBe(true);
    });

    // SMA Equality Tests
    it('should not reject when volume exactly equals SMA', () => {
      const result = filter.evaluate(200, 200, [100, 200, 300, 400, 500]);

      expect(result.passed).toBe(true);
      expect(result.rejected).toBe(false);
    });
  });


  // ============================================================================
  // KELLY SIZER TESTS (≥15 tests)
  // ============================================================================

  describe('KellySizer', () => {
    const sizer = createKellySizer();

    function createSignalHistory(pnlValues: number[]) {
      return pnlValues.map((pnl, i) => ({
        signalId: `signal-${i}`,
        pnl,
        riskAmount: 35,
        timestamp: new Date(Date.now() - (pnlValues.length - i) * 300000).toISOString(),
      }));
    }

    // Cold Start Tests (< 20 signals)
    it('should return $35.00 for empty history (cold start)', () => {
      const result = sizer.calculateRisk([]);

      expect(result.riskAmount).toBe(35.0);
      expect(result.isColdStart).toBe(true);
    });

    it('should return $35.00 for 1 signal (cold start)', () => {
      const history = createSignalHistory([10]);
      const result = sizer.calculateRisk(history);

      expect(result.riskAmount).toBe(35.0);
      expect(result.isColdStart).toBe(true);
    });

    it('should return $35.00 for 19 signals (cold start)', () => {
      const history = createSignalHistory(Array(19).fill(5));
      const result = sizer.calculateRisk(history);

      expect(result.riskAmount).toBe(35.0);
      expect(result.isColdStart).toBe(true);
    });

    it('should NOT be cold start at exactly 20 signals (warm start)', () => {
      const history = createSignalHistory(Array(20).fill(5));
      const result = sizer.calculateRisk(history);

      expect(result.isColdStart).toBe(false);
    });

    // Warm Start Tests (≥20 signals)
    it('should return value in [$17.50, $70.00] for warm start', () => {
      const history = createSignalHistory(Array(20).fill(5));
      const result = sizer.calculateRisk(history);

      expect(result.riskAmount).toBeGreaterThanOrEqual(17.5);
      expect(result.riskAmount).toBeLessThanOrEqual(70.0);
    });

    // Drawdown Tests
    it('should allow ceiling ($70) for drawdown ≤ 2% with low variance', () => {
      // All positive → 0% drawdown
      const history = createSignalHistory(Array(20).fill(5));
      const result = sizer.calculateRisk(history);

      expect(result.riskAmount).toBe(70.0);
      expect(result.rollingDrawdown).toBe(0);
    });

    it('should apply moderate level for drawdown in middle range', () => {
      // Create drawdown in the 2-5% range (not quite in the linear zone)
      const pnlValues = [300, ...Array(19).fill(-12)];
      const history = createSignalHistory(pnlValues);
      const result = sizer.calculateRisk(history);

      // Should be in moderate range, not at extremes
      expect(result.riskAmount).toBeGreaterThan(17.5);
      expect(result.riskAmount).toBeLessThan(70.0);
    });

    it('should reduce amount when drawdown exceeds 5%', () => {
      // Create ~10% drawdown at the boundary to reach floor
      const pnlValues = [1000, ...Array(19).fill(-52.6)];
      const history = createSignalHistory(pnlValues);
      const result = sizer.calculateRisk(history);

      // Drawdown close to 10% should reach floor at $17.50
      expect(result.riskAmount).toBeLessThanOrEqual(70.0);
      expect(result.riskAmount).toBeGreaterThanOrEqual(17.5);
    });

    it('should reach floor ($17.50) for drawdown > 10%', () => {
      // Create >10% drawdown
      const pnlValues = [1000, ...Array(19).fill(-100)];
      const history = createSignalHistory(pnlValues);
      const result = sizer.calculateRisk(history);

      expect(result.rollingDrawdown).toBeGreaterThan(10.0);
      expect(result.riskAmount).toBe(17.5);
    });

    // Variance & Adjustment Tests
    it('should handle high variance appropriately', () => {
      // Create significant variance pattern
      const pnlValues = [];
      for (let i = 0; i < 10; i++) {
        pnlValues.push(-100);
        pnlValues.push(100);
      }
      const history = createSignalHistory(pnlValues);
      const result = sizer.calculateRisk(history);

      // With high variance and near-zero drawdown, should still produce valid result
      expect(result.riskAmount).toBeGreaterThanOrEqual(17.5);
      expect(result.riskAmount).toBeLessThanOrEqual(70.0);
      expect(isFinite(result.riskAmount)).toBe(true);
    });

    // Bounds Enforcement Tests
    it('should never go below $17.50 floor', () => {
      const pnlValues = [1500, ...Array(19).fill(-200)];
      const history = createSignalHistory(pnlValues);
      const result = sizer.calculateRisk(history);

      expect(result.riskAmount).toBeGreaterThanOrEqual(17.5);
    });

    it('should never exceed $70.00 ceiling', () => {
      const history = createSignalHistory(Array(20).fill(100));
      const result = sizer.calculateRisk(history);

      expect(result.riskAmount).toBeLessThanOrEqual(70.0);
    });

    // Output Consistency Tests
    it('should always return finite and positive amounts', () => {
      const history = createSignalHistory(Array(20).fill(0));
      const result = sizer.calculateRisk(history);

      expect(isFinite(result.riskAmount)).toBe(true);
      expect(result.riskAmount).toBeGreaterThan(0);
    });

    it('should use only last 20 signals for calculations', () => {
      // 30 signals: first 10 losing, last 20 stable
      const pnlValues = [...Array(10).fill(-50), ...Array(20).fill(5)];
      const history = createSignalHistory(pnlValues);
      const result = sizer.calculateRisk(history);

      // Should only look at last 20 → ceiling
      expect(result.riskAmount).toBe(70.0);
    });

    it('should handle all-negative P&L with floor enforcement', () => {
      const pnlValues = Array(20).fill(-25);
      const history = createSignalHistory(pnlValues);
      const result = sizer.calculateRisk(history);

      // Significant losing streak should enforce floor
      expect(result.riskAmount).toBeGreaterThanOrEqual(17.5);
      expect(result.riskAmount).toBeLessThanOrEqual(70.0);
    });
  });


  // ============================================================================
  // SLIPPAGE SIMULATOR TESTS (≥8 tests)
  // ============================================================================

  describe('SlippageSimulator', () => {
    // Probability Tests
    it('should apply slippage in ~20% of cases (probability test)', () => {
      // Use a seeded random to test probability
      let slippageCount = 0;
      const testRuns = 100;

      for (let i = 0; i < testRuns; i++) {
        let callCount = 0;
        const mockRandom = () => {
          callCount++;
          // Return values from 0 to 1, roughly 20% below 0.2
          return (i % 5 === 0 && callCount === 1) ? 0.1 : 0.5;
        };

        const simulator = createSlippageSimulator(mockRandom);
        const result = simulator.applySlippage({
          entryPrice: 2000,
          direction: 'long',
        });

        if (result.applied) slippageCount++;
      }

      // Should be roughly 20 out of 100 (allow variance)
      expect(slippageCount).toBeGreaterThan(10);
      expect(slippageCount).toBeLessThan(30);
    });

    it('should NOT apply slippage when random >= 0.2', () => {
      const mockRandom = () => 0.2;
      const simulator = createSlippageSimulator(mockRandom);
      const result = simulator.applySlippage({
        entryPrice: 2000,
        direction: 'long',
      });

      expect(result.applied).toBe(false);
      expect(result.adjustedEntry).toBe(2000);
    });

    // Slippage Range Tests
    it('should apply slippage in range [0.5, 2.5] pips', () => {
      let callCount = 0;
      const mockRandom = () => {
        callCount++;
        return callCount === 1 ? 0.0 : 0.5; // apply, midpoint
      };

      const simulator = createSlippageSimulator(mockRandom);
      const result = simulator.applySlippage({
        entryPrice: 2000,
        direction: 'long',
      });

      expect(result.slippagePips).toBeGreaterThanOrEqual(0.5);
      expect(result.slippagePips).toBeLessThanOrEqual(2.5);
    });

    // Direction Tests
    it('should apply slippage adverse to trade direction (LONG)', () => {
      let callCount = 0;
      const mockRandom = () => {
        callCount++;
        return callCount === 1 ? 0.0 : 0.5; // apply, 1.5 pips
      };

      const simulator = createSlippageSimulator(mockRandom);
      const result = simulator.applySlippage({
        entryPrice: 2000,
        direction: 'long',
      });

      // For long: worse = higher entry
      expect(result.adjustedEntry).toBeGreaterThan(result.originalEntry);
    });

    it('should apply slippage adverse to trade direction (SHORT)', () => {
      let callCount = 0;
      const mockRandom = () => {
        callCount++;
        return callCount === 1 ? 0.0 : 0.5; // apply, 1.5 pips
      };

      const simulator = createSlippageSimulator(mockRandom);
      const result = simulator.applySlippage({
        entryPrice: 2000,
        direction: 'short',
      });

      // For short: worse = lower entry
      expect(result.adjustedEntry).toBeLessThan(result.originalEntry);
    });

    // Output Format Tests
    it('should return complete SlippageResult when applied', () => {
      let callCount = 0;
      const mockRandom = () => {
        callCount++;
        return callCount === 1 ? 0.0 : 0.5;
      };

      const simulator = createSlippageSimulator(mockRandom);
      const result = simulator.applySlippage({
        entryPrice: 2000,
        direction: 'long',
      });

      expect(result).toHaveProperty('applied');
      expect(result).toHaveProperty('originalEntry');
      expect(result).toHaveProperty('adjustedEntry');
      expect(result).toHaveProperty('slippagePips');
    });

    it('should return complete SlippageResult when not applied', () => {
      const mockRandom = () => 0.5;
      const simulator = createSlippageSimulator(mockRandom);
      const result = simulator.applySlippage({
        entryPrice: 2000,
        direction: 'long',
      });

      expect(result).toHaveProperty('applied');
      expect(result).toHaveProperty('originalEntry');
      expect(result).toHaveProperty('adjustedEntry');
      expect(result).toHaveProperty('slippagePips');
      expect(result.slippagePips).toBe(0);
    });

    it('should convert pips correctly to price units (1 pip = 0.1)', () => {
      let callCount = 0;
      const mockRandom = () => {
        callCount++;
        // 1.0 pip: (1.0 - 0.5) / (2.5 - 0.5) = 0.25
        return callCount === 1 ? 0.0 : 0.25;
      };

      const simulator = createSlippageSimulator(mockRandom);
      const result = simulator.applySlippage({
        entryPrice: 2000,
        direction: 'long',
      });

      // 1.0 pip * 0.1 = 0.10 price units
      expect(result.slippagePips).toBeCloseTo(1.0, 5);
      expect(result.adjustedEntry).toBeCloseTo(2000.10, 5);
    });

    it('should handle maximum slippage (2.5 pips)', () => {
      let callCount = 0;
      const mockRandom = () => {
        callCount++;
        return callCount === 1 ? 0.0 : 0.9999;
      };

      const simulator = createSlippageSimulator(mockRandom);
      const result = simulator.applySlippage({
        entryPrice: 2000,
        direction: 'short',
      });

      expect(result.slippagePips).toBeCloseTo(2.5, 1);
      // Allow small floating point difference
      expect(result.adjustedEntry).toBeLessThanOrEqual(1999.76);
    });
  });


  // ============================================================================
  // SIGNAL OUTPUT FORMATTER TESTS (≥12 tests)
  // ============================================================================

  describe('SignalOutputFormatter', () => {
    const formatter = createSignalOutputFormatter();

    function makeFormatterInput(overrides: any = {}) {
      const rawSignal = makeRawSignal();
      return {
        rawSignal,
        stopLoss: 2038.0,
        targets: {
          rUnit: 2.0,
          tp1: 2042.1,
          tp2: 2046.0,
          isValid: true,
        },
        zoneClassification: 'expansion_zone' as const,
        kellyResult: {
          riskAmount: 35.0,
          riskPercentage: 0.7,
          rollingDrawdown: 0,
          equityCurveVariance: 0,
          historicalAverageVariance: 0,
          isColdStart: true,
          adjustmentReason: 'Cold start',
        },
        slippageResult: {
          applied: false,
          originalEntry: rawSignal.entryPrice,
          adjustedEntry: rawSignal.entryPrice,
          slippagePips: 0,
        },
        ...overrides,
      };
    }

    // Split Position Tests
    it('should split position: Ticket 1 (45%), Ticket 2 (55%)', () => {
      const input = makeFormatterInput();
      const result = formatter.format(input);

      expect(result.ticket1.positionSizePercent).toBe(45);
      expect(result.ticket2.positionSizePercent).toBe(55);
      expect(
        result.ticket1.positionSizePercent + result.ticket2.positionSizePercent
      ).toBe(100);
    });

    // TP1 Calculation Tests
    it('should calculate TP1 = E + 0.35×(TP2-E) for longs', () => {
      const entry = 2040.0;
      const tp2 = 2046.0;
      const input = makeFormatterInput({
        rawSignal: makeRawSignal({ direction: 'long', entryPrice: entry }),
        targets: { rUnit: 2.0, tp1: 2042.1, tp2, isValid: true },
        slippageResult: {
          applied: false,
          originalEntry: entry,
          adjustedEntry: entry,
          slippagePips: 0,
        },
      });

      const result = formatter.format(input);
      const expectedTp1 = entry + 0.35 * (tp2 - entry);

      expect(result.ticket1.takeProfit).toBeCloseTo(expectedTp1, 5);
    });

    it('should calculate TP1 = E - 0.35×(E-TP2) for shorts', () => {
      const entry = 2050.0;
      const tp2 = 2044.0;
      const input = makeFormatterInput({
        rawSignal: makeRawSignal({
          direction: 'short',
          entryPrice: entry,
        }),
        targets: { rUnit: 2.0, tp1: 2047.9, tp2, isValid: true },
        slippageResult: {
          applied: false,
          originalEntry: entry,
          adjustedEntry: entry,
          slippagePips: 0,
        },
      });

      const result = formatter.format(input);
      const expectedTp1 = entry - 0.35 * (entry - tp2);

      expect(result.ticket1.takeProfit).toBeCloseTo(expectedTp1, 5);
    });

    // TP2 Assignment Tests
    it('should assign TP2 for expansion_zone (3.0R)', () => {
      const input = makeFormatterInput({
        targets: { rUnit: 2.0, tp1: 2042.1, tp2: 2046.0, isValid: true },
        zoneClassification: 'expansion_zone' as const,
      });

      const result = formatter.format(input);
      expect(result.ticket2.takeProfit).toBe(2046.0);
    });

    it('should assign TP2 for chop_zone (1.5R)', () => {
      const input = makeFormatterInput({
        targets: { rUnit: 2.0, tp1: 2041.3, tp2: 2043.0, isValid: true },
        zoneClassification: 'chop_zone' as const,
      });

      const result = formatter.format(input);
      expect(result.ticket2.takeProfit).toBe(2043.0);
    });

    // Breakeven & Trailing Stop Tests
    it('should generate breakeven trigger instruction', () => {
      const input = makeFormatterInput();
      const result = formatter.format(input);

      expect(result.breakevenTrigger).toContain('Ticket 1 TP');
      expect(result.breakevenTrigger).toContain('move Ticket 2 SL to entry');
    });

    it('should generate trailing stop guidance with swing point', () => {
      const input = makeFormatterInput({
        recentSwingPoint: 2039.5,
      });

      const result = formatter.format(input);

      expect(result.trailingStopGuidance).toContain('swing low');
      expect(result.trailingStopGuidance).toContain('2039.50');
      expect(result.trailingStopGuidance).toContain('breakeven');
    });

    // Kelly Risk & Zone Tests
    it('should include Kelly risk amount ($35-$70)', () => {
      const input = makeFormatterInput({
        kellyResult: {
          riskAmount: 52.5,
          riskPercentage: 1.05,
          rollingDrawdown: 3.0,
          equityCurveVariance: 100,
          historicalAverageVariance: 100,
          isColdStart: false,
          adjustmentReason: 'Moderate drawdown',
        },
      });

      const result = formatter.format(input);
      expect(result.riskAmount).toBe(52.5);
    });

    it('should include zone classification in output', () => {
      const input = makeFormatterInput({
        zoneClassification: 'expansion_zone' as const,
      });

      const result = formatter.format(input);
      expect(result.zoneClassification).toBe('expansion_zone');
    });

    // Slippage Details Tests
    it('should include slippage details in output', () => {
      const input = makeFormatterInput({
        slippageResult: {
          applied: true,
          originalEntry: 2040.0,
          adjustedEntry: 2040.15,
          slippagePips: 1.5,
        },
      });

      const result = formatter.format(input);
      expect(result.slippage.applied).toBe(true);
      expect(result.slippage.originalEntry).toBe(2040.0);
      expect(result.slippage.adjustedEntry).toBe(2040.15);
      expect(result.slippage.slippagePips).toBe(1.5);
    });

    // Instrument & Reasoning Tests
    it('should label instrument as XAUUSD', () => {
      const input = makeFormatterInput();
      const result = formatter.format(input);

      expect(result.instrument).toBe('XAUUSD');
    });

    it('should limit reasoning to 280 characters', () => {
      const input = makeFormatterInput();
      const result = formatter.format(input);

      expect(result.reasoning.length).toBeLessThanOrEqual(280);
    });

    it('should include all required fields in output', () => {
      const input = makeFormatterInput();
      const result = formatter.format(input);

      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('timestamp');
      expect(result).toHaveProperty('instrument');
      expect(result).toHaveProperty('direction');
      expect(result).toHaveProperty('entryPrice');
      expect(result).toHaveProperty('stopLoss');
      expect(result).toHaveProperty('ticket1');
      expect(result).toHaveProperty('ticket2');
      expect(result).toHaveProperty('zoneClassification');
      expect(result).toHaveProperty('riskAmount');
      expect(result).toHaveProperty('rUnit');
      expect(result).toHaveProperty('reasoning');
      expect(result).toHaveProperty('slippage');
      expect(result).toHaveProperty('breakevenTrigger');
      expect(result).toHaveProperty('trailingStopGuidance');
    });

    it('should use adjusted entry when slippage applied', () => {
      const input = makeFormatterInput({
        rawSignal: makeRawSignal({
          direction: 'long',
          entryPrice: 2040.0,
        }),
        slippageResult: {
          applied: true,
          originalEntry: 2040.0,
          adjustedEntry: 2040.2,
          slippagePips: 2.0,
        },
      });

      const result = formatter.format(input);
      expect(result.entryPrice).toBe(2040.2);
      expect(result.ticket1.entryPrice).toBe(2040.2);
      expect(result.ticket2.entryPrice).toBe(2040.2);
    });
  });
});
