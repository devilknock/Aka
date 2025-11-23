// index.js (UPGRADED SIGNAL ENGINE + symbol switching)
// Node 16+ recommended.

const http = require("http");
const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");
const axios = require("axios");

// ----------------- CONFIG ------------------
let CURRENT_SYMBOL = (process.env.SYMBOL || "btcusdt").toLowerCase();
const INTERVAL = process.env.INTERVAL || "1m";
const HISTORICAL_LIMIT = parseInt(process.env.HISTORICAL_LIMIT || "300", 10);
const PORT = process.env.PORT || 5000;

// Signal tuning parameters (change as needed)
const EMA_SHORT = parseInt(process.env.EMA_SHORT || "9", 10);
const EMA_LONG = parseInt(process.env.EMA_LONG || "21", 10);
const RSI_PERIOD = parseInt(process.env.RSI_PERIOD || "14", 10);

// Realistic RSI thresholds
const RSI_BUY_MAX = parseFloat(process.env.RSI_BUY_MAX || "60");
const RSI_SELL_MIN = parseFloat(process.env.RSI_SELL_MIN || "40");

// Confirmation settings
const REQUIRE_CONFIRMATION = true;

const BINANCE_WS = (symbol = CURRENT_SYMBOL, interval = INTERVAL) =>
  `wss://stream.binance.com:9443/ws/${symbol}@kline_${interval}`;

const BINANCE_REST = (symbol = CURRENT_SYMBOL, interval = INTERVAL, limit = HISTORICAL_LIMIT) =>
  `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`;
// -------------------------------------------

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wssServer = new WebSocket.Server({ server });

let ohlc = []; // current symbol's candles
let lastSignal = null;
let binanceSocket = null;
let restarting = false; // avoid concurrent restarts

// =============== UTILITIES ===============

function ema(values, length) {
  const out = new Array(values.length).fill(null);
  if (!values.length || values.length < length) return out;

  const k = 2 / (length + 1);

  let sum = 0;
  for (let i = 0; i < length; i++) sum += values[i];
  let prevEma = sum / length;
  out[length - 1] = prevEma;

  for (let i = length; i < values.length; i++) {
    const v = values[i];
    const emaVal = v * k + prevEma * (1 - k);
    out[i] = emaVal;
    prevEma = emaVal;
  }
  return out;
}

function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gains += change;
    else losses += -change;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-8));

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-8));
  }
  return out;
}

function isCrossUp(emaShort, emaLong, i) {
  if (i <= 0) return false;
  return emaShort[i - 1] <= emaLong[i - 1] && emaShort[i] > emaLong[i];
}
function isCrossDown(emaShort, emaLong, i) {
  if (i <= 0) return false;
  return emaShort[i - 1] >= emaLong[i - 1] && emaShort[i] < emaLong[i];
}

function confirmedCrossUp(emaS, emaL, i) {
  if (!REQUIRE_CONFIRMATION) return isCrossUp(emaS, emaL, i);
  if (!isCrossUp(emaS, emaL, i)) return false;
  if (i + 1 >= emaS.length) return true;
  return emaS[i + 1] > emaL[i + 1];
}
function confirmedCrossDown(emaS, emaL, i) {
  if (!REQUIRE_CONFIRMATION) return isCrossDown(emaS, emaL, i);
  if (!isCrossDown(emaS, emaL, i)) return false;
  if (i + 1 >= emaS.length) return true;
  return emaS[i + 1] < emaL[i + 1];
}

function calcConfidence(base = 0.6, rsi, side) {
  let bonus = 0;
  if (side === "BUY") {
    bonus = Math.max(0, (RSI_BUY_MAX - rsi) / 100);
  } else {
    bonus = Math.max(0, (rsi - RSI_SELL_MIN) / 100);
  }
  const conf = Math.min(0.95, base + bonus);
  return +conf.toFixed(2);
}

function broadcast(type, data) {
  // include symbol if not present
  if (data && data.symbol === undefined) data.symbol = CURRENT_SYMBOL;
  const payload = JSON.stringify({ type, data });
  wssServer.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) {
      try {
        c.send(payload);
      } catch (e) {
        // ignore
      }
    }
  });
}

// =============== SIGNAL ENGINE ===============

function analyzeAndSignal(ohlcArr) {
  const closes = ohlcArr.map((d) => d.close);
  const len = closes.length;

  const emaS = ema(closes, EMA_SHORT);
  const emaL = ema(closes, EMA_LONG);
  const rsiArr = rsi(closes, RSI_PERIOD);

  const i = len - 1;
  if (i < EMA_LONG) return { signal: "HOLD", reason: "Not enough data", price: closes[i] ?? null };

  const price = closes[i];
  const r = Math.round(rsiArr[i] ?? 50);

  const up = confirmedCrossUp(emaS, emaL, i);
  const down = confirmedCrossDown(emaS, emaL, i);

  if (up && r <= RSI_BUY_MAX) {
    const entry = price;
    const stopLoss = +(price - Math.max(0.2, price * 0.002)).toFixed(2);
    const takeProfit = +(price + Math.max(0.6, price * 0.006)).toFixed(2);
    const confidence = calcConfidence(0.6, r, "BUY");
    return {
      signal: "BUY",
      entry,
      stopLoss,
      takeProfit,
      confidence,
      reason: `EMA cross up (S:${EMA_SHORT} over L:${EMA_LONG}) + RSI ${r} <= ${RSI_BUY_MAX}`,
      price,
      rsi: r,
    };
  }

  if (down && r >= RSI_SELL_MIN) {
    const entry = price;
    const stopLoss = +(price + Math.max(0.2, price * 0.002)).toFixed(2);
    const takeProfit = +(price - Math.max(0.6, price * 0.006)).toFixed(2);
    const confidence = calcConfidence(0.6, r, "SELL");
    return {
      signal: "SELL",
      entry,
      stopLoss,
      takeProfit,
      confidence,
      reason: `EMA cross down (S:${EMA_SHORT} below L:${EMA_LONG}) + RSI ${r} >= ${RSI_SELL_MIN}`,
      price,
      rsi: r,
    };
  }

  return { signal: "HOLD", reason: `No confirmed cross (RSI ${r})`, price, rsi: r };
}

// =============== HISTORICAL FETCH ===============

async function loadHistoricalCandles(symbol = CURRENT_SYMBOL) {
  try {
    console.log("Fetching historical candles for", symbol);
    const res = await axios.get(BINANCE_REST(symbol));
    // transform to consistent shape
    ohlc = res.data.map((c) => ({
      t: c[0],
      open: +c[1],
      high: +c[2],
      low: +c[3],
      close: +c[4],
      volume: +c[5],
      isFinal: true,
    }));

    console.log(`Loaded ${ohlc.length} historical candles for ${symbol}.`);
    const result = analyzeAndSignal(ohlc);
    lastSignal = { ...result, symbol, ts: Date.now() };
    broadcast("signal", lastSignal);
    console.log("Initial signal:", lastSignal.signal, "-", lastSignal.reason);
  } catch (err) {
    console.error("Error loading historical data:", err.message || err);
  }
}

// =============== LIVE STREAM ===============

function startLiveStream(symbol = CURRENT_SYMBOL) {
  // If a socket exists, close/terminate it first
  try {
    if (binanceSocket) {
      try { binanceSocket.terminate(); } catch (e) {}
      binanceSocket = null;
    }
  } catch (e) {}

  const url = BINANCE_WS(symbol);
  console.log("Connecting WS:", url);

  binanceSocket = new WebSocket(url);

  binanceSocket.on("open", () => {
    console.log("Live stream connected for", symbol);
  });

  binanceSocket.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      // Binance KLINE payload has 'k'
      if (!data.k) return;

      const k = data.k;
      const candle = {
        t: k.t,
        open: +k.o,
        high: +k.h,
        low: +k.l,
        close: +k.c,
        volume: +k.v,
        isFinal: k.x,
      };

      // broadcast price with symbol for frontend clarity
      broadcast("price", { t: candle.t, close: candle.close, symbol });

      if (candle.isFinal) {
        // ensure we only keep candles for current symbol
        ohlc.push(candle);
        if (ohlc.length > 2000) ohlc.shift();
        const result = analyzeAndSignal(ohlc);
        lastSignal = { ...result, symbol, ts: Date.now() };
        broadcast("signal", lastSignal);
        console.log(new Date(), "Signal:", lastSignal.signal, "-", lastSignal.reason);
      }
    } catch (e) {
      console.error("WS parse error:", e && e.message);
    }
  });

  binanceSocket.on("close", () => {
    console.log("WS closed for", symbol, " — reconnecting in 3s...");
    setTimeout(() => startLiveStream(symbol), 3000);
  });

  binanceSocket.on("error", (err) => {
    console.error("WS error:", err && err.message);
    try { binanceSocket.terminate(); } catch (e) {}
  });
}

// =============== HTTP ENDPOINTS ===============

app.get("/signal", (req, res) => {
  return res.json(lastSignal ?? { signal: "HOLD", reason: "Not ready", symbol: CURRENT_SYMBOL });
});

app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now(), symbol: CURRENT_SYMBOL }));

// small handy list (you can extend)
app.get("/available-symbols", (req, res) => {
  return res.json({
    symbols: ["btcusdt", "ethusdt", "bnbusdt", "xrpusdt", "adausdt", "solusdt", "dogeusdt"],
    current: CURRENT_SYMBOL,
  });
});

/**
 * POST /change-symbol
 * body: { symbol: "ethusdt" }
 *
 * Behaviour:
 * - validate symbol string
 * - set CURRENT_SYMBOL
 * - reload historical for new symbol
 * - restart live stream for new symbol
 * - broadcast updated lastSignal (after historical loaded)
 */
app.post("/change-symbol", async (req, res) => {
  const { symbol } = req.body || {};
  if (!symbol || typeof symbol !== "string") {
    return res.status(400).json({ ok: false, error: "symbol required" });
  }
  const s = symbol.trim().toLowerCase();
  // basic validation: letters/numbers only (e.g. btcusdt)
  if (!/^[a-z0-9]+$/.test(s)) {
    return res.status(400).json({ ok: false, error: "invalid symbol format" });
  }

  // Prevent concurrent restarts
  if (restarting) {
    return res.status(409).json({ ok: false, error: "restart in progress" });
  }

  try {
    restarting = true;
    console.log("Changing symbol ->", s);

    // set symbol first (affects BINANCE_* helpers)
    CURRENT_SYMBOL = s;

    // load historical for new symbol
    await loadHistoricalCandles(s);

    // restart live stream for new symbol
    startLiveStream(s);

    // broadcast a lightweight notice to clients
    broadcast("notice", { msg: `Symbol changed to ${s}`, symbol: s });

    restarting = false;
    return res.json({ ok: true, symbol: s });
  } catch (err) {
    restarting = false;
    console.error("change-symbol error:", err && err.message);
    return res.status(500).json({ ok: false, error: "failed to change symbol" });
  }
});

// optional debugging: push-ohlc (same as your frontend test)
app.post("/push-ohlc", (req, res) => {
  const arr = Array.isArray(req.body) ? req.body : null;
  if (!arr) return res.status(400).json({ ok: false, error: "expected array" });

  // convert incoming items to candle shape with ms timestamps
  arr.forEach((c) => {
    const t = Number(c.t) > 1e12 ? Number(c.t) : Number(c.t) * 1000;
    const candle = {
      t,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume || 0),
      isFinal: true,
    };
    ohlc.push(candle);
    if (ohlc.length > 2000) ohlc.shift();
    broadcast("price", { t: candle.t, close: candle.close, symbol: CURRENT_SYMBOL });
  });

  // re-run signal after pushing
  const result = analyzeAndSignal(ohlc);
  lastSignal = { ...result, symbol: CURRENT_SYMBOL, ts: Date.now() };
  broadcast("signal", lastSignal);

  return res.json({ ok: true, added: arr.length });
});

// =============== RUN SERVER ===============

server.listen(PORT, async () => {
  console.log("Server started on", PORT, "initial symbol:", CURRENT_SYMBOL);
  console.log("Loading historical data...");
  await loadHistoricalCandles(CURRENT_SYMBOL);
  startLiveStream(CURRENT_SYMBOL);
});
