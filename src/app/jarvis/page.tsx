"use client";

import { useState, useRef, useEffect, useCallback } from "react";

type PermissionState = "idle" | "requesting" | "granted" | "denied" | "error" | "unsupported";
type AppState = "permissions" | "ready" | "listening" | "thinking" | "speaking";
interface Message {
  role: "user" | "assistant";
  content: string;
}

interface LogEntry {
  id: number;
  type: "interim" | "heard" | "reply" | "error" | "status";
  text: string;
}

// ─── Shared Audio Analyser ──────────────────────────────────────────────────
class AudioAnalyserBus {
  ctx: AudioContext | null = null;
  analyser: AnalyserNode | null = null;
  data: Uint8Array = new Uint8Array(0);
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micStream: MediaStream | null = null;
  private ttsSource: MediaElementAudioSourceNode | null = null;
  private ttsEl: HTMLAudioElement | null = null;

  private ensureCtx() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
    if (!this.analyser) {
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.75;
      this.data = new Uint8Array(this.analyser.frequencyBinCount);
    }
    return this.ctx;
  }

  attachMic(stream: MediaStream) {
    const ctx = this.ensureCtx();
    this.detachMic();
    this.micStream = stream;
    this.micSource = ctx.createMediaStreamSource(stream);
    this.micSource.connect(this.analyser!);
  }

  detachMic() {
    try { this.micSource?.disconnect(); } catch {}
    this.micSource = null;
    this.micStream = null;
  }

  attachTTS(audioEl: HTMLAudioElement) {
    const ctx = this.ensureCtx();
    if (this.ttsEl === audioEl && this.ttsSource) {
      this.ttsSource.connect(this.analyser!);
      return;
    }
    this.detachTTS();
    this.ttsEl = audioEl;
    try {
      this.ttsSource = ctx.createMediaElementSource(audioEl);
      this.ttsSource.connect(this.analyser!);
      this.ttsSource.connect(ctx.destination);
    } catch {
      this.ttsSource = null;
    }
  }

  detachTTS() {
    try { this.ttsSource?.disconnect(); } catch {}
    this.ttsSource = null;
    this.ttsEl = null;
  }

  getLevels(bandCount: number): number[] {
    if (!this.analyser) return new Array(bandCount).fill(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.analyser.getByteFrequencyData(this.data as any);
    const bins = this.data.length;
    const bands = new Array(bandCount).fill(0);
    const perBand = Math.floor(bins / bandCount) || 1;
    for (let b = 0; b < bandCount; b++) {
      let sum = 0;
      const start = b * perBand;
      const end = Math.min(start + perBand, bins);
      for (let i = start; i < end; i++) sum += this.data[i];
      const avg = sum / Math.max(1, end - start);
      bands[b] = avg / 255;
    }
    return bands;
  }
}

let audioBus: AudioAnalyserBus | null = null;
function getAudioBus() {
  if (typeof window === "undefined") return null;
  if (!audioBus) audioBus = new AudioAnalyserBus();
  return audioBus;
}

// ─── TTS Hook ─────────────────────────────────────────────────────────────────
function useTTS() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const unlockedRef = useRef(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const unlock = useCallback(() => {
    if (unlockedRef.current) return;
    try {
      const a = new Audio();
      a.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
      a.volume = 0;
      const p = a.play();
      if (p && typeof p.then === "function") {
        p.then(() => { unlockedRef.current = true; }).catch(() => {});
      } else {
        unlockedRef.current = true;
      }
    } catch {}
    try { getAudioBus()?.ctx?.resume(); } catch {}
  }, []);

  const speak = useCallback(async (text: string) => {
    if (!text || !text.trim()) return;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    setIsLoading(true);
    setIsSpeaking(false);
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error("TTS failed");
      const arrayBuffer = await res.arrayBuffer();
      if (arrayBuffer.byteLength === 0) throw new Error("Empty audio");
      const blob = new Blob([arrayBuffer], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio();
      audio.preload = "auto";
      audio.crossOrigin = "anonymous";
      audio.setAttribute("playsinline", "true");
      audioRef.current = audio;
      audio.onplay = () => {
        setIsLoading(false);
        setIsSpeaking(true);
        try { getAudioBus()?.attachTTS(audio); } catch {}
      };
      audio.onended = () => {
        setIsSpeaking(false);
        audioRef.current = null;
        try { getAudioBus()?.detachTTS(); } catch {}
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      audio.onerror = () => {
        setIsSpeaking(false);
        setIsLoading(false);
        audioRef.current = null;
        try { getAudioBus()?.detachTTS(); } catch {}
        URL.revokeObjectURL(url);
      };
      audio.src = url;
      await audio.play();
      unlockedRef.current = true;
    } catch (err) {
      console.error("[TTS]", err);
      setIsSpeaking(false);
      setIsLoading(false);
    }
  }, []);

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    try { getAudioBus()?.detachTTS(); } catch {}
    setIsSpeaking(false);
    setIsLoading(false);
  }, []);

  useEffect(() => () => { audioRef.current?.pause(); }, []);
  return { speak, stop, unlock, isSpeaking, isLoading };
}

// ─── STT Hook ──────────────────────────────────────────────────────────────
type AnyRecognition = {
  continuous: boolean; interimResults: boolean; lang: string;
  onstart: (() => void) | null; onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onresult: ((e: {
    resultIndex: number;
    results: { [k: number]: { [k: number]: { transcript: string }; isFinal: boolean }; length: number }
  }) => void) | null;
  start: () => void; stop: () => void; abort: () => void;
};

function getSpeechRecognitionCtor(): (new () => AnyRecognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, new () => AnyRecognition>;
  return w["SpeechRecognition"] || w["webkitSpeechRecognition"] || null;
}

function useSTT(
  onResult: (text: string) => void,
  onInterim: (text: string) => void,
  onLog: (type: LogEntry["type"], text: string) => void
) {
  const recognitionRef = useRef<AnyRecognition | null>(null);
  const userWantsListeningRef = useRef(false);
  const accumulatedFinalRef = useRef("");
  // Mirrors the latest interim transcript in a ref so stop() can read it
  // synchronously — React state (interimText) is not accessible inside
  // callbacks without stale-closure issues.
  const latestInterimRef = useRef("");
  const [isListening, setIsListening] = useState(false);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    setSupported(getSpeechRecognitionCtor() !== null);
  }, []);

  const createRecognition = useCallback(() => {
    const SR = getSpeechRecognitionCtor();
    if (!SR) { setSupported(false); return null; }

    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onstart = () => {
      setIsListening(true);
      onLog("status", "Listening… tap again to stop");
    };

    rec.onend = () => {
      // Silently restart if user still wants to listen (handles mobile
      // engines that end sessions after silence / ~60s timeout).
      if (userWantsListeningRef.current) {
        try {
          const fresh = createRecognition();
          if (fresh) {
            recognitionRef.current = fresh;
            fresh.start();
          }
        } catch {
          setIsListening(false);
          userWantsListeningRef.current = false;
        }
      } else {
        setIsListening(false);
      }
    };

    rec.onerror = (e) => {
      // Benign — don't surface these to the user.
      if (e.error === "no-speech" || e.error === "aborted") return;
      console.error("[STT] error:", e.error);
      onLog("error", `Speech error: ${e.error}`);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        userWantsListeningRef.current = false;
        setIsListening(false);
      }
    };

    rec.onresult = (e) => {
      // Start from e.resultIndex to avoid re-processing already-finalized results.
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          accumulatedFinalRef.current = (accumulatedFinalRef.current + " " + transcript).trim();
          // Once finalized, clear the interim mirror for this chunk.
          latestInterimRef.current = "";
        } else {
          interimText += transcript;
        }
      }
      // Always keep the ref in sync so stop() can grab it as a fallback.
      if (interimText) latestInterimRef.current = interimText;
      onInterim(interimText);
    };

    return rec;
  }, [onInterim, onLog]);

  const start = useCallback(() => {
    if (userWantsListeningRef.current) return;
    const SR = getSpeechRecognitionCtor();
    if (!SR) { setSupported(false); return; }
    userWantsListeningRef.current = true;
    accumulatedFinalRef.current = "";
    latestInterimRef.current = "";
    const rec = createRecognition();
    if (!rec) return;
    recognitionRef.current = rec;
    try {
      rec.start();
    } catch (err) {
      console.error("[STT] start failed:", err);
      onLog("error", `Could not start mic: ${err}`);
      userWantsListeningRef.current = false;
      setIsListening(false);
    }
  }, [createRecognition, onLog]);

  // Explicit stop — fires onResult with whatever was heard (finals first,
  // interim as fallback). This is the "tap to send" moment.
  const stop = useCallback(() => {
    userWantsListeningRef.current = false;
    try { recognitionRef.current?.stop(); } catch {}
    try { recognitionRef.current?.abort(); } catch {}
    recognitionRef.current = null;
    setIsListening(false);
    onInterim("");

    const finals = accumulatedFinalRef.current.trim();
    // If the engine hasn't committed a final yet (common when the user
    // taps stop quickly), fall back to whatever interim text was last seen.
    const interim = latestInterimRef.current.trim();
    accumulatedFinalRef.current = "";
    latestInterimRef.current = "";

    const text = finals || interim;
    if (text) {
      onResult(text);
    } else {
      onLog("status", "No speech detected");
    }
  }, [onResult, onInterim, onLog]);

  useEffect(() => () => {
    userWantsListeningRef.current = false;
    try { recognitionRef.current?.abort(); } catch {}
  }, []);

  return { start, stop, isListening, supported };
}

// ─── Transcript Panel ──────────────────────────────────────────────────────
function TranscriptPanel({ log, interimText, jarvisText, color }: {
  log: LogEntry[];
  interimText: string;
  jarvisText: string;
  color: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [log, interimText]);

  return (
    <div style={{
      position: "absolute",
      bottom: "max(4.5rem, calc(env(safe-area-inset-bottom, 0px) + 4rem))",
      left: "max(1rem, env(safe-area-inset-left, 0px))",
      right: "max(1rem, env(safe-area-inset-right, 0px))",
      zIndex: 20,
      display: "flex",
      flexDirection: "column",
      gap: 8,
    }}>
      <div style={{
        background: "rgba(0,0,0,0.7)",
        border: `1px solid rgba(${color},0.3)`,
        borderRadius: 6,
        padding: "10px 14px",
      }}>
        <div style={{ fontSize: 8, letterSpacing: "0.25em", color: `rgba(${color},0.5)`, marginBottom: 6 }}>
          JARVIS RESPONSE
        </div>
        <div style={{ fontSize: 13, color: `rgba(${color},0.9)`, lineHeight: 1.5, maxHeight: 80, overflow: "hidden", textOverflow: "ellipsis" }}>
          {jarvisText || "—"}
        </div>
      </div>

      <div
        ref={scrollRef}
        style={{
          background: "rgba(0,0,0,0.6)",
          border: `1px solid rgba(${color},0.15)`,
          borderRadius: 6,
          padding: "8px 12px",
          maxHeight: 120,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <div style={{ fontSize: 8, letterSpacing: "0.25em", color: `rgba(${color},0.4)`, marginBottom: 4 }}>
          SPEECH LOG
        </div>
        {log.length === 0 && (
          <div style={{ fontSize: 11, color: `rgba(${color},0.3)` }}>Tap orb to start speaking…</div>
        )}
        {log.map((entry) => (
          <div key={entry.id} style={{
            fontSize: 11,
            color:
              entry.type === "heard" ? `rgba(${color},0.85)` :
              entry.type === "reply" ? `rgba(0,220,120,0.75)` :
              entry.type === "error" ? "rgba(220,60,60,0.85)" :
              `rgba(${color},0.4)`,
            lineHeight: 1.4,
          }}>
            {entry.type === "heard" && "🎤 "}
            {entry.type === "reply" && "🤖 "}
            {entry.type === "error" && "⚠️ "}
            {entry.text}
          </div>
        ))}
        {interimText && (
          <div style={{ fontSize: 11, color: `rgba(${color},0.5)`, fontStyle: "italic" }}>
            🎤 {interimText}…
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Audio Visualizer Canvas ────────────────────────────────────────────────
function AudioVisualizer({ appState, micStream }: { appState: AppState; micStream: MediaStream | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const barsRef = useRef<number[]>([]);
  const timeRef = useRef(0);
  const BAR_COUNT = 64;

  useEffect(() => {
    const bus = getAudioBus();
    if (!bus) return;
    if (appState === "listening" && micStream) {
      bus.attachMic(micStream);
    } else if (appState !== "speaking") {
      bus.detachMic();
    }
    return () => {
      if (appState === "listening") bus.detachMic();
    };
  }, [appState, micStream]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const safeCtx = ctx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssSize = canvas.clientWidth || 500;
    canvas.width = cssSize * dpr;
    canvas.height = cssSize * dpr;
    safeCtx.scale(dpr, dpr);

    if (barsRef.current.length === 0) {
      barsRef.current = Array.from({ length: BAR_COUNT }, () => 0);
    }

    const W = cssSize;
    const H = cssSize;
    const cx = W / 2;
    const cy = H / 2;
    const radius = Math.min(W, H) * 0.28;

    function draw() {
      timeRef.current += 0.03;
      const t = timeRef.current;
      safeCtx.clearRect(0, 0, W, H);

      const isActive = appState === "speaking" || appState === "listening";
      const isThinking = appState === "thinking";
      const bus = getAudioBus();
      const liveLevels = isActive && bus ? bus.getLevels(BAR_COUNT) : null;
      const hasSignal = !!(liveLevels && liveLevels.some((v) => v > 0.02));

      barsRef.current = barsRef.current.map((v, i) => {
        if (hasSignal && liveLevels) {
          const target = Math.min(1, liveLevels[i] * 1.6);
          return v + (target - v) * 0.35;
        }
        if (!isActive && !isThinking) {
          const target = 0.04 + 0.06 * Math.sin(t * 0.8 + i * 0.3);
          return v + (target - v) * 0.08;
        }
        if (isThinking) {
          const target = 0.15 + 0.15 * Math.sin(t * 1.2 + i * (Math.PI * 2 / BAR_COUNT) * 3);
          return v + (target - v) * 0.06;
        }
        const target = 0.08 + 0.06 * Math.sin(t * 1.5 + i * 0.4);
        return v + (target - v) * 0.1;
      });

      for (let i = 0; i < BAR_COUNT; i++) {
        const angle = (i / BAR_COUNT) * Math.PI * 2 - Math.PI / 2;
        const barH = barsRef.current[i];
        const barLength = radius * 0.5 * barH + (isActive ? 4 : 2);
        const innerR = radius + 2;
        const outerR = innerR + barLength;
        const x1 = cx + Math.cos(angle) * innerR;
        const y1 = cy + Math.sin(angle) * innerR;
        const x2 = cx + Math.cos(angle) * outerR;
        const y2 = cy + Math.sin(angle) * outerR;

        let r: number, g: number, b: number;
        if (appState === "listening") { r = 220 + Math.floor(barH * 35); g = 60 + Math.floor(barH * 40); b = 60 + Math.floor(barH * 20); }
        else if (appState === "thinking") { r = 140 + Math.floor(barH * 60); g = 100 + Math.floor(barH * 50); b = 240; }
        else { r = Math.floor(barH * 80); g = 180 + Math.floor(barH * 75); b = 255; }

        const alpha = 0.3 + barH * 0.7;
        safeCtx.save();
        safeCtx.strokeStyle = `rgba(${r},${g},${b},${alpha * 0.35})`;
        safeCtx.lineWidth = 4;
        safeCtx.lineCap = "round";
        safeCtx.shadowColor = `rgba(${r},${g},${b},0.9)`;
        safeCtx.shadowBlur = isActive ? 12 + barH * 18 : 4;
        safeCtx.beginPath();
        safeCtx.moveTo(x1, y1);
        safeCtx.lineTo(x2, y2);
        safeCtx.stroke();
        safeCtx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
        safeCtx.lineWidth = isActive && barH > 0.6 ? 2.5 : 1.5;
        safeCtx.shadowBlur = 0;
        safeCtx.beginPath();
        safeCtx.moveTo(x1, y1);
        safeCtx.lineTo(x2, y2);
        safeCtx.stroke();
        safeCtx.restore();
      }

      const pulseScale = isActive ? 1 + 0.06 * Math.sin(t * 4) : 1 + 0.02 * Math.sin(t * 1.5);
      const coreR = radius * pulseScale;
      const outerGlow = safeCtx.createRadialGradient(cx, cy, coreR * 0.3, cx, cy, coreR * 1.4);
      if (appState === "listening") {
        outerGlow.addColorStop(0, `rgba(220,60,60,${0.12 + barAmplitude(barsRef.current) * 0.15})`);
        outerGlow.addColorStop(1, "rgba(0,0,0,0)");
      } else if (appState === "thinking") {
        outerGlow.addColorStop(0, `rgba(140,100,255,${0.1 + 0.1 * Math.sin(t * 2)})`);
        outerGlow.addColorStop(1, "rgba(0,0,0,0)");
      } else {
        outerGlow.addColorStop(0, `rgba(0,180,255,${0.08 + barAmplitude(barsRef.current) * 0.12})`);
        outerGlow.addColorStop(1, "rgba(0,0,0,0)");
      }
      safeCtx.beginPath();
      safeCtx.arc(cx, cy, coreR * 1.4, 0, Math.PI * 2);
      safeCtx.fillStyle = outerGlow;
      safeCtx.fill();

      animRef.current = requestAnimationFrame(draw);
    }

    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [appState]);

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" style={{ pointerEvents: "none" }} />;
}

function barAmplitude(bars: number[]) {
  if (!bars.length) return 0;
  return bars.reduce((a, b) => a + b, 0) / bars.length;
}

// ─── Arc Reactor Rings ────────────────────────────────────────────────────────
function ArcReactorRings({ appState }: { appState: AppState }) {
  const color = appState === "listening" ? "220,60,60" : appState === "thinking" ? "140,100,255" : "0,212,255";
  const alpha = appState === "ready" ? 0.08 : 0.18;
  return (
    <>
      <div className="absolute rounded-full" style={{ width: "68%", height: "68%", border: `1px solid rgba(${color},${alpha})`, animationName: "jSpin", animationDuration: "22s", animationTimingFunction: "linear", animationIterationCount: "infinite" }}>
        {Array.from({ length: 32 }).map((_, i) => (
          <div key={i} className="absolute" style={{ width: i % 8 === 0 ? 3 : 1.5, height: i % 8 === 0 ? 10 : 5, background: i % 8 === 0 ? `rgba(${color},0.6)` : `rgba(${color},0.2)`, top: "50%", left: "50%", transformOrigin: `1px 84px`, transform: `rotate(${i * (360 / 32)}deg) translateY(-84px)` }} />
        ))}
      </div>
      <div className="absolute rounded-full" style={{ width: "60%", height: "60%", border: `1px solid rgba(${color},${alpha * 0.6})`, animationName: "jSpin", animationDuration: "16s", animationTimingFunction: "linear", animationIterationCount: "infinite", animationDirection: "reverse" }}>
        {Array.from({ length: 16 }).map((_, i) => (
          <div key={i} className="absolute rounded-full" style={{ width: 3, height: 3, background: `rgba(${color},0.4)`, top: "50%", left: "50%", transformOrigin: "1.5px 74px", transform: `rotate(${i * (360 / 16)}deg) translateY(-74px)` }} />
        ))}
      </div>
      <div className="absolute rounded-full" style={{ width: "52%", height: "52%", border: `1px solid rgba(${color},${alpha * 0.4})`, animationName: "jSpin", animationDuration: "9s", animationTimingFunction: "linear", animationIterationCount: "infinite" }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="absolute" style={{ width: 1, height: 14, background: `rgba(${color},0.5)`, top: "50%", left: "50%", transformOrigin: "0.5px 64px", transform: `rotate(${i * 60}deg) translateY(-64px)` }} />
        ))}
      </div>
      <div className="absolute rounded-full" style={{ width: "44%", height: "44%", border: `1px solid rgba(${color},0.06)`, boxShadow: `0 0 ${appState === "speaking" ? 30 : 10}px rgba(${color},0.1)` }} />
    </>
  );
}

// ─── Permissions Screen ─────────────────────────────────────────────────────
function PermissionRow({ label, status, color }: { label: string; status: PermissionState; color: string }) {
  const statusText =
    status === "idle" ? "PENDING" :
    status === "requesting" ? "REQUESTING…" :
    status === "granted" ? "GRANTED" :
    status === "denied" ? "DENIED" :
    status === "unsupported" ? "UNSUPPORTED" : "ERROR";

  const statusColor =
    status === "granted" ? "0,220,120" :
    status === "denied" || status === "error" ? "220,60,60" :
    status === "requesting" ? "230,180,40" :
    "120,120,120";

  return (
    <div className="flex items-center justify-between gap-4 w-full">
      <span className="text-[10px] sm:text-[11px] tracking-[0.25em]" style={{ color: `rgba(${color},0.65)` }}>
        {label}
      </span>
      <div className="flex items-center gap-2">
        <div className="rounded-full" style={{
          width: 6, height: 6,
          background: `rgba(${statusColor},0.9)`,
          boxShadow: `0 0 8px rgba(${statusColor},0.7)`,
          animationName: status === "requesting" ? "jPulse" : "none",
          animationDuration: "1s",
          animationIterationCount: "infinite",
        }} />
        <span className="text-[9px] sm:text-[10px] tracking-[0.2em]" style={{ color: `rgba(${statusColor},0.85)` }}>
          {statusText}
        </span>
      </div>
    </div>
  );
}

function PermissionsScreen({ locStatus, micStatus, camStatus, onRequest }: {
  locStatus: PermissionState;
  micStatus: PermissionState;
  camStatus: PermissionState;
  onRequest: () => void;
}) {
  const color = "0,212,255";
  const anyRequesting = locStatus === "requesting" || micStatus === "requesting" || camStatus === "requesting";
  const anyDenied = locStatus === "denied" || micStatus === "denied";
  const buttonLabel = anyRequesting ? "REQUESTING ACCESS…" : anyDenied ? "RETRY AUTHORIZATION" : "INITIALIZE SYSTEMS";

  return (
    <div className="min-h-[100dvh] bg-[#020609] flex flex-col items-center justify-center font-mono overflow-hidden relative select-none px-6" style={{ touchAction: "manipulation" }}>
      <div className="absolute inset-0" style={{ background: `radial-gradient(ellipse at 50% 50%, rgba(${color},0.05) 0%, #020609 55%, #010305 100%)` }} />
      <div className="absolute inset-0 opacity-[0.025]" style={{ backgroundImage: "linear-gradient(#00d4ff 1px,transparent 1px),linear-gradient(90deg,#00d4ff 1px,transparent 1px)", backgroundSize: "80px 80px" }} />

      <HudCorners color={color} />

      <div className="relative z-10 flex flex-col items-center gap-8 w-full max-w-sm">
        <div className="flex flex-col items-center gap-2">
          <div className="flex items-center gap-3 sm:gap-4">
            <div className="h-px w-12 sm:w-16" style={{ background: `linear-gradient(to right, transparent, rgba(${color},0.4))` }} />
            <span className="text-[10px] sm:text-[12px] tracking-[0.5em] sm:tracking-[0.6em]" style={{ color: `rgba(${color},0.6)` }}>J · A · R · V · I · S</span>
            <div className="h-px w-12 sm:w-16" style={{ background: `linear-gradient(to left, transparent, rgba(${color},0.4))` }} />
          </div>
          <span className="text-[7px] sm:text-[8px] tracking-[0.3em] text-center" style={{ color: `rgba(${color},0.25)` }}>STARK INDUSTRIES · AUTONOMOUS INTELLIGENCE</span>
        </div>

        <div className="w-full flex flex-col gap-4 px-5 py-5 rounded-sm" style={{ border: `1px solid rgba(${color},0.18)`, background: "rgba(3,10,16,0.6)", boxShadow: `0 0 30px rgba(${color},0.06) inset` }}>
          <span className="text-[8px] tracking-[0.3em]" style={{ color: `rgba(${color},0.4)` }}>SYSTEM AUTHORIZATION REQUIRED</span>
          <PermissionRow label="LOCATION" status={locStatus} color={color} />
          <PermissionRow label="MICROPHONE" status={micStatus} color={color} />
          <PermissionRow label="CAMERA" status={camStatus} color={color} />
        </div>

        <button type="button" onClick={onRequest} disabled={anyRequesting} className="w-full py-3 rounded-sm text-[10px] sm:text-[11px] tracking-[0.3em] transition-all duration-300" style={{ border: `1px solid rgba(${color},0.5)`, color: `rgba(${color},0.9)`, background: `rgba(${color},0.07)`, boxShadow: `0 0 20px rgba(${color},0.12)`, cursor: anyRequesting ? "not-allowed" : "pointer", opacity: anyRequesting ? 0.6 : 1 }}>
          {buttonLabel}
        </button>

        {anyDenied && (
          <p className="text-[9px] tracking-[0.1em] text-center leading-relaxed" style={{ color: "rgba(220,60,60,0.7)" }}>
            Access denied. Enable location and microphone permissions in your browser settings, then retry.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── HUD Corner Brackets ─────────────────────────────────────────────────────
// FIX: Removed borderColor from base style. Instead, each corner's border-side
// properties include the full value (e.g. "1px solid rgba(...)") so React
// never sees borderColor and borderTop/Left/Right/Bottom on the same element
// at the same time — which was causing the "conflicting shorthand" warnings.
function HudCorners({ color }: { color: string }) {
  const borderVal = `1px solid rgba(${color},0.3)`;
  const w = "min(7vw, 36px)";
  const h = "min(7vw, 36px)";
  const insetTop = "max(0.75rem, env(safe-area-inset-top, 0px))";
  const insetBottom = "max(0.75rem, env(safe-area-inset-bottom, 0px))";
  const insetLeft = "max(0.75rem, env(safe-area-inset-left, 0px))";
  const insetRight = "max(0.75rem, env(safe-area-inset-right, 0px))";

  const base: React.CSSProperties = {
    position: "absolute",
    width: w,
    height: h,
  };

  return (
    <div className="absolute inset-0 pointer-events-none z-10">
      {/* Top-left */}
      <div style={{ ...base, top: insetTop, left: insetLeft, borderTop: borderVal, borderLeft: borderVal }} />
      {/* Top-right */}
      <div style={{ ...base, top: insetTop, right: insetRight, borderTop: borderVal, borderRight: borderVal }} />
      {/* Bottom-left */}
      <div style={{ ...base, bottom: insetBottom, left: insetLeft, borderBottom: borderVal, borderLeft: borderVal }} />
      {/* Bottom-right */}
      <div style={{ ...base, bottom: insetBottom, right: insetRight, borderBottom: borderVal, borderRight: borderVal }} />
    </div>
  );
}

// ─── State Indicator Dot + Label ─────────────────────────────────────────────
function StateDot({ state, color }: { state: AppState; color: string }) {
  const label =
    state === "listening" ? "LISTENING" :
    state === "thinking" ? "PROCESSING" :
    state === "speaking" ? "RESPONDING" :
    "STANDBY";

  return (
    <div className="flex items-center gap-2">
      <div className="rounded-full" style={{
        width: 6, height: 6,
        background: `rgba(${color},0.9)`,
        boxShadow: `0 0 10px rgba(${color},0.8)`,
        animationName: state === "ready" ? "jPulse" : "none",
        animationDuration: "2s",
        animationIterationCount: "infinite",
      }} />
      <span className="text-[9px] sm:text-[10px] tracking-[0.35em]" style={{ color: `rgba(${color},0.55)` }}>
        {label}
      </span>
    </div>
  );
}

// ─── Orb Center Icon/Indicator ───────────────────────────────────────────────
function OrbCenter({ appState, color }: { appState: AppState; color: string }) {
  if (appState === "thinking") {
    return (
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="flex gap-1.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-full" style={{
              width: 6, height: 6,
              background: `rgba(${color},0.85)`,
              boxShadow: `0 0 8px rgba(${color},0.6)`,
              animationName: "jBounce",
              animationDuration: "1.1s",
              animationTimingFunction: "ease-in-out",
              animationIterationCount: "infinite",
              animationDelay: `${i * 0.15}s`,
            }} />
          ))}
        </div>
      </div>
    );
  }

  if (appState === "listening") {
    return (
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="flex items-end gap-[3px]" style={{ height: 22 }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} style={{
              width: 3, height: "100%",
              background: `rgba(${color},0.85)`,
              boxShadow: `0 0 6px rgba(${color},0.5)`,
              borderRadius: 2,
              animationName: "jWave",
              animationDuration: "0.9s",
              animationTimingFunction: "ease-in-out",
              animationIterationCount: "infinite",
              animationDelay: `${i * 0.08}s`,
              transformOrigin: "bottom",
            }} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div className="rounded-full" style={{
        width: "22%", height: "22%",
        background: `radial-gradient(circle, rgba(${color},0.9) 0%, rgba(${color},0.3) 60%, transparent 100%)`,
        boxShadow: `0 0 ${appState === "speaking" ? 24 : 14}px rgba(${color},0.6)`,
      }} />
    </div>
  );
}

// ─── Bottom Indicator ────────────────────────────────────────────────────────
function BottomIndicator({ appState, color }: { appState: AppState; color: string }) {
  const text =
    appState === "listening" ? "TAP TO STOP & SEND" :
    appState === "thinking" ? "TAP TO CANCEL" :
    appState === "speaking" ? "TAP TO INTERRUPT" :
    "TAP ORB TO SPEAK";

  return (
    <div className="flex items-center gap-3">
      <div className="h-px w-6" style={{ background: `linear-gradient(to right, transparent, rgba(${color},0.3))` }} />
      <span className="text-[8px] sm:text-[9px] tracking-[0.3em]" style={{ color: `rgba(${color},0.4)` }}>{text}</span>
      <div className="h-px w-6" style={{ background: `linear-gradient(to left, transparent, rgba(${color},0.3))` }} />
    </div>
  );
}

// ─── Text Fallback Modal ──────────────────────────────────────────────────────
function TextFallbackModal({ color, value, onChange, onSubmit, onClose }: {
  color: string; value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-6" style={{ background: "rgba(2,6,9,0.85)", backdropFilter: "blur(4px)" }} onClick={onClose}>
      <div className="w-full max-w-sm flex flex-col gap-4 px-5 py-5 rounded-sm" style={{ border: `1px solid rgba(${color},0.3)`, background: "rgba(3,10,16,0.95)", boxShadow: `0 0 40px rgba(${color},0.1)` }} onClick={(e) => e.stopPropagation()}>
        <span className="text-[9px] tracking-[0.3em]" style={{ color: `rgba(${color},0.5)` }}>MANUAL INPUT</span>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onSubmit(); if (e.key === "Escape") onClose(); }}
          placeholder="Type your query, sir…"
          className="w-full bg-transparent outline-none text-[14px] py-2 px-1"
          style={{ color: `rgba(${color},0.9)`, borderBottom: `1px solid rgba(${color},0.25)` }}
        />
        <div className="flex gap-3 justify-end">
          <button type="button" onClick={onClose} className="px-4 py-2 text-[9px] tracking-[0.25em] rounded-sm" style={{ color: `rgba(${color},0.5)`, border: `1px solid rgba(${color},0.15)` }}>CANCEL</button>
          <button type="button" onClick={onSubmit} disabled={!value.trim()} className="px-4 py-2 text-[9px] tracking-[0.25em] rounded-sm" style={{ color: `rgba(${color},0.95)`, border: `1px solid rgba(${color},0.5)`, background: `rgba(${color},0.08)`, opacity: value.trim() ? 1 : 0.4 }}>SEND</button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function JarvisPage() {
  const [appState, setAppState] = useState<AppState>("permissions");
  const [jarvisText, setJarvisText] = useState("Systems online. How can I assist you today, sir?");
  const [messages, setMessages] = useState<Message[]>([]);
  const [textFallbackOpen, setTextFallbackOpen] = useState(false);
  const [textInput, setTextInput] = useState("");

  const [transcriptLog, setTranscriptLog] = useState<LogEntry[]>([]);
  const [interimText, setInterimText] = useState("");
  const logIdRef = useRef(0);

  const addLog = useCallback((type: LogEntry["type"], text: string) => {
    setTranscriptLog((prev) => [...prev.slice(-30), { id: ++logIdRef.current, type, text }]);
  }, []);

  const [locStatus, setLocStatus] = useState<PermissionState>("idle");
  const [micStatus, setMicStatus] = useState<PermissionState>("idle");
  const [camStatus, setCamStatus] = useState<PermissionState>("idle");
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [weather, setWeather] = useState<{ temperature: number; description: string; units: { temperature: string } } | null>(null);

  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<Message[]>([]);
  const coordsRef = useRef<{ lat: number; lon: number } | null>(null);
  const weatherRef = useRef<{ temperature: number; description: string; units: { temperature: string } } | null>(null);
  const locRef = useRef<PermissionState>("idle");
  const micRef = useRef<PermissionState>("idle");
  const camRef = useRef<PermissionState>("idle");

  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { coordsRef.current = coords; }, [coords]);
  useEffect(() => { weatherRef.current = weather; }, [weather]);
  useEffect(() => { locRef.current = locStatus; }, [locStatus]);
  useEffect(() => { micRef.current = micStatus; }, [micStatus]);
  useEffect(() => { camRef.current = camStatus; }, [camStatus]);

  const { speak, stop: stopTTS, unlock: unlockAudio, isSpeaking, isLoading: ttsLoading } = useTTS();

  const allGranted = locStatus === "granted" && micStatus === "granted";

  const handleVoiceInput = useCallback(async (text: string) => {
    if (!text.trim()) return;
    stopTTS();
    setInterimText("");
    addLog("heard", text);
    setAppState("thinking");

    const context = [
      coordsRef.current ? `[LOCATION: GPS ${coordsRef.current.lat.toFixed(5)}, ${coordsRef.current.lon.toFixed(5)}]` : "",
      weatherRef.current ? `[WEATHER: ${weatherRef.current.description} | ${weatherRef.current.temperature}${weatherRef.current.units.temperature}]` : "",
      `[PERMISSIONS: location=${locRef.current}, microphone=${micRef.current}, camera=${camRef.current}]`,
      "[SYSTEM: Use sensor data above when present. If a value is missing, say so rather than guessing.]",
    ].filter(Boolean).join("\n");

    const userMsg: Message = { role: "user", content: text };
    const nextMessages = [...messagesRef.current, userMsg];
    setMessages(nextMessages);

    abortRef.current?.abort();
    abortRef.current = new AbortController();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortRef.current.signal,
        body: JSON.stringify({
          messages: nextMessages.map(({ role, content }) => ({ role, content })),
          context,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const reply = data.reply as string;
      setJarvisText(reply);
      addLog("reply", reply);
      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
      // FIX: set appState to "speaking" BEFORE calling speak() so the orb
      // transitions immediately, instead of briefly flashing back to "ready".
      setAppState("speaking");
      await speak(reply);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      const errMsg = "Systems experiencing interference, sir. Please repeat your query.";
      setJarvisText(errMsg);
      addLog("error", errMsg);
      setAppState("speaking");
      await speak(errMsg);
    } finally {
      setAppState("ready");
    }
  }, [speak, stopTTS, addLog]);

  const handleInterim = useCallback((text: string) => {
    setInterimText(text);
  }, []);

  const { start: startSTT, stop: stopSTT, isListening, supported: sttSupported } = useSTT(
    handleVoiceInput,
    handleInterim,
    addLog
  );

  // FIX: Simplified state sync. We only sync listening→"listening" here.
  // The "thinking"→"speaking"→"ready" transitions are driven explicitly in
  // handleVoiceInput above, so we don't need to watch isSpeaking/ttsLoading
  // here and risk a race condition with the "thinking" state.
  useEffect(() => {
    if (appState === "thinking" || appState === "speaking") return;
    if (isListening) {
      setAppState("listening");
    } else if (appState === "listening") {
      setAppState("ready");
    }
  }, [isListening]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (allGranted && appState === "permissions") {
      setAppState("ready");
      setTimeout(() => speak(jarvisText), 800);
    }
  }, [allGranted]); // eslint-disable-line react-hooks/exhaustive-deps

  const requestAll = useCallback(async () => {
    unlockAudio();

    if ("geolocation" in navigator) {
      setLocStatus("requesting");
      navigator.geolocation.getCurrentPosition(
        async ({ coords: { latitude: lat, longitude: lon } }) => {
          setCoords({ lat, lon });
          setLocStatus("granted");
          try {
            const res = await fetch(`/api/weather?lat=${lat}&lon=${lon}`);
            if (res.ok) setWeather(await res.json());
          } catch {}
        },
        () => setLocStatus("denied"),
        { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 }
      );
    } else {
      setLocStatus("error");
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setMicStatus("unsupported");
      setCamStatus("unsupported");
      return;
    }

    setMicStatus("requesting");
    try {
      const a = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = a;
      setMicStream(a);
      setMicStatus("granted");
    } catch {
      setMicStatus("denied");
    }

    setCamStatus("requesting");
    try {
      const v = await navigator.mediaDevices.getUserMedia({ video: true });
      v.getTracks().forEach((t) => t.stop());
      setCamStatus("granted");
    } catch {
      setCamStatus("denied");
    }
  }, [unlockAudio]);

  useEffect(() => () => {
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  const activateOrb = useCallback(() => {
    if (!allGranted) return;
    if (appState === "listening") {
      // User taps to stop — STT hook will fire onResult with whatever was said.
      stopSTT();
      return;
    }
    if (appState === "speaking") {
  stopTTS();
  if (sttSupported) {
    addLog("status", "Listening… tap again to stop");
    startSTT();
  } else {
    setAppState("ready");
  }
  return;
}
    if (appState === "thinking") { abortRef.current?.abort(); setAppState("ready"); return; }
    if (appState === "ready") {
      if (!sttSupported) { setTextFallbackOpen(true); return; }
      addLog("status", "Listening… tap again to stop");
      startSTT();
    }
  }, [appState, allGranted, sttSupported, startSTT, stopSTT, stopTTS, addLog]);

  const handleClick = useCallback(() => {
    activateOrb();
  }, [activateOrb]);

  const submitTextFallback = useCallback(() => {
    const t = textInput.trim();
    if (!t) return;
    setTextInput("");
    setTextFallbackOpen(false);
    handleVoiceInput(t);
  }, [textInput, handleVoiceInput]);

  if (appState === "permissions") {
    return <PermissionsScreen locStatus={locStatus} micStatus={micStatus} camStatus={camStatus} onRequest={requestAll} />;
  }

  const stateColor =
    appState === "listening" ? "220,60,60" :
    appState === "thinking" ? "140,100,255" :
    appState === "speaking" ? "0,212,255" : "0,180,220";
  const isActive = appState === "speaking" || appState === "listening";

  return (
    <div
      className="min-h-[100dvh] bg-[#020609] flex flex-col items-center justify-center font-mono overflow-hidden relative select-none"
      style={{ touchAction: "manipulation" }}
    >
      <div className="absolute inset-0" style={{
        background: `radial-gradient(ellipse at 50% 50%, rgba(${stateColor},0.04) 0%, #020609 55%, #010305 100%)`,
        transition: "background 1s ease",
      }} />
      <div className="absolute inset-0 opacity-[0.025]" style={{
        backgroundImage: "linear-gradient(#00d4ff 1px,transparent 1px),linear-gradient(90deg,#00d4ff 1px,transparent 1px)",
        backgroundSize: "80px 80px",
      }} />
      <div className="absolute inset-0 pointer-events-none" style={{
        backgroundImage: "repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,0,0,0.05) 3px,rgba(0,0,0,0.05) 4px)",
      }} />

      <HudCorners color={stateColor} />

      <div className="absolute top-[max(1.5rem,env(safe-area-inset-top,0px))] left-0 right-0 flex flex-col items-center gap-1 z-10 px-4">
        <div className="flex items-center gap-3 sm:gap-4">
          <div className="h-px w-12 sm:w-20" style={{ background: `linear-gradient(to right, transparent, rgba(${stateColor},0.4))` }} />
          <span className="text-[9px] sm:text-[11px] tracking-[0.5em] sm:tracking-[0.6em] whitespace-nowrap" style={{ color: `rgba(${stateColor},0.55)` }}>J · A · R · V · I · S</span>
          <div className="h-px w-12 sm:w-20" style={{ background: `linear-gradient(to left, transparent, rgba(${stateColor},0.4))` }} />
        </div>
        <span className="text-[6px] sm:text-[7px] tracking-[0.3em] sm:tracking-[0.35em] text-center" style={{ color: `rgba(${stateColor},0.2)` }}>STARK INDUSTRIES · AUTONOMOUS INTELLIGENCE</span>
      </div>

      <div className="absolute z-10" style={{ top: "max(5.5rem, calc(env(safe-area-inset-top, 0px) + 4.5rem))" }}>
        <StateDot state={appState} color={stateColor} />
      </div>

      {weather && (
        <div className="absolute z-10 flex flex-col items-end gap-0.5" style={{ top: "max(1.5rem, env(safe-area-inset-top, 0px))", right: "max(1rem, env(safe-area-inset-right, 0px))" }}>
          <span className="text-[11px] font-light" style={{ color: `rgba(${stateColor},0.5)` }}>
            {weather.temperature}{weather.units.temperature}
          </span>
        </div>
      )}

      {!sttSupported && (
        <div className="absolute z-10 px-3 py-1 rounded-sm text-[7px] tracking-[0.2em]" style={{
          top: "max(8.5rem, calc(env(safe-area-inset-top, 0px) + 7.5rem))",
          border: `1px solid rgba(${stateColor},0.2)`,
          color: `rgba(${stateColor},0.5)`,
          background: "rgba(3,10,16,0.7)",
        }}>
          VOICE INPUT UNAVAILABLE · TAP TO TYPE
        </div>
      )}

      {/* Orb — sized to never exceed available viewport space */}
      <div
        className="relative z-10 flex items-center justify-center"
        style={{
          width: "min(85vw, 85vh, 420px)",
          height: "min(85vw, 85vh, 420px)",
          marginBottom: "min(25vw, 25vh, 140px)",
        }}
      >
        <AudioVisualizer appState={appState} micStream={micStream} />
        <ArcReactorRings appState={appState} />

        {isActive && (
          <>
            <div className="absolute rounded-full" style={{ width: "76%", height: "76%", border: `1px solid rgba(${stateColor},0.15)`, animationName: "jPing", animationDuration: "2.2s", animationTimingFunction: "ease-out", animationIterationCount: "infinite" }} />
            <div className="absolute rounded-full" style={{ width: "76%", height: "76%", border: `1px solid rgba(${stateColor},0.1)`, animationName: "jPing", animationDuration: "2.2s", animationTimingFunction: "ease-out", animationIterationCount: "infinite", animationDelay: "0.8s" }} />
          </>
        )}

        <button
          type="button"
          onClick={handleClick}
          disabled={appState === "thinking"}
          aria-label={
            appState === "listening" ? "Stop listening and send" :
            appState === "speaking" ? "Stop speaking" :
            appState === "thinking" ? "Processing" :
            "Start voice input"
          }
          aria-pressed={appState === "listening"}
          className="absolute rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 transition-all duration-700"
          style={{
            // FIX: use percentage sizing only — no fixed minWidth/minHeight
            // that could overflow small phone screens.
            width: "36%",
            height: "36%",
            outlineColor: `rgba(${stateColor},0.6)`,
            WebkitTapHighlightColor: "transparent",
            touchAction: "manipulation",
            background:
              appState === "listening" ? "radial-gradient(circle at 38% 35%, rgba(255,100,100,0.28) 0%, rgba(160,30,30,0.18) 45%, rgba(25,4,4,0.94) 100%)" :
              appState === "thinking" ? "radial-gradient(circle at 38% 35%, rgba(180,140,255,0.22) 0%, rgba(80,40,180,0.12) 45%, rgba(5,2,18,0.94) 100%)" :
              appState === "speaking" ? "radial-gradient(circle at 38% 35%, rgba(80,230,255,0.25) 0%, rgba(0,130,200,0.15) 45%, rgba(1,10,20,0.94) 100%)" :
              "radial-gradient(circle at 38% 35%, rgba(20,130,180,0.1) 0%, rgba(0,50,80,0.06) 45%, rgba(2,8,16,0.95) 100%)",
            border: `1px solid rgba(${stateColor},${isActive ? 0.55 : 0.18})`,
            boxShadow: isActive
              ? `0 0 80px rgba(${stateColor},0.35), 0 0 30px rgba(${stateColor},0.18) inset, 0 0 120px rgba(${stateColor},0.12)`
              : appState === "thinking"
              ? `0 0 40px rgba(${stateColor},0.2), 0 0 12px rgba(${stateColor},0.08) inset`
              : `0 0 18px rgba(${stateColor},0.08)`,
            cursor: appState === "thinking" ? "not-allowed" : "pointer",
          }}
        >
          <div className="absolute rounded-full pointer-events-none" style={{ width: "32%", height: "18%", top: "16%", left: "19%", background: "radial-gradient(ellipse, rgba(255,255,255,0.09) 0%, transparent 100%)", transform: "rotate(-22deg)" }} />
          <OrbCenter appState={appState} color={stateColor} />
        </button>
      </div>

      <TranscriptPanel
        log={transcriptLog}
        interimText={interimText}
        jarvisText={jarvisText}
        color={stateColor}
      />

      <div className="absolute z-10 flex justify-center px-4" style={{ bottom: "max(0.5rem, calc(env(safe-area-inset-bottom, 0px) + 0.25rem))" }}>
        <BottomIndicator appState={appState} color={stateColor} />
      </div>

      {textFallbackOpen && (
        <TextFallbackModal
          color={stateColor}
          value={textInput}
          onChange={setTextInput}
          onSubmit={submitTextFallback}
          onClose={() => setTextFallbackOpen(false)}
        />
      )}

      <style>{`
        @keyframes jSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes jPing { 0% { transform: scale(1); opacity: 0.6; } 100% { transform: scale(1.55); opacity: 0; } }
        @keyframes jPulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }
        @keyframes jBounce { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
        @keyframes jWave { 0%,100% { transform: scaleY(0.25); } 50% { transform: scaleY(1); } }
        @media (prefers-reduced-motion: reduce) {
          * { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; }
        }
      `}</style>
    </div>
  );
}
