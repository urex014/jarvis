#!/usr/bin/env bash
# ==============================================================================
# J.A.R.V.I.S. Unified Subsystem Supervisor
# Starts the Wake Daemon, agy Bridge, and STT pipeline
# ==============================================================================

set -euo pipefail

PROJECT_DIR="/home/cryptic/projects/jarvis"
PYTHON_BIN="${PROJECT_DIR}/.venv/bin/python"

echo "=== Initializing J.A.R.V.I.S. Core Infrastructure ==="

# 1. Start Desktop HUD Overlay (Native Gtk WebKit)
if ! pgrep -f "daemon/overlay_window.py" >/dev/null 2>&1; then
    echo "Starting Desktop HUD Overlay..."
    nohup python3 "${PROJECT_DIR}/daemon/overlay_window.py" --hidden > /tmp/jarvis_overlay.log 2>&1 &
    disown
    echo "Desktop HUD Overlay started."
else
    echo "Desktop HUD Overlay is already active."
fi

# 2. Start agy Agent Bridge Daemon
if ! pgrep -f "daemon/agy_bridge.py" >/dev/null 2>&1; then
    echo "Starting agy Agent Bridge (WebSocket + IPC)..."
    nohup "$PYTHON_BIN" "${PROJECT_DIR}/daemon/agy_bridge.py" > /tmp/jarvis_agy_bridge.log 2>&1 &
    disown
    echo "agy Agent Bridge started."
else
    echo "agy Agent Bridge is already active."
fi

# 3. Start Wake Word Daemon
if ! pgrep -f "daemon/wake_word_daemon.py" >/dev/null 2>&1; then
    echo "Starting Wake Word Detection Daemon (Vosk offline)..."
    nohup "$PYTHON_BIN" "${PROJECT_DIR}/daemon/wake_word_daemon.py" > /tmp/jarvis_wake_daemon.log 2>&1 &
    disown
    echo "Wake Word Daemon started."
else
    echo "Wake Word Daemon is already active."
fi

echo "=== All J.A.R.V.I.S. subsystems operational ==="
echo "Say 'Jarvis' or 'Hey Jarvis' to activate the HUD."
