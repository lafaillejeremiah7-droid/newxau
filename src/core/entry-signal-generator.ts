/**
 * Entry Signal Generator for the Isagi Engine Signal Bot.
 *
 * Generates entry signals when a rejection candle's close price falls within
 * the structural window bounded by the breakdown/breakout zone and dynamic EMA levels.
 *
 * Logic:
 * 1. Check if the rejection candle's close price is within [lower, upper] (inclusive)
 * 2. For BOTH long and short signals: close must be >= lower AND <= upper
 * 3. If close is beyond the window, discard and return rejection reason
 * 4. If close is exactly on a boundary, treat as WITHIN the window (generate signal)
 * 5. Generate RawSignal with unique ID, timestamp, entry price, direction, zone level,
 *    window bounds, rejection type, and all context candles
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */

import { randomUUID } from 'node:crypto';
import type { Candle } from '../types/candle.js';
import type { RawSignal } from '../types/signal.js';

/** Input for the entry signal generator */
export interface EntrySignalGeneratorInput {
  rejectionCandle: Candle;
  direction: 'long' | 'short';
  structuralWindowUpper: number; // upper boundary of the structural window
  structuralWindowLower: number; // lower boundary of the structural window
  liquidityZoneLevel: number; // the originating zone level
  rejectionCandleType:
    | 'shooting_star'
    | 'hammer'
    | 'bearish_engulfing'
    | 'bullish_engulfing';
  expansionCandles: Candle[];
  retracementCandles: Candle[];
  observationCandles: Candle[];
}

/** Result from the entry signal generator */
export interface EntrySignalResult {
  valid: boolean;
  signal: RawSignal | null;
  rejectionReason: string | null;
}

/** Interface for the entry signal generator */
export interface IEntrySignalGenerator {
  evaluate(input: EntrySignalGeneratorInput): EntrySignalResult;
}

/**
 * Checks whether the close price is within the structural window [lower, upper].
 * Both boundaries are inclusive (close exactly on boundary is WITHIN).
 *
 * Requirement 4.4: close exactly on boundary → within window
 */
function isWithinStructuralWindow(
  closePrice: number,
  lower: number,
  upper: number,
): boolean {
  return closePrice >= lower && closePrice <= upper;
}

/**
 * Creates an entry signal generator.
 *
 * The generator evaluates whether a rejection candle's close price falls within
 * the structural window and generates a RawSignal if valid.
 */
export function createEntrySignalGenerator(): IEntrySignalGenerator {
  return {
    /**
     * Evaluate a rejection candle for entry signal generation.
     *
     * Requirement 4.5: Only evaluates on fully closed M5 candles.
     * The caller is responsible for ensuring the candle is fully closed before calling.
     *
     * @param input - The entry signal generator input containing the rejection candle and context
     * @returns EntrySignalResult with valid=true and a RawSignal, or valid=false with rejection reason
     */
    evaluate(input: EntrySignalGeneratorInput): EntrySignalResult {
      const {
        rejectionCandle,
        direction,
        structuralWindowUpper,
        structuralWindowLower,
        liquidityZoneLevel,
        rejectionCandleType,
        expansionCandles,
        retracementCandles,
        observationCandles,
      } = input;

      const closePrice = rejectionCandle.close;

      // Check if close is within the structural window [lower, upper] (inclusive)
      if (
        !isWithinStructuralWindow(
          closePrice,
          structuralWindowLower,
          structuralWindowUpper,
        )
      ) {
        // Requirement 4.2: Discard and log rejection reason including close price and boundaries
        const rejectionReason =
          `Entry signal discarded: rejection candle close price ${closePrice} is outside ` +
          `structural window [${structuralWindowLower}, ${structuralWindowUpper}]. ` +
          `Direction: ${direction}.`;

        return {
          valid: false,
          signal: null,
          rejectionReason,
        };
      }

      // Close is within window — generate entry signal
      // Requirement 4.1: Generate entry signal at the close price of the rejection candle
      // Requirement 4.3: Record timestamp (UTC), entry price, direction, zone level,
      //                   window boundaries, rejection pattern type
      const signal: RawSignal = {
        id: randomUUID(),
        timestamp: rejectionCandle.timestamp, // UTC timestamp from the M5 candle close
        direction,
        entryPrice: closePrice,
        liquidityZoneLevel,
        structuralWindowUpper,
        structuralWindowLower,
        rejectionCandleType,
        expansionCandles,
        retracementCandles,
        observationCandles,
      };

      return {
        valid: true,
        signal,
        rejectionReason: null,
      };
    },
  };
}
