/**
 * Always-on operating status for the Isagi Engine.
 *
 * The former 12:00–17:00 UTC restriction has been removed. The class keeps
 * its legacy API so existing callers remain compatible, but it now reports an
 * active gate at every UTC time and never deactivates the FSM.
 */

/** Legacy shape retained for compatibility with existing configuration callers. */
export interface TimeGateConfig {
  startHourUTC: number;
  startMinuteUTC: number;
  startSecondUTC: number;
  endHourUTC: number;
  endMinuteUTC: number;
  endSecondUTC: number;
}

/** Status information returned by the always-on operating gate. */
export interface TimeGateStatus {
  active: boolean;
  windowStart: string;
  windowEnd: string;
}

/** Legacy default retained for callers that still construct TimeGate with no arguments. */
const DEFAULT_CONFIG: TimeGateConfig = {
  startHourUTC: 0,
  startMinuteUTC: 0,
  startSecondUTC: 0,
  endHourUTC: 23,
  endMinuteUTC: 59,
  endSecondUTC: 59,
};

/**
 * Compatibility façade for the former time-window filter.
 *
 * The operating gate is now always open. News freezes and the circuit breaker
 * remain independent filters and continue to suppress signals when active.
 */
export class TimeGate {
  constructor(_config: TimeGateConfig = DEFAULT_CONFIG) {
    // Legacy configuration is accepted but intentionally ignored.
  }

  /** Initialize the always-on operating gate. */
  initialize(_currentTime: Date): void {
    // No time-based state is required.
  }

  /** Return true at every UTC time. */
  isActive(_currentTime: Date): boolean {
    return true;
  }

  /** Legacy activation hook; the gate never needs to activate. */
  shouldActivate(_currentTime: Date): boolean {
    return false;
  }

  /** Legacy deactivation hook; the gate never deactivates. */
  shouldDeactivate(_currentTime: Date): boolean {
    return false;
  }

  /** Return the always-on operating status. */
  getStatus(): TimeGateStatus {
    return {
      active: true,
      windowStart: '00:00:00',
      windowEnd: '23:59:59',
    };
  }

  /** There is no suppression reason because the operating gate is always open. */
  getSuppressionReason(_currentTime: Date): string | null {
    return null;
  }
}
