// ===================================================
// FILE: server.js
// DESCRIPTION: Main Backend Server (Node.js/Express)
// ===================================================

const express = require("express");
const http = require("http");
const cors = require("cors");
const WebSocket = require("ws");
const axios = require("axios");

// Import the Pattern Analyzer we created
const detectChartPatterns = require("./patternAnalyzer");

// --- CONFIGURATION ---
const SYMBOL = "btcusdt";
const INTERVAL = "1m";
const HIST_LIMIT = 200; // Keep last 200 candles in memory
const PORT = 4000;

// --- APP SETUP ---
const app = express();
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// --- GLOBAL STATE ---
let candles = []; 

// ===================================================
// UTILITY FUNCTIONS (INDICATORS)
// ===================================================

// 1. Calculate EMA (Exponential Moving Average)
function calcEMA(prices, period) {
  if (prices.length < period) return null;
  
  const k = 2 / (period + 1);
  
  // Step 1: SMA for the first period
  let sum = 0;
  for(let i=0; i<period; i++) sum += prices[i];
  let ema = sum / period;

  // Step 2: EMA for the rest
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] * k) + (ema * (1 - k));
  }
  return ema;
}

// 2. Calculate RSI (Wilder's Smoothing Method - Standard)
function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;

  let gains = 0, losses = 0;

  // Initial SMA of gains/losses
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Smoothed averages
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    const currentGain = diff > 0 ? diff : 0;
    const currentLoss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = ((avgGain * (period - 1)) + currentGain) / period;
    avgLoss = ((avgLoss * (period - 1)) + currentLoss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ===================================================
// CORE LOGIC: SIGNAL GENERATOR
// ===================================================

function analyzeMarket() {
  if (candles.length < 50) return; 

  const closes = candles.map(c => c.close);
  const lastClose = closes[closes.length - 1];

  // --- Calculate Indicators ---
  const ema5 = calcEMA(closes, 5);
  const ema20 = calcEMA(closes, 20);
  const rsi = calcRSI(closes, 14);

  // Safety check
  if (!ema5 || !ema20 || !rsi) return;

  // --- 1. Buy/Sell Signal Logic ---
  let signal = "HOLD";

  // BUY Condition: EMA Crossover + RSI Healthy + Price above EMA20
  if (ema5 > ema20 && rsi > 50 && rsi < 70 && lastClose > ema20) {
    signal = "BUY";
  }
  // SELL Condition: EMA Crossunder + RSI Weak + Price below EMA20
  else if (ema5 < ema20 && rsi < 50 && rsi > 30 && lastClose < ema20) {
    signal = "SELL";
  }

  // --- 2. Chart Pattern Detection ---
  const detectedPattern = detectChartPatterns(candles);

  // --- Prepare Payload ---
  const result = {
    symbol: SYMBOL.toUpperCase(),
    price: lastClose,
    signal: signal,
    pattern: detectedPattern || "NONE",
    indicators: {
      rsi: rsi.toFixed(2),
      ema5: ema5.toFixed(2),
      ema20: ema20.toFixed(2)
    },
    timestamp: new Date().toLocaleTimeString()
  };

  console.log(`[${result.timestamp}] Signal: ${signal} | Pattern: ${result.pattern} | RSI: ${result.indicators.rsi}`);
  
  // Broadcast to Frontend
  sendToFrontend(result);
}

function sendToFrontend(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// ===================================================
// DATA STREAMING (BINANCE)
// ===================================================

async function loadHistoricalData() {
  try {
    console.log("Fetching historical data...");
    const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL.toUpperCase()}&interval=${INTERVAL}&limit=${HIST_LIMIT}`;
    const res = await axios.get(url);
    
    // Format Binance Data
    candles = res.data.map(c => ({
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      time: c[0]
    }));
    
    console.log(`Loaded ${candles.length} candles.`);
  } catch (error) {
    console.error("Error loading history:", error.message);
  }
}

function connectBinanceWebSocket() {
  const wsUrl = `wss://stream.binance.com:9443/ws/${SYMBOL}@kline_${INTERVAL}`;
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => console.log("Connected to Binance WebSocket");
  
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (!msg.k) return;

    const k = msg.k;
    const newCandle = {
      open: parseFloat(k.o),
      high: parseFloat(k.h),
      low: parseFloat(k.l),
      close: parseFloat(k.c),
      time: k.t
    };

    if (k.x === false) {
      // Candle is still open (update the last candle)
      if (candles.length > 0) candles[candles.length - 1] = newCandle;
    } else {
      // Candle closed (push new candle)
      candles.push(newCandle);
      if (candles.length > HIST_LIMIT) candles.shift(); // Remove oldest
      
      // TRIGGER ANALYSIS ONLY ON CANDLE CLOSE
      analyzeMarket();
    }
  };

  ws.onclose = () => {
    console.log("Binance disconnected. Reconnecting in 3s...");
    setTimeout(connectBinanceWebSocket, 3000);
  };

  ws.onerror = (err) => console.error("WebSocket Error:", err.message);
}

// ===================================================
// START SERVER
// ===================================================

app.get("/", (req, res) => res.send("Trading Bot Backend is Running 🚀"));

server.listen(PORT, async () => {
  console.log(`Server started on http://localhost:${PORT}`);
  await loadHistoricalData();
  connectBinanceWebSocket();
});
