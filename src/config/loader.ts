/**
 * Configuration loader with signal-only enforcement.
 * Reads config from environment variables (precedence) or JSON file.
 * Validates the signal-only constraint by checking for forbidden broker/trade execution configuration.
 *
 * Requirements: 15.5, 15.6, 15.7, 16.1
 */

import * as fs from 'fs';
import * as path from 'path';
import { SystemConfig } from '../types/config.js';

/**
 * Forbidden environment variable prefixes and exact keys.
 * If any of these are detected, the system refuses to start.
 */
const FORBIDDEN_EXACT_KEYS: string[] = [
  'BROKER_API_KEY',
  'BROKER_API_SECRET',
  'TRADING_ACCOUNT_ID',
  'ORDER_ENDPOINT',
  'TRADE_ENDPOINT',
  'EXECUTION_URL',
  'BROKER_URL',
];

const FORBIDDEN_PREFIXES: string[] = ['MT4_', 'MT5_', 'OANDA_', 'IBKR_'];

/**
 * Check if a given key matches any forbidden configuration pattern.
 */
export function isForbiddenKey(key: string): boolean {
  const upperKey = key.toUpperCase();

  if (FORBIDDEN_EXACT_KEYS.includes(upperKey)) {
    return true;
  }

  for (const prefix of FORBIDDEN_PREFIXES) {
    if (upperKey.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}

/**
 * Scans environment variables for any forbidden broker/trade execution configuration.
 * Returns an array of detected forbidden keys.
 */
export function detectForbiddenEnvVars(
  env: Record<string, string | undefined>,
): string[] {
  const detected: string[] = [];

  for (const key of Object.keys(env)) {
    if (isForbiddenKey(key)) {
      detected.push(key);
    }
  }

  return detected;
}

/**
 * Scans a JSON config object for any forbidden broker/trade execution keys.
 * Performs a recursive check on all keys in the object.
 * Returns an array of detected forbidden keys.
 */
export function detectForbiddenJsonKeys(
  obj: Record<string, unknown>,
  parentPath = '',
): string[] {
  const detected: string[] = [];

  for (const key of Object.keys(obj)) {
    const fullPath = parentPath ? `${parentPath}.${key}` : key;

    if (isForbiddenKey(key)) {
      detected.push(fullPath);
    }

    const value = obj[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      detected.push(
        ...detectForbiddenJsonKeys(value as Record<string, unknown>, fullPath),
      );
    }
  }

  return detected;
}

/**
 * Validates that the instrument is 'XAUUSD'.
 * Throws if any other instrument is configured.
 */
export function validateInstrument(instrument: string): void {
  if (instrument !== 'XAUUSD') {
    throw new Error(
      `[CRITICAL] Invalid instrument configured: "${instrument}". Only "XAUUSD" is allowed.`,
    );
  }
}

/**
 * Loads configuration from a JSON file if it exists.
 * Returns null if the file does not exist or cannot be parsed.
 */
function loadJsonConfig(configPath: string): Record<string, unknown> | null {
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(content) as Record<string, unknown>;
    }
  } catch {
    // If file doesn't exist or can't be parsed, return null
  }
  return null;
}

/**
 * Loads and validates the system configuration.
 * Reads from environment variables (higher precedence) and config.json file.
 * Enforces signal-only constraint: refuses to start if any trade execution configuration is detected.
 *
 * @param env - Environment variables (defaults to process.env)
 * @param configFilePath - Path to config.json (defaults to ./config.json in project root)
 * @returns Validated SystemConfig
 * @throws Error if forbidden configuration detected or instrument is invalid
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  configFilePath?: string,
): SystemConfig {
  const resolvedConfigPath =
    configFilePath ?? path.resolve(process.cwd(), 'config.json');

  // Load JSON config file if it exists
  const jsonConfig = loadJsonConfig(resolvedConfigPath);

  // Step 1: Check for forbidden environment variables (signal-only enforcement)
  const forbiddenEnvVars = detectForbiddenEnvVars(env);
  if (forbiddenEnvVars.length > 0) {
    const message = `[CRITICAL] Trade execution configuration detected in environment variables: ${forbiddenEnvVars.join(', ')}. Signal-only mode violated. Refusing to start.`;
    console.error(message);
    throw new Error(message);
  }

  // Step 2: Check for forbidden keys in JSON config file
  if (jsonConfig) {
    const forbiddenJsonKeys = detectForbiddenJsonKeys(jsonConfig);
    if (forbiddenJsonKeys.length > 0) {
      const message = `[CRITICAL] Trade execution configuration detected in config file: ${forbiddenJsonKeys.join(', ')}. Signal-only mode violated. Refusing to start.`;
      console.error(message);
      throw new Error(message);
    }
  }

  // Step 3: Build configuration with defaults, env vars take precedence
  const wsUrl = env['WS_URL'] ?? 'ws://localhost:8080';
  const instrument = 'XAUUSD' as const;
  const botToken =
    env['TELEGRAM_BOT_TOKEN'] ??
    '8926622863:AAF0QHHYAyEVQZiYV35b5vyeKxDC_ouMnmQ';
  const chatId = env['TELEGRAM_CHAT_ID'] ?? '7040023207';
  const dashboardPort = env['DASHBOARD_PORT']
    ? parseInt(env['DASHBOARD_PORT'], 10)
    : 3000;
  const dbPath = env['DB_PATH'] ?? './data/signals.db';

  // Step 4: Validate instrument
  validateInstrument(instrument);

  // Step 5: Build and return the complete SystemConfig
  const config: SystemConfig = {
    dataSource: {
      wsUrl,
      instrument,
      reconnectIntervalMs: 1000,
    },
    timeGate: {
      // Retained for configuration compatibility; TimeGate now operates 24/7.
      startHourUTC: 0,
      startMinuteUTC: 0,
      endHourUTC: 23,
      endMinuteUTC: 59,
      endSecondUTC: 59,
    },
    telegram: {
      botToken,
      chatId,
      maxRetries: 3,
      baseRetryMs: 2000,
    },
    kelly: {
      equityBaseline: 5000,
      floorRisk: 17.5,
      ceilingRisk: 70.0,
      coldStartRisk: 35.0,
      windowSize: 20,
      drawdownThresholdStart: 0.05,
      drawdownThresholdMax: 0.1,
      varianceMultiplierThreshold: 1.5,
      varianceReductionFactor: 0.25,
    },
    volume: {
      smaPeriod: 20,
      expansionTrendCount: 3,
      expansionLookback: 5,
    },
    circuitBreaker: {
      thresholdPips: 300,
      suppressionMinutes: 15,
    },
    slippage: {
      probabilityPercent: 20,
      minPips: 0.5,
      maxPips: 2.5,
    },
    signalStructure: {
      minExpansionCandles: 2,
      minRetracementCandles: 2,
      maxRetracementCandles: 4,
      bodyRatioThreshold: 0.6,
      observationMinCandles: 3,
      observationMaxCandles: 6,
      wickClusterMinCount: 3,
      wickClusterMaxRange: 1.0,
      liquidityPocketMinWidth: 5.0,
      minRewardRisk: 1.5,
    },
    dashboard: {
      port: dashboardPort,
      maxSignalHistory: 100,
    },
    logging: {
      dbPath,
      retentionDays: 90,
      maxRetries: 3,
    },
  };

  return config;
}
