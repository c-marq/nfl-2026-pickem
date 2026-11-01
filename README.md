# NFL 2026 Pick'em Schedule 🏈

An interactive, rest-of-season NFL schedule and pick'em — **Weeks 8–18** — built as a single self-contained `index.html`, now with **live betting odds from Hard Rock Bet (Florida)** under every game. No build step, no framework, no accounts.

**▶ Live:** https://c-marq.github.io/nfl-2026-pickem/

## What it does

- **Week selector** across the top (Wk 8–18), each showing how many games you've picked.
- Each week lists its games **Thursday → Monday**, with venue, kickoff time (ET), and TV network.
- **Tap a team to pick the winner** — the winner turns green, the loser dims.
- **Team records** are shown next to each matchup.
- **Odds row** under each game: moneyline, spread, and total (O/U) from Hard Rock Bet FL, with one "odds as of … ET" stamp at the top. A line that isn't posted shows "—".
- **Per-week byes** are listed at the bottom of each week.
- The **Chicago Bears** are highlighted in team colors (navy + burnt orange) wherever they play.

## Sharing your picks

Your picks are saved into the page's URL. Hit **Copy share link** and send it — whoever opens it sees your exact picks. Nothing is stored on a server; it all lives in the link.

## How the odds refresh

```
page opens ──► Cloudflare Worker (holds the API key) ──► The Odds API
                  │  cached copy fresh enough? → return it (0 credits)
                  └─ too old? → fetch Hard Rock Bet FL (3 credits), save, return
```

- The page can't hold an API key (anyone could read it), so a tiny **Cloudflare Worker** (`worker/`, free plan) calls [The Odds API](https://the-odds-api.com) and keeps **one shared copy** in Workers KV. Every visitor gets that copy; nobody's visit triggers a call unless the copy is too old.
- **Fresh enough means:** under **60 minutes** during the game-day window (from 4 hours before the day's first kickoff to its last kickoff, Eastern time) and under **12 hours** otherwise.
- **After kickoff:** a game keeps its last pre-game line, labeled **Closing**. Live in-game odds are never shown. A game that kicked off before we ever saw a line shows **Kicked off** and "—".
- **Credit floor:** if the API balance drops below **100**, the Worker stops calling and serves the last saved odds (the page notes "refresh paused"). It re-checks the balance on a free endpoint every 6 hours, so it resumes on its own after the monthly reset.
- The page also re-checks for odds when you come back to the tab after 10+ minutes.

### Credit math (free plan: 500 credits/month, 3 credits per call)

| Day type | Calls per day (most) | Credits |
|---|---|---|
| Sunday: window ≈ 9 AM–8:20 PM ET → ≤ 12 hourly + ≤ 2 outside it | 14 | 42 |
| Thu / Mon / Sat game days: ≤ 5 visits → ≤ 5 calls | 5 | 15 |
| Non-game days: 12 h limit | 2 | 6 |

- **Worst case** (5-Sunday month, 9 other game days, 16 quiet days): 5×42 + 9×15 + 16×6 = **441**. The credit floor caps real use at **400**.
- **Expected** for ~5 friends (hourly on Sundays, about once a day otherwise): ~**300/month**.

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

- Team records are a snapshot **as of Week 8 (Nov 1, 2026)**.
- International games show their real host city — e.g. Bengals–Falcons in Madrid (Wk 9), Patriots–Lions in Munich (Wk 10), Vikings–49ers in Mexico City (Wk 11).
- Week 18 kickoff times read "TBD" because the NFL sets them after Week 17.

## Responsible gambling

Odds are shown **for information only**. They may be delayed and may not match the book's current lines. This site isn't a betting service and isn't affiliated with Hard Rock Bet, any sportsbook, or the NFL. **21+**; check your local laws. Gambling problem? Call **1-800-GAMBLER** (1-800-522-4700).

## Updating

The page is one file. Replace `index.html` and push to `main`, and the live link refreshes automatically. The Worker deploys separately: `cd worker && npx wrangler deploy`.

---
<sub>Schedule and records sourced from public NFL data. Odds via The Odds API. Not affiliated with the NFL or any sportsbook.</sub>
