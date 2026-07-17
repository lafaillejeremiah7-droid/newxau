# Implementation Plan: Signal Evaluation Logic

## Overview

Implement the complete `handleSignalEvaluationState()` method in `SignalEngineFSM` with a three-sub-phase pipeline (expansion tracking → retracement tracking → entry check). The implementation modifies `src/types/state.ts` to add the `subPhase` field and fully replaces the placeholder logic in `src/core/signal-engine-fsm.ts`.

## Tasks

- [ ] 1. Add subPhase field to EvaluationContext and define constants
  - [ ] 1.1 Add `subPhase` field to the `EvaluationContext` interface in `src/types/state.ts`
    - Add field: `subPhase: 'expansion_tracking' | 'retracement_tracking' | 'entry_check'`
    - Update the existing EvaluationContext initialization in `signal-engine-fsm.ts` (in `handleObservationState`) to include `subPhase: 'expansion_tracking'`
    - Add configuration constants to `signal-engine-fsm.ts`: `MIN_EXPANSION_CANDLES = 2`, `MIN_RETRACEMENT_CANDLES = 2`, `MAX_RETRACEMENT_CANDLES = 4`, `BODY_RATIO_THRESHOLD = 0.6`
    - _Requirements: 1.5, 2.5, 2.6_

- [ ] 2. Implement expansion and retracement classification methods
  - [ ] 2.1 Implement `isExpansionCandle(candle, direction)` private method
    - Returns true if body ratio `(Math.abs(open - close) / (high - low)) >= 0.6` AND close direction matches trade direction (close < open for short, close > open for long)
    - Handle edge case where `high === low` (doji) by returning false
    - _Requirements: 1.1, 1.2, 1.3_

  - [ ] 2.2 Implement `isRetracementCandle(candle, direction)` private method
    - For short direction: returns true if `close > open` (bullish candle pulling back toward zone)
    - For long direction: returns true if `close < open` (bearish candle pulling back toward zone)
    - Flat body candles (`open === close`) are treated as retracement (neutral, doesn't extend expansion)
    - _Requirements: 2.2, 2.3_

  - [ ] 2.3 Implement `updateExpansionAverages(ctx)` private method
    - Recalculate `averageExpansionVolume` as mean of all expansion candle volumes
    - Recalculate `averageExpansionBodySize` as mean of `Math.abs(open - close)` across expansion candles
    - _Requirements: 1.4_

  - [ ]* 2.4 Write property tests for expansion and retracement classification (Properties 1, 3)
    - **Property 1: Expansion Candle Classification Consistency** — For any candle and direction, classified as expansion iff body ratio ≥ 0.6 AND correct close direction
    - **Property 3: Retracement Candle Direction Inversion** — For any retracement candle, its directional body is opposite to the trade direction
    - **Validates: Requirements 1.1, 1.2, 1.3, 2.2, 2.3**

- [ ] 3. Implement signal construction and invalidation helpers
  - [ ] 3.1 Implement `constructAndEmitSignal(ctx, currentTime)` private method
    - Construct `RawSignal` using: `crypto.randomUUID()` for id, `currentTime.toISOString()` for timestamp, direction from ctx, entry price from rejection candle close, zone midpoint for liquidityZoneLevel, zone boundaries for structural window, rejection pattern type from CandlePatternAnalyzer result, expansion/retracement/observation candle arrays
    - Call `this.emitSignal(signal)` to publish
    - _Requirements: 5.1, 5.2_

  - [ ] 3.2 Implement `invalidateSetup(reason, currentTime)` private method
    - Clear `this.evaluationContext = null` and `this.observationContext = null`
    - Call `this.transitionTo('scanning', reason, currentTime)`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [ ]* 3.3 Write property tests for invalidation behavior (Property 9)
    - **Property 9: Invalidation Clears Context** — After any invalidation, both evaluationContext and observationContext are null
    - **Validates: Requirements 5.4, 6.5**

- [ ] 4. Implement the full handleSignalEvaluationState method
  - [ ] 4.1 Implement expansion_tracking sub-phase logic within `handleSignalEvaluationState`
    - If candle is expansion: append to ctx.expansionCandles, call updateExpansionAverages
    - If candle is NOT expansion AND expansionCandles.length >= 2: transition subPhase to 'retracement_tracking' and process the candle as retracement (fall through)
    - If candle is NOT expansion AND expansionCandles.length < 2: call invalidateSetup("expansion_insufficient")
    - _Requirements: 1.1, 1.4, 1.5, 6.3_

  - [ ] 4.2 Implement retracement_tracking sub-phase logic within `handleSignalEvaluationState`
    - First check for rejection if retracementCandles.length >= 2: call `candlePatternAnalyzer.isRejectionCandle(candle, rejectionDirection, priorCandle)`. If rejection found, store rejection candle and set subPhase to 'entry_check', fall through to entry_check logic
    - If not rejection and isRetracementCandle: append to retracementCandles. If length > 4: invalidateSetup("retracement_exceeded_max")
    - If not rejection and not retracement and retracementCandles >= 2: check if flat body (open === close) → treat as retracement; otherwise invalidateSetup("unexpected_candle_in_retracement")
    - If retracementCandles < 2: append as retracement if qualifies, otherwise treat as neutral
    - _Requirements: 2.1, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 6.2_

  - [ ] 4.3 Implement entry_check sub-phase logic within `handleSignalEvaluationState`
    - Validate structural window: entry price = rejectionCandle.close must be within [zone.lowerBoundary, zone.upperBoundary]
    - If outside: invalidateSetup("entry_outside_structural_window")
    - If within: call constructAndEmitSignal, then transitionTo('scanning', 'signal_emitted'), clear evaluationContext and observationContext
    - _Requirements: 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 5.4_

  - [ ]* 4.4 Write property tests for minimum expansion requirement (Property 2)
    - **Property 2: Minimum Expansion Requirement** — FSM never transitions to retracement_tracking with fewer than 2 expansion candles; setup is invalidated instead
    - **Validates: Requirements 1.5, 6.3**

  - [ ]* 4.5 Write property tests for retracement count bounds (Property 4)
    - **Property 4: Retracement Count Bounds** — If retracement count exceeds 4 without entry rejection, setup is invalidated. No signal ever emitted with >4 retracement candles.
    - **Validates: Requirements 2.6, 6.2**

- [ ] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Wire signal construction and validate end-to-end flow
  - [ ] 6.1 Store rejection pattern type from CandlePatternAnalyzer result for signal construction
    - During entry_check, the rejection result includes the pattern type (shooting_star, hammer, bearish_engulfing, bullish_engulfing). Store this on the evaluation context or pass directly to constructAndEmitSignal.
    - Ensure observation context candles are available for signal construction (observationContext must not be cleared until after signal emission)
    - _Requirements: 3.4, 5.1, 7.1, 7.2_

  - [ ] 6.2 Wire up observation candles and zone data into signal construction
    - Access `this.observationContext.candles` for the observationCandles field in RawSignal
    - Access `this.observationContext.liquidityZone` for zone boundaries and midpoint
    - Ensure the observation context reference is preserved until signal construction completes
    - _Requirements: 5.1, 7.3, 7.4_

  - [ ]* 6.3 Write property tests for entry rejection direction alignment (Property 5)
    - **Property 5: Entry Rejection Direction Alignment** — For short trades, rejection is bearish (shooting_star or bearish_engulfing); for long trades, rejection is bullish (hammer or bullish_engulfing)
    - **Validates: Requirements 3.2, 3.3**

  - [ ]* 6.4 Write property tests for structural window validation (Property 6)
    - **Property 6: Structural Window Validation** — For any emitted signal, entry price is within [lowerBoundary, upperBoundary]. No signal emitted with entry outside window.
    - **Validates: Requirements 4.1, 4.2, 4.3**

  - [ ]* 6.5 Write property tests for signal construction completeness and direction-zone alignment (Properties 7, 8)
    - **Property 7: Signal Construction Completeness** — Every emitted signal has unique ID, valid timestamp, correct direction, entry price = rejection candle close, ≥2 expansion candles, ≥2 retracement candles, observation candles from prior phase
    - **Property 8: Direction-Zone Alignment** — structural_high → short, structural_low → long
    - **Validates: Requirements 5.1, 7.1, 7.2, 7.3, 7.4**

  - [ ]* 6.6 Write property test for signal-only enforcement (Property 10)
    - **Property 10: Signal-Only Enforcement** — The only externally-visible side effect is emitSignal(). No trade execution, order placement, or broker API invocation occurs.
    - **Validates: Requirements 8.1, 8.2, 8.3**

- [ ] 7. Add unit tests for end-to-end signal flows
  - [ ] 7.1 Write unit tests for complete short signal flow
    - Hand-crafted test: structural_high zone → 2 bearish expansion candles → 2 bullish retracement candles → shooting_star rejection → signal emitted with direction "short"
    - Verify signal fields (id, timestamp, direction, entryPrice, liquidityZoneLevel, structuralWindowUpper, structuralWindowLower, rejectionCandleType, expansionCandles, retracementCandles, observationCandles)
    - Verify FSM transitions back to scanning with reason "signal_emitted"
    - _Requirements: 5.1, 7.1, 7.3_

  - [ ] 7.2 Write unit tests for complete long signal flow
    - Hand-crafted test: structural_low zone → 3 bullish expansion candles → 2 bearish retracement candles → hammer rejection → signal emitted with direction "long"
    - Verify all signal fields populated correctly
    - Verify FSM transitions back to scanning with reason "signal_emitted"
    - _Requirements: 5.1, 7.2, 7.4_

  - [ ] 7.3 Write unit tests for edge cases and invalidation paths
    - Test: exactly 2 expansion candles (minimum valid)
    - Test: exactly 4 retracement candles (maximum valid)
    - Test: body ratio exactly at 0.6 threshold (should qualify as expansion)
    - Test: entry price exactly on zone boundary (should be within window)
    - Test: 5th retracement candle triggers invalidation
    - Test: non-expansion candle with only 1 expansion triggers invalidation
    - Test: entry price outside zone triggers invalidation
    - _Requirements: 1.5, 2.6, 4.2, 6.2, 6.3, 6.4_

- [ ] 8. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties using fast-check
- Unit tests validate specific examples and edge cases
- The implementation modifies primarily `src/core/signal-engine-fsm.ts` and `src/types/state.ts`
- No trade execution code is permitted — this is a signal-only bot
- The existing `emitSignal()` method and `RawSignal` interface are already in place

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "2.2", "2.3", "3.1", "3.2"] },
    { "id": 2, "tasks": ["2.4", "3.3", "4.1"] },
    { "id": 3, "tasks": ["4.2", "4.3"] },
    { "id": 4, "tasks": ["4.4", "4.5", "6.1", "6.2"] },
    { "id": 5, "tasks": ["6.3", "6.4", "6.5", "6.6"] },
    { "id": 6, "tasks": ["7.1", "7.2", "7.3"] }
  ]
}
```
