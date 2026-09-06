import { useState, useEffect, useRef, useCallback } from "react";
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

interface AgentStatusPayload {
  status: string;
  is_busy?: boolean;
  prompt?: string;
}

interface AgentResponsePayload {
  response?: string;
  text?: string;
  done?: boolean;
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
  
  // Phase 4: agy Agent State Management
  const [agentProcessStatus, setAgentProcessStatus] = useState("[Systems nominal // Awaiting directive]");
  const [isAgentBusy, setIsAgentBusy] = useState(false);
  const [agentResponse, setAgentResponse] = useState("");
  const [autoHandoffEnabled, setAutoHandoffEnabled] = useState(true);
  const [isWsConnected, setIsWsConnected] = useState(false);

  // Phase 5: Voice Synthesis & Auto-Hide
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [autoHideCountdown, setAutoHideCountdown] = useState<number | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cancel any pending auto-hide timer
  const cancelAutoHideTimer = useCallback(() => {
    if (autoHideTimerRef.current) {
      clearTimeout(autoHideTimerRef.current);
      autoHideTimerRef.current = null;
    }
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    setAutoHideCountdown(null);
  }, []);

  // Initiate auto-hide countdown: applies CSS opacity fade then Tauri hide_window
  const startAutoHideTimer = useCallback((durationMs = 4000) => {
    cancelAutoHideTimer();
    let remaining = Math.round(durationMs / 1000);
    setAutoHideCountdown(remaining);

    countdownIntervalRef.current = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        setAutoHideCountdown(remaining);
      } else {
        setAutoHideCountdown(null);
        if (countdownIntervalRef.current) {
          clearInterval(countdownIntervalRef.current);
          countdownIntervalRef.current = null;
        }
      }
    }, 1000);

    autoHideTimerRef.current = setTimeout(async () => {
      cancelAutoHideTimer();
      // Apply CSS opacity transition to fade out the container
      setIsVisible(false);
      // Once fade transition concludes, trigger Tauri command to set window visibility to false
      setTimeout(async () => {
        try {
          await invoke("hide_window");
        } catch {
          // Fallback outside Tauri
        }
      }, 500);
    }, durationMs);
  }, [cancelAutoHideTimer]);

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

  // Connect to local agy WebSocket bridge (ws://127.0.0.1:9002) with auto-reconnect
  useEffect(() => {
    let reconnectTimeout: ReturnType<typeof setTimeout>;
    let isMounted = true;

    function connectWs() {
      try {
        const ws = new WebSocket("ws://127.0.0.1:9002");
        wsRef.current = ws;

        ws.onopen = () => {
          if (isMounted) {
            setIsWsConnected(true);
          }
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.event === "agent_status") {
              setAgentProcessStatus(data.status || "[Processing...]");
              setIsAgentBusy(data.is_busy !== undefined ? data.is_busy : true);
            } else if (data.event === "agent_response") {
              setAgentResponse(data.response || data.text || "");
              setIsAgentBusy(false);
              setAgentProcessStatus("[Task completed // Response ready]");
            } else if (data.event === "tts_state") {
              if (data.state === "speaking") {
                cancelAutoHideTimer();
                setIsSpeaking(true);
                setAgentProcessStatus("[Speaking...]");
              } else if (data.state === "finished") {
                setIsSpeaking(false);
                setAgentProcessStatus("[Systems nominal // Awaiting directive]");
                startAutoHideTimer(4000);
              }
            }
          } catch {
            // Ignore non-JSON
          }
        };

        ws.onclose = () => {
          if (isMounted) {
            setIsWsConnected(false);
            reconnectTimeout = setTimeout(connectWs, 3000);
          }
        };

        ws.onerror = () => {
          if (isMounted) {
            setIsWsConnected(false);
          }
        };
      } catch {
        if (isMounted) {
          reconnectTimeout = setTimeout(connectWs, 3000);
        }
      }
    }

    connectWs();

    return () => {
      isMounted = false;
      clearTimeout(reconnectTimeout);
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [cancelAutoHideTimer, startAutoHideTimer]);

  // Dispatch prompt to agy agent via WebSocket or Tauri IPC
  const handoffPromptToAgent = useCallback(async (promptText: string) => {
    const trimmed = promptText.trim();
    if (!trimmed) return;

    cancelAutoHideTimer();
    setIsAgentBusy(true);
    setAgentProcessStatus("[Analyzing prompt & planning strategy...]");
    setStatusMessage(`HANDING OFF PROMPT TO AGY: "${trimmed}"`);

    // 1. Send via WebSocket if available
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        action: "prompt",
        prompt: trimmed
      }));
    }

    // 2. Also forward via Tauri invoke for IPC bridge
    try {
      await invoke("submit_agy_prompt", { prompt: trimmed });
    } catch {
      // Fallback
    }
  }, [cancelAutoHideTimer]);

  // Listen for Tauri backend events
  useEffect(() => {
    const unlistenFns: (() => void)[] = [];

    async function setupListeners() {
      try {
        // 1. Wake word detection: resets auto-hide and unhides window
        const unlistenWake = await listen<WakeWordPayload>("wake-word-detected", (event) => {
          cancelAutoHideTimer();
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
          cancelAutoHideTimer();
          const text = event.payload?.text || "";
          setTranscribedPartial(text);
          setIsListening(true);
          setStatusMessage("TRANSCRIBING // STREAMING AUDIO TOKENS");

          // Silence threshold detection: 1.5s after last partial token
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
          }
          if (autoHandoffEnabled && text) {
            silenceTimerRef.current = setTimeout(() => {
              handoffPromptToAgent(text);
              setTranscribedFinal((prev) => (prev ? `${prev} ${text}` : text));
              setTranscribedPartial("");
            }, 1500);
          }
        });
        unlistenFns.push(unlistenPartial);

        // 3. STT final recognized phrase
        const unlistenFinal = await listen<SttPayload>("stt-final", (event) => {
          cancelAutoHideTimer();
          const text = event.payload?.text || "";
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
          }
          if (text) {
            setTranscribedFinal((prev) => (prev ? `${prev} ${text}` : text));
            if (autoHandoffEnabled) {
              handoffPromptToAgent(text);
            }
          }
          setTranscribedPartial("");
          setStatusMessage("TRANSCRIPTION COMMITTED // AWAITING DIRECTIVE");
        });
        unlistenFns.push(unlistenFinal);

        // 4. STT engine state
        const unlistenState = await listen<{ state: string }>("stt-state", (event) => {
          const state = event.payload?.state || "idle";
          if (state === "listening") {
            cancelAutoHideTimer();
            setIsListening(true);
          } else if (state === "idle") {
            setIsListening(false);
          }
        });
        unlistenFns.push(unlistenState);

        // 5. agy Agent Status updates from Tauri IPC
        const unlistenAgentStatus = await listen<AgentStatusPayload>("agent-status", (event) => {
          cancelAutoHideTimer();
          const status = event.payload?.status || "[Processing...]";
          setAgentProcessStatus(status);
          if (event.payload?.is_busy !== undefined) {
            setIsAgentBusy(event.payload.is_busy);
          }
        });
        unlistenFns.push(unlistenAgentStatus);

        // 6. agy Agent Response from Tauri IPC
        const unlistenAgentResp = await listen<AgentResponsePayload>("agent-response", (event) => {
          const resp = event.payload?.response || event.payload?.text || "";
          setAgentResponse(resp);
          setIsAgentBusy(false);
          setAgentProcessStatus("[Task completed // Response ready]");
        });
        unlistenFns.push(unlistenAgentResp);

        // 7. TTS state listener (synthesizing -> speaking -> finished -> auto-hide)
        const unlistenTts = await listen<{ state: string; status?: string; text?: string }>("tts-state", (event) => {
          const state = event.payload?.state;
          if (state === "speaking") {
            cancelAutoHideTimer();
            setIsSpeaking(true);
            setAgentProcessStatus("[Speaking...]");
            setStatusMessage("VOICE SYNTHESIS ACTIVE // SPEAKING");
          } else if (state === "synthesizing") {
            cancelAutoHideTimer();
            setAgentProcessStatus("[Synthesizing speech response...]");
          } else if (state === "finished") {
            setIsSpeaking(false);
            setAgentProcessStatus("[Systems nominal // Awaiting directive]");
            // Trigger 4-second auto-hide countdown once speech playback concludes
            startAutoHideTimer(4000);
          }
        });
        unlistenFns.push(unlistenTts);

      } catch (err) {
        console.warn("Tauri event listener failed to bind:", err);
      }
    }

    setupListeners();

    return () => {
      unlistenFns.forEach((fn) => fn());
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
      }
      cancelAutoHideTimer();
    };
  }, [autoHandoffEnabled, handoffPromptToAgent, cancelAutoHideTimer, startAutoHideTimer]);

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

        const analyser = ctx.createAnalyser();
        analyser.fftSize = 64;
        source.connect(analyser);

        setIsWebAudioActive(true);
        setIsListening(true);
        setStatusMessage("WEBRTC AUDIO CAPTURE LIVE // STREAMING MICROPHONE");

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

  // Simulate token-by-token streaming STT text with automatic command handoff on completion
  const handleSimulateTokenStream = async () => {
    setIsVisible(true);
    setIsListening(true);
    setStatusMessage("STREAMING TEST: DISPATCHING SIMULATED TOKENS");

    const sampleTokens = [
      "Jarvis,",
      "inspect",
      "project",
      "status",
      "and",
      "review",
      "git",
      "commits."
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
      await new Promise((r) => setTimeout(r, 110));
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

    // Silence threshold trigger handoff
    if (autoHandoffEnabled) {
      handoffPromptToAgent(currentString);
    }
  };

  // Simulate agy agent process telemetry steps
  const handleSimulateAgentTelemetry = async () => {
    setIsAgentBusy(true);
    try {
      await invoke("simulate_agy_workflow", {
        prompt: "Analyze system diagnostics and codebase status"
      });
    } catch {
      // Fallback directly via state
      const steps = [
        "[Analyzing prompt & planning strategy...]",
        "[Searching file system...]",
        "[Analyzing logs & source files...]",
        "[Generating response...]"
      ];
      for (const step of steps) {
        setAgentProcessStatus(step);
        await new Promise((r) => setTimeout(r, 700));
      }
      setAgentProcessStatus("[Systems nominal // Awaiting directive]");
      setAgentResponse("Diagnostics confirm all operations nominal. Primary workspace in optimal health, Sir.");
      setIsAgentBusy(false);
    }
  };

  // Trigger manual TTS synthesis and speech playback
  const handleTriggerTts = async () => {
    cancelAutoHideTimer();
    setIsSpeaking(true);
    setAgentProcessStatus("[Speaking...]");
    setStatusMessage("VOICE SYNTHESIS ACTIVE // SPEAKING");
    const textToSpeak = agentResponse || "Diagnostics confirm all systems are functioning within normal parameters, Sir.";
    try {
      await invoke("trigger_tts_speak", { text: textToSpeak });
    } catch {
      setTimeout(() => {
        setIsSpeaking(false);
        setAgentProcessStatus("[Systems nominal // Awaiting directive]");
        startAutoHideTimer(4000);
      }, 3000);
    }
  };

  const handleClearTranscript = () => {
    setTranscribedFinal("");
    setTranscribedPartial("");
    setStatusMessage("TRANSCRIPTION BUFFER CLEARED");
  };

  const handleClearAgentResponse = () => {
    setAgentResponse("");
    setAgentProcessStatus("[Systems nominal // Awaiting directive]");
    setIsAgentBusy(false);
  };

  const handleCommandSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inputValue.trim();
    if (!trimmed) return;

    if (trimmed === "/voice") {
      handleTriggerVoice();
    } else if (trimmed === "/stop") {
      handleStopVoice();
    } else if (trimmed === "/speak") {
      handleTriggerTts();
    } else if (trimmed === "/hide" || trimmed === "/dismiss") {
      handleDismiss();
    } else if (trimmed === "/wake") {
      handleSimulateWake();
    } else if (trimmed === "/clear") {
      handleClearTranscript();
      handleClearAgentResponse();
    } else if (trimmed === "/test-stt") {
      handleSimulateTokenStream();
    } else if (trimmed === "/test-agent") {
      handleSimulateAgentTelemetry();
    } else {
      // Direct command submitted to agy agent
      handoffPromptToAgent(trimmed);
    }
    setInputValue("");
  };

  return (
    <main className="w-screen h-screen flex flex-col items-center justify-center p-6 select-none bg-transparent">
      {/* HUD Container with CSS Fade-In and Scale Transition */}
      <div
        className={`w-full max-w-xl rounded-2xl bg-neutral-950/90 backdrop-blur-2xl border border-cyan-500/30 p-6 shadow-2xl shadow-cyan-950/60 text-slate-100 flex flex-col gap-3.5 transform transition-all duration-500 ease-out ${
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
                  isSpeaking
                    ? "bg-amber-400"
                    : isListening || isWebAudioActive
                    ? "bg-emerald-400"
                    : isAgentBusy
                    ? "bg-amber-400"
                    : "bg-cyan-400"
                }`}
              ></span>
              <span
                className={`relative inline-flex rounded-full h-3 w-3 ${
                  isSpeaking
                    ? "bg-amber-500"
                    : isListening || isWebAudioActive
                    ? "bg-emerald-500"
                    : isAgentBusy
                    ? "bg-amber-500"
                    : "bg-cyan-500"
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
              className="text-xs font-mono text-cyan-500 hover:text-cyan-300 px-2 py-0.5 rounded border border-cyan-500/20 hover:border-cyan-500/50 transition-colors cursor-pointer"
            >
              ESC ✕
            </button>
          </div>
        </div>

        {/* Audio Visualizer & Wave Activity */}
        <div className="flex items-center justify-between bg-black/40 rounded-xl px-4 py-2.5 border border-cyan-500/10">
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-cyan-400/60 uppercase tracking-widest">
                Acoustic Telemetry
              </span>
              {isSpeaking && (
                <span className="text-[9px] font-mono bg-amber-950/80 text-amber-300 border border-amber-500/40 px-1.5 py-0.2 rounded animate-pulse">
                  TTS ACTIVE
                </span>
              )}
              {isWebAudioActive && !isSpeaking && (
                <span className="text-[9px] font-mono bg-emerald-950/80 text-emerald-400 border border-emerald-500/30 px-1.5 py-0.2 rounded">
                  WEBRTC LIVE
                </span>
              )}
            </div>
            <span className="text-xs font-mono font-medium text-cyan-100">
              {isSpeaking ? (
                <span className="text-amber-300 font-semibold animate-pulse">
                  AUDIO SYNTHESIS ❯ SPEAKING RESPONSE...
                </span>
              ) : isListening || isWebAudioActive ? (
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

          {/* Dynamic Audio Wave Bars (Reactive to Speaking and Listening) */}
          <div className="flex items-end gap-1 h-7">
            {[40, 75, 100, 60, 90, 45, 80, 55, 30].map((height, idx) => (
              <span
                key={idx}
                className={`w-1 rounded-full transition-all duration-150 ${
                  isSpeaking
                    ? "bg-gradient-to-t from-amber-400 to-yellow-200 animate-pulse"
                    : isListening || isWebAudioActive
                    ? "bg-gradient-to-t from-emerald-500 to-cyan-300 animate-pulse"
                    : "bg-cyan-500/20"
                }`}
                style={{
                  height: isSpeaking ? `${height * 1.1}%` : isListening || isWebAudioActive ? `${height}%` : "20%",
                  animationDelay: `${idx * 75}ms`,
                }}
              />
            ))}
          </div>
        </div>

        {/* Auto-Hide Countdown Banner */}
        {autoHideCountdown !== null && (
          <div className="flex items-center justify-between px-3.5 py-1.5 rounded-xl bg-cyan-950/30 border border-cyan-500/30 text-[10px] font-mono text-cyan-300 transition-all">
            <div className="flex items-center gap-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping"></span>
              <span>RESPONSE COMPLETE // AUTO-HIDING IN {autoHideCountdown}S...</span>
            </div>
            <button
              onClick={cancelAutoHideTimer}
              className="text-cyan-400 hover:text-white underline cursor-pointer uppercase font-bold text-[9px]"
              title="Pin window and cancel auto-hide"
            >
              Pin Window
            </button>
          </div>
        )}

        {/* Phase 4: Agent Process Display - Secondary Smaller Field with subtle pulse animation */}
        <div className="flex items-center justify-between px-3.5 py-2 rounded-xl bg-cyan-950/20 border border-cyan-500/20 text-xs font-mono transition-all">
          <div className="flex items-center gap-2.5 overflow-hidden">
            <span className="relative flex h-2 w-2 flex-shrink-0">
              {isAgentBusy ? (
                <>
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500"></span>
                </>
              ) : (
                <span className="inline-flex rounded-full h-2 w-2 bg-slate-500/60"></span>
              )}
            </span>
            <span className="text-[10px] text-cyan-400/60 uppercase tracking-widest flex-shrink-0">
              PROCESS:
            </span>
            <span
              className={`tracking-wide text-xs truncate ${
                isAgentBusy
                  ? "text-cyan-200 animate-pulse font-medium drop-shadow-[0_0_8px_rgba(34,211,238,0.6)]"
                  : "text-slate-400"
              }`}
            >
              {agentProcessStatus}
            </span>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0 text-[9px] font-mono text-cyan-400/50">
            <span title={statusMessage} className="hidden md:inline text-cyan-500/70 truncate max-w-[140px]">{statusMessage}</span>
            <span className="hidden md:inline">•</span>
            <span>IPC</span>
            <span>•</span>
            <span className={isWsConnected ? "text-emerald-400" : "text-slate-500"}>
              WS {isWsConnected ? "ON" : "OFF"}
            </span>
          </div>
        </div>

        {/* Real-Time Transcription Minimalist Glowing White Text Block */}
        <div className="relative rounded-xl bg-white/[0.02] border border-white/10 p-4 shadow-inner backdrop-blur-md overflow-hidden min-h-[85px] flex flex-col justify-between transition-all duration-300">
          <div className="flex items-center justify-between border-b border-white/5 pb-2 mb-2">
            <div className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-cyan-400 shadow-[0_0_6px_#22d3ee] animate-pulse"></span>
              <span className="text-[10px] font-mono tracking-widest text-slate-300 uppercase">
                Real-Time Speech-to-Text
              </span>
            </div>
            <div className="flex items-center gap-2 text-[10px] font-mono text-cyan-400/80">
              <span
                onClick={() => setAutoHandoffEnabled(!autoHandoffEnabled)}
                className={`cursor-pointer px-1.5 py-0.5 rounded border text-[9px] transition-colors ${
                  autoHandoffEnabled
                    ? "bg-cyan-950/60 text-cyan-300 border-cyan-500/40"
                    : "bg-neutral-900 text-slate-500 border-neutral-700"
                }`}
                title="Automatically submit prompt to agy agent when silence is reached"
              >
                AUTO-HANDOFF: {autoHandoffEnabled ? "ON" : "OFF"}
              </span>
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
          <div className="font-mono text-sm leading-relaxed select-text min-h-[40px] break-words">
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
                Awaiting acoustic input... Say &quot;Jarvis&quot; to speak.
              </span>
            ) : (
              <span className="inline-block w-2 h-4 ml-1 bg-white/40 animate-pulse align-middle"></span>
            )}
          </div>
        </div>

        {/* agy Agent Response Pane (Conditional Display) */}
        {agentResponse && (
          <div className="relative rounded-xl bg-cyan-950/30 border border-cyan-500/30 p-4 backdrop-blur-md shadow-xl text-slate-100 flex flex-col gap-2">
            <div className="flex items-center justify-between border-b border-cyan-500/20 pb-2">
              <span className="text-[10px] font-mono uppercase tracking-widest text-cyan-400 font-semibold">
                J.A.R.V.I.S. Response
              </span>
              <button
                onClick={handleClearAgentResponse}
                className="text-[10px] font-mono text-cyan-400 hover:text-cyan-200 underline cursor-pointer"
              >
                Dismiss
              </button>
            </div>
            <p className="font-mono text-xs text-cyan-50 leading-relaxed max-h-40 overflow-y-auto pr-1">
              {agentResponse}
            </p>
          </div>
        )}

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
            placeholder="Type directive for agy or command (/voice, /clear)..."
            className="w-full bg-transparent text-sm text-cyan-100 placeholder-cyan-600/50 outline-none font-mono"
          />
          <button
            type="submit"
            className="text-xs font-mono font-semibold text-cyan-400 hover:text-cyan-200 uppercase tracking-wider px-2 py-1 rounded bg-cyan-950/60 border border-cyan-500/30 hover:border-cyan-400/60 transition-all cursor-pointer"
          >
            Send
          </button>
        </form>

        {/* Test Controls & Telemetry Footer */}
        <div className="flex items-center justify-between text-[10px] font-mono text-cyan-400/50 pt-1.5 border-t border-cyan-500/10">
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
              title="Test voice stream + auto-handoff to agent"
            >
              Simulate STT
            </button>
            <span>•</span>
            <button
              onClick={handleSimulateAgentTelemetry}
              className="text-cyan-400 hover:text-cyan-200 underline cursor-pointer"
              title="Test [Searching file system...], etc."
            >
              Test Status
            </button>
            <button
              onClick={handleSimulateWake}
              className="text-cyan-400 hover:text-cyan-200 underline cursor-pointer"
            >
              Wake
            </button>
            <span>•</span>
            <button
              onClick={handleTriggerTts}
              className="text-amber-400 hover:text-amber-200 underline cursor-pointer"
              title="Synthesize and play response via TTS"
            >
              Speak
            </button>
          </div>
          <span className="hidden sm:inline">HYPRLAND: FLOATING</span>
        </div>
      </div>
    </main>
  );
}



