# NFL 2026 Scores & Odds 🏈

A rest-of-season NFL schedule (**Weeks 8–18**) with **live scores** and **odds from Hard Rock Bet (Florida)** under every game, built as a single self-contained `index.html`. No build step, no framework, no accounts.

**▶ Live:** https://c-marq.github.io/nfl-2026-pickem/

## What it does

- **Week selector** across the top (Wk 8–18), each showing the week's first game date.
- Each week lists its games **Thursday → Monday**, with venue, kickoff time (ET), and TV network.
- **Sundays start collapsed**, so Thursday and Monday are visible at a glance. Tap "Show Sunday's games" to expand; the collapsed bar shows "12 games · 3 LIVE · 8 final".
- **Live scores**: games in progress show a red LIVE chip, the quarter and clock, and the score, updating every minute while the page is open.
- **Finals highlight the winner** in green with the final score; the loser dims.
- **Team logos** sit left of each name (loaded from ESPN's image CDN; a winner gets a small green check on its logo).
- **Team records and kickoff times stay current** (including flexed games). The page opens on the current NFL week.
- **Odds row** under each game: moneyline, spread, and total (O/U) from Hard Rock Bet FL, with one "odds as of … ET" stamp at the top. A line that isn't posted shows "—".
- **Per-week byes** are listed at the bottom of each week.
- The **Chicago Bears** are highlighted in team colors (navy + burnt orange) wherever they play.

## Where scores and records come from

The page reads **ESPN's public scoreboard feed** (`site.api.espn.com/.../nfl/scoreboard`) straight from the browser. It needs no key, uses no Odds API credits, and doesn't go through the Worker. The page fetches the current week plus last week (for teams on bye), and the week you're viewing. While a game is live or about to start, it re-checks every 60 seconds; otherwise every 10 minutes, and only while the tab is visible.

This feed is **unofficial and undocumented**, so ESPN could change it without notice. If it fails, the page falls back gracefully: no scores, records from the Week 8 snapshot, and the schedule and odds work as before.

## How the odds refresh

```
page opens ──► Cloudflare Worker (holds the API key) ──► The Odds API
                  │  cached copy fresh enough? → return it (0 credits)
                  └─ too old? → fetch Hard Rock Bet FL (3 credits), save, return
```

- The page can't hold an API key (anyone could read it), so a tiny **Cloudflare Worker** (`worker/`, free plan) calls [The Odds API](https://the-odds-api.com) and keeps **one shared copy** in Workers KV. Every visitor gets that copy; nobody's visit triggers a call unless the copy is too old.
- **Fresh enough means:** under **90 minutes** during the game-day window (from 2 hours before the day's first kickoff to its last kickoff, Eastern time) and under **12 hours** otherwise. The 2-hour lead catches Sunday-morning inactives news (~11:30 AM ET).
- **After kickoff:** a game keeps its last pre-game line. Live in-game odds are never shown. The line is labeled **Closing** only if it was captured within an hour of kickoff; otherwise it says **Last line** with the time it was captured (e.g. "Last line · Sun 9:05 AM"), because the Worker only refreshes when someone visits. A game that kicked off before we ever saw a line shows **Kicked off** and "—".
- **Credit floor:** if a call would take the API balance below **100**, the Worker stops calling and serves the last saved odds (the page notes "refresh paused"). It re-checks the balance on a free endpoint every 6 hours, so it resumes on its own after the monthly reset. If the API ever stops reporting the balance, the Worker counts its own spend (3 per call) and, if the balance stays unconfirmed for a week, allows one refresh so a reset it couldn't see doesn't freeze the feed.
- **Waste guards:** one refresh at a time (simultaneous visitors share it), a 5-minute back-off after an Odds API error, and a failed cache save never throws away odds that were already paid for.
- **If a refresh fails**, the page keeps showing the last odds with their "as of" time and notes "couldn't refresh just now".
- While the page is open it asks the Worker for odds again every 15 minutes at most (the Worker's cache decides whether that costs anything).

### Credit math (free plan: 500 credits/month, 3 credits per call)

Simulated by running the real Worker code against the real Weeks 8–18 schedule (fake clock, fake API, zero real credits), with the **worst-case traffic of a request every 5 minutes, around the clock**:

| Day type | Calls per day | Credits per day |
|---|---|---|
| Sunday (9:30 AM international games → Sunday night) | 8–9 | 24–27 |
| Thursday / Monday | 3 | 9 |
| Thanksgiving / Christmas (3 games) | 8 | 24 |
| Saturday (late season) | 5 | 15 |
| No games | 2 | 6 |
| **November total** | | **324** |
| **December total** | | **312** |

- The 100-credit floor is never reached at these settings. If something unexpected burns credits, the floor stops the Worker before the balance goes under 100, so use can't pass **400/month**.
- The earlier setting (4-hour lead, 60 minutes) simulated to ~500/month uncapped and would have hit the floor at noon on Thanksgiving, leaving odds stale for 4½ days.
- Real use by 1–3 people is far below the worst case. Credits follow the clock, not the number of visitors: one open tab and a hundred open tabs cost the same.

Where the key lives: Cloudflare Worker secret **`ODDS_API_KEY`**. It's never in this repo or the page.

## Local testing (no API credits)

```bash
python3 -m http.server 8000          # the page
node scripts/dev-odds.mjs            # mock Worker on :8787 with made-up odds
#   --fail           pretend the odds service is down
#   --remaining=40   pretend we're under the credit floor
```

Open http://localhost:8000. On localhost the page reads odds from the mock Worker automatically.

## Notes on the data

- Team records come live from ESPN. The built-in fallback is a snapshot **as of Week 8 (Nov 1, 2026)**.
- Weeks 8–18 were cross-checked against ESPN on Nov 1, 2026. Byes, dates, and game counts all match. Week 16–17 games without a set kickoff show "Time TBD".
- International games show their real host city — e.g. Bengals–Falcons in Madrid (Wk 9), Patriots–Lions in Munich (Wk 10), Vikings–49ers in Mexico City (Wk 11).
- Week 18 kickoff times read "TBD" because the NFL sets them after Week 17.

## Responsible gambling

Odds are shown **for information only**. They may be delayed and may not match the book's current lines. This site isn't a betting service and isn't affiliated with Hard Rock Bet, any sportsbook, or the NFL. **21+**; check your local laws. Gambling problem? Call **1-800-GAMBLER** (1-800-522-4700).

## Updating

The page is one file. Replace `index.html` and push to `main`, and the live link refreshes automatically. The Worker deploys separately: `cd worker && npx wrangler deploy`.

### First launch (one time, in this order)

Two placeholders need real values from the Cloudflare account. Don't push the page until both are filled, or the live site will show "Odds unavailable".

1. Create a free Cloudflare account and log in from this folder: `npx wrangler login`.
2. Create the cache: `cd worker && npx wrangler kv namespace create ODDS_KV`, then paste the printed `id` into `worker/wrangler.toml` in place of `REPLACE_WITH_KV_NAMESPACE_ID`. The id isn't secret.
3. Set the key as a Worker secret, typed at the prompt and never pasted into a file or chat: `npx wrangler secret put ODDS_API_KEY`.
4. Deploy the Worker: `npx wrangler deploy`. Note the `https://<name>.<subdomain>.workers.dev` address it prints.
5. In `index.html`, replace `https://REPLACE-AT-DEPLOY.workers.dev/odds` (the `ODDS_URL` line) with that address plus `/odds`.
6. Open `<worker address>/odds` once in a browser to confirm it returns odds JSON, then push `index.html` to `main`.

---
<sub>Schedule and records sourced from public NFL data. Odds via The Odds API. Not affiliated with the NFL or any sportsbook.</sub>
