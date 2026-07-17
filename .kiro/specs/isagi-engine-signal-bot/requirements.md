# Requirements Document

## Introduction

The Isagi Engine Signal Bot is a signal-only analysis engine for XAU/USD (Gold) trading. The system observes price action on higher timeframes, identifies liquidity zones, monitors M5 candle structures, and generates buy/sell signals with precise entry, stop-loss, and take-profit levels. Signals are displayed on a dashboard and delivered via Telegram notifications. The bot performs NO automatic trade execution — all trades are placed manually by the user based on the generated signals.

## Glossary

- **Signal_Engine**: The core analysis system that processes price data, applies protocol rules, and generates trading signals for XAU/USD.
- **Observation_Phase**: A mandatory inactive monitoring state where the Signal_Engine watches M5 candle behavior within a higher-timeframe liquidity zone before any signal can be generated.
- **Liquidity_Zone**: A higher-timeframe (H1/M15) structural high or low area where significant order absorption is expected.
- **Rejection_Candle**: A candlestick pattern (shooting star, hammer, engulfing) that signals price rejection at a retracement culmination point.
- **Expansion_Candle**: A full-bodied candle that breaks past local structural levels, indicating directional momentum.
- **Macro_Filter_Module**: The subsystem that applies five gatekeeping filters (time, news, sizing, volume, black swan) to suppress or modify signals.
- **Signal_Output_Formatter**: The subsystem that formats validated signals into structured output including entry, SL, TP, position split, and reasoning.
- **Telegram_Notifier**: The subsystem that delivers formatted signal messages to a configured Telegram chat.
- **Dashboard**: The web-based interface that displays current engine state, generated signals, and historical signal log.
- **Time_Gate**: The operational window filter restricting signal generation to 12:00–17:00 UTC.
- **News_Decoupler**: The filter that suppresses signals within 2 minutes before to 15 minutes after high-impact USD economic releases.
- **Kelly_Sizer**: The dynamic fractional Kelly sizing calculator that adjusts risk between $17.50 and $70 based on equity curve variance.
- **Volume_Filter**: The filter that rejects signals where M5 volume is below the 20-period simple moving average.
- **Circuit_Breaker**: The safety module that flags extreme adverse price movement (300+ pips on 1-min candle) as a circuit-breaker signal.
- **Slippage_Simulator**: The module that injects random 0.5–2.5 pip negative slippage on 20% of signals for simulation realism.
- **R_Unit**: The distance between the entry price and the invalidation (stop-loss) level, used as the base unit for target projection.
- **Chop_Zone**: A market condition identified by compressing volume where reduced targets (1.5R–2.0R) are applied.
- **Expansion_Zone**: A market condition identified by expanding volume where extended targets (3.0R) are applied.

## Requirements

### Requirement 1: Observation Phase Activation

**User Story:** As a trader, I want the engine to enter an observation state when price reaches a key liquidity zone, so that signals are only generated after proper structural confirmation.

#### Acceptance Criteria

1. WHEN the M5 candle close price enters a higher-timeframe (H1/M15) Liquidity_Zone boundary, THE Signal_Engine SHALL transition to Observation_Phase and begin monitoring the M5 chart.
2. WHILE in Observation_Phase, THE Signal_Engine SHALL monitor a minimum of 3 and a maximum of 6 full M5 candles, evaluating whether M5 volume remains below the 20-period simple moving average (indicating order absorption) and whether price range compresses relative to the preceding expansion candles.
3. WHILE in Observation_Phase, THE Signal_Engine SHALL suppress all signal generation until a Rejection_Candle pattern (as defined in the Glossary) forms within the Liquidity_Zone on the M5 chart.
4. IF an M5 candle closes beyond the far boundary of the Liquidity_Zone by 1 or more pips without a preceding Rejection_Candle during Observation_Phase, THEN THE Signal_Engine SHALL cancel the observation and return to scanning state.
5. WHEN a Rejection_Candle (shooting star, hammer, or engulfing pattern per Glossary definition) forms within the Liquidity_Zone during Observation_Phase, THE Signal_Engine SHALL transition to signal evaluation state.
6. IF 6 full M5 candles complete during Observation_Phase without either a Rejection_Candle or a breakthrough beyond the zone boundary, THEN THE Signal_Engine SHALL cancel the observation, log a timeout reason, and return to scanning state.

### Requirement 2: Short Signal Candle Structure Detection

**User Story:** As a trader, I want the engine to identify valid short signal setups on the M5 chart, so that I receive accurate bearish entry signals.

#### Acceptance Criteria

1. WHEN Observation_Phase completes with confirmed reaction, THE Signal_Engine SHALL scan for a minimum of 2 consecutive bearish Expansion_Candles where each candle's body comprises at least 60% of its total high-to-low range, and each candle closes below the prior local minor structural low identified within the preceding 20 M5 candles.
2. WHEN bearish expansion is confirmed, THE Signal_Engine SHALL monitor for a corrective retracement of 2–4 M5 candles where each retracement candle's volume is below the average per-candle volume of the expansion candles, and each retracement candle's body size is smaller than the average body size of the expansion candles, retracing back toward the breakdown zone or the 9-period and 21-period EMAs.
3. WHEN a retracement of 2–4 candles completes, THE Signal_Engine SHALL require an explicit bearish Rejection_Candle — defined as a shooting star (top wick ≥ 50% of total candle range with body in the lower third), or a bearish engulfing candle (body fully engulfs prior candle's body) — forming at the retracement high point.
4. IF the retracement exceeds 4 M5 candles without a Rejection_Candle, THEN THE Signal_Engine SHALL invalidate the short setup and return to scanning state.
5. IF the average per-candle volume during retracement exceeds the average per-candle volume during expansion, THEN THE Signal_Engine SHALL invalidate the short setup and return to scanning state.

### Requirement 3: Long Signal Candle Structure Detection

**User Story:** As a trader, I want the engine to identify valid long signal setups on the M5 chart, so that I receive accurate bullish entry signals.

#### Acceptance Criteria

1. WHEN Observation_Phase completes with confirmed reaction, THE Signal_Engine SHALL scan for a minimum of 2 consecutive bullish Expansion_Candles where each candle's body (absolute difference between open and close) is at least 60% of the total candle range (high minus low) and each candle's close breaks above the highest high of the preceding 10 M5 candles.
2. WHEN bullish expansion is confirmed, THE Signal_Engine SHALL monitor for a corrective retracement of 2–4 M5 candles where each retracement candle's volume is below the average volume of the expansion candles and each retracement candle's range (high minus low) is smaller than the average range of the expansion candles, pulling price back toward the breakout zone or dynamic EMAs.
3. WHEN a retracement of 2–4 candles completes, THE Signal_Engine SHALL require an explicit bullish Rejection_Candle (hammer with bottom wick at least 2 times the candle body length, or bullish engulfing pattern) at the retracement low point.
4. IF the retracement exceeds 4 M5 candles without a Rejection_Candle, THEN THE Signal_Engine SHALL invalidate the long setup and return to scanning state.
5. IF the average volume of the retracement candles exceeds the average volume of the expansion candles, THEN THE Signal_Engine SHALL invalidate the long setup and return to scanning state.
6. WHEN a valid long setup is identified, THE Signal_Engine SHALL record the expansion candle count, retracement candle count, Rejection_Candle type, and breakout level as structural context for signal generation.

### Requirement 4: Entry Signal Generation

**User Story:** As a trader, I want entry signals to fire only when the validation candle closes within the structural window, so that I receive precise, actionable entry points.

#### Acceptance Criteria

1. WHEN a Rejection_Candle that satisfies the candle structure detection criteria (Requirement 2 or 3) closes at or within the structural window bounded by the breakdown/breakout zone and the dynamic EMA levels, THE Signal_Engine SHALL generate an entry signal at the close price of that candle upon the M5 candle close.
2. IF the Rejection_Candle close price is beyond the structural window (above the upper EMA boundary for shorts or below the lower zone boundary for longs), THEN THE Signal_Engine SHALL discard the setup and log the rejection reason including the candle close price and the structural window boundaries.
3. THE Signal_Engine SHALL record for each generated signal: timestamp (UTC), entry price, signal direction (long or short), originating Liquidity_Zone level, the structural window upper and lower boundaries, and the Rejection_Candle pattern type.
4. IF a Rejection_Candle closes exactly on the structural window boundary, THEN THE Signal_Engine SHALL treat the candle as within the structural window and generate the entry signal.
5. WHILE the Signal_Engine is evaluating a Rejection_Candle for entry signal generation, THE Signal_Engine SHALL wait until the M5 candle fully closes before making the within/outside determination and SHALL NOT generate signals on incomplete candles.

### Requirement 5: Stop Loss and Target Mapping

**User Story:** As a trader, I want precise stop-loss and take-profit levels with each signal, so that I can manage risk and reward accurately.

#### Acceptance Criteria

1. WHEN a short signal is generated, THE Signal_Engine SHALL set the stop-loss 1–2 pips beyond the highest wick cluster (3 or more candle wicks within a 1-pip vertical range) of the swing high identified during the preceding observation and expansion structure, within a lookback of 20 M5 candles from the entry candle.
2. WHEN a long signal is generated, THE Signal_Engine SHALL set the stop-loss 1–2 pips beyond the lowest wick cluster (3 or more candle wicks within a 1-pip vertical range) of the swing low identified during the preceding observation and expansion structure, within a lookback of 20 M5 candles from the entry candle.
3. THE Signal_Engine SHALL calculate the R_Unit as the absolute distance in pips between entry price and stop-loss level.
4. WHEN a signal is generated, THE Signal_Engine SHALL project a final target into the nearest open liquidity pocket (a price zone of at least 5 pips width with no volume block exceeding 150% of the 20-period average volume) in the signal direction.
5. IF a volume block exceeding 150% of the 20-period average M5 volume exists between entry and the projected target, THEN THE Signal_Engine SHALL adjust the target to the nearest open liquidity pocket before that volume block.
6. IF the projected final target after adjustment yields less than 1.5R distance from entry, THEN THE Signal_Engine SHALL invalidate the signal and log the rejection reason as insufficient reward-to-risk.
7. WHEN setting stop-loss within the 1–2 pip buffer range, THE Signal_Engine SHALL select 1 pip beyond the wick cluster for Chop_Zone conditions and 2 pips beyond the wick cluster for Expansion_Zone conditions.

### Requirement 6: Time Gate Filter

**User Story:** As a trader, I want signal generation restricted to the optimal trading window, so that signals only fire during high-liquidity market hours.

#### Acceptance Criteria

1. THE Signal_Engine SHALL only generate signals within the 12:00:00 to 16:59:59 UTC operational window (inclusive of both boundaries), treating 17:00:00 UTC as outside the window.
2. WHILE current UTC time is outside the 12:00:00–16:59:59 window, THE Signal_Engine SHALL suppress all signal generation and log the suppression reason.
3. WHEN the Time_Gate activates at 12:00:00 UTC, THE Signal_Engine SHALL transition from suppressed state to active scanning state.
4. WHEN the Time_Gate deactivates at 17:00:00 UTC, THE Signal_Engine SHALL cancel any in-progress observation phases or signal evaluation states and transition to suppressed state.
5. WHEN the Signal_Engine starts or restarts, THE Signal_Engine SHALL check the current UTC time and initialize into active scanning state if within the 12:00:00–16:59:59 window, or into suppressed state if outside the window.
6. IF an M5 candle is still forming when the Time_Gate deactivates at 17:00:00 UTC, THEN THE Signal_Engine SHALL discard the incomplete candle from signal evaluation and not generate a signal from it.

### Requirement 7: News Decoupler Filter

**User Story:** As a trader, I want signals suppressed around high-impact news events, so that I avoid entering during extreme volatility caused by economic releases.

#### Acceptance Criteria

1. WHEN a high-impact USD economic release (CPI, NFP, FOMC, GDP, PPI) is scheduled, THE News_Decoupler SHALL activate a 17-minute freeze window starting 2 minutes before the scheduled release time.
2. WHILE the News_Decoupler freeze window is active, THE Signal_Engine SHALL suppress all signal generation.
3. WHEN the 15-minute post-release period expires, THE News_Decoupler SHALL deactivate the freeze window and allow signal generation to resume.
4. IF a signal setup is in progress (Observation_Phase or signal evaluation state) when the freeze window activates, THEN THE Signal_Engine SHALL cancel the setup, discard any partial analysis, and log the cancellation reason including the triggering news event name and scheduled time.
5. IF the news schedule data source is unavailable or returns an error, THEN THE News_Decoupler SHALL log a warning and continue operating without freeze window activation until the schedule source becomes available again.
6. IF multiple high-impact USD releases are scheduled within 17 minutes of each other, THEN THE News_Decoupler SHALL merge the overlapping freeze windows into a single continuous freeze window spanning from 2 minutes before the earliest release to 15 minutes after the latest release.
7. WHEN the News_Decoupler activates or deactivates a freeze window, THE News_Decoupler SHALL log the event name, scheduled release time, freeze window start time, and freeze window end time.

### Requirement 8: Dynamic Fractional Kelly Position Sizing

**User Story:** As a trader, I want risk to scale dynamically based on performance, so that position sizing adapts to my equity curve health.

#### Acceptance Criteria

1. THE Kelly_Sizer SHALL calculate risk per signal between a floor of $17.50 (0.35% equity risk) and a ceiling of $70.00 (1.4% equity risk) based on a $5,000 equity baseline.
2. THE Kelly_Sizer SHALL compute rolling drawdown as the peak-to-trough decline in cumulative signal P&L over the most recent 20 signals.
3. THE Kelly_Sizer SHALL compute equity curve variance as the standard deviation of per-signal returns over the most recent 20 signals.
4. IF rolling drawdown exceeds 5% of equity, THEN THE Kelly_Sizer SHALL reduce risk linearly from the current level toward the $17.50 floor, reaching the floor at 10% drawdown.
5. IF equity curve variance exceeds 1.5× the 20-signal historical average variance, THEN THE Kelly_Sizer SHALL reduce risk by 25% from the current calculated level, subject to the $17.50 floor.
6. IF rolling drawdown is at or below 2% of equity AND equity curve variance is at or below 1.0× the 20-signal historical average variance, THEN THE Kelly_Sizer SHALL allow risk up to the $70.00 ceiling.
7. IF fewer than 20 signals exist in history (cold-start condition), THEN THE Kelly_Sizer SHALL default risk to $35.00 (0.7% equity risk) until 20 signals are accumulated.
8. THE Signal_Output_Formatter SHALL include the calculated risk amount in each signal output.
9. WHEN a new signal is generated, THE Kelly_Sizer SHALL recalculate the risk amount using the most recent 20-signal window before the Signal_Output_Formatter formats the output.

### Requirement 9: Volume Filter and Adaptive Target Switch

**User Story:** As a trader, I want the engine to reject signals in low-volume conditions and adapt targets based on volume profile, so that I only receive signals with adequate market participation.

#### Acceptance Criteria

1. WHEN the current M5 candle's volume is below the 20-period simple moving average of the prior 20 closed M5 candle volumes, THE Volume_Filter SHALL reject the signal and log the rejection reason.
2. WHEN M5 volume is above the 20-period SMA and at least 3 of the last 5 closed M5 candles show sequentially increasing volume, THE Signal_Engine SHALL classify the market as Expansion_Zone and set target at 3.0R with partial profit at 35% of the total distance to final TP.
3. WHEN M5 volume is above the 20-period SMA and at least 3 of the last 5 closed M5 candles show sequentially decreasing volume, THE Signal_Engine SHALL classify the market as Chop_Zone and set target at 1.5R with full exit at target.
4. IF M5 volume is above the 20-period SMA but neither the Expansion_Zone nor Chop_Zone trend condition is met, THEN THE Signal_Engine SHALL default to Chop_Zone classification and set target at 2.0R with full exit at target.
5. THE Signal_Output_Formatter SHALL include the zone classification (Expansion_Zone or Chop_Zone) in each signal output.

### Requirement 10: Black Swan and Slippage Degradation Module

**User Story:** As a trader, I want the simulation to account for slippage and extreme market events, so that signal performance metrics are realistic.

#### Acceptance Criteria

1. THE Slippage_Simulator SHALL inject random negative slippage of 0.5–2.5 pips (uniform distribution within range) on 20% of generated signals, applying the slippage to the entry price only.
2. THE Slippage_Simulator SHALL select the 20% of signals randomly with uniform distribution.
3. WHEN a 1-minute candle expands 300 or more pips against the most recently generated signal's direction, THE Circuit_Breaker SHALL generate a circuit-breaker alert signal.
4. THE Circuit_Breaker alert SHALL include the adverse movement magnitude, the affected signal's identifier, and timestamp.
5. WHEN a circuit-breaker alert is generated, THE Signal_Engine SHALL suppress new signal generation for 15 minutes following the alert timestamp.
6. THE Signal_Output_Formatter SHALL indicate when slippage has been applied to a signal, including the original entry price, the slippage amount in pips, and the adjusted entry price.

### Requirement 11: Split Position Signal Output

**User Story:** As a trader, I want each signal to include split position details, so that I can manage partial profits and runners effectively.

#### Acceptance Criteria

1. THE Signal_Output_Formatter SHALL split each signal into two tickets: Ticket 1 (Safety Lock) at 45% of position size and Ticket 2 (Runner) at 55% of position size.
2. THE Signal_Output_Formatter SHALL set Ticket 1 TP at 35% of the distance between the entry price and the Ticket 2 TP level.
3. IF the market is classified as Expansion_Zone, THEN THE Signal_Output_Formatter SHALL set Ticket 2 TP at the 3.0R target.
4. IF the market is classified as Chop_Zone, THEN THE Signal_Output_Formatter SHALL set Ticket 2 TP at 1.5R, unless the distance to the next open liquidity pocket is greater than 1.5R, in which case the TP SHALL be set at 2.0R.
5. WHEN Ticket 1 TP is reached (price touches or crosses the Ticket 1 TP level), THE Signal_Output_Formatter SHALL include a breakeven shift instruction specifying that the stop-loss for Ticket 2 moves to the entry price.
6. THE Signal_Output_Formatter SHALL include trailing stop guidance for Ticket 2 specifying the most recent M5 structural swing point (swing high for short signals, swing low for long signals) as the recommended trailing stop level after breakeven is activated.
7. THE Signal_Output_Formatter SHALL include both tickets' entry price, stop-loss level, take-profit level, position size percentage, and the breakeven trigger condition in the signal output.

### Requirement 12: Telegram Signal Delivery

**User Story:** As a trader, I want signals delivered to my Telegram chat, so that I receive immediate notification of new trading opportunities.

#### Acceptance Criteria

1. WHEN the Signal_Engine generates a validated signal, THE Telegram_Notifier SHALL send the message to the configured Telegram chat within 5 seconds of signal generation.
2. THE Telegram_Notifier SHALL include in each message: signal direction, entry price, stop-loss level, TP1 level, TP2 level, position split details (Ticket 1 and Ticket 2 sizes and targets), zone classification (Expansion_Zone or Chop_Zone), risk amount, and reasoning summary limited to a maximum of 280 characters.
3. IF the Telegram message delivery fails, THEN THE Telegram_Notifier SHALL retry delivery up to 3 times with exponential backoff starting at a 2-second base interval (2s, 4s, 8s).
4. IF all 3 retries fail, THEN THE Telegram_Notifier SHALL log the delivery failure and the full signal content for manual review.
5. THE Telegram_Notifier SHALL deliver signal-only information and SHALL NOT include any trade execution commands or automated order placement instructions.
6. IF the Telegram chat is not configured or any required signal field (direction, entry price, stop-loss, TP1, TP2, zone classification, risk amount) is unavailable, THEN THE Telegram_Notifier SHALL suppress message delivery and log an error indicating the missing configuration or field.

### Requirement 13: Dashboard Signal Display

**User Story:** As a trader, I want a dashboard showing the engine state and signal history, so that I can monitor the system and review past signals.

#### Acceptance Criteria

1. THE Dashboard SHALL display the current Signal_Engine state (scanning, observation, signal evaluation, suppressed).
2. THE Dashboard SHALL display generated signals in a reverse-chronological log (newest first) with entry price, direction, SL, TP1, TP2, zone classification, risk amount, and timestamp, retaining at minimum the most recent 100 signals.
3. THE Dashboard SHALL display active Macro_Filter_Module status (Time_Gate active/inactive, News_Decoupler freeze active/inactive, current volume classification).
4. WHEN a new signal is generated, THE Dashboard SHALL update within 2 seconds to display the new signal.
5. THE Dashboard SHALL display the current Kelly_Sizer risk level, rolling drawdown percentage, and equity curve variance.
6. IF the Dashboard loses connection to the Signal_Engine data source, THEN THE Dashboard SHALL display a visible disconnection indicator and the timestamp of the last successful data update.
7. WHEN the Dashboard connection to the Signal_Engine data source is restored, THE Dashboard SHALL remove the disconnection indicator and resume live updates within 5 seconds.

### Requirement 14: Signal Logging

**User Story:** As a trader, I want all signals and engine decisions logged persistently, so that I can review historical performance and engine behavior.

#### Acceptance Criteria

1. THE Signal_Engine SHALL log every generated signal with full details (entry, SL, TP, direction, zone, risk, timestamp, reasoning).
2. THE Signal_Engine SHALL log every rejected setup with the rejection reason, filter that triggered rejection, and timestamp.
3. THE Signal_Engine SHALL log every state transition (scanning, observation, evaluation, suppressed) with an ISO 8601 UTC timestamp with millisecond precision, the event or condition name that caused the transition, and the previous state.
4. THE Signal_Engine SHALL log every Macro_Filter_Module activation and deactivation with filter name, ISO 8601 UTC timestamp with millisecond precision, and duration in seconds.
5. THE Signal_Engine SHALL persist all logs to durable storage that survives application restart and SHALL retain all log entries for a minimum of 90 days.
6. IF a log write to durable storage fails, THEN THE Signal_Engine SHALL retry the write up to 3 times, and if all retries fail, SHALL buffer the log entry in memory and emit a warning indicating the storage write failure.
7. THE Signal_Engine SHALL record all log timestamps in ISO 8601 UTC format with millisecond precision, and SHALL store log entries in chronological order.

### Requirement 15: Signal-Only Constraint

**User Story:** As a trader, I want the system to be strictly signal-only with no trade execution capability, so that I maintain full manual control over all trade placement.

#### Acceptance Criteria

1. THE Signal_Engine SHALL NOT place, modify, or close any trades on any trading platform or broker API.
2. THE Signal_Engine SHALL NOT make any API calls to broker endpoints that submit, amend, or cancel orders.
3. THE Signal_Engine SHALL only read price data from market data feeds and SHALL NOT write any trading instructions to external systems, and no subsystem (including the Dashboard and Telegram_Notifier) SHALL send outbound requests to any trading or brokerage endpoint.
4. THE Telegram_Notifier SHALL deliver informational signals only and SHALL NOT trigger any automated order execution.
5. IF any component attempts to invoke a trade execution function, THEN THE Signal_Engine SHALL block the invocation and log a critical error including the component name, the attempted operation, and the timestamp of the blocked attempt.
6. WHEN the Signal_Engine starts, THE Signal_Engine SHALL verify that no broker API credentials with write permissions are configured and that no trade execution endpoints are registered, and SHALL refuse to start if any are detected.
7. THE Signal_Engine SHALL NOT store or accept configuration for broker authentication tokens, trading account credentials, or order submission endpoints.

### Requirement 16: XAU/USD Instrument Restriction

**User Story:** As a trader, I want the engine to operate exclusively on XAU/USD, so that all analysis and signals are focused on a single instrument.

#### Acceptance Criteria

1. THE Signal_Engine SHALL process price data exclusively for the XAU/USD (Gold vs US Dollar) instrument and SHALL reject price data for any other instrument.
2. IF price data for an instrument other than XAU/USD is received, THEN THE Signal_Engine SHALL discard the data and log a warning that includes the rejected instrument identifier, the timestamp of receipt, and the data source origin.
3. THE Signal_Engine SHALL label all signals, logs, and dashboard displays with the XAU/USD instrument identifier.
4. WHEN the Signal_Engine starts up, IF the configured data source does not provide XAU/USD price data, THEN THE Signal_Engine SHALL log a critical error and remain in suppressed state until a valid XAU/USD data source is available.
