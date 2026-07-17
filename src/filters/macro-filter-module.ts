/**
 * Macro Filter Module (Façade)
 *
 * Combines the three individual gatekeeping filters:
 * - Time Gate: restricts signal generation to 12:00:00–16:59:59 UTC
 * - News Decoupler: suppresses signals around high-impact USD events
 * - Circuit Breaker: suppresses signals after extreme adverse movement
 *
 * Provides a unified interface for checking all filters and emitting
 * filter.change events on the EventBus when any filter activates/deactivates.
 *
 * Requirements: 6, 7, 10.3-10.5
 */

import { TimeGate } from './time-gate.js';
import { NewsDecoupler } from './news-decoupler.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { EventBus, FilterChangeEvent } from '../core/event-bus.js';
import { Candle } from '../types/candle.js';
import { FilterStatus, FilterResult } from '../types/filter.js';

/**
 * Tracks the previous activation state of each filter
 * to detect state changes and emit events.
 */
interface FilterStateTracker {
  timeGateActive: boolean;
  newsFreezeActive: boolean;
  circuitBreakerActive: boolean;
}

/**
 * MacroFilterModule façade that wraps TimeGate, NewsDecoupler,
 * and CircuitBreaker into a single cohesive interface.
 */
export class MacroFilterModule {
  private readonly timeGate: TimeGate;
  private readonly newsDecoupler: NewsDecoupler;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly eventBus: EventBus;
  private previousState: FilterStateTracker;

  constructor(
    timeGate: TimeGate,
    newsDecoupler: NewsDecoupler,
    circuitBreaker: CircuitBreaker,
    eventBus: EventBus,
  ) {
    this.timeGate = timeGate;
    this.newsDecoupler = newsDecoupler;
    this.circuitBreaker = circuitBreaker;
    this.eventBus = eventBus;

    // Initialize state tracker with default values (all inactive)
    this.previousState = {
      timeGateActive: false,
      newsFreezeActive: false,
      circuitBreakerActive: false,
    };
  }

  /**
   * Check if the Time Gate is currently active (within trading window).
   */
  isTimeGateActive(currentTime: Date): boolean {
    return this.timeGate.isActive(currentTime);
  }

  /**
   * Check if the News Decoupler freeze is currently active.
   */
  isNewsFreezeActive(currentTime: Date): boolean {
    return this.newsDecoupler.isFreezeActive(currentTime);
  }

  /**
   * Check if the Circuit Breaker is currently active (suppressing signals).
   */
  isCircuitBreakerActive(currentTime: Date): boolean {
    return this.circuitBreaker.isActive(currentTime);
  }

  /**
   * Get the combined status of all three filters for dashboard consumption.
   */
  getFilterStatus(): FilterStatus {
    const timeGateStatus = this.timeGate.getStatus();
    const newsStatus = this.newsDecoupler.getStatus();
    const cbStatus = this.circuitBreaker.getStatus();

    return {
      timeGate: {
        active: timeGateStatus.active,
        windowStart: timeGateStatus.windowStart,
        windowEnd: timeGateStatus.windowEnd,
      },
      newsDecoupler: {
        freezeActive: newsStatus.freezeActive,
        currentEvent: newsStatus.currentEvent,
        freezeEnd: newsStatus.freezeEnd,
      },
      circuitBreaker: {
        active: cbStatus.active,
        expiresAt: cbStatus.expiresAt,
      },
    };
  }

  /**
   * Check all three filters in order and return pass/block with reason.
   *
   * Order of checks:
   * 1. Time Gate — must be within active window
   * 2. News Decoupler — must not be in a freeze window
   * 3. Circuit Breaker — must not be suppressing after an alert
   *
   * Returns `{ passed: true }` if all pass, or
   * `{ passed: false, blockedBy: 'filter_name', reason: '...' }` on first failure.
   *
   * Also processes M1 candles through the circuit breaker and
   * detects/emits filter.change events when any filter activates/deactivates.
   */
  checkAllFilters(currentTime: Date, candle: Candle): FilterResult {
    // Detect state changes and emit events
    this.detectAndEmitStateChanges(currentTime);

    // 1. Check Time Gate
    if (!this.timeGate.isActive(currentTime)) {
      const reason =
        this.timeGate.getSuppressionReason(currentTime) ??
        'Outside active trading window (12:00:00–16:59:59 UTC)';
      return {
        passed: false,
        blockedBy: 'time_gate',
        reason,
      };
    }

    // 2. Check News Decoupler
    if (this.newsDecoupler.isFreezeActive(currentTime)) {
      const activeWindow = this.newsDecoupler.getActiveFreezeWindow(currentTime);
      const eventNames = activeWindow?.events.join(', ') ?? 'unknown';
      return {
        passed: false,
        blockedBy: 'news_decoupler',
        reason: `News freeze active for event(s): ${eventNames}`,
      };
    }

    // 3. Check Circuit Breaker
    if (this.circuitBreaker.isActive(currentTime)) {
      const cbStatus = this.circuitBreaker.getStatus();
      return {
        passed: false,
        blockedBy: 'circuit_breaker',
        reason: `Circuit breaker active, suppression expires at ${cbStatus.expiresAt}`,
      };
    }

    // Process M1 candles through the circuit breaker
    // (the circuit breaker monitors M1 candles for adverse movement)
    if (candle.timeframe === 'M1') {
      this.processM1Candle(candle);
    }

    return {
      passed: true,
      blockedBy: null,
      reason: null,
    };
  }

  /**
   * Process an M1 candle through the circuit breaker.
   * This is called internally from checkAllFilters for M1 candles,
   * but can also be called directly for explicit M1 processing.
   */
  processM1Candle(
    candle: Candle,
    currentSignalDirection: 'long' | 'short' | null = null,
    currentSignalId: string | null = null,
  ): void {
    this.circuitBreaker.processM1Candle(
      candle,
      currentSignalDirection,
      currentSignalId,
    );
  }

  /**
   * Detect state changes across all filters and emit filter.change events
   * on the EventBus when any filter activates/deactivates.
   */
  private detectAndEmitStateChanges(currentTime: Date): void {
    const currentState: FilterStateTracker = {
      timeGateActive: this.timeGate.isActive(currentTime),
      newsFreezeActive: this.newsDecoupler.isFreezeActive(currentTime),
      circuitBreakerActive: this.circuitBreaker.isActive(currentTime),
    };

    const timestamp = currentTime.toISOString();

    // Time Gate state change
    if (currentState.timeGateActive !== this.previousState.timeGateActive) {
      const event: FilterChangeEvent = {
        filterName: 'time_gate',
        action: currentState.timeGateActive ? 'activated' : 'deactivated',
        timestamp,
        reason: currentState.timeGateActive
          ? 'Trading window opened (12:00:00 UTC)'
          : 'Trading window closed (17:00:00 UTC)',
      };
      this.eventBus.publish('filter.change', event);
    }

    // News Decoupler state change
    if (currentState.newsFreezeActive !== this.previousState.newsFreezeActive) {
      const activeWindow = this.newsDecoupler.getActiveFreezeWindow(currentTime);
      const event: FilterChangeEvent = {
        filterName: 'news_decoupler',
        action: currentState.newsFreezeActive ? 'activated' : 'deactivated',
        timestamp,
        reason: currentState.newsFreezeActive
          ? `News freeze activated for: ${activeWindow?.events.join(', ') ?? 'unknown'}`
          : 'News freeze window expired',
      };
      this.eventBus.publish('filter.change', event);
    }

    // Circuit Breaker state change
    if (
      currentState.circuitBreakerActive !==
      this.previousState.circuitBreakerActive
    ) {
      const event: FilterChangeEvent = {
        filterName: 'circuit_breaker',
        action: currentState.circuitBreakerActive ? 'activated' : 'deactivated',
        timestamp,
        reason: currentState.circuitBreakerActive
          ? 'Circuit breaker triggered (300+ pip adverse movement)'
          : 'Circuit breaker cooldown expired',
      };
      this.eventBus.publish('filter.change', event);
    }

    // Update previous state
    this.previousState = currentState;
  }
}
