/**
 * Soft daily signal target tracking.
 *
 * This module measures qualified signals per UTC day. It never creates,
 * suppresses, or alters signals; it only reports whether the configured daily
 * target was met.
 */

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

/**
 * Tracks qualified signals for the current UTC day.
 * A qualified signal is recorded only after it passes the complete pipeline.
 */
export class DailySignalTargetTracker {
  private readonly config: DailySignalTargetConfig;
  private dateKey: string;
  private qualifiedSignals = 0;

  constructor(
    config: DailySignalTargetConfig = DEFAULT_DAILY_SIGNAL_TARGET,
    initialTimestamp: Date | string = new Date(),
  ) {
    if (!Number.isInteger(config.minSignalsPerUtcDay) || config.minSignalsPerUtcDay < 0) {
      throw new Error('minSignalsPerUtcDay must be a non-negative integer');
    }
    if (!Number.isInteger(config.maxSignalsPerUtcDay) || config.maxSignalsPerUtcDay < 0) {
      throw new Error('maxSignalsPerUtcDay must be a non-negative integer');
    }
    if (config.maxSignalsPerUtcDay < config.minSignalsPerUtcDay) {
      throw new Error('maxSignalsPerUtcDay must be greater than or equal to minSignalsPerUtcDay');
    }

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

  /** Record one signal that passed the complete signal pipeline. */
  recordQualifiedSignal(timestamp: Date | string): DailySignalTargetStatus {
    this.observe(timestamp);
    this.qualifiedSignals += 1;
    return this.getStatus();
  }

  getStatus(timestamp?: Date | string): DailySignalTargetStatus {
    if (timestamp !== undefined) {
      this.observe(timestamp);
    }

    return {
      dateKey: this.dateKey,
      qualifiedSignals: this.qualifiedSignals,
      minimum: this.config.minSignalsPerUtcDay,
      maximum: this.config.maxSignalsPerUtcDay,
      minimumMet: this.qualifiedSignals >= this.config.minSignalsPerUtcDay,
      maximumReached: this.qualifiedSignals >= this.config.maxSignalsPerUtcDay,
    };
  }
}
