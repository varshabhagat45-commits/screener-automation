// api/cron/ai-rescore.js
// Runs daily, Mon-Fri, scheduled after price-refresh (and, on Mon/Thu, after
// the fundamentals shards) so it works off the freshest data. ~23 batched
// Claude calls at concurrency 4 finishes in a couple minutes — well under
// the 300s cap.

const seed = require("../../data/universe-seed.json");
const { rescoreAll } = require("../../lib/ai-rescoring");
const { applyDerivedFields } = require("../../lib/scoring");
const { loadCurrentDataset, saveDataset } = require("../../lib/storage");

module.exports = async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const dataset = await loadCurrentDataset(seed);
    let stocks = await rescoreAll(dataset.companies);
    stocks = stocks.map(applyDerivedFields);

    const payload = {
      ...dataset,
      meta: { ...dataset.meta, asOf: new Date().toISOString().slice(0, 10), generatedBy: "ai-rescore cron" },
      companies: stocks,
    };
    const url = await saveDataset(payload);

    return res.status(200).json({ ok: true, stage: "ai-rescore", count: stocks.length, datasetUrl: url });
  } catch (err) {
    return res.status(500).json({ ok: false, stage: "ai-rescore", error: err.message });
  }
};
