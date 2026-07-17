#!/bin/bash
# Isagi Engine - Start Everything (Bridge + Bot)
# Usage: npm run start:all

set -u

BRIDGE_PORT="${BRIDGE_PORT:-8080}"
export WS_URL="${WS_URL:-ws://localhost:${BRIDGE_PORT}}"
BRIDGE_PID=""
BOT_PID=""
OWN_BRIDGE=0
EXIT_STATUS=0

port_is_open() {
  PORT_TO_CHECK="$1" node -e "const net = require('node:net'); const socket = net.createConnection({ host: '127.0.0.1', port: Number(process.env.PORT_TO_CHECK) }); socket.once('connect', () => { socket.destroy(); process.exit(0); }); socket.once('error', () => process.exit(1)); setTimeout(() => process.exit(1), 500);" >/dev/null 2>&1
}

bridge_is_ready() {
  BRIDGE_PORT_TO_CHECK="$1" node -e "const WebSocket = require('ws'); let finished = false; const finish = (code) => { if (finished) return; finished = true; process.exit(code); }; const ws = new WebSocket('ws://127.0.0.1:' + process.env.BRIDGE_PORT_TO_CHECK); ws.once('open', () => { ws.close(); finish(0); }); ws.once('error', () => finish(1)); setTimeout(() => finish(1), 1000);" >/dev/null 2>&1
}

cleanup() {
  local status="${1:-0}"
  trap - INT TERM EXIT

  echo ""
  echo "[Startup] Shutting down..."

  if [[ -n "$BOT_PID" ]] && kill -0 "$BOT_PID" 2>/dev/null; then
    kill "$BOT_PID" 2>/dev/null || true
  fi

  # Only stop the bridge launched by this script. An existing bridge is reused.
  if [[ "$OWN_BRIDGE" -eq 1 ]] && [[ -n "$BRIDGE_PID" ]] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
    kill "$BRIDGE_PID" 2>/dev/null || true
  fi

  if [[ -n "$BOT_PID" ]]; then
    wait "$BOT_PID" 2>/dev/null || true
  fi
  if [[ "$OWN_BRIDGE" -eq 1 ]] && [[ -n "$BRIDGE_PID" ]]; then
    wait "$BRIDGE_PID" 2>/dev/null || true
  fi

  echo "[Startup] Done."
  exit "$status"
}

on_signal() {
  cleanup 0
}

trap on_signal INT TERM
trap 'cleanup "$?"' EXIT

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Isagi Engine - Starting Signal Bot + Live Data Bridge"
echo "  Dashboard: http://localhost:3000"
echo "  Data: TradingView XAU/USD (real-time, no API key)"
echo "═══════════════════════════════════════════════════════════════"
echo ""

echo "[Startup] Building TypeScript and refreshing dashboard assets..."
if ! npm run build; then
  echo "[Startup] ERROR: Build failed. Nothing was started."
  exit 1
fi

if bridge_is_ready "$BRIDGE_PORT"; then
  echo "[Startup] Reusing existing Isagi WebSocket bridge on port $BRIDGE_PORT."
else
  if port_is_open "$BRIDGE_PORT"; then
    echo "[Startup] Port $BRIDGE_PORT is occupied by a non-Isagi service; selecting a free bridge port."
    candidate_port=$((BRIDGE_PORT + 1))
    while port_is_open "$candidate_port"; do
      candidate_port=$((candidate_port + 1))
    done
    BRIDGE_PORT="$candidate_port"
  fi

  # Keep the bot and bridge on the same local port when a fallback is needed.
  export BRIDGE_PORT
  export WS_URL="ws://localhost:${BRIDGE_PORT}"

  echo "[Startup] Starting live data bridge on port $BRIDGE_PORT..."
  npm run start:bridge &
  BRIDGE_PID=$!
  OWN_BRIDGE=1

  bridge_ready=0
  for _ in {1..40}; do
    if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
      echo "[Startup] ERROR: Live data bridge exited before becoming ready."
      wait "$BRIDGE_PID" 2>/dev/null || true
      exit 1
    fi
    if port_is_open "$BRIDGE_PORT"; then
      bridge_ready=1
      break
    fi
    sleep 0.25
  done

  if [[ "$bridge_ready" -ne 1 ]]; then
    echo "[Startup] ERROR: Live data bridge did not open port $BRIDGE_PORT within 10 seconds."
    exit 1
  fi
fi

echo "[Startup] Starting signal bot..."
npm run start &
BOT_PID=$!

echo ""
echo "[Startup] Both processes are running:"
if [[ "$OWN_BRIDGE" -eq 1 ]]; then
  echo "  Bridge PID: $BRIDGE_PID"
else
  echo "  Bridge: existing process on port $BRIDGE_PORT"
fi
echo "  Bot PID: $BOT_PID"
echo ""
echo "  Dashboard: http://localhost:3000"
echo "  Press Ctrl+C to stop the bot and any bridge started by this script."
echo ""

if [[ "$OWN_BRIDGE" -eq 1 ]]; then
  wait -n "$BRIDGE_PID" "$BOT_PID" 2>/dev/null || EXIT_STATUS=$?
else
  wait "$BOT_PID" 2>/dev/null || EXIT_STATUS=$?
fi

cleanup "$EXIT_STATUS"
