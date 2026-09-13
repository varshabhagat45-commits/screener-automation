// api/cron/price-refresh.js
// Runs daily, Mon-Fri. Fastest stage — Dhan calls with concurrency 16 should
// clear all 452 stocks in well under a minute, comfortably inside the 300s
// function duration cap (Vercel's hard max regardless of plan).

const seed = require("../../data/universe-seed.json");
const { refreshPriceFields } = require("../../lib/dhan");
const { loadCurrentDataset, saveDataset } = require("../../lib/storage");

const CONCURRENCY = 16;

module.exports = async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const dataset = await loadCurrentDataset(seed);
    let stocks = dataset.companies;

    const refreshed = [];
    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      const batch = stocks.slice(i, i + CONCURRENCY);
      refreshed.push(...(await Promise.all(batch.map(refreshPriceFields))));
    }

    const payload = {
      ...dataset,
      meta: { ...dataset.meta, asOf: new Date().toISOString().slice(0, 10) },
      companies: refreshed,
    };
    const url = await saveDataset(payload);

    return res.status(200).json({ ok: true, stage: "price-refresh", count: refreshed.length, datasetUrl: url });
  } catch (err) {
    return res.status(500).json({ ok: false, stage: "price-refresh", error: err.message });
  }
};
