/**
 * Unit tests for Signal Engine FSM
 *
 * Covers:
 * - Initial state based on time (within/outside active window)
 * - Basic state transitions (scanning → observation, observation → scanning, etc.)
 * - Event emission on state change (EventBus and handler callbacks)
 * - Time Gate deactivation handling
 * - News freeze handling
 * - Observation timeout (6 candles)
 * - Zone breakthrough
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SignalEngineFSM } from './signal-engine-fsm.js';
import { EventBus } from './event-bus.js';
import { TimeGate } from '../filters/time-gate.js';
import { NewsDecoupler } from '../filters/news-decoupler.js';
import { LiquidityZoneDetector } from './liquidity-zone-detector.js';
import { createCandlePatternAnalyzer } from './candle-pattern-analyzer.js';
import { CandleBufferManager } from '../data/candle-buffer.js';
import type { SignalLogger } from '../data/signal-logger.js';
import type { Candle } from '../types/candle.js';
import type { StateTransition } from '../types/state.js';

/**
 * Creates a mock SignalLogger for testing.
 */
function createMockSignalLogger(): SignalLogger {
  return {
    logSignal: vi.fn().mockResolvedValue(undefined),
    logRejection: vi.fn().mockResolvedValue(undefined),
    logStateTransition: vi.fn().mockResolvedValue(undefined),
    logFilterEvent: vi.fn().mockResolvedValue(undefined),
    runRetentionCleanup: vi.fn(),
    close: vi.fn(),
  };
}

/**
 * Creates a basic M5 candle for testing.
 */
function createM5Candle(overrides: Partial<Candle> = {}): Candle {
  return {
    instrument: 'XAUUSD',
    timeframe: 'M5',
    timestamp: '2024-01-15T14:00:00.000Z',
    open: 2050.0,
    high: 2052.0,
    low: 2049.0,
    close: 2051.0,
    volume: 1000,
    ...overrides,
  };
}

/**
 * Creates a Date at the specified UTC hour and minute.
 */
function createTimeUTC(hour: number, minute: number = 0, second: number = 0): Date {
  const d = new Date('2024-01-15T00:00:00.000Z');
  d.setUTCHours(hour, minute, second, 0);
  return d;
}

describe('SignalEngineFSM', () => {
  let fsm: SignalEngineFSM;
  let eventBus: EventBus;
  let timeGate: TimeGate;
  let newsDecoupler: NewsDecoupler;
  let zoneDetector: LiquidityZoneDetector;
  let patternAnalyzer: ReturnType<typeof createCandlePatternAnalyzer>;
  let signalLogger: SignalLogger;

  beforeEach(() => {
    eventBus = new EventBus();
    timeGate = new TimeGate();
    newsDecoupler = new NewsDecoupler();
    zoneDetector = new LiquidityZoneDetector();
    patternAnalyzer = createCandlePatternAnalyzer();
    signalLogger = createMockSignalLogger();

    fsm = new SignalEngineFSM({
      eventBus,
      timeGate,
      newsDecoupler,
      liquidityZoneDetector: zoneDetector,
      candlePatternAnalyzer: patternAnalyzer,
      signalLogger,
    });
  });

  describe('initialize()', () => {
    it('should set state to scanning at any UTC time', () => {
      const time = createTimeUTC(10, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      expect(fsm.getState()).toBe('scanning');
    });

    it('should remain scanning after the former 17:00 boundary', () => {
      const time = createTimeUTC(17, 30);
      timeGate.initialize(time);
      fsm.initialize(time);

      expect(fsm.getState()).toBe('scanning');
    });

    it('should set state to scanning at exactly 12:00:00 UTC', () => {
      const time = createTimeUTC(12, 0, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      expect(fsm.getState()).toBe('scanning');
    });

    it('should set state to scanning at 16:59:59 UTC', () => {
      const time = createTimeUTC(16, 59, 59);
      timeGate.initialize(time);
      fsm.initialize(time);

      expect(fsm.getState()).toBe('scanning');
    });

    it('should set state to scanning at exactly 17:00:00 UTC', () => {
      const time = createTimeUTC(17, 0, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      expect(fsm.getState()).toBe('scanning');
    });

    it('should emit state.change event on initialization', () => {
      const transitions: StateTransition[] = [];
      eventBus.subscribe('state.change', (t) => transitions.push(t));

      const time = createTimeUTC(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      expect(transitions.length).toBe(1);
      expect(transitions[0].from).toBe('suppressed');
      expect(transitions[0].to).toBe('scanning');
      expect(transitions[0].reason).toBe('initialization_always_active');
    });

    it('should log state transition via Signal Logger on initialization', () => {
      const time = createTimeUTC(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      expect(signalLogger.logStateTransition).toHaveBeenCalledTimes(1);
      expect(signalLogger.logStateTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'suppressed',
          to: 'scanning',
          reason: 'initialization_always_active',
        })
      );
    });
  });

  describe('State transitions - Scanning → Observation', () => {
    beforeEach(() => {
      // Initialize in scanning state
      const time = createTimeUTC(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);
    });

    it('should transition to observation when M5 close enters a liquidity zone', () => {
      // Add H1 candles to create a liquidity zone (swing high)
      const h1Candles: Candle[] = [
        createM5Candle({ timeframe: 'H1', high: 2048, low: 2045, timestamp: '2024-01-15T10:00:00.000Z' }),
        createM5Candle({ timeframe: 'H1', high: 2055, low: 2050, timestamp: '2024-01-15T11:00:00.000Z' }),
        createM5Candle({ timeframe: 'H1', high: 2048, low: 2046, timestamp: '2024-01-15T12:00:00.000Z' }),
      ];

      for (const c of h1Candles) {
        fsm.processCandle(c);
      }

      // Zone should be at upper=2055, lower=2050
      // Send M5 candle that closes within the zone
      const m5Candle = createM5Candle({
        close: 2052, // Within [2050, 2055]
        timestamp: '2024-01-15T14:05:00.000Z',
      });

      fsm.processCandle(m5Candle);

      expect(fsm.getState()).toBe('observation');
    });

    it('should remain in scanning when M5 close does not enter a liquidity zone', () => {
      const m5Candle = createM5Candle({
        close: 2100, // Not in any zone
        timestamp: '2024-01-15T14:05:00.000Z',
      });

      fsm.processCandle(m5Candle);

      expect(fsm.getState()).toBe('scanning');
    });
  });

  describe('State transitions - Observation → Scanning (zone breakthrough)', () => {
    beforeEach(() => {
      const time = createTimeUTC(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      // Create a structural high zone at [2050, 2055]
      const h1Candles: Candle[] = [
        createM5Candle({ timeframe: 'H1', high: 2048, low: 2045, timestamp: '2024-01-15T10:00:00.000Z' }),
        createM5Candle({ timeframe: 'H1', high: 2055, low: 2050, timestamp: '2024-01-15T11:00:00.000Z' }),
        createM5Candle({ timeframe: 'H1', high: 2048, low: 2046, timestamp: '2024-01-15T12:00:00.000Z' }),
      ];
      for (const c of h1Candles) {
        fsm.processCandle(c);
      }

      // Enter observation by sending M5 candle within zone
      fsm.processCandle(createM5Candle({ close: 2052, timestamp: '2024-01-15T14:05:00.000Z' }));
      expect(fsm.getState()).toBe('observation');
    });

    it('should transition back to scanning when price breaks zone boundary by ≥1 pip', () => {
      // Zone upper boundary is 2055. Break above by 1+ pips
      const breakoutCandle = createM5Candle({
        close: 2055.02, // > 2055 + 0.01 (1 pip)
        timestamp: '2024-01-15T14:10:00.000Z',
      });

      fsm.processCandle(breakoutCandle);

      expect(fsm.getState()).toBe('scanning');
    });
  });

  describe('State transitions - Observation → Scanning (6 candle timeout)', () => {
    beforeEach(() => {
      const time = createTimeUTC(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      // Create a structural low zone at [2040, 2045]
      const h1Candles: Candle[] = [
        createM5Candle({ timeframe: 'H1', high: 2048, low: 2046, timestamp: '2024-01-15T10:00:00.000Z' }),
        createM5Candle({ timeframe: 'H1', high: 2047, low: 2040, timestamp: '2024-01-15T11:00:00.000Z' }),
        createM5Candle({ timeframe: 'H1', high: 2048, low: 2046, timestamp: '2024-01-15T12:00:00.000Z' }),
      ];
      for (const c of h1Candles) {
        fsm.processCandle(c);
      }

      // Enter observation with close in zone [2040, 2047]
      fsm.processCandle(createM5Candle({ close: 2042, timestamp: '2024-01-15T14:05:00.000Z' }));
      expect(fsm.getState()).toBe('observation');
    });

    it('should transition back to scanning after 6 candles without rejection or breakthrough', () => {
      // Send 5 more candles within zone (total 6 including entry candle)
      // Use candles that do NOT trigger rejection patterns:
      // - Not hammer: bottom wick must be < 2x body
      // - Not bullish engulfing: body must NOT fully engulf prior candle's body
      // - Not shooting star: not relevant for bullish direction at structural_low
      // Use bearish candles (close < open) so they can't be bullish engulfing
      for (let i = 0; i < 5; i++) {
        const candle = createM5Candle({
          open: 2043.0,
          high: 2043.5,
          low: 2041.5,
          close: 2042.0, // bearish candle (close < open), body=1.0, bottomWick=0.5, 0.5 < 2*1.0 → not hammer
          timestamp: `2024-01-15T14:${(i + 2) * 5}:00.000Z`,
        });
        fsm.processCandle(candle);
      }

      expect(fsm.getState()).toBe('scanning');
    });
  });

  describe('State transitions - always-on operating gate', () => {
    it('should remain scanning when processing a candle at the former 17:00 boundary', () => {
      const initTime = createTimeUTC(14, 0);
      timeGate.initialize(initTime);
      fsm.initialize(initTime);
      expect(fsm.getState()).toBe('scanning');

      const candle = createM5Candle({
        timestamp: '2024-01-15T17:00:00.000Z',
      });

      fsm.processCandle(candle);

      expect(fsm.getState()).toBe('scanning');
    });

    it('does not cancel observation at the former 17:00 boundary', () => {
      const initTime = createTimeUTC(14, 0);
      timeGate.initialize(initTime);
      fsm.initialize(initTime);

      const h1Candles: Candle[] = [
        createM5Candle({ timeframe: 'H1', high: 2048, low: 2045, timestamp: '2024-01-15T10:00:00.000Z' }),
        createM5Candle({ timeframe: 'H1', high: 2055, low: 2050, timestamp: '2024-01-15T11:00:00.000Z' }),
        createM5Candle({ timeframe: 'H1', high: 2048, low: 2046, timestamp: '2024-01-15T12:00:00.000Z' }),
      ];
      for (const c of h1Candles) {
        fsm.processCandle(c);
      }

      fsm.processCandle(createM5Candle({ close: 2052, timestamp: '2024-01-15T16:55:00.000Z' }));
      expect(fsm.getState()).toBe('observation');

      fsm.processCandle(createM5Candle({ timestamp: '2024-01-15T17:00:00.000Z' }));

      expect(fsm.getState()).toBe('observation');
      expect(fsm.getObservationContext()).not.toBeNull();
    });
  });

  describe('State transitions - News freeze handling', () => {
    it('should transition from observation to scanning on news freeze activation', () => {
      const initTime = createTimeUTC(14, 0);
      timeGate.initialize(initTime);
      fsm.initialize(initTime);

      // Create zone and enter observation
      const h1Candles: Candle[] = [
        createM5Candle({ timeframe: 'H1', high: 2048, low: 2045, timestamp: '2024-01-15T10:00:00.000Z' }),
        createM5Candle({ timeframe: 'H1', high: 2055, low: 2050, timestamp: '2024-01-15T11:00:00.000Z' }),
        createM5Candle({ timeframe: 'H1', high: 2048, low: 2046, timestamp: '2024-01-15T12:00:00.000Z' }),
      ];
      for (const c of h1Candles) {
        fsm.processCandle(c);
      }

      fsm.processCandle(createM5Candle({ close: 2052, timestamp: '2024-01-15T14:05:00.000Z' }));
      expect(fsm.getState()).toBe('observation');

      // Set up a news freeze window at 14:10 UTC
      const nfpTime = new Date('2024-01-15T14:12:00.000Z');
      newsDecoupler.setSchedule([
        { name: 'NFP', scheduledTime: nfpTime, impact: 'high', currency: 'USD' },
      ]);

      // Send M5 candle during freeze window (14:10 = NFP - 2min)
      const freezeCandle = createM5Candle({
        close: 2052,
        timestamp: '2024-01-15T14:11:00.000Z', // During freeze: 14:10 to 14:27
      });
      fsm.processCandle(freezeCandle);

      expect(fsm.getState()).toBe('scanning');
    });

    it('should transition from signal_evaluation to scanning on news freeze activation', () => {
      const initTime = createTimeUTC(14, 0);
      timeGate.initialize(initTime);
      fsm.initialize(initTime);

      // Create a structural high zone at [2050, 2055]
      const h1Candles: Candle[] = [
        createM5Candle({ timeframe: 'H1', high: 2048, low: 2045, timestamp: '2024-01-15T10:00:00.000Z' }),
        createM5Candle({ timeframe: 'H1', high: 2055, low: 2050, timestamp: '2024-01-15T11:00:00.000Z' }),
        createM5Candle({ timeframe: 'H1', high: 2048, low: 2046, timestamp: '2024-01-15T12:00:00.000Z' }),
      ];
      for (const c of h1Candles) {
        fsm.processCandle(c);
      }

      // Enter observation
      fsm.processCandle(createM5Candle({ close: 2052, timestamp: '2024-01-15T14:05:00.000Z' }));
      expect(fsm.getState()).toBe('observation');

      // Send enough candles to reach minimum 3 then a shooting star for rejection
      fsm.processCandle(createM5Candle({
        close: 2053,
        open: 2052,
        high: 2054,
        low: 2051.5,
        timestamp: '2024-01-15T14:10:00.000Z',
      }));
      fsm.processCandle(createM5Candle({
        close: 2052.5,
        open: 2053.5,
        high: 2054,
        low: 2052,
        timestamp: '2024-01-15T14:15:00.000Z',
      }));

      // Shooting star: top wick ≥50% of range, body in lower third
      // high=2060, low=2050, open=2051, close=2050.5 → topWick=9, range=10, body in lower third
      const shootingStar = createM5Candle({
        open: 2051,
        close: 2050.5,
        high: 2060,
        low: 2050,
        timestamp: '2024-01-15T14:20:00.000Z',
      });
      fsm.processCandle(shootingStar);

      expect(fsm.getState()).toBe('signal_evaluation');

      // Feed expansion candles to keep FSM in signal_evaluation (short direction: bearish, body ratio >= 0.6)
      fsm.processCandle(createM5Candle({
        open: 2050, close: 2042, high: 2051, low: 2041,
        timestamp: '2024-01-15T14:21:00.000Z',
      }));
      fsm.processCandle(createM5Candle({
        open: 2042, close: 2034, high: 2043, low: 2033,
        timestamp: '2024-01-15T14:22:00.000Z',
      }));

      expect(fsm.getState()).toBe('signal_evaluation');

      // Now set up news freeze and send candle during freeze
      const nfpTime = new Date('2024-01-15T14:27:00.000Z');
      newsDecoupler.setSchedule([
        { name: 'NFP', scheduledTime: nfpTime, impact: 'high', currency: 'USD' },
      ]);

      // 14:25 is within freeze window (NFP at 14:27, freeze starts at 14:25)
      const freezeCandle = createM5Candle({
        close: 2052,
        timestamp: '2024-01-15T14:25:00.000Z',
      });
      fsm.processCandle(freezeCandle);

      expect(fsm.getState()).toBe('scanning');
      expect(fsm.getEvaluationContext()).toBeNull();
    });

    it('should not change state in scanning when news freeze is active', () => {
      const initTime = createTimeUTC(14, 0);
      timeGate.initialize(initTime);
      fsm.initialize(initTime);
      expect(fsm.getState()).toBe('scanning');

      // Set up a news freeze
      const nfpTime = new Date('2024-01-15T14:05:00.000Z');
      newsDecoupler.setSchedule([
        { name: 'NFP', scheduledTime: nfpTime, impact: 'high', currency: 'USD' },
      ]);

      // Send candle during freeze (no zone, so shouldn't transition anyway)
      const candle = createM5Candle({ timestamp: '2024-01-15T14:04:00.000Z' });
      fsm.processCandle(candle);

      expect(fsm.getState()).toBe('scanning');
    });
  });

  describe('Event emission on state change', () => {
    it('should call registered onStateChange handlers on every transition', () => {
      const transitions: StateTransition[] = [];
      fsm.onStateChange((t) => transitions.push(t));

      const time = createTimeUTC(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      expect(transitions.length).toBe(1);
      expect(transitions[0].from).toBe('suppressed');
      expect(transitions[0].to).toBe('scanning');
      expect(transitions[0].reason).toBe('initialization_always_active');
      expect(transitions[0].timestamp).toBe(time.toISOString());
    });

    it('should emit state.change event on EventBus for each transition', () => {
      const busEvents: StateTransition[] = [];
      eventBus.subscribe('state.change', (t) => busEvents.push(t));

      const time = createTimeUTC(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      expect(busEvents.length).toBe(1);
      expect(busEvents[0].to).toBe('scanning');
    });

    it('should include correct timestamp in ISO 8601 format', () => {
      const transitions: StateTransition[] = [];
      fsm.onStateChange((t) => transitions.push(t));

      const time = createTimeUTC(14, 30);
      timeGate.initialize(time);
      fsm.initialize(time);

      expect(transitions[0].timestamp).toBe('2024-01-15T14:30:00.000Z');
    });

    it('should log every state transition via Signal Logger', () => {
      const time = createTimeUTC(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      expect(signalLogger.logStateTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'suppressed',
          to: 'scanning',
        })
      );
    });
  });

  describe('H1/M15 candle forwarding', () => {
    it('should forward H1 candles to the liquidity zone detector without state transition', () => {
      const time = createTimeUTC(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      const h1Candle = createM5Candle({
        timeframe: 'H1',
        timestamp: '2024-01-15T14:00:00.000Z',
      });

      fsm.processCandle(h1Candle);
      expect(fsm.getState()).toBe('scanning'); // No state change
    });

    it('should ignore M1 candles completely', () => {
      const time = createTimeUTC(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      const m1Candle = createM5Candle({
        timeframe: 'M1',
        timestamp: '2024-01-15T14:00:00.000Z',
      });

      fsm.processCandle(m1Candle);
      expect(fsm.getState()).toBe('scanning');
    });
  });

  describe('Observation → SignalEvaluation (rejection candle)', () => {
    it('should transition to signal_evaluation when rejection candle detected after ≥3 candles', () => {
      const initTime = createTimeUTC(14, 0);
      timeGate.initialize(initTime);
      fsm.initialize(initTime);

      // Create structural high zone
      const h1Candles: Candle[] = [
        createM5Candle({ timeframe: 'H1', high: 2048, low: 2045, timestamp: '2024-01-15T10:00:00.000Z' }),
        createM5Candle({ timeframe: 'H1', high: 2055, low: 2050, timestamp: '2024-01-15T11:00:00.000Z' }),
        createM5Candle({ timeframe: 'H1', high: 2048, low: 2046, timestamp: '2024-01-15T12:00:00.000Z' }),
      ];
      for (const c of h1Candles) {
        fsm.processCandle(c);
      }

      // Enter observation (candle 1)
      fsm.processCandle(createM5Candle({ close: 2052, timestamp: '2024-01-15T14:05:00.000Z' }));
      expect(fsm.getState()).toBe('observation');

      // Candle 2 - normal candle
      fsm.processCandle(createM5Candle({
        open: 2052,
        close: 2053,
        high: 2054,
        low: 2051,
        timestamp: '2024-01-15T14:10:00.000Z',
      }));
      expect(fsm.getState()).toBe('observation');

      // Candle 3 - shooting star (bearish rejection at structural high zone)
      // Top wick ≥50% range, body in lower third
      const shootingStar = createM5Candle({
        open: 2051,
        close: 2050.5,
        high: 2060,
        low: 2050,
        timestamp: '2024-01-15T14:15:00.000Z',
      });
      fsm.processCandle(shootingStar);

      expect(fsm.getState()).toBe('signal_evaluation');
    });
  });

  describe('Always-on operating state', () => {
    it('starts scanning even before the former 12:00 boundary', () => {
      const earlyTime = createTimeUTC(11, 59, 59);
      timeGate.initialize(earlyTime);
      fsm.initialize(earlyTime);
      expect(fsm.getState()).toBe('scanning');

      const candle = createM5Candle({
        timestamp: '2024-01-15T12:00:00.000Z',
      });
      fsm.processCandle(candle);

      expect(fsm.getState()).toBe('scanning');
    });
  });
});



describe('SignalEngineFSM - Observation Phase (Task 6.2)', () => {
  let fsm: SignalEngineFSM;
  let eventBus: EventBus;
  let timeGate: TimeGate;
  let newsDecoupler: NewsDecoupler;
  let zoneDetector: LiquidityZoneDetector;
  let patternAnalyzer: ReturnType<typeof createCandlePatternAnalyzer>;
  let signalLogger: SignalLogger;

  beforeEach(() => {
    eventBus = new EventBus();
    timeGate = new TimeGate();
    newsDecoupler = new NewsDecoupler();
    zoneDetector = new LiquidityZoneDetector();
    patternAnalyzer = createCandlePatternAnalyzer();
    signalLogger = createMockSignalLogger();

    fsm = new SignalEngineFSM({
      eventBus,
      timeGate,
      newsDecoupler,
      liquidityZoneDetector: zoneDetector,
      candlePatternAnalyzer: patternAnalyzer,
      signalLogger,
    });
  });

  /**
   * Sets up a structural high zone at [2050, 2055] and enters observation.
   * Returns the FSM in observation state with candleCount = 1.
   */
  function setupObservationHighZone(): void {
    const time = createTimeUTC(14, 0);
    timeGate.initialize(time);
    fsm.initialize(time);

    // Create structural high zone at [2050, 2055]
    const h1Candles: Candle[] = [
      createM5Candle({ timeframe: 'H1', high: 2048, low: 2045, timestamp: '2024-01-15T10:00:00.000Z' }),
      createM5Candle({ timeframe: 'H1', high: 2055, low: 2050, timestamp: '2024-01-15T11:00:00.000Z' }),
      createM5Candle({ timeframe: 'H1', high: 2048, low: 2046, timestamp: '2024-01-15T12:00:00.000Z' }),
    ];
    for (const c of h1Candles) {
      fsm.processCandle(c);
    }

    // Enter observation with close in zone
    fsm.processCandle(createM5Candle({ close: 2052, high: 2054, low: 2050, timestamp: '2024-01-15T14:05:00.000Z' }));
    expect(fsm.getState()).toBe('observation');
  }

  describe('Volume below SMA tracking', () => {
    it('should set volumeBelowSma=false when no CandleBufferManager is provided', () => {
      setupObservationHighZone();

      // Send another candle in the zone
      fsm.processCandle(createM5Candle({
        close: 2053, open: 2052, high: 2054, low: 2051,
        volume: 500,
        timestamp: '2024-01-15T14:10:00.000Z',
      }));

      const ctx = fsm.getObservationContext();
      expect(ctx).not.toBeNull();
      expect(ctx!.volumeBelowSma).toBe(false);
    });

    it('should set volumeBelowSma=true when candle volume < SMA-20 (with CandleBufferManager)', () => {
      const bufferManager = new CandleBufferManager();

      // Populate buffer with M5 candles of volume 1000 each to set SMA-20 = 1000
      for (let i = 0; i < 20; i++) {
        bufferManager.addCandle(createM5Candle({ volume: 1000, timestamp: `2024-01-15T13:${String(i).padStart(2, '0')}:00.000Z` }));
      }

      // Create FSM with CandleBufferManager
      const fsmWithBuffer = new SignalEngineFSM({
        eventBus,
        timeGate,
        newsDecoupler,
        liquidityZoneDetector: zoneDetector,
        candlePatternAnalyzer: patternAnalyzer,
        signalLogger,
        candleBufferManager: bufferManager,
      });

      const time = createTimeUTC(14, 0);
      timeGate.initialize(time);
      fsmWithBuffer.initialize(time);

      // Create zone
      const h1Candles: Candle[] = [
        createM5Candle({ timeframe: 'H1', high: 2048, low: 2045, timestamp: '2024-01-15T10:00:00.000Z' }),
        createM5Candle({ timeframe: 'H1', high: 2055, low: 2050, timestamp: '2024-01-15T11:00:00.000Z' }),
        createM5Candle({ timeframe: 'H1', high: 2048, low: 2046, timestamp: '2024-01-15T12:00:00.000Z' }),
      ];
      for (const c of h1Candles) {
        fsmWithBuffer.processCandle(c);
      }

      // Enter observation
      fsmWithBuffer.processCandle(createM5Candle({ close: 2052, timestamp: '2024-01-15T14:05:00.000Z', volume: 1000 }));
      expect(fsmWithBuffer.getState()).toBe('observation');

      // Send candle with volume BELOW the SMA (500 < 1000)
      fsmWithBuffer.processCandle(createM5Candle({
        close: 2053, open: 2052, high: 2054, low: 2051,
        volume: 500,
        timestamp: '2024-01-15T14:10:00.000Z',
      }));

      const ctx = fsmWithBuffer.getObservationContext();
      expect(ctx).not.toBeNull();
      expect(ctx!.volumeBelowSma).toBe(true);
    });

    it('should set volumeBelowSma=false when candle volume >= SMA-20 (with CandleBufferManager)', () => {
      const bufferManager = new CandleBufferManager();

      // Populate buffer with volume 1000 → SMA = 1000
      for (let i = 0; i < 20; i++) {
        bufferManager.addCandle(createM5Candle({ volume: 1000, timestamp: `2024-01-15T13:${String(i).padStart(2, '0')}:00.000Z` }));
      }

      const fsmWithBuffer = new SignalEngineFSM({
        eventBus,
        timeGate,
        newsDecoupler,
        liquidityZoneDetector: zoneDetector,
        candlePatternAnalyzer: patternAnalyzer,
        signalLogger,
        candleBufferManager: bufferManager,
      });

      const time = createTimeUTC(14, 0);
      timeGate.initialize(time);
      fsmWithBuffer.initialize(time);

      const h1Candles: Candle[] = [
        createM5Candle({ timeframe: 'H1', high: 2048, low: 2045, timestamp: '2024-01-15T10:00:00.000Z' }),
        createM5Candle({ timeframe: 'H1', high: 2055, low: 2050, timestamp: '2024-01-15T11:00:00.000Z' }),
        createM5Candle({ timeframe: 'H1', high: 2048, low: 2046, timestamp: '2024-01-15T12:00:00.000Z' }),
      ];
      for (const c of h1Candles) {
        fsmWithBuffer.processCandle(c);
      }

      fsmWithBuffer.processCandle(createM5Candle({ close: 2052, timestamp: '2024-01-15T14:05:00.000Z', volume: 1000 }));
      expect(fsmWithBuffer.getState()).toBe('observation');

      // Send candle with volume AT or above the SMA (1200 > 1000)
      fsmWithBuffer.processCandle(createM5Candle({
        close: 2053, open: 2052, high: 2054, low: 2051,
        volume: 1200,
        timestamp: '2024-01-15T14:10:00.000Z',
      }));

      const ctx = fsmWithBuffer.getObservationContext();
      expect(ctx).not.toBeNull();
      expect(ctx!.volumeBelowSma).toBe(false);
    });
  });

  describe('Range compression tracking', () => {
    it('should set rangeCompressing=true when current candle range is smaller than average prior range', () => {
      setupObservationHighZone(); // Entry candle has range = 2054 - 2050 = 4

      // Send candle with SMALLER range than the entry candle
      fsm.processCandle(createM5Candle({
        close: 2052, open: 2051.5, high: 2052.5, low: 2051, // range = 1.5
        timestamp: '2024-01-15T14:10:00.000Z',
      }));

      const ctx = fsm.getObservationContext();
      expect(ctx).not.toBeNull();
      expect(ctx!.rangeCompressing).toBe(true);
    });

    it('should set rangeCompressing=false when current candle range is larger than average prior range', () => {
      setupObservationHighZone(); // Entry candle has range = 4

      // Send candle with LARGER range
      fsm.processCandle(createM5Candle({
        close: 2053, open: 2050, high: 2056, low: 2049, // range = 7
        timestamp: '2024-01-15T14:10:00.000Z',
      }));

      const ctx = fsm.getObservationContext();
      expect(ctx).not.toBeNull();
      expect(ctx!.rangeCompressing).toBe(false);
    });

    it('should compute rangeCompressing across multiple candles in observation', () => {
      setupObservationHighZone(); // Entry candle range = 4

      // Candle 2: range = 3 (compressing relative to avg of [4] → true)
      fsm.processCandle(createM5Candle({
        close: 2052, open: 2051, high: 2053, low: 2050, // range = 3
        timestamp: '2024-01-15T14:10:00.000Z',
      }));
      expect(fsm.getObservationContext()!.rangeCompressing).toBe(true);

      // Candle 3: range = 2 (compressing relative to avg of [4, 3] = 3.5 → true)
      fsm.processCandle(createM5Candle({
        close: 2052, open: 2051, high: 2052.5, low: 2050.5, // range = 2
        timestamp: '2024-01-15T14:15:00.000Z',
      }));
      expect(fsm.getObservationContext()!.rangeCompressing).toBe(true);

      // Candle 4: range = 5 (avg of [4, 3, 2] = 3 → 5 > 3 → false)
      fsm.processCandle(createM5Candle({
        close: 2053, open: 2050, high: 2055, low: 2050, // range = 5
        timestamp: '2024-01-15T14:20:00.000Z',
      }));
      expect(fsm.getObservationContext()!.rangeCompressing).toBe(false);
    });
  });

  describe('Rejection candle 3-candle minimum enforcement', () => {
    it('should NOT transition to signal_evaluation if rejection pattern appears on candle 2', () => {
      setupObservationHighZone(); // Candle 1 already counted

      // Candle 2: shooting star (bearish rejection) - should NOT trigger transition
      // because candleCount = 2 which is < 3
      const shootingStar = createM5Candle({
        open: 2051, close: 2050.5, high: 2060, low: 2050, // top wick ≥50%, body in lower third
        timestamp: '2024-01-15T14:10:00.000Z',
      });
      fsm.processCandle(shootingStar);

      expect(fsm.getState()).toBe('observation');
      expect(fsm.getObservationContext()!.candleCount).toBe(2);
    });

    it('should transition to signal_evaluation when rejection appears on exactly candle 3', () => {
      setupObservationHighZone(); // Candle 1

      // Candle 2: normal candle
      fsm.processCandle(createM5Candle({
        open: 2052, close: 2053, high: 2054, low: 2051,
        timestamp: '2024-01-15T14:10:00.000Z',
      }));
      expect(fsm.getState()).toBe('observation');

      // Candle 3: shooting star → should trigger (candleCount = 3 >= 3)
      const shootingStar = createM5Candle({
        open: 2051, close: 2050.5, high: 2060, low: 2050,
        timestamp: '2024-01-15T14:15:00.000Z',
      });
      fsm.processCandle(shootingStar);

      expect(fsm.getState()).toBe('signal_evaluation');
    });

    it('should still allow zone breakthrough on candle 2 (no 3-candle requirement)', () => {
      setupObservationHighZone(); // Candle 1; zone upper = 2055

      // Candle 2: breakthrough above zone by ≥1 pip
      const breakthrough = createM5Candle({
        close: 2055.02, // > 2055 + 0.01
        timestamp: '2024-01-15T14:10:00.000Z',
      });
      fsm.processCandle(breakthrough);

      expect(fsm.getState()).toBe('scanning');
    });
  });

  describe('Timeout logging on 6-candle expiry', () => {
    it('should log rejection with timeout reason when observation times out at 6 candles', () => {
      setupObservationHighZone(); // Candle 1

      // Send 5 more candles (non-rejection, within zone)
      // Use small bullish candles that can't be shooting star or bearish engulfing:
      // - Not shooting star (bullish, body not in lower third)
      // - Not bearish engulfing (close > open)
      for (let i = 0; i < 5; i++) {
        fsm.processCandle(createM5Candle({
          open: 2051.0, high: 2053.0, low: 2050.5, close: 2052.5, // bullish candle
          timestamp: `2024-01-15T14:${String((i + 2) * 5).padStart(2, '0')}:00.000Z`,
        }));
      }

      expect(fsm.getState()).toBe('scanning');

      // Verify logRejection was called with timeout info
      expect(signalLogger.logRejection).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: expect.stringContaining('Observation timeout'),
          filter: 'observation_timeout',
          context: expect.objectContaining({
            candleCount: 6,
          }),
        })
      );
    });

    it('should include zone and observation details in timeout log context', () => {
      setupObservationHighZone();

      // 5 more bullish candles to timeout (won't trigger bearish rejection)
      for (let i = 0; i < 5; i++) {
        fsm.processCandle(createM5Candle({
          open: 2051.0, high: 2053.0, low: 2050.5, close: 2052.5, // bullish
          timestamp: `2024-01-15T14:${String((i + 2) * 5).padStart(2, '0')}:00.000Z`,
        }));
      }

      const call = (signalLogger.logRejection as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.context.zoneType).toBe('structural_high');
      expect(call.context.startTimestamp).toBe('2024-01-15T14:05:00.000Z');
      expect(call.context.candleCount).toBe(6);
      expect(typeof call.context.volumeBelowSma).toBe('boolean');
      expect(typeof call.context.rangeCompressing).toBe('boolean');
    });
  });

  describe('Observation candle count tracking', () => {
    it('should correctly track candle count from 1 to 6', () => {
      setupObservationHighZone(); // Starts at candleCount = 1

      const ctx = fsm.getObservationContext();
      expect(ctx!.candleCount).toBe(1);

      // Add candles 2 through 5 and verify count
      // Use bullish candles that won't trigger bearish rejection
      for (let i = 2; i <= 5; i++) {
        fsm.processCandle(createM5Candle({
          open: 2051.0, high: 2053.0, low: 2050.5, close: 2052.5, // bullish
          timestamp: `2024-01-15T14:${String(i * 5).padStart(2, '0')}:00.000Z`,
        }));
        expect(fsm.getObservationContext()!.candleCount).toBe(i);
      }

      // On 6th candle, should timeout and transition to scanning
      fsm.processCandle(createM5Candle({
        open: 2051.0, high: 2053.0, low: 2050.5, close: 2052.5,
        timestamp: '2024-01-15T14:30:00.000Z',
      }));
      expect(fsm.getState()).toBe('scanning');
    });
  });
});
