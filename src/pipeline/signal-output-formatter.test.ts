/**
 * Tests for the Signal Output Formatter module.
 *
 * Validates:
 * - Split position: Ticket 1 (Safety Lock) at 45%, Ticket 2 (Runner) at 55%
 * - TP1 calculation: 35% of distance from entry to TP2
 * - TP2 uses zone-based R-multiple targets from pipeline
 * - Breakeven trigger instruction generation
 * - Trailing stop guidance generation
 * - Kelly risk amount inclusion
 * - Zone classification inclusion
 * - Slippage details (original entry, adjusted entry, slippage pips)
 * - Instrument labeled as 'XAUUSD' on all outputs
 * - Reasoning limited to 280 characters
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 8.8, 9.5, 16.3
 */

import { describe, it, expect } from 'vitest';
import {
  createSignalOutputFormatter,
  type FormatterInput,
} from './signal-output-formatter.js';
import type { RawSignal, SlippageResult } from '../types/signal.js';
import type { ZoneClassification } from '../types/zone.js';
import type { TargetLevels } from './stop-loss-target-mapper.js';
import type { KellyResult } from './kelly-sizer.js';

/** Helper to create a minimal valid RawSignal */
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

/** Helper to create a KellyResult */
function makeKellyResult(overrides: Partial<KellyResult> = {}): KellyResult {
  return {
    riskAmount: 35.0,
    riskPercentage: 0.7,
    rollingDrawdown: 0,
    equityCurveVariance: 0,
    historicalAverageVariance: 0,
    isColdStart: true,
    adjustmentReason: 'Cold start: fewer than 20 signals in history',
    ...overrides,
  };
}

/** Helper to create SlippageResult (no slippage) */
function makeNoSlippage(entryPrice: number): SlippageResult {
  return {
    applied: false,
    originalEntry: entryPrice,
    adjustedEntry: entryPrice,
    slippagePips: 0,
  };
}

/** Helper to create SlippageResult (with slippage) */
function makeSlippage(
  originalEntry: number,
  adjustedEntry: number,
  slippagePips: number,
): SlippageResult {
  return {
    applied: true,
    originalEntry,
    adjustedEntry,
    slippagePips,
  };
}

/** Helper to create TargetLevels */
function makeTargets(overrides: Partial<TargetLevels> = {}): TargetLevels {
  return {
    rUnit: 2.0,
    tp1: 2042.1, // This will be recalculated by formatter
    tp2: 2046.0,
    isValid: true,
    ...overrides,
  };
}

/** Helper to create a full FormatterInput */
function makeFormatterInput(overrides: Partial<FormatterInput> = {}): FormatterInput {
  const rawSignal = makeRawSignal();
  return {
    rawSignal,
    stopLoss: 2038.0,
    targets: makeTargets(),
    zoneClassification: 'expansion_zone' as ZoneClassification,
    kellyResult: makeKellyResult(),
    slippageResult: makeNoSlippage(rawSignal.entryPrice),
    ...overrides,
  };
}

describe('SignalOutputFormatter', () => {
  const formatter = createSignalOutputFormatter();

  describe('split position sizing', () => {
    it('should set Ticket 1 (Safety Lock) at 45% position size', () => {
      const input = makeFormatterInput();
      const result = formatter.format(input);

      expect(result.ticket1.label).toBe('Safety Lock');
      expect(result.ticket1.positionSizePercent).toBe(45);
    });

    it('should set Ticket 2 (Runner) at 55% position size', () => {
      const input = makeFormatterInput();
      const result = formatter.format(input);

      expect(result.ticket2.label).toBe('Runner');
      expect(result.ticket2.positionSizePercent).toBe(55);
    });

    it('should have Ticket 1 + Ticket 2 = 100% total position', () => {
      const input = makeFormatterInput();
      const result = formatter.format(input);

      expect(
        result.ticket1.positionSizePercent + result.ticket2.positionSizePercent,
      ).toBe(100);
    });
  });

  describe('TP1 calculation (35% of distance to TP2)', () => {
    it('should calculate TP1 for LONG: entry + 0.35 × (TP2 - entry)', () => {
      const entry = 2040.0;
      const tp2 = 2046.0;
      const input = makeFormatterInput({
        rawSignal: makeRawSignal({ direction: 'long', entryPrice: entry }),
        targets: makeTargets({ tp2 }),
        slippageResult: makeNoSlippage(entry),
      });

      const result = formatter.format(input);

      // TP1 = 2040 + 0.35 * (2046 - 2040) = 2040 + 0.35 * 6 = 2040 + 2.1 = 2042.1
      const expectedTp1 = entry + 0.35 * (tp2 - entry);
      expect(result.ticket1.takeProfit).toBeCloseTo(expectedTp1, 10);
    });

    it('should calculate TP1 for SHORT: entry - 0.35 × (entry - TP2)', () => {
      const entry = 2050.0;
      const tp2 = 2044.0;
      const input = makeFormatterInput({
        rawSignal: makeRawSignal({ direction: 'short', entryPrice: entry }),
        targets: makeTargets({ tp2 }),
        slippageResult: makeNoSlippage(entry),
        zoneClassification: 'expansion_zone',
      });

      const result = formatter.format(input);

      // TP1 = 2050 - 0.35 * (2050 - 2044) = 2050 - 0.35 * 6 = 2050 - 2.1 = 2047.9
      const expectedTp1 = entry - 0.35 * (entry - tp2);
      expect(result.ticket1.takeProfit).toBeCloseTo(expectedTp1, 10);
    });

    it('should place TP1 between entry and TP2 for longs', () => {
      const entry = 2040.0;
      const tp2 = 2046.0;
      const input = makeFormatterInput({
        rawSignal: makeRawSignal({ direction: 'long', entryPrice: entry }),
        targets: makeTargets({ tp2 }),
        slippageResult: makeNoSlippage(entry),
      });

      const result = formatter.format(input);

      expect(result.ticket1.takeProfit).toBeGreaterThan(entry);
      expect(result.ticket1.takeProfit).toBeLessThan(tp2);
    });

    it('should place TP1 between TP2 and entry for shorts', () => {
      const entry = 2050.0;
      const tp2 = 2044.0;
      const input = makeFormatterInput({
        rawSignal: makeRawSignal({ direction: 'short', entryPrice: entry }),
        targets: makeTargets({ tp2 }),
        slippageResult: makeNoSlippage(entry),
      });

      const result = formatter.format(input);

      expect(result.ticket1.takeProfit).toBeLessThan(entry);
      expect(result.ticket1.takeProfit).toBeGreaterThan(tp2);
    });
  });

  describe('TP2 assignment', () => {
    it('should use TP2 from targets (expansion zone 3.0R)', () => {
      const input = makeFormatterInput({
        targets: makeTargets({ tp2: 2046.0, rUnit: 2.0 }),
        zoneClassification: 'expansion_zone',
      });

      const result = formatter.format(input);
      expect(result.ticket2.takeProfit).toBe(2046.0);
    });

    it('should use TP2 from targets (chop zone 1.5R)', () => {
      const input = makeFormatterInput({
        targets: makeTargets({ tp2: 2043.0, rUnit: 2.0 }),
        zoneClassification: 'chop_zone',
      });

      const result = formatter.format(input);
      expect(result.ticket2.takeProfit).toBe(2043.0);
    });
  });

  describe('shared entry and stop-loss', () => {
    it('should set both tickets to the same entry price', () => {
      const input = makeFormatterInput();
      const result = formatter.format(input);

      expect(result.ticket1.entryPrice).toBe(result.ticket2.entryPrice);
      expect(result.ticket1.entryPrice).toBe(result.entryPrice);
    });

    it('should set both tickets to the same stop-loss', () => {
      const input = makeFormatterInput({ stopLoss: 2037.5 });
      const result = formatter.format(input);

      expect(result.ticket1.stopLoss).toBe(result.ticket2.stopLoss);
      expect(result.ticket1.stopLoss).toBe(2037.5);
    });
  });

  describe('breakeven trigger', () => {
    it('should include breakeven trigger text for long signals', () => {
      const input = makeFormatterInput({
        rawSignal: makeRawSignal({ direction: 'long', entryPrice: 2040.0 }),
        slippageResult: makeNoSlippage(2040.0),
      });

      const result = formatter.format(input);

      expect(result.breakevenTrigger).toContain('Ticket 1 TP');
      expect(result.breakevenTrigger).toContain('Ticket 2 SL');
      expect(result.breakevenTrigger).toContain('entry');
      expect(result.breakevenTrigger).toContain('2040.00');
    });

    it('should include breakeven trigger text for short signals', () => {
      const entry = 2050.0;
      const input = makeFormatterInput({
        rawSignal: makeRawSignal({ direction: 'short', entryPrice: entry }),
        slippageResult: makeNoSlippage(entry),
      });

      const result = formatter.format(input);

      expect(result.breakevenTrigger).toContain('Ticket 1 TP');
      expect(result.breakevenTrigger).toContain('move Ticket 2 SL to entry');
    });
  });

  describe('trailing stop guidance', () => {
    it('should reference swing low for long signals', () => {
      const input = makeFormatterInput({
        rawSignal: makeRawSignal({ direction: 'long' }),
        recentSwingPoint: 2039.5,
      });

      const result = formatter.format(input);

      expect(result.trailingStopGuidance).toContain('swing low');
      expect(result.trailingStopGuidance).toContain('2039.50');
      expect(result.trailingStopGuidance).toContain('breakeven');
    });

    it('should reference swing high for short signals', () => {
      const input = makeFormatterInput({
        rawSignal: makeRawSignal({ direction: 'short', entryPrice: 2050.0 }),
        slippageResult: makeNoSlippage(2050.0),
        recentSwingPoint: 2051.2,
      });

      const result = formatter.format(input);

      expect(result.trailingStopGuidance).toContain('swing high');
      expect(result.trailingStopGuidance).toContain('2051.20');
      expect(result.trailingStopGuidance).toContain('breakeven');
    });

    it('should provide generic guidance when no swing point available', () => {
      const input = makeFormatterInput();
      // No recentSwingPoint provided

      const result = formatter.format(input);

      expect(result.trailingStopGuidance).toContain('M5 structural');
      expect(result.trailingStopGuidance).toContain('breakeven');
    });
  });

  describe('Kelly risk amount inclusion', () => {
    it('should include Kelly risk amount in output (Requirement 8.8)', () => {
      const input = makeFormatterInput({
        kellyResult: makeKellyResult({ riskAmount: 52.5 }),
      });

      const result = formatter.format(input);
      expect(result.riskAmount).toBe(52.5);
    });

    it('should include cold start default risk ($35)', () => {
      const input = makeFormatterInput({
        kellyResult: makeKellyResult({ riskAmount: 35.0, isColdStart: true }),
      });

      const result = formatter.format(input);
      expect(result.riskAmount).toBe(35.0);
    });
  });

  describe('zone classification inclusion (Requirement 9.5)', () => {
    it('should include expansion_zone classification', () => {
      const input = makeFormatterInput({
        zoneClassification: 'expansion_zone',
      });

      const result = formatter.format(input);
      expect(result.zoneClassification).toBe('expansion_zone');
    });

    it('should include chop_zone classification', () => {
      const input = makeFormatterInput({
        zoneClassification: 'chop_zone',
      });

      const result = formatter.format(input);
      expect(result.zoneClassification).toBe('chop_zone');
    });
  });

  describe('slippage details inclusion (Requirement 10.6)', () => {
    it('should include slippage result when slippage is applied', () => {
      const slippageResult = makeSlippage(2040.0, 2040.15, 1.5);
      const input = makeFormatterInput({
        rawSignal: makeRawSignal({ direction: 'long', entryPrice: 2040.0 }),
        slippageResult,
      });

      const result = formatter.format(input);

      expect(result.slippage.applied).toBe(true);
      expect(result.slippage.originalEntry).toBe(2040.0);
      expect(result.slippage.adjustedEntry).toBe(2040.15);
      expect(result.slippage.slippagePips).toBe(1.5);
    });

    it('should include slippage result when slippage is NOT applied', () => {
      const input = makeFormatterInput({
        slippageResult: makeNoSlippage(2040.0),
      });

      const result = formatter.format(input);

      expect(result.slippage.applied).toBe(false);
      expect(result.slippage.originalEntry).toBe(2040.0);
      expect(result.slippage.adjustedEntry).toBe(2040.0);
      expect(result.slippage.slippagePips).toBe(0);
    });

    it('should use adjusted entry as the signal entry price when slippage applied', () => {
      const slippageResult = makeSlippage(2040.0, 2040.2, 2.0);
      const input = makeFormatterInput({
        rawSignal: makeRawSignal({ direction: 'long', entryPrice: 2040.0 }),
        slippageResult,
      });

      const result = formatter.format(input);

      // Entry price on the signal and tickets should be the adjusted entry
      expect(result.entryPrice).toBe(2040.2);
      expect(result.ticket1.entryPrice).toBe(2040.2);
      expect(result.ticket2.entryPrice).toBe(2040.2);
    });
  });

  describe('instrument label (Requirement 16.3)', () => {
    it('should label instrument as XAUUSD on all outputs', () => {
      const input = makeFormatterInput();
      const result = formatter.format(input);

      expect(result.instrument).toBe('XAUUSD');
    });

    it('should label instrument as XAUUSD regardless of direction', () => {
      const longInput = makeFormatterInput({
        rawSignal: makeRawSignal({ direction: 'long' }),
      });
      const shortInput = makeFormatterInput({
        rawSignal: makeRawSignal({ direction: 'short', entryPrice: 2050.0 }),
        slippageResult: makeNoSlippage(2050.0),
      });

      expect(formatter.format(longInput).instrument).toBe('XAUUSD');
      expect(formatter.format(shortInput).instrument).toBe('XAUUSD');
    });
  });

  describe('reasoning field', () => {
    it('should include reasoning limited to 280 characters', () => {
      const input = makeFormatterInput();
      const result = formatter.format(input);

      expect(result.reasoning.length).toBeLessThanOrEqual(280);
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it('should include direction, zone, and pattern in reasoning', () => {
      const input = makeFormatterInput({
        rawSignal: makeRawSignal({
          direction: 'long',
          rejectionCandleType: 'hammer',
        }),
        zoneClassification: 'expansion_zone',
      });

      const result = formatter.format(input);

      expect(result.reasoning).toContain('LONG');
      expect(result.reasoning).toContain('XAUUSD');
      expect(result.reasoning).toContain('Expansion');
      expect(result.reasoning).toContain('hammer');
    });

    it('should truncate reasoning to 280 chars with ellipsis if too long', () => {
      // Create an input with a very long adjustment reason
      const longReason = 'A'.repeat(300);
      const input = makeFormatterInput({
        kellyResult: makeKellyResult({
          adjustmentReason: longReason,
          isColdStart: false,
        }),
      });

      const result = formatter.format(input);
      expect(result.reasoning.length).toBeLessThanOrEqual(280);
      expect(result.reasoning).toMatch(/\.\.\.$/);
    });
  });

  describe('signal ID and timestamp propagation', () => {
    it('should propagate signal ID from raw signal', () => {
      const input = makeFormatterInput({
        rawSignal: makeRawSignal({ id: 'unique-signal-id-123' }),
      });

      const result = formatter.format(input);
      expect(result.id).toBe('unique-signal-id-123');
    });

    it('should propagate timestamp from raw signal', () => {
      const input = makeFormatterInput({
        rawSignal: makeRawSignal({ timestamp: '2024-03-20T15:45:30.123Z' }),
      });

      const result = formatter.format(input);
      expect(result.timestamp).toBe('2024-03-20T15:45:30.123Z');
    });
  });

  describe('rUnit propagation', () => {
    it('should include R_Unit from target calculation', () => {
      const input = makeFormatterInput({
        targets: makeTargets({ rUnit: 3.5 }),
      });

      const result = formatter.format(input);
      expect(result.rUnit).toBe(3.5);
    });
  });

  describe('direction propagation', () => {
    it('should propagate long direction', () => {
      const input = makeFormatterInput({
        rawSignal: makeRawSignal({ direction: 'long' }),
      });

      const result = formatter.format(input);
      expect(result.direction).toBe('long');
    });

    it('should propagate short direction', () => {
      const input = makeFormatterInput({
        rawSignal: makeRawSignal({ direction: 'short', entryPrice: 2050.0 }),
        slippageResult: makeNoSlippage(2050.0),
      });

      const result = formatter.format(input);
      expect(result.direction).toBe('short');
    });
  });

  describe('complete FormattedSignal structure', () => {
    it('should return all required FormattedSignal fields', () => {
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

    it('should return complete TicketDetail for ticket1', () => {
      const input = makeFormatterInput();
      const result = formatter.format(input);

      expect(result.ticket1).toHaveProperty('label');
      expect(result.ticket1).toHaveProperty('positionSizePercent');
      expect(result.ticket1).toHaveProperty('entryPrice');
      expect(result.ticket1).toHaveProperty('stopLoss');
      expect(result.ticket1).toHaveProperty('takeProfit');
    });

    it('should return complete TicketDetail for ticket2', () => {
      const input = makeFormatterInput();
      const result = formatter.format(input);

      expect(result.ticket2).toHaveProperty('label');
      expect(result.ticket2).toHaveProperty('positionSizePercent');
      expect(result.ticket2).toHaveProperty('entryPrice');
      expect(result.ticket2).toHaveProperty('stopLoss');
      expect(result.ticket2).toHaveProperty('takeProfit');
    });
  });

  describe('end-to-end scenarios', () => {
    it('should format a complete long signal with expansion zone', () => {
      const entry = 2040.0;
      const sl = 2038.0;
      const rUnit = 2.0; // |2040 - 2038|
      const tp2 = entry + 3.0 * rUnit; // 3.0R expansion = 2046.0
      const tp1 = entry + 0.35 * (tp2 - entry); // 2040 + 0.35 * 6 = 2042.1

      const input: FormatterInput = {
        rawSignal: makeRawSignal({
          direction: 'long',
          entryPrice: entry,
          rejectionCandleType: 'bullish_engulfing',
        }),
        stopLoss: sl,
        targets: { rUnit, tp1: tp1, tp2, isValid: true },
        zoneClassification: 'expansion_zone',
        kellyResult: makeKellyResult({ riskAmount: 70.0, isColdStart: false }),
        slippageResult: makeNoSlippage(entry),
        recentSwingPoint: 2039.2,
      };

      const result = formatter.format(input);

      expect(result.instrument).toBe('XAUUSD');
      expect(result.direction).toBe('long');
      expect(result.entryPrice).toBe(2040.0);
      expect(result.stopLoss).toBe(2038.0);
      expect(result.ticket1.positionSizePercent).toBe(45);
      expect(result.ticket1.takeProfit).toBeCloseTo(2042.1, 5);
      expect(result.ticket2.positionSizePercent).toBe(55);
      expect(result.ticket2.takeProfit).toBe(2046.0);
      expect(result.zoneClassification).toBe('expansion_zone');
      expect(result.riskAmount).toBe(70.0);
      expect(result.rUnit).toBe(2.0);
      expect(result.trailingStopGuidance).toContain('2039.20');
    });

    it('should format a complete short signal with chop zone and slippage', () => {
      const originalEntry = 2050.0;
      const adjustedEntry = 2049.85; // 1.5 pips slippage adverse for short
      const sl = 2052.0;
      const rUnit = 2.0; // from target mapper (uses original calculations)
      const tp2 = 2047.0; // 1.5R chop zone target
      // TP1 for short: entry - 0.35 * (entry - tp2)
      // = 2049.85 - 0.35 * (2049.85 - 2047.0) = 2049.85 - 0.35 * 2.85 = 2049.85 - 0.9975 = 2048.8525

      const input: FormatterInput = {
        rawSignal: makeRawSignal({
          direction: 'short',
          entryPrice: originalEntry,
          rejectionCandleType: 'shooting_star',
        }),
        stopLoss: sl,
        targets: { rUnit, tp1: 2048.95, tp2, isValid: true },
        zoneClassification: 'chop_zone',
        kellyResult: makeKellyResult({ riskAmount: 35.0 }),
        slippageResult: makeSlippage(originalEntry, adjustedEntry, 1.5),
        recentSwingPoint: 2051.5,
      };

      const result = formatter.format(input);

      expect(result.instrument).toBe('XAUUSD');
      expect(result.direction).toBe('short');
      expect(result.entryPrice).toBe(adjustedEntry);
      expect(result.stopLoss).toBe(2052.0);
      expect(result.ticket1.positionSizePercent).toBe(45);
      expect(result.ticket2.positionSizePercent).toBe(55);
      expect(result.ticket2.takeProfit).toBe(2047.0);
      expect(result.zoneClassification).toBe('chop_zone');
      expect(result.slippage.applied).toBe(true);
      expect(result.slippage.originalEntry).toBe(2050.0);
      expect(result.slippage.adjustedEntry).toBe(2049.85);
      expect(result.slippage.slippagePips).toBe(1.5);
      expect(result.trailingStopGuidance).toContain('swing high');
      expect(result.trailingStopGuidance).toContain('2051.50');
    });
  });
});
