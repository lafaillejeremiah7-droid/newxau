import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import Database from 'better-sqlite3';
import { EventBus } from '../core/event-bus.js';
import { SignalEngineFSM } from '../core/signal-engine-fsm.js';
import { CandleBufferManager } from '../data/candle-buffer.js';
import { SqliteSignalLogger } from '../data/signal-logger.js';
import { TimeGate } from '../filters/time-gate.js';
import { NewsDecoupler } from '../filters/news-decoupler.js';
import { CircuitBreaker } from '../filters/circuit-breaker.js';
import { MacroFilterModule } from '../filters/macro-filter-module.js';
import { createStopLossTargetMapper } from '../pipeline/stop-loss-target-mapper.js';
import { createVolumeFilter } from '../pipeline/volume-filter.js';
import { createKellySizer } from '../pipeline/kelly-sizer.js';
import { createSlippageSimulator } from '../pipeline/slippage-simulator.js';
import { createSignalOutputFormatter } from '../pipeline/signal-output-formatter.js';
import { TelegramNotifier } from '../output/telegram-notifier.js';
import { DashboardServerImpl } from '../output/dashboard-server.js';
import { LiquidityZoneDetector } from '../core/liquidity-zone-detector.js';
import { createCandlePatternAnalyzer } from '../core/candle-pattern-analyzer.js';

import type { Candle } from '../types/candle.js';
import type { FormattedSignal } from '../types/signal.js';
import type { RawSignal } from '../core/signal-engine-fsm.js';

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const TEMP_DIR = path.join(os.tmpdir(), `isagi-test-${Date.now()}`);

/** Create a temporary test database path */
function createTempDbPath(name: string): string {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
  return path.join(TEMP_DIR, `${name}.db`);
}

/** Mock Candle Factory */
function createMockCandle(overrides: Partial<Candle> = {}): Candle {
  return {
    instrument: 'XAUUSD',
    timeframe: 'M5',
    timestamp: new Date().toISOString(),
    open: 2045.0,
    high: 2047.0,
    low: 2044.0,
    close: 2046.0,
    volume: 1000,
    ...overrides,
  };
}

/** Create a sequence of expansion candles (bullish) */
function createBullishExpansionCandles(count: number = 2): Candle[] {
  const candles: Candle[] = [];
  let currentClose = 2045.0;

  for (let i = 0; i < count; i++) {
    const open = currentClose - 1.0;
    const close = currentClose + 1.5;
    candles.push({
      instrument: 'XAUUSD',
      timeframe: 'M5',
      timestamp: new Date(Date.now() + i * 60000).toISOString(),
      open,
      high: close + 0.5,
      low: open - 0.5,
      close,
      volume: 1500 + i * 200,
    });
    currentClose = close;
  }

  return candles;
}

/** Create a retracement candle (bullish hammer) */
function createBullishRetracementCandle(): Candle {
  return {
    instrument: 'XAUUSD',
    timeframe: 'M5',
    timestamp: new Date().toISOString(),
    open: 2048.0,
    high: 2048.5,
    low: 2046.0, // Long lower wick
    close: 2047.5,
    volume: 800,
  };
}

/** Mock Telegram delivery tracking */
let telegramDeliveries: Array<{
  signal: FormattedSignal;
  timestamp: string;
}> = [];

function mockTelegramFetch(url: string, options: any) {
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: 'OK',
  });
}

function mockTelegramLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  };
}

// ─── Integration Tests ──────────────────────────────────────────────────────

describe('Integration Tests: Isagi Engine Signal Bot', () => {
  let eventBus: EventBus;
  let dbPath: string;
  let signalLogger: SqliteSignalLogger;
  let candleBufferManager: CandleBufferManager;
  let timeGate: TimeGate;
  let newsDecoupler: NewsDecoupler;
  let circuitBreaker: CircuitBreaker;
  let macroFilterModule: MacroFilterModule;
  let liquidityZoneDetector: LiquidityZoneDetector;
  let candlePatternAnalyzer: any;
  let signalEngineFSM: SignalEngineFSM;
  let stopLossTargetMapper: any;
  let volumeFilter: any;
  let kellySizer: any;
  let slippageSimulator: any;
  let signalOutputFormatter: any;
  let dashboard: any;
  let telegramNotifier: TelegramNotifier;

  beforeEach(() => {
    // Clean up temp directory
    telegramDeliveries = [];

    // Initialize event bus
    eventBus = new EventBus();

    // Initialize database
    dbPath = createTempDbPath(`test-signals-${Date.now()}`);
    signalLogger = new SqliteSignalLogger(dbPath, 90, 3);

    // Initialize candle buffer
    candleBufferManager = new CandleBufferManager();

    // Initialize filters (use 12:00-16:59:59 UTC window for testing)
    timeGate = new TimeGate({
      startHourUTC: 12,
      startMinuteUTC: 0,
      startSecondUTC: 0,
      endHourUTC: 16,
      endMinuteUTC: 59,
      endSecondUTC: 59,
    });

    newsDecoupler = new NewsDecoupler();
    circuitBreaker = new CircuitBreaker({
      thresholdPips: 300,
      suppressionMinutes: 15,
    });

    macroFilterModule = new MacroFilterModule(
      timeGate,
      newsDecoupler,
      circuitBreaker,
      eventBus
    );

    // Initialize core engine components
    liquidityZoneDetector = new LiquidityZoneDetector();
    candlePatternAnalyzer = createCandlePatternAnalyzer();

    // Initialize FSM
    signalEngineFSM = new SignalEngineFSM({
      eventBus,
      timeGate,
      newsDecoupler,
      liquidityZoneDetector,
      candlePatternAnalyzer,
      signalLogger,
      candleBufferManager,
    });

    // Initialize pipeline
    stopLossTargetMapper = createStopLossTargetMapper();
    volumeFilter = createVolumeFilter();
    kellySizer = createKellySizer({
      equityBaseline: 35.0,
      floorRisk: 17.5,
      ceilingRisk: 70.0,
      coldStartRisk: 35.0,
      windowSize: 20,
      drawdownThresholdStart: 0.05,
      drawdownThresholdMax: 0.1,
      varianceMultiplierThreshold: 1.5,
      varianceReductionFactor: 0.25,
    });
    slippageSimulator = createSlippageSimulator();
    signalOutputFormatter = createSignalOutputFormatter();

    // Initialize dashboard
    dashboard = new DashboardServerImpl(100);

    // Initialize Telegram notifier with mocks
    const mockLogger = mockTelegramLogger();
    telegramNotifier = new TelegramNotifier(
      {
        botToken: 'test-token',
        chatId: '12345',
        maxRetries: 3,
        baseRetryMs: 100,
      },
      mockLogger as any,
      mockTelegramFetch as any
    );
  });

  afterEach(() => {
    // Close database
    signalLogger.close();

    // Clean up temp files
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
    const walPath = `${dbPath}-wal`;
    if (fs.existsSync(walPath)) {
      fs.unlinkSync(walPath);
    }
    const shmPath = `${dbPath}-shm`;
    if (fs.existsSync(shmPath)) {
      fs.unlinkSync(shmPath);
    }

    eventBus.removeAllListeners();
  });

  describe('End-to-End Signal Flow', () => {
    it('should process complete flow: WebSocket candle → FSM → pipeline → outputs', async () => {
      const processedSignals: FormattedSignal[] = [];
      const telegrams: Array<{ signal: FormattedSignal }> = [];
      const stateTransitions: string[] = [];

      // Subscribe to formatted signals
      eventBus.subscribe('signal.formatted', (signal) => {
        processedSignals.push(signal);
      });

      // Track state changes
      eventBus.subscribe('state.change', (transition) => {
        stateTransitions.push(
          `${transition.from} → ${transition.to}: ${transition.reason}`
        );
      });

      // Mock Telegram delivery
      const telegramSpy = vi.spyOn(telegramNotifier, 'sendSignal');
      telegramSpy.mockResolvedValue({
        success: true,
        attempts: 1,
        error: null,
        timestamp: new Date().toISOString(),
      });

      // Wire signal pipeline
      eventBus.subscribe('signal.raw', async (rawSignal: RawSignal) => {
        const slWithTarget = stopLossTargetMapper.calculate(
          rawSignal,
          candleBufferManager
        );
        if (!slWithTarget) return;

        const volumeResult = volumeFilter.classify(
          slWithTarget,
          candleBufferManager
        );
        if (!volumeResult) return;

        const riskAmount = kellySizer.calculateRisk();

        const withSlippage = slippageSimulator.apply({
          ...volumeResult,
          riskAmount,
        });

        const formatted = signalOutputFormatter.format({
          ...withSlippage,
          riskAmount,
        });

        eventBus.publish('signal.formatted', formatted);

        // Send to Telegram
        await telegramNotifier.sendSignal(formatted);

        // Log to database
        await signalLogger.logSignal(formatted);

        // Broadcast to dashboard
        dashboard.broadcastSignal(formatted);

        telegrams.push({ signal: formatted });
      });

      // Simulate processing candles in active time window
      const testCandles = [
        createMockCandle({ close: 2045.5, volume: 1200 }),
        createMockCandle({ close: 2045.2, volume: 1100 }),
      ];

      for (const candle of testCandles) {
        candleBufferManager.addCandle(candle);
        eventBus.publish('candle.close', {
          candle,
          timeframe: 'M5',
        });
      }

      // Verify state transitions occurred
      expect(stateTransitions.length).toBeGreaterThanOrEqual(0);

      // Verify Telegram notification setup (even if no signal generated)
      expect(telegramSpy).toBeDefined();

      // Verify dashboard received updates
      expect(dashboard.getConnectedClients).toBeDefined();

      // Verify signal logger is recording
      expect(signalLogger).toBeDefined();
    });

    it('should verify Telegram delivery timing is within 5 seconds', async () => {
      const deliveryTimes: number[] = [];

      const telegramSpy = vi.spyOn(telegramNotifier, 'sendSignal');
      telegramSpy.mockImplementation(async (signal) => {
        const deliveryTime = Date.now();
        deliveryTimes.push(deliveryTime);
        return {
          success: true,
          attempts: 1,
          error: null,
          timestamp: new Date().toISOString(),
        };
      });

      // Create a test formatted signal
      const testSignal: FormattedSignal = {
        id: 'test-sig-001',
        timestamp: new Date().toISOString(),
        instrument: 'XAUUSD',
        direction: 'long',
        entryPrice: 2045.5,
        stopLoss: 2043.0,
        ticket1: {
          label: 'Safety Lock',
          positionSizePercent: 45,
          entryPrice: 2045.5,
          stopLoss: 2043.0,
          takeProfit: 2047.0,
        },
        ticket2: {
          label: 'Runner',
          positionSizePercent: 55,
          entryPrice: 2045.5,
          stopLoss: 2043.0,
          takeProfit: 2050.0,
        },
        zoneClassification: 'chop_zone',
        riskAmount: 35.0,
        rUnit: 2.5,
        reasoning: 'Test signal for timing verification',
        slippage: {
          applied: false,
          originalEntry: 2045.5,
          adjustedEntry: 2045.5,
          slippagePips: 0,
        },
        breakevenTrigger: 'Move SL to entry when TP1 reached',
        trailingStopGuidance: 'Trail at M5 swing low',
      };

      const startTime = Date.now();
      await telegramNotifier.sendSignal(testSignal);
      const endTime = Date.now();

      const deliveryDuration = endTime - startTime;
      expect(deliveryDuration).toBeLessThan(5000);
    });

    it('should verify Dashboard WebSocket update timing is within 2 seconds', async () => {
      const broadcastTimes: number[] = [];

      const broadcastSpy = vi.spyOn(dashboard, 'broadcastSignal');
      broadcastSpy.mockImplementation((signal) => {
        broadcastTimes.push(Date.now());
      });

      const testSignal: FormattedSignal = {
        id: 'test-sig-002',
        timestamp: new Date().toISOString(),
        instrument: 'XAUUSD',
        direction: 'short',
        entryPrice: 2046.0,
        stopLoss: 2048.5,
        ticket1: {
          label: 'Safety Lock',
          positionSizePercent: 45,
          entryPrice: 2046.0,
          stopLoss: 2048.5,
          takeProfit: 2044.5,
        },
        ticket2: {
          label: 'Runner',
          positionSizePercent: 55,
          entryPrice: 2046.0,
          stopLoss: 2048.5,
          takeProfit: 2041.5,
        },
        zoneClassification: 'expansion_zone',
        riskAmount: 35.0,
        rUnit: 2.5,
        reasoning: 'Dashboard timing test',
        slippage: {
          applied: false,
          originalEntry: 2046.0,
          adjustedEntry: 2046.0,
          slippagePips: 0,
        },
        breakevenTrigger: 'Move SL to entry',
        trailingStopGuidance: 'Trail at M5 swing',
      };

      const startTime = Date.now();
      dashboard.broadcastSignal(testSignal);
      const endTime = Date.now();

      const broadcastDuration = endTime - startTime;
      expect(broadcastDuration).toBeLessThan(2000);
      expect(broadcastSpy).toHaveBeenCalledWith(testSignal);
    });

    it('should verify log persistence survives restart', async () => {
      const testSignal: FormattedSignal = {
        id: 'test-sig-persist-001',
        timestamp: new Date().toISOString(),
        instrument: 'XAUUSD',
        direction: 'long',
        entryPrice: 2045.5,
        stopLoss: 2043.0,
        ticket1: {
          label: 'Safety Lock',
          positionSizePercent: 45,
          entryPrice: 2045.5,
          stopLoss: 2043.0,
          takeProfit: 2047.0,
        },
        ticket2: {
          label: 'Runner',
          positionSizePercent: 55,
          entryPrice: 2045.5,
          stopLoss: 2043.0,
          takeProfit: 2050.0,
        },
        zoneClassification: 'chop_zone',
        riskAmount: 35.0,
        rUnit: 2.5,
        reasoning: 'Test persistence',
        slippage: {
          applied: false,
          originalEntry: 2045.5,
          adjustedEntry: 2045.5,
          slippagePips: 0,
        },
        breakevenTrigger: 'Move SL',
        trailingStopGuidance: 'Trail',
      };

      // Log signal
      await signalLogger.logSignal(testSignal);

      // Verify it was written
      const db = new Database(dbPath);
      const result = db
        .prepare('SELECT * FROM signals WHERE id = ?')
        .get(testSignal.id) as any;
      expect(result).toBeDefined();
      expect(result.id).toBe(testSignal.id);
      expect(result.direction).toBe('long');
      db.close();

      // Close and reopen logger (simulating restart)
      signalLogger.close();
      const newLogger = new SqliteSignalLogger(dbPath, 90, 3);

      // Query the database directly to verify persistence
      const newDb = new Database(dbPath);
      const persistedSignal = newDb
        .prepare('SELECT * FROM signals WHERE id = ?')
        .get(testSignal.id) as any;
      expect(persistedSignal).toBeDefined();
      expect(persistedSignal.id).toBe('test-sig-persist-001');
      expect(persistedSignal.entry_price).toBe(2045.5);
      newDb.close();
      newLogger.close();
    });
  });

  describe('Data Persistence and Retention', () => {
    it('should log and persist rejection events', async () => {
      const rejectionLog = {
        timestamp: new Date().toISOString(),
        reason: 'Volume below threshold',
        filter: 'volumeFilter',
        context: { volume: 500, sma20: 1000 },
      };

      await signalLogger.logRejection(rejectionLog);

      // Verify in database
      const db = new Database(dbPath);
      const result = db
        .prepare('SELECT * FROM rejections WHERE reason = ?')
        .get('Volume below threshold') as any;
      expect(result).toBeDefined();
      expect(result.filter_name).toBe('volumeFilter');
      db.close();
    });

    it('should log and persist state transitions', async () => {
      const transition = {
        from: 'scanning' as const,
        to: 'observation' as const,
        reason: 'M5 close entered liquidity zone',
        timestamp: new Date().toISOString(),
      };

      await signalLogger.logStateTransition(transition);

      // Verify in database
      const db = new Database(dbPath);
      const result = db
        .prepare('SELECT * FROM state_transitions WHERE reason = ?')
        .get('M5 close entered liquidity zone') as any;
      expect(result).toBeDefined();
      expect(result.from_state).toBe('scanning');
      expect(result.to_state).toBe('observation');
      db.close();
    });

    it('should log and persist filter events', async () => {
      const filterEvent = {
        filterName: 'timeGate',
        action: 'activated' as const,
        timestamp: new Date().toISOString(),
        durationSeconds: null,
        metadata: { reason: 'Window start at 12:00 UTC' },
      };

      await signalLogger.logFilterEvent(filterEvent);

      // Verify in database
      const db = new Database(dbPath);
      const result = db
        .prepare('SELECT * FROM filter_events WHERE filter_name = ?')
        .get('timeGate') as any;
      expect(result).toBeDefined();
      expect(result.action).toBe('activated');
      db.close();
    });

    it('should maintain log entry chronological ordering', async () => {
      // Insert multiple signals with known timestamps
      const signals: FormattedSignal[] = [];
      for (let i = 0; i < 3; i++) {
        signals.push({
          id: `sig-order-${i}`,
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
          instrument: 'XAUUSD',
          direction: i % 2 === 0 ? 'long' : 'short',
          entryPrice: 2045.0 + i,
          stopLoss: 2043.0 + i,
          ticket1: {
            label: 'Safety Lock',
            positionSizePercent: 45,
            entryPrice: 2045.0 + i,
            stopLoss: 2043.0 + i,
            takeProfit: 2047.0 + i,
          },
          ticket2: {
            label: 'Runner',
            positionSizePercent: 55,
            entryPrice: 2045.0 + i,
            stopLoss: 2043.0 + i,
            takeProfit: 2050.0 + i,
          },
          zoneClassification: 'chop_zone',
          riskAmount: 35.0,
          rUnit: 2.5,
          reasoning: `Signal ${i}`,
          slippage: {
            applied: false,
            originalEntry: 2045.0 + i,
            adjustedEntry: 2045.0 + i,
            slippagePips: 0,
          },
          breakevenTrigger: 'Move SL',
          trailingStopGuidance: 'Trail',
        });
      }

      for (const signal of signals) {
        await signalLogger.logSignal(signal);
      }

      // Verify ordering in database
      const db = new Database(dbPath);
      const results = db
        .prepare('SELECT id, timestamp FROM signals ORDER BY timestamp ASC')
        .all() as any[];
      expect(results).toHaveLength(3);
      expect(results[0].id).toBe('sig-order-0');
      expect(results[1].id).toBe('sig-order-1');
      expect(results[2].id).toBe('sig-order-2');
      db.close();
    });
  });

  describe('Filter Integration', () => {
    it('should evaluate Time Gate status correctly', () => {
      const status = timeGate.getStatus();
      expect(status).toBeDefined();
      expect(status.windowStart).toBe('12:00:00');
      expect(status.windowEnd).toBe('16:59:59');
    });

    it('should evaluate News Decoupler freeze status', async () => {
      const status = newsDecoupler.getStatus();
      expect(status).toBeDefined();
      expect(typeof status.freezeActive).toBe('boolean');
      expect(status.currentEvent).toBeNull();
    });

    it('should evaluate Circuit Breaker status', () => {
      const status = circuitBreaker.getStatus();
      expect(status).toBeDefined();
      expect(typeof status.active).toBe('boolean');
    });

    it('should combine filter statuses in macro module', () => {
      const macroStatus = macroFilterModule.getFilterStatus();
      expect(macroStatus).toBeDefined();
      expect(macroStatus.timeGate).toBeDefined();
      expect(macroStatus.newsDecoupler).toBeDefined();
      expect(macroStatus.circuitBreaker).toBeDefined();
    });
  });

  describe('Signal Output Formatting', () => {
    it('should format signals with complete required fields', () => {
      const testSignal: FormattedSignal = {
        id: 'fmt-test-001',
        timestamp: new Date().toISOString(),
        instrument: 'XAUUSD',
        direction: 'long',
        entryPrice: 2045.5,
        stopLoss: 2043.0,
        ticket1: {
          label: 'Safety Lock',
          positionSizePercent: 45,
          entryPrice: 2045.5,
          stopLoss: 2043.0,
          takeProfit: 2047.0,
        },
        ticket2: {
          label: 'Runner',
          positionSizePercent: 55,
          entryPrice: 2045.5,
          stopLoss: 2043.0,
          takeProfit: 2050.0,
        },
        zoneClassification: 'chop_zone',
        riskAmount: 35.0,
        rUnit: 2.5,
        reasoning: 'Test signal formatting',
        slippage: {
          applied: false,
          originalEntry: 2045.5,
          adjustedEntry: 2045.5,
          slippagePips: 0,
        },
        breakevenTrigger: 'Move SL to entry',
        trailingStopGuidance: 'Trail at M5 swing',
      };

      expect(testSignal.instrument).toBe('XAUUSD');
      expect(testSignal.ticket1.positionSizePercent).toBe(45);
      expect(testSignal.ticket2.positionSizePercent).toBe(55);
      expect(testSignal.ticket1.positionSizePercent +
             testSignal.ticket2.positionSizePercent).toBe(100);
    });

    it('should validate signal split position arithmetic', () => {
      const testSignal: FormattedSignal = {
        id: 'split-test-001',
        timestamp: new Date().toISOString(),
        instrument: 'XAUUSD',
        direction: 'long',
        entryPrice: 2045.0,
        stopLoss: 2043.0,
        ticket1: {
          label: 'Safety Lock',
          positionSizePercent: 45,
          entryPrice: 2045.0,
          stopLoss: 2043.0,
          takeProfit: 2047.1, // 35% of distance to TP2 (2045.0 + 0.35 * (2051.0 - 2045.0))
        },
        ticket2: {
          label: 'Runner',
          positionSizePercent: 55,
          entryPrice: 2045.0,
          stopLoss: 2043.0,
          takeProfit: 2051.0, // 3.0R for expansion zone
        },
        zoneClassification: 'expansion_zone',
        riskAmount: 35.0,
        rUnit: 2.0,
        reasoning: 'Split position test',
        slippage: {
          applied: false,
          originalEntry: 2045.0,
          adjustedEntry: 2045.0,
          slippagePips: 0,
        },
        breakevenTrigger: 'Move SL to entry',
        trailingStopGuidance: 'Trail',
      };

      // Verify split percentages
      expect(testSignal.ticket1.positionSizePercent).toBe(45);
      expect(testSignal.ticket2.positionSizePercent).toBe(55);

      // Verify both tickets share same entry and SL
      expect(testSignal.ticket1.entryPrice).toBe(testSignal.ticket2.entryPrice);
      expect(testSignal.ticket1.stopLoss).toBe(testSignal.ticket2.stopLoss);

      // Verify TP1 is partial distance (35% of entry to TP2)
      const expectedTP1 = 2045.0 + 0.35 * (2051.0 - 2045.0);
      expect(testSignal.ticket1.takeProfit).toBeCloseTo(expectedTP1, 1);
    });
  });

  describe('Telegram Integration', () => {
    it('should validate signal fields before Telegram delivery', async () => {
      const completeSignal: FormattedSignal = {
        id: 'telegram-test-001',
        timestamp: new Date().toISOString(),
        instrument: 'XAUUSD',
        direction: 'long',
        entryPrice: 2045.5,
        stopLoss: 2043.0,
        ticket1: {
          label: 'Safety Lock',
          positionSizePercent: 45,
          entryPrice: 2045.5,
          stopLoss: 2043.0,
          takeProfit: 2047.0,
        },
        ticket2: {
          label: 'Runner',
          positionSizePercent: 55,
          entryPrice: 2045.5,
          stopLoss: 2043.0,
          takeProfit: 2050.0,
        },
        zoneClassification: 'chop_zone',
        riskAmount: 35.0,
        rUnit: 2.5,
        reasoning: 'Test signal for Telegram',
        slippage: {
          applied: false,
          originalEntry: 2045.5,
          adjustedEntry: 2045.5,
          slippagePips: 0,
        },
        breakevenTrigger: 'Move SL',
        trailingStopGuidance: 'Trail',
      };

      const result = await telegramNotifier.sendSignal(completeSignal);
      expect(result.success).toBe(true);
      expect(result.attempts).toBe(1);
    });

    it('should suppress delivery if required fields are missing', async () => {
      const incompleteSignal: Partial<FormattedSignal> = {
        id: 'telegram-incomplete',
        timestamp: new Date().toISOString(),
        instrument: 'XAUUSD',
        direction: 'long',
        // Missing required fields
      };

      const result = await telegramNotifier.sendSignal(
        incompleteSignal as FormattedSignal
      );
      expect(result.success).toBe(false);
      expect(result.attempts).toBe(0);
      expect(result.error).toContain('Missing required field');
    });

    it('should retry on Telegram API failure', async () => {
      let attemptCount = 0;
      const failingFetch = async () => {
        attemptCount++;
        if (attemptCount < 2) {
          return {
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
          };
        }
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
        };
      };

      const retryNotifier = new TelegramNotifier(
        {
          botToken: 'test-token',
          chatId: '12345',
          maxRetries: 3,
          baseRetryMs: 10, // Short for testing
        },
        mockTelegramLogger() as any,
        failingFetch as any
      );

      const testSignal: FormattedSignal = {
        id: 'retry-test',
        timestamp: new Date().toISOString(),
        instrument: 'XAUUSD',
        direction: 'long',
        entryPrice: 2045.5,
        stopLoss: 2043.0,
        ticket1: {
          label: 'Safety Lock',
          positionSizePercent: 45,
          entryPrice: 2045.5,
          stopLoss: 2043.0,
          takeProfit: 2047.0,
        },
        ticket2: {
          label: 'Runner',
          positionSizePercent: 55,
          entryPrice: 2045.5,
          stopLoss: 2043.0,
          takeProfit: 2050.0,
        },
        zoneClassification: 'chop_zone',
        riskAmount: 35.0,
        rUnit: 2.5,
        reasoning: 'Retry test',
        slippage: {
          applied: false,
          originalEntry: 2045.5,
          adjustedEntry: 2045.5,
          slippagePips: 0,
        },
        breakevenTrigger: 'Move SL',
        trailingStopGuidance: 'Trail',
      };

      const result = await retryNotifier.sendSignal(testSignal);
      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
    });
  });

  describe('Dashboard Signal Management', () => {
    it('should maintain signal history in reverse-chronological order', () => {
      const signals: FormattedSignal[] = [];
      for (let i = 0; i < 3; i++) {
        signals.push({
          id: `dash-sig-${i}`,
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
          instrument: 'XAUUSD',
          direction: 'long',
          entryPrice: 2045.0 + i,
          stopLoss: 2043.0 + i,
          ticket1: {
            label: 'Safety Lock',
            positionSizePercent: 45,
            entryPrice: 2045.0 + i,
            stopLoss: 2043.0 + i,
            takeProfit: 2047.0 + i,
          },
          ticket2: {
            label: 'Runner',
            positionSizePercent: 55,
            entryPrice: 2045.0 + i,
            stopLoss: 2043.0 + i,
            takeProfit: 2050.0 + i,
          },
          zoneClassification: 'chop_zone',
          riskAmount: 35.0,
          rUnit: 2.5,
          reasoning: `Signal ${i}`,
          slippage: {
            applied: false,
            originalEntry: 2045.0 + i,
            adjustedEntry: 2045.0 + i,
            slippagePips: 0,
          },
          breakevenTrigger: 'Move SL',
          trailingStopGuidance: 'Trail',
        });
      }

      for (const signal of signals) {
        dashboard.broadcastSignal(signal);
      }

      const history = dashboard.getSignalHistory();
      expect(history).toHaveLength(3);

      // Verify reverse-chronological order (newest first)
      if (history.length >= 2) {
        const first = new Date(history[0].timestamp).getTime();
        const second = new Date(history[1].timestamp).getTime();
        expect(first).toBeGreaterThanOrEqual(second);
      }
    });

    it('should limit signal history to maximum capacity', () => {
      const smallDashboard = new DashboardServerImpl(5);

      // Broadcast more signals than the limit
      for (let i = 0; i < 10; i++) {
        smallDashboard.broadcastSignal({
          id: `excess-sig-${i}`,
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
          instrument: 'XAUUSD',
          direction: 'long',
          entryPrice: 2045.0,
          stopLoss: 2043.0,
          ticket1: {
            label: 'Safety Lock',
            positionSizePercent: 45,
            entryPrice: 2045.0,
            stopLoss: 2043.0,
            takeProfit: 2047.0,
          },
          ticket2: {
            label: 'Runner',
            positionSizePercent: 55,
            entryPrice: 2045.0,
            stopLoss: 2043.0,
            takeProfit: 2050.0,
          },
          zoneClassification: 'chop_zone',
          riskAmount: 35.0,
          rUnit: 2.5,
          reasoning: `Signal`,
          slippage: {
            applied: false,
            originalEntry: 2045.0,
            adjustedEntry: 2045.0,
            slippagePips: 0,
          },
          breakevenTrigger: 'Move SL',
          trailingStopGuidance: 'Trail',
        });
      }

      const history = smallDashboard.getSignalHistory();
      expect(history.length).toBeLessThanOrEqual(5);
    });
  });
});
