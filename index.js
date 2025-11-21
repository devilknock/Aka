// index.js (FULL UPGRADED VERSION)
const http = require("http");
const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");
const axios = require("axios");

// ----------------- CONFIG ------------------
const SYMBOL = process.env.SYMBOL || "ethusdt";
const INTERVAL = process.env.INTERVAL || "1m";
const HISTORICAL_LIMIT = 300; // old candles count to load initially

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

const PORT = process.env.PORT || 5000;

let ohlc = [];
let lastSignal = null;

// ================= HELPER FUNCTIONS =================

function ema(values, length) {
  const out = new Array(values.length).fill(null);
  if (!values.length) return out;

  const k = 2 / (length + 1);
  let prev = values[0];

  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  const deltas = values.map((v, i) => (i === 0 ? 0 : v - values[i - 1]));
  let gain = 0,
    loss = 0;

  for (let i = 1; i <= period; i++) {
    if (deltas[i] >= 0) gain += deltas[i];
    else loss -= deltas[i];
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-8));

  for (let i = period + 1; i < values.length; i++) {
    const d = deltas[i];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;

    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;

    out[i] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-8));
  }
  return out;
}

function broadcast(type, data) {
  const payload = JSON.stringify({ type, data });
  wssServer.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(payload);
  });
}

// ================= SIGNAL ENGINE =================

function analyzeAndSignal(ohlcArr) {
  const closes = ohlcArr.map((d) => d.close);

  const emaS = ema(closes, 9);
  const emaL = ema(closes, 21);
  const rsiArr = rsi(closes, 14);

  const i = closes.length - 1;
  if (i < 22) return { signal: "HOLD", reason: "Not enough data" };

  const prev = i - 1;
  const crossedUp = emaS[prev] <= emaL[prev] && emaS[i] > emaL[i];
  const crossedDown = emaS[prev] >= emaL[prev] && emaS[i] < emaL[i];

  const price = closes[i];
  const r = Math.round(rsiArr[i] ?? 50);

  if (crossedUp && r < 45) {
    return {
      signal: "BUY",
      entry: price,
      stopLoss: +(price - 0.5).toFixed(2),
      takeProfit: +(price + 1.5).toFixed(2),
      confidence: +Math.min(0.95, 0.6 + (45 - r) / 100).toFixed(2),
      reason: `EMA UP + RSI ${r}`,
      price,
      rsi: r,
    };
  }

  if (crossedDown && r > 65) {
    return {
      signal: "SELL",
      entry: price,
      stopLoss: +(price + 0.5).toFixed(2),
      takeProfit: +(price - 1.5).toFixed(2),
      confidence: +Math.min(0.95, 0.6 + (r - 65) / 100).toFixed(2),
      reason: `EMA DOWN + RSI ${r}`,
      price,
      rsi: r,
    };
  }

  return { signal: "HOLD", reason: `No cross (RSI ${r})`, price, rsi: r };
}

// ================= FETCH HISTORICAL OHLC =================

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
    console.log("Initial signal:", lastSignal.signal);

  } catch (err) {
    console.error("Error loading historical data:", err.message);
  }
}

// ================= BINANCE LIVE STREAM =================

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
        if (ohlc.length > 500) ohlc.shift();

        const result = analyzeAndSignal(ohlc);
        lastSignal = { ...result, symbol: SYMBOL, ts: Date.now() };
        broadcast("signal", lastSignal);
        console.log("Signal:", lastSignal.signal);
      }
    } catch (e) {
      console.error("WS parse error:", e);
    }
  });

  binanceSocket.on("close", () => {
    console.log("WS closed, reconnecting...");
    setTimeout(startLiveStream, 3000);
  });

  binanceSocket.on("error", () => {
    binanceSocket.terminate();
  });
}

// ================= RUN SERVER =================

server.listen(PORT, async () => {
  console.log("Server started on", PORT);
  console.log("Loading historical data...");
  await loadHistoricalCandles();
  startLiveStream();
});

w
