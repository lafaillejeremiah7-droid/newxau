/**
 * Long Signal Detector for the Isagi Engine Signal Bot.
 *
 * Detects valid long (bullish) signal setups by scanning for:
 * 1. Expansion phase: >=2 consecutive bullish expansion candles
 *    (body >= 60% range, close above highest high of preceding 10 candles)
 * 2. Retracement phase: 2-4 candles with lower volume and smaller range
 *    than expansion averages
 * 3. Rejection phase: bullish rejection candle (hammer or bullish engulfing)
 *    at retracement low
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */

import type { Candle } from '../types/candle.js';
import type { CandlePatternAnalyzer } from './candle-pattern-analyzer.js';

/** Detection phase of the long signal structure */
export type LongDetectionPhase =
  | 'expansion'
  | 'retracement'
  | 'rejection';

/** Result from processing a candle through the long signal detector */
export type LongDetectionResult =
  | { status: 'pending' }
  | { status: 'valid'; context: LongSignalContext }
  | { status: 'invalid'; reason: string };

/** Context of a valid long signal detection */
export interface LongSignalContext {
  expansionCandleCount: number;
  retracementCandleCount: number;
  rejectionType: 'hammer' | 'bullish_engulfing';
  breakoutLevel: number;
  expansionCandles: Candle[];
  retracementCandles: Candle[];
  rejectionCandle: Candle;
  averageExpansionVolume: number;
  averageExpansionRange: number;
}

/** Interface for the Long Signal Detector */
export interface ILongSignalDetector {
  processCandle(candle: Candle, precedingCandles: Candle[]): LongDetectionResult;
  reset(): void;
  getPhase(): LongDetectionPhase;
}

/**
 * Creates a LongSignalDetector that processes M5 candles one at a time
 * in the signal_evaluation state to detect bullish signal structures.
 *
 * @param analyzer - CandlePatternAnalyzer for pattern detection
 */
export function createLongSignalDetector(
  analyzer: CandlePatternAnalyzer
): ILongSignalDetector {
  let phase: LongDetectionPhase = 'expansion';
  let expansionCandles: Candle[] = [];
  let retracementCandles: Candle[] = [];
  let breakoutLevel: number = 0;
  let averageExpansionVolume: number = 0;
  let averageExpansionRange: number = 0;

  function reset(): void {
    phase = 'expansion';
    expansionCandles = [];
    retracementCandles = [];
    breakoutLevel = 0;
    averageExpansionVolume = 0;
    averageExpansionRange = 0;
  }

  /**
   * Computes the highest high of the preceding N candles from the given list.
   * The list should NOT include the current candle being evaluated.
   */
  function getHighestHigh(candles: Candle[]): number {
    if (candles.length === 0) return -Infinity;
    return Math.max(...candles.map((c) => c.high));
  }

  /**
   * Check if a candle is a bullish expansion candle:
   * - Body (|open - close|) >= 60% of range (high - low)
   * - Close above the highest high of the preceding 10 candles
   */
  function isBullishExpansionCandle(
    candle: Candle,
    precedingCandles: Candle[]
  ): boolean {
    const range = candle.high - candle.low;
    if (range === 0) return false;

    const body = Math.abs(candle.open - candle.close);
    const bodyRatio = body / range;
    if (bodyRatio < 0.6) return false;

    // Must be bullish (close > open)
    if (candle.close <= candle.open) return false;

    // Close must be above the highest high of the preceding 10 candles
    const lookback = precedingCandles.slice(-10);
    const highestHigh = getHighestHigh(lookback);

    return candle.close > highestHigh;
  }

  /**
   * Checks if a candle qualifies as a retracement candle:
   * - Volume below the average expansion volume
   * - Range (high - low) smaller than the average expansion range
   */
  function isRetracementCandle(candle: Candle): boolean {
    const candleRange = candle.high - candle.low;
    return (
      candle.volume < averageExpansionVolume &&
      candleRange < averageExpansionRange
    );
  }

  /**
   * Computes the average volume of the expansion candles.
   */
  function computeAverageVolume(candles: Candle[]): number {
    if (candles.length === 0) return 0;
    const totalVolume = candles.reduce((sum, c) => sum + c.volume, 0);
    return totalVolume / candles.length;
  }

  /**
   * Computes the average range (high - low) of the expansion candles.
   */
  function computeAverageRange(candles: Candle[]): number {
    if (candles.length === 0) return 0;
    const totalRange = candles.reduce((sum, c) => sum + (c.high - c.low), 0);
    return totalRange / candles.length;
  }

  function processCandle(
    candle: Candle,
    precedingCandles: Candle[]
  ): LongDetectionResult {
    switch (phase) {
      case 'expansion':
        return handleExpansionPhase(candle, precedingCandles);
      case 'retracement':
        return handleRetracementPhase(candle);
      case 'rejection':
        return handleRejectionPhase(candle);
      default:
        return { status: 'pending' };
    }
  }

  function handleExpansionPhase(
    candle: Candle,
    precedingCandles: Candle[]
  ): LongDetectionResult {
    // Build the preceding candles context for the current expansion check
    // Include any previously confirmed expansion candles before this one
    const allPreceding = [...precedingCandles, ...expansionCandles];

    if (isBullishExpansionCandle(candle, allPreceding)) {
      expansionCandles.push(candle);

      // Update breakout level (the close of the latest expansion candle)
      breakoutLevel = candle.close;

      // Still pending until we have at least 2 expansion candles
      return { status: 'pending' };
    } else {
      // Not an expansion candle
      if (expansionCandles.length >= 2) {
        // We have enough expansion candles - transition to retracement
        averageExpansionVolume = computeAverageVolume(expansionCandles);
        averageExpansionRange = computeAverageRange(expansionCandles);
        phase = 'retracement';

        // Evaluate the current candle as a potential retracement candle
        return handleRetracementPhase(candle);
      } else {
        // Not enough expansion candles, invalid setup
        reset();
        return {
          status: 'invalid',
          reason: 'insufficient_expansion_candles',
        };
      }
    }
  }

  function handleRetracementPhase(candle: Candle): LongDetectionResult {
    // Check if this could be a rejection candle
    const priorCandle =
      retracementCandles.length > 0
        ? retracementCandles[retracementCandles.length - 1]
        : expansionCandles[expansionCandles.length - 1];

    const rejectionResult = analyzer.isRejectionCandle(
      candle,
      'bullish',
      priorCandle
    );

    // Priority: If we already have >= 2 retracement candles and this is a rejection,
    // treat it as a rejection candle (even if it also qualifies as retracement)
    if (retracementCandles.length >= 2 && rejectionResult.isRejection) {
      const rejectionType = rejectionResult.pattern as
        | 'hammer'
        | 'bullish_engulfing';
      const context: LongSignalContext = {
        expansionCandleCount: expansionCandles.length,
        retracementCandleCount: retracementCandles.length,
        rejectionType,
        breakoutLevel,
        expansionCandles: [...expansionCandles],
        retracementCandles: [...retracementCandles],
        rejectionCandle: candle,
        averageExpansionVolume,
        averageExpansionRange,
      };
      reset();
      return { status: 'valid', context };
    }

    if (isRetracementCandle(candle)) {
      retracementCandles.push(candle);

      // Check if retracement exceeded 4 candles
      if (retracementCandles.length > 4) {
        const reason = 'retracement_exceeded_4_candles';
        reset();
        return { status: 'invalid', reason };
      }

      // Check volume invalidation: retracement avg volume > expansion avg volume
      const retracementAvgVolume = computeAverageVolume(retracementCandles);
      if (retracementAvgVolume > averageExpansionVolume) {
        const reason = 'retracement_volume_exceeds_expansion';
        reset();
        return { status: 'invalid', reason };
      }

      // Still pending — need at least 2 retracement candles before accepting rejection
      return { status: 'pending' };
    } else {
      // Not a valid retracement candle and not a rejection with enough retracement

      // If we don't have enough retracement candles yet, it's invalid
      if (retracementCandles.length < 2) {
        const reason = 'retracement_too_short';
        reset();
        return { status: 'invalid', reason };
      }

      // We had retracement but no rejection pattern - invalid
      const reason = 'no_rejection_candle_at_retracement_low';
      reset();
      return { status: 'invalid', reason };
    }
  }

  function handleRejectionPhase(_candle: Candle): LongDetectionResult {
    // This phase is not explicitly needed since rejection is checked within retracement
    // Included for completeness
    return { status: 'pending' };
  }

  return {
    processCandle,
    reset,
    getPhase(): LongDetectionPhase {
      return phase;
    },
  };
}
