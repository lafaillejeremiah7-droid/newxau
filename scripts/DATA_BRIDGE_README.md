# Data Bridge for Isagi Engine

The Isagi Engine bot needs a live XAU/USD price feed delivered via WebSocket. This directory contains two bridge options that connect to different data sources and re-broadcast candles in the exact format the bot expects.

## Expected Candle Format

Both bridges emit JSON messages on `ws://localhost:8080` in this format:

```json
{
  "instrument": "XAUUSD",
  "timestamp": "2026-07-15T14:05:00.000Z",
  "open": 2387.50,
  "high": 2389.20,
  "low": 2386.80,
  "close": 2388.10,
  "volume": 1250,
  "timeframe": "M5"
}
```

**Key guarantees:**
- Only `XAUUSD` data is served (no other instruments)
- Candles are only emitted on **close** (never incomplete/partial candles)
- All 4 timeframes supported: `M1`, `M5`, `M15`, `H1`
- Timestamps are always ISO 8601 UTC
- Auto-reconnect if upstream source disconnects

---

## Option 1: Twelve Data WebSocket Bridge (Recommended)

**Best for:** Anyone without a broker account, paper trading, development/testing.

### Setup

1. **Get a free API key** from [https://twelvedata.com](https://twelvedata.com)
   - Sign up (free tier allows 800 API calls/day and 1 WebSocket connection)
   - Copy your API key from the dashboard

2. **Set environment variable:**
   ```bash
   export TWELVE_DATA_API_KEY=your_api_key_here
   ```

3. **Run the bridge:**
   ```bash
   npm run bridge:twelvedata
   # or
   npx tsx src/bridges/twelve-data-bridge.ts
   ```

4. **Start the bot** (in another terminal):
   ```bash
   npm start
   ```

### How It Works

- Connects to Twelve Data's real-time WebSocket API for XAU/USD tick data
- Aggregates incoming price ticks into OHLCV candles for each timeframe
- When a candle period ends (e.g., the 5-minute mark for M5), the completed candle is broadcast
- A safety-net timer checks every second if any period has closed even if no new ticks arrive
- Auto-reconnects with exponential backoff if the upstream connection drops

### Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `TWELVE_DATA_API_KEY` | *(required)* | Your Twelve Data API key |
| `BRIDGE_PORT` | `8080` | Local WebSocket server port |

### Limitations (Free Tier)

- 1 WebSocket connection at a time
- XAU/USD data may have slight delay vs. broker feed
- 800 REST API calls/day (bridge uses WebSocket so this is rarely hit)

---

## Option 2: MetaTrader 5 Bridge

**Best for:** Users with an MT5 broker account who want real broker-quality data.

### Prerequisites

- Windows (MT5 only runs natively on Windows)
- MetaTrader 5 terminal installed and logged into a broker account
- XAUUSD symbol visible in Market Watch
- Python 3.8+

### Setup

1. **Install Python dependencies:**
   ```bash
   pip install MetaTrader5 websockets
   ```

2. **Make sure MT5 is running** and logged into your account

3. **Ensure XAUUSD is in Market Watch:**
   - Right-click Market Watch → Show All, or search for XAUUSD

4. **Run the bridge:**
   ```bash
   python scripts/mt5-bridge.py
   ```

5. **Start the bot** (in another terminal):
   ```bash
   npm start
   ```

### How It Works

- Connects to the running MT5 terminal via the MetaTrader5 Python package
- Polls MT5 every second for new closed candles across all 4 timeframes
- Only emits a candle when it detects a genuinely new completed candle
- If MT5 disconnects, the bridge will log the error (you'll need to restart)

### Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `BRIDGE_PORT` | `8080` | Local WebSocket server port |
| `MT5_PATH` | *(auto-detect)* | Path to MT5 terminal executable |

### Limitations

- Windows only (MetaTrader5 Python package requires Windows)
- Requires a broker account with XAUUSD access
- MT5 must remain running and logged in

---

## Connecting the Bot

The Isagi Engine bot connects to `ws://localhost:8080` by default via its candle ingestion module. Make sure:

1. A bridge is running **before** starting the bot
2. The bridge port matches what the bot expects (default: 8080)
3. Only one bridge is running at a time (both use port 8080)

To change the port, set `BRIDGE_PORT=9090` (or any port) and update the bot's WebSocket URL configuration accordingly.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "TWELVE_DATA_API_KEY not set" | Export the env var: `export TWELVE_DATA_API_KEY=xxx` |
| No candles being emitted | Markets may be closed (XAU/USD trades Sun 5pm – Fri 5pm ET) |
| Connection refused on 8080 | Make sure no other service is using port 8080 |
| MT5 "symbol not found" | Add XAUUSD to Market Watch in your MT5 terminal |
| MT5 initialization failed | Ensure MT5 is running and you're logged in |
