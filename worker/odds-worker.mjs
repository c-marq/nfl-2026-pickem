// NFL odds proxy for the pick'em page — Cloudflare Worker (free plan).
//
// GET /odds  ->  trimmed Hard Rock Bet (FL) odds for every NFL game The Odds API lists.
//
// Why a Worker: the page is static (GitHub Pages) and can't hide an API key. The Worker
// holds the key as a secret (env.ODDS_API_KEY) and keeps ONE shared cached copy in KV,
// so credit use depends on the clock, not on how many people open the page.
//
// Credit rules (The Odds API free plan = 500 credits/month; one call here = 3 credits):
//   * Fresh enough?  60 min inside the game-day window (4 h before the day's first
//     kickoff through its last kickoff, US Eastern), 12 h otherwise. Fresh -> 0 credits.
//   * Credit floor:  if the last call left < CREDIT_FLOOR credits, stop calling and serve
//     the cached copy (stale: true). Re-check the balance on the free /sports endpoint
//     (0 credits) at most every 6 h, so the feed resumes on its own after the monthly reset.
//   * Closing lines: once a game kicks off we keep its last pre-kickoff line and never
//     store live in-game odds.

const SPORT = "americanfootball_nfl";
const BOOK = "hardrockbet_fl";
const MARKETS = "h2h,spreads,totals";
const API = "https://api.the-odds-api.com/v4";
const KV_KEY = "odds:v1";

const MIN = 60_000, HOUR = 60 * MIN;
const FAST_TTL = 60 * MIN;      // game-day window
const SLOW_TTL = 12 * HOUR;     // everything else
const WINDOW_LEAD = 4 * HOUR;   // window opens this long before the day's first kickoff
const PROBE_EVERY = 6 * HOUR;   // free balance re-check while under the floor
const KEEP_PAST = 10 * 24 * HOUR; // keep closing lines for finished games this long
const DEFAULT_FLOOR = 100;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405, cors);
    if (url.pathname !== "/odds") return json({ error: "not found" }, 404, cors);
    if (!env.ODDS_KV) return json({ error: "KV binding ODDS_KV is not configured" }, 500, cors);

    const now = Date.now();
    const floor = Number(env.CREDIT_FLOOR ?? DEFAULT_FLOOR);
    const cached = await env.ODDS_KV.get(KV_KEY, "json");

    if (cached && now - Date.parse(cached.fetched) < maxAge(cached, now)) {
      return json(publicView(cached, false), 200, cors);
    }

    // Under the credit floor: serve cached odds, and only probe the free endpoint now and then.
    if (cached && cached.remaining != null && cached.remaining < floor) {
      const lastProbe = cached.probed ? Date.parse(cached.probed) : 0;
      let recovered = false;
      if (now - lastProbe >= PROBE_EVERY && env.ODDS_API_KEY) {
        const rem = await probeRemaining(env.ODDS_API_KEY).catch(() => null);
        recovered = rem != null && rem >= floor;
        await env.ODDS_KV.put(KV_KEY, JSON.stringify({ ...cached, probed: new Date(now).toISOString(), remaining: rem ?? cached.remaining }));
      }
      if (!recovered) return json(publicView(cached, true, "credit-floor"), 200, cors);
    }

    if (!env.ODDS_API_KEY) {
      return cached ? json(publicView(cached, true, "no-key"), 200, cors)
                    : json({ error: "odds unavailable" }, 503, cors);
    }

    try {
      const fresh = await refresh(env.ODDS_API_KEY, cached, now);
      await env.ODDS_KV.put(KV_KEY, JSON.stringify(fresh));
      return json(publicView(fresh, false), 200, cors);
    } catch (err) {
      // Never echo the upstream URL (it contains the key). Log only a short reason.
      console.log("odds refresh failed:", String(err && err.message || err).slice(0, 120));
      return cached ? json(publicView(cached, true, "upstream-error"), 200, cors)
                    : json({ error: "odds unavailable" }, 503, cors);
    }
  },
};

// ---------- upstream ----------

async function refresh(key, cached, now) {
  const qs = new URLSearchParams({
    apiKey: key, bookmakers: BOOK, markets: MARKETS, oddsFormat: "american", dateFormat: "iso",
  });
  const res = await fetch(`${API}/sports/${SPORT}/odds?${qs}`);
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const events = await res.json();
  if (!Array.isArray(events)) throw new Error("unexpected upstream shape");
  const remaining = toNum(res.headers.get("x-requests-remaining"));

  const prev = new Map((cached?.games || []).map(g => [g.id, g]));
  const games = [];
  const seen = new Set();
  for (const ev of events) {
    const start = Date.parse(ev.commence_time);
    const old = prev.get(ev.id);
    seen.add(ev.id);
    if (start <= now) {
      // Kicked off: keep the pre-kickoff (closing) line we already had, never live odds.
      games.push(old ? { ...old, closed: true }
                     : { id: ev.id, commence: ev.commence_time, home: ev.home_team, away: ev.away_team, closed: true, lines: null });
    } else {
      games.push({ id: ev.id, commence: ev.commence_time, home: ev.home_team, away: ev.away_team, closed: false, ...extractLines(ev) });
    }
  }
  // Finished games drop out of the API; keep their closing lines for a while.
  for (const g of prev.values()) {
    if (!seen.has(g.id) && now - Date.parse(g.commence) < KEEP_PAST) games.push({ ...g, closed: true });
  }
  games.sort((a, b) => Date.parse(a.commence) - Date.parse(b.commence));
  return { fetched: new Date(now).toISOString(), book: BOOK, remaining, games };
}

async function probeRemaining(key) {
  // /sports does not count against the usage quota but still reports the balance.
  const res = await fetch(`${API}/sports?${new URLSearchParams({ apiKey: key })}`);
  return toNum(res.headers.get("x-requests-remaining"));
}

function extractLines(ev) {
  const bk = (ev.bookmakers || []).find(b => b.key === BOOK);
  if (!bk) return { lines: null, updated: null };
  const mk = k => (bk.markets || []).find(m => m.key === k);
  const h2h = mk("h2h"), spreads = mk("spreads"), totals = mk("totals");
  const lines = { ml: null, spread: null, total: null };
  if (h2h) {
    lines.ml = {};
    for (const o of h2h.outcomes || []) if (isNum(o.price)) lines.ml[o.name] = o.price;
    if (!Object.keys(lines.ml).length) lines.ml = null;
  }
  if (spreads) {
    lines.spread = {};
    for (const o of spreads.outcomes || []) if (isNum(o.point)) lines.spread[o.name] = { point: o.point, price: o.price ?? null };
    if (!Object.keys(lines.spread).length) lines.spread = null;
  }
  if (totals) {
    const over = (totals.outcomes || []).find(o => o.name === "Over");
    const under = (totals.outcomes || []).find(o => o.name === "Under");
    const point = over?.point ?? under?.point;
    if (isNum(point)) lines.total = { point, over: over?.price ?? null, under: under?.price ?? null };
  }
  return { lines, updated: bk.last_update || null };
}

// ---------- freshness ----------

function maxAge(cached, now) {
  const today = etDate(now);
  const starts = (cached.games || [])
    .map(g => Date.parse(g.commence))
    .filter(t => etDate(t) === today);
  if (!starts.length) return SLOW_TTL;
  const first = Math.min(...starts), last = Math.max(...starts);
  return now >= first - WINDOW_LEAD && now <= last ? FAST_TTL : SLOW_TTL;
}

const ET_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
function etDate(ms) { return ET_DATE.format(new Date(ms)); } // YYYY-MM-DD

// ---------- helpers ----------

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
