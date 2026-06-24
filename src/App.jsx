import { useState, useEffect, useRef, useCallback } from "react";

const INSTRUMENTS = [
  { id: "BOOM300N",  label: "Boom 300",   type: "boom",  color: "#00E5FF", avgInterval: 300  },
  { id: "BOOM500",   label: "Boom 500",   type: "boom",  color: "#00B8D4", avgInterval: 500  },
  { id: "BOOM1000",  label: "Boom 1000",  type: "boom",  color: "#0288D1", avgInterval: 1000 },
  { id: "CRASH300N", label: "Crash 300",  type: "crash", color: "#FF4081", avgInterval: 300  },
  { id: "CRASH500",  label: "Crash 500",  type: "crash", color: "#F50057", avgInterval: 500  },
  { id: "CRASH1000", label: "Crash 1000", type: "crash", color: "#C51162", avgInterval: 1000 },
];

const MAX_TICKS       = 300;
const EMA_FAST        = 20;
const EMA_SLOW        = 50;
const RSI_PERIOD      = 14;
const BB_PERIOD       = 20;
const BB_DEV          = 2;
const SPIKE_THRESH    = 0.003;
const ALERT_PCT       = 0.80;
const EVAL_TICKS      = 10;
const TRADE_LOG_KEY   = "boomCrashTradeLog";

// ── Audio & Haptics ───────────────────────────────────────────────────────────
let _ctx = null;
function getCtx() {
  const C = window.AudioContext || window.webkitAudioContext;
  if (!C) return null;
  if (!_ctx) _ctx = new C();
  if (_ctx.state === "suspended") _ctx.resume();
  return _ctx;
}
function tone(freq, dur = 0.15, delay = 0, type = "sine", vol = 0.25) {
  const ctx = getCtx(); if (!ctx) return;
  try {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq; g.gain.value = vol;
    o.connect(g); g.connect(ctx.destination);
    const t = ctx.currentTime + delay;
    o.start(t); o.stop(t + dur);
  } catch {}
}
function playSignal(sig) {
  if (sig === "BUY") {
    tone(523, 0.1, 0, "sine", 0.3); tone(659, 0.1, 0.11, "sine", 0.3); tone(784, 0.15, 0.22, "sine", 0.3);
  } else {
    tone(784, 0.1, 0, "sine", 0.3); tone(659, 0.1, 0.11, "sine", 0.3); tone(523, 0.15, 0.22, "sine", 0.3);
  }
}
function playSpike() { tone(1400, 0.08, 0, "square", 0.2); tone(1800, 0.08, 0.09, "square", 0.2); }
function playWatch()  { tone(740, 0.1, 0, "sine", 0.12); }
function vibe(p)      { try { navigator.vibrate?.(p); } catch {} }

// ── Indicators ────────────────────────────────────────────────────────────────
function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let e = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) e = prices[i] * k + e * (1 - k);
  return e;
}
function calcRSI(prices, period) {
  if (prices.length < period + 1) return null;
  const sl = prices.slice(-(period + 1));
  let g = 0, l = 0;
  for (let i = 1; i < sl.length; i++) { const d = sl[i] - sl[i-1]; if (d > 0) g += d; else l -= d; }
  const ag = g / period, al = l / period;
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}
function calcBB(prices) {
  if (prices.length < BB_PERIOD) return null;
  const sl = prices.slice(-BB_PERIOD);
  const mean = sl.reduce((a, b) => a + b, 0) / BB_PERIOD;
  const std  = Math.sqrt(sl.reduce((s, v) => s + (v - mean) ** 2, 0) / BB_PERIOD);
  return { upper: mean + BB_DEV * std, lower: mean - BB_DEV * std, middle: mean, std, squeeze: std / mean < 0.0008 };
}
function detectSpike(prices) {
  if (prices.length < 2) return false;
  const l = prices[prices.length - 1], p = prices[prices.length - 2];
  return Math.abs((l - p) / p) > SPIKE_THRESH;
}

// ── Signal Engine (new: tick-gated + BB) ─────────────────────────────────────
function evaluate(prices, type, ticksSince, avgInterval) {
  if (prices.length < EMA_SLOW + 1) return { ready: false, signal: null, strength: 0, rsi: null, emaFast: null, emaSlow: null, bb: null };
  const e20   = calcEMA(prices, EMA_FAST);
  const e50   = calcEMA(prices, EMA_SLOW);
  const r     = calcRSI(prices, RSI_PERIOD);
  const bands = calcBB(prices);
  const last  = prices[prices.length - 1];
  const tickPct = ticksSince / avgInterval;

  if (!e20 || !e50 || r === null || !bands)
    return { ready: false, signal: null, strength: 0, rsi: null, emaFast: e20, emaSlow: e50, bb: bands };

  // Gate: tick counter must reach 80% before any signal fires
  if (tickPct < ALERT_PCT)
    return { ready: false, signal: null, strength: 0, rsi: r.toFixed(1), emaFast: e20, emaSlow: e50, bb: bands };

  let score = 3; // base from tick threshold
  if (bands.squeeze) score += 2;

  if (type === "boom") {
    if (last > e20 && last > e50) score += 2; else if (last > e50) score += 1;
    if (e20 >= e50)               score += 1;
    if (r < 50)                   score += 2; else if (r < 60) score += 1;
    const ready = score >= 6;
    return { ready, signal: ready ? "BUY" : null, strength: Math.min(score, 10), rsi: r.toFixed(1), emaFast: e20, emaSlow: e50, bb: bands };
  } else {
    if (last < e20 && last < e50) score += 2; else if (last < e50) score += 1;
    if (e20 <= e50)               score += 1;
    if (r > 50)                   score += 2; else if (r > 40) score += 1;
    const ready = score >= 6;
    return { ready, signal: ready ? "SELL" : null, strength: Math.min(score, 10), rsi: r.toFixed(1), emaFast: e20, emaSlow: e50, bb: bands };
  }
}

function strengthLabel(s) {
  if (s >= 9) return { label: "STRONG",   color: "#00FF87" };
  if (s >= 7) return { label: "MODERATE", color: "#FFD700" };
  return             { label: "WEAK",     color: "#FF6B35" };
}

// ── Mini Chart ────────────────────────────────────────────────────────────────
function MiniChart({ ticks, color, gradId }) {
  if (ticks.length < 2) return <div style={{ height: 48 }} />;
  const vals  = ticks.slice(-60);
  const min   = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const W = 100, H = 48;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * W},${H - ((v - min) / range) * H}`).join(" ");
  const last = vals[vals.length - 1], prev = vals[vals.length - 2];
  const spike = Math.abs((last - prev) / prev) > SPIKE_THRESH;
  const dotY  = H - ((last - min) / range) * H;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 48 }}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${pts} ${W},${H}`} fill={`url(#${gradId})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
      {spike && <circle cx={W} cy={dotY} r="3" fill="#FFD700" />}
    </svg>
  );
}

// ── Instrument Card ───────────────────────────────────────────────────────────
function InstrumentCard({ instrument, ticks, result, spikeNow, ticksSince, price, onToggleBot, botActive, alertCount }) {
  const { ready, signal, strength, rsi, emaFast, emaSlow } = result;
  const tickPct  = Math.min((ticksSince / instrument.avgInterval) * 100, 100);
  const sl       = strengthLabel(strength);
  const isBoom   = instrument.type === "boom";
  const isHighZone = tickPct >= 80 && !spikeNow;

  const borderCol = spikeNow ? "#FFD700" : ready ? (isBoom ? "#00FF87" : "#FF4081") : isHighZone ? "#FF6400" : "rgba(255,255,255,0.07)";
  const cardBg    = spikeNow ? "rgba(255,215,0,0.07)" : ready ? (isBoom ? "rgba(0,255,135,0.05)" : "rgba(255,64,129,0.05)") : "rgba(255,255,255,0.03)";
  const glow      = spikeNow ? "0 0 20px rgba(255,215,0,0.18)" : ready ? `0 0 18px ${isBoom ? "rgba(0,255,135,0.12)" : "rgba(255,64,129,0.12)"}` : "none";

  return (
    <div style={{ background: cardBg, border: `1px solid ${borderCol}`, borderRadius: 16, padding: "14px 16px", transition: "all 0.3s", boxShadow: glow }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: instrument.color, boxShadow: `0 0 6px ${instrument.color}` }} />
          <span style={{ fontWeight: 800, fontSize: 14, color: "#fff", letterSpacing: 0.3 }}>{instrument.label}</span>
          {spikeNow    && <span style={{ fontSize: 10, background: "rgba(255,215,0,0.2)",  color: "#FFD700", borderRadius: 4, padding: "1px 6px", fontWeight: 700 }}>⚡ SPIKE</span>}
          {isHighZone  && !ready && <span style={{ fontSize: 10, background: "rgba(255,100,0,0.2)", color: "#FF6400", borderRadius: 4, padding: "1px 6px", fontWeight: 700 }}>👀 WATCH</span>}
          {alertCount > 0 && <span style={{ fontSize: 10, background: "rgba(255,100,0,0.2)", color: "#FF6400", borderRadius: 4, padding: "1px 6px" }}>🔔 {alertCount}</span>}
        </div>
        {/* Signal badge */}
        {ready ? (
          <span style={{
            background: isBoom ? "rgba(0,255,135,0.15)" : "rgba(255,64,129,0.15)",
            border: `1px solid ${isBoom ? "#00FF87" : "#FF4081"}`,
            color: isBoom ? "#00FF87" : "#FF4081",
            borderRadius: 6, padding: "2px 10px", fontFamily: "monospace", fontWeight: 700, fontSize: 13, letterSpacing: 1,
          }}>{signal === "BUY" ? "⬆ BUY" : "⬇ SELL"}</span>
        ) : (
          <span style={{ background: "rgba(255,255,255,0.05)", border: "1px solid #333", color: "#666", borderRadius: 6, padding: "2px 10px", fontFamily: "monospace", fontWeight: 700, fontSize: 13 }}>— WAIT</span>
        )}
      </div>

      {/* Price */}
      <div style={{ fontSize: 22, fontWeight: 900, color: "#fff", fontFamily: "monospace", marginBottom: 6 }}>
        {price !== undefined ? price.toFixed(2) : "—"}
      </div>

      {/* Mini chart */}
      <MiniChart ticks={ticks} color={instrument.color} gradId={`g-${instrument.id}`} />

      {/* Indicators row */}
      <div style={{ display: "flex", gap: 12, marginTop: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: "#888" }}>RSI <span style={{ color: "#ccc" }}>{rsi ?? "—"}</span></span>
        <span style={{ fontSize: 11, color: "#888" }}>EMA20 <span style={{ color: "#ccc" }}>{emaFast !== null ? emaFast.toFixed(2) : "—"}</span></span>
        <span style={{ fontSize: 11, color: "#888" }}>EMA50 <span style={{ color: "#ccc" }}>{emaSlow !== null ? emaSlow.toFixed(2) : "—"}</span></span>
      </div>

      {/* Tick countdown */}
      <div style={{ marginBottom: 10, background: "rgba(0,0,0,0.25)", borderRadius: 10, padding: "8px 12px", border: `1px solid ${isHighZone ? "rgba(255,100,0,0.2)" : "rgba(255,255,255,0.05)"}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
          <span style={{ fontSize: 10, color: "#444", letterSpacing: 1 }}>TICK COUNTDOWN</span>
          <span style={{ fontSize: 10, fontWeight: 700, color: spikeNow ? "#FFD700" : tickPct >= 80 ? "#FF6400" : tickPct >= 50 ? "#FFD700" : "#00B8D4" }}>
            {spikeNow ? "⚡ RESET" : tickPct >= 80 ? "🔥 ALERT ZONE" : tickPct >= 50 ? "BUILDING" : "WAITING"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 6 }}>
          <span style={{ fontSize: 30, fontWeight: 900, fontFamily: "monospace", color: spikeNow ? "#FFD700" : tickPct >= 80 ? "#FF6400" : "#fff", letterSpacing: -1 }}>
            {spikeNow ? "000" : String(ticksSince).padStart(3, "0")}
          </span>
          <span style={{ fontSize: 12, color: "#444", fontFamily: "monospace" }}>/ {instrument.avgInterval}</span>
          <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 800, fontFamily: "monospace", color: tickPct >= 80 ? "#FF6400" : "#555" }}>
            {spikeNow ? "100%" : `${tickPct.toFixed(0)}%`}
          </span>
        </div>
        <div style={{ position: "relative", height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 3 }}>
          <div style={{ width: `${spikeNow ? 100 : tickPct}%`, height: "100%", borderRadius: 3, background: spikeNow ? "#FFD700" : tickPct >= 80 ? "#FF6400" : tickPct >= 50 ? "#FFD700" : "#00B8D4", transition: "width 0.3s" }} />
          <div style={{ position: "absolute", top: -3, left: "80%", width: 2, height: 10, background: "rgba(255,200,0,0.6)", borderRadius: 1 }} />
        </div>
      </div>

      {/* Signal state panel */}
      {ready ? (
        <div style={{ textAlign: "center", padding: "12px 0", background: isBoom ? "rgba(0,255,135,0.07)" : "rgba(255,64,129,0.07)", borderRadius: 10, border: `1px solid ${isBoom ? "rgba(0,255,135,0.2)" : "rgba(255,64,129,0.2)"}`, marginBottom: 10 }}>
          <div style={{ fontSize: 10, color: "#666", letterSpacing: 2, marginBottom: 4 }}>SPIKE IMMINENT</div>
          <div style={{ fontSize: 26, fontWeight: 900, letterSpacing: 2, color: isBoom ? "#00FF87" : "#FF4081", textShadow: `0 0 16px ${isBoom ? "rgba(0,255,135,0.5)" : "rgba(255,64,129,0.5)"}` }}>
            {signal === "BUY" ? "▲ BUY NOW" : "▼ SELL NOW"}
          </div>
          <div style={{ marginTop: 8, display: "flex", justifyContent: "center", gap: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: sl.color, background: `${sl.color}18`, borderRadius: 6, padding: "2px 8px", border: `1px solid ${sl.color}44` }}>{sl.label}</span>
            <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
              {[...Array(10)].map((_, i) => (
                <div key={i} style={{ width: 4, height: 9, borderRadius: 2, background: i < strength ? sl.color : "rgba(255,255,255,0.08)" }} />
              ))}
            </div>
          </div>
        </div>
      ) : spikeNow ? (
        <div style={{ textAlign: "center", padding: "10px 0", background: "rgba(255,215,0,0.08)", borderRadius: 10, border: "1px solid rgba(255,215,0,0.25)", marginBottom: 10 }}>
          <div style={{ fontSize: 20 }}>⚡</div>
          <div style={{ fontSize: 13, fontWeight: 900, color: "#FFD700", letterSpacing: 2 }}>SPIKE DETECTED</div>
          <div style={{ fontSize: 10, color: "#666", marginTop: 2 }}>Waiting for next setup…</div>
        </div>
      ) : isHighZone ? (
        <div style={{ textAlign: "center", padding: "10px 0", background: "rgba(255,100,0,0.05)", borderRadius: 10, border: "1px solid rgba(255,100,0,0.18)", marginBottom: 10 }}>
          <div style={{ fontSize: 18 }}>👀</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#FF6400", letterSpacing: 1 }}>WATCHING</div>
          <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>Conditions not yet aligned</div>
        </div>
      ) : (
        <div style={{ textAlign: "center", padding: "10px 0", marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: "#333", letterSpacing: 1 }}>— WAITING —</div>
          <div style={{ fontSize: 10, color: "#2a2a2a", marginTop: 3 }}>{(100 - tickPct).toFixed(0)}% of cycle remaining</div>
        </div>
      )}

      {/* Bot toggle */}
      <button onClick={() => onToggleBot(instrument.id)} style={{
        width: "100%", padding: "7px 0", borderRadius: 8, border: "none",
        background: botActive ? "rgba(255,64,129,0.2)" : "rgba(0,229,100,0.12)",
        color: botActive ? "#FF4081" : "#00E564",
        fontWeight: 700, fontSize: 12, cursor: "pointer", letterSpacing: 1, transition: "all 0.2s",
      }}>
        {botActive ? "⏹ STOP BOT" : "▶ START BOT"}
      </button>
    </div>
  );
}

// ── Alert Log ─────────────────────────────────────────────────────────────────
function AlertLog({ alerts }) {
  if (alerts.length === 0) return null;
  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ fontSize: 12, color: "#666", marginBottom: 8, letterSpacing: 1, textTransform: "uppercase" }}>Recent Alerts</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 160, overflowY: "auto" }}>
        {[...alerts].reverse().map((a, i) => (
          <div key={i} style={{ background: "rgba(255,255,255,0.04)", borderRadius: 8, padding: "8px 12px", display: "flex", justifyContent: "space-between", alignItems: "center", borderLeft: `3px solid ${a.type === "spike" ? "#FFD700" : a.type === "watch" ? "#FF6400" : a.signal === "BUY" ? "#00FF87" : "#FF4081"}` }}>
            <div>
              <span style={{ fontSize: 12, color: "#fff", fontWeight: 600 }}>{a.label}</span>
              <span style={{ fontSize: 11, color: "#888", marginLeft: 8 }}>
                {a.type === "spike" ? "⚡ Spike" : a.type === "watch" ? "👀 Alert zone" : a.signal === "BUY" ? "⬆ Buy signal" : "⬇ Sell signal"}
              </span>
            </div>
            <span style={{ fontSize: 10, color: "#555" }}>{a.time}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Trade Log / Performance ───────────────────────────────────────────────────
function StatBox({ label, value, color }) {
  return (
    <div style={{ flex: 1, textAlign: "center", background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: "8px 4px" }}>
      <div style={{ fontSize: 15, fontWeight: 700, color, fontFamily: "monospace" }}>{value}</div>
      <div style={{ fontSize: 9, color: "#666", letterSpacing: 0.5, marginTop: 2 }}>{label}</div>
    </div>
  );
}

function TradeLog({ trades, onClear }) {
  if (trades.length === 0) return (
    <div style={{ marginTop: 20 }}>
      <div style={{ fontSize: 12, color: "#666", marginBottom: 8, letterSpacing: 1, textTransform: "uppercase" }}>Performance</div>
      <div style={{ fontSize: 12, color: "#555", textAlign: "center", padding: "16px 0" }}>
        No closed signals yet — results appear {EVAL_TICKS} ticks after each signal fires
      </div>
    </div>
  );
  const wins    = trades.filter(t => t.win).length;
  const losses  = trades.length - wins;
  const winRate = ((wins / trades.length) * 100).toFixed(1);
  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: "#666", letterSpacing: 1, textTransform: "uppercase" }}>Performance</div>
        <button onClick={onClear} style={{ fontSize: 10, color: "#666", background: "none", border: "none", cursor: "pointer" }}>Clear</button>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <StatBox label="WIN RATE" value={`${winRate}%`} color={winRate >= 50 ? "#00FF87" : "#FF4081"} />
        <StatBox label="WINS"     value={wins}           color="#00FF87" />
        <StatBox label="LOSSES"   value={losses}          color="#FF4081" />
        <StatBox label="TOTAL"    value={trades.length}   color="#888" />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 200, overflowY: "auto" }}>
        {trades.slice(0, 30).map(t => (
          <div key={t.id} style={{ background: "rgba(255,255,255,0.04)", borderRadius: 8, padding: "8px 12px", display: "flex", justifyContent: "space-between", alignItems: "center", borderLeft: `3px solid ${t.win ? "#00FF87" : "#FF4081"}` }}>
            <div>
              <span style={{ fontSize: 12, color: "#fff", fontWeight: 600 }}>{t.label}</span>
              <span style={{ fontSize: 11, color: "#888", marginLeft: 8 }}>{t.signal === "BUY" ? "⬆" : "⬇"} {t.signal} · {t.win ? "✅ WIN" : "❌ LOSS"}</span>
            </div>
            <span style={{ fontSize: 10, color: "#555" }}>{t.closedTime}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [tickData,        setTickData]        = useState({});
  const [results,         setResults]         = useState({});
  const [spikes,          setSpikes]          = useState({});
  const [ticksSince,      setTicksSince]      = useState({});
  const [prices,          setPrices]          = useState({});
  const [activeBots,      setActiveBots]      = useState({});
  const [alerts,          setAlerts]          = useState([]);
  const [tradeLog,        setTradeLog]        = useState([]);
  const [connected,       setConnected]       = useState(false);
  const [soundOn,         setSoundOn]         = useState(true);
  const [activeTab,       setActiveTab]       = useState("all");

  const wsRef          = useRef(null);
  const soundRef       = useRef(true);
  const ticksSinceRef  = useRef({});
  const prevResultsRef = useRef({});
  const prevSpikeRef   = useRef({});
  const prevZoneRef    = useRef({});
  const alertsRef      = useRef([]);
  const tradeLogRef    = useRef([]);
  const openTradesRef  = useRef({});

  useEffect(() => { soundRef.current = soundOn; }, [soundOn]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(TRADE_LOG_KEY);
      if (saved) { const p = JSON.parse(saved); tradeLogRef.current = p; setTradeLog(p); }
    } catch {}
  }, []);

  const persistTrades = useCallback((log) => {
    try { localStorage.setItem(TRADE_LOG_KEY, JSON.stringify(log.slice(0, 200))); } catch {}
  }, []);

  const clearTrades = useCallback(() => {
    tradeLogRef.current = []; setTradeLog([]);
    try { localStorage.removeItem(TRADE_LOG_KEY); } catch {}
  }, []);

  const addAlert = useCallback((a) => {
    alertsRef.current = [a, ...alertsRef.current].slice(0, 50);
    setAlerts([...alertsRef.current]);
    if (!soundRef.current) return;
    if (a.type === "spike")  { playSpike();         vibe([80, 40, 80]); }
    if (a.type === "signal") { playSignal(a.signal); vibe(a.signal === "BUY" ? [200, 80, 200] : [100, 50, 100, 50, 200]); }
    if (a.type === "watch")  { playWatch();          vibe([40]); }
  }, []);

  const connectWS = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    const ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      INSTRUMENTS.forEach(i => ws.send(JSON.stringify({ ticks: i.id, subscribe: 1 })));
    };

    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.msg_type !== "tick" || !msg.tick) return;
      const { symbol, quote } = msg.tick;
      const inst = INSTRUMENTS.find(i => i.id === symbol);
      if (!inst) return;
      const time = new Date().toLocaleTimeString();

      setTickData(prev => {
        const existing = prev[symbol] || [];
        const updated  = [...existing, quote].slice(-MAX_TICKS);

        // Spike
        const wasSpike = detectSpike(existing);
        const nowSpike = detectSpike(updated);
        if (nowSpike && !wasSpike) addAlert({ label: inst.label, type: "spike", time });

        // Tick counter
        const prevCount = ticksSinceRef.current[symbol] ?? 0;
        const newCount  = nowSpike ? 0 : prevCount + 1;
        ticksSinceRef.current[symbol] = newCount;
        setTicksSince(ts => ({ ...ts, [symbol]: newCount }));

        // Watch zone transition
        const tickPct  = newCount / inst.avgInterval;
        const prevZone = prevZoneRef.current[symbol] ?? "low";
        const currZone = tickPct >= 0.8 ? "high" : tickPct >= 0.5 ? "mid" : "low";
        if (currZone === "high" && prevZone !== "high") addAlert({ label: inst.label, type: "watch", time });
        prevZoneRef.current[symbol] = currZone;

        // Evaluate
        const result    = evaluate(updated, inst.type, newCount, inst.avgInterval);
        const prevReady = prevResultsRef.current[symbol]?.ready;

        // Signal transition alert
        if (result.ready && !prevReady)
          addAlert({ label: inst.label, signal: result.signal, type: "signal", time });

        // Open trade on new signal
        if (result.ready && !prevReady && !openTradesRef.current[symbol])
          openTradesRef.current[symbol] = { entryPrice: quote, ticksElapsed: 0, signal: result.signal, time, label: inst.label };

        // Progress open trade
        const openTrade = openTradesRef.current[symbol];
        if (openTrade) {
          const elapsed = openTrade.ticksElapsed + 1;
          if (elapsed >= EVAL_TICKS) {
            const win = openTrade.signal === "BUY" ? quote > openTrade.entryPrice : quote < openTrade.entryPrice;
            const closed = {
              id: `${symbol}-${openTrade.time}-${Math.random().toString(36).slice(2,6)}`,
              label: openTrade.label, signal: openTrade.signal,
              entryPrice: openTrade.entryPrice, exitPrice: quote,
              win, time: openTrade.time, closedTime: time,
            };
            tradeLogRef.current = [closed, ...tradeLogRef.current].slice(0, 200);
            setTradeLog([...tradeLogRef.current]);
            persistTrades(tradeLogRef.current);
            delete openTradesRef.current[symbol];
          } else {
            openTradesRef.current[symbol] = { ...openTrade, ticksElapsed: elapsed };
          }
        }

        prevResultsRef.current[symbol] = result;
        prevSpikeRef.current[symbol]   = nowSpike;
        setResults(r => ({ ...r, [symbol]: result }));
        setSpikes(s  => ({ ...s, [symbol]: nowSpike }));
        setPrices(p  => ({ ...p, [symbol]: quote }));

        return { ...prev, [symbol]: updated };
      });
    };

    ws.onclose = () => { setConnected(false); setTimeout(connectWS, 3000); };
    ws.onerror = () => ws.close();
  }, [addAlert, persistTrades]);

  useEffect(() => { connectWS(); return () => wsRef.current?.close(); }, [connectWS]);

  const toggleBot = useCallback((id) => {
    setActiveBots(prev => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const alertCounts = alerts.reduce((acc, a) => { acc[a.label] = (acc[a.label] || 0) + 1; return acc; }, {});
  const totalBots   = Object.values(activeBots).filter(Boolean).length;
  const activeSigs  = INSTRUMENTS.filter(i => results[i.id]?.ready).length;

  const visible = INSTRUMENTS.filter(i =>
    activeTab === "boom" ? i.type === "boom" : activeTab === "crash" ? i.type === "crash" : true
  );

  return (
    <div style={{ minHeight: "100vh", background: "#080810", color: "#fff", fontFamily: "'Inter', -apple-system, sans-serif", maxWidth: 480, margin: "0 auto", paddingBottom: 40 }}>
      {/* Top bar */}
      <div style={{ padding: "18px 20px 14px", background: "rgba(255,255,255,0.02)", borderBottom: "1px solid rgba(255,255,255,0.05)", position: "sticky", top: 0, zIndex: 10, backdropFilter: "blur(16px)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 900, letterSpacing: -0.5, color: "#fff" }}>Boom &amp; Crash</div>
            <div style={{ fontSize: 10, color: "#444", letterSpacing: 2, marginTop: 1 }}>SPIKE SIGNAL TERMINAL</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {activeSigs > 0 && (
              <div style={{ fontSize: 11, fontWeight: 800, background: "rgba(0,255,135,0.12)", color: "#00FF87", borderRadius: 8, padding: "4px 10px", border: "1px solid rgba(0,255,135,0.25)", animation: "pulse 1.5s infinite" }}>
                ⚡ {activeSigs} SIGNAL{activeSigs > 1 ? "S" : ""}
              </div>
            )}
            {totalBots > 0 && (
              <div style={{ fontSize: 11, background: "rgba(0,229,100,0.12)", color: "#00E564", borderRadius: 6, padding: "3px 8px", border: "1px solid rgba(0,229,100,0.25)" }}>
                🤖 {totalBots}
              </div>
            )}
            <button onClick={() => { getCtx(); setSoundOn(s => !s); }} style={{ width: 30, height: 30, borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", background: soundOn ? "rgba(0,255,135,0.1)" : "rgba(255,255,255,0.04)", color: soundOn ? "#00FF87" : "#555", fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {soundOn ? "🔊" : "🔇"}
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: connected ? "#00FF87" : "#FF4081", boxShadow: connected ? "0 0 8px #00FF87" : "none" }} />
              <span style={{ fontSize: 10, color: connected ? "#00FF87" : "#FF4081", letterSpacing: 0.5 }}>{connected ? "LIVE" : "RECONNECTING"}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", padding: "14px 20px 0", gap: 8 }}>
        {[{ id: "all", label: "All" }, { id: "boom", label: "Boom" }, { id: "crash", label: "Crash" }].map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{ padding: "7px 20px", borderRadius: 20, border: "none", cursor: "pointer", background: activeTab === t.id ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.04)", color: activeTab === t.id ? "#fff" : "#666", fontWeight: 700, fontSize: 12, letterSpacing: 0.5, transition: "all 0.2s" }}>{t.label}</button>
        ))}
      </div>

      {/* Cards */}
      <div style={{ padding: "14px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
        {visible.map(inst => (
          <InstrumentCard
            key={inst.id}
            instrument={inst}
            ticks={tickData[inst.id] || []}
            result={results[inst.id] || { ready: false, signal: null, strength: 0, rsi: null, emaFast: null, emaSlow: null }}
            spikeNow={!!spikes[inst.id]}
            ticksSince={ticksSince[inst.id] || 0}
            price={prices[inst.id]}
            onToggleBot={toggleBot}
            botActive={!!activeBots[inst.id]}
            alertCount={alertCounts[inst.label] || 0}
          />
        ))}
      </div>

      {/* Performance & Alerts */}
      <div style={{ padding: "0 20px" }}>
        <TradeLog trades={tradeLog} onClear={clearTrades} />
        <AlertLog alerts={alerts} />
      </div>

      <div style={{ textAlign: "center", fontSize: 10, color: "#2a2a2a", padding: "12px 20px" }}>
        Live via Deriv WebSocket · Signals are analytical tools, not financial advice
      </div>

      <style>{`
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.6; } }
      `}</style>
    </div>
  );
}
