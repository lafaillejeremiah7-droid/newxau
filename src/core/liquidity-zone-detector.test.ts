/**
 * Unit tests for LiquidityZoneDetector.
 *
 * Tests cover:
 * - Structural high and low detection from H1/M15 candles
 * - Ignoring M1 and M5 candles
 * - Zone boundary definitions (candle high-low range)
 * - isWithinZone() price containment checks
 * - Zone capacity management (max zones per timeframe)
 * - Zone updates as new candles arrive
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LiquidityZoneDetector } from './liquidity-zone-detector.js';
import { Candle } from '../types/candle.js';

/** Helper to create a candle with specified OHLCV values */
function makeCandle(params: {
  high: number;
  low: number;
  open?: number;
  close?: number;
  volume?: number;
  timeframe?: Candle['timeframe'];
  timestamp?: string;
}): Candle {
  return {
    instrument: 'XAUUSD',
    timeframe: params.timeframe ?? 'H1',
    timestamp: params.timestamp ?? new Date().toISOString(),
    open: params.open ?? (params.high + params.low) / 2,
    high: params.high,
    low: params.low,
    close: params.close ?? (params.high + params.low) / 2,
    volume: params.volume ?? 100,
  };
}

describe('LiquidityZoneDetector', () => {
  let detector: LiquidityZoneDetector;

  beforeEach(() => {
    detector = new LiquidityZoneDetector();
  });

  describe('updateZones - H1 candles', () => {
    it('should detect a structural high (swing high) from H1 candles', () => {
      // prev.high < current.high > next.high
      const candles: Candle[] = [
        makeCandle({ high: 2000, low: 1990, timeframe: 'H1', timestamp: '2024-01-01T01:00:00.000Z' }),
        makeCandle({ high: 2010, low: 1995, timeframe: 'H1', timestamp: '2024-01-01T02:00:00.000Z' }),
        makeCandle({ high: 2005, low: 1992, timeframe: 'H1', timestamp: '2024-01-01T03:00:00.000Z' }),
      ];

      candles.forEach((c) => detector.updateZones(c));

      const zones = detector.getActiveZones();
      expect(zones).toHaveLength(1);
      expect(zones[0].type).toBe('structural_high');
      expect(zones[0].timeframe).toBe('H1');
      expect(zones[0].upperBoundary).toBe(2010);
      expect(zones[0].lowerBoundary).toBe(1995);
      expect(zones[0].identifiedAt).toBe('2024-01-01T02:00:00.000Z');
    });

    it('should detect a structural low (swing low) from H1 candles', () => {
      // prev.low > current.low < next.low
      const candles: Candle[] = [
        makeCandle({ high: 2000, low: 1990, timeframe: 'H1', timestamp: '2024-01-01T01:00:00.000Z' }),
        makeCandle({ high: 1998, low: 1980, timeframe: 'H1', timestamp: '2024-01-01T02:00:00.000Z' }),
        makeCandle({ high: 2002, low: 1985, timeframe: 'H1', timestamp: '2024-01-01T03:00:00.000Z' }),
      ];

      candles.forEach((c) => detector.updateZones(c));

      const zones = detector.getActiveZones();
      expect(zones).toHaveLength(1);
      expect(zones[0].type).toBe('structural_low');
      expect(zones[0].timeframe).toBe('H1');
      expect(zones[0].upperBoundary).toBe(1998);
      expect(zones[0].lowerBoundary).toBe(1980);
    });

    it('should detect both structural high and structural low on the same candle', () => {
      // A candle that is both a swing high and swing low (island candle)
      const candles: Candle[] = [
        makeCandle({ high: 2000, low: 1990, timeframe: 'H1', timestamp: '2024-01-01T01:00:00.000Z' }),
        makeCandle({ high: 2010, low: 1980, timeframe: 'H1', timestamp: '2024-01-01T02:00:00.000Z' }),
        makeCandle({ high: 2005, low: 1985, timeframe: 'H1', timestamp: '2024-01-01T03:00:00.000Z' }),
      ];

      candles.forEach((c) => detector.updateZones(c));

      const zones = detector.getActiveZones();
      expect(zones).toHaveLength(2);
      expect(zones.map((z) => z.type).sort()).toEqual([
        'structural_high',
        'structural_low',
      ]);
    });

    it('should not detect a swing point when highs/lows are equal', () => {
      // Equal highs — no swing high
      const candles: Candle[] = [
        makeCandle({ high: 2000, low: 1990, timeframe: 'H1' }),
        makeCandle({ high: 2000, low: 1988, timeframe: 'H1' }),
        makeCandle({ high: 1998, low: 1985, timeframe: 'H1' }),
      ];

      candles.forEach((c) => detector.updateZones(c));
      const zones = detector.getActiveZones();
      // No structural high since current.high is not strictly greater than prev.high
      // But there might be a structural low if 1988 < 1990 and 1988 < 1985 -> not true (1988 > 1985)
      expect(zones.filter((z) => z.type === 'structural_high')).toHaveLength(0);
    });
  });

  describe('updateZones - M15 candles', () => {
    it('should detect structural high from M15 candles', () => {
      const candles: Candle[] = [
        makeCandle({ high: 1950, low: 1945, timeframe: 'M15', timestamp: '2024-01-01T00:15:00.000Z' }),
        makeCandle({ high: 1960, low: 1948, timeframe: 'M15', timestamp: '2024-01-01T00:30:00.000Z' }),
        makeCandle({ high: 1955, low: 1947, timeframe: 'M15', timestamp: '2024-01-01T00:45:00.000Z' }),
      ];

      candles.forEach((c) => detector.updateZones(c));

      const zones = detector.getActiveZones();
      expect(zones).toHaveLength(1);
      expect(zones[0].type).toBe('structural_high');
      expect(zones[0].timeframe).toBe('M15');
      expect(zones[0].upperBoundary).toBe(1960);
      expect(zones[0].lowerBoundary).toBe(1948);
    });

    it('should detect structural low from M15 candles', () => {
      const candles: Candle[] = [
        makeCandle({ high: 1950, low: 1945, timeframe: 'M15', timestamp: '2024-01-01T00:15:00.000Z' }),
        makeCandle({ high: 1948, low: 1940, timeframe: 'M15', timestamp: '2024-01-01T00:30:00.000Z' }),
        makeCandle({ high: 1952, low: 1942, timeframe: 'M15', timestamp: '2024-01-01T00:45:00.000Z' }),
      ];

      candles.forEach((c) => detector.updateZones(c));

      const zones = detector.getActiveZones();
      expect(zones).toHaveLength(1);
      expect(zones[0].type).toBe('structural_low');
      expect(zones[0].timeframe).toBe('M15');
      expect(zones[0].upperBoundary).toBe(1948);
      expect(zones[0].lowerBoundary).toBe(1940);
    });
  });

  describe('updateZones - ignores M1 and M5 candles', () => {
    it('should not create zones from M1 candles', () => {
      const candles: Candle[] = [
        makeCandle({ high: 2000, low: 1990, timeframe: 'M1' }),
        makeCandle({ high: 2010, low: 1995, timeframe: 'M1' }),
        makeCandle({ high: 2005, low: 1992, timeframe: 'M1' }),
      ];

      candles.forEach((c) => detector.updateZones(c));
      expect(detector.getActiveZones()).toHaveLength(0);
    });

    it('should not create zones from M5 candles', () => {
      const candles: Candle[] = [
        makeCandle({ high: 2000, low: 1990, timeframe: 'M5' }),
        makeCandle({ high: 2010, low: 1995, timeframe: 'M5' }),
        makeCandle({ high: 2005, low: 1992, timeframe: 'M5' }),
      ];

      candles.forEach((c) => detector.updateZones(c));
      expect(detector.getActiveZones()).toHaveLength(0);
    });
  });

  describe('updateZones - requires 3 candles minimum', () => {
    it('should not detect zones with only 1 candle', () => {
      detector.updateZones(makeCandle({ high: 2010, low: 1990, timeframe: 'H1' }));
      expect(detector.getActiveZones()).toHaveLength(0);
    });

    it('should not detect zones with only 2 candles', () => {
      detector.updateZones(makeCandle({ high: 2000, low: 1990, timeframe: 'H1' }));
      detector.updateZones(makeCandle({ high: 2010, low: 1995, timeframe: 'H1' }));
      expect(detector.getActiveZones()).toHaveLength(0);
    });
  });

  describe('updateZones - multiple swing points over time', () => {
    it('should detect multiple swing highs as candles arrive', () => {
      // First swing high: candle at index 1 (high=2010), prev=2000, next=2005
      detector.updateZones(makeCandle({ high: 2000, low: 1990, timeframe: 'H1', timestamp: '2024-01-01T01:00:00.000Z' }));
      detector.updateZones(makeCandle({ high: 2010, low: 1995, timeframe: 'H1', timestamp: '2024-01-01T02:00:00.000Z' }));
      detector.updateZones(makeCandle({ high: 2005, low: 1995, timeframe: 'H1', timestamp: '2024-01-01T03:00:00.000Z' }));

      expect(detector.getActiveZones()).toHaveLength(1);

      // Add more candles to form a second swing high
      // candle at index 2 (high=2005): prev.high=2010 → NOT swing high (2005 < 2010)
      // candle at index 2 (low=1995): prev.low=1995, next.low=1998 → 1995 not < 1995 → NOT swing low
      detector.updateZones(makeCandle({ high: 2015, low: 1998, timeframe: 'H1', timestamp: '2024-01-01T04:00:00.000Z' }));
      // candle at index 3 (high=2015): prev.high=2005, next.high=2008 → swing high ✓
      detector.updateZones(makeCandle({ high: 2008, low: 1996, timeframe: 'H1', timestamp: '2024-01-01T05:00:00.000Z' }));

      const highZones = detector.getActiveZones().filter((z) => z.type === 'structural_high');
      expect(highZones).toHaveLength(2);
      expect(highZones[0].upperBoundary).toBe(2010);
      expect(highZones[1].upperBoundary).toBe(2015);
    });
  });

  describe('isWithinZone', () => {
    it('should return the zone when price is within boundaries', () => {
      // Create a structural high zone with boundaries [1995, 2010]
      const candles: Candle[] = [
        makeCandle({ high: 2000, low: 1990, timeframe: 'H1' }),
        makeCandle({ high: 2010, low: 1995, timeframe: 'H1' }),
        makeCandle({ high: 2005, low: 1992, timeframe: 'H1' }),
      ];
      candles.forEach((c) => detector.updateZones(c));

      const result = detector.isWithinZone(2000);
      expect(result).not.toBeNull();
      expect(result!.upperBoundary).toBe(2010);
      expect(result!.lowerBoundary).toBe(1995);
    });

    it('should return the zone when price is exactly at upper boundary', () => {
      const candles: Candle[] = [
        makeCandle({ high: 2000, low: 1990, timeframe: 'H1' }),
        makeCandle({ high: 2010, low: 1995, timeframe: 'H1' }),
        makeCandle({ high: 2005, low: 1992, timeframe: 'H1' }),
      ];
      candles.forEach((c) => detector.updateZones(c));

      const result = detector.isWithinZone(2010);
      expect(result).not.toBeNull();
    });

    it('should return the zone when price is exactly at lower boundary', () => {
      const candles: Candle[] = [
        makeCandle({ high: 2000, low: 1990, timeframe: 'H1' }),
        makeCandle({ high: 2010, low: 1995, timeframe: 'H1' }),
        makeCandle({ high: 2005, low: 1992, timeframe: 'H1' }),
      ];
      candles.forEach((c) => detector.updateZones(c));

      const result = detector.isWithinZone(1995);
      expect(result).not.toBeNull();
    });

    it('should return null when price is above all zone boundaries', () => {
      const candles: Candle[] = [
        makeCandle({ high: 2000, low: 1990, timeframe: 'H1' }),
        makeCandle({ high: 2010, low: 1995, timeframe: 'H1' }),
        makeCandle({ high: 2005, low: 1992, timeframe: 'H1' }),
      ];
      candles.forEach((c) => detector.updateZones(c));

      const result = detector.isWithinZone(2020);
      expect(result).toBeNull();
    });

    it('should return null when price is below all zone boundaries', () => {
      const candles: Candle[] = [
        makeCandle({ high: 2000, low: 1990, timeframe: 'H1' }),
        makeCandle({ high: 2010, low: 1995, timeframe: 'H1' }),
        makeCandle({ high: 2005, low: 1992, timeframe: 'H1' }),
      ];
      candles.forEach((c) => detector.updateZones(c));

      const result = detector.isWithinZone(1990);
      expect(result).toBeNull();
    });

    it('should return null when no zones exist', () => {
      const result = detector.isWithinZone(2000);
      expect(result).toBeNull();
    });

    it('should return the first matching zone when multiple zones contain the price', () => {
      // Create H1 zone
      const h1Candles: Candle[] = [
        makeCandle({ high: 2000, low: 1990, timeframe: 'H1' }),
        makeCandle({ high: 2010, low: 1995, timeframe: 'H1' }),
        makeCandle({ high: 2005, low: 1992, timeframe: 'H1' }),
      ];
      h1Candles.forEach((c) => detector.updateZones(c));

      // Create overlapping M15 zone
      const m15Candles: Candle[] = [
        makeCandle({ high: 2003, low: 1993, timeframe: 'M15' }),
        makeCandle({ high: 2008, low: 1997, timeframe: 'M15' }),
        makeCandle({ high: 2004, low: 1994, timeframe: 'M15' }),
      ];
      m15Candles.forEach((c) => detector.updateZones(c));

      // Price 2000 is within both zones
      const result = detector.isWithinZone(2000);
      expect(result).not.toBeNull();
      // H1 zones are listed first in getActiveZones()
      expect(result!.timeframe).toBe('H1');
    });
  });

  describe('Zone capacity management', () => {
    it('should maintain maximum 10 zones per timeframe by default', () => {
      // Create 12 swing highs for H1
      for (let i = 0; i < 12; i++) {
        const base = 2000 + i * 20;
        detector.updateZones(makeCandle({ high: base, low: base - 10, timeframe: 'H1' }));
        detector.updateZones(makeCandle({ high: base + 10, low: base - 5, timeframe: 'H1' }));
        detector.updateZones(makeCandle({ high: base + 5, low: base - 8, timeframe: 'H1' }));
      }

      const zones = detector.getActiveZones();
      const h1Zones = zones.filter((z) => z.timeframe === 'H1');
      expect(h1Zones.length).toBeLessThanOrEqual(10);
    });

    it('should respect custom maxZonesPerTimeframe configuration', () => {
      const customDetector = new LiquidityZoneDetector({ maxZonesPerTimeframe: 3 });

      // Create 5 swing highs for H1
      for (let i = 0; i < 5; i++) {
        const base = 2000 + i * 20;
        customDetector.updateZones(makeCandle({ high: base, low: base - 10, timeframe: 'H1' }));
        customDetector.updateZones(makeCandle({ high: base + 10, low: base - 5, timeframe: 'H1' }));
        customDetector.updateZones(makeCandle({ high: base + 5, low: base - 8, timeframe: 'H1' }));
      }

      const zones = customDetector.getActiveZones();
      const h1Zones = zones.filter((z) => z.timeframe === 'H1');
      expect(h1Zones.length).toBeLessThanOrEqual(3);
    });

    it('should remove oldest zones when capacity is exceeded', () => {
      const customDetector = new LiquidityZoneDetector({ maxZonesPerTimeframe: 2 });

      // First swing high: high=2010
      customDetector.updateZones(makeCandle({ high: 2000, low: 1990, timeframe: 'H1', timestamp: '2024-01-01T01:00:00.000Z' }));
      customDetector.updateZones(makeCandle({ high: 2010, low: 1995, timeframe: 'H1', timestamp: '2024-01-01T02:00:00.000Z' }));
      customDetector.updateZones(makeCandle({ high: 2005, low: 1992, timeframe: 'H1', timestamp: '2024-01-01T03:00:00.000Z' }));

      // Second swing high: high=2030
      customDetector.updateZones(makeCandle({ high: 2030, low: 2020, timeframe: 'H1', timestamp: '2024-01-01T04:00:00.000Z' }));
      customDetector.updateZones(makeCandle({ high: 2025, low: 2018, timeframe: 'H1', timestamp: '2024-01-01T05:00:00.000Z' }));

      // Third swing high: high=2050
      customDetector.updateZones(makeCandle({ high: 2050, low: 2040, timeframe: 'H1', timestamp: '2024-01-01T06:00:00.000Z' }));
      customDetector.updateZones(makeCandle({ high: 2045, low: 2035, timeframe: 'H1', timestamp: '2024-01-01T07:00:00.000Z' }));

      const zones = customDetector.getActiveZones();
      // With max 2, the oldest zone (high=2010) should have been removed
      expect(zones.length).toBeLessThanOrEqual(2);
      // The first zone (2010) should have been evicted
      const hasFirstZone = zones.some((z) => z.upperBoundary === 2010);
      expect(hasFirstZone).toBe(false);
    });
  });

  describe('Zone ID uniqueness', () => {
    it('should generate unique IDs for each zone', () => {
      // Create multiple zones
      const candles: Candle[] = [
        makeCandle({ high: 2000, low: 1990, timeframe: 'H1' }),
        makeCandle({ high: 2010, low: 1980, timeframe: 'H1' }), // Both swing high and swing low
        makeCandle({ high: 2005, low: 1985, timeframe: 'H1' }),
      ];
      candles.forEach((c) => detector.updateZones(c));

      const zones = detector.getActiveZones();
      const ids = zones.map((z) => z.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });

  describe('Zone boundaries use candle high-low range', () => {
    it('should set zone boundaries to the swing candle high and low', () => {
      // Swing high candle: high=2010, low=1995 → zone = [1995, 2010]
      const candles: Candle[] = [
        makeCandle({ high: 2000, low: 1990, timeframe: 'H1' }),
        makeCandle({ high: 2010, low: 1995, timeframe: 'H1' }),
        makeCandle({ high: 2005, low: 1992, timeframe: 'H1' }),
      ];
      candles.forEach((c) => detector.updateZones(c));

      const zones = detector.getActiveZones();
      expect(zones[0].upperBoundary).toBe(2010);
      expect(zones[0].lowerBoundary).toBe(1995);
    });

    it('should set structural low zone boundaries to the swing candle high and low', () => {
      // Swing low candle: high=1998, low=1980 → zone = [1980, 1998]
      const candles: Candle[] = [
        makeCandle({ high: 2000, low: 1990, timeframe: 'M15' }),
        makeCandle({ high: 1998, low: 1980, timeframe: 'M15' }),
        makeCandle({ high: 2002, low: 1985, timeframe: 'M15' }),
      ];
      candles.forEach((c) => detector.updateZones(c));

      const zones = detector.getActiveZones();
      expect(zones[0].upperBoundary).toBe(1998);
      expect(zones[0].lowerBoundary).toBe(1980);
    });
  });

  describe('Mixed timeframes', () => {
    it('should maintain separate zone lists for H1 and M15', () => {
      // H1 swing high
      detector.updateZones(makeCandle({ high: 2000, low: 1990, timeframe: 'H1' }));
      detector.updateZones(makeCandle({ high: 2010, low: 1995, timeframe: 'H1' }));
      detector.updateZones(makeCandle({ high: 2005, low: 1992, timeframe: 'H1' }));

      // M15 swing low
      detector.updateZones(makeCandle({ high: 1950, low: 1945, timeframe: 'M15' }));
      detector.updateZones(makeCandle({ high: 1948, low: 1940, timeframe: 'M15' }));
      detector.updateZones(makeCandle({ high: 1952, low: 1942, timeframe: 'M15' }));

      const allZones = detector.getActiveZones();
      expect(allZones).toHaveLength(2);

      const h1Zones = allZones.filter((z) => z.timeframe === 'H1');
      const m15Zones = allZones.filter((z) => z.timeframe === 'M15');
      expect(h1Zones).toHaveLength(1);
      expect(m15Zones).toHaveLength(1);
      expect(h1Zones[0].type).toBe('structural_high');
      expect(m15Zones[0].type).toBe('structural_low');
    });

    it('should not have H1 zones affect M15 zone capacity and vice versa', () => {
      const customDetector = new LiquidityZoneDetector({ maxZonesPerTimeframe: 2 });

      // Fill H1 zones to capacity
      for (let i = 0; i < 3; i++) {
        const base = 2000 + i * 20;
        customDetector.updateZones(makeCandle({ high: base, low: base - 10, timeframe: 'H1' }));
        customDetector.updateZones(makeCandle({ high: base + 10, low: base - 5, timeframe: 'H1' }));
        customDetector.updateZones(makeCandle({ high: base + 5, low: base - 8, timeframe: 'H1' }));
      }

      // Add M15 zones — these should not be affected by H1 capacity
      customDetector.updateZones(makeCandle({ high: 1900, low: 1890, timeframe: 'M15' }));
      customDetector.updateZones(makeCandle({ high: 1910, low: 1895, timeframe: 'M15' }));
      customDetector.updateZones(makeCandle({ high: 1905, low: 1892, timeframe: 'M15' }));

      const allZones = customDetector.getActiveZones();
      const h1Zones = allZones.filter((z) => z.timeframe === 'H1');
      const m15Zones = allZones.filter((z) => z.timeframe === 'M15');

      expect(h1Zones.length).toBeLessThanOrEqual(2);
      expect(m15Zones.length).toBeLessThanOrEqual(2);
    });
  });

  describe('Edge cases', () => {
    it('should handle flat market (no swing points detected)', () => {
      // All candles have the same high
      const candles: Candle[] = [
        makeCandle({ high: 2000, low: 1990, timeframe: 'H1' }),
        makeCandle({ high: 2000, low: 1990, timeframe: 'H1' }),
        makeCandle({ high: 2000, low: 1990, timeframe: 'H1' }),
      ];
      candles.forEach((c) => detector.updateZones(c));

      expect(detector.getActiveZones()).toHaveLength(0);
    });

    it('should handle monotonically increasing highs (no swing high)', () => {
      const candles: Candle[] = [
        makeCandle({ high: 2000, low: 1990, timeframe: 'H1' }),
        makeCandle({ high: 2005, low: 1995, timeframe: 'H1' }),
        makeCandle({ high: 2010, low: 2000, timeframe: 'H1' }),
        makeCandle({ high: 2015, low: 2005, timeframe: 'H1' }),
      ];
      candles.forEach((c) => detector.updateZones(c));

      // No swing highs in a monotonically increasing sequence
      const highZones = detector.getActiveZones().filter((z) => z.type === 'structural_high');
      expect(highZones).toHaveLength(0);
    });

    it('should handle monotonically decreasing lows (no swing low)', () => {
      const candles: Candle[] = [
        makeCandle({ high: 2010, low: 2000, timeframe: 'H1' }),
        makeCandle({ high: 2005, low: 1995, timeframe: 'H1' }),
        makeCandle({ high: 2000, low: 1990, timeframe: 'H1' }),
        makeCandle({ high: 1995, low: 1985, timeframe: 'H1' }),
      ];
      candles.forEach((c) => detector.updateZones(c));

      const lowZones = detector.getActiveZones().filter((z) => z.type === 'structural_low');
      expect(lowZones).toHaveLength(0);
    });
  });
});
