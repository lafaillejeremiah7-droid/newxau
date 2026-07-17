# Isagi Engine — XAU/USD Signal Bot

Signal-only analysis engine for XAU/USD (Gold) with Telegram notifications and real-time dashboard.

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Create data directory
mkdir -p data

# Start everything (bridge + bot + dashboard)
npm run start:all
```

That's it. Open http://localhost:3000 for the dashboard.

## What It Does

- Analyzes XAU/USD price action using the Isagi Engine protocol
- Sends BUY/SELL signals to Telegram with entry, SL, TP1, TP2
- Shows live engine state on a web dashboard
- **SIGNAL ONLY** — does NOT place any trades automatically

## Architecture

- **Data Source:** TradingView (free, no API key needed)
- **Analysis:** FSM-based engine with observation → expansion → retracement → rejection pattern
- **Filters:** Time Gate (12-17 UTC), News Decoupler, Volume Filter, Kelly Sizing, Circuit Breaker
- **Output:** Telegram (split position 45%/55%) + Web Dashboard + SQLite Logging

## Telegram

Signals are sent to:
- Bot Token: `8926622863:AAF0QHHYAyEVQZiYV35b5vyeKxDC_ouMnmQ`
- Chat ID: `7040023207`

## Running Separately

```bash
# Terminal 1: Bridge
npm run start:bridge

# Terminal 2: Bot
npm start
```

## Tests

```bash
npm test
```

660 unit tests covering all components.
