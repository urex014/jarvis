#!/usr/bin/env python3
"""
J.A.R.V.I.S. agy Agent Bridge & State Management Daemon
Provides real-time bidirectional WebSocket and IPC channels between the
agy CLI agent and the Tauri overlay UI, tracking agent process states and
streaming live telemetry.
"""

import os
import sys
import json
import time
import socket
import signal
import asyncio
import logging
import argparse
import subprocess
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [J.A.R.V.I.S. AGY-BRIDGE] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger("AgyBridge")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOCKET_PATH = "/tmp/jarvis.sock"
AGENT_SOCKET_PATH = "/tmp/jarvis_agent.sock"
WS_HOST = "127.0.0.1"
WS_PORT = 9002

running = True
connected_websockets = set()

def signal_handler(signum, frame):
    global running
    logger.info("Signal received. Terminating agy bridge...")
    running = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

def send_unix_ipc(socket_path: str, event_type: str, data: dict) -> bool:
    """Dispatches event to Tauri Unix domain socket."""
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
        logger.debug("IPC send error to %s: %s", socket_path, e)
        return False

async def broadcast_event(socket_path: str, event_type: str, data: dict):
    """Sends event to both Tauri Unix socket and all connected WebSockets."""
    # 1. Unix Domain Socket
    send_unix_ipc(socket_path, event_type, data)

    # 2. WebSockets
    if connected_websockets:
        payload = json.dumps({
            "event": event_type,
            "timestamp": int(time.time() * 1000),
            **data
        })
        disconnected = set()
        for ws in connected_websockets:
            try:
                await ws.send(payload)
            except Exception:
                disconnected.add(ws)
        connected_websockets.difference_update(disconnected)

def map_tool_to_status(tool_name: str) -> str:
    """Translates agy tool calls into human-readable process status indicators."""
    tool = tool_name.lower()
    if any(k in tool for k in ["find", "list_dir", "dir", "glob"]):
        return "[Searching file system...]"
    elif any(k in tool for k in ["grep", "search"]):
        return "[Scanning codebase & databanks...]"
    elif any(k in tool for k in ["view_file", "read", "cat"]):
        return "[Analyzing logs & source files...]"
    elif any(k in tool for k in ["run_command", "bash", "exec"]):
        return "[Executing system command...]"
    elif any(k in tool for k in ["web", "fetch", "url", "curl"]):
        return "[Querying external network...]"
    elif any(k in tool for k in ["write", "replace", "edit"]):
        return "[Modifying project files...]"
    else:
        return f"[Running {tool_name}...]"

current_agy_process = None
current_tts_process = None

async def stop_all_execution(socket_path: str):
    """Emergency stop: halts active agy process, audio players, and resets states."""
    global current_agy_process, current_tts_process
    logger.info(">>> EMERGENCY STOP ACTIVATED BY DIRECTIVE <<<")
    if current_agy_process:
        try:
            current_agy_process.kill()
        except Exception:
            pass
        current_agy_process = None

    if current_tts_process:
        try:
            current_tts_process.kill()
        except Exception:
            pass
        current_tts_process = None

    for p in ["paplay", "pw-play", "aplay"]:
        subprocess.run(["pkill", "-9", p], capture_output=True)

    if os.path.exists("/tmp/jarvis_is_speaking"):
        try:
            os.remove("/tmp/jarvis_is_speaking")
        except Exception:
            pass

    await broadcast_event(socket_path, "agent_status", {
        "status": "[Operation halted by user]",
        "is_busy": False
    })
    await broadcast_event(socket_path, "tts_state", {
        "state": "finished",
        "status": "[Halted]"
    })

async def execute_agy_prompt(prompt: str, socket_path: str):
    """Executes agy CLI with the prompt and streams process updates."""
    global current_agy_process

    # Kill any existing agent execution to prevent concurrent responses
    if current_agy_process:
        try:
            current_agy_process.kill()
        except Exception:
            pass
        current_agy_process = None

    logger.info("Executing agy prompt: '%s'", prompt)

    await broadcast_event(socket_path, "agent_status", {
        "status": "[Analyzing prompt & planning strategy...]",
        "prompt": prompt,
        "is_busy": True
    })

    # Strict voice directive: short, crisp, under 25 words
    brief_prompt = (
        f"{prompt}\n\n"
        f"[VOICE DIRECTIVE: Provide an impeccably concise response in 1-2 brief sentences, "
        f"strictly under 25 words total, suitable for British voice synthesis. Address user as Sir.]"
    )

    cmd = [
        "agy",
        "--output-format", "stream-json",
        "--dangerously-skip-permissions",
        f"--print={brief_prompt}"
    ]

    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd="/home/cryptic/projects/jarvis"
        )
        current_agy_process = process

        response_chunks = []

        while True:
            line = await process.stdout.readline()
            if not line:
                break
            
            raw_line = line.decode("utf-8").strip()
            if not raw_line:
                continue

            try:
                data = json.loads(raw_line)
            except json.JSONDecodeError:
                continue

            ev = data.get("event")
            
            if ev == "step_update":
                step = data.get("step_update", {})
                step_type = step.get("step_type", "")

                if "tool" in step_type:
                    tool_name = step.get("tool_name") or step.get("tool", "tool")
                    status_text = map_tool_to_status(tool_name)
                    logger.info("Tool execution: %s", status_text)
                    await broadcast_event(socket_path, "agent_status", {
                        "status": status_text,
                        "is_busy": True
                    })
                elif step_type == "agent_response":
                    delta = step.get("text_delta", "")
                    if delta:
                        response_chunks.append(delta)
                        await broadcast_event(socket_path, "agent_status", {
                            "status": "[Generating response...]",
                            "is_busy": True
                        })
                        await broadcast_event(socket_path, "agent_delta", {
                            "delta": delta,
                            "accumulated": "".join(response_chunks)
                        })
                elif "think" in step_type:
                    await broadcast_event(socket_path, "agent_status", {
                        "status": "[Synthesizing analytical reasoning...]",
                        "is_busy": True
                    })

            elif ev == "result":
                res = data.get("result", {})
                final_response = res.get("response", "").strip() or "".join(response_chunks).strip()
                logger.info("Agent response complete (%d characters)", len(final_response))
                await broadcast_event(socket_path, "agent_response", {
                    "response": final_response,
                    "status": "SUCCESS",
                    "done": True
                })
                if final_response:
                    asyncio.create_task(invoke_tts_synthesis(final_response, socket_path))

        await process.wait()

    except Exception as e:
        logger.error("Error running agy CLI: %s", e)
        await broadcast_event(socket_path, "agent_status", {
            "status": f"[Error: {str(e)[:40]}]",
            "is_busy": False
        })

async def invoke_tts_synthesis(text: str, socket_path: str, simulate: bool = False):
    """Spawns the TTS engine to synthesize and play the response audio."""
    global current_tts_process

    # Kill any existing TTS playback to prevent overlapping voices
    if current_tts_process:
        try:
            current_tts_process.kill()
        except Exception:
            pass
        current_tts_process = None

    for p in ["paplay", "pw-play", "aplay"]:
        subprocess.run(["pkill", "-9", p], capture_output=True)

    tts_script = str(PROJECT_ROOT / "daemon" / "tts_service.py")
    python_bin = str(PROJECT_ROOT / ".venv" / "bin" / "python")
    cmd = [python_bin, tts_script, text, "--socket-path", socket_path]
    if simulate:
        cmd.append("--simulate")
    try:
        proc = await asyncio.create_subprocess_exec(*cmd)
        current_tts_process = proc
        await proc.wait()
    except Exception as e:
        logger.error("Error executing TTS service: %s", e)
    finally:
        current_tts_process = None

async def simulate_agent_flow(prompt: str, socket_path: str):
    """Simulates realistic agy process telemetry updates for testing."""
    logger.info("Running simulated agy workflow for prompt: '%s'", prompt)

    steps = [
        ("[Analyzing prompt & planning strategy...]", 0.6),
        ("[Searching file system...]", 0.8),
        ("[Analyzing logs & source files...]", 0.7),
        ("[Generating response...]", 0.9),
    ]

    for status_text, delay in steps:
        logger.info("Simulated step: %s", status_text)
        await broadcast_event(socket_path, "agent_status", {
            "status": status_text,
            "is_busy": True,
            "prompt": prompt
        })
        await asyncio.sleep(delay)

    response_text = f"Diagnostics confirm all operations nominal. Completed directive: '{prompt}', Sir."
    
    await broadcast_event(socket_path, "agent_response", {
        "response": response_text,
        "done": True
    })

    # Trigger TTS simulation
    asyncio.create_task(invoke_tts_synthesis(response_text, socket_path, simulate=True))
    logger.info("Simulated agy workflow completed successfully.")

async def start_unix_listener(agent_sock_path: str, tauri_sock_path: str):
    """Listens on /tmp/jarvis_agent.sock for prompts from Tauri or transcription daemon."""
    if os.path.exists(agent_sock_path):
        try:
            os.remove(agent_sock_path)
        except Exception:
            pass

    async def client_handler(reader, writer):
        try:
            data = await reader.readline()
            if data:
                line = data.decode("utf-8").strip()
                if line:
                    payload = json.loads(line)
                    action = payload.get("action")
                    event = payload.get("event")
                    if action in ("stop", "cancel") or event in ("stop", "cancel"):
                        asyncio.create_task(stop_all_execution(tauri_sock_path))
                    else:
                        prompt = payload.get("prompt") or payload.get("text", "")
                        if prompt:
                            asyncio.create_task(execute_agy_prompt(prompt, tauri_sock_path))
        except Exception as e:
            logger.debug("Agent socket handler error: %s", e)
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_unix_server(client_handler, path=agent_sock_path)
    logger.info("Agent command handoff listener active at %s", agent_sock_path)
    return server

async def start_websocket_server(host: str, port: int, tauri_sock_path: str):
    """Starts local WebSocket server for live telemetry and frontend communication."""
    import websockets

    async def ws_handler(websocket):
        connected_websockets.add(websocket)
        logger.info("Frontend WebSocket client connected (%s)", websocket.remote_address)
        try:
            await websocket.send(json.dumps({
                "event": "connected",
                "message": "Connected to J.A.R.V.I.S. agy agent bridge",
                "timestamp": int(time.time() * 1000)
            }))
            async for message in websocket:
                try:
                    data = json.loads(message)
                    action = data.get("action") or data.get("event")
                    if action in ("stop", "cancel"):
                        asyncio.create_task(stop_all_execution(tauri_sock_path))
                    elif action == "prompt":
                        prompt = data.get("text") or data.get("prompt", "")
                        if prompt:
                            asyncio.create_task(execute_agy_prompt(prompt, tauri_sock_path))
                    elif action == "simulate":
                        prompt = data.get("prompt", "Analyze repository state")
                        asyncio.create_task(simulate_agent_flow(prompt, tauri_sock_path))
                except json.JSONDecodeError:
                    pass
        except Exception as e:
            logger.debug("WebSocket client error: %s", e)
        finally:
            connected_websockets.discard(websocket)
            logger.info("Frontend WebSocket client disconnected")

    ws_server = await websockets.serve(ws_handler, host, port)
    logger.info("WebSocket telemetry server active on ws://%s:%d", host, port)
    return ws_server

async def main_async(args):
    # If one-off simulation requested:
    if args.simulate is not None:
        prompt = args.simulate if args.simulate.strip() else "Inspect recent codebase changes"
        await simulate_agent_flow(prompt, args.socket_path)
        return

    # If one-off prompt requested:
    if args.prompt is not None:
        await execute_agy_prompt(args.prompt, args.socket_path)
        return

    # Daemon mode: Start both Unix socket listener and WebSocket server
    unix_server = await start_unix_listener(args.agent_socket, args.socket_path)
    ws_server = await start_websocket_server(args.ws_host, args.ws_port, args.socket_path)

    logger.info("J.A.R.V.I.S. agy Bridge Daemon operational. Standing by for handoffs, Sir.")

    try:
        while running:
            await asyncio.sleep(1)
    finally:
        unix_server.close()
        ws_server.close()
        if os.path.exists(args.agent_socket):
            try:
                os.remove(args.agent_socket)
            except Exception:
                pass

def main():
    parser = argparse.ArgumentParser(description="J.A.R.V.I.S. agy Agent Bridge & State Management")
    parser.add_argument("--socket-path", default=DEFAULT_SOCKET_PATH, help="Tauri Unix domain socket path")
    parser.add_argument("--agent-socket", default=AGENT_SOCKET_PATH, help="Agent Unix domain socket path")
    parser.add_argument("--ws-host", default=WS_HOST, help="WebSocket server host")
    parser.add_argument("--ws-port", type=int, default=WS_PORT, help="WebSocket server port")
    parser.add_argument("--prompt", type=str, default=None, help="Execute single agy prompt")
    parser.add_argument("--simulate", type=str, default=None, help="Simulate agy execution flow")

    args = parser.parse_args()
    asyncio.run(main_async(args))

if __name__ == "__main__":
    main()
