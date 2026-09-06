#!/usr/bin/env python3
"""
J.A.R.V.I.S. Wake Word Detection Daemon
Continuously listens for "Jarvis" / "Hey Jarvis" offline using Vosk.
Emits IPC events to Tauri via Unix domain socket and triggers /voice routing.
"""

import os
import sys
import json
import time
import queue
import socket
import signal
import logging
import argparse
import subprocess
from pathlib import Path

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [J.A.R.V.I.S. WAKE] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger("JarvisWakeDaemon")

DEFAULT_SOCKET_PATH = "/tmp/jarvis.sock"
DEFAULT_MODEL_DIR = os.path.expanduser("~/.cache/vosk/vosk-model-small-en-us-0.15")
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_VOICE_SCRIPT = str(PROJECT_ROOT / "scripts" / "voice_route.sh")

audio_queue = queue.Queue()
running = True

def signal_handler(signum, frame):
    global running
    logger.info("Termination signal received. Shutting down gracefully...")
    running = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

def play_wake_ack():
    """Immediately plays acoustic acknowledgement ('Yes, Sir?') through system speakers."""
    ack_path = PROJECT_ROOT / "wake_ack.wav"
    if ack_path.exists():
        try:
            subprocess.Popen(["paplay", str(ack_path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            logger.info("Acoustic wake acknowledgement dispatched ('Yes, Sir?').")
        except Exception as e:
            logger.debug("Acoustic playback failed: %s", e)

def notify_tauri_overlay(socket_path: str, phrase: str) -> bool:
    """Dispatches wake-word event to Tauri overlay and agent bridge sockets."""
    payload = {
        "event": "wake_word",
        "phrase": phrase,
        "timestamp": int(time.time() * 1000)
    }
    raw = (json.dumps(payload) + "\n").encode("utf-8")
    sent = False

    for target in [socket_path, "/tmp/jarvis_agent.sock"]:
        if os.path.exists(target):
            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    client.settimeout(1.0)
                    client.connect(target)
                    client.sendall(raw)
                    sent = True
                    logger.info("Dispatched wake event to %s: %s", target, payload)
            except Exception as e:
                logger.debug("Failed sending to %s: %s", target, e)
    return sent

def trigger_voice_routing(voice_script_path: str):
    """Executes the voice route script to pipe microphone input to transcription."""
    if os.path.exists(voice_script_path):
        try:
            subprocess.Popen(["bash", voice_script_path, "start"])
            logger.info("Voice routing script triggered: %s start", voice_script_path)
        except Exception as e:
            logger.error("Error executing voice route script: %s", e)
    else:
        logger.warning("Voice routing script not found at %s", voice_script_path)

def audio_callback(indata, frames, time_info, status):
    """Sounddevice input stream callback."""
    if status:
        logger.debug("Audio callback status: %s", status)
    audio_queue.put(bytes(indata))

def run_daemon(model_path: str, socket_path: str, voice_script: str, device=None):
    from vosk import Model, KaldiRecognizer, SetLogLevel
    import sounddevice as sd

    SetLogLevel(-1) # Quiet Vosk internal logging

    logger.info("Initializing Vosk wake word engine...")
    if not os.path.exists(model_path):
        logger.info("Model path %s not found. Attempting automatic download (en-us)...", model_path)
        model = Model(lang="en-us")
    else:
        model = Model(model_path)

    # Constrain grammar to wake words + unk to maximize speed and minimize CPU
    grammar = '["jarvis", "hey jarvis", "[unk]"]'
    samplerate = 16000
    recognizer = KaldiRecognizer(model, samplerate, grammar)
    recognizer.SetWords(False)

    logger.info("Wake word grammar loaded: 'jarvis', 'hey jarvis'.")
    logger.info("Opening audio input stream at %d Hz...", samplerate)

    cooldown_seconds = 2.5
    last_trigger_time = 0.0

    try:
        with sd.RawInputStream(
            samplerate=samplerate,
            blocksize=4000,
            device=device,
            dtype="int16",
            channels=1,
            callback=audio_callback
        ):
            logger.info("J.A.R.V.I.S. is listening. Standing by for wake directives, Sir.")
            while running:
                try:
                    data = audio_queue.get(timeout=0.5)
                except queue.Empty:
                    continue

                if recognizer.AcceptWaveform(data):
                    res = json.loads(recognizer.Result())
                    text = res.get("text", "").strip().lower()
                    if text in ("jarvis", "hey jarvis"):
                        now = time.time()
                        if now - last_trigger_time > cooldown_seconds:
                            last_trigger_time = now
                            logger.info(">>> WAKE PHRASE DETECTED: '%s' <<<", text)
                            play_wake_ack()
                            notify_tauri_overlay(socket_path, text)
                            trigger_voice_routing(voice_script)
                        else:
                            logger.debug("Wake phrase '%s' ignored due to cooldown.", text)
                else:
                    # Check partial result for lower latency
                    partial = json.loads(recognizer.PartialResult())
                    partial_text = partial.get("partial", "").strip().lower()
                    if partial_text in ("jarvis", "hey jarvis"):
                        now = time.time()
                        if now - last_trigger_time > cooldown_seconds:
                            last_trigger_time = now
                            logger.info(">>> WAKE PHRASE DETECTED (PARTIAL): '%s' <<<", partial_text)
                            recognizer.Reset()
                            play_wake_ack()
                            notify_tauri_overlay(socket_path, partial_text)
                            trigger_voice_routing(voice_script)

    except Exception as e:
        logger.error("Audio stream failure: %s", e)
        raise

def simulate_detection(socket_path: str, voice_script: str, phrase: str = "jarvis"):
    logger.info("Running wake-word simulation test...")
    logger.info("Target socket: %s", socket_path)
    logger.info("Simulated phrase: '%s'", phrase)

    # 1. Trigger voice routing script
    trigger_voice_routing(voice_script)

    # 2. Notify Tauri overlay
    success = notify_tauri_overlay(socket_path, phrase)
    if success:
        logger.info("Simulation successful: Tauri overlay notified.")
    else:
        logger.info("Simulation completed (Tauri socket unreachable or not open yet).")

def main():
    parser = argparse.ArgumentParser(description="J.A.R.V.I.S. Background Wake Word Daemon")
    parser.add_argument("--model-path", default=DEFAULT_MODEL_DIR, help="Path to Vosk model")
    parser.add_argument("--socket-path", default=DEFAULT_SOCKET_PATH, help="Unix domain socket path")
    parser.add_argument("--voice-script", default=DEFAULT_VOICE_SCRIPT, help="Path to voice route script")
    parser.add_argument("--device", type=int, default=None, help="Audio input device index")
    parser.add_argument("--simulate", action="store_true", help="Simulate wake detection for testing")
    parser.add_argument("--phrase", default="jarvis", help="Phrase to simulate ('jarvis' or 'hey jarvis')")

    args = parser.parse_args()

    if args.simulate:
        simulate_detection(args.socket_path, args.voice_script, args.phrase)
        sys.exit(0)

    run_daemon(args.model_path, args.socket_path, args.voice_script, args.device)

if __name__ == "__main__":
    main()
