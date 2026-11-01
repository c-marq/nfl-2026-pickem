// Local test harness for the odds Worker — ZERO API credits.
//
// Runs the real worker/odds-worker.mjs in Node on http://localhost:8787 with:
//   * an in-memory KV store, and
//   * a fake The Odds API that returns MADE-UP odds for the games in index.html.
// Nothing here talks to the internet.
//
//   node scripts/dev-odds.mjs                 normal: odds for Wk 8-10, some games with no line
//   node scripts/dev-odds.mjs --fail          upstream errors (page should show "—" + unavailable)
//   node scripts/dev-odds.mjs --remaining=40  under the credit floor (serves cached, flagged stale)
//
// Then in another terminal:  python3 -m http.server 8000   and open http://localhost:8000

import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../worker/odds-worker.mjs";

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? true];
}));
const PORT = Number(args.port || 8787);
let balance = Number(args.remaining ?? 497);
const FAIL = !!args.fail;

// ---- schedule from index.html ----
const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
const D = JSON.parse(html.match(/const D=(\{.*?\});const T=/s)[1]);

function etToIso(date, time) {
  const m = /(\d+):(\d+)\s*(AM|PM)/i.exec(time) || [0, "1", "00", "PM"];
  let h = Number(m[1]) % 12 + (m[3].toUpperCase() === "PM" ? 12 : 0);
  const [y, mo, d] = date.split("-").map(Number);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23", day: "numeric" });
  for (const off of [4, 5]) {
    const t = Date.UTC(y, mo - 1, d, h + off, Number(m[2]));
    const parts = Object.fromEntries(fmt.formatToParts(new Date(t)).map(p => [p.type, p.value]));
    if (Number(parts.hour) === h && Number(parts.day) === d) return new Date(t).toISOString();
  }
  throw new Error("bad ET time " + date + " " + time);
}

// deterministic pseudo-random per game
function rnd(seed) { let x = 0; for (const c of seed) x = (x * 31 + c.charCodeAt(0)) >>> 0; return () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32); }

function mockEvents() {
  const evs = [];
  for (const g of D.games.filter(g => g.wk >= 8 && g.wk <= 10)) {
    const r = rnd(g.id);
    const ev = { id: "mock-" + g.id, sport_key: "americanfootball_nfl", sport_title: "NFL",
      commence_time: etToIso(g.date, g.time), home_team: g.hn, away_team: g.an, bookmakers: [] };
    const roll = r();
    if (roll < 0.12) { evs.push(ev); continue; }                 // no line posted at all
    const spread = Math.round((r() * 14 - 7) * 2) / 2 || 1.5;     // home spread
    const total = Math.round((38 + r() * 13) * 2) / 2;
    const fav = spread < 0 ? -1 : 1, size = Math.abs(spread);
    const favML = -Math.round(110 + size * 28), dogML = Math.round(size * 24 + 95);
    const homeML = fav < 0 ? favML : dogML, awayML = fav < 0 ? dogML : favML;
    const ts = new Date().toISOString();
    const markets = [
      { key: "h2h", last_update: ts, outcomes: [{ name: g.hn, price: homeML }, { name: g.an, price: awayML }] },
      { key: "spreads", last_update: ts, outcomes: [{ name: g.hn, price: -110, point: spread }, { name: g.an, price: -110, point: -spread }] },
      { key: "totals", last_update: ts, outcomes: [{ name: "Over", price: -110, point: total }, { name: "Under", price: -110, point: total }] },
    ];
    // one in ~8 games: moneyline only (spread + total not posted)
    ev.bookmakers.push({ key: "hardrockbet_fl", title: "Hard Rock Bet (FL)", last_update: ts,
      markets: roll < 0.24 ? markets.slice(0, 1) : markets });
    evs.push(ev);
  }
  // The real API drops finished games and includes in-progress ones; approximate that.
  const now = Date.now();
  return evs.filter(e => now - Date.parse(e.commence_time) < 4 * 3600e3);
}

// ---- fake upstream ----
const realFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.hostname !== "api.the-odds-api.com") return realFetch(input, init);
  if (FAIL) return new Response("mock upstream failure", { status: 500 });
  if (u.pathname.endsWith("/sports")) {
    return new Response("[]", { headers: { "x-requests-remaining": String(balance) } });
  }
  calls++; balance -= 3;
  console.log(`  [mock API] /odds call #${calls} — 3 credits, mock balance now ${balance}`);
  return new Response(JSON.stringify(mockEvents()), {
    headers: { "content-type": "application/json", "x-requests-remaining": String(balance), "x-requests-used": String(500 - balance), "x-requests-last": "3" },
  });
};

// ---- in-memory KV ----
const store = new Map();
const kv = {
  async get(k, type) { const v = store.get(k); return v == null ? null : type === "json" ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); },
};
const env = { ODDS_KV: kv, ODDS_API_KEY: "example-not-a-real-key", CREDIT_FLOOR: "100",
  ALLOWED_ORIGINS: "http://localhost:8000,http://127.0.0.1:8000" };

// Seed: pretend we fetched 3 days ago so already-played games have "closing" lines.
if (!FAIL) {
  const realNow = Date.now;
  Date.now = () => realNow() - 3 * 24 * 3600e3;
  await worker.fetch(new Request("http://localhost/odds"), env);
  Date.now = realNow;
}

http.createServer(async (req, res) => {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const r = await worker.fetch(new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers }), env);
  const body = Buffer.from(await r.arrayBuffer());
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(body);
  console.log(`${new Date().toLocaleTimeString()}  ${req.method} ${req.url} -> ${r.status}`);
}).listen(PORT, () => {
  console.log(`Mock odds Worker on http://localhost:${PORT}/odds  (fail=${FAIL}, mock balance=${balance}) — no real API calls.`);
});
