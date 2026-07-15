#!/usr/bin/env python3
"""
MetaTrader 5 WebSocket Bridge for the Isagi Engine Signal Bot.

Connects to a running MetaTrader 5 terminal, reads XAUUSD candle data,
and pushes completed candles to connected WebSocket clients on port 8080.

Requirements:
    pip install MetaTrader5 websockets

Usage:
    python scripts/mt5-bridge.py

Environment Variables:
    BRIDGE_PORT - Local WebSocket server port (default: 8080)
    MT5_PATH    - Path to MetaTrader5 terminal (optional, auto-detected)
"""

import asyncio
import json
import os
import signal
import sys
from datetime import datetime, timezone, timedelta
from typing import Optional

try:
    import MetaTrader5 as mt5
except ImportError:
    print("ERROR: MetaTrader5 package not installed.")
    print("  Install it with: pip install MetaTrader5")
    sys.exit(1)

try:
    import websockets
    from websockets.server import serve
except ImportError:
    print("ERROR: websockets package not installed.")
    print("  Install it with: pip install websockets")
    sys.exit(1)

# ─── Configuration ────────────────────────────────────────────────────────────

BRIDGE_PORT = int(os.environ.get("BRIDGE_PORT", "8080"))
MT5_PATH = os.environ.get("MT5_PATH", None)
SYMBOL = "XAUUSD"
POLL_INTERVAL_SECONDS = 1.0

# Timeframe mapping: our label -> MT5 constant -> duration in minutes
TIMEFRAMES = {
    "M1": {"mt5_tf": mt5.TIMEFRAME_M1, "minutes": 1},
    "M5": {"mt5_tf": mt5.TIMEFRAME_M5, "minutes": 5},
    "M15": {"mt5_tf": mt5.TIMEFRAME_M15, "minutes": 15},
    "H1": {"mt5_tf": mt5.TIMEFRAME_H1, "minutes": 60},
}

# ─── State ────────────────────────────────────────────────────────────────────

connected_clients: set = set()
last_candle_time: dict[str, Optional[datetime]] = {tf: None for tf in TIMEFRAMES}
running = True


# ─── MT5 Initialization ──────────────────────────────────────────────────────

def initialize_mt5() -> bool:
    """Initialize connection to MetaTrader 5 terminal."""
    kwargs = {}
    if MT5_PATH:
        kwargs["path"] = MT5_PATH

    if not mt5.initialize(**kwargs):
        print(f"[MT5 Bridge] Failed to initialize MT5: {mt5.last_error()}")
        return False

    # Verify XAUUSD symbol is available
    symbol_info = mt5.symbol_info(SYMBOL)
    if symbol_info is None:
        print(f"[MT5 Bridge] Symbol {SYMBOL} not found in MT5 terminal.")
        print("  Make sure XAUUSD is visible in Market Watch.")
        mt5.shutdown()
        return False

    if not symbol_info.visible:
        # Try to make the symbol visible
        if not mt5.symbol_select(SYMBOL, True):
            print(f"[MT5 Bridge] Failed to select {SYMBOL} in Market Watch.")
            mt5.shutdown()
            return False

    print(f"[MT5 Bridge] Connected to MT5 terminal.")
    print(f"[MT5 Bridge] Account: {mt5.account_info().login}")
    print(f"[MT5 Bridge] Server: {mt5.account_info().server}")
    print(f"[MT5 Bridge] Symbol: {SYMBOL} (spread: {symbol_info.spread})")
    return True


# ─── Candle Fetching ──────────────────────────────────────────────────────────

def get_latest_closed_candle(timeframe_label: str) -> Optional[dict]:
    """
    Fetch the most recently closed candle for the given timeframe.
    Returns None if no new candle since last check.

    MT5 returns candles where index 0 is the current (incomplete) candle.
    We want index 1 (the last fully closed candle).
    """
    tf_config = TIMEFRAMES[timeframe_label]
    mt5_tf = tf_config["mt5_tf"]

    # Get the last 2 candles (current incomplete + last closed)
    rates = mt5.copy_rates_from_pos(SYMBOL, mt5_tf, 0, 2)

    if rates is None or len(rates) < 2:
        return None

    # Index 0 = oldest (closed), Index 1 = newest (current/incomplete)
    # Actually MT5 copy_rates_from_pos returns in chronological order:
    # rates[0] = second-to-last candle (closed)
    # rates[1] = last candle (potentially still open)
    # We want rates[0] which is the last fully closed candle
    closed_candle = rates[0]

    # Convert timestamp to datetime (MT5 gives Unix timestamp in seconds)
    candle_time = datetime.fromtimestamp(closed_candle["time"], tz=timezone.utc)

    # Check if this is a new candle we haven't emitted yet
    if last_candle_time[timeframe_label] is not None:
        if candle_time <= last_candle_time[timeframe_label]:
            return None  # Already emitted this candle

    last_candle_time[timeframe_label] = candle_time

    return {
        "instrument": "XAUUSD",
        "timestamp": candle_time.isoformat(timespec="milliseconds"),
        "open": float(closed_candle["open"]),
        "high": float(closed_candle["high"]),
        "low": float(closed_candle["low"]),
        "close": float(closed_candle["close"]),
        "volume": int(closed_candle["tick_volume"]),
        "timeframe": timeframe_label,
    }


# ─── WebSocket Server ─────────────────────────────────────────────────────────

async def handle_client(websocket):
    """Handle a new WebSocket client connection."""
    connected_clients.add(websocket)
    client_addr = websocket.remote_address
    print(f"[MT5 Bridge] Client connected: {client_addr}. Total: {len(connected_clients)}")

    try:
        async for _ in websocket:
            # We don't expect messages from clients, just keep connection alive
            pass
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        connected_clients.discard(websocket)
        print(f"[MT5 Bridge] Client disconnected: {client_addr}. Total: {len(connected_clients)}")


async def broadcast_candle(candle: dict):
    """Broadcast a completed candle to all connected clients."""
    if not connected_clients:
        return

    payload = json.dumps(candle)
    # Send to all connected clients
    disconnected = set()
    for client in connected_clients:
        try:
            await client.send(payload)
        except websockets.exceptions.ConnectionClosed:
            disconnected.add(client)

    # Clean up disconnected clients
    for client in disconnected:
        connected_clients.discard(client)


# ─── Main Polling Loop ────────────────────────────────────────────────────────

async def candle_poll_loop():
    """
    Continuously poll MT5 for new closed candles across all timeframes.
    Only emits a candle when it detects a new completed one.
    """
    global running
    print("[MT5 Bridge] Starting candle polling loop...")

    while running:
        for tf_label in TIMEFRAMES:
            candle = get_latest_closed_candle(tf_label)
            if candle is not None:
                await broadcast_candle(candle)
                print(
                    f"[MT5 Bridge] Emitted {candle['timeframe']} candle @ {candle['timestamp']} "
                    f"O={candle['open']:.2f} H={candle['high']:.2f} "
                    f"L={candle['low']:.2f} C={candle['close']:.2f} V={candle['volume']}"
                )

        await asyncio.sleep(POLL_INTERVAL_SECONDS)


# ─── Entry Point ──────────────────────────────────────────────────────────────

async def main():
    global running

    print("""
╔══════════════════════════════════════════════════════════════╗
║  Isagi Engine - MetaTrader 5 XAU/USD Bridge                 ║
║                                                              ║
║  Local WebSocket server: ws://localhost:{port:<5}             ║
║  Symbol: XAUUSD                                              ║
║  Timeframes: M1, M5, M15, H1                                ║
║  Only closed candles are emitted.                            ║
╚══════════════════════════════════════════════════════════════╝
""".format(port=BRIDGE_PORT))

    # Initialize MT5
    if not initialize_mt5():
        print("[MT5 Bridge] Failed to initialize. Exiting.")
        sys.exit(1)

    # Setup graceful shutdown
    loop = asyncio.get_event_loop()

    def shutdown_handler():
        global running
        running = False
        print("\n[MT5 Bridge] Shutting down...")

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, shutdown_handler)

    # Start WebSocket server
    async with serve(handle_client, "0.0.0.0", BRIDGE_PORT) as server:
        print(f"[MT5 Bridge] WebSocket server listening on port {BRIDGE_PORT}")

        # Run the polling loop
        try:
            await candle_poll_loop()
        except asyncio.CancelledError:
            pass

    # Cleanup
    mt5.shutdown()
    print("[MT5 Bridge] MT5 connection closed. Goodbye.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[MT5 Bridge] Interrupted. Shutting down...")
        mt5.shutdown()
