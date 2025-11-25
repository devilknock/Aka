// patternAnalyzer.js
// Simple pattern analyzer returning structured info
// Input: candles array of { open, close, time } (strings or numbers)
// Output: null or { name, support, resistance, structureLow, structureHigh }

function detectChartPatterns(candles) {
  if (!Array.isArray(candles) || candles.length < 50) return null;

  const closes = candles.map(c => Number(c.close));
  const len = closes.length;
  if (closes.some(isNaN)) return null;

  let pattern = null;

  // Helper values
  const last = (i) => closes[len - 1 - i];
  const slice = (n) => closes.slice(len - n, len);
  const last20 = slice(20);
  const last50 = slice(50);
  const structureLow = Math.min(...last20);
  const structureHigh = Math.max(...last20);

  // PRICE POINTS (recent pivots)
  const p1 = last(4); // 5th from end
  const p2 = last(2); // 3rd from end
  const p3 = last(0); // last

  // DOUBLE TOP (two highs then drop)
  if (p1 < p2 && Math.abs(p2 - p3) < p2 * 0.002 && p3 < p2) {
    pattern = "DOUBLE_TOP";
  }
  // DOUBLE BOTTOM
  else if (p1 > p2 && Math.abs(p2 - p3) < p2 * 0.002 && p3 > p2) {
    pattern = "DOUBLE_BOTTOM";
  }

  // HEAD & SHOULDERS (approx)
  const L = last(6);
  const H = last(4);
  const R = last(2);
  if (L < H && R < H && Math.abs(L - R) < H * 0.01) {
    pattern = "HEAD_SHOULDERS";
  }
  // INVERSE H&S
  if (L > H && R > H && Math.abs(L - R) < H * 0.01) {
    pattern = "INVERSE_HEAD_SHOULDERS";
  }

  // WEDGES / TRIANGLES using last 10/20
  const last10 = slice(10);
  const first5 = last10.slice(0, 5);
  const last5 = last10.slice(5);
  const firstAvg = first5.reduce((a, b) => a + b, 0) / 5;
  const lastAvg = last5.reduce((a, b) => a + b, 0) / 5;

  if (lastAvg > firstAvg && (last10[9] - last10[0]) < firstAvg * 0.02) {
    pattern = "RISING_WEDGE";
  }
  if (lastAvg < firstAvg && (last10[0] - last10[9]) < firstAvg * 0.02) {
    pattern = "FALLING_WEDGE";
  }

  // ASCENDING / DESCENDING TRIANGLE
  const highLine = Math.max(...last20);
  const lowLine = Math.min(...last20);
  const supportTrend = last20[0] < last20[9] && last20[9] < last20[19];
  const resistanceTrend = last20[0] > last20[9] && last20[9] > last20[19];

  if (supportTrend && Math.abs(closes[len - 1] - highLine) < highLine * 0.003) {
    pattern = "ASCENDING_TRIANGLE";
  }
  if (resistanceTrend && Math.abs(closes[len - 1] - lowLine) < lowLine * 0.003) {
    pattern = "DESCENDING_TRIANGLE";
  }

  // FLAGS (simple heuristics)
  const last30 = slice(30);
  if (last30.length === 30) {
    const rise = last30[10] < last30[0] * 0.98 && Math.max(...last30.slice(0, 11)) > Math.min(...last30.slice(0, 11));
    const flat = Math.abs(last30[29] - last30[10]) < last30[0] * 0.015;
    if (rise && flat) pattern = "BULL_FLAG";

    const drop = last30[10] > last30[0] * 1.02;
    const flat2 = Math.abs(last30[29] - last30[10]) < last30[0] * 0.015;
    if (drop && flat2) pattern = "BEAR_FLAG";
  }

  // CUP & HANDLE
  if (last50.length === 50) {
    const left = last50[0];
    const mid = last50[25];
    const right = last50[49];
    const cupShape = mid < left * 0.98 && mid < right * 0.98;
    const symmetry = Math.abs(left - right) < left * 0.015;
    if (cupShape && symmetry) pattern = "CUP_HANDLE";
  }

  if (!pattern) return null;

  // Estimate support/resistance (basic)
  const support = lowLine;
  const resistance = highLine;

  return {
    name: pattern,
    support: Number(support.toFixed(4)),
    resistance: Number(resistance.toFixed(4)),
    structureLow: Number(structureLow.toFixed(4)),
    structureHigh: Number(structureHigh.toFixed(4))
  };
}

module.exports = detectChartPatterns;
