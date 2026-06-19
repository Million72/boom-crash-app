import { useState, useEffect, useRef, useCallback } from "react";

const INSTRUMENTS = [
  { id: "BOOM300N",  label: "Boom 300",   type: "boom",  color: "#00E5FF" },
  { id: "BOOM500",   label: "Boom 500",   type: "boom",  color: "#00B8D4" },
  { id: "BOOM1000",  label: "Boom 1000",  type: "boom",  color: "#0288D1" },
  { id: "CRASH300N", label: "Crash 300",  type: "crash", color: "#FF4081" },
  { id: "CRASH500",  label: "Crash 500",  type: "crash", color: "#F50057" },
  { id: "CRASH1000", label: "Crash 1000", type: "crash", color: "#C51162" },
];

const MAX_TICKS      = 200;
const EMA_FAST       = 9;
const EMA_SLOW       = 21;
const RSI_PERIOD     = 14;
const SPIKE_THRESHOLD = 0.003;

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

function InstrumentCard({ instrument, ticks, signal, onToggleBot, botActive, alertCount }) {
  const isSpike = detectSpike(ticks);
  const last    = ticks[ticks.length - 1];
  const prev    = ticks[ticks.length - 2];
  const change  = (last !== undefined && prev) ? ((last - prev) / prev * 100) : 0;
  // stable gradient id derived from instrument id (no spaces / special chars)
  const gradId  = `grad-${instrument.id}`;

  return (
    <div style={{
      background:    "rgba(255,255,255,0.04)",
      border:        `1px solid ${isSpike ? "#FFD700" : "rgba(255,255,255,0.08)"}`,
      borderRadius:  14,
      padding:       "14px 16px",
      transition:    "border-color 0.3s",
      boxShadow:     isSpike ? "0 0 16px rgba(255,215,0,0.15)" : "none",
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
        {[...alerts].reverse().map((a, i) => (
          <div key={i} style={{
            background: "rgba(255,255,255,0.04)", borderRadius: 8, padding: "8px 12px",
            display: "flex", justifyContent: "space-between", alignItems: "center",
            borderLeft: `3px solid ${a.type === "spike" ? "#FFD700" : a.signal === "BUY" ? "#00E564" : "#FF4081"}`,
          }}>
            <div>
              <span style={{ fontSize: 12, color: "#fff", fontWeight: 600 }}>{a.label}</span>
              <span style={{ fontSize: 11, color: "#888", marginLeft: 8 }}>
                {a.type === "spike" ? "⚡ Spike detected" : a.signal === "BUY" ? "⬆ Buy signal" : "⬇ Sell signal"}
              </span>
            </div>
            <span style={{ fontSize: 10, color: "#555" }}>{a.time}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────

export default function App() {
  const [tickData,   setTickData]   = useState({});   // { [symbol]: number[] }
  const [signals,    setSignals]    = useState({});   // { [symbol]: SignalResult }
  const [prevSigs,   setPrevSigs]   = useState({});   // track previous signal to fire alert once
  const [activeBots, setActiveBots] = useState({});
  const [alerts,     setAlerts]     = useState([]);
  const [connected,  setConnected]  = useState(false);
  const [activeTab,  setActiveTab]  = useState("boom");
  const [filter,     setFilter]     = useState("all");

  const wsRef       = useRef(null);
  const alertsRef   = useRef([]);
  const prevSigsRef = useRef({});   // ref copy so ws handler always sees latest

  const addAlert = useCallback((alert) => {
    alertsRef.current = [alert, ...alertsRef.current].slice(0, 50);
    setAlerts([...alertsRef.current]);
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

        // Signal alert (only when transitioning from WAIT → BUY/SELL)
        if (sig.signal !== "WAIT" && prevSig === "WAIT") {
          addAlert({ label: inst.label, signal: sig.signal, type: "signal", time });
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
  }, [addAlert]);

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
          />
        ))}
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
