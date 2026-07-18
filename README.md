# Isagi Engine — XAU/USD + BTC/USD Signal Bot

Signal-only analysis engine for XAU/USD (Gold) and BTC/USD (Bitcoin) with Telegram notifications and optional real-time dashboards.

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Create data directory
mkdir -p data

# Start isolated XAU/USD and BTC/USD bridges and bots
npm run start:all

# Run only one instrument if needed
START_INSTRUMENTS=BTCUSD npm run start:all
```

That's it. Open http://localhost:3000 for the dashboard.

## What It Does

- Analyzes XAU/USD and BTC/USD price action using the Isagi Engine protocol
- Sends BUY/SELL signals to Telegram with entry, SL, TP1, TP2
- Shows live engine state on a web dashboard
- **SIGNAL ONLY** — does NOT place any trades automatically

## Architecture

- **Data Sources:** TradingView CFD scanner for `OANDA:XAUUSD` and crypto scanner for `COINBASE:BTCUSD` (free, no API key needed)
- **Isolation:** XAU/USD and BTC/USD run as separate processes with separate bridge ports, runtime state, and SQLite databases
- **Analysis:** FSM-based engine with observation → expansion → retracement → rejection pattern
- **Filters:** Time Gate (12-17 UTC), News Decoupler, Volume Filter, Kelly Sizing, Circuit Breaker
- **Output:** Telegram (split position 45%/55%) + Web Dashboard + SQLite Logging

## Telegram

Set the credentials through environment variables; do not commit bot tokens or chat IDs:

```bash
export TELEGRAM_BOT_TOKEN="<your Telegram bot token>"
export TELEGRAM_CHAT_ID="<your Telegram chat ID>"

# Optional smoke test: fetches live XAU/USD and BTC/USD prices and sends
# clearly labeled TEST SIGNAL — DO NOT TRADE messages.
npm run telegram:test
```

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

Automated tests cover the core engine, both instrument data paths, output formatting, persistence, and signal-only enforcement.
