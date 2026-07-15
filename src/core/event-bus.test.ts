import { describe, it, expect, beforeEach } from 'vitest';
import {
  EventBus,
  CandleCloseEvent,
  StateTransition,
  FilterChangeEvent,
  CircuitBreakerAlert,
  RawSignal,
  FormattedSignal,
} from './event-bus';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  describe('subscribe and publish', () => {
    it('should deliver candle.close events to subscribers', () => {
      const received: CandleCloseEvent[] = [];
      bus.subscribe('candle.close', (event) => {
        received.push(event);
      });

      const event: CandleCloseEvent = {
        candle: {
          instrument: 'XAUUSD',
          timeframe: 'M5',
          timestamp: '2024-01-15T14:30:00.000Z',
          open: 2045.5,
          high: 2047.2,
          low: 2044.8,
          close: 2046.9,
          volume: 1250,
        },
        timeframe: 'M5',
      };

      bus.publish('candle.close', event);
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(event);
    });

    it('should deliver state.change events with correct types', () => {
      const received: StateTransition[] = [];
      bus.subscribe('state.change', (transition) => {
        received.push(transition);
      });

      const transition: StateTransition = {
        from: 'scanning',
        to: 'observation',
        reason: 'M5 close entered liquidity zone',
        timestamp: '2024-01-15T14:30:00.000Z',
      };

      bus.publish('state.change', transition);
      expect(received).toHaveLength(1);
      expect(received[0].from).toBe('scanning');
      expect(received[0].to).toBe('observation');
    });

    it('should deliver filter.change events', () => {
      const received: FilterChangeEvent[] = [];
      bus.subscribe('filter.change', (event) => {
        received.push(event);
      });

      const event: FilterChangeEvent = {
        filterName: 'timeGate',
        action: 'activated',
        timestamp: '2024-01-15T12:00:00.000Z',
        reason: 'UTC time reached 12:00',
      };

      bus.publish('filter.change', event);
      expect(received).toHaveLength(1);
      expect(received[0].filterName).toBe('timeGate');
      expect(received[0].action).toBe('activated');
    });

    it('should deliver alert.circuitBreaker events', () => {
      const received: CircuitBreakerAlert[] = [];
      bus.subscribe('alert.circuitBreaker', (alert) => {
        received.push(alert);
      });

      const alert: CircuitBreakerAlert = {
        magnitude: 350,
        affectedSignalId: 'sig-001',
        direction: 'long',
        timestamp: '2024-01-15T14:45:00.000Z',
        suppressionEndsAt: '2024-01-15T15:00:00.000Z',
      };

      bus.publish('alert.circuitBreaker', alert);
      expect(received).toHaveLength(1);
      expect(received[0].magnitude).toBe(350);
      expect(received[0].affectedSignalId).toBe('sig-001');
    });

    it('should support multiple subscribers for the same event', () => {
      let count = 0;
      bus.subscribe('state.change', () => { count++; });
      bus.subscribe('state.change', () => { count++; });

      const transition: StateTransition = {
        from: 'suppressed',
        to: 'scanning',
        reason: 'Time Gate activated',
        timestamp: '2024-01-15T12:00:00.000Z',
      };

      bus.publish('state.change', transition);
      expect(count).toBe(2);
    });

    it('should not deliver events to other event subscribers', () => {
      let stateChangeCalled = false;
      let candleCloseCalled = false;

      bus.subscribe('state.change', () => { stateChangeCalled = true; });
      bus.subscribe('candle.close', () => { candleCloseCalled = true; });

      const transition: StateTransition = {
        from: 'scanning',
        to: 'suppressed',
        reason: 'Time Gate deactivated',
        timestamp: '2024-01-15T17:00:00.000Z',
      };

      bus.publish('state.change', transition);
      expect(stateChangeCalled).toBe(true);
      expect(candleCloseCalled).toBe(false);
    });
  });

  describe('unsubscribe', () => {
    it('should stop receiving events after unsubscribe', () => {
      let callCount = 0;
      const unsubscribe = bus.subscribe('state.change', () => { callCount++; });

      const transition: StateTransition = {
        from: 'scanning',
        to: 'observation',
        reason: 'Zone entry',
        timestamp: '2024-01-15T14:30:00.000Z',
      };

      bus.publish('state.change', transition);
      expect(callCount).toBe(1);

      unsubscribe();
      bus.publish('state.change', transition);
      expect(callCount).toBe(1); // not incremented
    });
  });

  describe('subscribeOnce', () => {
    it('should only receive the first event', () => {
      let callCount = 0;
      bus.subscribeOnce('state.change', () => { callCount++; });

      const transition: StateTransition = {
        from: 'scanning',
        to: 'observation',
        reason: 'Zone entry',
        timestamp: '2024-01-15T14:30:00.000Z',
      };

      bus.publish('state.change', transition);
      bus.publish('state.change', transition);
      expect(callCount).toBe(1);
    });
  });

  describe('listenerCount', () => {
    it('should return the number of listeners for an event', () => {
      expect(bus.listenerCount('candle.close')).toBe(0);

      bus.subscribe('candle.close', () => {});
      expect(bus.listenerCount('candle.close')).toBe(1);

      bus.subscribe('candle.close', () => {});
      expect(bus.listenerCount('candle.close')).toBe(2);
    });
  });

  describe('removeAllListeners', () => {
    it('should remove all listeners for a specific event', () => {
      bus.subscribe('candle.close', () => {});
      bus.subscribe('state.change', () => {});

      bus.removeAllListeners('candle.close');
      expect(bus.listenerCount('candle.close')).toBe(0);
      expect(bus.listenerCount('state.change')).toBe(1);
    });

    it('should remove all listeners when no event specified', () => {
      bus.subscribe('candle.close', () => {});
      bus.subscribe('state.change', () => {});
      bus.subscribe('filter.change', () => {});

      bus.removeAllListeners();
      expect(bus.listenerCount('candle.close')).toBe(0);
      expect(bus.listenerCount('state.change')).toBe(0);
      expect(bus.listenerCount('filter.change')).toBe(0);
    });
  });

  describe('signal events', () => {
    it('should deliver signal.raw events', () => {
      const received: RawSignal[] = [];
      bus.subscribe('signal.raw', (signal) => {
        received.push(signal);
      });

      const signal: RawSignal = {
        id: 'sig-001',
        timestamp: '2024-01-15T14:35:00.000Z',
        direction: 'short',
        entryPrice: 2046.5,
        liquidityZoneLevel: 2048.0,
        structuralWindowUpper: 2047.8,
        structuralWindowLower: 2045.2,
        rejectionCandleType: 'shooting_star',
        expansionCandles: [],
        retracementCandles: [],
        observationCandles: [],
      };

      bus.publish('signal.raw', signal);
      expect(received).toHaveLength(1);
      expect(received[0].direction).toBe('short');
      expect(received[0].entryPrice).toBe(2046.5);
    });

    it('should deliver signal.formatted events', () => {
      const received: FormattedSignal[] = [];
      bus.subscribe('signal.formatted', (signal) => {
        received.push(signal);
      });

      const signal: FormattedSignal = {
        id: 'sig-001',
        timestamp: '2024-01-15T14:35:00.000Z',
        instrument: 'XAUUSD',
        direction: 'short',
        entryPrice: 2046.5,
        stopLoss: 2049.0,
        ticket1: {
          label: 'Safety Lock',
          positionSizePercent: 45,
          entryPrice: 2046.5,
          stopLoss: 2049.0,
          takeProfit: 2044.8,
        },
        ticket2: {
          label: 'Runner',
          positionSizePercent: 55,
          entryPrice: 2046.5,
          stopLoss: 2049.0,
          takeProfit: 2041.7,
        },
        zoneClassification: 'expansion_zone',
        riskAmount: 35.0,
        rUnit: 2.5,
        reasoning: 'Bearish rejection at H1 structural high with expansion and clean retracement.',
        slippage: {
          applied: false,
          originalEntry: 2046.5,
          adjustedEntry: 2046.5,
          slippagePips: 0,
        },
        breakevenTrigger: 'Move SL to entry when TP1 reached',
        trailingStopGuidance: 'Trail at most recent M5 swing low after breakeven',
      };

      bus.publish('signal.formatted', signal);
      expect(received).toHaveLength(1);
      expect(received[0].instrument).toBe('XAUUSD');
      expect(received[0].ticket1.positionSizePercent).toBe(45);
      expect(received[0].ticket2.positionSizePercent).toBe(55);
    });
  });
});
