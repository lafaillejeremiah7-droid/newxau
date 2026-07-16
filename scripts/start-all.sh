#!/bin/bash
# Isagi Engine - Start Everything (Bridge + Bot)
# Usage: npm run start:all

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Isagi Engine - Starting Signal Bot + Live Data Bridge"
echo "  Dashboard: http://localhost:3000"
echo "  Data: TradingView XAU/USD (real-time, no API key)"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Create data directory if it doesn't exist
mkdir -p data

# Build TypeScript if dist/ doesn't exist
if [ ! -f dist/main.js ]; then
  echo "[Startup] Building TypeScript..."
  npx tsc
fi

# Start the bridge in background
echo "[Startup] Starting live data bridge..."
npx tsx src/bridges/live-data-bridge.ts &
BRIDGE_PID=$!

# Wait for bridge to be ready
sleep 3

# Start the bot
echo "[Startup] Starting signal bot..."
node dist/main.js &
BOT_PID=$!

echo ""
echo "[Startup] Both processes started:"
echo "  Bridge PID: $BRIDGE_PID"
echo "  Bot PID: $BOT_PID"
echo ""
echo "  Dashboard: http://localhost:3000"
echo "  Press Ctrl+C to stop both."
echo ""

# Handle Ctrl+C - kill both processes
cleanup() {
  echo ""
  echo "[Startup] Shutting down..."
  kill $BOT_PID 2>/dev/null
  kill $BRIDGE_PID 2>/dev/null
  wait $BOT_PID 2>/dev/null
  wait $BRIDGE_PID 2>/dev/null
  echo "[Startup] Done."
  exit 0
}

trap cleanup SIGINT SIGTERM

# Wait for either process to exit
wait -n $BRIDGE_PID $BOT_PID 2>/dev/null
cleanup
