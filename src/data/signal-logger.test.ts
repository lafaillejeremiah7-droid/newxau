/**
 * Unit tests for SqliteSignalLogger.
 * Verifies schema creation, retention cleanup, and basic logging operations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SqliteSignalLogger } from './signal-logger.js';
import type { RejectionLog, FilterEvent } from './signal-logger.js';
import type { FormattedSignal } from '../types/signal.js';
import type { StateTransition } from '../types/state.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

/** Helper to create a temporary database path */
function createTempDbPath(): string {
  const tmpDir = os.tmpdir();
  return path.join(tmpDir, `signal-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

/** Helper to create a minimal FormattedSignal for testing */
function createTestSignal(overrides: Partial<FormattedSignal> = {}): FormattedSignal {
  return {
    id: `sig-${Date.now()}`,
    timestamp: new Date().toISOString(),
    instrument: 'XAUUSD',
    direction: 'long',
    entryPrice: 2350.5,
    stopLoss: 2348.0,
    ticket1: {
      label: 'Safety Lock',
      positionSizePercent: 45,
      entryPrice: 2350.5,
      stopLoss: 2348.0,
      takeProfit: 2352.625,
    },
    ticket2: {
      label: 'Runner',
      positionSizePercent: 55,
      entryPrice: 2350.5,
      stopLoss: 2348.0,
      takeProfit: 2356.57,
    },
    zoneClassification: 'expansion_zone',
    riskAmount: 35.0,
    rUnit: 2.5,
    reasoning: 'Bullish rejection at H1 support zone with expansion',
    slippage: {
      applied: false,
      originalEntry: 2350.5,
      adjustedEntry: 2350.5,
      slippagePips: 0,
    },
    breakevenTrigger: 'Move Ticket 2 SL to entry when price reaches TP1',
    trailingStopGuidance: 'Trail to most recent M5 swing low after breakeven',
    ...overrides,
  };
}

describe('SqliteSignalLogger', () => {
  let dbPath: string;
  let logger: SqliteSignalLogger;

  beforeEach(() => {
    dbPath = createTempDbPath();
    logger = new SqliteSignalLogger(dbPath);
  });

  afterEach(() => {
    logger.close();
    // Clean up temp database files
    try {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
      if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Schema Initialization', () => {
    it('should create all four tables on initialization', () => {
      const db = logger.getDatabase();
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        .all() as Array<{ name: string }>;

      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain('signals');
      expect(tableNames).toContain('rejections');
      expect(tableNames).toContain('state_transitions');
      expect(tableNames).toContain('filter_events');
    });

    it('should create indexes on timestamp columns', () => {
      const db = logger.getDatabase();
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name"
        )
        .all() as Array<{ name: string }>;

      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_signals_timestamp');
      expect(indexNames).toContain('idx_rejections_timestamp');
      expect(indexNames).toContain('idx_state_transitions_timestamp');
      expect(indexNames).toContain('idx_filter_events_timestamp');
    });

    it('should not fail if called multiple times (IF NOT EXISTS)', () => {
      // Close and re-open with the same db path
      logger.close();
      const logger2 = new SqliteSignalLogger(dbPath);
      const db = logger2.getDatabase();
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )
        .all() as Array<{ name: string }>;

      expect(tables.length).toBeGreaterThanOrEqual(4);
      logger2.close();
    });

    it('should enforce direction CHECK constraint on signals table', () => {
      const db = logger.getDatabase();
      expect(() => {
        db.prepare(
          `INSERT INTO signals (id, timestamp, direction, entry_price, stop_loss, tp1, tp2, zone_classification, risk_amount, r_unit, reasoning)
           VALUES ('test', '2024-01-01T00:00:00.000Z', 'invalid', 100, 100, 100, 100, 'chop_zone', 35, 2.5, 'test')`
        ).run();
      }).toThrow();
    });

    it('should enforce action CHECK constraint on filter_events table', () => {
      const db = logger.getDatabase();
      expect(() => {
        db.prepare(
          `INSERT INTO filter_events (filter_name, action, timestamp)
           VALUES ('time_gate', 'invalid_action', '2024-01-01T00:00:00.000Z')`
        ).run();
      }).toThrow();
    });
  });

  describe('Retention Cleanup', () => {
    it('should delete records older than 90 days', async () => {
      const db = logger.getDatabase();

      // Insert a record with a timestamp 100 days ago
      const oldTimestamp = new Date(
        Date.now() - 100 * 24 * 60 * 60 * 1000
      ).toISOString();
      const recentTimestamp = new Date().toISOString();

      // Insert old signal
      db.prepare(
        `INSERT INTO signals (id, timestamp, direction, entry_price, stop_loss, tp1, tp2, zone_classification, risk_amount, r_unit, reasoning)
         VALUES (?, ?, 'long', 2350, 2348, 2352, 2356, 'expansion_zone', 35, 2.5, 'test')`
      ).run('old-signal', oldTimestamp);

      // Insert recent signal
      db.prepare(
        `INSERT INTO signals (id, timestamp, direction, entry_price, stop_loss, tp1, tp2, zone_classification, risk_amount, r_unit, reasoning)
         VALUES (?, ?, 'short', 2350, 2352, 2348, 2344, 'chop_zone', 35, 2.5, 'test')`
      ).run('recent-signal', recentTimestamp);

      // Insert old rejection
      db.prepare(
        `INSERT INTO rejections (timestamp, reason, filter_name, context_json)
         VALUES (?, 'low volume', 'volume_filter', '{}')`
      ).run(oldTimestamp);

      // Insert recent rejection
      db.prepare(
        `INSERT INTO rejections (timestamp, reason, filter_name, context_json)
         VALUES (?, 'low volume', 'volume_filter', '{}')`
      ).run(recentTimestamp);

      // Insert old state transition
      db.prepare(
        `INSERT INTO state_transitions (timestamp, from_state, to_state, reason)
         VALUES (?, 'scanning', 'observation', 'zone entry')`
      ).run(oldTimestamp);

      // Insert recent state transition
      db.prepare(
        `INSERT INTO state_transitions (timestamp, from_state, to_state, reason)
         VALUES (?, 'scanning', 'observation', 'zone entry')`
      ).run(recentTimestamp);

      // Insert old filter event
      db.prepare(
        `INSERT INTO filter_events (filter_name, action, timestamp, duration_seconds, metadata_json)
         VALUES ('time_gate', 'activated', ?, NULL, '{}')`
      ).run(oldTimestamp);

      // Insert recent filter event
      db.prepare(
        `INSERT INTO filter_events (filter_name, action, timestamp, duration_seconds, metadata_json)
         VALUES ('time_gate', 'deactivated', ?, 18000, '{}')`
      ).run(recentTimestamp);

      // Run retention cleanup
      logger.runRetentionCleanup();

      // Verify old records are gone, recent ones remain
      const signals = db.prepare('SELECT id FROM signals').all() as Array<{ id: string }>;
      expect(signals.length).toBe(1);
      expect(signals[0].id).toBe('recent-signal');

      const rejections = db.prepare('SELECT id FROM rejections').all() as Array<{ id: number }>;
      expect(rejections.length).toBe(1);

      const transitions = db.prepare('SELECT id FROM state_transitions').all() as Array<{ id: number }>;
      expect(transitions.length).toBe(1);

      const filterEvents = db.prepare('SELECT id FROM filter_events').all() as Array<{ id: number }>;
      expect(filterEvents.length).toBe(1);
    });

    it('should keep records exactly at the 90-day boundary', () => {
      const db = logger.getDatabase();

      // Insert a record at exactly 89 days ago (should be kept)
      const borderTimestamp = new Date(
        Date.now() - 89 * 24 * 60 * 60 * 1000
      ).toISOString();

      db.prepare(
        `INSERT INTO signals (id, timestamp, direction, entry_price, stop_loss, tp1, tp2, zone_classification, risk_amount, r_unit, reasoning)
         VALUES (?, ?, 'long', 2350, 2348, 2352, 2356, 'expansion_zone', 35, 2.5, 'test')`
      ).run('border-signal', borderTimestamp);

      logger.runRetentionCleanup();

      const signals = db.prepare('SELECT id FROM signals').all() as Array<{ id: string }>;
      expect(signals.length).toBe(1);
      expect(signals[0].id).toBe('border-signal');
    });

    it('should support custom retention periods', () => {
      logger.close();
      // Create a logger with a 30-day retention period
      const shortRetentionLogger = new SqliteSignalLogger(dbPath, 30);
      const db = shortRetentionLogger.getDatabase();

      // Insert a record 40 days old (should be deleted with 30-day retention)
      const oldTimestamp = new Date(
        Date.now() - 40 * 24 * 60 * 60 * 1000
      ).toISOString();

      db.prepare(
        `INSERT INTO signals (id, timestamp, direction, entry_price, stop_loss, tp1, tp2, zone_classification, risk_amount, r_unit, reasoning)
         VALUES (?, ?, 'short', 2350, 2352, 2348, 2344, 'chop_zone', 35, 2.5, 'test')`
      ).run('old-signal', oldTimestamp);

      shortRetentionLogger.runRetentionCleanup();

      const signals = db.prepare('SELECT id FROM signals').all();
      expect(signals.length).toBe(0);

      shortRetentionLogger.close();
    });

    it('should run cleanup on startup', () => {
      // Insert old data, close, and reopen to verify cleanup on startup
      const db = logger.getDatabase();
      const oldTimestamp = new Date(
        Date.now() - 100 * 24 * 60 * 60 * 1000
      ).toISOString();

      db.prepare(
        `INSERT INTO signals (id, timestamp, direction, entry_price, stop_loss, tp1, tp2, zone_classification, risk_amount, r_unit, reasoning)
         VALUES (?, ?, 'long', 2350, 2348, 2352, 2356, 'expansion_zone', 35, 2.5, 'test')`
      ).run('startup-old-signal', oldTimestamp);

      logger.close();

      // Re-open (should run cleanup in constructor)
      const logger2 = new SqliteSignalLogger(dbPath);
      const db2 = logger2.getDatabase();

      const signals = db2.prepare('SELECT id FROM signals').all();
      expect(signals.length).toBe(0);

      logger2.close();
    });
  });

  describe('logSignal', () => {
    it('should persist a formatted signal to the database', async () => {
      const signal = createTestSignal({ id: 'test-sig-001' });
      await logger.logSignal(signal);

      const db = logger.getDatabase();
      const row = db.prepare('SELECT * FROM signals WHERE id = ?').get('test-sig-001') as Record<string, unknown>;

      expect(row).toBeDefined();
      expect(row.direction).toBe('long');
      expect(row.entry_price).toBe(2350.5);
      expect(row.stop_loss).toBe(2348.0);
      expect(row.tp1).toBe(2352.625);
      expect(row.tp2).toBe(2356.57);
      expect(row.zone_classification).toBe('expansion_zone');
      expect(row.risk_amount).toBe(35.0);
      expect(row.r_unit).toBe(2.5);
      expect(row.reasoning).toBe('Bullish rejection at H1 support zone with expansion');
      expect(row.slippage_applied).toBe(0);
      expect(row.slippage_pips).toBe(0);
      expect(row.ticket1_size_pct).toBe(45);
      expect(row.ticket2_size_pct).toBe(55);
    });

    it('should persist slippage data when applied', async () => {
      const signal = createTestSignal({
        id: 'test-sig-slippage',
        slippage: {
          applied: true,
          originalEntry: 2350.5,
          adjustedEntry: 2349.3,
          slippagePips: 1.2,
        },
      });
      await logger.logSignal(signal);

      const db = logger.getDatabase();
      const row = db.prepare('SELECT * FROM signals WHERE id = ?').get('test-sig-slippage') as Record<string, unknown>;

      expect(row.slippage_applied).toBe(1);
      expect(row.slippage_pips).toBe(1.2);
      expect(row.original_entry).toBe(2350.5);
    });
  });

  describe('logRejection', () => {
    it('should persist a rejection log entry', async () => {
      const rejection: RejectionLog = {
        timestamp: new Date().toISOString(),
        reason: 'Volume below 20-period SMA',
        filter: 'volume_filter',
        context: { volume: 150, sma20: 200 },
      };

      await logger.logRejection(rejection);

      const db = logger.getDatabase();
      const row = db.prepare('SELECT * FROM rejections ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;

      expect(row).toBeDefined();
      expect(row.reason).toBe('Volume below 20-period SMA');
      expect(row.filter_name).toBe('volume_filter');
      expect(JSON.parse(row.context_json as string)).toEqual({ volume: 150, sma20: 200 });
    });
  });

  describe('logStateTransition', () => {
    it('should persist a state transition', async () => {
      const transition: StateTransition = {
        from: 'scanning',
        to: 'observation',
        reason: 'M5 close entered H1 liquidity zone',
        timestamp: new Date().toISOString(),
      };

      await logger.logStateTransition(transition);

      const db = logger.getDatabase();
      const row = db.prepare('SELECT * FROM state_transitions ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;

      expect(row).toBeDefined();
      expect(row.from_state).toBe('scanning');
      expect(row.to_state).toBe('observation');
      expect(row.reason).toBe('M5 close entered H1 liquidity zone');
    });
  });

  describe('logFilterEvent', () => {
    it('should persist a filter activation event', async () => {
      const event: FilterEvent = {
        filterName: 'time_gate',
        action: 'activated',
        timestamp: new Date().toISOString(),
        durationSeconds: null,
        metadata: { windowStart: '12:00', windowEnd: '17:00' },
      };

      await logger.logFilterEvent(event);

      const db = logger.getDatabase();
      const row = db.prepare('SELECT * FROM filter_events ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;

      expect(row).toBeDefined();
      expect(row.filter_name).toBe('time_gate');
      expect(row.action).toBe('activated');
      expect(row.duration_seconds).toBeNull();
      expect(JSON.parse(row.metadata_json as string)).toEqual({
        windowStart: '12:00',
        windowEnd: '17:00',
      });
    });

    it('should persist a filter deactivation event with duration', async () => {
      const event: FilterEvent = {
        filterName: 'news_decoupler',
        action: 'deactivated',
        timestamp: new Date().toISOString(),
        durationSeconds: 1020,
        metadata: { event: 'NFP', scheduledTime: '2024-01-05T13:30:00.000Z' },
      };

      await logger.logFilterEvent(event);

      const db = logger.getDatabase();
      const row = db.prepare('SELECT * FROM filter_events ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;

      expect(row).toBeDefined();
      expect(row.filter_name).toBe('news_decoupler');
      expect(row.action).toBe('deactivated');
      expect(row.duration_seconds).toBe(1020);
    });
  });

  describe('ISO 8601 UTC Timestamp Format (Requirement 14.7)', () => {
    const ISO_8601_MS_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

    it('should store signal timestamps in ISO 8601 UTC with millisecond precision', async () => {
      const timestamp = '2024-06-15T14:30:45.123Z';
      const signal = createTestSignal({ id: 'ts-test-signal', timestamp });
      await logger.logSignal(signal);

      const db = logger.getDatabase();
      const row = db.prepare('SELECT timestamp FROM signals WHERE id = ?').get('ts-test-signal') as { timestamp: string };

      expect(row.timestamp).toBe(timestamp);
      expect(row.timestamp).toMatch(ISO_8601_MS_REGEX);
    });

    it('should store rejection timestamps in ISO 8601 UTC with millisecond precision', async () => {
      const timestamp = '2024-06-15T14:30:45.456Z';
      const rejection: RejectionLog = {
        timestamp,
        reason: 'Volume too low',
        filter: 'volume_filter',
        context: {},
      };
      await logger.logRejection(rejection);

      const db = logger.getDatabase();
      const row = db.prepare('SELECT timestamp FROM rejections ORDER BY id DESC LIMIT 1').get() as { timestamp: string };

      expect(row.timestamp).toBe(timestamp);
      expect(row.timestamp).toMatch(ISO_8601_MS_REGEX);
    });

    it('should store state transition timestamps in ISO 8601 UTC with millisecond precision', async () => {
      const timestamp = '2024-06-15T14:30:45.789Z';
      const transition: StateTransition = {
        from: 'suppressed',
        to: 'scanning',
        reason: 'Time gate activated',
        timestamp,
      };
      await logger.logStateTransition(transition);

      const db = logger.getDatabase();
      const row = db.prepare('SELECT timestamp FROM state_transitions ORDER BY id DESC LIMIT 1').get() as { timestamp: string };

      expect(row.timestamp).toBe(timestamp);
      expect(row.timestamp).toMatch(ISO_8601_MS_REGEX);
    });

    it('should store filter event timestamps in ISO 8601 UTC with millisecond precision', async () => {
      const timestamp = '2024-06-15T14:30:45.321Z';
      const event: FilterEvent = {
        filterName: 'circuit_breaker',
        action: 'activated',
        timestamp,
        durationSeconds: null,
        metadata: {},
      };
      await logger.logFilterEvent(event);

      const db = logger.getDatabase();
      const row = db.prepare('SELECT timestamp FROM filter_events ORDER BY id DESC LIMIT 1').get() as { timestamp: string };

      expect(row.timestamp).toBe(timestamp);
      expect(row.timestamp).toMatch(ISO_8601_MS_REGEX);
    });
  });

  describe('Chronological Ordering (Requirement 14.7)', () => {
    it('should store log entries in chronological order for signals', async () => {
      const timestamps = [
        '2024-06-15T12:00:00.100Z',
        '2024-06-15T12:05:00.200Z',
        '2024-06-15T12:10:00.300Z',
      ];

      for (let i = 0; i < timestamps.length; i++) {
        await logger.logSignal(createTestSignal({ id: `chrono-sig-${i}`, timestamp: timestamps[i] }));
      }

      const db = logger.getDatabase();
      const rows = db.prepare('SELECT timestamp FROM signals WHERE id LIKE ? ORDER BY timestamp ASC').all('chrono-sig-%') as Array<{ timestamp: string }>;

      expect(rows.length).toBe(3);
      expect(rows[0].timestamp).toBe(timestamps[0]);
      expect(rows[1].timestamp).toBe(timestamps[1]);
      expect(rows[2].timestamp).toBe(timestamps[2]);
    });

    it('should store log entries in chronological order for state transitions', async () => {
      const transitions: StateTransition[] = [
        { from: 'suppressed', to: 'scanning', reason: 'Time gate open', timestamp: '2024-06-15T12:00:00.000Z' },
        { from: 'scanning', to: 'observation', reason: 'Zone entry', timestamp: '2024-06-15T12:05:00.000Z' },
        { from: 'observation', to: 'signal_evaluation', reason: 'Rejection candle', timestamp: '2024-06-15T12:10:00.000Z' },
      ];

      for (const t of transitions) {
        await logger.logStateTransition(t);
      }

      const db = logger.getDatabase();
      const rows = db.prepare('SELECT timestamp, from_state, to_state FROM state_transitions ORDER BY timestamp ASC').all() as Array<{ timestamp: string; from_state: string; to_state: string }>;

      expect(rows.length).toBe(3);
      expect(rows[0].from_state).toBe('suppressed');
      expect(rows[1].from_state).toBe('scanning');
      expect(rows[2].from_state).toBe('observation');
      // Verify ordering
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].timestamp > rows[i - 1].timestamp).toBe(true);
      }
    });
  });

  describe('close', () => {
    it('should close the database connection', () => {
      logger.close();
      // Attempting operations after close should throw
      expect(() => {
        logger.getDatabase().prepare('SELECT 1').get();
      }).toThrow();
    });
  });
});



describe('Write Retry and Memory Buffer Fallback (Requirement 14.6)', () => {
  let dbPath: string;
  let logger: SqliteSignalLogger;

  beforeEach(() => {
    dbPath = createTempDbPath();
    logger = new SqliteSignalLogger(dbPath);
  });

  afterEach(() => {
    try {
      logger.close();
    } catch {
      // Already closed in some tests
    }
    try {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
      if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Retry Logic', () => {
    it('should succeed on first attempt for normal writes', async () => {
      const signal = createTestSignal({ id: 'retry-normal-001' });
      await logger.logSignal(signal);

      const db = logger.getDatabase();
      const row = db.prepare('SELECT id FROM signals WHERE id = ?').get('retry-normal-001') as { id: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.id).toBe('retry-normal-001');
      expect(logger.getBufferSize()).toBe(0);
    });

    it('should buffer signal entry after all retries fail when database is closed', async () => {
      const signal = createTestSignal({ id: 'retry-fail-001' });

      // Close the database to force write failures
      logger.getDatabase().close();

      // Spy on console.warn
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await logger.logSignal(signal);

      expect(logger.getBufferSize()).toBe(1);
      const buffer = logger.getMemoryBuffer();
      expect(buffer[0].type).toBe('signal');
      expect((buffer[0].data as FormattedSignal).id).toBe('retry-fail-001');

      // Verify warning was emitted
      expect(warnSpy).toHaveBeenCalledWith(
        '[SignalLogger] Write to durable storage failed after 3 retries, buffering in memory'
      );

      warnSpy.mockRestore();
    });

    it('should buffer rejection entry after all retries fail', async () => {
      const rejection: RejectionLog = {
        timestamp: new Date().toISOString(),
        reason: 'Volume below SMA',
        filter: 'volume_filter',
        context: { volume: 100 },
      };

      // Close the database to force write failures
      logger.getDatabase().close();

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await logger.logRejection(rejection);

      expect(logger.getBufferSize()).toBe(1);
      const buffer = logger.getMemoryBuffer();
      expect(buffer[0].type).toBe('rejection');
      expect((buffer[0].data as RejectionLog).reason).toBe('Volume below SMA');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('should buffer state transition entry after all retries fail', async () => {
      const transition: StateTransition = {
        from: 'scanning',
        to: 'observation',
        reason: 'Zone entry',
        timestamp: new Date().toISOString(),
      };

      logger.getDatabase().close();

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await logger.logStateTransition(transition);

      expect(logger.getBufferSize()).toBe(1);
      const buffer = logger.getMemoryBuffer();
      expect(buffer[0].type).toBe('state_transition');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('should buffer filter event entry after all retries fail', async () => {
      const event: FilterEvent = {
        filterName: 'time_gate',
        action: 'activated',
        timestamp: new Date().toISOString(),
        durationSeconds: null,
        metadata: {},
      };

      logger.getDatabase().close();

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await logger.logFilterEvent(event);

      expect(logger.getBufferSize()).toBe(1);
      const buffer = logger.getMemoryBuffer();
      expect(buffer[0].type).toBe('filter_event');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('should accumulate multiple buffered entries', async () => {
      logger.getDatabase().close();

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await logger.logSignal(createTestSignal({ id: 'buffer-acc-1' }));
      await logger.logSignal(createTestSignal({ id: 'buffer-acc-2' }));
      await logger.logRejection({
        timestamp: new Date().toISOString(),
        reason: 'test',
        filter: 'test_filter',
        context: {},
      });

      expect(logger.getBufferSize()).toBe(3);
      expect(warnSpy).toHaveBeenCalledTimes(3);

      warnSpy.mockRestore();
    });
  });

  describe('Buffer Flush on Successful Write', () => {
    it('should flush buffered entries when database recovers', async () => {
      // Create a fresh logger for this test
      const testDbPath = createTempDbPath();
      const testLogger = new SqliteSignalLogger(testDbPath);

      // We'll simulate failures by dropping a table, then recreating it
      const db = testLogger.getDatabase();

      // First log a signal successfully to confirm base functionality
      await testLogger.logSignal(createTestSignal({ id: 'base-signal' }));
      expect(testLogger.getBufferSize()).toBe(0);

      // Drop the rejections table to simulate write failure for rejections
      db.exec('DROP TABLE rejections');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // This should fail and buffer
      const rejection: RejectionLog = {
        timestamp: '2024-06-15T14:30:45.123Z',
        reason: 'Volume below SMA',
        filter: 'volume_filter',
        context: { volume: 100 },
      };
      await testLogger.logRejection(rejection);

      expect(testLogger.getBufferSize()).toBe(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // Recreate the rejections table (simulating recovery)
      db.exec(`
        CREATE TABLE rejections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          reason TEXT NOT NULL,
          filter_name TEXT NOT NULL,
          context_json TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
        )
      `);

      warnSpy.mockRestore();

      // Now do a successful write to a different table - this should trigger flush
      await testLogger.logSignal(createTestSignal({ id: 'trigger-flush-signal' }));

      // Buffer should be empty after successful flush
      expect(testLogger.getBufferSize()).toBe(0);

      // Verify the buffered rejection was written
      const row = db.prepare('SELECT * FROM rejections WHERE reason = ?').get('Volume below SMA') as Record<string, unknown> | undefined;
      expect(row).toBeDefined();
      expect(row!.filter_name).toBe('volume_filter');

      testLogger.close();
      try {
        if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
        if (fs.existsSync(testDbPath + '-wal')) fs.unlinkSync(testDbPath + '-wal');
        if (fs.existsSync(testDbPath + '-shm')) fs.unlinkSync(testDbPath + '-shm');
      } catch { /* ignore */ }
    });

    it('should retain entries in buffer if flush also fails', async () => {
      const testDbPath = createTempDbPath();
      const testLogger = new SqliteSignalLogger(testDbPath);
      const db = testLogger.getDatabase();

      // Drop rejections table
      db.exec('DROP TABLE rejections');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Buffer a rejection (will fail because table doesn't exist)
      await testLogger.logRejection({
        timestamp: '2024-06-15T14:30:45.123Z',
        reason: 'Test failure',
        filter: 'test_filter',
        context: {},
      });

      expect(testLogger.getBufferSize()).toBe(1);

      // Now do a successful signal write - flush will attempt but fail for rejection
      // because the table still doesn't exist
      await testLogger.logSignal(createTestSignal({ id: 'flush-fail-signal' }));

      // The rejection should still be in the buffer since it can't be flushed
      expect(testLogger.getBufferSize()).toBe(1);

      warnSpy.mockRestore();
      testLogger.close();
      try {
        if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
        if (fs.existsSync(testDbPath + '-wal')) fs.unlinkSync(testDbPath + '-wal');
        if (fs.existsSync(testDbPath + '-shm')) fs.unlinkSync(testDbPath + '-shm');
      } catch { /* ignore */ }
    });

    it('should flush multiple buffered entries of different types', async () => {
      const testDbPath = createTempDbPath();
      const testLogger = new SqliteSignalLogger(testDbPath);
      const db = testLogger.getDatabase();

      // Drop both tables to cause failures
      db.exec('DROP TABLE rejections');
      db.exec('DROP TABLE filter_events');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Buffer entries of different types
      await testLogger.logRejection({
        timestamp: '2024-06-15T14:30:45.123Z',
        reason: 'Volume low',
        filter: 'volume_filter',
        context: {},
      });
      await testLogger.logFilterEvent({
        filterName: 'time_gate',
        action: 'activated',
        timestamp: '2024-06-15T14:30:45.456Z',
        durationSeconds: null,
        metadata: {},
      });

      expect(testLogger.getBufferSize()).toBe(2);

      // Recreate both tables
      db.exec(`
        CREATE TABLE rejections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          reason TEXT NOT NULL,
          filter_name TEXT NOT NULL,
          context_json TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
        )
      `);
      db.exec(`
        CREATE TABLE filter_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filter_name TEXT NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('activated', 'deactivated')),
          timestamp TEXT NOT NULL,
          duration_seconds REAL,
          metadata_json TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
        )
      `);

      warnSpy.mockRestore();

      // Trigger flush with a successful signal write
      await testLogger.logSignal(createTestSignal({ id: 'multi-flush-trigger' }));

      // Buffer should be empty
      expect(testLogger.getBufferSize()).toBe(0);

      // Verify both entries were flushed
      const rejections = db.prepare('SELECT * FROM rejections').all();
      expect(rejections.length).toBe(1);

      const filterEvents = db.prepare('SELECT * FROM filter_events').all();
      expect(filterEvents.length).toBe(1);

      testLogger.close();
      try {
        if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
        if (fs.existsSync(testDbPath + '-wal')) fs.unlinkSync(testDbPath + '-wal');
        if (fs.existsSync(testDbPath + '-shm')) fs.unlinkSync(testDbPath + '-shm');
      } catch { /* ignore */ }
    });
  });

  describe('Warning Emission', () => {
    it('should emit correct warning message on write failure', async () => {
      logger.getDatabase().close();

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await logger.logSignal(createTestSignal({ id: 'warn-test' }));

      expect(warnSpy).toHaveBeenCalledWith(
        '[SignalLogger] Write to durable storage failed after 3 retries, buffering in memory'
      );

      warnSpy.mockRestore();
    });

    it('should emit one warning per failed write operation', async () => {
      logger.getDatabase().close();

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await logger.logSignal(createTestSignal({ id: 'warn-multi-1' }));
      await logger.logSignal(createTestSignal({ id: 'warn-multi-2' }));

      expect(warnSpy).toHaveBeenCalledTimes(2);

      warnSpy.mockRestore();
    });
  });

  describe('Configurable Max Retries', () => {
    it('should respect custom maxRetries parameter', async () => {
      const customDbPath = createTempDbPath();
      // Create logger with 1 retry
      const customLogger = new SqliteSignalLogger(customDbPath, 90, 1);

      // Drop a table
      const db = customLogger.getDatabase();
      db.exec('DROP TABLE signals');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await customLogger.logSignal(createTestSignal({ id: 'custom-retry' }));

      // Should buffer after just 1 attempt (maxRetries = 1)
      expect(customLogger.getBufferSize()).toBe(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);

      warnSpy.mockRestore();
      customLogger.close();
      try {
        if (fs.existsSync(customDbPath)) fs.unlinkSync(customDbPath);
        if (fs.existsSync(customDbPath + '-wal')) fs.unlinkSync(customDbPath + '-wal');
        if (fs.existsSync(customDbPath + '-shm')) fs.unlinkSync(customDbPath + '-shm');
      } catch { /* ignore */ }
    });
  });
});
