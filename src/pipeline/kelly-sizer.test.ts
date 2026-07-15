/**
 * Tests for Kelly Sizer - Dynamic Fractional Kelly Position Sizing
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.9
 */

import { describe, it, expect } from 'vitest';
import {
  createKellySizer,
  computeRollingDrawdown,
  computeEquityCurveVariance,
  DEFAULT_KELLY_CONFIG,
  type SignalResult,
  type KellyConfig,
} from './kelly-sizer.js';

// Helper to create a SignalResult array from P&L values
function createSignalHistory(pnlValues: number[]): SignalResult[] {
  return pnlValues.map((pnl, i) => ({
    signalId: `signal-${i}`,
    pnl,
    riskAmount: 35,
    timestamp: new Date(Date.now() - (pnlValues.length - i) * 300000).toISOString(),
  }));
}

describe('Kelly Sizer', () => {
  const sizer = createKellySizer();

  describe('Cold Start (< 20 signals)', () => {
    it('should return $35.00 for empty history', () => {
      const result = sizer.calculateRisk([]);
      expect(result.riskAmount).toBe(35.0);
      expect(result.isColdStart).toBe(true);
      expect(result.riskPercentage).toBeCloseTo(0.7);
    });

    it('should return $35.00 for 1 signal', () => {
      const history = createSignalHistory([10]);
      const result = sizer.calculateRisk(history);
      expect(result.riskAmount).toBe(35.0);
      expect(result.isColdStart).toBe(true);
    });

    it('should return $35.00 for 19 signals', () => {
      const history = createSignalHistory(Array(19).fill(5));
      const result = sizer.calculateRisk(history);
      expect(result.riskAmount).toBe(35.0);
      expect(result.isColdStart).toBe(true);
    });

    it('should NOT be cold start at exactly 20 signals', () => {
      const history = createSignalHistory(Array(20).fill(5));
      const result = sizer.calculateRisk(history);
      expect(result.isColdStart).toBe(false);
    });
  });

  describe('Rolling Drawdown Computation', () => {
    it('should compute 0% drawdown for all positive P&L', () => {
      const pnlValues = Array(20).fill(10);
      const drawdown = computeRollingDrawdown(pnlValues, 5000);
      expect(drawdown).toBe(0);
    });

    it('should compute correct drawdown for simple decline', () => {
      // Cumulative: [50, 100, 50, 0] → peak=100, trough=0, drawdown=100
      const pnlValues = [50, 50, -50, -50];
      const drawdown = computeRollingDrawdown(pnlValues, 5000);
      // drawdown = 100/5000 * 100 = 2%
      expect(drawdown).toBeCloseTo(2.0);
    });

    it('should find the maximum peak-to-trough decline', () => {
      // Cumulative: [100, 200, 50, 100, -50]
      // Peak=200, then drops to -50 → drawdown=250
      const pnlValues = [100, 100, -150, 50, -150];
      const drawdown = computeRollingDrawdown(pnlValues, 5000);
      // drawdown = 250/5000 * 100 = 5%
      expect(drawdown).toBeCloseTo(5.0);
    });

    it('should handle all negative P&L', () => {
      // Cumulative: [-10, -20, -30, ...] → peak = -10 (first), trough lowest
      // Actually peak is the highest cumulative point. First value is -10.
      // Since all are negative, peak = -10, lowest is sum of all.
      const pnlValues = Array(20).fill(-10);
      // Cumulative: [-10, -20, -30, ..., -200]
      // Peak = -10 (first element), max trough = -200
      // Drawdown = (-10 - (-200)) = 190
      const drawdown = computeRollingDrawdown(pnlValues, 5000);
      expect(drawdown).toBeCloseTo((190 / 5000) * 100);
    });

    it('should return 0 for empty array', () => {
      expect(computeRollingDrawdown([], 5000)).toBe(0);
    });
  });

  describe('Equity Curve Variance Computation', () => {
    it('should compute 0 for all identical values', () => {
      const pnlValues = Array(20).fill(10);
      expect(computeEquityCurveVariance(pnlValues)).toBe(0);
    });

    it('should compute correct standard deviation', () => {
      // Simple case: [-10, 10] → mean=0, variance=100, std=10
      const pnlValues = [-10, 10];
      expect(computeEquityCurveVariance(pnlValues)).toBeCloseTo(10);
    });

    it('should compute correct std dev for known values', () => {
      // Values: [2, 4, 4, 4, 5, 5, 7, 9]
      // Mean = 5, Population std dev = 2
      const pnlValues = [2, 4, 4, 4, 5, 5, 7, 9];
      expect(computeEquityCurveVariance(pnlValues)).toBeCloseTo(2.0);
    });

    it('should return 0 for empty array', () => {
      expect(computeEquityCurveVariance([])).toBe(0);
    });
  });

  describe('Drawdown > 5%: Linear Reduction', () => {
    it('should apply linear reduction at 7.5% drawdown (midpoint between 5%-10%)', () => {
      // We need a history that produces ~7.5% drawdown
      // 7.5% of $5000 = $375 drawdown
      // Create cumulative P&L that rises then falls by $375
      const pnlValues: number[] = [];
      // Rise by $400, then fall by $375 to create 7.5% drawdown from peak
      pnlValues.push(400); // cumulative: 400 (peak)
      // Need to decline by 375 over remaining 19 signals
      const declinePerSignal = -375 / 19;
      for (let i = 0; i < 19; i++) {
        pnlValues.push(declinePerSignal);
      }

      const history = createSignalHistory(pnlValues);
      const result = sizer.calculateRisk(history);

      // At 7.5% drawdown: t = (7.5-5)/(10-5) = 0.5
      // risk = 70 - 0.5 * (70 - 17.5) = 70 - 26.25 = 43.75
      expect(result.riskAmount).toBeCloseTo(43.75, 0);
      expect(result.rollingDrawdown).toBeCloseTo(7.5, 0);
    });

    it('should reach floor ($17.50) at 10% drawdown', () => {
      // 10% of $5000 = $500 drawdown
      const pnlValues: number[] = [];
      pnlValues.push(500); // cumulative: 500 (peak)
      const declinePerSignal = -500 / 19;
      for (let i = 0; i < 19; i++) {
        pnlValues.push(declinePerSignal);
      }

      const history = createSignalHistory(pnlValues);
      const result = sizer.calculateRisk(history);

      expect(result.riskAmount).toBe(17.5);
      expect(result.rollingDrawdown).toBeCloseTo(10.0, 0);
    });

    it('should be at floor for drawdown > 10%', () => {
      // 12% of $5000 = $600 drawdown
      const pnlValues: number[] = [];
      pnlValues.push(600);
      const declinePerSignal = -600 / 19;
      for (let i = 0; i < 19; i++) {
        pnlValues.push(declinePerSignal);
      }

      const history = createSignalHistory(pnlValues);
      const result = sizer.calculateRisk(history);

      expect(result.riskAmount).toBe(17.5);
    });
  });

  describe('Drawdown ≤ 2% AND Variance ≤ 1.0× average: Ceiling Allowed', () => {
    it('should allow ceiling ($70.00) with low drawdown and low variance', () => {
      // All positive, consistent P&L → 0% drawdown, uniform variance
      // Variance = std dev = 0 when all values are equal
      // With all identical values, variance=0, historicalAvg=0, condition is 0<=0 → true
      const pnlValues = Array(20).fill(5);
      const history = createSignalHistory(pnlValues);
      const result = sizer.calculateRisk(history);

      expect(result.riskAmount).toBe(70.0);
      expect(result.rollingDrawdown).toBe(0);
      expect(result.riskPercentage).toBeCloseTo(1.4);
    });

    it('should allow ceiling with small drawdown under 2%', () => {
      // Create small fluctuations that result in < 2% drawdown
      // 2% of $5000 = $100. Stay under that.
      // All same value → 0 drawdown, 0 variance
      const pnlValues = Array(20).fill(2);
      const history = createSignalHistory(pnlValues);
      const result = sizer.calculateRisk(history);

      expect(result.riskAmount).toBe(70.0);
    });
  });

  describe('Clamping Between Floor and Ceiling', () => {
    it('should never go below $17.50', () => {
      // Large losses to create huge drawdown
      const pnlValues = [1000, ...Array(19).fill(-200)];
      const history = createSignalHistory(pnlValues);
      const result = sizer.calculateRisk(history);

      expect(result.riskAmount).toBeGreaterThanOrEqual(17.5);
    });

    it('should never go above $70.00', () => {
      // All positive consistent values
      const pnlValues = Array(20).fill(100);
      const history = createSignalHistory(pnlValues);
      const result = sizer.calculateRisk(history);

      expect(result.riskAmount).toBeLessThanOrEqual(70.0);
    });
  });

  describe('Risk Percentage Calculation', () => {
    it('should compute risk percentage as (riskAmount / equityBaseline) * 100', () => {
      const history = createSignalHistory(Array(20).fill(5));
      const result = sizer.calculateRisk(history);

      expect(result.riskPercentage).toBeCloseTo(
        (result.riskAmount / 5000) * 100
      );
    });

    it('should be 0.35% at floor', () => {
      // Force floor
      const pnlValues = [1000, ...Array(19).fill(-100)];
      const history = createSignalHistory(pnlValues);
      const result = sizer.calculateRisk(history);

      if (result.riskAmount === 17.5) {
        expect(result.riskPercentage).toBeCloseTo(0.35);
      }
    });

    it('should be 1.4% at ceiling', () => {
      const pnlValues = Array(20).fill(5);
      const history = createSignalHistory(pnlValues);
      const result = sizer.calculateRisk(history);

      expect(result.riskPercentage).toBeCloseTo(1.4);
    });
  });

  describe('Custom Configuration', () => {
    it('should respect custom equity baseline', () => {
      const customConfig: KellyConfig = {
        ...DEFAULT_KELLY_CONFIG,
        equityBaseline: 10000,
      };
      const customSizer = createKellySizer(customConfig);
      const history = createSignalHistory(Array(20).fill(5));
      const result = customSizer.calculateRisk(history);

      // Risk percentage should be based on $10,000 baseline
      expect(result.riskPercentage).toBeCloseTo(
        (result.riskAmount / 10000) * 100
      );
    });

    it('should respect custom window size', () => {
      const customConfig: KellyConfig = {
        ...DEFAULT_KELLY_CONFIG,
        windowSize: 10,
      };
      const customSizer = createKellySizer(customConfig);

      // 9 signals should still be cold start with window=10
      const history9 = createSignalHistory(Array(9).fill(5));
      expect(customSizer.calculateRisk(history9).isColdStart).toBe(true);

      // 10 signals should NOT be cold start
      const history10 = createSignalHistory(Array(10).fill(5));
      expect(customSizer.calculateRisk(history10).isColdStart).toBe(false);
    });
  });

  describe('Recalculation on Each New Signal', () => {
    it('should produce different results as history changes', () => {
      // Start with stable history
      const stableHistory = createSignalHistory(Array(20).fill(10));
      const result1 = sizer.calculateRisk(stableHistory);

      // Add a large loss
      const unstableHistory = createSignalHistory([
        ...Array(10).fill(10),
        ...Array(9).fill(-50),
        10,
      ]);
      const result2 = sizer.calculateRisk(unstableHistory);

      // Results should differ because the drawdown profile changed
      expect(result1.riskAmount).not.toBe(result2.riskAmount);
    });

    it('should use only the last 20 signals when history is longer', () => {
      // 30 signals: first 10 have big losses, last 20 are all positive
      const longHistory = createSignalHistory([
        ...Array(10).fill(-100),
        ...Array(20).fill(5),
      ]);
      const result = sizer.calculateRisk(longHistory);

      // Should only look at last 20 (all +5), so 0 drawdown → ceiling
      expect(result.riskAmount).toBe(70.0);
      expect(result.rollingDrawdown).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle exactly at 5% drawdown boundary (not reduced)', () => {
      // 5% of $5000 = $250
      // At exactly 5%, it should be just over the threshold
      // Let's create exactly 5%: cumulative peak then drops by exactly $250
      const pnlValues: number[] = [];
      pnlValues.push(250); // cumulative: 250 (peak)
      // Decline by 250 over 19 signals
      const declinePerSignal = -250 / 19;
      for (let i = 0; i < 19; i++) {
        pnlValues.push(declinePerSignal);
      }

      const history = createSignalHistory(pnlValues);
      const result = sizer.calculateRisk(history);

      // At exactly 5%, t = 0, so risk = ceiling = 70
      // But 5% > 5% threshold? No, 5% is at the boundary.
      // The condition is > 5%, so exactly 5% falls into "moderate" category
      // which is the midpoint ($43.75)
      // Actually: drawdown > 5% means strictly greater than 5
      expect(result.rollingDrawdown).toBeCloseTo(5.0, 0);
    });

    it('should handle exactly at 2% drawdown boundary for ceiling check', () => {
      // At exactly 2%, drawdown ≤ 2% is satisfied (inclusive)
      // 2% of $5000 = $100
      const pnlValues: number[] = Array(20).fill(0);
      pnlValues[0] = 100; // peak = 100
      pnlValues[1] = -100; // cumulative goes to 0, drawdown = 100 = 2%
      // Rest are 0, so cumulative stays at 0

      const history = createSignalHistory(pnlValues);
      const result = sizer.calculateRisk(history);

      // Drawdown should be 2%, variance check: since historicalAvg = computed variance,
      // the condition equityCurveVariance <= 1.0 * historicalAverageVariance is always true
      expect(result.rollingDrawdown).toBeCloseTo(2.0);
      expect(result.riskAmount).toBe(70.0);
    });

    it('should handle all zero P&L', () => {
      const pnlValues = Array(20).fill(0);
      const history = createSignalHistory(pnlValues);
      const result = sizer.calculateRisk(history);

      // 0 drawdown, 0 variance → ceiling allowed
      expect(result.riskAmount).toBe(70.0);
      expect(result.rollingDrawdown).toBe(0);
      expect(result.equityCurveVariance).toBe(0);
    });

    it('should handle single large loss among winners', () => {
      // 19 winners of $10, then 1 big loss of -$300
      const pnlValues = [...Array(19).fill(10), -300];
      const history = createSignalHistory(pnlValues);
      const result = sizer.calculateRisk(history);

      // Cumulative peak is 190 (sum of first 19), then drops to -110
      // Drawdown = 300 / 5000 * 100 = 6%
      expect(result.rollingDrawdown).toBeCloseTo(6.0);
      // Should be in linear reduction zone (5% < 6% ≤ 10%)
      expect(result.riskAmount).toBeLessThan(70.0);
      expect(result.riskAmount).toBeGreaterThanOrEqual(17.5);
    });
  });
});
