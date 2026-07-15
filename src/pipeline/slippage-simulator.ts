/**
 * Slippage Simulator for the Isagi Engine Signal Bot.
 *
 * Injects realistic slippage on a random 20% of signals for performance
 * simulation accuracy. Slippage is always adverse to the trade direction
 * and applied to the entry price only.
 *
 * For XAU/USD: 1 pip = 0.1 price units.
 *
 * Requirements: 10.1, 10.2, 10.6
 */

import type { SlippageResult } from '../types/signal.js';

/** Input signal data required for slippage calculation */
export interface SlippageInput {
  entryPrice: number;
  direction: 'long' | 'short';
}

/** SlippageSimulator interface */
export interface SlippageSimulator {
  applySlippage(signal: SlippageInput): SlippageResult;
}

/** Configuration for the slippage simulator */
export interface SlippageSimulatorConfig {
  /** Probability of slippage being applied (0-1). Default: 0.2 (20%) */
  probability: number;
  /** Minimum slippage in pips. Default: 0.5 */
  minPips: number;
  /** Maximum slippage in pips. Default: 2.5 */
  maxPips: number;
}

/** Random number generator function type (returns value in [0, 1)) */
export type RandomFn = () => number;

const DEFAULT_CONFIG: SlippageSimulatorConfig = {
  probability: 0.2,
  minPips: 0.5,
  maxPips: 2.5,
};

/** XAU/USD pip value in price units */
const PIP_VALUE = 0.1;

/**
 * Creates a SlippageSimulator instance.
 *
 * Logic:
 * 1. Generate random number [0, 1) — if < probability (20%), apply slippage
 * 2. If applying slippage:
 *    - Generate slippage amount: uniform random in [minPips, maxPips] pips
 *    - Convert to price: slippage_price = slippagePips × 0.1
 *    - For LONG signals: adjustedEntry = originalEntry + slippage_price (worse fill = higher entry)
 *    - For SHORT signals: adjustedEntry = originalEntry - slippage_price (worse fill = lower entry)
 * 3. If not applying: adjustedEntry = originalEntry, slippagePips = 0
 *
 * @param randomFn - Injectable random function for testability. Defaults to Math.random.
 * @param config - Optional configuration overrides.
 */
export function createSlippageSimulator(
  randomFn: RandomFn = Math.random,
  config: Partial<SlippageSimulatorConfig> = {},
): SlippageSimulator {
  const cfg: SlippageSimulatorConfig = { ...DEFAULT_CONFIG, ...config };

  return {
    applySlippage(signal: SlippageInput): SlippageResult {
      const originalEntry = signal.entryPrice;

      // Step 1: Determine whether to apply slippage (uniform 20% probability)
      const selectionRoll = randomFn();
      const shouldApply = selectionRoll < cfg.probability;

      if (!shouldApply) {
        // Step 3: No slippage applied
        return {
          applied: false,
          originalEntry,
          adjustedEntry: originalEntry,
          slippagePips: 0,
        };
      }

      // Step 2: Apply slippage
      // Generate slippage amount: uniform distribution in [minPips, maxPips]
      const amountRoll = randomFn();
      const slippagePips =
        cfg.minPips + amountRoll * (cfg.maxPips - cfg.minPips);

      // Convert pips to price units (1 pip = 0.1 for XAU/USD)
      const slippagePrice = slippagePips * PIP_VALUE;

      // Direction: always adverse to trade direction
      let adjustedEntry: number;
      if (signal.direction === 'long') {
        // Worse fill for longs = higher entry price
        adjustedEntry = originalEntry + slippagePrice;
      } else {
        // Worse fill for shorts = lower entry price
        adjustedEntry = originalEntry - slippagePrice;
      }

      return {
        applied: true,
        originalEntry,
        adjustedEntry,
        slippagePips,
      };
    },
  };
}
