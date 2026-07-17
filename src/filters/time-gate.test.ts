/**
 * Unit tests for the always-on operating gate.
 *
 * The former 12:00–17:00 UTC restriction has been removed. These tests
 * verify that the legacy API remains compatible while the gate stays active
 * at every UTC time.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TimeGate } from './time-gate.js';

function utcDate(hours: number, minutes = 0, seconds = 0): Date {
  return new Date(Date.UTC(2025, 0, 15, hours, minutes, seconds));
}

describe('TimeGate (always-on)', () => {
  let timeGate: TimeGate;

  beforeEach(() => {
    timeGate = new TimeGate();
  });

  it.each([
    ['midnight', utcDate(0, 0, 0)],
    ['before the former window', utcDate(11, 59, 59)],
    ['former window start', utcDate(12, 0, 0)],
    ['former window middle', utcDate(14, 30, 0)],
    ['former window end', utcDate(16, 59, 59)],
    ['after the former window', utcDate(17, 0, 0)],
    ['late evening', utcDate(23, 59, 59)],
  ])('is active at %s', (_label, time) => {
    expect(timeGate.isActive(time)).toBe(true);
  });

  it('starts active before initialization', () => {
    expect(timeGate.getStatus().active).toBe(true);
  });

  it('remains active after initialization at any UTC time', () => {
    timeGate.initialize(utcDate(3, 15, 0));
    expect(timeGate.getStatus().active).toBe(true);

    timeGate.initialize(utcDate(19, 45, 0));
    expect(timeGate.getStatus().active).toBe(true);
  });

  it('never requests activation', () => {
    expect(timeGate.shouldActivate(utcDate(12, 0, 0))).toBe(false);
    expect(timeGate.shouldActivate(utcDate(22, 0, 0))).toBe(false);
    expect(timeGate.getStatus().active).toBe(true);
  });

  it('never requests deactivation at the former 17:00 boundary', () => {
    timeGate.initialize(utcDate(16, 59, 59));
    expect(timeGate.shouldDeactivate(utcDate(17, 0, 0))).toBe(false);
    expect(timeGate.shouldDeactivate(utcDate(23, 0, 0))).toBe(false);
    expect(timeGate.getStatus().active).toBe(true);
  });

  it('reports a full-day status', () => {
    expect(timeGate.getStatus()).toEqual({
      active: true,
      windowStart: '00:00:00',
      windowEnd: '23:59:59',
    });
  });

  it('never reports a suppression reason', () => {
    expect(timeGate.getSuppressionReason(utcDate(8, 0, 0))).toBeNull();
    expect(timeGate.getSuppressionReason(utcDate(17, 0, 0))).toBeNull();
  });

  it('accepts legacy custom configuration without restoring a time restriction', () => {
    const legacyConfiguredGate = new TimeGate({
      startHourUTC: 12,
      startMinuteUTC: 0,
      startSecondUTC: 0,
      endHourUTC: 16,
      endMinuteUTC: 59,
      endSecondUTC: 59,
    });

    expect(legacyConfiguredGate.isActive(utcDate(6, 0, 0))).toBe(true);
    expect(legacyConfiguredGate.isActive(utcDate(20, 0, 0))).toBe(true);
  });
});
