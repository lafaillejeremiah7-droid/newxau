/**
 * Live Data Bridge for the Isagi Engine Signal Bot.
 *
 * Provides real-time XAU/USD candle data via local WebSocket (port 8080).
 * Uses a multi-source approach:
 *   1. Primary: Twelve Data REST API polling for M1 candles
 *   2. Fallback: Simulated price data for testing/demo when API is unavailable
 *
 * The bridge aggregates M1 candles into M5, M15, and H1 timeframes locally.
 *
 * Environment Variables:
 *   TWELVE_DATA_API_KEY - Twelve Data API key (free tier: ~800 calls/day)
 *   BRIDGE_PORT         - Local WebSocket server port (default: 8080)
 *   POLL_INTERVAL_SEC   - Seconds between REST polls (default: 60, min: 10)
 *   SIMULATION_MODE     - Force simulation mode: "true" | "false" (default: auto-detect)
 *
 * Usage:
 *   npx tsx src/bridges/live-data-bridge.ts
 *
 * Free tier calculation (Twelve Data):
 *   800 calls/day = 1 call per ~108 seconds
 *   Recommended: POLL_INTERVAL_SEC=60 (generous) or 120 (conservative)
 */

import WebSocket, { WebSocketServer } from 'ws';

// ─── Configuration ───────────────────────────────────────────────────────────

const API_KEY = process.env.TWELVE_DATA_API_KEY ?? '';
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT ?? '8080', 10);
const POLL_INTERVAL_SEC = Math.max(10, parseInt(process.env.POLL_INTERVAL_SEC ?? '60', 10));
const FORCE_SIMULATION = process.env.SIMULATION_MODE === 'true';

const TWELVE_DATA_REST_URL = 'https://api.twelvedata.com/time_series';
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

interface TwelveDataResponse {
  meta?: {
    symbol: string;
    interval: string;
  };
  values?: Array<{
    datetime: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume?: string;
  }>;
  status?: string;
  code?: number;
  message?: string;
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

let isSimulationMode = false;
let lastKnownPrice = 2650.0; // Default XAU/USD approximate price
let simulationInterval: ReturnType<typeof setInterval> | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let lastFetchedTimestamp: string | null = null;
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;

// ─── Candle Aggregation ──────────────────────────────────────────────────────

/**
 * Get the candle boundary start for a given timestamp and timeframe.
 */
function getCandleBoundaryStart(timestampMs: number, timeframe: Timeframe): number {
  const duration = TIMEFRAME_DURATION_MS[timeframe];
  return Math.floor(timestampMs / duration) * duration;
}

/**
 * Process an incoming M1 candle and aggregate into higher timeframes.
 * The M1 candle is emitted directly; M5/M15/H1 are aggregated.
 */
function processM1Candle(candle: CandleMessage): CandleMessage[] {
  const completedCandles: CandleMessage[] = [];

  // Always emit the M1 candle directly
  completedCandles.push(candle);

  const candleTimestampMs = new Date(candle.timestamp).getTime();

  // Aggregate into higher timeframes (M5, M15, H1)
  for (const tf of ['M5', 'M15', 'H1'] as Timeframe[]) {
    const duration = TIMEFRAME_DURATION_MS[tf];
    const currentBoundary = getCandleBoundaryStart(candleTimestampMs, tf);
    const active = activeCandles.get(tf);

    if (active === null || active === undefined) {
      // First candle for this timeframe
      activeCandles.set(tf, {
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        startMs: currentBoundary,
        tickCount: 1,
      });
    } else if (currentBoundary !== active.startMs) {
      // New period — emit the completed candle
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

      // Fill gap periods if any
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
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        startMs: currentBoundary,
        tickCount: 1,
      });
    } else {
      // Same period — update OHLCV
      active.high = Math.max(active.high, candle.high);
      active.low = Math.min(active.low, candle.low);
      active.close = candle.close;
      active.volume += candle.volume;
      active.tickCount++;
    }
  }

  return completedCandles;
}

/**
 * Process a tick (price update) into all timeframes.
 * Used for simulation mode where we get price ticks, not candles.
 */
function processTick(price: number, timestampMs: number, volume: number): CandleMessage[] {
  const completedCandles: CandleMessage[] = [];

  for (const tf of TIMEFRAMES) {
    const duration = TIMEFRAME_DURATION_MS[tf];
    const currentBoundary = getCandleBoundaryStart(timestampMs, tf);
    const active = activeCandles.get(tf);

    if (active === null || active === undefined) {
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
      // Emit completed candle
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

      // Fill gaps
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

      // New candle
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
      // Update current candle
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

  // Send current state info to new client
  const statusMsg = JSON.stringify({
    type: 'status',
    mode: isSimulationMode ? 'simulation' : 'live',
    lastPrice: lastKnownPrice,
    connectedAt: new Date().toISOString(),
  });
  ws.send(statusMsg);

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[LiveBridge] Client disconnected. Total: ${clients.size}`);
  });

  ws.on('error', (err) => {
    console.error(`[LiveBridge] Client error: ${err.message}`);
    clients.delete(ws);
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
    `[LiveBridge] ${isSimulationMode ? '[SIM]' : '[LIVE]'} ` +
      `${candle.timeframe} candle @ ${candle.timestamp} ` +
      `O=${candle.open.toFixed(2)} H=${candle.high.toFixed(2)} ` +
      `L=${candle.low.toFixed(2)} C=${candle.close.toFixed(2)} V=${candle.volume}`
  );
}

// ─── Twelve Data REST Polling ────────────────────────────────────────────────

/**
 * Fetch the latest M1 candles from Twelve Data REST API.
 */
async function fetchLatestCandles(): Promise<CandleMessage[]> {
  const url = `${TWELVE_DATA_REST_URL}?symbol=${encodeURIComponent(SYMBOL)}&interval=1min&outputsize=5&apikey=${API_KEY}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as TwelveDataResponse;

    if (data.code || data.status === 'error') {
      throw new Error(data.message ?? 'Unknown API error');
    }

    if (!data.values || data.values.length === 0) {
      throw new Error('No candle data in response');
    }

    // Convert to CandleMessage format (data comes newest first)
    const candles: CandleMessage[] = data.values
      .map((v) => ({
        instrument: 'XAUUSD' as const,
        timestamp: new Date(v.datetime + ' UTC').toISOString(),
        open: parseFloat(v.open),
        high: parseFloat(v.high),
        low: parseFloat(v.low),
        close: parseFloat(v.close),
        volume: parseInt(v.volume ?? '0', 10),
        timeframe: 'M1' as Timeframe,
      }))
      .reverse(); // Oldest first for processing

    return candles;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`Twelve Data fetch failed: ${errorMsg}`);
  }
}

/**
 * Poll cycle: fetch latest candles and process new ones.
 */
async function pollCycle(): Promise<void> {
  try {
    const candles = await fetchLatestCandles();
    consecutiveErrors = 0;

    // Only process candles we haven't seen before
    for (const candle of candles) {
      if (lastFetchedTimestamp && candle.timestamp <= lastFetchedTimestamp) {
        continue; // Already processed
      }

      lastKnownPrice = candle.close;
      const completedCandles = processM1Candle(candle);
      for (const c of completedCandles) {
        broadcastCandle(c);
      }
    }

    // Update last fetched timestamp
    if (candles.length > 0) {
      lastFetchedTimestamp = candles[candles.length - 1].timestamp;
    }
  } catch (err) {
    consecutiveErrors++;
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[LiveBridge] Poll error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${errorMsg}`);

    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      console.warn('[LiveBridge] Too many consecutive errors. Switching to simulation mode...');
      switchToSimulation();
    }
  }
}

/**
 * Start REST polling mode.
 */
function startPolling(): void {
  console.log(
    `[LiveBridge] Starting REST polling mode (interval: ${POLL_INTERVAL_SEC}s, ` +
      `~${Math.floor(86400 / POLL_INTERVAL_SEC)} calls/day)`
  );

  // Initial fetch
  pollCycle();

  // Set up polling interval
  pollInterval = setInterval(pollCycle, POLL_INTERVAL_SEC * 1000);
}

// ─── Simulation Mode ─────────────────────────────────────────────────────────

/**
 * Generate a realistic simulated XAU/USD tick.
 * Uses random walk with mean reversion and realistic volatility.
 */
function generateSimulatedTick(): { price: number; volume: number } {
  // XAU/USD typical intraday volatility: ~$10-20 range per day
  // Per-tick (every 5s): ~$0.05-0.30 move
  const volatility = 0.15; // Standard deviation of per-tick move in USD
  const meanReversionStrength = 0.001; // Slight pull toward 2650

  // Random walk component
  const randomMove = (Math.random() - 0.5) * 2 * volatility * (1 + Math.random());

  // Mean reversion component (prevents drift too far)
  const reversion = (2650 - lastKnownPrice) * meanReversionStrength;

  // Occasional larger moves (simulating news/liquidity events)
  const spike = Math.random() < 0.02 ? (Math.random() - 0.5) * 3.0 : 0;

  lastKnownPrice = Math.max(2500, Math.min(2800, lastKnownPrice + randomMove + reversion + spike));

  // Simulate volume (random, with occasional spikes)
  const baseVolume = Math.floor(50 + Math.random() * 200);
  const volumeSpike = Math.random() < 0.05 ? Math.floor(Math.random() * 500) : 0;

  return {
    price: Math.round(lastKnownPrice * 100) / 100,
    volume: baseVolume + volumeSpike,
  };
}

/**
 * Start simulation mode — generates ticks every 5 seconds.
 */
function startSimulation(): void {
  isSimulationMode = true;
  console.log('[LiveBridge] Starting SIMULATION mode (tick every 5 seconds)');
  console.log('[LiveBridge] Simulated base price: $' + lastKnownPrice.toFixed(2));

  simulationInterval = setInterval(() => {
    const { price, volume } = generateSimulatedTick();
    const nowMs = Date.now();

    const completedCandles = processTick(price, nowMs, volume);
    for (const candle of completedCandles) {
      broadcastCandle(candle);
    }

    // Log current price periodically (every 12 ticks = ~1 min)
    if (Math.random() < 0.083) {
      console.log(`[LiveBridge] [SIM] Current price: $${price.toFixed(2)}`);
    }
  }, 5000);
}

/**
 * Switch from live polling to simulation mode.
 */
function switchToSimulation(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (!simulationInterval) {
    startSimulation();
  }
}

/**
 * Switch from simulation to live polling mode.
 */
function switchToLive(): void {
  if (simulationInterval) {
    clearInterval(simulationInterval);
    simulationInterval = null;
  }
  isSimulationMode = false;
  consecutiveErrors = 0;
  startPolling();
}

// ─── Periodic Candle Flush (Safety Net) ──────────────────────────────────────

/**
 * Every second, check if any active candle's period has ended.
 * Emits candles even if no new data arrives (prevents stale state).
 */
setInterval(() => {
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

// ─── Health Check / Status Endpoint (simple HTTP on same port via upgrade) ───

// We'll add a simple "ping" response for WebSocket clients
wss.on('connection', (ws) => {
  ws.on('message', (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ping') {
        ws.send(
          JSON.stringify({
            type: 'pong',
            mode: isSimulationMode ? 'simulation' : 'live',
            lastPrice: lastKnownPrice,
            uptime: process.uptime(),
            clients: clients.size,
          })
        );
      } else if (msg.type === 'switch_mode') {
        // Allow manual mode switching via WebSocket command
        if (msg.mode === 'simulation') {
          switchToSimulation();
          ws.send(JSON.stringify({ type: 'mode_changed', mode: 'simulation' }));
        } else if (msg.mode === 'live') {
          if (!API_KEY) {
            ws.send(
              JSON.stringify({
                type: 'error',
                message: 'Cannot switch to live mode: TWELVE_DATA_API_KEY not set',
              })
            );
          } else {
            switchToLive();
            ws.send(JSON.stringify({ type: 'mode_changed', mode: 'live' }));
          }
        }
      }
    } catch {
      // Ignore non-JSON messages
    }
  });
});

// ─── Startup ─────────────────────────────────────────────────────────────────

console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Isagi Engine - Live Data Bridge (XAU/USD)                  ║
║                                                              ║
║  Local WebSocket: ws://localhost:${String(BRIDGE_PORT).padEnd(4)}                     ║
║  Symbol: ${SYMBOL.padEnd(48)}║
║  Timeframes: M1, M5, M15, H1                                ║
║  Poll Interval: ${String(POLL_INTERVAL_SEC).padEnd(3)}s                                     ║
║  Mode: ${(FORCE_SIMULATION ? 'SIMULATION (forced)' : API_KEY ? 'LIVE (REST polling)' : 'SIMULATION (no API key)').padEnd(50)}║
╚══════════════════════════════════════════════════════════════╝
`);

wss.on('listening', () => {
  console.log(`[LiveBridge] WebSocket server listening on port ${BRIDGE_PORT}`);

  if (FORCE_SIMULATION || !API_KEY) {
    if (!API_KEY && !FORCE_SIMULATION) {
      console.log(
        '[LiveBridge] No TWELVE_DATA_API_KEY set. Running in simulation mode.\n' +
          '  To use live data, get a free key from https://twelvedata.com/pricing\n' +
          '  Then: export TWELVE_DATA_API_KEY=your_key_here'
      );
    }
    startSimulation();
  } else {
    startPolling();
  }
});

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

function shutdown(signal: string): void {
  console.log(`\n[LiveBridge] Received ${signal}, shutting down...`);

  if (pollInterval) clearInterval(pollInterval);
  if (simulationInterval) clearInterval(simulationInterval);

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
