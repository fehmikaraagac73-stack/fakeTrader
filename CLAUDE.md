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

---

## Files

| File | Lines | Contents |
|---|---|---|
| `index.html` | ~100 | Static shell only — top bar, tab bar, sheet host, banner/toast hosts, onboarding. Every view is built by JS. |
| `styles.css` | ~610 | Design tokens, dark-first, mobile-first, one desktop breakpoint at 900px. |
| `scripts.js` | ~3950 | Everything else, in 29 numbered sections. |

### `scripts.js` section map

| § | Section | § | Section |
|---|---|---|---|
| 1 | Constants & utilities | 16 | Order ticket |
| 2 | The universe (42 companies) | 17 | Note & alert editor |
| 3 | Market sessions | 18 | Net worth series |
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
on every load. Three consequences, all of which the rest of the design leans on:

1. **Save files stay tiny.** Only the portfolio is persisted — cash, positions,
   orders, history, notes, snapshots, settings. A full run is ~30KB.
2. **Reopening after a week backfills instantly.** The market "kept moving" while the
   app was closed because it was never running in the first place.
3. **Resting orders settle retroactively.** `scanForFill()` replays the minute bars
   that occurred while the app was shut and fills any limit/stop that crossed its
   trigger — identical logic whether one second elapsed or one week.

If you change how prices are generated, you change every existing save file's market.
That is acceptable (each run is disposable) but should be a conscious choice.

### How the price series is built

Two resolutions stitched together:

- **Daily bars** (`buildDaily`, §5) — 730 days generated at load for all 42 tickers,
  ~30ms. Per day, per ticker: `drift + beta × marketFactor + idiosyncratic noise +
  mean reversion`, plus a news jump if one fires.
- **Intraday** (`intradayFor`, §6) — a 1440-minute walk for a given `(ticker, day)`,
  generated on demand and LRU-cached. Its drift is the daily bar's return, so the two
  resolutions agree.
- **Sub-minute** (`subPath`, §6) — a Brownian bridge from the previous minute's close
  to the current minute's close, sampled at the current second. This is what makes
  the live candle visibly grow between ticks.

`livePrice(sym, ts)` is the single entry point every view reads.

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

- **Nothing derived is ever stored.** Net worth, P/L, allocation and buying power are
  computed on demand (§8) so two numbers can never disagree.
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

There is a Node harness that stubs enough DOM to run `scripts.js` unmodified and
exercise the engine, orders, portfolio math, all six views, all seven sheets and all
eight routes. **100 assertions, all passing.**

> The harness currently lives in the session scratchpad, not in this repo. Move it to
> `test/harness.js` if it should survive.

It covers: price sanity across all 42 tickers, OHLC invariants on all 730 daily bars,
every timeframe, seed determinism, intraday/daily continuity, order execution and
every rejection path, resting-order replay, buying-power reservation, alerts,
allocation summing to 100%, and save/load round-trip.

**What it cannot catch:** there is no CSS cascade and no real layout in it. Styling,
specificity and touch behaviour are invisible to the tests — those need a browser.

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

---

## Known gaps / possible next steps

- Realized P/L is average-cost only. FIFO lots would need per-lot tracking.
- History has no virtualization; a run with thousands of fills will scroll heavily.
- No import for a previously exported save (export only, CSV + JSON).
- Simulated rivals are a smooth deterministic curve, not actual simulated portfolios.
- Today's daily bar is derived from intraday, while past days come from the daily
  walk — so a bar shifts slightly when "today" becomes "yesterday". Cosmetic and
  invisible in practice, but it is a known inconsistency.
