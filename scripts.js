/* ============================================================================
   PAPER TRADER
   A fake stock market. Every ticker, price and headline here is invented.

   Architecture note — the important one:
   Prices are a *pure deterministic function* of (seed, ticker, timestamp).
   Nothing about the market is stored; it is regenerated from the seed on every
   load. That gives us three things for free:
     1. Save files stay tiny (only your portfolio is persisted).
     2. Reopening after a week "backfills" instantly — the market kept moving
        because it was never running in the first place.
     3. Pending limit/stop orders can be settled retroactively by replaying the
        bars that occurred while the app was closed.
   ========================================================================== */
(function () {
'use strict';

/* ============================================================================
   1. CONSTANTS & SMALL UTILITIES
   ========================================================================== */

var STORE_KEY   = 'paper-trader/v1';
var START_CASH  = 10000;
var HISTORY_DAYS = 730;          // how far back the daily series is generated
var MIN_PRICE   = 0.75;          // hard floor; prices never reach zero
var TICK_MS     = 2000;          // live price refresh
var SUBSTEPS    = 30;            // sub-minute path resolution (30 x 2s = 60s)
var MINUTES_DAY = 1440;
var DAY_MS      = 86400000;

var $  = function (sel, root) { return (root || document).querySelector(sel); };
var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

function el(tag, attrs, children) {
  var node = document.createElement(tag);
  if (attrs) {
    for (var k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, v);
    }
  }
  if (children) {
    (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
  }
  return node;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

/* ── Number formatting ─────────────────────────────────────────────────────
   One place, so a price never renders two different ways in two views. */

function money(n, dp) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  dp = dp === undefined ? 2 : dp;
  var neg = n < 0;
  var s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return (neg ? '-$' : '$') + s;
}
function signedMoney(n, dp) {
  if (!isFinite(n)) return '—';
  var sign = n > 0 ? '+' : n < 0 ? '−' : '';
  dp = dp === undefined ? 2 : dp;
  return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function pct(n, dp) {
  if (!isFinite(n)) return '—';
  dp = dp === undefined ? 2 : dp;
  return n.toFixed(dp) + '%';
}
function signedPct(n, dp) {
  if (!isFinite(n)) return '—';
  var sign = n > 0 ? '+' : n < 0 ? '−' : '';
  dp = dp === undefined ? 2 : dp;
  return sign + Math.abs(n).toFixed(dp) + '%';
}
function shares(n) {
  if (!isFinite(n)) return '—';
  // Whole share counts read cleaner without ".00000"; fractions keep 5dp.
  return Math.abs(n - Math.round(n)) < 1e-9
    ? Math.round(n).toLocaleString('en-US')
    : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 5 });
}
function compact(n) {
  var a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (a >= 1e9)  return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6)  return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3)  return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function toneOf(n) { return n > 0 ? 'pos' : n < 0 ? 'neg' : 'flat'; }

/* ── Dates ───────────────────────────────────────────────────────────────── */

function startOfDay(ts) { var d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
function dayNum(ts) { return Math.round(startOfDay(ts) / DAY_MS); }   // round survives DST
function dayStartTs(dn) { return dn * DAY_MS - new Date(dn * DAY_MS).getTimezoneOffset() * 60000; }
function minuteOfDay(ts) { var d = new Date(ts); return d.getHours() * 60 + d.getMinutes(); }

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtDayHeading(ts) {
  var dn = dayNum(ts), today = dayNum(Date.now());
  if (dn === today) return 'Today';
  if (dn === today - 1) return 'Yesterday';
  var opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (new Date(ts).getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return new Date(ts).toLocaleDateString('en-US', opts);
}
function relTime(ts) {
  var s = (Date.now() - ts) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  if (s < 86400 * 7) return Math.round(s / 86400) + 'd ago';
  return fmtDate(ts);
}

/* ── Seeded randomness ─────────────────────────────────────────────────────
   mulberry32 + a string hash, so any (seed, ticker, day, purpose) tuple maps to
   its own reproducible stream. */

function hash32(str) {
  var h = 2166136261 >>> 0;
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function streamFor(parts) { return mulberry32(hash32(parts.join('|'))); }

function gauss(rng) {
  // Box–Muller. Clamped so one freak draw can't blow a price up 40%.
  var u = 1 - rng(), v = rng();
  var g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return clamp(g, -3.6, 3.6);
}

/* ============================================================================
   2. THE UNIVERSE — 42 invented companies
   drift : daily log-drift          vol : daily log-volatility
   beta  : sensitivity to the market-wide factor
   ========================================================================== */

var SECTORS = {
  'Technology':    '#4c8dff',
  'Healthcare':    '#31c9a0',
  'Financials':    '#f0b429',
  'Energy':        '#ff7a45',
  'Consumer':      '#c084fc',
  'Industrials':   '#8b9bb4',
  'Communication': '#3ecfd6',
  'Utilities':     '#5b8c6e',
  'Materials':     '#d98a5f',
  'Real Estate':   '#e06c9f'
};

var UNIVERSE = [
  // sym      name                          sector           p0     drift     vol    beta
  ['NVTX', 'Novatix Semiconductor',      'Technology',     118.40,  0.00082, 0.0330, 1.45],
  ['HLYX', 'Helyx Systems',              'Technology',      74.20,  0.00061, 0.0272, 1.20],
  ['QBTA', 'Quanbit Analytics',          'Technology',     212.75,  0.00074, 0.0300, 1.32],
  ['ZEPH', 'Zephyr Cloud',               'Technology',      54.10,  0.00058, 0.0288, 1.25],
  ['ORBM', 'Orbmark Robotics',           'Technology',      31.65,  0.00095, 0.0455, 1.62],
  ['SLTH', 'Solterra Holdings',          'Technology',      88.90,  0.00046, 0.0245, 1.10],
  ['VYRA', 'Vyra Interactive',           'Technology',      16.30,  0.00110, 0.0620, 1.85],

  ['MEDR', 'Medrion Therapeutics',       'Healthcare',     143.20,  0.00048, 0.0292, 0.82],
  ['CLVA', 'Calviva Biosciences',        'Healthcare',      27.85,  0.00088, 0.0525, 1.05],
  ['NRVN', 'Nirvana Health Group',       'Healthcare',      96.55,  0.00034, 0.0198, 0.62],
  ['PXGN', 'Praxigen Labs',              'Healthcare',      61.10,  0.00066, 0.0378, 0.95],
  ['ASTM', 'Asterim Devices',            'Healthcare',      44.70,  0.00040, 0.0230, 0.74],

  ['FRSB', 'First Sable Bancorp',        'Financials',      52.35,  0.00030, 0.0192, 0.96],
  ['KRWN', 'Krownbridge Capital',        'Financials',     187.40,  0.00038, 0.0221, 1.08],
  ['ATLI', 'Atlas Line Insurance',       'Financials',      79.60,  0.00026, 0.0165, 0.71],
  ['VNTR', 'Venturi Payments',           'Financials',     134.25,  0.00070, 0.0305, 1.28],
  ['HDGE', 'Hedgemont Partners',         'Financials',      23.90,  0.00034, 0.0248, 1.14],

  ['PTRC', 'Petrocore Energy',           'Energy',          63.75,  0.00022, 0.0288, 0.88],
  ['GLDN', 'Golden Ridge Petroleum',     'Energy',          41.20,  0.00018, 0.0322, 0.92],
  ['SUNQ', 'Sunquell Renewables',        'Energy',          18.45,  0.00075, 0.0512, 1.40],
  ['VLTC', 'Voltaic Grid',               'Energy',          29.80,  0.00052, 0.0365, 1.12],

  ['BRWG', 'Brewgard Beverages',         'Consumer',        58.90,  0.00028, 0.0172, 0.58],
  ['MRVL', 'Marvelo Retail Group',       'Consumer',       112.30,  0.00042, 0.0225, 0.86],
  ['TSTE', 'Tastebud Foods',             'Consumer',        34.15,  0.00024, 0.0158, 0.48],
  ['LUXE', 'Luxevale Brands',            'Consumer',       205.60,  0.00050, 0.0264, 0.94],
  ['PWDR', 'Powdersnow Apparel',         'Consumer',        12.75,  0.00068, 0.0548, 1.35],

  ['IRNW', 'Ironworks Manufacturing',    'Industrials',     87.45,  0.00032, 0.0208, 1.02],
  ['AERD', 'Aeroded Aerospace',          'Industrials',    156.80,  0.00044, 0.0246, 1.06],
  ['FRGT', 'Freightline Logistics',      'Industrials',     68.20,  0.00030, 0.0219, 0.98],
  ['CNSTR', 'Constrata Group',           'Industrials',     45.55,  0.00026, 0.0234, 1.04],

  ['ECHO', 'Echostream Media',           'Communication',   77.90,  0.00056, 0.0298, 1.18],
  ['LNKV', 'Linkverse Social',           'Communication',   39.40,  0.00084, 0.0472, 1.52],
  ['TLCM', 'Telcomma Networks',          'Communication',   26.65,  0.00016, 0.0176, 0.66],
  ['PIXL', 'Pixelith Studios',           'Communication',   93.15,  0.00062, 0.0356, 1.24],

  ['NGRD', 'Northgrid Utility',          'Utilities',       71.30,  0.00014, 0.0118, 0.34],
  ['AQFR', 'Aquifer Water Co',           'Utilities',       55.85,  0.00012, 0.0104, 0.28],
  ['STDY', 'Steadypoint Power',          'Utilities',       48.20,  0.00015, 0.0126, 0.38],

  ['COPR', 'Copperfield Mining',         'Materials',       36.90,  0.00028, 0.0334, 1.08],
  ['TERR', 'Terrafine Chemicals',        'Materials',       64.40,  0.00024, 0.0242, 0.90],
  ['ALLY', 'Alloyd Metals',              'Materials',       22.10,  0.00030, 0.0368, 1.16],

  ['HRTH', 'Hearthstone Realty',         'Real Estate',     83.75,  0.00020, 0.0186, 0.78],
  ['SKYP', 'Skypoint Properties',        'Real Estate',     41.85,  0.00025, 0.0224, 0.88]
];

var STOCKS = {};      // sym -> descriptor
var SYMBOLS = [];

UNIVERSE.forEach(function (r) {
  var s = {
    sym: r[0], name: r[1], sector: r[2],
    p0: r[3], drift: r[4], vol: r[5], beta: r[6],
    color: SECTORS[r[2]],
    // Deterministic per-company traits used for the stats panel.
    floatShares: 0, baseVolume: 0
  };
  var rng = streamFor(['static', s.sym]);
  s.floatShares = Math.round((40 + rng() * 900) * 1e6);
  s.baseVolume = Math.round((0.4 + rng() * 9) * 1e6);
  STOCKS[s.sym] = s;
  SYMBOLS.push(s.sym);
});

function initials(sym) { return sym.slice(0, 2); }

/* ============================================================================
   3. MARKET SESSIONS
   The market technically never sleeps here — it would be a poor game if half
   the week were dead — but volatility is scaled by session and the header
   reports the real one, so weekends genuinely feel quiet.
   ========================================================================== */

function sessionAt(ts) {
  var d = new Date(ts);
  var day = d.getDay();
  var m = d.getHours() * 60 + d.getMinutes();
  if (day === 0 || day === 6) return 'weekend';
  if (m >= 570 && m < 960) return 'open';        // 9:30 – 16:00
  if ((m >= 240 && m < 570) || (m >= 960 && m < 1200)) return 'ext';  // 4:00–9:30, 16:00–20:00
  return 'closed';
}
function sessionMult(dn, minute) {
  var d = new Date(dayStartTs(dn) + minute * 60000);
  var day = d.getDay();
  if (day === 0 || day === 6) return 0.15;
  if (minute >= 570 && minute < 960) return 1.0;
  if ((minute >= 240 && minute < 570) || (minute >= 960 && minute < 1200)) return 0.4;
  return 0.12;
}
function sessionLabel(ts) {
  switch (sessionAt(ts)) {
    case 'open':    return { text: 'Market open', kind: 'open' };
    case 'ext':     return { text: 'After hours', kind: 'ext' };
    case 'weekend': return { text: 'Weekend', kind: 'closed' };
    default:        return { text: 'Closed', kind: 'closed' };
  }
}

/* ============================================================================
   4. NEWS
   Deterministic per (ticker, day). A headline both gaps the price and lands in
   the feed, so the move always has a visible reason attached.
   ========================================================================== */

var NEWS_GOOD = [
  ['{n} beats quarterly estimates', 'Earnings'],
  ['{n} raises full-year guidance', 'Guidance'],
  ['Analysts upgrade {s} to Overweight', 'Rating'],
  ['{n} lands major enterprise contract', 'Business'],
  ['{n} announces buyback program', 'Capital'],
  ['{n} clears key regulatory hurdle', 'Regulatory'],
  ['{n} reports record unit shipments', 'Operations'],
  ['{n} expands into three new markets', 'Business']
];
var NEWS_BAD = [
  ['{n} misses on revenue', 'Earnings'],
  ['{n} cuts full-year outlook', 'Guidance'],
  ['Analysts downgrade {s} to Underweight', 'Rating'],
  ['{n} discloses supply chain disruption', 'Operations'],
  ['Regulators open inquiry into {n}', 'Regulatory'],
  ['{n} loses flagship customer', 'Business'],
  ['{n} delays product launch', 'Operations'],
  ['{n} chief executive steps down', 'Leadership']
];

function newsFor(sym, dn) {
  var rng = streamFor([state.seed, 'news', sym, dn]);
  if (rng() > 0.035) return null;                       // ~3.5% of days
  var good = rng() > 0.46;
  var mag = 0.028 + rng() * 0.11;                       // 2.8% – 13.8%
  var list = good ? NEWS_GOOD : NEWS_BAD;
  var pick = list[Math.floor(rng() * list.length)];
  var st = STOCKS[sym];
  return {
    sym: sym,
    dn: dn,
    minute: 540 + Math.floor(rng() * 400),              // lands during the session
    jump: good ? mag : -mag,
    good: good,
    headline: pick[0].replace('{n}', st.name).replace('{s}', sym),
    tag: pick[1]
  };
}

/* ============================================================================
   5. PRICE ENGINE — daily series
   ========================================================================== */

var dailyCache = null;       // sym -> [{t,o,h,l,c,v,dn}]
var dailyBaseDn = 0;

function marketLogRet(dn) {
  var rng = streamFor([state.seed, 'market', dn]);
  return 0.00030 + 0.0092 * gauss(rng);
}

/* Returns the log return for one ticker on one day, split so intraday can
   apply the news gap at the right minute instead of smearing it over the day. */
function dayLogRet(st, dn, price, anchor) {
  var rng = streamFor([state.seed, 'day', st.sym, dn]);
  var idio = st.vol * gauss(rng);
  var mkt = st.beta * marketLogRet(dn);
  // Soft mean reversion toward a slowly compounding anchor — this is the
  // guardrail that stops a ticker drifting to $0.80 or $9,000 over two years.
  var revert = -0.014 * Math.log(price / anchor);
  var base = st.drift + mkt + idio + clamp(revert, -0.05, 0.05);
  var news = newsFor(st.sym, dn);
  return { base: base, jump: news ? Math.log(1 + news.jump) : 0, news: news };
}

function buildDaily() {
  dailyCache = {};
  var today = dayNum(Date.now());
  dailyBaseDn = today - HISTORY_DAYS;

  SYMBOLS.forEach(function (sym) {
    var st = STOCKS[sym];
    var bars = new Array(HISTORY_DAYS);
    var price = st.p0;
    for (var i = 0; i < HISTORY_DAYS; i++) {
      var dn = dailyBaseDn + i;
      var anchor = st.p0 * Math.exp(st.drift * i);
      var r = dayLogRet(st, dn, price, anchor);
      var total = r.base + r.jump;

      var prev = price;
      var close = Math.max(MIN_PRICE, prev * Math.exp(total));
      // Open gaps slightly from the prior close; H/L wrap the O–C body.
      var brng = streamFor([state.seed, 'bar', sym, dn]);
      var open = Math.max(MIN_PRICE, prev * Math.exp((r.jump ? r.jump : 0) + st.vol * 0.22 * gauss(brng)));
      var hi = Math.max(open, close) * (1 + Math.abs(gauss(brng)) * st.vol * 0.42);
      var lo = Math.min(open, close) * (1 - Math.abs(gauss(brng)) * st.vol * 0.42);
      lo = Math.max(MIN_PRICE * 0.9, Math.min(lo, Math.min(open, close)));
      hi = Math.max(hi, Math.max(open, close));

      bars[i] = {
        dn: dn,
        t: dayStartTs(dn) + 60000 * 780,
        o: open, h: hi, l: lo, c: close,
        v: Math.round(st.baseVolume * (0.55 + brng() * 1.1) * (1 + 9 * Math.abs(total)))
      };
      price = close;
    }
    dailyCache[sym] = bars;
  });
}

function dailyBars(sym) { return dailyCache[sym]; }

/* Close of the day *before* dn — the reference for "today's change". */
function closeBefore(sym, dn) {
  var bars = dailyCache[sym];
  var i = dn - dailyBaseDn - 1;
  if (i < 0) return STOCKS[sym].p0;
  if (i >= bars.length) i = bars.length - 1;
  return bars[i].c;
}

/* ============================================================================
   6. PRICE ENGINE — intraday
   One minute-resolution walk per (ticker, day), plus a Brownian bridge inside
   the current minute so the live candle visibly grows between ticks.
   ========================================================================== */

var intradayCache = new Map();      // "sym|dn" -> {closes, vols, dn, sym, full}
var INTRADAY_CACHE_MAX = 400;

function buildIntradayCloses(sym, dn) {
  var st = STOCKS[sym];
  var prevClose = closeBefore(sym, dn);
  var anchor = st.p0 * Math.exp(st.drift * (dn - dailyBaseDn));
  var r = dayLogRet(st, dn, prevClose, anchor);
  var perMinDrift = r.base / MINUTES_DAY;
  var sigma = st.vol / Math.sqrt(600);

  var rng = streamFor([state.seed, 'intra', sym, dn]);
  var vrng = streamFor([state.seed, 'ivol', sym, dn]);
  var closes = new Float64Array(MINUTES_DAY);
  var vols = new Float64Array(MINUTES_DAY);
  var p = prevClose;
  var baseVol = st.baseVolume / 500;

  for (var m = 0; m < MINUTES_DAY; m++) {
    var mult = sessionMult(dn, m);
    var step = perMinDrift + sigma * mult * gauss(rng);
    if (r.news && m === r.news.minute) step += r.jump;
    p = Math.max(MIN_PRICE, p * Math.exp(step));
    closes[m] = p;
    vols[m] = Math.round(baseVol * mult * (0.3 + vrng() * 1.7) * (1 + 45 * Math.abs(step)));
  }
  return { sym: sym, dn: dn, closes: closes, vols: vols, prevClose: prevClose, news: r.news };
}

function intradayFor(sym, dn) {
  var key = sym + '|' + dn;
  var hit = intradayCache.get(key);
  if (hit) return hit;
  var built = buildIntradayCloses(sym, dn);
  if (intradayCache.size >= INTRADAY_CACHE_MAX) {
    // Cheap LRU-ish eviction: drop the oldest inserted key.
    var firstKey = intradayCache.keys().next().value;
    intradayCache.delete(firstKey);
  }
  intradayCache.set(key, built);
  return built;
}

/* Path inside a single minute — bridges prevMinuteClose -> thisMinuteClose. */
function subPath(sym, dn, minute, upto) {
  var day = intradayFor(sym, dn);
  var from = minute === 0 ? day.prevClose : day.closes[minute - 1];
  var to = day.closes[minute];
  var amp = from * STOCKS[sym].vol * 0.05 * sessionMult(dn, minute);
  var rng = streamFor([state.seed, 'sub', sym, dn, minute]);
  var out = [];
  for (var k = 0; k <= upto; k++) {
    var f = (k + 1) / SUBSTEPS;
    var v = from + (to - from) * f + amp * gauss(rng) * Math.sqrt(f * (1 - f));
    out.push(Math.max(MIN_PRICE, v));
  }
  return out;
}

/* The number every view reads. */
function livePrice(sym, ts) {
  ts = ts || Date.now();
  var dn = dayNum(ts);
  var m = minuteOfDay(ts);
  var sec = new Date(ts).getSeconds();
  var k = Math.min(SUBSTEPS - 1, Math.floor(sec / (60 / SUBSTEPS)));
  var path = subPath(sym, dn, m, k);
  return path[path.length - 1];
}

/* Today's live candle (open/high/low/close so far within the current minute
   is folded into the last bucket by the aggregator below). */
function todayChange(sym, ts) {
  ts = ts || Date.now();
  var dn = dayNum(ts);
  var prev = closeBefore(sym, dn);
  var p = livePrice(sym, ts);
  return { price: p, prev: prev, abs: p - prev, pct: ((p - prev) / prev) * 100 };
}

/* ── Bar assembly ─────────────────────────────────────────────────────────── */

function minuteBar(sym, dn, m, live) {
  var day = intradayFor(sym, dn);
  var open = m === 0 ? day.prevClose : day.closes[m - 1];
  var close = day.closes[m];
  var t = dayStartTs(dn) + m * 60000;
  if (live) {
    var sec = new Date().getSeconds();
    var k = Math.min(SUBSTEPS - 1, Math.floor(sec / (60 / SUBSTEPS)));
    var path = subPath(sym, dn, m, k);
    close = path[path.length - 1];
    var hi = open, lo = open;
    for (var i = 0; i < path.length; i++) { if (path[i] > hi) hi = path[i]; if (path[i] < lo) lo = path[i]; }
    return { t: t, o: open, h: hi, l: lo, c: close, v: day.vols[m] * ((k + 1) / SUBSTEPS) };
  }
  var wig = Math.abs(close - open) * 0.55 + open * STOCKS[sym].vol * 0.012;
  return { t: t, o: open, h: Math.max(open, close) + wig, l: Math.max(MIN_PRICE, Math.min(open, close) - wig), c: close, v: day.vols[m] };
}

/* Minute bars for a whole day (or up to "now" if the day is today). */
function minuteBars(sym, dn) {
  var now = Date.now();
  var isToday = dn === dayNum(now);
  var last = isToday ? minuteOfDay(now) : MINUTES_DAY - 1;
  var out = new Array(last + 1);
  for (var m = 0; m <= last; m++) out[m] = minuteBar(sym, dn, m, isToday && m === last);
  return out;
}

/* Fold N source bars into one bucket. */
function bucket(bars, size) {
  if (size <= 1) return bars.slice();
  var out = [];
  for (var i = 0; i < bars.length; i += size) {
    var slice = bars.slice(i, i + size);
    var h = -Infinity, l = Infinity, v = 0;
    for (var j = 0; j < slice.length; j++) {
      if (slice[j].h > h) h = slice[j].h;
      if (slice[j].l < l) l = slice[j].l;
      v += slice[j].v;
    }
    out.push({ t: slice[0].t, o: slice[0].o, h: h, l: l, c: slice[slice.length - 1].c, v: v });
  }
  return out;
}

var TIMEFRAMES = ['1D', '1W', '1M', '3M', '1Y', 'ALL'];

/* The one entry point charts use. */
function barsFor(sym, tf) {
  var today = dayNum(Date.now());
  var d, i;
  if (tf === '1D') {
    return bucket(minuteBars(sym, today), 3);                  // 3-minute candles
  }
  if (tf === '1W') {
    var all = [];
    for (d = 6; d >= 0; d--) all = all.concat(minuteBars(sym, today - d));
    return bucket(all, 60);                                     // hourly
  }
  var daily = dailyBars(sym);
  var live = todayLiveDaily(sym);
  var hist = daily.slice();                                     // ends yesterday
  hist.push(live);
  if (tf === '1M')  return hist.slice(-31);
  if (tf === '3M')  return hist.slice(-91);
  if (tf === '1Y')  return bucket(hist.slice(-365), 3);
  return bucket(hist, 7);                                       // ALL -> weekly
}

/* Today's daily bar is synthesised from the live intraday walk so the last
   candle on a 1M/3M/1Y chart moves with the price. */
function todayLiveDaily(sym) {
  var dn = dayNum(Date.now());
  var day = intradayFor(sym, dn);
  var m = minuteOfDay(Date.now());
  var hi = -Infinity, lo = Infinity;
  for (var i = 0; i <= m && i < MINUTES_DAY; i++) {
    if (day.closes[i] > hi) hi = day.closes[i];
    if (day.closes[i] < lo) lo = day.closes[i];
  }
  var p = livePrice(sym);
  return {
    dn: dn, t: dayStartTs(dn) + 60000 * 780,
    o: day.prevClose, h: Math.max(hi, p), l: Math.min(lo, p), c: p,
    v: Math.round(STOCKS[sym].baseVolume * (m / MINUTES_DAY))
  };
}

/* Compact series for sparklines — cheap, no bucketing machinery. */
function sparkSeries(sym) {
  var dn = dayNum(Date.now());
  var day = intradayFor(sym, dn);
  var m = minuteOfDay(Date.now());
  var out = [day.prevClose];
  var step = Math.max(1, Math.floor((m + 1) / 40));
  for (var i = 0; i <= m; i += step) out.push(day.closes[i]);
  out.push(livePrice(sym));
  return out;
}

/* 52-week high / low, used in the stats panel. */
function yearRange(sym) {
  var bars = dailyBars(sym).slice(-252);
  var hi = -Infinity, lo = Infinity;
  for (var i = 0; i < bars.length; i++) {
    if (bars[i].h > hi) hi = bars[i].h;
    if (bars[i].l < lo) lo = bars[i].l;
  }
  var p = livePrice(sym);
  return { hi: Math.max(hi, p), lo: Math.min(lo, p) };
}

/* ============================================================================
   7. STATE & PERSISTENCE
   Only the things the engine cannot regenerate are stored.
   ========================================================================== */

var state = null;
var saveTimer = null;

function freshState(seed) {
  return {
    v: 1,
    seed: seed || (Math.floor(Math.random() * 4294967295) >>> 0),
    createdAt: Date.now(),
    lastSeen: Date.now(),
    cash: START_CASH,
    positions: {},            // sym -> {shares, avgCost, realized}
    orders: [],               // open + historical orders
    history: [],              // executions & cancellations, newest last
    notes: [],
    watchlist: ['NVTX', 'MEDR', 'VNTR', 'SUNQ', 'LUXE', 'LNKV'],
    snapshots: [],            // [{t, v}] net worth over time
    news: [],                 // seen headlines, newest last
    settings: {
      palette: 'classic',
      chartType: 'line',
      timeframe: '1D',
      realism: false,         // bid/ask spread + slippage
      reducedMotion: false,
      haptics: true,
      onboarded: false
    },
    stats: {
      tradeCount: 0,
      bestTrade: null,
      worstTrade: null,
      streakDays: 1,
      lastActiveDn: dayNum(Date.now()),
      badges: []
    }
  };
}

function load() {
  var raw = null;
  try { raw = localStorage.getItem(STORE_KEY); } catch (e) { raw = null; }
  if (!raw) return freshState();
  try {
    var s = JSON.parse(raw);
    var base = freshState(s.seed);
    // Shallow-merge so a save from an older build still boots.
    for (var k in base) if (!(k in s)) s[k] = base[k];
    s.settings = Object.assign({}, base.settings, s.settings || {});
    s.stats = Object.assign({}, base.stats, s.stats || {});
    return s;
  } catch (e) {
    console.warn('Save file unreadable, starting fresh.', e);
    return freshState();
  }
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(function () {
    saveTimer = null;
    try {
      if (state.snapshots.length > 4000) state.snapshots = state.snapshots.slice(-4000);
      if (state.news.length > 200) state.news = state.news.slice(-200);
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('Could not persist state.', e);
    }
  }, 400);
}
function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
}

/* ============================================================================
   8. PORTFOLIO MATH
   Everything derived is computed on demand. Nothing derived is ever stored,
   so no two numbers can drift out of agreement.
   ========================================================================== */

function heldSymbols() {
  return Object.keys(state.positions).filter(function (s) { return state.positions[s].shares > 1e-9; });
}
function positionOf(sym) {
  return state.positions[sym] || { shares: 0, avgCost: 0, realized: 0 };
}
function holdingsValue() {
  return heldSymbols().reduce(function (sum, sym) {
    return sum + positionOf(sym).shares * livePrice(sym);
  }, 0);
}
function netWorth() { return state.cash + holdingsValue(); }

/* Cash committed to resting buy orders can't be spent twice. */
function reservedCash() {
  return state.orders.reduce(function (sum, o) {
    if (o.status !== 'open' || o.side !== 'buy') return sum;
    var ref = o.type === 'limit' ? o.limitPrice : o.stopPrice;
    return sum + (o.notional !== null && o.notional !== undefined ? o.notional : o.qty * ref);
  }, 0);
}
function buyingPower() { return Math.max(0, state.cash - reservedCash()); }

/* Shares committed to resting sell orders likewise. */
function reservedShares(sym) {
  return state.orders.reduce(function (sum, o) {
    return (o.status === 'open' && o.side === 'sell' && o.ticker === sym) ? sum + o.qty : sum;
  }, 0);
}
function sellableShares(sym) { return Math.max(0, positionOf(sym).shares - reservedShares(sym)); }

function unrealizedPL(sym) {
  var p = positionOf(sym);
  if (p.shares <= 1e-9) return { abs: 0, pct: 0 };
  var cost = p.shares * p.avgCost;
  var val = p.shares * livePrice(sym);
  return { abs: val - cost, pct: cost > 0 ? ((val - cost) / cost) * 100 : 0 };
}
function totalUnrealized() {
  return heldSymbols().reduce(function (s, sym) { return s + unrealizedPL(sym).abs; }, 0);
}
function totalRealized() {
  return Object.keys(state.positions).reduce(function (s, sym) {
    return s + (state.positions[sym].realized || 0);
  }, 0);
}
function totalReturn() {
  var nw = netWorth();
  return { abs: nw - START_CASH, pct: ((nw - START_CASH) / START_CASH) * 100 };
}

/* Today's P/L = change in the market value of what you hold since yesterday's
   close, which is the number that matches the ticker percentages on screen. */
function todayPL() {
  var dn = dayNum(Date.now());
  return heldSymbols().reduce(function (sum, sym) {
    var p = positionOf(sym);
    return sum + p.shares * (livePrice(sym) - closeBefore(sym, dn));
  }, 0);
}

function allocation() {
  var held = heldSymbols();
  var total = holdingsValue() + state.cash;
  var items = held.map(function (sym) {
    var v = positionOf(sym).shares * livePrice(sym);
    return { key: sym, label: sym, value: v, pct: total > 0 ? (v / total) * 100 : 0, color: STOCKS[sym].color };
  });
  items.sort(function (a, b) { return b.value - a.value; });
  if (state.cash > 0.005) {
    items.push({ key: '__cash', label: 'Cash', value: state.cash, pct: total > 0 ? (state.cash / total) * 100 : 0, color: '#4a5461' });
  }
  return items;
}
function allocationBySector() {
  var map = {}, total = holdingsValue();
  heldSymbols().forEach(function (sym) {
    var sec = STOCKS[sym].sector;
    map[sec] = (map[sec] || 0) + positionOf(sym).shares * livePrice(sym);
  });
  return Object.keys(map).map(function (sec) {
    return { key: sec, label: sec, value: map[sec], pct: total > 0 ? (map[sec] / total) * 100 : 0, color: SECTORS[sec] };
  }).sort(function (a, b) { return b.value - a.value; });
}

/* ============================================================================
   9. ORDERS
   Two verbs only — buy and sell. There is no counterparty here, so "trade" was
   never a distinct action; it's just the pair of them.
   ========================================================================== */

function spreadFor(sym) { return state.settings.realism ? 0.0004 + STOCKS[sym].vol * 0.012 : 0; }

/* What a market order actually fills at, once spread and slippage are on. */
function fillPrice(sym, side, ts) {
  var mid = livePrice(sym, ts);
  if (!state.settings.realism) return mid;
  var half = spreadFor(sym) / 2;
  var slip = STOCKS[sym].vol * 0.05 * Math.random();
  return side === 'buy' ? mid * (1 + half + slip) : mid * (1 - half - slip);
}

function quoteFor(sym) {
  var mid = livePrice(sym);
  var half = spreadFor(sym) / 2;
  return { mid: mid, bid: mid * (1 - half), ask: mid * (1 + half) };
}

function validateOrder(o) {
  var st = STOCKS[o.ticker];
  if (!st) return 'Unknown ticker.';
  var qty = o.qty;

  if (o.notional !== null && o.notional !== undefined) {
    if (!isFinite(o.notional) || o.notional <= 0) return 'Enter an amount above $0.';
    if (o.notional < 1) return 'Minimum order is $1.00.';
    var ref = o.type === 'market' ? quoteFor(o.ticker).ask : (o.limitPrice || o.stopPrice);
    qty = o.notional / ref;
  }
  if (!isFinite(qty) || qty <= 0) return 'Enter a quantity above zero.';
  if (qty > 1e7) return 'That quantity is unrealistically large.';

  if (o.type === 'limit') {
    if (!isFinite(o.limitPrice) || o.limitPrice <= 0) return 'Enter a limit price above $0.';
    if (o.limitPrice > livePrice(o.ticker) * 12) return 'Limit price is implausibly far from the market.';
  }
  if (o.type === 'stop') {
    if (!isFinite(o.stopPrice) || o.stopPrice <= 0) return 'Enter a stop price above $0.';
    if (o.side === 'sell' && o.stopPrice >= livePrice(o.ticker)) return 'A stop-loss must sit below the current price.';
    if (o.side === 'buy' && o.stopPrice <= livePrice(o.ticker)) return 'A buy stop must sit above the current price.';
  }

  if (o.side === 'buy') {
    var cost = o.notional !== null && o.notional !== undefined
      ? o.notional
      : qty * (o.type === 'market' ? quoteFor(o.ticker).ask : (o.limitPrice || o.stopPrice));
    if (cost > buyingPower() + 1e-6) {
      return 'Not enough buying power. You have ' + money(buyingPower()) + ' available.';
    }
  } else {
    var avail = sellableShares(o.ticker);
    if (avail <= 1e-9) return 'You do not own any ' + o.ticker + '.';
    if (qty > avail + 1e-9) return 'You can sell at most ' + shares(avail) + ' shares.';
  }
  return null;
}

/* The single mutation point for money and positions. */
function executeFill(order, price, ts, note) {
  ts = ts || Date.now();
  var sym = order.ticker;
  var qty = order.qty;

  if (order.notional !== null && order.notional !== undefined) {
    qty = order.notional / price;
  }
  qty = Math.max(0, qty);
  if (qty <= 1e-9) return null;

  var pos = state.positions[sym] || (state.positions[sym] = { shares: 0, avgCost: 0, realized: 0 });
  var total = qty * price;
  var realized = null;

  if (order.side === 'buy') {
    if (total > state.cash + 1e-6) {
      // Can happen if a resting buy's reference price moved; scale it down.
      qty = state.cash / price;
      total = qty * price;
      if (qty <= 1e-9) return null;
    }
    var newShares = pos.shares + qty;
    pos.avgCost = newShares > 0 ? (pos.shares * pos.avgCost + total) / newShares : price;
    pos.shares = newShares;
    state.cash -= total;
  } else {
    qty = Math.min(qty, pos.shares);
    total = qty * price;
    realized = (price - pos.avgCost) * qty;      // average-cost basis
    pos.realized = (pos.realized || 0) + realized;
    pos.shares -= qty;
    state.cash += total;
    if (pos.shares <= 1e-9) { pos.shares = 0; }
  }

  var rec = {
    id: uid(),
    orderId: order.id,
    ts: ts,
    ticker: sym,
    side: order.side,
    type: order.type,
    qty: qty,
    price: price,
    total: total,
    cashAfter: state.cash,
    realized: realized,
    status: 'filled',
    note: note || null
  };
  state.history.push(rec);
  state.stats.tradeCount++;

  if (realized !== null) {
    if (!state.stats.bestTrade || realized > state.stats.bestTrade.realized) {
      state.stats.bestTrade = { ticker: sym, realized: realized, ts: ts };
    }
    if (!state.stats.worstTrade || realized < state.stats.worstTrade.realized) {
      state.stats.worstTrade = { ticker: sym, realized: realized, ts: ts };
    }
  }

  order.status = 'filled';
  order.filledAt = ts;
  order.filledPrice = price;
  order.filledQty = qty;
  return rec;
}

/* Public entry: returns {ok, error, record, order}. */
function placeOrder(spec) {
  var order = {
    id: uid(),
    ticker: spec.ticker,
    side: spec.side,
    type: spec.type,
    qty: spec.qty !== undefined && spec.qty !== null ? Number(spec.qty) : null,
    notional: spec.notional !== undefined && spec.notional !== null ? Number(spec.notional) : null,
    limitPrice: spec.limitPrice !== undefined && spec.limitPrice !== null ? Number(spec.limitPrice) : null,
    stopPrice: spec.stopPrice !== undefined && spec.stopPrice !== null ? Number(spec.stopPrice) : null,
    createdAt: Date.now(),
    status: 'open'
  };

  var err = validateOrder(order);
  if (err) {
    order.status = 'rejected';
    order.reason = err;
    state.orders.push(order);
    state.history.push({
      id: uid(), orderId: order.id, ts: Date.now(), ticker: order.ticker, side: order.side,
      type: order.type, qty: order.qty || 0, price: livePrice(order.ticker), total: 0,
      cashAfter: state.cash, realized: null, status: 'rejected', note: err
    });
    save();
    return { ok: false, error: err, order: order };
  }

  state.orders.push(order);

  if (order.type === 'market') {
    var price = fillPrice(order.ticker, order.side);
    var rec = executeFill(order, price);
    afterTrade();
    return { ok: true, record: rec, order: order };
  }

  save();
  return { ok: true, record: null, order: order, resting: true };
}

function cancelOrder(id) {
  var o = null;
  for (var i = 0; i < state.orders.length; i++) if (state.orders[i].id === id) o = state.orders[i];
  if (!o || o.status !== 'open') return false;
  o.status = 'canceled';
  o.canceledAt = Date.now();
  state.history.push({
    id: uid(), orderId: o.id, ts: Date.now(), ticker: o.ticker, side: o.side, type: o.type,
    qty: o.qty || (o.notional ? o.notional / livePrice(o.ticker) : 0), price: livePrice(o.ticker),
    total: 0, cashAfter: state.cash, realized: null, status: 'canceled', note: 'Canceled by you'
  });
  save();
  return true;
}

function openOrders() {
  return state.orders.filter(function (o) { return o.status === 'open'; })
                     .sort(function (a, b) { return b.createdAt - a.createdAt; });
}

/* ── Resting-order settlement ──────────────────────────────────────────────
   Walks the minute series between two timestamps looking for the first bar
   that crosses the trigger. Because prices are deterministic, this works
   identically whether one second elapsed or one week. */

function triggerPriceInBar(order, bar) {
  if (order.type === 'limit') {
    if (order.side === 'buy'  && bar.l <= order.limitPrice) return Math.min(order.limitPrice, bar.o);
    if (order.side === 'sell' && bar.h >= order.limitPrice) return Math.max(order.limitPrice, bar.o);
  } else if (order.type === 'stop') {
    if (order.side === 'sell' && bar.l <= order.stopPrice) return Math.min(order.stopPrice, bar.o);
    if (order.side === 'buy'  && bar.h >= order.stopPrice) return Math.max(order.stopPrice, bar.o);
  }
  return null;
}

function scanForFill(order, fromTs, toTs) {
  if (toTs < fromTs) return null;
  var now = Date.now();
  var startDn = dayNum(fromTs), endDn = dayNum(toTs);
  // Cap the replay window; a save from months ago shouldn't churn for seconds.
  if (endDn - startDn > 10) { startDn = endDn - 10; fromTs = dayStartTs(startDn); }

  var todayDn = dayNum(now), nowMin = minuteOfDay(now);

  for (var dn = startDn; dn <= endDn; dn++) {
    var day = intradayFor(order.ticker, dn);
    var mStart = dn === startDn ? minuteOfDay(fromTs) : 0;
    var mEnd = dn === endDn ? Math.min(MINUTES_DAY - 1, minuteOfDay(toTs)) : MINUTES_DAY - 1;

    for (var m = mStart; m <= mEnd; m++) {
      // The first minute starts where the scan starts, not at the minute
      // boundary — otherwise an order could fill at a price that predates it.
      var o = (dn === startDn && m === mStart)
        ? livePrice(order.ticker, fromTs)
        : (m === 0 ? day.prevClose : day.closes[m - 1]);
      // The minute in progress ends at *now*, so nothing fills against a price
      // that has not happened yet.
      var c = (dn === todayDn && m === nowMin) ? livePrice(order.ticker, now) : day.closes[m];

      var bar = { o: o, c: c, h: Math.max(o, c), l: Math.min(o, c) };
      var p = triggerPriceInBar(order, bar);
      if (p !== null) {
        return { price: p, ts: Math.min(now, Math.max(fromTs, dayStartTs(dn) + m * 60000)) };
      }
    }
  }
  return null;
}

function processRestingOrders(fromTs, toTs) {
  var fills = [];
  openOrders().forEach(function (o) {
    var from = Math.max(o.createdAt, fromTs);
    var hit = scanForFill(o, from, toTs);
    if (!hit) return;
    var rec = executeFill(o, hit.price, hit.ts);
    if (rec) fills.push(rec);
  });
  if (fills.length) { afterTrade(); }
  return fills;
}

/* ============================================================================
   10. NOTES & ALERTS
   ========================================================================== */

var NOTE_TAGS = [
  { id: 'buy', label: 'Buy idea' },
  { id: 'sell', label: 'Sell target' },
  { id: 'research', label: 'Research' }
];

function notesFor(sym) {
  return state.notes.filter(function (n) { return n.ticker === sym; })
                    .sort(function (a, b) { return b.updatedAt - a.updatedAt; });
}
function saveNote(note) {
  var now = Date.now();
  if (note.id) {
    for (var i = 0; i < state.notes.length; i++) {
      if (state.notes[i].id === note.id) {
        var prev = state.notes[i];
        state.notes[i] = Object.assign({}, prev, note, { updatedAt: now });
        // Editing the alert conditions re-arms it.
        if (prev.targetPrice !== note.targetPrice || prev.direction !== note.direction) {
          state.notes[i].triggeredAt = null;
        }
        save();
        return state.notes[i];
      }
    }
  }
  var n = Object.assign({
    id: uid(), createdAt: now, updatedAt: now, triggeredAt: null
  }, note);
  state.notes.push(n);
  save();
  return n;
}
function deleteNote(id) {
  state.notes = state.notes.filter(function (n) { return n.id !== id; });
  save();
}
function activeAlerts() {
  return state.notes.filter(function (n) { return n.targetPrice && n.triggeredAt; });
}

/* Called every tick. Fires each alert once until it's re-armed. */
function checkAlerts() {
  var fired = [];
  state.notes.forEach(function (n) {
    if (!n.targetPrice || n.triggeredAt) return;
    var p = livePrice(n.ticker);
    var hit = n.direction === 'below' ? p <= n.targetPrice : p >= n.targetPrice;
    if (hit) {
      n.triggeredAt = Date.now();
      n.triggeredPrice = p;
      fired.push(n);
    }
  });
  if (fired.length) save();
  return fired;
}

/* ============================================================================
   11. NEWS FEED, SNAPSHOTS, STREAKS, BADGES, RIVALS
   ========================================================================== */

function collectNews(dn) {
  var out = [];
  SYMBOLS.forEach(function (sym) {
    var n = newsFor(sym, dn);
    if (n) out.push(n);
  });
  return out;
}

/* Headlines for the last N days, newest first, only those already "published"
   (i.e. whose minute has passed if the day is today). */
function recentNews(days, symFilter) {
  var today = dayNum(Date.now());
  var nowMin = minuteOfDay(Date.now());
  var out = [];
  for (var d = 0; d < days; d++) {
    var dn = today - d;
    collectNews(dn).forEach(function (n) {
      if (symFilter && n.sym !== symFilter) return;
      if (dn === today && n.minute > nowMin) return;
      out.push(Object.assign({}, n, { ts: dayStartTs(dn) + n.minute * 60000 }));
    });
  }
  out.sort(function (a, b) { return b.ts - a.ts; });
  return out;
}

function snapshotNetWorth() {
  var now = Date.now();
  var last = state.snapshots[state.snapshots.length - 1];
  if (last && now - last.t < 55000) return;
  state.snapshots.push({ t: now, v: Math.round(netWorth() * 100) / 100 });
  if (state.snapshots.length > 4000) state.snapshots = state.snapshots.slice(-4000);
}

function touchStreak() {
  var today = dayNum(Date.now());
  var last = state.stats.lastActiveDn;
  if (last === today) return;
  state.stats.streakDays = (today - last === 1) ? state.stats.streakDays + 1 : 1;
  state.stats.lastActiveDn = today;
  save();
}

var BADGES = [
  { id: 'first-trade', emoji: '🎬', name: 'First Trade',   test: function () { return state.stats.tradeCount >= 1; } },
  { id: 'ten-trades',  emoji: '🔁', name: '10 Trades',     test: function () { return state.stats.tradeCount >= 10; } },
  { id: 'diversified', emoji: '🧩', name: '5 Positions',   test: function () { return heldSymbols().length >= 5; } },
  { id: 'sector-spread', emoji: '🌐', name: '4 Sectors',   test: function () { return allocationBySector().length >= 4; } },
  { id: 'green',       emoji: '📈', name: 'In the Green',  test: function () { return netWorth() > START_CASH; } },
  { id: 'up-10',       emoji: '🚀', name: '+10% Return',   test: function () { return totalReturn().pct >= 10; } },
  { id: 'up-25',       emoji: '💎', name: '+25% Return',   test: function () { return totalReturn().pct >= 25; } },
  { id: 'realized-1k', emoji: '💰', name: '$1K Realized',  test: function () { return totalRealized() >= 1000; } },
  { id: 'limit-fill',  emoji: '🎯', name: 'Limit Filled',  test: function () {
      return state.history.some(function (h) { return h.status === 'filled' && h.type === 'limit'; }); } },
  { id: 'note-taker',  emoji: '📝', name: 'Note Taker',    test: function () { return state.notes.length >= 3; } },
  { id: 'alert-hit',   emoji: '🔔', name: 'Alert Fired',   test: function () { return state.notes.some(function (n) { return n.triggeredAt; }); } },
  { id: 'streak-3',    emoji: '🔥', name: '3-Day Streak',  test: function () { return state.stats.streakDays >= 3; } }
];

function checkBadges() {
  var earned = [];
  BADGES.forEach(function (b) {
    if (state.stats.badges.indexOf(b.id) !== -1) return;
    var ok = false;
    try { ok = b.test(); } catch (e) { ok = false; }
    if (ok) { state.stats.badges.push(b.id); earned.push(b); }
  });
  if (earned.length) save();
  return earned;
}

/* Three simulated rivals so the leaderboard has someone to beat. Their equity
   curve is a deterministic function of the seed and elapsed days. */
var RIVAL_NAMES = ['Quinn "Steady" Alvarez', 'Rook Nakamura', 'Delta Okafor'];

function rivalNetWorth(i) {
  var days = (Date.now() - state.createdAt) / DAY_MS;
  var rng = streamFor([state.seed, 'rival', i]);
  var skill = 0.0015 + rng() * 0.006;
  var vol = 0.012 + rng() * 0.02;
  var wobble = Math.sin(days * (1.3 + i * 0.7) + rng() * 6.28) * vol;
  return START_CASH * Math.exp(skill * days + wobble);
}
function leaderboard() {
  var rows = RIVAL_NAMES.map(function (name, i) {
    return { name: name, value: rivalNetWorth(i), you: false };
  });
  rows.push({ name: 'You', value: netWorth(), you: true });
  rows.sort(function (a, b) { return b.value - a.value; });
  return rows;
}

/* Runs after any position/cash change. */
function afterTrade() {
  snapshotNetWorth();
  var earned = checkBadges();
  earned.forEach(function (b) {
    pushBanner('badge', 'Badge unlocked — ' + b.name, b.emoji + '  Keep going.');
  });
  save();
}

/* ============================================================================
   12. CHART RENDERER
   Hand-rolled canvas. A library would work, but this way the crosshair, the
   growing live candle and the Robinhood-style gradient all behave exactly as
   intended, and there is no CDN to be offline.
   ========================================================================== */

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function withAlpha(hex, a) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  var r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}

function Chart(canvas, opts) {
  this.canvas = canvas;
  this.ctx = canvas.getContext('2d');
  this.opts = Object.assign({ volume: true, baseline: true, timeAxis: true, pad: 14 }, opts || {});
  this.bars = [];
  this.type = 'line';
  this.scrubIndex = -1;
  this.onScrub = null;
  this._raf = null;
  this._bind();
}

Chart.prototype._bind = function () {
  var self = this;
  var c = this.canvas;

  function idxFromX(clientX) {
    var rect = c.getBoundingClientRect();
    var x = clientX - rect.left;
    var pad = self.opts.pad;
    var w = rect.width - pad * 2;
    if (w <= 0 || !self.bars.length) return -1;
    var f = clamp((x - pad) / w, 0, 1);
    return clamp(Math.round(f * (self.bars.length - 1)), 0, self.bars.length - 1);
  }

  var active = false;

  function begin(e) {
    if (!self.bars.length) return;
    active = true;
    c.setPointerCapture && e.pointerId !== undefined && c.setPointerCapture(e.pointerId);
    self.setScrub(idxFromX(e.clientX));
  }
  function move(e) {
    if (!active) return;
    self.setScrub(idxFromX(e.clientX));
  }
  function end() {
    if (!active) return;
    active = false;
    self.setScrub(-1);
  }

  c.addEventListener('pointerdown', begin);
  c.addEventListener('pointermove', move);
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
  c.addEventListener('pointerleave', end);

  // Safari on iOS can still try to scroll mid-scrub; this keeps the drag ours
  // once it has started. Must be non-passive to be allowed to preventDefault.
  c.addEventListener('touchmove', function (e) {
    if (active) e.preventDefault();
  }, { passive: false });
};

Chart.prototype.setScrub = function (i) {
  if (i === this.scrubIndex) return;
  this.scrubIndex = i;
  if (this.onScrub) this.onScrub(i >= 0 ? this.bars[i] : null, i);
  this.draw();
};

Chart.prototype.setData = function (bars, type) {
  this.bars = bars || [];
  if (type) this.type = type;
  if (this.scrubIndex >= this.bars.length) this.scrubIndex = -1;
  this.draw();
};

Chart.prototype.draw = function () {
  var self = this;
  if (this._raf) return;
  this._raf = requestAnimationFrame(function () {
    self._raf = null;
    self._paint();
  });
};

Chart.prototype._paint = function () {
  var c = this.canvas, ctx = this.ctx;
  var rect = c.getBoundingClientRect();
  var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  var W = Math.max(1, Math.round(rect.width)), H = Math.max(1, Math.round(rect.height));

  if (c.width !== W * dpr || c.height !== H * dpr) {
    c.width = W * dpr; c.height = H * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  var bars = this.bars;
  if (!bars.length) return;

  var pad = this.opts.pad;
  var axisH = this.opts.timeAxis ? 16 : 0;
  var volH = this.opts.volume ? Math.round((H - axisH) * 0.16) : 0;
  var topPad = 10, gap = this.opts.volume ? 8 : 0;
  var priceTop = topPad;
  var priceH = H - axisH - volH - gap - topPad;
  var plotW = W - pad * 2;

  // ── Scale ────────────────────────────────────────────────────────────────
  var min = Infinity, max = -Infinity, maxVol = 0;
  for (var i = 0; i < bars.length; i++) {
    var b = bars[i];
    var lo = this.type === 'candle' ? b.l : Math.min(b.c, b.o);
    var hi = this.type === 'candle' ? b.h : Math.max(b.c, b.o);
    if (this.type === 'line') { lo = b.c; hi = b.c; }
    if (lo < min) min = lo;
    if (hi > max) max = hi;
    if (b.v > maxVol) maxVol = b.v;
  }
  var baseline = this.opts.baseline ? bars[0].o : null;
  if (baseline !== null) { min = Math.min(min, baseline); max = Math.max(max, baseline); }
  if (max - min < 1e-6) { max += 0.5; min -= 0.5; }
  var padY = (max - min) * 0.08;
  min -= padY; max += padY;

  function X(i) { return pad + (bars.length === 1 ? plotW / 2 : (i / (bars.length - 1)) * plotW); }
  function Y(p) { return priceTop + priceH - ((p - min) / (max - min)) * priceH; }

  // ── Direction colour, driven by the whole range, not the last tick ───────
  var first = bars[0].o, last = bars[bars.length - 1].c;
  var up = last >= first;
  var col = up ? cssVar('--pos') : cssVar('--neg');
  var faint = cssVar('--text-faint');
  var lineSoft = cssVar('--line-soft');

  // ── Volume ───────────────────────────────────────────────────────────────
  if (this.opts.volume && maxVol > 0) {
    var volTop = priceTop + priceH + gap;
    var bw = Math.max(1, (plotW / bars.length) * 0.62);
    for (i = 0; i < bars.length; i++) {
      var vb = bars[i];
      var h = Math.max(1, (vb.v / maxVol) * volH);
      var vUp = vb.c >= vb.o;
      ctx.fillStyle = withAlpha(vUp ? cssVar('--pos') : cssVar('--neg'), 0.28);
      ctx.fillRect(X(i) - bw / 2, volTop + volH - h, bw, h);
    }
  }

  // ── Baseline (period open) ───────────────────────────────────────────────
  if (baseline !== null) {
    ctx.save();
    ctx.strokeStyle = withAlpha(faint || '#64707e', 0.5);
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(pad, Y(baseline));
    ctx.lineTo(W - pad, Y(baseline));
    ctx.stroke();
    ctx.restore();
  }

  // ── Series ───────────────────────────────────────────────────────────────
  if (this.type === 'candle') {
    var cw = Math.max(1.5, (plotW / bars.length) * 0.66);
    for (i = 0; i < bars.length; i++) {
      var k = bars[i];
      var kUp = k.c >= k.o;
      var kc = kUp ? cssVar('--pos') : cssVar('--neg');
      var x = X(i);
      ctx.strokeStyle = kc;
      ctx.fillStyle = kc;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, Y(k.h));
      ctx.lineTo(x, Y(k.l));
      ctx.stroke();
      var yo = Y(k.o), yc = Y(k.c);
      var top = Math.min(yo, yc);
      var bh = Math.max(1.2, Math.abs(yc - yo));
      ctx.fillRect(x - cw / 2, top, cw, bh);
    }
  } else {
    // Gradient fill under the line
    var grad = ctx.createLinearGradient(0, priceTop, 0, priceTop + priceH);
    grad.addColorStop(0, withAlpha(col, 0.28));
    grad.addColorStop(1, withAlpha(col, 0));
    ctx.beginPath();
    ctx.moveTo(X(0), Y(bars[0].c));
    for (i = 1; i < bars.length; i++) ctx.lineTo(X(i), Y(bars[i].c));
    ctx.lineTo(X(bars.length - 1), priceTop + priceH);
    ctx.lineTo(X(0), priceTop + priceH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(X(0), Y(bars[0].c));
    for (i = 1; i < bars.length; i++) ctx.lineTo(X(i), Y(bars[i].c));
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    // Live dot on the last point
    var lx = X(bars.length - 1), ly = Y(bars[bars.length - 1].c);
    ctx.beginPath();
    ctx.arc(lx, ly, 3.4, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(lx, ly, 7.5, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(col, 0.18);
    ctx.fill();
  }

  // ── Time axis ────────────────────────────────────────────────────────────
  if (this.opts.timeAxis) {
    ctx.fillStyle = faint || '#64707e';
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    var span = bars[bars.length - 1].t - bars[0].t;
    var labels = 4;
    for (var n = 0; n <= labels; n++) {
      var idx = Math.round((n / labels) * (bars.length - 1));
      var t = bars[idx].t;
      var txt = span > DAY_MS * 3
        ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      ctx.textAlign = n === 0 ? 'left' : n === labels ? 'right' : 'center';
      ctx.fillText(txt, clamp(X(idx), pad, W - pad), H - 2);
    }
  }

  // ── Crosshair ────────────────────────────────────────────────────────────
  if (this.scrubIndex >= 0 && this.scrubIndex < bars.length) {
    var sb = bars[this.scrubIndex];
    var sx = X(this.scrubIndex), sy = Y(sb.c);
    ctx.save();
    ctx.strokeStyle = withAlpha(cssVar('--text') || '#eef2f6', 0.32);
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(sx, priceTop - 4); ctx.lineTo(sx, priceTop + priceH + volH + gap); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pad, sy); ctx.lineTo(W - pad, sy); ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(sx, sy, 5, 0, Math.PI * 2);
    ctx.fillStyle = cssVar('--bg') || '#0b0d10';
    ctx.fill();
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = col;
    ctx.stroke();
  }
};

/* ── Sparklines ───────────────────────────────────────────────────────────── */

function drawSpark(canvas, series, positive) {
  var ctx = canvas.getContext('2d');
  var rect = canvas.getBoundingClientRect();
  var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  var W = Math.max(1, Math.round(rect.width || 62)), H = Math.max(1, Math.round(rect.height || 30));
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!series || series.length < 2) return;

  var min = Infinity, max = -Infinity;
  for (var i = 0; i < series.length; i++) {
    if (series[i] < min) min = series[i];
    if (series[i] > max) max = series[i];
  }
  if (max - min < 1e-9) { max += 0.01; min -= 0.01; }
  var col = cssVar(positive ? '--pos' : '--neg');
  var p = 3;
  function X(i) { return (i / (series.length - 1)) * (W - 2) + 1; }
  function Y(v) { return H - p - ((v - min) / (max - min)) * (H - p * 2); }

  ctx.beginPath();
  ctx.moveTo(X(0), Y(series[0]));
  for (i = 1; i < series.length; i++) ctx.lineTo(X(i), Y(series[i]));
  ctx.strokeStyle = col;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}

/* A text equivalent of the chart, for screen readers. */
function chartSummary(bars, label) {
  if (!bars || !bars.length) return '';
  var first = bars[0].o, last = bars[bars.length - 1].c;
  var min = Infinity, max = -Infinity;
  bars.forEach(function (b) { if (b.l < min) min = b.l; if (b.h > max) max = b.h; });
  var ch = ((last - first) / first) * 100;
  return label + ': opened at ' + money(first) + ', now ' + money(last) + ', ' +
    (ch >= 0 ? 'up ' : 'down ') + Math.abs(ch).toFixed(2) + ' percent over the period. ' +
    'Range ' + money(min) + ' to ' + money(max) + ' across ' + bars.length + ' intervals.';
}

/* ============================================================================
   13. UI PRIMITIVES — banners, toasts, sheets, haptics
   ========================================================================== */

function haptic(pattern) {
  if (!state.settings.haptics) return;
  if (navigator.vibrate) { try { navigator.vibrate(pattern || 12); } catch (e) {} }
}

var ICONS = {
  bell:  '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  news:  '<path d="M4 4h13v16H4z"/><path d="M17 8h3v10a2 2 0 0 1-2 2"/><path d="M7 8h7M7 12h7M7 16h4"/>',
  star:  '<path d="m12 3 2.6 5.6 6 .8-4.4 4.2 1.1 6.1L12 16.8 6.7 19.7l1.1-6.1L3.4 9.4l6-.8z"/>',
  x:     '<path d="M18 6 6 18M6 6l12 12"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  edit:  '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  plus:  '<path d="M12 5v14M5 12h14"/>',
  empty: '<circle cx="12" cy="12" r="9"/><path d="M9 12h6"/>'
};
function svg(name, cls) {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"' + (cls ? ' class="' + cls + '"' : '') + '>' + ICONS[name] + '</svg>';
}

function pushBanner(kind, title, text, onClick) {
  var stack = $('#bannerStack');
  var icon = kind === 'alert' ? 'bell' : kind === 'fill' ? 'check' : kind === 'badge' ? 'star' : 'news';
  var node = el('div', { class: 'banner', 'data-kind': kind });
  node.innerHTML =
    '<span class="banner-icon">' + svg(icon) + '</span>' +
    '<div class="banner-body"><div class="banner-title"></div><div class="banner-text"></div></div>' +
    '<button class="banner-x" aria-label="Dismiss">' + svg('x') + '</button>';
  $('.banner-title', node).textContent = title;
  $('.banner-text', node).textContent = text || '';
  $('.banner-x', node).addEventListener('click', function (e) { e.stopPropagation(); node.remove(); });
  if (onClick) {
    node.style.cursor = 'pointer';
    node.addEventListener('click', function () { node.remove(); onClick(); });
  }
  stack.appendChild(node);
  while (stack.children.length > 3) stack.removeChild(stack.firstChild);
  setTimeout(function () { if (node.parentNode) node.remove(); }, 12000);
  announce(title + '. ' + (text || ''));
}

function toast(msg, tone) {
  var host = $('#toastHost');
  var t = el('div', { class: 'toast' + (tone ? ' ' + tone : ''), text: msg });
  host.appendChild(t);
  setTimeout(function () {
    t.style.transition = 'opacity .3s';
    t.style.opacity = '0';
    setTimeout(function () { t.remove(); }, 320);
  }, 2600);
  announce(msg);
}

function announce(msg) {
  var live = $('#srLive');
  if (live) { live.textContent = ''; setTimeout(function () { live.textContent = msg; }, 40); }
}

/* ── Bottom sheet ─────────────────────────────────────────────────────────── */

var sheetState = { open: false, onClose: null };

function openSheet(buildFn, onClose) {
  var host = $('#sheetHost'), body = $('#sheetBody'), sheet = $('#sheet');
  clearSheetTicks();
  body.innerHTML = '';
  buildFn(body);
  host.hidden = false;
  sheet.style.transform = '';
  // Force a reflow so the open transition actually runs.
  void host.offsetHeight;
  host.classList.add('open');
  sheetState.open = true;
  sheetState.onClose = onClose || null;
  document.body.style.overflow = 'hidden';
}

function closeSheet() {
  if (!sheetState.open) return;
  var host = $('#sheetHost'), sheet = $('#sheet');
  host.classList.remove('open');
  sheet.style.transform = '';
  sheetState.open = false;
  document.body.style.overflow = '';
  var cb = sheetState.onClose;
  sheetState.onClose = null;
  setTimeout(function () {
    if (!sheetState.open) { host.hidden = true; $('#sheetBody').innerHTML = ''; }
  }, 320);
  if (cb) cb();
}

function initSheetGestures() {
  var grab = $('#sheetGrab'), sheet = $('#sheet');
  var startY = 0, dy = 0, dragging = false;

  function down(e) {
    dragging = true; startY = e.clientY; dy = 0;
    sheet.classList.add('dragging');
    grab.setPointerCapture && e.pointerId !== undefined && grab.setPointerCapture(e.pointerId);
  }
  function move(e) {
    if (!dragging) return;
    dy = Math.max(0, e.clientY - startY);
    sheet.style.transform = 'translateY(' + dy + 'px)';
  }
  function up() {
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove('dragging');
    if (dy > 90) { closeSheet(); }
    else { sheet.style.transform = ''; }
  }
  grab.addEventListener('pointerdown', down);
  grab.addEventListener('pointermove', move);
  grab.addEventListener('pointerup', up);
  grab.addEventListener('pointercancel', up);
  $('#sheetScrim').addEventListener('click', closeSheet);
}

/* ── Confirm dialog, as a sheet ───────────────────────────────────────────── */

function confirmSheet(opts, onYes) {
  openSheet(function (body) {
    body.appendChild(el('div', { class: 'sheet-title', text: opts.title }));
    body.appendChild(el('div', { class: 'sheet-sub', text: opts.text }));
    var yes = el('button', { class: 'btn btn-lg ' + (opts.danger ? 'btn-danger' : 'btn-primary'), text: opts.confirm || 'Confirm' });
    var no = el('button', { class: 'btn btn-lg btn-quiet', text: 'Cancel', style: 'margin-top:8px' });
    yes.addEventListener('click', function () { closeSheet(); onYes(); });
    no.addEventListener('click', closeSheet);
    body.appendChild(yes);
    body.appendChild(no);
  });
}

/* ── Swipe-to-confirm control ─────────────────────────────────────────────── */

function swipeConfirm(label, color, onDone) {
  var wrap = el('div', { class: 'swipe' });
  wrap.style.setProperty('--sw-color', color);
  wrap.innerHTML =
    '<div class="swipe-fill"></div>' +
    '<div class="swipe-label"></div>' +
    '<div class="swipe-knob">' + svg('check') + '</div>';
  $('.swipe-label', wrap).textContent = label;

  var knob = $('.swipe-knob', wrap), fill = $('.swipe-fill', wrap);
  var dragging = false, startX = 0, x = 0, maxX = 0, fired = false;

  function limit() { return wrap.clientWidth - knob.offsetWidth - 8; }

  function down(e) {
    if (fired) return;
    dragging = true; startX = e.clientX - x; maxX = limit();
    wrap.classList.add('armed');
    wrap.setPointerCapture && e.pointerId !== undefined && wrap.setPointerCapture(e.pointerId);
  }
  function move(e) {
    if (!dragging) return;
    x = clamp(e.clientX - startX, 0, maxX);
    knob.style.transform = 'translateX(' + x + 'px)';
    fill.style.width = (x + knob.offsetWidth) + 'px';
  }
  function up() {
    if (!dragging) return;
    dragging = false;
    wrap.classList.remove('armed');
    if (x >= maxX - 6) {
      fired = true;
      wrap.classList.add('done');
      $('.swipe-label', wrap).textContent = 'Confirmed';
      haptic([14, 40, 22]);
      onDone();
    } else {
      x = 0;
      knob.style.transform = '';
      fill.style.width = '0';
    }
  }
  wrap.addEventListener('pointerdown', down);
  wrap.addEventListener('pointermove', move);
  wrap.addEventListener('pointerup', up);
  wrap.addEventListener('pointercancel', up);

  // Keyboard / assistive fallback — a swipe must never be the only way through.
  wrap.setAttribute('role', 'button');
  wrap.setAttribute('tabindex', '0');
  wrap.setAttribute('aria-label', label + ' (press Enter to confirm)');
  wrap.addEventListener('keydown', function (e) {
    if (fired) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fired = true;
      wrap.classList.add('done');
      knob.style.transform = 'translateX(' + limit() + 'px)';
      fill.style.width = '100%';
      $('.swipe-label', wrap).textContent = 'Confirmed';
      onDone();
    }
  });
  return wrap;
}

/* ============================================================================
   14. TICK SUBSCRIPTIONS
   Views and sheets register a repaint callback; the loop calls whatever is
   currently mounted and nothing else.
   ========================================================================== */

var viewTicks = [];      // cleared on navigation
var sheetTicks = [];     // cleared when a sheet closes

function onViewTick(fn) { viewTicks.push(fn); return fn; }
function onSheetTick(fn) { sheetTicks.push(fn); return fn; }
function clearViewTicks() { viewTicks.length = 0; }
function clearSheetTicks() { sheetTicks.length = 0; }

/* ============================================================================
   15. SHARED ROW COMPONENTS
   ========================================================================== */

function logoTile(sym, large) {
  var st = STOCKS[sym];
  var tile = el('div', { class: 'logo-tile' + (large ? ' lg' : ''), text: initials(sym) });
  tile.style.background = st.color;
  return tile;
}

/* A watchlist / search result row: logo, name, sparkline, price, day change. */
function tickerRow(sym, opts) {
  opts = opts || {};
  var st = STOCKS[sym];
  var row = el('a', { class: 'row', href: '#/stock/' + sym });

  row.appendChild(logoTile(sym));

  var main = el('div', { class: 'row-main' });
  var title = el('div', { class: 'row-title' }, [document.createTextNode(sym)]);
  if (state.notes.some(function (n) { return n.ticker === sym && n.triggeredAt; })) {
    title.appendChild(el('span', { class: 'tagchip live', text: 'Alert' }));
  }
  main.appendChild(title);
  main.appendChild(el('div', { class: 'row-sub', text: opts.sub || st.name }));
  row.appendChild(main);

  var spark = el('canvas', { class: 'row-spark', 'aria-hidden': 'true' });
  row.appendChild(spark);

  var right = el('div', { class: 'row-right' });
  var pEl = el('div', { class: 'row-val' });
  var dEl = el('div', { class: 'row-delta' });
  right.appendChild(pEl);
  right.appendChild(dEl);
  row.appendChild(right);

  var lastPrice = null;
  function paint() {
    var ch = todayChange(sym);
    pEl.textContent = money(ch.price);
    dEl.textContent = signedPct(ch.pct);
    dEl.className = 'row-delta ' + toneOf(ch.pct);
    if (lastPrice !== null && Math.abs(ch.price - lastPrice) > 1e-9) {
      pEl.classList.remove('flash-pos', 'flash-neg');
      void pEl.offsetWidth;
      pEl.classList.add(ch.price > lastPrice ? 'flash-pos' : 'flash-neg');
    }
    lastPrice = ch.price;
    drawSpark(spark, sparkSeries(sym), ch.pct >= 0);
    row.setAttribute('aria-label', sym + ' ' + st.name + ', ' + money(ch.price) + ', ' + signedPct(ch.pct) + ' today');
  }
  paint();
  onViewTick(paint);
  return row;
}

/* A portfolio holding row: shares + avg cost on the left, value + P/L right. */
function holdingRow(sym) {
  var st = STOCKS[sym];
  var row = el('a', { class: 'row', href: '#/stock/' + sym });
  row.appendChild(logoTile(sym));

  var main = el('div', { class: 'row-main' });
  main.appendChild(el('div', { class: 'row-title', text: sym }));
  var sub = el('div', { class: 'row-sub' });
  main.appendChild(sub);
  row.appendChild(main);

  var spark = el('canvas', { class: 'row-spark', 'aria-hidden': 'true' });
  row.appendChild(spark);

  var right = el('div', { class: 'row-right' });
  var vEl = el('div', { class: 'row-val' });
  var pEl = el('div', { class: 'row-delta' });
  right.appendChild(vEl);
  right.appendChild(pEl);
  row.appendChild(right);

  function paint() {
    var pos = positionOf(sym);
    var price = livePrice(sym);
    var pl = unrealizedPL(sym);
    var day = todayChange(sym);
    var dayAbs = pos.shares * day.abs;      // what this position did today

    sub.innerHTML = '';
    sub.appendChild(document.createTextNode(
      shares(pos.shares) + ' sh · avg ' + money(pos.avgCost) + ' · ' + money(price) + ' · today '));
    sub.appendChild(el('span', { class: toneOf(dayAbs), text: signedMoney(dayAbs) + ' ' + signedPct(day.pct) }));

    vEl.textContent = money(pos.shares * price);
    pEl.textContent = signedMoney(pl.abs) + '  ' + signedPct(pl.pct);
    pEl.className = 'row-delta ' + toneOf(pl.abs);
    drawSpark(spark, sparkSeries(sym), day.pct >= 0);
    row.setAttribute('aria-label',
      sym + ', ' + shares(pos.shares) + ' shares worth ' + money(pos.shares * price) +
      ', today ' + signedMoney(dayAbs) + ', unrealized ' + signedMoney(pl.abs));
  }
  paint();
  onViewTick(paint);
  return row;
}

function emptyState(title, text, actionLabel, onAction) {
  var box = el('div', { class: 'empty' });
  box.appendChild(el('div', { class: 'empty-icon', html: svg('empty') }));
  box.appendChild(el('div', { class: 'empty-title', text: title }));
  box.appendChild(el('div', { class: 'empty-text', text: text }));
  if (actionLabel) {
    var b = el('button', { class: 'btn btn-ghost', text: actionLabel });
    b.addEventListener('click', onAction);
    box.appendChild(b);
  }
  return box;
}

function sectionHead(title, linkText, linkHref) {
  var h = el('div', { class: 'section-head' });
  h.appendChild(el('div', { class: 'section-title', text: title }));
  if (linkText) h.appendChild(el('a', { class: 'section-link', href: linkHref || '#', text: linkText }));
  return h;
}

function kv(k, v, cls) {
  var row = el('div', { class: 'kv' });
  row.appendChild(el('div', { class: 'kv-k', text: k }));
  row.appendChild(el('div', { class: 'kv-v' + (cls ? ' ' + cls : ''), text: v }));
  return row;
}

/* Horizontal allocation bar + legend, shared by position and sector views. */
function allocBlock(items) {
  var wrap = el('div');
  var bar = el('div', { class: 'alloc-bar' });
  items.forEach(function (it) {
    var seg = el('span');
    seg.style.width = Math.max(0, it.pct) + '%';
    seg.style.background = it.color;
    bar.appendChild(seg);
  });
  wrap.appendChild(bar);
  var legend = el('div', { class: 'alloc-legend' });
  items.forEach(function (it) {
    var row = el('div', { class: 'alloc-item' });
    var dot = el('span', { class: 'alloc-dot' });
    dot.style.background = it.color;
    row.appendChild(dot);
    row.appendChild(el('span', { class: 'alloc-name', text: it.label }));
    row.appendChild(el('span', { class: 'alloc-pct', text: pct(it.pct, 1) }));
    legend.appendChild(row);
  });
  wrap.appendChild(legend);
  return wrap;
}

/* ============================================================================
   16. ORDER TICKET
   ========================================================================== */

function openOrderTicket(sym, side) {
  var st = STOCKS[sym];
  var form = {
    side: side || 'buy',
    type: 'market',
    mode: 'shares',            // 'shares' | 'dollars'
    qty: '',
    amount: '',
    limitPrice: '',
    stopPrice: ''
  };

  openSheet(function (body) {
    // ── Header ────────────────────────────────────────────────────────────
    var head = el('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:14px' });
    head.appendChild(logoTile(sym, true));
    var hcol = el('div', { style: 'flex:1;min-width:0' });
    hcol.appendChild(el('div', { class: 'sheet-title', text: sym }));
    hcol.appendChild(el('div', { style: 'font-size:12.5px;color:var(--text-faint)', text: st.name }));
    head.appendChild(hcol);
    var livePriceEl = el('div', { style: 'font-size:19px;font-weight:800;font-variant-numeric:tabular-nums' });
    head.appendChild(livePriceEl);
    body.appendChild(head);

    // ── Buy / Sell ────────────────────────────────────────────────────────
    var sideSeg = el('div', { class: 'seg', style: 'margin-bottom:12px' });
    ['buy', 'sell'].forEach(function (s) {
      var b = el('button', { type: 'button', text: s === 'buy' ? 'Buy' : 'Sell' });
      b.setAttribute('aria-pressed', String(form.side === s));
      b.addEventListener('click', function () {
        form.side = s;
        $$('button', sideSeg).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        if (s === 'sell' && form.type === 'stop') { /* stop-loss is the natural sell stop */ }
        render();
      });
      sideSeg.appendChild(b);
    });
    body.appendChild(sideSeg);

    // ── Order type ────────────────────────────────────────────────────────
    var typeChips = el('div', { class: 'chips', style: 'margin-bottom:14px' });
    [['market', 'Market'], ['limit', 'Limit'], ['stop', 'Stop']].forEach(function (t) {
      var c = el('button', { class: 'chip', type: 'button', text: t[1] });
      c.setAttribute('aria-pressed', String(form.type === t[0]));
      c.addEventListener('click', function () {
        form.type = t[0];
        $$('.chip', typeChips).forEach(function (x) { x.setAttribute('aria-pressed', String(x === c)); });
        render();
      });
      typeChips.appendChild(c);
    });
    body.appendChild(typeChips);

    var dyn = el('div');
    body.appendChild(dyn);

    /* ── The body below the type chips is rebuilt on every change ────────── */
    function render() {
      // Drop the previous pass's live-repaint handler, or every keystroke
      // would leave another one running against a detached summary card.
      clearSheetTicks();
      dyn.innerHTML = '';

      var q = quoteFor(sym);
      var isBuy = form.side === 'buy';
      var accent = isBuy ? cssVar('--pos') : cssVar('--neg');

      // Shares vs dollars
      if (form.type === 'market') {
        var modeSeg = el('div', { class: 'seg', style: 'margin-bottom:14px' });
        [['shares', 'Shares'], ['dollars', 'Dollars']].forEach(function (m) {
          var b = el('button', { type: 'button', text: m[1] });
          b.setAttribute('aria-pressed', String(form.mode === m[0]));
          b.addEventListener('click', function () { form.mode = m[0]; render(); });
          modeSeg.appendChild(b);
        });
        dyn.appendChild(modeSeg);
      } else {
        form.mode = 'shares';
      }

      // Quantity / amount
      var field = el('div', { class: 'field' });
      if (form.mode === 'dollars') {
        field.appendChild(el('div', { class: 'field-label', text: 'Amount' }));
        var amtIn = el('input', {
          class: 'input', type: 'text', inputmode: 'decimal', placeholder: '$0.00',
          value: form.amount, 'aria-label': 'Dollar amount'
        });
        amtIn.addEventListener('input', function () {
          form.amount = amtIn.value.replace(/[^0-9.]/g, '');
          updateSummary();
        });
        field.appendChild(amtIn);
        var quick = el('div', { class: 'quick-amts' });
        [100, 500, 1000, 'Max'].forEach(function (v) {
          var b = el('button', { type: 'button', text: v === 'Max' ? 'Max' : '$' + v });
          b.addEventListener('click', function () {
            var maxAmt = isBuy ? buyingPower() : sellableShares(sym) * q.bid;
            form.amount = String(v === 'Max' ? Math.floor(maxAmt * 100) / 100 : Math.min(v, maxAmt));
            amtIn.value = form.amount;
            updateSummary();
          });
          quick.appendChild(b);
        });
        field.appendChild(quick);
      } else {
        field.appendChild(el('div', { class: 'field-label', text: 'Shares' }));
        var stepper = el('div', { class: 'stepper' });
        var minus = el('button', { type: 'button', text: '−', 'aria-label': 'Decrease shares' });
        var qtyIn = el('input', {
          class: 'input', type: 'text', inputmode: 'decimal', placeholder: '0',
          value: form.qty, 'aria-label': 'Share quantity'
        });
        var plus = el('button', { type: 'button', text: '+', 'aria-label': 'Increase shares' });
        function bump(d) {
          var cur = parseFloat(form.qty) || 0;
          var next = Math.max(0, Math.round((cur + d) * 100000) / 100000);
          form.qty = next ? String(next) : '';
          qtyIn.value = form.qty;
          haptic(8);
          updateSummary();
        }
        minus.addEventListener('click', function () { bump(-1); });
        plus.addEventListener('click', function () { bump(1); });
        qtyIn.addEventListener('input', function () {
          form.qty = qtyIn.value.replace(/[^0-9.]/g, '');
          updateSummary();
        });
        stepper.appendChild(minus); stepper.appendChild(qtyIn); stepper.appendChild(plus);
        field.appendChild(stepper);

        var quick2 = el('div', { class: 'quick-amts' });
        (isBuy ? [1, 5, 10, 'Max'] : [1, 5, 10, 'All']).forEach(function (v) {
          var b = el('button', { type: 'button', text: typeof v === 'number' ? '+' + v : v });
          b.addEventListener('click', function () {
            if (typeof v === 'number') { bump(v); return; }
            var ref = form.type === 'market' ? q.ask : (parseFloat(form.limitPrice) || parseFloat(form.stopPrice) || q.mid);
            var max = isBuy ? buyingPower() / ref : sellableShares(sym);
            form.qty = String(Math.floor(max * 100000) / 100000);
            qtyIn.value = form.qty;
            updateSummary();
          });
          quick2.appendChild(b);
        });
        field.appendChild(quick2);
      }
      dyn.appendChild(field);

      // Limit / stop price
      if (form.type === 'limit' || form.type === 'stop') {
        var isLimit = form.type === 'limit';
        var pf = el('div', { class: 'field' });
        pf.appendChild(el('div', {
          class: 'field-label',
          text: isLimit ? 'Limit price' : (isBuy ? 'Stop price (triggers above)' : 'Stop price (triggers below)')
        }));
        var pIn = el('input', {
          class: 'input', type: 'text', inputmode: 'decimal',
          placeholder: money(q.mid),
          value: isLimit ? form.limitPrice : form.stopPrice,
          'aria-label': isLimit ? 'Limit price' : 'Stop price'
        });
        pIn.addEventListener('input', function () {
          var v = pIn.value.replace(/[^0-9.]/g, '');
          if (isLimit) form.limitPrice = v; else form.stopPrice = v;
          updateSummary();
        });
        pf.appendChild(pIn);
        pf.appendChild(el('div', {
          class: 'hint',
          text: isLimit
            ? (isBuy ? 'Fills automatically if the price drops to or below this.'
                     : 'Fills automatically if the price rises to or above this.')
            : (isBuy ? 'Buys once the price climbs through this level.'
                     : 'Sells to cap your loss if the price falls through this level.')
        }));
        dyn.appendChild(pf);
      }

      // Summary
      var summary = el('div', { class: 'card', style: 'padding:6px 14px;margin-bottom:14px' });
      dyn.appendChild(summary);

      var errBox = el('div');
      dyn.appendChild(errBox);

      // Confirm
      var label = (isBuy ? 'Swipe to buy ' : 'Swipe to sell ') + sym;
      var confirmWrap = el('div');
      dyn.appendChild(confirmWrap);
      dyn.appendChild(el('div', {
        class: 'hint',
        style: 'margin-top:12px;text-align:center',
        text: 'Paper money only — nothing here is a real order.'
      }));

      function currentSpec() {
        var spec = { ticker: sym, side: form.side, type: form.type };
        if (form.mode === 'dollars') spec.notional = parseFloat(form.amount);
        else spec.qty = parseFloat(form.qty);
        if (form.type === 'limit') spec.limitPrice = parseFloat(form.limitPrice);
        if (form.type === 'stop') spec.stopPrice = parseFloat(form.stopPrice);
        return spec;
      }

      function estimate() {
        var spec = currentSpec();
        var ref = form.type === 'market'
          ? (isBuy ? quoteFor(sym).ask : quoteFor(sym).bid)
          : (parseFloat(form.limitPrice) || parseFloat(form.stopPrice) || q.mid);
        var qty = spec.notional ? (ref > 0 ? spec.notional / ref : 0) : (spec.qty || 0);
        return { ref: ref, qty: qty, total: qty * ref };
      }

      function updateSummary() {
        var est = estimate();
        var pos = positionOf(sym);
        summary.innerHTML = '';
        summary.appendChild(kv(form.type === 'market' ? 'Market price' : 'Last price', money(q.mid)));
        if (state.settings.realism && form.type === 'market') {
          summary.appendChild(kv('Bid / Ask', money(q.bid) + ' / ' + money(q.ask)));
        }
        summary.appendChild(kv('Estimated shares', est.qty > 0 ? shares(est.qty) : '—'));
        summary.appendChild(kv(isBuy ? 'Estimated cost' : 'Estimated credit', est.total > 0 ? money(est.total) : '—'));
        if (isBuy) {
          summary.appendChild(kv('Buying power', money(buyingPower())));
          summary.appendChild(kv('Remaining after', money(buyingPower() - est.total),
            buyingPower() - est.total < 0 ? 'neg' : ''));
        } else {
          summary.appendChild(kv('Shares available', shares(sellableShares(sym))));
          if (pos.shares > 0) {
            var plIfSold = (est.ref - pos.avgCost) * Math.min(est.qty, pos.shares);
            summary.appendChild(kv('Realized P/L if filled', signedMoney(plIfSold), toneOf(plIfSold)));
          }
        }

        // Live validation, so the error appears as you type, not on submit.
        errBox.innerHTML = '';
        var hasInput = form.mode === 'dollars' ? !!parseFloat(form.amount) : !!parseFloat(form.qty);
        var err = hasInput ? validateOrder(Object.assign({ id: 'preview' }, currentSpec())) : null;
        if (err) errBox.appendChild(el('div', { class: 'err', text: err }));

        confirmWrap.innerHTML = '';
        if (hasInput && !err) {
          confirmWrap.appendChild(swipeConfirm(label, accent, submit));
        } else {
          var disabled = el('button', {
            class: 'btn btn-lg', disabled: true,
            text: hasInput ? 'Fix the error above' : (isBuy ? 'Enter an amount' : 'Enter a quantity')
          });
          confirmWrap.appendChild(disabled);
        }
      }

      function submit() {
        var res = placeOrder(currentSpec());
        if (!res.ok) {
          haptic([30, 40, 30]);
          toast(res.error, 'bad');
          render();
          return;
        }
        haptic([12, 30, 18]);
        closeSheet();
        if (res.resting) {
          toast(form.type === 'limit' ? 'Limit order placed' : 'Stop order placed', 'good');
        } else {
          var r = res.record;
          toast((r.side === 'buy' ? 'Bought ' : 'Sold ') + shares(r.qty) + ' ' + sym + ' @ ' + money(r.price), 'good');
        }
        rerender();
      }

      updateSummary();
      // Keep the ticket honest while prices move underneath it.
      onSheetTick(function () {
        livePriceEl.textContent = money(livePrice(sym));
        updateSummary();
      });
    }

    livePriceEl.textContent = money(livePrice(sym));
    render();
  }, function () {
    clearSheetTicks();
  });
}

/* ============================================================================
   17. NOTE & ALERT EDITOR
   ========================================================================== */

function openNoteEditor(sym, existing) {
  var note = existing || { ticker: sym, text: '', tag: 'research', targetPrice: null, direction: 'below' };
  var draft = {
    text: note.text || '',
    tag: note.tag || 'research',
    alertOn: !!note.targetPrice,
    target: note.targetPrice ? String(note.targetPrice) : '',
    direction: note.direction || 'below'
  };

  openSheet(function (body) {
    body.appendChild(el('div', { class: 'sheet-title', text: (existing ? 'Edit note' : 'New note') + ' · ' + note.ticker }));
    body.appendChild(el('div', { class: 'sheet-sub', text: STOCKS[note.ticker].name + ' · ' + money(livePrice(note.ticker)) }));

    // Tag
    var tagField = el('div', { class: 'field' });
    tagField.appendChild(el('div', { class: 'field-label', text: 'Tag' }));
    var tagChips = el('div', { class: 'chips' });
    NOTE_TAGS.forEach(function (t) {
      var c = el('button', { class: 'chip', type: 'button', text: t.label });
      c.setAttribute('aria-pressed', String(draft.tag === t.id));
      c.addEventListener('click', function () {
        draft.tag = t.id;
        $$('.chip', tagChips).forEach(function (x) { x.setAttribute('aria-pressed', String(x === c)); });
      });
      tagChips.appendChild(c);
    });
    tagField.appendChild(tagChips);
    body.appendChild(tagField);

    // Text
    var txtField = el('div', { class: 'field' });
    txtField.appendChild(el('div', { class: 'field-label', text: 'Note' }));
    var ta = el('textarea', {
      class: 'input', placeholder: 'e.g. Add more under $95 — waiting on the next earnings print.',
      'aria-label': 'Note text'
    });
    ta.value = draft.text;
    ta.addEventListener('input', function () { draft.text = ta.value; });
    txtField.appendChild(ta);
    body.appendChild(txtField);

    // Alert
    var alertRow = el('div', { class: 'switch-row' });
    var alertLabel = el('div');
    alertLabel.appendChild(el('div', { class: 'switch-label', text: 'Price alert' }));
    alertLabel.appendChild(el('div', { class: 'switch-desc', text: 'Notify me when this note becomes relevant' }));
    alertRow.appendChild(alertLabel);
    var sw = el('button', { class: 'switch', type: 'button', 'aria-label': 'Toggle price alert' });
    sw.setAttribute('aria-pressed', String(draft.alertOn));
    alertRow.appendChild(sw);
    body.appendChild(alertRow);

    var alertBox = el('div', { style: 'margin-top:14px' });
    body.appendChild(alertBox);

    function renderAlertBox() {
      alertBox.innerHTML = '';
      if (!draft.alertOn) return;
      var dirSeg = el('div', { class: 'seg', style: 'margin-bottom:12px' });
      [['below', 'Falls to or below'], ['above', 'Rises to or above']].forEach(function (d) {
        var b = el('button', { type: 'button', text: d[1] });
        b.setAttribute('aria-pressed', String(draft.direction === d[0]));
        b.addEventListener('click', function () {
          draft.direction = d[0];
          $$('button', dirSeg).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        });
        dirSeg.appendChild(b);
      });
      alertBox.appendChild(dirSeg);

      var pf = el('div', { class: 'field' });
      pf.appendChild(el('div', { class: 'field-label', text: 'Target price' }));
      var pin = el('input', {
        class: 'input', type: 'text', inputmode: 'decimal',
        placeholder: money(livePrice(note.ticker)), value: draft.target, 'aria-label': 'Target price'
      });
      pin.addEventListener('input', function () {
        draft.target = pin.value.replace(/[^0-9.]/g, '');
      });
      pf.appendChild(pin);
      alertBox.appendChild(pf);
    }
    sw.addEventListener('click', function () {
      draft.alertOn = !draft.alertOn;
      sw.setAttribute('aria-pressed', String(draft.alertOn));
      renderAlertBox();
    });
    renderAlertBox();

    var errBox = el('div');
    body.appendChild(errBox);

    var saveBtn = el('button', { class: 'btn btn-primary btn-lg', text: existing ? 'Save changes' : 'Save note' });
    saveBtn.addEventListener('click', function () {
      errBox.innerHTML = '';
      if (!draft.text.trim()) {
        errBox.appendChild(el('div', { class: 'err', text: 'Write something first.' }));
        return;
      }
      var target = draft.alertOn ? parseFloat(draft.target) : null;
      if (draft.alertOn && (!isFinite(target) || target <= 0)) {
        errBox.appendChild(el('div', { class: 'err', text: 'Enter a target price above $0.' }));
        return;
      }
      saveNote({
        id: existing ? existing.id : null,
        ticker: note.ticker,
        text: draft.text.trim(),
        tag: draft.tag,
        targetPrice: target,
        direction: draft.direction
      });
      haptic(12);
      closeSheet();
      toast(existing ? 'Note updated' : 'Note saved', 'good');
      rerender();
    });
    body.appendChild(saveBtn);

    if (existing) {
      var del = el('button', { class: 'btn btn-lg btn-quiet', style: 'margin-top:8px', text: 'Delete note' });
      del.addEventListener('click', function () {
        deleteNote(existing.id);
        closeSheet();
        toast('Note deleted');
        rerender();
      });
      body.appendChild(del);
    }
  });
}

/* ============================================================================
   18. NET WORTH SERIES
   Snapshots are taken once a minute; this shapes them into chart bars.
   ========================================================================== */

function netWorthBars() {
  var snaps = state.snapshots.slice();
  if (!snaps.length || snaps[0].t > state.createdAt + 1000) {
    snaps.unshift({ t: state.createdAt, v: START_CASH });
  }
  snaps.push({ t: Date.now(), v: netWorth() });

  // Keep the line readable regardless of how long the run has been going.
  var MAXP = 180;
  if (snaps.length > MAXP) {
    var step = snaps.length / MAXP;
    var thin = [];
    for (var i = 0; i < MAXP; i++) thin.push(snaps[Math.floor(i * step)]);
    thin.push(snaps[snaps.length - 1]);
    snaps = thin;
  }

  var bars = [];
  for (var j = 0; j < snaps.length; j++) {
    var prev = j === 0 ? snaps[0].v : snaps[j - 1].v;
    bars.push({
      t: snaps[j].t, o: prev, c: snaps[j].v,
      h: Math.max(prev, snaps[j].v), l: Math.min(prev, snaps[j].v), v: 0
    });
  }
  return bars;
}

/* A chart block with a heading readout that follows the crosshair. */
function chartBlock(opts) {
  var wrap = el('div');
  var readout = el('div', { class: 'chart-readout' });
  var left = el('span'), right = el('span');
  readout.appendChild(left); readout.appendChild(right);

  var holder = el('div', { class: 'chart-wrap' });
  var canvas = el('canvas', { class: 'chart-canvas' + (opts.short ? ' short' : ''), role: 'img' });
  holder.appendChild(readout);
  holder.appendChild(canvas);
  wrap.appendChild(holder);

  var chart = new Chart(canvas, { volume: !!opts.volume, baseline: opts.baseline !== false, timeAxis: opts.timeAxis !== false });
  chart.type = opts.type || 'line';
  chart.onScrub = function (bar) {
    if (!bar) { readout.classList.remove('on'); if (opts.onScrub) opts.onScrub(null); return; }
    readout.classList.add('on');
    var d = new Date(bar.t);
    left.textContent = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + '  ' +
                       d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    right.textContent = opts.candleReadout && chart.type === 'candle'
      ? 'O ' + money(bar.o) + '  H ' + money(bar.h) + '  L ' + money(bar.l) + '  C ' + money(bar.c)
      : money(bar.c);
    if (opts.onScrub) opts.onScrub(bar);
  };
  return { wrap: wrap, chart: chart, canvas: canvas };
}

/* ============================================================================
   19. VIEW — HOME
   ========================================================================== */

function viewHome() {
  var frag = document.createDocumentFragment();
  setTitle('Paper Trader', false);

  // ── Hero ──────────────────────────────────────────────────────────────────
  var hero = el('div', { class: 'hero' });
  hero.appendChild(el('div', { class: 'hero-label', text: 'Net worth' }));
  var nwEl = el('div', { class: 'big-price' });
  hero.appendChild(nwEl);
  var deltaEl = el('div', { class: 'delta' });
  hero.appendChild(deltaEl);
  frag.appendChild(hero);

  // ── Net worth chart ───────────────────────────────────────────────────────
  var cb = chartBlock({ volume: false, baseline: true });
  frag.appendChild(cb.wrap);

  var scrubbed = null;
  var baseOnScrub = cb.chart.onScrub;
  cb.chart.onScrub = function (bar) {
    baseOnScrub(bar);
    scrubbed = bar;
    paintHero();
  };

  function paintHero() {
    var nw = netWorth();
    var shown = scrubbed ? scrubbed.c : nw;
    nwEl.textContent = money(shown);

    var tpl = todayPL();
    var tot = totalReturn();
    deltaEl.innerHTML = '';
    if (scrubbed) {
      var base = START_CASH;
      var ch = shown - base;
      deltaEl.appendChild(el('span', { class: toneOf(ch), text: signedMoney(ch) + ' (' + signedPct((ch / base) * 100) + ')' }));
      deltaEl.appendChild(el('span', { class: 'sub', text: 'since start' }));
    } else {
      deltaEl.appendChild(el('span', { class: toneOf(tpl), text: signedMoney(tpl) + ' today' }));
      deltaEl.appendChild(el('span', { class: 'sub', text: '·' }));
      deltaEl.appendChild(el('span', { class: toneOf(tot.abs), text: signedMoney(tot.abs) + ' (' + signedPct(tot.pct) + ') all time' }));
    }
    nwEl.setAttribute('aria-label', 'Net worth ' + money(nw));
  }

  function paintChart() {
    var bars = netWorthBars();
    cb.chart.setData(bars, 'line');
    cb.canvas.setAttribute('aria-label', chartSummary(bars, 'Net worth'));
  }
  paintHero(); paintChart();
  onViewTick(function () { paintHero(); paintChart(); });

  // ── Buying power ──────────────────────────────────────────────────────────
  var bpCard = el('div', { class: 'card', style: 'padding:6px 16px' });
  frag.appendChild(bpCard);
  function paintBP() {
    bpCard.innerHTML = '';
    bpCard.appendChild(kv('Cash', money(state.cash)));
    bpCard.appendChild(kv('Buying power', money(buyingPower())));
    bpCard.appendChild(kv('Holdings value', money(holdingsValue())));
  }
  paintBP(); onViewTick(paintBP);

  // ── Open orders ───────────────────────────────────────────────────────────
  var ordersWrap = el('div');
  frag.appendChild(ordersWrap);
  function paintOrders() {
    var open = openOrders();
    ordersWrap.innerHTML = '';
    if (!open.length) return;
    ordersWrap.appendChild(sectionHead('Open orders'));
    var card = el('div', { class: 'card card-flush' });
    var rows = el('div', { class: 'rows' });
    open.forEach(function (o) { rows.appendChild(openOrderRow(o)); });
    card.appendChild(rows);
    ordersWrap.appendChild(card);
  }
  paintOrders(); onViewTick(paintOrders);

  // ── Holdings ──────────────────────────────────────────────────────────────
  var held = heldSymbols().sort(function (a, b) {
    return positionOf(b).shares * livePrice(b) - positionOf(a).shares * livePrice(a);
  });
  frag.appendChild(sectionHead('Holdings', held.length ? 'Portfolio' : null, '#/portfolio'));
  if (held.length) {
    var hCard = el('div', { class: 'card card-flush' });
    var hRows = el('div', { class: 'rows' });
    held.forEach(function (sym) { hRows.appendChild(holdingRow(sym)); });
    hCard.appendChild(hRows);
    frag.appendChild(hCard);
  } else {
    var hEmpty = el('div', { class: 'card' });
    hEmpty.appendChild(emptyState(
      'No positions yet',
      'You have ' + money(state.cash) + ' of paper money waiting. Find something in Search and place your first buy.',
      'Browse stocks',
      function () { go('#/search'); }
    ));
    frag.appendChild(hEmpty);
  }

  // ── Watchlist ─────────────────────────────────────────────────────────────
  frag.appendChild(sectionHead('Watchlist'));
  var wCard = el('div', { class: 'card card-flush' });
  var wRows = el('div', { class: 'rows' });
  if (state.watchlist.length) {
    state.watchlist.forEach(function (sym) { if (STOCKS[sym]) wRows.appendChild(tickerRow(sym)); });
  } else {
    wRows.appendChild(emptyState('Watchlist is empty', 'Star a stock from its detail page to track it here.', 'Find stocks', function () { go('#/search'); }));
  }
  wCard.appendChild(wRows);
  frag.appendChild(wCard);

  // ── Movers ────────────────────────────────────────────────────────────────
  frag.appendChild(sectionHead('Today\'s movers'));
  var movers = SYMBOLS.map(function (s) { return { sym: s, ch: todayChange(s).pct }; })
                      .sort(function (a, b) { return Math.abs(b.ch) - Math.abs(a.ch); })
                      .slice(0, 5);
  var mCard = el('div', { class: 'card card-flush' });
  var mRows = el('div', { class: 'rows' });
  movers.forEach(function (m) { mRows.appendChild(tickerRow(m.sym)); });
  mCard.appendChild(mRows);
  frag.appendChild(mCard);

  // ── Recent activity ───────────────────────────────────────────────────────
  var recent = state.history.slice().reverse().slice(0, 4);
  frag.appendChild(sectionHead('Recent activity', recent.length ? 'See all' : null, '#/history'));
  var rCard = el('div', { class: 'card card-flush' });
  if (recent.length) {
    var rRows = el('div', { class: 'rows' });
    recent.forEach(function (h) { rRows.appendChild(historyRow(h)); });
    rCard.appendChild(rRows);
  } else {
    rCard.appendChild(emptyState('Nothing here yet', 'Your buys and sells will appear here as soon as you place one.'));
  }
  frag.appendChild(rCard);

  // ── Market news ───────────────────────────────────────────────────────────
  var news = recentNews(4).slice(0, 5);
  if (news.length) {
    frag.appendChild(sectionHead('Market news'));
    var nCard = el('div', { class: 'card' });
    news.forEach(function (n) { nCard.appendChild(newsItem(n)); });
    frag.appendChild(nCard);
  }

  // ── Leaderboard ───────────────────────────────────────────────────────────
  frag.appendChild(sectionHead('Leaderboard'));
  var lbCard = el('div', { class: 'card' });
  frag.appendChild(lbCard);
  function paintLB() {
    lbCard.innerHTML = '';
    leaderboard().forEach(function (r, i) {
      var row = el('div', { class: 'rival-row' + (r.you ? ' you' : '') });
      row.appendChild(el('div', { class: 'rival-rank', text: '#' + (i + 1) }));
      row.appendChild(el('div', { class: 'rival-name', text: r.name }));
      var d = ((r.value - START_CASH) / START_CASH) * 100;
      row.appendChild(el('div', { class: 'row-right' }, [
        el('div', { class: 'row-val', text: money(r.value) }),
        el('div', { class: 'row-delta ' + toneOf(d), text: signedPct(d) })
      ]));
      lbCard.appendChild(row);
    });
  }
  paintLB(); onViewTick(paintLB);

  frag.appendChild(el('div', {
    class: 'hint',
    style: 'text-align:center;padding:24px 20px 8px',
    text: 'Simulated market. Fictional companies, fictional money.'
  }));

  return frag;
}

/* Shared: a single open order row with a cancel button. */
function openOrderRow(o) {
  var row = el('div', { class: 'row' });
  row.appendChild(el('div', {
    class: 'side-pill ' + (o.side === 'buy' ? 'buy' : 'sell'),
    text: o.side === 'buy' ? 'BUY' : 'SELL'
  }));
  var main = el('div', { class: 'row-main' });
  main.appendChild(el('div', { class: 'row-title', text: o.ticker }));
  var trigger = o.type === 'limit' ? 'limit ' + money(o.limitPrice) : 'stop ' + money(o.stopPrice);
  var size = o.notional ? money(o.notional) : shares(o.qty) + ' sh';
  main.appendChild(el('div', { class: 'row-sub', text: size + ' · ' + trigger + ' · ' + relTime(o.createdAt) }));
  row.appendChild(main);

  var right = el('div', { class: 'row-right' });
  right.appendChild(el('div', { class: 'row-val', text: money(livePrice(o.ticker)) }));
  var cancel = el('button', { class: 'btn btn-sm btn-ghost', text: 'Cancel' });
  cancel.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    cancelOrder(o.id);
    toast('Order canceled');
    rerender();
  });
  right.appendChild(cancel);
  row.appendChild(right);
  return row;
}

function newsItem(n) {
  var item = el('div', { class: 'news-item' });
  var tile = logoTile(n.sym);
  item.appendChild(tile);
  var body = el('div', { class: 'news-body' });
  var link = el('a', { href: '#/stock/' + n.sym, class: 'news-head', text: n.headline });
  body.appendChild(link);
  body.appendChild(el('div', {
    class: 'news-meta',
    text: n.tag + ' · ' + n.sym + ' · ' + relTime(n.ts) + ' · ' + (n.good ? '▲ ' : '▼ ') + signedPct(n.jump * 100, 1)
  }));
  item.appendChild(body);
  return item;
}

/* ============================================================================
   20. VIEW — SEARCH
   ========================================================================== */

var searchQuery = '';
var searchSector = 'All';

function viewSearch() {
  var frag = document.createDocumentFragment();
  setTitle('Search', false);

  var bar = el('div', { class: 'search-bar' });
  bar.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>';
  var input = el('input', {
    class: 'input', type: 'search', placeholder: 'Search ticker, company, or sector',
    value: searchQuery, 'aria-label': 'Search stocks'
  });
  bar.appendChild(input);
  frag.appendChild(bar);

  var chips = el('div', { class: 'chips' });
  ['All'].concat(Object.keys(SECTORS)).forEach(function (sec) {
    var c = el('button', { class: 'chip', type: 'button', text: sec });
    c.setAttribute('aria-pressed', String(searchSector === sec));
    c.addEventListener('click', function () {
      searchSector = sec;
      $$('.chip', chips).forEach(function (x) { x.setAttribute('aria-pressed', String(x === c)); });
      paintResults();
    });
    chips.appendChild(c);
  });
  frag.appendChild(chips);

  var resultCard = el('div', { class: 'card card-flush', style: 'margin-top:12px' });
  frag.appendChild(resultCard);

  function matches(sym) {
    var st = STOCKS[sym];
    if (searchSector !== 'All' && st.sector !== searchSector) return false;
    if (!searchQuery) return true;
    var q = searchQuery.toLowerCase();
    return sym.toLowerCase().indexOf(q) !== -1 ||
           st.name.toLowerCase().indexOf(q) !== -1 ||
           st.sector.toLowerCase().indexOf(q) !== -1;
  }

  function paintResults() {
    clearViewTicks();
    resultCard.innerHTML = '';
    var list = SYMBOLS.filter(matches);
    if (!list.length) {
      resultCard.appendChild(emptyState('No matches', 'Nothing in this market matches “' + searchQuery + '”. Try a different name or sector.'));
      return;
    }
    var rows = el('div', { class: 'rows' });
    list.forEach(function (sym) {
      rows.appendChild(tickerRow(sym, { sub: STOCKS[sym].name + ' · ' + STOCKS[sym].sector }));
    });
    resultCard.appendChild(rows);
  }

  input.addEventListener('input', function () {
    searchQuery = input.value.trim();
    paintResults();
  });

  paintResults();
  return frag;
}

/* ============================================================================
   21. VIEW — STOCK DETAIL
   ========================================================================== */

function viewStock(sym) {
  if (!STOCKS[sym]) return viewNotFound(sym);
  var st = STOCKS[sym];
  var frag = document.createDocumentFragment();
  setTitle(sym, true);

  var tf = state.settings.timeframe || '1D';
  var ctype = state.settings.chartType || 'line';

  // ── Header ────────────────────────────────────────────────────────────────
  var head = el('div', { class: 'hero' });
  var nameRow = el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:6px' });
  nameRow.appendChild(logoTile(sym, true));
  var nameCol = el('div', { style: 'flex:1;min-width:0' });
  nameCol.appendChild(el('div', { style: 'font-size:15px;font-weight:750', text: st.name }));
  nameCol.appendChild(el('div', { style: 'font-size:12.5px;color:var(--text-faint)', text: st.sector }));
  nameRow.appendChild(nameCol);

  var starBtn = el('button', { class: 'icon-btn', 'aria-label': 'Toggle watchlist' });
  function paintStar() {
    var on = state.watchlist.indexOf(sym) !== -1;
    starBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"' + (on ? ' fill="currentColor"' : '') + '>' + ICONS.star + '</svg>';
    starBtn.style.color = on ? cssVar('--warn') : '';
    starBtn.setAttribute('aria-pressed', String(on));
  }
  starBtn.addEventListener('click', function () {
    var i = state.watchlist.indexOf(sym);
    if (i === -1) { state.watchlist.push(sym); toast(sym + ' added to watchlist', 'good'); }
    else { state.watchlist.splice(i, 1); toast(sym + ' removed from watchlist'); }
    haptic(10);
    save(); paintStar();
  });
  paintStar();
  nameRow.appendChild(starBtn);
  head.appendChild(nameRow);

  var priceEl = el('div', { class: 'big-price' });
  head.appendChild(priceEl);
  var chEl = el('div', { class: 'delta' });
  head.appendChild(chEl);
  frag.appendChild(head);

  // ── Chart ─────────────────────────────────────────────────────────────────
  var cb = chartBlock({ volume: true, baseline: true, candleReadout: true });
  cb.chart.type = ctype;
  frag.appendChild(cb.wrap);

  var scrubBar = null;
  var baseScrub = cb.chart.onScrub;
  cb.chart.onScrub = function (bar) { baseScrub(bar); scrubBar = bar; paintHeader(); };

  // Timeframe strip
  var strip = el('div', { class: 'tf-strip' });
  TIMEFRAMES.forEach(function (t) {
    var b = el('button', { type: 'button', text: t, 'aria-label': 'Timeframe ' + t });
    b.setAttribute('aria-pressed', String(tf === t));
    b.addEventListener('click', function () {
      tf = t;
      state.settings.timeframe = t;
      save();
      $$('button', strip).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      paintChart(); paintHeader();
      haptic(6);
    });
    strip.appendChild(b);
  });
  frag.appendChild(strip);

  // Line / candle toggle
  var typeSeg = el('div', { class: 'seg', style: 'margin:10px 0 4px' });
  [['line', 'Line'], ['candle', 'Candles']].forEach(function (t) {
    var b = el('button', { type: 'button', text: t[1] });
    b.setAttribute('aria-pressed', String(ctype === t[0]));
    b.addEventListener('click', function () {
      ctype = t[0];
      state.settings.chartType = t[0];
      save();
      $$('button', typeSeg).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      cb.chart.type = ctype;
      paintChart();
    });
    typeSeg.appendChild(b);
  });
  frag.appendChild(typeSeg);

  var currentBars = [];
  function paintChart() {
    currentBars = barsFor(sym, tf);
    cb.chart.setData(currentBars, ctype);
    cb.canvas.setAttribute('aria-label', chartSummary(currentBars, sym + ' ' + tf));
    // Tint the active timeframe pill to match the trend.
    var up = currentBars.length && currentBars[currentBars.length - 1].c >= currentBars[0].o;
    strip.style.setProperty('--tf-color', up ? cssVar('--pos') : cssVar('--neg'));
    strip.style.setProperty('--tf-bg', up ? cssVar('--pos-soft') : cssVar('--neg-soft'));
  }

  var lastShown = null;
  function paintHeader() {
    var live = livePrice(sym);
    var shown = scrubBar ? scrubBar.c : live;
    priceEl.textContent = money(shown);
    if (lastShown !== null && Math.abs(shown - lastShown) > 1e-9) {
      priceEl.classList.remove('flash-pos', 'flash-neg');
      void priceEl.offsetWidth;
      priceEl.classList.add(shown > lastShown ? 'flash-pos' : 'flash-neg');
    }
    lastShown = shown;

    chEl.innerHTML = '';
    var base = currentBars.length ? currentBars[0].o : closeBefore(sym, dayNum(Date.now()));
    var abs = shown - base;
    var pc = base > 0 ? (abs / base) * 100 : 0;
    chEl.appendChild(el('span', { class: toneOf(abs), text: signedMoney(abs) + '  ' + signedPct(pc) }));
    chEl.appendChild(el('span', { class: 'sub', text: scrubBar ? 'at ' + fmtTime(scrubBar.t) : tfLabel(tf) }));
    if (!scrubBar) {
      var sess = sessionLabel(Date.now());
      if (sess.kind !== 'open') chEl.appendChild(el('span', { class: 'sub', text: '· ' + sess.text }));
    }
  }

  paintChart(); paintHeader();
  onViewTick(function () { paintChart(); paintHeader(); });

  // ── Your position ─────────────────────────────────────────────────────────
  var posWrap = el('div');
  frag.appendChild(posWrap);
  function paintPos() {
    var p = positionOf(sym);
    posWrap.innerHTML = '';
    if (p.shares <= 1e-9) return;
    posWrap.appendChild(sectionHead('Your position'));
    var card = el('div', { class: 'card', style: 'padding:6px 16px' });
    var pl = unrealizedPL(sym);
    card.appendChild(kv('Shares', shares(p.shares)));
    card.appendChild(kv('Average cost', money(p.avgCost)));
    card.appendChild(kv('Market value', money(p.shares * livePrice(sym))));
    card.appendChild(kv('Unrealized P/L', signedMoney(pl.abs) + '  ' + signedPct(pl.pct), toneOf(pl.abs)));
    var todayAbs = p.shares * (livePrice(sym) - closeBefore(sym, dayNum(Date.now())));
    card.appendChild(kv('Today', signedMoney(todayAbs), toneOf(todayAbs)));
    if (p.realized) card.appendChild(kv('Realized to date', signedMoney(p.realized), toneOf(p.realized)));
    posWrap.appendChild(card);
  }
  paintPos(); onViewTick(paintPos);

  // ── Open orders on this ticker ────────────────────────────────────────────
  var ooWrap = el('div');
  frag.appendChild(ooWrap);
  function paintOO() {
    var mine = openOrders().filter(function (o) { return o.ticker === sym; });
    ooWrap.innerHTML = '';
    if (!mine.length) return;
    ooWrap.appendChild(sectionHead('Open orders'));
    var card = el('div', { class: 'card card-flush' });
    var rows = el('div', { class: 'rows' });
    mine.forEach(function (o) { rows.appendChild(openOrderRow(o)); });
    card.appendChild(rows);
    ooWrap.appendChild(card);
  }
  paintOO(); onViewTick(paintOO);

  // ── Stats ─────────────────────────────────────────────────────────────────
  frag.appendChild(sectionHead('Statistics'));
  var statGrid = el('div', { class: 'stat-grid' });
  frag.appendChild(statGrid);
  function paintStats() {
    var dn = dayNum(Date.now());
    var day = intradayFor(sym, dn);
    var live = todayLiveDaily(sym);
    var yr = yearRange(sym);
    var q = quoteFor(sym);
    var cells = [
      ['Open', money(day.prevClose)],
      ['High', money(live.h)],
      ['Low', money(live.l)],
      ['Volume', compact(live.v)],
      ['52w high', money(yr.hi)],
      ['52w low', money(yr.lo)],
      ['Market cap', '$' + compact(livePrice(sym) * st.floatShares)],
      ['Volatility', pct(st.vol * 100, 1) + '/d'],
      ['Beta', st.beta.toFixed(2)]
    ];
    if (state.settings.realism) {
      cells.push(['Bid', money(q.bid)]);
      cells.push(['Ask', money(q.ask)]);
      cells.push(['Spread', pct(spreadFor(sym) * 100, 3)]);
    }
    statGrid.innerHTML = '';
    cells.forEach(function (c) {
      var cell = el('div', { class: 'stat' });
      cell.appendChild(el('div', { class: 'stat-label', text: c[0] }));
      cell.appendChild(el('div', { class: 'stat-val', text: c[1] }));
      statGrid.appendChild(cell);
    });
  }
  paintStats(); onViewTick(paintStats);

  // ── Notes ─────────────────────────────────────────────────────────────────
  var notesHead = sectionHead('Notes & alerts');
  var addBtn = el('button', { class: 'section-link', text: '+ Add note' });
  addBtn.addEventListener('click', function () { openNoteEditor(sym); });
  notesHead.appendChild(addBtn);
  frag.appendChild(notesHead);

  var notesWrap = el('div');
  frag.appendChild(notesWrap);
  function paintNotes() {
    var list = notesFor(sym);
    notesWrap.innerHTML = '';
    if (!list.length) {
      var c = el('div', { class: 'card' });
      c.appendChild(emptyState(
        'No notes on ' + sym,
        'Jot down why you are watching this, and attach a price alert so it reminds you when it matters.',
        'Write a note', function () { openNoteEditor(sym); }
      ));
      notesWrap.appendChild(c);
      return;
    }
    list.forEach(function (n) { notesWrap.appendChild(noteCard(n)); });
  }
  paintNotes();

  // ── News on this ticker ───────────────────────────────────────────────────
  var tickerNews = recentNews(120, sym).slice(0, 6);
  if (tickerNews.length) {
    frag.appendChild(sectionHead('News'));
    var nc = el('div', { class: 'card' });
    tickerNews.forEach(function (n) { nc.appendChild(newsItem(n)); });
    frag.appendChild(nc);
  }

  // ── Your history with this ticker ─────────────────────────────────────────
  var mine = state.history.filter(function (h) { return h.ticker === sym; }).reverse();
  frag.appendChild(sectionHead('Your history with ' + sym, mine.length > 5 ? 'See all' : null, '#/history'));
  var histCard = el('div', { class: 'card card-flush' });
  if (mine.length) {
    var hr = el('div', { class: 'rows' });
    mine.slice(0, 5).forEach(function (h) { hr.appendChild(historyRow(h)); });
    histCard.appendChild(hr);
  } else {
    histCard.appendChild(emptyState('No trades in ' + sym, 'Once you buy or sell this one, the fills show up here.'));
  }
  frag.appendChild(histCard);

  // ── About ─────────────────────────────────────────────────────────────────
  frag.appendChild(sectionHead('About'));
  var about = el('div', { class: 'card' });
  about.appendChild(el('div', { style: 'font-size:14px;line-height:1.55;color:var(--text-dim)', text:
    st.name + ' (' + sym + ') is a fictional ' + st.sector.toLowerCase() + ' company created for this simulator. ' +
    'It trades with a daily volatility of about ' + pct(st.vol * 100, 1) + ' and a market beta of ' + st.beta.toFixed(2) + ', ' +
    'meaning it moves ' + (st.beta > 1.15 ? 'more sharply than' : st.beta < 0.85 ? 'more calmly than' : 'roughly in line with') +
    ' the overall market.' }));
  frag.appendChild(about);

  // ── Sticky buy / sell ─────────────────────────────────────────────────────
  setActionBar([
    { label: 'Buy', cls: 'btn-primary', onClick: function () { openOrderTicket(sym, 'buy'); } },
    { label: 'Sell', cls: positionOf(sym).shares > 0 ? 'btn-danger' : 'btn-ghost', onClick: function () { openOrderTicket(sym, 'sell'); } }
  ]);

  return frag;
}

function tfLabel(tf) {
  return { '1D': 'Today', '1W': 'Past week', '1M': 'Past month', '3M': 'Past 3 months', '1Y': 'Past year', 'ALL': 'All time' }[tf] || '';
}

function viewNotFound(sym) {
  var frag = document.createDocumentFragment();
  setTitle('Not found', true);
  frag.appendChild(emptyState('No such ticker', '“' + sym + '” is not listed in this market.', 'Back to search', function () { go('#/search'); }));
  return frag;
}

/* ============================================================================
   22. VIEW — PORTFOLIO
   ========================================================================== */

var allocMode = 'position';

function viewPortfolio() {
  var frag = document.createDocumentFragment();
  setTitle('Portfolio', false);

  // ── Header card ───────────────────────────────────────────────────────────
  var hero = el('div', { class: 'hero' });
  hero.appendChild(el('div', { class: 'hero-label', text: 'Net worth' }));
  var nwEl = el('div', { class: 'big-price' });
  var dEl = el('div', { class: 'delta' });
  hero.appendChild(nwEl); hero.appendChild(dEl);
  frag.appendChild(hero);

  var cb = chartBlock({ volume: false, baseline: true });
  frag.appendChild(cb.wrap);
  var scrubbed = null;
  var base = cb.chart.onScrub;
  cb.chart.onScrub = function (bar) { base(bar); scrubbed = bar; paintHero(); };

  function paintHero() {
    var nw = netWorth();
    var shown = scrubbed ? scrubbed.c : nw;
    nwEl.textContent = money(shown);
    var tot = { abs: shown - START_CASH, pct: ((shown - START_CASH) / START_CASH) * 100 };
    var tp = todayPL();
    dEl.innerHTML = '';
    dEl.appendChild(el('span', { class: toneOf(tot.abs), text: signedMoney(tot.abs) + ' (' + signedPct(tot.pct) + ')' }));
    dEl.appendChild(el('span', { class: 'sub', text: scrubbed ? fmtDate(scrubbed.t) + ' ' + fmtTime(scrubbed.t) : 'all time' }));
    if (!scrubbed) {
      dEl.appendChild(el('span', { class: 'sub', text: '·' }));
      dEl.appendChild(el('span', { class: toneOf(tp), text: signedMoney(tp) + ' today' }));
    }
  }
  function paintChart() {
    var bars = netWorthBars();
    cb.chart.setData(bars, 'line');
    cb.canvas.setAttribute('aria-label', chartSummary(bars, 'Net worth'));
  }
  paintHero(); paintChart();
  onViewTick(function () { paintHero(); paintChart(); });

  // ── Breakdown ─────────────────────────────────────────────────────────────
  frag.appendChild(sectionHead('Account'));
  var acct = el('div', { class: 'card', style: 'padding:6px 16px' });
  frag.appendChild(acct);
  function paintAcct() {
    acct.innerHTML = '';
    var un = totalUnrealized(), re = totalRealized();
    acct.appendChild(kv('Cash', money(state.cash)));
    acct.appendChild(kv('Buying power', money(buyingPower())));
    if (reservedCash() > 0.005) acct.appendChild(kv('Reserved for open orders', money(reservedCash())));
    acct.appendChild(kv('Holdings value', money(holdingsValue())));
    acct.appendChild(kv('Net worth', money(netWorth())));
    acct.appendChild(kv('Unrealized P/L', signedMoney(un), toneOf(un)));
    acct.appendChild(kv('Realized P/L', signedMoney(re), toneOf(re)));
    acct.appendChild(kv('Total return', signedMoney(totalReturn().abs) + '  ' + signedPct(totalReturn().pct), toneOf(totalReturn().abs)));
  }
  paintAcct(); onViewTick(paintAcct);

  // ── Allocation ────────────────────────────────────────────────────────────
  var held = heldSymbols();
  if (held.length) {
    frag.appendChild(sectionHead('Allocation'));
    var seg = el('div', { class: 'seg', style: 'margin-bottom:14px' });
    [['position', 'By position'], ['sector', 'By sector']].forEach(function (m) {
      var b = el('button', { type: 'button', text: m[1] });
      b.setAttribute('aria-pressed', String(allocMode === m[0]));
      b.addEventListener('click', function () {
        allocMode = m[0];
        $$('button', seg).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        paintAlloc();
      });
      seg.appendChild(b);
    });
    frag.appendChild(seg);
    var allocCard = el('div', { class: 'card' });
    frag.appendChild(allocCard);
    function paintAlloc() {
      allocCard.innerHTML = '';
      allocCard.appendChild(allocBlock(allocMode === 'position' ? allocation() : allocationBySector()));
    }
    paintAlloc(); onViewTick(paintAlloc);
  }

  // ── Holdings ──────────────────────────────────────────────────────────────
  frag.appendChild(sectionHead('Holdings'));
  var hCard = el('div', { class: 'card card-flush' });
  if (held.length) {
    var rows = el('div', { class: 'rows' });
    held.sort(function (a, b) {
      return positionOf(b).shares * livePrice(b) - positionOf(a).shares * livePrice(a);
    }).forEach(function (sym) { rows.appendChild(holdingRow(sym)); });
    hCard.appendChild(rows);
  } else {
    hCard.appendChild(emptyState(
      'Nothing owned yet',
      'Your positions, cost basis and unrealized P/L will live here. Start with a single share of anything.',
      'Find a stock', function () { go('#/search'); }
    ));
  }
  frag.appendChild(hCard);

  // ── Open orders ───────────────────────────────────────────────────────────
  var ooWrap = el('div');
  frag.appendChild(ooWrap);
  function paintOO() {
    var open = openOrders();
    ooWrap.innerHTML = '';
    ooWrap.appendChild(sectionHead('Open orders'));
    var card = el('div', { class: 'card card-flush' });
    if (open.length) {
      var r = el('div', { class: 'rows' });
      open.forEach(function (o) { r.appendChild(openOrderRow(o)); });
      card.appendChild(r);
    } else {
      card.appendChild(emptyState('No resting orders', 'Limit and stop orders you place will wait here until the price reaches them.'));
    }
    ooWrap.appendChild(card);
  }
  paintOO(); onViewTick(paintOO);

  // ── Best / worst ──────────────────────────────────────────────────────────
  if (state.stats.bestTrade || state.stats.worstTrade) {
    frag.appendChild(sectionHead('Track record'));
    var tr = el('div', { class: 'card', style: 'padding:6px 16px' });
    tr.appendChild(kv('Trades placed', String(state.stats.tradeCount)));
    if (state.stats.bestTrade) {
      tr.appendChild(kv('Best closed trade', state.stats.bestTrade.ticker + '  ' + signedMoney(state.stats.bestTrade.realized), 'pos'));
    }
    if (state.stats.worstTrade) {
      tr.appendChild(kv('Worst closed trade', state.stats.worstTrade.ticker + '  ' + signedMoney(state.stats.worstTrade.realized), 'neg'));
    }
    tr.appendChild(kv('Day streak', state.stats.streakDays + (state.stats.streakDays === 1 ? ' day' : ' days')));
    frag.appendChild(tr);
  }

  // ── Badges ────────────────────────────────────────────────────────────────
  frag.appendChild(sectionHead('Badges', state.stats.badges.length + ' / ' + BADGES.length));
  var bCard = el('div', { class: 'card' });
  var grid = el('div', { class: 'badge-grid' });
  BADGES.forEach(function (b) {
    var earned = state.stats.badges.indexOf(b.id) !== -1;
    var tile = el('div', { class: 'badge-tile' + (earned ? ' earned' : ''), title: b.name });
    tile.appendChild(el('div', { class: 'badge-emoji', text: b.emoji }));
    tile.appendChild(el('div', { class: 'badge-name', text: b.name }));
    tile.setAttribute('aria-label', b.name + (earned ? ' — earned' : ' — locked'));
    grid.appendChild(tile);
  });
  bCard.appendChild(grid);
  frag.appendChild(bCard);

  // ── Leaderboard ───────────────────────────────────────────────────────────
  frag.appendChild(sectionHead('Leaderboard'));
  var lb = el('div', { class: 'card' });
  frag.appendChild(lb);
  function paintLB() {
    lb.innerHTML = '';
    leaderboard().forEach(function (r, i) {
      var row = el('div', { class: 'rival-row' + (r.you ? ' you' : '') });
      row.appendChild(el('div', { class: 'rival-rank', text: '#' + (i + 1) }));
      row.appendChild(el('div', { class: 'rival-name', text: r.name }));
      var d = ((r.value - START_CASH) / START_CASH) * 100;
      row.appendChild(el('div', { class: 'row-right' }, [
        el('div', { class: 'row-val', text: money(r.value) }),
        el('div', { class: 'row-delta ' + toneOf(d), text: signedPct(d) })
      ]));
      lb.appendChild(row);
    });
  }
  paintLB(); onViewTick(paintLB);

  return frag;
}

/* ============================================================================
   23. VIEW — HISTORY
   ========================================================================== */

var histFilter = { side: 'all', ticker: 'all', status: 'filled', q: '', range: 'all' };

function historyRow(h) {
  var row = el('div', { class: 'row' });
  var voided = h.status !== 'filled';
  row.appendChild(el('div', {
    class: 'side-pill ' + (voided ? 'void' : h.side === 'buy' ? 'buy' : 'sell'),
    text: voided ? (h.status === 'canceled' ? 'CXL' : 'REJ') : (h.side === 'buy' ? 'BUY' : 'SELL')
  }));

  var main = el('div', { class: 'row-main' });
  var title = el('div', { class: 'row-title' }, [document.createTextNode(h.ticker)]);
  if (h.type && h.type !== 'market') {
    title.appendChild(el('span', { class: 'tagchip', text: h.type }));
  }
  main.appendChild(title);
  main.appendChild(el('div', {
    class: 'row-sub',
    text: voided
      ? (h.note || h.status)
      : shares(h.qty) + ' sh @ ' + money(h.price) + ' · ' + fmtTime(h.ts)
  }));
  row.appendChild(main);

  var right = el('div', { class: 'row-right' });
  if (voided) {
    right.appendChild(el('div', { class: 'row-val flat', text: '—' }));
    right.appendChild(el('div', { class: 'row-delta', text: fmtTime(h.ts) }));
  } else {
    right.appendChild(el('div', { class: 'row-val', text: (h.side === 'buy' ? '−' : '+') + money(h.total) }));
    if (h.realized !== null && h.realized !== undefined) {
      right.appendChild(el('div', { class: 'row-delta ' + toneOf(h.realized), text: signedMoney(h.realized) + ' realized' }));
    } else {
      right.appendChild(el('div', { class: 'row-delta', text: 'bal ' + money(h.cashAfter) }));
    }
  }
  row.appendChild(right);

  row.setAttribute('role', 'button');
  row.setAttribute('tabindex', '0');
  row.addEventListener('click', function () { openTradeDetail(h); });
  row.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTradeDetail(h); }
  });
  return row;
}

function openTradeDetail(h) {
  openSheet(function (body) {
    body.appendChild(el('div', { class: 'sheet-title', text: (h.status !== 'filled' ? (h.status === 'canceled' ? 'Canceled ' : 'Rejected ') : h.side === 'buy' ? 'Bought ' : 'Sold ') + h.ticker }));
    body.appendChild(el('div', { class: 'sheet-sub', text: STOCKS[h.ticker] ? STOCKS[h.ticker].name : h.ticker }));

    var card = el('div', { class: 'card', style: 'padding:6px 16px' });
    card.appendChild(kv('Date', fmtDate(h.ts)));
    card.appendChild(kv('Time', fmtTime(h.ts)));
    card.appendChild(kv('Side', h.side === 'buy' ? 'Buy' : 'Sell'));
    card.appendChild(kv('Order type', h.type || 'market'));
    card.appendChild(kv('Status', h.status));
    if (h.status === 'filled') {
      card.appendChild(kv('Quantity', shares(h.qty) + ' shares'));
      card.appendChild(kv('Fill price', money(h.price)));
      card.appendChild(kv('Total value', money(h.total)));
      card.appendChild(kv('Cash after', money(h.cashAfter)));
      if (h.realized !== null && h.realized !== undefined) {
        card.appendChild(kv('Realized P/L', signedMoney(h.realized), toneOf(h.realized)));
      }
      var now = STOCKS[h.ticker] ? livePrice(h.ticker) : null;
      if (now !== null) {
        card.appendChild(kv('Price now', money(now)));
        var since = ((now - h.price) / h.price) * 100;
        card.appendChild(kv('Since this fill', signedPct(since), toneOf(h.side === 'buy' ? since : -since)));
      }
    }
    if (h.note) card.appendChild(kv('Note', h.note));
    body.appendChild(card);

    if (STOCKS[h.ticker]) {
      var open = el('button', { class: 'btn btn-lg btn-ghost', text: 'Open ' + h.ticker });
      open.addEventListener('click', function () { closeSheet(); go('#/stock/' + h.ticker); });
      body.appendChild(open);
    }
  });
}

function viewHistory() {
  var frag = document.createDocumentFragment();
  setTitle('History', false);

  // ── Search + filters ──────────────────────────────────────────────────────
  var bar = el('div', { class: 'search-bar' });
  bar.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>';
  var input = el('input', { class: 'input', type: 'search', placeholder: 'Search by ticker', value: histFilter.q, 'aria-label': 'Search transactions' });
  bar.appendChild(input);
  frag.appendChild(bar);

  var sideChips = el('div', { class: 'chips' });
  [['all', 'All'], ['buy', 'Buys'], ['sell', 'Sells']].forEach(function (s) {
    var c = el('button', { class: 'chip', type: 'button', text: s[1] });
    c.setAttribute('aria-pressed', String(histFilter.side === s[0]));
    c.addEventListener('click', function () {
      histFilter.side = s[0];
      $$('.chip', sideChips).forEach(function (x) { x.setAttribute('aria-pressed', String(x === c)); });
      paint();
    });
    sideChips.appendChild(c);
  });
  frag.appendChild(sideChips);

  var statusChips = el('div', { class: 'chips', style: 'margin-top:8px' });
  [['filled', 'Filled'], ['void', 'Canceled / rejected'], ['all', 'Everything']].forEach(function (s) {
    var c = el('button', { class: 'chip', type: 'button', text: s[1] });
    c.setAttribute('aria-pressed', String(histFilter.status === s[0]));
    c.addEventListener('click', function () {
      histFilter.status = s[0];
      $$('.chip', statusChips).forEach(function (x) { x.setAttribute('aria-pressed', String(x === c)); });
      paint();
    });
    statusChips.appendChild(c);
  });
  frag.appendChild(statusChips);

  var rangeChips = el('div', { class: 'chips', style: 'margin-top:8px' });
  [['all', 'All time'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['today', 'Today']].forEach(function (s) {
    var c = el('button', { class: 'chip', type: 'button', text: s[1] });
    c.setAttribute('aria-pressed', String(histFilter.range === s[0]));
    c.addEventListener('click', function () {
      histFilter.range = s[0];
      $$('.chip', rangeChips).forEach(function (x) { x.setAttribute('aria-pressed', String(x === c)); });
      paint();
    });
    rangeChips.appendChild(c);
  });
  frag.appendChild(rangeChips);

  // ── Summary + export ──────────────────────────────────────────────────────
  var summary = el('div', { class: 'card', style: 'padding:6px 16px;margin-top:14px' });
  frag.appendChild(summary);

  var exportRow = el('div', { style: 'display:flex;gap:8px;margin-bottom:6px' });
  var csvBtn = el('button', { class: 'btn btn-sm btn-ghost', style: 'flex:1', text: 'Export CSV' });
  var jsonBtn = el('button', { class: 'btn btn-sm btn-ghost', style: 'flex:1', text: 'Export JSON' });
  csvBtn.addEventListener('click', function () { exportHistory('csv'); });
  jsonBtn.addEventListener('click', function () { exportHistory('json'); });
  exportRow.appendChild(csvBtn); exportRow.appendChild(jsonBtn);
  frag.appendChild(exportRow);

  var listWrap = el('div');
  frag.appendChild(listWrap);

  function filtered() {
    var now = Date.now();
    return state.history.filter(function (h) {
      if (histFilter.status === 'filled' && h.status !== 'filled') return false;
      if (histFilter.status === 'void' && h.status === 'filled') return false;
      if (histFilter.side !== 'all' && h.side !== histFilter.side) return false;
      if (histFilter.q && h.ticker.toLowerCase().indexOf(histFilter.q.toLowerCase()) === -1) return false;
      if (histFilter.range === 'today' && dayNum(h.ts) !== dayNum(now)) return false;
      if (histFilter.range === '7' && now - h.ts > 7 * DAY_MS) return false;
      if (histFilter.range === '30' && now - h.ts > 30 * DAY_MS) return false;
      return true;
    }).reverse();
  }

  function paint() {
    var list = filtered();

    var bought = 0, sold = 0, realized = 0;
    list.forEach(function (h) {
      if (h.status !== 'filled') return;
      if (h.side === 'buy') bought += h.total; else sold += h.total;
      if (h.realized) realized += h.realized;
    });
    summary.innerHTML = '';
    summary.appendChild(kv('Transactions shown', String(list.length)));
    summary.appendChild(kv('Total bought', money(bought)));
    summary.appendChild(kv('Total sold', money(sold)));
    summary.appendChild(kv('Realized P/L', signedMoney(realized), toneOf(realized)));

    listWrap.innerHTML = '';
    if (!list.length) {
      var card = el('div', { class: 'card' });
      card.appendChild(emptyState(
        state.history.length ? 'No matching transactions' : 'No transactions yet',
        state.history.length
          ? 'Try widening the filters — the record itself is never deleted.'
          : 'Every buy and sell you make is recorded here with the quantity, price, date and the cash balance it left behind.',
        state.history.length ? null : 'Place your first trade',
        function () { go('#/search'); }
      ));
      listWrap.appendChild(card);
      return;
    }

    // Group by calendar day, with a sticky heading per group.
    var currentDay = null, groupCard = null, groupRows = null;
    list.forEach(function (h) {
      var dn = dayNum(h.ts);
      if (dn !== currentDay) {
        currentDay = dn;
        listWrap.appendChild(el('div', { class: 'day-head', text: fmtDayHeading(h.ts) }));
        groupCard = el('div', { class: 'card card-flush', style: 'margin-top:8px' });
        groupRows = el('div', { class: 'rows' });
        groupCard.appendChild(groupRows);
        listWrap.appendChild(groupCard);
      }
      groupRows.appendChild(historyRow(h));
    });
  }

  input.addEventListener('input', function () { histFilter.q = input.value.trim(); paint(); });
  paint();
  return frag;
}

function download(name, text, mime) {
  try {
    var blob = new Blob([text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
    toast('Exported ' + name, 'good');
  } catch (e) {
    toast('Export failed in this browser', 'bad');
  }
}

function exportHistory(kind) {
  var rows = state.history.slice().reverse();
  if (!rows.length) { toast('Nothing to export yet'); return; }
  if (kind === 'json') {
    download('paper-trader-history.json', JSON.stringify(rows, null, 2), 'application/json');
    return;
  }
  var head = ['date', 'time', 'ticker', 'side', 'order_type', 'status', 'quantity', 'price', 'total', 'realized_pl', 'cash_after', 'note'];
  var lines = [head.join(',')];
  rows.forEach(function (h) {
    var d = new Date(h.ts);
    lines.push([
      d.toISOString().slice(0, 10),
      d.toTimeString().slice(0, 8),
      h.ticker, h.side, h.type || 'market', h.status,
      (h.qty || 0).toFixed(6), (h.price || 0).toFixed(4), (h.total || 0).toFixed(2),
      h.realized === null || h.realized === undefined ? '' : h.realized.toFixed(2),
      (h.cashAfter || 0).toFixed(2),
      '"' + String(h.note || '').replace(/"/g, '""') + '"'
    ].join(','));
  });
  download('paper-trader-history.csv', lines.join('\n'), 'text/csv');
}

/* ============================================================================
   24. VIEW — NOTES & ALERTS
   ========================================================================== */

var notesSort = 'recent';

function noteCard(n) {
  var card = el('div', { class: 'note-card' + (n.triggeredAt ? ' triggered' : '') });

  var head = el('div', { class: 'note-head' });
  var link = el('a', { href: '#/stock/' + n.ticker, class: 'note-ticker', text: n.ticker });
  head.appendChild(link);
  var tag = NOTE_TAGS.filter(function (t) { return t.id === n.tag; })[0];
  if (tag) head.appendChild(el('span', { class: 'tagchip', 'data-tag': n.tag, text: tag.label }));
  if (n.targetPrice) {
    head.appendChild(el('span', {
      class: 'tagchip' + (n.triggeredAt ? ' live' : ''),
      text: (n.triggeredAt ? 'Triggered ' : 'Alert ') + (n.direction === 'below' ? '≤ ' : '≥ ') + money(n.targetPrice)
    }));
  }
  card.appendChild(head);

  card.appendChild(el('div', { class: 'note-text', text: n.text }));

  var meta = el('div', { class: 'note-meta' });
  var metaText = el('span');
  meta.appendChild(metaText);

  var actions = el('div', { class: 'note-actions' });
  if (n.triggeredAt) {
    var rearm = el('button', { 'aria-label': 'Re-arm alert', title: 'Re-arm alert', html: svg('bell') });
    rearm.addEventListener('click', function () {
      n.triggeredAt = null; n.triggeredPrice = null;
      save(); toast('Alert re-armed'); rerender();
    });
    actions.appendChild(rearm);
  }
  var edit = el('button', { 'aria-label': 'Edit note', title: 'Edit', html: svg('edit') });
  edit.addEventListener('click', function () { openNoteEditor(n.ticker, n); });
  var del = el('button', { 'aria-label': 'Delete note', title: 'Delete', html: svg('trash') });
  del.addEventListener('click', function () {
    confirmSheet({ title: 'Delete this note?', text: 'The note on ' + n.ticker + ' will be removed. This cannot be undone.', confirm: 'Delete', danger: true }, function () {
      deleteNote(n.id);
      toast('Note deleted');
      rerender();
    });
  });
  actions.appendChild(edit);
  actions.appendChild(del);
  meta.appendChild(actions);
  card.appendChild(meta);

  function paintMeta() {
    var price = livePrice(n.ticker);
    var bits = [money(price)];
    if (n.targetPrice) {
      var away = ((price - n.targetPrice) / n.targetPrice) * 100;
      bits.push(n.triggeredAt
        ? 'hit ' + relTime(n.triggeredAt) + ' at ' + money(n.triggeredPrice || n.targetPrice)
        : signedPct(away) + ' from target');
    }
    bits.push('edited ' + relTime(n.updatedAt));
    metaText.textContent = bits.join(' · ');
  }
  paintMeta();
  onViewTick(paintMeta);
  return card;
}

function viewNotes() {
  var frag = document.createDocumentFragment();
  setTitle('Notes & alerts', false);

  var head = el('div', { style: 'display:flex;gap:8px;align-items:center;margin:14px 0 4px' });
  var seg = el('div', { class: 'seg', style: 'flex:1' });
  [['recent', 'Recent'], ['ticker', 'By ticker']].forEach(function (m) {
    var b = el('button', { type: 'button', text: m[1] });
    b.setAttribute('aria-pressed', String(notesSort === m[0]));
    b.addEventListener('click', function () {
      notesSort = m[0];
      $$('button', seg).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      paint();
    });
    seg.appendChild(b);
  });
  head.appendChild(seg);
  var add = el('button', { class: 'btn btn-sm btn-primary', text: '+ Note' });
  add.addEventListener('click', openTickerPicker);
  head.appendChild(add);
  frag.appendChild(head);

  var body = el('div');
  frag.appendChild(body);

  function paint() {
    body.innerHTML = '';
    if (!state.notes.length) {
      var card = el('div', { class: 'card' });
      card.appendChild(emptyState(
        'No notes yet',
        'Notes are your reminders — why you are watching something, and at what price you want to act. Attach a target and it becomes an alert that finds you.',
        'Write your first note', openTickerPicker
      ));
      body.appendChild(card);
      return;
    }

    var triggered = state.notes.filter(function (n) { return n.triggeredAt; })
                               .sort(function (a, b) { return b.triggeredAt - a.triggeredAt; });
    var rest = state.notes.filter(function (n) { return !n.triggeredAt; });

    if (notesSort === 'ticker') {
      rest.sort(function (a, b) { return a.ticker === b.ticker ? b.updatedAt - a.updatedAt : a.ticker.localeCompare(b.ticker); });
    } else {
      rest.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    }

    if (triggered.length) {
      body.appendChild(sectionHead('Triggered alerts'));
      triggered.forEach(function (n) { body.appendChild(noteCard(n)); });
    }
    if (rest.length) {
      body.appendChild(sectionHead(triggered.length ? 'All notes' : 'Your notes'));
      rest.forEach(function (n) { body.appendChild(noteCard(n)); });
    }

    var armed = state.notes.filter(function (n) { return n.targetPrice && !n.triggeredAt; }).length;
    body.appendChild(el('div', {
      class: 'hint', style: 'text-align:center;padding:18px 10px',
      text: state.notes.length + ' note' + (state.notes.length === 1 ? '' : 's') + ' · ' + armed + ' alert' + (armed === 1 ? '' : 's') + ' armed'
    }));
  }

  paint();
  return frag;
}

/* Ticker picker used by "+ Note" when we are not already on a stock page. */
function openTickerPicker() {
  openSheet(function (body) {
    body.appendChild(el('div', { class: 'sheet-title', text: 'Pick a stock' }));
    body.appendChild(el('div', { class: 'sheet-sub', text: 'Which company is this note about?' }));

    var bar = el('div', { class: 'search-bar', style: 'margin-top:0' });
    bar.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>';
    var input = el('input', { class: 'input', type: 'search', placeholder: 'Ticker or company', 'aria-label': 'Search stocks' });
    bar.appendChild(input);
    body.appendChild(bar);

    var list = el('div', { class: 'rows', style: 'max-height:46vh;overflow-y:auto' });
    body.appendChild(list);

    function paint() {
      var q = input.value.trim().toLowerCase();
      list.innerHTML = '';
      SYMBOLS.filter(function (s) {
        return !q || s.toLowerCase().indexOf(q) !== -1 || STOCKS[s].name.toLowerCase().indexOf(q) !== -1;
      }).slice(0, 40).forEach(function (sym) {
        var row = el('div', { class: 'row' });
        row.appendChild(logoTile(sym));
        var main = el('div', { class: 'row-main' });
        main.appendChild(el('div', { class: 'row-title', text: sym }));
        main.appendChild(el('div', { class: 'row-sub', text: STOCKS[sym].name }));
        row.appendChild(main);
        row.appendChild(el('div', { class: 'row-val', text: money(livePrice(sym)) }));
        row.addEventListener('click', function () { closeSheet(); setTimeout(function () { openNoteEditor(sym); }, 320); });
        list.appendChild(row);
      });
    }
    input.addEventListener('input', paint);
    paint();
  });
}

/* ============================================================================
   25. SETTINGS
   ========================================================================== */

function applySettings() {
  document.documentElement.setAttribute('data-palette', state.settings.palette === 'cb' ? 'cb' : 'classic');
  document.documentElement.setAttribute('data-motion', state.settings.reducedMotion ? 'reduced' : 'normal');
}

function switchRow(label, desc, get, set) {
  var row = el('div', { class: 'switch-row' });
  var col = el('div');
  col.appendChild(el('div', { class: 'switch-label', text: label }));
  col.appendChild(el('div', { class: 'switch-desc', text: desc }));
  row.appendChild(col);
  var sw = el('button', { class: 'switch', type: 'button', 'aria-label': label });
  sw.setAttribute('aria-pressed', String(get()));
  sw.addEventListener('click', function () {
    set(!get());
    sw.setAttribute('aria-pressed', String(get()));
    save();
    haptic(8);
  });
  row.appendChild(sw);
  return row;
}

function openSettings() {
  openSheet(function (body) {
    body.appendChild(el('div', { class: 'sheet-title', text: 'Settings' }));
    body.appendChild(el('div', { class: 'sheet-sub', text: 'Seed #' + state.seed + ' · started ' + fmtDate(state.createdAt) }));

    // Palette
    var pf = el('div', { class: 'field' });
    pf.appendChild(el('div', { class: 'field-label', text: 'Colour palette' }));
    var pseg = el('div', { class: 'seg' });
    [['classic', 'Green / Red'], ['cb', 'Blue / Orange']].forEach(function (p) {
      var b = el('button', { type: 'button', text: p[1] });
      b.setAttribute('aria-pressed', String(state.settings.palette === p[0]));
      b.addEventListener('click', function () {
        state.settings.palette = p[0];
        $$('button', pseg).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        applySettings(); save(); rerender();
      });
      pseg.appendChild(b);
    });
    pf.appendChild(pseg);
    pf.appendChild(el('div', { class: 'hint', text: 'Blue / orange stays legible with red-green colour blindness.' }));
    body.appendChild(pf);

    var card = el('div', { class: 'card', style: 'padding:2px 16px' });
    card.appendChild(switchRow(
      'Realistic fills', 'Apply a bid/ask spread and slippage to market orders',
      function () { return state.settings.realism; },
      function (v) { state.settings.realism = v; }
    ));
    card.appendChild(switchRow(
      'Reduce motion', 'Turn off transitions and price flashes',
      function () { return state.settings.reducedMotion; },
      function (v) { state.settings.reducedMotion = v; applySettings(); }
    ));
    card.appendChild(switchRow(
      'Haptics', 'Vibrate on confirmations, where supported',
      function () { return state.settings.haptics; },
      function (v) { state.settings.haptics = v; }
    ));
    body.appendChild(card);

    // Data
    body.appendChild(el('div', { class: 'section-title', style: 'margin:6px 2px 10px', text: 'Data' }));
    var dataRow = el('div', { style: 'display:flex;gap:8px;margin-bottom:10px' });
    var expH = el('button', { class: 'btn btn-ghost', style: 'flex:1', text: 'Export history' });
    expH.addEventListener('click', function () { exportHistory('csv'); });
    var expS = el('button', { class: 'btn btn-ghost', style: 'flex:1', text: 'Export save' });
    expS.addEventListener('click', function () {
      download('paper-trader-save.json', JSON.stringify(state, null, 2), 'application/json');
    });
    dataRow.appendChild(expH); dataRow.appendChild(expS);
    body.appendChild(dataRow);

    var reset = el('button', { class: 'btn btn-lg btn-danger', text: 'Reset account' });
    reset.addEventListener('click', function () {
      confirmSheet({
        title: 'Start over?',
        text: 'This wipes your positions, orders, transaction history and notes, and generates a brand new market. You will be back to ' + money(START_CASH) + ' in paper money. It cannot be undone.',
        confirm: 'Reset everything',
        danger: true
      }, function () {
        var keep = { palette: state.settings.palette, reducedMotion: state.settings.reducedMotion, haptics: state.settings.haptics, realism: state.settings.realism };
        state = freshState();
        state.settings = Object.assign(state.settings, keep, { onboarded: true });
        intradayCache.clear();
        buildDaily();
        saveNow();
        applySettings();
        toast('Fresh start — ' + money(START_CASH) + ' in paper money', 'good');
        go('#/home');
        rerender();
      });
    });
    body.appendChild(reset);

    body.appendChild(el('div', {
      class: 'hint', style: 'margin-top:16px;text-align:center',
      text: 'Paper Trader is a simulation. The companies, prices, headlines and money are all invented. Nothing here is investment advice, and no real order ever leaves your device.'
    }));
  });
}

/* ============================================================================
   26. CHROME — title bar, action bar, tabs
   ========================================================================== */

function setTitle(text, showBack) {
  $('#topbarTitle').textContent = text;
  $('#backBtn').hidden = !showBack;
}

function setActionBar(buttons) {
  var bar = $('#actionBar');
  bar.innerHTML = '';
  if (!buttons || !buttons.length) {
    bar.hidden = true;
    $('#view').classList.remove('has-action-bar');
    return;
  }
  buttons.forEach(function (b) {
    var btn = el('button', { class: 'btn ' + (b.cls || 'btn-ghost'), text: b.label });
    btn.addEventListener('click', b.onClick);
    bar.appendChild(btn);
  });
  bar.hidden = false;
  $('#view').classList.add('has-action-bar');
}

function updateSessionPill() {
  var s = sessionLabel(Date.now());
  var pill = $('#sessionPill');
  pill.setAttribute('data-session', s.kind);
  $('#sessionText').textContent = s.text;
}

function updateNotesBadge() {
  var n = state.notes.filter(function (x) { return x.triggeredAt; }).length;
  var badge = $('#notesBadge');
  badge.hidden = n === 0;
  badge.textContent = String(n);
}

/* ============================================================================
   27. ROUTER
   ========================================================================== */

var currentRoute = null;

function parseRoute() {
  var h = (location.hash || '').replace(/^#\/?/, '');
  var parts = h.split('/').filter(Boolean);
  if (!parts.length) return { name: 'home' };
  switch (parts[0]) {
    case 'search':    return { name: 'search' };
    case 'portfolio': return { name: 'portfolio' };
    case 'history':   return { name: 'history' };
    case 'notes':     return { name: 'notes' };
    case 'stock':     return { name: 'stock', sym: (parts[1] || '').toUpperCase() };
    default:          return { name: 'home' };
  }
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function render(preserveScroll) {
  var route = parseRoute();
  currentRoute = route;

  clearViewTicks();
  setActionBar(null);

  var view = $('#view');
  var scrollY = preserveScroll ? window.scrollY : 0;
  view.innerHTML = '';

  var content;
  switch (route.name) {
    case 'search':    content = viewSearch(); break;
    case 'portfolio': content = viewPortfolio(); break;
    case 'history':   content = viewHistory(); break;
    case 'notes':     content = viewNotes(); break;
    case 'stock':     content = viewStock(route.sym); break;
    default:          content = viewHome(); break;
  }
  view.appendChild(content);

  // Tab highlighting — a stock page belongs to whichever tab you came from,
  // so we simply light none of them rather than lying.
  var tabName = route.name === 'stock' ? null : route.name;
  $$('.tab').forEach(function (t) {
    if (t.getAttribute('data-tab') === tabName) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });

  window.scrollTo(0, scrollY);
  updateSessionPill();
  updateNotesBadge();
}

/* Re-render in place, keeping the scroll position — used after a trade. */
var rerenderQueued = false;
function rerender() {
  if (rerenderQueued) return;
  rerenderQueued = true;
  setTimeout(function () {
    rerenderQueued = false;
    render(true);
  }, 0);
}

/* ============================================================================
   28. THE LOOP
   ========================================================================== */

var tickCount = 0;
var lastNewsMinute = -1;

function pumpNews() {
  var now = Date.now();
  var m = minuteOfDay(now);
  if (lastNewsMinute < 0) { lastNewsMinute = m; return; }
  if (m === lastNewsMinute) return;
  var dn = dayNum(now);
  var from = lastNewsMinute;
  lastNewsMinute = m;

  collectNews(dn).forEach(function (n) {
    if (n.minute <= from || n.minute > m) return;
    var relevant = positionOf(n.sym).shares > 0 || state.watchlist.indexOf(n.sym) !== -1;
    if (!relevant) return;
    state.news.push({ sym: n.sym, headline: n.headline, ts: now, good: n.good });
    pushBanner('news', n.headline, n.sym + ' ' + (n.good ? '▲' : '▼') + ' ' + signedPct(n.jump * 100, 1) + ' on the news',
      function () { go('#/stock/' + n.sym); });
  });
}

function tick() {
  if (document.hidden) return;
  var now = Date.now();

  // Settle anything that crossed its trigger since the last tick.
  var fills = processRestingOrders(state.lastSeen, now);
  fills.forEach(function (f) {
    pushBanner('fill',
      (f.side === 'buy' ? 'Bought ' : 'Sold ') + shares(f.qty) + ' ' + f.ticker + ' @ ' + money(f.price),
      'Your ' + f.type + ' order filled ' + relTime(f.ts) + '.',
      function () { go('#/stock/' + f.ticker); });
    haptic([10, 30, 10]);
  });

  var alerts = checkAlerts();
  alerts.forEach(function (a) {
    pushBanner('alert',
      a.ticker + ' ' + (a.direction === 'below' ? 'fell to ' : 'reached ') + money(a.triggeredPrice),
      a.text,
      function () { go('#/stock/' + a.ticker); });
    haptic([16, 40, 16]);
  });

  pumpNews();

  state.lastSeen = now;
  snapshotNetWorth();
  updateSessionPill();
  updateNotesBadge();

  // Repaint whatever is mounted. Errors in one panel must not kill the loop.
  viewTicks.forEach(function (fn) { try { fn(); } catch (e) { console.warn(e); } });
  sheetTicks.forEach(function (fn) { try { fn(); } catch (e) { console.warn(e); } });

  if (fills.length || alerts.length) { save(); rerender(); }
  else if (++tickCount % 30 === 0) save();
}

/* ============================================================================
   29. BOOT
   ========================================================================== */

function catchUp() {
  var now = Date.now();
  var away = now - state.lastSeen;
  var fills = processRestingOrders(state.lastSeen, now);
  state.lastSeen = now;
  lastNewsMinute = minuteOfDay(now);

  if (fills.length) {
    fills.forEach(function (f) {
      pushBanner('fill',
        (f.side === 'buy' ? 'Bought ' : 'Sold ') + shares(f.qty) + ' ' + f.ticker + ' @ ' + money(f.price),
        'Filled while you were away, ' + relTime(f.ts) + '.',
        function () { go('#/stock/' + f.ticker); });
    });
  }
  var alerts = checkAlerts();
  alerts.forEach(function (a) {
    pushBanner('alert', a.ticker + ' hit ' + money(a.triggeredPrice), a.text, function () { go('#/stock/' + a.ticker); });
  });

  if (away > 6 * 3600 * 1000 && state.stats.tradeCount > 0) {
    var tot = totalReturn();
    pushBanner('news', 'Welcome back',
      'The market kept moving. You are at ' + money(netWorth()) + ' — ' + signedPct(tot.pct) + ' all time.');
  }
  snapshotNetWorth();
  save();
}

function boot() {
  applySettings();
  touchStreak();
  catchUp();
  checkBadges();

  render();
  setInterval(tick, TICK_MS);

  // Re-sync the instant the tab comes back, rather than waiting for a tick.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { catchUp(); render(true); }
  });

  // Charts are canvas — they need an explicit repaint on resize / rotate.
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      viewTicks.forEach(function (fn) { try { fn(); } catch (e) {} });
    }, 140);
  });

  window.addEventListener('hashchange', function () { render(); });

  $('#backBtn').addEventListener('click', function () {
    if (history.length > 1) history.back();
    else go('#/home');
  });
  $('#settingsBtn').addEventListener('click', openSettings);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && sheetState.open) closeSheet();
  });

  // Persist immediately if the page is being closed.
  window.addEventListener('pagehide', saveNow);
  window.addEventListener('beforeunload', saveNow);
}

function init() {
  state = load();
  applySettings();
  buildDaily();
  initSheetGestures();

  if (!state.settings.onboarded) {
    var ob = $('#onboard');
    ob.hidden = false;
    $('#onboardStart').addEventListener('click', function () {
      state.settings.onboarded = true;
      state.createdAt = Date.now();
      state.lastSeen = Date.now();
      state.snapshots = [{ t: Date.now(), v: START_CASH }];
      saveNow();
      ob.hidden = true;
      boot();
    });
    return;
  }
  boot();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
