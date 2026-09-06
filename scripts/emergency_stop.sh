#!/usr/bin/env bash
# ==============================================================================
# J.A.R.V.I.S. Emergency Stop & Audio Termination Script
# Halts audio playback, active TTS, and running agent processes immediately.
# ==============================================================================

# 1. Stop active microphone capture immediately
bash /home/cryptic/projects/jarvis/scripts/voice_route.sh stop >/dev/null 2>&1 || true

# 2. Kill audio players immediately
pkill -9 paplay 2>/dev/null || true
pkill -9 pw-play 2>/dev/null || true
pkill -9 aplay 2>/dev/null || true
pkill -9 spd-say 2>/dev/null || true

# 3. Kill Piper and TTS worker processes
pkill -9 -f "piper" 2>/dev/null || true
pkill -9 -f "daemon/tts_service.py" 2>/dev/null || true

# 3. Clear speaking state flag
rm -f /tmp/jarvis_is_speaking

# 4. Notify bridge and overlay sockets
python3 -c "
import socket, json
for s_path in ['/tmp/jarvis.sock', '/tmp/jarvis_agent.sock']:
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(0.3)
            s.connect(s_path)
            s.sendall(json.dumps({'event': 'stop', 'action': 'stop'}).encode('utf-8') + b'\n')
    except Exception:
        pass
" 2>/dev/null || true

echo "[EMERGENCY_STOP] J.A.R.V.I.S. audio and agent execution halted."
