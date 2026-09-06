#!/usr/bin/env python3
"""
J.A.R.V.I.S. Desktop HUD Overlay Runner
Uses native Gtk 3.0 + WebKit2 to render the transparent, borderless, floating React UI
on Wayland / GNOME / Hyprland. Listens on /tmp/jarvis.sock for IPC commands and controls
window visibility and live telemetry rendering.
"""

import os
import sys
import json
import time
import socket
import signal
import threading
import logging
from pathlib import Path

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [J.A.R.V.I.S. OVERLAY] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger("JarvisOverlay")

import gi
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, Gdk, GLib, WebKit2

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DIST_INDEX = PROJECT_ROOT / "dist" / "index.html"
SOCKET_PATH = "/tmp/jarvis.sock"

class JarvisOverlayWindow(Gtk.Window):
    def __init__(self, start_visible: bool = True):
        super().__init__(title="Jarvis Overlay")
        self.set_role("jarvis-ui")
        self.set_wmclass("jarvis-ui", "jarvis-ui")
        
        # Transparent, borderless, floating configuration
        self.set_decorated(False)
        self.set_keep_above(True)
        self.set_skip_taskbar_hint(True)
        self.set_skip_pager_hint(True)
        self.set_app_paintable(True)
        self.set_default_size(760, 540)
        self.set_position(Gtk.WindowPosition.CENTER)

        # Apply RGBA visual for transparency
        screen = self.get_screen()
        visual = screen.get_rgba_visual()
        if visual and screen.is_composited():
            self.set_visual(visual)
            logger.info("Composited RGBA transparency engaged.")
        else:
            logger.warning("RGBA compositing not detected; window will render opaque.")

        # Configure WebKit View
        self.webview = WebKit2.WebView()
        self.webview.set_background_color(Gdk.RGBA(0, 0, 0, 0)) # Fully transparent base

        settings = self.webview.get_settings()
        settings.set_enable_javascript(True)
        settings.set_allow_file_access_from_file_urls(True)
        settings.set_allow_universal_access_from_file_urls(True)
        settings.set_enable_developer_extras(True)

        # Load built React HUD
        file_uri = f"file://{DIST_INDEX.resolve()}"
        logger.info("Loading HUD interface from %s", file_uri)
        self.webview.load_uri(file_uri)

        # Keyboard shortcuts (Escape hides window)
        self.connect("key-press-event", self.on_key_press)
        self.connect("destroy", Gtk.main_quit)

        self.add(self.webview)

        if start_visible:
            self.show_all()
            self.present()
        else:
            self.hide()

    def on_key_press(self, widget, event):
        if event.keyval == Gdk.KEY_Escape:
            logger.info("Escape pressed. Executing emergency stop and concealing HUD overlay.")
            try:
                import subprocess
                subprocess.Popen(["bash", str(PROJECT_ROOT / "scripts" / "emergency_stop.sh")])
            except Exception:
                pass
            self.hide_overlay()
            return True
        return False

    def show_overlay(self):
        logger.info("Displaying J.A.R.V.I.S. HUD overlay.")
        self.show_all()
        self.present()
        self.dispatch_js_event({"event": "window_shown", "timestamp": int(time.time() * 1000)})

    def hide_overlay(self):
        logger.info("Concealing J.A.R.V.I.S. HUD overlay.")
        self.hide()

    def dispatch_js_event(self, payload: dict):
        raw_json = json.dumps(payload)
        script = f"""
        if (window.__JARVIS_DISPATCH__) {{
            window.__JARVIS_DISPATCH__({raw_json});
        }} else {{
            window.dispatchEvent(new CustomEvent('jarvis-event', {{ detail: {raw_json} }}));
        }}
        """
        try:
            self.webview.evaluate_javascript(script, -1, None, None, None, None, None)
        except Exception as e:
            logger.debug("Failed evaluating JS: %s", e)

def run_socket_listener(window: JarvisOverlayWindow, socket_path: str):
    """Background listener on /tmp/jarvis.sock to handle IPC triggers."""
    if os.path.exists(socket_path):
        try:
            os.remove(socket_path)
        except Exception:
            pass

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(socket_path)
    server.listen(10)
    logger.info("IPC Socket listener active at %s", socket_path)

    while True:
        try:
            conn, _ = server.accept()
            with conn:
                data = conn.recv(8192)
                if not data:
                    continue
                lines = data.decode("utf-8", errors="ignore").strip().split("\n")
                for line in lines:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        payload = json.loads(line)
                        event = payload.get("event")
                        logger.info("Received IPC event on %s: %s", socket_path, event)

                        if event in ("wake_word", "show_window"):
                            GLib.idle_add(window.show_overlay)
                        elif event == "hide_window":
                            GLib.idle_add(window.hide_overlay)

                        # Always forward to webview
                        GLib.idle_add(window.dispatch_js_event, payload)
                    except json.JSONDecodeError:
                        pass
        except Exception as e:
            logger.debug("Socket listener exception: %s", e)
            time.sleep(0.5)

def main():
    start_visible = "--hidden" not in sys.argv
    app = JarvisOverlayWindow(start_visible=start_visible)

    # Start socket listener thread
    sock_thread = threading.Thread(
        target=run_socket_listener,
        args=(app, SOCKET_PATH),
        daemon=True
    )
    sock_thread.start()

    logger.info("J.A.R.V.I.S. Desktop HUD Overlay initialized successfully, Sir.")
    try:
        Gtk.main()
    except KeyboardInterrupt:
        logger.info("Overlay terminated by user.")

if __name__ == "__main__":
    main()
