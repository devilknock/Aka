// ================= CHART PATTERN ANALYZER =================

function detectChartPatterns(candles) {
  if (candles.length < 50) return null;

  const closes = candles.map(c => parseFloat(c.close));
  const len = closes.length;

  let pattern = null;

  // ------ PRICE POINTS ------
  const p1 = closes[len - 5];
  const p2 = closes[len - 3];
  const p3 = closes[len - 1];

  // ========== DOUBLE TOP ==========
  if (p1 < p2 && Math.abs(p2 - p3) < p2 * 0.002 && p3 < p2) {
    pattern = "DOUBLE_TOP";
  }

  // ========== DOUBLE BOTTOM ==========
  else if (p1 > p2 && Math.abs(p2 - p3) < p2 * 0.002 && p3 > p2) {
    pattern = "DOUBLE_BOTTOM";
  }

  // ========= HEAD & SHOULDERS =========
  const L = closes[len - 7];
  const H = closes[len - 5];
  const R = closes[len - 3];

  if (L < H && R < H && Math.abs(L - R) < H * 0.01) {
    pattern = "HEAD_SHOULDERS";
  }

  // ======== INVERSE HEAD & SHOULDERS ========
  if (L > H && R > H && Math.abs(L - R) < H * 0.01) {
    pattern = "INVERSE_HEAD_SHOULDERS";
  }

  // ========== RISING WEDGE ==========
  const last10 = closes.slice(-10);
  const first5 = last10.slice(0, 5);
  const last5 = last10.slice(5);

  const firstAvg = first5.reduce((a, b) => a + b) / 5;
  const lastAvg = last5.reduce((a, b) => a + b) / 5;

  if (lastAvg > firstAvg && (last10[9] - last10[0]) < firstAvg * 0.02) {
    pattern = "RISING_WEDGE";
  }

  // ========== FALLING WEDGE ==========
  if (lastAvg < firstAvg && (last10[0] - last10[9]) < firstAvg * 0.02) {
    pattern = "FALLING_WEDGE";
  }

  // ========== ASCENDING TRIANGLE ==========
  const highLine = Math.max(...closes.slice(-20));
  const supportTrend = closes[len - 20] < closes[len - 10] && closes[len - 10] < closes[len - 1];

  if (supportTrend && Math.abs(closes[len - 1] - highLine) < highLine * 0.003) {
    pattern = "ASCENDING_TRIANGLE";
  }

  // ========== DESCENDING TRIANGLE ==========
  const lowLine = Math.min(...closes.slice(-20));
  const resistanceTrend = closes[len - 20] > closes[len - 10] && closes[len - 10] > closes[len - 1];

  if (resistanceTrend && Math.abs(closes[len - 1] - lowLine) < lowLine * 0.003) {
    pattern = "DESCENDING_TRIANGLE";
  }

  // ========== BULLISH FLAG ==========
  const last30 = closes.slice(-30);
  const rise = last30[10] < last30[0] * 0.98;  
  const flat = Math.abs(last30[29] - last30[10]) < last30[0] * 0.015;

  if (rise && flat) {
    pattern = "BULL_FLAG";
  }

  // ========== BEARISH FLAG ==========
  const drop = last30[10] > last30[0] * 1.02;  
  const flat2 = Math.abs(last30[29] - last30[10]) < last30[0] * 0.015;

  if (drop && flat2) {
    pattern = "BEAR_FLAG";
  }

  // ========== CUP & HANDLE ==========
  const last50 = closes.slice(-50);
  const left = last50[0];
  const mid = last50[25];
  const right = last50[49];

  const cupShape = mid < left * 0.98 && mid < right * 0.98;
  const symmetry = Math.abs(left - right) < left * 0.015;

  if (cupShape && symmetry) {
    pattern = "CUP_HANDLE";
  }

  return pattern;
}

module.exports = detectChartPatterns;
