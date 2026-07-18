/**
 * Signal Engine FSM - Core state machine for the Isagi Engine Signal Bot.
 *
 * Processes M5 candle events, manages state transitions between 4 states,
 * coordinates with macro filters, and emits state change events.
 *
 * States: suppressed, scanning, observation, signal_evaluation
 *
 * Requirements: 1.1, 6.3, 6.4, 6.5
 */

import crypto from 'node:crypto';
import type { Instrument } from '../config/instrument.js';
import type { Candle } from '../types/candle.js';
import type {
  EngineState,
  StateTransition,
  ObservationContext,
  EvaluationContext,
} from '../types/state.js';
import type { EventBus } from './event-bus.js';
import type { TimeGate } from '../filters/time-gate.js';
import type { NewsDecoupler } from '../filters/news-decoupler.js';
import type { ILiquidityZoneDetector } from './liquidity-zone-detector.js';
import type { CandlePatternAnalyzer } from './candle-pattern-analyzer.js';
import type { SignalLogger } from '../data/signal-logger.js';
import type { CandleBufferManager } from '../data/candle-buffer.js';

export const MIN_EXPANSION_CANDLES = 2;
export const MIN_RETRACEMENT_CANDLES = 2;
export const MAX_RETRACEMENT_CANDLES = 4;
export const BODY_RATIO_THRESHOLD = 0.6;

/** Raw signal emitted by the FSM */
export interface RawSignal {
  id: string;
  timestamp: string;
  instrument?: Instrument;
  direction: 'long' | 'short';
  entryPrice: number;
  liquidityZoneLevel: number;
  structuralWindowUpper: number;
  structuralWindowLower: number;
  rejectionCandleType:
    | 'shooting_star'
    | 'hammer'
    | 'bearish_engulfing'
    | 'bullish_engulfing';
  expansionCandles: Candle[];
  retracementCandles: Candle[];
  observationCandles: Candle[];
}

/** Signal handler type */
export type SignalHandler = (signal: RawSignal) => void;

/** State change handler type */
export type StateChangeHandler = (transition: StateTransition) => void;

/** SignalEngineFSM interface per design specification */
export interface ISignalEngineFSM {
  initialize(currentTime: Date): void;
  processCandle(candle: Candle): void;
  getState(): EngineState;
  onSignal(handler: SignalHandler): void;
  onStateChange(handler: StateChangeHandler): void;
}

/** Dependencies required by the Signal Engine FSM */
export interface SignalEngineFSMDependencies {
  eventBus: EventBus;
  instrument?: Instrument;
  breakthroughSize?: number;
  timeGate: TimeGate;
  newsDecoupler: NewsDecoupler;
  liquidityZoneDetector: ILiquidityZoneDetector;
  candlePatternAnalyzer: CandlePatternAnalyzer;
  signalLogger: SignalLogger;
  candleBufferManager?: CandleBufferManager;
}

/**
 * SignalEngineFSM implementation.
 *
 * Core state machine that processes M5 candle events, manages state transitions,
 * coordinates with macro filters (TimeGate, NewsDecoupler), detects candle structures,
 * and generates raw signals.
 */
export class SignalEngineFSM implements ISignalEngineFSM {
  private state: EngineState = 'suppressed';
  private readonly deps: SignalEngineFSMDependencies;

  /** Observation phase context */
  private observationContext: ObservationContext | null = null;

  /** Signal evaluation context */
  private evaluationContext: EvaluationContext | null = null;

  /** Signal handlers */
  private signalHandlers: SignalHandler[] = [];

  /** State change handlers */
  private stateChangeHandlers: StateChangeHandler[] = [];

  constructor(deps: SignalEngineFSMDependencies) {
    this.deps = deps;
  }

  /**
   * Initialize the FSM with the always-on operating gate.
   * The TimeGate remains injectable for compatibility, but the production
   * implementation is active at every UTC time.
   */
  initialize(currentTime: Date): void {
    const isActive = this.deps.timeGate.isActive(currentTime);

    if (isActive) {
      this.transitionTo('scanning', 'initialization_always_active', currentTime);
    } else {
      // Defensive fallback: TimeGate is always active, but retain the state
      // transition for custom implementations of the dependency.
      this.transitionTo('suppressed', 'initialization_gate_inactive', currentTime);
    }
  }

  /**
   * Process a closed M5 candle through the state machine.
   * Delegates to the appropriate state-specific handler.
   *
   * Only processes M5 candles for state transitions.
   * H1/M15 candles are forwarded to zone detector only.
   */
  processCandle(candle: Candle): void {
    // Forward H1/M15 candles to zone detector
    if (candle.timeframe === 'H1' || candle.timeframe === 'M15') {
      this.deps.liquidityZoneDetector.updateZones(candle);
      return;
    }

    // Only process M5 candles for state transitions
    if (candle.timeframe !== 'M5') {
      return;
    }

    const candleTime = new Date(candle.timestamp);

    // Check Time Gate deactivation (17:00:00 UTC)
    if (this.deps.timeGate.shouldDeactivate(candleTime)) {
      this.handleTimeGateDeactivation(candleTime);
      return;
    }

    // Check Time Gate activation (12:00:00 UTC)
    if (this.state === 'suppressed' && this.deps.timeGate.shouldActivate(candleTime)) {
      this.transitionTo('scanning', 'time_gate_activated', candleTime);
    }

    // Check News Decoupler freeze
    if (this.deps.newsDecoupler.isFreezeActive(candleTime)) {
      this.handleNewsFreezeActivation(candleTime);
      return;
    }

    // Delegate to state-specific handler
    switch (this.state) {
      case 'suppressed':
        this.handleSuppressedState(candle, candleTime);
        break;
      case 'scanning':
        this.handleScanningState(candle, candleTime);
        break;
      case 'observation':
        this.handleObservationState(candle, candleTime);
        break;
      case 'signal_evaluation':
        this.handleSignalEvaluationState(candle, candleTime);
        break;
    }
  }

  /**
   * Returns the current FSM state.
   */
  getState(): EngineState {
    return this.state;
  }

  /**
   * Register a handler for raw signal emissions.
   */
  onSignal(handler: SignalHandler): void {
    this.signalHandlers.push(handler);
  }

  /**
   * Register a handler for state change events.
   */
  onStateChange(handler: StateChangeHandler): void {
    this.stateChangeHandlers.push(handler);
  }

  /**
   * Get the current observation context (for testing/debugging).
   */
  getObservationContext(): ObservationContext | null {
    return this.observationContext;
  }

  /**
   * Get the current evaluation context (for testing/debugging).
   */
  getEvaluationContext(): EvaluationContext | null {
    return this.evaluationContext;
  }

  // ─── State Transition Core ─────────────────────────────────────────────────

  /**
   * Execute a state transition.
   * Emits state.change event on the event bus, logs via Signal Logger,
   * and notifies all registered state change handlers.
   */
  private transitionTo(
    newState: EngineState,
    reason: string,
    timestamp: Date
  ): void {
    const previousState = this.state;

    // Skip if already in the target state
    if (previousState === newState) {
      return;
    }

    this.state = newState;

    const transition: StateTransition = {
      from: previousState,
      to: newState,
      reason,
      timestamp: timestamp.toISOString(),
    };

    // Emit state.change event on the event bus
    this.deps.eventBus.publish('state.change', transition);

    // Log state transition via Signal Logger
    this.deps.signalLogger.logStateTransition(transition);

    // Notify registered handlers
    for (const handler of this.stateChangeHandlers) {
      handler(transition);
    }

    // Clear context when leaving observation or signal_evaluation
    if (previousState === 'observation' && newState !== 'signal_evaluation') {
      this.observationContext = null;
    }
    if (previousState === 'signal_evaluation') {
      this.evaluationContext = null;
    }
  }

  // ─── Time Gate Handling ────────────────────────────────────────────────────

  /**
   * Handle Time Gate deactivation at 17:00:00 UTC.
   * Cancels any in-progress observation/evaluation and transitions to suppressed.
   *
   * Requirements: 6.4
   */
  private handleTimeGateDeactivation(currentTime: Date): void {
    if (this.state === 'observation') {
      this.observationContext = null;
    }
    if (this.state === 'signal_evaluation') {
      this.evaluationContext = null;
    }
    if (this.state !== 'suppressed') {
      this.transitionTo('suppressed', 'time_gate_deactivated', currentTime);
    }
  }

  // ─── News Freeze Handling ──────────────────────────────────────────────────

  /**
   * Handle News Decoupler freeze activation.
   * If in observation or signal_evaluation, cancel and return to scanning.
   *
   * Requirements: 7.4
   */
  private handleNewsFreezeActivation(currentTime: Date): void {
    if (this.state === 'observation') {
      this.observationContext = null;
      this.transitionTo('scanning', 'news_freeze_activated', currentTime);
    } else if (this.state === 'signal_evaluation') {
      this.evaluationContext = null;
      this.transitionTo('scanning', 'news_freeze_activated', currentTime);
    }
    // If in scanning or suppressed, news freeze doesn't cause state change
  }

  // ─── State-Specific Handlers ───────────────────────────────────────────────

  /**
   * Handle M5 candle in suppressed state.
   * Check if Time Gate should activate (handled above in processCandle).
   * No signal processing occurs in suppressed state.
   */
  private handleSuppressedState(_candle: Candle, _currentTime: Date): void {
    // In suppressed state, no signal processing occurs.
    // Time Gate activation is already handled in processCandle() above.
  }

  /**
   * Handle M5 candle in scanning state.
   * Check if the candle close enters a liquidity zone → transition to observation.
   *
   * Requirements: 1.1
   */
  private handleScanningState(candle: Candle, currentTime: Date): void {
    // Check if close price enters a liquidity zone
    const zone = this.deps.liquidityZoneDetector.isWithinZone(candle.close);

    if (zone) {
      // Transition to observation
      this.observationContext = {
        liquidityZone: zone,
        candleCount: 1,
        candles: [candle],
        volumeBelowSma: false, // Will be evaluated in observation handler
        rangeCompressing: false,
        startTimestamp: candle.timestamp,
      };
      this.transitionTo('observation', 'price_entered_liquidity_zone', currentTime);
    }
  }

  /**
   * Handle M5 candle in observation state.
   * Monitor 3-6 candles for rejection pattern, zone breakthrough, or timeout.
   *
   * Tracks informational fields:
   * - volumeBelowSma: whether current M5 volume is below the 20-period SMA
   * - rangeCompressing: whether price range is compressing relative to prior candles
   *
   * Transition rules:
   * - Zone breakthrough (≥1 pip beyond far boundary) → scanning
   * - Rejection candle detected (after ≥3 candles observed) → signal_evaluation
   * - 6-candle timeout → scanning (with timeout reason logged)
   *
   * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
   */
  private handleObservationState(candle: Candle, currentTime: Date): void {
    if (!this.observationContext) {
      // Shouldn't happen, but recover gracefully
      this.transitionTo('scanning', 'observation_context_missing', currentTime);
      return;
    }

    const ctx = this.observationContext;
    ctx.candles.push(candle);
    ctx.candleCount++;

    const zone = ctx.liquidityZone;

    // ─── Track volume vs 20-period SMA (order absorption detection) ──────────
    // Volume below SMA indicates order absorption (informational, doesn't gate transitions)
    ctx.volumeBelowSma = this.isVolumeBelowSma(candle);

    // ─── Track price range compression ──────────────────────────────────────────
    // Range compressing indicates consolidation within the zone (informational)
    ctx.rangeCompressing = this.isRangeCompressing(ctx.candles);

    // ─── Check zone breakthrough: price breaks zone boundary by ≥1 pip ──────────
    const breakthroughThreshold = this.deps.breakthroughSize ?? 0.01;
    if (zone.type === 'structural_high' && candle.close > zone.upperBoundary + breakthroughThreshold) {
      this.observationContext = null;
      this.transitionTo('scanning', 'zone_breakthrough_above', currentTime);
      return;
    }
    if (zone.type === 'structural_low' && candle.close < zone.lowerBoundary - breakthroughThreshold) {
      this.observationContext = null;
      this.transitionTo('scanning', 'zone_breakthrough_below', currentTime);
      return;
    }

    // ─── Check for rejection candle pattern (only after ≥3 candles observed) ────
    // Requirement 1.2: minimum 3 candles must be observed before rejection can fire
    if (ctx.candleCount >= 3) {
      const rejectionDirection = zone.type === 'structural_high' ? 'bearish' : 'bullish';
      const priorCandle = ctx.candles.length >= 2 ? ctx.candles[ctx.candles.length - 2] : undefined;
      const rejectionResult = this.deps.candlePatternAnalyzer.isRejectionCandle(
        candle,
        rejectionDirection,
        priorCandle
      );

      if (rejectionResult.isRejection) {
        // Transition to signal_evaluation
        this.transitionTo('signal_evaluation', 'rejection_candle_detected', currentTime);
        // Initialize evaluation context (placeholder for tasks 6.4, 6.5)
        this.evaluationContext = {
          direction: zone.type === 'structural_high' ? 'short' : 'long',
          subPhase: 'expansion_tracking',
          expansionCandles: [],
          retracementCandles: [],
          rejectionCandle: candle,
          averageExpansionVolume: 0,
          averageExpansionBodySize: 0,
          structuralBreakLevel: zone.type === 'structural_high' ? zone.upperBoundary : zone.lowerBoundary,
        };
        return;
      }
    }

    // ─── Check 6-candle timeout ─────────────────────────────────────────────────
    if (ctx.candleCount >= 6) {
      // Log the timeout reason for diagnostics
      this.deps.signalLogger.logRejection({
        timestamp: currentTime.toISOString(),
        reason: `Observation timeout: 6 M5 candles completed without rejection or breakthrough in zone ${zone.id}`,
        filter: 'observation_timeout',
        context: {
          zoneId: zone.id,
          zoneType: zone.type,
          candleCount: ctx.candleCount,
          volumeBelowSma: ctx.volumeBelowSma,
          rangeCompressing: ctx.rangeCompressing,
          startTimestamp: ctx.startTimestamp,
        },
      });
      this.observationContext = null;
      this.transitionTo('scanning', 'observation_timeout_6_candles', currentTime);
      return;
    }
  }

  // ─── Observation Phase Helpers ─────────────────────────────────────────────

  /**
   * Determines whether the current M5 candle's volume is below the 20-period SMA.
   * Uses CandleBufferManager if available; otherwise compares against a default threshold.
   *
   * This is an INFORMATIONAL field stored in ObservationContext.
   */
  private isVolumeBelowSma(candle: Candle): boolean {
    if (this.deps.candleBufferManager) {
      const sma20 = this.deps.candleBufferManager.getSma20Volume();
      // If SMA is 0 (no prior candles), consider volume as not below SMA
      if (sma20 === 0) {
        return false;
      }
      return candle.volume < sma20;
    }
    // Without CandleBufferManager, we can't compute SMA — default to false
    return false;
  }

  /**
   * Determines whether price range is compressing relative to preceding candles.
   * Range compression means the current candle's range (high - low) is smaller than
   * the average range of the prior candles in the observation sequence.
   *
   * This is an INFORMATIONAL field stored in ObservationContext.
   */
  private isRangeCompressing(observationCandles: Candle[]): boolean {
    if (observationCandles.length < 2) {
      return false;
    }

    const currentCandle = observationCandles[observationCandles.length - 1];
    const currentRange = currentCandle.high - currentCandle.low;

    // Calculate average range of prior candles in the observation sequence
    const priorCandles = observationCandles.slice(0, observationCandles.length - 1);
    const avgPriorRange =
      priorCandles.reduce((sum, c) => sum + (c.high - c.low), 0) / priorCandles.length;

    // Range is compressing if current range is smaller than the average of prior candles
    if (avgPriorRange === 0) {
      return false;
    }
    return currentRange < avgPriorRange;
  }

  /**
   * Handle M5 candle in signal_evaluation state.
   * Three-sub-phase pipeline: expansion_tracking → retracement_tracking → entry_check
   *
   * Requirements: 1.1-1.5, 2.1-2.6, 3.1-3.4, 4.1-4.3, 5.1-5.4, 6.1-6.5, 7.1-7.4
   */
  private handleSignalEvaluationState(candle: Candle, currentTime: Date): void {
    if (!this.evaluationContext) {
      this.transitionTo('scanning', 'evaluation_context_missing', currentTime);
      return;
    }

    const ctx = this.evaluationContext;

    switch (ctx.subPhase) {
      case 'expansion_tracking':
        this.processExpansionPhase(candle, ctx, currentTime);
        break;
      case 'retracement_tracking':
        this.processRetracementPhase(candle, ctx, currentTime);
        break;
      case 'entry_check':
        this.processEntryCheck(ctx, currentTime);
        break;
    }
  }

  /**
   * Process a candle during the expansion tracking sub-phase.
   * Accumulates expansion candles until minimum reached, then transitions.
   */
  private processExpansionPhase(candle: Candle, ctx: EvaluationContext, currentTime: Date): void {
    if (this.isExpansionCandle(candle, ctx.direction)) {
      // Valid expansion candle - add it
      ctx.expansionCandles.push(candle);
      this.updateExpansionAverages(ctx);
    } else {
      // Non-expansion candle received
      if (ctx.expansionCandles.length >= MIN_EXPANSION_CANDLES) {
        // Enough expansions - transition to retracement tracking
        ctx.subPhase = 'retracement_tracking';
        // Process this same candle as potential retracement
        this.processRetracementPhase(candle, ctx, currentTime);
      } else {
        // Not enough expansion candles - invalidate
        this.invalidateSetup('expansion_insufficient', currentTime);
      }
    }
  }

  /**
   * Process a candle during the retracement tracking sub-phase.
   * Checks for entry rejection first (if enough retracements), then counts retracements.
   */
  private processRetracementPhase(candle: Candle, ctx: EvaluationContext, currentTime: Date): void {
    // If we have enough retracements, check for entry rejection FIRST
    if (ctx.retracementCandles.length >= MIN_RETRACEMENT_CANDLES) {
      const rejectionDirection = ctx.direction === 'short' ? 'bearish' : 'bullish';
      const priorCandle = ctx.retracementCandles.length > 0
        ? ctx.retracementCandles[ctx.retracementCandles.length - 1]
        : undefined;
      const rejectionResult = this.deps.candlePatternAnalyzer.isRejectionCandle(
        candle,
        rejectionDirection as 'bullish' | 'bearish',
        priorCandle
      );

      if (rejectionResult.isRejection) {
        // Entry rejection confirmed - store and move to entry_check
        ctx.rejectionCandle = candle;
        ctx.subPhase = 'entry_check';
        this.processEntryCheck(ctx, currentTime);
        return;
      }
    }

    // Not a rejection (or not enough retracements yet) - try to classify as retracement
    if (this.isRetracementCandle(candle, ctx.direction)) {
      ctx.retracementCandles.push(candle);

      // Check max retracement limit
      if (ctx.retracementCandles.length > MAX_RETRACEMENT_CANDLES) {
        this.invalidateSetup('retracement_exceeded_max', currentTime);
        return;
      }
    } else {
      // Candle is neither rejection nor retracement
      if (ctx.retracementCandles.length >= MIN_RETRACEMENT_CANDLES) {
        // We have enough retracements but this candle doesn't fit - invalidate
        this.invalidateSetup('unexpected_candle_in_retracement', currentTime);
      } else {
        // Not enough retracements yet and candle doesn't qualify - count it anyway as neutral
        ctx.retracementCandles.push(candle);
        if (ctx.retracementCandles.length > MAX_RETRACEMENT_CANDLES) {
          this.invalidateSetup('retracement_exceeded_max', currentTime);
        }
      }
    }
  }

  /**
   * Process the entry check sub-phase.
   * Validates structural window and emits signal if valid.
   */
  private processEntryCheck(ctx: EvaluationContext, currentTime: Date): void {
    if (!ctx.rejectionCandle || !this.observationContext) {
      this.invalidateSetup('entry_check_missing_data', currentTime);
      return;
    }

    const zone = this.observationContext.liquidityZone;
    const entryPrice = ctx.rejectionCandle.close;

    // Validate structural window: entry price must be within zone boundaries
    if (entryPrice < zone.lowerBoundary || entryPrice > zone.upperBoundary) {
      this.invalidateSetup('entry_outside_structural_window', currentTime);
      return;
    }

    // All conditions met - construct and emit signal
    this.constructAndEmitSignal(ctx, currentTime);

    // Transition to scanning
    this.evaluationContext = null;
    this.observationContext = null;
    this.transitionTo('scanning', 'signal_emitted', currentTime);
  }

  // ─── Expansion / Retracement Classification ─────────────────────────────────

  /**
   * Classify a candle as an expansion candle.
   * Body ratio >= 0.6 AND close moves away from zone (correct direction).
   */
  private isExpansionCandle(candle: Candle, direction: 'long' | 'short'): boolean {
    const range = candle.high - candle.low;
    if (range === 0) return false; // doji/zero-range candle

    const bodyRatio = Math.abs(candle.open - candle.close) / range;
    if (bodyRatio < BODY_RATIO_THRESHOLD) return false;

    // Direction check: close must move AWAY from zone
    if (direction === 'short') {
      return candle.close < candle.open; // bearish (moving down, away from structural high)
    } else {
      return candle.close > candle.open; // bullish (moving up, away from structural low)
    }
  }

  /**
   * Classify a candle as a retracement candle.
   * Close pulls back TOWARD the zone (opposite to trade direction).
   * Flat body (open === close) treated as retracement (neutral).
   */
  private isRetracementCandle(candle: Candle, direction: 'long' | 'short'): boolean {
    if (candle.open === candle.close) return true; // flat body = neutral = retracement

    if (direction === 'short') {
      return candle.close > candle.open; // bullish candle pulling back up toward zone
    } else {
      return candle.close < candle.open; // bearish candle pulling back down toward zone
    }
  }

  /**
   * Recalculate expansion averages after adding a new expansion candle.
   */
  private updateExpansionAverages(ctx: EvaluationContext): void {
    const candles = ctx.expansionCandles;
    if (candles.length === 0) return;

    ctx.averageExpansionVolume = candles.reduce((sum, c) => sum + c.volume, 0) / candles.length;
    ctx.averageExpansionBodySize = candles.reduce((sum, c) => sum + Math.abs(c.open - c.close), 0) / candles.length;
  }

  // ─── Signal Construction & Invalidation ────────────────────────────────────

  /**
   * Construct a RawSignal from the current evaluation context and emit it.
   */
  private constructAndEmitSignal(ctx: EvaluationContext, currentTime: Date): void {
    if (!this.observationContext || !ctx.rejectionCandle) return;

    const zone = this.observationContext.liquidityZone;
    const rejectionCandle = ctx.rejectionCandle;

    // Determine rejection candle type by re-analyzing
    const rejectionDirection = ctx.direction === 'short' ? 'bearish' : 'bullish';
    const priorCandle = ctx.retracementCandles.length > 0
      ? ctx.retracementCandles[ctx.retracementCandles.length - 1]
      : undefined;
    const rejectionResult = this.deps.candlePatternAnalyzer.isRejectionCandle(
      rejectionCandle,
      rejectionDirection as 'bullish' | 'bearish',
      priorCandle
    );

    const signal: RawSignal = {
      id: crypto.randomUUID(),
      timestamp: currentTime.toISOString(),
      instrument: this.deps.instrument ?? rejectionCandle.instrument,
      direction: ctx.direction,
      entryPrice: rejectionCandle.close,
      liquidityZoneLevel: (zone.upperBoundary + zone.lowerBoundary) / 2,
      structuralWindowUpper: zone.upperBoundary,
      structuralWindowLower: zone.lowerBoundary,
      rejectionCandleType: (rejectionResult.pattern ?? 'shooting_star') as RawSignal['rejectionCandleType'],
      expansionCandles: [...ctx.expansionCandles],
      retracementCandles: [...ctx.retracementCandles],
      observationCandles: [...this.observationContext.candles],
    };

    this.emitSignal(signal);
  }

  /**
   * Invalidate the current signal evaluation setup.
   * Clears both evaluation and observation contexts, transitions to scanning.
   */
  private invalidateSetup(reason: string, currentTime: Date): void {
    this.evaluationContext = null;
    this.observationContext = null;
    this.transitionTo('scanning', reason, currentTime);
  }

  // ─── Signal Emission ───────────────────────────────────────────────────────

  /**
   * Emit a raw signal to all registered handlers and the event bus.
   * Called by the signal evaluation logic when a valid signal is generated.
   */
  protected emitSignal(signal: RawSignal): void {
    // Emit on event bus
    this.deps.eventBus.publish('signal.raw', signal);

    // Notify all registered handlers
    for (const handler of this.signalHandlers) {
      handler(signal);
    }
  }
}
