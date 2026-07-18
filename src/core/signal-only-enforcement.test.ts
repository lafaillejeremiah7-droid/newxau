/**
 * Unit tests for the Signal-Only Enforcement Layer.
 * Tests Requirements: 15.1, 15.2, 15.3, 15.5, 15.6, 15.7
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validateStartup,
  blockTradeExecution,
  isAllowedOutbound,
  isTradeExecutionEndpoint,
  enforceSignalOnlyStartup,
  configureAllowedDomains,
  getBlockedAttempts,
  clearBlockedAttempts,
} from './signal-only-enforcement.js';
import { SystemConfig } from '../types/config.js';

/**
 * Creates a minimal valid SystemConfig for testing.
 */
function createValidConfig(): SystemConfig {
  return {
    dataSource: {
      wsUrl: 'ws://localhost:8080',
      instrument: 'XAUUSD',
      reconnectIntervalMs: 1000,
    },
    timeGate: {
      startHourUTC: 12,
      startMinuteUTC: 0,
      endHourUTC: 16,
      endMinuteUTC: 59,
      endSecondUTC: 59,
    },
    telegram: {
      botToken: '8926622863:AAF0QHHYAyEVQZiYV35b5vyeKxDC_ouMnmQ',
      chatId: '7040023207',
      maxRetries: 3,
      baseRetryMs: 2000,
    },
    kelly: {
      equityBaseline: 5000,
      floorRisk: 17.5,
      ceilingRisk: 70.0,
      coldStartRisk: 35.0,
      windowSize: 20,
      drawdownThresholdStart: 0.05,
      drawdownThresholdMax: 0.1,
      varianceMultiplierThreshold: 1.5,
      varianceReductionFactor: 0.25,
    },
    volume: {
      smaPeriod: 20,
      expansionTrendCount: 3,
      expansionLookback: 5,
    },
    circuitBreaker: {
      thresholdPips: 300,
      suppressionMinutes: 15,
    },
    slippage: {
      probabilityPercent: 20,
      minPips: 0.5,
      maxPips: 2.5,
    },
    signalStructure: {
      minExpansionCandles: 2,
      minRetracementCandles: 2,
      maxRetracementCandles: 4,
      bodyRatioThreshold: 0.6,
      observationMinCandles: 3,
      observationMaxCandles: 6,
      wickClusterMinCount: 3,
      wickClusterMaxRange: 1.0,
      liquidityPocketMinWidth: 5.0,
      minRewardRisk: 1.5,
    },
    dailySignalTarget: {
      minSignalsPerUtcDay: 1,
      maxSignalsPerUtcDay: 2,
    },
    dashboard: {
      port: 3000,
      maxSignalHistory: 100,
    },
    logging: {
      dbPath: './data/signals.db',
      retentionDays: 90,
      maxRetries: 3,
    },
  };
}

describe('Signal-Only Enforcement Layer', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    clearBlockedAttempts();
    configureAllowedDomains([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('validateStartup', () => {
    it('should pass validation with a clean config and no forbidden env vars', () => {
      const config = createValidConfig();
      const env = { WS_URL: 'ws://localhost:8080' };
      const result = validateStartup(config, env);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail if broker API key detected in env', () => {
      const config = createValidConfig();
      const env = { BROKER_API_KEY: 'some-key' };
      const result = validateStartup(config, env);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('[CRITICAL]');
      expect(result.errors[0]).toContain('BROKER_API_KEY');
    });

    it('should fail if broker API secret detected in env', () => {
      const config = createValidConfig();
      const env = { BROKER_API_SECRET: 'secret' };
      const result = validateStartup(config, env);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('BROKER_API_SECRET');
    });

    it('should fail if trading account ID detected in env', () => {
      const config = createValidConfig();
      const env = { TRADING_ACCOUNT_ID: 'acc-123' };
      const result = validateStartup(config, env);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('TRADING_ACCOUNT_ID');
    });

    it('should fail if order endpoint detected in env', () => {
      const config = createValidConfig();
      const env = { ORDER_ENDPOINT: 'https://broker.com/orders' };
      const result = validateStartup(config, env);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('ORDER_ENDPOINT');
    });

    it('should fail if MT4/MT5/OANDA/IBKR prefixed keys detected in env', () => {
      const config = createValidConfig();

      const mt4Result = validateStartup(config, { MT4_PASSWORD: 'pass' });
      expect(mt4Result.valid).toBe(false);

      const mt5Result = validateStartup(config, { MT5_SERVER: 'server.com' });
      expect(mt5Result.valid).toBe(false);

      const oandaResult = validateStartup(config, {
        OANDA_TOKEN: 'token123',
      });
      expect(oandaResult.valid).toBe(false);

      const ibkrResult = validateStartup(config, { IBKR_API_KEY: 'key' });
      expect(ibkrResult.valid).toBe(false);
    });

    it('should fail if data source URL contains trade execution path', () => {
      const config = createValidConfig();
      config.dataSource.wsUrl = 'ws://broker.com/orders/submit';
      const result = validateStartup(config, {});
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Trade execution endpoint'))).toBe(true);
    });

    it('should log critical errors for each violation', () => {
      const config = createValidConfig();
      const env = { BROKER_API_KEY: 'key', MT5_SERVER: 'server' };
      validateStartup(config, env);
      expect(console.error).toHaveBeenCalled();
    });

    it('should collect multiple errors when multiple violations exist', () => {
      const config = createValidConfig();
      config.dataSource.wsUrl = 'ws://broker.com/trade/execute';
      const env = { BROKER_API_KEY: 'key' };
      const result = validateStartup(config, env);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });

    it('should pass with legitimate env vars only', () => {
      const config = createValidConfig();
      const env = {
        WS_URL: 'ws://localhost:8080',
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_CHAT_ID: '123',
        DASHBOARD_PORT: '3000',
        DB_PATH: './data/signals.db',
        NODE_ENV: 'production',
        PATH: '/usr/bin',
      };
      const result = validateStartup(config, env);
      expect(result.valid).toBe(true);
    });
  });

  describe('blockTradeExecution', () => {
    it('should log a critical error with component name, operation, and timestamp', () => {
      const attempt = blockTradeExecution('TestComponent', 'placeOrder');
      expect(attempt.componentName).toBe('TestComponent');
      expect(attempt.operation).toBe('placeOrder');
      expect(attempt.timestamp).toBeTruthy();
      expect(attempt.message).toContain('[CRITICAL]');
      expect(attempt.message).toContain('TestComponent');
      expect(attempt.message).toContain('placeOrder');
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[CRITICAL]'));
    });

    it('should include a valid ISO 8601 timestamp', () => {
      const attempt = blockTradeExecution('Module', 'executeTrade');
      const date = new Date(attempt.timestamp);
      expect(date.toISOString()).toBe(attempt.timestamp);
    });

    it('should accumulate blocked attempts', () => {
      blockTradeExecution('ComponentA', 'submitOrder');
      blockTradeExecution('ComponentB', 'modifyPosition');
      blockTradeExecution('ComponentC', 'closePosition');

      const attempts = getBlockedAttempts();
      expect(attempts).toHaveLength(3);
      expect(attempts[0].componentName).toBe('ComponentA');
      expect(attempts[1].componentName).toBe('ComponentB');
      expect(attempts[2].componentName).toBe('ComponentC');
    });

    it('should clear blocked attempts when clearBlockedAttempts is called', () => {
      blockTradeExecution('X', 'op');
      expect(getBlockedAttempts()).toHaveLength(1);
      clearBlockedAttempts();
      expect(getBlockedAttempts()).toHaveLength(0);
    });

    it('should include the operation in the message', () => {
      const attempt = blockTradeExecution('TelegramNotifier', 'sendTradeCommand');
      expect(attempt.message).toContain('sendTradeCommand');
    });
  });

  describe('isAllowedOutbound', () => {
    it('should allow Telegram Bot API', () => {
      expect(isAllowedOutbound('https://api.telegram.org/bot123/sendMessage')).toBe(true);
    });

    it('should allow localhost', () => {
      expect(isAllowedOutbound('http://localhost:3000/api/status')).toBe(true);
      expect(isAllowedOutbound('http://127.0.0.1:3000/dashboard')).toBe(true);
    });

    it('should allow forex-factory.com subdomains (economic calendar)', () => {
      expect(isAllowedOutbound('https://www.forex-factory.com/calendar')).toBe(true);
      expect(isAllowedOutbound('https://api.forex-factory.com/events')).toBe(true);
    });

    it('should allow www.forexfactory.com', () => {
      expect(isAllowedOutbound('https://www.forexfactory.com/calendar.php')).toBe(true);
    });

    it('should allow nfs.faireconomy.media (news calendar)', () => {
      expect(isAllowedOutbound('https://nfs.faireconomy.media/ff_calendar.json')).toBe(true);
    });

    it('should allow myfxbook.com subdomains', () => {
      expect(isAllowedOutbound('https://www.myfxbook.com/api/calendar')).toBe(true);
    });

    it('should block broker API endpoints', () => {
      expect(isAllowedOutbound('https://api.oanda.com/v3/accounts')).toBe(false);
      expect(isAllowedOutbound('https://api.ibkr.com/orders')).toBe(false);
      expect(isAllowedOutbound('https://mt4.broker.com/trade')).toBe(false);
    });

    it('should block unknown domains', () => {
      expect(isAllowedOutbound('https://unknown-broker.com/api')).toBe(false);
      expect(isAllowedOutbound('https://trading-platform.io/execute')).toBe(false);
    });

    it('should block invalid URLs', () => {
      expect(isAllowedOutbound('not-a-url')).toBe(false);
      expect(isAllowedOutbound('')).toBe(false);
    });

    it('should allow additional configured domains', () => {
      configureAllowedDomains(['custom-data-feed.com', 'ws.marketdata.io']);
      expect(isAllowedOutbound('https://custom-data-feed.com/stream')).toBe(true);
      expect(isAllowedOutbound('wss://ws.marketdata.io/xauusd')).toBe(true);
    });

    it('should be case-insensitive for domain matching', () => {
      expect(isAllowedOutbound('https://API.TELEGRAM.ORG/bot/send')).toBe(true);
      expect(isAllowedOutbound('https://LOCALHOST:3000')).toBe(true);
    });
  });

  describe('isTradeExecutionEndpoint', () => {
    it('should detect order endpoints', () => {
      expect(isTradeExecutionEndpoint('https://broker.com/orders')).toBe(true);
      expect(isTradeExecutionEndpoint('https://broker.com/order/submit')).toBe(true);
    });

    it('should detect trade endpoints', () => {
      expect(isTradeExecutionEndpoint('https://broker.com/trade')).toBe(true);
      expect(isTradeExecutionEndpoint('https://broker.com/v3/trade/execute')).toBe(true);
    });

    it('should detect execute endpoints', () => {
      expect(isTradeExecutionEndpoint('https://broker.com/execute')).toBe(true);
    });

    it('should detect position management endpoints', () => {
      expect(isTradeExecutionEndpoint('https://broker.com/positions')).toBe(true);
      expect(isTradeExecutionEndpoint('https://broker.com/position/close')).toBe(true);
    });

    it('should detect modify/cancel endpoints', () => {
      expect(isTradeExecutionEndpoint('https://broker.com/modify')).toBe(true);
      expect(isTradeExecutionEndpoint('https://broker.com/cancel')).toBe(true);
    });

    it('should not flag safe endpoints', () => {
      expect(isTradeExecutionEndpoint('https://api.telegram.org/bot/sendMessage')).toBe(false);
      expect(isTradeExecutionEndpoint('https://data.feed.com/candles')).toBe(false);
      expect(isTradeExecutionEndpoint('http://localhost:3000/dashboard')).toBe(false);
    });

    it('should return false for invalid URLs', () => {
      expect(isTradeExecutionEndpoint('not-a-url')).toBe(false);
    });
  });

  describe('enforceSignalOnlyStartup', () => {
    it('should not throw for valid configuration', () => {
      const config = createValidConfig();
      expect(() => enforceSignalOnlyStartup(config, {})).not.toThrow();
    });

    it('should throw if broker credentials detected', () => {
      const config = createValidConfig();
      const env = { BROKER_API_KEY: 'key123' };
      expect(() => enforceSignalOnlyStartup(config, env)).toThrow(/Signal-only enforcement failed/);
    });

    it('should throw if trade endpoint detected in data source URL', () => {
      const config = createValidConfig();
      config.dataSource.wsUrl = 'ws://broker.com/orders/stream';
      expect(() => enforceSignalOnlyStartup(config, {})).toThrow(/Signal-only enforcement failed/);
    });

    it('should configure allowed domains from data source wsUrl on success', () => {
      const config = createValidConfig();
      config.dataSource.wsUrl = 'ws://custom-feed.example.com:8080/stream';
      enforceSignalOnlyStartup(config, {});
      // After enforcement, the data source domain should be allowed
      expect(isAllowedOutbound('https://custom-feed.example.com/data')).toBe(true);
    });

    it('should throw with all error messages combined', () => {
      const config = createValidConfig();
      config.dataSource.wsUrl = 'ws://broker.com/trade';
      const env = { BROKER_API_KEY: 'key', MT5_SERVER: 'srv' };
      try {
        enforceSignalOnlyStartup(config, env);
        expect.fail('Should have thrown');
      } catch (error) {
        const msg = (error as Error).message;
        expect(msg).toContain('Signal-only enforcement failed');
        expect(msg).toContain('BROKER_API_KEY');
      }
    });
  });
});
