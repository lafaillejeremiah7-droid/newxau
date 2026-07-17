# Requirements: Trading Dashboard Terminal

## Overview
Create a production-ready HTML trading terminal dashboard for the Isagi Quant XAU/USD signal bot with real-time metrics, candlestick charting, signal logging, and celebration overlays.

## Functional Requirements

### 1. Header Bar (Always Visible)
- Display bot identity: "⚡ ISAGI QUANT"
- Instrument badge: "XAU/USD" with cyan styling
- Mode indicator: "SIGNAL ONLY" with gold styling
- UTC clock that updates every second
- Connection status indicator with animated dot (green when connected, red when disconnected)

### 2. Large P&L Display (Top Left, 180px x auto)
- Primary focus: Display realized P&L in 48px gold font
- Label: "Realized P&L" in dim text
- Golden border with glowing inset shadow
- Responsive to P&L value changes from localStorage

### 3. Metrics Grid (Top Right, 2 columns)
Display 6 performance metrics:
- Win Rate % - percentage of closed signals that won
- Total P&L - cumulative profit/loss across all signals
- Open Signals - count of pending (unresolved) signals
- Win/Loss count - formatted as "wins/losses"
- Avg Risk:Reward ratio - average R:R across all signals
- Status - current engine state (COLD START, SUPPRESSED, etc.)

### 4. Candlestick Chart (Center, Dominant Area)
- TradingView lightweight-charts library for M5 candlestick display
- Support up to 100 candles in history
- Show SL and TP price lines for active signals
- Display signal entry markers (arrow up for long, arrow down for short)
- Auto-scale and fit content when new candles arrive
- Responsive resize on window resize

### 5. Network Visualization (Bottom Left, 200px height)
- Canvas-based animated network graph
- 12 glowing nodes with random colors (magenta, cyan, green, gold)
- Animated connections between nodes
- Continuous loop animation with physics (gravity, velocity)
- Nodes wrap around edges
- Gradient glow effects around each node

### 6. Signal Log Table (Bottom Center, Primary)
- Show last 50 signals in reverse-chronological order
- Columns: Time | Dir | Entry | SL | TP1 | Zone | Risk | Status
- Color-coded rows: green left border for wins, red for losses
- Status badge: PENDING, WIN, or LOSS with appropriate styling
- Direction indicator: "L" for long (green), "S" for short (red)
- Table header sticky at top with dark background
- Hover effects on rows
- Scrollable with custom green scrollbar

### 7. Bottom Navigation Bar (Always Visible, 50px)
Display 6 key metrics inline:
- Signals: Total signal count
- Win %: Current win rate percentage
- P&L: Current cumulative P&L
- Kelly Risk: Current Kelly sizing risk amount
- Engine: Current engine state
- Latency: ms since last update

### 8. Celebration Overlay (Modal)
- Triggered on WIN outcome only
- Semi-transparent dark background (rgba(0,0,0,0.9))
- Central content area with:
  - Large golden P&L amount (96px font)
  - Direction label (LONG WIN / SHORT WIN)
  - Entry and TP Hit prices
  - Golden particle animation (50 particles, 5s auto-dismiss)
- Close button (X) to dismiss early
- Queue multiple wins (process sequentially)
- Auto-dismiss after 5 seconds

## Data Flow

### WebSocket Message Handling
The dashboard connects to ws://localhost:3000 and expects messages:
- **snapshot**: Initial state on connection (engineState, signals[], filterStatus, kellyMetrics, candles[])
- **signal**: New signal event (FormattedSignal object)
- **state_change**: Engine state update
- **filter_status**: Filter status update
- **kelly_metrics**: Kelly sizing metrics update
- **candle_update**: New M5 candle with gap detection

### localStorage Persistence
- Key: `isagi_signal_outcomes` → Array of FormattedSignal with outcome + pnl
- Key: `isagi_performance_metrics` → Object with wins, losses, pending, winRate, cumulativePnL, avgRR
- Outcomes updated on every signal resolution
- Metrics recalculated on every outcome change

## Non-Functional Requirements

### Performance
- All code inline (no external dependencies except TradingView CDN)
- Single HTML file, no build step required
- Initial load < 2s
- WebSocket connection established within 1s
- Metrics update within 50ms of WebSocket message receipt
- Chart updates without jank (60fps)

### Reliability
- Auto-reconnect with exponential backoff (1s → 30s max)
- Graceful degradation if WebSocket unavailable
- localStorage fallback for metrics persistence
- Explicit error handling for JSON parsing, chart rendering, animation loops

### Design
- Neon cyberpunk aesthetic (green, gold, cyan, magenta, dark bg)
- All borders glow with box-shadow
- Text shadows for visual depth
- JetBrains Mono monospace font for terminal feel
- Consistent 8px padding/gap spacing
- Dark background (#0a0a0a) throughout

## Browser Compatibility
- Chrome/Edge 88+
- Firefox 87+
- Safari 14+
- Responsive to 1920x1080+ minimum (terminal dashboard, not mobile-first)

