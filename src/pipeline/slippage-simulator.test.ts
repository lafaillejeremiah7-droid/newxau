/**
 * Tests for the Slippage Simulator module.
 *
 * Validates:
 * - 20% probability selection logic
 * - Slippage amount within [0.5, 2.5] pips when applied
 * - Adverse direction (worse fill) for both long and short signals
 * - No slippage case returns original entry unchanged
 * - Dependency injection of random function works correctly
 *
 * Requirements: 10.1, 10.2, 10.6
 */

import { describe, it, expect } from 'vitest';
import {
  createSlippageSimulator,
  type SlippageInput,
} from './slippage-simulator.js';

describe('SlippageSimulator', () => {
  describe('slippage selection (20% probability)', () => {
    it('should apply slippage when random value is below 0.2', () => {
      // First call returns 0.1 (< 0.2, apply slippage), second returns 0.5 (amount)
      let callCount = 0;
      const mockRandom = () => {
        callCount++;
        return callCount === 1 ? 0.1 : 0.5;
      };

      const simulator = createSlippageSimulator(mockRandom);
      const signal: SlippageInput = { entryPrice: 2000, direction: 'long' };
      const result = simulator.applySlippage(signal);

      expect(result.applied).toBe(true);
    });

    it('should NOT apply slippage when random value is at or above 0.2', () => {
      const mockRandom = () => 0.2; // exactly 0.2 = NOT applied (< 0.2 is the condition)
      const simulator = createSlippageSimulator(mockRandom);
      const signal: SlippageInput = { entryPrice: 2000, direction: 'long' };
      const result = simulator.applySlippage(signal);

      expect(result.applied).toBe(false);
      expect(result.adjustedEntry).toBe(2000);
      expect(result.slippagePips).toBe(0);
    });

    it('should NOT apply slippage when random value is 0.99', () => {
      const mockRandom = () => 0.99;
      const simulator = createSlippageSimulator(mockRandom);
      const signal: SlippageInput = { entryPrice: 1950, direction: 'short' };
      const result = simulator.applySlippage(signal);

      expect(result.applied).toBe(false);
      expect(result.adjustedEntry).toBe(1950);
      expect(result.slippagePips).toBe(0);
    });

    it('should apply slippage when random value is 0 (edge case)', () => {
      let callCount = 0;
      const mockRandom = () => {
        callCount++;
        return callCount === 1 ? 0.0 : 0.5;
      };
      const simulator = createSlippageSimulator(mockRandom);
      const signal: SlippageInput = { entryPrice: 2000, direction: 'long' };
      const result = simulator.applySlippage(signal);

      expect(result.applied).toBe(true);
    });

    it('should apply slippage when random value is 0.19999 (just below threshold)', () => {
      let callCount = 0;
      const mockRandom = () => {
        callCount++;
        return callCount === 1 ? 0.19999 : 0.5;
      };
      const simulator = createSlippageSimulator(mockRandom);
      const signal: SlippageInput = { entryPrice: 2000, direction: 'long' };
      const result = simulator.applySlippage(signal);

      expect(result.applied).toBe(true);
    });
  });

  describe('slippage amount calculation', () => {
    it('should produce minimum slippage (0.5 pips) when amount roll is 0', () => {
      let callCount = 0;
      const mockRandom = () => {
        callCount++;
        return callCount === 1 ? 0.0 : 0.0; // selection=apply, amount=min
      };
      const simulator = createSlippageSimulator(mockRandom);
      const signal: SlippageInput = { entryPrice: 2000, direction: 'long' };
      const result = simulator.applySlippage(signal);

      expect(result.applied).toBe(true);
      expect(result.slippagePips).toBeCloseTo(0.5, 10);
    });

    it('should produce maximum slippage (2.5 pips) when amount roll approaches 1', () => {
      let callCount = 0;
      const mockRandom = () => {
        callCount++;
        return callCount === 1 ? 0.0 : 0.9999999;
      };
      const simulator = createSlippageSimulator(mockRandom);
      const signal: SlippageInput = { entryPrice: 2000, direction: 'long' };
      const result = simulator.applySlippage(signal);

      expect(result.applied).toBe(true);
      expect(result.slippagePips).toBeCloseTo(2.5, 3);
    });

    it('should produce midpoint slippage (1.5 pips) when amount roll is 0.5', () => {
      let callCount = 0;
      const mockRandom = () => {
        callCount++;
        return callCount === 1 ? 0.0 : 0.5; // selection=apply, amount=midpoint
      };
      const simulator = createSlippageSimulator(mockRandom);
      const signal: SlippageInput = { entryPrice: 2000, direction: 'long' };
      const result = simulator.applySlippage(signal);

      expect(result.applied).toBe(true);
      // 0.5 + 0.5 * (2.5 - 0.5) = 0.5 + 1.0 = 1.5
      expect(result.slippagePips).toBeCloseTo(1.5, 10);
    });
  });

  describe('slippage direction (adverse to trade)', () => {
    it('should increase entry for LONG signals (worse fill = higher entry)', () => {
      let callCount = 0;
      const mockRandom = () => {
        callCount++;
        return callCount === 1 ? 0.1 : 0.5; // apply, midpoint slippage
      };
      const simulator = createSlippageSimulator(mockRandom);
      const signal: SlippageInput = { entryPrice: 2000, direction: 'long' };
      const result = simulator.applySlippage(signal);

      expect(result.applied).toBe(true);
      expect(result.originalEntry).toBe(2000);
      // 1.5 pips * 0.1 = 0.15 price units
      expect(result.adjustedEntry).toBeCloseTo(2000.15, 10);
      expect(result.adjustedEntry).toBeGreaterThan(result.originalEntry);
    });

    it('should decrease entry for SHORT signals (worse fill = lower entry)', () => {
      let callCount = 0;
      const mockRandom = () => {
        callCount++;
        return callCount === 1 ? 0.1 : 0.5; // apply, midpoint slippage
      };
      const simulator = createSlippageSimulator(mockRandom);
      const signal: SlippageInput = { entryPrice: 2000, direction: 'short' };
      const result = simulator.applySlippage(signal);

      expect(result.applied).toBe(true);
      expect(result.originalEntry).toBe(2000);
      // 1.5 pips * 0.1 = 0.15 price units
      expect(result.adjustedEntry).toBeCloseTo(1999.85, 10);
      expect(result.adjustedEntry).toBeLessThan(result.originalEntry);
    });
  });

  describe('no slippage case', () => {
    it('should return original entry unchanged when not applied', () => {
      const mockRandom = () => 0.5; // > 0.2, no slippage
      const simulator = createSlippageSimulator(mockRandom);
      const signal: SlippageInput = { entryPrice: 2050.75, direction: 'long' };
      const result = simulator.applySlippage(signal);

      expect(result.applied).toBe(false);
      expect(result.originalEntry).toBe(2050.75);
      expect(result.adjustedEntry).toBe(2050.75);
      expect(result.slippagePips).toBe(0);
    });
  });

  describe('SlippageResult completeness', () => {
    it('should return all required fields when slippage is applied', () => {
      let callCount = 0;
      const mockRandom = () => {
        callCount++;
        return callCount === 1 ? 0.05 : 0.75;
      };
      const simulator = createSlippageSimulator(mockRandom);
      const signal: SlippageInput = { entryPrice: 1980, direction: 'short' };
      const result = simulator.applySlippage(signal);

      expect(result).toHaveProperty('applied');
      expect(result).toHaveProperty('originalEntry');
      expect(result).toHaveProperty('adjustedEntry');
      expect(result).toHaveProperty('slippagePips');
      expect(typeof result.applied).toBe('boolean');
      expect(typeof result.originalEntry).toBe('number');
      expect(typeof result.adjustedEntry).toBe('number');
      expect(typeof result.slippagePips).toBe('number');
    });

    it('should return all required fields when slippage is NOT applied', () => {
      const mockRandom = () => 0.8;
      const simulator = createSlippageSimulator(mockRandom);
      const signal: SlippageInput = { entryPrice: 1980, direction: 'long' };
      const result = simulator.applySlippage(signal);

      expect(result).toHaveProperty('applied');
      expect(result).toHaveProperty('originalEntry');
      expect(result).toHaveProperty('adjustedEntry');
      expect(result).toHaveProperty('slippagePips');
      expect(typeof result.applied).toBe('boolean');
      expect(typeof result.originalEntry).toBe('number');
      expect(typeof result.adjustedEntry).toBe('number');
      expect(typeof result.slippagePips).toBe('number');
    });
  });

  describe('pip to price conversion', () => {
    it('should convert pips to price correctly (1 pip = 0.1 price units)', () => {
      // Force slippage of exactly 1.0 pip: amount roll = (1.0 - 0.5) / (2.5 - 0.5) = 0.25
      let callCount = 0;
      const mockRandom = () => {
        callCount++;
        return callCount === 1 ? 0.0 : 0.25;
      };
      const simulator = createSlippageSimulator(mockRandom);
      const signal: SlippageInput = { entryPrice: 2000, direction: 'long' };
      const result = simulator.applySlippage(signal);

      // 1.0 pip * 0.1 = 0.10 price units
      expect(result.slippagePips).toBeCloseTo(1.0, 10);
      expect(result.adjustedEntry).toBeCloseTo(2000.10, 10);
    });

    it('should handle 2.0 pip slippage correctly', () => {
      // amount roll = (2.0 - 0.5) / (2.5 - 0.5) = 0.75
      let callCount = 0;
      const mockRandom = () => {
        callCount++;
        return callCount === 1 ? 0.0 : 0.75;
      };
      const simulator = createSlippageSimulator(mockRandom);
      const signal: SlippageInput = { entryPrice: 2000, direction: 'short' };
      const result = simulator.applySlippage(signal);

      // 2.0 pips * 0.1 = 0.20 price units, adverse for short = lower
      expect(result.slippagePips).toBeCloseTo(2.0, 10);
      expect(result.adjustedEntry).toBeCloseTo(1999.80, 10);
    });
  });

  describe('custom configuration', () => {
    it('should respect custom probability', () => {
      // With 50% probability, random value 0.3 should trigger slippage
      let callCount = 0;
      const mockRandom = () => {
        callCount++;
        return callCount === 1 ? 0.3 : 0.5;
      };
      const simulator = createSlippageSimulator(mockRandom, {
        probability: 0.5,
      });
      const signal: SlippageInput = { entryPrice: 2000, direction: 'long' };
      const result = simulator.applySlippage(signal);

      expect(result.applied).toBe(true);
    });

    it('should respect custom pip range', () => {
      let callCount = 0;
      const mockRandom = () => {
        callCount++;
        return callCount === 1 ? 0.0 : 0.5; // midpoint
      };
      const simulator = createSlippageSimulator(mockRandom, {
        minPips: 1.0,
        maxPips: 3.0,
      });
      const signal: SlippageInput = { entryPrice: 2000, direction: 'long' };
      const result = simulator.applySlippage(signal);

      // midpoint: 1.0 + 0.5 * (3.0 - 1.0) = 2.0 pips
      expect(result.slippagePips).toBeCloseTo(2.0, 10);
    });
  });
});
