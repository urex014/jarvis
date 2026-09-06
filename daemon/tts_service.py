#!/usr/bin/env python3
"""
J.A.R.V.I.S. Voice Synthesis (TTS) & Playback Service
Synthesizes speech using local Piper (British model) or ElevenLabs API,
emits real-time state telemetry to Tauri, and plays audio through system speakers.
"""

import os
import sys
import json
import time
import socket
import logging
import argparse
import subprocess
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [J.A.R.V.I.S. TTS] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger("JarvisTTS")

DEFAULT_SOCKET_PATH = "/tmp/jarvis.sock"
DEFAULT_PIPER_MODEL = os.path.expanduser("~/.cache/piper/en_GB-alan-medium.onnx")
OUTPUT_WAV = "/tmp/jarvis_tts_output.wav"
PROJECT_DIR = Path(__file__).resolve().parent.parent
PIPER_BIN = PROJECT_DIR / ".venv" / "bin" / "piper"

def send_ipc_event(socket_path: str, event_type: str, data: dict) -> bool:
    """Sends event to Tauri Unix domain socket."""
    if not os.path.exists(socket_path):
        return False
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(1.0)
            client.connect(socket_path)
            payload = {
                "event": event_type,
                "timestamp": int(time.time() * 1000),
                **data
            }
            msg = json.dumps(payload) + "\n"
            client.sendall(msg.encode("utf-8"))
            return True
    except Exception as e:
        logger.debug("IPC send error: %s", e)
        return False

def clean_text_for_speech(raw_text: str, max_sentences: int = 2, max_words: int = 30) -> str:
    """Strips markdown and limits output to at most 1-2 concise sentences for speech."""
    import re
    # Remove code blocks
    text = re.sub(r"```[\s\S]*?```", "", raw_text)
    # Remove inline code
    text = re.sub(r"`([^`]+)`", r"\1", text)
    # Remove markdown links, keep label
    text = re.sub(r"\[([^\]]+)\]\([^\)]+\)", r"\1", text)
    # Remove special characters / markdown headers
    text = re.sub(r"[#*_~>|]", " ", text)
    # Collapse multiple whitespaces
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return ""

    # Split into sentences using punctuation boundaries (. ! ?)
    sentence_matches = re.split(r'(?<=[.!?])\s+', text)
    selected_sentences = []
    word_count = 0

    for s in sentence_matches:
        s = s.strip()
        if not s:
            continue
        words = s.split()
        if not selected_sentences or (len(selected_sentences) < max_sentences and word_count + len(words) <= max_words):
            selected_sentences.append(s)
            word_count += len(words)
        else:
            break

    result = " ".join(selected_sentences).strip()
    if result and result[-1] not in ".!?":
        result += "."
    return result

def synthesize_with_elevenlabs(text: str, output_path: str, api_key: str) -> bool:
    """Synthesizes speech using ElevenLabs API with British voice."""
    import urllib.request
    logger.info("Attempting ElevenLabs synthesis with British voice...")
    voice_id = os.environ.get("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb") # George / British
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
    
    headers = {
        "Accept": "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": api_key
    }
    payload = {
        "text": text,
        "model_id": "eleven_monolingual_v1",
        "voice_settings": {
            "stability": 0.55,
            "similarity_boost": 0.8
        }
    }

    try:
        req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=10) as response:
            with open(output_path, "wb") as f:
                f.write(response.read())
        logger.info("ElevenLabs audio saved to %s", output_path)
        return True
    except Exception as e:
        logger.warning("ElevenLabs request failed (%s). Falling back to local Piper...", e)
        return False

def synthesize_with_piper(text: str, output_path: str, model_path: str) -> bool:
    """Synthesizes speech locally using Piper TTS."""
    logger.info("Engaging Piper neural TTS with model %s...", model_path)
    if not os.path.exists(model_path):
        logger.error("Piper model not found at %s", model_path)
        return False

    cmd = [
        str(PIPER_BIN) if PIPER_BIN.exists() else "piper",
        "-m", model_path,
        "-f", output_path
    ]

    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        stdout, stderr = proc.communicate(input=text, timeout=15)
        if proc.returncode == 0 and os.path.exists(output_path):
            logger.info("Piper audio generated at %s", output_path)
            return True
        else:
            logger.error("Piper synthesis failed: %s", stderr)
            return False
    except Exception as e:
        logger.error("Piper invocation exception: %s", e)
        return False

def play_audio(audio_path: str):
    """Plays audio through system speakers via paplay, pw-play, or aplay."""
    players = ["paplay", "pw-play", "aplay"]
    for player in players:
        if subprocess.run(["which", player], capture_output=True).returncode == 0:
            logger.info("Playing audio via %s...", player)
            try:
                subprocess.run([player, audio_path], check=True, capture_output=True)
                return True
            except Exception as e:
                logger.warning("%s playback failed: %s", player, e)
    return False

def speak_text(text: str, socket_path: str = DEFAULT_SOCKET_PATH, model_path: str = DEFAULT_PIPER_MODEL):
    """Coordinates the full TTS synthesis, status dispatch, and playback cycle."""
    clean_text = clean_text_for_speech(text)
    if not clean_text:
        logger.info("No pronounceable text to speak.")
        return

    logger.info("Synthesizing speech for: '%s'", clean_text[:80])

    # 1. Update UI state: [Synthesizing speech...]
    send_ipc_event(socket_path, "tts_state", {
        "state": "synthesizing",
        "status": "[Synthesizing speech response...]",
        "text": clean_text
    })

    # 2. Synthesis (ElevenLabs or Piper fallback)
    api_key = os.environ.get("ELEVENLABS_API_KEY")
    success = False

    if api_key:
        success = synthesize_with_elevenlabs(clean_text, OUTPUT_WAV, api_key)

    if not success:
        success = synthesize_with_piper(clean_text, OUTPUT_WAV, model_path)

    if not success:
        # Fallback to speech-dispatcher if piper unavailable
        logger.info("Falling back to speech-dispatcher (spd-say)...")
        send_ipc_event(socket_path, "tts_state", {
            "state": "speaking",
            "status": "[Speaking...]",
            "text": clean_text
        })
        try:
            subprocess.run(["spd-say", "-r", "-10", clean_text])
        except Exception:
            pass
        send_ipc_event(socket_path, "tts_state", {
            "state": "finished",
            "status": "[Systems nominal // Awaiting directive]",
            "text": clean_text
        })
        return

    # 3. Notify UI of active playback: [Speaking...]
    send_ipc_event(socket_path, "tts_state", {
        "state": "speaking",
        "status": "[Speaking...]",
        "text": clean_text
    })

    speaking_flag = "/tmp/jarvis_is_speaking"
    try:
        with open(speaking_flag, "w") as f:
            f.write(str(os.getpid()))
    except Exception:
        pass

    try:
        # 4. Play audio through speakers
        play_audio(OUTPUT_WAV)
    finally:
        # Echo dampening cooldown: allows speaker reverberation to decay
        time.sleep(0.4)
        if os.path.exists(speaking_flag):
            try:
                os.remove(speaking_flag)
            except Exception:
                pass

    # 5. Notify UI that audio playback has finished -> triggers auto-hide logic
    logger.info("Audio playback complete. Emitting finished event to initiate auto-hide timer.")
    send_ipc_event(socket_path, "tts_state", {
        "state": "finished",
        "status": "[Systems nominal // Awaiting directive]",
        "text": clean_text
    })

def simulate_tts(socket_path: str, text: str):
    """Simulates TTS lifecycle for testing without blocking speakers."""
    logger.info("Running TTS simulation...")
    send_ipc_event(socket_path, "tts_state", {
        "state": "speaking",
        "status": "[Speaking...]",
        "text": text
    })
    time.sleep(2.0)
    logger.info("Simulation playback complete.")
    send_ipc_event(socket_path, "tts_state", {
        "state": "finished",
        "status": "[Systems nominal // Awaiting directive]",
        "text": text
    })

def main():
    parser = argparse.ArgumentParser(description="J.A.R.V.I.S. Text-to-Speech Engine & Playback")
    parser.add_argument("text", nargs="?", default="All systems nominal, Sir. Awaiting your directive.", help="Text to speak")
    parser.add_argument("--socket-path", default=DEFAULT_SOCKET_PATH, help="Tauri Unix domain socket path")
    parser.add_argument("--model-path", default=DEFAULT_PIPER_MODEL, help="Path to Piper ONNX model")
    parser.add_argument("--simulate", action="store_true", help="Simulate speaking state without audio playback")

    args = parser.parse_args()

    if args.simulate:
        simulate_tts(args.socket_path, args.text)
    else:
        speak_text(args.text, args.socket_path, args.model_path)

if __name__ == "__main__":
    main()
