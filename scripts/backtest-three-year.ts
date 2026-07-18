/**
 * Three-year, signal-only replay for the existing strategy and proposed
 * higher-frequency profiles.
 *
 * One authoritative Dukascopy M1 bid file is used per instrument. M5, M15,
 * and H1 candles are aggregated deterministically from those M1 rows. The
 * existing production FSM is reported as Tier A. Tier B uses M15 structure
 * with M5 execution. An exploratory M1 execution profile is also reported so
 * the requested M15/M5/M1 frequency trade-off is visible.
 *
 * This script never places trades, modifies orders, or sends Telegram alerts.
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
import { createStopLossTargetMapper } from '../src/pipeline/stop-loss-target-mapper.js';
import {
  getUtcDateKey,
  selectSignalsWithUtcDailyCap,
} from '../src/monitoring/daily-signal-target.js';
import type { SignalLogger } from '../src/data/signal-logger.js';
import type { Candle, Timeframe } from '../src/types/index.js';
import type { ZoneClassification } from '../src/types/zone.js';

const START_DATE = '2023-07-18T00:00:00.000Z';
const END_DATE = '2026-07-18T00:00:00.000Z';
const OUTPUT_DIR = resolve('data/backtest-results');
const MS: Record<Timeframe, number> = {
  M1: 60 * 1000,
  M5: 5 * 60 * 1000,
  M15: 15 * 60 * 1000,
  H1: 60 * 60 * 1000,
};

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

interface BacktestSignal {
  timestamp: string;
  direction: 'long' | 'short';
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  rUnit: number;
  zoneClassification: ZoneClassification;
  outcome?: SignalOutcome;
}

interface ProfileResult {
  instrument: Instrument;
  profile: string;
  structureTimeframe: Timeframe;
  executionTimeframe: Timeframe;
  source: string;
  start: string;
  end: string;
  sourceRows: number;
  emittedCandles: Record<Timeframe, number>;
  rawSignals: number;
  qualifiedSignals: number;
  rejectedByVolume: number;
  rejectedByRewardRisk: number;
  rejectedByStopPlacement: number;
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

function parseCsvRow(line: string): CsvM1Row | null {
  const values = line.split(',');
  if (values.length < 6 || values[0] === 'timestamp') return null;
  const numbers = values.slice(0, 6).map(Number);
  if (numbers.some((value) => !Number.isFinite(value))) return null;
  return {
    timestamp: numbers[0],
    open: numbers[1],
    high: numbers[2],
    low: numbers[3],
    close: numbers[4],
    volume: numbers[5],
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
  const duration = MS[timeframe];
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

function newResult(
  instrument: Instrument,
  profile: string,
  structureTimeframe: Timeframe,
  executionTimeframe: Timeframe,
): ProfileResult {
  return {
    instrument,
    profile,
    structureTimeframe,
    executionTimeframe,
    source: `Dukascopy ${instrument.toLowerCase()} bid M1 OHLCV; deterministic ${structureTimeframe}/${executionTimeframe} replay`,
    start: START_DATE,
    end: END_DATE,
    sourceRows: 0,
    emittedCandles: { M1: 0, M5: 0, M15: 0, H1: 0 },
    rawSignals: 0,
    qualifiedSignals: 0,
    rejectedByVolume: 0,
    rejectedByRewardRisk: 0,
    rejectedByStopPlacement: 0,
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
}

function classifyVolume(volumes: number[]): {
  zoneClassification: ZoneClassification;
  targetRMultiple: number;
} {
  let increasing = 0;
  let decreasing = 0;
  for (let index = 1; index < volumes.length; index++) {
    if (volumes[index] > volumes[index - 1]) increasing++;
    if (volumes[index] < volumes[index - 1]) decreasing++;
  }
  if (increasing >= 3) return { zoneClassification: 'expansion_zone', targetRMultiple: 3 };
  if (decreasing >= 3) return { zoneClassification: 'chop_zone', targetRMultiple: 1.5 };
  return { zoneClassification: 'chop_zone', targetRMultiple: 2 };
}

function qualifySignal(
  result: ProfileResult,
  signal: RawSignal,
  recentCandles: Candle[],
  recentVolumes: number[],
  currentVolume: number,
  smaVolume: number,
  minimumVolumeRatio: number,
  mapper: ReturnType<typeof createStopLossTargetMapper>,
  zoneClassification: ZoneClassification,
  targetRMultiple: number,
): void {
  result.rawSignals++;
  if (smaVolume > 0 && currentVolume < minimumVolumeRatio * smaVolume) {
    result.rejectedByVolume++;
    return;
  }

  const stopLoss = mapper.calculateStopLoss(signal, recentCandles, zoneClassification);
  const stopOnCorrectSide = signal.direction === 'long'
    ? stopLoss < signal.entryPrice
    : stopLoss > signal.entryPrice;
  if (!Number.isFinite(stopLoss) || !stopOnCorrectSide) {
    result.rejectedByStopPlacement++;
    return;
  }
  const targets = mapper.calculateTargets(
    signal.entryPrice,
    stopLoss,
    targetRMultiple,
    recentCandles,
    smaVolume,
  );
  if (!targets.isValid) {
    result.rejectedByRewardRisk++;
    return;
  }

  result.qualifiedSignals++;
  result.directions[signal.direction]++;
  result.zones[zoneClassification]++;
  result.signals.push({
    timestamp: signal.timestamp,
    direction: signal.direction,
    entryPrice: signal.entryPrice,
    stopLoss,
    tp1: targets.tp1,
    tp2: targets.tp2,
    rUnit: targets.rUnit,
    zoneClassification,
  });
}

function findFirstRowAtOrAfter(rows: CsvM1Row[], timestamp: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function evaluateOutcomes(result: ProfileResult, rows: CsvM1Row[]): void {
  let positiveR = 0;
  let negativeR = 0;
  for (const signal of result.signals) {
    const isLong = signal.direction === 'long';
    const startIndex = findFirstRowAtOrAfter(
      rows,
      Date.parse(signal.timestamp) + MS[result.executionTimeframe],
    );
    let stage: 'before_tp1' | 'after_tp1' = 'before_tp1';
    let realizedR = 0;
    let status: SignalOutcome['status'] = 'open_at_end';
    let resolutionTimestamp: string | null = null;

    for (let index = startIndex; index < rows.length; index++) {
      const row = rows[index];
      if (stage === 'before_tp1') {
        const stopHit = isLong ? row.low <= signal.stopLoss : row.high >= signal.stopLoss;
        const tp1Hit = isLong ? row.high >= signal.tp1 : row.low <= signal.tp1;
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
          realizedR = 0.45 * (isLong
            ? (signal.tp1 - signal.entryPrice) / signal.rUnit
            : (signal.entryPrice - signal.tp1) / signal.rUnit);
        }
        continue;
      }

      const breakevenHit = isLong ? row.low <= signal.entryPrice : row.high >= signal.entryPrice;
      const tp2Hit = isLong ? row.high >= signal.tp2 : row.low <= signal.tp2;
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
        realizedR += 0.55 * (isLong
          ? (signal.tp2 - signal.entryPrice) / signal.rUnit
          : (signal.entryPrice - signal.tp2) / signal.rUnit);
        resolutionTimestamp = new Date(row.timestamp).toISOString();
        break;
      }
    }

    signal.outcome = { status, realizedR, resolutionTimestamp };
    if (status === 'stop_before_tp1') result.outcomes.stopBeforeTp1++;
    else if (status === 'tp1_then_breakeven') result.outcomes.tp1ThenBreakeven++;
    else if (status === 'tp1_then_tp2') result.outcomes.tp1ThenTp2++;
    else if (status === 'open_at_end') result.outcomes.openAtEnd++;
    else result.outcomes.ambiguousStopFirst++;

    result.totalRealizedR += realizedR;
    if (realizedR > 0) {
      result.winningSignals++;
      positiveR += realizedR;
    } else if (realizedR < 0) {
      result.losingSignals++;
      negativeR += Math.abs(realizedR);
    }
  }
  result.averageRealizedR = result.signals.length > 0
    ? result.totalRealizedR / result.signals.length
    : 0;
  result.profitFactor = negativeR > 0 ? positiveR / negativeR : null;
}

interface StructureZone {
  id: string;
  type: 'structural_high' | 'structural_low';
  upperBoundary: number;
  lowerBoundary: number;
  availableAt: number;
}

interface RelaxedSetup {
  zone: StructureZone;
  direction: 'long' | 'short';
  observationBars: Candle[];
  expansionBarsSeen: number;
  retracementSeen: boolean;
  rejectionPattern: RawSignal['rejectionCandleType'];
}

class RelaxedProfile {
  private readonly result: ProfileResult;
  private readonly instrument: Instrument;
  private readonly structureTimeframe: Exclude<Timeframe, 'M1'>;
  private readonly executionTimeframe: Timeframe;
  private readonly breakthroughSize: number;
  private readonly mapper: ReturnType<typeof createStopLossTargetMapper>;
  private readonly analyzer = createCandlePatternAnalyzer();
  private structureBars: Candle[] = [];
  private zones: StructureZone[] = [];
  private state: 'scanning' | 'observation' | 'expansion' | 'retracement' | 'entry' = 'scanning';
  private setup: RelaxedSetup | null = null;
  private usedZoneId: string | null = null;
  private executionBars: Candle[] = [];
  private nextZoneId = 0;

  constructor(
    instrument: Instrument,
    structureTimeframe: Exclude<Timeframe, 'M1'>,
    executionTimeframe: Timeframe,
    result: ProfileResult,
  ) {
    this.instrument = instrument;
    this.structureTimeframe = structureTimeframe;
    this.executionTimeframe = executionTimeframe;
    this.result = result;
    const metadata = getInstrumentMetadata(instrument);
    this.breakthroughSize = metadata.breakthroughSize;
    this.mapper = createStopLossTargetMapper({ pipSize: metadata.pipSize });
  }

  process(candle: Candle): void {
    if (candle.timeframe === this.structureTimeframe) this.updateStructure(candle);
    if (candle.timeframe === this.executionTimeframe) this.processExecution(candle);
  }

  private updateStructure(candle: Candle): void {
    this.structureBars.push(candle);
    if (this.structureBars.length < 3) return;
    const index = this.structureBars.length - 2;
    const previous = this.structureBars[index - 1];
    const current = this.structureBars[index];
    const next = this.structureBars[index + 1];
    let type: StructureZone['type'] | null = null;
    if (current.high > previous.high && current.high > next.high) type = 'structural_high';
    if (current.low < previous.low && current.low < next.low) type = 'structural_low';
    if (!type) return;
    this.nextZoneId++;
    this.zones.push({
      id: `${this.result.profile}-zone-${this.nextZoneId}`,
      type,
      upperBoundary: current.high,
      lowerBoundary: current.low,
      availableAt: Date.parse(candle.timestamp) + MS[this.structureTimeframe],
    });
    if (this.zones.length > 10) this.zones.shift();
  }

  private processExecution(candle: Candle): void {
    this.executionBars.push(candle);
    if (this.executionBars.length > 200) this.executionBars.shift();

    if (this.usedZoneId) {
      const usedZone = this.zones.find((zone) => zone.id === this.usedZoneId);
      if (!usedZone || candle.close < usedZone.lowerBoundary || candle.close > usedZone.upperBoundary) {
        this.usedZoneId = null;
      }
    }

    if (this.state === 'scanning') {
      const zone = [...this.zones]
        .reverse()
        .find((candidate) =>
          candidate.id !== this.usedZoneId &&
          candle.timestamp &&
          Date.parse(candle.timestamp) >= candidate.availableAt &&
          candle.close >= candidate.lowerBoundary &&
          candle.close <= candidate.upperBoundary,
        );
      if (zone) {
        this.setup = {
          zone,
          direction: zone.type === 'structural_low' ? 'long' : 'short',
          observationBars: [candle],
          expansionBarsSeen: 0,
          retracementSeen: false,
          rejectionPattern: 'hammer',
        };
        this.state = 'observation';
      }
      return;
    }

    if (!this.setup) {
      this.state = 'scanning';
      return;
    }

    const setup = this.setup;
    if (this.isBreakthrough(candle, setup.zone)) {
      this.resetSetup();
      return;
    }

    if (this.state === 'observation') {
      setup.observationBars.push(candle);
      if (setup.observationBars.length >= 2) {
        const rejection = this.analyzer.isRejectionCandle(
          candle,
          setup.direction === 'long' ? 'bullish' : 'bearish',
          setup.observationBars[setup.observationBars.length - 2],
        );
        if (rejection.isRejection) {
          setup.rejectionPattern = rejection.pattern ?? setup.rejectionPattern;
          this.state = 'expansion';
          return;
        }
      }
      if (setup.observationBars.length >= 4) this.resetSetup();
      return;
    }

    if (this.state === 'expansion') {
      setup.expansionBarsSeen++;
      if (this.isExpansion(candle, setup.direction)) {
        this.state = 'retracement';
        return;
      }
      if (setup.expansionBarsSeen >= 3) this.resetSetup();
      return;
    }

    if (this.state === 'retracement') {
      if (this.isRetracement(candle, setup.direction)) {
        setup.retracementSeen = true;
        this.state = 'entry';
      } else {
        this.resetSetup();
      }
      return;
    }

    const rejection = this.analyzer.isRejectionCandle(
      candle,
      setup.direction === 'long' ? 'bullish' : 'bearish',
      this.executionBars.length >= 2 ? this.executionBars[this.executionBars.length - 2] : undefined,
    );
    if (!rejection.isRejection || !setup.retracementSeen) {
      this.resetSetup();
      return;
    }

    setup.rejectionPattern = rejection.pattern ?? setup.rejectionPattern;
    const currentVolume = candle.volume;
    const recentVolumes = this.executionBars.slice(-5).map((bar) => bar.volume);
    const smaVolume = this.executionBars.slice(-20).reduce((sum, bar) => sum + bar.volume, 0) /
      Math.min(20, this.executionBars.length);
    const classification = classifyVolume(recentVolumes);
    const signal: RawSignal = {
      id: `${this.result.profile}-${this.result.rawSignals + 1}`,
      timestamp: candle.timestamp,
      instrument: this.instrument,
      direction: setup.direction,
      entryPrice: candle.close,
      liquidityZoneLevel: (setup.zone.upperBoundary + setup.zone.lowerBoundary) / 2,
      structuralWindowUpper: setup.zone.upperBoundary,
      structuralWindowLower: setup.zone.lowerBoundary,
      rejectionCandleType: setup.rejectionPattern,
      expansionCandles: [],
      retracementCandles: [],
      observationCandles: setup.observationBars,
    };
    qualifySignal(
      this.result,
      signal,
      this.executionBars.slice(-20),
      recentVolumes,
      currentVolume,
      smaVolume,
      0.8,
      this.mapper,
      classification.zoneClassification,
      classification.targetRMultiple,
    );
    this.usedZoneId = setup.zone.id;
    this.resetSetup();
  }

  private isBreakthrough(candle: Candle, zone: StructureZone): boolean {
    if (zone.type === 'structural_high') {
      return candle.close > zone.upperBoundary + this.breakthroughSize;
    }
    return candle.close < zone.lowerBoundary - this.breakthroughSize;
  }

  private isExpansion(candle: Candle, direction: 'long' | 'short'): boolean {
    const range = candle.high - candle.low;
    if (range === 0) return false;
    const bodyRatio = Math.abs(candle.open - candle.close) / range;
    if (bodyRatio < 0.55) return false;
    return direction === 'long' ? candle.close > candle.open : candle.close < candle.open;
  }

  private isRetracement(candle: Candle, direction: 'long' | 'short'): boolean {
    if (candle.open === candle.close) return true;
    return direction === 'long' ? candle.close < candle.open : candle.close > candle.open;
  }

  private resetSetup(): void {
    this.setup = null;
    this.state = 'scanning';
  }
}

async function readRows(csvPath: string): Promise<CsvM1Row[]> {
  const rows: CsvM1Row[] = [];
  const input = createReadStream(csvPath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const row = parseCsvRow(line);
    if (!row) continue;
    if (row.timestamp < Date.parse(START_DATE) || row.timestamp >= Date.parse(END_DATE)) continue;
    rows.push(row);
  }
  lines.close();
  input.close();
  if (rows.length === 0) throw new Error(`No rows found in ${csvPath}`);
  return rows;
}

function runProductionTierA(instrument: Instrument, rows: CsvM1Row[], counts: Record<Timeframe, number>): ProfileResult {
  const metadata = getInstrumentMetadata(instrument);
  const result = newResult(instrument, 'tier-a-production-h1-m15-m5', 'M15', 'M5');
  result.sourceRows = rows.length;
  result.emittedCandles = { ...counts };
  const eventBus = new EventBus();
  const candleBuffer = new CandleBufferManager();
  const zones = new LiquidityZoneDetector();
  const fsm = new SignalEngineFSM({
    eventBus,
    instrument,
    breakthroughSize: metadata.breakthroughSize,
    timeGate: new TimeGate(),
    newsDecoupler: new NewsDecoupler(),
    liquidityZoneDetector: zones,
    candlePatternAnalyzer: createCandlePatternAnalyzer(),
    signalLogger: NOOP_LOGGER,
    candleBufferManager: candleBuffer,
  });
  const mapper = createStopLossTargetMapper({ pipSize: metadata.pipSize });
  let initialized = false;

  eventBus.subscribe('signal.raw', (rawSignal) => {
    const signal = rawSignal as RawSignal;
    const recentM5 = candleBuffer.getLatestCandles('M5', 20);
    const currentVolume = recentM5.length > 0 ? recentM5[recentM5.length - 1].volume : 0;
    const smaVolume = candleBuffer.getSma20Volume();
    const volumes = candleBuffer.getVolumeTrend(5);
    const classification = classifyVolume(volumes);
    qualifySignal(
      result,
      signal,
      recentM5,
      volumes,
      currentVolume,
      smaVolume,
      1,
      mapper,
      classification.zoneClassification,
      classification.targetRMultiple,
    );
  });

  let m5: MutableBar | null = null;
  let m15: MutableBar | null = null;
  let h1: MutableBar | null = null;
  const feed = (candle: Candle): void => {
    candleBuffer.addCandle(candle);
    fsm.processCandle(candle);
  };
  for (const row of rows) {
    if (!initialized) {
      fsm.initialize(new Date(row.timestamp));
      initialized = true;
    }
    feed(toCandle(instrument, 'M1', row.timestamp, row.open, row.high, row.low, row.close, row.volume));
    const m5Update = updateBar(m5, row, 'M5');
    m5 = m5Update.bar;
    if (m5Update.closed) feed(barToCandle(instrument, 'M5', m5Update.closed));
    const m15Update = updateBar(m15, row, 'M15');
    m15 = m15Update.bar;
    if (m15Update.closed) feed(barToCandle(instrument, 'M15', m15Update.closed));
    const h1Update = updateBar(h1, row, 'H1');
    h1 = h1Update.bar;
    if (h1Update.closed) feed(barToCandle(instrument, 'H1', h1Update.closed));
  }
  evaluateOutcomes(result, rows);
  return result;
}

async function runInstrument(instrument: Instrument, csvPath: string): Promise<ProfileResult[]> {
  const rows = await readRows(csvPath);
  const tierBResult = newResult(instrument, 'tier-b-m15-structure-m5-execution', 'M15', 'M5');
  const tierCResult = newResult(instrument, 'tier-b-m5-structure-m1-execution', 'M5', 'M1');
  tierBResult.sourceRows = rows.length;
  tierCResult.sourceRows = rows.length;
  const tierB = new RelaxedProfile(instrument, 'M15', 'M5', tierBResult);
  const tierC = new RelaxedProfile(instrument, 'M5', 'M1', tierCResult);
  let m5: MutableBar | null = null;
  let m15: MutableBar | null = null;
  let h1: MutableBar | null = null;
  const counts: Record<Timeframe, number> = { M1: 0, M5: 0, M15: 0, H1: 0 };

  for (const row of rows) {
    const m1 = toCandle(instrument, 'M1', row.timestamp, row.open, row.high, row.low, row.close, row.volume);
    counts.M1++;
    tierC.process(m1);

    const m5Update = updateBar(m5, row, 'M5');
    m5 = m5Update.bar;
    if (m5Update.closed) {
      const candle = barToCandle(instrument, 'M5', m5Update.closed);
      counts.M5++;
      tierB.process(candle);
      tierC.process(candle);
    }

    const m15Update = updateBar(m15, row, 'M15');
    m15 = m15Update.bar;
    if (m15Update.closed) {
      const candle = barToCandle(instrument, 'M15', m15Update.closed);
      counts.M15++;
      tierB.process(candle);
    }

    const h1Update = updateBar(h1, row, 'H1');
    h1 = h1Update.bar;
    if (h1Update.closed) counts.H1++;
  }

  tierBResult.emittedCandles = { ...counts };
  tierCResult.emittedCandles = { ...counts };
  evaluateOutcomes(tierBResult, rows);
  evaluateOutcomes(tierCResult, rows);
  const tierA = runProductionTierA(instrument, rows, counts);
  return [tierA, tierBResult, tierCResult];
}

function buildCombinedTierBDailyCap(results: ProfileResult[]): {
  profile: string;
  maximumSignalsPerUtcDay: number;
  selection: string;
  calendarDays: number;
  zeroSignalDays: number;
  oneSignalDays: number;
  twoSignalDays: number;
  threeOrMoreSignalDays: number;
  candidateSignals: number;
  selectedSignals: number;
  winningSignals: number;
  losingSignals: number;
  totalRealizedR: number;
  averageRealizedR: number;
  profitFactor: number | null;
} {
  const profile = 'tier-b-m15-structure-m5-execution';
  const candidates = results
    .filter((result) => result.profile === profile)
    .flatMap((result) => result.signals.map((signal) => ({ ...signal, instrument: result.instrument })));
  const selected = selectSignalsWithUtcDailyCap(candidates, 2);
  const countsByDay = new Map<string, number>();
  for (const signal of candidates) {
    const dateKey = getUtcDateKey(signal.timestamp);
    countsByDay.set(dateKey, (countsByDay.get(dateKey) ?? 0) + 1);
  }

  let oneSignalDays = 0;
  let twoSignalDays = 0;
  let threeOrMoreSignalDays = 0;
  for (const count of countsByDay.values()) {
    if (count === 1) oneSignalDays++;
    else if (count === 2) twoSignalDays++;
    else if (count >= 3) threeOrMoreSignalDays++;
  }

  let positiveR = 0;
  let negativeR = 0;
  let winningSignals = 0;
  let losingSignals = 0;
  for (const signal of selected) {
    const realizedR = signal.outcome?.realizedR ?? 0;
    if (realizedR > 0) {
      positiveR += realizedR;
      winningSignals++;
    } else if (realizedR < 0) {
      negativeR += Math.abs(realizedR);
      losingSignals++;
    }
  }

  const calendarDays = Math.round((Date.parse(END_DATE) - Date.parse(START_DATE)) / (24 * 60 * 60 * 1000));
  const totalRealizedR = positiveR - negativeR;
  return {
    profile,
    maximumSignalsPerUtcDay: 2,
    selection: 'Chronological first two combined XAUUSD/BTCUSD qualifying signals per UTC day; no outcome lookahead.',
    calendarDays,
    zeroSignalDays: calendarDays - countsByDay.size,
    oneSignalDays,
    twoSignalDays,
    threeOrMoreSignalDays,
    candidateSignals: candidates.length,
    selectedSignals: selected.length,
    winningSignals,
    losingSignals,
    totalRealizedR,
    averageRealizedR: selected.length > 0 ? totalRealizedR / selected.length : 0,
    profitFactor: negativeR > 0 ? positiveR / negativeR : null,
  };
}

async function main(): Promise<void> {
  const configs: Array<{ instrument: Instrument; path: string }> = [
    {
      instrument: 'XAUUSD',
      path: resolve('data/historical/xauusd/xauusd-m1-bid-2023-07-18-2026-07-18.csv'),
    },
    {
      instrument: 'BTCUSD',
      path: resolve('data/historical/btcusd/btcusd-m1-bid-2023-07-18-2026-07-18.csv'),
    },
  ];
  const results: ProfileResult[] = [];
  for (const config of configs) {
    console.log(`[Backtest] Running ${config.instrument} from ${START_DATE} to ${END_DATE}...`);
    const instrumentResults = await runInstrument(config.instrument, config.path);
    results.push(...instrumentResults);
    for (const result of instrumentResults) {
      console.log(
        `[Backtest] ${result.profile}: ${result.qualifiedSignals} qualified ` +
        `(${result.rawSignals} raw, ${result.rejectedByVolume} volume rejects, ` +
        `${result.rejectedByRewardRisk} RR rejects, ${result.rejectedByStopPlacement} stop-side rejects), ${result.totalRealizedR.toFixed(2)}R ` +
        `from ${result.winningSignals} wins/${result.losingSignals} losses.`,
      );
    }
  }
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPath = resolve(OUTPUT_DIR, 'three-year-tiered-summary.json');
  const summary = {
    generatedAt: new Date().toISOString(),
    window: { start: START_DATE, end: END_DATE },
    dataSource: 'Dukascopy M1 bid OHLCV; M5, M15, and H1 deterministically aggregated from M1',
    methodology: {
      tierA: 'Unchanged production H1/M15 liquidity zones with production M5 FSM and production volume/target pipeline.',
      tierB: 'Relaxed M15 structure/M5 execution: two-observation minimum, one 55% body-ratio expansion, one retracement, rejection entry, volume >= 0.8 SMA20, minimum 1.5R.',
      tierC: 'Exploratory M5 structure/M1 execution using the same relaxed Tier B rules; included to measure the requested M1 frequency trade-off.',
      outcomes: 'Hypothetical TP1/TP2/breakeven simulation using M1 bid OHLC; stop-first when both levels occur in one M1 bar; no spread, fees, or slippage.',
    },
    dailyCap: buildCombinedTierBDailyCap(results),
    results,
  };
  writeFileSync(outputPath, JSON.stringify(summary, null, 2) + '\n');
  console.log(`[Backtest] Summary written to ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error('[Backtest] Fatal error:', error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
