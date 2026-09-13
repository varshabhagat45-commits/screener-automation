// api/cron/daily-refresh.js
// Vercel Cron target — see vercel.json ("0 12 * * 1-5" = 5:30pm IST, Mon-Fri)
//
// Pipeline:
//   1. Load current dataset (previous day's snapshot)
//   2. Refresh price/momentum/PE/PB for every stock via Dhan     (daily)
//   3. Refresh ROE/ROCE/margins/CAGR/promoter via Screener.in     (see note below)
//   4. Re-run the AI judgment pass (qScore/momScore/jScore/wealth/narrative)
//   5. Recompute composite + hold verdict deterministically
//   6. Save the new snapshot, timestamped

const seed = require("../../data/universe-seed.json");
const { refreshPriceFields } = require("../../lib/dhan");
const { scrapeFundamentals } = require("../../lib/scrape-fundamentals");
const { rescoreAll } = require("../../lib/ai-rescoring");
const { applyDerivedFields } = require("../../lib/scoring");
const { saveDataset } = require("../../lib/storage");

// Fundamentals barely move day to day — run the scrape stage only on
// Mondays/Thursdays to go easy on Screener.in and cut run time. Flip to
// `true` unconditionally if you decide you want it strictly daily anyway.
function shouldScrapeFundamentalsToday() {
  const day = new Date().getDay(); // 0=Sun ... 1=Mon ... 4=Thu
  return day === 1 || day === 4;
}

module.exports = async function handler(req, res) {
  // Vercel Cron sends a bearer secret you set yourself — verify it so this
  // endpoint can't be triggered by anyone who finds the URL.
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const log = [];
  try {
    let stocks = seed.companies;

    log.push(`Starting refresh for ${stocks.length} stocks`);

    // Stage 1: price/momentum (concurrency-limited to be gentle on Dhan's API)
    const priceResults = [];
    const PRICE_CONCURRENCY = 8;
    for (let i = 0; i < stocks.length; i += PRICE_CONCURRENCY) {
      const batch = stocks.slice(i, i + PRICE_CONCURRENCY);
      const refreshed = await Promise.all(batch.map(refreshPriceFields));
      priceResults.push(...refreshed);
    }
    stocks = priceResults;
    log.push("Stage 1 (Dhan price/momentum) complete");

    // Stage 2: fundamentals (Mon/Thu only, see note above)
    if (shouldScrapeFundamentalsToday()) {
      const symbols = stocks.map((s) => s.sym);
      const fundamentals = await scrapeFundamentals(symbols);
      const bySymbol = Object.fromEntries(fundamentals.map((f) => [f.symbol, f]));
      stocks = stocks.map((s) => ({ ...s, ...(bySymbol[s.sym] || {}) }));
      log.push("Stage 2 (Screener.in fundamentals) complete");
    } else {
      log.push("Stage 2 skipped today (fundamentals only refreshed Mon/Thu)");
    }

    // Stage 3: AI re-scoring pass (quality/momentum/J-score/wealth/narrative)
    stocks = await rescoreAll(stocks);
    log.push("Stage 3 (AI re-scoring) complete");

    // Stage 4: deterministic composite + verdict
    stocks = stocks.map(applyDerivedFields);
    log.push("Stage 4 (composite + verdict) complete");

    const payload = {
      meta: {
        asOf: new Date().toISOString().slice(0, 10),
        universe: stocks.length,
        sectors: seed.meta.sectors,
        generatedBy: "daily-refresh cron",
      },
      companies: stocks,
      sectors: seed.sectors,
    };

    const url = await saveDataset(payload);
    log.push(`Saved snapshot to ${url}`);

    return res.status(200).json({ ok: true, log, datasetUrl: url });
  } catch (err) {
    log.push(`ERROR: ${err.message}`);
    return res.status(500).json({ ok: false, log, error: err.message });
  }
};
