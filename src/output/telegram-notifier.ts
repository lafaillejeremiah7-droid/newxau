/**
 * Telegram Notifier module for the Isagi Engine Signal Bot.
 * Delivers formatted signal messages to a configured Telegram chat via the Bot API.
 *
 * - Uses sendMessage endpoint with HTML formatting
 * - Retries on failure with exponential backoff (2s, 4s, 8s) up to 3 retries
 * - Suppresses delivery if chat not configured or required fields missing
 * - MUST NOT include trade execution commands or order placement instructions
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 15.4
 */

import type { FormattedSignal } from '../types/signal.js';

/** Result of a Telegram delivery attempt */
export interface DeliveryResult {
  success: boolean;
  attempts: number;
  error: string | null;
  timestamp: string;
}

/** Telegram configuration */
export interface TelegramConfig {
  botToken: string;
  chatId: string;
  maxRetries: number;
  baseRetryMs: number;
}

/** Logger interface for dependency injection */
export interface TelegramLogger {
  error(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
}

/** Fetch function type for dependency injection (testability) */
export type FetchFn = (
  url: string,
  options: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ ok: boolean; status: number; statusText: string }>;

/** Sleep function type for dependency injection (testability) */
export type SleepFn = (ms: number) => Promise<void>;

/** Required fields that must be present on a FormattedSignal for delivery */
const REQUIRED_FIELDS: (keyof FormattedSignal)[] = [
  'direction',
  'entryPrice',
  'stopLoss',
  'zoneClassification',
  'riskAmount',
];

/**
 * Validates that all required signal fields are present and non-null.
 * Also checks ticket TP levels (TP1 from ticket1, TP2 from ticket2).
 */
function validateSignalFields(signal: FormattedSignal): string | null {
  for (const field of REQUIRED_FIELDS) {
    if (signal[field] === undefined || signal[field] === null) {
      return `Missing required field: ${field}`;
    }
  }

  if (
    !signal.ticket1 ||
    signal.ticket1.takeProfit === undefined ||
    signal.ticket1.takeProfit === null
  ) {
    return 'Missing required field: ticket1.takeProfit (TP1)';
  }

  if (
    !signal.ticket2 ||
    signal.ticket2.takeProfit === undefined ||
    signal.ticket2.takeProfit === null
  ) {
    return 'Missing required field: ticket2.takeProfit (TP2)';
  }

  return null;
}

/**
 * Formats a signal into an HTML Telegram message.
 * Includes: direction, entry price, SL, TP1, TP2, split details, zone, risk amount, reasoning (≤280 chars).
 * MUST NOT include trade execution commands or order placement instructions.
 */
function formatSignalMessage(signal: FormattedSignal): string {
  const directionEmoji = signal.direction === 'long' ? '🟢' : '🔴';
  const directionLabel = signal.direction.toUpperCase();
  const zoneLabel =
    signal.zoneClassification === 'expansion_zone'
      ? 'Expansion Zone'
      : 'Chop Zone';

  // Truncate reasoning to 280 characters max
  const reasoning =
    signal.reasoning.length > 280
      ? signal.reasoning.slice(0, 280)
      : signal.reasoning;

  const lines: string[] = [
    `${directionEmoji} <b>${signal.instrument === 'BTCUSD' ? 'BTC/USD' : 'XAU/USD'} ${directionLabel} SIGNAL</b>`,
    '',
    `<b>Entry:</b> ${signal.entryPrice.toFixed(2)}`,
    `<b>Stop Loss:</b> ${signal.stopLoss.toFixed(2)}`,
    `<b>TP1:</b> ${signal.ticket1.takeProfit.toFixed(2)}`,
    `<b>TP2:</b> ${signal.ticket2.takeProfit.toFixed(2)}`,
    '',
    `<b>Split:</b>`,
    `  • Ticket 1 (Safety Lock): ${signal.ticket1.positionSizePercent}%`,
    `  • Ticket 2 (Runner): ${signal.ticket2.positionSizePercent}%`,
    '',
    `<b>Zone:</b> ${zoneLabel}`,
    `<b>Risk:</b> $${signal.riskAmount.toFixed(2)}`,
    `<b>R-Unit:</b> ${signal.rUnit.toFixed(2)} pips`,
    '',
    `<b>Reasoning:</b> ${reasoning}`,
  ];

  // Include slippage info if applied
  if (signal.slippage && signal.slippage.applied) {
    lines.push('');
    lines.push(
      `<i>Slippage: ${signal.slippage.slippagePips.toFixed(1)} pips (adjusted from ${signal.slippage.originalEntry.toFixed(2)})</i>`,
    );
  }

  return lines.join('\n');
}

/** Default sleep implementation using setTimeout */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * TelegramNotifier sends formatted signal messages to a Telegram chat.
 * Implements retry with exponential backoff and validates config/fields before sending.
 */
export class TelegramNotifier {
  private readonly config: TelegramConfig;
  private readonly logger: TelegramLogger;
  private readonly fetchFn: FetchFn;
  private readonly sleepFn: SleepFn;

  constructor(
    config: TelegramConfig,
    logger: TelegramLogger,
    fetchFn: FetchFn,
    sleepFn: SleepFn = defaultSleep,
  ) {
    this.config = config;
    this.logger = logger;
    this.fetchFn = fetchFn;
    this.sleepFn = sleepFn;
  }

  /**
   * Sends a formatted signal to the configured Telegram chat.
   * Returns a DeliveryResult indicating success/failure and attempt count.
   */
  async sendSignal(signal: FormattedSignal): Promise<DeliveryResult> {
    const timestamp = new Date().toISOString();

    // Check chat configuration
    if (!this.config.chatId || !this.config.botToken) {
      const missingConfig = !this.config.chatId ? 'chatId' : 'botToken';
      this.logger.error(
        `Telegram delivery suppressed: missing configuration (${missingConfig})`,
        {
          missingConfig,
          signalId: signal.id,
        },
      );
      return {
        success: false,
        attempts: 0,
        error: `Missing Telegram configuration: ${missingConfig}`,
        timestamp,
      };
    }

    // Validate required signal fields
    const validationError = validateSignalFields(signal);
    if (validationError) {
      this.logger.error(
        `Telegram delivery suppressed: ${validationError}`,
        {
          signalId: signal.id,
          error: validationError,
        },
      );
      return {
        success: false,
        attempts: 0,
        error: validationError,
        timestamp,
      };
    }

    // Format the message
    const messageText = formatSignalMessage(signal);

    // Attempt delivery with exponential backoff retry
    const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;
    const body = JSON.stringify({
      chat_id: this.config.chatId,
      text: messageText,
      parse_mode: 'HTML',
    });

    let lastError: string | null = null;
    const maxAttempts = 1 + this.config.maxRetries; // initial + retries

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await this.fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });

        if (response.ok) {
          this.logger.info('Telegram signal delivered successfully', {
            signalId: signal.id,
            attempts: attempt,
          });
          return {
            success: true,
            attempts: attempt,
            error: null,
            timestamp: new Date().toISOString(),
          };
        }

        lastError = `HTTP ${response.status}: ${response.statusText}`;
      } catch (err: unknown) {
        lastError =
          err instanceof Error ? err.message : 'Unknown fetch error';
      }

      // If not the last attempt, wait with exponential backoff before retry
      if (attempt < maxAttempts) {
        const backoffMs =
          this.config.baseRetryMs * Math.pow(2, attempt - 1);
        this.logger.warn(
          `Telegram delivery attempt ${attempt} failed, retrying in ${backoffMs}ms`,
          {
            signalId: signal.id,
            attempt,
            error: lastError,
            nextRetryMs: backoffMs,
          },
        );
        await this.sleepFn(backoffMs);
      }
    }

    // All retries failed - log failure + full signal content for manual review
    this.logger.error(
      'Telegram delivery failed after all retries - logging full signal for manual review',
      {
        signalId: signal.id,
        attempts: maxAttempts,
        lastError,
        fullSignal: signal,
      },
    );

    return {
      success: false,
      attempts: maxAttempts,
      error: lastError,
      timestamp: new Date().toISOString(),
    };
  }
}

// Export formatting helper for testing
export { formatSignalMessage, validateSignalFields };
