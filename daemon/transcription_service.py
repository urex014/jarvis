#!/usr/bin/env python3
"""
J.A.R.V.I.S. Real-Time Speech-to-Text (STT) Transcription Service
Pipes raw microphone audio (PipeWire FIFO or direct capture) into a local
low-latency model (Vosk) or cloud API (Deepgram), streaming tokens to Tauri.
"""

import os
import sys
import json
import time
import socket
import signal
import logging
import argparse
import threading
import re
import subprocess
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [J.A.R.V.I.S. STT] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger("JarvisSTT")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOCKET_PATH = "/tmp/jarvis.sock"
DEFAULT_MODEL_DIR = os.path.expanduser("~/.cache/vosk/vosk-model-small-en-us-0.15")
RUNTIME_DIR = os.environ.get("XDG_RUNTIME_DIR", "/tmp")
DEFAULT_AUDIO_FIFO = os.path.join(RUNTIME_DIR, "jarvis_audio_stream.raw")

running = True

def signal_handler(signum, frame):
    global running
    logger.info("Termination signal received. Shutting down STT service...")
    running = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

class IPCClient:
    """Manages continuous or reconnecting IPC socket connection to Tauri."""
    def __init__(self, socket_path: str):
        self.socket_path = socket_path
        self.sock = None

    def connect(self) -> bool:
        if not os.path.exists(self.socket_path):
            return False
        try:
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(2.0)
            self.sock.connect(self.socket_path)
            return True
        except Exception as e:
            logger.debug("Could not connect to Tauri socket %s: %s", self.socket_path, e)
            self.sock = None
            return False

    def send_event(self, event_type: str, data: dict):
        payload = {
            "event": event_type,
            "timestamp": int(time.time() * 1000),
            **data
        }
        raw = (json.dumps(payload) + "\n").encode("utf-8")
        
        # Try direct send or reconnect
        for attempt in range(2):
            if self.sock is None:
                if not self.connect():
                    return False
            try:
                self.sock.sendall(raw)
                return True
            except Exception:
                try:
                    if self.sock:
                        self.sock.close()
                except Exception:
                    pass
                self.sock = None
        return False

    def close(self):
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass
            self.sock = None

def stream_simulation(ipc: IPCClient, text: str):
    """Simulates real-time token-by-token transcription streaming."""
    logger.info("Initiating simulated token streaming: '%s'", text)
    ipc.send_event("stt_state", {"state": "listening"})
    time.sleep(0.3)

    words = text.split()
    accumulated = []
    
    for word in words:
        if not running:
            break
        accumulated.append(word)
        current_partial = " ".join(accumulated)
        logger.info("Partial token stream: '%s'", current_partial)
        ipc.send_event("stt_partial", {
            "text": current_partial,
            "last_token": word,
            "token_count": len(accumulated)
        })
        time.sleep(0.12) # Realistic speech pacing

    if running:
        logger.info("Final transcription emitted: '%s'", text)
        ipc.send_event("stt_final", {
            "text": text,
            "token_count": len(words)
        })
        ipc.send_event("stt_state", {"state": "idle"})

def run_vosk_fifo_stream(model_path: str, fifo_path: str, ipc: IPCClient):
    """Reads raw 16kHz PCM from FIFO and streams transcribed tokens to Tauri."""
    global running
    from vosk import Model, KaldiRecognizer, SetLogLevel
    SetLogLevel(-1)

    logger.info("Loading Vosk STT acoustic model from %s...", model_path)
    if not os.path.exists(model_path):
        model = Model(lang="en-us")
    else:
        model = Model(model_path)

    recognizer = KaldiRecognizer(model, 16000)
    recognizer.SetWords(True)
    recognizer.SetPartialWords(True)

    logger.info("Awaiting audio feed on FIFO: %s", fifo_path)
    ipc.send_event("stt_state", {"state": "listening"})

    last_partial = ""
    chunk_size = 4000 # 250ms at 16kHz S16_LE (2 bytes per sample)

    session_start_time = time.time()
    MAX_TURN_SECONDS = 7.0
    last_partial = ""
    last_partial_time = 0.0

    def commit_prompt(final_text: str, result_meta: list = None) -> bool:
        global running
        if not final_text:
            return False

        # Immediate stop directive check on full utterance
        if re.search(r'\b(stop|cancel|quiet|shut up)\b', final_text, re.IGNORECASE):
            logger.info(">>> STOP DIRECTIVE DETECTED VIA STT: '%s' <<<", final_text)
            subprocess.run(["bash", str(PROJECT_ROOT / "scripts" / "emergency_stop.sh")])
            subprocess.Popen(["bash", str(PROJECT_ROOT / "scripts" / "voice_route.sh"), "stop"])
            running = False
            return True

        if os.path.exists("/tmp/jarvis_is_speaking"):
            logger.debug("TTS active; discarding speaker acoustic feedback: '%s'", final_text)
            return False

        ipc.send_event("stt_final", {
            "text": final_text,
            "result": result_meta or []
        })

        clean_prompt = re.sub(r'^(hey\s+)?jarvis\s*,?\s*', '', final_text, flags=re.IGNORECASE).strip()
        words = clean_prompt.split()
        is_noise = len(words) <= 1 and clean_prompt.lower() in (
            "huh", "um", "ah", "the", "a", "oh", "er", "m", "mm", "hmm", "is", "but", "one", "uni", "cool"
        )

        if clean_prompt and not is_noise:
            logger.info("Directive accepted: '%s'. Dispatching prompt and stopping microphone capture.", clean_prompt)
            ipc.send_event("command_handoff", {
                "prompt": clean_prompt,
                "source": "speech_silence_threshold"
            })
            ipc.send_event("stt_state", {"state": "idle"})
            if os.path.exists("/tmp/jarvis_agent.sock"):
                try:
                    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as agent_sock:
                        agent_sock.settimeout(1.0)
                        agent_sock.connect("/tmp/jarvis_agent.sock")
                        agent_sock.sendall((json.dumps({"action": "prompt", "prompt": clean_prompt}) + "\n").encode("utf-8"))
                        logger.info("Dispatched prompt to agent socket: '%s'", clean_prompt)
                except Exception as err:
                    logger.debug("Could not handoff to agent socket: %s", err)

            subprocess.Popen(["bash", str(PROJECT_ROOT / "scripts" / "voice_route.sh"), "stop"])
            running = False
            return True
        return False

    while running:
        if not os.path.exists(fifo_path):
            time.sleep(0.1)
            if time.time() - session_start_time > MAX_TURN_SECONDS:
                break
            continue

        try:
            with open(fifo_path, "rb") as fifo:
                logger.info("Connected to audio stream buffer.")
                while running:
                    # Overall turn timeout
                    if time.time() - session_start_time > MAX_TURN_SECONDS:
                        logger.info("Turn duration exceeded (%.1fs). Shutting down microphone capture.", MAX_TURN_SECONDS)
                        subprocess.Popen(["bash", str(PROJECT_ROOT / "scripts" / "voice_route.sh"), "stop"])
                        running = False
                        break

                    # Fast silence auto-commit: if user spoke a command and paused for 0.85s
                    if last_partial and (time.time() - last_partial_time >= 0.85):
                        logger.info("Fast silence threshold reached (0.85s). Finalizing prompt '%s'...", last_partial)
                        res = json.loads(recognizer.FinalResult())
                        final_candidate = res.get("text", "").strip() or last_partial
                        if commit_prompt(final_candidate, res.get("result", [])):
                            break
                        last_partial = ""

                    data = fifo.read(chunk_size)
                    if not data:
                        time.sleep(0.04)
                        continue

                    if recognizer.AcceptWaveform(data):
                        res = json.loads(recognizer.Result())
                        final_text = res.get("text", "").strip()
                        if final_text:
                            logger.info("[STT FINAL] %s", final_text)
                            if commit_prompt(final_text, res.get("result", [])):
                                break
                            last_partial = ""
                    else:
                        partial_res = json.loads(recognizer.PartialResult())
                        partial_text = partial_res.get("partial", "").strip()
                        if partial_text:
                            # Immediate stop check on unambiguous multi-word partial phrases
                            if re.search(r'\b(shut up|jarvis stop)\b', partial_text, re.IGNORECASE):
                                logger.info(">>> STOP DIRECTIVE DETECTED (PARTIAL): '%s' <<<", partial_text)
                                subprocess.run(["bash", str(PROJECT_ROOT / "scripts" / "emergency_stop.sh")])
                                subprocess.Popen(["bash", str(PROJECT_ROOT / "scripts" / "voice_route.sh"), "stop"])
                                running = False
                                break

                            # Discard partial tokens while TTS is playing
                            if os.path.exists("/tmp/jarvis_is_speaking"):
                                continue

                            if partial_text != last_partial:
                                last_partial = partial_text
                                last_partial_time = time.time()
                                logger.debug("[STT PARTIAL] %s", partial_text)
                                ipc.send_event("stt_partial", {
                                    "text": partial_text,
                                    "partial_result": partial_res.get("partial_result", [])
                                })

        except Exception as e:
            if running:
                logger.warning("Audio stream disconnected (%s). Reconnecting...", e)
                time.sleep(0.5)

    ipc.send_event("stt_state", {"state": "idle"})
    ipc.close()

def main():
    parser = argparse.ArgumentParser(description="J.A.R.V.I.S. Real-Time Speech-to-Text Transcription Service")
    parser.add_argument("--model-path", default=DEFAULT_MODEL_DIR, help="Path to Vosk model")
    parser.add_argument("--fifo-path", default=DEFAULT_AUDIO_FIFO, help="Path to audio FIFO stream")
    parser.add_argument("--socket-path", default=DEFAULT_SOCKET_PATH, help="Unix domain socket path for Tauri")
    parser.add_argument("--simulate", type=str, default=None, help="Simulate real-time token stream with given sentence")

    args = parser.parse_args()

    ipc = IPCClient(args.socket_path)
    ipc.connect()

    if args.simulate is not None:
        phrase = args.simulate if args.simulate.strip() else "Jarvis, run system diagnostics and display status overlay."
        stream_simulation(ipc, phrase)
        sys.exit(0)

    run_vosk_fifo_stream(args.model_path, args.fifo_path, ipc)

if __name__ == "__main__":
    main()
