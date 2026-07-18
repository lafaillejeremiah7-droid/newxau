/**
 * Deterministic one-year replay of the live signal engine.
 *
 * This script consumes Dukascopy M1 bid OHLCV CSV files, aggregates them into
 * M5/M15/H1 candles, and feeds candles through the production FSM and the
 * production signal-validation pipeline. It counts hypothetical qualified
 * signals only; it never places orders or sends Telegram messages.
 *
 * Usage:
 *   npm run backtest:year
 *
 * Data files expected:
 *   data/historical/xauusd/xauusd-m1-bid-2025-07-18-2026-07-18.csv
 *   data/historical/btcusd/btcusd-m1-bid-2025-07-18-2026-07-18.csv
 */

import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

import { getInstrumentMetadata, type Instrument } from '../src/config/instrument.js';
import { SignalEngineFSM, type RawSignal } from '../src/core/signal-engine-fsm.js';
import { EventBus } from '../src/core/event-bus.js';
import { LiquidityZoneDetector } from '../src/core/liquidity-zone-detector.js';
import { createCandlePatternAnalyzer } from '../src/core/candle-pattern-analyzer.js';
import { CandleBufferManager } from '../src/data/candle-buffer.js';
import { TimeGate } from '../src/filters/time-gate.js';
import { NewsDecoupler } from '../src/filters/news-decoupler.js';
import { CircuitBreaker } from '../src/filters/circuit-breaker.js';
import { createStopLossTargetMapper } from '../src/pipeline/stop-loss-target-mapper.js';
import { createVolumeFilter } from '../src/pipeline/volume-filter.js';
import type { SignalLogger } from '../src/data/signal-logger.js';
import type { Candle, Timeframe } from '../src/types/index.js';

const START_DATE = '2025-07-18T00:00:00.000Z';
const END_DATE = '2026-07-18T00:00:00.000Z';
const OUTPUT_DIR = resolve('data/backtest-results');

interface CsvM1Row {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface MutableBar {
  startMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface BacktestSignal {
  timestamp: string;
  direction: 'long' | 'short';
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  rUnit: number;
  zoneClassification: 'expansion_zone' | 'chop_zone';
  outcome?: SignalOutcome;
}

interface SignalOutcome {
  status:
    | 'stop_before_tp1'
    | 'tp1_then_breakeven'
    | 'tp1_then_tp2'
    | 'open_at_end'
    | 'ambiguous_stop_first';
  realizedR: number;
  resolutionTimestamp: string | null;
}

interface BacktestResult {
  instrument: Instrument;
  source: string;
  start: string;
  end: string;
  sourceRows: number;
  emittedCandles: Record<Timeframe, number>;
  rawSignals: number;
  qualifiedSignals: number;
  rejectedByVolume: number;
  rejectedByRewardRisk: number;
  directions: { long: number; short: number };
  zones: { expansion_zone: number; chop_zone: number };
  outcomes: {
    stopBeforeTp1: number;
    tp1ThenBreakeven: number;
    tp1ThenTp2: number;
    openAtEnd: number;
    ambiguousStopFirst: number;
  };
  winningSignals: number;
  losingSignals: number;
  totalRealizedR: number;
  averageRealizedR: number;
  profitFactor: number | null;
  signals: BacktestSignal[];
}

const NOOP_LOGGER: SignalLogger = {
  logSignal: async () => {},
  logRejection: async () => {},
  logStateTransition: async () => {},
  logFilterEvent: async () => {},
  runRetentionCleanup: () => {},
  close: () => {},
};

const TIMEFRAME_MS: Record<Exclude<Timeframe, 'M1'>, number> = {
  M5: 5 * 60 * 1000,
  M15: 15 * 60 * 1000,
  H1: 60 * 60 * 1000,
};

function parseCsvRow(line: string): CsvM1Row | null {
  const values = line.split(',');
  if (values.length < 6 || values[0] === 'timestamp') return null;

  const row = values.slice(0, 6).map(Number);
  if (row.some((value) => !Number.isFinite(value))) return null;

  return {
    timestamp: row[0],
    open: row[1],
    high: row[2],
    low: row[3],
    close: row[4],
    volume: row[5],
  };
}

function toCandle(
  instrument: Instrument,
  timeframe: Timeframe,
  startMs: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
): Candle {
  return {
    instrument,
    timeframe,
    timestamp: new Date(startMs).toISOString(),
    open,
    high,
    low,
    close,
    volume,
  };
}

function updateBar(
  existing: MutableBar | null,
  row: CsvM1Row,
  timeframe: Exclude<Timeframe, 'M1'>,
): { bar: MutableBar; closed: MutableBar | null } {
  const duration = TIMEFRAME_MS[timeframe];
  const startMs = Math.floor(row.timestamp / duration) * duration;

  if (!existing) {
    return {
      bar: {
        startMs,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
      },
      closed: null,
    };
  }

  if (existing.startMs !== startMs) {
    return {
      closed: existing,
      bar: {
        startMs,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
      },
    };
  }

  existing.high = Math.max(existing.high, row.high);
  existing.low = Math.min(existing.low, row.low);
  existing.close = row.close;
  existing.volume += row.volume;
  return { bar: existing, closed: null };
}

function barToCandle(
  instrument: Instrument,
  timeframe: Exclude<Timeframe, 'M1'>,
  bar: MutableBar,
): Candle {
  return toCandle(
    instrument,
    timeframe,
    bar.startMs,
    bar.open,
    bar.high,
    bar.low,
    bar.close,
    bar.volume,
  );
}

function evaluateOutcomes(result: BacktestResult, sourceRows: CsvM1Row[]): void {
  let positiveR = 0;
  let negativeR = 0;

  for (const signal of result.signals) {
    const isLong = signal.direction === 'long';
    const evaluationStartMs = Date.parse(signal.timestamp) + TIMEFRAME_MS.M5;
    let stage: 'before_tp1' | 'after_tp1' = 'before_tp1';
    let realizedR = 0;
    let status: SignalOutcome['status'] = 'open_at_end';
    let resolutionTimestamp: string | null = null;

    for (const row of sourceRows) {
      if (row.timestamp < evaluationStartMs) continue;

      if (stage === 'before_tp1') {
        const stopHit = isLong ? row.low <= signal.stopLoss : row.high >= signal.stopLoss;
        const tp1Hit = isLong ? row.high >= signal.tp1 : row.low <= signal.tp1;

        // OHLC data does not reveal intrabar order. Use stop-first whenever
        // both levels occur in one minute, which avoids optimistic results.
        if (stopHit && tp1Hit) {
          status = 'ambiguous_stop_first';
          realizedR = -1;
          resolutionTimestamp = new Date(row.timestamp).toISOString();
          break;
        }
        if (stopHit) {
          status = 'stop_before_tp1';
          realizedR = -1;
          resolutionTimestamp = new Date(row.timestamp).toISOString();
          break;
        }
        if (tp1Hit) {
          stage = 'after_tp1';
          realizedR =
            0.45 *
            (isLong
              ? (signal.tp1 - signal.entryPrice) / signal.rUnit
              : (signal.entryPrice - signal.tp1) / signal.rUnit);
        }
        continue;
      }

      const breakevenHit = isLong ? row.low <= signal.entryPrice : row.high >= signal.entryPrice;
      const tp2Hit = isLong ? row.high >= signal.tp2 : row.low <= signal.tp2;

      // After TP1, Ticket 2 moves to entry. Again, use the conservative
      // breakeven-first ordering when both levels occur in one minute.
      if (breakevenHit && tp2Hit) {
        status = 'tp1_then_breakeven';
        resolutionTimestamp = new Date(row.timestamp).toISOString();
        break;
      }
      if (breakevenHit) {
        status = 'tp1_then_breakeven';
        resolutionTimestamp = new Date(row.timestamp).toISOString();
        break;
      }
      if (tp2Hit) {
        status = 'tp1_then_tp2';
        realizedR +=
          0.55 *
          (isLong
            ? (signal.tp2 - signal.entryPrice) / signal.rUnit
            : (signal.entryPrice - signal.tp2) / signal.rUnit);
        resolutionTimestamp = new Date(row.timestamp).toISOString();
        break;
      }
    }

    signal.outcome = { status, realizedR, resolutionTimestamp };
    result.outcomes[
      status === 'stop_before_tp1'
        ? 'stopBeforeTp1'
        : status === 'tp1_then_breakeven'
          ? 'tp1ThenBreakeven'
          : status === 'tp1_then_tp2'
            ? 'tp1ThenTp2'
            : status === 'open_at_end'
              ? 'openAtEnd'
              : 'ambiguousStopFirst'
    ]++;
    result.totalRealizedR += realizedR;
    if (realizedR > 0) {
      result.winningSignals++;
      positiveR += realizedR;
    } else if (realizedR < 0) {
      result.losingSignals++;
      negativeR += Math.abs(realizedR);
    }
  }

  result.averageRealizedR =
    result.signals.length > 0 ? result.totalRealizedR / result.signals.length : 0;
  result.profitFactor = negativeR > 0 ? positiveR / negativeR : null;
}

async function runInstrument(instrument: Instrument, csvPath: string): Promise<BacktestResult> {
  const metadata = getInstrumentMetadata(instrument);
  const eventBus = new EventBus();
  const candleBuffer = new CandleBufferManager();
  const zones = new LiquidityZoneDetector();
  const analyzer = createCandlePatternAnalyzer();
  const timeGate = new TimeGate();
  const newsDecoupler = new NewsDecoupler();
  const circuitBreaker = new CircuitBreaker({
    thresholdPips: 300,
    suppressionMinutes: 15,
    pipSize: metadata.pipSize,
  });
  const fsm = new SignalEngineFSM({
    eventBus,
    instrument,
    breakthroughSize: metadata.breakthroughSize,
    timeGate,
    newsDecoupler,
    liquidityZoneDetector: zones,
    candlePatternAnalyzer: analyzer,
    signalLogger: NOOP_LOGGER,
    candleBufferManager: candleBuffer,
  });
  const volumeFilter = createVolumeFilter();
  const targetMapper = createStopLossTargetMapper({ pipSize: metadata.pipSize });

  const result: BacktestResult = {
    instrument,
    source: `Dukascopy ${instrument.toLowerCase()} bid M1 OHLCV`,
    start: START_DATE,
    end: END_DATE,
    sourceRows: 0,
    emittedCandles: { M1: 0, M5: 0, M15: 0, H1: 0 },
    rawSignals: 0,
    qualifiedSignals: 0,
    rejectedByVolume: 0,
    rejectedByRewardRisk: 0,
    directions: { long: 0, short: 0 },
    zones: { expansion_zone: 0, chop_zone: 0 },
    outcomes: {
      stopBeforeTp1: 0,
      tp1ThenBreakeven: 0,
      tp1ThenTp2: 0,
      openAtEnd: 0,
      ambiguousStopFirst: 0,
    },
    winningSignals: 0,
    losingSignals: 0,
    totalRealizedR: 0,
    averageRealizedR: 0,
    profitFactor: null,
    signals: [],
  };

  let lastSignalDirection: 'long' | 'short' | null = null;
  let lastSignalId: string | null = null;
  let firstTimestamp: number | null = null;
  const sourceRows: CsvM1Row[] = [];
  let m5: MutableBar | null = null;
  let m15: MutableBar | null = null;
  let h1: MutableBar | null = null;

  const feedCandle = (candle: Candle): void => {
    result.emittedCandles[candle.timeframe]++;
    candleBuffer.addCandle(candle);

    if (candle.timeframe === 'M1') {
      // This matches production wiring: the breaker observes M1 candles but
      // does not gate the FSM or pipeline in the current live implementation.
      circuitBreaker.processM1Candle(candle, lastSignalDirection, lastSignalId);
    }

    fsm.processCandle(candle);
  };

  eventBus.subscribe('signal.raw', (rawSignal) => {
    const signal = rawSignal as RawSignal;
    result.rawSignals++;

    const recentM5 = candleBuffer.getLatestCandles('M5', 20);
    const currentVolume = recentM5.length > 0 ? recentM5[recentM5.length - 1].volume : 0;
    const volumeResult = volumeFilter.evaluate(
      currentVolume,
      candleBuffer.getSma20Volume(),
      candleBuffer.getVolumeTrend(5),
    );

    if (volumeResult.rejected) {
      result.rejectedByVolume++;
      return;
    }

    const stopLoss = targetMapper.calculateStopLoss(
      signal as unknown as Parameters<typeof targetMapper.calculateStopLoss>[0],
      recentM5,
      volumeResult.zoneClassification,
    );
    const targets = targetMapper.calculateTargets(
      signal.entryPrice,
      stopLoss,
      volumeResult.targetRMultiple,
      recentM5,
      candleBuffer.getSma20Volume(),
    );

    if (!targets.isValid) {
      result.rejectedByRewardRisk++;
      return;
    }

    result.qualifiedSignals++;
    result.directions[signal.direction]++;
    result.zones[volumeResult.zoneClassification]++;
    lastSignalDirection = signal.direction;
    lastSignalId = signal.id;
    result.signals.push({
      timestamp: signal.timestamp,
      direction: signal.direction,
      entryPrice: signal.entryPrice,
      stopLoss,
      tp1: targets.tp1,
      tp2: targets.tp2,
      rUnit: targets.rUnit,
      zoneClassification: volumeResult.zoneClassification,
    });
  });

  let initialized = false;
  const input = createReadStream(csvPath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    const row = parseCsvRow(line);
    if (!row) continue;
    if (row.timestamp < Date.parse(START_DATE) || row.timestamp >= Date.parse(END_DATE)) continue;

    result.sourceRows++;
    sourceRows.push(row);
    firstTimestamp ??= row.timestamp;
    if (!initialized) {
      timeGate.initialize(new Date(row.timestamp));
      fsm.initialize(new Date(row.timestamp));
      initialized = true;
    }

    const m1 = toCandle(
      instrument,
      'M1',
      row.timestamp,
      row.open,
      row.high,
      row.low,
      row.close,
      row.volume,
    );
    feedCandle(m1);

    const m5Update = updateBar(m5, row, 'M5');
    m5 = m5Update.bar;
    if (m5Update.closed) feedCandle(barToCandle(instrument, 'M5', m5Update.closed));

    const m15Update = updateBar(m15, row, 'M15');
    m15 = m15Update.bar;
    if (m15Update.closed) feedCandle(barToCandle(instrument, 'M15', m15Update.closed));

    const h1Update = updateBar(h1, row, 'H1');
    h1 = h1Update.bar;
    if (h1Update.closed) feedCandle(barToCandle(instrument, 'H1', h1Update.closed));
  }

  lines.close();
  input.close();

  if (!firstTimestamp) {
    throw new Error(`No rows found in ${csvPath} for requested range`);
  }

  evaluateOutcomes(result, sourceRows);
  return result;
}

async function main(): Promise<void> {
  const configs: Array<{ instrument: Instrument; path: string }> = [
    {
      instrument: 'XAUUSD',
      path: resolve('data/historical/xauusd/xauusd-m1-bid-2025-07-18-2026-07-18.csv'),
    },
    {
      instrument: 'BTCUSD',
      path: resolve('data/historical/btcusd/btcusd-m1-bid-2025-07-18-2026-07-18.csv'),
    },
  ];

  const results: BacktestResult[] = [];
  for (const config of configs) {
    console.log(`[Backtest] Running ${config.instrument} from ${START_DATE} to ${END_DATE}...`);
    const result = await runInstrument(config.instrument, config.path);
    results.push(result);
    console.log(
      `[Backtest] ${config.instrument}: ${result.qualifiedSignals} qualified signals ` +
        `(${result.rawSignals} raw, ${result.rejectedByVolume} volume rejects, ` +
        `${result.rejectedByRewardRisk} reward/risk rejects); ` +
        `outcome=${result.totalRealizedR.toFixed(2)}R, ` +
        `wins=${result.winningSignals}, losses=${result.losingSignals}.`,
    );
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPath = resolve(OUTPUT_DIR, 'one-year-summary.json');
  writeFileSync(
    outputPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2) + '\n',
  );

  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(`[Backtest] Summary written to ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error(
    '[Backtest] Fatal error:',
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exitCode = 1;
});
