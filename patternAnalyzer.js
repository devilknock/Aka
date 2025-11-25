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

  // ------------- DOUBLE TOP -------------
  if (p1 < p2 && Math.abs(p2 - p3) < p2 * 0.002 && p3 < p2) {
    pattern = "DOUBLE_TOP";
  }

  // ------------- DOUBLE BOTTOM -------------
  else if (p1 > p2 && Math.abs(p2 - p3) < p2 * 0.002 && p3 > p2) {
    pattern = "DOUBLE_BOTTOM";
  }

  // ------------- HEAD & SHOULDERS -------------
  const L = closes[len - 7];
  const H = closes[len - 5];
  const R = closes[len - 3];

  if (L < H && R < H && Math.abs(L - R) < H * 0.01) {
    pattern = "HEAD_SHOULDERS";
  }

  // ------------- INVERSE HEAD & SHOULDERS -------------
  if (L > H && R > H && Math.abs(L - R) < H * 0.01) {
    pattern = "INVERSE_HEAD_SHOULDERS";
  }

  return pattern;
}

module.exports = detectChartPatterns;
