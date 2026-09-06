import { useState, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

interface WakeWordPayload {
  phrase: string;
  timestamp: number;
}

export default function App() {
  const [time, setTime] = useState("");
  const [isVisible, setIsVisible] = useState(true);
  const [isListening, setIsListening] = useState(false);
  const [statusMessage, setStatusMessage] = useState("SYSTEMS NOMINAL // STANDING BY");
  const [detectedPhrase, setDetectedPhrase] = useState("");
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Digital clock update
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setTime(
        now.toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        })
      );
    };
    updateTime();
    const timer = setInterval(updateTime, 1000);
    return () => clearInterval(timer);
  }, []);

  // Listen for Tauri wake-word-detected event
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    async function setupListener() {
      try {
        unlisten = await listen<WakeWordPayload>("wake-word-detected", (event) => {
          const phrase = event.payload?.phrase || "jarvis";
          setDetectedPhrase(phrase);
          setIsVisible(true);
          setIsListening(true);
          setStatusMessage(`WAKE DETECTED: "${phrase.toUpperCase()}" // ROUTING AUDIO TO TRANSCRIPTION`);
          
          if (inputRef.current) {
            inputRef.current.focus();
          }
        });
      } catch (err) {
        console.warn("Tauri event listener failed to bind (likely running in standard browser):", err);
      }
    }

    setupListener();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Keyboard shortcut: Escape hides window
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleDismiss();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleDismiss = async () => {
    setIsVisible(false);
    setIsListening(false);
    try {
      await invoke("hide_window");
    } catch {
      // Ignored if outside Tauri runtime
    }
  };

  const handleTriggerVoice = async () => {
    setIsListening(true);
    setStatusMessage("VOICE PIPELINE ENGAGED // ROUTING MICROPHONE INPUT");
    try {
      await invoke("trigger_voice_route");
    } catch {
      // Fallback
    }
  };

  const handleSimulateWake = async () => {
    setIsVisible(true);
    setIsListening(true);
    setDetectedPhrase("jarvis");
    setStatusMessage('SIMULATED WAKE: "JARVIS" // ROUTING MICROPHONE STREAM');
    try {
      await invoke("trigger_wake_word", { phrase: "jarvis" });
    } catch {
      // Fallback
    }
  };

  const handleCommandSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inputValue.trim();
    if (!trimmed) return;

    if (trimmed === "/voice") {
      handleTriggerVoice();
    } else if (trimmed === "/hide" || trimmed === "/dismiss") {
      handleDismiss();
    } else if (trimmed === "/wake") {
      handleSimulateWake();
    } else {
      setStatusMessage(`COMMAND EXECUTED: "${trimmed}"`);
    }
    setInputValue("");
  };

  return (
    <main className="w-screen h-screen flex flex-col items-center justify-center p-6 select-none bg-transparent">
      {/* HUD Container with CSS Fade-In and Scale Transition */}
      <div
        className={`w-full max-w-xl rounded-2xl bg-neutral-950/85 backdrop-blur-2xl border border-cyan-500/30 p-6 shadow-2xl shadow-cyan-950/60 text-slate-100 flex flex-col gap-4 transform transition-all duration-500 ease-out ${
          isVisible
            ? "opacity-100 scale-100 translate-y-0"
            : "opacity-0 scale-95 -translate-y-4 pointer-events-none"
        }`}
      >
        {/* Header HUD Bar */}
        <div className="flex items-center justify-between border-b border-cyan-500/20 pb-3">
          <div className="flex items-center gap-3">
            <span className="relative flex h-3 w-3">
              <span
                className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                  isListening ? "bg-emerald-400" : "bg-cyan-400"
                }`}
              ></span>
              <span
                className={`relative inline-flex rounded-full h-3 w-3 ${
                  isListening ? "bg-emerald-500" : "bg-cyan-500"
                }`}
              ></span>
            </span>
            <span className="text-xs font-mono font-semibold tracking-widest text-cyan-400 uppercase">
              J.A.R.V.I.S. // NEURAL INTERFACE
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono text-cyan-300/70">{time}</span>
            <button
              onClick={handleDismiss}
              title="Dismiss Window (Esc)"
              className="text-xs font-mono text-cyan-500 hover:text-cyan-300 px-2 py-0.5 rounded border border-cyan-500/20 hover:border-cyan-500/50 transition-colors"
            >
              ESC ✕
            </button>
          </div>
        </div>

        {/* Audio Visualizer & Wave Activity */}
        <div className="flex items-center justify-between bg-black/40 rounded-xl px-4 py-3 border border-cyan-500/10">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-mono text-cyan-400/60 uppercase tracking-widest">
              Acoustic Telemetry
            </span>
            <span className="text-xs font-mono font-medium text-cyan-100">
              {isListening ? (
                <span className="text-emerald-400 font-semibold animate-pulse">
                  MIC STREAM ROUTED ❯ TRANSCRIPTION ACTIVE
                </span>
              ) : (
                "DAEMON STANDBY // LISTENING FOR 'JARVIS'"
              )}
            </span>
            {detectedPhrase && (
              <span className="text-[10px] font-mono text-cyan-300/80">
                Triggered via: <span className="text-cyan-400 font-bold uppercase">{detectedPhrase}</span>
              </span>
            )}
          </div>

          {/* Dynamic Audio Bars */}
          <div className="flex items-end gap-1 h-8">
            {[40, 75, 100, 60, 90, 45, 80, 55, 30].map((height, idx) => (
              <span
                key={idx}
                className={`w-1 rounded-full transition-all duration-150 ${
                  isListening
                    ? "bg-gradient-to-t from-emerald-500 to-cyan-300 animate-pulse"
                    : "bg-cyan-500/20"
                }`}
                style={{
                  height: isListening ? `${height}%` : "20%",
                  animationDelay: `${idx * 75}ms`,
                }}
              />
            ))}
          </div>
        </div>

        {/* Diagnostics & Status Indicator */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-mono text-cyan-400/60 uppercase tracking-wider">
            Directive Status
          </span>
          <p className="text-sm font-medium tracking-wide text-cyan-100 font-mono bg-neutral-900/60 rounded-lg p-2.5 border border-cyan-500/15">
            {statusMessage}
          </p>
        </div>

        {/* Quick Action Input / Command Line */}
        <form
          onSubmit={handleCommandSubmit}
          className="flex items-center gap-2 bg-neutral-900/90 border border-cyan-500/20 rounded-xl px-4 py-2.5 focus-within:border-cyan-400/60 focus-within:ring-1 focus-within:ring-cyan-400/30 transition-all"
        >
          <span className="text-cyan-400 font-mono text-sm">❯</span>
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="Type a command or '/voice'..."
            className="w-full bg-transparent text-sm text-cyan-100 placeholder-cyan-600/50 outline-none font-mono"
          />
          <button
            type="submit"
            className="text-xs font-mono font-semibold text-cyan-400 hover:text-cyan-200 uppercase tracking-wider px-2 py-1 rounded bg-cyan-950/60 border border-cyan-500/30 hover:border-cyan-400/60 transition-all"
          >
            Send
          </button>
        </form>

        {/* Test Controls & Telemetry Footer */}
        <div className="flex items-center justify-between text-[10px] font-mono text-cyan-400/50 pt-2 border-t border-cyan-500/10">
          <div className="flex items-center gap-2">
            <span>QUICK TEST:</span>
            <button
              onClick={handleSimulateWake}
              className="text-cyan-400 hover:text-cyan-200 underline cursor-pointer"
            >
              Simulate Wake
            </button>
            <span>•</span>
            <button
              onClick={handleTriggerVoice}
              className="text-cyan-400 hover:text-cyan-200 underline cursor-pointer"
            >
              Trigger /voice
            </button>
          </div>
          <span>HYPRLAND: FLOATING // PINNED</span>
        </div>
      </div>
    </main>
  );
}

