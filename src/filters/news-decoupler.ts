/**
 * News Decoupler Filter
 *
 * Monitors high-impact USD economic events (CPI, NFP, FOMC, GDP, PPI)
 * and activates freeze windows to suppress signal generation around releases.
 *
 * Freeze window: 2 minutes before → 15 minutes after release (total 17 minutes)
 * Overlapping events are merged into a single continuous window.
 * If data source is unavailable: log warning, continue without freeze (fail open).
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7
 */

/** High-impact USD economic event types monitored by the News Decoupler */
export type NewsEventType = 'CPI' | 'NFP' | 'FOMC' | 'GDP' | 'PPI';

/** Represents a scheduled high-impact USD economic event */
export interface NewsEvent {
  name: NewsEventType;
  scheduledTime: Date;
  impact: 'high';
  currency: 'USD';
}

/** A computed freeze window with merged overlapping events */
export interface FreezeWindow {
  start: Date;
  end: Date;
  events: string[];
}

/** Status snapshot for dashboard consumption */
export interface NewsDecouplerStatus {
  freezeActive: boolean;
  currentEvent: string | null;
  freezeEnd: string | null;
}

/** Logger interface for dependency injection */
export interface NewsDecouplerLogger {
  warn(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
}

/** Default console-based logger */
const defaultLogger: NewsDecouplerLogger = {
  warn(message: string, metadata?: Record<string, unknown>): void {
    console.warn(`[NewsDecoupler] ${message}`, metadata ?? '');
  },
  info(message: string, metadata?: Record<string, unknown>): void {
    console.info(`[NewsDecoupler] ${message}`, metadata ?? '');
  },
};

/** Pre-release buffer in milliseconds (2 minutes) */
const PRE_RELEASE_BUFFER_MS = 2 * 60 * 1000;

/** Post-release buffer in milliseconds (15 minutes) */
const POST_RELEASE_BUFFER_MS = 15 * 60 * 1000;

/** Valid high-impact event types */
const VALID_EVENT_TYPES: ReadonlySet<string> = new Set([
  'CPI',
  'NFP',
  'FOMC',
  'GDP',
  'PPI',
]);

/**
 * NewsDecoupler class
 *
 * Manages freeze windows around high-impact USD economic events.
 * Merges overlapping windows and provides status queries.
 */
export class NewsDecoupler {
  private freezeWindows: FreezeWindow[] = [];
  private logger: NewsDecouplerLogger;
  private dataSourceAvailable = true;

  constructor(logger?: NewsDecouplerLogger) {
    this.logger = logger ?? defaultLogger;
  }

  /**
   * Sets the schedule of upcoming economic events.
   * Filters for valid high-impact USD events, computes freeze windows,
   * and merges overlapping windows.
   */
  setSchedule(events: NewsEvent[]): void {
    // Filter for valid high-impact USD events
    const validEvents = events.filter(
      (e) =>
        e.impact === 'high' &&
        e.currency === 'USD' &&
        VALID_EVENT_TYPES.has(e.name)
    );

    if (validEvents.length === 0) {
      this.freezeWindows = [];
      return;
    }

    // Compute individual freeze windows
    const rawWindows: FreezeWindow[] = validEvents.map((e) => ({
      start: new Date(e.scheduledTime.getTime() - PRE_RELEASE_BUFFER_MS),
      end: new Date(e.scheduledTime.getTime() + POST_RELEASE_BUFFER_MS),
      events: [e.name],
    }));

    // Sort by start time
    rawWindows.sort((a, b) => a.start.getTime() - b.start.getTime());

    // Merge overlapping windows
    this.freezeWindows = this.mergeWindows(rawWindows);

    this.dataSourceAvailable = true;
  }

  /**
   * Marks the data source as unavailable.
   * Logs a warning and continues without freeze (fail open per Requirement 7.5).
   */
  markDataSourceUnavailable(): void {
    this.dataSourceAvailable = false;
    this.freezeWindows = [];
    this.logger.warn(
      'News schedule data source unavailable. Continuing without freeze window activation.',
      { timestamp: new Date().toISOString() }
    );
  }

  /**
   * Marks the data source as available again.
   */
  markDataSourceAvailable(): void {
    this.dataSourceAvailable = true;
  }

  /**
   * Returns whether the data source is currently available.
   */
  isDataSourceAvailable(): boolean {
    return this.dataSourceAvailable;
  }

  /**
   * Checks if a freeze window is currently active at the given time.
   */
  isFreezeActive(currentTime: Date): boolean {
    const time = currentTime.getTime();
    return this.freezeWindows.some(
      (w) => time >= w.start.getTime() && time < w.end.getTime()
    );
  }

  /**
   * Returns the active freeze window at the given time, or null if none active.
   */
  getActiveFreezeWindow(
    currentTime: Date
  ): { start: Date; end: Date; events: string[] } | null {
    const time = currentTime.getTime();
    const active = this.freezeWindows.find(
      (w) => time >= w.start.getTime() && time < w.end.getTime()
    );
    return active ?? null;
  }

  /**
   * Returns the current status for dashboard consumption.
   */
  getStatus(currentTime?: Date): NewsDecouplerStatus {
    const now = currentTime ?? new Date();
    const active = this.getActiveFreezeWindow(now);

    if (active) {
      return {
        freezeActive: true,
        currentEvent: active.events.join(', '),
        freezeEnd: active.end.toISOString(),
      };
    }

    return {
      freezeActive: false,
      currentEvent: null,
      freezeEnd: null,
    };
  }

  /**
   * Returns all computed freeze windows (for testing/debugging).
   */
  getFreezeWindows(): FreezeWindow[] {
    return [...this.freezeWindows];
  }

  /**
   * Logs activation of a freeze window.
   */
  logActivation(currentTime: Date): void {
    const window = this.getActiveFreezeWindow(currentTime);
    if (window) {
      this.logger.info('News freeze window ACTIVATED', {
        events: window.events,
        freezeStart: window.start.toISOString(),
        freezeEnd: window.end.toISOString(),
        activatedAt: currentTime.toISOString(),
      });
    }
  }

  /**
   * Logs deactivation of a freeze window.
   */
  logDeactivation(currentTime: Date, window: FreezeWindow): void {
    this.logger.info('News freeze window DEACTIVATED', {
      events: window.events,
      freezeStart: window.start.toISOString(),
      freezeEnd: window.end.toISOString(),
      deactivatedAt: currentTime.toISOString(),
    });
  }

  /**
   * Merges overlapping freeze windows into single continuous windows.
   * Two windows overlap if one starts before the other ends.
   */
  private mergeWindows(sortedWindows: FreezeWindow[]): FreezeWindow[] {
    if (sortedWindows.length === 0) return [];

    const merged: FreezeWindow[] = [];
    let current = { ...sortedWindows[0], events: [...sortedWindows[0].events] };

    for (let i = 1; i < sortedWindows.length; i++) {
      const next = sortedWindows[i];

      // If windows overlap or are adjacent (next starts before current ends)
      if (next.start.getTime() <= current.end.getTime()) {
        // Merge: extend end to the later of the two, combine events
        if (next.end.getTime() > current.end.getTime()) {
          current.end = next.end;
        }
        current.events.push(...next.events);
      } else {
        // No overlap — push current window and start a new one
        merged.push(current);
        current = { ...next, events: [...next.events] };
      }
    }

    merged.push(current);
    return merged;
  }
}
