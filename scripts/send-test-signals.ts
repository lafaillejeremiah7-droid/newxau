/**
 * Sends clearly labeled Telegram smoke-test signals for both supported instruments.
 *
 * The prices are fetched live from TradingView immediately before sending. The
 * levels are synthetic and the messages explicitly say not to trade.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN="..." TELEGRAM_CHAT_ID="..." npm run telegram:test
 */

import { TelegramNotifier, type TelegramLogger } from '../src/output/telegram-notifier.js';
import type { FormattedSignal } from '../src/types/signal.js';
import type { Instrument } from '../src/config/instrument.js';

interface MarketSpec {
  instrument: Instrument;
  displayName: string;
  scannerUrl: string;
  ticker: string;
  direction: 'long' | 'short';
  stopDistance: number;
  targetDistance: number;
  pipSize: number;
}

interface TradingViewResponse {
  data?: Array<{ d?: number[] }>;
}

const MARKETS: MarketSpec[] = [
  {
    instrument: 'XAUUSD',
    displayName: 'XAU/USD',
    scannerUrl: 'https://scanner.tradingview.com/cfd/scan',
    ticker: 'OANDA:XAUUSD',
    direction: 'long',
    stopDistance: 2.5,
    targetDistance: 7.5,
    pipSize: 0.1,
  },
  {
    instrument: 'BTCUSD',
    displayName: 'BTC/USD',
    scannerUrl: 'https://scanner.tradingview.com/crypto/scan',
    ticker: 'COINBASE:BTCUSD',
    direction: 'short',
    stopDistance: 250,
    targetDistance: 750,
    pipSize: 1,
  },
];

const logger: TelegramLogger = {
  error: (message, context) => console.error(`[Telegram test] ${message}`, context ?? ''),
  warn: (message, context) => console.warn(`[Telegram test] ${message}`, context ?? ''),
  info: (message, context) => console.info(`[Telegram test] ${message}`, context ?? ''),
};

async function fetchLiveClose(market: MarketSpec): Promise<number> {
  const response = await fetch(market.scannerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbols: {
        tickers: [market.ticker],
        query: { types: [] },
      },
      columns: ['close'],
    }),
  });

  if (!response.ok) {
    throw new Error(
      `${market.displayName} TradingView HTTP ${response.status}: ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as TradingViewResponse;
  const close = payload.data?.[0]?.d?.[0];
  if (typeof close !== 'number' || !Number.isFinite(close) || close <= 0) {
    throw new Error(`${market.displayName} returned no valid live close price`);
  }

  return close;
}

function createTestSignal(market: MarketSpec, entryPrice: number): FormattedSignal {
  const { direction, stopDistance, targetDistance } = market;
  const stopLoss = direction === 'long' ? entryPrice - stopDistance : entryPrice + stopDistance;
  const tp2 = direction === 'long' ? entryPrice + targetDistance : entryPrice - targetDistance;
  const tp1 =
    direction === 'long' ? entryPrice + targetDistance * 0.35 : entryPrice - targetDistance * 0.35;

  return {
    id: `telegram-test-${market.instrument.toLowerCase()}-${Date.now()}`,
    timestamp: new Date().toISOString(),
    instrument: market.instrument,
    direction,
    entryPrice,
    stopLoss,
    ticket1: {
      label: 'Safety Lock',
      positionSizePercent: 45,
      entryPrice,
      stopLoss,
      takeProfit: tp1,
    },
    ticket2: {
      label: 'Runner',
      positionSizePercent: 55,
      entryPrice,
      stopLoss,
      takeProfit: tp2,
    },
    zoneClassification: 'expansion_zone',
    riskAmount: 35,
    rUnit: stopDistance / market.pipSize,
    reasoning: `TEST ONLY: synthetic ${direction.toUpperCase()} levels built from the live ${market.displayName} TradingView close. No trade was placed.`,
    slippage: {
      applied: false,
      originalEntry: entryPrice,
      adjustedEntry: entryPrice,
      slippagePips: 0,
    },
    breakevenTrigger: 'Test message only; no position exists.',
    trailingStopGuidance: 'Test message only; no position exists.',
  };
}

async function main(): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? '';
  const chatId = process.env.TELEGRAM_CHAT_ID ?? '';

  if (!botToken || !chatId) {
    throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set');
  }

  const notifier = new TelegramNotifier(
    {
      botToken,
      chatId,
      maxRetries: 3,
      baseRetryMs: 2000,
    },
    logger,
    async (url, options) => {
      const response = await fetch(url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
      });
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
      };
    },
  );

  let failed = false;
  for (const market of MARKETS) {
    const liveClose = await fetchLiveClose(market);
    const signal = createTestSignal(market, liveClose);
    console.log(
      `[Telegram test] Sending ${market.displayName} test using live close ${liveClose.toFixed(2)}...`,
    );

    const result = await notifier.sendSignal(signal, { testOnly: true });
    if (!result.success) {
      failed = true;
      console.error(
        `[Telegram test] ${market.displayName} failed: ${result.error ?? 'unknown error'}`,
      );
    } else {
      console.log(
        `[Telegram test] ${market.displayName} delivered in ${result.attempts} attempt(s).`,
      );
    }
  }

  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error('[Telegram test] Aborted:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
