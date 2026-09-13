// lib/ai-rescoring.js
// Regenerates the "judgment layer" fields that aren't derivable by formula:
//   qScore, momScore, jScore, wealthScore, stage, hold, trigger, evidence,
//   invalidation, redFlags
//
// COST/LATENCY NOTE: calling this once per stock (452 calls/day) is slow and
// expensive. Instead we batch ~20 stocks per call, so a full run is
// ~23 calls. At ~15-20s per call that's roughly 6-8 minutes sequential, or
// under 2 minutes with 4-way concurrency — comfortably inside Vercel's
// extended function duration (see vercel.json maxDuration).
//
// If overnight latency is fine and cost matters more than turnaround time,
// swap this for Anthropic's Message Batches API (50% cheaper, results
// typically within a couple hours) — see the commented alternative at the
// bottom of this file.

const CHUNK_SIZE = 20;
const MODEL = "claude-sonnet-5";
const CONCURRENCY = 4;

function buildPrompt(stocks) {
  return `You are re-scoring a batch of Indian NSE-listed stocks for a fundamental+technical
research screener, using ONLY the data provided below (no outside knowledge, no browsing).

For EACH stock, return:
- qScore (0-100): fundamental quality — profitability, balance-sheet strength, capital efficiency
- momScore (0-100): technical/price momentum strength
- jScore (0-100): earnings-inflection / J-curve setup strength
- wealthScore (0-100): overall long-term compounding attractiveness
- stage (1, 2, or 3): 1 = early inflection, 2 = mid-cycle compounding, 3 = late/mature
- redFlags (array of short strings, [] if none)
- trigger (one sentence: the specific catalyst/thesis for this stock right now)
- evidence (one sentence: the strongest data point supporting the trigger)
- invalidation (one sentence: what would prove this thesis wrong)

Be conservative — if the data doesn't clearly support a strong score, score it neutrally
(40-60) rather than inventing conviction. Flag data gaps as redFlags rather than guessing.

Return ONLY a JSON array, one object per stock, each with a "symbol" field matching the
input, plus the fields above. No prose, no markdown fences.

STOCKS:
${JSON.stringify(stocks, null, 0)}`;
}

async function callClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const text = data.content.find((b) => b.type === "text")?.text ?? "[]";
  const cleaned = text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

/**
 * @param {object[]} stocks - full stock list with fresh price + fundamentals already merged in
 */
async function rescoreAll(stocks) {
  // Only send the fields the model actually needs — keeps prompts small.
  const slim = stocks.map((s) => ({
    symbol: s.sym,
    sector: s.sector,
    price: s.price,
    pe: s.pe,
    pb: s.pb,
    roe: s.roe,
    roce: s.roce,
    opm: s.opm,
    de: s.de,
    salesCagr5y: s.salesCagr5y,
    profitCagr5y: s.profitCagr5y,
    mom1y: s.mom1y,
    mom6m: s.mom6m,
    mom3m: s.mom3m,
    promoter: s.promoter,
  }));

  const chunks = chunk(slim, CHUNK_SIZE);
  const chunkResults = await mapWithConcurrency(chunks, CONCURRENCY, (c) =>
    callClaude(buildPrompt(c)),
  );
  const bySymbol = {};
  for (const arr of chunkResults) {
    for (const r of arr) bySymbol[r.symbol] = r;
  }

  return stocks.map((s) => {
    const r = bySymbol[s.sym];
    if (!r) return { ...s, rescoreError: "missing from AI response" };
    return {
      ...s,
      q: r.qScore,
      mo: r.momScore,
      jscore: r.jScore,
      wealth: r.wealthScore,
      stage: r.stage,
      redFlags: r.redFlags || [],
      trigger: r.trigger,
      evidence: r.evidence,
      invalidation: r.invalidation,
      rescoredAt: new Date().toISOString(),
    };
  });
}

module.exports = { rescoreAll };

// --- Alternative: Message Batches API (cheaper, slower turnaround) -------
// const batchReq = await fetch("https://api.anthropic.com/v1/messages/batches", {
//   method: "POST",
//   headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
//   body: JSON.stringify({
//     requests: chunks.map((c, i) => ({
//       custom_id: `chunk-${i}`,
//       params: { model: MODEL, max_tokens: 4000, messages: [{ role: "user", content: buildPrompt(c) }] },
//     })),
//   }),
// });
// Poll GET /v1/messages/batches/{id} until status === "ended", then fetch
// results_url and merge — same shape as the synchronous path above.
