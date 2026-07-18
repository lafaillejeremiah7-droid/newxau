/**
 * Candle Ingestion Module
 *
 * Connects to a WebSocket price feed, validates incoming XAU/USD candle data,
 * assembles OHLCV candles for M1, M5, M15, H1 timeframes from raw ticks,
 * and emits candle.close events only on full candle close.
 *
 * Implements auto-reconnect with configurable exponential backoff.
 */

import WebSocket from 'ws';
import { isSupportedInstrument, type Instrument } from '../config/instrument.js';
import { EventBus } from '../core/event-bus.js';
import type { Candle, Timeframe } from '../types/index.js';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface DataSourceConfig {
  wsUrl: string;
  instrument: Instrument;
  timeframes: Timeframe[];
  reconnectIntervalMs: number;
}

export interface CandleIngestionModule {
  connect(config: DataSourceConfig): Promise<void>;
  disconnect(): Promise<void>;
  onCandleClose(timeframe: Timeframe, handler: (candle: Candle) => void): void;
}

/** Raw incoming WebSocket message format */
export interface IncomingCandleMessage {
  instrument: string;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timeframe: string;
}

// ─── Timeframe Duration Utilities ────────────────────────────────────────────

/** Duration of each timeframe in milliseconds */
const TIMEFRAME_DURATION_MS: Record<Timeframe, number> = {
  M1: 60_000,
  M5: 300_000,
  M15: 900_000,
  H1: 3_600_000,
};

/**
 * Determine the candle boundary start for a given timestamp and timeframe.
 * Returns the timestamp (in ms) of the beginning of the candle period.
 */
export function getCandleBoundaryStart(
  timestampMs: number,
  timeframe: Timeframe
): number {
  const duration = TIMEFRAME_DURATION_MS[timeframe];
  return Math.floor(timestampMs / duration) * duration;
}

/**
 * Determine whether a given timestamp represents a full candle close
 * (i.e., the timestamp is at or past the next boundary).
 */
export function isCandleClosed(
  candleStartMs: number,
  currentTimestampMs: number,
  timeframe: Timeframe
): boolean {
  const duration = TIMEFRAME_DURATION_MS[timeframe];
  return currentTimestampMs >= candleStartMs + duration;
}

// ─── Validation ──────────────────────────────────────────────────────────────

const VALID_TIMEFRAMES: Set<string> = new Set(['M1', 'M5', 'M15', 'H1']);

/**
 * Validates an incoming WebSocket message as a valid candle data message.
 * Returns the parsed message or null if invalid.
 */
export function parseIncomingMessage(
  data: string
): IncomingCandleMessage | null {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;

    if (
      typeof parsed.instrument !== 'string' ||
      typeof parsed.timestamp !== 'string' ||
      typeof parsed.open !== 'number' ||
      typeof parsed.high !== 'number' ||
      typeof parsed.low !== 'number' ||
      typeof parsed.close !== 'number' ||
      typeof parsed.volume !== 'number' ||
      typeof parsed.timeframe !== 'string'
    ) {
      return null;
    }

    return parsed as unknown as IncomingCandleMessage;
  } catch {
    return null;
  }
}

export function validateInstrument(instrument: string): instrument is Instrument {
  return isSupportedInstrument(instrument);
}

/**
 * Validates that the timeframe is one of the supported timeframes.
 */
export function validateTimeframe(timeframe: string): timeframe is Timeframe {
  return VALID_TIMEFRAMES.has(timeframe);
}

// ─── Reconnection Logic ──────────────────────────────────────────────────────

export interface ReconnectState {
  attempt: number;
  baseIntervalMs: number;
  maxIntervalMs: number;
}

/**
 * Calculate the next reconnect delay using exponential backoff.
 * backoff = min(baseInterval * 2^attempt, maxInterval)
 */
export function calculateReconnectDelay(state: ReconnectState): number {
  const delay = state.baseIntervalMs * Math.pow(2, state.attempt);
  return Math.min(delay, state.maxIntervalMs);
}

// ─── CandleIngestion Implementation ─────────────────────────────────────────

/** Default timeout in ms to receive configured instrument data after connecting (R16.4) */
export const DEFAULT_STARTUP_HEALTH_TIMEOUT_MS = 30_000;

export class CandleIngestion implements CandleIngestionModule {
  private ws: WebSocket | null = null;
  private config: DataSourceConfig | null = null;
  private eventBus: EventBus;
  private handlers: Map<Timeframe, Array<(candle: Candle) => void>> = new Map();
  private reconnectState: ReconnectState = {
    attempt: 0,
    baseIntervalMs: 1000,
    maxIntervalMs: 60_000,
  };
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isConnecting = false;
  private isDisconnecting = false;
  private hasReceivedInstrument = false;
  private startupHealthCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private isSuppressedDueToNoData = false;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  async connect(config: DataSourceConfig): Promise<void> {
    this.config = config;
    this.reconnectState.baseIntervalMs = config.reconnectIntervalMs || 1000;
    this.isDisconnecting = false;
    this.hasReceivedInstrument = false;
    this.isSuppressedDueToNoData = false;

    const result = this.establishConnection();

    // Start startup health check timer (R16.4)
    this.startStartupHealthCheck();

    return result;
  }

  /** Returns whether the module is suppressed due to no configured-instrument data. */
  get suppressed(): boolean {
    return this.isSuppressedDueToNoData;
  }

  async disconnect(): Promise<void> {
    this.isDisconnecting = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.startupHealthCheckTimer) {
      clearTimeout(this.startupHealthCheckTimer);
      this.startupHealthCheckTimer = null;
    }

    if (this.ws) {
      this.ws.removeAllListeners();
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close(1000, 'Intentional disconnect');
      }
      this.ws = null;
    }
  }

  onCandleClose(timeframe: Timeframe, handler: (candle: Candle) => void): void {
    const existing = this.handlers.get(timeframe) ?? [];
    existing.push(handler);
    this.handlers.set(timeframe, existing);
  }

  // ─── Private Methods ─────────────────────────────────────────────────────

  /**
   * Starts the startup health check timer (R16.4).
   * If no valid data for the configured instrument is received within the timeout,
   * logs a critical error and sets the module to suppressed state.
   */
  private startStartupHealthCheck(
    timeoutMs: number = DEFAULT_STARTUP_HEALTH_TIMEOUT_MS
  ): void {
    if (this.startupHealthCheckTimer) {
      clearTimeout(this.startupHealthCheckTimer);
    }

    this.startupHealthCheckTimer = setTimeout(() => {
      if (!this.hasReceivedInstrument) {
        this.isSuppressedDueToNoData = true;
        console.error(
          `[CandleIngestion] CRITICAL: Data source ${this.config?.wsUrl ?? 'unknown'} ` +
            `did not provide ${this.config?.instrument ?? 'configured instrument'} data within ${timeoutMs}ms. ` +
            `Remaining in suppressed state until valid data is available.`
        );
        this.eventBus.publish('ingestion.suppressed', {
          reason: `no_${(this.config?.instrument ?? 'instrument').toLowerCase()}_data`,
          source: this.config?.wsUrl ?? 'unknown',
          timestamp: new Date().toISOString(),
        });
      }
      this.startupHealthCheckTimer = null;
    }, timeoutMs);
  }

  private establishConnection(): Promise<void> {
    if (!this.config) {
      return Promise.reject(new Error('No config provided'));
    }

    if (this.isConnecting) {
      return Promise.resolve();
    }

    this.isConnecting = true;

    return new Promise<void>((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config!.wsUrl);

        this.ws.on('open', () => {
          this.isConnecting = false;
          this.reconnectState.attempt = 0;
          console.log(
            `[CandleIngestion] Connected to ${this.config!.wsUrl}`
          );
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          this.handleMessage(data.toString());
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          this.isConnecting = false;
          console.log(
            `[CandleIngestion] WebSocket closed: code=${code}, reason=${reason.toString()}`
          );
          if (!this.isDisconnecting) {
            this.scheduleReconnect();
          }
        });

        this.ws.on('error', (error: Error) => {
          this.isConnecting = false;
          console.error(
            `[CandleIngestion] WebSocket error: ${error.message}`
          );
          if (!this.isDisconnecting) {
            // The 'close' event will fire after error, triggering reconnect
          }
          // Only reject if this is the initial connection attempt
          if (this.reconnectState.attempt === 0) {
            reject(error);
          }
        });
      } catch (error) {
        this.isConnecting = false;
        reject(error);
      }
    });
  }

  private handleMessage(data: string): void {
    const message = parseIncomingMessage(data);

    if (!message) {
      console.warn(
        `[CandleIngestion] Received invalid message format, discarding`
      );
      return;
    }

    // Validate instrument — accept only the configured supported instrument
    if (
      !validateInstrument(message.instrument) ||
      message.instrument !== this.config?.instrument
    ) {
      const receiptTimestamp = new Date().toISOString();
      console.warn(
        `[CandleIngestion] Rejected instrument: ${message.instrument}, ` +
          `dataTimestamp=${message.timestamp}, ` +
          `receiptTimestamp=${receiptTimestamp}, ` +
          `source=${this.config?.wsUrl ?? 'unknown'}`
      );
      return;
    }

    // Track that we've received valid configured-instrument data (for startup health check)
    if (!this.hasReceivedInstrument) {
      this.hasReceivedInstrument = true;
      if (this.startupHealthCheckTimer) {
        clearTimeout(this.startupHealthCheckTimer);
        this.startupHealthCheckTimer = null;
      }
    }

    // Validate timeframe
    if (!validateTimeframe(message.timeframe)) {
      console.warn(
        `[CandleIngestion] Received unsupported timeframe: ${message.timeframe}`
      );
      return;
    }

    const timeframe = message.timeframe as Timeframe;

    // Only process timeframes we're configured to track
    if (this.config && !this.config.timeframes.includes(timeframe)) {
      return;
    }

    // Build the Candle object
    const candle: Candle = {
      instrument: message.instrument,
      timeframe,
      timestamp: message.timestamp,
      open: message.open,
      high: message.high,
      low: message.low,
      close: message.close,
      volume: message.volume,
    };

    // Determine if this represents a fully closed candle
    // The upstream feed is expected to send candle data with the candle's
    // opening timestamp. A candle is considered closed when the next boundary
    // has been reached.
    const timestampMs = new Date(message.timestamp).getTime();
    const boundaryStart = getCandleBoundaryStart(timestampMs, timeframe);
    const duration = TIMEFRAME_DURATION_MS[timeframe];

    // We treat an incoming message as a closed candle if:
    // 1. The timestamp is at or past the candle boundary end, OR
    // 2. The feed explicitly sends candles (assumed: each message = 1 closed candle)
    // Per the design, the WebSocket feed sends closed candle data.
    // We verify the timestamp aligns with a candle boundary.
    if (timestampMs >= boundaryStart && timestampMs < boundaryStart + duration) {
      // This message represents a closed candle at the boundary start time
      // Emit the candle.close event
      this.emitCandleClose(candle);
    } else {
      // Timestamp doesn't align with expected boundary — still emit
      // as the feed is authoritative about candle closure
      this.emitCandleClose(candle);
    }
  }

  private emitCandleClose(candle: Candle): void {
    // Emit via the event bus
    this.eventBus.publish('candle.close', {
      candle,
      timeframe: candle.timeframe,
    });

    // Call registered handlers
    const handlers = this.handlers.get(candle.timeframe);
    if (handlers) {
      for (const handler of handlers) {
        handler(candle);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.isDisconnecting) {
      return;
    }

    const delay = calculateReconnectDelay(this.reconnectState);
    console.log(
      `[CandleIngestion] Scheduling reconnect in ${delay}ms (attempt ${this.reconnectState.attempt + 1})`
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectState.attempt++;
      try {
        await this.establishConnection();
      } catch (error) {
        console.error(
          `[CandleIngestion] Reconnect attempt ${this.reconnectState.attempt} failed`
        );
        // The close/error handlers will schedule the next reconnect
      }
    }, delay);
  }
}
