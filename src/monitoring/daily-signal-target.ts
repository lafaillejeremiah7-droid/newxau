/**
 * UTC-day signal targeting and hard-cap coordination.
 *
 * The minimum is an observational target: the engine never fabricates a signal
 * when no valid setup exists. The maximum is enforced before any signal output.
 * SharedDailySignalCap persists reservations so isolated XAUUSD and BTCUSD
 * runtimes use one combined UTC-day counter.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export interface DailySignalTargetConfig {
  minSignalsPerUtcDay: number;
  maxSignalsPerUtcDay: number;
}

export interface DailySignalTargetStatus {
  dateKey: string;
  qualifiedSignals: number;
  minimum: number;
  maximum: number;
  minimumMet: boolean;
  maximumReached: boolean;
}

export interface DailySignalDayRollover {
  completedDay: DailySignalTargetStatus;
  currentDay: DailySignalTargetStatus;
}

export interface DailySignalDecision {
  accepted: boolean;
  status: DailySignalTargetStatus;
}

interface PersistedDailySignalState {
  dateKey: string;
  qualifiedSignals: number;
}

export const DEFAULT_DAILY_SIGNAL_TARGET: DailySignalTargetConfig = {
  minSignalsPerUtcDay: 1,
  maxSignalsPerUtcDay: 2,
};

/** Return a stable YYYY-MM-DD key in UTC. */
export function getUtcDateKey(timestamp: Date | string): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${String(timestamp)}`);
  }
  return date.toISOString().slice(0, 10);
}

function validateConfig(config: DailySignalTargetConfig): void {
  if (!Number.isInteger(config.minSignalsPerUtcDay) || config.minSignalsPerUtcDay < 0) {
    throw new Error('minSignalsPerUtcDay must be a non-negative integer');
  }
  if (!Number.isInteger(config.maxSignalsPerUtcDay) || config.maxSignalsPerUtcDay < 0) {
    throw new Error('maxSignalsPerUtcDay must be a non-negative integer');
  }
  if (config.maxSignalsPerUtcDay < config.minSignalsPerUtcDay) {
    throw new Error('maxSignalsPerUtcDay must be greater than or equal to minSignalsPerUtcDay');
  }
}

function makeStatus(
  config: DailySignalTargetConfig,
  dateKey: string,
  qualifiedSignals: number,
): DailySignalTargetStatus {
  return {
    dateKey,
    qualifiedSignals,
    minimum: config.minSignalsPerUtcDay,
    maximum: config.maxSignalsPerUtcDay,
    minimumMet: qualifiedSignals >= config.minSignalsPerUtcDay,
    maximumReached: qualifiedSignals >= config.maxSignalsPerUtcDay,
  };
}

/**
 * Tracks qualified signals for one runtime's current UTC day.
 * A signal is never counted above the configured maximum.
 */
export class DailySignalTargetTracker {
  private readonly config: DailySignalTargetConfig;
  private dateKey: string;
  private qualifiedSignals = 0;

  constructor(
    config: DailySignalTargetConfig = DEFAULT_DAILY_SIGNAL_TARGET,
    initialTimestamp: Date | string = new Date(),
  ) {
    validateConfig(config);
    this.config = { ...config };
    this.dateKey = getUtcDateKey(initialTimestamp);
  }

  /** Observe a timestamp and report a completed day when UTC rolls over. */
  observe(timestamp: Date | string): DailySignalDayRollover | null {
    const nextDateKey = getUtcDateKey(timestamp);
    if (nextDateKey === this.dateKey) {
      return null;
    }

    const completedDay = this.getStatus();
    this.dateKey = nextDateKey;
    this.qualifiedSignals = 0;

    return {
      completedDay,
      currentDay: this.getStatus(),
    };
  }

  /** Atomically accept one signal unless this runtime has reached its maximum. */
  tryRecordQualifiedSignal(timestamp: Date | string): DailySignalDecision {
    this.observe(timestamp);
    if (this.qualifiedSignals >= this.config.maxSignalsPerUtcDay) {
      return { accepted: false, status: this.getStatus() };
    }

    this.qualifiedSignals += 1;
    return { accepted: true, status: this.getStatus() };
  }

  /** Record one signal, retaining the legacy status-only API. */
  recordQualifiedSignal(timestamp: Date | string): DailySignalTargetStatus {
    return this.tryRecordQualifiedSignal(timestamp).status;
  }

  getStatus(timestamp?: Date | string): DailySignalTargetStatus {
    if (timestamp !== undefined) {
      this.observe(timestamp);
    }

    return makeStatus(this.config, this.dateKey, this.qualifiedSignals);
  }
}

/**
 * Cross-process UTC-day cap used by the isolated XAUUSD and BTCUSD runtimes.
 * Reservations are serialized with a short-lived lock file and persisted to
 * disk, so a restart cannot reset the combined daily count.
 */
export class SharedDailySignalCap {
  private readonly config: DailySignalTargetConfig;
  private readonly statePath: string;
  private readonly lockPath: string;

  constructor(
    config: DailySignalTargetConfig = DEFAULT_DAILY_SIGNAL_TARGET,
    statePath = './data/daily-signal-cap.json',
  ) {
    validateConfig(config);
    this.config = { ...config };
    this.statePath = statePath;
    this.lockPath = `${statePath}.lock`;
    mkdirSync(dirname(this.statePath), { recursive: true });
  }

  /** Reserve one qualified signal, returning false after the daily cap. */
  tryRecordQualifiedSignal(timestamp: Date | string): DailySignalDecision {
    const dateKey = getUtcDateKey(timestamp);
    return this.withLockedState((state) => {
      const current = this.forDate(state, dateKey);
      if (current.qualifiedSignals >= this.config.maxSignalsPerUtcDay) {
        return {
          accepted: false,
          status: makeStatus(this.config, dateKey, current.qualifiedSignals),
        };
      }

      current.qualifiedSignals += 1;
      return { accepted: true, status: makeStatus(this.config, dateKey, current.qualifiedSignals) };
    });
  }

  /** Read the shared status and roll stale state to the requested UTC date. */
  getStatus(timestamp: Date | string = new Date()): DailySignalTargetStatus {
    const dateKey = getUtcDateKey(timestamp);
    return this.withLockedState((state) => {
      const current = this.forDate(state, dateKey);
      return makeStatus(this.config, dateKey, current.qualifiedSignals);
    });
  }

  private forDate(state: PersistedDailySignalState, dateKey: string): PersistedDailySignalState {
    if (state.dateKey !== dateKey) {
      state.dateKey = dateKey;
      state.qualifiedSignals = 0;
    }
    return state;
  }

  private readState(): PersistedDailySignalState {
    if (!existsSync(this.statePath)) {
      return { dateKey: getUtcDateKey(new Date()), qualifiedSignals: 0 };
    }

    try {
      const parsed = JSON.parse(
        readFileSync(this.statePath, 'utf8'),
      ) as Partial<PersistedDailySignalState>;
      const qualifiedSignals = parsed.qualifiedSignals;
      if (
        typeof parsed.dateKey === 'string' &&
        typeof qualifiedSignals === 'number' &&
        Number.isInteger(qualifiedSignals) &&
        qualifiedSignals >= 0
      ) {
        return { dateKey: parsed.dateKey, qualifiedSignals };
      }
    } catch {
      // A corrupt state file is safely replaced under the lock.
    }
    return { dateKey: getUtcDateKey(new Date()), qualifiedSignals: 0 };
  }

  private writeState(state: PersistedDailySignalState): void {
    const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(state) + '\n', 'utf8');
    renameSync(temporaryPath, this.statePath);
  }

  private withLockedState<T>(operation: (state: PersistedDailySignalState) => T): T {
    mkdirSync(dirname(this.statePath), { recursive: true });
    let lockFd: number | null = null;
    const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        lockFd = openSync(this.lockPath, 'wx');
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > 30_000) unlinkSync(this.lockPath);
        } catch {
          // The lock may have been released between stat and unlink.
        }
        Atomics.wait(waitBuffer, 0, 0, 5);
      }
    }

    if (lockFd === null) {
      throw new Error(`Unable to acquire daily signal cap lock: ${this.lockPath}`);
    }

    try {
      const state = this.readState();
      const result = operation(state);
      this.writeState(state);
      return result;
    } finally {
      closeSync(lockFd);
      try {
        unlinkSync(this.lockPath);
      } catch {
        // Another cleanup path may already have removed a stale lock.
      }
    }
  }
}

/** Select at most `maximum` chronologically ordered signals per UTC day. */
export function selectSignalsWithUtcDailyCap<T extends { timestamp: string }>(
  signals: readonly T[],
  maximum: number,
): T[] {
  if (!Number.isInteger(maximum) || maximum < 0) {
    throw new Error('maximum must be a non-negative integer');
  }

  const counts = new Map<string, number>();
  return [...signals]
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
    .filter((signal) => {
      const dateKey = getUtcDateKey(signal.timestamp);
      const count = counts.get(dateKey) ?? 0;
      if (count >= maximum) return false;
      counts.set(dateKey, count + 1);
      return true;
    });
}
