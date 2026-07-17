/**
 * Unit tests for MacroFilterModule façade.
 *
 * Tests the combined filter logic including:
 * - checkAllFilters() returning pass/block with reason
 * - getFilterStatus() for dashboard consumption
 * - filter.change event emission on state transitions
 * - M1 candle processing through circuit breaker
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MacroFilterModule } from './macro-filter-module.js';
import { TimeGate } from './time-gate.js';
import { NewsDecoupler } from './news-decoupler.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { EventBus, FilterChangeEvent } from '../core/event-bus.js';
import { Candle } from '../types/candle.js';

/** Helper to create a Candle object */
function makeCandle(overrides: Partial<Candle> = {}): Candle {
  return {
    instrument: 'XAUUSD',
    timeframe: 'M5',
    timestamp: '2024-01-15T14:00:00.000Z',
    open: 2050.0,
    high: 2055.0,
    low: 2048.0,
    close: 2053.0,
    volume: 1500,
    ...overrides,
  };
}

/** Helper to create a Date at a specific UTC time on 2024-01-15 */
function makeUTCDate(hours: number, minutes = 0, seconds = 0): Date {
  return new Date(Date.UTC(2024, 0, 15, hours, minutes, seconds));
}

describe('MacroFilterModule', () => {
  let timeGate: TimeGate;
  let newsDecoupler: NewsDecoupler;
  let circuitBreaker: CircuitBreaker;
  let eventBus: EventBus;
  let module: MacroFilterModule;

  beforeEach(() => {
    timeGate = new TimeGate();
    newsDecoupler = new NewsDecoupler({ warn: vi.fn(), info: vi.fn() });
    circuitBreaker = new CircuitBreaker();
    eventBus = new EventBus();
    module = new MacroFilterModule(
      timeGate,
      newsDecoupler,
      circuitBreaker,
      eventBus,
    );
  });

  describe('isTimeGateActive', () => {
    it('returns true at every UTC time', () => {
      expect(module.isTimeGateActive(makeUTCDate(0, 0, 0))).toBe(true);
      expect(module.isTimeGateActive(makeUTCDate(8, 0, 0))).toBe(true);
      expect(module.isTimeGateActive(makeUTCDate(12, 0, 0))).toBe(true);
      expect(module.isTimeGateActive(makeUTCDate(17, 0, 0))).toBe(true);
      expect(module.isTimeGateActive(makeUTCDate(23, 59, 59))).toBe(true);
    });
  });

  describe('isNewsFreezeActive', () => {
    it('returns true during an active freeze window', () => {
      const eventTime = makeUTCDate(14, 30, 0); // 14:30 UTC
      newsDecoupler.setSchedule([
        { name: 'CPI', scheduledTime: eventTime, impact: 'high', currency: 'USD' },
      ]);

      // During the freeze: 14:28 to 14:45
      expect(module.isNewsFreezeActive(makeUTCDate(14, 29, 0))).toBe(true);
      expect(module.isNewsFreezeActive(makeUTCDate(14, 40, 0))).toBe(true);
    });

    it('returns false outside of any freeze window', () => {
      const eventTime = makeUTCDate(14, 30, 0);
      newsDecoupler.setSchedule([
        { name: 'CPI', scheduledTime: eventTime, impact: 'high', currency: 'USD' },
      ]);

      // Before the freeze (before 14:28)
      expect(module.isNewsFreezeActive(makeUTCDate(14, 27, 59))).toBe(false);
      // After the freeze (after 14:45)
      expect(module.isNewsFreezeActive(makeUTCDate(14, 45, 0))).toBe(false);
    });

    it('returns false when no events are scheduled', () => {
      expect(module.isNewsFreezeActive(makeUTCDate(14, 30, 0))).toBe(false);
    });
  });

  describe('isCircuitBreakerActive', () => {
    it('returns false when no alert has been triggered', () => {
      expect(module.isCircuitBreakerActive(makeUTCDate(14, 0, 0))).toBe(false);
    });

    it('returns true during the suppression period after a trigger', () => {
      const candle = makeCandle({
        timeframe: 'M1',
        timestamp: '2024-01-15T14:00:00.000Z',
        open: 2050.0,
        close: 2020.0, // 300 pip drop (adverse for long)
      });

      circuitBreaker.processM1Candle(candle, 'long', 'signal-1');

      // Within 15 minutes of trigger
      expect(module.isCircuitBreakerActive(makeUTCDate(14, 10, 0))).toBe(true);
    });

    it('returns false after the suppression period expires', () => {
      const candle = makeCandle({
        timeframe: 'M1',
        timestamp: '2024-01-15T14:00:00.000Z',
        open: 2050.0,
        close: 2020.0,
      });

      circuitBreaker.processM1Candle(candle, 'long', 'signal-1');

      // After 15 minutes
      expect(module.isCircuitBreakerActive(makeUTCDate(14, 16, 0))).toBe(false);
    });
  });

  describe('getFilterStatus', () => {
    it('returns combined status of all filters', () => {
      timeGate.initialize(makeUTCDate(14, 0, 0));

      const status = module.getFilterStatus();

      expect(status).toHaveProperty('timeGate');
      expect(status).toHaveProperty('newsDecoupler');
      expect(status).toHaveProperty('circuitBreaker');
    });

    it('reflects time gate active status', () => {
      timeGate.initialize(makeUTCDate(14, 0, 0));
      const status = module.getFilterStatus();

      expect(status.timeGate.active).toBe(true);
      expect(status.timeGate.windowStart).toBe('00:00:00');
      expect(status.timeGate.windowEnd).toBe('23:59:59');
    });

    it('reflects news decoupler status when freeze is active', () => {
      const eventTime = makeUTCDate(14, 30, 0);
      newsDecoupler.setSchedule([
        { name: 'NFP', scheduledTime: eventTime, impact: 'high', currency: 'USD' },
      ]);

      // Get status during the freeze (use getStatus with a time in the freeze window)
      const status = module.getFilterStatus();
      // The newsDecoupler.getStatus() uses current time by default
      expect(status.newsDecoupler).toHaveProperty('freezeActive');
      expect(status.newsDecoupler).toHaveProperty('currentEvent');
      expect(status.newsDecoupler).toHaveProperty('freezeEnd');
    });

    it('reflects circuit breaker status', () => {
      const status = module.getFilterStatus();

      expect(status.circuitBreaker.active).toBe(false);
      expect(status.circuitBreaker.expiresAt).toBeNull();
    });
  });

  describe('checkAllFilters', () => {
    it('returns passed: true when all filters pass', () => {
      timeGate.initialize(makeUTCDate(14, 0, 0));
      const candle = makeCandle();
      const result = module.checkAllFilters(makeUTCDate(14, 0, 0), candle);

      expect(result.passed).toBe(true);
      expect(result.blockedBy).toBeNull();
      expect(result.reason).toBeNull();
    });

    it('does not block at any UTC time because the operating gate is always open', () => {
      const candle = makeCandle();
      const result = module.checkAllFilters(makeUTCDate(8, 0, 0), candle);

      expect(result.passed).toBe(true);
      expect(result.blockedBy).toBeNull();
      expect(result.reason).toBeNull();
    });

    it('blocks with news_decoupler when news freeze is active', () => {
      timeGate.initialize(makeUTCDate(14, 0, 0));
      const eventTime = makeUTCDate(14, 30, 0);
      newsDecoupler.setSchedule([
        { name: 'FOMC', scheduledTime: eventTime, impact: 'high', currency: 'USD' },
      ]);

      const candle = makeCandle();
      // Time is during the freeze (14:29)
      const result = module.checkAllFilters(makeUTCDate(14, 29, 0), candle);

      expect(result.passed).toBe(false);
      expect(result.blockedBy).toBe('news_decoupler');
      expect(result.reason).toContain('FOMC');
    });

    it('blocks with circuit_breaker when circuit breaker is active', () => {
      timeGate.initialize(makeUTCDate(14, 0, 0));

      // Trigger the circuit breaker
      const triggerCandle = makeCandle({
        timeframe: 'M1',
        timestamp: '2024-01-15T14:00:00.000Z',
        open: 2050.0,
        close: 2020.0, // 300 pips adverse for long
      });
      circuitBreaker.processM1Candle(triggerCandle, 'long', 'signal-1');

      const candle = makeCandle();
      const result = module.checkAllFilters(makeUTCDate(14, 5, 0), candle);

      expect(result.passed).toBe(false);
      expect(result.blockedBy).toBe('circuit_breaker');
      expect(result.reason).toContain('Circuit breaker active');
    });

    it('checks News Decoupler when the operating gate is always open', () => {
      const eventTime = makeUTCDate(8, 30, 0);
      newsDecoupler.setSchedule([
        { name: 'CPI', scheduledTime: eventTime, impact: 'high', currency: 'USD' },
      ]);

      const candle = makeCandle();
      const result = module.checkAllFilters(makeUTCDate(8, 30, 0), candle);

      expect(result.blockedBy).toBe('news_decoupler');
    });

    it('checks News Decoupler before Circuit Breaker', () => {
      timeGate.initialize(makeUTCDate(14, 0, 0));

      // Both news freeze and circuit breaker active
      const eventTime = makeUTCDate(14, 30, 0);
      newsDecoupler.setSchedule([
        { name: 'GDP', scheduledTime: eventTime, impact: 'high', currency: 'USD' },
      ]);

      const triggerCandle = makeCandle({
        timeframe: 'M1',
        timestamp: '2024-01-15T14:00:00.000Z',
        open: 2050.0,
        close: 2020.0,
      });
      circuitBreaker.processM1Candle(triggerCandle, 'long', 'signal-1');

      const candle = makeCandle();
      const result = module.checkAllFilters(makeUTCDate(14, 29, 0), candle);

      // Should block on news_decoupler first
      expect(result.blockedBy).toBe('news_decoupler');
    });
  });

  describe('filter.change event emission', () => {
    it('does not emit Time Gate activation events', () => {
      const events: FilterChangeEvent[] = [];
      eventBus.subscribe('filter.change', (e) => events.push(e));

      const candle = makeCandle();
      module.checkAllFilters(makeUTCDate(11, 59, 0), candle);
      module.checkAllFilters(makeUTCDate(12, 0, 0), candle);

      expect(events.some((e) => e.filterName === 'time_gate')).toBe(false);
    });

    it('does not emit Time Gate deactivation events', () => {
      const events: FilterChangeEvent[] = [];
      eventBus.subscribe('filter.change', (e) => events.push(e));

      const candle = makeCandle();
      module.checkAllFilters(makeUTCDate(16, 59, 0), candle);
      module.checkAllFilters(makeUTCDate(17, 0, 0), candle);

      expect(events.some((e) => e.filterName === 'time_gate')).toBe(false);
    });

    it('emits filter.change when News Decoupler activates', () => {
      const events: FilterChangeEvent[] = [];
      eventBus.subscribe('filter.change', (e) => events.push(e));

      const eventTime = makeUTCDate(14, 30, 0);
      newsDecoupler.setSchedule([
        { name: 'PPI', scheduledTime: eventTime, impact: 'high', currency: 'USD' },
      ]);

      const candle = makeCandle();

      // Call before freeze window (sets previous state)
      module.checkAllFilters(makeUTCDate(14, 27, 0), candle);

      // Call during freeze window — should detect activation
      module.checkAllFilters(makeUTCDate(14, 29, 0), candle);

      const newsEvent = events.find(
        (e) => e.filterName === 'news_decoupler' && e.action === 'activated',
      );
      expect(newsEvent).toBeDefined();
      expect(newsEvent!.reason).toContain('PPI');
    });

    it('emits filter.change when News Decoupler deactivates', () => {
      const events: FilterChangeEvent[] = [];
      eventBus.subscribe('filter.change', (e) => events.push(e));

      const eventTime = makeUTCDate(14, 30, 0);
      newsDecoupler.setSchedule([
        { name: 'CPI', scheduledTime: eventTime, impact: 'high', currency: 'USD' },
      ]);

      const candle = makeCandle();

      // Call during freeze window (sets previous state)
      module.checkAllFilters(makeUTCDate(14, 35, 0), candle);

      // Call after freeze window — should detect deactivation
      module.checkAllFilters(makeUTCDate(14, 46, 0), candle);

      const newsEvent = events.find(
        (e) => e.filterName === 'news_decoupler' && e.action === 'deactivated',
      );
      expect(newsEvent).toBeDefined();
      expect(newsEvent!.reason).toContain('expired');
    });

    it('emits filter.change when Circuit Breaker activates', () => {
      const events: FilterChangeEvent[] = [];
      eventBus.subscribe('filter.change', (e) => events.push(e));

      const candle = makeCandle();

      // First call — no circuit breaker (sets previous state)
      module.checkAllFilters(makeUTCDate(14, 0, 0), candle);

      // Trigger circuit breaker
      const triggerCandle = makeCandle({
        timeframe: 'M1',
        timestamp: '2024-01-15T14:01:00.000Z',
        open: 2050.0,
        close: 2020.0,
      });
      circuitBreaker.processM1Candle(triggerCandle, 'long', 'signal-1');

      // Next call should detect activation
      module.checkAllFilters(makeUTCDate(14, 2, 0), candle);

      const cbEvent = events.find(
        (e) => e.filterName === 'circuit_breaker' && e.action === 'activated',
      );
      expect(cbEvent).toBeDefined();
      expect(cbEvent!.reason).toContain('Circuit breaker triggered');
    });

    it('emits filter.change when Circuit Breaker deactivates', () => {
      const events: FilterChangeEvent[] = [];
      eventBus.subscribe('filter.change', (e) => events.push(e));

      // Trigger circuit breaker
      const triggerCandle = makeCandle({
        timeframe: 'M1',
        timestamp: '2024-01-15T14:00:00.000Z',
        open: 2050.0,
        close: 2020.0,
      });
      circuitBreaker.processM1Candle(triggerCandle, 'long', 'signal-1');

      const candle = makeCandle();

      // Call during suppression (sets previous state)
      module.checkAllFilters(makeUTCDate(14, 5, 0), candle);

      // Call after suppression expires (15 min after trigger)
      module.checkAllFilters(makeUTCDate(14, 16, 0), candle);

      const cbEvent = events.find(
        (e) => e.filterName === 'circuit_breaker' && e.action === 'deactivated',
      );
      expect(cbEvent).toBeDefined();
      expect(cbEvent!.reason).toContain('cooldown expired');
    });

    it('does not emit events when filter state remains unchanged', () => {
      const events: FilterChangeEvent[] = [];
      eventBus.subscribe('filter.change', (e) => events.push(e));

      const candle = makeCandle();

      // Two calls within the window — no state change
      module.checkAllFilters(makeUTCDate(14, 0, 0), candle);
      module.checkAllFilters(makeUTCDate(14, 5, 0), candle);

      // The always-on gate remains unchanged across both calls.
      const timeGateEvents = events.filter((e) => e.filterName === 'time_gate');
      expect(timeGateEvents.length).toBe(0);
    });
  });

  describe('M1 candle processing', () => {
    it('processM1Candle delegates to the circuit breaker', () => {
      const candle = makeCandle({
        timeframe: 'M1',
        timestamp: '2024-01-15T14:00:00.000Z',
        open: 2050.0,
        close: 2020.0, // 300 pip drop
      });

      module.processM1Candle(candle, 'long', 'signal-1');

      expect(circuitBreaker.isActive(makeUTCDate(14, 5, 0))).toBe(true);
    });

    it('does not trigger circuit breaker for movements below threshold', () => {
      const candle = makeCandle({
        timeframe: 'M1',
        timestamp: '2024-01-15T14:00:00.000Z',
        open: 2050.0,
        close: 2045.0, // only 50 pips
      });

      module.processM1Candle(candle, 'long', 'signal-1');

      expect(circuitBreaker.isActive(makeUTCDate(14, 5, 0))).toBe(false);
    });

    it('does not trigger circuit breaker without a signal direction', () => {
      const candle = makeCandle({
        timeframe: 'M1',
        timestamp: '2024-01-15T14:00:00.000Z',
        open: 2050.0,
        close: 2020.0,
      });

      module.processM1Candle(candle, null, null);

      expect(circuitBreaker.isActive(makeUTCDate(14, 5, 0))).toBe(false);
    });
  });
});
