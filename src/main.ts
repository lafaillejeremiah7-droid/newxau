/**
 * Isagi Engine Signal Bot - Application Entry Point (main.ts)
 *
 * Wires all components together:
 * 1. Loads config via loadConfig()
 * 2. Runs enforceSignalOnlyStartup(config)
 * 3. Initializes all components with proper dependencies
 * 4. Wires the event flow:
 *    - candle.close → CandleBufferManager.addCandle() + FSM.processCandle()
 *    - signal.raw → Pipeline → signal.formatted → Telegram + Dashboard + Logger
 *    - M1 candles → CircuitBreaker via MacroFilterModule
 *    - filter.change → Dashboard.broadcastFilterStatus()
 *    - state.change → Dashboard.broadcastStateChange()
 * 5. Starts Dashboard server
 * 6. Connects WebSocket data feed
 * 7. Handles SIGINT/SIGTERM for graceful shutdown
 *
 * Requirements: 1.1, 5, 6.3, 6.5, 8.9, 9, 10, 11, 12.1, 13.4, 14.1, 15.6, 16.1, 16.4
 */

import { loadConfig } from './config/loader.js';
import { enforceSignalOnlyStartup } from './core/signal-only-enforcement.js';
import { EventBus } from './core/event-bus.js';
import { SignalEngineFSM } from './core/signal-engine-fsm.js';
import { CandleIngestion } from './data/candle-ingestion.js';
import { CandleBufferManager } from './data/candle-buffer.js';
import { SqliteSignalLogger } from './data/signal-logger.js';
import { TimeGate } from './filters/time-gate.js';
import { NewsDecoupler } from './filters/news-decoupler.js';
import { CircuitBreaker } from './filters/circuit-breaker.js';
import { MacroFilterModule } from './filters/macro-filter-module.js';
import { createStopLossTargetMapper } from './pipeline/stop-loss-target-mapper.js';
import { createVolumeFilter } from './pipeline/volume-filter.js';
import { createKellySizer } from './pipeline/kelly-sizer.js';
import { createSlippageSimulator } from './pipeline/slippage-simulator.js';
import { createSignalOutputFormatter } from './pipeline/signal-output-formatter.js';
import { TelegramNotifier } from './output/telegram-notifier.js';
import { createDashboardServer } from './output/dashboard-server.js';
import { LiquidityZoneDetector } from './core/liquidity-zone-detector.js';
import { createCandlePatternAnalyzer } from './core/candle-pattern-analyzer.js';
import { DailySignalTargetTracker } from './monitoring/daily-signal-target.js';

import type { RawSignal } from './core/signal-engine-fsm.js';
import type { Candle } from './types/candle.js';
import type { FormattedSignal } from './types/signal.js';
import type { SignalResult } from './pipeline/kelly-sizer.js';

// ─── Application State ───────────────────────────────────────────────────────

let isShuttingDown = false;

/** Signal history for Kelly Sizer (last 20 signals) */
const signalHistory: SignalResult[] = [];

/** Most recent signal direction and ID for circuit breaker */
let lastSignalDirection: 'long' | 'short' | null = null;
let lastSignalId: string | null = null;

// ─── Main Bootstrap ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('[Isagi Engine] Starting Signal Bot...');

  // ─── Step 1: Load configuration ─────────────────────────────────────────────
  let config;
  try {
    config = loadConfig();
    console.log('[Isagi Engine] Configuration loaded successfully.');
  } catch (err) {
    console.error('[Isagi Engine] CRITICAL: Failed to load configuration.', err);
    process.exit(1);
  }

  // ─── Step 2: Signal-only enforcement (broker check) ─────────────────────────
  try {
    enforceSignalOnlyStartup(config);
    console.log('[Isagi Engine] Signal-only enforcement passed.');
  } catch (err) {
    console.error('[Isagi Engine] CRITICAL: Signal-only enforcement failed.', err);
    process.exit(1);
  }

  // ─── Step 3: Initialize all components ──────────────────────────────────────

  // Event Bus
  const eventBus = new EventBus();

  // Signal Logger (SQLite)
  let signalLogger: SqliteSignalLogger;
  try {
    signalLogger = new SqliteSignalLogger(
      config.logging.dbPath,
      config.logging.retentionDays,
      config.logging.maxRetries,
    );
    console.log('[Isagi Engine] Signal Logger initialized.');
  } catch (err) {
    console.error('[Isagi Engine] CRITICAL: Failed to initialize Signal Logger.', err);
    process.exit(1);
  }

  // Candle Buffer Manager
  const candleBufferManager = new CandleBufferManager();

  // Soft daily signal target tracker. This observes qualified signals only;
  // it never creates, suppresses, or changes a signal.
  const dailySignalTargetTracker = new DailySignalTargetTracker(config.dailySignalTarget);
  console.log(
    `[Daily Signal Target] Soft UTC-day target: ${config.dailySignalTarget.minSignalsPerUtcDay}-${config.dailySignalTarget.maxSignalsPerUtcDay} qualified signals.`,
  );

  // Filters
  const timeGate = new TimeGate({
    startHourUTC: config.timeGate.startHourUTC,
    startMinuteUTC: config.timeGate.startMinuteUTC,
    startSecondUTC: 0,
    endHourUTC: config.timeGate.endHourUTC,
    endMinuteUTC: config.timeGate.endMinuteUTC,
    endSecondUTC: config.timeGate.endSecondUTC,
  });

  const newsDecoupler = new NewsDecoupler();

  const circuitBreaker = new CircuitBreaker({
    thresholdPips: config.circuitBreaker.thresholdPips,
    suppressionMinutes: config.circuitBreaker.suppressionMinutes,
  });

  const macroFilterModule = new MacroFilterModule(
    timeGate,
    newsDecoupler,
    circuitBreaker,
    eventBus,
  );

  // Core Engine Components
  const liquidityZoneDetector = new LiquidityZoneDetector();
  const candlePatternAnalyzer = createCandlePatternAnalyzer();

  // Signal Engine FSM
  const signalEngineFSM = new SignalEngineFSM({
    eventBus,
    timeGate,
    newsDecoupler,
    liquidityZoneDetector,
    candlePatternAnalyzer,
    signalLogger,
    candleBufferManager,
  });

  // Pipeline Components
  const stopLossTargetMapper = createStopLossTargetMapper();
  const volumeFilter = createVolumeFilter();
  const kellySizer = createKellySizer({
    equityBaseline: config.kelly.equityBaseline,
    floorRisk: config.kelly.floorRisk,
    ceilingRisk: config.kelly.ceilingRisk,
    coldStartRisk: config.kelly.coldStartRisk,
    windowSize: config.kelly.windowSize,
    drawdownThresholdStart: config.kelly.drawdownThresholdStart,
    drawdownThresholdMax: config.kelly.drawdownThresholdMax,
    varianceMultiplierThreshold: config.kelly.varianceMultiplierThreshold,
    varianceReductionFactor: config.kelly.varianceReductionFactor,
  });
  const slippageSimulator = createSlippageSimulator();
  const signalOutputFormatter = createSignalOutputFormatter();

  // Output Components
  const dashboard = createDashboardServer(config.dashboard.maxSignalHistory);

  const telegramNotifier = new TelegramNotifier(
    {
      botToken: config.telegram.botToken,
      chatId: config.telegram.chatId,
      maxRetries: config.telegram.maxRetries,
      baseRetryMs: config.telegram.baseRetryMs,
    },
    {
      error: (msg, ctx) => console.error(`[Telegram] ${msg}`, ctx ?? ''),
      warn: (msg, ctx) => console.warn(`[Telegram] ${msg}`, ctx ?? ''),
      info: (msg, ctx) => console.info(`[Telegram] ${msg}`, ctx ?? ''),
    },
    // Fetch function for HTTP requests
    async (url, options) => {
      const response = await fetch(url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
      });
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
      };
    },
  );

  // Candle Ingestion
  const candleIngestion = new CandleIngestion(eventBus);

  // ─── Step 4: Wire the event flow ───────────────────────────────────────────

  // 4a. candle.close → CandleBufferManager.addCandle() + FSM.processCandle()
  eventBus.subscribe('candle.close', (event) => {
    const candle = event.candle as Candle;

    const rollover = dailySignalTargetTracker.observe(candle.timestamp);
    if (rollover) {
      const completed = rollover.completedDay;
      const completion = completed.minimumMet ? 'minimum met' : 'minimum missed';
      console.log(
        `[Daily Signal Target] UTC ${completed.dateKey} complete: ` +
          `${completed.qualifiedSignals}/${completed.minimum}-${completed.maximum} qualified signals (${completion}).`,
      );
    }

    // Add to buffer for SMA/volume tracking
    candleBufferManager.addCandle(candle);

    // Broadcast M5 candles to dashboard
    if (candle.timeframe === 'M5') {
      dashboard.broadcastCandleUpdate(candle);
    }

    // Process M1 candles through circuit breaker
    if (candle.timeframe === 'M1') {
      macroFilterModule.processM1Candle(candle, lastSignalDirection, lastSignalId);
    }

    // Forward all candles to FSM (FSM internally filters for M5/H1/M15)
    signalEngineFSM.processCandle(candle);
  });

  // 4b. signal.raw → Pipeline → signal.formatted → Outputs
  eventBus.subscribe('signal.raw', (rawSignal) => {
    processSignalPipeline(
      rawSignal as unknown as RawSignal,
      candleBufferManager,
      stopLossTargetMapper,
      volumeFilter,
      kellySizer,
      slippageSimulator,
      signalOutputFormatter,
      telegramNotifier,
      dashboard,
      signalLogger,
      eventBus,
      dailySignalTargetTracker,
    );
  });

  // 4c. filter.change → Dashboard.broadcastFilterStatus()
  eventBus.subscribe('filter.change', () => {
    const filterStatus = macroFilterModule.getFilterStatus();
    dashboard.broadcastFilterStatus(filterStatus);
  });

  // 4d. state.change → Dashboard.broadcastStateChange()
  eventBus.subscribe('state.change', (transition) => {
    dashboard.broadcastStateChange(transition.to);
  });

  // 4e. alert.circuitBreaker → Dashboard + Logger
  eventBus.subscribe('alert.circuitBreaker', (alert) => {
    const filterStatus = macroFilterModule.getFilterStatus();
    dashboard.broadcastFilterStatus(filterStatus);
    signalLogger.logFilterEvent({
      filterName: 'circuit_breaker',
      action: 'activated',
      timestamp: alert.timestamp,
      durationSeconds: config.circuitBreaker.suppressionMinutes * 60,
      metadata: {
        magnitude: alert.magnitude,
        affectedSignalId: alert.affectedSignalId,
        direction: alert.direction,
        suppressionEndsAt: alert.suppressionEndsAt,
      },
    });
  });

  // ─── Step 5: Time check → Initialize FSM state ─────────────────────────────
  const now = new Date();
  timeGate.initialize(now);
  signalEngineFSM.initialize(now);
  console.log(`[Isagi Engine] FSM initialized. State: ${signalEngineFSM.getState()}`);

  // ─── Step 6: Start Dashboard server ─────────────────────────────────────────
  try {
    await dashboard.start(config.dashboard.port);
    console.log(`[Isagi Engine] Dashboard started on port ${config.dashboard.port}.`);
  } catch (err) {
    console.error('[Isagi Engine] WARNING: Failed to start Dashboard.', err);
    // Non-fatal: continue without dashboard
  }

  // ─── Step 7: Connect Telegram (validate config) ─────────────────────────────
  if (config.telegram.botToken && config.telegram.chatId) {
    console.log('[Isagi Engine] Telegram Notifier configured.');
  } else {
    console.warn(
      '[Isagi Engine] WARNING: Telegram not configured. Signals will not be sent to Telegram.',
    );
  }

  // ─── Step 8: Load News Calendar (best-effort) ──────────────────────────────
  // News Decoupler runs without schedule initially (fail-open per R7.5)
  console.log('[Isagi Engine] News Decoupler initialized (will activate on schedule load).');

  // ─── Step 9: Connect WebSocket data feed ───────────────────────────────────
  try {
    await candleIngestion.connect({
      wsUrl: config.dataSource.wsUrl,
      instrument: config.dataSource.instrument,
      timeframes: ['M1', 'M5', 'M15', 'H1'],
      reconnectIntervalMs: config.dataSource.reconnectIntervalMs,
    });
    console.log(`[Isagi Engine] Connected to data feed: ${config.dataSource.wsUrl}`);
  } catch (err) {
    console.error('[Isagi Engine] WARNING: Failed to connect to data feed. Will retry...', err);
    // Non-fatal: CandleIngestion auto-reconnects
  }

  console.log('[Isagi Engine] System fully initialized. Processing candles...');

  // ─── Step 10: Graceful Shutdown Handler ─────────────────────────────────────
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n[Isagi Engine] Received ${signal}. Shutting down gracefully...`);

    const dailyStatus = dailySignalTargetTracker.getStatus();
    const dailyCompletion = dailyStatus.minimumMet ? 'minimum met' : 'minimum missed';
    console.log(
      `[Daily Signal Target] UTC ${dailyStatus.dateKey}: ` +
        `${dailyStatus.qualifiedSignals}/${dailyStatus.minimum}-${dailyStatus.maximum} qualified signals (${dailyCompletion}).`,
    );

    try {
      // 1. Disconnect WebSocket
      await candleIngestion.disconnect();
      console.log('[Isagi Engine] WebSocket disconnected.');
    } catch (err) {
      console.error('[Isagi Engine] Error disconnecting WebSocket:', err);
    }

    try {
      // 2. Stop Dashboard server
      await dashboard.stop();
      console.log('[Isagi Engine] Dashboard stopped.');
    } catch (err) {
      console.error('[Isagi Engine] Error stopping Dashboard:', err);
    }

    try {
      // 3. Close Signal Logger (flushes buffer, closes SQLite)
      signalLogger.close();
      console.log('[Isagi Engine] Signal Logger closed.');
    } catch (err) {
      console.error('[Isagi Engine] Error closing Signal Logger:', err);
    }

    // 4. Clean up event bus
    eventBus.removeAllListeners();

    console.log('[Isagi Engine] Shutdown complete.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // ─── Uncaught Error Handling ────────────────────────────────────────────────
  process.on('uncaughtException', (err) => {
    console.error('[Isagi Engine] CRITICAL - Uncaught Exception:', err);
    signalLogger.logRejection({
      timestamp: new Date().toISOString(),
      reason: `Uncaught exception: ${err.message}`,
      filter: 'system_error',
      context: { stack: err.stack },
    });
    // Attempt graceful degradation: don't crash immediately
    // The system can continue processing if the error is non-fatal
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[Isagi Engine] CRITICAL - Unhandled Rejection:', reason);
    signalLogger.logRejection({
      timestamp: new Date().toISOString(),
      reason: `Unhandled rejection: ${String(reason)}`,
      filter: 'system_error',
      context: { reason: String(reason) },
    });
  });
}

// ─── Signal Pipeline Processing ──────────────────────────────────────────────

/**
 * Process a raw signal through the full pipeline:
 * SL/Target Mapper → Volume Filter → Kelly Sizer → Slippage Simulator → Output Formatter
 *
 * Short-circuits on:
 * - Volume rejection (volume below SMA)
 * - Reward < 1.5R invalidation (target too close)
 */
function processSignalPipeline(
  rawSignal: RawSignal,
  candleBufferManager: CandleBufferManager,
  stopLossTargetMapper: ReturnType<typeof createStopLossTargetMapper>,
  volumeFilter: ReturnType<typeof createVolumeFilter>,
  kellySizer: ReturnType<typeof createKellySizer>,
  slippageSimulator: ReturnType<typeof createSlippageSimulator>,
  signalOutputFormatter: ReturnType<typeof createSignalOutputFormatter>,
  telegramNotifier: TelegramNotifier,
  dashboard: ReturnType<typeof createDashboardServer>,
  signalLogger: SqliteSignalLogger,
  eventBus: EventBus,
  dailySignalTargetTracker: DailySignalTargetTracker,
): void {
  // Get recent M5 candles for pipeline calculations
  const recentM5Candles = candleBufferManager.getLatestCandles('M5', 20);
  const sma20Volume = candleBufferManager.getSma20Volume();
  const lastFiveVolumes = candleBufferManager.getVolumeTrend(5);

  // ─── Step 1: Volume Filter ──────────────────────────────────────────────────
  const currentVolume =
    recentM5Candles.length > 0 ? recentM5Candles[recentM5Candles.length - 1].volume : 0;

  const volumeResult = volumeFilter.evaluate(currentVolume, sma20Volume, lastFiveVolumes);

  if (volumeResult.rejected) {
    // Short-circuit: volume rejection
    console.log(`[Pipeline] Signal ${rawSignal.id} rejected: ${volumeResult.rejectionReason}`);
    signalLogger.logRejection({
      timestamp: new Date().toISOString(),
      reason: volumeResult.rejectionReason ?? 'Volume below SMA',
      filter: 'volume_filter',
      context: { signalId: rawSignal.id, currentVolume, sma20Volume },
    });
    return;
  }

  // ─── Step 2: Stop Loss / Target Calculation ─────────────────────────────────
  const stopLoss = stopLossTargetMapper.calculateStopLoss(
    rawSignal as unknown as Parameters<typeof stopLossTargetMapper.calculateStopLoss>[0],
    recentM5Candles,
    volumeResult.zoneClassification,
  );

  const targets = stopLossTargetMapper.calculateTargets(
    rawSignal.entryPrice,
    stopLoss,
    volumeResult.targetRMultiple,
    recentM5Candles,
    sma20Volume,
  );

  // Short-circuit: reward < 1.5R invalidation
  if (!targets.isValid) {
    console.log(`[Pipeline] Signal ${rawSignal.id} invalidated: reward < 1.5R`);
    signalLogger.logRejection({
      timestamp: new Date().toISOString(),
      reason: 'Insufficient reward-to-risk (< 1.5R after target adjustment)',
      filter: 'target_validation',
      context: {
        signalId: rawSignal.id,
        rUnit: targets.rUnit,
        tp2: targets.tp2,
        entry: rawSignal.entryPrice,
      },
    });
    return;
  }

  // ─── Step 3: Kelly Sizer ────────────────────────────────────────────────────
  const kellyResult = kellySizer.calculateRisk(signalHistory);

  // ─── Step 4: Slippage Simulator ─────────────────────────────────────────────
  const slippageResult = slippageSimulator.applySlippage({
    entryPrice: rawSignal.entryPrice,
    direction: rawSignal.direction,
  });

  // ─── Step 5: Signal Output Formatter ────────────────────────────────────────
  const formattedSignal: FormattedSignal = signalOutputFormatter.format({
    rawSignal: rawSignal as unknown as Parameters<
      typeof signalOutputFormatter.format
    >[0]['rawSignal'],
    stopLoss,
    targets,
    zoneClassification: volumeResult.zoneClassification,
    kellyResult,
    slippageResult,
  });

  // ─── Step 6: Emit formatted signal and deliver to outputs ──────────────────

  const dailyStatus = dailySignalTargetTracker.recordQualifiedSignal(rawSignal.timestamp);
  const dailyTargetNote = dailyStatus.minimumMet ? 'minimum met' : 'minimum pending';
  console.log(
    `[Daily Signal Target] UTC ${dailyStatus.dateKey}: ` +
      `${dailyStatus.qualifiedSignals}/${dailyStatus.minimum}-${dailyStatus.maximum} qualified signals (${dailyTargetNote}).`,
  );

  // Publish on event bus
  eventBus.publish('signal.formatted', formattedSignal);

  // Update last signal tracking for circuit breaker
  lastSignalDirection = rawSignal.direction;
  lastSignalId = rawSignal.id;

  // Record in signal history for Kelly calculations
  signalHistory.push({
    signalId: rawSignal.id,
    pnl: 0, // Actual P&L tracked externally; starts at 0
    riskAmount: kellyResult.riskAmount,
    timestamp: rawSignal.timestamp,
  });

  // Broadcast to Dashboard
  dashboard.broadcastSignal(formattedSignal);
  dashboard.broadcastKellyMetrics(kellyResult);

  // Log to Signal Logger
  signalLogger.logSignal(formattedSignal);

  // Send to Telegram (async, non-blocking)
  telegramNotifier.sendSignal(formattedSignal).catch((err) => {
    console.error('[Pipeline] Telegram delivery error:', err);
  });

  console.log(
    `[Pipeline] Signal ${formattedSignal.id} processed: ${formattedSignal.direction} ` +
      `entry=${formattedSignal.entryPrice.toFixed(2)} SL=${formattedSignal.stopLoss.toFixed(2)} ` +
      `TP1=${formattedSignal.ticket1.takeProfit.toFixed(2)} TP2=${formattedSignal.ticket2.takeProfit.toFixed(2)} ` +
      `zone=${formattedSignal.zoneClassification} risk=$${formattedSignal.riskAmount.toFixed(2)}`,
  );
}

// ─── Start Application ───────────────────────────────────────────────────────

main().catch((err) => {
  console.error('[Isagi Engine] Fatal startup error:', err);
  process.exit(1);
});
