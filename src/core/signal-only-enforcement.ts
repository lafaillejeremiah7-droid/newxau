/**
 * Signal-Only Enforcement Layer
 *
 * Provides comprehensive enforcement that no trade execution capability
 * exists in the system. This module:
 * 1. Wraps the config validation (from loader.ts) with additional runtime checks
 * 2. Maintains a whitelist of allowed outbound HTTP domains
 * 3. Provides a `validateStartup(config)` function that runs all enforcement checks
 * 4. Provides a `blockTradeExecution(componentName, operation)` function that logs critical errors
 * 5. Provides an `isAllowedOutbound(url)` function that validates outbound HTTP destinations
 *
 * Requirements: 15.1, 15.2, 15.3, 15.5, 15.6, 15.7
 */

import { SystemConfig } from '../types/config.js';
import {
  detectForbiddenEnvVars,
  detectForbiddenJsonKeys,
} from '../config/loader.js';

/**
 * Represents a blocked trade execution attempt.
 */
export interface BlockedAttempt {
  componentName: string;
  operation: string;
  timestamp: string;
  message: string;
}

/**
 * Result of the startup validation check.
 */
export interface StartupValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Default whitelist of allowed outbound HTTP domains.
 * Only these domains are permitted for outbound requests.
 */
const DEFAULT_ALLOWED_DOMAINS: string[] = [
  'api.telegram.org',
  'localhost',
  '127.0.0.1',
];

/**
 * Patterns for allowed outbound domains (supports wildcards).
 */
const ALLOWED_DOMAIN_PATTERNS: RegExp[] = [
  /^api\.telegram\.org$/,
  /^localhost$/,
  /^127\.0\.0\.1$/,
  /^.*\.forex-factory\.com$/,
  /^www\.forexfactory\.com$/,
  /^nfs\.faireconomy\.media$/,
  /^.*\.myfxbook\.com$/,
];

/**
 * Known trade execution endpoint patterns that must be blocked.
 */
const TRADE_EXECUTION_PATTERNS: RegExp[] = [
  /\/orders?\b/i,
  /\/trade/i,
  /\/execute/i,
  /\/positions?\b/i,
  /\/close/i,
  /\/modify/i,
  /\/cancel/i,
  /\/submit/i,
];

/**
 * Configurable allowed market data WebSocket/HTTP URLs.
 */
let additionalAllowedDomains: string[] = [];

/**
 * Stores the log of all blocked trade execution attempts.
 */
const blockedAttempts: BlockedAttempt[] = [];

/**
 * Configure additional allowed market data domains.
 * Used to add WebSocket data feed domains at startup.
 *
 * @param domains - Array of domain strings to allow
 */
export function configureAllowedDomains(domains: string[]): void {
  additionalAllowedDomains = domains.map((d) => d.toLowerCase());
}

/**
 * Get the current list of blocked trade execution attempts.
 */
export function getBlockedAttempts(): BlockedAttempt[] {
  return [...blockedAttempts];
}

/**
 * Clear blocked attempts log (mainly for testing).
 */
export function clearBlockedAttempts(): void {
  blockedAttempts.length = 0;
}

/**
 * Validates system startup by checking for any trade execution configuration.
 *
 * Checks:
 * 1. No forbidden environment variables (broker API keys, trade endpoints)
 * 2. No forbidden keys in the config object
 * 3. No trade execution endpoints registered
 * 4. Configuration schema does not contain broker tokens or trading credentials
 *
 * @param config - The system configuration object
 * @param env - Environment variables to check (defaults to process.env)
 * @returns StartupValidationResult indicating whether startup is allowed
 */
export function validateStartup(
  config: SystemConfig,
  env: Record<string, string | undefined> = process.env,
): StartupValidationResult {
  const errors: string[] = [];

  // Check 1: Forbidden environment variables
  const forbiddenEnvVars = detectForbiddenEnvVars(env);
  if (forbiddenEnvVars.length > 0) {
    errors.push(
      `[CRITICAL] Broker API credentials detected in environment: ${forbiddenEnvVars.join(', ')}. Signal-only mode violated.`,
    );
  }

  // Check 2: Forbidden keys in config object (recursively check the config as a plain object)
  const configAsRecord = config as unknown as Record<string, unknown>;
  const forbiddenConfigKeys = detectForbiddenJsonKeys(configAsRecord);
  if (forbiddenConfigKeys.length > 0) {
    errors.push(
      `[CRITICAL] Trade execution configuration detected in config: ${forbiddenConfigKeys.join(', ')}. Signal-only mode violated.`,
    );
  }

  // Check 3: Verify no trade execution endpoints in the data source URL
  if (config.dataSource.wsUrl) {
    try {
      const url = new URL(config.dataSource.wsUrl);
      for (const pattern of TRADE_EXECUTION_PATTERNS) {
        if (pattern.test(url.pathname)) {
          errors.push(
            `[CRITICAL] Trade execution endpoint detected in data source URL: ${config.dataSource.wsUrl}`,
          );
          break;
        }
      }
    } catch {
      // Invalid URL format is handled elsewhere; not a security concern here
    }
  }

  // Check 4: Verify instrument is XAUUSD only
  if (config.dataSource.instrument !== 'XAUUSD') {
    errors.push(
      `[CRITICAL] Invalid instrument configured: "${config.dataSource.instrument}". Only "XAUUSD" is allowed.`,
    );
  }

  // Log all errors
  for (const error of errors) {
    console.error(error);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Blocks a trade execution invocation attempt.
 * Logs a critical error with the component name, operation, and timestamp.
 *
 * This function should be called whenever any component attempts to invoke
 * a trade execution function. The invocation is blocked and logged.
 *
 * @param componentName - The name of the component attempting trade execution
 * @param operation - The operation that was attempted (e.g., "placeOrder", "modifyPosition")
 * @returns The BlockedAttempt record
 */
export function blockTradeExecution(
  componentName: string,
  operation: string,
): BlockedAttempt {
  const timestamp = new Date().toISOString();
  const message = `[CRITICAL] Trade execution blocked: component="${componentName}", operation="${operation}", timestamp="${timestamp}". Signal-only mode enforced.`;

  console.error(message);

  const attempt: BlockedAttempt = {
    componentName,
    operation,
    timestamp,
    message,
  };

  blockedAttempts.push(attempt);
  return attempt;
}

/**
 * Validates whether an outbound HTTP/HTTPS/WS URL is allowed.
 *
 * Allowed destinations:
 * - api.telegram.org (Telegram Bot API)
 * - *.forex-factory.com and similar economic calendar APIs
 * - Market data WebSocket URLs (configurable via configureAllowedDomains)
 * - localhost / 127.0.0.1 (for dashboard)
 *
 * @param url - The URL to validate
 * @returns true if the URL destination is allowed, false otherwise
 */
export function isAllowedOutbound(url: string): boolean {
  let hostname: string;

  try {
    const parsed = new URL(url);
    hostname = parsed.hostname.toLowerCase();
  } catch {
    // If URL can't be parsed, block it
    return false;
  }

  // Check against exact allowed domains
  if (DEFAULT_ALLOWED_DOMAINS.includes(hostname)) {
    return true;
  }

  // Check against allowed domain patterns (wildcards)
  for (const pattern of ALLOWED_DOMAIN_PATTERNS) {
    if (pattern.test(hostname)) {
      return true;
    }
  }

  // Check against additional configured domains (market data feeds)
  if (additionalAllowedDomains.includes(hostname)) {
    return true;
  }

  return false;
}

/**
 * Checks if a URL points to a known trade execution endpoint.
 * Used as an additional safety check for any outbound request.
 *
 * @param url - The URL to check
 * @returns true if the URL appears to be a trade execution endpoint
 */
export function isTradeExecutionEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    for (const pattern of TRADE_EXECUTION_PATTERNS) {
      if (pattern.test(parsed.pathname)) {
        return true;
      }
    }
  } catch {
    // If URL can't be parsed, we can't determine if it's a trade endpoint
    return false;
  }

  return false;
}

/**
 * Performs a full enforcement check on startup.
 * This is the main entry point for the signal-only enforcement layer.
 *
 * If validation fails, throws an error to prevent the system from starting.
 *
 * @param config - The system configuration
 * @param env - Environment variables (defaults to process.env)
 * @throws Error if any trade execution configuration is detected
 */
export function enforceSignalOnlyStartup(
  config: SystemConfig,
  env: Record<string, string | undefined> = process.env,
): void {
  const result = validateStartup(config, env);

  if (!result.valid) {
    throw new Error(
      `Signal-only enforcement failed. System refused to start.\n${result.errors.join('\n')}`,
    );
  }

  // Configure allowed outbound domains from the data source
  if (config.dataSource.wsUrl) {
    try {
      const wsUrl = new URL(config.dataSource.wsUrl);
      configureAllowedDomains([wsUrl.hostname]);
    } catch {
      // Invalid URL will be caught during connection
    }
  }
}
