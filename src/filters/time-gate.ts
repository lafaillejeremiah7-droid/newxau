/**
 * Time Gate Filter
 *
 * Restricts signal generation to the optimal trading window: 12:00:00 – 16:59:59 UTC.
 * 17:00:00 UTC is the first second OUTSIDE the window.
 *
 * Responsibilities:
 * - Determine if the engine should be active based on current UTC time
 * - Signal cancellation of in-progress observations/evaluations on deactivation
 * - Log suppression reason when outside window
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

/** Configuration for the Time Gate window */
export interface TimeGateConfig {
  startHourUTC: number;
  startMinuteUTC: number;
  startSecondUTC: number;
  endHourUTC: number;
  endMinuteUTC: number;
  endSecondUTC: number;
}

/** Status information returned by the Time Gate */
export interface TimeGateStatus {
  active: boolean;
  windowStart: string;
  windowEnd: string;
}

/** Default configuration: 12:00:00 – 16:59:59 UTC */
const DEFAULT_CONFIG: TimeGateConfig = {
  startHourUTC: 12,
  startMinuteUTC: 0,
  startSecondUTC: 0,
  endHourUTC: 16,
  endMinuteUTC: 59,
  endSecondUTC: 59,
};

/**
 * TimeGate filter implementation.
 *
 * The Time Gate only determines activation state — it doesn't directly control
 * the FSM, but emits information that the FSM uses.
 */
export class TimeGate {
  private readonly config: TimeGateConfig;
  private active: boolean;

  constructor(config: TimeGateConfig = DEFAULT_CONFIG) {
    this.config = config;
    this.active = false;
  }

  /**
   * Initialize the Time Gate by checking the current UTC time.
   * Sets the internal active state accordingly.
   *
   * Requirements: 6.5
   */
  initialize(currentTime: Date): void {
    this.active = this.isWithinWindow(currentTime);

    if (!this.active) {
      this.logSuppression(currentTime, 'initialization_outside_window');
    }
  }

  /**
   * Check if a given time is within the active window.
   * Active window: 12:00:00 – 16:59:59 UTC (inclusive).
   * 17:00:00 is the first second OUTSIDE the window.
   *
   * Requirements: 6.1, 6.2
   */
  isActive(currentTime: Date): boolean {
    return this.isWithinWindow(currentTime);
  }

  /**
   * Determine if the Time Gate should activate at the given time.
   * Returns true when the time is exactly 12:00:00 UTC or enters the active window.
   *
   * Requirements: 6.3
   */
  shouldActivate(currentTime: Date): boolean {
    const wasActive = this.active;
    const nowActive = this.isWithinWindow(currentTime);

    if (!wasActive && nowActive) {
      this.active = true;
      return true;
    }

    return false;
  }

  /**
   * Determine if the Time Gate should deactivate at the given time.
   * Returns true when the time reaches 17:00:00 UTC or leaves the active window.
   * On deactivation, in-progress observations/evaluations should be cancelled.
   *
   * Requirements: 6.4, 6.6
   */
  shouldDeactivate(currentTime: Date): boolean {
    const wasActive = this.active;
    const nowActive = this.isWithinWindow(currentTime);

    if (wasActive && !nowActive) {
      this.active = false;
      this.logSuppression(currentTime, 'window_deactivation');
      return true;
    }

    return false;
  }

  /**
   * Get the current status of the Time Gate.
   */
  getStatus(): TimeGateStatus {
    return {
      active: this.active,
      windowStart: this.formatTime(
        this.config.startHourUTC,
        this.config.startMinuteUTC,
        this.config.startSecondUTC
      ),
      windowEnd: this.formatTime(
        this.config.endHourUTC,
        this.config.endMinuteUTC,
        this.config.endSecondUTC
      ),
    };
  }

  /**
   * Get the suppression reason for the current time.
   * Returns null if the time is within the active window.
   *
   * Requirements: 6.2
   */
  getSuppressionReason(currentTime: Date): string | null {
    if (this.isWithinWindow(currentTime)) {
      return null;
    }

    const hours = currentTime.getUTCHours();
    const minutes = currentTime.getUTCMinutes();
    const seconds = currentTime.getUTCSeconds();

    const timeStr = this.formatTime(hours, minutes, seconds);

    if (this.isBeforeWindow(currentTime)) {
      return `Time Gate suppressed: current time ${timeStr} UTC is before active window (${this.getStatus().windowStart} UTC)`;
    }

    return `Time Gate suppressed: current time ${timeStr} UTC is after active window (${this.getStatus().windowEnd} UTC)`;
  }

  /**
   * Check if the given time is within the active window.
   * Inclusive on both boundaries: 12:00:00 and 16:59:59 are both inside.
   * 17:00:00 is outside.
   */
  private isWithinWindow(time: Date): boolean {
    const totalSeconds = this.getUTCTotalSeconds(time);
    const startSeconds = this.configToTotalSeconds(
      this.config.startHourUTC,
      this.config.startMinuteUTC,
      this.config.startSecondUTC
    );
    const endSeconds = this.configToTotalSeconds(
      this.config.endHourUTC,
      this.config.endMinuteUTC,
      this.config.endSecondUTC
    );

    return totalSeconds >= startSeconds && totalSeconds <= endSeconds;
  }

  /**
   * Check if the given time is before the active window.
   */
  private isBeforeWindow(time: Date): boolean {
    const totalSeconds = this.getUTCTotalSeconds(time);
    const startSeconds = this.configToTotalSeconds(
      this.config.startHourUTC,
      this.config.startMinuteUTC,
      this.config.startSecondUTC
    );

    return totalSeconds < startSeconds;
  }

  /**
   * Get total seconds since midnight UTC for a Date.
   */
  private getUTCTotalSeconds(time: Date): number {
    return (
      time.getUTCHours() * 3600 +
      time.getUTCMinutes() * 60 +
      time.getUTCSeconds()
    );
  }

  /**
   * Convert hours/minutes/seconds to total seconds since midnight.
   */
  private configToTotalSeconds(
    hours: number,
    minutes: number,
    seconds: number
  ): number {
    return hours * 3600 + minutes * 60 + seconds;
  }

  /**
   * Format hours, minutes, seconds into HH:MM:SS string.
   */
  private formatTime(hours: number, minutes: number, seconds: number): string {
    return [hours, minutes, seconds]
      .map((v) => v.toString().padStart(2, '0'))
      .join(':');
  }

  /**
   * Log suppression reason (placeholder — actual logging would use the signal logger).
   */
  private logSuppression(time: Date, reason: string): void {
    const hours = time.getUTCHours();
    const minutes = time.getUTCMinutes();
    const seconds = time.getUTCSeconds();
    const timeStr = this.formatTime(hours, minutes, seconds);

    console.log(
      `[TimeGate] Suppressed at ${timeStr} UTC. Reason: ${reason}. ` +
        `Active window: ${this.getStatus().windowStart} – ${this.getStatus().windowEnd} UTC`
    );
  }
}
