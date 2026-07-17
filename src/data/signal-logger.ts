/**
 * Signal Logger - SQLite-based durable storage for signals, rejections,
 * state transitions, and filter events.
 *
 * Implements the SignalLogger interface from the design specification.
 * Uses better-sqlite3 for synchronous, file-based persistence.
 */

import Database from 'better-sqlite3';
import type { FormattedSignal } from '../types/signal.js';
import type { StateTransition } from '../types/state.js';

/** Rejection log entry */
export interface RejectionLog {
  timestamp: string; // ISO 8601 UTC ms
  reason: string;
  filter: string;
  context: Record<string, unknown>;
}

/** Filter event log entry */
export interface FilterEvent {
  filterName: string;
  action: 'activated' | 'deactivated';
  timestamp: string; // ISO 8601 UTC ms
  durationSeconds: number | null;
  metadata: Record<string, unknown>;
}

/** SignalLogger interface */
export interface SignalLogger {
  logSignal(signal: FormattedSignal): Promise<void>;
  logRejection(rejection: RejectionLog): Promise<void>;
  logStateTransition(transition: StateTransition): Promise<void>;
  logFilterEvent(event: FilterEvent): Promise<void>;
  runRetentionCleanup(): void;
  close(): void;
}

/** Default retention period in days */
const DEFAULT_RETENTION_DAYS = 90;

/** Default max retries on write failure */
const DEFAULT_MAX_RETRIES = 3;

/** Buffered log entry stored in memory when all retries fail */
export interface BufferedEntry {
  type: 'signal' | 'rejection' | 'state_transition' | 'filter_event';
  data: unknown;
}

/**
 * SQLite-based SignalLogger implementation.
 * Initializes database schema on construction, supports 90-day retention cleanup.
 * Includes write retry logic and in-memory buffer fallback per Requirement 14.6.
 */
export class SqliteSignalLogger implements SignalLogger {
  private db: Database.Database;
  private retentionDays: number;
  private maxRetries: number;
  private memoryBuffer: BufferedEntry[] = [];

  constructor(
    dbPath: string,
    retentionDays: number = DEFAULT_RETENTION_DAYS,
    maxRetries: number = DEFAULT_MAX_RETRIES
  ) {
    this.retentionDays = retentionDays;
    this.maxRetries = maxRetries;
    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent read performance
    this.db.pragma('journal_mode = WAL');

    this.initializeSchema();
    this.runRetentionCleanup();
  }

  /**
   * Creates all tables and indexes if they don't already exist.
   */
  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signals (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('long', 'short')),
        entry_price REAL NOT NULL,
        stop_loss REAL NOT NULL,
        tp1 REAL NOT NULL,
        tp2 REAL NOT NULL,
        zone_classification TEXT NOT NULL,
        risk_amount REAL NOT NULL,
        r_unit REAL NOT NULL,
        reasoning TEXT NOT NULL,
        slippage_applied INTEGER NOT NULL DEFAULT 0,
        slippage_pips REAL DEFAULT 0,
        original_entry REAL,
        ticket1_size_pct REAL NOT NULL DEFAULT 45,
        ticket2_size_pct REAL NOT NULL DEFAULT 55,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
      );

      CREATE TABLE IF NOT EXISTS rejections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        reason TEXT NOT NULL,
        filter_name TEXT NOT NULL,
        context_json TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
      );

      CREATE TABLE IF NOT EXISTS state_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
      );

      CREATE TABLE IF NOT EXISTS filter_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filter_name TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('activated', 'deactivated')),
        timestamp TEXT NOT NULL,
        duration_seconds REAL,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp);
      CREATE INDEX IF NOT EXISTS idx_rejections_timestamp ON rejections(timestamp);
      CREATE INDEX IF NOT EXISTS idx_state_transitions_timestamp ON state_transitions(timestamp);
      CREATE INDEX IF NOT EXISTS idx_filter_events_timestamp ON filter_events(timestamp);
    `);
  }

  /**
   * Runs 90-day retention cleanup, deleting records older than the retention period.
   * Called on startup and can be called periodically.
   */
  runRetentionCleanup(): void {
    const cutoffDate = new Date(
      Date.now() - this.retentionDays * 24 * 60 * 60 * 1000
    );
    const cutoffIso = cutoffDate.toISOString();

    const deleteSignals = this.db.prepare(
      'DELETE FROM signals WHERE timestamp < ?'
    );
    const deleteRejections = this.db.prepare(
      'DELETE FROM rejections WHERE timestamp < ?'
    );
    const deleteStateTransitions = this.db.prepare(
      'DELETE FROM state_transitions WHERE timestamp < ?'
    );
    const deleteFilterEvents = this.db.prepare(
      'DELETE FROM filter_events WHERE timestamp < ?'
    );

    const runCleanup = this.db.transaction(() => {
      deleteSignals.run(cutoffIso);
      deleteRejections.run(cutoffIso);
      deleteStateTransitions.run(cutoffIso);
      deleteFilterEvents.run(cutoffIso);
    });

    runCleanup();
  }

  /**
   * Executes a synchronous database write operation with retry logic.
   * On failure, retries up to maxRetries times. If all retries fail,
   * buffers the entry in memory and emits a warning.
   *
   * @param fn - The synchronous write operation to execute
   * @param entry - The buffered entry to store if all retries fail
   * @returns true if the write succeeded (possibly after retries), false if buffered
   */
  private executeWithRetry(fn: () => void, entry: BufferedEntry): boolean {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        fn();
        // Write succeeded - flush any buffered entries
        this.flushBuffer();
        return true;
      } catch {
        if (attempt === this.maxRetries) {
          // All retries exhausted - buffer in memory and emit warning
          this.memoryBuffer.push(entry);
          console.warn(
            '[SignalLogger] Write to durable storage failed after 3 retries, buffering in memory'
          );
          return false;
        }
        // Retry on next iteration
      }
    }
    return false;
  }

  /**
   * Attempts to flush all buffered entries to the database.
   * Called after each successful write operation.
   * Entries that still fail to write remain in the buffer.
   */
  private flushBuffer(): void {
    if (this.memoryBuffer.length === 0) return;

    const remaining: BufferedEntry[] = [];

    for (const entry of this.memoryBuffer) {
      try {
        this.writeEntry(entry);
      } catch {
        // If flush fails for this entry, keep it in buffer
        remaining.push(entry);
      }
    }

    this.memoryBuffer = remaining;
  }

  /**
   * Directly writes a buffered entry to the database (no retry logic).
   * Used internally by flushBuffer.
   */
  private writeEntry(entry: BufferedEntry): void {
    switch (entry.type) {
      case 'signal': {
        const signal = entry.data as FormattedSignal;
        this.db.prepare(`
          INSERT INTO signals (
            id, timestamp, direction, entry_price, stop_loss, tp1, tp2,
            zone_classification, risk_amount, r_unit, reasoning,
            slippage_applied, slippage_pips, original_entry,
            ticket1_size_pct, ticket2_size_pct
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          signal.id,
          signal.timestamp,
          signal.direction,
          signal.entryPrice,
          signal.stopLoss,
          signal.ticket1.takeProfit,
          signal.ticket2.takeProfit,
          signal.zoneClassification,
          signal.riskAmount,
          signal.rUnit,
          signal.reasoning,
          signal.slippage.applied ? 1 : 0,
          signal.slippage.slippagePips,
          signal.slippage.originalEntry,
          signal.ticket1.positionSizePercent,
          signal.ticket2.positionSizePercent
        );
        break;
      }
      case 'rejection': {
        const rejection = entry.data as RejectionLog;
        this.db.prepare(`
          INSERT INTO rejections (timestamp, reason, filter_name, context_json)
          VALUES (?, ?, ?, ?)
        `).run(
          rejection.timestamp,
          rejection.reason,
          rejection.filter,
          JSON.stringify(rejection.context)
        );
        break;
      }
      case 'state_transition': {
        const transition = entry.data as StateTransition;
        this.db.prepare(`
          INSERT INTO state_transitions (timestamp, from_state, to_state, reason)
          VALUES (?, ?, ?, ?)
        `).run(
          transition.timestamp,
          transition.from,
          transition.to,
          transition.reason
        );
        break;
      }
      case 'filter_event': {
        const event = entry.data as FilterEvent;
        this.db.prepare(`
          INSERT INTO filter_events (filter_name, action, timestamp, duration_seconds, metadata_json)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          event.filterName,
          event.action,
          event.timestamp,
          event.durationSeconds,
          JSON.stringify(event.metadata)
        );
        break;
      }
    }
  }

  /**
   * Logs a formatted signal to the database with retry logic.
   */
  async logSignal(signal: FormattedSignal): Promise<void> {
    const entry: BufferedEntry = { type: 'signal', data: signal };
    this.executeWithRetry(() => {
      this.db.prepare(`
        INSERT INTO signals (
          id, timestamp, direction, entry_price, stop_loss, tp1, tp2,
          zone_classification, risk_amount, r_unit, reasoning,
          slippage_applied, slippage_pips, original_entry,
          ticket1_size_pct, ticket2_size_pct
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        signal.id,
        signal.timestamp,
        signal.direction,
        signal.entryPrice,
        signal.stopLoss,
        signal.ticket1.takeProfit,
        signal.ticket2.takeProfit,
        signal.zoneClassification,
        signal.riskAmount,
        signal.rUnit,
        signal.reasoning,
        signal.slippage.applied ? 1 : 0,
        signal.slippage.slippagePips,
        signal.slippage.originalEntry,
        signal.ticket1.positionSizePercent,
        signal.ticket2.positionSizePercent
      );
    }, entry);
  }

  /**
   * Logs a rejection event to the database with retry logic.
   */
  async logRejection(rejection: RejectionLog): Promise<void> {
    const entry: BufferedEntry = { type: 'rejection', data: rejection };
    this.executeWithRetry(() => {
      this.db.prepare(`
        INSERT INTO rejections (timestamp, reason, filter_name, context_json)
        VALUES (?, ?, ?, ?)
      `).run(
        rejection.timestamp,
        rejection.reason,
        rejection.filter,
        JSON.stringify(rejection.context)
      );
    }, entry);
  }

  /**
   * Logs a state transition event to the database with retry logic.
   */
  async logStateTransition(transition: StateTransition): Promise<void> {
    const entry: BufferedEntry = { type: 'state_transition', data: transition };
    this.executeWithRetry(() => {
      this.db.prepare(`
        INSERT INTO state_transitions (timestamp, from_state, to_state, reason)
        VALUES (?, ?, ?, ?)
      `).run(
        transition.timestamp,
        transition.from,
        transition.to,
        transition.reason
      );
    }, entry);
  }

  /**
   * Logs a filter event to the database with retry logic.
   */
  async logFilterEvent(event: FilterEvent): Promise<void> {
    const entry: BufferedEntry = { type: 'filter_event', data: event };
    this.executeWithRetry(() => {
      this.db.prepare(`
        INSERT INTO filter_events (filter_name, action, timestamp, duration_seconds, metadata_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        event.filterName,
        event.action,
        event.timestamp,
        event.durationSeconds,
        JSON.stringify(event.metadata)
      );
    }, entry);
  }

  /**
   * Returns the underlying database instance (for testing purposes).
   */
  getDatabase(): Database.Database {
    return this.db;
  }

  /**
   * Returns the current in-memory buffer contents (for testing/monitoring purposes).
   */
  getMemoryBuffer(): ReadonlyArray<BufferedEntry> {
    return this.memoryBuffer;
  }

  /**
   * Returns the current buffer size (for monitoring).
   */
  getBufferSize(): number {
    return this.memoryBuffer.length;
  }

  /**
   * Closes the database connection.
   */
  close(): void {
    this.db.close();
  }
}
