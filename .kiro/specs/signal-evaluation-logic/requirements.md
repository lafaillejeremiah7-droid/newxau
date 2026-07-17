# Requirements Document

## Introduction

This feature implements the signal evaluation logic within the Isagi Engine Signal Bot's finite state machine (FSM). The FSM currently transitions into the `signal_evaluation` state after detecting a rejection candle in an observation phase, but the `handleSignalEvaluationState()` method is a placeholder that never emits signals. This feature provides the complete logic to track expansion candles, retracement candles, detect entry rejection confirmation, validate structural windows, emit raw buy/sell signals, and handle invalidation scenarios. The bot is strictly a signal-only system — it generates signals for display and logging, never executing trades.

## Glossary

- **Signal_Engine_FSM**: The core finite state machine that processes M5 candle events and manages state transitions (suppressed → scanning → observation → signal_evaluation).
- **Expansion_Candle**: An M5 candle whose body (|open - close|) is ≥ 60% of its total range (high - low) and whose close moves away from the originating liquidity zone.
- **Retracement_Candle**: An M5 candle whose close pulls back toward the originating liquidity zone after the expansion phase.
- **Entry_Rejection_Candle**: A candlestick pattern (shooting star, hammer, bearish engulfing, or bullish engulfing) detected at the end of the retracement phase that confirms the trade direction.
- **Structural_Window**: The price range bounded by the liquidity zone's upper and lower boundaries within which a valid entry must occur.
- **Liquidity_Zone**: A detected structural high or structural low on H1 or M15 timeframes, defined by upper and lower price boundaries.
- **Raw_Signal**: The output emitted by the Signal_Engine_FSM containing direction, entry price, zone level, structural window bounds, rejection candle type, and candle arrays.
- **Evaluation_Context**: Internal state object tracking expansion candles, retracement candles, rejection candle reference, average expansion volume, average expansion body size, and structural break level during signal evaluation.
- **Body_Ratio_Threshold**: The configured minimum ratio (0.6) of candle body size to total range for expansion candle qualification.
- **Candle_Pattern_Analyzer**: The module responsible for detecting candlestick patterns including rejection candles and expansion candles.

## Requirements

### Requirement 1: Expansion Candle Tracking

**User Story:** As a signal analyst, I want the Signal_Engine_FSM to identify and count expansion candles after a rejection is detected, so that the system verifies directional momentum before seeking an entry.

#### Acceptance Criteria

1. WHEN the Signal_Engine_FSM is in signal_evaluation state and receives an M5 candle, THE Signal_Engine_FSM SHALL classify the candle as an Expansion_Candle if its body ratio (|open - close| / (high - low)) is ≥ 0.6 and its close moves away from the Liquidity_Zone relative to the trade direction.
2. WHEN the trade direction is short, THE Signal_Engine_FSM SHALL classify an M5 candle as an Expansion_Candle only if the candle close is lower than the candle open (bearish body moving away from a structural high zone).
3. WHEN the trade direction is long, THE Signal_Engine_FSM SHALL classify an M5 candle as an Expansion_Candle only if the candle close is higher than the candle open (bullish body moving away from a structural low zone).
4. WHEN an Expansion_Candle is detected, THE Signal_Engine_FSM SHALL append the candle to the Evaluation_Context expansionCandles array and update the averageExpansionVolume and averageExpansionBodySize fields.
5. THE Signal_Engine_FSM SHALL require a minimum of 2 Expansion_Candles before transitioning to the retracement tracking sub-phase.

### Requirement 2: Retracement Candle Tracking

**User Story:** As a signal analyst, I want the Signal_Engine_FSM to identify and count retracement candles after sufficient expansion, so that the system recognizes a pullback that sets up the entry opportunity.

#### Acceptance Criteria

1. WHEN the Signal_Engine_FSM has accumulated at least 2 Expansion_Candles and receives an M5 candle that does not qualify as an Expansion_Candle, THE Signal_Engine_FSM SHALL begin classifying candles as Retracement_Candles.
2. WHEN the trade direction is short, THE Signal_Engine_FSM SHALL classify an M5 candle as a Retracement_Candle if the candle close is higher than the candle open (price pulling back upward toward the structural high zone).
3. WHEN the trade direction is long, THE Signal_Engine_FSM SHALL classify an M5 candle as a Retracement_Candle if the candle close is lower than the candle open (price pulling back downward toward the structural low zone).
4. WHEN a Retracement_Candle is detected, THE Signal_Engine_FSM SHALL append the candle to the Evaluation_Context retracementCandles array.
5. THE Signal_Engine_FSM SHALL require a minimum of 2 Retracement_Candles before checking for an Entry_Rejection_Candle.
6. IF the Evaluation_Context accumulates more than 4 Retracement_Candles without detecting an Entry_Rejection_Candle, THEN THE Signal_Engine_FSM SHALL invalidate the setup and transition to scanning state with reason "retracement_exceeded_max".

### Requirement 3: Entry Rejection Detection

**User Story:** As a signal analyst, I want the Signal_Engine_FSM to detect an entry rejection candle at the end of the retracement phase, so that the system confirms directional commitment before generating a signal.

#### Acceptance Criteria

1. WHEN the Signal_Engine_FSM has accumulated between 2 and 4 Retracement_Candles and receives a new M5 candle, THE Signal_Engine_FSM SHALL invoke the Candle_Pattern_Analyzer to check for a rejection candle matching the expected trade direction.
2. WHEN the trade direction is short, THE Signal_Engine_FSM SHALL check for a bearish rejection pattern (shooting star or bearish engulfing) on the new M5 candle.
3. WHEN the trade direction is long, THE Signal_Engine_FSM SHALL check for a bullish rejection pattern (hammer or bullish engulfing) on the new M5 candle.
4. WHEN the Candle_Pattern_Analyzer confirms a rejection pattern matching the trade direction, THE Signal_Engine_FSM SHALL store the candle as the entry rejection candle and proceed to structural window validation.

### Requirement 4: Structural Window Validation

**User Story:** As a signal analyst, I want the system to validate that the entry price falls within the structural window, so that signals are only generated at structurally meaningful price levels.

#### Acceptance Criteria

1. WHEN an Entry_Rejection_Candle is detected, THE Signal_Engine_FSM SHALL validate that the entry price (the close of the Entry_Rejection_Candle) is within the Structural_Window bounded by the Liquidity_Zone upperBoundary and lowerBoundary.
2. IF the entry price is above the Liquidity_Zone upperBoundary or below the Liquidity_Zone lowerBoundary, THEN THE Signal_Engine_FSM SHALL invalidate the setup and transition to scanning state with reason "entry_outside_structural_window".
3. WHEN the entry price is within the Structural_Window, THE Signal_Engine_FSM SHALL proceed to emit the Raw_Signal.

### Requirement 5: Raw Signal Emission

**User Story:** As a signal analyst, I want the Signal_Engine_FSM to emit a complete Raw_Signal when all conditions are met, so that downstream pipeline components can process and format the trade signal.

#### Acceptance Criteria

1. WHEN structural window validation passes, THE Signal_Engine_FSM SHALL construct a Raw_Signal with a unique identifier, the current ISO 8601 timestamp, the trade direction (long or short), the entry price, the liquidity zone level (midpoint of zone boundaries), the structural window upper and lower bounds, the Entry_Rejection_Candle pattern type, the expansion candle array, the retracement candle array, and the observation candle array.
2. WHEN a Raw_Signal is constructed, THE Signal_Engine_FSM SHALL invoke the emitSignal method to publish the signal to the event bus and notify all registered signal handlers.
3. WHEN the Raw_Signal is emitted, THE Signal_Engine_FSM SHALL transition to scanning state with reason "signal_emitted".
4. WHEN the Raw_Signal is emitted, THE Signal_Engine_FSM SHALL clear the Evaluation_Context.

### Requirement 6: Setup Invalidation

**User Story:** As a signal analyst, I want the Signal_Engine_FSM to gracefully handle invalid setups by transitioning back to scanning, so that the system can evaluate new opportunities without getting stuck.

#### Acceptance Criteria

1. IF the Signal_Engine_FSM receives an M5 candle in signal_evaluation state and the Evaluation_Context is null, THEN THE Signal_Engine_FSM SHALL transition to scanning state with reason "evaluation_context_missing".
2. IF the retracement count exceeds 4 candles without entry rejection detection, THEN THE Signal_Engine_FSM SHALL transition to scanning state with reason "retracement_exceeded_max".
3. IF a candle during the expansion phase does not qualify as an Expansion_Candle and fewer than 2 Expansion_Candles have been accumulated, THEN THE Signal_Engine_FSM SHALL invalidate the setup and transition to scanning state with reason "expansion_insufficient".
4. IF the entry price fails structural window validation, THEN THE Signal_Engine_FSM SHALL transition to scanning state with reason "entry_outside_structural_window".
5. WHEN the Signal_Engine_FSM transitions from signal_evaluation to scanning due to invalidation, THE Signal_Engine_FSM SHALL clear the Evaluation_Context and the associated Observation_Context.

### Requirement 7: Direction-Specific Signal Rules

**User Story:** As a signal analyst, I want the system to enforce correct directional logic for short and long signals, so that signals are only emitted when the complete pattern aligns with the zone type.

#### Acceptance Criteria

1. WHEN the Liquidity_Zone type is structural_high, THE Signal_Engine_FSM SHALL enforce short-signal logic: rejection from zone → bearish expansion (candles closing lower) → bullish retracement (candles closing higher) → bearish entry rejection → SELL signal.
2. WHEN the Liquidity_Zone type is structural_low, THE Signal_Engine_FSM SHALL enforce long-signal logic: rejection from zone → bullish expansion (candles closing higher) → bearish retracement (candles closing lower) → bullish entry rejection → BUY signal.
3. THE Signal_Engine_FSM SHALL set the Raw_Signal direction to "short" when the originating zone type is structural_high.
4. THE Signal_Engine_FSM SHALL set the Raw_Signal direction to "long" when the originating zone type is structural_low.

### Requirement 8: Signal-Only Enforcement

**User Story:** As a system operator, I want the signal evaluation logic to produce signals exclusively for display and logging, so that no automatic trade execution can occur.

#### Acceptance Criteria

1. THE Signal_Engine_FSM SHALL emit Raw_Signals only through the emitSignal method which publishes to the event bus and notifies registered signal handlers.
2. THE Signal_Engine_FSM SHALL NOT invoke any trade execution, order placement, order modification, or order cancellation API.
3. THE Signal_Engine_FSM SHALL NOT contain any import or reference to broker APIs, trading APIs, or order management systems.
