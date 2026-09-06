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
LOG_FILE="${RUNTIME_DIR}/jarvis_voice_route.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [VOICE_ROUTE] $*" | tee -a "$LOG_FILE"
}

start_routing() {
    log "Initializing microphone stream routing..."

    # Check if already recording
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        log "Microphone routing is already actively running (PID: $(cat "$PID_FILE"))."
        return 0
    fi

    # Mark state as active
    echo "ACTIVE" > "$STATE_FILE"

    # Ensure FIFO exists for streaming raw 16kHz audio to transcription service
    if [[ ! -p "$AUDIO_FIFO" ]]; then
        rm -f "$AUDIO_FIFO"
        mkfifo "$AUDIO_FIFO"
    fi

    # Start audio recorder in background feeding the FIFO or transcription buffer
    # Uses pw-record if available (PipeWire native), otherwise fall back to arecord
    if command -v pw-record >/dev/null 2>&1; then
        log "Engaging PipeWire native capture (pw-record, 16kHz mono S16_LE)..."
        (pw-record --rate=16000 --channels=1 --format=s16 "$AUDIO_FIFO" >/dev/null 2>&1 & echo $! > "$PID_FILE") || true
    elif command -v arecord >/dev/null 2>&1; then
        log "Engaging ALSA capture (arecord, 16kHz mono S16_LE)..."
        (arecord -q -r 16000 -c 1 -f S16_LE -t raw "$AUDIO_FIFO" >/dev/null 2>&1 & echo $! > "$PID_FILE") || true
    else
        log "Warning: Neither pw-record nor arecord located on PATH."
    fi

    log "Microphone routing initiated successfully. Audio stream buffered at $AUDIO_FIFO"
}

stop_routing() {
    log "Terminating microphone routing..."
    if [[ -f "$PID_FILE" ]]; then
        PID="$(cat "$PID_FILE" 2>/dev/null || true)"
        if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
            kill "$PID" 2>/dev/null || true
            log "Terminated recorder process $PID."
        fi
        rm -f "$PID_FILE"
    fi
    echo "IDLE" > "$STATE_FILE"
    log "Microphone routing stopped."
}

status_routing() {
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "ACTIVE (PID: $(cat "$PID_FILE"))"
    else
        echo "IDLE"
    fi
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
