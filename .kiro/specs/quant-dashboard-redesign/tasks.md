# Implementation Plan: Quant Dashboard Redesign

## Overview

Transform the existing Isagi Engine dashboard into a professional quant trading terminal with dark theme, live candlestick chart, FSM pipeline visualization, signal performance tracking with simulated P&L, and celebration overlay. The implementation modifies two existing files: `src/output/dashboard-server.ts` (backend candle broadcast) and `src/output/dashboard/index.html` (complete frontend rebuild).

## Tasks

- [ ] 1. Backend: Add candle_update broadcast and snapshot enhancement
  - [ ] 1.1 Add candle_update message type and candle buffer to DashboardServer
    - Add `'candle_update'` to the `WsMessageType` union in `src/output/dashboard-server.ts`
    - Add `CandleUpdatePayload` interface with `candle: Candle` and `hasGap: boolean` fields
    - Add `candles: Candle[]` field to the `DashboardSnapshot` interface
    - Add a private `candleHistory: Candle[]` ring buffer (max 100) to `DashboardServerImpl`
    - Implement `broadcastCandleUpdate(candle: Candle, hasGap?: boolean): void` method that appends to the ring buffer (evicting oldest if >100) and broadcasts to all clients
    - Update `buildSnapshot()` to include the candle history array
    - Update the `DashboardServer` interface to expose `broadcastCandleUpdate`
    - _Requirements: 9.2, 9.3, 12.1, 12.2, 12.3, 12.4_

  - [ ] 1.2 Wire candle.close event to dashboard broadcast in main.ts
    - In `src/main.ts`, add a subscription to `eventBus` for `candle.close` events where `candle.timeframe === 'M5'`
    - Call `dashboard.broadcastCandleUpdate(candle)` for each M5 candle close
    - _Requirements: 12.1, 9.5_

  - [ ]* 1.3 Write unit tests for candle buffer and broadcast
    - Test that candle buffer never exceeds 100 entries
    - Test that snapshot includes candle history
    - Test that `broadcastCandleUpdate` sends correct message format to connected clients
    - Test gap indicator is included when `hasGap: true`
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

- [ ] 2. Checkpoint - Backend changes complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 3. Frontend: Dark quant theme, layout structure, and header bar
  - [ ] 3.1 Rebuild index.html with CSS custom properties, grid layout, and header bar
    - Replace entire `src/output/dashboard/index.html` with the new quant terminal layout
    - Implement CSS custom properties for the dark theme (`--bg-primary: #0a0a0a`, `--neon-green: #00ff41`, `--gold-yellow: #ffd700`, etc.)
    - Use monospace terminal font (JetBrains Mono via Google Fonts CDN, fallback to Fira Code/SF Mono)
    - Implement the CSS Grid layout with areas: header, perf, chart, pipe, side, log, status
    - Implement the Header_Bar with "ISAGI • QUANT" identity, "XAU/USD" instrument badge, "SIGNAL ONLY" mode indicator, live UTC clock (updates every 1s via `setInterval`), and WebSocket connection status dot (green/red)
    - Add dim green borders (`#1a3a1a`) for all panels
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5_

- [ ] 4. Frontend: Performance panel and signal performance tracker
  - [ ] 4.1 Implement the Signal Performance Tracker module and Performance Panel UI
    - Create the `SignalPerformanceTracker` as a JS module (IIFE) inside `index.html`
    - Implement P&L calculation: LONG win = (TP - entry), LONG loss = -(entry - SL), SHORT win = (entry - TP), SHORT loss = -(SL - entry)
    - Track open signals, monitor each `candle_update` close price against TP1 and SL levels
    - Record outcomes (win/loss) and update cumulative metrics (total signals, win rate, cumulative P&L, avg R:R)
    - Persist signal outcomes and metrics to `localStorage` under keys `isagi_signal_outcomes` and `isagi_performance_metrics`
    - Render the Performance_Panel UI showing: total signal count, win rate %, cumulative P&L (yellow), and avg R:R
    - Update panel in real-time as outcomes resolve
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [ ]* 4.2 Write property test for P&L calculation correctness
    - **Property 1: Simulated P&L calculation correctness**
    - **Validates: Requirements 3.1, 3.2, 3.3**

  - [ ]* 4.3 Write property test for performance metrics aggregation
    - **Property 2: Performance metrics aggregation consistency**
    - **Validates: Requirements 3.4, 3.5**

  - [ ]* 4.4 Write property test for localStorage round-trip persistence
    - **Property 3: Signal outcome persistence round-trip**
    - **Validates: Requirements 3.6**

- [ ] 5. Frontend: Celebration overlay
  - [ ] 5.1 Implement the Celebration Overlay with CSS animations and Canvas particles
    - Create the Celebration_Overlay as a hidden full-screen overlay in the HTML
    - Show overlay when `SignalPerformanceTracker` records a win (TP hit)
    - Display profit amount in large yellow text, signal direction (LONG/SHORT), entry price, and TP price
    - Implement golden sparkle particle animation using Canvas 2D API (random velocity, gravity, gold/yellow circles)
    - Auto-dismiss after exactly 5 seconds with CSS fade-out transition
    - Include a close button (X) for manual dismissal before 5s
    - Queue celebrations if multiple TPs hit simultaneously (show one at a time)
    - Ensure overlay does not block WebSocket message processing (non-blocking overlay)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [ ] 6. Frontend: FSM Pipeline Visualizer
  - [ ] 6.1 Implement the Pipeline Visualizer component
    - Render four FSM states (Suppressed, Scanning, Observation, Signal Evaluation) as a horizontal progress bar with labeled stages
    - Highlight current active state with bright neon green; dim inactive states with muted gray
    - Draw connecting arrows/lines between stages to indicate progression flow
    - On `state_change` WebSocket message, transition highlight to new state within 300ms using CSS transitions
    - When in "suppressed" state, display pulsing dim animation on the SUPPRESSED label
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [ ] 7. Frontend: Live XAU/USD Candlestick Chart
  - [ ] 7.1 Implement the Candlestick Chart using TradingView lightweight-charts
    - Include `lightweight-charts` from CDN (`https://unpkg.com/lightweight-charts/dist/lightweight-charts.standalone.production.js`)
    - Initialize chart with dark theme config (background `#0a0a0a`, text color `#00ff41`, grid lines `#1a3a1a`)
    - Add candlestick series with green up-candles (`#00ff41`) and red down-candles (`#ff4444`)
    - On snapshot, load initial candle history (up to 100 M5 candles)
    - On `candle_update` message, append new candle and scroll view to latest
    - On new signal, add marker at entry price with directional arrow (up for long, down for short)
    - Display horizontal price lines for active signals: red dashed for SL, green dashed for TP
    - Remove price lines when signal outcome is resolved (TP or SL hit)
    - Ensure at least 50 candles visible on screen at once
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

- [ ] 8. Checkpoint - Core UI components complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Frontend: Kelly Metrics, Filter Status, and Signal Log panels
  - [ ] 9.1 Implement the Kelly Metrics Panel
    - Display risk amount ($XX.XX), rolling drawdown (XX.XX%), equity curve variance (X.XXXX)
    - Display "COLD START" in yellow when `isColdStart === true`, "ACTIVE" in green otherwise
    - Update all values within 100ms on `kelly_metrics` WebSocket message
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [ ] 9.2 Implement the Filter Status Panel
    - Display Time Gate with active/inactive state and configured trading window times
    - Display News Decoupler with clear/frozen state and current news event name when frozen
    - Display Circuit Breaker with active/inactive state and expiration time when active
    - Use neon green badges for active/clear, red badges for frozen/triggered
    - Update within 100ms on `filter_status` WebSocket message
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [ ] 9.3 Implement the Signal Log Table
    - Render scrollable table with most recent 100 signals in reverse-chronological order
    - Columns: timestamp, direction, entry, SL, TP1, TP2, zone, risk, outcome (pending/win/loss)
    - Highlight winning signals with green row accent, losing with red row accent
    - Prepend new signals with fade-in animation on `signal` WebSocket message
    - Use monospace font for all price values
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

  - [ ]* 9.4 Write property test for signal log ordering invariant
    - **Property 5: Signal log ordering invariant**
    - **Validates: Requirements 11.1, 11.4**

- [ ] 10. Frontend: WebSocket client, reconnection, and bottom status bar
  - [ ] 10.1 Implement WebSocket client with reconnection and message routing
    - Establish WebSocket connection on page load with automatic reconnection
    - Implement exponential backoff: starting at 1s, doubling on each failure, max 30s
    - Reset backoff to 1s on successful connection
    - Process message types: `snapshot`, `signal`, `state_change`, `filter_status`, `kelly_metrics`, `candle_update`
    - Route each message to the appropriate UI component for update
    - On snapshot, initialize all panels (engine state, signals, filters, kelly, candles)
    - Show disconnection banner with last update timestamp when connection is lost
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [ ] 10.2 Implement the fixed bottom Status Bar
    - Render fixed-position bar at viewport bottom, always visible
    - Display cumulative Simulated_PnL in yellow text (from Signal Performance Tracker)
    - Display total signal count
    - Display current Kelly risk amount per signal
    - Display connection latency in ms (difference between server `timestamp` field and client receive time)
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

  - [ ]* 10.3 Write property test for WebSocket reconnection backoff bounds
    - **Property 4: WebSocket reconnection backoff bounds**
    - **Validates: Requirements 9.1**

  - [ ]* 10.4 Write property test for candle buffer size and validity
    - **Property 6: Candle buffer size and validity invariant**
    - **Validates: Requirements 12.2, 12.3**

- [ ] 11. Final checkpoint - Full integration verification
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The frontend is a single HTML file with no build step — all JS/CSS is inline
- TradingView lightweight-charts is loaded from CDN (no npm install needed for frontend)
- Backend changes are minimal: only `dashboard-server.ts` and `main.ts` are modified
- All P&L tracking is simulated (signal-only system, no trade execution)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["3.1"] },
    { "id": 3, "tasks": ["4.1", "6.1", "7.1"] },
    { "id": 4, "tasks": ["4.2", "4.3", "4.4", "5.1", "9.1", "9.2", "9.3"] },
    { "id": 5, "tasks": ["9.4", "10.1", "10.2"] },
    { "id": 6, "tasks": ["10.3", "10.4"] }
  ]
}
```
