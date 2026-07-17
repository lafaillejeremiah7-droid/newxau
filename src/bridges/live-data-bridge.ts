/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  Isagi Engine - LIVE XAU/USD Data Bridge                    ║
 * ║  Source: TradingView (real-time, no API key needed)         ║
 * ║  WebSocket: ws://localhost:8080                             ║
 * ║  Timeframes: M1, M5, M15, H1                               ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Polls TradingView's free public scanner API every 5 seconds for live
 * XAU/USD price data. Builds M1 candles from ticks, then aggregates
 * into M5, M15, and H1 timeframes. Emits completed candles via WebSocket.
 *
 * NO API key required. NO signup. Works immediately.
 *
 * Usage:
 *   npx tsx src/bridges/live-data-bridge.ts
 */

import WebSocket, { WebSocketServer } from 'ws';

// ─── Configuration ───────────────────────────────────────────────────────────

const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT ?? '8080', 10);
const POLL_INTERVAL_MS = 5_000; // Poll every 5 seconds
const PRICE_LOG_INTERVAL_MS = 30_000; // Log price every 30 seconds

const TRADINGVIEW_SCANNER_URL = 'https://scanner.tradingview.com/cfd/scan';

const TRADINGVIEW_BODY = JSON.stringify({
  symbols: { tickers: ['OANDA:XAUUSD'], query: { types: [] } },
  columns: ['close', 'open', 'high', 'low', 'bid', 'ask', 'change', 'change_abs', 'volume'],
});

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

interface TradingViewResponse {
  totalCount: number;
  data: Array<{
    s: string;
    d: number[];
  }>;
}

// ─── Timeframe Configuration ─────────────────────────────────────────────────

const TIMEFRAME_DURATION_MS: Record<Timeframe, number> = {
  M1: 60_000,
  M5: 300_000,
  M15: 900_000,
  H1: 3_600_000,
};

const TIMEFRAMES: Timeframe[] = ['M1', 'M5', 'M15', 'H1'];

// ─── State ───────────────────────────────────────────────────────────────────

const activeCandles: Map<Timeframe, ActiveCandle | null> = new Map();
for (const tf of TIMEFRAMES) {
  activeCandles.set(tf, null);
}

let lastKnownPrice = 0;
let lastBid = 0;
let lastAsk = 0;
let lastPriceLogMs = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

// Exponential backoff state
let consecutiveErrors = 0;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

// ─── Candle Boundary Utilities ───────────────────────────────────────────────

/**
 * Get the candle boundary start for a given timestamp and timeframe.
 */
function getCandleBoundaryStart(timestampMs: number, timeframe: Timeframe): number {
  const duration = TIMEFRAME_DURATION_MS[timeframe];
  return Math.floor(timestampMs / duration) * duration;
}

// ─── Tick Processing & Candle Aggregation ────────────────────────────────────

/**
 * Process an incoming price tick into all timeframes.
 * Returns completed candles (emitted only on close / boundary crossing).
 */
function processTick(price: number, timestampMs: number, volume: number): CandleMessage[] {
  const completedCandles: CandleMessage[] = [];

  for (const tf of TIMEFRAMES) {
    const duration = TIMEFRAME_DURATION_MS[tf];
    const currentBoundary = getCandleBoundaryStart(timestampMs, tf);
    const active = activeCandles.get(tf);

    if (active === null || active === undefined) {
      // First tick for this timeframe — open a new candle
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
      // Boundary crossed — emit completed candle
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

      // Fill gap periods if any (e.g., missed boundaries during outage)
      let nextBoundary = active.startMs + duration;
      while (nextBoundary < currentBoundary) {
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

      // Start new candle
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

// ─── Local WebSocket Server ──────────────────────────────────────────────────

const wss = new WebSocketServer({ port: BRIDGE_PORT });
const clients: Set<WebSocket> = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[LiveBridge] Client connected. Total: ${clients.size}`);

  // Send current state to new client
  // const statusMsg = JSON.stringify({
  //   type: 'status',
  //   mode: 'live',
  //   source: 'TradingView',
  //   lastPrice: lastKnownPrice,
  //   bid: lastBid,
  //   ask: lastAsk,
  //   spread: lastAsk - lastBid,
  //   connectedAt: new Date().toISOString(),
  // });
  // ws.send(statusMsg);

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[LiveBridge] Client disconnected. Total: ${clients.size}`);
  });

  ws.on('error', (err) => {
    console.error(`[LiveBridge] Client error: ${err.message}`);
    clients.delete(ws);
  });

  ws.on('message', (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ping') {
        ws.send(
          JSON.stringify({
            type: 'pong',
            mode: 'live',
            source: 'TradingView',
            lastPrice: lastKnownPrice,
            bid: lastBid,
            ask: lastAsk,
            spread: lastAsk - lastBid,
            uptime: process.uptime(),
            clients: clients.size,
          })
        );
      }
    } catch {
      // Ignore non-JSON messages
    }
  });
});

/**
 * Broadcast a completed candle to all connected clients.
 */
function broadcastCandle(candle: CandleMessage): void {
  const payload = JSON.stringify(candle);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
  console.log(
    `[LiveBridge] [LIVE] ${candle.timeframe} candle closed @ ${candle.timestamp} ` +
      `O=${candle.open.toFixed(2)} H=${candle.high.toFixed(2)} ` +
      `L=${candle.low.toFixed(2)} C=${candle.close.toFixed(2)} V=${candle.volume}`
  );
}

// ─── TradingView Scanner Polling ─────────────────────────────────────────────

/**
 * Fetch latest XAU/USD data from TradingView public scanner API.
 */
async function fetchTradingViewPrice(): Promise<{
  close: number;
  open: number;
  high: number;
  low: number;
  bid: number;
  ask: number;
  volume: number;
}> {
  const response = await fetch(TRADINGVIEW_SCANNER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: TRADINGVIEW_BODY,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as TradingViewResponse;

  if (!data.data || data.data.length === 0) {
    throw new Error('No data returned from TradingView scanner');
  }

  const row = data.data[0].d;
  // Columns: close, open, high, low, bid, ask, change, change_abs, volume
  return {
    close: row[0],
    open: row[1],
    high: row[2],
    low: row[3],
    bid: row[4],
    ask: row[5],
    volume: row[8] ?? 0,
  };
}

/**
 * Single poll cycle with auto-reconnect (exponential backoff).
 */
async function pollCycle(): Promise<void> {
  try {
    const priceData = await fetchTradingViewPrice();
    consecutiveErrors = 0; // Reset on success

    lastKnownPrice = priceData.close;
    lastBid = priceData.bid;
    lastAsk = priceData.ask;

    const nowMs = Date.now();

    // Process the tick
    const completedCandles = processTick(priceData.close, nowMs, priceData.volume);
    for (const candle of completedCandles) {
      broadcastCandle(candle);
    }

    // Print live price every 30 seconds
    if (nowMs - lastPriceLogMs >= PRICE_LOG_INTERVAL_MS) {
      const spread = (priceData.ask - priceData.bid).toFixed(2);
      console.log(
        `[LiveBridge] XAU/USD $${priceData.close.toFixed(2)} | ` +
          `Bid: $${priceData.bid.toFixed(2)} Ask: $${priceData.ask.toFixed(2)} | ` +
          `Spread: $${spread} | Clients: ${clients.size}`
      );
      lastPriceLogMs = nowMs;
    }

    // Schedule next poll at normal interval
    scheduleNextPoll(POLL_INTERVAL_MS);
  } catch (err) {
    consecutiveErrors++;
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Exponential backoff: 5s, 10s, 20s, 40s, 60s (capped)
    const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, consecutiveErrors - 1), MAX_BACKOFF_MS);

    console.error(
      `[LiveBridge] Fetch error #${consecutiveErrors}: ${errorMsg}. ` +
        `Retrying in ${(backoffMs / 1000).toFixed(1)}s...`
    );

    // Schedule next poll with backoff
    scheduleNextPoll(backoffMs);
  }
}

/**
 * Schedule the next poll cycle.
 */
function scheduleNextPoll(delayMs: number): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
  }
  pollTimer = setTimeout(pollCycle, delayMs);
}

// ─── Periodic Candle Flush (Safety Net) ──────────────────────────────────────

/**
 * Every second, check if any active candle's period has ended.
 * Emits candles even if no new data arrives (prevents stale state).
 */
const flushInterval = setInterval(() => {
  const nowMs = Date.now();

  for (const tf of TIMEFRAMES) {
    const active = activeCandles.get(tf);
    if (active === null || active === undefined) continue;

    const duration = TIMEFRAME_DURATION_MS[tf];
    if (nowMs >= active.startMs + duration) {
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
      activeCandles.set(tf, null);
    }
  }
}, 1000);

// ─── Startup ─────────────────────────────────────────────────────────────────

console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Isagi Engine - LIVE XAU/USD Data Bridge                    ║
║  Source: TradingView (real-time, no API key needed)         ║
║  WebSocket: ws://localhost:${String(BRIDGE_PORT).padEnd(4)}                         ║
║  Timeframes: M1, M5, M15, H1                               ║
║  Poll Interval: 5s                                          ║
╚══════════════════════════════════════════════════════════════╝
`);

wss.on('listening', () => {
  console.log(`[LiveBridge] WebSocket server listening on ws://localhost:${BRIDGE_PORT}`);
  console.log('[LiveBridge] Fetching live XAU/USD data from TradingView...');
  console.log('[LiveBridge] No API key needed. No signup required.');
  console.log('');

  // Start polling immediately
  pollCycle();
});

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

function shutdown(signal: string): void {
  console.log(`\n[LiveBridge] Received ${signal}, shutting down...`);

  if (pollTimer) clearTimeout(pollTimer);
  clearInterval(flushInterval);

  // Close all client connections
  for (const client of clients) {
    client.close(1001, 'Bridge shutting down');
  }

  wss.close(() => {
    console.log('[LiveBridge] Server closed.');
    process.exit(0);
  });

  // Force exit if graceful close takes too long
  setTimeout(() => {
    console.error('[LiveBridge] Forced exit after timeout.');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
