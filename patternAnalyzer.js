// ===================================================
// FILE: patternAnalyzer.js
// DESCRIPTION: Detects technical chart patterns
// ===================================================

function detectChartPatterns(candles) {
  // We need at least 30 candles to detect a valid pattern
  if (!candles || candles.length < 30) return null;

  // Convert string data to numbers for calculation
  const closes = candles.map(c => parseFloat(c.close));
  const highs = candles.map(c => parseFloat(c.high));
  const lows = candles.map(c => parseFloat(c.low));
  const len = closes.length;

  let pattern = null;

  // --- Helper Functions ---
  const getMax = (arr, start, end) => Math.max(...arr.slice(start, end));
  const getMin = (arr, start, end) => Math.min(...arr.slice(start, end));

  // 1. DOUBLE TOP ("M" Shape - Bearish Reversal)
  // Logic: Two peaks at similar height separated by a dip
  const dtLeftMax = getMax(highs, len - 20, len - 10);
  const dtRightMax = getMax(highs, len - 10, len);
  const dtNeckline = getMin(lows, len - 20, len); 
  const currentPrice = closes[len - 1];

  if (Math.abs(dtLeftMax - dtRightMax) < dtLeftMax * 0.005 && currentPrice < dtNeckline) {
    pattern = "DOUBLE_TOP";
  }

  // 2. DOUBLE BOTTOM ("W" Shape - Bullish Reversal)
  // Logic: Two bottoms at similar depth separated by a peak
  const dbLeftMin = getMin(lows, len - 20, len - 10);
  const dbRightMin = getMin(lows, len - 10, len);
  const dbNeckRes = getMax(highs, len - 20, len);

  if (Math.abs(dbLeftMin - dbRightMin) < dbLeftMin * 0.005 && currentPrice > dbNeckRes) {
    pattern = "DOUBLE_BOTTOM";
  }

  // 3. BULLISH FLAG (Trend Continuation)
  // Logic: Strong move up (Pole) followed by consolidation
  const poleStart = closes[len - 20];
  const poleTop = getMax(highs, len - 20, len - 10);
  const flagHigh = getMax(highs, len - 10, len);
  const flagLow = getMin(lows, len - 10, len);

  const isStrongMoveUp = poleTop > poleStart * 1.02; // At least 2% rise
  const isConsolidating = (flagHigh - flagLow) < (poleTop * 0.015); // Tight range
  const notRetracedTooMuch = flagLow > poleTop * 0.95; // Price held up

  if (isStrongMoveUp && isConsolidating && notRetracedTooMuch) {
    pattern = "BULL_FLAG";
  }

  // 4. BEARISH FLAG (Trend Continuation)
  // Logic: Strong move down followed by consolidation
  const poleBottom = getMin(lows, len - 20, len - 10);
  
  const isStrongMoveDown = poleBottom < poleStart * 0.98; // At least 2% drop
  const isConsolidatingBear = (flagHigh - flagLow) < (poleStart * 0.015);

  if (isStrongMoveDown && isConsolidatingBear) {
    pattern = "BEAR_FLAG";
  }

  // 5. HEAD AND SHOULDERS (Bearish Reversal)
  // Logic: Left Shoulder < Head > Right Shoulder
  const lHigh = getMax(highs, len - 30, len - 20);
  const headHigh = getMax(highs, len - 20, len - 10);
  const rHigh = getMax(highs, len - 10, len);

  if (headHigh > lHigh && headHigh > rHigh && 
      lHigh < headHigh * 0.99 && rHigh < headHigh * 0.99 && 
      Math.abs(lHigh - rHigh) < headHigh * 0.02) {
    pattern = "HEAD_SHOULDERS";
  }

  return pattern;
}

module.exports = detectChartPatterns;
      
