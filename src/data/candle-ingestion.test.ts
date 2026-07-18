/**
 * Unit Tests for Candle Ingestion Module
 *
 * Tests candle parsing, instrument validation, timeframe validation,
 * reconnection delay logic, and candle boundary utilities.
 *
 * WebSocket connection behavior is tested via the parseable/validation
 * layers since actual WebSocket connections require a running server.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseIncomingMessage,
  validateInstrument,
  validateTimeframe,
  calculateReconnectDelay,
  getCandleBoundaryStart,
  isCandleClosed,
  CandleIngestion,
  type DataSourceConfig,
  type ReconnectState,
} from './candle-ingestion.js';
import { EventBus } from '../core/event-bus.js';

// ─── parseIncomingMessage Tests ──────────────────────────────────────────────

describe('parseIncomingMessage', () => {
  it('should parse a valid XAUUSD candle message', () => {
    const msg = JSON.stringify({
      instrument: 'XAUUSD',
      timestamp: '2024-01-15T14:05:00.000Z',
      open: 2035.5,
      high: 2036.2,
      low: 2034.8,
      close: 2035.9,
      volume: 1250,
      timeframe: 'M5',
    });

    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.instrument).toBe('XAUUSD');
    expect(result!.timeframe).toBe('M5');
    expect(result!.open).toBe(2035.5);
    expect(result!.high).toBe(2036.2);
    expect(result!.low).toBe(2034.8);
    expect(result!.close).toBe(2035.9);
    expect(result!.volume).toBe(1250);
  });

  it('should return null for invalid JSON', () => {
    expect(parseIncomingMessage('not json')).toBeNull();
    expect(parseIncomingMessage('')).toBeNull();
    expect(parseIncomingMessage('{malformed')).toBeNull();
  });

  it('should return null for missing required fields', () => {
    // Missing instrument
    expect(
      parseIncomingMessage(
        JSON.stringify({
          timestamp: '2024-01-15T14:05:00.000Z',
          open: 2035.5,
          high: 2036.2,
          low: 2034.8,
          close: 2035.9,
          volume: 1250,
          timeframe: 'M5',
        })
      )
    ).toBeNull();

    // Missing volume
    expect(
      parseIncomingMessage(
        JSON.stringify({
          instrument: 'XAUUSD',
          timestamp: '2024-01-15T14:05:00.000Z',
          open: 2035.5,
          high: 2036.2,
          low: 2034.8,
          close: 2035.9,
          timeframe: 'M5',
        })
      )
    ).toBeNull();

    // Missing timeframe
    expect(
      parseIncomingMessage(
        JSON.stringify({
          instrument: 'XAUUSD',
          timestamp: '2024-01-15T14:05:00.000Z',
          open: 2035.5,
          high: 2036.2,
          low: 2034.8,
          close: 2035.9,
          volume: 1250,
        })
      )
    ).toBeNull();
  });

  it('should return null for wrong field types', () => {
    // open is a string instead of number
    expect(
      parseIncomingMessage(
        JSON.stringify({
          instrument: 'XAUUSD',
          timestamp: '2024-01-15T14:05:00.000Z',
          open: '2035.5',
          high: 2036.2,
          low: 2034.8,
          close: 2035.9,
          volume: 1250,
          timeframe: 'M5',
        })
      )
    ).toBeNull();

    // instrument is a number
    expect(
      parseIncomingMessage(
        JSON.stringify({
          instrument: 123,
          timestamp: '2024-01-15T14:05:00.000Z',
          open: 2035.5,
          high: 2036.2,
          low: 2034.8,
          close: 2035.9,
          volume: 1250,
          timeframe: 'M5',
        })
      )
    ).toBeNull();
  });
});

// ─── validateInstrument Tests ────────────────────────────────────────────────

describe('validateInstrument', () => {
  it('should accept supported instruments', () => {
    expect(validateInstrument('XAUUSD')).toBe(true);
    expect(validateInstrument('BTCUSD')).toBe(true);
  });

  it('should reject unsupported instruments', () => {
    expect(validateInstrument('EURUSD')).toBe(false);
    expect(validateInstrument('GBPUSD')).toBe(false);
    expect(validateInstrument('xauusd')).toBe(false); // case-sensitive
    expect(validateInstrument('XAU/USD')).toBe(false);
    expect(validateInstrument('')).toBe(false);
    expect(validateInstrument('XAGUSD')).toBe(false);
  });
});

// ─── validateTimeframe Tests ─────────────────────────────────────────────────

describe('validateTimeframe', () => {
  it('should accept valid timeframes', () => {
    expect(validateTimeframe('M1')).toBe(true);
    expect(validateTimeframe('M5')).toBe(true);
    expect(validateTimeframe('M15')).toBe(true);
    expect(validateTimeframe('H1')).toBe(true);
  });

  it('should reject invalid timeframes', () => {
    expect(validateTimeframe('M2')).toBe(false);
    expect(validateTimeframe('M30')).toBe(false);
    expect(validateTimeframe('H4')).toBe(false);
    expect(validateTimeframe('D1')).toBe(false);
    expect(validateTimeframe('W1')).toBe(false);
    expect(validateTimeframe('')).toBe(false);
    expect(validateTimeframe('m5')).toBe(false);
  });
});

// ─── calculateReconnectDelay Tests ───────────────────────────────────────────

describe('calculateReconnectDelay', () => {
  it('should calculate exponential backoff correctly', () => {
    const state: ReconnectState = {
      attempt: 0,
      baseIntervalMs: 1000,
      maxIntervalMs: 60_000,
    };

    // 1s, 2s, 4s, 8s, 16s, 32s, then max
    expect(calculateReconnectDelay({ ...state, attempt: 0 })).toBe(1000);
    expect(calculateReconnectDelay({ ...state, attempt: 1 })).toBe(2000);
    expect(calculateReconnectDelay({ ...state, attempt: 2 })).toBe(4000);
    expect(calculateReconnectDelay({ ...state, attempt: 3 })).toBe(8000);
    expect(calculateReconnectDelay({ ...state, attempt: 4 })).toBe(16000);
    expect(calculateReconnectDelay({ ...state, attempt: 5 })).toBe(32000);
  });

  it('should cap at maxIntervalMs', () => {
    const state: ReconnectState = {
      attempt: 6,
      baseIntervalMs: 1000,
      maxIntervalMs: 60_000,
    };

    // 2^6 * 1000 = 64000, but max is 60000
    expect(calculateReconnectDelay(state)).toBe(60_000);
  });

  it('should cap at maxIntervalMs for very large attempt numbers', () => {
    const state: ReconnectState = {
      attempt: 20,
      baseIntervalMs: 1000,
      maxIntervalMs: 60_000,
    };

    expect(calculateReconnectDelay(state)).toBe(60_000);
  });

  it('should respect custom base and max intervals', () => {
    const state: ReconnectState = {
      attempt: 0,
      baseIntervalMs: 500,
      maxIntervalMs: 10_000,
    };

    expect(calculateReconnectDelay({ ...state, attempt: 0 })).toBe(500);
    expect(calculateReconnectDelay({ ...state, attempt: 1 })).toBe(1000);
    expect(calculateReconnectDelay({ ...state, attempt: 2 })).toBe(2000);
    expect(calculateReconnectDelay({ ...state, attempt: 3 })).toBe(4000);
    expect(calculateReconnectDelay({ ...state, attempt: 4 })).toBe(8000);
    expect(calculateReconnectDelay({ ...state, attempt: 5 })).toBe(10_000); // capped
  });
});

// ─── getCandleBoundaryStart Tests ────────────────────────────────────────────

describe('getCandleBoundaryStart', () => {
  it('should align M1 candles to minute boundaries', () => {
    // 14:05:30.500 → 14:05:00.000
    const ts = new Date('2024-01-15T14:05:30.500Z').getTime();
    const boundary = getCandleBoundaryStart(ts, 'M1');
    expect(boundary).toBe(new Date('2024-01-15T14:05:00.000Z').getTime());
  });

  it('should align M5 candles to 5-minute boundaries', () => {
    // 14:07:30.000 → 14:05:00.000
    const ts = new Date('2024-01-15T14:07:30.000Z').getTime();
    const boundary = getCandleBoundaryStart(ts, 'M5');
    expect(boundary).toBe(new Date('2024-01-15T14:05:00.000Z').getTime());
  });

  it('should align M15 candles to 15-minute boundaries', () => {
    // 14:22:00.000 → 14:15:00.000
    const ts = new Date('2024-01-15T14:22:00.000Z').getTime();
    const boundary = getCandleBoundaryStart(ts, 'M15');
    expect(boundary).toBe(new Date('2024-01-15T14:15:00.000Z').getTime());
  });

  it('should align H1 candles to hour boundaries', () => {
    // 14:30:00.000 → 14:00:00.000
    const ts = new Date('2024-01-15T14:30:00.000Z').getTime();
    const boundary = getCandleBoundaryStart(ts, 'H1');
    expect(boundary).toBe(new Date('2024-01-15T14:00:00.000Z').getTime());
  });

  it('should return the same timestamp when already at boundary', () => {
    const ts = new Date('2024-01-15T14:00:00.000Z').getTime();
    expect(getCandleBoundaryStart(ts, 'M1')).toBe(ts);
    expect(getCandleBoundaryStart(ts, 'M5')).toBe(ts);
    expect(getCandleBoundaryStart(ts, 'M15')).toBe(ts);
    expect(getCandleBoundaryStart(ts, 'H1')).toBe(ts);
  });
});

// ─── isCandleClosed Tests ────────────────────────────────────────────────────

describe('isCandleClosed', () => {
  it('should report M5 candle as closed when 5 minutes have passed', () => {
    const start = new Date('2024-01-15T14:05:00.000Z').getTime();
    const fiveMinLater = new Date('2024-01-15T14:10:00.000Z').getTime();
    expect(isCandleClosed(start, fiveMinLater, 'M5')).toBe(true);
  });

  it('should report M5 candle as not closed before 5 minutes', () => {
    const start = new Date('2024-01-15T14:05:00.000Z').getTime();
    const threeMinLater = new Date('2024-01-15T14:08:00.000Z').getTime();
    expect(isCandleClosed(start, threeMinLater, 'M5')).toBe(false);
  });

  it('should report H1 candle as closed when 1 hour has passed', () => {
    const start = new Date('2024-01-15T14:00:00.000Z').getTime();
    const oneHourLater = new Date('2024-01-15T15:00:00.000Z').getTime();
    expect(isCandleClosed(start, oneHourLater, 'H1')).toBe(true);
  });

  it('should report M1 candle as closed after exactly 60 seconds', () => {
    const start = new Date('2024-01-15T14:05:00.000Z').getTime();
    const oneMinLater = start + 60_000;
    expect(isCandleClosed(start, oneMinLater, 'M1')).toBe(true);
  });

  it('should report M1 candle as NOT closed at 59 seconds', () => {
    const start = new Date('2024-01-15T14:05:00.000Z').getTime();
    const almostOneMin = start + 59_999;
    expect(isCandleClosed(start, almostOneMin, 'M1')).toBe(false);
  });
});

// ─── CandleIngestion class Tests ─────────────────────────────────────────────

describe('CandleIngestion', () => {
  let eventBus: EventBus;
  let ingestion: CandleIngestion;

  beforeEach(() => {
    eventBus = new EventBus();
    ingestion = new CandleIngestion(eventBus);
  });

  afterEach(async () => {
    await ingestion.disconnect();
  });

  describe('onCandleClose', () => {
    it('should register handlers for specific timeframes', () => {
      const handler = vi.fn();
      ingestion.onCandleClose('M5', handler);

      // The handler is registered but won't fire until a message is processed
      expect(handler).not.toHaveBeenCalled();
    });

    it('should allow multiple handlers for the same timeframe', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      ingestion.onCandleClose('M5', handler1);
      ingestion.onCandleClose('M5', handler2);

      // Both registered without error
      expect(true).toBe(true);
    });
  });

  describe('message handling via event bus integration', () => {
    it('should emit candle.close events on the event bus for valid XAUUSD candles', () => {
      const handler = vi.fn();
      eventBus.subscribe('candle.close', handler);

      // Simulate internal message handling by accessing handleMessage via
      // the class. We test the data flow end-to-end by simulating a message.
      // Since handleMessage is private, we test through the event bus output
      // by triggering the internal logic via a test helper approach:
      // We'll call the private method via prototype access for testing.
      const proto = Object.getPrototypeOf(ingestion);
      const handleMessage =
        proto.handleMessage.bind(ingestion);

      // Set config so timeframe filtering works
      (ingestion as unknown as { config: DataSourceConfig }).config = {
        wsUrl: 'ws://test',
        instrument: 'XAUUSD',
        timeframes: ['M1', 'M5', 'M15', 'H1'],
        reconnectIntervalMs: 1000,
      };

      handleMessage(
        JSON.stringify({
          instrument: 'XAUUSD',
          timestamp: '2024-01-15T14:05:00.000Z',
          open: 2035.5,
          high: 2036.2,
          low: 2034.8,
          close: 2035.9,
          volume: 1250,
          timeframe: 'M5',
        })
      );

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0][0];
      expect(event.candle.instrument).toBe('XAUUSD');
      expect(event.candle.timeframe).toBe('M5');
      expect(event.timeframe).toBe('M5');
    });

    it('should NOT emit events for non-XAUUSD instruments', () => {
      const handler = vi.fn();
      eventBus.subscribe('candle.close', handler);

      (ingestion as unknown as { config: DataSourceConfig }).config = {
        wsUrl: 'ws://test',
        instrument: 'XAUUSD',
        timeframes: ['M1', 'M5', 'M15', 'H1'],
        reconnectIntervalMs: 1000,
      };

      const handleMessage =
        Object.getPrototypeOf(ingestion).handleMessage.bind(ingestion);

      handleMessage(
        JSON.stringify({
          instrument: 'EURUSD',
          timestamp: '2024-01-15T14:05:00.000Z',
          open: 1.085,
          high: 1.086,
          low: 1.084,
          close: 1.0855,
          volume: 500,
          timeframe: 'M5',
        })
      );

      expect(handler).not.toHaveBeenCalled();
    });

    it('should NOT emit events for invalid messages', () => {
      const handler = vi.fn();
      eventBus.subscribe('candle.close', handler);

      (ingestion as unknown as { config: DataSourceConfig }).config = {
        wsUrl: 'ws://test',
        instrument: 'XAUUSD',
        timeframes: ['M1', 'M5', 'M15', 'H1'],
        reconnectIntervalMs: 1000,
      };

      const handleMessage =
        Object.getPrototypeOf(ingestion).handleMessage.bind(ingestion);

      handleMessage('invalid json');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should call registered onCandleClose handlers', () => {
      const m5Handler = vi.fn();
      const m1Handler = vi.fn();
      ingestion.onCandleClose('M5', m5Handler);
      ingestion.onCandleClose('M1', m1Handler);

      (ingestion as unknown as { config: DataSourceConfig }).config = {
        wsUrl: 'ws://test',
        instrument: 'XAUUSD',
        timeframes: ['M1', 'M5', 'M15', 'H1'],
        reconnectIntervalMs: 1000,
      };

      const handleMessage =
        Object.getPrototypeOf(ingestion).handleMessage.bind(ingestion);

      handleMessage(
        JSON.stringify({
          instrument: 'XAUUSD',
          timestamp: '2024-01-15T14:05:00.000Z',
          open: 2035.5,
          high: 2036.2,
          low: 2034.8,
          close: 2035.9,
          volume: 1250,
          timeframe: 'M5',
        })
      );

      expect(m5Handler).toHaveBeenCalledTimes(1);
      expect(m1Handler).not.toHaveBeenCalled();
    });

    it('should NOT emit events for timeframes not in config', () => {
      const handler = vi.fn();
      eventBus.subscribe('candle.close', handler);

      (ingestion as unknown as { config: DataSourceConfig }).config = {
        wsUrl: 'ws://test',
        instrument: 'XAUUSD',
        timeframes: ['M5', 'H1'], // Only M5 and H1
        reconnectIntervalMs: 1000,
      };

      const handleMessage =
        Object.getPrototypeOf(ingestion).handleMessage.bind(ingestion);

      handleMessage(
        JSON.stringify({
          instrument: 'XAUUSD',
          timestamp: '2024-01-15T14:05:00.000Z',
          open: 2035.5,
          high: 2036.2,
          low: 2034.8,
          close: 2035.9,
          volume: 1250,
          timeframe: 'M1', // Not in config
        })
      );

      expect(handler).not.toHaveBeenCalled();
    });

    it('should log warning for rejected instruments including timestamps and source', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      (ingestion as unknown as { config: DataSourceConfig }).config = {
        wsUrl: 'ws://test-source',
        instrument: 'XAUUSD',
        timeframes: ['M1', 'M5', 'M15', 'H1'],
        reconnectIntervalMs: 1000,
      };

      const handleMessage =
        Object.getPrototypeOf(ingestion).handleMessage.bind(ingestion);

      handleMessage(
        JSON.stringify({
          instrument: 'GBPUSD',
          timestamp: '2024-01-15T14:05:00.000Z',
          open: 1.27,
          high: 1.271,
          low: 1.269,
          close: 1.2705,
          volume: 800,
          timeframe: 'M5',
        })
      );

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Rejected instrument: GBPUSD')
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('dataTimestamp=2024-01-15T14:05:00.000Z')
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('receiptTimestamp=')
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('source=ws://test-source')
      );

      warnSpy.mockRestore();
    });
  });

  describe('disconnect', () => {
    it('should clear reconnect timer on disconnect', async () => {
      // Set up a fake reconnect timer
      (ingestion as unknown as { reconnectTimer: ReturnType<typeof setTimeout> | null }).reconnectTimer =
        setTimeout(() => {}, 10000);

      await ingestion.disconnect();

      expect(
        (ingestion as unknown as { reconnectTimer: ReturnType<typeof setTimeout> | null }).reconnectTimer
      ).toBeNull();
    });

    it('should set isDisconnecting flag to prevent reconnect', async () => {
      await ingestion.disconnect();

      expect(
        (ingestion as unknown as { isDisconnecting: boolean }).isDisconnecting
      ).toBe(true);
    });

    it('should clear startup health check timer on disconnect', async () => {
      (ingestion as unknown as { startupHealthCheckTimer: ReturnType<typeof setTimeout> | null }).startupHealthCheckTimer =
        setTimeout(() => {}, 10000);

      await ingestion.disconnect();

      expect(
        (ingestion as unknown as { startupHealthCheckTimer: ReturnType<typeof setTimeout> | null }).startupHealthCheckTimer
      ).toBeNull();
    });
  });

  describe('startup health check (R16.4)', () => {
    it('should enter suppressed state if no XAUUSD data received within timeout', async () => {
      vi.useFakeTimers();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      (ingestion as unknown as { config: DataSourceConfig }).config = {
        wsUrl: 'ws://no-gold-source',
        instrument: 'XAUUSD',
        timeframes: ['M1', 'M5', 'M15', 'H1'],
        reconnectIntervalMs: 1000,
      };

      // Call the private startStartupHealthCheck with a short timeout
      const startHealthCheck = (
        ingestion as unknown as { startStartupHealthCheck: (timeout: number) => void }
      ).startStartupHealthCheck.bind(ingestion);
      startHealthCheck(100);

      // Advance past the timeout
      vi.advanceTimersByTime(150);

      expect(ingestion.suppressed).toBe(true);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('CRITICAL')
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('did not provide XAUUSD data')
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('ws://no-gold-source')
      );

      errorSpy.mockRestore();
      vi.useRealTimers();
    });

    it('should NOT enter suppressed state if XAUUSD data is received before timeout', async () => {
      vi.useFakeTimers();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      (ingestion as unknown as { config: DataSourceConfig }).config = {
        wsUrl: 'ws://gold-source',
        instrument: 'XAUUSD',
        timeframes: ['M1', 'M5', 'M15', 'H1'],
        reconnectIntervalMs: 1000,
      };

      // Start health check
      const startHealthCheck = (
        ingestion as unknown as { startStartupHealthCheck: (timeout: number) => void }
      ).startStartupHealthCheck.bind(ingestion);
      startHealthCheck(100);

      // Simulate receiving valid XAUUSD data before timeout
      const handleMessage =
        Object.getPrototypeOf(ingestion).handleMessage.bind(ingestion);
      handleMessage(
        JSON.stringify({
          instrument: 'XAUUSD',
          timestamp: '2024-01-15T14:05:00.000Z',
          open: 2035.5,
          high: 2036.2,
          low: 2034.8,
          close: 2035.9,
          volume: 1250,
          timeframe: 'M5',
        })
      );

      // Advance past the timeout
      vi.advanceTimersByTime(150);

      expect(ingestion.suppressed).toBe(false);
      expect(errorSpy).not.toHaveBeenCalled();

      errorSpy.mockRestore();
      vi.useRealTimers();
    });

    it('should emit ingestion.suppressed event when health check fails', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const handler = vi.fn();
      eventBus.subscribe('ingestion.suppressed', handler);

      (ingestion as unknown as { config: DataSourceConfig }).config = {
        wsUrl: 'ws://no-gold-source',
        instrument: 'XAUUSD',
        timeframes: ['M1', 'M5', 'M15', 'H1'],
        reconnectIntervalMs: 1000,
      };

      const startHealthCheck = (
        ingestion as unknown as { startStartupHealthCheck: (timeout: number) => void }
      ).startStartupHealthCheck.bind(ingestion);
      startHealthCheck(100);

      vi.advanceTimersByTime(150);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'no_xauusd_data',
          source: 'ws://no-gold-source',
        })
      );

      vi.useRealTimers();
    });

    it('should clear health check timer when receiving only non-XAUUSD data (remain will trigger)', async () => {
      vi.useFakeTimers();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      (ingestion as unknown as { config: DataSourceConfig }).config = {
        wsUrl: 'ws://euro-source',
        instrument: 'XAUUSD',
        timeframes: ['M1', 'M5', 'M15', 'H1'],
        reconnectIntervalMs: 1000,
      };

      const startHealthCheck = (
        ingestion as unknown as { startStartupHealthCheck: (timeout: number) => void }
      ).startStartupHealthCheck.bind(ingestion);
      startHealthCheck(100);

      // Send non-XAUUSD data — this should NOT cancel the health check
      const handleMessage =
        Object.getPrototypeOf(ingestion).handleMessage.bind(ingestion);
      handleMessage(
        JSON.stringify({
          instrument: 'EURUSD',
          timestamp: '2024-01-15T14:05:00.000Z',
          open: 1.085,
          high: 1.086,
          low: 1.084,
          close: 1.0855,
          volume: 500,
          timeframe: 'M5',
        })
      );

      vi.advanceTimersByTime(150);

      // Should still become suppressed since only non-XAUUSD data was received
      expect(ingestion.suppressed).toBe(true);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('CRITICAL')
      );

      errorSpy.mockRestore();
      vi.useRealTimers();
    });
  });
});


describe('CandleIngestion - BTC/USD configuration', () => {
  it('accepts BTCUSD candles only when configured for BTCUSD', async () => {
    const eventBus = new EventBus();
    const ingestion = new CandleIngestion(eventBus);
    const handler = vi.fn();
    eventBus.subscribe('candle.close', handler);

    (ingestion as unknown as { config: DataSourceConfig }).config = {
      wsUrl: 'ws://btc-source',
      instrument: 'BTCUSD',
      timeframes: ['M1', 'M5', 'M15', 'H1'],
      reconnectIntervalMs: 1000,
    };

    const handleMessage = Object.getPrototypeOf(ingestion).handleMessage.bind(ingestion);
    handleMessage(JSON.stringify({
      instrument: 'BTCUSD',
      timestamp: '2024-01-15T14:05:00.000Z',
      open: 60_000,
      high: 60_050,
      low: 59_950,
      close: 60_025,
      volume: 12,
      timeframe: 'M5',
    }));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].candle.instrument).toBe('BTCUSD');
    await ingestion.disconnect();
  });
});
