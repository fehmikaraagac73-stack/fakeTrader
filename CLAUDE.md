# Paper Trader

A fake stock market trading game. The player starts with $10,000 in paper money and
buys/sells invented stocks against a simulated live market, with Robinhood-style
charts, a portfolio view, transaction history, and per-ticker notes with price alerts.

**Every company, price, headline and dollar in this project is fictional.** There is
no network call anywhere in the codebase and no real brokerage behaviour is implied.

---

## Running it

Open `index.html`. No server, no build step, no package manager, no CDN.

Everything is inline and works from `file://` — this constraint is deliberate and
should be preserved. It is why the code is a classic `<script>` inside an IIFE rather
than ES modules (module imports are blocked by CORS on `file://`), and why the chart
is hand-rolled instead of using a charting library.

State lives in `localStorage` under the key `paper-trader/v1`, so each browser holds
its own independent run.

The key and the save schema version are **not** the same thing and do not move
together. `STORE_KEY` is still `paper-trader/v1`; the schema inside it is now `v: 2`.
`load()` migrates older saves in place rather than discarding them — bump `v` and add
a migration step there, and leave the key alone unless a save becomes genuinely
unreadable.

---

## Files

| File | Lines | Contents |
|---|---|---|
| `index.html` | ~100 | Static shell only — top bar, tab bar, sheet host, banner/toast hosts, onboarding. Every view is built by JS. |
| `styles.css` | ~610 | Design tokens, dark-first, mobile-first, one desktop breakpoint at 900px. |
| `scripts.js` | ~4200 | Everything else, in 29 numbered sections. |
| `test/harness.js` | ~1070 | Node test harness. Not shipped; `index.html` never references it. |
| `README.txt` | ~460 | Player-facing manual, plain text, 80 columns, `--` for dashes. Behaviour changes that a player would notice belong in it — §2.5 covers the market running while away. |

### `scripts.js` section map

| § | Section | § | Section |
|---|---|---|---|
| 1 | Constants & utilities | 16 | Order ticket |
| 2 | The universe (42 companies) | 17 | Note & alert editor |
| 3 | Market sessions | 18 | Net worth series (computed) |
| 4 | News | 19 | View — Home |
| 5 | Price engine — daily | 20 | View — Search |
| 6 | Price engine — intraday | 21 | View — Stock detail |
| 7 | State & persistence | 22 | View — Portfolio |
| 8 | Portfolio math | 23 | View — History |
| 9 | Orders | 24 | View — Notes & alerts |
| 10 | Notes & alerts | 25 | Settings |
| 11 | News feed, badges, rivals | 26 | Chrome (title/action bar/tabs) |
| 12 | Chart renderer | 27 | Router |
| 13 | UI primitives | 28 | The loop |
| 14 | Tick subscriptions | 29 | Boot |
| 15 | Shared row components | | |

---

## The one architectural decision that shapes everything

**Prices are a pure deterministic function of `(seed, ticker, timestamp)`.**

No market state is ever stored. The entire price history is regenerated from the seed
on every load. Four consequences, all of which the rest of the design leans on:

1. **Save files stay tiny.** Only the portfolio is persisted — cash, positions,
   orders, history, notes, settings. A full run is ~20KB.
2. **Reopening after a week backfills instantly.** The market "kept moving" while the
   app was closed because it was never running in the first place.
3. **Resting orders settle retroactively.** `scanForFill()` replays the minute bars
   that occurred while the app was shut and fills any limit/stop that crossed its
   trigger — identical logic whether one second elapsed or one week.
4. **The equity curve is reconstructed, not recorded.** `state.history` gives cash and
   share counts at any past instant; the engine gives prices at any past instant.
   Net worth for every minute the app was closed follows from the two (§18). This is
   the same trick as (3), applied to the portfolio as a whole.

If you change how prices are generated, you change every existing save file's market.
That is acceptable (each run is disposable) but should be a conscious choice.

### How the price series is built

Two resolutions stitched together:

- **Daily bars** (`buildDaily`, §5) — 730 days generated at load for all 42 tickers,
  ~30ms. Per day, per ticker: `drift + beta × marketFactor + idiosyncratic noise +
  mean reversion`, plus a news jump if one fires.
- **Intraday** (`intradayFor`, §6) — a 1440-minute walk for a given `(ticker, day)`,
  generated on demand and LRU-cached. It is a **bridge**: it starts at the previous
  daily close and is pinned to land exactly on this day's daily close, so the two
  resolutions agree to the cent rather than only on average. See the bug notes below
  for why that matters.
- **Sub-minute** (`subPath`, §6) — a Brownian bridge from the previous minute's close
  to the current minute's close, sampled at the current second. This is what makes
  the live candle visibly grow between ticks.

`livePrice(sym, ts)` is the single entry point every view reads.

`buildDaily()` owns invalidating everything downstream — it clears the intraday cache
and the net worth series cache. Neither cache key contains the seed or the base day,
so any path that changes the market **must** go through `buildDaily()`.
`ensureFreshDay()` (§5) calls it when the day rolls over, which is what stops a tab
left open overnight from working against a stale "today".

### How the equity curve is built

§18 is the price engine's trick applied to the portfolio. Nothing about net worth is
stored; the curve is rebuilt from two things that already exist.

- **`portfolioTimeline()`** — replays `state.history` (filled records only, sorted by
  `ts`) into checkpoints of `{t, cash, pos}`. Between two checkpoints the portfolio is
  constant and only prices move, which is what makes valuing an arbitrary instant a
  single lookup. Memoized on `createdAt | history.length | cash`.
- **`priceAtMinute` / `priceAtDay`** — a past price without paying for the sub-minute
  Brownian bridge. Minute closes come straight out of the cached intraday walk; daily
  closes come out of `dailyCache`. `livePrice` is used only at the live edge.
- **`netWorthSeries(tf)`** — samples a uniform time grid across the window and returns
  chart bars. Memoized per timeframe; a repaint that hasn't crossed a grid boundary
  re-prices only the trailing point (`liveTail`), which is ~0.4ms for a 20-holding
  portfolio versus a full rebuild.
- **`netWorthChart()`** (§12) — the mounted component. Both views use it.

Three invariants worth not breaking:

1. **The last bar's close equals `netWorth()` exactly.** The chart endpoint and the
   hero figure are the same number; the tail checkpoint is deliberately overwritten
   with live `state.cash`/`state.positions` so a gap in history can never make them
   disagree.
2. **The grid is uniform in time.** The chart's x-axis is index-based, so uneven
   sampling silently misdraws.
3. **Every window clamps to `state.createdAt`.** No point may predate the account.

Sorting by `ts` rather than trusting insertion order matters: retroactively settled
resting orders are appended when they are *discovered*, not when they happened, so
`state.history` is not always in timestamp order.

### Guardrails

- Soft mean reversion toward a compounding anchor (`-0.014 × log(price/anchor)`,
  clamped) — stops a ticker drifting to $0.80 or $9,000 over two years.
- `MIN_PRICE` floor of $0.75.
- Gaussian draws clamped to ±3.6σ so one freak sample can't gap a price 40%.
- Order validation rejects limit prices more than 12× away from the market.

### Market hours

The market ticks 7 days a week — a dead weekend makes a poor game. Realism comes from
`sessionMult()` scaling volatility instead: 1.0 in regular hours, 0.4 extended,
0.12 overnight, 0.15 weekends. The header pill reports the true session.

---

## Conventions

- **Nothing derived is ever stored.** Net worth, P/L, allocation, buying power and the
  whole equity curve are computed on demand (§8, §18) so two numbers can never
  disagree. `state.snapshots` used to be the one exception, and it was the one place
  the numbers *did* disagree — see the bug notes.
- **The net worth chart is one component.** Home and Portfolio both mount
  `netWorthChart()` (§12), which owns the timeframe strip, the crosshair and the
  `onChange` callback the hero uses. Neither view reimplements it.
- **Sampled series are anchored, not trailing.** `netWorthSeries` snaps its grid to
  absolute step boundaries rather than measuring back from `Date.now()`. A trailing
  window moves every point on every tick, which defeats caching and makes the
  crosshair drift under a held finger.
- **One mutation point for money.** All cash and position changes go through
  `executeFill()` (§9). Realized P/L uses average cost, not FIFO.
- **One place for number formatting** (§1): `money`, `signedMoney`, `pct`,
  `signedPct`, `shares`, `compact`. Prices use `font-variant-numeric: tabular-nums`
  so digits don't jitter as they update.
- **Views are functions returning a fragment.** The router (§27) clears tick handlers,
  clears the action bar, and calls one. `rerender()` re-renders in place preserving
  scroll.
- **Tick subscriptions** (§14): mounted views register repaint callbacks via
  `onViewTick`; sheets use `onSheetTick`. Both are cleared on teardown. The 2s loop
  (§28) calls only what is currently mounted.

### Mobile & accessibility rules being followed

- Bottom tab bar and sticky Buy/Sell bar; interactive targets ≥44px.
- Safe-area insets (`env(safe-area-inset-*)`) and `100dvh`, not `100vh`.
- Bottom sheets, not centred modals; swipe-down to dismiss.
- No hover-dependent information. Hover effects are wrapped in `@media (hover: hover)`.
- Swipe-to-confirm always has an Enter-key fallback.
- Colourblind palette (blue/orange) via `html[data-palette="cb"]`.
- Charts carry a text summary in `aria-label` via `chartSummary()`.
- `prefers-reduced-motion` plus a manual `html[data-motion="reduced"]` override.

---

## Testing

```
node test/harness.js
```

**183 assertions, all passing.** No dependencies, no test runner — it is plain Node
and exits non-zero on failure.

The harness builds a small DOM (element tree, class/id/attribute selectors, an
`innerHTML` parser, a no-op canvas context) and evaluates `scripts.js` **unmodified**,
splicing an export line inside the IIFE at load so the file on disk stays exactly what
the browser gets. The clock is frozen for the whole run, so assertions are exact
rather than tolerance-based; tests that need time to pass reassign `NOW` and put it
back.

It covers: price sanity across all 42 tickers, the intraday bridge landing exactly on
its daily close for every ticker and day, midnight continuity, portfolio replay from
the fill history, the net worth series across all six timeframes (spacing, OHLC
invariants, determinism, chart endpoint equalling `netWorth()` to the cent), offline
movement, grid stability across ticks and cache invalidation, day rollover, the v1→v2
save migration, Home and Portfolio rendering with every timeframe button clicked, and
a full boot from a legacy save with a resting order settling retroactively.

**What it cannot catch:** there is no CSS cascade and no real layout in it. Styling,
specificity and touch behaviour are invisible to the tests — those need a browser.
The canvas context is a stub, so the chart's paint path runs but draws nothing
verifiable.

---

## Bugs already found and fixed (do not reintroduce)

1. **`[hidden]` losing to class selectors.** `.onboard { display: grid }` outranks the
   UA rule `[hidden] { display: none }`, so the onboarding overlay never hid and the
   app appeared frozen. Same latent flaw on `.action-bar` and `.icon-btn`. Fixed with
   a global `[hidden] { display: none !important; }` near the top of `styles.css`.
2. **Malformed favicon data URI.** Raw `<`, `>` and spaces made the browser resolve
   the href against the document and try to load `index.html` as an icon. Percent-encode
   inline SVG data URIs.
3. **Resting orders peeking ahead.** `scanForFill` built the current minute's bar from
   its *final* close, letting an order fill against a price that hadn't happened yet,
   and skipped zero-width scan windows entirely. Now the first scanned minute opens at
   the scan start and the in-progress minute ends at `now`.
4. **Order ticket leaking tick handlers.** Every keystroke re-ran the ticket's
   `render()` and registered another `onSheetTick`, each updating a detached summary
   card. `render()` now calls `clearSheetTicks()` first.
5. **Net worth sampled instead of computed.** `state.snapshots` recorded net worth
   once a minute *while the tab was open*. Four days away therefore contributed one
   data point, so the curve could not move offline — it could only jump. Compounding
   it, `Chart._paint`'s `X(i)` spaces points by **index**, so a three-hour session
   took more width than the following four days and the gap rendered as a cliff.
   Fixed by computing the series from the fill history and the price engine (§18) on
   a grid that is uniform in time. Do not reintroduce a stored equity curve; if a
   series is ever sampled unevenly, the index-based x-axis will misdraw it.
6. **Intraday walks not landing on their daily close.** The 1440-minute walk started
   at the previous daily close and drifted by the daily return, which is only correct
   *in expectation* — accumulated noise is ~1.55x the daily volatility, so a day
   typically ended 2–3% away from the daily bar describing it. Since the next day's
   walk starts from that daily close, **every midnight was a price gap**: a visible
   step in any multi-day chart (the 1W stock chart already had this) and a phantom
   jump in the net worth curve at 00:00. `buildIntradayCloses` is now a bridge that
   pins the endpoint, spreading the residual by session activity.
7. **Intraday cache surviving a market change.** The cache key is `sym|dn` — no seed,
   no base day — so it was only correct because the one reset call site remembered to
   call `intradayCache.clear()`. Any new invalidation path would have silently served
   prices from a market that no longer existed. `buildDaily()` now owns the clear.

---

## Gotchas worth remembering

- The chart's `touchmove` listener **must** be registered `{ passive: false }` — the
  default is passive and `preventDefault()` silently does nothing, so a scrub fights
  the page scroll.
- `.chart-wrap` and its canvas use `touch-action: pan-y`: vertical drags scroll the
  page, horizontal drags are ours.
- Canvas needs an explicit repaint on resize/rotate — it is not reflowed by CSS.
- `dayNum()` uses `Math.round` on the day quotient so DST hour shifts don't produce
  duplicate or skipped day indices.
- The tick loop skips work when `document.hidden`; `visibilitychange` triggers a
  `catchUp()` rather than waiting for the next tick.
- `netWorthSeries()` returns a **cached array that is mutated in place** — successive
  calls within one grid step hand back the same object with its last bar rewritten.
  Fine for the chart, which re-reads it every paint. Do not stash the result expecting
  a stable snapshot; copy it if you need one.
- Repainting a chart under a held finger has to re-read the scrubbed bar out of the
  new series. Keeping the old bar object means the readout quietly quotes a value that
  is no longer on the line — `netWorthChart`'s `paint()` re-resolves it from
  `chart.scrubIndex`.
- `buildDaily()` reads `state.seed`, so `state` must be assigned before it is called.
  It also references `intradayCache`, declared later in the file — safe only because
  nothing calls it until `init()`.

---

## Known gaps / possible next steps

- Realized P/L is average-cost only. FIFO lots would need per-lot tracking.
- History has no virtualization; a run with thousands of fills will scroll heavily.
- No import for a previously exported save (export only, CSV + JSON).
- Simulated rivals are a smooth deterministic curve, not actual simulated portfolios.
- Today's daily bar is derived from intraday, while past days come from the daily
  walk. The *close* now agrees exactly (the intraday bridge pins it), but the high and
  low still shift slightly when "today" becomes "yesterday".
- **Resolution seam in the net worth chart.** Windows up to 8 days sample minute
  closes; longer ones sample daily closes, because a 3-month window would otherwise
  build ~90 intraday walks per holding on every timeframe tap. Both agree at day
  boundaries and at the live edge, but a mid-day point on 1M is that day's close
  rather than that moment's price. Widening `NW_FINE_MAX` trades that away for a
  cold-paint cost that scales with holdings × days.
- The 730-day daily window is anchored to "today", so it slides at midnight and every
  historical price shifts a little. `ensureFreshDay()` keeps the app self-consistent
  across the roll, but a chart screenshotted either side of midnight will differ.
