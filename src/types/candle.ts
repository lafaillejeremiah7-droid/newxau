/**
 * Candle-related type definitions for the Isagi Engine Signal Bot.
 * Defines candlestick data structures and timeframe management.
 */

/** Supported trading timeframes */
export type Timeframe = 'M1' | 'M5' | 'M15' | 'H1';

/** A single OHLCV candlestick for XAU/USD */
export interface Candle {
  instrument: 'XAUUSD';
  timeframe: Timeframe;
  timestamp: string; // ISO 8601 UTC ms precision
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Rolling buffer of candles per timeframe with volume SMA tracking */
export interface CandleBuffer {
  timeframe: Timeframe;
  maxSize: number; // M5: 200, M15: 100, H1: 50, M1: 500
  candles: Candle[];
  sma20Volume: number;
}
