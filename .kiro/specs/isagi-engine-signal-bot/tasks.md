# Implementation Plan: Isagi Engine Signal Bot

## Overview

This plan implements the Isagi Engine — a signal-only XAU/USD trading signal bot using TypeScript/Node.js with an FSM-based Signal Engine, event-driven architecture, SQLite logging, WebSocket price ingestion, Express.js dashboard, and Telegram notifications. The implementation is broken into incremental tasks that build on each other, culminating in a fully wired system with property-based and unit tests.

## Tasks

- [x] 1. Project scaffolding, configuration, and core interfaces
  - [x] 1.1 Initialize TypeScript project with dependencies
    - Initialize npm project with TypeScript, ts-node, ESLint, Prettier
    - Install dependencies: express, ws, better-sqlite3, node-fetch, fast-check, vitest
    - Configure tsconfig.json with strict mode, ES2022 target, Node module resolution
    - Create src/ directory structure: src/core/, src/filters/, src/pipeline/, src/output/, src/data/, src/config/, src/types/
    - _Requirements: All (project foundation)_


  - [x] 1.2 Define core type interfaces and domain models
    - Create src/types/candle.ts with Candle, Timeframe, CandleBuffer interfaces
    - Create src/types/signal.ts with RawSignal, FormattedSignal, TicketDetail, SlippageResult interfaces
    - Create src/types/state.ts with EngineState, StateTransition, ObservationContext, EvaluationContext interfaces
    - Create src/types/zone.ts with LiquidityZone, ZoneClassification, WickCluster, LiquidityPocket interfaces
    - Create src/types/filter.ts with FilterStatus, FilterResult interfaces
    - Create src/types/config.ts with SystemConfig interface matching the design specification
    - _Requirements: All (type safety foundation)_

  - [x] 1.3 Implement configuration loader and signal-only enforcement
    - Create src/config/loader.ts that reads config from environment variables or JSON file
    - Implement startup validation: refuse to start if broker API credentials or trade execution endpoints are found
    - Validate instrument is 'XAUUSD' only
    - Validate Telegram config (botToken: <TELEGRAM_BOT_TOKEN>, chatId: 7040023207)
    - Log critical error and exit if any trade execution configuration detected
    - _Requirements: 15.5, 15.6, 15.7, 16.1_

  - [x] 1.4 Implement internal event bus
    - Create src/core/event-bus.ts using Node.js EventEmitter pattern with typed events
    - Define event types: candle.close, state.change, signal.raw, signal.formatted, filter.change, alert.circuitBreaker
    - Provide typed subscribe/publish methods for loose coupling between components
    - _Requirements: All (architecture foundation)_


- [x] 2. Signal Logger and SQLite storage layer
  - [x] 2.1 Implement SQLite database initialization and schema
    - Create src/data/signal-logger.ts implementing SignalLogger interface
    - Initialize SQLite database with signals, rejections, state_transitions, filter_events tables per design schema
    - Create indexes on timestamp columns for retention cleanup queries
    - Implement 90-day retention cleanup (DELETE records older than 90 days)
    - _Requirements: 14.5, 14.7_

  - [x] 2.2 Implement signal and rejection logging methods
    - Implement logSignal() persisting all signal fields (entry, SL, TP, direction, zone, risk, timestamp, reasoning)
    - Implement logRejection() with rejection reason, filter name, timestamp, and context JSON
    - Implement logStateTransition() with from_state, to_state, reason, ISO 8601 UTC ms timestamp
    - Implement logFilterEvent() with filter name, action, timestamp, duration, metadata
    - All timestamps in ISO 8601 UTC format with millisecond precision
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.7_

  - [x] 2.3 Implement write retry and memory buffer fallback
    - On write failure, retry up to 3 times
    - If all retries fail, buffer entry in memory and emit warning
    - Flush buffered entries on next successful write
    - _Requirements: 14.6_

  - [ ]* 2.4 Write property test for log entry completeness (Property 23)
    - **Property 23: Log Entry Completeness and Format**
    - Generate random log entries of each type (signal, rejection, state transition, filter event)
    - Verify all contain ISO 8601 UTC timestamp with ms precision and non-null required fields
    - Verify chronological ordering is maintained
    - **Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.7**


- [x] 3. Candle Ingestion Module and Instrument Filter
  - [x] 3.1 Implement Candle Ingestion Module with WebSocket connection
    - Create src/data/candle-ingestion.ts implementing CandleIngestionModule interface
    - Connect to WebSocket price feed and parse incoming tick/candle data
    - Assemble OHLCV candles for M1, M5, M15, H1 timeframes from raw ticks
    - Emit candle.close events only on full candle close (never incomplete candles)
    - Implement auto-reconnect with configurable exponential backoff (1s, 2s, 4s, 8s, max 60s)
    - _Requirements: 16.1, 4.5, 6.6_

  - [x] 3.2 Implement XAU/USD instrument validation and rejection
    - Reject any incoming data where instrument !== 'XAUUSD'
    - Log rejected instruments with identifier, timestamp, and data source origin
    - On startup, if data source does not provide XAU/USD, log critical error and remain in suppressed state
    - _Requirements: 16.1, 16.2, 16.3, 16.4_

  - [ ]* 3.3 Write property test for instrument exclusivity (Property 25)
    - **Property 25: XAU/USD Instrument Exclusivity**
    - Generate random instrument identifiers; verify only 'XAUUSD' is accepted
    - Verify rejected instruments produce warning log with identifier, timestamp, source
    - **Validates: Requirements 16.1, 16.2**

  - [x] 3.4 Implement CandleBuffer with rolling SMA-20 volume calculation
    - Create src/data/candle-buffer.ts managing rolling candle arrays per timeframe
    - M5 buffer: 200 candles, M15: 100, H1: 50, M1: 500
    - Maintain rolling 20-period SMA of volume for M5 candles
    - _Requirements: 9.1 (volume SMA baseline)_


- [x] 4. Candle Pattern Analyzer and Liquidity Zone Detector
  - [x] 4.1 Implement Candle Pattern Analyzer
    - Create src/core/candle-pattern-analyzer.ts implementing CandlePatternAnalyzer interface
    - Implement isRejectionCandle(): shooting star (top wick ≥50% range, body in lower third), hammer (bottom wick ≥2× body), bearish engulfing (body engulfs prior), bullish engulfing
    - Implement isExpansionCandle(): body ≥60% of range AND breaks structural level
    - Implement getBodyRatio() and getWickRatio() helper methods
    - _Requirements: 1.5, 2.1, 2.3, 3.1, 3.3_

  - [ ]* 4.2 Write property test for expansion candle detection (Property 3)
    - **Property 3: Expansion Candle Detection Invariant**
    - Generate random OHLCV candles with varying body ratios and structural levels
    - Verify classification matches: body/range ≥ 0.60 AND breaks structural level ↔ isExpansion = true
    - **Validates: Requirements 2.1, 3.1**

  - [x] 4.3 Implement Liquidity Zone Detector
    - Create src/core/liquidity-zone-detector.ts implementing LiquidityZoneDetector interface
    - Identify H1 and M15 structural highs and lows as liquidity zones
    - Maintain list of active zones with upper/lower boundaries
    - Implement isWithinZone() to check if a price falls within any active zone
    - Update zones as new H1/M15 candles close
    - _Requirements: 1.1_


- [x] 5. Macro Filter Module (Time Gate, News Decoupler, Circuit Breaker)
  - [x] 5.1 Implement Time Gate filter
    - Create src/filters/time-gate.ts
    - Active window: 12:00:00 – 16:59:59 UTC (inclusive); 17:00:00 is outside
    - On startup: check current UTC time and return active/suppressed accordingly
    - On deactivation (17:00:00): signal cancellation of in-progress observations/evaluations
    - Log suppression reason when outside window
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [ ]* 5.2 Write property test for Time Gate enforcement (Property 11)
    - **Property 11: Time Gate Enforcement**
    - Generate random UTC timestamps across 24-hour range
    - Verify engine is active iff 12:00:00 ≤ T < 17:00:00 UTC
    - Verify all other times → suppressed state
    - **Validates: Requirements 6.1, 6.2, 6.4, 6.5**

  - [x] 5.3 Implement News Decoupler filter
    - Create src/filters/news-decoupler.ts
    - Monitor high-impact USD events: CPI, NFP, FOMC, GDP, PPI
    - Freeze window: 2 minutes before → 15 minutes after release
    - Merge overlapping freeze windows into single continuous window
    - On data source unavailable: log warning, continue without freeze
    - Log activation/deactivation with event name, times
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_

  - [ ]* 5.4 Write property test for news freeze window computation (Property 12)
    - **Property 12: News Freeze Window Computation**
    - Generate random sets of event times with potential overlaps
    - Verify merged window spans min(Tᵢ)-2min to max(Tᵢ)+15min for overlapping events
    - Verify signal suppression during active freeze
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.6**

  - [x] 5.5 Implement Circuit Breaker
    - Create src/filters/circuit-breaker.ts
    - Monitor M1 candles for 300+ pip adverse movement against most recent signal direction
    - On trigger: generate alert (magnitude, signal ID, timestamp), suppress signals for 15 minutes
    - Auto-resume after cooldown period
    - _Requirements: 10.3, 10.4, 10.5_

  - [ ]* 5.6 Write property test for circuit breaker (Property 18)
    - **Property 18: Circuit Breaker Threshold and Suppression**
    - Generate random M1 candle movements × signal directions
    - Verify alert generated iff movement ≥ 300 pips adverse
    - Verify 15-minute suppression after alert
    - **Validates: Requirements 10.3, 10.5**

  - [x] 5.7 Implement MacroFilterModule façade
    - Create src/filters/macro-filter-module.ts combining Time Gate, News Decoupler, Circuit Breaker
    - Implement checkAllFilters() returning pass/block with reason
    - Implement getFilterStatus() for dashboard consumption
    - Emit filter.change events on bus when any filter activates/deactivates
    - _Requirements: 6, 7, 10.3-10.5_


- [x] 6. Signal Engine FSM (core state machine)
  - [x] 6.1 Implement Signal Engine FSM structure and state transitions
    - Create src/core/signal-engine-fsm.ts implementing SignalEngineFSM interface
    - Implement 4 states: suppressed, scanning, observation, signal_evaluation
    - Implement initialize() checking current time for initial state
    - Implement all state transition rules per design state transition table
    - Emit state.change events on every transition with from, to, reason, timestamp
    - Log every state transition via Signal Logger
    - _Requirements: 1.1, 6.3, 6.4, 6.5_

  - [x] 6.2 Implement Observation Phase logic
    - Track observation candle count (3-6 range)
    - Monitor M5 volume vs 20-period SMA (order absorption detection)
    - Monitor price range compression relative to expansion candles
    - Transition to SignalEvaluation on rejection candle detection
    - Transition to Scanning on: zone breakthrough (≥1 pip beyond far boundary), timeout (6 candles), or news freeze
    - Log timeout reason on 6-candle expiry
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [ ]* 6.3 Write property tests for Observation Phase (Properties 1, 2)
    - **Property 1: Observation Phase Transition Correctness**
    - Generate random M5 candle close prices × random zone boundaries
    - Verify transition to Observation iff close within zone while in Scanning
    - Verify no signals generated during Observation regardless of candle content
    - **Property 2: Observation Phase Termination**
    - Generate random 3-6 candle sequences with/without rejection/breakthrough
    - Verify exactly one of three outcomes occurs
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6**

  - [x] 6.4 Implement Short Signal structure detection
    - Scan for ≥2 consecutive bearish expansion candles (body ≥60% range, closes below prior local minor low within 20 candles)
    - Monitor corrective retracement: 2-4 candles, volume below expansion average, body size smaller than expansion average
    - Require bearish rejection candle (shooting star or bearish engulfing) at retracement high
    - Invalidate if retracement > 4 candles or retracement volume > expansion volume
    - Record structural context for signal generation
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 6.5 Implement Long Signal structure detection
    - Scan for ≥2 consecutive bullish expansion candles (body ≥60% range, closes above highest high of preceding 10 candles)
    - Monitor corrective retracement: 2-4 candles, volume below expansion average, range smaller than expansion average
    - Require bullish rejection candle (hammer or bullish engulfing) at retracement low
    - Invalidate if retracement > 4 candles or retracement volume > expansion volume
    - Record expansion count, retracement count, rejection type, breakout level
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [ ]* 6.6 Write property tests for retracement validation (Properties 4, 5)
    - **Property 4: Retracement Validation**
    - Generate random expansion + retracement candle pairs with varying volumes
    - Verify valid iff: volume < expansion avg, body/range < expansion avg, length 2-4
    - **Property 5: Setup Invalidation on Retracement Timeout**
    - Generate random 5+ candle sequences without rejection
    - Verify invalidation and return to scanning
    - **Validates: Requirements 2.2, 2.4, 2.5, 3.2, 3.4, 3.5**

  - [x] 6.7 Implement Entry Signal generation logic
    - Generate entry signal when rejection candle close is within structural window (breakdown/breakout zone to EMA levels)
    - Treat close exactly on boundary as within window
    - Wait for full M5 candle close before determination (never signal on incomplete candles)
    - Discard and log if close beyond structural window (include close price and window boundaries)
    - Record: timestamp (UTC), entry price, direction, liquidity zone level, window boundaries, rejection pattern type
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [ ]* 6.8 Write property tests for entry signal (Properties 6, 7)
    - **Property 6: Entry Signal Structural Window**
    - Generate random close prices × random window boundaries
    - Verify signal generated iff close ≤ upper AND close ≥ lower (boundary inclusive)
    - **Property 7: Signal Record Completeness**
    - Generate random valid signal contexts
    - Verify all required fields present and non-null
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 16.3**


- [x] 7. Checkpoint - Core engine verification
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Signal Pipeline: Stop Loss and Target Mapper
  - [x] 8.1 Implement wick cluster detection and stop-loss calculation
    - Create src/pipeline/stop-loss-target-mapper.ts implementing StopLossTargetMapper interface
    - Implement findWickCluster(): find ≥3 candle wicks within 1-pip vertical range in 20-candle lookback
    - For shorts: SL at 1-2 pips above highest wick cluster of swing high
    - For longs: SL at 1-2 pips below lowest wick cluster of swing low
    - Buffer: 1 pip for Chop_Zone, 2 pips for Expansion_Zone
    - _Requirements: 5.1, 5.2, 5.7_

  - [x] 8.2 Implement target projection and liquidity pocket detection
    - Implement findLiquidityPocket(): locate nearest open liquidity pocket (≥5 pips width, no volume block >150% of 20-period avg)
    - Project final target into nearest open liquidity pocket in signal direction
    - Adjust target before any volume block exceeding 150% of 20-period average
    - Calculate R_Unit = |entry - stopLoss|
    - Calculate TP1 = 35% of distance from entry to TP2
    - Invalidate signal if adjusted target < 1.5R from entry
    - _Requirements: 5.3, 5.4, 5.5, 5.6_

  - [ ]* 8.3 Write property tests for stop-loss and targets (Properties 8, 9, 10)
    - **Property 8: Stop Loss Placement**
    - Generate random 20-candle histories with wick clusters; verify SL placement correctness
    - **Property 9: R-Unit and Minimum Reward-to-Risk**
    - Generate random entry/SL/target combinations; verify R_Unit = |E-S| and reward ≥ 1.5R
    - **Property 10: Target Adjustment for Volume Blocks**
    - Generate random candle histories with volume blocks; verify target adjusted before block
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7**


- [x] 9. Signal Pipeline: Volume Filter and Zone Classifier
  - [x] 9.1 Implement Volume Filter with zone classification
    - Create src/pipeline/volume-filter.ts
    - Reject signal if current M5 volume < 20-period SMA of prior 20 closed M5 candles
    - Classify Expansion_Zone: ≥3 of last 5 candles show sequentially increasing volume → 3.0R target, partial profit at 35% distance
    - Classify Chop_Zone: ≥3 of last 5 candles show sequentially decreasing volume → 1.5R target, full exit
    - Default: neither condition → Chop_Zone classification, 2.0R target, full exit
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

  - [ ]* 9.2 Write property tests for volume filter (Properties 15, 16)
    - **Property 15: Volume Zone Classification**
    - Generate random 5-candle volume sequences above SMA; verify correct classification
    - **Property 16: Volume Filter Rejection**
    - Generate random candles × random SMA values; verify rejection iff volume < SMA
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.4**

- [x] 10. Signal Pipeline: Kelly Sizer
  - [x] 10.1 Implement Kelly Sizer with dynamic risk calculation
    - Create src/pipeline/kelly-sizer.ts implementing KellySizer interface
    - Compute rolling drawdown: peak-to-trough decline in cumulative P&L over last 20 signals
    - Compute equity curve variance: standard deviation of per-signal returns over last 20 signals
    - Cold start (< 20 signals): default $35.00
    - Drawdown > 5%: linear reduction toward $17.50 floor (reaching floor at 10%)
    - Variance > 1.5× historical average: reduce by 25%
    - Drawdown ≤ 2% AND variance ≤ 1.0× average: allow up to $70.00 ceiling
    - Clamp output between $17.50 and $70.00
    - Recalculate on each new signal before output formatting
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.9_

  - [ ]* 10.2 Write property tests for Kelly Sizer (Properties 13, 14)
    - **Property 13: Kelly Sizer Bounded Output**
    - Generate random P&L histories of varying lengths (0-50)
    - Verify: N<20 → $35, N≥20 → output in [$17.50, $70.00] with correct adjustments
    - **Property 14: Kelly Drawdown Calculation**
    - Generate random 20-element P&L sequences
    - Verify rolling drawdown = max peak-to-trough decline in cumulative sum
    - Verify equity curve variance = standard deviation of per-signal returns
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7**


- [x] 11. Signal Pipeline: Slippage Simulator
  - [x] 11.1 Implement Slippage Simulator
    - Create src/pipeline/slippage-simulator.ts implementing SlippageSimulator interface
    - Random selection: uniform 20% probability for slippage application
    - Slippage amount: uniform distribution in [0.5, 2.5] pips
    - Direction: always negative (adverse to trade direction) — applied to entry price only
    - Return SlippageResult with applied flag, original/adjusted entry, slippage pips
    - _Requirements: 10.1, 10.2, 10.6_

  - [ ]* 11.2 Write property test for slippage distribution (Property 17)
    - **Property 17: Slippage Distribution**
    - Generate large batches (1000+) of signals
    - Verify approximately 20% have slippage applied (within statistical tolerance)
    - Verify slippage amounts are within [0.5, 2.5] pips when applied
    - Verify slippage is adverse (negative) adjustment to entry price only
    - **Validates: Requirements 10.1, 10.2**

- [x] 12. Signal Output Formatter (split position logic)
  - [x] 12.1 Implement Signal Output Formatter
    - Create src/pipeline/signal-output-formatter.ts implementing SignalOutputFormatter interface
    - Split position: Ticket 1 (Safety Lock) at 45%, Ticket 2 (Runner) at 55%
    - Ticket 1 TP: 35% of distance from entry to Ticket 2 TP
    - Ticket 2 TP: based on zone (Expansion → 3.0R, Chop → 1.5R or 2.0R per liquidity pocket distance)
    - Include breakeven trigger: when Ticket 1 TP reached, Ticket 2 SL moves to entry
    - Include trailing stop guidance: most recent M5 structural swing point after breakeven
    - Include Kelly risk amount, zone classification, reasoning (max 280 chars)
    - Include slippage details (original entry, adjusted entry, slippage pips)
    - Label instrument as 'XAUUSD' on all outputs
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 8.8, 9.5, 16.3_

  - [ ]* 12.2 Write property test for split position arithmetic (Property 19)
    - **Property 19: Split Position Arithmetic**
    - Generate random entry/SL/TP combinations × zone types
    - Verify Ticket 1 at 45% with TP1 = E + 0.35×(TP2-E) for longs, E - 0.35×(E-TP2) for shorts
    - Verify Ticket 2 at 55% with zone-appropriate R-multiple
    - Verify both tickets share same entry and stop-loss
    - **Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.7**


- [x] 13. Checkpoint - Signal pipeline verification
  - Ensure all tests pass, ask the user if questions arise.

- [x] 14. Telegram Notifier
  - [x] 14.1 Implement Telegram Notifier with retry logic
    - Create src/output/telegram-notifier.ts implementing TelegramNotifier interface
    - Send formatted signal via Telegram Bot API sendMessage endpoint with HTML formatting
    - Bot token: <TELEGRAM_BOT_TOKEN>, Chat ID: 7040023207
    - Include: direction, entry price, SL, TP1, TP2, split details, zone, risk amount, reasoning (≤280 chars)
    - MUST NOT include trade execution commands or order placement instructions
    - Delivery target: within 5 seconds of signal generation
    - Retry on failure: exponential backoff 2s, 4s, 8s (3 retries max)
    - On all retries failed: log failure + full signal content for manual review
    - Suppress delivery if chat not configured or any required field missing (log error)
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 15.4_

  - [ ]* 14.2 Write property tests for Telegram (Properties 20, 21)
    - **Property 20: Telegram Message Content Completeness and Safety**
    - Generate random formatted signals; verify message contains all required fields
    - Verify message does NOT contain trade execution commands or order placement
    - Verify reasoning ≤ 280 characters
    - **Property 21: Telegram Delivery Suppression on Invalid Config**
    - Generate random signals with missing fields; verify suppression and error logging
    - **Validates: Requirements 12.2, 12.5, 12.6, 15.4**


- [x] 15. Dashboard (Express.js + WebSocket)
  - [x] 15.1 Implement Dashboard server backend
    - Create src/output/dashboard-server.ts implementing DashboardServer interface
    - Express.js HTTP server serving static HTML/CSS/JS single-page application
    - WebSocket (ws library) for real-time push updates to connected clients
    - Broadcast signal, state change, and filter status events to all connected clients
    - Maintain last 100 signals in reverse-chronological order (discard older)
    - Push updates within 2 seconds of signal generation
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5_

  - [x] 15.2 Implement Dashboard frontend (HTML/CSS/JS SPA)
    - Create src/output/dashboard/index.html with lightweight HTML/CSS/JS (no framework)
    - Display current engine state (scanning, observation, signal evaluation, suppressed)
    - Display signal log: entry price, direction, SL, TP1, TP2, zone, risk, timestamp (reverse-chronological)
    - Display active filter status: Time Gate, News Decoupler freeze, volume classification
    - Display Kelly metrics: risk level, rolling drawdown %, equity curve variance
    - Display disconnection indicator with last-update timestamp if connection lost
    - Remove disconnection indicator and resume live updates within 5 seconds of reconnection
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7_

  - [ ]* 15.3 Write property test for dashboard signal ordering (Property 22)
    - **Property 22: Dashboard Signal Ordering and Capacity**
    - Generate random sequences of signals with random timestamps
    - Verify display maintains reverse-chronological order (newest first)
    - Verify capacity retains minimum 100 signals, discards older
    - **Validates: Requirements 13.2**


- [x] 16. Signal-Only Enforcement Layer
  - [x] 16.1 Implement signal-only enforcement and startup validation
    - Create src/core/signal-only-enforcement.ts
    - Startup validation: verify no broker API credentials with write permissions configured
    - Verify no trade execution endpoints registered
    - If any detected: refuse to start, log critical error
    - Block any component attempting trade execution invocation, log critical error with component name, operation, timestamp
    - Restrict outbound HTTP to: market data feeds, Telegram Bot API, economic calendar API only
    - Configuration schema rejects broker tokens, trading account credentials, order submission endpoints
    - _Requirements: 15.1, 15.2, 15.3, 15.5, 15.6, 15.7_

  - [ ]* 16.2 Write property test for configuration enforcement (Property 24)
    - **Property 24: Signal-Only Configuration Enforcement**
    - Generate random config objects with/without broker credential fields
    - Verify system refuses to start if broker write credentials or trade endpoints detected
    - Verify config schema does not accept such fields
    - **Validates: Requirements 15.6, 15.7**

- [x] 17. Checkpoint - Output and enforcement verification
  - Ensure all tests pass, ask the user if questions arise.


- [x] 18. Integration wiring and end-to-end signal flow
  - [x] 18.1 Wire Candle Ingestion → Event Bus → Signal Engine FSM
    - Create src/main.ts as the application entry point
    - Connect CandleIngestionModule candle.close events to SignalEngineFSM.processCandle()
    - Wire FSM state.change events to Signal Logger and Event Bus
    - Wire Macro Filter Module to FSM for filter checks on each candle
    - Initialize correct state based on current UTC time (scanning or suppressed)
    - _Requirements: 1.1, 6.3, 6.5, 16.1_

  - [x] 18.2 Wire Signal Engine → Signal Pipeline → Output channels
    - Connect FSM signal.raw events to pipeline: SL/Target Mapper → Volume Filter → Kelly Sizer → Slippage Simulator → Output Formatter
    - Connect formatted signals to: Telegram Notifier, Dashboard broadcast, Signal Logger
    - Ensure pipeline short-circuits on volume rejection or reward < 1.5R invalidation
    - Connect circuit breaker alerts to Dashboard and Logger
    - _Requirements: 5, 8.9, 9, 10, 11, 12.1, 13.4, 14.1_

  - [x] 18.3 Implement application startup sequence
    - Implement startup validation per design flowchart: broker check → data source check → time check → dashboard → telegram → news calendar → begin processing
    - Handle graceful shutdown: close WebSocket, flush logger buffer, close SQLite
    - Handle uncaught errors: log critical, attempt graceful degradation
    - _Requirements: 15.6, 16.4, 6.5_

  - [ ]* 18.4 Write integration tests for end-to-end signal flow
    - Test full flow: mock WebSocket candle → FSM transition → pipeline → Telegram send + Dashboard broadcast + Log write
    - Verify Telegram delivery timing target (within 5 seconds)
    - Verify Dashboard WebSocket update (within 2 seconds)
    - Verify log persistence survives restart (write → restart → verify readable)
    - Verify 90-day retention cleanup removes old records
    - Verify multi-filter interaction (Time Gate + News + Circuit Breaker simultaneously)
    - _Requirements: 12.1, 13.4, 14.5_


- [x] 19. Final checkpoint - Full system verification
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at logical boundaries
- Property tests validate universal correctness properties using fast-check
- Unit tests validate specific examples and edge cases
- The system is SIGNAL-ONLY — no automatic trade placement is ever implemented
- Telegram Bot Token: <TELEGRAM_BOT_TOKEN>
- Telegram Chat ID: 7040023207
- All 25 correctness properties from the design document have corresponding test tasks
- TypeScript with strict mode is used throughout

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.4"] },
    { "id": 2, "tasks": ["1.3", "2.1"] },
    { "id": 3, "tasks": ["2.2", "3.1", "3.4"] },
    { "id": 4, "tasks": ["2.3", "2.4", "3.2", "3.3"] },
    { "id": 5, "tasks": ["4.1", "4.3", "5.1", "5.3", "5.5"] },
    { "id": 6, "tasks": ["4.2", "5.2", "5.4", "5.6", "5.7"] },
    { "id": 7, "tasks": ["6.1"] },
    { "id": 8, "tasks": ["6.2", "6.4", "6.5"] },
    { "id": 9, "tasks": ["6.3", "6.6", "6.7"] },
    { "id": 10, "tasks": ["6.8", "8.1"] },
    { "id": 11, "tasks": ["8.2", "9.1", "10.1", "11.1"] },
    { "id": 12, "tasks": ["8.3", "9.2", "10.2", "11.2", "12.1"] },
    { "id": 13, "tasks": ["12.2", "14.1", "15.1", "16.1"] },
    { "id": 14, "tasks": ["14.2", "15.2", "15.3", "16.2"] },
    { "id": 15, "tasks": ["18.1"] },
    { "id": 16, "tasks": ["18.2", "18.3"] },
    { "id": 17, "tasks": ["18.4"] }
  ]
}
```
