# World Cup Pulse — Project Log & Operations Handbook

> Living record of **what the project is**, **how it was built** (the story + the hard problems
> solved), and **how to operate it** (deploy, automation, video, gotchas). Written so the project
> can be picked up cold after a context reload, and so the "making‑of" story is preserved.
> Author: **Alexander Bogachev** · X `@bogachev_al` · LinkedIn `in/bogachev-aleksandr` · site
> `wc26.bogachev.fr`. Repo: **github.com/Bogachev11/worldcup-pulse**.

---

## 1. What it is (the concept)

**World Cup Pulse** turns each 2026 World Cup match into a single **living data‑portrait** — one
scene that plays the whole match through in ~15s of "dramatic time". It's built to be instantly
readable by a **broad football audience** (not analysts) and beautiful enough to get on the radar
of top design studios — "functional art" in Alberto Cairo's sense: **meaning = the real, honest
match structure; art = the execution.** Evaluated by Kulinkovich's 3K lens: **contrast**
(unlike existing football viz), **context** (data‑viz canon + football tradition), **content**
(craft). Rule: every signal must be self‑evidently football to a layperson; clean, not monstrous.

**How to read one match (the visual language, all from REAL data):**
- **Two cloth "blankets"** — one per team, in national colour — lie over the pitch and meet at a
  moving **front**. The front is the **possession / territory tide**: who is camped in whose half,
  minute by minute. Driven by FotMob per‑minute **momentum** (`valueNorm`, +home/−away) plus an
  attack‑reach reconciliation so the front reflects where a team actually got.
- **Relief / hills** rise where **shots** happen — height ∝ **xG** (the danger). The only tall
  feature; away from shots the cloth is a low rolling swell.
- A **goal floods** the whole pitch in the scorer's colour (a directional roll onto the conceded
  end), then eases back; the **sky** leans to the leading team's hue (score‑tint).
- **Corners & penalties** are neutral‑white "threat" waves (not team‑coloured — a set piece is a
  moment, not owned territory). A **penalty**: neutral wave from the spot → scored floods, missed
  doesn't.
- Bottom **pulse** = a momentum **seismograph** (home pressure up / away down, split at a midline),
  drawn only up to the playhead.
- **Post‑match penalty shootout** is a *directed* end sequence (see §4).
- HUD: flags + 3‑letter abbrs, big score under each team, per‑team event rows (goals / red cards /
  shootout rings ○=scored ●=missed), a top‑right football clock, a credits footer.

---

## 2. Evolution / stages

The engine grew through numbered "stages" (each a full html+js pair in `public/`):
- **stage10** — the "constructor" base (layers A/B/C/D, tunable panel).
- **stage11** — score‑tinted sky, goal wave onto the торец, bottom pulse strip, centered 1000px
  column, flags.
- **stage12** — front **reconciliation** (attack‑reach), neutral set‑piece waves, penalties,
  cards→panel, sky = goals only, event‑lag.
- **stage13 — the FINALIZED public piece.** Cloned from stage12, then the whole **chrome/HUD** was
  redesigned to the "vB2" direction (see §3). This is what ships. Everything below refers to
  stage13 unless noted.

Design exploration: 4 subagent variants (A Editorial / B Swiss‑technical / C Bold sport / D Gallery)
→ **B chosen** → refined to `public/design/vB2.html` (the visual target) → integrated as stage13.

---

## 3. The finalized HUD (stage13 chrome)

Design language: **Space Grotesk** (labels/UI) + **Space Mono** (numerics) via Google Fonts;
deep plum‑navy/near‑black; gallery‑grade, restrained. Key pieces:
- Teams top‑left: flag + 3‑letter abbr + **thick country‑colour rail** + very large mono score.
- Per‑team **event rows** under the score (no word labels — marker shape carries meaning):
  goal = team‑colour disc + minute; red card = red card rect + minute; **penalty shootout** = a
  row of rings (**scored = hollow ○, missed = filled ●** — per the brief).
- Top‑right **clock**: football minute, apostrophe as a superscript hanging past the right edge;
  a period sub‑label ("2ND HALF" / "EXTRA TIME" / "FULL TIME").
- Bottom **transport**: a circular **play** button merged into the transparent **pulse** (no
  plate). Play/pause lives here; the pulse is click/drag‑scrubbable.
- **Footer** (text, video‑safe): `Alexander Bogachev, Data Visualization Lead • 𝕏 bogachev_al •
  in/bogachev-aleksandr` / `wc26.bogachev.fr • Data: FotMob · WhoScored (Opta)`.
- **Dev chrome gated behind `?dev=1`**: the left constructor `#panel` (incl. a **full match
  selector** of all matches, speed + shootout‑timing sliders, restart), the camera panel, the
  match tabs. Public sees only the clean auto‑playing piece.

---

## 4. Penalty‑shootout choreography (post‑match)

After the match settles, if it went to penalties the shootout is **directed** (not shown at once),
driven by a dedicated wall clock (`shootWall`; the match clock is frozen at full time):
1. a pause, then each kick in turn (adjustable **pause0 / gap** via panel sliders);
2. a neutral wave from the spot toward the goal — **teams kick at OPPOSITE goals**;
3. **scored → the whole field floods** the kicker's colour (via the goal‑wave front override);
   **missed → no flood + a small recoil** in the wave;
4. the base field during the shootout is a **clean 50/50 colour split** (not the jagged
   end‑of‑match territory); result **rings reveal one at a time**;
5. the finale **holds the winner's colour**.
Data comes from `tlDoc.shootout` (`[{team, scored}]`), extracted in `build_timeline.js` from the
"PenaltyShootout" period; shootout kicks are **excluded from the score and from `fullT`**. Dev hook
`__shoot(wallSeconds)` jumps into the sequence.

---

## 5. Hard problems solved (the story)

| Problem | Cause | Fix |
|---|---|---|
| Territory "stuck in centre", didn't swing with the match | thrust fingers of both teams cancelled the momentum swing | momentum **backbone** (FotMob valueNorm) + **attack‑reach** reconciliation; steepened momFront; lowered TAUs |
| Score / sky changed a beat **before** the cloth flood | HUD fired at goal‑instant, flood rolls ~0.9s | **event‑lag**: score/sky/markers trail the flood by `EVENT_LAG_S≈0.7s` (in wall‑seconds) |
| Corners/penalties looked like team territory | crest tinted toward the attacking colour | **neutral** `SETPIECE_COL` (pitch‑line white) — only a goal floods a colour |
| Black holes tearing the blanket at the seam | a tall xG spire on the possession seam + tiny `lap` (0.005) can't bridge it | damp the crest **hard at the seam** (`crestNotch` floor 0.6→0.22) |
| A "monster" spike (looked like super‑xG) | **two overlapping low‑xG shots** stacked and hit the height ceiling 8 | lower the ceiling to **4.5**; the pulse now shows the shots at their true (small) xG |
| Clock showed inflated minutes in ET (137') | engine clock is **expanded** minutes (cumulative stoppage) | display the **football minute** (`footballMinuteAt` maps expanded→football via the events; 2nd half tops at 90/96, **ET restarts 90→120**) |
| Pulse "finished" while the match still ran | playhead used the expanded clock vs momentum‑minute axis | playhead synced to `footballMinuteAt`; pulse draws **only up to the playhead** (no future preview — preserves intrigue) |
| Sky invisible when a **dark** team (Germany #464646) led | grey tint on near‑black = black‑on‑black | **chroma‑gated** sky glow — a grey/low‑chroma leader keeps the background **black**; only a clearly‑coloured leader glows |
| Phantom duplicate goals (e.g. GER‑PAR read 3‑1 not 1‑1) | the rich‑fallback `|| best.isGoal` marked non‑goal **rebound shots** near a real goal | dedup: each rich goal maps to **one** event (prefer a WhoScored‑typed 'Goal') |
| Gallery mislabelled R16/R32 as "Final/Semi" | date‑rank guessing; rich has only generic `round:"knockout"` | recover the **true stage** from FotMob `general.leagueRoundName` (`1/16`→Round of 32, `1/8`→R16, `1/4`→QF, `1/2`→SF, `Final`) via team‑pair join in `build_matches_index.js` |
| Group letters (A–L) for the gallery | **not present** in FotMob data (only matchday number) | left grouped **by matchday**; true letters would need the official draw (TODO) |
| Deploy broke: EBUSY on `dist/`, corrupted git ref | Mail.ru Cloud **syncs & locks** the `.git`/`dist` inside `D:/Sync` | build `dist` into an **OS‑temp dir** (`DIST_DIR`); deploy from an **isolated temp git**; cleared the conflicted‑copy ref |

---

## 6. Data pipeline

Sources: **FotMob** (per‑minute momentum + shots/xG + colours + true round) and **WhoScored/Opta**
(event geometry: positions, passes, corners, cards, shootout). Python = **`D:/Python/python.exe`**
(3.12 + Playwright + **system Chrome**; NOT system 3.14).

- `server/harvest_rich.py` — bulk FotMob‑enumerated group‑stage harvest.
- `server/harvest_one.py --url <whoscored_url> [--round knockout]` — one match; auto‑joins FotMob;
  **falls back to FotMob‑only** (`data/rich/fm_<fid>.json`) when WhoScored can't be resolved.
- `server/harvest_discover.py` — **auto‑discovery** (the nightly brain): FotMob lists ALL WC
  matches by date; for a rolling window it harvests every *finished* match not on disk (idempotent
  by team‑pair), resolving WhoScored from an anchor pool (season page + 12 group pages) by team‑pair
  slug, else FotMob‑fallback. Keeps working for QF/SF/Final with zero human input.
- `server/build_timeline.js` — raws → `data/timeline/{id}.json` (master event stream; joins xG;
  **extracts the penalty shootout**; excludes it from `fullT`; **dedups phantom goals**).
- `server/build_matches_index.js` — rich → `data/matches.json` (+ `public/matches.json`); **joins
  FotMob raw for the true `stage` + `stageRank`**; group letter absent → `group:null`.

Data lives in `data/rich/`, `data/timeline/`, `data/raw/{whoscored,fotmob}/`. FotMob‑only matches
have `fm_` id prefix (momentum + shots, no WhoScored geometry — still render via momentum).

---

## 7. Serving & the app

- **Dynamic dev server**: `server/index.js` on **port 5280**. Serves `public/` + dynamic
  `/api/rich/{id}`, `/api/timeline/{id}`, `/matches.json`. stage13 fetches `/api/timeline/{id}` then
  `/api/rich/{id}`; the gallery fetches `/matches.json`. three.js + fonts are **CDN** (esm.sh /
  Google Fonts).
- **Persistent server**: `server/serve_forever.ps1` (a detached PowerShell supervisor that
  health‑checks :5280 and restarts it) + a Startup‑folder shortcut. **⚠ NEVER bind/kill port 5280.**
  Sub‑tasks verify on a throwaway port (e.g. 5399) instead.
- **Local viewing**: gallery `http://localhost:5280/index.html`; a match `.../stage13.html?id=<id>`;
  **dev** (panels + full match selector) `.../stage13.html?dev=1`. Local = the `dev` branch state.

---

## 8. Deploy (GitHub Pages → wc26.bogachev.fr)

- Repo **github.com/Bogachev11/worldcup-pulse** (public). Branches: **main** (prod source, default),
  **dev** (working — local is on `dev`), **gh-pages** (the deployed static site).
- `server/build_static.js` — assembles `dist/` (only the launch files: index/about/stage13.*,
  claybattle.js, style.css, matches.json, og‑cover.png) + materialises **`/api/rich/{id}` and
  `/api/timeline/{id}` as extensionless JSON files** (GH Pages serves static; `fetch().json()`
  parses regardless of content‑type) + `CNAME` (`wc26.bogachev.fr`) + `.nojekyll`. `DIST_DIR` env
  redirects the build outside the Mail.ru‑synced folder.
- `server/deploy.sh` — build_static into an OS‑temp dir → copy to a fresh temp git → commit →
  **force‑push to `gh-pages`** (auth via the `gh` credential helper; **never** a token in a file).
- GitHub Pages is **enabled** (source `gh-pages`), custom domain `wc26.bogachev.fr` auto‑detected
  from CNAME. **Remaining human step:** DNS record — `CNAME wc26 → bogachev11.github.io` in
  bogachev.fr's DNS. Then HTTPS is auto‑provisioned.
- Release cycle: work on `dev` → merge to `main` → `sh server/deploy.sh`.

**Deploy quirks (Mail.ru `D:/Sync` hazard):** the project `.git` drifts (conflicted‑copy refs);
**remote = source of truth**. Never embed a GitHub token in `.git/config` or any committed file
(a `-u` push once leaked one into the tracking URL → scrubbed; upstream is `origin` = clean URL).

---

## 9. Nightly automation

- `server/nightly.sh` — harvest (auto‑discovery) → `build_timeline.js` + `build_matches_index.js`
  → commit/push `dev` (gh helper) → `deploy.sh` (redeploy gh‑pages) → `server/nightly.log`.
  Fail‑soft per stage; never touches 5280.
- **Windows Task Scheduler** task **"WorldCupPulse Nightly"** — daily **04:30**, State Ready
  (registered without admin via `server/nightly_task.cmd`; re‑register with
  `server/schedule_nightly.cmd`). So new matches (incl. tonight's) appear on the site by morning
  with zero manual work.

---

## 10. Video / OG image (social)

- **OG cover** `public/og-cover.png` (1200×630) — rendered headlessly via **Playwright + system
  Chrome** (`p.chromium.launch(channel="chrome")`, viewport 1200×630, `device_scale_factor 2`),
  load stage13 (public), `__setClock(52)`, screenshot. Referenced by the OG/Twitter‑Card meta on
  stage13/index/about.
- **Video for posts** (planned): same Playwright + system Chrome approach, auto‑play (no Play
  button), capture ~40s → MP4/GIF via ffmpeg (deterministic frame sweep — the project has a capture
  pipeline for this). Dev chrome hidden (public view). Auto‑posting: X API feasible; LinkedIn manual.
- **Thumbnails** (`stage-thumb`, in progress): small 3D‑isometric **transparent** "essence" render
  per match — colour‑split = time‑averaged possession, relief = cumulative xG — batch‑rendered to
  `public/thumbs/{id}.png` for the gallery cards.

---

## 11. Dev hooks & gotchas

- Dev hooks (console): `__setClock(min)` (snap), `__step(min,dt)` (live‑glide), `__frontStats()`,
  `__shoot(wallSec)` (jump into the shootout). `cfg`/`momentum` etc. are module‑scoped (not
  eval‑accessible).
- `?dev=1` reveals the constructor + camera panels + match selector. Public hides them.
- **Real data only** — no mock/decorative/procedural noise, ever (absolute rule).
- Chat: reply **Russian**, concise; long detail goes in deliverables like this file.
- Ports: 5280 is sacred (supervised). Python: `D:/Python`. Node on PATH. Fonts/three.js: CDN.

---

## 12. Status & TODO (as of 2026‑07‑05)

**Done:** stage13 finalized; 90 matches harvested; true KO stages; gallery + About; dev‑gate + OG +
mobile; GitHub Pages deployed (needs DNS); nightly automation scheduled; match selector; deploy +
static‑export scripts.

**Pending / next:**
- **DNS** `CNAME wc26 → bogachev11.github.io` (user) → site goes live.
- **Brazil–Norway** (launch match, 5 Jul) — auto‑harvested by tonight's 04:30 run once FotMob
  finalizes it (else trigger `server/nightly.sh` manually in the morning).
- **Thumbnails** (`stage-thumb`) — finish + refine the "essence" look, batch‑render, wire gallery.
- **Video** export pipeline for social clips.
- **Group letters** A–L (needs the official draw) — currently grouped by matchday.
- Launch posts: **X** = all matches (link + OG/gif); **LinkedIn** = best matches + highlights +
  this making‑of story.
