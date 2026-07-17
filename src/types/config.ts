/**
 * System configuration type definitions for the Isagi Engine Signal Bot.
 * Defines the complete configuration schema matching the design specification.
 */

/** Complete system configuration */
export interface SystemConfig {
  /** Data source configuration */
  dataSource: {
    wsUrl: string;
    instrument: 'XAUUSD';
    reconnectIntervalMs: number;
  };

  /** Time gate configuration shape retained for compatibility; operation is always-on. */
  timeGate: {
    startHourUTC: number;
    startMinuteUTC: number;
    endHourUTC: number;
    endMinuteUTC: number;
    endSecondUTC: number;
  };

  /** Telegram notification settings */
  telegram: {
    botToken: string;
    chatId: string;
    maxRetries: 3;
    baseRetryMs: 2000;
  };

  /** Kelly position sizer parameters */
  kelly: {
    equityBaseline: 5000;
    floorRisk: 17.5;
    ceilingRisk: 70.0;
    coldStartRisk: 35.0;
    windowSize: 20;
    drawdownThresholdStart: 0.05;
    drawdownThresholdMax: 0.1;
    varianceMultiplierThreshold: 1.5;
    varianceReductionFactor: 0.25;
  };

  /** Volume filter parameters */
  volume: {
    smaPeriod: 20;
    expansionTrendCount: 3;
    expansionLookback: 5;
  };

  /** Circuit breaker parameters */
  circuitBreaker: {
    thresholdPips: 300;
    suppressionMinutes: 15;
  };

  /** Slippage simulator parameters */
  slippage: {
    probabilityPercent: 20;
    minPips: 0.5;
    maxPips: 2.5;
  };

  /** Signal structure detection parameters */
  signalStructure: {
    minExpansionCandles: 2;
    minRetracementCandles: 2;
    maxRetracementCandles: 4;
    bodyRatioThreshold: 0.6;
    observationMinCandles: 3;
    observationMaxCandles: 6;
    wickClusterMinCount: 3;
    wickClusterMaxRange: 1.0;
    liquidityPocketMinWidth: 5.0;
    minRewardRisk: 1.5;
  };

  /** Dashboard server parameters */
  dashboard: {
    port: number;
    maxSignalHistory: 100;
  };

  /** Logging and persistence parameters */
  logging: {
    dbPath: string;
    retentionDays: 90;
    maxRetries: 3;
  };
}
