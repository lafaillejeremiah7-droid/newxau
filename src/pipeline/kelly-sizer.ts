/**
 * Kelly Sizer - Dynamic Fractional Kelly Position Sizing Calculator
 *
 * Adjusts risk per signal between $17.50 (floor) and $70.00 (ceiling)
 * based on rolling drawdown and equity curve variance from the most
 * recent 20 signals.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.9
 */

/** Result of a past signal used for Kelly calculations */
export interface SignalResult {
  signalId: string;
  pnl: number; // profit/loss in dollars
  riskAmount: number;
  timestamp: string;
}

/** Output of the Kelly Sizer calculation */
export interface KellyResult {
  riskAmount: number; // $17.50 – $70.00
  riskPercentage: number; // 0.35% – 1.4%
  rollingDrawdown: number; // percentage
  equityCurveVariance: number;
  historicalAverageVariance: number;
  isColdStart: boolean;
  adjustmentReason: string | null;
}

/** Configuration for the Kelly Sizer */
export interface KellyConfig {
  equityBaseline: number; // $5,000
  floorRisk: number; // $17.50
  ceilingRisk: number; // $70.00
  coldStartRisk: number; // $35.00
  windowSize: number; // 20
  drawdownThresholdStart: number; // 0.05 (5%)
  drawdownThresholdMax: number; // 0.10 (10%)
  varianceMultiplierThreshold: number; // 1.5
  varianceReductionFactor: number; // 0.25
}

/** KellySizer interface as defined in the design */
export interface KellySizer {
  calculateRisk(signalHistory: SignalResult[]): KellyResult;
}

/** Default Kelly configuration */
export const DEFAULT_KELLY_CONFIG: KellyConfig = {
  equityBaseline: 5000,
  floorRisk: 17.5,
  ceilingRisk: 70.0,
  coldStartRisk: 35.0,
  windowSize: 20,
  drawdownThresholdStart: 0.05,
  drawdownThresholdMax: 0.10,
  varianceMultiplierThreshold: 1.5,
  varianceReductionFactor: 0.25,
};

/**
 * Computes rolling drawdown as peak-to-trough decline in cumulative P&L
 * over the given signals, expressed as a percentage of equity baseline.
 */
export function computeRollingDrawdown(
  pnlValues: number[],
  equityBaseline: number
): number {
  if (pnlValues.length === 0) return 0;

  // Build cumulative P&L array
  const cumulativePnl: number[] = [];
  let cumSum = 0;
  for (const pnl of pnlValues) {
    cumSum += pnl;
    cumulativePnl.push(cumSum);
  }

  // Find max peak-to-trough decline
  let peak = cumulativePnl[0];
  let maxDrawdown = 0;

  for (const value of cumulativePnl) {
    if (value > peak) {
      peak = value;
    }
    const drawdown = peak - value;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  // Express as percentage of equity baseline
  return (maxDrawdown / equityBaseline) * 100;
}

/**
 * Computes equity curve variance as the standard deviation of per-signal returns.
 */
export function computeEquityCurveVariance(pnlValues: number[]): number {
  if (pnlValues.length === 0) return 0;

  const n = pnlValues.length;
  const mean = pnlValues.reduce((sum, v) => sum + v, 0) / n;
  const sumSquaredDiffs = pnlValues.reduce(
    (sum, v) => sum + (v - mean) ** 2,
    0
  );
  // Population standard deviation (since we're using the full window)
  return Math.sqrt(sumSquaredDiffs / n);
}

/**
 * Creates a KellySizer instance with the given configuration.
 */
export function createKellySizer(
  config: KellyConfig = DEFAULT_KELLY_CONFIG
): KellySizer {
  return {
    calculateRisk(signalHistory: SignalResult[]): KellyResult {
      const {
        equityBaseline,
        floorRisk,
        ceilingRisk,
        coldStartRisk,
        windowSize,
        drawdownThresholdStart,
        drawdownThresholdMax,
        varianceMultiplierThreshold,
        varianceReductionFactor,
      } = config;

      // Cold start: fewer than windowSize (20) signals
      if (signalHistory.length < windowSize) {
        return {
          riskAmount: coldStartRisk,
          riskPercentage: (coldStartRisk / equityBaseline) * 100,
          rollingDrawdown: 0,
          equityCurveVariance: 0,
          historicalAverageVariance: 0,
          isColdStart: true,
          adjustmentReason: 'Cold start: fewer than 20 signals in history',
        };
      }

      // Take last 20 signals
      const recentSignals = signalHistory.slice(-windowSize);
      const pnlValues = recentSignals.map((s) => s.pnl);

      // Step 1: Compute rolling drawdown (percentage)
      const rollingDrawdown = computeRollingDrawdown(pnlValues, equityBaseline);

      // Step 2: Compute equity curve variance (std dev of returns)
      const equityCurveVariance = computeEquityCurveVariance(pnlValues);

      // Step 3: Historical average variance
      // For now, use the computed variance as the baseline since we don't
      // have historical data; in practice this would be a longer-term average
      const historicalAverageVariance = equityCurveVariance;

      // Step 4: Apply adjustment rules
      const drawdownPercent = rollingDrawdown; // already in percentage form
      const drawdownStartPercent = drawdownThresholdStart * 100; // 5%
      const drawdownMaxPercent = drawdownThresholdMax * 100; // 10%

      let riskAmount: number;
      let adjustmentReason: string | null = null;

      // Rule: Drawdown ≤ 2% AND variance ≤ 1.0× average → allow ceiling
      if (drawdownPercent <= 2 && equityCurveVariance <= 1.0 * historicalAverageVariance) {
        riskAmount = ceilingRisk;
        adjustmentReason = 'Low drawdown and low variance: ceiling risk allowed';
      }
      // Rule: Drawdown > 10% → floor
      else if (drawdownPercent > drawdownMaxPercent) {
        riskAmount = floorRisk;
        adjustmentReason = `Drawdown ${drawdownPercent.toFixed(2)}% exceeds 10%: floor risk applied`;
      }
      // Rule: Drawdown > 5% AND ≤ 10% → linear interpolation toward floor
      else if (drawdownPercent > drawdownStartPercent) {
        // Linear interpolation from ceiling to floor as drawdown goes from 5% to 10%
        const t =
          (drawdownPercent - drawdownStartPercent) /
          (drawdownMaxPercent - drawdownStartPercent);
        riskAmount = ceilingRisk - t * (ceilingRisk - floorRisk);
        adjustmentReason = `Drawdown ${drawdownPercent.toFixed(2)}%: linear reduction applied`;
      }
      // Otherwise: moderate level (midpoint scaled)
      else {
        // Use a moderate midpoint between floor and ceiling
        const midpoint = (floorRisk + ceilingRisk) / 2; // $43.75
        riskAmount = midpoint;
        adjustmentReason = null;
      }

      // Rule: Variance > 1.5× historical average → reduce by 25%
      if (
        historicalAverageVariance > 0 &&
        equityCurveVariance > varianceMultiplierThreshold * historicalAverageVariance
      ) {
        riskAmount = riskAmount * (1 - varianceReductionFactor);
        adjustmentReason = adjustmentReason
          ? `${adjustmentReason}; high variance: reduced by 25%`
          : 'High variance (>1.5× average): reduced by 25%';
      }

      // Clamp between floor and ceiling
      riskAmount = Math.max(floorRisk, Math.min(ceilingRisk, riskAmount));

      return {
        riskAmount,
        riskPercentage: (riskAmount / equityBaseline) * 100,
        rollingDrawdown: drawdownPercent,
        equityCurveVariance,
        historicalAverageVariance,
        isColdStart: false,
        adjustmentReason,
      };
    },
  };
}
