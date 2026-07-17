/**
 * State-related type definitions for the Isagi Engine Signal Bot.
 * Defines FSM states, transitions, and context objects.
 */

import type { Candle } from './candle.js';
import type { LiquidityZone } from './zone.js';

/** Possible states of the Signal Engine FSM */
export type EngineState =
  | 'suppressed'
  | 'scanning'
  | 'observation'
  | 'signal_evaluation';

/** Record of a state transition event */
export interface StateTransition {
  from: EngineState;
  to: EngineState;
  reason: string;
  timestamp: string;
}

/** Context maintained during Observation Phase */
export interface ObservationContext {
  liquidityZone: LiquidityZone;
  candleCount: number;
  candles: Candle[];
  volumeBelowSma: boolean;
  rangeCompressing: boolean;
  startTimestamp: string;
}

/** Context maintained during Signal Evaluation Phase */
export interface EvaluationContext {
  direction: 'long' | 'short';
  subPhase: 'expansion_tracking' | 'retracement_tracking' | 'entry_check';
  expansionCandles: Candle[];
  retracementCandles: Candle[];
  rejectionCandle: Candle | null;
  averageExpansionVolume: number;
  averageExpansionBodySize: number;
  structuralBreakLevel: number;
}
