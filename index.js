// index.js (UPGRADED SIGNAL ENGINE with Chart Switcher)
// Replace your current file with this. Node 16+ recommended.

const http = require("http");
const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");
const axios = require("axios");

// ----------------- CONFIG ------------------
let CURRENT_SYMBOL = process.env.SYMBOL || "btcusdt";
const INTERVAL = process.env.INTERVAL || "1m";
const HISTORICAL_LIMIT = parseInt(process.env.HISTORICAL_LIMIT || "300", 10);
const PORT = process.env.PORT || 5000;

// Signal tuning parameters (change as needed)
const EMA_SHORT = parseInt(process.env.EMA_SHORT || "9", 10);
const EMA_LONG = parseInt(process.env.EMA_LONG || "21", 10);
const RSI_PERIOD = parseInt(process.env.RSI_PERIOD || "14", 10);
const RSI_BUY_MAX = parseFloat(process.env.RSI_BUY_MAX || "60");
const RSI_SELL_MIN = parseFloat(process.env.RSI_SELL_MIN || "40");
const REQUIRE_CONFIRMATION = true; // require cross to hold for 1 candle after cross to confirm

// helpers to build endpoints for a given symbol
const binanceWsFor = (symbol = CURRENT_SYMBOL, interval = INTERVAL) =>
  `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_${interval}`;

const binanceRestFor = (symbol = CURRENT_SYMBOL, interval = INTERVAL, limit = HISTORICAL_LIMIT) =>
  `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`;

// -------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wssServer = new WebSocket.Server({ server });

let ohlc = [];
let lastSignal = null;
let binanceSocket = null;
let isSwitching = false;

// =============== INDICATOR FUNCTIONS ===============
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
function calcConfidence(base = 0.6, rsiVal, side) {
  let bonus = 0;
  if (side === "BUY") {
    bonus = Math.max(0, (RSI_BUY_MAX - rsiVal) / 100);
  } else {
    bonus = Math.max(0, (rsiVal - RSI_SELL_MIN) / 100);
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
function analyzeAndSignal(ohlcArr, symbolLabel = CURRENT_SYMBOL) {
  const closes = ohlcArr.map((d) => d.close);
  const len = closes.length;
  const emaS = ema(closes, EMA_SHORT);
  const emaL = ema(closes, EMA_LONG);
  const rsiArr = rsi(closes, RSI_PERIOD);
  const i = len - 1;
  if (i < EMA_LONG) return { signal: "HOLD", reason: "Not enough data", price: closes[i] ?? null, symbol: symbolLabel };
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
      symbol: symbolLabel,
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
      symbol: symbolLabel,
    };
  }

  return { signal: "HOLD", reason: `No confirmed cross (RSI ${r})`, price, rsi: r, symbol: symbolLabel };
}

// =============== HISTORICAL FETCH ===============
async function loadHistoricalCandlesFor(symbol) {
  try {
    console.log("Fetching historical candles for", symbol);
    const res = await axios.get(binanceRestFor(symbol));
    const data = res.data;
    ohlc = data.map((c) => ({
      t: c[0],
      open: +c[1],
      high: +c[2],
      low: +c[3],
      close: +c[4],
      volume: +c[5],
      isFinal: true,
    }));
    console.log(`Loaded ${ohlc.length} historical candles for ${symbol}.`);
    const result = analyzeAndSignal(ohlc, symbol);
    lastSignal = { ...result, symbol: symbol, ts: Date.now() };
    broadcast("signal", lastSignal);
    console.log("Initial signal:", lastSignal.signal, "-", lastSignal.reason);
  } catch (err) {
    console.error("Error loading historical data for", symbol, err && err.message);
  }
}

// =============== LIVE STREAM ===============
function startLiveStreamFor(symbol) {
  const url = binanceWsFor(symbol);
  console.log("Connecting WS:", url);
  try {
    binanceSocket = new WebSocket(url);

    binanceSocket.on("open", () => {
      console.log("Live stream connected for", symbol);
    });

    binanceSocket.on("message", (msg) => {
      try {
        const data = JSON.parse(msg.toString());
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

        // broadcast price ticks to frontends
        broadcast("price", { t: candle.t, close: candle.close, symbol });

        if (candle.isFinal) {
          ohlc.push(candle);
          if (ohlc.length > 2000) ohlc.shift();
          const result = analyzeAndSignal(ohlc, symbol);
          lastSignal = { ...result, symbol, ts: Date.now() };
          broadcast("signal", lastSignal);
          console.log(new Date(), "Signal:", lastSignal.signal, "-", lastSignal.reason);
        }
      } catch (e) {
        console.error("WS parse error:", e);
      }
    });

    binanceSocket.on("close", () => {
      console.log("WS closed for", symbol, "reconnecting in 3s...");
      // try to reopen only if not switching symbol
      setTimeout(() => {
        if (!isSwitching) startLiveStreamFor(CURRENT_SYMBOL);
      }, 3000);
    });

    binanceSocket.on("error", (err) => {
      console.error("WS error:", err && err.message);
      try { binanceSocket.terminate(); } catch (e) {}
    });
  } catch (err) {
    console.error("startLiveStreamFor exception:", err && err.message);
  }
}

// helper to cleanly switch symbols
async function switchSymbolTo(newSymbolRaw) {
  const newSymbol = String(newSymbolRaw || "").toLowerCase();
  if (!newSymbol) throw new Error("No symbol provided");
  if (newSymbol === CURRENT_SYMBOL.toLowerCase()) {
    return { ok: true, message: "Already on symbol", symbol: CURRENT_SYMBOL };
  }
  isSwitching = true;
  console.log("Switching symbol to", newSymbol);

  // close existing binance socket gracefully
  try {
    if (binanceSocket && binanceSocket.readyState === WebSocket.OPEN) {
      try { binanceSocket.removeAllListeners?.(); } catch (e) {}
      try { binanceSocket.close(); } catch (e) {}
    }
  } catch (e) {
    console.warn("Error closing old ws:", e && e.message);
  }
  binanceSocket = null;

  // set symbol, load historical, start new ws
  CURRENT_SYMBOL = newSymbol;
  await loadHistoricalCandlesFor(CURRENT_SYMBOL);
  startLiveStreamFor(CURRENT_SYMBOL);

  // notify clients symbol changed + new signal
  broadcast("symbol_changed", { symbol: CURRENT_SYMBOL, ts: Date.now() });
  broadcast("signal", lastSignal);

  isSwitching = false;
  return { ok: true, symbol: CURRENT_SYMBOL };
}

// =============== HTTP (endpoints) ===============
app.get("/signal", (req, res) => {
  return res.json(lastSignal ?? { signal: "HOLD", reason: "Not ready", symbol: CURRENT_SYMBOL });
});
// alias for compatibility
app.get("/api/last-signal", (req, res) => {
  return res.json(lastSignal ?? { signal: "HOLD", reason: "Not ready", symbol: CURRENT_SYMBOL });
});
app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now(), symbol: CURRENT_SYMBOL }));

// change-symbol endpoint (frontend will call this)
app.post("/change-symbol", async (req, res) => {
  // support both query and body
  const s = req.query.symbol || req.body.symbol;
  if (!s) return res.status(400).json({ ok: false, error: "symbol required (ex: BTCUSDT)" });
  try {
    const result = await switchSymbolTo(s);
    return res.json({ ok: true, symbol: result.symbol });
  } catch (err) {
    console.error("change-symbol error:", err && err.message);
    return res.status(500).json({ ok: false, error: err.message || "switch failed" });
  }
});

// quick list endpoint (optional) — frontend can use to show options
app.get("/available-symbols", (req, res) => {
  // you can expand this list as you like
  const list = ["btcusdt","ethusdt","bnbusdt","adausdt","xrpusdt","tatausdt","tatasteel","goldusdt"];
  return res.json({ ok: true, symbols: list });
});

// =============== WEBSOCKET (client connections) ===============
wssServer.on("connection", (ws, req) => {
  console.log("Client connected (ws)");
  // send current symbol + lastSignal on connect
  try {
    ws.send(JSON.stringify({ type: "symbol_changed", data: { symbol: CURRENT_SYMBOL, ts: Date.now() } }));
    if (lastSignal) ws.send(JSON.stringify({ type: "signal", data: lastSignal }));
  } catch (e) {}
  ws.on("close", () => {
    // console.log("client disconnected");
  });
});

// =============== RUN SERVER ===============
server.listen(PORT, async () => {
  console.log("Server started on", PORT);
  console.log("Initial symbol:", CURRENT_SYMBOL);
  await loadHistoricalCandlesFor(CURRENT_SYMBOL);
  startLiveStreamFor(CURRENT_SYMBOL);
});
