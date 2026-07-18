/**
 * Tests for the Telegram Notifier module.
 * Tests retry logic, field validation, message formatting, and delivery suppression.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TelegramNotifier,
  formatSignalMessage,
  validateSignalFields,
  type TelegramConfig,
  type TelegramLogger,
  type FetchFn,
  type SleepFn,
} from './telegram-notifier.js';
import type { FormattedSignal } from '../types/signal.js';

/** Helper to create a valid FormattedSignal for testing */
function createValidSignal(overrides?: Partial<FormattedSignal>): FormattedSignal {
  return {
    id: 'sig-001',
    timestamp: '2024-01-15T14:30:00.000Z',
    instrument: 'XAUUSD',
    direction: 'long',
    entryPrice: 2045.5,
    stopLoss: 2042.0,
    ticket1: {
      label: 'Safety Lock',
      positionSizePercent: 45,
      entryPrice: 2045.5,
      stopLoss: 2042.0,
      takeProfit: 2047.73,
    },
    ticket2: {
      label: 'Runner',
      positionSizePercent: 55,
      entryPrice: 2045.5,
      stopLoss: 2042.0,
      takeProfit: 2056.0,
    },
    zoneClassification: 'expansion_zone',
    riskAmount: 35.0,
    rUnit: 3.5,
    reasoning: 'Bullish hammer at M15 support with volume expansion and EMA confluence.',
    slippage: {
      applied: false,
      originalEntry: 2045.5,
      adjustedEntry: 2045.5,
      slippagePips: 0,
    },
    breakevenTrigger: 'Move SL to entry when TP1 hit',
    trailingStopGuidance: 'Trail to most recent M5 swing low',
    ...overrides,
  };
}

function createConfig(overrides?: Partial<TelegramConfig>): TelegramConfig {
  return {
    botToken: 'test-token',
    chatId: '7040023207',
    maxRetries: 3,
    baseRetryMs: 2000,
    ...overrides,
  };
}

function createLogger(): TelegramLogger & {
  errors: Array<{ message: string; context?: Record<string, unknown> }>;
  warnings: Array<{ message: string; context?: Record<string, unknown> }>;
  infos: Array<{ message: string; context?: Record<string, unknown> }>;
} {
  const errors: Array<{ message: string; context?: Record<string, unknown> }> = [];
  const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
  const infos: Array<{ message: string; context?: Record<string, unknown> }> = [];

  return {
    errors,
    warnings,
    infos,
    error(message: string, context?: Record<string, unknown>) {
      errors.push({ message, context });
    },
    warn(message: string, context?: Record<string, unknown>) {
      warnings.push({ message, context });
    },
    info(message: string, context?: Record<string, unknown>) {
      infos.push({ message, context });
    },
  };
}

function createSuccessFetch(): FetchFn {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
}

function createFailFetch(status = 500, statusText = 'Internal Server Error'): FetchFn {
  return vi.fn().mockResolvedValue({ ok: false, status, statusText });
}

function createInstantSleep(): SleepFn {
  return vi.fn().mockResolvedValue(undefined);
}

describe('TelegramNotifier', () => {
  let config: TelegramConfig;
  let logger: ReturnType<typeof createLogger>;
  let sleepFn: SleepFn;

  beforeEach(() => {
    config = createConfig();
    logger = createLogger();
    sleepFn = createInstantSleep();
  });

  describe('sendSignal - successful delivery', () => {
    it('should deliver signal on first attempt when fetch succeeds', async () => {
      const fetchFn = createSuccessFetch();
      const notifier = new TelegramNotifier(config, logger, fetchFn, sleepFn);
      const signal = createValidSignal();

      const result = await notifier.sendSignal(signal);

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(1);
      expect(result.error).toBeNull();
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('should call the correct Telegram Bot API URL', async () => {
      const fetchFn = createSuccessFetch();
      const notifier = new TelegramNotifier(config, logger, fetchFn, sleepFn);
      const signal = createValidSignal();

      await notifier.sendSignal(signal);

      expect(fetchFn).toHaveBeenCalledWith(
        `https://api.telegram.org/bot${config.botToken}/sendMessage`,
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    it('should send message with HTML parse mode and correct chat ID', async () => {
      const fetchFn = createSuccessFetch();
      const notifier = new TelegramNotifier(config, logger, fetchFn, sleepFn);
      const signal = createValidSignal();

      await notifier.sendSignal(signal);

      const callArgs = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.chat_id).toBe('7040023207');
      expect(body.parse_mode).toBe('HTML');
    });

    it('should log info on successful delivery', async () => {
      const fetchFn = createSuccessFetch();
      const notifier = new TelegramNotifier(config, logger, fetchFn, sleepFn);
      const signal = createValidSignal();

      await notifier.sendSignal(signal);

      expect(logger.infos.length).toBe(1);
      expect(logger.infos[0].message).toContain('delivered successfully');
    });
  });

  describe('sendSignal - retry logic', () => {
    it('should retry with exponential backoff on failure (2s, 4s, 8s)', async () => {
      const fetchFn = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
        .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
        .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
        .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK' }) as unknown as FetchFn;

      const notifier = new TelegramNotifier(config, logger, fetchFn, sleepFn);
      const signal = createValidSignal();

      const result = await notifier.sendSignal(signal);

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(4); // 1 initial + 3 retries
      expect(sleepFn).toHaveBeenCalledTimes(3);
      expect(sleepFn).toHaveBeenNthCalledWith(1, 2000); // 2s
      expect(sleepFn).toHaveBeenNthCalledWith(2, 4000); // 4s
      expect(sleepFn).toHaveBeenNthCalledWith(3, 8000); // 8s
    });

    it('should succeed on second attempt after first failure', async () => {
      const fetchFn = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' })
        .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK' }) as unknown as FetchFn;

      const notifier = new TelegramNotifier(config, logger, fetchFn, sleepFn);
      const signal = createValidSignal();

      const result = await notifier.sendSignal(signal);

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
      expect(sleepFn).toHaveBeenCalledTimes(1);
      expect(sleepFn).toHaveBeenCalledWith(2000);
    });

    it('should handle network errors and retry', async () => {
      const fetchFn = vi.fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK' }) as unknown as FetchFn;

      const notifier = new TelegramNotifier(config, logger, fetchFn, sleepFn);
      const signal = createValidSignal();

      const result = await notifier.sendSignal(signal);

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
    });

    it('should log failure and full signal content after all retries exhausted', async () => {
      const fetchFn = createFailFetch(500, 'Internal Server Error');
      const notifier = new TelegramNotifier(config, logger, fetchFn, sleepFn);
      const signal = createValidSignal();

      const result = await notifier.sendSignal(signal);

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(4); // 1 initial + 3 retries
      expect(result.error).toContain('500');

      // Must log failure with full signal for manual review
      const failureLog = logger.errors.find((e) =>
        e.message.includes('failed after all retries'),
      );
      expect(failureLog).toBeDefined();
      expect(failureLog!.context).toHaveProperty('fullSignal');
      expect(failureLog!.context!.fullSignal).toEqual(signal);
    });

    it('should log warnings for each intermediate retry attempt', async () => {
      const fetchFn = createFailFetch();
      const notifier = new TelegramNotifier(config, logger, fetchFn, sleepFn);
      const signal = createValidSignal();

      await notifier.sendSignal(signal);

      // Should have 3 warning logs for the 3 retries (attempts 1, 2, 3 fail, then final)
      expect(logger.warnings.length).toBe(3);
    });
  });

  describe('sendSignal - configuration validation', () => {
    it('should suppress delivery and log error if chatId is missing', async () => {
      const fetchFn = createSuccessFetch();
      const configNoChatId = createConfig({ chatId: '' });
      const notifier = new TelegramNotifier(configNoChatId, logger, fetchFn, sleepFn);
      const signal = createValidSignal();

      const result = await notifier.sendSignal(signal);

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(0);
      expect(result.error).toContain('chatId');
      expect(fetchFn).not.toHaveBeenCalled();
      expect(logger.errors.length).toBe(1);
      expect(logger.errors[0].message).toContain('suppressed');
    });

    it('should suppress delivery and log error if botToken is missing', async () => {
      const fetchFn = createSuccessFetch();
      const configNoToken = createConfig({ botToken: '' });
      const notifier = new TelegramNotifier(configNoToken, logger, fetchFn, sleepFn);
      const signal = createValidSignal();

      const result = await notifier.sendSignal(signal);

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(0);
      expect(result.error).toContain('botToken');
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  describe('sendSignal - field validation', () => {
    it('should suppress delivery if direction is missing', async () => {
      const fetchFn = createSuccessFetch();
      const notifier = new TelegramNotifier(config, logger, fetchFn, sleepFn);
      const signal = createValidSignal({ direction: undefined as unknown as 'long' });

      const result = await notifier.sendSignal(signal);

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(0);
      expect(result.error).toContain('direction');
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('should suppress delivery if entryPrice is missing', async () => {
      const fetchFn = createSuccessFetch();
      const notifier = new TelegramNotifier(config, logger, fetchFn, sleepFn);
      const signal = createValidSignal({ entryPrice: undefined as unknown as number });

      const result = await notifier.sendSignal(signal);

      expect(result.success).toBe(false);
      expect(result.error).toContain('entryPrice');
    });

    it('should suppress delivery if stopLoss is missing', async () => {
      const fetchFn = createSuccessFetch();
      const notifier = new TelegramNotifier(config, logger, fetchFn, sleepFn);
      const signal = createValidSignal({ stopLoss: undefined as unknown as number });

      const result = await notifier.sendSignal(signal);

      expect(result.success).toBe(false);
      expect(result.error).toContain('stopLoss');
    });

    it('should suppress delivery if zoneClassification is missing', async () => {
      const fetchFn = createSuccessFetch();
      const notifier = new TelegramNotifier(config, logger, fetchFn, sleepFn);
      const signal = createValidSignal({
        zoneClassification: undefined as unknown as 'expansion_zone',
      });

      const result = await notifier.sendSignal(signal);

      expect(result.success).toBe(false);
      expect(result.error).toContain('zoneClassification');
    });

    it('should suppress delivery if riskAmount is missing', async () => {
      const fetchFn = createSuccessFetch();
      const notifier = new TelegramNotifier(config, logger, fetchFn, sleepFn);
      const signal = createValidSignal({ riskAmount: undefined as unknown as number });

      const result = await notifier.sendSignal(signal);

      expect(result.success).toBe(false);
      expect(result.error).toContain('riskAmount');
    });

    it('should suppress delivery if ticket1 TP (TP1) is missing', async () => {
      const fetchFn = createSuccessFetch();
      const notifier = new TelegramNotifier(config, logger, fetchFn, sleepFn);
      const signal = createValidSignal({
        ticket1: {
          label: 'Safety Lock',
          positionSizePercent: 45,
          entryPrice: 2045.5,
          stopLoss: 2042.0,
          takeProfit: undefined as unknown as number,
        },
      });

      const result = await notifier.sendSignal(signal);

      expect(result.success).toBe(false);
      expect(result.error).toContain('TP1');
    });

    it('should suppress delivery if ticket2 TP (TP2) is missing', async () => {
      const fetchFn = createSuccessFetch();
      const notifier = new TelegramNotifier(config, logger, fetchFn, sleepFn);
      const signal = createValidSignal({
        ticket2: {
          label: 'Runner',
          positionSizePercent: 55,
          entryPrice: 2045.5,
          stopLoss: 2042.0,
          takeProfit: undefined as unknown as number,
        },
      });

      const result = await notifier.sendSignal(signal);

      expect(result.success).toBe(false);
      expect(result.error).toContain('TP2');
    });
  });

  describe('sendSignal - signal-only constraint', () => {
    it('should NOT include trade execution commands in the message', async () => {
      const fetchFn = createSuccessFetch();
      const notifier = new TelegramNotifier(config, logger, fetchFn, sleepFn);
      const signal = createValidSignal();

      await notifier.sendSignal(signal);

      const callArgs = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      const messageText: string = body.text;

      // Must NOT contain execution-related keywords
      const executionKeywords = [
        'execute',
        'place order',
        'submit order',
        'open trade',
        'close trade',
        'buy now',
        'sell now',
        'market order',
        'limit order',
        'pending order',
      ];

      for (const keyword of executionKeywords) {
        expect(messageText.toLowerCase()).not.toContain(keyword.toLowerCase());
      }
    });
  });
});

describe('formatSignalMessage', () => {
  it('should include direction in the message', () => {
    const signal = createValidSignal({ direction: 'long' });
    const message = formatSignalMessage(signal);
    expect(message).toContain('LONG');
  });

  it('should include entry price', () => {
    const signal = createValidSignal({ entryPrice: 2045.5 });
    const message = formatSignalMessage(signal);
    expect(message).toContain('2045.50');
  });

  it('should include stop loss', () => {
    const signal = createValidSignal({ stopLoss: 2042.0 });
    const message = formatSignalMessage(signal);
    expect(message).toContain('2042.00');
  });

  it('should include TP1 and TP2', () => {
    const signal = createValidSignal();
    const message = formatSignalMessage(signal);
    expect(message).toContain('2047.73'); // TP1
    expect(message).toContain('2056.00'); // TP2
  });

  it('should include split position details', () => {
    const signal = createValidSignal();
    const message = formatSignalMessage(signal);
    expect(message).toContain('45%');
    expect(message).toContain('55%');
    expect(message).toContain('Safety Lock');
    expect(message).toContain('Runner');
  });

  it('should include zone classification', () => {
    const signal = createValidSignal({ zoneClassification: 'expansion_zone' });
    const message = formatSignalMessage(signal);
    expect(message).toContain('Expansion Zone');
  });

  it('should include chop zone classification', () => {
    const signal = createValidSignal({ zoneClassification: 'chop_zone' });
    const message = formatSignalMessage(signal);
    expect(message).toContain('Chop Zone');
  });

  it('should include risk amount', () => {
    const signal = createValidSignal({ riskAmount: 35.0 });
    const message = formatSignalMessage(signal);
    expect(message).toContain('$35.00');
  });

  it('should include reasoning limited to 280 characters', () => {
    const longReasoning = 'A'.repeat(300);
    const signal = createValidSignal({ reasoning: longReasoning });
    const message = formatSignalMessage(signal);
    // The reasoning in the message should be truncated to 280 chars
    expect(message).toContain('A'.repeat(280));
    expect(message).not.toContain('A'.repeat(281));
  });

  it('should include slippage info when applied', () => {
    const signal = createValidSignal({
      slippage: {
        applied: true,
        originalEntry: 2046.0,
        adjustedEntry: 2045.5,
        slippagePips: 1.5,
      },
    });
    const message = formatSignalMessage(signal);
    expect(message).toContain('Slippage');
    expect(message).toContain('1.5');
  });

  it('should NOT include slippage info when not applied', () => {
    const signal = createValidSignal({
      slippage: {
        applied: false,
        originalEntry: 2045.5,
        adjustedEntry: 2045.5,
        slippagePips: 0,
      },
    });
    const message = formatSignalMessage(signal);
    expect(message).not.toContain('Slippage');
  });

  it('should use green emoji for long signals', () => {
    const signal = createValidSignal({ direction: 'long' });
    const message = formatSignalMessage(signal);
    expect(message).toContain('🟢');
  });

  it('should use red emoji for short signals', () => {
    const signal = createValidSignal({ direction: 'short' });
    const message = formatSignalMessage(signal);
    expect(message).toContain('🔴');
  });

  it('should include XAU/USD instrument label', () => {
    const signal = createValidSignal();
    const message = formatSignalMessage(signal);
    expect(message).toContain('XAU/USD');
  });
});

describe('validateSignalFields', () => {
  it('should return null for a valid signal', () => {
    const signal = createValidSignal();
    expect(validateSignalFields(signal)).toBeNull();
  });

  it('should return error for missing direction', () => {
    const signal = createValidSignal({ direction: undefined as unknown as 'long' });
    const error = validateSignalFields(signal);
    expect(error).toContain('direction');
  });

  it('should return error for missing entryPrice', () => {
    const signal = createValidSignal({ entryPrice: undefined as unknown as number });
    const error = validateSignalFields(signal);
    expect(error).toContain('entryPrice');
  });

  it('should return error for null stopLoss', () => {
    const signal = createValidSignal({ stopLoss: null as unknown as number });
    const error = validateSignalFields(signal);
    expect(error).toContain('stopLoss');
  });

  it('should return error for missing ticket1', () => {
    const signal = createValidSignal({
      ticket1: undefined as unknown as FormattedSignal['ticket1'],
    });
    const error = validateSignalFields(signal);
    expect(error).toContain('TP1');
  });

  it('should return error for missing ticket2 takeProfit', () => {
    const signal = createValidSignal({
      ticket2: {
        label: 'Runner',
        positionSizePercent: 55,
        entryPrice: 2045.5,
        stopLoss: 2042.0,
        takeProfit: null as unknown as number,
      },
    });
    const error = validateSignalFields(signal);
    expect(error).toContain('TP2');
  });
});
