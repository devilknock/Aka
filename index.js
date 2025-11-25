// index.js (backend) -- PORT 4000
const express = require("express");
const http = require("http");
const cors = require("cors");
const WebSocket = require("ws");
const axios = require("axios");

const detectChartPatterns = require("./patternAnalyzer");

const SYMBOL = "btcusdt";
const INTERVAL = "1m";
const HIST_LIMIT = 200;

const app = express();
app.use(cors());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let candles = [];
let lastSignal = null;
let wsBinance = null;

// ---------- Helpers ----------
function calcEMA(prices, period) {
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, length = 14) {
  if (!closes || closes.length < length + 1) return 50;
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

function sendToFrontend(msg) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(msg));
    }
  });
}

// ------------ Load initial candles ------------
async function loadInitialCandles() {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL.toUpperCase()}&interval=${INTERVAL}&limit=${HIST_LIMIT}`;
    const res = await axios.get(url, { timeout: 10000 });
    candles = res.data.map(c => ({
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      time: c[0]
    }));
    console.log("Loaded", candles.length, "historical candles");
  } catch (err) {
    console.error("Failed to load initial candles:", err.message);
    candles = [];
  }
}

// ------------ Signal & Combined SL/TP logic ------------
async function getSignal() {
  try {
    const closes = candles.map(c => Number(c.close));
    if (closes.length < 20) return;

    const ema5 = calcEMA(closes, 5);
    const ema20 = calcEMA(closes, 20);
    const rsi = calcRSI(closes);

    const lastCandle = candles[candles.length - 1];
    const lastClose = Number(lastCandle.close);

    let signal = "HOLD";

    if (ema5 > ema20 && rsi > 55 && rsi < 70 && lastClose > ema20) signal = "BUY";
    else if (ema5 < ema20 && rsi < 45 && rsi > 30 && lastClose < ema20) signal = "SELL";

    // signal-based SL/TP
    let signalSL = null;
    let signalTP = null;
    if (signal === "BUY") {
      signalSL = Number((lastClose * 0.995).toFixed(4));
      signalTP = Number((lastClose * 1.01).toFixed(4));
    } else if (signal === "SELL") {
      signalSL = Number((lastClose * 1.005).toFixed(4));
      signalTP = Number((lastClose * 0.99).toFixed(4));
    }

    // priceRange (open-close absolute)
    const priceRange = Math.abs(Number(lastCandle.high) - Number(lastCandle.low));
    const priceRangeFmt = Number(priceRange.toFixed(4));

    // pattern detection
    const detected = detectChartPatterns(candles); // object or null
    if (detected) {
      sendToFrontend({
        type: "pattern",
        data: {
          symbol: SYMBOL,
          pattern: detected.name,
          support: detected.support,
          resistance: detected.resistance,
          structureLow: detected.structureLow,
          structureHigh: detected.structureHigh,
          time: new Date().toLocaleString()
        }
      });
    }

    // pattern-based SL/TP heuristics
    let patternSL = null;
    let patternTP = null;
    if (detected) {
      const p = detected;
      switch (p.name) {
        case "DOUBLE_TOP":
          patternSL = p.structureHigh;
          patternTP = Number((lastClose - (p.structureHigh - p.structureLow)).toFixed(4));
          break;
        case "DOUBLE_BOTTOM":
          patternSL = p.structureLow;
          patternTP = Number((lastClose + (p.structureHigh - p.structureLow)).toFixed(4));
          break;
        case "HEAD_SHOULDERS":
          patternSL = p.structureHigh;
          patternTP = Number((lastClose - (p.structureHigh - p.structureLow)).toFixed(4));
          break;
        case "INVERSE_HEAD_SHOULDERS":
          patternSL = p.structureLow;
          patternTP = Number((lastClose + (p.structureHigh - p.structureLow)).toFixed(4));
          break;
        case "ASCENDING_TRIANGLE":
          patternSL = p.support;
          patternTP = Number((lastClose + (p.resistance - p.support)).toFixed(4));
          break;
        case "DESCENDING_TRIANGLE":
          patternSL = p.resistance;
          patternTP = Number((lastClose - (p.resistance - p.support)).toFixed(4));
          break;
        case "CUP_HANDLE":
          patternSL = p.structureLow;
          patternTP = Number((lastClose + (p.structureHigh - p.structureLow)).toFixed(4));
          break;
        case "BULL_FLAG":
          patternSL = Number((lastClose * 0.99).toFixed(4));
          patternTP = Number((lastClose * 1.02).toFixed(4));
          break;
        case "BEAR_FLAG":
          patternSL = Number((lastClose * 1.01).toFixed(4));
          patternTP = Number((lastClose * 0.98).toFixed(4));
          break;
        case "RISING_WEDGE":
          patternSL = Number((lastClose * 0.997).toFixed(4));
          patternTP = Number((lastClose * 0.985).toFixed(4));
          break;
        case "FALLING_WEDGE":
          patternSL = Number((lastClose * 1.003).toFixed(4));
          patternTP = Number((lastClose * 1.015).toFixed(4));
          break;
        default:
          patternSL = null;
          patternTP = null;
      }
    }

    // Combine logic (if both exist)
    let finalSL = null;
    let finalTP = null;
    if (signalSL !== null && patternSL !== null) {
      // for SL we choose the more conservative (closer to price in direction of protection)
      // Use MIN for SL if BUY (lower), use MAX for SL if SELL (higher)
      if (signal === "BUY") finalSL = Number(Math.min(signalSL, patternSL).toFixed(4));
      else if (signal === "SELL") finalSL = Number(Math.max(signalSL, patternSL).toFixed(4));
    } else {
      finalSL = signalSL !== null ? signalSL : patternSL;
    }

    if (signalTP !== null && patternTP !== null) {
      // choose the larger target for TP
      if (signal === "BUY") finalTP = Number(Math.max(signalTP, patternTP).toFixed(4));
      else if (signal === "SELL") finalTP = Number(Math.min(signalTP, patternTP).toFixed(4));
    } else {
      finalTP = signalTP !== null ? signalTP : patternTP;
    }

    const result = {
      symbol: SYMBOL,
      signal,
      lastPrice: Number(lastClose.toFixed(4)),
      priceRange: priceRangeFmt,
      rsi: Math.round(rsi),
      ema5: Number(ema5.toFixed(2)),
      ema20: Number(ema20.toFixed(2)),
      signalSL: signalSL,
      signalTP: signalTP,
      pattern: detected ? detected.name : null,
      patternSL: patternSL,
      patternTP: patternTP,
      stopLoss: finalSL,
      takeProfit: finalTP,
      time: new Date().toLocaleString()
    };

    lastSignal = result;
    console.log("SIGNAL:", result);

    sendToFrontend({ type: "signal", data: result });
  } catch (err) {
    console.error("getSignal error:", err.message);
  }
}

// ------------- Binance websocket -------------
function connectBinance() {
  try {
    const url = `wss://stream.binance.com:9443/ws/${SYMBOL}@kline_${INTERVAL}`;
    wsBinance = new WebSocket(url);

    wsBinance.onopen = () => console.log("Binance WS connected");
    wsBinance.onclose = () => {
      console.log("Binance WS closed — reconnecting in 3s...");
      setTimeout(connectBinance, 3000);
    };
    wsBinance.onerror = (e) => {
      console.error("Binance WS error", e.message);
      if (wsBinance) wsBinance.close();
    };

    wsBinance.onmessage = msg => {
      try {
        const data = JSON.parse(msg.data);
        if (!data.k) return;
        const k = data.k;

        const candle = {
          open: k.o,
          high: k.h,
          low: k.l,
          close: k.c,
          time: k.t
        };

        if (k.x === false) {
          // update last candle
          if (candles.length === 0) candles.push(candle);
          else candles[candles.length - 1] = candle;
        } else {
          // closed candle
          candles.push(candle);
          if (candles.length > HIST_LIMIT) candles.shift();
          // New signal on closed candle
          getSignal();
        }

        sendToFrontend({ type: "price", data: candle });
      } catch (err) {
        console.error("ws msg parse:", err.message);
      }
    };
  } catch (err) {
    console.error("connectBinance error:", err.message);
    setTimeout(connectBinance, 3000);
  }
}

// --------------- Routes ----------------
app.get("/", (req, res) => {
  res.send("Backend running 🚀");
});

wss.on("connection", (socket) => {
  console.log("Frontend connected to WS");
  // send initial lastSignal if exists
  if (lastSignal) socket.send(JSON.stringify({ type: "signal", data: lastSignal }));
  // send last candle
  if (candles.length) socket.send(JSON.stringify({ type: "price", data: candles[candles.length - 1] }));
});

// --------------- Start server ----------------
server.listen(4000, async () => {
  console.log("Server running on port 4000");
  await loadInitialCandles();
  connectBinance();
});
