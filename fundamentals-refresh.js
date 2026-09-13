// api/cron/fundamentals-refresh.js
// Fundamentals barely move day to day (only on quarterly results), so this
// only runs Mon+Thu — AND even then, scraping all 452 stocks at a polite
// 1.5s/request rate takes ~11 minutes, well over the 300s function cap.
// Solution: split the 452 stocks into 4 shards and schedule 4 separate cron
// triggers a few minutes apart (see vercel.json), each hitting this same
// function with a different ?shard=0..3 query param. Each shard is ~113
// stocks * 1.5s =~170s, comfortably under the cap.

const seed = require("../../data/universe-seed.json");
const { scrapeFundamentals } = require("../../lib/scrape-fundamentals");
const { loadCurrentDataset, saveDataset } = require("../../lib/storage");

const NUM_SHARDS = 4;

function isFundamentalsDay() {
  const day = new Date().getDay(); // 1 = Mon, 4 = Thu
  return day === 1 || day === 4;
}

module.exports = async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const shard = parseInt(req.query.shard ?? "0", 10);

  if (!isFundamentalsDay()) {
    return res.status(200).json({ ok: true, stage: "fundamentals-refresh", skipped: "not a scheduled fundamentals day (Mon/Thu only)" });
  }

  try {
    const dataset = await loadCurrentDataset(seed);
    const stocks = dataset.companies;

    // Deterministic partition by index so every shard's set is stable and
    // the four scheduled calls together cover all 452 exactly once.
    const shardStocks = stocks.filter((_, i) => i % NUM_SHARDS === shard);
    const symbols = shardStocks.map((s) => s.sym);

    const fundamentals = await scrapeFundamentals(symbols);
    const bySymbol = Object.fromEntries(fundamentals.map((f) => [f.symbol, f]));

    const merged = stocks.map((s) => (bySymbol[s.sym] ? { ...s, ...bySymbol[s.sym] } : s));

    const payload = { ...dataset, companies: merged };
    const url = await saveDataset(payload);

    return res.status(200).json({
      ok: true,
      stage: "fundamentals-refresh",
      shard,
      scraped: fundamentals.length,
      errors: fundamentals.filter((f) => f.scrapeError).length,
      datasetUrl: url,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, stage: "fundamentals-refresh", shard, error: err.message });
  }
};
