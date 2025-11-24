// index.js (UPGRADED SIGNAL ENGINE)
// Replace your current file with this. Node 16+ recommended.

const http = require("http");
const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");
const axios = require("axios");

// ----------------- CONFIG ------------------
const SYMBOL = process.env.SYMBOL || "btcusdt";
const INTERVAL = process.env.INTERVAL || "1m";
const HISTORICAL_LIMIT = parseInt(process.env.HISTORICAL_LIMIT || "300", 10);
const PORT = process.env.PORT || 5000;

// Signal tuning parameters (change as needed)
const EMA_SHORT = parseInt(process.env.EMA_SHORT || "9", 10);
const EMA_LONG = parseInt(process.env.EMA_LONG || "21", 10);
const RSI_PERIOD = parseInt(process.env.RSI_PERIOD || "14", 10);

// Realistic RSI thresholds
const RSI_BUY_MAX = parseFloat(process.env.RSI_BUY_MAX || "60");   // allow RSI up to this on buy
const RSI_SELL_MIN = parseFloat(process.env.RSI_SELL_MIN || "40"); // allow RSI down to this on sell

// Confirmation settings
const REQUIRE_CONFIRMATION = true; // require cross to hold for 1 candle after cross to confirm

const BINANCE_WS = (symbol = SYMBOL, interval = INTERVAL) =>
  `wss://stream.binance.com:9443/ws/${symbol}@kline_${interval}`;

const BINANCE_REST = (symbol = SYMBOL, interval = INTERVAL, limit = HISTORICAL_LIMIT) =>
  `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`;

// -------------------------------------------

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wssServer = new WebSocket.Server({ server });

let ohlc = [];
let lastSignal = null;

// =============== UTILITIES ===============

// EMA initialized with SMA for first 'length' points for stability
function ema(values, length) {
  const out = new Array(values.length).fill(null);
  if (!values.length || values.length < length) return out;

  const k = 2 / (length + 1);

  // compute initial SMA at index length-1
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

// Standard RSI (Wilder)
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

// simple helper that checks for EMA cross at index i (compares prev index)
function isCrossUp(emaShort, emaLong, i) {
  if (i <= 0) return false;
  return emaShort[i - 1] <= emaLong[i - 1] && emaShort[i] > emaLong[i];
}
function isCrossDown(emaShort, emaLong, i) {
  if (i <= 0) return false;
  return emaShort[i - 1] >= emaLong[i - 1] && emaShort[i] < emaLong[i];
}

// require the cross to be still valid at next candle (confirmation) to reduce noise
function confirmedCrossUp(emaS, emaL, i) {
  if (!REQUIRE_CONFIRMATION) return isCrossUp(emaS, emaL, i);
  // cross happened at i and still above at i+1 (if available)
  if (!isCrossUp(emaS, emaL, i)) return false;
  if (i + 1 >= emaS.length) return true; // can't confirm yet (use as-is)
  return emaS[i + 1] > emaL[i + 1];
}
function confirmedCrossDown(emaS, emaL, i) {
  if (!REQUIRE_CONFIRMATION) return isCrossDown(emaS, emaL, i);
  if (!isCrossDown(emaS, emaL, i)) return false;
  if (i + 1 >= emaS.length) return true;
  return emaS[i + 1] < emaL[i + 1];
}

// confidence calculation (simple, scale 0.0 - 0.95)
function calcConfidence(base = 0.6, rsi, side) {
  // side: "BUY" expects lower RSI better, "SELL" expects higher RSI better
  let bonus = 0;
  if (side === "BUY") {
    bonus = Math.max(0, (RSI_BUY_MAX - rsi) / 100); // smaller RSI => slightly higher confidence
  } else {
    bonus = Math.max(0, (rsi - RSI_SELL_MIN) / 100);
  }
  const conf = Math.min(0.95, base + bonus);
  return +conf.toFixed(2);
}

function broadcast(type, data) {
  const payload = JSON.stringify({ type, data });
  wssServer.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(payload);
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

  const prev = i - 1;
  const price = closes[i];
  const r = Math.round(rsiArr[i] ?? 50);

  const up = confirmedCrossUp(emaS, emaL, i);
  const down = confirmedCrossDown(emaS, emaL, i);

  // BUY condition: crossover up + RSI not overbought (<= RSI_BUY_MAX)
  if (up && r <= RSI_BUY_MAX) {
    const entry = price;
    const stopLoss = +(price - Math.max(0.2, price * 0.002)).toFixed(2); // small ATR-like buffer
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

  // SELL condition: crossover down + RSI not oversold (>= RSI_SELL_MIN)
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

  // No clear condition
  return { signal: "HOLD", reason: `No confirmed cross (RSI ${r})`, price, rsi: r };
}

// =============== HISTORICAL FETCH ===============

async function loadHistoricalCandles() {
  try {
    console.log("Fetching historical candles...");
    const res = await axios.get(BINANCE_REST());
    ohlc = res.data.map((c) => ({
      t: c[0],
      open: +c[1],
      high: +c[2],
      low: +c[3],
      close: +c[4],
      volume: +c[5],
      isFinal: true,
    }));

    console.log(`Loaded ${ohlc.length} historical candles.`);

    const result = analyzeAndSignal(ohlc);
    lastSignal = { ...result, symbol: SYMBOL, ts: Date.now() };

    broadcast("signal", lastSignal);
    console.log("Initial signal:", lastSignal.signal, "-", lastSignal.reason);
  } catch (err) {
    console.error("Error loading historical data:", err.message);
  }
}

// =============== LIVE STREAM ===============

let binanceSocket;

function startLiveStream() {
  const url = BINANCE_WS();
  console.log("Connecting WS:", url);

  binanceSocket = new WebSocket(url);

  binanceSocket.on("open", () => {
    console.log("Live stream connected.");
  });

  binanceSocket.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
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

      broadcast("price", { t: candle.t, close: candle.close });

      if (candle.isFinal) {
        ohlc.push(candle);
        if (ohlc.length > 2000) ohlc.shift(); // keep buffer
        const result = analyzeAndSignal(ohlc);
        lastSignal = { ...result, symbol: SYMBOL, ts: Date.now() };
        broadcast("signal", lastSignal);
        console.log(new Date(), "Signal:", lastSignal.signal, "-", lastSignal.reason);
      }
    } catch (e) {
      console.error("WS parse error:", e);
    }
  });

  binanceSocket.on("close", () => {
    console.log("WS closed, reconnecting in 3s...");
    setTimeout(startLiveStream, 3000);
  });

  binanceSocket.on("error", (err) => {
    console.error("WS error:", err && err.message);
    try { binanceSocket.terminate(); } catch (e) {}
  });
}

// =============== HTTP (optional endpoints) ===============

app.get("/signal", (req, res) => {
  return res.json(lastSignal ?? { signal: "HOLD", reason: "Not ready" });
});

app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

// =============== RUN SERVER ===============

server.listen(PORT, async () => {
  console.log("Server started on", PORT);
  console.log("Loading historical data...");
  await loadHistoricalCandles();
  startLiveStream();
});
