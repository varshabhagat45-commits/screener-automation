// scripts/resolve-dhan-ids.js
//
// Run this once (and re-run whenever new stocks are added to the universe)
// to fill in `dhanSecurityId` for every stock in data/universe-seed.json.
//
// Verified against Dhan's real CSV column names (confirmed via their docs
// and community threads, since this sandbox can't reach images.dhan.co
// directly — the columns below are the actual ones, not a guess):
//   SEM_EXM_EXCH_ID, SEM_SEGMENT, SEM_SMST_SECURITY_ID, SEM_INSTRUMENT_NAME,
//   SEM_TRADING_SYMBOL, SEM_LOT_UNITS, SEM_CUSTOM_SYMBOL, SEM_SERIES,
//   SEM_EXCH_INSTRUMENT_TYPE, SM_SYMBOL_NAME
//
// Known gotcha (reported by other Dhan API users): the CSV has duplicate
// SEM_TRADING_SYMBOL values across instrument types (e.g. an ETF and an
// equity can share a symbol-ish string). Filtering to NSE + cash segment +
// instrument type "ES" (equity shares) + series "EQ" avoids picking up
// ETFs/InvITs/REITs/bonds by mistake.
//
// Usage:  node scripts/resolve-dhan-ids.js
// Requires Node 18+ (for global fetch). Writes the updated JSON back to
// data/universe-seed.json in place (prints a diff summary first).

const fs = require("fs");
const path = require("path");

const CSV_URL = "https://images.dhan.co/api-data/api-scrip-master.csv";
const SEED_PATH = path.join(__dirname, "..", "data", "universe-seed.json");

// Minimal CSV parser (no external dependency) — good enough for Dhan's
// well-formed, comma-separated, quoted-when-needed export.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (field.length || row.length) { row.push(field); rows.push(row); }
      field = ""; row = [];
      if (c === "\r" && text[i + 1] === "\n") i++;
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toObjects(rows) {
  const header = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

// A few known symbol-name mismatches between common usage and Dhan's
// SEM_TRADING_SYMBOL. Extend this as you find more during the run.
const SYMBOL_ALIASES = {
  "M&M": "M_M",       // Dhan/NSE sometimes encode "&" differently — verify against actual CSV
  "L&T": "LT",
  "BAJAJ-AUTO": "BAJAJ_AUTO",
};

async function main() {
  console.log("Downloading Dhan instrument master...");
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`Failed to download CSV: ${res.status}`);
  const text = await res.text();
  const instruments = toObjects(parseCsv(text));
  console.log(`Loaded ${instruments.length} total instrument rows`);

  const nseEquities = instruments.filter(
    (r) =>
      r.SEM_EXM_EXCH_ID === "NSE" &&
      r.SEM_INSTRUMENT_NAME === "EQUITY" &&
      r.SEM_EXCH_INSTRUMENT_TYPE === "ES" &&
      r.SEM_SERIES === "EQ",
  );
  console.log(`Filtered to ${nseEquities.length} NSE main-board equity rows`);

  const bySymbol = {};
  for (const r of nseEquities) {
    bySymbol[r.SEM_TRADING_SYMBOL] = r.SEM_SMST_SECURITY_ID;
  }

  const seed = JSON.parse(fs.readFileSync(SEED_PATH, "utf8"));

  let resolved = 0;
  const unresolved = [];
  for (const c of seed.companies) {
    const lookupSymbol = SYMBOL_ALIASES[c.sym] || c.sym;
    const id = bySymbol[lookupSymbol];
    if (id) {
      c.dhanSecurityId = id;
      resolved++;
    } else if (!c.dhanSecurityId) {
      unresolved.push(c.sym);
    }
  }

  fs.writeFileSync(SEED_PATH, JSON.stringify(seed));
  console.log(`Resolved ${resolved} / ${seed.companies.length} stocks`);
  if (unresolved.length) {
    console.log(`\n${unresolved.length} symbols still unresolved — check manually:`);
    console.log(unresolved.join(", "));
    console.log(
      "\nCommon reasons: recent listing/delisting, name change, or a symbol " +
        "that needs an entry in SYMBOL_ALIASES above.",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
