# Design: Trading Dashboard Terminal

## Architecture Overview

### Single HTML File Structure
```
index.html
├── <meta> + Google Fonts + TradingView CDN
├── <style> - All CSS inline
│   ├── Root CSS variables (colors, spacing)
│   ├── Grid layout system
│   ├── Component styles
│   └── Animation keyframes
├── <body> - HTML structure
│   ├── Dashboard grid container
│   ├── Header bar
│   ├── P&L display
│   ├── Metrics grid
│   ├── Chart container
│   ├── Network canvas
│   ├── Signal log table
│   ├── Bottom nav
│   └── Celebration overlay
└── <script> - All JavaScript
    ├── Storage utilities
    ├── App state object
    ├── WebSocket management
    ├── Message handlers
    ├── Chart initialization (TradingView)
    ├── Network animation loop
    ├── Celebration animation
    └── UI update functions
```

## Grid Layout System

### CSS Grid Template
```
grid-template-areas:
  "header header header header"
  "pnl-large metrics-top metrics-top chart"
  "pnl-large chart chart chart"
  "net-viz chart chart chart"
  "net-viz log log log"
  "nav nav nav nav"

grid-template-columns: 1fr 1fr 1fr 1fr
grid-template-rows: 50px 180px 1fr 200px auto 50px
gap: 8px
padding: 8px
```

### Area Assignments
- **header**: Full width top bar
- **pnl-large**: Left column, 2 rows height (top metrics area)
- **metrics-top**: 2x2 grid of metrics, top right
- **chart**: Right 3 columns, spanning rows 2-4 (dominant central area)
- **net-viz**: Left column, row 4, 200px canvas
- **log**: Right 3 columns, row 5 (table scrollable)
- **nav**: Full width bottom bar

## Component Design

### Header Bar
- Height: 50px
- Background: Semi-transparent dark with green bottom border
- Box-shadow: Glowing green (0 0 20px rgba(0,255,65,0.2))
- FlexBox layout (space-between)
- Items: Left (identity, badges) | Right (clock, connection)

### P&L Display
- Border: 2px solid gold (#ffd700)
- Border-radius: 4px
- Box-shadow: Inset gold glow + outer gold glow
- ::before pseudo-element: Gradient overlay (135deg, 5% opacity)
- Font: 48px bold, gold text-shadow (0 0 20px)
- Centered flex layout (column)

### Metrics Grid
- 2-column CSS grid inside parent
- Each cell: flex column, centered content
- Label: 9px uppercase dim text
- Value: 20px bold with glow text-shadow
- Value variants: cyan for certain metrics, gold for P&L

### Candlestick Chart
- Container: Flex column, flex: 1 (grows to fill)
- TradingView library config:
  - Dark background (#0a0a0a)
  - Green text color (#00ff41)
  - Grid lines (#1a3a1a)
  - Crosshair enabled
  - Candles: Green up, red down
  - Tick price lines for SL/TP (green up, red down, dashed)
  - Marker arrows for signal entries

### Network Visualization
- Canvas element, 100% width/height of parent
- Animation loop: requestAnimationFrame
- Node rendering: Radial gradient glow + solid center circle
- Edge rendering: Semi-transparent lines connecting nodes
- Physics: Velocity + gravity + wraparound
- Colors: Rotating set of [magenta, cyan, green, gold]

### Signal Log Table
- Container: Flex column, flex: 1 overflow-y: auto
- Table: 100% width, border-collapse
- Sticky header: position sticky, top 0, z-index 10
- Rows: Hover effect (rgba green background)
- Rows class-based styling: .win (green left border), .loss (red left border)
- Custom scrollbar: 6px width, green thumb

### Bottom Navigation
- Height: 50px
- FlexBox: space-between, items-center
- 6 items, each with label + value styling
- Values highlighted in gold/cyan with glow

### Celebration Overlay
- Fixed full-screen modal (z-index 10000)
- Background: rgba(0,0,0,0.9)
- Visibility: Hidden by default, toggled by .active class
- Content: Centered absolute positioned
  - Title: 96px gold font with heavy text-shadow
  - Details: Direction + Entry/TP prices
  - Close button: Position absolute top-right, circular 50px
  - Canvas: Behind text (z-index: 0 for canvas in content)
- Animations:
  - Fade in: 0.3s ease-out
  - Content zoom: 0.5s cubic-bezier (scale 0.3 → 1)
  - Fade out: 0.5s ease-in

## State Management

### App State Object
```typescript
{
  isConnected: boolean,
  lastUpdateTimestamp: ISO string,
  signals: FormattedSignal[],
  openSignals: { [id]: {...outcome, pnl} },
  outcomes: FormattedSignal[] (from localStorage),
  metrics: {
    totalSignals: number,
    wins: number,
    losses: number,
    pending: number,
    winRate: number,
    cumulativePnL: number,
    avgRiskReward: number
  },
  engineState: string,
  filterStatus: object,
  kellyMetrics: object,
  candles: Candle[],
  ws: WebSocket,
  reconnectDelay: number,
  reconnectTimer: NodeJS.Timeout
}
```

## Animation & Effects

### Glow Text Shadow (Metrics, Headers)
```css
text-shadow: 0 0 10px rgba(0, 255, 65, 0.5);
```

### Box-Shadow Glow (Borders)
```css
box-shadow: 0 0 20px rgba(0, 255, 65, 0.2);
```

### Keyframes
- **glow-pulse**: Connection dot animation (0.5s pulse, infinit)
- **celebrationFadeIn**: Overlay entrance (0.3s)
- **celebrationFadeOut**: Overlay exit (0.5s)
- **celebrationZoom**: Content zoom (0.5s, cubic-bezier spring)

### Particle System (Celebration)
- 50 particles spawned on celebration trigger
- Each particle:
  - Random position (full viewport)
  - Random velocity (±4 px/frame)
  - Random size (3-11px)
  - Gravity acceleration (0.1 px/frame²)
  - Opacity decay (1 → 0 over lifecycle)
  - Lifetime: 100 frames (~1.6s at 60fps)
- Rendered each frame with canvas radial gradient

## Color Palette

| Purpose | Color | Hex | Usage |
|---------|-------|-----|-------|
| Background | Primary | #0a0a0a | Body, grid bg |
| Background | Secondary | #0f0f0f | Panels, header |
| Background | Tertiary | #151515 | Table headers, nested |
| Accent | Green (Neon) | #00ff41 | Headers, text, borders |
| Accent | Cyan (Neon) | #00ffff | Badges, alt metrics |
| Accent | Gold (Neon) | #ffd700 | P&L, mode badge |
| Accent | Magenta (Neon) | #ff00ff | Network viz |
| Status | Profit | #00ff41 | Win rows, green metrics |
| Status | Loss | #ff4444 | Loss rows, SL markers |
| Text | Dim | #666666 | Labels, secondary text |

## Responsive Behavior

### Window Resize Handling
- Chart: Remeasure container, call chart.applyOptions()
- Network: Remeasure canvas, continue animation
- Grid: CSS Grid handles automatically (flex: 1 containers)
- No breakpoints (desktop terminal dashboard, not mobile-first)

## WebSocket Reconnection Strategy

1. Initial connection: ws://[location.host]
2. On close/error: Schedule reconnect
3. Backoff: Start 1s, double each attempt, cap at 30s
4. On reconnect success: Reset delay to 1s
5. On disconnect: Update UI immediately (red dot, "DISCONNECTED")

## Data Persistence

### localStorage Keys
1. `isagi_signal_outcomes`
   - Type: JSON stringified array
   - Content: FormattedSignal[] with outcome + pnl fields
   - Updated: Every signal resolution
   - Used: Recovery on page reload

2. `isagi_performance_metrics`
   - Type: JSON stringified object
   - Content: Metrics object (totalSignals, wins, losses, etc.)
   - Updated: Every metrics recalculation
   - Used: Recovery on page reload

### Recovery Logic
- On page load: Restore outcomes and metrics from localStorage
- Open signals indexed by ID in openSignals map
- Outcomes map used to fill initial signal table
- Metrics used to populate display on load

