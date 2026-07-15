/**
 * Circuit Breaker Filter
 *
 * Monitors M1 candles for extreme adverse price movement (300+ pips)
 * against the most recent signal direction. On trigger, suppresses
 * signal generation for 15 minutes.
 *
 * For XAU/USD: 1 pip = 0.1 price points, so 300 pips = 30.0 points.
 *
 * Requirements: 10.3, 10.4, 10.5
 */

import { Candle } from '../types/candle.js';

/** Alert generated when the circuit breaker triggers */
export interface CircuitBreakerAlert {
  magnitude: number; // pips of adverse movement
  affectedSignalId: string | null;
  direction: 'long' | 'short';
  timestamp: string;
  suppressionEndsAt: string;
}

/** Configuration for the circuit breaker */
export interface CircuitBreakerConfig {
  thresholdPips: number; // default 300
  suppressionMinutes: number; // default 15
  pipSize: number; // price value of 1 pip (0.1 for XAU/USD)
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  thresholdPips: 300,
  suppressionMinutes: 15,
  pipSize: 0.1,
};

/**
 * CircuitBreaker monitors M1 candles for extreme adverse movement
 * against the most recent signal direction and suppresses signals
 * for a cooldown period after triggering.
 */
export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private alert: CircuitBreakerAlert | null = null;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Process an M1 candle and check if it triggers the circuit breaker.
   *
   * For a long signal: a bearish M1 candle where (open - close) >= threshold triggers it.
   * For a short signal: a bullish M1 candle where (close - open) >= threshold triggers it.
   *
   * @param candle - The M1 candle to evaluate
   * @param currentSignalDirection - Direction of the most recent signal ('long', 'short', or null)
   * @param currentSignalId - ID of the most recent signal (or null)
   * @returns CircuitBreakerAlert if triggered, null otherwise
   */
  processM1Candle(
    candle: Candle,
    currentSignalDirection: 'long' | 'short' | null,
    currentSignalId: string | null,
  ): CircuitBreakerAlert | null {
    // If no active signal direction, don't trigger
    if (currentSignalDirection === null) {
      return null;
    }

    const thresholdPrice = this.config.thresholdPips * this.config.pipSize;

    let adverseMovement = 0;

    if (currentSignalDirection === 'long') {
      // For long signals, check bearish movement: open - close
      const bearishMove = candle.open - candle.close;
      if (bearishMove >= thresholdPrice) {
        adverseMovement = bearishMove;
      }
    } else {
      // For short signals, check bullish movement: close - open
      const bullishMove = candle.close - candle.open;
      if (bullishMove >= thresholdPrice) {
        adverseMovement = bullishMove;
      }
    }

    if (adverseMovement > 0) {
      const magnitudePips = adverseMovement / this.config.pipSize;
      const triggerTime = new Date(candle.timestamp);
      const suppressionEnd = new Date(
        triggerTime.getTime() + this.config.suppressionMinutes * 60 * 1000,
      );

      this.alert = {
        magnitude: magnitudePips,
        affectedSignalId: currentSignalId,
        direction: currentSignalDirection,
        timestamp: triggerTime.toISOString(),
        suppressionEndsAt: suppressionEnd.toISOString(),
      };

      return this.alert;
    }

    return null;
  }

  /**
   * Check if the circuit breaker is currently active (suppressing signals).
   *
   * @param currentTime - The current time to check against
   * @returns true if signals should be suppressed
   */
  isActive(currentTime: Date): boolean {
    if (this.alert === null) {
      return false;
    }

    const suppressionEnd = new Date(this.alert.suppressionEndsAt);
    return currentTime.getTime() < suppressionEnd.getTime();
  }

  /**
   * Get the current status of the circuit breaker.
   *
   * @returns Object with active flag and expiration time
   */
  getStatus(): { active: boolean; expiresAt: string | null } {
    if (this.alert === null) {
      return { active: false, expiresAt: null };
    }

    const now = new Date();
    const suppressionEnd = new Date(this.alert.suppressionEndsAt);
    const active = now.getTime() < suppressionEnd.getTime();

    return {
      active,
      expiresAt: active ? this.alert.suppressionEndsAt : null,
    };
  }

  /**
   * Reset the circuit breaker, clearing any active alert.
   */
  reset(): void {
    this.alert = null;
  }
}
