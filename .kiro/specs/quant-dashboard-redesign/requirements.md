# Requirements Document

## Introduction

Redesign the Isagi Engine Signal Bot's web dashboard to match a professional quant trading terminal aesthetic. The new dashboard features a dark theme with neon green/yellow accents, real-time updating performance statistics, a live XAU/USD candlestick chart, FSM pipeline visualization, signal performance tracking (simulated P&L), and a celebration pop-up when a signal's Take Profit level is hit in the market. The system remains signal-only — it does not execute trades — so all P&L metrics represent simulated performance based on whether generated signals would have been profitable.

## Glossary

- **Dashboard**: The single-page HTML/CSS/JS web application served by the Express.js backend that displays real-time engine data via WebSocket.
- **Signal_Performance_Tracker**: The client-side module that monitors live market price against open signals to calculate simulated P&L, win rate, and signal outcomes.
- **Pipeline_Visualizer**: The UI component that displays the current FSM state as a linear progress bar through the engine states (Suppressed → Scanning → Observation → Signal Evaluation).
- **Celebration_Overlay**: A full-screen animated pop-up that appears when a signal's Take Profit level is reached by the live market price.
- **Candlestick_Chart**: An interactive chart component rendering XAU/USD candle data with signal entry/exit markers overlaid.
- **Header_Bar**: The top navigation strip showing bot identity, instrument, mode indicator, and a live UTC clock.
- **Performance_Panel**: The UI section displaying cumulative signal metrics including simulated P&L, signal count, win rate, and average risk-to-reward ratio.
- **Filter_Status_Panel**: The UI section displaying the active/inactive state of each macro filter (Time Gate, News Decoupler, Circuit Breaker).
- **Kelly_Metrics_Panel**: The UI section displaying current Kelly Sizer output including risk amount, rolling drawdown, equity curve variance, and cold start status.
- **Simulated_PnL**: A calculated dollar value representing what the profit or loss would have been if a signal's entry and exit levels were traded, based on live market price reaching TP or SL.
- **WebSocket_Server**: The existing Express.js + ws server that pushes real-time state updates to connected dashboard clients.

## Requirements

### Requirement 1: Dark Quant Theme and Layout

**User Story:** As a trader, I want the dashboard to use a dark theme with neon green and yellow accents, so that it matches professional quant trading terminal aesthetics and reduces eye strain during extended monitoring sessions.

#### Acceptance Criteria

1. THE Dashboard SHALL use a primary background color of #000000 or near-black (#0a0a0a) with neon green (#00ff41) as the primary text and accent color.
2. THE Dashboard SHALL use bright yellow (#ffd700) for profit-related numbers and golden highlight elements.
3. THE Dashboard SHALL use a monospace terminal font (such as JetBrains Mono or Fira Code) for all numeric values and data displays.
4. THE Dashboard SHALL render all panel borders and separators using a dim green (#1a3a1a) or dark gray (#1c1c1c) color.
5. THE Dashboard SHALL organize content into a grid layout with a fixed Header_Bar at the top, a Performance_Panel below it, a main content area with the Candlestick_Chart and Pipeline_Visualizer, and a bottom status bar.

### Requirement 2: Header Bar with Live Clock

**User Story:** As a trader, I want a header bar showing the bot identity, trading instrument, and a live UTC clock, so that I always know the current context at a glance.

#### Acceptance Criteria

1. THE Header_Bar SHALL display the text "ISAGI • QUANT" as the bot identity on the left side.
2. THE Header_Bar SHALL display an "XAU/USD" instrument badge adjacent to the bot identity.
3. THE Header_Bar SHALL display the text "SIGNAL ONLY" as a mode indicator to clearly communicate the system does not execute trades.
4. THE Header_Bar SHALL display a live UTC clock formatted as HH:MM:SS that updates every second.
5. THE Header_Bar SHALL display a WebSocket connection status indicator using a colored dot (green for connected, red for disconnected).

### Requirement 3: Signal Performance Tracking

**User Story:** As a trader, I want to see cumulative signal performance metrics, so that I can evaluate the historical accuracy and profitability of generated signals.

#### Acceptance Criteria

1. THE Signal_Performance_Tracker SHALL calculate Simulated_PnL for each signal by comparing the signal entry price against the live market price when either the Take Profit or Stop Loss level is reached.
2. WHEN a signal's Take Profit level is reached by the live market price, THE Signal_Performance_Tracker SHALL record the signal as a win and add the profit amount to the cumulative Simulated_PnL.
3. WHEN a signal's Stop Loss level is reached by the live market price, THE Signal_Performance_Tracker SHALL record the signal as a loss and subtract the loss amount from the cumulative Simulated_PnL.
4. THE Performance_Panel SHALL display the following metrics: total signal count, win rate as a percentage, cumulative Simulated_PnL in dollars, and average risk-to-reward ratio.
5. THE Performance_Panel SHALL update all displayed metrics in real time as new signal outcomes are resolved.
6. THE Signal_Performance_Tracker SHALL persist signal outcomes to local browser storage so that metrics survive page refreshes.

### Requirement 4: Celebration Overlay on Take Profit Hit

**User Story:** As a trader, I want a visual celebration when a signal's Take Profit is hit, so that I receive immediate positive feedback on successful signals.

#### Acceptance Criteria

1. WHEN the Signal_Performance_Tracker records a signal win, THE Celebration_Overlay SHALL appear as a full-screen overlay displaying the profit amount in large yellow text with a golden sparkle particle animation.
2. THE Celebration_Overlay SHALL display the signal direction (LONG or SHORT), entry price, and Take Profit price that was hit.
3. THE Celebration_Overlay SHALL display for exactly 5 seconds before automatically fading out.
4. THE Celebration_Overlay SHALL include a close button allowing the user to dismiss it before the 5-second timer expires.
5. THE Celebration_Overlay SHALL not block the underlying dashboard from receiving real-time updates while displayed.

### Requirement 5: FSM Pipeline Visualization

**User Story:** As a trader, I want to see a visual representation of the engine's current state in the FSM pipeline, so that I understand where the engine is in its signal generation cycle.

#### Acceptance Criteria

1. THE Pipeline_Visualizer SHALL display the four FSM states (Suppressed, Scanning, Observation, Signal Evaluation) as a horizontal progress bar with labeled stages.
2. THE Pipeline_Visualizer SHALL highlight the current active state with a bright neon green indicator and dim inactive states with a muted gray color.
3. WHEN the WebSocket_Server broadcasts a state_change event, THE Pipeline_Visualizer SHALL transition the highlight to the new active state within 300 milliseconds.
4. THE Pipeline_Visualizer SHALL display connecting lines or arrows between stages to indicate the progression flow.
5. WHILE the engine is in the "suppressed" state, THE Pipeline_Visualizer SHALL display a "SUPPRESSED" label with a pulsing dim animation to indicate the engine is inactive.

### Requirement 6: Live XAU/USD Candlestick Chart

**User Story:** As a trader, I want a live candlestick chart of XAU/USD price data, so that I can visually correlate signals with price action.

#### Acceptance Criteria

1. THE Candlestick_Chart SHALL render M5 candlestick data for XAU/USD using green candles for bullish closes and red candles for bearish closes.
2. THE Candlestick_Chart SHALL display at least the most recent 50 candles on screen at once.
3. WHEN a new M5 candle closes, THE Candlestick_Chart SHALL append the new candle and scroll the view to show the most recent data.
4. WHEN a signal is generated, THE Candlestick_Chart SHALL overlay a marker at the signal entry price with a directional arrow (up for long, down for short).
5. THE Candlestick_Chart SHALL display horizontal lines for active signal Stop Loss (red dashed) and Take Profit (green dashed) levels.
6. THE Candlestick_Chart SHALL render with a transparent or near-black background consistent with the dark quant theme.

### Requirement 7: Kelly Metrics Display

**User Story:** As a trader, I want to see the current Kelly Sizer metrics, so that I understand the risk level being recommended for the next signal.

#### Acceptance Criteria

1. THE Kelly_Metrics_Panel SHALL display the current risk amount in dollars formatted to two decimal places.
2. THE Kelly_Metrics_Panel SHALL display the rolling drawdown as a percentage formatted to two decimal places.
3. THE Kelly_Metrics_Panel SHALL display the equity curve variance formatted to four decimal places.
4. THE Kelly_Metrics_Panel SHALL display a status indicator showing "COLD START" in yellow when fewer than 20 signals have been recorded, or "ACTIVE" in green otherwise.
5. WHEN the WebSocket_Server broadcasts a kelly_metrics event, THE Kelly_Metrics_Panel SHALL update all displayed values within 100 milliseconds.

### Requirement 8: Filter Status Indicators

**User Story:** As a trader, I want to see the current status of all macro filters at a glance, so that I know which filters are currently suppressing or allowing signal generation.

#### Acceptance Criteria

1. THE Filter_Status_Panel SHALL display the Time Gate filter with its active/inactive state and the configured trading window times.
2. THE Filter_Status_Panel SHALL display the News Decoupler filter with its clear/frozen state and the current news event name when a freeze is active.
3. THE Filter_Status_Panel SHALL display the Circuit Breaker filter with its active/inactive state and the expiration time when active.
4. THE Filter_Status_Panel SHALL use neon green badges for active/clear states and red badges for frozen/triggered states.
5. WHEN the WebSocket_Server broadcasts a filter_status event, THE Filter_Status_Panel SHALL update all filter indicators within 100 milliseconds.

### Requirement 9: Real-Time WebSocket Data Integration

**User Story:** As a trader, I want all dashboard components to update in real time without page refreshes, so that I always see the latest engine state.

#### Acceptance Criteria

1. THE Dashboard SHALL establish a WebSocket connection to the WebSocket_Server on page load and maintain it with automatic reconnection using exponential backoff starting at 1 second up to a maximum of 30 seconds.
2. WHEN the WebSocket connection is established, THE WebSocket_Server SHALL send a full state snapshot including current engine state, signal history, filter status, and Kelly metrics.
3. THE Dashboard SHALL process incoming WebSocket messages of types: snapshot, signal, state_change, filter_status, kelly_metrics, and candle_update.
4. IF the WebSocket connection is lost, THEN THE Dashboard SHALL display a disconnection banner with the timestamp of the last received update.
5. THE WebSocket_Server SHALL broadcast candle_update messages containing closed M5 candle data for the Candlestick_Chart.

### Requirement 10: Bottom Status Bar

**User Story:** As a trader, I want a persistent bottom bar showing key summary statistics, so that critical metrics remain visible regardless of scroll position.

#### Acceptance Criteria

1. THE Dashboard SHALL render a fixed-position bottom status bar visible at all times.
2. THE bottom status bar SHALL display the cumulative Simulated_PnL in yellow text.
3. THE bottom status bar SHALL display the total signal count.
4. THE bottom status bar SHALL display the current Kelly risk amount per signal.
5. THE bottom status bar SHALL display the current connection latency in milliseconds (time between server timestamp and client receive time).

### Requirement 11: Signal Log Table

**User Story:** As a trader, I want to see a scrollable table of all generated signals with their details, so that I can review signal history and outcomes.

#### Acceptance Criteria

1. THE Dashboard SHALL display a signal log table showing the most recent 100 signals in reverse-chronological order.
2. THE signal log table SHALL include columns for: timestamp, direction, entry price, stop loss, take profit 1, take profit 2, zone classification, risk amount, and outcome (pending/win/loss).
3. THE signal log table SHALL highlight winning signals with a green row accent and losing signals with a red row accent.
4. WHEN a new signal is received via WebSocket, THE signal log table SHALL prepend it to the top of the table with a brief fade-in animation.
5. THE signal log table SHALL use monospace font for all price values to maintain column alignment.

### Requirement 12: Responsive Candle Data Delivery

**User Story:** As a developer, I want the backend to deliver M5 candle data to the dashboard via WebSocket, so that the candlestick chart can render live price action.

#### Acceptance Criteria

1. THE WebSocket_Server SHALL broadcast a candle_update message each time an M5 candle closes, containing the open, high, low, close, volume, and timestamp fields.
2. THE WebSocket_Server SHALL include the most recent 100 closed M5 candles in the initial snapshot payload sent to new WebSocket clients.
3. THE candle_update message payload SHALL conform to the existing Candle type interface (open, high, low, close, volume, timestamp, timeframe).
4. IF the candle data feed is interrupted, THEN THE WebSocket_Server SHALL include a gap indicator in the next candle_update message so the Candlestick_Chart can display a visual break.
