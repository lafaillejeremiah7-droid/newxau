/**
 * Dashboard Server - Express.js + WebSocket Real-time Dashboard Backend
 *
 * Serves a static HTML/CSS/JS single-page application and provides
 * real-time push updates to connected clients via WebSocket.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5
 */

import { createServer, Server as HttpServer, IncomingMessage } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Duplex } from 'node:stream';
import express, { Application } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import type { EngineState } from '../types/state.js';
import type { FormattedSignal } from '../types/signal.js';
import type { FilterStatus } from '../types/filter.js';
import type { KellyResult } from '../pipeline/kelly-sizer.js';

// ─── WebSocket Message Types ─────────────────────────────────────────────────

export type WsMessageType =
  | 'snapshot'
  | 'signal'
  | 'state_change'
  | 'filter_status'
  | 'kelly_metrics';

export interface WsMessage {
  type: WsMessageType;
  payload: unknown;
  timestamp: string;
}

export interface DashboardSnapshot {
  engineState: EngineState;
  signals: FormattedSignal[];
  filterStatus: FilterStatus;
  kellyMetrics: KellyResult | null;
  lastUpdateTimestamp: string;
}

// ─── DashboardServer Interface ───────────────────────────────────────────────

export interface DashboardServer {
  start(port: number): Promise<void>;
  stop(): Promise<void>;
  broadcastSignal(signal: FormattedSignal): void;
  broadcastStateChange(state: EngineState): void;
  broadcastFilterStatus(status: FilterStatus): void;
  broadcastKellyMetrics(metrics: KellyResult): void;
  getConnectedClients(): number;
  getSignalHistory(): FormattedSignal[];
}

// ─── Default Filter Status ───────────────────────────────────────────────────

const DEFAULT_FILTER_STATUS: FilterStatus = {
  timeGate: { active: false, windowStart: '12:00:00', windowEnd: '16:59:59' },
  newsDecoupler: { freezeActive: false, currentEvent: null, freezeEnd: null },
  circuitBreaker: { active: false, expiresAt: null },
};

// ─── DashboardServer Implementation ─────────────────────────────────────────

export class DashboardServerImpl implements DashboardServer {
  private app: Application;
  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private readonly maxSignalHistory: number;

  // Internal state
  private signals: FormattedSignal[] = [];
  private engineState: EngineState = 'suppressed';
  private filterStatus: FilterStatus = { ...DEFAULT_FILTER_STATUS };
  private kellyMetrics: KellyResult | null = null;
  private lastUpdateTimestamp: string = new Date().toISOString();

  constructor(maxSignalHistory: number = 100) {
    this.maxSignalHistory = maxSignalHistory;
    this.app = express();
    this.setupRoutes();
  }

  /**
   * Configure Express routes for serving static files and API endpoints.
   */
  private setupRoutes(): void {
    // Try dist/output/dashboard first, fallback to src/output/dashboard
    const dashboardDir = path.resolve(__dirname, 'dashboard');
    const srcDashboardDir = path.resolve(__dirname, '../../src/output/dashboard');

    // Use whichever directory actually contains index.html
    const staticDir = fs.existsSync(path.join(dashboardDir, 'index.html'))
      ? dashboardDir
      : srcDashboardDir;

    this.app.use(express.static(staticDir));

    // Explicitly serve index.html at root for compatibility
    this.app.get('/', (_req, res) => {
      res.sendFile(path.join(staticDir, 'index.html'));
    });

    // Health check endpoint
    this.app.get('/api/health', (_req, res) => {
      res.json({
        status: 'ok',
        engineState: this.engineState,
        connectedClients: this.getConnectedClients(),
        signalCount: this.signals.length,
        timestamp: new Date().toISOString(),
      });
    });

    // Get current snapshot via REST (fallback for initial load)
    this.app.get('/api/snapshot', (_req, res) => {
      res.json(this.buildSnapshot());
    });
  }

  /**
   * Start the HTTP + WebSocket server on the given port.
   */
  async start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.httpServer = createServer(this.app);
        this.wss = new WebSocketServer({ noServer: true });

        this.wss.on('connection', (ws: WebSocket) => {
          this.handleNewConnection(ws);
        });

        this.httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
          if (this.wss) {
            this.wss.handleUpgrade(request, socket, head, (ws) => {
              this.wss!.emit('connection', ws, request);
            });
          }
        });

        this.httpServer.listen(port, () => {
          resolve();
        });

        this.httpServer.on('error', (err) => {
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Stop the server and close all connections.
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.wss) {
        // Close all WebSocket connections
        for (const client of this.wss.clients) {
          client.close(1000, 'Server shutting down');
        }
        this.wss.close();
        this.wss = null;
      }

      if (this.httpServer) {
        this.httpServer.close(() => {
          this.httpServer = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle a new WebSocket client connection.
   * Sends the current state snapshot immediately on connect.
   */
  private handleNewConnection(ws: WebSocket): void {
    // Send current state snapshot to new client
    const snapshot = this.buildSnapshot();
    this.sendToClient(ws, {
      type: 'snapshot',
      payload: snapshot,
      timestamp: new Date().toISOString(),
    });

    // Handle client ping/pong for connection keepalive
    ws.on('pong', () => {
      // Client is alive
    });
  }

  /**
   * Broadcast a new signal to all connected clients.
   * Maintains last 100 signals in reverse-chronological order.
   */
  broadcastSignal(signal: FormattedSignal): void {
    // Add to front of array (reverse-chronological)
    this.signals.unshift(signal);

    // Trim to maxSignalHistory (discard older signals)
    if (this.signals.length > this.maxSignalHistory) {
      this.signals = this.signals.slice(0, this.maxSignalHistory);
    }

    this.lastUpdateTimestamp = new Date().toISOString();

    this.broadcast({
      type: 'signal',
      payload: signal,
      timestamp: this.lastUpdateTimestamp,
    });
  }

  /**
   * Broadcast an engine state change to all connected clients.
   */
  broadcastStateChange(state: EngineState): void {
    this.engineState = state;
    this.lastUpdateTimestamp = new Date().toISOString();

    this.broadcast({
      type: 'state_change',
      payload: { engineState: state },
      timestamp: this.lastUpdateTimestamp,
    });
  }

  /**
   * Broadcast filter status update to all connected clients.
   */
  broadcastFilterStatus(status: FilterStatus): void {
    this.filterStatus = status;
    this.lastUpdateTimestamp = new Date().toISOString();

    this.broadcast({
      type: 'filter_status',
      payload: status,
      timestamp: this.lastUpdateTimestamp,
    });
  }

  /**
   * Broadcast Kelly metrics update to all connected clients.
   */
  broadcastKellyMetrics(metrics: KellyResult): void {
    this.kellyMetrics = metrics;
    this.lastUpdateTimestamp = new Date().toISOString();

    this.broadcast({
      type: 'kelly_metrics',
      payload: metrics,
      timestamp: this.lastUpdateTimestamp,
    });
  }

  /**
   * Get the number of currently connected WebSocket clients.
   */
  getConnectedClients(): number {
    if (!this.wss) return 0;
    return this.wss.clients.size;
  }

  /**
   * Get the current signal history (last 100, reverse-chronological).
   */
  getSignalHistory(): FormattedSignal[] {
    return [...this.signals];
  }

  /**
   * Build the current state snapshot for new clients.
   */
  private buildSnapshot(): DashboardSnapshot {
    return {
      engineState: this.engineState,
      signals: [...this.signals],
      filterStatus: { ...this.filterStatus },
      kellyMetrics: this.kellyMetrics,
      lastUpdateTimestamp: this.lastUpdateTimestamp,
    };
  }

  /**
   * Broadcast a message to all connected WebSocket clients.
   */
  private broadcast(message: WsMessage): void {
    if (!this.wss) return;

    const data = JSON.stringify(message);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  /**
   * Send a message to a specific WebSocket client.
   */
  private sendToClient(ws: WebSocket, message: WsMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
}

/**
 * Factory function to create a DashboardServer instance.
 */
export function createDashboardServer(
  maxSignalHistory: number = 100
): DashboardServer {
  return new DashboardServerImpl(maxSignalHistory);
}
