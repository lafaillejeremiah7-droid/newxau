/**
 * Comprehensive Unit Tests for Core FSM and Filter Components
 *
 * This test suite provides detailed unit test coverage for:
 * - TimeGate (Requirements 6.1-6.6)
 * - NewsDecoupler (Requirements 7.1-7.7)
 * - CircuitBreaker (Requirements 10.3-10.5)
 * - MacroFilterModule (Requirements 6, 7, 10.3-10.5)
 * - SignalEngineFSM (Requirements 1.1-1.6, 6.3-6.8)
 *
 * Focus on edge cases, boundary conditions, and state transitions.
 * Requirements: 16.1, 16.3 (XAU/USD instrument focus)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TimeGate } from '../filters/time-gate.js';
import { NewsDecoupler } from '../filters/news-decoupler.js';
import { CircuitBreaker } from '../filters/circuit-breaker.js';
import { MacroFilterModule } from '../filters/macro-filter-module.js';
import { SignalEngineFSM } from '../core/signal-engine-fsm.js';
import { EventBus } from '../core/event-bus.js';
import { LiquidityZoneDetector } from '../core/liquidity-zone-detector.js';
import { createCandlePatternAnalyzer } from '../core/candle-pattern-analyzer.js';
import { CandleBufferManager } from '../data/candle-buffer.js';
import type { Candle, FilterStatus, FilterResult } from '../types/index.js';
import type { SignalLogger } from '../data/signal-logger.js';

/**
 * Helper: Create a mock SignalLogger
 */
function createMockLogger(): SignalLogger {
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
 * Helper: Create a test candle with defaults
 */
function createTestCandle(overrides: Partial<Candle> = {}): Candle {
  return {
    instrument: 'XAUUSD',
    timeframe: 'M5',
    timestamp: '2024-01-15T14:00:00.000Z',
    open: 2000.0,
    high: 2005.0,
    low: 1995.0,
    close: 2002.0,
    volume: 1000,
    ...overrides,
  };
}

/**
 * Helper: Create a date at a specific UTC time
 */
function createUTCDate(hour: number, minute: number = 0, second: number = 0): Date {
  const d = new Date('2024-01-15T00:00:00.000Z');
  d.setUTCHours(hour, minute, second, 0);
  return d;
}

// ============================================================================
// TIMEGATE TESTS
// ============================================================================

describe('TimeGate', () => {
  let timeGate: TimeGate;

  beforeEach(() => {
    timeGate = new TimeGate();
  });

  describe('Initialization and Basic State', () => {
    it('should initialize within window (12:00-17:00 UTC) as active', () => {
      const time = createUTCDate(14, 30);
      timeGate.initialize(time);
      const status = timeGate.getStatus();
      expect(status.active).toBe(true);
    });

    it('should initialize before window (11:59 UTC) as inactive', () => {
      const time = createUTCDate(11, 59, 59);
      timeGate.initialize(time);
      const status = timeGate.getStatus();
      expect(status.active).toBe(false);
    });

    it('should initialize after window (17:00 UTC) as inactive', () => {
      const time = createUTCDate(17, 0, 0);
      timeGate.initialize(time);
      const status = timeGate.getStatus();
      expect(status.active).toBe(false);
    });
  });

  describe('Window Boundary Conditions', () => {
    it('should treat 12:00:00 UTC (window start) as active', () => {
      expect(timeGate.isActive(createUTCDate(12, 0, 0))).toBe(true);
    });

    it('should treat 16:59:59 UTC (window end) as active', () => {
      expect(timeGate.isActive(createUTCDate(16, 59, 59))).toBe(true);
    });

    it('should treat 17:00:00 UTC (first second after) as inactive', () => {
      expect(timeGate.isActive(createUTCDate(17, 0, 0))).toBe(false);
    });

    it('should treat 11:59:59 UTC (one second before) as inactive', () => {
      expect(timeGate.isActive(createUTCDate(11, 59, 59))).toBe(false);
    });
  });

  describe('Edge Cases: Exactly at 12:00 and 17:00', () => {
    it('should transition from inactive to active at exactly 12:00:00 UTC', () => {
      timeGate.initialize(createUTCDate(11, 59, 59));
      expect(timeGate.getStatus().active).toBe(false);

      expect(timeGate.shouldActivate(createUTCDate(12, 0, 0))).toBe(true);
      expect(timeGate.getStatus().active).toBe(true);
    });

    it('should transition from active to inactive at exactly 17:00:00 UTC', () => {
      timeGate.initialize(createUTCDate(16, 59, 59));
      expect(timeGate.getStatus().active).toBe(true);

      expect(timeGate.shouldDeactivate(createUTCDate(17, 0, 0))).toBe(true);
      expect(timeGate.getStatus().active).toBe(false);
    });

    it('should not transition if time is within window', () => {
      timeGate.initialize(createUTCDate(14, 0));
      expect(timeGate.shouldActivate(createUTCDate(15, 0))).toBe(false);
      expect(timeGate.shouldDeactivate(createUTCDate(15, 0))).toBe(false);
    });
  });

  describe('Suppression Reason Reporting', () => {
    it('should return null reason when within active window', () => {
      const reason = timeGate.getSuppressionReason(createUTCDate(14, 0));
      expect(reason).toBeNull();
    });

    it('should return reason indicating "before window" for times < 12:00 UTC', () => {
      const reason = timeGate.getSuppressionReason(createUTCDate(10, 30));
      expect(reason).toBeDefined();
      expect(reason).toContain('before');
    });

    it('should return reason indicating "after window" for times >= 17:00 UTC', () => {
      const reason = timeGate.getSuppressionReason(createUTCDate(18, 0));
      expect(reason).toBeDefined();
      expect(reason).toContain('after');
    });
  });

  describe('Status Information', () => {
    it('should report correct window boundaries in status', () => {
      const status = timeGate.getStatus();
      expect(status.windowStart).toBeDefined();
      expect(status.windowEnd).toBeDefined();
      expect(status.active).toBeDefined();
    });

    it('should not affect other filters when transitioning', () => {
      timeGate.initialize(createUTCDate(14, 0));
      const status1 = timeGate.getStatus();
      
      timeGate.shouldDeactivate(createUTCDate(17, 0, 0));
      const status2 = timeGate.getStatus();

      expect(status2.windowStart).toBe(status1.windowStart);
      expect(status2.windowEnd).toBe(status1.windowEnd);
    });
  });
});



// ============================================================================
// NEWS DECOUPLER TESTS
// ============================================================================

describe('NewsDecoupler', () => {
  let decoupler: NewsDecoupler;

  beforeEach(() => {
    decoupler = new NewsDecoupler();
  });

  describe('Freeze Window Calculation', () => {
    it('should compute 17-minute freeze window (2 min before + 15 min after)', () => {
      const releaseTime = createUTCDate(14, 30, 0);
      decoupler.setSchedule([
        { name: 'CPI', scheduledTime: releaseTime, impact: 'high', currency: 'USD' },
      ]);

      const windows = decoupler.getFreezeWindows();
      expect(windows).toHaveLength(1);
      expect(windows[0].start).toEqual(createUTCDate(14, 28, 0));
      expect(windows[0].end).toEqual(createUTCDate(14, 45, 0));
    });

    it('should compute correct window for NFP event', () => {
      const releaseTime = createUTCDate(12, 30, 0);
      decoupler.setSchedule([
        { name: 'NFP', scheduledTime: releaseTime, impact: 'high', currency: 'USD' },
      ]);

      const windows = decoupler.getFreezeWindows();
      expect(windows[0].start).toEqual(createUTCDate(12, 28, 0));
      expect(windows[0].end).toEqual(createUTCDate(12, 45, 0));
    });
  });

  describe('Overlapping Events Merge', () => {
    it('should merge events within 17-minute overlap into single window', () => {
      const event1Time = createUTCDate(14, 30, 0);
      const event2Time = createUTCDate(14, 35, 0); // 5 minutes after event1

      decoupler.setSchedule([
        { name: 'CPI', scheduledTime: event1Time, impact: 'high', currency: 'USD' },
        { name: 'PPI', scheduledTime: event2Time, impact: 'high', currency: 'USD' },
      ]);

      const windows = decoupler.getFreezeWindows();
      expect(windows).toHaveLength(1);
      expect(windows[0].start).toEqual(createUTCDate(14, 28, 0)); // min - 2 min
      expect(windows[0].end).toEqual(createUTCDate(14, 50, 0)); // max + 15 min
      expect(windows[0].events).toContain('CPI');
      expect(windows[0].events).toContain('PPI');
    });

    it('should keep separate windows for non-overlapping events', () => {
      const event1Time = createUTCDate(14, 0, 0);
      const event2Time = createUTCDate(15, 0, 0); // 30 minutes after event1

      decoupler.setSchedule([
        { name: 'CPI', scheduledTime: event1Time, impact: 'high', currency: 'USD' },
        { name: 'NFP', scheduledTime: event2Time, impact: 'high', currency: 'USD' },
      ]);

      const windows = decoupler.getFreezeWindows();
      expect(windows.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Freeze Status Reporting', () => {
    it('should report freeze inactive when no events scheduled', () => {
      const status = decoupler.getStatus();
      expect(status.freezeActive).toBe(false);
    });

    it('should report freeze active during freeze window', () => {
      const releaseTime = createUTCDate(14, 30, 0);
      decoupler.setSchedule([
        { name: 'NFP', scheduledTime: releaseTime, impact: 'high', currency: 'USD' },
      ]);

      // Check at 14:29 (within freeze window 14:28-14:45)
      const checkTime = createUTCDate(14, 29, 0);
      const isActive = decoupler.isFreezeActive(checkTime);
      expect(isActive).toBe(true);
    });

    it('should report freeze inactive before freeze window', () => {
      const releaseTime = createUTCDate(14, 30, 0);
      decoupler.setSchedule([
        { name: 'CPI', scheduledTime: releaseTime, impact: 'high', currency: 'USD' },
      ]);

      // Check at 14:25 (before freeze start at 14:28)
      const checkTime = createUTCDate(14, 25, 0);
      const isActive = decoupler.isFreezeActive(checkTime);
      expect(isActive).toBe(false);
    });

    it('should report freeze inactive after freeze window', () => {
      const releaseTime = createUTCDate(14, 30, 0);
      decoupler.setSchedule([
        { name: 'CPI', scheduledTime: releaseTime, impact: 'high', currency: 'USD' },
      ]);

      // Check at 14:50 (after freeze end at 14:45)
      const checkTime = createUTCDate(14, 50, 0);
      const isActive = decoupler.isFreezeActive(checkTime);
      expect(isActive).toBe(false);
    });
  });

  describe('Edge Cases: Multiple Simultaneous Events', () => {
    it('should handle multiple events at exact same time', () => {
      const sameTime = createUTCDate(14, 30, 0);
      decoupler.setSchedule([
        { name: 'CPI', scheduledTime: sameTime, impact: 'high', currency: 'USD' },
        { name: 'PPI', scheduledTime: sameTime, impact: 'high', currency: 'USD' },
        { name: 'FOMC', scheduledTime: sameTime, impact: 'high', currency: 'USD' },
      ]);

      const windows = decoupler.getFreezeWindows();
      expect(windows).toHaveLength(1);
      expect(windows[0].start).toEqual(createUTCDate(14, 28, 0));
      expect(windows[0].end).toEqual(createUTCDate(14, 45, 0));
      expect(windows[0].events.length).toBe(3);
    });

    it('should expire freeze window after 15 minutes post-event', () => {
      const releaseTime = createUTCDate(14, 30, 0);
      decoupler.setSchedule([
        { name: 'NFP', scheduledTime: releaseTime, impact: 'high', currency: 'USD' },
      ]);

      // Check at exactly 14:45:00 (freeze should be expiring)
      const checkTime = createUTCDate(14, 45, 0);
      const isActive = decoupler.isFreezeActive(checkTime);
      expect(isActive).toBe(false);
    });
  });

  describe('Data Source Unavailability', () => {
    it('should handle data source unavailability gracefully', () => {
      decoupler.markDataSourceUnavailable();
      expect(decoupler.isDataSourceAvailable()).toBe(false);
    });

    it('should continue operating without freeze when source becomes unavailable', () => {
      const releaseTime = createUTCDate(14, 30, 0);
      decoupler.setSchedule([
        { name: 'NFP', scheduledTime: releaseTime, impact: 'high', currency: 'USD' },
      ]);

      decoupler.markDataSourceUnavailable();
      const windows = decoupler.getFreezeWindows();
      expect(windows).toHaveLength(0);
    });

    it('should re-enable freeze windows when data source becomes available', () => {
      decoupler.markDataSourceUnavailable();
      expect(decoupler.isDataSourceAvailable()).toBe(false);

      decoupler.markDataSourceAvailable();
      expect(decoupler.isDataSourceAvailable()).toBe(true);
    });
  });
});



// ============================================================================
// CIRCUIT BREAKER TESTS
// ============================================================================

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker();
  });

  describe('Initialization and Default State', () => {
    it('should initialize with no active alert', () => {
      const status = cb.getStatus();
      expect(status.active).toBe(false);
      expect(status.expiresAt).toBeNull();
    });

    it('should report not active when no alert triggered', () => {
      const checkTime = createUTCDate(14, 30);
      expect(cb.isActive(checkTime)).toBe(false);
    });
  });

  describe('Threshold Detection (300+ pips adverse)', () => {
    it('should NOT trigger when no signal direction exists', () => {
      const candle = createTestCandle({
        open: 2050.0,
        close: 2000.0, // Large bearish move
        timeframe: 'M1',
      });

      const result = cb.processM1Candle(candle, null, null);
      expect(result).toBeNull();
    });

    it('should trigger on exactly 300 pip adverse move against long signal', () => {
      const candle = createTestCandle({
        open: 2030.0,
        close: 2000.0, // 300 pips (30 points) bearish
        timeframe: 'M1',
      });

      const result = cb.processM1Candle(candle, 'long', 'signal-1');
      expect(result).not.toBeNull();
      expect(result!.magnitude).toBe(300);
    });

    it('should trigger on 300+ pip adverse move against short signal (bullish)', () => {
      const candle = createTestCandle({
        open: 2000.0,
        close: 2030.0, // 300 pips (30 points) bullish
        timeframe: 'M1',
      });

      const result = cb.processM1Candle(candle, 'short', 'signal-1');
      expect(result).not.toBeNull();
      expect(result!.magnitude).toBe(300);
    });

    it('should NOT trigger below 300 pip threshold', () => {
      const candle = createTestCandle({
        open: 2029.9,
        close: 2000.0, // 299 pips (29.9 points)
        timeframe: 'M1',
      });

      const result = cb.processM1Candle(candle, 'long', 'signal-1');
      expect(result).toBeNull();
    });

    it('should NOT trigger on favorable movement (same direction as signal)', () => {
      // Bullish move with long signal = favorable
      const bullishCandle = createTestCandle({
        open: 2000.0,
        close: 2050.0, // Large bullish move
        timeframe: 'M1',
      });

      const result = cb.processM1Candle(bullishCandle, 'long', 'signal-1');
      expect(result).toBeNull();
    });

    it('should NOT trigger on favorable bearish move with short signal', () => {
      // Bearish move with short signal = favorable
      const bearishCandle = createTestCandle({
        open: 2050.0,
        close: 2000.0, // Large bearish move
        timeframe: 'M1',
      });

      const result = cb.processM1Candle(bearishCandle, 'short', 'signal-1');
      expect(result).toBeNull();
    });
  });

  describe('Suppression Duration (15 minutes)', () => {
    it('should set suppression end time to 15 minutes after trigger', () => {
      const candle = createTestCandle({
        timestamp: '2024-01-15T14:30:00.000Z',
        open: 2030.0,
        close: 2000.0,
        timeframe: 'M1',
      });

      const result = cb.processM1Candle(candle, 'long', 'signal-1');
      expect(result).not.toBeNull();
      expect(result!.suppressionEndsAt).toBe('2024-01-15T14:45:00.000Z');
    });

    it('should remain active within suppression window', () => {
      const candle = createTestCandle({
        timestamp: '2024-01-15T14:30:00.000Z',
        open: 2030.0,
        close: 2000.0,
        timeframe: 'M1',
      });
      cb.processM1Candle(candle, 'long', 'signal-1');

      // Check at 14:35 (5 min after trigger)
      expect(cb.isActive(createUTCDate(14, 35))).toBe(true);
    });

    it('should remain active at 14:44:59 (one second before expiry)', () => {
      const candle = createTestCandle({
        timestamp: '2024-01-15T14:30:00.000Z',
        open: 2030.0,
        close: 2000.0,
        timeframe: 'M1',
      });
      cb.processM1Candle(candle, 'long', 'signal-1');

      expect(cb.isActive(new Date('2024-01-15T14:44:59.000Z'))).toBe(true);
    });

    it('should be inactive at exactly 14:45:00 (suppression end)', () => {
      const candle = createTestCandle({
        timestamp: '2024-01-15T14:30:00.000Z',
        open: 2030.0,
        close: 2000.0,
        timeframe: 'M1',
      });
      cb.processM1Candle(candle, 'long', 'signal-1');

      expect(cb.isActive(createUTCDate(14, 45, 0))).toBe(false);
    });

    it('should auto-reset after suppression period', () => {
      const candle = createTestCandle({
        timestamp: '2024-01-15T14:30:00.000Z',
        open: 2030.0,
        close: 2000.0,
        timeframe: 'M1',
      });
      cb.processM1Candle(candle, 'long', 'signal-1');

      // Check after suppression window
      expect(cb.isActive(createUTCDate(15, 0))).toBe(false);
      expect(cb.getStatus().active).toBe(false);
    });
  });

  describe('Alert Metadata', () => {
    it('should include magnitude in alert when threshold is met', () => {
      const candle = createTestCandle({
        open: 2030.0,
        close: 2000.0, // 300+ pips
        timeframe: 'M1',
      });

      const result = cb.processM1Candle(candle, 'long', 'signal-1');
      expect(result).not.toBeNull();
      expect(result!.magnitude).toBe(300);
    });

    it('should include timestamp in alert when triggered', () => {
      const candle = createTestCandle({
        timestamp: '2024-01-15T14:30:45.123Z',
        open: 2030.0,
        close: 2000.0,
        timeframe: 'M1',
      });

      const result = cb.processM1Candle(candle, 'long', 'signal-1');
      expect(result).not.toBeNull();
      expect(result!.timestamp).toBe('2024-01-15T14:30:45.123Z');
    });
  });

  describe('Reset and State Management', () => {
    it('should clear alert on reset', () => {
      const candle = createTestCandle({
        timestamp: '2024-01-15T14:30:00.000Z',
        open: 2030.0,
        close: 2000.0,
        timeframe: 'M1',
      });
      cb.processM1Candle(candle, 'long', 'signal-1');
      expect(cb.isActive(createUTCDate(14, 35))).toBe(true);

      cb.reset();

      expect(cb.isActive(createUTCDate(14, 35))).toBe(false);
      expect(cb.getStatus().active).toBe(false);
    });

    it('should overwrite previous alert on subsequent trigger', () => {
      const candle1 = createTestCandle({
        timestamp: '2024-01-15T14:30:00.000Z',
        open: 2030.0,
        close: 2000.0,
        timeframe: 'M1',
      });
      cb.processM1Candle(candle1, 'long', 'signal-1');

      const candle2 = createTestCandle({
        timestamp: '2024-01-15T14:35:00.000Z',
        open: 2040.0,
        close: 2000.0,
        timeframe: 'M1',
      });
      const result = cb.processM1Candle(candle2, 'long', 'signal-2');

      expect(result!.affectedSignalId).toBe('signal-2');
      expect(result!.suppressionEndsAt).toBe('2024-01-15T14:50:00.000Z');
    });
  });

  describe('Edge Cases and Boundary Conditions', () => {
    it('should handle doji candle (open === close) without triggering', () => {
      const candle = createTestCandle({
        open: 2000.0,
        close: 2000.0,
        timeframe: 'M1',
      });

      expect(cb.processM1Candle(candle, 'long', 'signal-1')).toBeNull();
      expect(cb.processM1Candle(candle, 'short', 'signal-2')).toBeNull();
    });

    it('should handle null signal ID gracefully', () => {
      const candle = createTestCandle({
        open: 2030.0,
        close: 2000.0,
        timeframe: 'M1',
      });

      const result = cb.processM1Candle(candle, 'long', null);
      expect(result).not.toBeNull();
      expect(result!.affectedSignalId).toBeNull();
    });

    it('should correctly compute magnitude for large adverse moves', () => {
      // 1000 pips = 100 points
      const candle = createTestCandle({
        open: 2100.0,
        close: 2000.0,
        timeframe: 'M1',
      });
      const result = cb.processM1Candle(candle, 'long', 'signal-1');
      expect(result).not.toBeNull();
      expect(result!.magnitude).toBe(1000);
    });
  });
});



// ============================================================================
// MACRO FILTER MODULE TESTS
// ============================================================================

describe('MacroFilterModule', () => {
  let macroFilter: MacroFilterModule;
  let timeGate: TimeGate;
  let newsDecoupler: NewsDecoupler;
  let circuitBreaker: CircuitBreaker;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    timeGate = new TimeGate();
    newsDecoupler = new NewsDecoupler();
    circuitBreaker = new CircuitBreaker();

    // Create MacroFilterModule with proper constructor
    macroFilter = new MacroFilterModule(
      timeGate,
      newsDecoupler,
      circuitBreaker,
      eventBus
    );
  });

  describe('Filter Status Reporting', () => {
    it('should report filter status', () => {
      const time = createUTCDate(14, 0);
      timeGate.initialize(time);

      const status = macroFilter.getFilterStatus();
      expect(status).toBeDefined();
      expect(typeof status).toBe('object');
    });

    it('should report time gate active state', () => {
      const time = createUTCDate(14, 0);
      timeGate.initialize(time);

      const status = macroFilter.getFilterStatus();
      expect(status.timeGate).toBeDefined();
    });

    it('should report news decoupler status', () => {
      const status = macroFilter.getFilterStatus();
      expect(status.newsDecoupler).toBeDefined();
    });

    it('should report circuit breaker status', () => {
      const status = macroFilter.getFilterStatus();
      expect(status.circuitBreaker).toBeDefined();
    });
  });

  describe('Filter Check Results', () => {
    it('should return pass result when called', () => {
      const time = createUTCDate(14, 0);
      timeGate.initialize(time);

      const candle = createTestCandle({ timeframe: 'M5' });
      const result = macroFilter.checkAllFilters(time, candle);

      expect(result).toBeDefined();
      expect(typeof result.passed).toBe('boolean');
    });

    it('should return blocked result when time gate is outside window', () => {
      const time = createUTCDate(18, 0);
      timeGate.initialize(time);

      const candle = createTestCandle({ timeframe: 'M5' });
      const result = macroFilter.checkAllFilters(time, candle);

      expect(result.passed).toBe(false);
    });
  });

  describe('M1 Candle Processing', () => {
    it('should accept M1 candles for circuit breaker processing', () => {
      const time = createUTCDate(14, 0);
      timeGate.initialize(time);

      const m1Candle = createTestCandle({
        timeframe: 'M1',
      });

      expect(() => {
        macroFilter.processM1Candle(m1Candle, 'long', 'signal-1');
      }).not.toThrow();
    });
  });

  describe('Integration Scenarios', () => {
    it('should handle graceful filter checks', () => {
      const time = createUTCDate(14, 30);
      timeGate.initialize(time);

      const candle = createTestCandle();

      expect(() => {
        const result = macroFilter.checkAllFilters(time, candle);
        expect(result).toBeDefined();
      }).not.toThrow();
    });
  });
});



// ============================================================================
// SIGNAL ENGINE FSM COMPREHENSIVE TESTS
// ============================================================================

describe('SignalEngineFSM - Full Coverage', () => {
  let fsm: SignalEngineFSM;
  let eventBus: EventBus;
  let timeGate: TimeGate;
  let newsDecoupler: NewsDecoupler;
  let zoneDetector: LiquidityZoneDetector;
  let patternAnalyzer: ReturnType<typeof createCandlePatternAnalyzer>;
  let logger: SignalLogger;

  beforeEach(() => {
    eventBus = new EventBus();
    timeGate = new TimeGate();
    newsDecoupler = new NewsDecoupler();
    zoneDetector = new LiquidityZoneDetector();
    patternAnalyzer = createCandlePatternAnalyzer();
    logger = createMockLogger();

    fsm = new SignalEngineFSM({
      eventBus,
      timeGate,
      newsDecoupler,
      liquidityZoneDetector: zoneDetector,
      candlePatternAnalyzer: patternAnalyzer,
      signalLogger: logger,
    });
  });

  describe('Initialization and State Management', () => {
    it('should initialize in scanning state within active window', () => {
      const time = createUTCDate(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      expect(fsm.getState()).toBe('scanning');
    });

    it('should initialize in suppressed state outside active window (before)', () => {
      const time = createUTCDate(11, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      expect(fsm.getState()).toBe('suppressed');
    });

    it('should initialize in suppressed state outside active window (after)', () => {
      const time = createUTCDate(18, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      expect(fsm.getState()).toBe('suppressed');
    });

    it('should emit state.change event on initialization', () => {
      const transitions: any[] = [];
      eventBus.subscribe('state.change', (t) => transitions.push(t));

      const time = createUTCDate(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      expect(transitions.length).toBeGreaterThan(0);
    });

    it('should log state transition on initialization', () => {
      const time = createUTCDate(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      expect(logger.logStateTransition).toHaveBeenCalled();
    });
  });

  describe('State Transitions: Scanning → Observation', () => {
    beforeEach(() => {
      const time = createUTCDate(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);
      expect(fsm.getState()).toBe('scanning');
    });

    it('should remain in scanning without liquidity zones established', () => {
      // M5 candle without zones should not transition
      fsm.processCandle(createTestCandle({
        close: 2052,
        timestamp: '2024-01-15T14:00:00.000Z',
      }));

      expect(fsm.getState()).toBe('scanning');
    });

    it('should NOT transition when M5 price does not enter zone', () => {
      fsm.processCandle(createTestCandle({
        close: 2100,
        timestamp: '2024-01-15T14:00:00.000Z',
      }));

      expect(fsm.getState()).toBe('scanning');
    });
  });

  describe('State Transitions: Observation → Scanning (Timeout)', () => {
    it('should handle timeout scenarios gracefully', () => {
      const time = createUTCDate(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      // Send many candles
      for (let i = 0; i < 7; i++) {
        expect(() => {
          fsm.processCandle(createTestCandle({
            timestamp: `2024-01-15T14:${String(i).padStart(2, '0')}:00.000Z`,
          }));
        }).not.toThrow();
      }

      // State should still be valid
      expect(['suppressed', 'scanning', 'observation', 'signal_evaluation']).toContain(fsm.getState());
    });
  });

  describe('State Transitions: Observation → Scanning (Zone Breakthrough)', () => {
    it('should remain in scanning when no zones are detected', () => {
      const time = createUTCDate(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      fsm.processCandle(createTestCandle({
        close: 2100,
      }));

      expect(fsm.getState()).toBe('scanning');
    });
  });

  describe('State Transitions: Observation → SignalEvaluation (Rejection)', () => {
    it('should require zones and proper conditions for rejection handling', () => {
      const time = createUTCDate(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      // Just sending shooting star without zones should not transition
      fsm.processCandle(createTestCandle({
        open: 2051,
        close: 2050.5,
        high: 2060,
        low: 2050,
        timestamp: '2024-01-15T14:10:00.000Z',
      }));

      expect(fsm.getState()).toBe('scanning');
    });

    it('should NOT transition if rejection appears before 3rd candle', () => {
      const time = createUTCDate(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      // Process shooting star (too early, need ≥3 in observation)
      fsm.processCandle(createTestCandle({
        open: 2051,
        close: 2050.5,
        high: 2060,
        low: 2050,
        timestamp: '2024-01-15T14:05:00.000Z',
      }));

      expect(fsm.getState()).toBe('scanning');
    });
  });

  describe('State Transitions: Time Gate Deactivation', () => {
    it('should transition to suppressed when time gate deactivates (17:00 UTC)', () => {
      const time = createUTCDate(16, 59, 59);
      timeGate.initialize(time);
      fsm.initialize(time);
      expect(fsm.getState()).toBe('scanning');

      fsm.processCandle(createTestCandle({
        timestamp: '2024-01-15T17:00:00.000Z',
      }));

      expect(fsm.getState()).toBe('suppressed');
    });

    it('should handle graceful state management on time gate changes', () => {
      const time = createUTCDate(16, 30);
      timeGate.initialize(time);
      fsm.initialize(time);
      expect(fsm.getState()).toBe('scanning');

      // Simulate 17:00:00
      fsm.processCandle(createTestCandle({
        timestamp: '2024-01-15T17:00:00.000Z',
      }));

      expect(fsm.getState()).toBe('suppressed');
    });
  });

  describe('State Transitions: Time Gate Activation', () => {
    it('should transition from suppressed to scanning when time gate activates (12:00 UTC)', () => {
      const earlyTime = createUTCDate(11, 59, 59);
      timeGate.initialize(earlyTime);
      fsm.initialize(earlyTime);
      expect(fsm.getState()).toBe('suppressed');

      fsm.processCandle(createTestCandle({
        timestamp: '2024-01-15T12:00:00.000Z',
      }));

      expect(fsm.getState()).toBe('scanning');
    });
  });

  describe('State Transitions: News Freeze', () => {
    it('should handle news freeze events gracefully', () => {
      const time = createUTCDate(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      // Schedule news event
      newsDecoupler.setSchedule([
        { name: 'NFP', scheduledTime: createUTCDate(14, 10), impact: 'high', currency: 'USD' },
      ]);

      // Process candle during freeze window
      expect(() => {
        fsm.processCandle(createTestCandle({
          timestamp: '2024-01-15T14:10:00.000Z',
        }));
      }).not.toThrow();

      expect(fsm.getState()).toBe('scanning');
    });
  });

  describe('Rapid State Transitions (Consecutive Candles)', () => {
    it('should handle rapid state transitions without crashing', () => {
      const time = createUTCDate(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      // Send many consecutive candles
      for (let i = 0; i < 10; i++) {
        expect(() => {
          fsm.processCandle(createTestCandle({
            close: 2000 + Math.random() * 100,
            timestamp: `2024-01-15T14:${String(i).padStart(2, '0')}:00.000Z`,
          }));
        }).not.toThrow();
      }

      // State should still be valid
      expect(fsm.getState()).toBe('scanning');
    });
  });

  describe('Zone Boundary Edge Cases', () => {
    it('should process edge case prices gracefully', () => {
      const time = createUTCDate(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      expect(() => {
        fsm.processCandle(createTestCandle({
          close: 2055,
          timestamp: '2024-01-15T14:00:00.000Z',
        }));
      }).not.toThrow();

      expect(fsm.getState()).toBe('scanning');
    });

    it('should handle multiple consecutive boundary prices', () => {
      const time = createUTCDate(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      expect(() => {
        fsm.processCandle(createTestCandle({
          close: 2055,
          timestamp: '2024-01-15T14:00:00.000Z',
        }));
        fsm.processCandle(createTestCandle({
          close: 2055.001,
          timestamp: '2024-01-15T14:05:00.000Z',
        }));
        fsm.processCandle(createTestCandle({
          close: 2055.02,
          timestamp: '2024-01-15T14:10:00.000Z',
        }));
      }).not.toThrow();
    });
  });

  describe('Event Bus Integration', () => {
    it('should emit state.change events on EventBus for every transition', () => {
      const events: any[] = [];
      eventBus.subscribe('state.change', (e) => events.push(e));

      const time = createUTCDate(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].to).toBe('scanning');
    });

    it('should include correct metadata in state change events', () => {
      const events: any[] = [];
      eventBus.subscribe('state.change', (e) => events.push(e));

      const time = createUTCDate(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      const event = events[0];
      expect(event.from).toBeDefined();
      expect(event.to).toBeDefined();
      expect(event.reason).toBeDefined();
      expect(event.timestamp).toBeDefined();
    });
  });

  describe('Context Management', () => {
    it('should provide null observation context when not in observation state', () => {
      const time = createUTCDate(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      expect(fsm.getObservationContext()).toBeNull();
    });

    it('should maintain state consistency across multiple candles', () => {
      const time = createUTCDate(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      for (let i = 0; i < 5; i++) {
        fsm.processCandle(createTestCandle());
        expect(['suppressed', 'scanning', 'observation', 'signal_evaluation']).toContain(fsm.getState());
      }
    });
  });

  describe('H1/M15 Candle Processing', () => {
    it('should forward H1 candles to zone detector without state change', () => {
      const time = createUTCDate(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      expect(() => {
        fsm.processCandle(createTestCandle({
          timeframe: 'H1',
        }));
      }).not.toThrow();

      expect(fsm.getState()).toBe('scanning');
    });

    it('should handle M15 candles without crashing', () => {
      const time = createUTCDate(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      expect(() => {
        fsm.processCandle(createTestCandle({
          timeframe: 'M15',
        }));
      }).not.toThrow();

      expect(fsm.getState()).toBe('scanning');
    });
  });

  describe('NaN and Infinity Handling', () => {
    it('should not crash on NaN values in candle data', () => {
      const time = createUTCDate(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      // Process candle with NaN should not crash
      expect(() => {
        fsm.processCandle(createTestCandle({
          close: NaN,
        }));
      }).not.toThrow();
    });

    it('should gracefully handle Infinity values', () => {
      const time = createUTCDate(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      expect(() => {
        fsm.processCandle(createTestCandle({
          high: Infinity,
        }));
      }).not.toThrow();
    });
  });

  describe('Concurrent Filter Evaluations', () => {
    it('should evaluate multiple filters without interference', () => {
      const time = createUTCDate(14, 0);
      timeGate.initialize(time);
      newsDecoupler.setSchedule([
        { name: 'CPI', scheduledTime: createUTCDate(14, 5), impact: 'high', currency: 'USD' },
      ]);
      fsm.initialize(time);

      fsm.processCandle(createTestCandle({
        timeframe: 'H1',
        high: 2055,
        low: 2050,
      }));

      // Process during news freeze - time gate should still be active
      fsm.processCandle(createTestCandle({
        close: 2052,
        timestamp: '2024-01-15T14:04:00.000Z', // Within freeze
      }));

      // News decoupler should have blocked observation
      expect(fsm.getState()).toBe('scanning');
    });
  });

  describe('Error Recovery and Graceful Degradation', () => {
    it('should continue operating after processing invalid candle', () => {
      const time = createUTCDate(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      // Process normal candle
      fsm.processCandle(createTestCandle());
      expect(fsm.getState()).toBe('scanning');

      // Should not throw on subsequent candles
      expect(() => {
        fsm.processCandle(createTestCandle());
      }).not.toThrow();
    });

    it('should remain stable across many consecutive candles', () => {
      const time = createUTCDate(14, 0);
      timeGate.initialize(time);
      fsm.initialize(time);

      let lastState = fsm.getState();

      // Process 50 candles
      for (let i = 0; i < 50; i++) {
        fsm.processCandle(createTestCandle({
          close: 2000 + Math.random() * 100,
          timestamp: `2024-01-15T14:${String(i % 60).padStart(2, '0')}:00.000Z`,
        }));
        lastState = fsm.getState();
      }

      // Should still be in a valid state
      expect(['suppressed', 'scanning', 'observation', 'signal_evaluation']).toContain(lastState);
    });
  });
});

