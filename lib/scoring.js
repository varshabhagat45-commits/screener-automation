// lib/scoring.js
// Ported from the original app's src/lib/scoring.ts (holdVerdict + composite
// logic) so the daily job reproduces the same rules the dashboard was built
// against, rather than inventing new thresholds.

function clamp(n, lo = 1, hi = 5) {
  return Math.max(lo, Math.min(hi, n));
}

function holdVerdict(c) {
  const failed = c.failed ?? 0;
  const flags = c.redFlags?.length ?? 0;
  if (c.verdict === "ELIMINATED" && failed >= 6) return "avoid";
  if (flags > 0 && c.wealth < 70) return "avoid";
  if (c.stage === 3) return "late";
  if (c.verdict === "ELIMINATED") return "watch";
  if (c.stage === 1 && c.wealth >= 64) return "early";
  if (c.wealth >= 70 && flags === 0 && c.stage === 2) return "compound";
  if (c.wealth >= 74 && flags === 0) return "compound";
  return "watch";
}

// composite (0-100 scale here, matching q/mo/jscore/wealth already being 0-100)
// simple weighted blend: quality 35%, momentum 25%, J-curve setup 20%, wealth 20%
function composite(c) {
  const parts = [
    [c.q, 0.35],
    [c.mo, 0.25],
    [c.jscore, 0.2],
    [c.wealth, 0.2],
  ].filter(([v]) => v != null);
  if (!parts.length) return null;
  const weightSum = parts.reduce((a, [, w]) => a + w, 0);
  return parts.reduce((a, [v, w]) => a + v * w, 0) / weightSum;
}

function applyDerivedFields(stock) {
  const comp = composite(stock);
  const hold = holdVerdict({ ...stock, wealth: stock.wealth ?? stock.q });
  return { ...stock, comp, hold };
}

module.exports = { holdVerdict, composite, applyDerivedFields, clamp };
