/**
 * Unit tests for CandleBufferManager.
 * Tests rolling candle buffer management and SMA-20 volume calculation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CandleBufferManager } from './candle-buffer.js';
import { Candle, Timeframe } from '../types/index.js';

/** Helper to create a candle with specified values */
function makeCandle(
  timeframe: Timeframe,
  volume: number,
  overrides?: Partial<Candle>,
): Candle {
  return {
    instrument: 'XAUUSD',
    timeframe,
    timestamp: new Date().toISOString(),
    open: 2000.0,
    high: 2005.0,
    low: 1995.0,
    close: 2002.0,
    volume,
    ...overrides,
  };
}

describe('CandleBufferManager', () => {
  let manager: CandleBufferManager;

  beforeEach(() => {
    manager = new CandleBufferManager();
  });

  describe('buffer initialization', () => {
    it('should initialize buffers for all timeframes', () => {
      const timeframes: Timeframe[] = ['M1', 'M5', 'M15', 'H1'];
      for (const tf of timeframes) {
        const buffer = manager.getBuffer(tf);
        expect(buffer.timeframe).toBe(tf);
        expect(buffer.candles).toEqual([]);
        expect(buffer.sma20Volume).toBe(0);
      }
    });

    it('should set correct max sizes for each timeframe', () => {
      expect(manager.getBuffer('M1').maxSize).toBe(500);
      expect(manager.getBuffer('M5').maxSize).toBe(200);
      expect(manager.getBuffer('M15').maxSize).toBe(100);
      expect(manager.getBuffer('H1').maxSize).toBe(50);
    });
  });

  describe('addCandle', () => {
    it('should add a candle to the correct buffer', () => {
      const candle = makeCandle('M5', 1000);
      manager.addCandle(candle);

      const buffer = manager.getBuffer('M5');
      expect(buffer.candles).toHaveLength(1);
      expect(buffer.candles[0]).toEqual(candle);
    });

    it('should not affect other buffers when adding a candle', () => {
      const candle = makeCandle('M5', 1000);
      manager.addCandle(candle);

      expect(manager.getBuffer('M1').candles).toHaveLength(0);
      expect(manager.getBuffer('M15').candles).toHaveLength(0);
      expect(manager.getBuffer('H1').candles).toHaveLength(0);
    });

    it('should evict the oldest candle when buffer is full (M5: 200)', () => {
      // Fill the M5 buffer to capacity
      for (let i = 0; i < 200; i++) {
        manager.addCandle(makeCandle('M5', i + 1));
      }
      expect(manager.getBuffer('M5').candles).toHaveLength(200);

      // Add one more - oldest should be evicted
      const newCandle = makeCandle('M5', 999);
      manager.addCandle(newCandle);

      const buffer = manager.getBuffer('M5');
      expect(buffer.candles).toHaveLength(200);
      // First candle's volume was 1, now it should be 2 (second oldest becomes first)
      expect(buffer.candles[0].volume).toBe(2);
      // Last candle should be the new one
      expect(buffer.candles[199].volume).toBe(999);
    });

    it('should evict the oldest candle when M1 buffer is full (500)', () => {
      for (let i = 0; i < 500; i++) {
        manager.addCandle(makeCandle('M1', i + 1));
      }
      expect(manager.getBuffer('M1').candles).toHaveLength(500);

      manager.addCandle(makeCandle('M1', 777));
      const buffer = manager.getBuffer('M1');
      expect(buffer.candles).toHaveLength(500);
      expect(buffer.candles[0].volume).toBe(2);
      expect(buffer.candles[499].volume).toBe(777);
    });

    it('should evict the oldest candle when M15 buffer is full (100)', () => {
      for (let i = 0; i < 100; i++) {
        manager.addCandle(makeCandle('M15', i + 1));
      }
      manager.addCandle(makeCandle('M15', 888));
      const buffer = manager.getBuffer('M15');
      expect(buffer.candles).toHaveLength(100);
      expect(buffer.candles[0].volume).toBe(2);
      expect(buffer.candles[99].volume).toBe(888);
    });

    it('should evict the oldest candle when H1 buffer is full (50)', () => {
      for (let i = 0; i < 50; i++) {
        manager.addCandle(makeCandle('H1', i + 1));
      }
      manager.addCandle(makeCandle('H1', 555));
      const buffer = manager.getBuffer('H1');
      expect(buffer.candles).toHaveLength(50);
      expect(buffer.candles[0].volume).toBe(2);
      expect(buffer.candles[49].volume).toBe(555);
    });
  });

  describe('SMA-20 volume calculation', () => {
    it('should return 0 when no M5 candles exist', () => {
      expect(manager.getSma20Volume()).toBe(0);
    });

    it('should calculate SMA with fewer than 20 candles (uses available)', () => {
      // Add 5 candles with volumes 10, 20, 30, 40, 50
      for (let i = 1; i <= 5; i++) {
        manager.addCandle(makeCandle('M5', i * 10));
      }
      // SMA = (10 + 20 + 30 + 40 + 50) / 5 = 150 / 5 = 30
      expect(manager.getSma20Volume()).toBe(30);
    });

    it('should calculate SMA with exactly 20 candles', () => {
      // Add 20 candles each with volume 100
      for (let i = 0; i < 20; i++) {
        manager.addCandle(makeCandle('M5', 100));
      }
      expect(manager.getSma20Volume()).toBe(100);
    });

    it('should use only the last 20 candles when more than 20 exist', () => {
      // Add 25 candles: first 5 with volume 1000, next 20 with volume 50
      for (let i = 0; i < 5; i++) {
        manager.addCandle(makeCandle('M5', 1000));
      }
      for (let i = 0; i < 20; i++) {
        manager.addCandle(makeCandle('M5', 50));
      }
      // SMA should use only the last 20 candles (all volume 50)
      expect(manager.getSma20Volume()).toBe(50);
    });

    it('should recalculate SMA on every new M5 candle addition', () => {
      // Add a single candle with volume 100
      manager.addCandle(makeCandle('M5', 100));
      expect(manager.getSma20Volume()).toBe(100);

      // Add another candle with volume 200
      manager.addCandle(makeCandle('M5', 200));
      // SMA = (100 + 200) / 2 = 150
      expect(manager.getSma20Volume()).toBe(150);

      // Add another candle with volume 300
      manager.addCandle(makeCandle('M5', 300));
      // SMA = (100 + 200 + 300) / 3 = 200
      expect(manager.getSma20Volume()).toBe(200);
    });

    it('should not recalculate SMA when non-M5 candles are added', () => {
      manager.addCandle(makeCandle('M5', 100));
      expect(manager.getSma20Volume()).toBe(100);

      // Adding non-M5 candles should not change M5 SMA
      manager.addCandle(makeCandle('M1', 5000));
      manager.addCandle(makeCandle('M15', 3000));
      manager.addCandle(makeCandle('H1', 8000));

      expect(manager.getSma20Volume()).toBe(100);
    });

    it('should correctly compute rolling SMA as old candles are evicted', () => {
      // Fill buffer past 200 to test eviction doesn't break SMA
      for (let i = 1; i <= 210; i++) {
        manager.addCandle(makeCandle('M5', i * 10));
      }

      // The buffer should have candles with volumes from 110 to 2100 (indices 11-210)
      // Last 20 candles: volumes 1910, 1920, ..., 2100
      // SMA = sum(1910 to 2100 step 10) / 20
      // Sum = 20 * (1910 + 2100) / 2 = 20 * 2005 = 40100
      // SMA = 40100 / 20 = 2005
      expect(manager.getSma20Volume()).toBe(2005);
    });
  });

  describe('getBuffer', () => {
    it('should return the correct buffer for each timeframe', () => {
      manager.addCandle(makeCandle('M5', 100));
      manager.addCandle(makeCandle('H1', 200));

      expect(manager.getBuffer('M5').candles).toHaveLength(1);
      expect(manager.getBuffer('H1').candles).toHaveLength(1);
      expect(manager.getBuffer('M1').candles).toHaveLength(0);
      expect(manager.getBuffer('M15').candles).toHaveLength(0);
    });
  });

  describe('getSma20Volume', () => {
    it('should return the same value as the M5 buffer sma20Volume field', () => {
      for (let i = 0; i < 10; i++) {
        manager.addCandle(makeCandle('M5', (i + 1) * 50));
      }
      const buffer = manager.getBuffer('M5');
      expect(manager.getSma20Volume()).toBe(buffer.sma20Volume);
    });
  });

  describe('getLatestCandles', () => {
    it('should return the last N candles', () => {
      for (let i = 1; i <= 10; i++) {
        manager.addCandle(makeCandle('M5', i * 10));
      }

      const latest3 = manager.getLatestCandles('M5', 3);
      expect(latest3).toHaveLength(3);
      expect(latest3[0].volume).toBe(80);
      expect(latest3[1].volume).toBe(90);
      expect(latest3[2].volume).toBe(100);
    });

    it('should return all available candles if fewer than N exist', () => {
      manager.addCandle(makeCandle('M5', 50));
      manager.addCandle(makeCandle('M5', 60));

      const latest5 = manager.getLatestCandles('M5', 5);
      expect(latest5).toHaveLength(2);
      expect(latest5[0].volume).toBe(50);
      expect(latest5[1].volume).toBe(60);
    });

    it('should return empty array for timeframe with no candles', () => {
      const result = manager.getLatestCandles('H1', 5);
      expect(result).toEqual([]);
    });

    it('should return exactly N candles when buffer has more than N', () => {
      for (let i = 1; i <= 50; i++) {
        manager.addCandle(makeCandle('M15', i));
      }
      const latest10 = manager.getLatestCandles('M15', 10);
      expect(latest10).toHaveLength(10);
      expect(latest10[0].volume).toBe(41);
      expect(latest10[9].volume).toBe(50);
    });
  });

  describe('getVolumeTrend', () => {
    it('should return the last N M5 candle volumes', () => {
      for (let i = 1; i <= 10; i++) {
        manager.addCandle(makeCandle('M5', i * 100));
      }

      const trend = manager.getVolumeTrend(5);
      expect(trend).toEqual([600, 700, 800, 900, 1000]);
    });

    it('should return all available M5 volumes if fewer than N exist', () => {
      manager.addCandle(makeCandle('M5', 100));
      manager.addCandle(makeCandle('M5', 200));

      const trend = manager.getVolumeTrend(5);
      expect(trend).toEqual([100, 200]);
    });

    it('should return empty array if no M5 candles exist', () => {
      const trend = manager.getVolumeTrend(5);
      expect(trend).toEqual([]);
    });

    it('should not include non-M5 candles in volume trend', () => {
      manager.addCandle(makeCandle('M5', 100));
      manager.addCandle(makeCandle('M1', 5000));
      manager.addCandle(makeCandle('M5', 200));

      const trend = manager.getVolumeTrend(5);
      expect(trend).toEqual([100, 200]);
    });
  });
});
