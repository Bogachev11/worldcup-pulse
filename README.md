# World Cup Pulse

A real-time generative **data-art** web app that turns **live FIFA World Cup 2026**
match data into a full-screen abstract visualization — a two-team territorial
flow field whose membrane surges and retreats with the real momentum of the game.

**Every visual signal is derived from real data.** Randomness is used only for
particle texture/jitter — never to fabricate match events, scores, or momentum.

---

## Run

```bash
cd D:\Sync\projects\20260620_worldcup_pulse
npm start            # node server/index.js  → http://localhost:5280
```

No build step, no dependencies (Node 18+ built-in `fetch` + `http` only).

Open <http://localhost:5280>. If a match is live it shows **LIVE**; otherwise it
auto-plays the most recent completed match in **REPLAY** mode so the demo always
has motion.

### Env knobs
| Var | Default | Meaning |
|---|---|---|
| `PORT` | 5280 (from `.claude/launch.json`) | HTTP port |
| `POLL_MS` | 15000 | ESPN summary poll interval |
| `REPLAY` | unset | `1` forces replay for any match |
| `REPLAY_SPEED` | 60 | replay time multiplier (60x real time) |
| `REPLAY_MATCH` | 760415 | match replayed when nothing is live |

---

## Data source (ESPN hidden API — free, no auth)

- Scoreboard: `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard`
- Match summary: `.../summary?event={id}` — provides `commentary[]` (rich,
  ~100 plays with type/team/clock), `keyEvents[]`, `boxscore.teams[].statistics`,
  and team colors from `header.competitions[0].competitors[]`.

The backend normalizes all of this into a compact **STATE** object.

---

## Momentum formula (the core real-data signal)

Built in `server/momentum.js`. Each timeline event (from `commentary[].play`,
falling back to `keyEvents[]`) gets a signed **thrust** toward the team that
performed it, weighted by danger:

| Event | Thrust |
|---|---|
| Goal / Goal - Header | +10 toward scoring team |
| Shot On Target / Hit Woodwork | +5 |
| Shot Blocked / Off Target | +3 |
| Corner Awarded | +2 |
| Offside (attacking) | +1 |
| Foul | +1 toward the fouled (non-acting) team |
| Yellow Card | −0.5 to the carded team |
| Red Card | −2 to the carded team |

Sign convention: **+ = home pressing, − = away pressing**.

The instantaneous momentum is an **exponentially time-decayed running sum** of
all thrusts up to match-time *t*, with a **half-life of 4 minutes**:

```
momentum(t) = tanh( Σ thrust_i · e^(−λ·(t − t_i))  / 8 )      for all t_i ≤ t
λ = ln(2) / 240s
```

`tanh(.../8)` squashes the sum to roughly **[−1, 1]**. A momentum series is
sampled every 30 s so the frontend can draw the curve and lerp between updates.

Because momentum is computed at an arbitrary *t*, **REPLAY** works by advancing a
virtual clock (60× real time) and recomputing momentum/score/stats at that *t* —
so a finished real match plays back as if live, purely from real data.

---

## STATE object (served by `/api/state` and pushed over `/api/stream`)

```
matchId, mode('live'|'replay'|'pre'|'post'),
clock{seconds, display}, state,
home/away{abbrev, displayName, colorHex, score},
momentum,                       // current, normalized [-1,1]
momentumSeries[{t,value}],      // curve
activity,                       // 0..1 recent event density (drives speed)
box{possession,shots,shotsOnTarget,corners,yellowCards,redCards,fouls},
recentPulses[{id,t,type,team,text}]   // last ~8, each id fires a bloom once
```

## Endpoints
- `GET /api/matches` → `{matches[], defaultMatch}` (cache 30 s)
- `GET /api/state?event={id}` → normalized STATE
- `GET /api/stream?event={id}` → Server-Sent Events, a STATE per tick
- `GET /api/monument` → the harvested tournament index from `data/monument.json`
  (cache 60 s; 404 with a hint if not yet harvested)
- `GET /api/match/:id` → the full per-match **fingerprint** record from
  `data/matches/{id}.json` (404 if absent)

---

## Harvest (offline fingerprints)

```bash
node server/harvest.js
```

Enumerates **all** FIFA World Cup 2026 events (2026-06-11 .. 2026-07-19, paged in
~10-day windows), keeps the `post` (completed) matches, fetches each summary, and
derives a normalized **fingerprint** persisted to disk:

- `data/matches/{id}.json` — one full record per completed match.
- `data/monument.json` — the single file the frontend loads to draw everything:
  `{ tournament:{name,startDate,endDate,days[]}, groups[], matches[] }`.

It is polite to ESPN: concurrency 3, short delays, exponential-backoff retry on
transient failures, and it skips non-`post` matches. **No mock data** — every
field comes from ESPN; momentum reuses `server/momentum.js` unchanged.

### Fingerprint schema (per match)

```
{
  id, day:"YYYY-MM-DD", kickoffISO,
  round:"group"|"r32"|"r16"|"qf"|"sf"|"3rd"|"final",
  group:"F"|null,
  home:{abbr,name,colorHex,score}, away:{abbr,name,colorHex,score},
  fingerprint:{
    momentumSeries:[{t,v}],   // t = match-minute (sampled every 1 min, 0..90+ incl. stoppage), v in [-1,1]
    goals:[{t,team:"home"|"away",scorer}],
    reds:[{t,team}],
    yellows:[{t,team}],
    penalties:[{t,team,scored:boolean}],
    finalMomentum,
    possessionHome, possessionAway,
    shotsHome, shotsAway, sotHome, sotAway,
    cornersHome, cornersAway
  }
}
```

`momentumSeries[].v = momentumAt(timeline, t·60)` using the unchanged momentum
formula. Goals/yellows/reds/penalties come from `summary.keyEvents` (whose
`clock.value` is in seconds → minute); event `team.displayName` is matched to the
two competitors to resolve home/away; the goal `scorer` is `participants[0]`
(falling back to parsing the keyEvent text). `round`/`group` come from the
competition `altGameNote` ("FIFA World Cup, Group F") with the header
`isThirdPlace` flag and `season.slug` as fallbacks.

### Penalty detection (method + limitations)

In-play penalties are taken from `keyEvents` whose `type.text` matches
`Penalty - Scored|Missed|Saved`, plus any `Goal*` keyEvent whose text contains
"penalty" (e.g. "converts the penalty"). `scored` is true for `Penalty - Scored`
or a penalty-mention goal. Dedupe is by `team:minute`.
**Limitations:** shootout penalties (`keyEvent.shootout`, decided after 120') are
**excluded** from `penalties[]` — only normal/extra-time spot-kicks count. ESPN
does not always emit a `Penalty - Missed/Saved` event, so missed in-play
penalties may be under-counted; the boxscore `penaltyKickShots`/`penaltyKickGoals`
stats are a cross-check but are not used to fabricate entries.

### Color resolution (with fallbacks)

Prefer the summary `header` competitor `color`, then the scoreboard team `color`,
then `alternateColor`, then canonical `#2266ff` (home) / `#ff5522` (away). If the
two chosen colors are too close (RGB distance < 80) or **both** very dark
(luminance < 0.12, poor contrast on the near-black canvas), one team is switched
to its `alternateColor` (or canonical as a last resort) so home/away stay
visually distinct. Any such substitution is logged by the harvester and recorded
in the record's `_colorFallbacks` field.

---

## Visualization (`public/app.js`, Canvas 2D)

- ~2600 particles flow along a deterministic value-noise flow field.
- The **membrane** (dividing front between the two team-color territories) is
  pushed right by positive momentum (home pressing) and left by negative.
- Particles take their territory's color and **mix/turbulate near the membrane**.
- Particle **speed scales with `activity`**; drift biased by **possession**.
- **Blooms** fire once per real pulse event: golden burst (Goal), expanding ring
  (Shot On Target), small ripple (Corner), yellow flash (Yellow), red flash (Red).
- Additive blending (`globalCompositeOperation = 'lighter'`), near-black bg.
- Minimal HUD: score, clock, LIVE/REPLAY tag, possession bar, live momentum
  curve, shot/corner line, and a match-switch dropdown.

---

## Limitations
- ESPN commentary lacks reliable event *coordinates*, so fouls use a flat thrust
  toward the fouled team rather than pitch location.
- Replay reveals goals/stats by commentary clock; ESPN boxscore stats are
  final-state snapshots, so possession/shots in replay reflect the final tallies
  rather than a perfectly time-sliced value (momentum *is* time-sliced).
- Single ESPN summary fetch per poll; no historical persistence.

## Next steps
- WebGL/three.js upgrade: GPU particle system + curl-noise fluid, bloom shaders.
- Multi-match **video wall** (grid of simultaneous pulses).
- Crowd-noise **audio channel** synthesized from momentum/activity.
- **Voronoi pitch-control** layer if/when positional data is available.
- Time-sliced boxscore via incremental commentary aggregation.
