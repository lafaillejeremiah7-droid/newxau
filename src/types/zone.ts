/**
 * Liquidity zone type definitions for the Isagi Engine Signal Bot.
 * Defines zone structures, classifications, and detection helpers.
 */

/** A detected liquidity zone on H1 or M15 timeframe */
export interface LiquidityZone {
  id: string;
  timeframe: 'M15' | 'H1';
  type: 'structural_high' | 'structural_low';
  upperBoundary: number;
  lowerBoundary: number;
  identifiedAt: string;
}

/** Volume-based zone classification for adaptive targets */
export type ZoneClassification = 'expansion_zone' | 'chop_zone';

/** A cluster of candle wicks within a tight price range */
export interface WickCluster {
  price: number;
  wickCount: number;
  range: number;
}

/** An open liquidity pocket (area with no significant volume blocking) */
export interface LiquidityPocket {
  startPrice: number;
  endPrice: number;
  width: number;
}
