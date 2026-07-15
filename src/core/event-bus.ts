/**
 * Internal Event Bus
 *
 * Provides typed publish/subscribe methods for loose coupling between components.
 * Uses Node.js EventEmitter as the underlying mechanism.
 *
 * Event types:
 * - candle.close: Emitted when a full candle closes on any timeframe (M1, M5, M15, H1)
 * - state.change: Emitted on every FSM state transition with StateTransition data
 * - signal.raw: Emitted when the FSM generates a raw signal (before pipeline processing)
 * - signal.formatted: Emitted after the signal pipeline produces a FormattedSignal
 * - filter.change: Emitted when any macro filter activates or deactivates
 * - alert.circuitBreaker: Emitted when the circuit breaker triggers (300+ pip move)
 */

import { EventEmitter } from 'node:events';

// ─── Event Payload Types ─────────────────────────────────────────────────────

export type Timeframe = 'M1' | 'M5' | 'M15' | 'H1';

export interface Candle {
  instrument: 'XAUUSD';
  timeframe: Timeframe;
  timestamp: string; // ISO 8601 UTC ms precision
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type EngineState =
  | 'suppressed'
  | 'scanning'
  | 'observation'
  | 'signal_evaluation';

export interface StateTransition {
  from: EngineState;
  to: EngineState;
  reason: string;
  timestamp: string; // ISO 8601 UTC ms precision
}

export type SignalDirection = 'long' | 'short';

export type RejectionCandleType =
  | 'shooting_star'
  | 'hammer'
  | 'bearish_engulfing'
  | 'bullish_engulfing';

export interface RawSignal {
  id: string;
  timestamp: string;
  direction: SignalDirection;
  entryPrice: number;
  liquidityZoneLevel: number;
  structuralWindowUpper: number;
  structuralWindowLower: number;
  rejectionCandleType: RejectionCandleType;
  expansionCandles: Candle[];
  retracementCandles: Candle[];
  observationCandles: Candle[];
}

export type ZoneClassification = 'expansion_zone' | 'chop_zone';

export interface SlippageResult {
  applied: boolean;
  originalEntry: number;
  adjustedEntry: number;
  slippagePips: number;
}

export interface TicketDetail {
  label: string;
  positionSizePercent: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
}

export interface FormattedSignal {
  id: string;
  timestamp: string;
  instrument: 'XAUUSD';
  direction: SignalDirection;
  entryPrice: number;
  stopLoss: number;
  ticket1: TicketDetail;
  ticket2: TicketDetail;
  zoneClassification: ZoneClassification;
  riskAmount: number;
  rUnit: number;
  reasoning: string;
  slippage: SlippageResult;
  breakevenTrigger: string;
  trailingStopGuidance: string;
}

export interface FilterChangeEvent {
  filterName: string;
  action: 'activated' | 'deactivated';
  timestamp: string; // ISO 8601 UTC ms precision
  reason: string;
}

export interface CircuitBreakerAlert {
  magnitude: number; // pips of adverse movement
  affectedSignalId: string | null;
  direction: SignalDirection;
  timestamp: string; // ISO 8601 UTC ms precision
  suppressionEndsAt: string; // ISO 8601 UTC ms precision
}

export interface CandleCloseEvent {
  candle: Candle;
  timeframe: Timeframe;
}

export interface IngestionSuppressedEvent {
  reason: string;
  source: string;
  timestamp: string;
}

// ─── Event Map (defines event name → payload type) ───────────────────────────

export interface EventBusEventMap {
  'candle.close': CandleCloseEvent;
  'state.change': StateTransition;
  'signal.raw': RawSignal;
  'signal.formatted': FormattedSignal;
  'filter.change': FilterChangeEvent;
  'alert.circuitBreaker': CircuitBreakerAlert;
  'ingestion.suppressed': IngestionSuppressedEvent;
}

export type EventName = keyof EventBusEventMap;

// ─── Typed Event Bus ─────────────────────────────────────────────────────────

export class EventBus {
  private readonly emitter: EventEmitter;

  constructor() {
    this.emitter = new EventEmitter();
    // Allow many listeners for components subscribing to same events
    this.emitter.setMaxListeners(50);
  }

  /**
   * Subscribe to a typed event.
   * Returns an unsubscribe function for easy cleanup.
   */
  subscribe<E extends EventName>(
    event: E,
    handler: (payload: EventBusEventMap[E]) => void
  ): () => void {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
    return () => {
      this.emitter.off(event, handler as (...args: unknown[]) => void);
    };
  }

  /**
   * Subscribe to a typed event for a single emission only.
   */
  subscribeOnce<E extends EventName>(
    event: E,
    handler: (payload: EventBusEventMap[E]) => void
  ): void {
    this.emitter.once(event, handler as (...args: unknown[]) => void);
  }

  /**
   * Publish a typed event to all subscribers.
   */
  publish<E extends EventName>(event: E, payload: EventBusEventMap[E]): void {
    this.emitter.emit(event, payload);
  }

  /**
   * Get the current listener count for an event.
   */
  listenerCount(event: EventName): number {
    return this.emitter.listenerCount(event);
  }

  /**
   * Remove all listeners for a specific event, or all events if none specified.
   */
  removeAllListeners(event?: EventName): void {
    if (event) {
      this.emitter.removeAllListeners(event);
    } else {
      this.emitter.removeAllListeners();
    }
  }
}
