#!/usr/bin/env bash
# ==============================================================================
# J.A.R.V.I.S. Unified Subsystem Supervisor
# Starts the Wake Daemon, agy Bridge, and STT pipeline
# ==============================================================================

set -euo pipefail

PROJECT_DIR="/home/cryptic/projects/jarvis"
PYTHON_BIN="${PROJECT_DIR}/.venv/bin/python"

echo "=== Initializing J.A.R.V.I.S. Core Infrastructure ==="

# 1. Start agy Agent Bridge Daemon
if ! pgrep -f "daemon/agy_bridge.py" >/dev/null 2>&1; then
    echo "Starting agy Agent Bridge (WebSocket + IPC)..."
    "$PYTHON_BIN" "${PROJECT_DIR}/daemon/agy_bridge.py" > /tmp/jarvis_agy_bridge.log 2>&1 &
    echo "agy Agent Bridge started (PID: $!)."
else
    echo "agy Agent Bridge is already active."
fi

# 2. Start Wake Word Daemon
if ! pgrep -f "daemon/wake_word_daemon.py" >/dev/null 2>&1; then
    echo "Starting Wake Word Detection Daemon (Vosk offline)..."
    "$PYTHON_BIN" "${PROJECT_DIR}/daemon/wake_word_daemon.py" > /tmp/jarvis_wake_daemon.log 2>&1 &
    echo "Wake Word Daemon started (PID: $!)."
else
    echo "Wake Word Daemon is already active."
fi

echo "=== All background daemons online ==="
echo "To start the frontend overlay UI: npm run tauri dev"
