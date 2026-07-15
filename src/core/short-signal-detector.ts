/**
 * Short Signal Detector for the Isagi Engine Signal Bot.
 *
 * Detects valid short (bearish) signal setups on the M5 chart by tracking:
 * 1. Expansion phase: ≥2 consecutive bearish expansion candles
 * 2. Retracement phase: 2-4 corrective candles with lower volume/body
 * 3. Rejection phase: bearish rejection candle at retracement high
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
 */

import type { Candle } from '../types/candle.js';
import type { EvaluationContext } from '../types/state.js';
import type { CandlePatternAnalyzer } from './candle-pattern-analyzer.js';

/** Detection phase within the short signal detector */
export type ShortDetectionPhase = 'expansion' | 'retracement' | 'rejection';

/** Result returned by the detector on each candle */
export type ShortDetectionResult =
  | { status: 'pending' }
  | { status: 'valid'; context: EvaluationContext }
  | { status: 'invalid'; reason: string };

/** Configuration for the short signal detector */
export interface ShortDetectorConfig {
  /** Minimum number of consecutive bearish expansion candles required */
  minExpansionCandles: number;
  /** Body-to-range ratio threshold for expansion candles (0.60 = 60%) */
  bodyRatioThreshold: number;
  /** Number of preceding candles to search for local minor low */
  structuralLookback: number;
  /** Minimum number of retracement candles */
  minRetracementCandles: number;
  /** Maximum number of retracement candles before invalidation */
  maxRetracementCandles: number;
}

/** Default configuration matching requirements */
export const DEFAULT_SHORT_DETECTOR_CONFIG: ShortDetectorConfig = {
  minExpansionCandles: 2,
  bodyRatioThreshold: 0.60,
  structuralLookback: 20,
  minRetracementCandles: 2,
  maxRetracementCandles: 4,
};

/**
 * Finds the local minor structural low within the specified lookback window.
 * The "local minor low" is the lowest low among the preceding candles in the lookback.
 */
export function findLocalMinorLow(precedingCandles: Candle[], lookback: number): number {
  if (precedingCandles.length === 0) return Infinity;
  const window = precedingCandles.slice(-lookback);
  return Math.min(...window.map((c) => c.low));
}

/**
 * Short Signal Detector class.
 *
 * Receives M5 candles one at a time during the signal_evaluation state
 * and tracks the detection phases for a short signal setup.
 */
export class ShortSignalDetector {
  private readonly config: ShortDetectorConfig;
  private readonly analyzer: CandlePatternAnalyzer;

  /** Current detection phase */
  private phase: ShortDetectionPhase = 'expansion';

  /** Collected expansion candles (bearish expansion) */
  private expansionCandles: Candle[] = [];

  /** Collected retracement candles */
  private retracementCandles: Candle[] = [];

  /** Average volume of expansion candles */
  private avgExpansionVolume: number = 0;

  /** Average body size of expansion candles */
  private avgExpansionBodySize: number = 0;

  /** Structural break level (the local minor low that expansion candles broke) */
  private structuralBreakLevel: number = 0;

  /** Preceding candles history used for structural lookback */
  private precedingCandles: Candle[] = [];

  constructor(
    analyzer: CandlePatternAnalyzer,
    config: ShortDetectorConfig = DEFAULT_SHORT_DETECTOR_CONFIG,
    precedingCandles: Candle[] = [],
  ) {
    this.analyzer = analyzer;
    this.config = config;
    this.precedingCandles = [...precedingCandles];
  }

  /**
   * Process a new M5 candle and return the detection result.
   *
   * @param candle - The closed M5 candle to process
   * @returns Detection result: pending, valid, or invalid with reason
   */
  processCandle(candle: Candle): ShortDetectionResult {
    switch (this.phase) {
      case 'expansion':
        return this.handleExpansionPhase(candle);
      case 'retracement':
        return this.handleRetracementPhase(candle);
      case 'rejection':
        return this.handleRejectionPhase(candle);
    }
  }

  /**
   * Get the current detection phase for debugging/testing.
   */
  getPhase(): ShortDetectionPhase {
    return this.phase;
  }

  /**
   * Get the current expansion candles collected.
   */
  getExpansionCandles(): Candle[] {
    return [...this.expansionCandles];
  }

  /**
   * Get the current retracement candles collected.
   */
  getRetracementCandles(): Candle[] {
    return [...this.retracementCandles];
  }

  // ─── Phase Handlers ──────────────────────────────────────────────────────────

  /**
   * Expansion phase: looking for ≥2 consecutive bearish expansion candles.
   *
   * Each candle must:
   * - Have body ≥ 60% of range
   * - Close below the prior local minor structural low within preceding 20 candles
   *
   * Requirements: 2.1
   */
  private handleExpansionPhase(candle: Candle): ShortDetectionResult {
    // Find the local minor low from preceding candles + any expansion candles collected so far
    const lookbackCandles = [...this.precedingCandles, ...this.expansionCandles];
    const localMinorLow = findLocalMinorLow(lookbackCandles, this.config.structuralLookback);

    // Check if this candle qualifies as a bearish expansion candle
    const isExpansion = this.analyzer.isExpansionCandle(candle, localMinorLow, 'bearish');

    if (isExpansion) {
      this.expansionCandles.push(candle);

      // Update structural break level to the local minor low that was broken
      if (this.expansionCandles.length === 1) {
        this.structuralBreakLevel = localMinorLow;
      }

      // Check if we have enough expansion candles to move to retracement phase
      if (this.expansionCandles.length >= this.config.minExpansionCandles) {
        this.computeExpansionAverages();
        this.phase = 'retracement';
      }

      return { status: 'pending' };
    } else {
      // If we already had some expansion candles but this one breaks the streak
      if (this.expansionCandles.length > 0) {
        // Check if we had enough expansion candles already
        if (this.expansionCandles.length >= this.config.minExpansionCandles) {
          // We had enough, the current candle might be start of retracement
          this.computeExpansionAverages();
          this.phase = 'retracement';
          return this.handleRetracementPhase(candle);
        }
        // Not enough expansion candles and streak broken → invalid
        return {
          status: 'invalid',
          reason: `Expansion phase incomplete: only ${this.expansionCandles.length} expansion candle(s) before non-expansion candle`,
        };
      }

      // No expansion candles yet, add to preceding candles and continue
      this.precedingCandles.push(candle);
      return { status: 'pending' };
    }
  }

  /**
   * Retracement phase: monitoring 2-4 corrective candles.
   *
   * Each retracement candle must:
   * - Have volume below the average expansion candle volume
   * - Have body size smaller than the average expansion candle body size
   *
   * Invalidation:
   * - Retracement exceeds 4 candles without rejection → invalid
   * - Average retracement volume exceeds average expansion volume → invalid
   *
   * Requirements: 2.2, 2.4, 2.5
   */
  private handleRetracementPhase(candle: Candle): ShortDetectionResult {
    const candleBody = Math.abs(candle.open - candle.close);

    // Check if this candle qualifies as a retracement candle
    const isRetracementCandle =
      candle.volume < this.avgExpansionVolume &&
      candleBody < this.avgExpansionBodySize;

    if (isRetracementCandle) {
      this.retracementCandles.push(candle);

      // Check invalidation: retracement volume exceeds expansion volume
      const avgRetracementVolume = this.computeAverageVolume(this.retracementCandles);
      if (avgRetracementVolume > this.avgExpansionVolume) {
        return {
          status: 'invalid',
          reason: 'Retracement average volume exceeds expansion average volume',
        };
      }

      // Check if max retracement candles reached without rejection
      if (this.retracementCandles.length > this.config.maxRetracementCandles) {
        return {
          status: 'invalid',
          reason: `Retracement exceeded ${this.config.maxRetracementCandles} candles without rejection candle`,
        };
      }

      // If we have minimum retracement candles, also check for rejection on this candle
      if (this.retracementCandles.length >= this.config.minRetracementCandles) {
        // Transition to rejection phase: check this candle AND future candles for rejection
        this.phase = 'rejection';
        // Check if this candle itself is a rejection
        return this.checkRejection(candle);
      }

      return { status: 'pending' };
    } else {
      // This candle doesn't qualify as retracement — might be a rejection candle
      if (this.retracementCandles.length >= this.config.minRetracementCandles) {
        // We have enough retracement candles, check if this is a rejection
        this.phase = 'rejection';
        return this.handleRejectionPhase(candle);
      } else if (this.retracementCandles.length > 0) {
        // We have some retracement candles but not enough
        // Count this as part of the retracement anyway for invalidation check
        this.retracementCandles.push(candle);

        // Check if exceeded max
        if (this.retracementCandles.length > this.config.maxRetracementCandles) {
          return {
            status: 'invalid',
            reason: `Retracement exceeded ${this.config.maxRetracementCandles} candles without rejection candle`,
          };
        }

        // Check volume invalidation
        const avgRetracementVolume = this.computeAverageVolume(this.retracementCandles);
        if (avgRetracementVolume > this.avgExpansionVolume) {
          return {
            status: 'invalid',
            reason: 'Retracement average volume exceeds expansion average volume',
          };
        }

        return { status: 'pending' };
      } else {
        // No retracement candles yet and this candle doesn't qualify
        // First candle after expansion is not retracement-like — 
        // It could still form a valid retracement if within bounds
        this.retracementCandles.push(candle);

        // Check volume invalidation
        const avgRetracementVolume = this.computeAverageVolume(this.retracementCandles);
        if (avgRetracementVolume > this.avgExpansionVolume) {
          return {
            status: 'invalid',
            reason: 'Retracement average volume exceeds expansion average volume',
          };
        }

        return { status: 'pending' };
      }
    }
  }

  /**
   * Rejection phase: waiting for bearish rejection candle at retracement high.
   *
   * Requires a shooting star or bearish engulfing candle.
   * If max retracement candles exceeded → invalidation.
   *
   * Requirements: 2.3, 2.4
   */
  private handleRejectionPhase(candle: Candle): ShortDetectionResult {
    // Add to retracement candles for count tracking
    if (!this.retracementCandles.includes(candle)) {
      this.retracementCandles.push(candle);
    }

    // Check if we've exceeded max retracement candles
    if (this.retracementCandles.length > this.config.maxRetracementCandles) {
      return {
        status: 'invalid',
        reason: `Retracement exceeded ${this.config.maxRetracementCandles} candles without rejection candle`,
      };
    }

    // Check volume invalidation
    const avgRetracementVolume = this.computeAverageVolume(this.retracementCandles);
    if (avgRetracementVolume > this.avgExpansionVolume) {
      return {
        status: 'invalid',
        reason: 'Retracement average volume exceeds expansion average volume',
      };
    }

    // Check for bearish rejection candle
    return this.checkRejection(candle);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Check if the given candle is a bearish rejection (shooting star or bearish engulfing).
   */
  private checkRejection(candle: Candle): ShortDetectionResult {
    const priorCandle =
      this.retracementCandles.length >= 2
        ? this.retracementCandles[this.retracementCandles.length - 2]
        : this.expansionCandles[this.expansionCandles.length - 1];

    const rejectionResult = this.analyzer.isRejectionCandle(candle, 'bearish', priorCandle);

    if (rejectionResult.isRejection) {
      // Valid short signal detected!
      const context: EvaluationContext = {
        direction: 'short',
        expansionCandles: [...this.expansionCandles],
        retracementCandles: [...this.retracementCandles],
        rejectionCandle: candle,
        averageExpansionVolume: this.avgExpansionVolume,
        averageExpansionBodySize: this.avgExpansionBodySize,
        structuralBreakLevel: this.structuralBreakLevel,
      };
      return { status: 'valid', context };
    }

    // Not a rejection yet
    if (this.retracementCandles.length >= this.config.maxRetracementCandles) {
      return {
        status: 'invalid',
        reason: `Retracement reached ${this.config.maxRetracementCandles} candles without rejection candle`,
      };
    }

    return { status: 'pending' };
  }

  /**
   * Compute average volume and body size of expansion candles.
   */
  private computeExpansionAverages(): void {
    const totalVolume = this.expansionCandles.reduce((sum, c) => sum + c.volume, 0);
    const totalBody = this.expansionCandles.reduce(
      (sum, c) => sum + Math.abs(c.open - c.close),
      0,
    );
    this.avgExpansionVolume = totalVolume / this.expansionCandles.length;
    this.avgExpansionBodySize = totalBody / this.expansionCandles.length;
  }

  /**
   * Compute average volume of a set of candles.
   */
  private computeAverageVolume(candles: Candle[]): number {
    if (candles.length === 0) return 0;
    return candles.reduce((sum, c) => sum + c.volume, 0) / candles.length;
  }
}
