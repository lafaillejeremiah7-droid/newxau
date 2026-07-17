/**
 * Twelve Data WebSocket Bridge for the Isagi Engine Signal Bot.
 *
 * Connects to Twelve Data's real-time WebSocket API for XAU/USD price data,
 * aggregates ticks into OHLCV candles for M1, M5, M15, and H1 timeframes,
 * and re-broadcasts completed candles via a local WebSocket server on port 8080.
 *
 * Environment Variables:
 *   TWELVE_DATA_API_KEY - Your free Twelve Data API key (required)
 *   BRIDGE_PORT         - Local WebSocket server port (default: 8080)
 *
 * Usage:
 *   npx tsx src/bridges/twelve-data-bridge.ts
 */

import WebSocket, { WebSocketServer } from 'ws';

// ─── Configuration ───────────────────────────────────────────────────────────

const API_KEY = process.env.TWELVE_DATA_API_KEY ?? '';
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT ?? '8080', 10);
const TWELVE_DATA_WS_URL = 'wss://ws.twelvedata.com/v1/quotes/price';
const SYMBOL = 'XAU/USD';

// ─── Types ───────────────────────────────────────────────────────────────────

type Timeframe = 'M1' | 'M5' | 'M15' | 'H1';

interface CandleMessage {
  instrument: 'XAUUSD';
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timeframe: Timeframe;
}

interface ActiveCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  startMs: number;
  tickCount: number;
}

interface TwelveDataPriceEvent {
  event: string;
  symbol?: string;
  price?: number;
  timestamp?: number;
  day_volume?: number;
}

// ─── Timeframe Configuration ─────────────────────────────────────────────────

const TIMEFRAME_DURATION_MS: Record<Timeframe, number> = {
  M1: 60_000,
  M5: 300_000,
  M15: 900_000,
  H1: 3_600_000,
};

const TIMEFRAMES: Timeframe[] = ['M1', 'M5', 'M15', 'H1'];

// ─── Candle Aggregation State ────────────────────────────────────────────────

const activeCandles: Map<Timeframe, ActiveCandle | null> = new Map();
for (const tf of TIMEFRAMES) {
  activeCandles.set(tf, null);
}

/**
 * Get the candle boundary start (beginning of the period) for a given timestamp.
 */
function getCandleBoundaryStart(timestampMs: number, timeframe: Timeframe): number {
  const duration = TIMEFRAME_DURATION_MS[timeframe];
  return Math.floor(timestampMs / duration) * duration;
}

/**
 * Process an incoming tick and update candle aggregation state.
 * Returns an array of completed candles (if any periods closed).
 */
function processTick(price: number, timestampMs: number, volume: number): CandleMessage[] {
  const completedCandles: CandleMessage[] = [];

  for (const tf of TIMEFRAMES) {
    const duration = TIMEFRAME_DURATION_MS[tf];
    const currentBoundary = getCandleBoundaryStart(timestampMs, tf);
    const active = activeCandles.get(tf);

    if (active === null || active === undefined) {
      // First tick for this timeframe — start a new candle
      activeCandles.set(tf, {
        open: price,
        high: price,
        low: price,
        close: price,
        volume,
        startMs: currentBoundary,
        tickCount: 1,
      });
    } else if (currentBoundary !== active.startMs) {
      // New period started — close the previous candle and emit it
      const closedCandle: CandleMessage = {
        instrument: 'XAUUSD',
        timestamp: new Date(active.startMs).toISOString(),
        open: active.open,
        high: active.high,
        low: active.low,
        close: active.close,
        volume: active.volume,
        timeframe: tf,
      };
      completedCandles.push(closedCandle);

      // Handle case where we skipped periods (gap in data)
      // Fill any missing periods between the old boundary and the current one
      let nextBoundary = active.startMs + duration;
      while (nextBoundary < currentBoundary) {
        // Gap candle — use last known close as OHLC
        const gapCandle: CandleMessage = {
          instrument: 'XAUUSD',
          timestamp: new Date(nextBoundary).toISOString(),
          open: active.close,
          high: active.close,
          low: active.close,
          close: active.close,
          volume: 0,
          timeframe: tf,
        };
        completedCandles.push(gapCandle);
        nextBoundary += duration;
      }

      // Start a new candle for the current period
      activeCandles.set(tf, {
        open: price,
        high: price,
        low: price,
        close: price,
        volume,
        startMs: currentBoundary,
        tickCount: 1,
      });
    } else {
      // Same period — update OHLCV
      active.high = Math.max(active.high, price);
      active.low = Math.min(active.low, price);
      active.close = price;
      active.volume += volume;
      active.tickCount++;
    }
  }

  return completedCandles;
}

// ─── Local WebSocket Server (broadcasts to bot) ──────────────────────────────

const wss = new WebSocketServer({ port: BRIDGE_PORT });
const clients: Set<WebSocket> = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[Bridge] Client connected. Total clients: ${clients.size}`);

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[Bridge] Client disconnected. Total clients: ${clients.size}`);
  });

  ws.on('error', (err) => {
    console.error(`[Bridge] Client error: ${err.message}`);
    clients.delete(ws);
  });
});

/**
 * Broadcast a completed candle to all connected bot clients.
 */
function broadcastCandle(candle: CandleMessage): void {
  const payload = JSON.stringify(candle);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
  console.log(
    `[Bridge] Emitted ${candle.timeframe} candle @ ${candle.timestamp} ` +
      `O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close} V=${candle.volume}`
  );
}

// ─── Twelve Data WebSocket Connection ────────────────────────────────────────

let upstreamWs: WebSocket | null = null;
let reconnectAttempt = 0;
const MAX_RECONNECT_DELAY_MS = 60_000;
const BASE_RECONNECT_DELAY_MS = 2_000;

function connectToTwelveData(): void {
  if (!API_KEY) {
    console.error(
      '[Bridge] ERROR: TWELVE_DATA_API_KEY environment variable is not set.\n' +
        '  Get a free API key from https://twelvedata.com and set it:\n' +
        '  export TWELVE_DATA_API_KEY=your_key_here'
    );
    process.exit(1);
  }

  console.log(`[Bridge] Connecting to Twelve Data WebSocket for ${SYMBOL}...`);

  upstreamWs = new WebSocket(TWELVE_DATA_WS_URL);

  upstreamWs.on('open', () => {
    console.log('[Bridge] Connected to Twelve Data WebSocket.');
    reconnectAttempt = 0;

    // Subscribe to XAU/USD price events
    const subscribeMsg = JSON.stringify({
      action: 'subscribe',
      params: {
        symbols: SYMBOL,
      },
    });
    upstreamWs!.send(subscribeMsg);
    console.log(`[Bridge] Subscribed to ${SYMBOL} price feed.`);
  });

  upstreamWs.on('message', (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString()) as TwelveDataPriceEvent;

      // Handle subscription status messages
      if (msg.event === 'subscribe-status') {
        console.log(`[Bridge] Subscription status: ${JSON.stringify(msg)}`);
        return;
      }

      // Handle heartbeat
      if (msg.event === 'heartbeat') {
        return;
      }

      // Process price events
      if (msg.event === 'price' && msg.price !== undefined && msg.timestamp !== undefined) {
        const price = msg.price;
        const timestampMs = msg.timestamp * 1000; // Twelve Data sends seconds
        const volume = msg.day_volume ?? 1; // Use day_volume or default tick volume of 1

        const completedCandles = processTick(price, timestampMs, volume);
        for (const candle of completedCandles) {
          broadcastCandle(candle);
        }
      }
    } catch (err) {
      console.error(`[Bridge] Error processing upstream message: ${err}`);
    }
  });

  upstreamWs.on('close', (code, reason) => {
    console.log(
      `[Bridge] Upstream WebSocket closed: code=${code}, reason=${reason.toString()}`
    );
    scheduleReconnect();
  });

  upstreamWs.on('error', (err) => {
    console.error(`[Bridge] Upstream WebSocket error: ${err.message}`);
    // close event will fire after this, triggering reconnect
  });
}

function scheduleReconnect(): void {
  const delay = Math.min(
    BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempt),
    MAX_RECONNECT_DELAY_MS
  );
  reconnectAttempt++;
  console.log(
    `[Bridge] Reconnecting in ${delay}ms (attempt ${reconnectAttempt})...`
  );
  setTimeout(connectToTwelveData, delay);
}

// ─── Periodic Candle Flush (Safety Net) ──────────────────────────────────────

/**
 * Every second, check if any active candle's period has ended.
 * This ensures candles are emitted even if tick data stops arriving.
 */
setInterval(() => {
  const nowMs = Date.now();

  for (const tf of TIMEFRAMES) {
    const active = activeCandles.get(tf);
    if (active === null || active === undefined) continue;

    const duration = TIMEFRAME_DURATION_MS[tf];
    if (nowMs >= active.startMs + duration) {
      // Period has ended — emit the candle
      const closedCandle: CandleMessage = {
        instrument: 'XAUUSD',
        timestamp: new Date(active.startMs).toISOString(),
        open: active.open,
        high: active.high,
        low: active.low,
        close: active.close,
        volume: active.volume,
        timeframe: tf,
      };
      broadcastCandle(closedCandle);

      // Reset — next tick will start a fresh candle
      activeCandles.set(tf, null);
    }
  }
}, 1000);

// ─── Startup ─────────────────────────────────────────────────────────────────

console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Isagi Engine - Twelve Data XAU/USD Bridge                  ║
║                                                              ║
║  Local WebSocket server: ws://localhost:${BRIDGE_PORT}              ║
║  Symbol: ${SYMBOL}                                            ║
║  Timeframes: M1, M5, M15, H1                                ║
║  Only closed candles are emitted.                            ║
╚══════════════════════════════════════════════════════════════╝
`);

wss.on('listening', () => {
  console.log(`[Bridge] Local WebSocket server listening on port ${BRIDGE_PORT}`);
  connectToTwelveData();
});

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('\n[Bridge] Shutting down...');
  if (upstreamWs) {
    upstreamWs.close(1000, 'Bridge shutdown');
  }
  wss.close(() => {
    console.log('[Bridge] Server closed.');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n[Bridge] Received SIGTERM, shutting down...');
  if (upstreamWs) {
    upstreamWs.close(1000, 'Bridge shutdown');
  }
  wss.close(() => {
    process.exit(0);
  });
});
