import { useState, useRef, useEffect, useCallback } from "react";

// ---------------------------------------------------------------------------
//  Morse tables
// ---------------------------------------------------------------------------
const MORSE: Record<string, string> = {
  A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.", H: "....",
  I: "..", J: ".---", K: "-.-", L: ".-..", M: "--", N: "-.", O: "---", P: ".--.",
  Q: "--.-", R: ".-.", S: "...", T: "-", U: "..-", V: "...-", W: ".--", X: "-..-",
  Y: "-.--", Z: "--..", "0": "-----", "1": ".----", "2": "..---", "3": "...--",
  "4": "....-", "5": ".....", "6": "-....", "7": "--...", "8": "---..", "9": "----.",
  "?": "..--..", "/": "-..-.", "&": ".-...", ":": "---...", "-": "-....-",
  ".": ".-.-.-", ",": "--..--", "'": ".----.", "!": "-.-.--", "@": ".--.-.",
};
const MORSE_REV: Record<string, string> = Object.fromEntries(
  Object.entries(MORSE).map(([k, v]) => [v, k]),
);

// ---------------------------------------------------------------------------
//  Timing — everything derives from one unit (the dit length in ms)
//  BPM = 60000 / unit  (one beat = one dit)
// ---------------------------------------------------------------------------
const DEFAULT_UNIT = 160; // ms per dit -> 375 BPM
interface Timing { ditDah: number; letterGap: number; wordGap: number }
const timingFromUnit = (u: number): Timing => ({
  ditDah: u,          // hold shorter than this -> dit
  letterGap: u * 1.6, // pause that ends a letter
  wordGap: u * 7,     // pause that ends a word (standard: 7 units)
});
const MSG_FLUSH_MS = 3000;  // idle time before accumulated message is sent
const CAL_TAPS_NEEDED = 8;  // dits to sample during calibration

interface Line {
  kind: "msg" | "event";
  nick?: string;
  text?: string;
  self?: boolean;
  signals?: { on: boolean; ts: number }[];
}

interface Training {
  target: string;
  score: number;
  streak: number;
  feedback: string;
}

// ---------------------------------------------------------------------------
//  MorseDecoder — timing -> text, per-instance timing (calibratable)
// ---------------------------------------------------------------------------
class MorseDecoder {
  out: (t: string) => void;
  onBuffer: (b: string) => void;
  onGap: (kind: "letter" | "word") => void;
  buf: string[];
  lastUp: number;
  lastDown: number | null;
  wordTimer: ReturnType<typeof setTimeout> | null;
  timing: Timing;

  constructor(out: (t: string) => void, onBuffer: (b: string) => void, timing?: Timing, onGap?: (kind: "letter" | "word") => void) {
    this.out = out;
    this.onBuffer = onBuffer || (() => {});
    this.onGap = onGap || (() => {});
    this.buf = [];
    this.lastUp = 0;
    this.lastDown = null;
    this.wordTimer = null;
    this.timing = timing || timingFromUnit(DEFAULT_UNIT);
  }

  setTiming(t: Timing) { this.timing = t; }

  emitBuf() { this.onBuffer(this.buf.join(" ")); }

  flushLetter() {
    if (this.buf.length === 0) return;
    const code = this.buf.join("");
    this.buf = [];
    this.out(MORSE_REV[code] || `<${code}>`);
    this.emitBuf();
  }
  element(holdMs: number) { this.buf.push(holdMs < this.timing.ditDah ? "." : "-"); this.emitBuf(); }

  feed(on: boolean, ts: number) {
    if (this.wordTimer) { clearTimeout(this.wordTimer); this.wordTimer = null; }
    if (on) {
      if (this.lastUp > 0) {
        const gap = ts - this.lastUp;
        if (gap >= this.timing.wordGap) { this.flushLetter(); this.out(" "); this.onGap("word"); }
        else if (gap >= this.timing.letterGap) { this.flushLetter(); this.onGap("letter"); }
      }
      this.lastDown = ts;
      this.lastUp = 0;
    } else {
      // classify the element from the hold time (dit or dah) — works for local
      // and remote feeds alike, since both see key-down and key-up timestamps
      if (this.lastDown !== null) this.element(ts - this.lastDown);
      this.lastDown = null;
      this.lastUp = ts;
      // fire the word gap the moment the pause crosses wordGap (when the meter is full)
      this.wordTimer = setTimeout(() => {
        this.wordTimer = null;
        this.flushLetter();
        this.out(" ");
        this.onGap("word");
        this.lastUp = 0; // gap consumed — next key-down starts a fresh letter
      }, this.timing.wordGap);
    }
  }

  reset() {
    this.buf = [];
    this.lastUp = 0;
    this.lastDown = null;
    if (this.wordTimer) { clearTimeout(this.wordTimer); this.wordTimer = null; }
    this.emitBuf();
  }
}

// ---------------------------------------------------------------------------
//  App
// ---------------------------------------------------------------------------
export default function App() {
  // connection setup — default to the host that served the page (same-origin WebSocket)
  const [wsUrl, setWsUrl] = useState(() => {
    try {
      if (typeof window !== "undefined" && window.location && window.location.host && !window.location.host.includes("localhost")) {
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        return `${proto}//${window.location.host}/ws`;
      }
    } catch {}
    return "ws://localhost:7002";
  });
  const [nick, setNick] = useState("anon");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);

  // chat state
  const [room, setRoom] = useState<string | null>(null);
  const [roomInput, setRoomInput] = useState("lobby");
  const [lines, setLines] = useState<Line[]>([]);
  const [rooms, setRooms] = useState<string[]>([]);
  const [presence, setPresence] = useState<string[]>([]);
  const [scratchpad, setScratchpad] = useState(false);
  const [showTable, setShowTable] = useState(false);
  const [passInput, setPassInput] = useState("");
  const [mobileMode, setMobileMode] = useState(
    typeof window !== "undefined" && /Mobi|Android|iPhone|iPad|iPod/i.test(window.navigator.userAgent)
  );

  // morse input
  const [keying, setKeying] = useState(false);
  const [localBuf, setLocalBuf] = useState("");
  const [remoteBufs, setRemoteBufs] = useState<Record<string, string>>({});
  const keyingRef = useRef(false);
  const keyDownAtRef = useRef(0);
  const decRef = useRef<MorseDecoder | null>(null);
  const remoteDecodersRef = useRef(new Map<string, MorseDecoder>());

  // pause feedback: flash badge on detected gaps + live pause meter
  const [gapFlash, setGapFlash] = useState<{ kind: "letter" | "word"; id: number } | null>(null);
  const gapFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pauseMs, setPauseMs] = useState(0);                  // ms since key-up (0 while keying)
  const [meterStarted, setMeterStarted] = useState(false);      // row stays mounted after first key-up
  const pauseRafRef = useRef<number | null>(null);
  const keyUpAtRef = useRef<number | null>(null);

  const flashGap = useCallback((kind: "letter" | "word") => {
    if (gapFlashTimerRef.current) clearTimeout(gapFlashTimerRef.current);
    setGapFlash({ kind, id: Date.now() });
    gapFlashTimerRef.current = setTimeout(() => {
      setGapFlash(null);
      gapFlashTimerRef.current = null;
    }, kind === "word" ? 900 : 500);
  }, []);

  // audio — shared context, two independent beep channels (local + remote)
  const audioCtxRef = useRef<AudioContext | null>(null);
  const ensureAudioCtx = (): AudioContext | null => {
    if (!audioCtxRef.current) {
      try {
        const Ctor = window.AudioContext || (window as any).webkitAudioContext;
        if (!Ctor) return null;
        audioCtxRef.current = new Ctor();
      } catch { return null; }
    }
    if (audioCtxRef.current.state === "suspended") audioCtxRef.current.resume().catch(() => {});
    return audioCtxRef.current;
  };
  const makeBeep = (freq: number) => {
    let osc: OscillatorNode | null = null, gain: GainNode | null = null;
    return (on: boolean) => {
      const ctx = ensureAudioCtx(); if (!ctx) return;
      if (on) {
        if (osc) return;
        osc = ctx.createOscillator(); gain = ctx.createGain();
        osc.type = "sine"; osc.frequency.value = freq;
        gain.gain.value = 0;
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start();
        gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.005);
      } else {
        if (gain) gain.gain.linearRampToValueAtTime(0.0, ctx.currentTime + 0.01);
        if (osc) { osc.stop(ctx.currentTime + 0.02); osc = null; }
        gain = null;
      }
    };
  };
  const localBeepRef = useRef<((on: boolean) => void) | null>(null);  // 600 Hz — your own keying
  const remoteBeepRef = useRef<((on: boolean) => void) | null>(null); // 700 Hz — remote keying
  if (!localBeepRef.current) localBeepRef.current = makeBeep(600);
  if (!remoteBeepRef.current) remoteBeepRef.current = makeBeep(700);

  // refs for global handlers
  const roomRef = useRef<string | null>(null);
  useEffect(() => { roomRef.current = room; }, [room]);
  const savedPassesRef = useRef<Record<string, string>>({}); // room -> password, for re-joins
  const scratchpadRef = useRef(false);
  useEffect(() => { scratchpadRef.current = scratchpad; }, [scratchpad]);

  // ---- training mode (scratchpad only) ----
  const [training, setTraining] = useState<Training | null>(null);
  const trainingRef = useRef<Training | null>(null);
  useEffect(() => { trainingRef.current = training; }, [training]);
  const randChar = () => {
    const keys = Object.keys(MORSE).filter((k) => /^[A-Z0-9]$/.test(k));
    return keys[Math.floor(Math.random() * keys.length)];
  };
  const startTraining = useCallback(() => {
    setTraining({ target: randChar(), score: 0, streak: 0, feedback: "" });
  }, []);
  const stopTraining = useCallback(() => setTraining(null), []);
  const handleTrainingLetter = useCallback((t: string) => {
    const tr = trainingRef.current; if (!tr) return;
    if (t === " ") return; // ignore word gaps
    if (t === tr.target) {
      setTraining({ target: randChar(), score: tr.score + 1, streak: tr.streak + 1, feedback: "✓" });
    } else {
      setTraining({ ...tr, streak: 0, feedback: `✗ das war ${t}` });
    }
  }, []);

  const pushLine = useCallback((l: Line) => {
    setLines((prev) => [...prev.slice(-200), l]);
  }, []);

  // ---- timing calibration (BPM) ----
  const [unit, setUnit] = useState(() => {
    try { const v = localStorage.getItem("morse-unit"); if (v) return parseFloat(v) || DEFAULT_UNIT; } catch {}
    return DEFAULT_UNIT;
  });
  const unitRef = useRef(unit);
  const setUnitEverywhere = useCallback((u: number) => {
    unitRef.current = u;
    setUnit(u);
    try { localStorage.setItem("morse-unit", String(u)); } catch {}
    const t = timingFromUnit(u);
    decRef.current?.setTiming(t);
    for (const dec of remoteDecodersRef.current.values()) dec.setTiming(t);
  }, []);
  const [calibrating, setCalibrating] = useState(false);
  const calibratingRef = useRef(false);
  useEffect(() => { calibratingRef.current = calibrating; }, [calibrating]);
  const calTapsRef = useRef<number[]>([]);
  const [calTaps, setCalTaps] = useState(0);
  const [bpmInput, setBpmInput] = useState("");

  const recordCalTap = useCallback((hold: number) => {
    if (hold < 5 || hold > 500) return; // ignore zero-length taps, dahs, accidental long holds
    calTapsRef.current.push(hold);
    setCalTaps(calTapsRef.current.length);
    if (calTapsRef.current.length >= CAL_TAPS_NEEDED) {
      const avg = calTapsRef.current.reduce((a, b) => a + b, 0) / calTapsRef.current.length;
      calTapsRef.current = [];
      calibratingRef.current = false;
      setCalibrating(false);
      setCalTaps(0);
      setUnitEverywhere(avg);
      pushLine({ kind: "event", text: `kalibriert: dit ≈ ${Math.round(avg)}ms → ${Math.round(60000 / avg)} BPM` });
    }
  }, [setUnitEverywhere, pushLine]);

  const startCalibrate = useCallback(() => {
    calTapsRef.current = [];
    setCalTaps(0);
    calibratingRef.current = true;
    setCalibrating(true);
    pushLine({ kind: "event", text: `kalibrierung: tippe ${CAL_TAPS_NEEDED} kurze dits (nur kurz antippen)` });
  }, [pushLine]);

  const applyBpm = useCallback(() => {
    const b = parseInt(bpmInput, 10);
    if (b >= 50 && b <= 1200) setUnitEverywhere(60000 / b);
  }, [bpmInput, setUnitEverywhere]);

  // ---- signal logs for replay ----
  interface Signal { on: boolean; ts: number }
  const localSignalLogRef = useRef<Signal[]>([]);
  const localSigMarkRef = useRef(0);
  const remoteSignalLogsRef = useRef(new Map<string, Signal[]>()); // key -> [{on, ts}]
  const remoteSigMarksRef = useRef(new Map<string, number>());   // key -> index

  // ---- message accumulator: collect decoded letters, flush as one message ----
  const pendingLocalRef = useRef("");
  const localMsgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [localMsg, setLocalMsg] = useState("");
  const pendingRemoteRef = useRef(new Map<string, { text: string; timer: ReturnType<typeof setTimeout> | null }>()); // key -> { text, timer }
  const [remoteMsgs, setRemoteMsgs] = useState<Record<string, string>>({});

  const flushLocalMsg = useCallback(() => {
    const text = pendingLocalRef.current.trim();
    pendingLocalRef.current = "";
    setLocalMsg("");
    const signals = localSignalLogRef.current.slice(localSigMarkRef.current);
    localSigMarkRef.current = localSignalLogRef.current.length;
    if (text) pushLine({ kind: "msg", nick, text, self: true, signals });
  }, [nick, pushLine]);

  const flushRemoteMsg = useCallback((rNick: string) => {
    const entry = pendingRemoteRef.current.get(rNick);
    if (!entry) return;
    const text = entry.text.trim();
    if (entry.timer) clearTimeout(entry.timer);
    pendingRemoteRef.current.delete(rNick);
    const log = remoteSignalLogsRef.current.get(rNick) || [];
    const mark = remoteSigMarksRef.current.get(rNick) || 0;
    const signals = log.slice(mark);
    remoteSigMarksRef.current.set(rNick, log.length);
    setRemoteMsgs((prev) => { const n = { ...prev }; delete n[rNick]; return n; });
    if (text) pushLine({ kind: "msg", nick: rNick.split("@")[0], text, self: false, signals });
  }, [pushLine]);

  // ---- local morse decoder ----
  useEffect(() => {
    decRef.current = new MorseDecoder(
      (t) => {
        // training mode intercepts decoded letters
        if (trainingRef.current && scratchpadRef.current) { handleTrainingLetter(t); return; }
        pendingLocalRef.current += t;
        setLocalMsg(pendingLocalRef.current);
        if (localMsgTimerRef.current) clearTimeout(localMsgTimerRef.current);
        localMsgTimerRef.current = setTimeout(flushLocalMsg, MSG_FLUSH_MS);
      },
      (b) => setLocalBuf(b),
      timingFromUnit(unitRef.current),
      (kind) => flashGap(kind),
    );
    return () => {
      if (localMsgTimerRef.current) clearTimeout(localMsgTimerRef.current);
      decRef.current?.reset();
    };
  }, [nick, pushLine, flushLocalMsg, handleTrainingLetter, flashGap]);

  // ---- connect ----
  const connect = useCallback(() => {
    if (wsRef.current) wsRef.current.close();
    setConnecting(true);
    setLines([]);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.onopen = () => {
      setConnecting(false); setConnected(true);
      ws.send(JSON.stringify({ t: "hello", nick }));
      // Re-join the room we were in (e.g. after a reconnect)
      const r = roomRef.current;
      if (r) {
        const pass = savedPassesRef.current[r] ?? null;
        const joinMsg: { t: string; room: string; pass?: string } = { t: "join", room: r };
        if (pass) joinMsg.pass = pass;
        ws.send(JSON.stringify(joinMsg));
        pushLine({ kind: "event", text: `rejoined #${r}` });
      }
    };
    ws.onclose = () => { setConnected(false); setConnecting(false); };
    ws.onerror = () => { setConnecting(false); };
    ws.onmessage = (ev: MessageEvent) => {
      let m: any; try { m = JSON.parse(ev.data); } catch { return; }
      switch (m.t) {
        case "welcome":
          setRooms(m.rooms || []);
          pushLine({ kind: "event", text: "connected" });
          break;
        case "rooms":
          setRooms(m.list || []);
          break;
        case "presence":
          if (m.room === roomRef.current) setPresence(m.nicks || []);
          break;
        case "room-deleted":
          if (m.room === roomRef.current) {
            setRoom(null); setPresence([]);
            pushLine({ kind: "event", text: `room #${m.room} was deleted` });
          }
          break;
        case "signal": {
          if (m.room !== roomRef.current) break;
          remoteBeepRef.current?.(m.on);
          const key = `${m.nick}@${m.srv}`;
          // log remote signals for replay
          let rlog = remoteSignalLogsRef.current.get(key);
          if (!rlog) { rlog = []; remoteSignalLogsRef.current.set(key, rlog); }
          rlog.push({ on: m.on, ts: m.ts });
          if (m.on) {
            // cancel pending remote message flush — remote user is still typing
            const remEntry = pendingRemoteRef.current.get(key);
            if (remEntry && remEntry.timer) { clearTimeout(remEntry.timer); remEntry.timer = null; }
          }
          let dec = remoteDecodersRef.current.get(key);
          if (!dec) {
            const sigKey = key;
            dec = new MorseDecoder(
              (t) => {
                let entry = pendingRemoteRef.current.get(sigKey);
                if (!entry) { entry = { text: "", timer: null }; pendingRemoteRef.current.set(sigKey, entry); }
                entry.text += t;
                setRemoteMsgs((prev) => ({ ...prev, [sigKey]: entry.text }));
                if (entry.timer) clearTimeout(entry.timer);
                entry.timer = setTimeout(() => flushRemoteMsg(sigKey), MSG_FLUSH_MS);
              },
              (b) => setRemoteBufs((prev) => ({ ...prev, [sigKey]: b })),
              timingFromUnit(unitRef.current),
            );
            remoteDecodersRef.current.set(key, dec);
          }
          dec.feed(m.on, m.ts);
          break;
        }
        case "error":
          pushLine({ kind: "event", text: `error: ${m.msg}` });
          // server rejected the join — undo local room state
          if (String(m.msg).startsWith("wrong password")) { setRoom(null); setPresence([]); }
          break;
      }
    };
  }, [wsUrl, nick, pushLine, flushRemoteMsg]);

  // ---- join / leave (room names may carry a BPM: "lobby@300") ----
  const clearRemoteState = useCallback(() => {
    for (const entry of pendingRemoteRef.current.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    pendingRemoteRef.current.clear();
    remoteDecodersRef.current.clear();
    remoteSignalLogsRef.current.clear();
    remoteSigMarksRef.current.clear();
    setRemoteBufs({});
    setRemoteMsgs({});
  }, []);

  const joinRoom = useCallback((r: string, passOverride?: string) => {
    const ws = wsRef.current; if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (room) ws.send(JSON.stringify({ t: "leave", room }));
    clearRemoteState();
    setRoom(r); setPresence([]);
    const pass = passOverride !== undefined ? passOverride : (savedPassesRef.current[r] ?? null);
    const joinMsg: { t: string; room: string; pass?: string } = { t: "join", room: r };
    if (pass) { joinMsg.pass = pass; savedPassesRef.current[r] = pass; }
    ws.send(JSON.stringify(joinMsg));
    const m = r.match(/@(\d+)\s*$/);
    if (m) {
      const bpm = parseInt(m[1], 10);
      if (bpm >= 50 && bpm <= 1200) {
        setUnitEverywhere(60000 / bpm);
        pushLine({ kind: "event", text: `raum-tempo: ${bpm} BPM` });
      }
    }
    pushLine({ kind: "event", text: `joined #${r}` });
  }, [room, pushLine, setUnitEverywhere, clearRemoteState]);

  const leaveRoom = useCallback(() => {
    const ws = wsRef.current; if (!ws || ws.readyState !== WebSocket.OPEN || !room) return;
    ws.send(JSON.stringify({ t: "leave", room }));
    setRoom(null); setPresence([]);
    pushLine({ kind: "event", text: `left #${room}` });
  }, [room, pushLine]);

  // ---- scratchpad (local practice, no network) ----
  const enterScratchpad = useCallback(() => {
    const ws = wsRef.current;
    if (room && ws && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ t: "leave", room }));
    setRoom(null); setPresence([]); setRemoteBufs({}); setRemoteMsgs({});
    pendingRemoteRef.current.clear();
    if (localMsgTimerRef.current) clearTimeout(localMsgTimerRef.current);
    pendingLocalRef.current = ""; setLocalMsg("");
    localSigMarkRef.current = localSignalLogRef.current.length;
    setLines([]);
    setScratchpad(true);
    pushLine({ kind: "event", text: "scratchpad — local practice mode, no signals sent" });
  }, [room, pushLine]);

  const exitScratchpad = useCallback(() => {
    setScratchpad(false);
    setTraining(null);
    setLines([]);
    setLocalBuf("");
    pendingLocalRef.current = "";
    setLocalMsg("");
    if (localMsgTimerRef.current) clearTimeout(localMsgTimerRef.current);
    pushLine({ kind: "event", text: "left scratchpad" });
  }, [pushLine]);

  // ---- send signal ----
  const sendSignal = useCallback((on: boolean) => {
    const ws = wsRef.current; const r = roomRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !r) return;
    ws.send(JSON.stringify({ t: "signal", room: r, on, ts: Date.now() }));
  }, []);

  // ---- shared key-down / key-up (keyboard + touch button) ----
  const stopPauseMeter = useCallback(() => {
    if (pauseRafRef.current !== null) { cancelAnimationFrame(pauseRafRef.current); pauseRafRef.current = null; }
    keyUpAtRef.current = null;
    setPauseMs(0); // keep the row mounted, just reset the fill
  }, []);

  const startPauseMeter = useCallback(() => {
    keyUpAtRef.current = performance.now();
    setMeterStarted(true);
    const tick = () => {
      if (keyUpAtRef.current === null) return;
      setPauseMs(performance.now() - keyUpAtRef.current);
      pauseRafRef.current = requestAnimationFrame(tick);
    };
    pauseRafRef.current = requestAnimationFrame(tick);
  }, []);

  const doKeyDown = useCallback(() => {
    if (keyingRef.current) return;
    keyingRef.current = true;
    stopPauseMeter();
    const now = Date.now();
    keyDownAtRef.current = now;
    setKeying(true);
    localBeepRef.current?.(true);           // audio feedback of own keying
    localSignalLogRef.current.push({ on: true, ts: now }); // record for replay
    decRef.current?.feed(true, now);        // gap detection (letter/word boundaries)
    if (localMsgTimerRef.current) clearTimeout(localMsgTimerRef.current); // user still typing
    if (!scratchpadRef.current) sendSignal(true);
  }, [sendSignal, stopPauseMeter]);

  const doKeyUp = useCallback(() => {
    if (!keyingRef.current) return;
    keyingRef.current = false;
    setKeying(false);
    const now = Date.now();
    const hold = now - keyDownAtRef.current;
    localBeepRef.current?.(false);
    localSignalLogRef.current.push({ on: false, ts: now });
    if (calibratingRef.current && scratchpadRef.current) recordCalTap(hold);
    decRef.current?.feed(false, now); // classifies dit/dah from hold time internally
    startPauseMeter();
    if (!scratchpadRef.current) sendSignal(false);
  }, [sendSignal, recordCalTap, startPauseMeter]);

  // ---- spacebar keydown/keyup (desktop, global) ----
  useEffect(() => {
    if (mobileMode) return; // touch button handles input on mobile
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      if (e.repeat) return;
      doKeyDown();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      doKeyUp();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      stopPauseMeter();
      if (gapFlashTimerRef.current) { clearTimeout(gapFlashTimerRef.current); gapFlashTimerRef.current = null; }
    };
  }, [mobileMode, doKeyDown, doKeyUp, stopPauseMeter]);



  // ---- replay a recorded signal sequence ----
  const playSignals = useCallback((signals: Signal[], freq = 650) => {
    if (!signals || signals.length < 2) return;
    const ctx = ensureAudioCtx(); if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine"; osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, ctx.currentTime);
    osc.connect(gain); gain.connect(ctx.destination);
    const t0 = signals[0].ts;
    const lead = 0.1;
    for (const s of signals) {
      const at = ctx.currentTime + lead + (s.ts - t0) / 1000;
      gain.gain.setValueAtTime(s.on ? 0.15 : 0.0, at);
    }
    const end = ctx.currentTime + lead + (signals[signals.length - 1].ts - t0) / 1000 + 0.3;
    osc.start();
    osc.stop(end);
  }, []);

  const transcriptRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [lines]);

  const bpm = Math.round(60000 / unit);
  const timing = timingFromUnit(unit);

  // ---- UI ----
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200 font-mono flex flex-col">
      {/* header */}
      <header className="border-b border-zinc-800 px-4 py-3 flex items-center gap-3 flex-wrap">
        <span className="text-amber-400 text-lg tracking-widest font-bold">·−· · ·-·· ·- ·· ···</span>
        <span className="text-zinc-400 text-sm">Morse Chat</span>
        <span className="text-xs text-zinc-500 border border-zinc-700 rounded px-1.5 py-0.5">{bpm} BPM</span>
        <button onClick={() => setShowTable((v) => !v)} className="text-xs text-zinc-400 hover:text-amber-400 border border-zinc-700 rounded px-1.5 py-0.5">·— Tabelle</button>
        <div className="ml-auto flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${connected ? "bg-emerald-500" : connecting ? "bg-amber-500 animate-pulse" : "bg-zinc-600"}`} />
          <span className="text-xs text-zinc-500">{connected ? "connected" : connecting ? "connecting…" : "disconnected"}</span>
        </div>
      </header>

      {/* connection bar */}
      {!connected && !scratchpad && (
        <div className="px-4 py-4 border-b border-zinc-800 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">WebSocket URL</span>
            <input value={wsUrl} onChange={(e) => setWsUrl(e.target.value)} className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm w-64 focus:border-amber-500 outline-none" placeholder="ws://host:port" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">Nick</span>
            <input value={nick} onChange={(e) => setNick(e.target.value)} className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm w-32 focus:border-amber-500 outline-none" />
          </label>
          <button onClick={connect} disabled={connecting} className="bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-zinc-950 font-bold rounded px-4 py-1.5 text-sm">
            {connecting ? "…" : "Connect"}
          </button>
        </div>
      )}

      <div className="flex-1 flex flex-col md:flex-row min-h-0">
        {/* left sidebar */}
        <aside className="md:w-64 border-b md:border-b-0 md:border-r border-zinc-800 p-3 flex flex-col gap-4 overflow-y-auto">
          <div>
            <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Mode</h2>
            <div className="flex gap-1 flex-wrap">
              <button
                onClick={() => { if (scratchpad) exitScratchpad(); }}
                className={`rounded px-2 py-1 text-xs ${!scratchpad && !mobileMode ? "bg-amber-500 text-zinc-950 font-bold" : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"}`}
              >Chat</button>
              <button
                onClick={() => { if (!scratchpad) enterScratchpad(); }}
                className={`rounded px-2 py-1 text-xs ${scratchpad ? "bg-amber-500 text-zinc-950 font-bold" : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"}`}
              >Scratchpad</button>
              <button
                onClick={() => { setMobileMode((v) => !v); }}
                className={`rounded px-2 py-1 text-xs ${mobileMode ? "bg-amber-500 text-zinc-950 font-bold" : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"}`}
              >📱 Mobile</button>
            </div>
          </div>

          {scratchpad ? (
            <>
              {/* timing calibration */}
              <div className="border-t border-zinc-800 pt-3">
                <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Timing</h2>
                <div className="text-sm mb-2">
                  <span className="text-amber-400 font-bold">{bpm} BPM</span>
                  <span className="text-zinc-600 text-xs"> (dit {Math.round(unit)}ms)</span>
                </div>
                <div className="flex gap-1">
                  <input value={bpmInput} onChange={(e) => setBpmInput(e.target.value)} placeholder="BPM" className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs outline-none focus:border-amber-500" />
                  <button onClick={applyBpm} className="bg-zinc-800 hover:bg-zinc-700 rounded px-2 py-1 text-xs">set</button>
                </div>
                <button
                  onClick={startCalibrate}
                  disabled={calibrating}
                  className={`w-full rounded px-2 py-1.5 text-xs mt-2 ${calibrating ? "bg-amber-500/20 text-amber-400 border border-amber-500/50" : "bg-zinc-800 hover:bg-zinc-700"}`}
                >
                  {calibrating ? `tippe dits… ${calTaps}/${CAL_TAPS_NEEDED}` : "Kalibrieren"}
                </button>
              </div>

              {/* training */}
              <div>
                <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Training</h2>
                <button
                  onClick={training ? stopTraining : startTraining}
                  className={`w-full rounded px-2 py-1.5 text-xs ${training ? "bg-rose-500/20 text-rose-400 border border-rose-500/50" : "bg-zinc-800 hover:bg-zinc-700"}`}
                >
                  {training ? "Training stoppen" : "Training starten"}
                </button>
              </div>
            </>
          ) : (
          <>
          <div>
            <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Room</h2>
            {room ? (
              <div className="flex items-center gap-2">
                <span className="text-amber-400 font-bold">#{room}</span>
                <button onClick={leaveRoom} className="text-xs text-zinc-500 hover:text-zinc-300">leave</button>
              </div>
            ) : (
              <span className="text-zinc-600 text-sm">none</span>
            )}
            <div className="mt-2 flex gap-1">
              <input value={roomInput} onChange={(e) => setRoomInput(e.target.value)} className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm focus:border-amber-500 outline-none" placeholder="name@bpm" onKeyDown={(e) => { if (e.key === "Enter") { joinRoom(roomInput.replace(/^#/, ""), passInput || undefined); setPassInput(""); } }} />
              <button onClick={() => { joinRoom(roomInput.replace(/^#/, ""), passInput || undefined); setPassInput(""); }} className="bg-zinc-800 hover:bg-zinc-700 rounded px-2 py-1 text-sm">join</button>
            </div>
            <input type="password" value={passInput} onChange={(e) => setPassInput(e.target.value)} placeholder="🔑 Passwort (optional, setzt Schutz bei Erstjoin)" className="w-full mt-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs focus:border-amber-500 outline-none" onKeyDown={(e) => { if (e.key === "Enter") { joinRoom(roomInput.replace(/^#/, ""), passInput || undefined); setPassInput(""); } }} />
            <p className="text-[10px] text-zinc-600 mt-1">mit @bpm-suffix setzt du das raum-tempo, z.b. lobby@300 für langsame, lobby@500 für schnelle schreiber</p>
          </div>

          <div>
            <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">In room</h2>
            {presence.length === 0 ? <span className="text-zinc-600 text-sm">—</span> : (
              <ul className="text-sm space-y-0.5">{presence.map((n) => <li key={n} className={n === nick ? "text-amber-400" : "text-zinc-300"}>{n}{n === nick && " (you)"}</li>)}</ul>
            )}
          </div>

          <div>
            <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Rooms</h2>
            {rooms.length === 0 ? <span className="text-zinc-600 text-sm">—</span> : (
              <ul className="text-xs space-y-0.5">{rooms.map((r) => <li key={r}><button onClick={() => joinRoom(r)} className="text-zinc-400 hover:text-amber-400">#{r}</button></li>)}</ul>
            )}
          </div>


          </>
          )}
        </aside>

        {/* right: transcript + key */}
        <main className="flex-1 flex flex-col min-h-0">
          {/* training panel */}
          {scratchpad && training && (
            <div className="border-b border-zinc-800 px-4 py-4 flex items-center gap-6 bg-zinc-900/50">
              <div className="text-center">
                <div className="text-5xl font-bold text-amber-400">{training.target}</div>
                <div className="text-xs text-zinc-500 mt-1 tracking-widest">{MORSE[training.target]}</div>
              </div>
              <div className="flex-1">
                <div className={`text-sm font-bold ${training.feedback === "✓" ? "text-emerald-400" : training.feedback ? "text-rose-400" : "text-zinc-500"}`}>
                  {training.feedback || "keye das zeichen"}
                </div>
                <div className="text-xs text-zinc-500 mt-1">score {training.score} · streak {training.streak}</div>
              </div>
              <button onClick={stopTraining} className="text-xs text-zinc-500 hover:text-zinc-300">stop</button>
            </div>
          )}

          {/* transcript */}
          <div ref={transcriptRef} className="flex-1 overflow-y-auto p-4 space-y-1 text-sm">
            {!scratchpad && !room && <div className="text-zinc-600 italic">Join a room to start keying morse. Hold SPACE to send signals.</div>}
            {scratchpad && lines.length === 0 && !training && <div className="text-zinc-600 italic">Practice mode — hold SPACE to key morse. Decoded text appears here. No signals sent over network.</div>}
            {lines.map((l, i) => {
              if (l.kind === "event") return <div key={i} className="text-zinc-600 italic text-xs">— {l.text}</div>;
              return (
                <div key={i} className={l.self ? "text-amber-300" : "text-zinc-300"}>
                  <span className="text-zinc-500">{l.nick}:</span> {l.text}
                  {l.signals && l.signals.length > 1 && (
                    <button onClick={() => playSignals(l.signals!)} className="ml-2 text-xs text-amber-500 hover:text-amber-300 align-middle" title="nachricht anhören">▶</button>
                  )}
                </div>
              );
            })}
          </div>

          {/* composing strip — live morse buffers */}
          <div className="border-t border-zinc-800 px-4 py-2 min-h-[2.5rem] flex items-center gap-4 flex-wrap">
            {!scratchpad && Object.entries(remoteMsgs).map(([n, msg]) => (
              <div key={n} className="flex items-center gap-1.5 text-xs">
                <span className="text-zinc-500">{n.split("@")[0]}:</span>
                <span className="text-zinc-300">{msg}</span>
                <span className="text-rose-400 tracking-widest font-bold ml-1">{remoteBufs[n] || ""}</span>
              </div>
            ))}
            {!scratchpad && Object.entries(remoteBufs).filter(([n, b]) => b && !remoteMsgs[n]).map(([n, b]) => (
              <div key={n} className="flex items-center gap-1.5 text-xs">
                <span className="text-zinc-500">{n.split("@")[0]}:</span>
                <span className="text-rose-400 tracking-widest font-bold">{b}</span>
              </div>
            ))}
            {(localMsg || localBuf) && (
              <div className="flex items-center gap-1.5 text-xs ml-auto">
                <span className="text-amber-500 font-bold">{nick}:</span>
                {localMsg && <span className="text-amber-300">{localMsg}</span>}
                <span className="text-amber-300 tracking-widest font-bold text-base">{localBuf}</span>
              </div>
            )}
            {gapFlash && (
              <span
                key={gapFlash.id}
                className={`text-xs font-bold rounded px-1.5 py-0.5 ${
                  gapFlash.kind === "word"
                    ? "bg-rose-500/20 text-rose-400 border border-rose-500/50 animate-[gapflash_0.9s_ease-out]"
                    : "bg-amber-500/10 text-amber-400 border border-amber-500/30 animate-[gapflash_0.5s_ease-out]"
                }`}
              >
                {gapFlash.kind === "word" ? "␣ wort-gap" : "· buchstabe"}
              </span>
            )}
            {scratchpad && !localMsg && !localBuf && calibrating && (
              <span className="text-amber-400 text-xs italic">kalibrierung: tippe kurze dits ({calTaps}/{CAL_TAPS_NEEDED})…</span>
            )}
          </div>

          {/* pause meter — own line, stays mounted once keying started; scales with BPM */}
          {meterStarted && (
            <div className="border-t border-zinc-800 px-4 py-1 flex items-center gap-2 text-xs">
              <div className="relative w-40 h-1.5 bg-zinc-800 rounded overflow-hidden">
                <div
                  className={`absolute inset-y-0 left-0 rounded transition-colors ${
                    pauseMs >= timing.wordGap ? "bg-rose-500" : pauseMs >= timing.letterGap ? "bg-amber-500" : "bg-zinc-500"
                  }`}
                  style={{ width: `${Math.min(100, (pauseMs / timing.wordGap) * 100)}%` }}
                />
              </div>
              <span className={`tabular-nums ${pauseMs >= timing.wordGap ? "text-rose-400 font-bold" : "text-zinc-500"}`}>
                {pauseMs >= timing.wordGap ? "␣ wort-gap" : `${Math.round(pauseMs)}/${Math.round(timing.wordGap)}ms`}
              </span>
            </div>
          )}

          {/* key indicator / touch button */}
          <div className="border-t border-zinc-800 p-4">
            {mobileMode ? (
              <button
                onTouchStart={(e) => { e.preventDefault(); doKeyDown(); }}
                onTouchEnd={(e) => { e.preventDefault(); doKeyUp(); }}
                onTouchCancel={(e) => { e.preventDefault(); doKeyUp(); }}
                onMouseDown={(e) => { e.preventDefault(); doKeyDown(); }}
                onMouseUp={(e) => { e.preventDefault(); doKeyUp(); }}
                onMouseLeave={() => { if (keyingRef.current) doKeyUp(); }}
                disabled={!scratchpad && !room}
                className={`w-full select-none touch-none rounded-2xl border-2 transition-all flex flex-col items-center justify-center gap-2 ${
                  keying
                    ? "bg-amber-500 border-amber-400 text-zinc-950 scale-[1.02] py-10"
                    : "bg-zinc-900 border-zinc-700 text-zinc-400 py-10 active:bg-zinc-800"
                } ${(!scratchpad && !room) ? "opacity-40 cursor-not-allowed" : ""}`}
                style={{ WebkitUserSelect: "none", userSelect: "none", WebkitTapHighlightColor: "transparent" }}
              >
                <span className="text-4xl font-bold">␣</span>
                <span className="text-xs uppercase tracking-wider">
                  {keying ? "keying…" : scratchpad ? "Hold to practice" : room ? `Hold to key #${room}` : "join a room first"}
                </span>
              </button>
            ) : (
            <div className="flex items-center gap-4">
              <div
                className={`flex items-center justify-center w-20 h-20 rounded-lg border-2 transition-colors select-none ${
                  keying ? "bg-amber-500 border-amber-400 text-zinc-950 scale-105" : "bg-zinc-900 border-zinc-700 text-zinc-500"
                }`}
              >
                <span className="text-2xl font-bold">␣</span>
              </div>
              <div className="flex-1">
                <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">
                  {scratchpad ? "Scratchpad — practice mode, no network" : room ? `Hold SPACE to key morse in #${room}` : "Join a room first"}
                </div>
                <div className="text-xs text-zinc-600">
                  {keying ? <span className="text-amber-400">● keying…</span> : "short = dit (·), long = dah (—), pause = letter gap"}
                </div>
              </div>
            </div>
            )}
          </div>
        </main>
      </div>

      {/* morse table overlay — always available via header toggle */}
      {showTable && (
        <div className="fixed right-2 bottom-2 z-50 bg-zinc-900 border border-zinc-700 rounded-lg p-3 shadow-2xl max-w-[300px] max-h-[70vh] overflow-y-auto">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs uppercase tracking-wider text-zinc-500">Morse Tabelle</h2>
            <button onClick={() => setShowTable(false)} className="text-zinc-500 hover:text-zinc-300 text-xs">✕</button>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
            {Object.entries(MORSE).filter(([k]) => /^[A-Z0-9]$/.test(k)).map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <span className="text-zinc-300 font-bold">{k}</span>
                <span className="text-amber-400 tracking-widest">{v.replace(/\./g, "·").replace(/-/g, "—")}</span>
              </div>
            ))}
          </div>
          <div className="mt-2 pt-2 border-t border-zinc-800 text-[10px] text-zinc-600">
            <div className="flex justify-between"><span>Dit</span><span>{Math.round(unit)}ms</span></div>
            <div className="flex justify-between"><span>Dah</span><span>{Math.round(unit * 3)}ms</span></div>
            <div className="flex justify-between"><span>Buchstaben-Gap</span><span>{Math.round(unit * 1.6)}ms</span></div>
            <div className="flex justify-between"><span>Wort-Gap</span><span>{Math.round(unit * 7)}ms</span></div>
          </div>
        </div>
      )}
    </div>
  );
}
