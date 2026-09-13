// lib/dhan.js
// Pulls daily closing price + historical price for momentum, and derives
// live P/E and P/B off the last known EPS / book value on file.
//
// TODO before running:
//   1. DHAN_ACCESS_TOKEN + DHAN_CLIENT_ID env vars must be set (same token
//      flow used for nexus-eod-scanner: web.dhan.co -> profile -> Access DhanHQ APIs)
//   2. Every stock in universe-seed.json needs a `dhanSecurityId` — only 5 are
//      resolved so far (DIXON, BEL, POWERGRID, CONCOR, HAL from the earlier
//      nexus project). The remaining ~447 need to be resolved via Dhan's
//      instrument master CSV (https://images.dhan.co/api-data/api-scrip-master.csv)
//      matched by NSE trading symbol before this can run at full scope.

const DHAN_BASE = "https://api.dhan.co/v2";

async function dhanFetch(path, opts = {}) {
  const res = await fetch(`${DHAN_BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "access-token": process.env.DHAN_ACCESS_TOKEN,
      "client-id": process.env.DHAN_CLIENT_ID,
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Dhan API ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Historical daily candles for momentum calc (1Y/6M/3M lookback).
async function getHistoricalClose(securityId, exchangeSegment, fromDate, toDate) {
  const body = {
    securityId: String(securityId),
    exchangeSegment, // "NSE_EQ"
    instrument: "EQUITY",
    fromDate,
    toDate,
  };
  const data = await dhanFetch("/charts/historical", {
    method: "POST",
    body: JSON.stringify(body),
  });
  // Dhan returns parallel arrays: { open, high, low, close, volume, timestamp }
  return data.close || [];
}

function pctReturn(closes, daysAgo) {
  if (!closes || closes.length < daysAgo + 1) return null;
  const latest = closes[closes.length - 1];
  const past = closes[closes.length - 1 - daysAgo];
  if (!past) return null;
  return ((latest - past) / past) * 100;
}

/**
 * Refresh price-derived fields for one stock.
 * @param {object} stock - existing record from universe-seed.json (must include dhanSecurityId, eps, bookValuePerShare)
 */
async function refreshPriceFields(stock) {
  if (!stock.dhanSecurityId) {
    return { ...stock, priceRefreshSkipped: "no dhanSecurityId mapped" };
  }
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - 380); // >1y of trading days with buffer

  const closes = await getHistoricalClose(
    stock.dhanSecurityId,
    "NSE_EQ",
    from.toISOString().slice(0, 10),
    today.toISOString().slice(0, 10),
  );

  const price = closes[closes.length - 1] ?? stock.price;

  return {
    ...stock,
    price,
    mom1y: pctReturn(closes, 250),
    mom6m: pctReturn(closes, 125),
    mom3m: pctReturn(closes, 63),
    pe: stock.eps ? price / stock.eps : stock.pe,
    pb: stock.bookValuePerShare ? price / stock.bookValuePerShare : stock.pb,
    priceUpdatedAt: new Date().toISOString(),
  };
}

module.exports = { refreshPriceFields, getHistoricalClose, pctReturn };
