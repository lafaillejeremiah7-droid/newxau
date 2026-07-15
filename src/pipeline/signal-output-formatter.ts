/**
 * Signal Output Formatter for the Isagi Engine Signal Bot.
 *
 * Assembles all computed pipeline values into the final FormattedSignal output
 * with split position details (Ticket 1: Safety Lock at 45%, Ticket 2: Runner at 55%).
 *
 * Split Position Rules:
 * - Ticket 1 (Safety Lock): 45% of position, TP at 35% of distance to Ticket 2 TP
 * - Ticket 2 (Runner): 55% of position, TP based on zone classification
 * - Breakeven trigger: When Ticket 1 TP reached, Ticket 2 SL moves to entry
 * - Trailing stop: Most recent M5 structural swing point after breakeven activation
 *
 * For XAU/USD: 1 pip = 0.1 price units.
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 8.8, 9.5, 16.3
 */

import type { RawSignal, FormattedSignal, SlippageResult } from '../types/signal.js';
import type { ZoneClassification } from '../types/zone.js';
import type { TargetLevels } from './stop-loss-target-mapper.js';
import type { KellyResult } from './kelly-sizer.js';

/** Maximum reasoning string length */
const MAX_REASONING_LENGTH = 280;

/** Ticket 1 position size percentage */
const TICKET_1_SIZE_PERCENT = 45;

/** Ticket 2 position size percentage */
const TICKET_2_SIZE_PERCENT = 55;

/** TP1 distance fraction (35% of distance from entry to TP2) */
const TP1_FRACTION = 0.35;

/** Input required by the Signal Output Formatter */
export interface FormatterInput {
  rawSignal: RawSignal;
  stopLoss: number;
  targets: TargetLevels;
  zoneClassification: ZoneClassification;
  kellyResult: KellyResult;
  slippageResult: SlippageResult;
  /** Most recent M5 structural swing point for trailing stop guidance */
  recentSwingPoint?: number;
}

/** Signal Output Formatter interface */
export interface SignalOutputFormatter {
  format(input: FormatterInput): FormattedSignal;
}

/**
 * Generates reasoning text for a formatted signal.
 * Includes direction, zone classification, rejection pattern, and risk adjustment.
 * Truncates to 280 characters maximum.
 */
function generateReasoning(input: FormatterInput): string {
  const { rawSignal, zoneClassification, kellyResult } = input;

  const dirLabel = rawSignal.direction === 'long' ? 'LONG' : 'SHORT';
  const zoneLabel =
    zoneClassification === 'expansion_zone' ? 'Expansion' : 'Chop';
  const patternLabel = rawSignal.rejectionCandleType.replace(/_/g, ' ');

  let reasoning = `${dirLabel} XAUUSD | ${zoneLabel} zone | ${patternLabel} at liquidity zone ${rawSignal.liquidityZoneLevel.toFixed(2)}`;

  if (kellyResult.adjustmentReason) {
    reasoning += ` | Risk: ${kellyResult.adjustmentReason}`;
  }

  if (kellyResult.isColdStart) {
    reasoning += ' | Cold start sizing';
  }

  // Truncate to max 280 characters
  if (reasoning.length > MAX_REASONING_LENGTH) {
    reasoning = reasoning.slice(0, MAX_REASONING_LENGTH - 3) + '...';
  }

  return reasoning;
}

/**
 * Generates the breakeven trigger instruction.
 */
function generateBreakevenTrigger(
  tp1: number,
  entryPrice: number,
  direction: 'long' | 'short',
): string {
  const dirText = direction === 'long' ? 'reaches' : 'reaches';
  return `When price ${dirText} Ticket 1 TP (${tp1.toFixed(2)}), move Ticket 2 SL to entry (${entryPrice.toFixed(2)})`;
}

/**
 * Generates trailing stop guidance text.
 */
function generateTrailingStopGuidance(
  direction: 'long' | 'short',
  recentSwingPoint?: number,
): string {
  const swingType = direction === 'short' ? 'swing high' : 'swing low';

  if (recentSwingPoint !== undefined) {
    return `After breakeven activated, trail Ticket 2 SL to most recent M5 ${swingType} at ${recentSwingPoint.toFixed(2)}`;
  }

  return `After breakeven activated, trail Ticket 2 SL to most recent M5 structural ${swingType}`;
}

/**
 * Creates a SignalOutputFormatter instance.
 *
 * Logic:
 * 1. Determine effective entry price (adjusted for slippage if applied)
 * 2. Calculate TP2 from targets (zone-based R-multiple already computed by pipeline)
 * 3. Calculate TP1 = entry + 0.35 × (TP2 - entry) for longs, entry - 0.35 × (entry - TP2) for shorts
 * 4. Build Ticket 1 (Safety Lock, 45%) and Ticket 2 (Runner, 55%)
 * 5. Generate breakeven trigger, trailing stop guidance, reasoning
 * 6. Include Kelly risk amount, zone classification, slippage details
 * 7. Label instrument as 'XAUUSD'
 */
export function createSignalOutputFormatter(): SignalOutputFormatter {
  return {
    format(input: FormatterInput): FormattedSignal {
      const {
        rawSignal,
        stopLoss,
        targets,
        zoneClassification,
        kellyResult,
        slippageResult,
        recentSwingPoint,
      } = input;

      // Use the adjusted entry from slippage (if applied) or raw signal entry
      const entryPrice = slippageResult.applied
        ? slippageResult.adjustedEntry
        : rawSignal.entryPrice;

      // TP2 comes from the target mapper pipeline (zone-based R-multiple)
      const tp2 = targets.tp2;

      // TP1 = 35% of distance from entry to TP2
      let tp1: number;
      if (rawSignal.direction === 'long') {
        tp1 = entryPrice + TP1_FRACTION * (tp2 - entryPrice);
      } else {
        tp1 = entryPrice - TP1_FRACTION * (entryPrice - tp2);
      }

      // Build Ticket 1: Safety Lock (45%)
      const ticket1 = {
        label: 'Safety Lock',
        positionSizePercent: TICKET_1_SIZE_PERCENT,
        entryPrice,
        stopLoss,
        takeProfit: tp1,
      };

      // Build Ticket 2: Runner (55%)
      const ticket2 = {
        label: 'Runner',
        positionSizePercent: TICKET_2_SIZE_PERCENT,
        entryPrice,
        stopLoss,
        takeProfit: tp2,
      };

      // Generate ancillary text
      const breakevenTrigger = generateBreakevenTrigger(
        tp1,
        entryPrice,
        rawSignal.direction,
      );

      const trailingStopGuidance = generateTrailingStopGuidance(
        rawSignal.direction,
        recentSwingPoint,
      );

      const reasoning = generateReasoning(input);

      return {
        id: rawSignal.id,
        timestamp: rawSignal.timestamp,
        instrument: 'XAUUSD',
        direction: rawSignal.direction,
        entryPrice,
        stopLoss,
        ticket1,
        ticket2,
        zoneClassification,
        riskAmount: kellyResult.riskAmount,
        rUnit: targets.rUnit,
        reasoning,
        slippage: slippageResult,
        breakevenTrigger,
        trailingStopGuidance,
      };
    },
  };
}
