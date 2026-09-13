# India Equity Screener — Daily Automation

Automates the 452-stock dashboard in three tiers:

| Tier | Fields | Source | Cadence |
|---|---|---|---|
| 1 | price, mom1y/6m/3m, P/E, P/B | Dhan API | Daily (Mon-Fri, 5:30pm IST) |
| 2 | ROE, ROCE, margins, D/E, CAGR, promoter | Screener.in scrape | Mon + Thu (rarely changes daily) |
| 3 | qScore, momScore, jScore, wealthScore, stage, trigger/evidence/invalidation | Claude API (batched) | Daily |

Then `composite` and `hold` verdict are recomputed deterministically (`lib/scoring.js`,
ported from the original app's `scoring.ts`).

## Setup

1. **Deploy to Vercel** (`vercel deploy`), on a plan that supports extended function
   duration (`maxDuration: 800` in `vercel.json` needs Pro + Fluid Compute — the free
   Hobby plan caps at 10s per invocation, nowhere near enough for 452 stocks).
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
5. **First manual run**: hit `/api/cron/daily-refresh` yourself with the right
   `Authorization: Bearer <CRON_SECRET>` header to confirm it completes end to end
   before letting the cron schedule take over.

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
