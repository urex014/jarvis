import { useState, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

interface WakeWordPayload {
  phrase: string;
  timestamp: number;
}

interface SttPayload {
  text: string;
  timestamp?: number;
  last_token?: string;
  token_count?: number;
}

export default function App() {
  const [time, setTime] = useState("");
  const [isVisible, setIsVisible] = useState(true);
  const [isListening, setIsListening] = useState(false);
  const [isWebAudioActive, setIsWebAudioActive] = useState(false);
  const [statusMessage, setStatusMessage] = useState("SYSTEMS NOMINAL // STANDING BY");
  const [detectedPhrase, setDetectedPhrase] = useState("");
  const [inputValue, setInputValue] = useState("");
  
  // Real-time STT transcript states
  const [transcribedFinal, setTranscribedFinal] = useState("");
  const [transcribedPartial, setTranscribedPartial] = useState("");
  
  const inputRef = useRef<HTMLInputElement>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

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

  // Listen for Tauri backend events: wake word, partial STT, final STT, and states
  useEffect(() => {
    const unlistenFns: (() => void)[] = [];

    async function setupListeners() {
      try {
        // 1. Wake word detection
        const unlistenWake = await listen<WakeWordPayload>("wake-word-detected", (event) => {
          const phrase = event.payload?.phrase || "jarvis";
          setDetectedPhrase(phrase);
          setIsVisible(true);
          setIsListening(true);
          setStatusMessage(`WAKE DETECTED: "${phrase.toUpperCase()}" // STT STREAM ROUTED`);
          setTranscribedPartial("");
          
          if (inputRef.current) {
            inputRef.current.focus();
          }
        });
        unlistenFns.push(unlistenWake);

        // 2. STT streaming partial tokens
        const unlistenPartial = await listen<SttPayload>("stt-partial", (event) => {
          const text = event.payload?.text || "";
          setTranscribedPartial(text);
          setIsListening(true);
          setStatusMessage("TRANSCRIBING // STREAMING AUDIO TOKENS");
        });
        unlistenFns.push(unlistenPartial);

        // 3. STT final recognized phrase
        const unlistenFinal = await listen<SttPayload>("stt-final", (event) => {
          const text = event.payload?.text || "";
          if (text) {
            setTranscribedFinal((prev) => (prev ? `${prev} ${text}` : text));
          }
          setTranscribedPartial("");
          setStatusMessage("TRANSCRIPTION COMMITTED // AWAITING DIRECTIVE");
        });
        unlistenFns.push(unlistenFinal);

        // 4. STT engine state
        const unlistenState = await listen<{ state: string }>("stt-state", (event) => {
          const state = event.payload?.state || "idle";
          if (state === "listening") {
            setIsListening(true);
          } else if (state === "idle") {
            setIsListening(false);
          }
        });
        unlistenFns.push(unlistenState);

      } catch (err) {
        console.warn("Tauri event listener failed to bind:", err);
      }
    }

    setupListeners();

    return () => {
      unlistenFns.forEach((fn) => fn());
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

  // Web Audio / WebRTC stream capture toggle
  const toggleWebAudioStream = async () => {
    if (isWebAudioActive) {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      setIsWebAudioActive(false);
      setIsListening(false);
      setStatusMessage("MICROPHONE STREAM DISENGAGED");
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaStreamRef.current = stream;
        const ctx = new AudioContext();
        audioContextRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);

        // Simple audio visualizer analyser
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 64;
        source.connect(analyser);

        setIsWebAudioActive(true);
        setIsListening(true);
        setStatusMessage("WEBRTC AUDIO CAPTURE LIVE // STREAMING MICROPHONE");

        // Also trigger backend voice route
        try {
          await invoke("trigger_voice_route");
        } catch {
          // Fallback
        }
      } catch (err) {
        console.error("Audio capture permission denied or unavailable:", err);
        setStatusMessage("AUDIO CAPTURE ERROR: PERMISSION DENIED");
      }
    }
  };

  const handleDismiss = async () => {
    setIsVisible(false);
    setIsListening(false);
    try {
      await invoke("hide_window");
    } catch {
      // Ignored outside Tauri
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

  const handleStopVoice = async () => {
    setIsListening(false);
    setStatusMessage("VOICE PIPELINE TERMINATED");
    try {
      await invoke("stop_voice_route");
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

  // Simulate token-by-token streaming STT text directly into frontend
  const handleSimulateTokenStream = async () => {
    setIsVisible(true);
    setIsListening(true);
    setStatusMessage("STREAMING TEST: DISPATCHING SIMULATED TOKENS");

    const sampleTokens = [
      "Jarvis,",
      "report",
      "diagnostic",
      "status",
      "and",
      "prepare",
      "overlay",
      "telemetry."
    ];

    let currentString = "";
    for (let i = 0; i < sampleTokens.length; i++) {
      currentString += (i === 0 ? "" : " ") + sampleTokens[i];
      setTranscribedPartial(currentString);
      try {
        await invoke("push_stt_token", {
          text: currentString,
          isFinal: false,
        });
      } catch {
        // Fallback
      }
      await new Promise((r) => setTimeout(r, 120));
    }

    setTranscribedFinal((prev) => (prev ? `${prev} ${currentString}` : currentString));
    setTranscribedPartial("");
    setStatusMessage("SIMULATED TRANSCRIPTION COMMITTED");
    try {
      await invoke("push_stt_token", {
        text: currentString,
        isFinal: true,
      });
    } catch {
      // Fallback
    }
  };

  const handleClearTranscript = () => {
    setTranscribedFinal("");
    setTranscribedPartial("");
    setStatusMessage("TRANSCRIPTION BUFFER CLEARED");
  };

  const handleCommandSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inputValue.trim();
    if (!trimmed) return;

    if (trimmed === "/voice") {
      handleTriggerVoice();
    } else if (trimmed === "/stop") {
      handleStopVoice();
    } else if (trimmed === "/hide" || trimmed === "/dismiss") {
      handleDismiss();
    } else if (trimmed === "/wake") {
      handleSimulateWake();
    } else if (trimmed === "/clear") {
      handleClearTranscript();
    } else if (trimmed === "/test") {
      handleSimulateTokenStream();
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
                  isListening || isWebAudioActive ? "bg-emerald-400" : "bg-cyan-400"
                }`}
              ></span>
              <span
                className={`relative inline-flex rounded-full h-3 w-3 ${
                  isListening || isWebAudioActive ? "bg-emerald-500" : "bg-cyan-500"
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
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-cyan-400/60 uppercase tracking-widest">
                Acoustic Telemetry
              </span>
              {isWebAudioActive && (
                <span className="text-[9px] font-mono bg-emerald-950/80 text-emerald-400 border border-emerald-500/30 px-1.5 py-0.2 rounded">
                  WEBRTC LIVE
                </span>
              )}
            </div>
            <span className="text-xs font-mono font-medium text-cyan-100">
              {isListening || isWebAudioActive ? (
                <span className="text-emerald-400 font-semibold animate-pulse">
                  MICROPHONE ROUTED ❯ STT STREAM ACTIVE
                </span>
              ) : (
                "DAEMON STANDBY // AWAITING WAKE DIRECTIVE"
              )}
            </span>
            {detectedPhrase && (
              <span className="text-[10px] font-mono text-cyan-300/80">
                Triggered via: <span className="text-cyan-400 font-bold uppercase">{detectedPhrase}</span>
              </span>
            )}
          </div>

          {/* Dynamic Audio Wave Bars */}
          <div className="flex items-end gap-1 h-8">
            {[40, 75, 100, 60, 90, 45, 80, 55, 30].map((height, idx) => (
              <span
                key={idx}
                className={`w-1 rounded-full transition-all duration-150 ${
                  isListening || isWebAudioActive
                    ? "bg-gradient-to-t from-emerald-500 to-cyan-300 animate-pulse"
                    : "bg-cyan-500/20"
                }`}
                style={{
                  height: isListening || isWebAudioActive ? `${height}%` : "20%",
                  animationDelay: `${idx * 75}ms`,
                }}
              />
            ))}
          </div>
        </div>

        {/* Glowing Minimalist Real-Time Transcription Text Block */}
        <div className="relative rounded-xl bg-white/[0.02] border border-white/10 p-4 shadow-inner backdrop-blur-md overflow-hidden min-h-[95px] flex flex-col justify-between transition-all duration-300">
          <div className="flex items-center justify-between border-b border-white/5 pb-2 mb-2">
            <div className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-cyan-400 shadow-[0_0_6px_#22d3ee] animate-pulse"></span>
              <span className="text-[10px] font-mono tracking-widest text-slate-300 uppercase">
                Real-Time Speech-to-Text
              </span>
            </div>
            <div className="flex items-center gap-2 text-[10px] font-mono text-cyan-400/80">
              <span>ENGINE: VOSK OFFLINE</span>
              {(transcribedFinal || transcribedPartial) && (
                <button
                  onClick={handleClearTranscript}
                  className="text-slate-400 hover:text-white transition-colors underline cursor-pointer ml-1"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Glowing Transcribed Tokens Stream */}
          <div className="font-mono text-sm leading-relaxed select-text min-h-[44px] break-words">
            {transcribedFinal && (
              <span className="text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.4)] font-light">
                {transcribedFinal}{" "}
              </span>
            )}
            {transcribedPartial ? (
              <span className="text-cyan-200 drop-shadow-[0_0_12px_rgba(103,232,249,0.8)] font-medium">
                {transcribedPartial}
                <span className="inline-block w-2 h-4 ml-1 bg-cyan-400 shadow-[0_0_8px_#22d3ee] animate-pulse align-middle"></span>
              </span>
            ) : !transcribedFinal ? (
              <span className="text-slate-500 italic font-light text-xs">
                Awaiting acoustic transcription... Say &quot;Jarvis&quot; or activate live microphone stream.
              </span>
            ) : (
              <span className="inline-block w-2 h-4 ml-1 bg-white/40 animate-pulse align-middle"></span>
            )}
          </div>
        </div>

        {/* Diagnostics & Status Indicator */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-mono text-cyan-400/60 uppercase tracking-wider">
            Directive Status
          </span>
          <p className="text-xs font-medium tracking-wide text-cyan-100 font-mono bg-neutral-900/60 rounded-lg p-2.5 border border-cyan-500/15">
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
            placeholder="Type a command (/voice, /stop, /test, /clear)..."
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
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={toggleWebAudioStream}
              className={`px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                isWebAudioActive
                  ? "bg-red-950/60 text-red-300 border-red-500/40"
                  : "bg-cyan-950/40 text-cyan-300 border-cyan-500/30 hover:border-cyan-400"
              }`}
            >
              {isWebAudioActive ? "Stop Mic" : "Start Live Mic"}
            </button>
            <span>•</span>
            <button
              onClick={handleSimulateTokenStream}
              className="text-cyan-400 hover:text-cyan-200 underline cursor-pointer"
            >
              Simulate STT
            </button>
            <span>•</span>
            <button
              onClick={handleSimulateWake}
              className="text-cyan-400 hover:text-cyan-200 underline cursor-pointer"
            >
              Wake
            </button>
            <span>•</span>
            <button
              onClick={handleTriggerVoice}
              className="text-cyan-400 hover:text-cyan-200 underline cursor-pointer"
            >
              /voice
            </button>
          </div>
          <span className="hidden sm:inline">HYPRLAND: FLOATING</span>
        </div>
      </div>
    </main>
  );
}


