import { describe, expect, it } from 'vitest';
import { getInstrumentMetadata, isSupportedInstrument } from './instrument.js';

describe('instrument metadata', () => {
  it('supports XAU/USD and BTC/USD with separate TradingView sources', () => {
    const xau = getInstrumentMetadata('XAUUSD');
    const btc = getInstrumentMetadata('BTCUSD');

    expect(xau.tradingViewScannerUrl).toContain('/cfd/scan');
    expect(xau.tradingViewTicker).toBe('OANDA:XAUUSD');
    expect(btc.tradingViewScannerUrl).toContain('/crypto/scan');
    expect(btc.tradingViewTicker).toBe('COINBASE:BTCUSD');
  });

  it('does not reuse XAU price units for BTC/USD', () => {
    expect(getInstrumentMetadata('XAUUSD').pipSize).toBe(0.1);
    expect(getInstrumentMetadata('BTCUSD').pipSize).toBe(1);
    expect(getInstrumentMetadata('BTCUSD').breakthroughSize).toBe(1);
  });

  it('rejects unsupported instruments', () => {
    expect(isSupportedInstrument('EURUSD')).toBe(false);
    expect(isSupportedInstrument('BTC/USD')).toBe(false);
  });
});
