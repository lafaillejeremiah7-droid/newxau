/**
 * Unit tests for News Decoupler Filter
 *
 * Covers:
 * - Single event freeze window computation
 * - Overlapping events merge
 * - Non-overlapping events remain separate
 * - Before/during/after freeze checks
 * - Data source unavailable fallback
 * - Multiple event types
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  NewsDecoupler,
  NewsEvent,
  NewsDecouplerLogger,
} from './news-decoupler.js';

// Helper to create a date at specific time
function makeDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

// Helper to create a news event
function makeEvent(
  name: 'CPI' | 'NFP' | 'FOMC' | 'GDP' | 'PPI',
  scheduledTime: Date
): NewsEvent {
  return {
    name,
    scheduledTime,
    impact: 'high',
    currency: 'USD',
  };
}

describe('NewsDecoupler', () => {
  let decoupler: NewsDecoupler;
  let mockLogger: NewsDecouplerLogger;

  beforeEach(() => {
    mockLogger = {
      warn: vi.fn(),
      info: vi.fn(),
    };
    decoupler = new NewsDecoupler(mockLogger);
  });

  describe('Single event freeze window computation', () => {
    it('should compute a 17-minute freeze window (2 min before → 15 min after)', () => {
      const eventTime = makeDate(2024, 6, 12, 14, 30, 0); // 14:30 UTC
      decoupler.setSchedule([makeEvent('CPI', eventTime)]);

      const windows = decoupler.getFreezeWindows();
      expect(windows).toHaveLength(1);
      expect(windows[0].start).toEqual(makeDate(2024, 6, 12, 14, 28, 0)); // 14:28 UTC
      expect(windows[0].end).toEqual(makeDate(2024, 6, 12, 14, 45, 0)); // 14:45 UTC
      expect(windows[0].events).toEqual(['CPI']);
    });

    it('should create correct window for NFP event', () => {
      const eventTime = makeDate(2024, 7, 5, 12, 30, 0);
      decoupler.setSchedule([makeEvent('NFP', eventTime)]);

      const windows = decoupler.getFreezeWindows();
      expect(windows).toHaveLength(1);
      expect(windows[0].start).toEqual(makeDate(2024, 7, 5, 12, 28, 0));
      expect(windows[0].end).toEqual(makeDate(2024, 7, 5, 12, 45, 0));
      expect(windows[0].events).toEqual(['NFP']);
    });

    it('should create correct window for FOMC event', () => {
      const eventTime = makeDate(2024, 9, 18, 18, 0, 0);
      decoupler.setSchedule([makeEvent('FOMC', eventTime)]);

      const windows = decoupler.getFreezeWindows();
      expect(windows).toHaveLength(1);
      expect(windows[0].start).toEqual(makeDate(2024, 9, 18, 17, 58, 0));
      expect(windows[0].end).toEqual(makeDate(2024, 9, 18, 18, 15, 0));
    });
  });

  describe('Overlapping events merge', () => {
    it('should merge two events scheduled 5 minutes apart into one window', () => {
      const event1Time = makeDate(2024, 6, 12, 14, 30, 0);
      const event2Time = makeDate(2024, 6, 12, 14, 35, 0);

      decoupler.setSchedule([
        makeEvent('CPI', event1Time),
        makeEvent('PPI', event2Time),
      ]);

      const windows = decoupler.getFreezeWindows();
      expect(windows).toHaveLength(1);
      // Merged: min start (14:28) to max end (14:50)
      expect(windows[0].start).toEqual(makeDate(2024, 6, 12, 14, 28, 0));
      expect(windows[0].end).toEqual(makeDate(2024, 6, 12, 14, 50, 0));
      expect(windows[0].events).toContain('CPI');
      expect(windows[0].events).toContain('PPI');
    });

    it('should merge events within 17 minutes of each other', () => {
      // Event1 at 14:30, freeze ends at 14:45
      // Event2 at 14:44 (freeze starts 14:42, which is before 14:45)
      const event1Time = makeDate(2024, 6, 12, 14, 30, 0);
      const event2Time = makeDate(2024, 6, 12, 14, 44, 0);

      decoupler.setSchedule([
        makeEvent('CPI', event1Time),
        makeEvent('GDP', event2Time),
      ]);

      const windows = decoupler.getFreezeWindows();
      expect(windows).toHaveLength(1);
      expect(windows[0].start).toEqual(makeDate(2024, 6, 12, 14, 28, 0));
      expect(windows[0].end).toEqual(makeDate(2024, 6, 12, 14, 59, 0));
      expect(windows[0].events).toEqual(['CPI', 'GDP']);
    });

    it('should merge three overlapping events into one window', () => {
      const event1Time = makeDate(2024, 6, 12, 14, 30, 0);
      const event2Time = makeDate(2024, 6, 12, 14, 35, 0);
      const event3Time = makeDate(2024, 6, 12, 14, 40, 0);

      decoupler.setSchedule([
        makeEvent('CPI', event1Time),
        makeEvent('PPI', event2Time),
        makeEvent('GDP', event3Time),
      ]);

      const windows = decoupler.getFreezeWindows();
      expect(windows).toHaveLength(1);
      expect(windows[0].start).toEqual(makeDate(2024, 6, 12, 14, 28, 0));
      expect(windows[0].end).toEqual(makeDate(2024, 6, 12, 14, 55, 0));
      expect(windows[0].events).toHaveLength(3);
    });

    it('should merge events when second starts exactly when first ends', () => {
      // Event1 at 14:30, freeze ends at 14:45
      // Event2 at 14:47, freeze starts at 14:45 (exactly at first end)
      const event1Time = makeDate(2024, 6, 12, 14, 30, 0);
      const event2Time = makeDate(2024, 6, 12, 14, 47, 0);

      decoupler.setSchedule([
        makeEvent('NFP', event1Time),
        makeEvent('FOMC', event2Time),
      ]);

      const windows = decoupler.getFreezeWindows();
      expect(windows).toHaveLength(1);
      expect(windows[0].start).toEqual(makeDate(2024, 6, 12, 14, 28, 0));
      expect(windows[0].end).toEqual(makeDate(2024, 6, 12, 15, 2, 0));
    });
  });

  describe('Non-overlapping events remain separate', () => {
    it('should keep separate windows for events far apart', () => {
      const event1Time = makeDate(2024, 6, 12, 12, 0, 0); // 12:00
      const event2Time = makeDate(2024, 6, 12, 14, 30, 0); // 14:30

      decoupler.setSchedule([
        makeEvent('CPI', event1Time),
        makeEvent('NFP', event2Time),
      ]);

      const windows = decoupler.getFreezeWindows();
      expect(windows).toHaveLength(2);

      expect(windows[0].start).toEqual(makeDate(2024, 6, 12, 11, 58, 0));
      expect(windows[0].end).toEqual(makeDate(2024, 6, 12, 12, 15, 0));
      expect(windows[0].events).toEqual(['CPI']);

      expect(windows[1].start).toEqual(makeDate(2024, 6, 12, 14, 28, 0));
      expect(windows[1].end).toEqual(makeDate(2024, 6, 12, 14, 45, 0));
      expect(windows[1].events).toEqual(['NFP']);
    });

    it('should keep windows separate when gap is 1 second', () => {
      // Event1 at 12:00, freeze ends at 12:15:00
      // Event2 at 12:17:01, freeze starts at 12:15:01 (1 second after first ends)
      const event1Time = makeDate(2024, 6, 12, 12, 0, 0);
      const event2Time = new Date(
        Date.UTC(2024, 5, 12, 12, 17, 1) // 12:17:01 UTC
      );

      decoupler.setSchedule([
        makeEvent('CPI', event1Time),
        makeEvent('NFP', event2Time),
      ]);

      const windows = decoupler.getFreezeWindows();
      expect(windows).toHaveLength(2);
    });
  });

  describe('Before/during/after freeze checks', () => {
    beforeEach(() => {
      const eventTime = makeDate(2024, 6, 12, 14, 30, 0);
      decoupler.setSchedule([makeEvent('CPI', eventTime)]);
    });

    it('should NOT be active before freeze window starts', () => {
      const beforeFreeze = makeDate(2024, 6, 12, 14, 27, 59);
      expect(decoupler.isFreezeActive(beforeFreeze)).toBe(false);
      expect(decoupler.getActiveFreezeWindow(beforeFreeze)).toBeNull();
    });

    it('should be active at exactly freeze window start', () => {
      const atStart = makeDate(2024, 6, 12, 14, 28, 0);
      expect(decoupler.isFreezeActive(atStart)).toBe(true);
      expect(decoupler.getActiveFreezeWindow(atStart)).not.toBeNull();
    });

    it('should be active during freeze window', () => {
      const during = makeDate(2024, 6, 12, 14, 35, 0);
      expect(decoupler.isFreezeActive(during)).toBe(true);
    });

    it('should be active at the event release time', () => {
      const atRelease = makeDate(2024, 6, 12, 14, 30, 0);
      expect(decoupler.isFreezeActive(atRelease)).toBe(true);
    });

    it('should be active 1 second before freeze window ends', () => {
      const nearEnd = new Date(Date.UTC(2024, 5, 12, 14, 44, 59));
      expect(decoupler.isFreezeActive(nearEnd)).toBe(true);
    });

    it('should NOT be active at exactly freeze window end (exclusive)', () => {
      const atEnd = makeDate(2024, 6, 12, 14, 45, 0);
      expect(decoupler.isFreezeActive(atEnd)).toBe(false);
      expect(decoupler.getActiveFreezeWindow(atEnd)).toBeNull();
    });

    it('should NOT be active after freeze window ends', () => {
      const after = makeDate(2024, 6, 12, 15, 0, 0);
      expect(decoupler.isFreezeActive(after)).toBe(false);
    });
  });

  describe('Data source unavailable fallback', () => {
    it('should clear freeze windows when data source is unavailable', () => {
      const eventTime = makeDate(2024, 6, 12, 14, 30, 0);
      decoupler.setSchedule([makeEvent('CPI', eventTime)]);

      expect(decoupler.getFreezeWindows()).toHaveLength(1);

      decoupler.markDataSourceUnavailable();

      expect(decoupler.getFreezeWindows()).toHaveLength(0);
      expect(decoupler.isFreezeActive(makeDate(2024, 6, 12, 14, 30, 0))).toBe(
        false
      );
    });

    it('should log a warning when data source becomes unavailable', () => {
      decoupler.markDataSourceUnavailable();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'News schedule data source unavailable. Continuing without freeze window activation.',
        expect.objectContaining({ timestamp: expect.any(String) })
      );
    });

    it('should report data source availability correctly', () => {
      expect(decoupler.isDataSourceAvailable()).toBe(true);

      decoupler.markDataSourceUnavailable();
      expect(decoupler.isDataSourceAvailable()).toBe(false);

      decoupler.markDataSourceAvailable();
      expect(decoupler.isDataSourceAvailable()).toBe(true);
    });

    it('should not freeze even if time matches previously scheduled events', () => {
      const eventTime = makeDate(2024, 6, 12, 14, 30, 0);
      decoupler.setSchedule([makeEvent('NFP', eventTime)]);

      // Confirm freeze is active
      expect(decoupler.isFreezeActive(eventTime)).toBe(true);

      // Data source goes down — fail open
      decoupler.markDataSourceUnavailable();
      expect(decoupler.isFreezeActive(eventTime)).toBe(false);
    });
  });

  describe('Multiple event types', () => {
    it('should accept all valid event types: CPI, NFP, FOMC, GDP, PPI', () => {
      const baseTime = makeDate(2024, 6, 12, 12, 0, 0);
      const events: NewsEvent[] = [
        makeEvent('CPI', new Date(baseTime.getTime() + 0)),
        makeEvent('NFP', new Date(baseTime.getTime() + 60 * 60 * 1000)), // +1hr
        makeEvent('FOMC', new Date(baseTime.getTime() + 2 * 60 * 60 * 1000)), // +2hr
        makeEvent('GDP', new Date(baseTime.getTime() + 3 * 60 * 60 * 1000)), // +3hr
        makeEvent('PPI', new Date(baseTime.getTime() + 4 * 60 * 60 * 1000)), // +4hr
      ];

      decoupler.setSchedule(events);

      const windows = decoupler.getFreezeWindows();
      expect(windows).toHaveLength(5); // All separate (1hr apart)

      expect(windows[0].events).toEqual(['CPI']);
      expect(windows[1].events).toEqual(['NFP']);
      expect(windows[2].events).toEqual(['FOMC']);
      expect(windows[3].events).toEqual(['GDP']);
      expect(windows[4].events).toEqual(['PPI']);
    });

    it('should filter out non-high-impact events', () => {
      const eventTime = makeDate(2024, 6, 12, 14, 30, 0);
      const events: NewsEvent[] = [
        makeEvent('CPI', eventTime),
        {
          name: 'CPI',
          scheduledTime: new Date(eventTime.getTime() + 3600000),
          impact: 'high' as const,
          currency: 'EUR' as unknown as 'USD', // Different currency
        },
      ];

      decoupler.setSchedule(events);
      const windows = decoupler.getFreezeWindows();
      expect(windows).toHaveLength(1);
      expect(windows[0].events).toEqual(['CPI']);
    });

    it('should handle empty schedule', () => {
      decoupler.setSchedule([]);
      expect(decoupler.getFreezeWindows()).toHaveLength(0);
      expect(decoupler.isFreezeActive(new Date())).toBe(false);
    });

    it('should handle replacing schedule with new events', () => {
      const event1Time = makeDate(2024, 6, 12, 14, 30, 0);
      decoupler.setSchedule([makeEvent('CPI', event1Time)]);
      expect(decoupler.getFreezeWindows()).toHaveLength(1);

      const event2Time = makeDate(2024, 6, 13, 12, 0, 0);
      decoupler.setSchedule([makeEvent('NFP', event2Time)]);
      expect(decoupler.getFreezeWindows()).toHaveLength(1);
      expect(decoupler.getFreezeWindows()[0].events).toEqual(['NFP']);
    });
  });

  describe('getStatus', () => {
    it('should return inactive status when no freeze active', () => {
      const status = decoupler.getStatus(makeDate(2024, 6, 12, 10, 0, 0));
      expect(status).toEqual({
        freezeActive: false,
        currentEvent: null,
        freezeEnd: null,
      });
    });

    it('should return active status with event name and end time during freeze', () => {
      const eventTime = makeDate(2024, 6, 12, 14, 30, 0);
      decoupler.setSchedule([makeEvent('CPI', eventTime)]);

      const status = decoupler.getStatus(makeDate(2024, 6, 12, 14, 35, 0));
      expect(status.freezeActive).toBe(true);
      expect(status.currentEvent).toBe('CPI');
      expect(status.freezeEnd).toBe(
        makeDate(2024, 6, 12, 14, 45, 0).toISOString()
      );
    });

    it('should list multiple event names when merged', () => {
      const event1Time = makeDate(2024, 6, 12, 14, 30, 0);
      const event2Time = makeDate(2024, 6, 12, 14, 35, 0);
      decoupler.setSchedule([
        makeEvent('CPI', event1Time),
        makeEvent('PPI', event2Time),
      ]);

      const status = decoupler.getStatus(makeDate(2024, 6, 12, 14, 30, 0));
      expect(status.freezeActive).toBe(true);
      expect(status.currentEvent).toBe('CPI, PPI');
    });
  });

  describe('Logging activation/deactivation', () => {
    it('should log activation with event name and times', () => {
      const eventTime = makeDate(2024, 6, 12, 14, 30, 0);
      decoupler.setSchedule([makeEvent('NFP', eventTime)]);

      const duringFreeze = makeDate(2024, 6, 12, 14, 32, 0);
      decoupler.logActivation(duringFreeze);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'News freeze window ACTIVATED',
        expect.objectContaining({
          events: ['NFP'],
          freezeStart: makeDate(2024, 6, 12, 14, 28, 0).toISOString(),
          freezeEnd: makeDate(2024, 6, 12, 14, 45, 0).toISOString(),
          activatedAt: duringFreeze.toISOString(),
        })
      );
    });

    it('should log deactivation with event name and times', () => {
      const eventTime = makeDate(2024, 6, 12, 14, 30, 0);
      decoupler.setSchedule([makeEvent('FOMC', eventTime)]);

      const window = decoupler.getFreezeWindows()[0];
      const afterFreeze = makeDate(2024, 6, 12, 14, 45, 0);
      decoupler.logDeactivation(afterFreeze, window);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'News freeze window DEACTIVATED',
        expect.objectContaining({
          events: ['FOMC'],
          freezeStart: window.start.toISOString(),
          freezeEnd: window.end.toISOString(),
          deactivatedAt: afterFreeze.toISOString(),
        })
      );
    });
  });

  describe('Edge cases', () => {
    it('should handle events provided in non-chronological order', () => {
      const event1Time = makeDate(2024, 6, 12, 16, 0, 0);
      const event2Time = makeDate(2024, 6, 12, 12, 0, 0);
      const event3Time = makeDate(2024, 6, 12, 14, 0, 0);

      decoupler.setSchedule([
        makeEvent('GDP', event1Time),
        makeEvent('CPI', event2Time),
        makeEvent('NFP', event3Time),
      ]);

      const windows = decoupler.getFreezeWindows();
      expect(windows).toHaveLength(3);
      // Should be sorted by start time
      expect(windows[0].events).toEqual(['CPI']);
      expect(windows[1].events).toEqual(['NFP']);
      expect(windows[2].events).toEqual(['GDP']);
    });

    it('should handle events at exact same time', () => {
      const eventTime = makeDate(2024, 6, 12, 14, 30, 0);
      decoupler.setSchedule([
        makeEvent('CPI', eventTime),
        makeEvent('PPI', eventTime),
      ]);

      const windows = decoupler.getFreezeWindows();
      expect(windows).toHaveLength(1);
      expect(windows[0].events).toContain('CPI');
      expect(windows[0].events).toContain('PPI');
      expect(windows[0].start).toEqual(makeDate(2024, 6, 12, 14, 28, 0));
      expect(windows[0].end).toEqual(makeDate(2024, 6, 12, 14, 45, 0));
    });
  });
});
