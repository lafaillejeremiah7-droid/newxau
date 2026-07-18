/** Supported market instruments and instrument-specific market metadata. */
export type Instrument = 'XAUUSD' | 'BTCUSD';

export interface InstrumentMetadata {
  instrument: Instrument;
  displayName: string;
  tradingViewScannerUrl: string;
  tradingViewTicker: string;
  /** Price units represented by one strategy pip. */
  pipSize: number;
  /** Price-unit threshold used for the FSM zone-breakthrough check. */
  breakthroughSize: number;
  priceDecimals: number;
}

const INSTRUMENTS: Record<Instrument, InstrumentMetadata> = {
  XAUUSD: {
    instrument: 'XAUUSD',
    displayName: 'XAU/USD',
    tradingViewScannerUrl: 'https://scanner.tradingview.com/cfd/scan',
    tradingViewTicker: 'OANDA:XAUUSD',
    pipSize: 0.1,
    // Preserve the existing XAU behavior (0.01 price units).
    breakthroughSize: 0.01,
    priceDecimals: 2,
  },
  BTCUSD: {
    instrument: 'BTCUSD',
    displayName: 'BTC/USD',
    tradingViewScannerUrl: 'https://scanner.tradingview.com/crypto/scan',
    tradingViewTicker: 'COINBASE:BTCUSD',
    // BTC strategy pips are whole-dollar price units; never reuse XAU's 0.1.
    pipSize: 1,
    breakthroughSize: 1,
    priceDecimals: 2,
  },
};

export function isSupportedInstrument(value: string): value is Instrument {
  return value === 'XAUUSD' || value === 'BTCUSD';
}

export function getInstrumentMetadata(instrument: Instrument): InstrumentMetadata {
  return INSTRUMENTS[instrument];
}
