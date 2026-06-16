"use client";

import { useState, useRef, useEffect, useCallback } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

type PermissionState = "idle" | "requesting" | "granted" | "denied" | "error" | "unsupported";
type AppState = "permissions" | "ready" | "listening" | "thinking" | "speaking";
interface Message {
  role: "user" | "assistant";
  content: string;
}

// ─── Platform detection ───────────────────────────────────────────────────────
// iOS Safari/Chrome/Firefox all use WebKit under the hood and share its quirks
// (no SpeechRecognition on iOS Chrome/Firefox, strict audio-gesture rules).

function isIOS() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const iOSDevice = /iPad|iPhone|iPod/.test(ua);
  // iPadOS 13+ reports as "Mac" with touch support — detect that case too.
  const iPadOS13Up = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return iOSDevice || iPadOS13Up;
}

// ─── TTS Hook ─────────────────────────────────────────────────────────────────
// iOS Safari/Chrome require every audio.play() call to be triggered by, or
// directly inside the call stack of, a user gesture the FIRST time — after
// one successful unlocked play() the element can usually be reused freely.

function useTTS() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const unlockedRef = useRef(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // Call this synchronously inside a click/touchend handler to "unlock" audio
  // playback on iOS before any async work happens. Plays a near-silent blip.
  const unlock = useCallback(() => {
    if (unlockedRef.current) return;
    try {
      const a = new Audio();
      // Tiny silent WAV — valid audio, effectively inaudible, very short.
      a.src =
        "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
      a.volume = 0;
      const p = a.play();
      if (p && typeof p.then === "function") {
        p.then(() => { unlockedRef.current = true; }).catch(() => { /* will retry unlock next gesture */ });
      } else {
        unlockedRef.current = true;
      }
    } catch {
      // Ignore — speak() will still try and may simply fail silently on first attempt.
    }
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
      // playsInline-equivalent for <audio> isn't needed, but setting these
      // helps some in-app/Android WebViews route playback correctly.
      audio.setAttribute("playsinline", "true");
      audioRef.current = audio;
      audio.onplay = () => { setIsLoading(false); setIsSpeaking(true); };
      audio.onended = () => { setIsSpeaking(false); audioRef.current = null; setTimeout(() => URL.revokeObjectURL(url), 1000); };
      audio.onerror = () => { setIsSpeaking(false); setIsLoading(false); audioRef.current = null; URL.revokeObjectURL(url); };
      audio.src = url;
      await audio.play();
      unlockedRef.current = true;
    } catch (err) {
      // Most common mobile failure mode: NotAllowedError because this call
      // wasn't inside a user gesture (e.g. it was fired from a setTimeout).
      console.error("[TTS]", err);
      setIsSpeaking(false);
      setIsLoading(false);
    }
  }, []);

  const stop = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = ""; audioRef.current = null; }
    setIsSpeaking(false);
    setIsLoading(false);
  }, []);

  useEffect(() => () => { audioRef.current?.pause(); }, []);
  return { speak, stop, unlock, isSpeaking, isLoading };
}

// ─── STT Hook ─────────────────────────────────────────────────────────────────
// SpeechRecognition is unavailable on iOS Chrome/Firefox and any Firefox
// without the flag enabled. We feature-detect once and expose `supported`
// so the UI can offer a typed-text fallback instead of a dead button.

type AnyRecognition = {
  continuous: boolean; interimResults: boolean; lang: string;
  onstart: (() => void) | null; onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onresult: ((e: { results: { [k: number]: { [k: number]: { transcript: string } } } }) => void) | null;
  start: () => void; stop: () => void; abort: () => void;
};

function getSpeechRecognitionCtor(): (new () => AnyRecognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, new () => AnyRecognition>;
  return w["SpeechRecognition"] || w["webkitSpeechRecognition"] || null;
}

function useSTT(onResult: (text: string) => void) {
  const recognitionRef = useRef<AnyRecognition | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    setSupported(getSpeechRecognitionCtor() !== null);
  }, []);

  const start = useCallback(() => {
    const SR = getSpeechRecognitionCtor();
    if (!SR) {
      setSupported(false);
      return;
    }
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* noop */ }
      recognitionRef.current = null;
    }
    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = "en-US";
    rec.onstart = () => setIsListening(true);
    rec.onend = () => setIsListening(false);
    rec.onerror = (e) => {
      console.error("[STT] error:", e.error);
      setIsListening(false);
    };
    rec.onresult = (e) => {
      const t = e.results[0]?.[0]?.transcript ?? "";
      if (t.trim()) onResult(t.trim());
    };
    recognitionRef.current = rec;
    try {
      rec.start();
    } catch (err) {
      console.error("[STT] start failed:", err);
      setIsListening(false);
    }
  }, [onResult]);

  const stop = useCallback(() => {
    try { recognitionRef.current?.stop(); } catch { /* noop */ }
    setIsListening(false);
  }, []);

  useEffect(() => () => {
    try { recognitionRef.current?.abort(); } catch { /* noop */ }
  }, []);

  return { start, stop, isListening, supported };
}

// ─── Audio Visualizer Canvas ─────────────────────────────────────────────────
// Uses devicePixelRatio-aware sizing so it renders crisply on high-DPI phone
// screens instead of the fixed 500x500 buffer being stretched/blurred by CSS.

function AudioVisualizer({ appState }: { appState: AppState }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const barsRef = useRef<number[]>([]);
  const timeRef = useRef(0);

  const BAR_COUNT = 64;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const safeCtx = ctx; // capture for closure — TypeScript loses narrowing in nested fns

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

    const isActive = appState === "speaking" || appState === "listening";
    const isThinking = appState === "thinking";

    function draw() {
      timeRef.current += 0.03;
      const t = timeRef.current;

      safeCtx.clearRect(0, 0, W, H);

      barsRef.current = barsRef.current.map((v, i) => {
        if (!isActive && !isThinking) {
          const target = 0.04 + 0.06 * Math.sin(t * 0.8 + i * 0.3);
          return v + (target - v) * 0.08;
        }
        if (isThinking) {
          const target = 0.15 + 0.15 * Math.sin(t * 1.2 + i * (Math.PI * 2 / BAR_COUNT) * 3);
          return v + (target - v) * 0.06;
        }
        const bass = i < 8 || i > BAR_COUNT - 9;
        const mid = (i >= 8 && i <= 20) || (i >= BAR_COUNT - 21 && i <= BAR_COUNT - 9);
        let target: number;
        if (bass) {
          target = 0.3 + 0.55 * Math.abs(Math.sin(t * (appState === "speaking" ? 3.2 : 2.4) + i * 0.5))
            + 0.15 * Math.abs(Math.sin(t * 1.7 + i * 0.9));
        } else if (mid) {
          target = 0.2 + 0.35 * Math.abs(Math.sin(t * 2.1 + i * 0.4))
            + 0.1 * Math.abs(Math.sin(t * 3.5 + i * 0.7));
        } else {
          target = 0.05 + 0.25 * Math.abs(Math.sin(t * 1.5 + i * 0.6))
            + 0.05 * Math.abs(Math.sin(t * 4.1 + i));
        }
        if (Math.random() < 0.015 && bass) target = Math.min(target + 0.3, 1.0);
        return v + (target - v) * 0.18;
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
        if (appState === "listening") {
          r = 220 + Math.floor(barH * 35);
          g = 60 + Math.floor(barH * 40);
          b = 60 + Math.floor(barH * 20);
        } else if (appState === "thinking") {
          r = 140 + Math.floor(barH * 60);
          g = 100 + Math.floor(barH * 50);
          b = 240;
        } else {
          r = Math.floor(barH * 80);
          g = 180 + Math.floor(barH * 75);
          b = 255;
        }

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

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
      style={{ pointerEvents: "none" }}
    />
  );
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
      <div className="absolute rounded-full" style={{
        width: "68%", height: "68%",
        border: `1px solid rgba(${color},${alpha})`,
        animationName: "jSpin",
        animationDuration: "22s",
        animationTimingFunction: "linear",
        animationIterationCount: "infinite",
        animationDirection: "normal",
      }}>
        {Array.from({ length: 32 }).map((_, i) => (
          <div key={i} className="absolute" style={{
            width: i % 8 === 0 ? 3 : 1.5,
            height: i % 8 === 0 ? 10 : 5,
            background: i % 8 === 0 ? `rgba(${color},0.6)` : `rgba(${color},0.2)`,
            top: "50%", left: "50%",
            transformOrigin: `1px 84px`,
            transform: `rotate(${i * (360 / 32)}deg) translateY(-84px)`,
          }} />
        ))}
      </div>

      <div className="absolute rounded-full" style={{
        width: "60%", height: "60%",
        border: `1px solid rgba(${color},${alpha * 0.6})`,
        animationName: "jSpin",
        animationDuration: "16s",
        animationTimingFunction: "linear",
        animationIterationCount: "infinite",
        animationDirection: "reverse",
      }}>
        {Array.from({ length: 16 }).map((_, i) => (
          <div key={i} className="absolute rounded-full" style={{
            width: 3, height: 3,
            background: `rgba(${color},0.4)`,
            top: "50%", left: "50%",
            transformOrigin: "1.5px 74px",
            transform: `rotate(${i * (360 / 16)}deg) translateY(-74px)`,
          }} />
        ))}
      </div>

      <div className="absolute rounded-full" style={{
        width: "52%", height: "52%",
        border: `1px solid rgba(${color},${alpha * 0.4})`,
        animationName: "jSpin",
        animationDuration: "9s",
        animationTimingFunction: "linear",
        animationIterationCount: "infinite",
        animationDirection: "normal",
      }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="absolute" style={{
            width: 1, height: 14,
            background: `rgba(${color},0.5)`,
            top: "50%", left: "50%",
            transformOrigin: "0.5px 64px",
            transform: `rotate(${i * 60}deg) translateY(-64px)`,
          }} />
        ))}
      </div>

      <div className="absolute rounded-full" style={{
        width: "44%", height: "44%",
        border: `1px solid rgba(${color},0.06)`,
        boxShadow: `0 0 ${appState === "speaking" ? 30 : 10}px rgba(${color},0.1)`,
      }} />
    </>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function JarvisPage() {
  const [appState, setAppState] = useState<AppState>("permissions");
  const [jarvisText, setJarvisText] = useState("Systems online. How can I assist you today, sir?");
  const [messages, setMessages] = useState<Message[]>([]);
  const [textFallbackOpen, setTextFallbackOpen] = useState(false);
  const [textInput, setTextInput] = useState("");

  const [locStatus, setLocStatus] = useState<PermissionState>("idle");
  const [micStatus, setMicStatus] = useState<PermissionState>("idle");
  const [camStatus, setCamStatus] = useState<PermissionState>("idle");

  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [weather, setWeather] = useState<{ temperature: number; description: string; units: { temperature: string } } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<Message[]>([]);
  const coordsRef = useRef<{ lat: number; lon: number } | null>(null);
  const weatherRef = useRef<{ temperature: number; description: string; units: { temperature: string } } | null>(null);
  const locRef = useRef<PermissionState>("idle");
  const micRef = useRef<PermissionState>("idle");
  const camRef = useRef<PermissionState>("idle");
  // Guards against the synthetic click that fires right after touchend on
  // mobile browsers, which would otherwise call the orb handler twice.
  const lastPointerActionRef = useRef(0);

  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { coordsRef.current = coords; }, [coords]);
  useEffect(() => { weatherRef.current = weather; }, [weather]);
  useEffect(() => { locRef.current = locStatus; }, [locStatus]);
  useEffect(() => { micRef.current = micStatus; }, [micStatus]);
  useEffect(() => { camRef.current = camStatus; }, [camStatus]);

  const { speak, stop: stopTTS, unlock: unlockAudio, isSpeaking, isLoading: ttsLoading } = useTTS();

  // Camera is optional/cosmetic for this build — only mic + location are
  // required to operate the assistant. Gating on camera meant any user who
  // denies it (or whose device doesn't expose one) got stuck forever.
  const allGranted = locStatus === "granted" && micStatus === "granted";

  const handleVoiceInput = useCallback(async (text: string) => {
    if (!text.trim()) return;
    stopTTS();
    setAppState("thinking");

    const context = [
      coordsRef.current ? `[LOCATION: GPS ${coordsRef.current.lat.toFixed(5)}, ${coordsRef.current.lon.toFixed(5)}]` : "",
      weatherRef.current ? `[WEATHER: ${weatherRef.current.description} | ${weatherRef.current.temperature}${weatherRef.current.units.temperature}]` : "",
      `[PERMISSIONS: location=${locRef.current}, microphone=${micRef.current}, camera=${camRef.current}]`,
      "[SYSTEM: Answer confidently using sensor data above. Never claim you lack access.]",
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
      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
      await speak(reply);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      const errMsg = "Systems experiencing interference, sir. Please repeat your query.";
      setJarvisText(errMsg);
      await speak(errMsg);
    } finally {
      setAppState("ready");
    }
  }, [speak, stopTTS]);

  const { start: startSTT, stop: stopSTT, isListening, supported: sttSupported } = useSTT(handleVoiceInput);

  useEffect(() => {
    if (appState === "thinking") return;
    if (ttsLoading || isSpeaking) { setAppState("speaking"); return; }
    if (isListening) { setAppState("listening"); return; }
    if (appState === "speaking" || appState === "listening") setAppState("ready");
  }, [isSpeaking, ttsLoading, isListening]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (allGranted && appState === "permissions") {
      setAppState("ready");
      // NOTE: this won't reliably play on iOS because it's not inside the
      // gesture call stack — the unlock() call fired synchronously inside
      // the INITIALIZE button press (see requestAll) handles that instead.
      // We still attempt it for desktop browsers where it works fine.
      setTimeout(() => speak(jarvisText), 800);
    }
  }, [allGranted]); // eslint-disable-line react-hooks/exhaustive-deps

  const requestAll = useCallback(async () => {
    // Unlock audio synchronously, inside this user-gesture handler, before
    // any awaited/async permission prompts run. This is the one moment on
    // iOS we're guaranteed a real user gesture is on the call stack.
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
          } catch { /* non-blocking */ }
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
      a.getTracks().forEach((t) => t.stop());
      setMicStatus("granted");
    } catch {
      setMicStatus("denied");
    }

    // Camera is requested separately and never blocks the app from
    // becoming usable — some users don't have one, and on Android Chrome a
    // combined audio+video prompt that's partially denied can leave both
    // permissions stuck in a confusing state.
    setCamStatus("requesting");
    try {
      const v = await navigator.mediaDevices.getUserMedia({ video: true });
      v.getTracks().forEach((t) => t.stop());
      setCamStatus("granted");
    } catch {
      setCamStatus("denied");
    }
  }, [unlockAudio]);

  // Single source of truth for "activate the orb" so click (desktop mouse),
  // touch (iOS/Android browsers), and pointer events never double-fire or
  // disagree about the current state.
  const activateOrb = useCallback(() => {
    if (!allGranted) return;
    if (appState === "listening") { stopSTT(); return; }
    if (appState === "speaking") { stopTTS(); return; }
    if (appState === "thinking") { abortRef.current?.abort(); setAppState("ready"); return; }
    if (appState === "ready") {
      if (!sttSupported) { setTextFallbackOpen(true); return; }
      startSTT();
    }
  }, [appState, allGranted, sttSupported, startSTT, stopSTT, stopTTS]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    lastPointerActionRef.current = Date.now();
    activateOrb();
  }, [activateOrb]);

  const handleClick = useCallback(() => {
    // Suppress the synthetic click mobile browsers fire ~after pointerup;
    // only handle real mouse clicks here (no recent pointer activation).
    if (Date.now() - lastPointerActionRef.current < 700) return;
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

      <div className="absolute top-[max(1.5rem,env(safe-area-inset-top))] left-0 right-0 flex flex-col items-center gap-1 z-10 px-4">
        <div className="flex items-center gap-3 sm:gap-4">
          <div className="h-px w-12 sm:w-20" style={{ background: `linear-gradient(to right, transparent, rgba(${stateColor},0.4))` }} />
          <span className="text-[9px] sm:text-[11px] tracking-[0.5em] sm:tracking-[0.6em] whitespace-nowrap" style={{ color: `rgba(${stateColor},0.55)` }}>J · A · R · V · I · S</span>
          <div className="h-px w-12 sm:w-20" style={{ background: `linear-gradient(to left, transparent, rgba(${stateColor},0.4))` }} />
        </div>
        <span className="text-[6px] sm:text-[7px] tracking-[0.3em] sm:tracking-[0.35em] text-center" style={{ color: `rgba(${stateColor},0.2)` }}>STARK INDUSTRIES · AUTONOMOUS INTELLIGENCE</span>
      </div>

      <div className="absolute z-10" style={{ top: "max(5.5rem, calc(env(safe-area-inset-top) + 4.5rem))" }}>
        <StateDot state={appState} color={stateColor} />
      </div>

      {weather && (
        <div className="absolute z-10 flex flex-col items-end gap-0.5" style={{ top: "max(1.5rem, env(safe-area-inset-top))", right: "max(1rem, env(safe-area-inset-right))" }}>
          <span className="text-[11px] font-light" style={{ color: `rgba(${stateColor},0.5)` }}>
            {weather.temperature}{weather.units.temperature}
          </span>
          <div className="flex gap-[2px]">
            {[3, 5, 4, 6, 3].map((h, i) => (
              <div key={i} style={{ width: 2, height: h, background: `rgba(${stateColor},0.25)`, borderRadius: 1 }} />
            ))}
          </div>
        </div>
      )}

      {!sttSupported && (
        <div className="absolute z-10 px-3 py-1 rounded-sm text-[7px] tracking-[0.2em]" style={{
          top: "max(8.5rem, calc(env(safe-area-inset-top) + 7.5rem))",
          border: `1px solid rgba(${stateColor},0.2)`,
          color: `rgba(${stateColor},0.5)`,
          background: "rgba(3,10,16,0.7)",
        }}>
          VOICE INPUT UNAVAILABLE · TAP TO TYPE
        </div>
      )}

      {/* MAIN ORB AREA — fluid, viewport-aware sizing instead of a fixed 500px box */}
      <div
        className="relative z-10 flex items-center justify-center"
        style={{
          width: "min(85vw, 420px)",
          height: "min(85vw, 420px)",
          maxWidth: "min(85vh, 420px)",
          maxHeight: "min(85vh, 420px)",
        }}
      >
        <AudioVisualizer appState={appState} />
        <ArcReactorRings appState={appState} />

        {isActive && (
          <>
            <div className="absolute rounded-full" style={{
              width: "76%", height: "76%",
              border: `1px solid rgba(${stateColor},0.15)`,
              animationName: "jPing",
              animationDuration: "2.2s",
              animationTimingFunction: "ease-out",
              animationIterationCount: "infinite",
            }} />
            <div className="absolute rounded-full" style={{
              width: "76%", height: "76%",
              border: `1px solid rgba(${stateColor},0.1)`,
              animationName: "jPing",
              animationDuration: "2.2s",
              animationTimingFunction: "ease-out",
              animationIterationCount: "infinite",
              animationDelay: "0.8s",
            }} />
          </>
        )}

        <button
          type="button"
          onPointerUp={handlePointerUp}
          onClick={handleClick}
          disabled={appState === "thinking"}
          aria-label={
            appState === "listening" ? "Stop listening" :
            appState === "speaking" ? "Stop speaking" :
            appState === "thinking" ? "Processing" : "Start voice input"
          }
          className="absolute rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 transition-all duration-700"
          style={{
            width: "36%",
            height: "36%",
            minWidth: 120,
            minHeight: 120,
            outlineColor: `rgba(${stateColor},0.6)`,
            WebkitTapHighlightColor: "transparent",
            touchAction: "manipulation",
            background:
              appState === "listening"
                ? "radial-gradient(circle at 38% 35%, rgba(255,100,100,0.28) 0%, rgba(160,30,30,0.18) 45%, rgba(25,4,4,0.94) 100%)"
                : appState === "thinking"
                ? "radial-gradient(circle at 38% 35%, rgba(180,140,255,0.22) 0%, rgba(80,40,180,0.12) 45%, rgba(5,2,18,0.94) 100%)"
                : appState === "speaking"
                ? "radial-gradient(circle at 38% 35%, rgba(80,230,255,0.25) 0%, rgba(0,130,200,0.15) 45%, rgba(1,10,20,0.94) 100%)"
                : "radial-gradient(circle at 38% 35%, rgba(20,130,180,0.1) 0%, rgba(0,50,80,0.06) 45%, rgba(2,8,16,0.95) 100%)",
            border: `1px solid rgba(${stateColor},${isActive ? 0.55 : 0.18})`,
            boxShadow: isActive
              ? `0 0 80px rgba(${stateColor},0.35), 0 0 30px rgba(${stateColor},0.18) inset, 0 0 120px rgba(${stateColor},0.12)`
              : appState === "thinking"
              ? `0 0 40px rgba(${stateColor},0.2), 0 0 12px rgba(${stateColor},0.08) inset`
              : `0 0 18px rgba(${stateColor},0.08)`,
            cursor: appState === "thinking" ? "not-allowed" : "pointer",
          }}
        >
          <div className="absolute rounded-full pointer-events-none" style={{
            width: "32%", height: "18%", top: "16%", left: "19%",
            background: "radial-gradient(ellipse, rgba(255,255,255,0.09) 0%, transparent 100%)",
            transform: "rotate(-22deg)",
          }} />

          <OrbCenter appState={appState} color={stateColor} />
        </button>
      </div>

      <div className="absolute z-10 flex justify-center px-4" style={{ bottom: "max(2rem, calc(env(safe-area-inset-bottom) + 1rem))" }}>
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
        @keyframes jBounce {
          0%,100% { transform: translateY(0); }
          50% { transform: translateY(-6px); }
        }
        @keyframes jWave {
          0%,100% { transform: scaleY(0.25); }
          50% { transform: scaleY(1); }
        }
        @media (prefers-reduced-motion: reduce) {
          * { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; }
        }
      `}</style>
    </div>
  );
}

// ─── Text Fallback Modal (for browsers without SpeechRecognition) ────────────

function TextFallbackModal({ color, value, onChange, onSubmit, onClose }: {
  color: string; value: string; onChange: (v: string) => void; onSubmit: () => void; onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      style={{ background: "rgba(2,6,9,0.75)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-md p-4 flex flex-col gap-3"
        style={{ background: "#040b10", border: `1px solid rgba(${color},0.25)` }}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="text-[8px] tracking-[0.3em]" style={{ color: `rgba(${color},0.6)` }}>TYPE YOUR QUERY</span>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onSubmit(); }}
          className="w-full rounded-sm px-3 py-2.5 text-sm bg-transparent outline-none"
          style={{ border: `1px solid rgba(${color},0.3)`, color: `rgba(${color},0.9)` }}
          placeholder="Ask J.A.R.V.I.S. anything…"
          autoComplete="off"
          autoCapitalize="sentences"
        />
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-sm text-[9px] tracking-[0.25em]"
            style={{ border: `1px solid rgba(${color},0.15)`, color: `rgba(${color},0.5)` }}
          >
            CANCEL
          </button>
          <button
            onClick={onSubmit}
            className="flex-1 py-2.5 rounded-sm text-[9px] tracking-[0.25em]"
            style={{ border: `1px solid rgba(${color},0.4)`, color: `rgba(${color},0.9)`, background: `rgba(${color},0.08)` }}
          >
            SEND
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Orb Center ───────────────────────────────────────────────────────────────

function OrbCenter({ appState, color }: { appState: AppState; color: string }) {
  if (appState === "thinking") {
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="relative w-12 h-12">
          {[0, 120, 240].map((deg, i) => (
            <div key={i} className="absolute inset-0 flex items-center justify-center" style={{
              animationName: "jSpin",
              animationDuration: `${1.8 + i * 0.15}s`,
              animationTimingFunction: "linear",
              animationIterationCount: "infinite",
              animationDirection: i % 2 === 0 ? "normal" : "reverse",
            }}>
              <div className="absolute rounded-full" style={{
                width: 7, height: 7,
                background: `rgba(${color},0.85)`,
                boxShadow: `0 0 10px rgba(${color},0.8)`,
                transform: `rotate(${deg}deg) translateX(18px)`,
              }} />
            </div>
          ))}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="rounded-full" style={{
              width: 6, height: 6,
              background: `rgba(${color},0.5)`,
              boxShadow: `0 0 8px rgba(${color},0.6)`,
            }} />
          </div>
        </div>
      </div>
    );
  }

  if (appState === "listening" || appState === "speaking") {
    const heights = appState === "listening"
      ? [5, 12, 9, 18, 8, 14, 9, 18, 8, 12, 5]
      : [6, 14, 10, 20, 14, 24, 14, 20, 10, 14, 6];

    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="flex items-center gap-[2.5px]">
          {heights.map((h, i) => (
            <div key={i} style={{
              width: 3,
              height: h,
              background: `rgba(${color},0.85)`,
              borderRadius: 2,
              boxShadow: `0 0 6px rgba(${color},0.7)`,
              animationName: "jWave",
              animationDuration: appState === "listening" ? "0.65s" : "0.5s",
              animationTimingFunction: "ease-in-out",
              animationIterationCount: "infinite",
              animationDelay: `${i * 55}ms`,
            }} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={`rgba(${color},0.4)`} strokeWidth="1.5" strokeLinecap="round">
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path d="M5 10a7 7 0 0 0 14 0" />
        <line x1="12" y1="19" x2="12" y2="22" />
        <line x1="9" y1="22" x2="15" y2="22" />
      </svg>
    </div>
  );
}

// ─── State Dot ────────────────────────────────────────────────────────────────

function StateDot({ state, color }: { state: AppState; color: string }) {
  const isActive = state !== "ready";
  return (
    <div className="flex items-center gap-2">
      <div style={{
        width: 6, height: 6,
        borderRadius: "50%",
        background: `rgba(${color},0.9)`,
        boxShadow: `0 0 8px 3px rgba(${color},0.5)`,
        animationName: isActive ? "jPulse" : "none",
        animationDuration: "1.4s",
        animationTimingFunction: "ease-in-out",
        animationIterationCount: "infinite",
      }} />
      <div className="flex gap-1">
        {[1, 1, 0.5, 0.3].map((o, i) => (
          <div key={i} style={{ width: 6, height: 1, background: `rgba(${color},${o * 0.4})`, borderRadius: 1 }} />
        ))}
      </div>
    </div>
  );
}

// ─── Bottom Indicator ─────────────────────────────────────────────────────────

function BottomIndicator({ appState, color }: { appState: AppState; color: string }) {
  if (appState === "ready") {
    return (
      <div className="flex flex-col items-center gap-2">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <circle cx="10" cy="10" r="8" stroke={`rgba(${color},0.2)`} strokeWidth="1" />
          <circle cx="10" cy="10" r="4" stroke={`rgba(${color},0.3)`} strokeWidth="1" />
          <circle cx="10" cy="10" r="1.5" fill={`rgba(${color},0.5)`} />
        </svg>
        <div className="flex gap-1">
          {[4, 6, 4].map((w, i) => <div key={i} style={{ width: w, height: 1, background: `rgba(${color},0.2)`, borderRadius: 1 }} />)}
        </div>
      </div>
    );
  }
  if (appState === "listening") {
    return (
      <svg width="24" height="16" viewBox="0 0 24 16" fill="none">
        {[0, 1, 2, 3].map((i) => (
          <rect key={i} x={i * 6} y={4 + i % 2 * 2} width="3" height={8 - i % 2 * 4} rx="1.5"
            fill={`rgba(${color},0.4)`} style={{
              animationName: "jWave", animationDuration: "0.7s", animationTimingFunction: "ease-in-out",
              animationIterationCount: "infinite", animationDelay: `${i * 80}ms`,
            }} />
        ))}
      </svg>
    );
  }
  if (appState === "speaking") {
    return (
      <svg width="22" height="18" viewBox="0 0 22 18" fill="none" style={{ opacity: 0.5 }}>
        <path d="M3 6H1v6h2l5 4V2L3 6z" fill={`rgba(${color},0.4)`} />
        <path d="M11 5a5 5 0 0 1 0 8" stroke={`rgba(${color},0.4)`} strokeWidth="1.5" strokeLinecap="round" fill="none" style={{
          animationName: "jPulse", animationDuration: "1.2s", animationTimingFunction: "ease-in-out", animationIterationCount: "infinite",
        }} />
      </svg>
    );
  }
  if (appState === "thinking") {
    return (
      <div className="flex gap-2">
        {[0, 200, 400].map((d, i) => (
          <div key={i} className="rounded-full" style={{
            width: 5, height: 5,
            background: `rgba(${color},0.5)`,
            animationName: "jBounce", animationDuration: "0.9s", animationTimingFunction: "ease-in-out",
            animationIterationCount: "infinite", animationDelay: `${d}ms`,
          }} />
        ))}
      </div>
    );
  }
  return null;
}

// ─── HUD Corner Brackets ──────────────────────────────────────────────────────

function HudCorners({ color }: { color: string }) {
  const size = 28;
  const thickness = 1.5;
  const c = `rgba(${color},0.2)`;
  const corners = [
    { top: 0, left: 0, borderTop: thickness, borderLeft: thickness },
    { top: 0, right: 0, borderTop: thickness, borderRight: thickness },
    { bottom: 0, left: 0, borderBottom: thickness, borderLeft: thickness },
    { bottom: 0, right: 0, borderBottom: thickness, borderRight: thickness },
  ];
  return (
    <>
      {corners.map((style, i) => (
        <div key={i} className="absolute z-20" style={{
          ...Object.fromEntries(Object.entries(style).map(([k, v]) => [k, typeof v === "number" ? (k.startsWith("border") ? `${v}px solid ${c}` : v) : v])),
          width: size, height: size,
          margin: "max(0.75rem, env(safe-area-inset-top))",
        }} />
      ))}
    </>
  );
}

// ─── Permissions Screen ───────────────────────────────────────────────────────

function PermissionsScreen({ locStatus, micStatus, camStatus, onRequest }: {
  locStatus: PermissionState; micStatus: PermissionState; camStatus: PermissionState; onRequest: () => void;
}) {
  const items = [
    { label: "LOCATION", status: locStatus, required: true },
    { label: "MICROPHONE", status: micStatus, required: true },
    { label: "CAMERA", status: camStatus, required: false },
  ];
  const anyRequesting = items.some((i) => i.status === "requesting");
  const requiredDenied = items.some((i) => i.required && (i.status === "denied" || i.status === "error" || i.status === "unsupported"));

  return (
    <div className="min-h-[100dvh] bg-[#020609] flex flex-col items-center justify-center font-mono relative overflow-hidden">
      <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse at 50% 40%, #041420 0%, #020609 70%)" }} />
      <div className="absolute inset-0 opacity-[0.03]" style={{
        backgroundImage: "linear-gradient(#00d4ff 1px,transparent 1px),linear-gradient(90deg,#00d4ff 1px,transparent 1px)",
        backgroundSize: "60px 60px",
      }} />
      <HudCorners color="0,180,220" />

      <div className="relative z-10 flex flex-col items-center gap-6 sm:gap-8 px-6 sm:px-8 max-w-sm w-full py-8" style={{ paddingTop: "max(2rem, env(safe-area-inset-top))", paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}>
        <div className="flex flex-col items-center gap-2">
          <div className="flex items-center gap-3">
            <div className="h-px w-14" style={{ background: "linear-gradient(to right, transparent, rgba(0,212,255,0.4))" }} />
            <span className="text-[11px] sm:text-[12px] tracking-[0.5em] sm:tracking-[0.55em]" style={{ color: "rgba(0,212,255,0.65)" }}>J · A · R · V · I · S</span>
            <div className="h-px w-14" style={{ background: "linear-gradient(to left, transparent, rgba(0,212,255,0.4))" }} />
          </div>
          <span className="text-[7px] tracking-[0.3em] text-center" style={{ color: "rgba(0,180,220,0.25)" }}>STARK INDUSTRIES · AUTONOMOUS INTELLIGENCE</span>
        </div>

        <div className="relative flex items-center justify-center" style={{ width: "min(50vw, 200px)", height: "min(50vw, 200px)" }}>
          {[200, 160, 120].map((s, i) => (
            <div key={i} className="absolute rounded-full" style={{
              width: `${(s / 200) * 100}%`, height: `${(s / 200) * 100}%`,
              border: `1px solid rgba(0,212,255,${0.06 - i * 0.015})`,
              animationName: "jSpin",
              animationDuration: `${20 + i * 8}s`,
              animationTimingFunction: "linear",
              animationIterationCount: "infinite",
              animationDirection: i % 2 === 0 ? "normal" : "reverse",
            }} />
          ))}
          <div className="rounded-full flex items-center justify-center" style={{
            width: "45%", height: "45%",
            background: "radial-gradient(circle at 38% 35%, rgba(15,50,70,0.25) 0%, rgba(2,8,15,0.96) 100%)",
            border: "1px solid rgba(0,212,255,0.1)",
            boxShadow: "0 0 30px rgba(0,212,255,0.08)",
          }}>
            <div className="rounded-full" style={{
              width: 18, height: 18,
              background: "rgba(0,212,255,0.12)",
              border: "1px solid rgba(0,212,255,0.2)",
              boxShadow: "0 0 12px rgba(0,212,255,0.2)",
              animationName: "jPulse",
              animationDuration: "2.5s",
              animationTimingFunction: "ease-in-out",
              animationIterationCount: "infinite",
            }} />
          </div>
        </div>

        <div className="w-full flex flex-col gap-2.5">
          {items.map(({ label, status, required }) => {
            const dotColor = status === "granted" ? "74,201,138" : (status === "denied" || status === "unsupported") ? "224,85,85" : status === "requesting" ? "245,166,35" : "30,60,80";
            return (
              <div key={label} className="flex items-center justify-between px-4 py-3 rounded-sm" style={{
                border: "1px solid rgba(10,26,39,0.9)",
                background: "rgba(3,10,16,0.85)",
              }}>
                <span className="text-[8px] tracking-[0.3em]" style={{ color: "rgba(0,180,220,0.5)" }}>
                  {label}{!required && <span style={{ opacity: 0.5 }}> · OPTIONAL</span>}
                </span>
                <div className="flex items-center gap-2">
                  <div style={{
                    width: 6, height: 6, borderRadius: "50%",
                    background: `rgba(${dotColor},0.9)`,
                    boxShadow: status === "granted" || status === "denied" ? `0 0 7px 2px rgba(${dotColor},0.5)` : "none",
                    animationName: status === "requesting" ? "jPulse" : "none",
                    animationDuration: "1s",
                    animationTimingFunction: "ease-in-out",
                    animationIterationCount: "infinite",
                  }} />
                  <span className="text-[7px] tracking-[0.25em]" style={{ color: `rgba(${dotColor},0.7)` }}>
                    {status === "granted" ? "ONLINE" : status === "denied" ? "DENIED" : status === "unsupported" ? "N/A" : status === "requesting" ? "INIT" : "OFFLINE"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {requiredDenied ? (
          <div className="w-full flex flex-col items-center gap-3">
            <div className="flex gap-1">
              {[6, 4, 6].map((w, i) => <div key={i} style={{ width: w, height: 1, background: "rgba(224,85,85,0.4)", borderRadius: 1 }} />)}
            </div>
            <span className="text-[7px] tracking-[0.2em] text-center" style={{ color: "rgba(224,85,85,0.6)" }}>
              ENABLE LOCATION &amp; MICROPHONE IN BROWSER SETTINGS
            </span>
            <button onClick={onRequest} className="px-8 py-2.5 rounded-sm transition-all active:scale-[0.98]" style={{
              border: "1px solid rgba(224,85,85,0.3)",
              color: "rgba(224,85,85,0.65)",
              fontSize: "9px",
              letterSpacing: "0.25em",
              background: "rgba(224,85,85,0.04)",
              touchAction: "manipulation",
              WebkitTapHighlightColor: "transparent",
            }}>RETRY</button>
          </div>
        ) : (
          <button
            onClick={onRequest}
            disabled={anyRequesting}
            className="w-full py-3.5 rounded-sm transition-all active:scale-[0.98]"
            style={{
              border: "1px solid rgba(0,212,255,0.22)",
              background: "rgba(0,212,255,0.04)",
              color: "rgba(0,212,255,0.65)",
              fontSize: "9px",
              letterSpacing: "0.35em",
              opacity: anyRequesting ? 0.45 : 1,
              cursor: anyRequesting ? "not-allowed" : "pointer",
              touchAction: "manipulation",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            {anyRequesting ? "INITIALIZING…" : "INITIALIZE J.A.R.V.I.S."}
          </button>
        )}
      </div>

      <style>{`
        @keyframes jSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes jPulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }
        @keyframes jWave { 0%,100% { transform: scaleY(0.25); } 50% { transform: scaleY(1); } }
        @keyframes jBounce { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
        @keyframes jPing { 0% { transform: scale(1); opacity: 0.5; } 100% { transform: scale(1.6); opacity: 0; } }
        @media (prefers-reduced-motion: reduce) {
          * { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; }
        }
      `}</style>
    </div>
  );
}