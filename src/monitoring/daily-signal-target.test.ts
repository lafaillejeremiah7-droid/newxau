import { describe, expect, it } from 'vitest';
import { DailySignalTargetTracker, getUtcDateKey } from './daily-signal-target.js';

describe('DailySignalTargetTracker', () => {
  it('creates date keys in UTC', () => {
    expect(getUtcDateKey('2026-07-18T00:30:00.000Z')).toBe('2026-07-18');
    expect(getUtcDateKey('2026-07-17T23:59:59.999-05:00')).toBe('2026-07-18');
  });

  it('starts at zero and records only qualified signals', () => {
    const tracker = new DailySignalTargetTracker(
      { minSignalsPerUtcDay: 1, maxSignalsPerUtcDay: 2 },
      '2026-07-18T01:00:00.000Z',
    );

    expect(tracker.getStatus()).toEqual({
      dateKey: '2026-07-18',
      qualifiedSignals: 0,
      minimum: 1,
      maximum: 2,
      minimumMet: false,
      maximumReached: false,
    });

    expect(tracker.recordQualifiedSignal('2026-07-18T02:00:00.000Z').minimumMet).toBe(true);
    expect(tracker.getStatus().qualifiedSignals).toBe(1);
  });

  it('reports when the soft maximum is reached without suppressing later signals', () => {
    const tracker = new DailySignalTargetTracker(
      { minSignalsPerUtcDay: 1, maxSignalsPerUtcDay: 2 },
      '2026-07-18T01:00:00.000Z',
    );

    tracker.recordQualifiedSignal('2026-07-18T02:00:00.000Z');
    expect(tracker.recordQualifiedSignal('2026-07-18T03:00:00.000Z').maximumReached).toBe(true);
    expect(tracker.recordQualifiedSignal('2026-07-18T04:00:00.000Z').qualifiedSignals).toBe(3);
  });

  it('resets the counter at the next UTC day and returns the completed day', () => {
    const tracker = new DailySignalTargetTracker(
      { minSignalsPerUtcDay: 1, maxSignalsPerUtcDay: 2 },
      '2026-07-18T23:00:00.000Z',
    );
    tracker.recordQualifiedSignal('2026-07-18T23:30:00.000Z');

    const rollover = tracker.observe('2026-07-19T00:00:00.000Z');

    expect(rollover?.completedDay).toMatchObject({
      dateKey: '2026-07-18',
      qualifiedSignals: 1,
      minimumMet: true,
    });
    expect(rollover?.currentDay).toMatchObject({
      dateKey: '2026-07-19',
      qualifiedSignals: 0,
      minimumMet: false,
    });
  });

  it('rejects invalid target ranges', () => {
    expect(
      () => new DailySignalTargetTracker({ minSignalsPerUtcDay: 2, maxSignalsPerUtcDay: 1 }),
    ).toThrow(/greater than or equal/);
  });
});
