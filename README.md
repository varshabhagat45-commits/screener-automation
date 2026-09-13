# India Equity Screener — Daily Automation

Automates the 452-stock dashboard in three tiers, each its **own small serverless
function** rather than one big one:

| Stage | Endpoint | Fields | Schedule (IST) | Runtime budget |
|---|---|---|---|---|
| 1 | `api/cron/price-refresh` | price, mom1y/6m/3m, P/E, P/B | Daily 5:30pm | 120s |
| 2 | `api/cron/fundamentals-refresh?shard=0..3` | ROE, ROCE, margins, D/E, CAGR, promoter | Mon+Thu, 5:34/39/44/49pm (4 shards) | 250s each |
| 3 | `api/cron/ai-rescore` | qScore, momScore, jScore, wealthScore, stage, narrative, composite, verdict | Daily 5:56pm | 200s |

**Why split into stages instead of one function:** Vercel caps function duration at
300 seconds *on every plan* — that's a hard platform limit, not something a paid
tier removes. Scraping all 452 Screener.in pages alone takes ~11 minutes at a
polite 1.5s/request rate, so it has to be sharded across 4 separate invocations
(deterministic partition by array index, so the 4 shards together cover exactly
all 452 stocks with no overlap or gaps).

**Why the stages are spaced ~5 minutes apart, not run in parallel:** each stage
reads the current dataset from Blob, updates its slice, and writes the whole
thing back. If two stages ran at the same moment, the second to finish would
overwrite the first's changes with stale data it read before the first stage's
write landed. Spacing them out is a simple fix for this sandbox-scale project;
if you outgrow it, a proper per-field merge (patch specific keys instead of
overwriting the whole document) would remove the ordering dependency entirely.

`composite` and `hold` verdict are recomputed deterministically at the end of stage
3 (`lib/scoring.js`, ported from the original app's `scoring.ts`).

## Setup

1. **Deploy to Vercel** (`vercel deploy` or via Git import). Cron Jobs themselves
   require a paid plan (Hobby/free doesn't support scheduling multiple crons per
   day) — check current Vercel pricing for what each stage's `maxDuration` needs,
   since per-function duration limits vary by plan tier even though 300s is the
   platform-wide ceiling.
2. **Environment variables** (Vercel dashboard → Settings → Environment Variables):
   - `DHAN_ACCESS_TOKEN`, `DHAN_CLIENT_ID` — same as your `nexus-eod-scanner` setup
   - `ANTHROPIC_API_KEY` — for the daily re-scoring pass
   - `BLOB_READ_WRITE_TOKEN` — create a Vercel Blob store, token is auto-generated
   - `CRON_SECRET` — any random string; protects the cron endpoint from being triggered by strangers
3. **Resolve Dhan security IDs for all 452 stocks.** Only 5 are mapped right now
   (DIXON, BEL, POWERGRID, CONCOR, HAL, carried over from the earlier watchlist).
   Download Dhan's instrument master (`https://images.dhan.co/api-data/api-scrip-master.csv`),
   match by NSE trading symbol, and fill in `dhanSecurityId` for every entry in
   `data/universe-seed.json`. Until this is done, `refreshPriceFields()` skips
   unmapped stocks and leaves their price/momentum untouched.
4. **Verify the Screener.in scraper.** The regex-based extraction in
   `lib/scrape-fundamentals.js` is illustrative — check it against the live site's
   current markup before trusting it, and consider swapping in `cheerio` for
   proper DOM parsing if the regex proves brittle.
5. **First manual run**: hit each stage yourself in order, with the right
   `Authorization: Bearer <CRON_SECRET>` header, before trusting the schedule:
   `/api/cron/price-refresh`, then (Mon/Thu only) `/api/cron/fundamentals-refresh?shard=0`
   through `shard=3`, then `/api/cron/ai-rescore`. Check each response's JSON for
   errors before moving to the next.

## What's real vs. what's scaffolded

- `lib/scoring.js` — real, ported directly from the source app's code.
- `lib/dhan.js` — real API shape, but untested against your actual Dhan account.
- `lib/scrape-fundamentals.js` — **rewritten and logic-verified**: I fetched
  screener.in/company/RELIANCE/consolidated/ live and found the "top ratio box"
  (Stock P/E, ROCE, ROE at the top of the page) is per-user customizable — Reliance's
  didn't even show Debt to Equity, a very standard ratio — so scraping it
  positionally isn't safe. Rewrote this to pull from the fixed-structure financial
  statement tables instead (`#ratios`, `#balance-sheet`, `#quarters`, `#profit-loss`,
  `#shareholding` — confirmed these section ids exist on the live page) and compute
  D/E myself from Borrowings/Equity+Reserves rather than trust a display value.
  Unit-tested the parsing logic against a structural mock of the real page and it
  correctly extracted ROCE 10.3%, D/E 0.446, OPM 15%, 5Y sales CAGR 18%, 5Y profit
  CAGR 12%, ROE 9%, promoter 50.48% — all matching the live Reliance numbers. What's
  still unverified: whether Screener's actual `<table>` markup matches the structure
  I tested against (I could only read the page as extracted text, not raw HTML, from
  this environment — do one live run and diff the output against the site before
  trusting it unattended).
- `lib/ai-rescoring.js` — the prompt and JSON contract are real and will run, but the
  scores it produces are a **new AI judgment layer**, not a continuation of whatever
  process originally authored the seed data's scores/narrative. Expect today's
  re-scored numbers to diverge somewhat from the original snapshot — that's inherent
  to replacing authored analysis with a different (automated) analyst.
- `scripts/resolve-dhan-ids.js` — **new**: one-time script to map all 452 stocks to
  Dhan security IDs from their real instrument master CSV. Confirmed the actual CSV
  column names (`SEM_EXM_EXCH_ID`, `SEM_TRADING_SYMBOL`, `SEM_SMST_SECURITY_ID`,
  `SEM_INSTRUMENT_NAME`, `SEM_SERIES`, `SEM_EXCH_INSTRUMENT_TYPE`) against Dhan's own
  docs and user reports of real CSV output — filters to NSE + `EQUITY` +
  instrument type `ES` + series `EQ` to avoid the CSV's known duplicate-symbol
  issue between equities and ETFs/InvITs sharing similar trading symbols. Couldn't
  actually download and run this against the live 5000+ row CSV from this sandbox
  (network egress here is allowlisted and doesn't include `images.dhan.co`) — run
  `node scripts/resolve-dhan-ids.js` yourself once deployed (or just locally with
  Node 18+) and check the "unresolved" list it prints at the end; a handful of
  symbols with special characters (M&M, L&T, BAJAJ-AUTO) may need entries added to
  the `SYMBOL_ALIASES` map at the top of the script.

## Cost estimate (Tier 3, the expensive part)

452 stocks batched 20-per-call ≈ 23 Claude API calls/day, each with a few KB of input
and ~2-4K output tokens. Rough order of magnitude: a few dollars/month on Sonnet-tier
pricing — check current rates, since this depends on model and token pricing at the
time you run it. Switching to the Message Batches API (commented at the bottom of
`lib/ai-rescoring.js`) cuts this further at the cost of turnaround time (results in
a queue rather than immediately).

## Dashboard changes

`public/index.html` (the dashboard) now tries `fetch('/api/latest-data')` on load and
falls back to the embedded September snapshot if nothing's live yet — so it keeps
working even before the automation is fully wired up. A badge under the title shows
whether you're looking at live or snapshot data.
