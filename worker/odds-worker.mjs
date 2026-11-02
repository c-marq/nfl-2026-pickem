// NFL odds proxy for the scores & odds page — Cloudflare Worker (free plan).
//
// GET /odds  ->  trimmed Hard Rock Bet (FL) odds for every NFL game The Odds API lists.
//
// Why a Worker: the page is static (GitHub Pages) and can't hide an API key. The Worker
// holds the key as a secret (env.ODDS_API_KEY) and keeps ONE shared cached copy in KV,
// so credit use depends on the clock, not on how many people open the page.
//
// Credit rules (The Odds API free plan = 500 credits/month; one call here = 3 credits):
//   * Fresh enough?  FAST_TTL inside the game-day window (WINDOW_LEAD before the day's
//     first kickoff through its last kickoff, US Eastern), SLOW_TTL otherwise. Fresh -> 0 credits.
//   * Credit floor:  if a call would take the balance under CREDIT_FLOOR, stop calling and serve the cached
//     copy (stale: true). Re-check the balance on the free /sports endpoint (0 credits) at
//     most every 6 h, so the feed resumes on its own after the monthly reset. If the balance
//     can't be confirmed for a week, allow one refresh so a missed reset can't freeze the feed.
//   * Waste guards:  one refresh at a time per isolate, a short KV "in flight" marker for
//     other instances (best effort: KV can lag ~60 s between locations), a 5-minute back-off after an upstream failure, and a failed KV save
//     never throws away a response we already paid for.
//   * Closing lines: once a game kicks off we keep its last pre-kickoff line (with the time
//     we captured it, `lineAt`) and never store live in-game odds.

const SPORT = "americanfootball_nfl";
const BOOK = "hardrockbet_fl";
const MARKETS = "h2h,spreads,totals";
const API = "https://api.the-odds-api.com/v4";
const KV_KEY = "odds:v1";     // the cached odds (shared by every visitor)
const KV_META = "odds:meta";  // refresh bookkeeping: in-flight marker, back-off

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const FAST_TTL = 90 * MIN;      // game-day window (chosen 2026-11-01; worst case ~324/month)
const SLOW_TTL = 12 * HOUR;     // everything else
const WINDOW_LEAD = 2 * HOUR;   // window opens this long before the day's first kickoff
const PROBE_EVERY = 6 * HOUR;   // free balance re-check while under the floor
const KEEP_PAST = 10 * DAY;     // keep closing lines for finished games this long
const DEFAULT_FLOOR = 100;
const CALL_COST = 3;            // 1 region (one book) x 3 markets
const ASSUMED_MONTHLY = 500;    // only used if the API never reports a balance
const RETRY_AFTER_FAIL = 5 * MIN;
const INFLIGHT_HOLD = 60_000;  // KV can take up to ~60 s to show the marker in other locations
const FETCH_TIMEOUT = 10_000;  // never let a hung upstream hold every request
const UNKNOWN_BALANCE_RETRY = 7 * DAY;

let inflight = null;      // refresh already running in this isolate -> share it
let memCache = null;      // last odds this isolate fetched (backstop if KV reads/writes fail)
let memRetryAfter = 0;    // back-off that survives a KV outage

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405, cors);
    if (url.pathname !== "/odds") return json({ error: "not found" }, 404, cors);
    if (!env.ODDS_KV) return json({ error: "KV binding ODDS_KV is not configured" }, 500, cors);

    const now = Date.now();
    const floor = parseFloor(env.CREDIT_FLOOR);
    const cached = clean(newer(await readJson(env, KV_KEY, isValidCache), memCache)); // corrupt value -> treated as no cache

    if (cached && now - Date.parse(cached.fetched) < maxAge(cached, now)) {
      return json(publicView(cached, false), 200, cors);
    }

    const meta = (await readJson(env, KV_META, m => m && typeof m === "object" && !Array.isArray(m))) || {};

    // A call would take the balance under the floor: serve cached odds unless the free balance check says we've recovered.
    const bal = balanceOf(cached, meta);
    if (cached && bal.remaining != null && bal.remaining - CALL_COST < floor) {
      const allowed = await floorAllows(env, cached, meta, bal, floor, now);
      if (!allowed) return json(publicView(cached, true, "credit-floor"), 200, cors);
    }

    if (!env.ODDS_API_KEY) {
      return cached ? json(publicView(cached, true, "no-key"), 200, cors)
                    : json({ error: "odds unavailable" }, 503, cors);
    }

    if (now < Math.max(meta.retryAfter || 0, memRetryAfter)) { // upstream failed recently: back off
      return cached ? json(publicView(cached, true, "upstream-error"), 200, cors)
                    : json({ error: "odds unavailable" }, 503, cors);
    }
    if (cached && meta.inflightUntil && now < meta.inflightUntil) { // another instance is refreshing
      return json(publicView(cached, false), 200, cors);
    }

    try {
      if (!inflight) inflight = doRefresh(env, cached, meta, balanceOf(cached, meta), now).finally(() => { inflight = null; });
      const fresh = await inflight;
      return json(publicView(fresh, false), 200, cors);
    } catch (err) {
      // Never echo the upstream URL (it contains the key). Log only a short reason.
      console.log("odds refresh failed:", String((err && err.message) || err).slice(0, 120));
      return cached ? json(publicView(cached, true, "upstream-error"), 200, cors)
                    : json({ error: "odds unavailable" }, 503, cors);
    }
  },
};

// ---------- refresh ----------

async function doRefresh(env, cached, meta, bal, now) {
  // Probe/recovery bookkeeping lives in KV_META so it never overwrites a newer odds copy.
  const keep = { probed: meta.probed, recoveryTried: meta.recoveryTried, probeRemaining: meta.probeRemaining, probeAt: meta.probeAt };
  await safePut(env, KV_META, { ...keep, inflightUntil: now + INFLIGHT_HOLD });
  try {
    const fresh = await refresh(env.ODDS_API_KEY, cached, bal, now);
    memCache = fresh;
    await safePut(env, KV_KEY, fresh);   // if this fails we still return what we paid for
    await safePut(env, KV_META, keep);
    return fresh;
  } catch (err) {
    memRetryAfter = now + RETRY_AFTER_FAIL;
    await safePut(env, KV_META, { ...keep, retryAfter: memRetryAfter });
    throw err;
  }
}

async function refresh(key, cached, bal, now) {
  const qs = new URLSearchParams({
    apiKey: key, bookmakers: BOOK, markets: MARKETS, oddsFormat: "american", dateFormat: "iso",
  });
  const res = await fetch(`${API}/sports/${SPORT}/odds?${qs}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const events = await res.json();
  if (!Array.isArray(events)) throw new Error("unexpected upstream shape");

  const stamp = new Date(now).toISOString();
  // Balance: trust the header; if it's missing, count our own spend from the last known value.
  const header = toNum(res.headers.get("x-requests-remaining"));
  const remaining = header != null ? header : (bal.remaining ?? ASSUMED_MONTHLY) - CALL_COST;
  const knownAt = header != null ? stamp : (bal.knownAt ?? null);

  const prev = new Map((cached?.games || []).map(g => [g.id, g]));
  const games = [];
  const seen = new Set();
  for (const ev of events) {
    if (!ev || typeof ev.id !== "string" || Number.isNaN(Date.parse(ev.commence_time))) continue;
    const start = Date.parse(ev.commence_time);
    const old = prev.get(ev.id);
    seen.add(ev.id);
    if (start <= now) {
      // Kicked off: keep the pre-kickoff line we already had, never live odds.
      games.push(old ? { ...old, closed: true }
                     : { id: ev.id, commence: ev.commence_time, home: ev.home_team, away: ev.away_team, closed: true, lines: null, lineAt: null });
    } else {
      const ex = extractLines(ev);
      if (!hasLines(ex.lines) && old && hasLines(old.lines)) {
        // Still listed but the Hard Rock market is missing (pulled or briefly off): keep the last
        // real line and when we captured it, so the page can label it "Last line · <time>".
        games.push({ ...old, commence: ev.commence_time, home: ev.home_team, away: ev.away_team, closed: false });
      } else {
        games.push({ id: ev.id, commence: ev.commence_time, home: ev.home_team, away: ev.away_team, closed: false, lineAt: stamp, ...ex });
      }
    }
  }
  // Games that dropped out of the API: finished ones keep their closing line for a while;
  // an upcoming one that vanished keeps its old line and old lineAt (the page labels it by age).
  for (const g of prev.values()) {
    if (!seen.has(g.id) && now - Date.parse(g.commence) < KEEP_PAST) {
      games.push({ ...g, closed: Date.parse(g.commence) <= now });
    }
  }
  games.sort((a, b) => Date.parse(a.commence) - Date.parse(b.commence));
  return { fetched: stamp, book: BOOK, remaining, knownAt, games };
}

// Returns true when a refresh is allowed despite the balance being at the floor.
// Updates `meta` (probe time/result, recovery time) and saves it to KV_META only.
async function floorAllows(env, cached, meta, bal, floor, now) {
  let rem = null, changed = false;
  const lastProbe = Date.parse(meta.probed || 0) || 0;
  if (env.ODDS_API_KEY && now - lastProbe >= PROBE_EVERY) {
    rem = await probeRemaining(env.ODDS_API_KEY).catch(() => null);
    meta.probed = new Date(now).toISOString();
    changed = true;
    if (rem != null) { meta.probeRemaining = rem; meta.probeAt = meta.probed; }
  }
  let allow = rem != null && rem - CALL_COST >= floor;
  // The balance can't be confirmed (no header anywhere) and hasn't been for a week:
  // allow one refresh so a monthly reset we couldn't see doesn't freeze the feed.
  const knownAt = Date.parse(bal.knownAt || cached.fetched) || 0;
  const lastTry = Date.parse(meta.recoveryTried || 0) || 0;
  if (!allow && rem == null && now - knownAt > UNKNOWN_BALANCE_RETRY && now - lastTry > UNKNOWN_BALANCE_RETRY) {
    allow = true;
    meta.recoveryTried = new Date(now).toISOString();
    changed = true;
  }
  if (changed) await safePut(env, KV_META, meta);
  return allow;
}

async function probeRemaining(key) {
  // /sports does not count against the usage quota; it may report the balance.
  const res = await fetch(`${API}/sports?${new URLSearchParams({ apiKey: key })}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  return toNum(res.headers.get("x-requests-remaining"));
}

function extractLines(ev) {
  const bk = (ev.bookmakers || []).find(b => b && b.key === BOOK);
  if (!bk) return { lines: null, updated: null };
  const mk = k => (bk.markets || []).find(m => m && m.key === k);
  const h2h = mk("h2h"), spreads = mk("spreads"), totals = mk("totals");
  const lines = { ml: null, spread: null, total: null };
  if (h2h) {
    lines.ml = {};
    for (const o of h2h.outcomes || []) if (o && isNum(o.price)) lines.ml[o.name] = o.price;
    if (!Object.keys(lines.ml).length) lines.ml = null;
  }
  if (spreads) {
    lines.spread = {};
    for (const o of spreads.outcomes || []) if (o && isNum(o.point)) lines.spread[o.name] = { point: o.point, price: isNum(o.price) ? o.price : null };
    if (!Object.keys(lines.spread).length) lines.spread = null;
  }
  if (totals) {
    const over = (totals.outcomes || []).find(o => o && o.name === "Over");
    const under = (totals.outcomes || []).find(o => o && o.name === "Under");
    const point = over?.point ?? under?.point;
    if (isNum(point)) lines.total = { point, over: isNum(over?.price) ? over.price : null, under: isNum(under?.price) ? under.price : null };
  }
  return { lines, updated: bk.last_update || null };
}

// ---------- freshness ----------

function maxAge(cached, now) {
  const today = etDate(now);
  const starts = (cached.games || [])
    .map(g => Date.parse(g.commence))
    .filter(t => !Number.isNaN(t) && etDate(t) === today);
  if (!starts.length) return SLOW_TTL;
  const first = Math.min(...starts), last = Math.max(...starts);
  return now >= first - WINDOW_LEAD && now <= last ? FAST_TTL : SLOW_TTL;
}

const ET_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
function etDate(ms) { return ET_DATE.format(new Date(ms)); } // YYYY-MM-DD

// ---------- helpers ----------

function clean(c) { // drop junk entries so one bad value in KV can't crash freshness checks
  return c ? { ...c, games: c.games.filter(g => g && typeof g === "object" && typeof g.commence === "string" && !Number.isNaN(Date.parse(g.commence))) } : null;
}

function hasLines(l) { return !!l && !!(l.ml || l.spread || l.total); }

// Latest known balance: from the last odds call, or a newer free /sports probe.
function balanceOf(cached, meta) {
  const own = { remaining: cached?.remaining ?? null, knownAt: cached?.knownAt ?? null };
  if (meta.probeRemaining != null && (Date.parse(meta.probeAt || 0) || 0) > (Date.parse(own.knownAt || 0) || 0)) {
    return { remaining: meta.probeRemaining, knownAt: meta.probeAt };
  }
  return own;
}

function newer(a, b) {
  if (!a) return b && isValidCache(b) ? b : null;
  if (!b) return a;
  return Date.parse(b.fetched) > Date.parse(a.fetched) ? b : a;
}

function isValidCache(c) {
  return !!c && typeof c === "object" && typeof c.fetched === "string" && !Number.isNaN(Date.parse(c.fetched)) && Array.isArray(c.games);
}

async function readJson(env, key, check) {
  try { const v = await env.ODDS_KV.get(key, "json"); return check(v) ? v : null; }
  catch { return null; } // unreadable / corrupt -> as if empty
}

async function safePut(env, key, value) {
  try { await env.ODDS_KV.put(key, JSON.stringify(value)); }
  catch { console.log("kv put failed:", key); }
}

function parseFloor(v) {
  if (v == null || String(v).trim() === "") return DEFAULT_FLOOR;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_FLOOR;
}

function publicView(data, stale, reason) {
  // Trimmed for the page. `remaining` is the shared API balance (not secret) — handy for debugging.
  return { fetched: data.fetched, book: data.book, stale, ...(reason ? { reason } : {}), remaining: data.remaining ?? null, games: data.games };
}

function corsHeaders(request, env) {
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const origin = request.headers.get("Origin");
  const h = { "Vary": "Origin" };
  if (origin && allowed.includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

function json(body, status, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60", ...extra },
  });
}

function toNum(v) { const n = Number(v); return v == null || v === "" || !Number.isFinite(n) ? null : n; }
function isNum(v) { return typeof v === "number" && Number.isFinite(v); }
