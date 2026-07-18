#!/bin/bash
# Isagi Engine - Start isolated XAU/USD and BTC/USD signal runtimes.
# Usage: npm run start:all
# Set START_INSTRUMENTS=XAUUSD or START_INSTRUMENTS=BTCUSD to run one runtime.

set -u

XAU_BRIDGE_PORT="${XAU_BRIDGE_PORT:-8080}"
BTC_BRIDGE_PORT="${BTC_BRIDGE_PORT:-8081}"
XAU_DASHBOARD_PORT="${XAU_DASHBOARD_PORT:-3000}"
BTC_DASHBOARD_PORT="${BTC_DASHBOARD_PORT:-3001}"
XAU_DB_PATH="${XAU_DB_PATH:-./data/signals.db}"
BTC_DB_PATH="${BTC_DB_PATH:-./data/signals-btc.db}"
START_INSTRUMENTS="${START_INSTRUMENTS:-XAUUSD,BTCUSD}"

PIDS=()

port_is_open() {
  PORT_TO_CHECK="$1" node -e "const net = require('node:net'); const socket = net.createConnection({ host: '127.0.0.1', port: Number(process.env.PORT_TO_CHECK) }); socket.once('connect', () => { socket.destroy(); process.exit(0); }); socket.once('error', () => process.exit(1)); setTimeout(() => process.exit(1), 500);" >/dev/null 2>&1
}

cleanup() {
  local status="${1:-0}"
  trap - INT TERM EXIT
  echo ""
  echo "[Startup] Shutting down signal runtimes..."
  for pid in "${PIDS[@]}"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  for pid in "${PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
  echo "[Startup] Done."
  exit "$status"
}

on_signal() {
  cleanup 0
}

trap on_signal INT TERM
trap 'cleanup "$?"' EXIT

TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"

if [[ -z "$TELEGRAM_BOT_TOKEN" || -z "$TELEGRAM_CHAT_ID" ]]; then
  echo "[Startup] ERROR: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set."
  echo "[Startup] No signal runtime was started."
  exit 1
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Isagi Engine - Starting isolated signal runtimes"
echo "  XAU/USD: bridge ${XAU_BRIDGE_PORT}, dashboard ${XAU_DASHBOARD_PORT}"
echo "  BTC/USD: bridge ${BTC_BRIDGE_PORT}, dashboard ${BTC_DASHBOARD_PORT}"
echo "  SIGNAL ONLY - no automatic order execution"
echo "═══════════════════════════════════════════════════════════════"
echo ""

echo "[Startup] Building TypeScript and refreshing dashboard assets..."
if ! npm run build; then
  echo "[Startup] ERROR: Build failed. Nothing was started."
  exit 1
fi

start_runtime() {
  local instrument="$1"
  local bridge_port="$2"
  local dashboard_port="$3"
  local db_path="$4"
  local bridge_pid
  local bot_pid

  while port_is_open "$bridge_port"; do
    echo "[Startup] Port ${bridge_port} is occupied; selecting the next free bridge port."
    bridge_port=$((bridge_port + 1))
  done
  while port_is_open "$dashboard_port"; do
    echo "[Startup] Port ${dashboard_port} is occupied; selecting the next free dashboard port."
    dashboard_port=$((dashboard_port + 1))
  done

  echo "[Startup] Starting ${instrument} TradingView bridge on port ${bridge_port}..."
  INSTRUMENT="$instrument" BRIDGE_PORT="$bridge_port" npm run start:bridge &
  bridge_pid=$!
  PIDS+=("$bridge_pid")

  for _ in {1..40}; do
    if ! kill -0 "$bridge_pid" 2>/dev/null; then
      echo "[Startup] ERROR: ${instrument} bridge exited before becoming ready."
      return 1
    fi
    if port_is_open "$bridge_port"; then
      break
    fi
    sleep 0.25
  done
  if ! port_is_open "$bridge_port"; then
    echo "[Startup] ERROR: ${instrument} bridge did not open port ${bridge_port}."
    return 1
  fi

  echo "[Startup] Starting ${instrument} signal bot..."
  INSTRUMENT="$instrument" WS_URL="ws://localhost:${bridge_port}" \
    DASHBOARD_PORT="$dashboard_port" DB_PATH="$db_path" \
    TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" TELEGRAM_CHAT_ID="$TELEGRAM_CHAT_ID" npm start &
  bot_pid=$!
  PIDS+=("$bot_pid")
  echo "[Startup] ${instrument} bridge PID=${bridge_pid}, bot PID=${bot_pid}"
}

IFS=',' read -r -a requested_instruments <<< "$START_INSTRUMENTS"
for requested in "${requested_instruments[@]}"; do
  instrument="${requested^^}"
  case "$instrument" in
    XAUUSD) start_runtime "$instrument" "$XAU_BRIDGE_PORT" "$XAU_DASHBOARD_PORT" "$XAU_DB_PATH" || exit 1 ;;
    BTCUSD) start_runtime "$instrument" "$BTC_BRIDGE_PORT" "$BTC_DASHBOARD_PORT" "$BTC_DB_PATH" || exit 1 ;;
    *) echo "[Startup] ERROR: Unsupported START_INSTRUMENTS value: ${requested}"; exit 1 ;;
  esac
done

echo ""
echo "[Startup] Signal runtimes are running."
echo "  XAU/USD signals use ${XAU_DB_PATH}; BTC/USD signals use ${BTC_DB_PATH}."
echo "  Press Ctrl+C to stop all runtimes."
echo ""

wait -n "${PIDS[@]}" 2>/dev/null || true
cleanup 0
