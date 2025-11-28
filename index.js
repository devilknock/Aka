// ---------------- CONFIG ----------------
const express = require("express");
const http = require("http");
const cors = require("cors");
const WebSocket = require("ws");
const axios = require("axios");

const detectChartPatterns = require("./patternAnalyzer");

const SYMBOL = "btcusdt";
const INTERVAL = "1m";             // 1-minute live candles
const HIST_LIMIT = 200;            // Load last 200 candles

// ------------- APP SETUP ---------------
const app = express();
app.use(cors());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ------------ GLOBAL DATA -------------
let candles = [];        // full OHLC list
let lastSignal = null;   // last Buy/Sell/Hold
let wsBinance = null;

// ------------ EMA FUNCTION -------------
function calcEMA(prices, period) {
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

// ------------ RSI FUNCTION -------------
function calcRSI(closes, length = 14) {
  if (closes.length < length + 1) return null;

  let gains = 0, losses = 0;

  for (let i = closes.length - length - 1; i < closes.length - 1; i++) {
    const diff = closes[i + 1] - closes[i];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  const avgGain = gains / length;
  const avgLoss = losses / length;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

// ------------ SIGNAL LOGIC -------------
function getSignal() {
  const closes = candles.map(c => parseFloat(c.close));
  if (closes.length < 20) return "HOLD";

  const ema5 = calcEMA(closes, 5);
  const ema20 = calcEMA(closes, 20);
  const rsi = calcRSI(closes);

  const lastClose = closes[closes.length - 1];

  let signal = "HOLD";

  // BUY Logic — TradingView style
  if (ema5 > ema20 && rsi > 55 && rsi < 70 && lastClose > ema20) {
    signal = "BUY";
  }

  // SELL Logic
  else if (ema5 < ema20 && rsi < 45 && rsi > 30 && lastClose < ema20) {
    signal = "SELL";
  }

  const result = {
    symbol: SYMBOL,
    signal,
    rsi: Math.round(rsi),
    ema5: ema5.toFixed(2),
    ema20: ema20.toFixed(2),
    time: new Date().toLocaleString(),
  };

  lastSignal = result;

  console.log("SIGNAL:", result);
  sendToFrontend({ type: "signal", data: result });
 
  // ------ CHART PATTERN DETECTION ------
const detectedPattern = detectChartPatterns(candles);
if (detectedPattern) {
  console.log("PATTERN:", detectedPattern);
  sendToFrontend({
    type: "pattern",
    data: {
      symbol: SYMBOL,
      pattern: detectedPattern,
      time: new Date().toLocaleString(),
    }
  });
 }
}

// ----------- BROADCAST FUNCTION --------
function sendToFrontend(msg) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(msg));
    }
  });
}

// --------- INITIAL HISTORICAL DATA -----
async function loadInitialCandles() {
  const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL.toUpperCase()}&interval=${INTERVAL}&limit=${HIST_LIMIT}`;
  const res = await axios.get(url);

  candles = res.data.map(c => ({
    open: c[1],
    close: c[4],
    time: c[0]
  }));
}

// ------------- LIVE WEBSOCKET ----------
function connectBinance() {
  const url = `wss://stream.binance.com:9443/ws/${SYMBOL}@kline_${INTERVAL}`;
  wsBinance = new WebSocket(url);

  wsBinance.onopen = () => console.log("Binance WS connected");
  wsBinance.onclose = () => {
    console.log("Binance WS closed — reconnecting...");
    setTimeout(connectBinance, 3000);
  };
  wsBinance.onerror = () => wsBinance.close();

  wsBinance.onmessage = msg => {
    const data = JSON.parse(msg.data);
    if (!data.k) return;

    const k = data.k; // candle data

    const candle = {
      open: k.o,
      close: k.c,
      time: k.t,
    };

    if (k.x === false) {
      // Candle running (update last)
      candles[candles.length - 1] = candle;
    } else {
      // Candle closed → push new
      candles.push(candle);
      if (candles.length > HIST_LIMIT) candles.shift();

      // NEW SIGNAL — every 1 minute
      getSignal();
    }

    sendToFrontend({ type: "price", data: candle });
  };
}

// ---------------- ROUTES ---------------
app.get("/", (req, res) => {
  res.send("Backend running 🚀");
});

// ------------- START SERVER ------------
server.listen(4000, async () => {
  console.log("Server running on port 4000");
  await loadInitialCandles();
  connectBinance();
});
