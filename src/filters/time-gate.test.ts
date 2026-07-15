/**
 * Unit tests for the Time Gate filter.
 *
 * Covers:
 * - Boundary conditions (exactly 12:00:00, 16:59:59, 17:00:00)
 * - Various times within and outside the window
 * - Startup initialization at different times
 * - Status reporting
 * - Activation/deactivation transitions
 * - Suppression reason logging
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TimeGate } from './time-gate.js';

/**
 * Helper to create a Date at a specific UTC time on an arbitrary day.
 */
function utcDate(
  hours: number,
  minutes: number,
  seconds: number,
  ms: number = 0
): Date {
  const d = new Date(Date.UTC(2025, 0, 15, hours, minutes, seconds, ms));
  return d;
}

describe('TimeGate', () => {
  let timeGate: TimeGate;

  beforeEach(() => {
    timeGate = new TimeGate();
  });

  describe('isActive', () => {
    describe('boundary conditions', () => {
      it('returns true at exactly 12:00:00 UTC (window start, inclusive)', () => {
        expect(timeGate.isActive(utcDate(12, 0, 0))).toBe(true);
      });

      it('returns true at exactly 16:59:59 UTC (window end, inclusive)', () => {
        expect(timeGate.isActive(utcDate(16, 59, 59))).toBe(true);
      });

      it('returns false at exactly 17:00:00 UTC (first second outside)', () => {
        expect(timeGate.isActive(utcDate(17, 0, 0))).toBe(false);
      });

      it('returns false at 11:59:59 UTC (one second before window)', () => {
        expect(timeGate.isActive(utcDate(11, 59, 59))).toBe(false);
      });
    });

    describe('times within the window', () => {
      it('returns true at 12:00:01 UTC', () => {
        expect(timeGate.isActive(utcDate(12, 0, 1))).toBe(true);
      });

      it('returns true at 14:30:00 UTC (middle of window)', () => {
        expect(timeGate.isActive(utcDate(14, 30, 0))).toBe(true);
      });

      it('returns true at 15:00:00 UTC', () => {
        expect(timeGate.isActive(utcDate(15, 0, 0))).toBe(true);
      });

      it('returns true at 16:00:00 UTC', () => {
        expect(timeGate.isActive(utcDate(16, 0, 0))).toBe(true);
      });

      it('returns true at 16:59:58 UTC', () => {
        expect(timeGate.isActive(utcDate(16, 59, 58))).toBe(true);
      });
    });

    describe('times outside the window', () => {
      it('returns false at 00:00:00 UTC (midnight)', () => {
        expect(timeGate.isActive(utcDate(0, 0, 0))).toBe(false);
      });

      it('returns false at 06:00:00 UTC (early morning)', () => {
        expect(timeGate.isActive(utcDate(6, 0, 0))).toBe(false);
      });

      it('returns false at 11:00:00 UTC (before window)', () => {
        expect(timeGate.isActive(utcDate(11, 0, 0))).toBe(false);
      });

      it('returns false at 17:00:01 UTC', () => {
        expect(timeGate.isActive(utcDate(17, 0, 1))).toBe(false);
      });

      it('returns false at 18:00:00 UTC', () => {
        expect(timeGate.isActive(utcDate(18, 0, 0))).toBe(false);
      });

      it('returns false at 23:59:59 UTC', () => {
        expect(timeGate.isActive(utcDate(23, 59, 59))).toBe(false);
      });
    });
  });

  describe('initialize', () => {
    it('sets active state to true when within window on startup', () => {
      timeGate.initialize(utcDate(14, 0, 0));
      const status = timeGate.getStatus();
      expect(status.active).toBe(true);
    });

    it('sets active state to false when before window on startup', () => {
      timeGate.initialize(utcDate(9, 0, 0));
      const status = timeGate.getStatus();
      expect(status.active).toBe(false);
    });

    it('sets active state to false when after window on startup', () => {
      timeGate.initialize(utcDate(20, 0, 0));
      const status = timeGate.getStatus();
      expect(status.active).toBe(false);
    });

    it('sets active state to true at exact window start', () => {
      timeGate.initialize(utcDate(12, 0, 0));
      const status = timeGate.getStatus();
      expect(status.active).toBe(true);
    });

    it('sets active state to true at exact window end', () => {
      timeGate.initialize(utcDate(16, 59, 59));
      const status = timeGate.getStatus();
      expect(status.active).toBe(true);
    });

    it('sets active state to false at 17:00:00 UTC', () => {
      timeGate.initialize(utcDate(17, 0, 0));
      const status = timeGate.getStatus();
      expect(status.active).toBe(false);
    });
  });

  describe('shouldActivate', () => {
    it('returns true when transitioning from outside to inside window', () => {
      // Start outside window
      timeGate.initialize(utcDate(11, 59, 59));
      expect(timeGate.getStatus().active).toBe(false);

      // Now time moves to 12:00:00
      const result = timeGate.shouldActivate(utcDate(12, 0, 0));
      expect(result).toBe(true);
    });

    it('returns false when already within window', () => {
      timeGate.initialize(utcDate(13, 0, 0));
      const result = timeGate.shouldActivate(utcDate(14, 0, 0));
      expect(result).toBe(false);
    });

    it('returns false when still outside window', () => {
      timeGate.initialize(utcDate(10, 0, 0));
      const result = timeGate.shouldActivate(utcDate(11, 0, 0));
      expect(result).toBe(false);
    });

    it('updates internal active state on activation', () => {
      timeGate.initialize(utcDate(11, 59, 59));
      timeGate.shouldActivate(utcDate(12, 0, 0));
      expect(timeGate.getStatus().active).toBe(true);
    });
  });

  describe('shouldDeactivate', () => {
    it('returns true when transitioning from inside to outside window at 17:00:00', () => {
      timeGate.initialize(utcDate(16, 59, 59));
      expect(timeGate.getStatus().active).toBe(true);

      const result = timeGate.shouldDeactivate(utcDate(17, 0, 0));
      expect(result).toBe(true);
    });

    it('returns false when still within window', () => {
      timeGate.initialize(utcDate(14, 0, 0));
      const result = timeGate.shouldDeactivate(utcDate(15, 0, 0));
      expect(result).toBe(false);
    });

    it('returns false when already outside window', () => {
      timeGate.initialize(utcDate(18, 0, 0));
      const result = timeGate.shouldDeactivate(utcDate(19, 0, 0));
      expect(result).toBe(false);
    });

    it('updates internal active state on deactivation', () => {
      timeGate.initialize(utcDate(16, 59, 59));
      timeGate.shouldDeactivate(utcDate(17, 0, 0));
      expect(timeGate.getStatus().active).toBe(false);
    });

    it('signals cancellation of in-progress work on deactivation', () => {
      timeGate.initialize(utcDate(16, 30, 0));
      // Deactivation at 17:00:00 should return true, indicating
      // the FSM should cancel in-progress observations/evaluations
      const shouldCancel = timeGate.shouldDeactivate(utcDate(17, 0, 0));
      expect(shouldCancel).toBe(true);
    });
  });

  describe('getStatus', () => {
    it('reports correct window boundaries', () => {
      const status = timeGate.getStatus();
      expect(status.windowStart).toBe('12:00:00');
      expect(status.windowEnd).toBe('16:59:59');
    });

    it('reports active=false before initialization', () => {
      const status = timeGate.getStatus();
      expect(status.active).toBe(false);
    });

    it('reports active=true after initialization within window', () => {
      timeGate.initialize(utcDate(13, 0, 0));
      const status = timeGate.getStatus();
      expect(status.active).toBe(true);
    });

    it('reports active=false after initialization outside window', () => {
      timeGate.initialize(utcDate(8, 0, 0));
      const status = timeGate.getStatus();
      expect(status.active).toBe(false);
    });
  });

  describe('getSuppressionReason', () => {
    it('returns null when within active window', () => {
      const reason = timeGate.getSuppressionReason(utcDate(14, 0, 0));
      expect(reason).toBeNull();
    });

    it('returns a reason mentioning "before" when time is before window', () => {
      const reason = timeGate.getSuppressionReason(utcDate(10, 30, 0));
      expect(reason).not.toBeNull();
      expect(reason).toContain('before');
      expect(reason).toContain('10:30:00');
    });

    it('returns a reason mentioning "after" when time is after window', () => {
      const reason = timeGate.getSuppressionReason(utcDate(17, 30, 0));
      expect(reason).not.toBeNull();
      expect(reason).toContain('after');
      expect(reason).toContain('17:30:00');
    });

    it('returns null at exact window start (12:00:00)', () => {
      const reason = timeGate.getSuppressionReason(utcDate(12, 0, 0));
      expect(reason).toBeNull();
    });

    it('returns null at exact window end (16:59:59)', () => {
      const reason = timeGate.getSuppressionReason(utcDate(16, 59, 59));
      expect(reason).toBeNull();
    });

    it('returns a reason at 17:00:00 (first second outside)', () => {
      const reason = timeGate.getSuppressionReason(utcDate(17, 0, 0));
      expect(reason).not.toBeNull();
      expect(reason).toContain('17:00:00');
    });
  });

  describe('custom configuration', () => {
    it('supports a custom time window', () => {
      const customGate = new TimeGate({
        startHourUTC: 8,
        startMinuteUTC: 30,
        startSecondUTC: 0,
        endHourUTC: 15,
        endMinuteUTC: 0,
        endSecondUTC: 0,
      });

      expect(customGate.isActive(utcDate(8, 30, 0))).toBe(true);
      expect(customGate.isActive(utcDate(15, 0, 0))).toBe(true);
      expect(customGate.isActive(utcDate(15, 0, 1))).toBe(false);
      expect(customGate.isActive(utcDate(8, 29, 59))).toBe(false);
    });
  });

  describe('transition sequences', () => {
    it('handles full day cycle: before → active → after', () => {
      // Before window
      timeGate.initialize(utcDate(11, 0, 0));
      expect(timeGate.getStatus().active).toBe(false);

      // Activate
      expect(timeGate.shouldActivate(utcDate(12, 0, 0))).toBe(true);
      expect(timeGate.getStatus().active).toBe(true);

      // Still active
      expect(timeGate.shouldDeactivate(utcDate(14, 0, 0))).toBe(false);
      expect(timeGate.getStatus().active).toBe(true);

      // Deactivate
      expect(timeGate.shouldDeactivate(utcDate(17, 0, 0))).toBe(true);
      expect(timeGate.getStatus().active).toBe(false);
    });

    it('does not re-activate after deactivation within same check', () => {
      timeGate.initialize(utcDate(16, 59, 59));
      timeGate.shouldDeactivate(utcDate(17, 0, 0));

      // Should not activate again at a later time
      expect(timeGate.shouldActivate(utcDate(18, 0, 0))).toBe(false);
    });

    it('can re-activate the next day', () => {
      timeGate.initialize(utcDate(16, 59, 59));
      timeGate.shouldDeactivate(utcDate(17, 0, 0));
      expect(timeGate.getStatus().active).toBe(false);

      // Next day 12:00:00
      expect(timeGate.shouldActivate(utcDate(12, 0, 0))).toBe(true);
      expect(timeGate.getStatus().active).toBe(true);
    });
  });
});
