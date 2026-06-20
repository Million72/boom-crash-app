import { useState, useEffect, useRef, useCallback } from "react";

const INSTRUMENTS = [
  { id: "BOOM300N",  label: "Boom 300",   type: "boom",  color: "#00E5FF", avgInterval: 300  },
  { id: "BOOM500",   label: "Boom 500",   type: "boom",  color: "#00B8D4", avgInterval: 500  },
  { id: "BOOM1000",  label: "Boom 1000",  type: "boom",  color: "#0288D1", avgInterval: 1000 },
  { id: "CRASH300N", label: "Crash 300",  type: "crash", color: "#FF4081", avgInterval: 300  },
  { id: "CRASH500",  label: "Crash 500",  type: "crash", color: "#F50057", avgInterval: 500  },
  { id: "CRASH1000", label: "Crash 1000", type: "crash", color: "#C51162", avgInterval: 1000 },
];

const MAX_TICKS       = 200;
const EMA_FAST        = 9;
const EMA_SLOW        = 21;
const RSI_PERIOD      = 14;
const SPIKE_THRESHOLD = 0.003;
const EVALUATION_TICKS = 10;            // how many ticks after a signal before scoring win/loss
const TRADE_LOG_KEY    = "boomCrashTradeLog";

// ─── Audio & Haptics helpers ──────────────────────────────────────────────────

let _audioCtx = null;

function getAudioCtx() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!_audioCtx) _audioCtx = new Ctx();
  if (_audioCtx.state === "suspended") _audioCtx.resume();
  return _audioCtx;
}

function playTone(freq, duration = 0.15, delay = 0, type = "sine", volume = 0.2) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.value = volume;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const t0 = ctx.currentTime + delay;
    osc.start(t0);
    osc.stop(t0 + duration);
  } catch { /* audio unavailable, fail silently */ }
}

function playSpikeSound() {
  playTone(1200, 0.12, 0,    "square", 0.25);
  playTone(1600, 0.12, 0.13, "square", 0.25);
}

function playSignalSound(signal) {
  if (signal === "BUY") {
    playTone(660, 0.12, 0,    "sine", 0.2);
    playTone(880, 0.15, 0.13, "sine", 0.2);
  } else {
    playTone(880, 0.12, 0,    "sine", 0.2);
    playTone(660, 0.15, 0.13, "sine", 0.2);
  }
}

function playWatchSound() {
  playTone(740, 0.1, 0, "sine", 0.12);
}

function vibrateDevice(pattern) {
  if (navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch { /* unsupported, fail silently */ }
  }
}

// ─── Indicator helpers ────────────────────────────────────────────────────────

function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(prices, period) {
  if (prices.length < period + 1) return null;
  const slice = prices.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function detectSpike(prices) {
  if (prices.length < 2) return false;
  const last = prices[prices.length - 1];
  const prev = prices[prices.length - 2];
  return Math.abs((last - prev) / prev) > SPIKE_THRESHOLD;
}

function getSignal(prices, type) {
  if (prices.length < RSI_PERIOD + 1) return { signal: "WAIT", strength: 0, rsi: null, emaFast: null, emaSlow: null };
  const emaFast = calcEMA(prices, EMA_FAST);
  const emaSlow = calcEMA(prices, EMA_SLOW);
  const rsi     = calcRSI(prices, RSI_PERIOD);
  const spike   = detectSpike(prices);
  const last    = prices[prices.length - 1];
  const prev    = prices[prices.length - 2];

  if (emaFast === null || emaSlow === null || rsi === null) {
    return { signal: "WAIT", strength: 0, rsi: null, emaFast, emaSlow };
  }

  let score  = 0;
  let signal = "WAIT";

  if (type === "boom") {
    if (spike && last > prev)          score += 3;
    if (emaFast > emaSlow)             score += 2;
    if (rsi < 40)                      score += 2;
    if (rsi >= 30 && rsi < 50)         score += 1;
    if (last < emaSlow)                score += 1;
    if (score >= 4)                    signal = "BUY";
  } else {
    if (spike && last < prev)          score += 3;
    if (emaFast < emaSlow)             score += 2;
    if (rsi > 60)                      score += 2;
    if (rsi > 50 && rsi <= 70)         score += 1;
    if (last > emaSlow)                score += 1;
    if (score >= 4)                    signal = "SELL";
  }

  return { signal, strength: Math.min(score, 9), rsi: rsi.toFixed(1), emaFast, emaSlow };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function MiniChart({ ticks, color, gradientId }) {
  if (ticks.length < 2) return <div style={{ height: 48 }} />;
  const vals  = ticks.slice(-60);
  const min   = Math.min(...vals);
  const max   = Math.max(...vals);
  const range = max - min || 1;
  const W = 100, H = 48;

  const pts = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * W;
    const y = H - ((v - min) / range) * H;
    return `${x},${y}`;
  }).join(" ");

  const last    = vals[vals.length - 1];
  const prev    = vals[vals.length - 2];
  const isSpike = Math.abs((last - prev) / prev) > SPIKE_THRESHOLD;
  const dotX    = W;
  const dotY    = H - ((last - min) / range) * H;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 48 }}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0"   />
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${pts} ${W},${H}`} fill={`url(#${gradientId})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
      {isSpike && <circle cx={dotX} cy={dotY} r="3" fill="#FFD700" />}
    </svg>
  );
}

function SignalBadge({ signal }) {
  const map = {
    BUY:  { bg: "rgba(0,229,100,0.15)",  border: "#00E564", color: "#00E564", text: "⬆ BUY"  },
    SELL: { bg: "rgba(255,64,129,0.15)", border: "#FF4081", color: "#FF4081", text: "⬇ SELL" },
    WAIT: { bg: "rgba(255,255,255,0.05)",border: "#444",    color: "#888",    text: "— WAIT"  },
  };
  const s = map[signal] ?? map.WAIT;
  return (
    <span style={{
      background: s.bg, border: `1px solid ${s.border}`, color: s.color,
      borderRadius: 6, padding: "2px 10px",
      fontFamily: "monospace", fontWeight: 700, fontSize: 13, letterSpacing: 1,
    }}>{s.text}</span>
  );
}

function StrengthBar({ strength, max = 9 }) {
  const pct   = (strength / max) * 100;
  const color = strength >= 7 ? "#00E564" : strength >= 4 ? "#FFD700" : "#FF4081";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ flex: 1, height: 5, background: "rgba(255,255,255,0.08)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3, transition: "width 0.3s" }} />
      </div>
      <span style={{ fontSize: 11, color: "#888", minWidth: 28 }}>{strength}/{max}</span>
    </div>
  );
}

function getSpikeZone(ticksSince, avgInterval) {
  const pct = Math.min((ticksSince / avgInterval) * 100, 100);
  if (pct >= 80) return { zone: "HIGH",     color: "#FF6400", pct };
  if (pct >= 50) return { zone: "BUILDING", color: "#FFD700", pct };
  return            { zone: "LOW",      color: "#00B8D4", pct };
}

function ProbabilityMeter({ ticksSince, avgInterval }) {
  const { zone, color, pct } = getSpikeZone(ticksSince, avgInterval);
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
        <span style={{ fontSize: 11, color: "#666" }}>Spike Probability</span>
        <span style={{ fontSize: 11, fontWeight: 700, color, letterSpacing: 0.5 }}>
          {zone} · {ticksSince}/{avgInterval}
        </span>
      </div>
      <div style={{ height: 5, background: "rgba(255,255,255,0.08)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3, transition: "width 0.3s" }} />
      </div>
    </div>
  );
}

function InstrumentCard({ instrument, ticks, signal, onToggleBot, botActive, alertCount, ticksSinceSpike }) {
  const isSpike = detectSpike(ticks);
  const last    = ticks[ticks.length - 1];
  const prev    = ticks[ticks.length - 2];
  const change  = (last !== undefined && prev) ? ((last - prev) / prev * 100) : 0;
  // stable gradient id derived from instrument id (no spaces / special chars)
  const gradId  = `grad-${instrument.id}`;
  const { zone: spikeZone } = getSpikeZone(ticksSinceSpike ?? 0, instrument.avgInterval);
  const isHighZone = spikeZone === "HIGH" && !isSpike;

  const borderColor = isSpike ? "#FFD700" : isHighZone ? "#FF6400" : "rgba(255,255,255,0.08)";
  const glow = isSpike
    ? "0 0 16px rgba(255,215,0,0.15)"
    : isHighZone
    ? "0 0 14px rgba(255,100,0,0.12)"
    : "none";

  return (
    <div style={{
      background:    "rgba(255,255,255,0.04)",
      border:        `1px solid ${borderColor}`,
      borderRadius:  14,
      padding:       "14px 16px",
      transition:    "border-color 0.3s",
      boxShadow:     glow,
    }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%",
            background: instrument.color, boxShadow: `0 0 6px ${instrument.color}`,
          }} />
          <span style={{ fontWeight: 700, fontSize: 14, color: "#fff", letterSpacing: 0.5 }}>
            {instrument.label}
          </span>
          {isSpike && (
            <span style={{ fontSize: 10, background: "rgba(255,215,0,0.2)", color: "#FFD700", borderRadius: 4, padding: "1px 6px", fontWeight: 700 }}>
              ⚡ SPIKE
            </span>
          )}
          {isHighZone && (
            <span style={{ fontSize: 10, background: "rgba(255,100,0,0.2)", color: "#FF6400", borderRadius: 4, padding: "1px 6px", fontWeight: 700 }}>
              👀 WATCH
            </span>
          )}
          {alertCount > 0 && (
            <span style={{ fontSize: 10, background: "rgba(255,100,0,0.2)", color: "#FF6400", borderRadius: 4, padding: "1px 6px" }}>
              🔔 {alertCount}
            </span>
          )}
        </div>
        <SignalBadge signal={signal.signal} />
      </div>

      {/* Price */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 22, fontWeight: 800, color: "#fff", fontFamily: "monospace" }}>
          {last !== undefined ? last.toFixed(2) : "—"}
        </span>
        <span style={{ fontSize: 12, color: change >= 0 ? "#00E564" : "#FF4081", fontFamily: "monospace" }}>
          {change >= 0 ? "+" : ""}{change.toFixed(4)}%
        </span>
      </div>

      {/* Chart */}
      <MiniChart ticks={ticks} color={instrument.color} gradientId={gradId} />

      {/* Indicators */}
      <div style={{ display: "flex", gap: 12, marginTop: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 11, color: "#888" }}>RSI <span style={{ color: "#ccc" }}>{signal.rsi ?? "—"}</span></span>
        <span style={{ fontSize: 11, color: "#888" }}>EMA9 <span style={{ color: "#ccc" }}>{signal.emaFast !== null ? signal.emaFast.toFixed(2) : "—"}</span></span>
        <span style={{ fontSize: 11, color: "#888" }}>EMA21 <span style={{ color: "#ccc" }}>{signal.emaSlow !== null ? signal.emaSlow.toFixed(2) : "—"}</span></span>
      </div>

      {/* Spike Probability */}
      <ProbabilityMeter ticksSince={ticksSinceSpike ?? 0} avgInterval={instrument.avgInterval} />

      {/* Strength */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: "#666", marginBottom: 3 }}>Signal Strength</div>
        <StrengthBar strength={signal.strength} />
      </div>

      {/* Bot toggle */}
      <button
        onClick={() => onToggleBot(instrument.id)}
        style={{
          width: "100%", padding: "7px 0", borderRadius: 8, border: "none",
          background: botActive ? "rgba(255,64,129,0.2)" : "rgba(0,229,100,0.15)",
          color:      botActive ? "#FF4081" : "#00E564",
          fontWeight: 700, fontSize: 12, cursor: "pointer",
          letterSpacing: 1, transition: "all 0.2s",
        }}
      >
        {botActive ? "⏹ STOP BOT" : "▶ START BOT"}
      </button>
    </div>
  );
}

function AlertLog({ alerts }) {
  if (alerts.length === 0) return null;
  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ fontSize: 12, color: "#666", marginBottom: 8, letterSpacing: 1, textTransform: "uppercase" }}>
        Recent Alerts
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 160, overflowY: "auto" }}>
        {[...alerts].reverse().map((a, i) => {
          const borderColor = a.type === "spike" ? "#FFD700" : a.type === "watch" ? "#FF6400" : a.signal === "BUY" ? "#00E564" : "#FF4081";
          const text = a.type === "spike" ? "⚡ Spike detected" : a.type === "watch" ? "👀 High probability zone" : a.signal === "BUY" ? "⬆ Buy signal" : "⬇ Sell signal";
          return (
            <div key={i} style={{
              background: "rgba(255,255,255,0.04)", borderRadius: 8, padding: "8px 12px",
              display: "flex", justifyContent: "space-between", alignItems: "center",
              borderLeft: `3px solid ${borderColor}`,
            }}>
              <div>
                <span style={{ fontSize: 12, color: "#fff", fontWeight: 600 }}>{a.label}</span>
                <span style={{ fontSize: 11, color: "#888", marginLeft: 8 }}>{text}</span>
              </div>
              <span style={{ fontSize: 10, color: "#555" }}>{a.time}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatBox({ label, value, color }) {
  return (
    <div style={{
      flex: 1, textAlign: "center", background: "rgba(255,255,255,0.03)",
      borderRadius: 10, padding: "8px 4px",
    }}>
      <div style={{ fontSize: 15, fontWeight: 700, color, fontFamily: "monospace" }}>{value}</div>
      <div style={{ fontSize: 9, color: "#666", letterSpacing: 0.5, marginTop: 2 }}>{label}</div>
    </div>
  );
}

function TradeLog({ trades, onClear }) {
  const total = trades.length;

  if (total === 0) {
    return (
      <div style={{ marginTop: 20 }}>
        <div style={{ fontSize: 12, color: "#666", marginBottom: 8, letterSpacing: 1, textTransform: "uppercase" }}>
          Performance
        </div>
        <div style={{ fontSize: 12, color: "#555", textAlign: "center", padding: "16px 0" }}>
          No closed signals yet — results appear {EVALUATION_TICKS} ticks after each signal fires
        </div>
      </div>
    );
  }

  const wins    = trades.filter(t => t.win).length;
  const losses  = total - wins;
  const winRate = ((wins / total) * 100).toFixed(1);

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: "#666", letterSpacing: 1, textTransform: "uppercase" }}>
          Performance
        </div>
        <button
          onClick={onClear}
          style={{ fontSize: 10, color: "#666", background: "none", border: "none", cursor: "pointer", padding: 0 }}
        >Clear</button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <StatBox label="WIN RATE" value={`${winRate}%`} color={winRate >= 50 ? "#00E564" : "#FF4081"} />
        <StatBox label="WINS"     value={wins}           color="#00E564" />
        <StatBox label="LOSSES"   value={losses}          color="#FF4081" />
        <StatBox label="TOTAL"    value={total}            color="#888" />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 200, overflowY: "auto" }}>
        {trades.slice(0, 30).map(t => (
          <div key={t.id} style={{
            background: "rgba(255,255,255,0.04)", borderRadius: 8, padding: "8px 12px",
            display: "flex", justifyContent: "space-between", alignItems: "center",
            borderLeft: `3px solid ${t.win ? "#00E564" : "#FF4081"}`,
          }}>
            <div>
              <span style={{ fontSize: 12, color: "#fff", fontWeight: 600 }}>{t.label}</span>
              <span style={{ fontSize: 11, color: "#888", marginLeft: 8 }}>
                {t.signal === "BUY" ? "⬆" : "⬇"} {t.signal} · {t.win ? "✅ WIN" : "❌ LOSS"}
              </span>
            </div>
            <span style={{ fontSize: 10, color: "#555" }}>{t.closedTime}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────

export default function App() {
  const [tickData,        setTickData]        = useState({});   // { [symbol]: number[] }
  const [signals,         setSignals]         = useState({});   // { [symbol]: SignalResult }
  const [prevSigs,        setPrevSigs]        = useState({});   // track previous signal to fire alert once
  const [activeBots,      setActiveBots]      = useState({});
  const [alerts,          setAlerts]          = useState([]);
  const [connected,       setConnected]       = useState(false);
  const [activeTab,       setActiveTab]       = useState("boom");
  const [filter,          setFilter]          = useState("all");
  const [ticksSinceSpike, setTicksSinceSpike] = useState({});   // { [symbol]: number }
  const [soundEnabled,    setSoundEnabled]    = useState(true);
  const [tradeLog,        setTradeLog]        = useState([]);   // closed signal outcomes, newest first

  const wsRef              = useRef(null);
  const alertsRef          = useRef([]);
  const prevSigsRef        = useRef({});   // ref copy so ws handler always sees latest
  const ticksSinceSpikeRef = useRef({});   // ref copy so ws handler always sees latest
  const prevZoneRef        = useRef({});   // tracks LOW/BUILDING/HIGH per symbol
  const soundEnabledRef    = useRef(true); // ref copy so ws handler always sees latest
  const tradeLogRef        = useRef([]);   // ref copy so ws handler always sees latest
  const openTradesRef      = useRef({});   // { [symbol]: { entryPrice, ticksElapsed, signal, time, label } }

  useEffect(() => { soundEnabledRef.current = soundEnabled; }, [soundEnabled]);

  // Load any saved trade history on first mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(TRADE_LOG_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        tradeLogRef.current = parsed;
        setTradeLog(parsed);
      }
    } catch { /* localStorage unavailable or corrupt, start fresh */ }
  }, []);

  const persistTradeLog = useCallback((log) => {
    try { localStorage.setItem(TRADE_LOG_KEY, JSON.stringify(log.slice(0, 200))); } catch { /* ignore */ }
  }, []);

  const clearTradeLog = useCallback(() => {
    tradeLogRef.current = [];
    setTradeLog([]);
    try { localStorage.removeItem(TRADE_LOG_KEY); } catch { /* ignore */ }
  }, []);

  const addAlert = useCallback((alert) => {
    alertsRef.current = [alert, ...alertsRef.current].slice(0, 50);
    setAlerts([...alertsRef.current]);

    if (!soundEnabledRef.current) return;
    if (alert.type === "spike") {
      playSpikeSound();
      vibrateDevice([80, 40, 80]);
    } else if (alert.type === "signal") {
      playSignalSound(alert.signal);
      vibrateDevice(alert.signal === "BUY" ? [150] : [150, 60, 150]);
    } else if (alert.type === "watch") {
      playWatchSound();
      vibrateDevice([40]);
    }
  }, []);

  const toggleSound = useCallback(() => {
    setSoundEnabled(prevVal => {
      const next = !prevVal;
      if (next) {
        getAudioCtx();
        playTone(880, 0.1); // confirmation beep when turning on
      }
      return next;
    });
  }, []);

  const connectWS = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      INSTRUMENTS.forEach(inst => {
        ws.send(JSON.stringify({ ticks: inst.id, subscribe: 1 }));
      });
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.msg_type !== "tick" || !msg.tick) return;

      const { symbol, quote } = msg.tick;
      const inst = INSTRUMENTS.find(i => i.id === symbol);
      if (!inst) return;

      const time = new Date().toLocaleTimeString();

      setTickData(prev => {
        const existing = prev[symbol] || [];
        const updated  = [...existing, quote].slice(-MAX_TICKS);

        // Compute signal synchronously here so we can compare with previous
        const sig      = getSignal(updated, inst.type);
        const prevSig  = prevSigsRef.current[symbol] ?? "WAIT";

        // Spike alert (only fire on rising edge)
        const wasSpike = detectSpike(existing);
        const isSpike  = detectSpike(updated);
        if (isSpike && !wasSpike) {
          addAlert({ label: inst.label, type: "spike", time });
        }

        // Ticks-since-last-spike counter (resets to 0 the moment a spike fires)
        const prevCount = ticksSinceSpikeRef.current[symbol] ?? 0;
        const newCount  = isSpike ? 0 : prevCount + 1;
        ticksSinceSpikeRef.current = { ...ticksSinceSpikeRef.current, [symbol]: newCount };
        setTicksSinceSpike(ts => ({ ...ts, [symbol]: newCount }));

        // Watch alert (only fire once, on the moment we enter the HIGH probability zone)
        const prevZone = prevZoneRef.current[symbol] ?? "LOW";
        const currZone = getSpikeZone(newCount, inst.avgInterval).zone;
        if (currZone === "HIGH" && prevZone !== "HIGH") {
          addAlert({ label: inst.label, type: "watch", time });
        }
        prevZoneRef.current = { ...prevZoneRef.current, [symbol]: currZone };

        // Progress any open trade for this symbol — close it out once EVALUATION_TICKS pass
        const openTrade = openTradesRef.current[symbol];
        if (openTrade) {
          const ticksElapsed = openTrade.ticksElapsed + 1;
          if (ticksElapsed >= EVALUATION_TICKS) {
            const win = openTrade.signal === "BUY" ? quote > openTrade.entryPrice : quote < openTrade.entryPrice;
            const closedTrade = {
              id: `${symbol}-${openTrade.time}-${Math.random().toString(36).slice(2, 7)}`,
              label: openTrade.label,
              signal: openTrade.signal,
              entryPrice: openTrade.entryPrice,
              exitPrice: quote,
              win,
              time: openTrade.time,
              closedTime: time,
            };
            tradeLogRef.current = [closedTrade, ...tradeLogRef.current].slice(0, 200);
            setTradeLog([...tradeLogRef.current]);
            persistTradeLog(tradeLogRef.current);
            delete openTradesRef.current[symbol];
          } else {
            openTradesRef.current[symbol] = { ...openTrade, ticksElapsed };
          }
        }
        // Update refs & state
        prevSigsRef.current = { ...prevSigsRef.current, [symbol]: sig.signal };
        setPrevSigs(ps => ({ ...ps, [symbol]: sig.signal }));
        setSignals(ps  => ({ ...ps, [symbol]: sig }));

        return { ...prev, [symbol]: updated };
      });
    };

    ws.onclose = () => {
      setConnected(false);
      setTimeout(connectWS, 3000);
    };

    ws.onerror = () => ws.close();
  }, [addAlert, persistTradeLog]);

  useEffect(() => {
    connectWS();
    return () => { wsRef.current?.close(); };
  }, [connectWS]);

  const toggleBot = useCallback((id) => {
    setActiveBots(prev => ({ ...prev, [id]: !prev[id] }));
  }, []);

  // Alert counts per instrument label
  const alertCounts = alerts.reduce((acc, a) => {
    acc[a.label] = (acc[a.label] || 0) + 1;
    return acc;
  }, {});

  const visibleInstruments = INSTRUMENTS.filter(inst => {
    if (activeTab === "boom"  && inst.type !== "boom")  return false;
    if (activeTab === "crash" && inst.type !== "crash") return false;
    if (filter === "signal") {
      const s = signals[inst.id]?.signal;
      return s === "BUY" || s === "SELL";
    }
    return true;
  });

  const totalSignals = INSTRUMENTS.filter(i => {
    const s = signals[i.id]?.signal;
    return s === "BUY" || s === "SELL";
  }).length;
  const totalBots  = Object.values(activeBots).filter(Boolean).length;
  const totalTicks = Object.values(tickData).reduce((a, b) => a + b.length, 0);

  return (
    <div style={{
      minHeight: "100vh",
      background: "#0A0A0F",
      color: "#fff",
      fontFamily: "'Inter', -apple-system, sans-serif",
      paddingBottom: 32,
      maxWidth: 480,
      margin: "0 auto",
    }}>
      {/* ── Top bar ── */}
      <div style={{
        padding: "16px 20px 12px",
        background: "rgba(255,255,255,0.02)",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        position: "sticky", top: 0, zIndex: 10,
        backdropFilter: "blur(12px)",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: -0.5, color: "#fff" }}>
              Boom &amp; Crash
            </div>
            <div style={{ fontSize: 11, color: "#555", letterSpacing: 1, marginTop: 1 }}>SIGNAL TERMINAL</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={toggleSound}
              style={{
                width: 28, height: 28, borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)",
                background: soundEnabled ? "rgba(0,229,100,0.12)" : "rgba(255,255,255,0.04)",
                color: soundEnabled ? "#00E564" : "#666",
                fontSize: 14, cursor: "pointer", display: "flex",
                alignItems: "center", justifyContent: "center",
              }}
              aria-label={soundEnabled ? "Mute alerts" : "Unmute alerts"}
            >
              {soundEnabled ? "🔊" : "🔇"}
            </button>
            {totalBots > 0 && (
              <div style={{
                fontSize: 11, background: "rgba(0,229,100,0.15)", color: "#00E564",
                borderRadius: 6, padding: "3px 8px", border: "1px solid rgba(0,229,100,0.3)",
              }}>
                🤖 {totalBots} BOT{totalBots > 1 ? "S" : ""}
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{
                width: 7, height: 7, borderRadius: "50%",
                background: connected ? "#00E564" : "#FF4081",
                boxShadow: connected ? "0 0 6px #00E564" : "none",
              }} />
              <span style={{ fontSize: 11, color: connected ? "#00E564" : "#FF4081" }}>
                {connected ? "LIVE" : "RECONNECTING…"}
              </span>
            </div>
          </div>
        </div>
        {/* Stats row */}
        <div style={{ display: "flex", gap: 20, marginTop: 10 }}>
          {[
            { label: "Signals", value: totalSignals, color: totalSignals > 0 ? "#FFD700" : "#444" },
            { label: "Ticks",   value: totalTicks,   color: "#888" },
            { label: "Bots",    value: totalBots,    color: totalBots > 0  ? "#00E564" : "#444" },
            { label: "Alerts",  value: alerts.length,color: alerts.length  > 0 ? "#FF6400" : "#444" },
          ].map(s => (
            <div key={s.label} style={{ textAlign: "center" }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: s.color, fontFamily: "monospace" }}>{s.value}</div>
              <div style={{ fontSize: 10, color: "#555", letterSpacing: 0.5 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Tabs ── */}
      <div style={{ display: "flex", padding: "12px 20px 0", gap: 8 }}>
        {[
          { id: "boom",  label: "Boom",  color: "#00B8D4" },
          { id: "crash", label: "Crash", color: "#FF4081" },
          { id: "all",   label: "All",   color: "#888"    },
        ].map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
            padding: "6px 18px", borderRadius: 20, border: "none", cursor: "pointer",
            background: activeTab === t.id ? t.color : "rgba(255,255,255,0.06)",
            color:      activeTab === t.id ? "#fff"  : "#888",
            fontWeight: 600, fontSize: 13, transition: "all 0.2s",
          }}>{t.label}</button>
        ))}
        <button
          onClick={() => setFilter(f => f === "signal" ? "all" : "signal")}
          style={{
            marginLeft: "auto", padding: "6px 14px", borderRadius: 20, border: "none", cursor: "pointer",
            background: filter === "signal" ? "rgba(255,215,0,0.2)" : "rgba(255,255,255,0.06)",
            color:      filter === "signal" ? "#FFD700" : "#888",
            fontWeight: 600, fontSize: 12, transition: "all 0.2s",
          }}
        >⚡ Signals only</button>
      </div>

      {/* ── Cards ── */}
      <div style={{ padding: "12px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
        {visibleInstruments.length === 0 ? (
          <div style={{ textAlign: "center", color: "#555", padding: "40px 0", fontSize: 14 }}>
            {filter === "signal" ? "No active signals right now" : "No instruments to display"}
          </div>
        ) : visibleInstruments.map(inst => (
          <InstrumentCard
            key={inst.id}
            instrument={inst}
            ticks={tickData[inst.id] || []}
            signal={signals[inst.id] || { signal: "WAIT", strength: 0, rsi: null, emaFast: null, emaSlow: null }}
            onToggleBot={toggleBot}
            botActive={!!activeBots[inst.id]}
            alertCount={alertCounts[inst.label] || 0}
            ticksSinceSpike={ticksSinceSpike[inst.id] || 0}
          />
        ))}
      </div>

      {/* ── Performance / Trade log ── */}
      <div style={{ padding: "0 20px" }}>
        <TradeLog trades={tradeLog} onClear={clearTradeLog} />
      </div>

      {/* ── Alert log ── */}
      <div style={{ padding: "0 20px" }}>
        <AlertLog alerts={alerts} />
      </div>

      {/* ── Footer ── */}
      <div style={{ textAlign: "center", padding: "20px 20px 0", fontSize: 11, color: "#333" }}>
        Live data via Deriv WebSocket API · Signals are analytical tools, not financial advice
      </div>
    </div>
  );
}
      
