// lib/scrape-fundamentals.js
//
// Verified against a live fetch of screener.in/company/RELIANCE/consolidated/
// just now. Two important findings changed this from the first draft:
//
// 1. The bullet list at the top of the page ("Stock P/E 22.8", "ROCE 10.3 %",
//    "ROE 8.91 %"...) is a PER-USER CUSTOMIZABLE ratio box ("Add ratio to
//    table" / "Edit ratios" are visible on the page) — its exact contents
//    can differ per session/account, so it's not a safe thing to scrape
//    positionally. Confirmed example: Reliance's box did not show Debt to
//    Equity at all, even though that's a very standard ratio.
//
// 2. Every company page instead has fixed-structure sections with stable
//    anchor ids — confirmed present: #chart #analysis #peers #quarters
//    #profit-loss #balance-sheet #cash-flow #ratios #shareholding
//    #documents — each containing a standard HTML table. Pulling named rows
//    out of those tables (e.g. "Promoters +" from #shareholding, "ROCE %"
//    from #ratios, "Borrowings" + "Equity Capital" + "Reserves" from
//    #balance-sheet) is far more robust than the customizable box.
//
// This still needs `cheerio` (npm install cheerio) and a real run against
// screener.in to confirm exact row-label text hasn't drifted (Screener does
// update markup occasionally) — but it's now built from an actual page,
// not a blind guess.

const cheerio = require("cheerio");

const RATE_LIMIT_MS = 1500; // ~40 req/min — be polite

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseNum(text) {
  if (text == null) return null;
  const cleaned = String(text).replace(/[,%₹\s]/g, "").trim();
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? null : n;
}

// Find a table row by its label (first cell), within a given section id.
// Screener rows often end in "+" for expandable line items (e.g.
// "Borrowings +", "Promoters +") — match by startsWith to tolerate that.
function findRow($, sectionId, label) {
  const section = $(`#${sectionId}`);
  let found = null;
  section.find("table tr").each((_, tr) => {
    const firstCell = $(tr).find("td, th").first().text().trim();
    if (firstCell === label || firstCell.startsWith(label)) {
      found = $(tr)
        .find("td")
        .slice(1)
        .map((__, td) => $(td).text().trim())
        .get();
    }
  });
  return found; // array of period values, oldest -> newest, or null if not found
}

function lastValue(arr) {
  if (!arr || !arr.length) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] && arr[i] !== "") return parseNum(arr[i]);
  }
  return null;
}

async function scrapeOne(symbol) {
  const url = `https://www.screener.in/company/${symbol}/consolidated/`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; research-bot/1.0)" },
  });
  if (!res.ok) {
    return { symbol, scrapeError: `HTTP ${res.status}` };
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  const roceRow = findRow($, "ratios", "ROCE %");
  const roce = lastValue(roceRow);

  const borrowings = lastValue(findRow($, "balance-sheet", "Borrowings"));
  const equityCapital = lastValue(findRow($, "balance-sheet", "Equity Capital"));
  const reserves = lastValue(findRow($, "balance-sheet", "Reserves"));
  const de =
    borrowings != null && equityCapital != null && reserves != null && (equityCapital + reserves) !== 0
      ? borrowings / (equityCapital + reserves)
      : null;

  const opm = lastValue(findRow($, "quarters", "OPM %"));

  const salesCagr5y = parseNum(
    $("#profit-loss")
      .find("th:contains('Compounded Sales Growth')")
      .closest("table")
      .find("tr:contains('5 Years')")
      .find("td")
      .last()
      .text(),
  );
  const profitCagr5y = parseNum(
    $("#profit-loss")
      .find("th:contains('Compounded Profit Growth')")
      .closest("table")
      .find("tr:contains('5 Years')")
      .find("td")
      .last()
      .text(),
  );

  const roe = parseNum(
    $("#profit-loss")
      .find("th:contains('Return on Equity')")
      .closest("table")
      .find("tr:contains('Last Year')")
      .find("td")
      .last()
      .text(),
  );

  const promoterRow = findRow($, "shareholding", "Promoters");
  const promoter = lastValue(promoterRow);

  return {
    symbol,
    roe,
    roce,
    opm,
    de,
    salesCagr5y,
    profitCagr5y,
    promoter,
    scrapedAt: new Date().toISOString(),
  };
}

async function scrapeFundamentals(symbols) {
  const results = [];
  for (const symbol of symbols) {
    try {
      results.push(await scrapeOne(symbol));
    } catch (err) {
      results.push({ symbol, scrapeError: String(err) });
    }
    await sleep(RATE_LIMIT_MS);
  }
  return results;
}

module.exports = { scrapeFundamentals, scrapeOne };
