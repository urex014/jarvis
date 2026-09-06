import { useState, useEffect } from "react";
import "./App.css";

export default function App() {
  const [time, setTime] = useState("");
  const [status, setStatus] = useState("SYSTEMS NOMINAL");

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

  return (
    <main className="w-screen h-screen flex flex-col items-center justify-center p-6 select-none bg-transparent">
      <div className="w-full max-w-lg rounded-2xl bg-neutral-950/80 backdrop-blur-xl border border-cyan-500/30 p-6 shadow-2xl shadow-cyan-950/50 text-slate-100 flex flex-col gap-4 transition-all duration-300">
        {/* Header HUD Bar */}
        <div className="flex items-center justify-between border-b border-cyan-500/20 pb-3">
          <div className="flex items-center gap-3">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-cyan-500"></span>
            </span>
            <span className="text-xs font-mono font-semibold tracking-widest text-cyan-400 uppercase">
              J.A.R.V.I.S. // OVERLAY
            </span>
          </div>
          <div className="text-xs font-mono text-cyan-300/70">{time}</div>
        </div>

        {/* Status Display */}
        <div className="flex flex-col gap-1 my-2">
          <span className="text-[10px] font-mono text-cyan-400/60 uppercase tracking-wider">
            Diagnostics
          </span>
          <span className="text-sm font-medium tracking-wide text-cyan-100 font-mono">
            {status}
          </span>
        </div>

        {/* Quick Action Input / Command Line */}
        <div className="flex items-center gap-2 bg-neutral-900/90 border border-cyan-500/20 rounded-xl px-4 py-2.5 focus-within:border-cyan-400/60 focus-within:ring-1 focus-within:ring-cyan-400/30 transition-all">
          <span className="text-cyan-400 font-mono text-sm">❯</span>
          <input
            type="text"
            placeholder="Awaiting directive, Sir..."
            className="w-full bg-transparent text-sm text-cyan-100 placeholder-cyan-600/50 outline-none font-mono"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setStatus(`PROCESSING: "${e.currentTarget.value}"`);
                e.currentTarget.value = "";
              }
            }}
          />
        </div>

        {/* Telemetry / Status Footer */}
        <div className="flex items-center justify-between text-[10px] font-mono text-cyan-400/50 pt-2 border-t border-cyan-500/10">
          <span>HOST: LINUX (WAYLAND)</span>
          <span>WINDOW: FLOATING / UNPINNED FOCUS</span>
        </div>
      </div>
    </main>
  );
}

