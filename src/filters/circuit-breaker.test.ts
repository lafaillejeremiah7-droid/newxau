/**
 * Unit tests for the Circuit Breaker filter.
 *
 * Tests cover:
 * - Triggering on 300+ pip adverse movement against signal direction
 * - Alert generation with correct metadata
 * - 15-minute suppression period
 * - Auto-resume after cooldown
 * - No trigger when no active signal direction
 * - No trigger when movement is below threshold
 * - No trigger when movement is in the same direction as signal
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker } from './circuit-breaker.js';
import { Candle } from '../types/candle.js';

function makeM1Candle(overrides: Partial<Candle> = {}): Candle {
  return {
    instrument: 'XAUUSD',
    timeframe: 'M1',
    timestamp: '2024-01-15T14:30:00.000Z',
    open: 2000.0,
    high: 2005.0,
    low: 1995.0,
    close: 2000.0,
    volume: 100,
    ...overrides,
  };
}

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker();
  });

  describe('processM1Candle', () => {
    it('should not trigger when currentSignalDirection is null', () => {
      const candle = makeM1Candle({ open: 2050.0, close: 2000.0 }); // 500 pip bearish move
      const result = cb.processM1Candle(candle, null, null);
      expect(result).toBeNull();
    });

    it('should trigger on 300+ pip bearish move against long signal', () => {
      // Long signal: adverse = bearish candle where (open - close) >= 30.0 (300 pips)
      const candle = makeM1Candle({
        open: 2030.0,
        close: 2000.0, // 300 pips bearish
        high: 2032.0,
        low: 1998.0,
      });

      const result = cb.processM1Candle(candle, 'long', 'signal-123');

      expect(result).not.toBeNull();
      expect(result!.magnitude).toBe(300);
      expect(result!.affectedSignalId).toBe('signal-123');
      expect(result!.direction).toBe('long');
      expect(result!.timestamp).toBe('2024-01-15T14:30:00.000Z');
    });

    it('should trigger on 300+ pip bullish move against short signal', () => {
      // Short signal: adverse = bullish candle where (close - open) >= 30.0 (300 pips)
      const candle = makeM1Candle({
        open: 2000.0,
        close: 2030.0, // 300 pips bullish
        high: 2032.0,
        low: 1998.0,
      });

      const result = cb.processM1Candle(candle, 'short', 'signal-456');

      expect(result).not.toBeNull();
      expect(result!.magnitude).toBe(300);
      expect(result!.affectedSignalId).toBe('signal-456');
      expect(result!.direction).toBe('short');
    });

    it('should trigger with exact 300 pip threshold (boundary)', () => {
      // Exactly 300 pips = 30.0 points
      const candle = makeM1Candle({
        open: 2030.0,
        close: 2000.0,
        high: 2031.0,
        low: 1999.0,
      });

      const result = cb.processM1Candle(candle, 'long', 'signal-789');

      expect(result).not.toBeNull();
      expect(result!.magnitude).toBe(300);
    });

    it('should trigger with more than 300 pips adverse movement', () => {
      // 500 pips = 50.0 points
      const candle = makeM1Candle({
        open: 2050.0,
        close: 2000.0,
        high: 2052.0,
        low: 1998.0,
      });

      const result = cb.processM1Candle(candle, 'long', 'signal-abc');

      expect(result).not.toBeNull();
      expect(result!.magnitude).toBe(500);
    });

    it('should NOT trigger when movement is below 300 pips (long signal)', () => {
      // 299 pips = 29.9 points (just below threshold)
      const candle = makeM1Candle({
        open: 2029.9,
        close: 2000.0,
        high: 2030.0,
        low: 1999.0,
      });

      const result = cb.processM1Candle(candle, 'long', 'signal-xyz');

      expect(result).toBeNull();
    });

    it('should NOT trigger when movement is below 300 pips (short signal)', () => {
      // 299 pips = 29.9 points
      const candle = makeM1Candle({
        open: 2000.0,
        close: 2029.9,
        high: 2030.0,
        low: 1999.0,
      });

      const result = cb.processM1Candle(candle, 'short', 'signal-xyz');

      expect(result).toBeNull();
    });

    it('should NOT trigger on bullish move with long signal (same direction)', () => {
      // Long signal: bullish move is favorable, not adverse
      const candle = makeM1Candle({
        open: 2000.0,
        close: 2050.0, // 500 pip bullish move
        high: 2052.0,
        low: 1998.0,
      });

      const result = cb.processM1Candle(candle, 'long', 'signal-abc');

      expect(result).toBeNull();
    });

    it('should NOT trigger on bearish move with short signal (same direction)', () => {
      // Short signal: bearish move is favorable, not adverse
      const candle = makeM1Candle({
        open: 2050.0,
        close: 2000.0, // 500 pip bearish move
        high: 2052.0,
        low: 1998.0,
      });

      const result = cb.processM1Candle(candle, 'short', 'signal-abc');

      expect(result).toBeNull();
    });

    it('should set correct suppressionEndsAt (15 minutes after trigger)', () => {
      const candle = makeM1Candle({
        timestamp: '2024-01-15T14:30:00.000Z',
        open: 2030.0,
        close: 2000.0,
      });

      const result = cb.processM1Candle(candle, 'long', 'signal-123');

      expect(result).not.toBeNull();
      expect(result!.suppressionEndsAt).toBe('2024-01-15T14:45:00.000Z');
    });

    it('should handle null signal ID', () => {
      const candle = makeM1Candle({
        open: 2030.0,
        close: 2000.0,
      });

      const result = cb.processM1Candle(candle, 'long', null);

      expect(result).not.toBeNull();
      expect(result!.affectedSignalId).toBeNull();
    });
  });

  describe('isActive', () => {
    it('should return false when no alert has been triggered', () => {
      const now = new Date('2024-01-15T14:35:00.000Z');
      expect(cb.isActive(now)).toBe(false);
    });

    it('should return true within suppression window', () => {
      // Trigger at 14:30, suppression until 14:45
      const candle = makeM1Candle({
        timestamp: '2024-01-15T14:30:00.000Z',
        open: 2030.0,
        close: 2000.0,
      });
      cb.processM1Candle(candle, 'long', 'signal-123');

      // Check at 14:35 (within suppression)
      const checkTime = new Date('2024-01-15T14:35:00.000Z');
      expect(cb.isActive(checkTime)).toBe(true);
    });

    it('should return true 1 second before suppression ends', () => {
      const candle = makeM1Candle({
        timestamp: '2024-01-15T14:30:00.000Z',
        open: 2030.0,
        close: 2000.0,
      });
      cb.processM1Candle(candle, 'long', 'signal-123');

      // Check at 14:44:59 (1 second before suppression ends)
      const checkTime = new Date('2024-01-15T14:44:59.000Z');
      expect(cb.isActive(checkTime)).toBe(true);
    });

    it('should return false exactly when suppression ends', () => {
      const candle = makeM1Candle({
        timestamp: '2024-01-15T14:30:00.000Z',
        open: 2030.0,
        close: 2000.0,
      });
      cb.processM1Candle(candle, 'long', 'signal-123');

      // Check at exactly 14:45:00 (suppression end)
      const checkTime = new Date('2024-01-15T14:45:00.000Z');
      expect(cb.isActive(checkTime)).toBe(false);
    });

    it('should return false after suppression period expires', () => {
      const candle = makeM1Candle({
        timestamp: '2024-01-15T14:30:00.000Z',
        open: 2030.0,
        close: 2000.0,
      });
      cb.processM1Candle(candle, 'long', 'signal-123');

      // Check at 15:00 (well after suppression)
      const checkTime = new Date('2024-01-15T15:00:00.000Z');
      expect(cb.isActive(checkTime)).toBe(false);
    });

    it('should auto-resume after cooldown period', () => {
      const candle = makeM1Candle({
        timestamp: '2024-01-15T14:30:00.000Z',
        open: 2030.0,
        close: 2000.0,
      });
      cb.processM1Candle(candle, 'long', 'signal-123');

      // During suppression
      expect(cb.isActive(new Date('2024-01-15T14:40:00.000Z'))).toBe(true);

      // After cooldown (auto-resume)
      expect(cb.isActive(new Date('2024-01-15T14:46:00.000Z'))).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('should return inactive status when no alert exists', () => {
      const status = cb.getStatus();
      expect(status.active).toBe(false);
      expect(status.expiresAt).toBeNull();
    });

    it('should return active status with expiration during suppression', () => {
      // Use a timestamp in the future so getStatus() sees it as active
      const futureTime = new Date(Date.now() + 60 * 1000); // 1 minute from now
      const candle = makeM1Candle({
        timestamp: futureTime.toISOString(),
        open: 2030.0,
        close: 2000.0,
      });
      cb.processM1Candle(candle, 'long', 'signal-123');

      const status = cb.getStatus();
      expect(status.active).toBe(true);
      const expectedEnd = new Date(futureTime.getTime() + 15 * 60 * 1000);
      expect(status.expiresAt).toBe(expectedEnd.toISOString());
    });
  });

  describe('reset', () => {
    it('should clear the alert and make isActive return false', () => {
      const candle = makeM1Candle({
        timestamp: '2024-01-15T14:30:00.000Z',
        open: 2030.0,
        close: 2000.0,
      });
      cb.processM1Candle(candle, 'long', 'signal-123');

      // Confirm it's active
      expect(cb.isActive(new Date('2024-01-15T14:35:00.000Z'))).toBe(true);

      // Reset
      cb.reset();

      // Should no longer be active
      expect(cb.isActive(new Date('2024-01-15T14:35:00.000Z'))).toBe(false);
    });

    it('should clear status to inactive after reset', () => {
      const candle = makeM1Candle({
        timestamp: '2024-01-15T14:30:00.000Z',
        open: 2030.0,
        close: 2000.0,
      });
      cb.processM1Candle(candle, 'long', 'signal-123');

      cb.reset();

      const status = cb.getStatus();
      expect(status.active).toBe(false);
      expect(status.expiresAt).toBeNull();
    });
  });

  describe('configurable parameters', () => {
    it('should respect custom threshold', () => {
      const customCb = new CircuitBreaker({ thresholdPips: 200 });

      // 200 pips = 20.0 points
      const candle = makeM1Candle({
        open: 2020.0,
        close: 2000.0,
      });

      const result = customCb.processM1Candle(candle, 'long', 'signal-1');
      expect(result).not.toBeNull();
      expect(result!.magnitude).toBe(200);
    });

    it('should respect custom suppression minutes', () => {
      const customCb = new CircuitBreaker({ suppressionMinutes: 30 });

      const candle = makeM1Candle({
        timestamp: '2024-01-15T14:30:00.000Z',
        open: 2030.0,
        close: 2000.0,
      });

      const result = customCb.processM1Candle(candle, 'long', 'signal-1');
      expect(result).not.toBeNull();
      expect(result!.suppressionEndsAt).toBe('2024-01-15T15:00:00.000Z');
    });

    it('should respect custom pip size', () => {
      // If pipSize is 0.01 (e.g., for forex), 300 pips = 3.0 points
      const customCb = new CircuitBreaker({ pipSize: 0.01 });

      const candle = makeM1Candle({
        open: 2003.0,
        close: 2000.0, // 3.0 points = 300 pips with 0.01 pipSize
      });

      const result = customCb.processM1Candle(candle, 'long', 'signal-1');
      expect(result).not.toBeNull();
      expect(result!.magnitude).toBe(300);
    });
  });

  describe('edge cases', () => {
    it('should handle doji candle (open === close) without triggering', () => {
      const candle = makeM1Candle({
        open: 2000.0,
        close: 2000.0,
        high: 2010.0,
        low: 1990.0,
      });

      const resultLong = cb.processM1Candle(candle, 'long', 'signal-1');
      expect(resultLong).toBeNull();

      cb.reset();

      const resultShort = cb.processM1Candle(candle, 'short', 'signal-2');
      expect(resultShort).toBeNull();
    });

    it('should update alert on subsequent trigger (overwrite previous)', () => {
      // First trigger
      const candle1 = makeM1Candle({
        timestamp: '2024-01-15T14:30:00.000Z',
        open: 2030.0,
        close: 2000.0,
      });
      cb.processM1Candle(candle1, 'long', 'signal-1');

      // Second trigger (later)
      const candle2 = makeM1Candle({
        timestamp: '2024-01-15T14:35:00.000Z',
        open: 2040.0,
        close: 2000.0,
      });
      const result = cb.processM1Candle(candle2, 'long', 'signal-2');

      expect(result).not.toBeNull();
      expect(result!.magnitude).toBe(400);
      expect(result!.affectedSignalId).toBe('signal-2');
      expect(result!.timestamp).toBe('2024-01-15T14:35:00.000Z');
      expect(result!.suppressionEndsAt).toBe('2024-01-15T14:50:00.000Z');
    });

    it('should handle very large adverse movements', () => {
      // 1000 pips = 100.0 points
      const candle = makeM1Candle({
        open: 2100.0,
        close: 2000.0,
        high: 2105.0,
        low: 1995.0,
      });

      const result = cb.processM1Candle(candle, 'long', 'signal-1');
      expect(result).not.toBeNull();
      expect(result!.magnitude).toBe(1000);
    });

    it('should correctly calculate magnitude as pips not price', () => {
      // 35.5 point move = 355 pips (with default 0.1 pip size)
      const candle = makeM1Candle({
        open: 2035.5,
        close: 2000.0,
      });

      const result = cb.processM1Candle(candle, 'long', 'signal-1');
      expect(result).not.toBeNull();
      expect(result!.magnitude).toBeCloseTo(355, 0);
    });
  });
});
