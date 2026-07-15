/**
 * CandleBufferManager - Manages rolling candle arrays per timeframe.
 *
 * Maintains separate buffers for M1, M5, M15, and H1 timeframes with
 * configurable maximum sizes. Computes a rolling 20-period SMA of volume
 * specifically for M5 candles (used by the Volume Filter).
 *
 * Requirements: 9.1 (volume SMA baseline)
 */

import { Candle, CandleBuffer, Timeframe } from '../types/index.js';

/** Default maximum buffer sizes per timeframe */
const BUFFER_MAX_SIZES: Record<Timeframe, number> = {
  M1: 500,
  M5: 200,
  M15: 100,
  H1: 50,
};

/** Number of periods used for the M5 volume SMA calculation */
const SMA_PERIOD = 20;

/**
 * Manages separate candle buffers per timeframe with FIFO eviction
 * and rolling SMA-20 volume calculation for M5.
 */
export class CandleBufferManager {
  private buffers: Map<Timeframe, CandleBuffer>;

  constructor() {
    this.buffers = new Map<Timeframe, CandleBuffer>();

    const timeframes: Timeframe[] = ['M1', 'M5', 'M15', 'H1'];
    for (const tf of timeframes) {
      this.buffers.set(tf, {
        timeframe: tf,
        maxSize: BUFFER_MAX_SIZES[tf],
        candles: [],
        sma20Volume: 0,
      });
    }
  }

  /**
   * Adds a candle to the appropriate buffer based on its timeframe.
   * If the buffer is full, the oldest candle is removed (FIFO).
   * Recalculates the SMA-20 volume for M5 candles on each M5 addition.
   */
  addCandle(candle: Candle): void {
    const buffer = this.buffers.get(candle.timeframe);
    if (!buffer) {
      return;
    }

    buffer.candles.push(candle);

    // Evict oldest candle if buffer exceeds max size
    if (buffer.candles.length > buffer.maxSize) {
      buffer.candles.shift();
    }

    // Recalculate SMA-20 volume for M5 candles
    if (candle.timeframe === 'M5') {
      buffer.sma20Volume = this.calculateSma20Volume(buffer.candles);
    }
  }

  /**
   * Returns the buffer for a given timeframe.
   */
  getBuffer(timeframe: Timeframe): CandleBuffer {
    const buffer = this.buffers.get(timeframe);
    if (!buffer) {
      throw new Error(`No buffer for timeframe: ${timeframe}`);
    }
    return buffer;
  }

  /**
   * Returns the current M5 20-period volume SMA.
   * Returns 0 if no M5 candles exist.
   */
  getSma20Volume(): number {
    const buffer = this.buffers.get('M5');
    if (!buffer) {
      return 0;
    }
    return buffer.sma20Volume;
  }

  /**
   * Returns the last N candles for a given timeframe.
   * If fewer than N candles exist, returns all available.
   */
  getLatestCandles(timeframe: Timeframe, count: number): Candle[] {
    const buffer = this.buffers.get(timeframe);
    if (!buffer) {
      return [];
    }
    const startIndex = Math.max(0, buffer.candles.length - count);
    return buffer.candles.slice(startIndex);
  }

  /**
   * Returns the last N M5 candle volumes for zone classification.
   * Used to determine Expansion_Zone vs Chop_Zone.
   */
  getVolumeTrend(count: number): number[] {
    const buffer = this.buffers.get('M5');
    if (!buffer) {
      return [];
    }
    const startIndex = Math.max(0, buffer.candles.length - count);
    return buffer.candles.slice(startIndex).map((c) => c.volume);
  }

  /**
   * Calculates the 20-period SMA of volume from the given candle array.
   * If fewer than 20 candles exist, uses whatever is available.
   * Returns 0 if no candles are provided.
   */
  private calculateSma20Volume(candles: Candle[]): number {
    if (candles.length === 0) {
      return 0;
    }

    const periodsToUse = Math.min(SMA_PERIOD, candles.length);
    const recentCandles = candles.slice(candles.length - periodsToUse);

    const volumeSum = recentCandles.reduce(
      (sum, candle) => sum + candle.volume,
      0,
    );

    return volumeSum / periodsToUse;
  }
}
