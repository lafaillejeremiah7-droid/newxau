/**
 * Dashboard Server Tests
 *
 * Tests the Express.js + WebSocket dashboard backend including:
 * - Server startup and shutdown
 * - WebSocket client connection and snapshot delivery
 * - Signal broadcasting and history management (last 100, reverse-chronological)
 * - State change and filter status broadcasting
 * - Kelly metrics broadcasting
 * - REST API endpoints
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import {
  DashboardServerImpl,
  createDashboardServer,
  type WsMessage,
  type DashboardSnapshot,
} from './dashboard-server.js';
import type { FormattedSignal } from '../types/signal.js';
import type { EngineState } from '../types/state.js';
import type { FilterStatus } from '../types/filter.js';
import type { KellyResult } from '../pipeline/kelly-sizer.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createTestSignal(id: string, timestamp?: string): FormattedSignal {
  return {
    id,
    timestamp: timestamp ?? new Date().toISOString(),
    instrument: 'XAUUSD',
    direction: 'long',
    entryPrice: 2350.5,
    stopLoss: 2348.0,
    ticket1: {
      label: 'Safety Lock',
      positionSizePercent: 45,
      entryPrice: 2350.5,
      stopLoss: 2348.0,
      takeProfit: 2352.625,
    },
    ticket2: {
      label: 'Runner',
      positionSizePercent: 55,
      entryPrice: 2350.5,
      stopLoss: 2348.0,
      takeProfit: 2356.57,
    },
    zoneClassification: 'expansion_zone',
    riskAmount: 35.0,
    rUnit: 2.5,
    reasoning: 'Bullish rejection at liquidity zone with expansion confirmation',
    slippage: {
      applied: false,
      originalEntry: 2350.5,
      adjustedEntry: 2350.5,
      slippagePips: 0,
    },
    breakevenTrigger: 'Move Ticket 2 SL to entry when TP1 is reached',
    trailingStopGuidance: 'Trail to most recent M5 swing low after breakeven',
  };
}

function createTestFilterStatus(): FilterStatus {
  return {
    timeGate: { active: true, windowStart: '12:00:00', windowEnd: '16:59:59' },
    newsDecoupler: {
      freezeActive: false,
      currentEvent: null,
      freezeEnd: null,
    },
    circuitBreaker: { active: false, expiresAt: null },
  };
}

function createTestKellyResult(): KellyResult {
  return {
    riskAmount: 35.0,
    riskPercentage: 0.7,
    rollingDrawdown: 0.02,
    equityCurveVariance: 5.0,
    historicalAverageVariance: 4.5,
    isColdStart: true,
    adjustmentReason: null,
  };
}

/**
 * Connect a WebSocket and set up a message queue so no messages are lost.
 * The snapshot message sent immediately on connection will be captured.
 */
function connectAndListen(port: number): Promise<{
  ws: WebSocket;
  nextMessage: () => Promise<WsMessage>;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messageQueue: WsMessage[] = [];
    const waiters: Array<(msg: WsMessage) => void> = [];

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as WsMessage;
      const waiter = waiters.shift();
      if (waiter) {
        waiter(msg);
      } else {
        messageQueue.push(msg);
      }
    });

    ws.on('open', () => {
      resolve({
        ws,
        nextMessage: () => {
          return new Promise<WsMessage>((res, rej) => {
            const queued = messageQueue.shift();
            if (queued) {
              res(queued);
              return;
            }
            const timeout = setTimeout(
              () => rej(new Error('Timeout waiting for message')),
              5000
            );
            waiters.push((msg) => {
              clearTimeout(timeout);
              res(msg);
            });
          });
        },
      });
    });

    ws.on('error', reject);
  });
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.on('close', () => resolve());
  });
}

// Use a dynamic port to avoid conflicts
let testPort = 28900;
function getPort(): number {
  return testPort++;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('DashboardServerImpl', () => {
  let server: DashboardServerImpl;
  let port: number;

  beforeEach(() => {
    port = getPort();
    server = new DashboardServerImpl(100);
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('Server Lifecycle', () => {
    it('should start and listen on the specified port', async () => {
      await server.start(port);
      const { ws } = await connectAndListen(port);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      await waitForClose(ws);
    });

    it('should stop and close all connections', async () => {
      await server.start(port);
      const { ws } = await connectAndListen(port);
      const closePromise = waitForClose(ws);
      await server.stop();
      await closePromise;
      expect(ws.readyState).toBe(WebSocket.CLOSED);
    });

    it('should stop gracefully even when no server is running', async () => {
      await server.stop(); // Should not throw
    });
  });

  describe('WebSocket Connection', () => {
    it('should send snapshot to newly connected client', async () => {
      await server.start(port);
      const { ws, nextMessage } = await connectAndListen(port);
      const message = await nextMessage();

      expect(message.type).toBe('snapshot');
      expect(message.timestamp).toBeDefined();

      const snapshot = message.payload as DashboardSnapshot;
      expect(snapshot.engineState).toBe('suppressed');
      expect(snapshot.signals).toEqual([]);
      expect(snapshot.filterStatus).toBeDefined();
      expect(snapshot.kellyMetrics).toBeNull();
      expect(snapshot.lastUpdateTimestamp).toBeDefined();

      ws.close();
      await waitForClose(ws);
    });

    it('should send current state snapshot with existing signals', async () => {
      await server.start(port);

      // Add signals before client connects
      const signal1 = createTestSignal('sig-1');
      const signal2 = createTestSignal('sig-2');
      server.broadcastSignal(signal1);
      server.broadcastSignal(signal2);

      // Now connect a new client - should receive all signals in snapshot
      const { ws, nextMessage } = await connectAndListen(port);
      const message = await nextMessage();

      const snapshot = message.payload as DashboardSnapshot;
      expect(snapshot.signals.length).toBe(2);
      // Newest first (reverse-chronological)
      expect(snapshot.signals[0].id).toBe('sig-2');
      expect(snapshot.signals[1].id).toBe('sig-1');

      ws.close();
      await waitForClose(ws);
    });

    it('should report connected clients count', async () => {
      await server.start(port);
      expect(server.getConnectedClients()).toBe(0);

      const { ws: ws1 } = await connectAndListen(port);
      expect(server.getConnectedClients()).toBe(1);

      const { ws: ws2 } = await connectAndListen(port);
      expect(server.getConnectedClients()).toBe(2);

      ws1.close();
      await waitForClose(ws1);
      // Wait a moment for disconnection to register
      await new Promise((r) => setTimeout(r, 50));
      expect(server.getConnectedClients()).toBe(1);

      ws2.close();
      await waitForClose(ws2);
    });
  });

  describe('Signal Broadcasting', () => {
    it('should broadcast new signal to connected clients', async () => {
      await server.start(port);
      const { ws, nextMessage } = await connectAndListen(port);
      await nextMessage(); // consume snapshot

      const signal = createTestSignal('sig-broadcast');
      const messagePromise = nextMessage();
      server.broadcastSignal(signal);
      const message = await messagePromise;

      expect(message.type).toBe('signal');
      expect((message.payload as FormattedSignal).id).toBe('sig-broadcast');
      expect(message.timestamp).toBeDefined();

      ws.close();
      await waitForClose(ws);
    });

    it('should maintain reverse-chronological order of signals', async () => {
      await server.start(port);

      server.broadcastSignal(createTestSignal('sig-1', '2024-01-01T12:00:00.000Z'));
      server.broadcastSignal(createTestSignal('sig-2', '2024-01-01T12:05:00.000Z'));
      server.broadcastSignal(createTestSignal('sig-3', '2024-01-01T12:10:00.000Z'));

      const history = server.getSignalHistory();
      expect(history[0].id).toBe('sig-3');
      expect(history[1].id).toBe('sig-2');
      expect(history[2].id).toBe('sig-1');
    });

    it('should discard signals beyond maxSignalHistory (100)', async () => {
      server = new DashboardServerImpl(100);
      await server.start(port);

      // Add 105 signals
      for (let i = 0; i < 105; i++) {
        server.broadcastSignal(createTestSignal(`sig-${i}`));
      }

      const history = server.getSignalHistory();
      expect(history.length).toBe(100);
      // Newest should be first
      expect(history[0].id).toBe('sig-104');
      // Oldest retained should be sig-5 (indices 0-4 discarded)
      expect(history[99].id).toBe('sig-5');
    });

    it('should broadcast to multiple clients simultaneously', async () => {
      await server.start(port);

      const { ws: ws1, nextMessage: next1 } = await connectAndListen(port);
      await next1(); // snapshot
      const { ws: ws2, nextMessage: next2 } = await connectAndListen(port);
      await next2(); // snapshot

      const msg1Promise = next1();
      const msg2Promise = next2();

      server.broadcastSignal(createTestSignal('sig-multi'));

      const [msg1, msg2] = await Promise.all([msg1Promise, msg2Promise]);
      expect(msg1.type).toBe('signal');
      expect((msg1.payload as FormattedSignal).id).toBe('sig-multi');
      expect(msg2.type).toBe('signal');
      expect((msg2.payload as FormattedSignal).id).toBe('sig-multi');

      ws1.close();
      ws2.close();
      await Promise.all([waitForClose(ws1), waitForClose(ws2)]);
    });
  });

  describe('State Change Broadcasting', () => {
    it('should broadcast engine state change', async () => {
      await server.start(port);
      const { ws, nextMessage } = await connectAndListen(port);
      await nextMessage(); // snapshot

      const messagePromise = nextMessage();
      server.broadcastStateChange('scanning');
      const message = await messagePromise;

      expect(message.type).toBe('state_change');
      expect((message.payload as { engineState: EngineState }).engineState).toBe(
        'scanning'
      );

      ws.close();
      await waitForClose(ws);
    });

    it('should update internal state and reflect in new client snapshot', async () => {
      await server.start(port);
      server.broadcastStateChange('observation');

      const { ws, nextMessage } = await connectAndListen(port);
      const message = await nextMessage();
      const snapshot = message.payload as DashboardSnapshot;
      expect(snapshot.engineState).toBe('observation');

      ws.close();
      await waitForClose(ws);
    });
  });

  describe('Filter Status Broadcasting', () => {
    it('should broadcast filter status update', async () => {
      await server.start(port);
      const { ws, nextMessage } = await connectAndListen(port);
      await nextMessage(); // snapshot

      const filterStatus = createTestFilterStatus();
      const messagePromise = nextMessage();
      server.broadcastFilterStatus(filterStatus);
      const message = await messagePromise;

      expect(message.type).toBe('filter_status');
      expect((message.payload as FilterStatus).timeGate.active).toBe(true);

      ws.close();
      await waitForClose(ws);
    });

    it('should reflect filter status in new client snapshot', async () => {
      await server.start(port);
      const filterStatus = createTestFilterStatus();
      filterStatus.newsDecoupler.freezeActive = true;
      filterStatus.newsDecoupler.currentEvent = 'NFP';
      server.broadcastFilterStatus(filterStatus);

      const { ws, nextMessage } = await connectAndListen(port);
      const message = await nextMessage();
      const snapshot = message.payload as DashboardSnapshot;
      expect(snapshot.filterStatus.newsDecoupler.freezeActive).toBe(true);
      expect(snapshot.filterStatus.newsDecoupler.currentEvent).toBe('NFP');

      ws.close();
      await waitForClose(ws);
    });
  });

  describe('Kelly Metrics Broadcasting', () => {
    it('should broadcast Kelly metrics update', async () => {
      await server.start(port);
      const { ws, nextMessage } = await connectAndListen(port);
      await nextMessage(); // snapshot

      const kelly = createTestKellyResult();
      const messagePromise = nextMessage();
      server.broadcastKellyMetrics(kelly);
      const message = await messagePromise;

      expect(message.type).toBe('kelly_metrics');
      expect((message.payload as KellyResult).riskAmount).toBe(35.0);
      expect((message.payload as KellyResult).rollingDrawdown).toBe(0.02);

      ws.close();
      await waitForClose(ws);
    });

    it('should reflect Kelly metrics in new client snapshot', async () => {
      await server.start(port);
      server.broadcastKellyMetrics(createTestKellyResult());

      const { ws, nextMessage } = await connectAndListen(port);
      const message = await nextMessage();
      const snapshot = message.payload as DashboardSnapshot;
      expect(snapshot.kellyMetrics).not.toBeNull();
      expect(snapshot.kellyMetrics!.riskAmount).toBe(35.0);

      ws.close();
      await waitForClose(ws);
    });
  });

  describe('REST API Endpoints', () => {
    it('should return health status from /api/health', async () => {
      await server.start(port);
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(response.ok).toBe(true);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.status).toBe('ok');
      expect(body.engineState).toBe('suppressed');
      expect(body.connectedClients).toBe(0);
      expect(body.signalCount).toBe(0);
      expect(body.timestamp).toBeDefined();
    });

    it('should return snapshot from /api/snapshot', async () => {
      await server.start(port);
      server.broadcastSignal(createTestSignal('rest-sig'));
      server.broadcastStateChange('scanning');

      const response = await fetch(`http://127.0.0.1:${port}/api/snapshot`);
      expect(response.ok).toBe(true);

      const snapshot = (await response.json()) as DashboardSnapshot;
      expect(snapshot.engineState).toBe('scanning');
      expect(snapshot.signals.length).toBe(1);
      expect(snapshot.signals[0].id).toBe('rest-sig');
    });
  });

  describe('Edge Cases', () => {
    it('should handle broadcast with no connected clients without error', async () => {
      await server.start(port);
      // No clients connected - should not throw
      expect(() =>
        server.broadcastSignal(createTestSignal('orphan'))
      ).not.toThrow();
      expect(() => server.broadcastStateChange('scanning')).not.toThrow();
      expect(() =>
        server.broadcastFilterStatus(createTestFilterStatus())
      ).not.toThrow();
      expect(() =>
        server.broadcastKellyMetrics(createTestKellyResult())
      ).not.toThrow();
    });

    it('should handle broadcast before server is started', () => {
      // Server not started yet - should not throw
      expect(() =>
        server.broadcastSignal(createTestSignal('early'))
      ).not.toThrow();
    });

    it('should return 0 connected clients when server not started', () => {
      expect(server.getConnectedClients()).toBe(0);
    });

    it('should handle custom maxSignalHistory', async () => {
      const smallServer = new DashboardServerImpl(5);
      const smallPort = getPort();
      await smallServer.start(smallPort);

      for (let i = 0; i < 10; i++) {
        smallServer.broadcastSignal(createTestSignal(`s-${i}`));
      }

      const history = smallServer.getSignalHistory();
      expect(history.length).toBe(5);
      expect(history[0].id).toBe('s-9');
      expect(history[4].id).toBe('s-5');

      await smallServer.stop();
    });
  });
});

describe('createDashboardServer factory', () => {
  it('should create a DashboardServer instance with default config', () => {
    const server = createDashboardServer();
    expect(server).toBeDefined();
    expect(server.getConnectedClients()).toBe(0);
    expect(server.getSignalHistory()).toEqual([]);
  });

  it('should create a DashboardServer instance with custom maxSignalHistory', () => {
    const server = createDashboardServer(50);
    expect(server).toBeDefined();
  });
});
