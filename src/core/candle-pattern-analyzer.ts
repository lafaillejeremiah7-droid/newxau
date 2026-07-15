/**
 * Candle Pattern Analyzer for the Isagi Engine Signal Bot.
 *
 * Detects specific candlestick patterns (rejection candles, expansion candles)
 * according to strict definitions from the requirements.
 *
 * Pattern Definitions:
 * - Shooting Star (bearish rejection): Top wick ≥ 50% of total range, body in lower third
 * - Hammer (bullish rejection): Bottom wick ≥ 2× body length
 * - Bearish Engulfing: Current candle's body fully engulfs prior candle's body, bearish close
 * - Bullish Engulfing: Current candle's body fully engulfs prior candle's body, bullish close
 * - Expansion Candle: Body (|open - close|) ≥ 60% of total range (high - low)
 */

import type { Candle } from '../types/candle.js';

/** Result from rejection candle analysis */
export interface RejectionResult {
  isRejection: boolean;
  pattern:
    | 'shooting_star'
    | 'hammer'
    | 'bearish_engulfing'
    | 'bullish_engulfing'
    | null;
  confidence: number;
}

/** Interface for candle pattern analysis */
export interface CandlePatternAnalyzer {
  isRejectionCandle(
    candle: Candle,
    direction: 'bullish' | 'bearish',
    priorCandle?: Candle,
  ): RejectionResult;
  isExpansionCandle(
    candle: Candle,
    priorStructuralLevel: number,
    direction: 'bullish' | 'bearish',
  ): boolean;
  getBodyRatio(candle: Candle): number;
  getWickRatio(candle: Candle, side: 'top' | 'bottom'): number;
}

/**
 * Returns the body size (absolute difference between open and close).
 */
function bodySize(candle: Candle): number {
  return Math.abs(candle.open - candle.close);
}

/**
 * Returns the total range of the candle (high - low).
 */
function range(candle: Candle): number {
  return candle.high - candle.low;
}

/**
 * Returns the top wick size.
 * Top wick = high - max(open, close)
 */
function topWick(candle: Candle): number {
  return candle.high - Math.max(candle.open, candle.close);
}

/**
 * Returns the bottom wick size.
 * Bottom wick = min(open, close) - low
 */
function bottomWick(candle: Candle): number {
  return Math.min(candle.open, candle.close) - candle.low;
}

/**
 * Checks if the candle body is in the lower third of the total range.
 * Lower third means the top of the body (max of open/close) is at or below
 * low + (1/3 * range).
 */
function isBodyInLowerThird(candle: Candle): boolean {
  const r = range(candle);
  if (r === 0) return false;
  const bodyTop = Math.max(candle.open, candle.close);
  const lowerThirdBoundary = candle.low + r / 3;
  return bodyTop <= lowerThirdBoundary;
}

/**
 * Checks if the candle is a shooting star pattern.
 * Criteria: Top wick ≥ 50% of total range AND body in lower third of candle.
 */
function isShootingStar(candle: Candle): boolean {
  const r = range(candle);
  if (r === 0) return false;
  const tw = topWick(candle);
  return tw >= 0.5 * r && isBodyInLowerThird(candle);
}

/**
 * Checks if the candle is a hammer pattern.
 * Criteria: Bottom wick ≥ 2× body length.
 */
function isHammer(candle: Candle): boolean {
  const body = bodySize(candle);
  const bw = bottomWick(candle);
  // Body can be zero for doji-like candles; require some body for hammer
  if (body === 0) return false;
  return bw >= 2 * body;
}

/**
 * Checks if the current candle is a bearish engulfing pattern.
 * Criteria: Current candle's body fully engulfs prior candle's body AND bearish close (close < open).
 */
function isBearishEngulfing(candle: Candle, priorCandle: Candle): boolean {
  // Bearish close: close < open
  if (candle.close >= candle.open) return false;

  const currentBodyHigh = Math.max(candle.open, candle.close);
  const currentBodyLow = Math.min(candle.open, candle.close);
  const priorBodyHigh = Math.max(priorCandle.open, priorCandle.close);
  const priorBodyLow = Math.min(priorCandle.open, priorCandle.close);

  // Current body fully engulfs prior body
  return currentBodyHigh >= priorBodyHigh && currentBodyLow <= priorBodyLow;
}

/**
 * Checks if the current candle is a bullish engulfing pattern.
 * Criteria: Current candle's body fully engulfs prior candle's body AND bullish close (close > open).
 */
function isBullishEngulfing(candle: Candle, priorCandle: Candle): boolean {
  // Bullish close: close > open
  if (candle.close <= candle.open) return false;

  const currentBodyHigh = Math.max(candle.open, candle.close);
  const currentBodyLow = Math.min(candle.open, candle.close);
  const priorBodyHigh = Math.max(priorCandle.open, priorCandle.close);
  const priorBodyLow = Math.min(priorCandle.open, priorCandle.close);

  // Current body fully engulfs prior body
  return currentBodyHigh >= priorBodyHigh && currentBodyLow <= priorBodyLow;
}

/**
 * Calculates the confidence for a detected pattern based on how strongly
 * the candle matches the pattern criteria.
 */
function calculateConfidence(
  candle: Candle,
  pattern: 'shooting_star' | 'hammer' | 'bearish_engulfing' | 'bullish_engulfing',
  priorCandle?: Candle,
): number {
  const r = range(candle);
  if (r === 0) return 0;

  switch (pattern) {
    case 'shooting_star': {
      // Confidence based on how much of the range is top wick (50% min → higher = more confident)
      const wickRatio = topWick(candle) / r;
      // Scale: 50% → 0.5 confidence, 80%+ → 1.0 confidence
      return Math.min(1.0, (wickRatio - 0.5) / 0.3 * 0.5 + 0.5);
    }
    case 'hammer': {
      // Confidence based on how much the bottom wick exceeds 2× body
      const body = bodySize(candle);
      if (body === 0) return 0;
      const ratio = bottomWick(candle) / body;
      // Scale: 2× → 0.5 confidence, 4×+ → 1.0 confidence
      return Math.min(1.0, (ratio - 2) / 2 * 0.5 + 0.5);
    }
    case 'bearish_engulfing':
    case 'bullish_engulfing': {
      if (!priorCandle) return 0.5;
      // Confidence based on how much the current body exceeds the prior body
      const currentBody = bodySize(candle);
      const priorBody = bodySize(priorCandle);
      if (priorBody === 0) return 0.7;
      const engulfRatio = currentBody / priorBody;
      // Scale: 1.0× → 0.5 confidence, 2.0×+ → 1.0 confidence
      return Math.min(1.0, (engulfRatio - 1) / 1 * 0.5 + 0.5);
    }
    default:
      return 0;
  }
}

/**
 * Creates a concrete implementation of the CandlePatternAnalyzer interface.
 */
export function createCandlePatternAnalyzer(): CandlePatternAnalyzer {
  return {
    /**
     * Determines if a candle is a rejection candle in the specified direction.
     *
     * For bearish direction: looks for shooting star or bearish engulfing
     * For bullish direction: looks for hammer or bullish engulfing
     *
     * @param candle - The candle to analyze
     * @param direction - The expected rejection direction ('bullish' or 'bearish')
     * @param priorCandle - Optional prior candle needed for engulfing pattern detection
     */
    isRejectionCandle(
      candle: Candle,
      direction: 'bullish' | 'bearish',
      priorCandle?: Candle,
    ): RejectionResult {
      if (direction === 'bearish') {
        // Look for shooting star (bearish rejection at top)
        if (isShootingStar(candle)) {
          return {
            isRejection: true,
            pattern: 'shooting_star',
            confidence: calculateConfidence(candle, 'shooting_star'),
          };
        }
        // Look for bearish engulfing
        if (priorCandle && isBearishEngulfing(candle, priorCandle)) {
          return {
            isRejection: true,
            pattern: 'bearish_engulfing',
            confidence: calculateConfidence(candle, 'bearish_engulfing', priorCandle),
          };
        }
      } else {
        // direction === 'bullish'
        // Look for hammer (bullish rejection at bottom)
        if (isHammer(candle)) {
          return {
            isRejection: true,
            pattern: 'hammer',
            confidence: calculateConfidence(candle, 'hammer'),
          };
        }
        // Look for bullish engulfing
        if (priorCandle && isBullishEngulfing(candle, priorCandle)) {
          return {
            isRejection: true,
            pattern: 'bullish_engulfing',
            confidence: calculateConfidence(candle, 'bullish_engulfing', priorCandle),
          };
        }
      }

      return {
        isRejection: false,
        pattern: null,
        confidence: 0,
      };
    },

    /**
     * Determines if a candle is an expansion candle.
     *
     * An expansion candle has:
     * - Body (|open - close|) ≥ 60% of total range (high - low)
     * - AND breaks the structural level in the given direction:
     *   - Bearish: close is below priorStructuralLevel
     *   - Bullish: close is above priorStructuralLevel
     *
     * @param candle - The candle to analyze
     * @param priorStructuralLevel - The structural level to break
     * @param direction - The expected expansion direction
     */
    isExpansionCandle(
      candle: Candle,
      priorStructuralLevel: number,
      direction: 'bullish' | 'bearish',
    ): boolean {
      const r = range(candle);
      if (r === 0) return false;

      const body = bodySize(candle);
      const bodyRatio = body / r;

      // Body must be ≥ 60% of range
      if (bodyRatio < 0.6) return false;

      // Must break structural level in the appropriate direction
      if (direction === 'bearish') {
        // For shorts: close must be below the prior structural level
        return candle.close < priorStructuralLevel;
      } else {
        // For longs: close must be above the prior structural level
        return candle.close > priorStructuralLevel;
      }
    },

    /**
     * Returns the body-to-range ratio for a candle.
     * Body ratio = |open - close| / (high - low)
     * Returns 0 if range is 0 (doji with high === low).
     */
    getBodyRatio(candle: Candle): number {
      const r = range(candle);
      if (r === 0) return 0;
      return bodySize(candle) / r;
    },

    /**
     * Returns the wick-to-range ratio for the specified side.
     * Top wick ratio = (high - max(open, close)) / (high - low)
     * Bottom wick ratio = (min(open, close) - low) / (high - low)
     * Returns 0 if range is 0.
     */
    getWickRatio(candle: Candle, side: 'top' | 'bottom'): number {
      const r = range(candle);
      if (r === 0) return 0;
      if (side === 'top') {
        return topWick(candle) / r;
      }
      return bottomWick(candle) / r;
    },
  };
}
