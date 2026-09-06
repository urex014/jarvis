#!/usr/bin/env bash
# ==============================================================================
# J.A.R.V.I.S. Subsystem Shutdown Script
# ==============================================================================

set -euo pipefail

echo "Concealing HUD and terminating J.A.R.V.I.S. background daemons..."

# Stop voice recording and STT
bash /home/cryptic/projects/jarvis/scripts/voice_route.sh stop >/dev/null 2>&1 || true

# Kill daemons
pkill -f "daemon/overlay_window.py" 2>/dev/null || true
pkill -f "daemon/wake_word_daemon.py" 2>/dev/null || true
pkill -f "daemon/agy_bridge.py" 2>/dev/null || true
pkill -f "daemon/transcription_service.py" 2>/dev/null || true
pkill -f "pw-record" 2>/dev/null || true

# Clean sockets
rm -f /tmp/jarvis.sock /tmp/jarvis_agent.sock

echo "All J.A.R.V.I.S. subsystems deactivated, Sir."
