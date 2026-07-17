# Tasks: Trading Dashboard Terminal

## Task 1: Implement Complete HTML Dashboard Structure

### Description
Create the complete single-file HTML dashboard with all inline CSS and JavaScript. This is the primary deliverable that replaces `/projects/sandbox/newxau/src/output/dashboard/index.html`.

### Requirements
- ✅ Header bar with bot identity, badges, clock, connection status
- ✅ Large P&L display (top-left, 48px gold font)
- ✅ Metrics grid (6 items, 2 columns, top-right)
- ✅ Candlestick chart container (center, dominant area)
- ✅ Network visualization canvas (bottom-left, 200px)
- ✅ Signal log table (bottom-center, last 50 signals)
- ✅ Bottom navigation bar (6 metrics)
- ✅ Celebration overlay modal (hidden by default)
- ✅ All CSS inline in <style> tags
- ✅ All JavaScript inline in <script> tags
- ✅ TradingView lightweight-charts CDN link in <head>
- ✅ Google Fonts JetBrains Mono loaded

### Acceptance Criteria
1. Single HTML file loads and renders without errors
2. Header displays correctly with all elements aligned
3. P&L display shows "$0.00" initially with gold glow
4. Metrics grid shows 6 items in 2-column layout
5. Chart container is empty (ready for TradingView initialization)
6. Network canvas element present and sized
7. Signal table with headers rendered (empty tbody initially)
8. Bottom nav displays 6 metrics rows
9. Celebration overlay hidden initially
10. CSS variables defined for all colors
11. Grid layout functions (gaps, borders visible)
12. No external dependencies except TradingView CDN

### Implementation Notes
- Use CSS Grid for main layout (6 columns, 6 rows)
- Use FlexBox for header, metrics items, nav items
- Apply neon colors with glow text-shadow and box-shadow
- Define ::before pseudo-elements for gradient overlays
- No build step required (pure HTML, CSS, JS)

### Definition of Done
- File at `/projects/sandbox/newxau/src/output/dashboard/index.html`
- File size < 100KB (all code inline)
- Visual inspection: All sections visible, colors correct, layout correct
- No console errors when loaded in browser
- All inline styles and scripts present



## Task 2: Implement WebSocket Connection & Message Handling

### Description
Implement WebSocket connection logic, auto-reconnect with exponential backoff, and message handlers for all WebSocket message types.

### Requirements
- ✅ Connect to ws://localhost:3000
- ✅ Auto-reconnect on disconnect (exponential backoff: 1s → 30s max)
- ✅ Handle "snapshot" message type (restore full state)
- ✅ Handle "signal" message type (new signal, add to openSignals)
- ✅ Handle "state_change" message type (update engineState)
- ✅ Handle "filter_status" message type (store filterStatus)
- ✅ Handle "kelly_metrics" message type (store kellyMetrics)
- ✅ Handle "candle_update" message type (update chart + check outcomes)
- ✅ Update connection status indicator (dot color, text)
- ✅ JSON parsing with error handling
- ✅ Timestamp tracking for latency calculation

### Acceptance Criteria
1. WebSocket connects on page load
2. Connection dot turns green when connected
3. Connection dot turns red on disconnect
4. Reconnection attempts after disconnect
5. Exponential backoff visible in reconnection delays
6. Snapshot message updates engineState, signals, filterStatus
7. Signal message adds signal to UI and openSignals map
8. State change updates navigation bar engine indicator
9. Kelly metrics updates bottom nav Kelly Risk display
10. Candle update advances chart and checks signal outcomes
11. All message handlers log to console (for debugging)
12. Error handling for malformed JSON

### Implementation Notes
- Store WebSocket instance in appState
- Maintain reconnectDelay and reconnectTimer
- Use JSON.parse with try-catch
- Update connection status immediately on connect/disconnect
- Clear reconnection timer on successful connection

### Definition of Done
- WebSocket connection establishes on page load
- All message types handled without errors
- Connection status reflects actual WebSocket state
- Auto-reconnect works after simulated network failure
- Latency < 50ms for message processing



## Task 3: Implement Storage & Metrics Calculation

### Description
Implement localStorage persistence for signal outcomes and performance metrics, with calculation logic for win rate, P&L, and risk:reward ratio.

### Requirements
- ✅ Read/write localStorage key: `isagi_signal_outcomes`
- ✅ Read/write localStorage key: `isagi_performance_metrics`
- ✅ Restore outcomes and metrics on page load
- ✅ Calculate win rate (wins / resolved signals * 100)
- ✅ Calculate cumulative P&L (sum of all resolved signal P&L)
- ✅ Calculate average Risk:Reward (avg of R:R across all signals)
- ✅ Track win count, loss count, pending count
- ✅ Update outcomes when signal resolution detected
- ✅ Update metrics after every outcome change
- ✅ Handle corrupted localStorage data gracefully

### Acceptance Criteria
1. Page reload preserves signal outcomes
2. Page reload preserves performance metrics
3. Win rate percentage calculated correctly
4. Total P&L sums all resolved signals correctly
5. Average R:R calculated as mean of individual R:R values
6. Pending count reflects unresolved signals
7. Win/Loss count matches resolved outcomes
8. Outcomes map indexed by signal ID for fast lookup
9. Metrics recalculated on every outcome change
10. localStorage save failures logged but don't crash app

### Implementation Notes
- getStoredOutcomes() returns empty array on parse error
- getStoredMetrics() returns default metrics object on error
- Outcomes indexed in openSignals map by signal.id
- Metrics object calculated from openSignals values
- R:R = (TP - Entry) / (Entry - SL) for long, reversed for short

### Definition of Done
- Outcomes persist across page reloads
- Metrics display matches localStorage values on reload
- Win rate percentage displays correctly
- Cumulative P&L updates after signal resolution
- R:R average updates after signal resolution
- No data loss on localStorage save failures



## Task 4: Implement TradingView Chart Integration

### Description
Initialize and manage TradingView lightweight-charts library for M5 candlestick display with signal markers and price lines.

### Requirements
- ✅ Initialize chart in chartContainer div
- ✅ Configure dark theme (#0a0a0a background)
- ✅ Add candlestick series (green up, red down)
- ✅ Support up to 100 candles in history
- ✅ Add marker arrows for signal entries (L/S direction)
- ✅ Add price lines for SL (red dashed) and TP (green dashed)
- ✅ Remove price lines when signal resolved
- ✅ Auto-fit chart on data update
- ✅ Handle window resize (remeasure container)
- ✅ Update existing candle (last candle update)
- ✅ Handle chart container not ready (lazy init on first data)

### Acceptance Criteria
1. Chart initializes without errors on page load
2. Chart renders candlesticks when snapshot received
3. Candle wicks and bodies colored correctly (green/red)
4. Signal markers display as arrows with direction text
5. SL price line red with dashed style
6. TP price line green with dashed style
7. Price lines removed when signal is resolved
8. Chart refits when new candles added
9. Chart updates last candle without full redraw
10. Window resize adjusts chart dimensions

### Implementation Notes
- LightweightCharts global object from CDN
- createChart() with custom layout/grid configuration
- addCandlestickSeries() for OHLC data
- Candle time: Math.floor(Date / 1000) for unix seconds
- setMarkers() replaces all markers (accumulate before calling)
- priceLineMap stores [slLine, tpLine] by signal.id
- Store candleSeries and chart references globally

### Definition of Done
- Chart displays without errors
- Sample candles render with correct colors
- Signal markers visible when signals added
- Price lines visible and correct colors
- Auto-fit works on data updates
- Resize handler adjusts chart smoothly
- No console errors



## Task 5: Implement Signal Outcome Tracking & Resolution

### Description
Detect when active signals are resolved (hit TP or SL) by analyzing candle close prices, update outcomes, and trigger celebrations on wins.

### Requirements
- ✅ For each candle update, check all pending signals
- ✅ Detect long signal resolution: price >= TP (win) or price <= SL (loss)
- ✅ Detect short signal resolution: price <= TP (win) or price >= SL (loss)
- ✅ Calculate P&L as (TP - Entry) for long win, or (Entry - TP) for short win
- ✅ Mark outcome as 'win', 'loss', or 'pending'
- ✅ Set resolved timestamp on outcome
- ✅ Remove price lines from chart on resolution
- ✅ Trigger celebration on win (not on loss)
- ✅ Update metrics after resolution
- ✅ Save outcomes to localStorage
- ✅ Update signal log table with outcome

### Acceptance Criteria
1. Long signal resolved when candle >= TP
2. Long signal resolved when candle <= SL
3. Short signal resolved when candle <= TP
4. Short signal resolved when candle >= SL
5. P&L calculated correctly for wins
6. P&L calculated as negative for losses
7. Outcome marked as 'pending' initially
8. Outcome marked as 'win' or 'loss' on resolution
9. Price lines removed from chart on resolution
10. Celebration triggered only on wins
11. Metrics updated after resolution
12. Outcomes persisted to localStorage

### Implementation Notes
- Check in order: if outcome already resolved, skip
- Use TP1 (ticket1.takeProfit) for exit price
- P&L for long: tp - entry for wins, -(entry - sl) for losses
- P&L for short: entry - tp for wins, -(sl - entry) for losses
- Set resolvedAt to candle.timestamp
- Call removeChartPriceLines(signalId)
- Call updatePerformanceMetrics()
- Call saveOutcomes()

### Definition of Done
- Signals resolve on correct TP/SL hits
- P&L calculated and displayed correctly
- Celebrations trigger on wins
- Metrics update after resolution
- Outcomes persist after page reload
- Price lines removed from chart
- Signal log shows resolved outcome



## Task 6: Implement Network Visualization Animation

### Description
Create canvas-based animated network graph with 12 glowing nodes, dynamic edges, physics simulation, and continuous animation loop.

### Requirements
- ✅ Initialize 12 nodes with random positions and colors
- ✅ Generate random edges (70% connection probability)
- ✅ Render edges as semi-transparent lines
- ✅ Render nodes with radial gradient glow + solid center
- ✅ Implement physics: velocity + gravity (0.1 px/frame²)
- ✅ Wrap nodes around canvas edges (toroidal wrap)
- ✅ Rotate through 4 colors (magenta, cyan, green, gold)
- ✅ Animate with requestAnimationFrame loop
- ✅ Fade old frame (0.1 opacity over-paint)
- ✅ Handle window resize (remeasure canvas)
- ✅ Continue animation indefinitely
- ✅ No performance impact on main thread (pure canvas)

### Acceptance Criteria
1. 12 nodes visible on canvas on page load
2. Nodes have colored glow halos
3. Edges visible as connecting lines
4. Nodes move smoothly (velocity + gravity)
5. Nodes wrap around canvas edges
6. Glow gradient rendered with proper transparency
7. Animation runs at smooth 60fps
8. Canvas resizes on window resize event
9. Animation loop continues indefinitely
10. No memory leaks (particles not accumulating)

### Implementation Notes
- Each node: {x, y, vx, vy, radius, color}
- Each edge: {from: index, to: index}
- Physics: x += vx, y += vy, vy += 0.1 (gravity)
- Gradient: createRadialGradient(x, y, 0, x, y, radius*3)
- Color stops: [0]: color + '40' (64% opaque), [1]: color + '00' (transparent)
- Wrap: if x < 0: x = canvas.width (repeat for y, >height)
- Canvas clear with fillRect(0,0,w,h) with semi-transparent fill

### Definition of Done
- Network canvas displays with animated nodes
- Glow effects visible and smooth
- Nodes move with physics simulation
- Animation runs continuously
- No lag or jank visible
- Canvas responds to window resize
- No console errors



## Task 7: Implement Signal Log Table Updates

### Description
Render signal table with last 50 signals, color-coded rows, and update dynamically as new signals arrive or resolve.

### Requirements
- ✅ Display up to 50 most recent signals (reverse-chronological)
- ✅ Columns: Time | Dir | Entry | SL | TP1 | Zone | Risk | Status
- ✅ Format time as HH:MM:SS UTC (from ISO timestamp)
- ✅ Direction: "L" (long, green) or "S" (short, red)
- ✅ Prices formatted to 2 decimals
- ✅ Zone classification from zoneClassification field
- ✅ Risk amount formatted as $X.XX
- ✅ Status badge: PENDING | WIN | LOSS with styling
- ✅ Rows with .win class: green left border
- ✅ Rows with .loss class: red left border
- ✅ Hover effect on rows (light background)
- ✅ Update table on new signal arrival
- ✅ Update row on outcome change
- ✅ Sticky header at top

### Acceptance Criteria
1. Table renders with all 8 columns
2. Header row visible at top with correct labels
3. Signal rows render in reverse-chronological order
4. Time formatted correctly (HH:MM:SS)
5. Direction shows correct letter and color
6. All prices formatted to 2 decimals
7. Zone classification displays (or — if missing)
8. Risk formatted as $X.XX
9. Status shows PENDING initially, updates to WIN/LOSS
10. Win rows have green left border
11. Loss rows have red left border
12. Hover effect visible on rows
13. Header stays visible on scroll
14. Table updates immediately on new signals

### Implementation Notes
- formatTimestamp(isoStr) extracts UTC HH:MM:SS
- formatPrice(p) formats to 2 decimals
- Row class assigned from outcome status
- Direction class assigned from signal.direction
- Signal data comes from appState.signals array (first 50)
- Outcome comes from appState.openSignals[signal.id]
- Insert row using tbody.insertRow() and set innerHTML

### Definition of Done
- Table displays last 50 signals
- All columns have correct data
- Row formatting correct (colors, borders)
- Table updates on new signals
- Table updates on outcome changes
- Hover effects visible
- Header sticky on scroll
- No console errors



## Task 8: Implement Celebration Overlay & Particle Animation

### Description
Display celebration modal on winning signals with golden particle effects, auto-dismiss after 5 seconds, and queue multiple celebrations.

### Requirements
- ✅ Show modal on WIN outcome only
- ✅ Modal center on screen with semi-transparent dark background
- ✅ Display P&L amount in 96px bold gold font
- ✅ Display direction label: "LONG WIN" or "SHORT WIN"
- ✅ Display entry price and TP hit price
- ✅ Render 50 golden particles with physics
- ✅ Particles: Random position, velocity, gravity, opacity decay
- ✅ Particle lifetime: ~1.6s (100 frames at 60fps)
- ✅ Particle rendering: Canvas circle with alpha channel
- ✅ Close button: X, circular, positioned top-right
- ✅ Auto-dismiss after 5 seconds (fade out 0.5s)
- ✅ Queue multiple celebrations (process sequentially)
- ✅ Early dismiss on close button click
- ✅ Animations: Fade in (0.3s), Zoom (0.5s), Fade out (0.5s)

### Acceptance Criteria
1. Modal hidden on page load
2. Modal shows on signal WIN outcome
3. P&L displays in large gold font
4. Direction displays correctly (LONG/SHORT WIN)
5. Entry and TP prices display
6. 50 golden particles spawn on modal show
7. Particles fall with gravity effect
8. Particles fade out over time
9. Close button visible and clickable
10. Modal dismisses after 5 seconds
11. Fade out animation plays
12. Multiple wins queue and display sequentially
13. Early dismiss on close button works
14. No jank during particle animation

### Implementation Notes
- celebrationQueue array for pending celebrations
- celebrationActive flag to ensure single modal at a time
- processCelebrationQueue() recursive, processes one at a time
- Particle class with update() and draw() methods
- Each particle: {x, y, vx, vy, size, life}
- Life decay: 0.01 per frame (100 frames = 1.6s)
- Canvas measurements: celebrationCanvas width="800" height="600"
- Text measurements: 96px font for profit, 24px for details
- Overlay .active class toggle for visibility
- closeBtn click calls processCelebrationQueue()

### Definition of Done
- Celebration displays on WIN outcome
- All text displays correctly
- Particles animate smoothly
- Auto-dismiss after 5 seconds
- Close button works
- Multiple celebrations queue properly
- Animations smooth and no jank
- No console errors



## Task 9: Implement UI Update Functions & Real-Time Display

### Description
Implement all UI update functions to reflect real-time data changes, connection status, engine state, and metrics calculations.

### Requirements
- ✅ updateConnectionStatus() - Set dot color and text based on isConnected
- ✅ updatePnlDisplay() - Update P&L value and related metrics
- ✅ updateEngineState() - Update engine state indicator
- ✅ updateSignalLog() - Refresh signal table with latest signals
- ✅ updateBottomNav() - Update bottom navigation metrics
- ✅ updateAllUI() - Call all update functions
- ✅ Update clock every second (HH:MM:SS UTC)
- ✅ Update connection status on WebSocket events
- ✅ Update metrics after outcome changes
- ✅ Update chart on candle updates
- ✅ Format P&L with +/- prefix
- ✅ Format prices to 2 decimals
- ✅ Format win rate to 1 decimal
- ✅ Format latency in milliseconds

### Acceptance Criteria
1. Connection dot green when connected, red when disconnected
2. Connection text updates immediately on status change
3. P&L displays with correct +/- prefix
4. P&L value updates on signal resolution
5. Win rate percentage displays correctly
6. Engine state displays correctly
7. Signal log table updates on new signals
8. Bottom nav metrics all update correctly
9. Clock updates every second
10. Latency calculated and displayed
11. All formatting functions work correctly
12. Updates happen within 50ms of event

### Implementation Notes
- updateConnectionStatus(): dot.classList.add/remove('connected')
- P&L format: (pnl >= 0 ? '+' : '') + '$' + Math.abs(pnl).toFixed(2)
- Win rate format: percentage.toFixed(1) + '%'
- Engine state: toUpperCase() and replace(/_/g, ' ')
- Clock update: Use setInterval(updateClock, 1000)
- Latency: Math.abs(Date.now() - new Date(lastUpdateTimestamp).getTime())
- updateAllUI() called after WebSocket snapshot, state changes

### Definition of Done
- All UI elements update correctly on data changes
- Connection status reflects WebSocket state
- Clock updates every second
- Metrics display calculated values correctly
- P&L displays with proper formatting
- No stale data on screen
- Updates happen smoothly without visible lag



## Task 10: Testing & Production Optimization

### Description
Test all features, optimize performance, verify cross-browser compatibility, and prepare for production deployment.

### Requirements
- ✅ Manual test: Page loads without errors
- ✅ Manual test: Chart initializes and renders
- ✅ Manual test: Network animation runs smoothly
- ✅ Manual test: WebSocket connects (dev server at 3000)
- ✅ Manual test: Signal table updates on new signals
- ✅ Manual test: Celebration overlay displays on wins
- ✅ Manual test: LocalStorage persists on reload
- ✅ Manual test: Reconnection works on disconnect
- ✅ Performance: File size < 100KB
- ✅ Performance: Initial load time < 2s
- ✅ Performance: Frame rate stable 60fps
- ✅ Performance: Memory usage stable (no leaks)
- ✅ Compatibility: Chrome/Edge 88+
- ✅ Compatibility: Firefox 87+
- ✅ Compatibility: Safari 14+
- ✅ Code: No external dependencies except TradingView CDN
- ✅ Code: All code inline (no external CSS/JS files)
- ✅ Documentation: Code comments for complex sections

### Acceptance Criteria
1. Page loads without console errors
2. Chart renders candlesticks correctly
3. Network animation runs at 60fps
4. WebSocket connects successfully
5. Signal table updates immediately on new signals
6. Celebration overlay shows on wins
7. Particle animation runs smoothly
8. localStorage persists data across reloads
9. File size reported < 100KB
10. Initial load time < 2 seconds
11. Frame rate remains stable 60fps during animation
12. Memory usage doesn't increase unbounded
13. No visual glitches or jank
14. Works in Chrome, Firefox, Safari (latest versions)
15. All features work without TradingView CDN failure

### Testing Checklist
- [ ] Open page in browser, check for console errors
- [ ] Verify header bar displays correctly
- [ ] Verify P&L display shows
- [ ] Verify metrics grid layout
- [ ] Verify chart container ready
- [ ] Verify network canvas animates
- [ ] Verify signal table renders
- [ ] Verify bottom nav displays
- [ ] Verify celebration overlay hidden
- [ ] Open DevTools, Network tab, watch WebSocket
- [ ] Trigger connection loss, verify reconnect
- [ ] Verify metrics update on new signals
- [ ] Verify celebration on wins
- [ ] Reload page, verify data persists
- [ ] Check file size: ls -lh index.html
- [ ] Measure load time: DevTools Lighthouse
- [ ] Record fps: DevTools Performance tab
- [ ] Check memory: DevTools Memory tab

### Performance Benchmarks
- File size: < 100KB (estimated ~80KB)
- Initial load: < 2s (depends on network)
- Frame rate: 60fps sustained
- Memory baseline: ~30MB (dashboard only)
- Chart render: < 50ms per candle
- Table update: < 30ms per signal

### Definition of Done
- All acceptance criteria met
- All testing checklist items completed
- Performance benchmarks met or exceeded
- Cross-browser testing completed
- Code reviewed for production quality
- File deployed to `/projects/sandbox/newxau/src/output/dashboard/index.html`
