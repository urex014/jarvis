#!/usr/bin/env bash
# ==============================================================================
# J.A.R.V.I.S. Voice Capture & Transcription Routing Script
# Activated upon wake-word detection or direct /voice invocation
# ==============================================================================

set -euo pipefail

RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}"
STATE_FILE="${RUNTIME_DIR}/jarvis_voice_state"
AUDIO_FIFO="${RUNTIME_DIR}/jarvis_audio_stream.raw"
PID_FILE="${RUNTIME_DIR}/jarvis_voice_recorder.pid"
STT_PID_FILE="${RUNTIME_DIR}/jarvis_voice_stt.pid"
LOG_FILE="${RUNTIME_DIR}/jarvis_voice_route.log"
PROJECT_DIR="/home/cryptic/projects/jarvis"
PYTHON_BIN="${PROJECT_DIR}/.venv/bin/python"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [VOICE_ROUTE] $*" | tee -a "$LOG_FILE"
}

start_routing() {
    log "Initializing microphone stream routing..."

    # Ensure any previous recorder or STT processes are cleanly stopped first
    stop_routing >/dev/null 2>&1 || true

    # Mark state as active
    echo "ACTIVE" > "$STATE_FILE"

    # Ensure FIFO exists for streaming raw 16kHz audio to transcription service
    rm -f "$AUDIO_FIFO"
    mkfifo "$AUDIO_FIFO"

    # Start audio recorder in background feeding the FIFO via stdout redirect
    if command -v pw-record >/dev/null 2>&1; then
        log "Engaging PipeWire native capture (pw-record, 16kHz mono S16_LE)..."
        (pw-record --rate=16000 --channels=1 --format=s16 - > "$AUDIO_FIFO" 2>/dev/null & echo $! > "$PID_FILE") || true
    elif command -v arecord >/dev/null 2>&1; then
        log "Engaging ALSA capture (arecord, 16kHz mono S16_LE)..."
        (arecord -q -r 16000 -c 1 -f S16_LE -t raw - > "$AUDIO_FIFO" 2>/dev/null & echo $! > "$PID_FILE") || true
    else
        log "Warning: Neither pw-record nor arecord located on PATH."
    fi

    # Launch background transcription engine for this turn
    if [[ -x "$PYTHON_BIN" ]]; then
        log "Launching background transcription engine (Vosk low-latency STT)..."
        ("$PYTHON_BIN" "${PROJECT_DIR}/daemon/transcription_service.py" --fifo-path "$AUDIO_FIFO" >> "$LOG_FILE" 2>&1 & echo $! > "$STT_PID_FILE") || true
    fi

    log "Microphone routing initiated successfully. Audio stream buffered at $AUDIO_FIFO"
}

stop_routing() {
    log "Terminating microphone routing..."
    if [[ -f "$PID_FILE" ]]; then
        PID="$(cat "$PID_FILE" 2>/dev/null || true)"
        if [[ -n "$PID" ]]; then
            kill -9 "$PID" 2>/dev/null || true
            log "Terminated recorder process $PID."
        fi
        rm -f "$PID_FILE"
    fi
    pkill -9 -f "pw-record.*jarvis_audio_stream" 2>/dev/null || true

    if [[ -f "$STT_PID_FILE" ]]; then
        STT_PID="$(cat "$STT_PID_FILE" 2>/dev/null || true)"
        if [[ -n "$STT_PID" ]]; then
            kill -9 "$STT_PID" 2>/dev/null || true
            log "Terminated STT engine process $STT_PID."
        fi
        rm -f "$STT_PID_FILE"
    fi
    pkill -9 -f "daemon/transcription_service.py" 2>/dev/null || true

    echo "IDLE" > "$STATE_FILE"
    log "Microphone routing stopped."
}

status_routing() {
    local rec_status="IDLE"
    local stt_status="IDLE"
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        rec_status="ACTIVE (PID: $(cat "$PID_FILE"))"
    fi
    if [[ -f "$STT_PID_FILE" ]] && kill -0 "$(cat "$STT_PID_FILE")" 2>/dev/null; then
        stt_status="ACTIVE (PID: $(cat "$STT_PID_FILE"))"
    fi
    echo "RECORDER: ${rec_status} | STT_ENGINE: ${stt_status}"
}

case "${1:-start}" in
    start)
        start_routing
        ;;
    stop)
        stop_routing
        ;;
    status)
        status_routing
        ;;
    *)
        echo "Usage: $0 {start|stop|status}"
        exit 1
        ;;
esac
