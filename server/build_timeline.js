// build_timeline.js — extract a REAL per-second event timeline from the full
// WhoScored Opta feed (data/raw/whoscored/{id}.json) for the stage9 engine.
//
// Output: data/timeline/{id}.json — one master-clock-sorted event stream with
// real seconds, joined with xG from the rich record for shot-type events.
//
// Run: `node server/build_timeline.js`  (loops every raw file; FRA-SEN = 1953888)

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RAW_DIR = path.join(ROOT, 'data', 'raw', 'whoscored');
const RICH_DIR = path.join(ROOT, 'data', 'rich');
const OUT_DIR = path.join(ROOT, 'data', 'timeline');

// Per-abbr colour overrides (match the engine's TEAM_COL).
const COLOR_OVERRIDE = { FRA: '#387ef0', SEN: '#0c954e' };

// pull a qualifier value (string) by displayName, or null
function qval(quals, name) {
  if (!Array.isArray(quals)) return null;
  for (const q of quals) {
    if (q && q.type && q.type.displayName === name) {
      return q.value !== undefined ? q.value : true;
    }
  }
  return null;
}
function qhas(quals, name) {
  if (!Array.isArray(quals)) return false;
  for (const q of quals) if (q && q.type && q.type.displayName === name) return true;
  return false;
}
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// SHOT-type events that should receive an xG join.
const SHOT_TYPES = new Set(['SavedShot', 'MissedShots', 'ShotOnPost', 'Goal']);

function buildOne(raw, rich) {
  const homeId = raw.home && raw.home.teamId;
  const awayId = raw.away && raw.away.teamId;

  // rich home/away carry abbr + colour
  const richHome = (rich && rich.home) || {};
  const richAway = (rich && rich.away) || {};
  const homeAbbr = richHome.abbr || (raw.home && raw.home.name ? raw.home.name.slice(0, 3).toUpperCase() : 'HOM');
  const awayAbbr = richAway.abbr || (raw.away && raw.away.name ? raw.away.name.slice(0, 3).toUpperCase() : 'AWA');
  const homeColor = COLOR_OVERRIDE[homeAbbr] || richHome.colorHex || '#387ef0';
  const awayColor = COLOR_OVERRIDE[awayAbbr] || richAway.colorHex || '#d33';

  const richShots = (rich && Array.isArray(rich.shots)) ? rich.shots : [];

  const events = [];
  for (const e of (raw.events || [])) {
    if (!e || !e.type) continue;
    const team = e.teamId === homeId ? 'home' : (e.teamId === awayId ? 'away' : null);
    if (!team) continue; // skip stray events with no team
    const second = Number(e.second) || 0;
    const expMin = Number(e.expandedMinute) || 0;
    const t = expMin + second / 60;          // master clock, minutes
    const type = e.type.displayName;
    const outcome = (e.outcomeType && e.outcomeType.displayName) || '';
    const x = num(e.x);
    const y = num(e.y);
    const q = e.qualifiers;

    const endX = num(qval(q, 'PassEndX'));
    const endY = num(qval(q, 'PassEndY'));
    const len = num(qval(q, 'Length'));
    const long = qhas(q, 'Longball');
    const cross = qhas(q, 'Cross');
    const through = qhas(q, 'Throughball') || qhas(q, 'ThroughBall');
    const corner = type === 'CornerAwarded' || qhas(q, 'Corner') || qhas(q, 'CornerTaken');
    // POST-MATCH PENALTY SHOOTOUT — events in the "PenaltyShootout" period. Tagged so the
    // app can (a) EXCLUDE them from the regular score/goal markers and (b) render the
    // shootout result block. The actual kicks are the shot-type events (Goal = scored,
    // SavedShot/MissedShots/ShotOnPost = missed); the mirrored PenaltyFaced/Save are dropped.
    const periodName = (e.period && (e.period.displayName || e.period.value)) || e.period || '';
    const isShootout = /shootout/i.test(String(periodName));

    const ev = {
      t, minute: Number(e.minute) || 0, second, team,
      type, outcome,
      x, y, endX, endY, len, long, cross, through, corner,
      isTouch: !!e.isTouch,
      _id: e.id,
    };

    // xG join for shot-type events: nearest same-team rich shot by minute (±1)
    if (SHOT_TYPES.has(type)) {
      let best = null, bestD = Infinity, bestIdx = -1;
      for (let si = 0; si < richShots.length; si++) {
        const s = richShots[si];
        if (s.team !== team) continue;
        const d = Math.abs((Number(s.minute) || 0) - ev.minute);
        if (d <= 1 && d < bestD) { bestD = d; best = s; bestIdx = si; }
      }
      ev.xg = best && Number.isFinite(best.xg) ? best.xg : null;
      ev.xgot = best && Number.isFinite(best.xgot) ? best.xgot : null;
      ev.onGoalX = best && Number.isFinite(best.onGoalX) ? best.onGoalX : null;
      ev.onGoalY = best && Number.isFinite(best.onGoalY) ? best.onGoalY : null;
      ev.situation = best ? (best.situation || null) : null;
      ev.isGoal = type === 'Goal' || (best ? !!best.isGoal : false);
      // remember which rich goal this event's isGoal maps to (for the dedup below) and
      // whether WhoScored itself typed it a 'Goal' (the strongest claim).
      if (best && best.isGoal) ev._richIdx = bestIdx;
      ev._typedGoal = (type === 'Goal');
    }

    if (isShootout) ev.shootout = true;
    events.push(ev);
  }

  // DEDUP phantom goals — the rich-fallback (`|| best.isGoal`) can mark SEVERAL shots that
  // xg-join to the SAME rich goal (e.g. a saved rebound a minute after a real goal). Keep
  // exactly ONE isGoal per rich goal: prefer a WhoScored-typed 'Goal', else the first; clear
  // isGoal on the other rich-derived claimants (never on a typed 'Goal').
  const claimants = new Map();   // richIdx -> [events with that _richIdx]
  for (const e of events) {
    if (e._richIdx == null) continue;
    if (!claimants.has(e._richIdx)) claimants.set(e._richIdx, []);
    claimants.get(e._richIdx).push(e);
  }
  for (const list of claimants.values()) {
    if (list.length <= 1) continue;
    const keeper = list.find((e) => e._typedGoal) || list[0];
    for (const e of list) if (e !== keeper && !e._typedGoal) e.isGoal = false;
  }

  // sort ascending by t, tiebreak by event id (stable order)
  events.sort((a, b) => (a.t - b.t) || ((a._id || 0) - (b._id || 0)));
  // drop the internal id + temp goal-dedup fields from the emitted records
  for (const ev of events) { delete ev._id; delete ev._richIdx; delete ev._typedGoal; }

  const firstT = events.length ? events[0].t : 0;
  // fullT must EXCLUDE the shootout (else the dramatic clock would run to ~126' and count
  // shootout kicks as goals) — use the last REGULATION/extra-time event.
  const regEvents = events.filter((e) => !e.shootout);
  const lastT = regEvents.length ? regEvents[regEvents.length - 1].t
    : (events.length ? events[events.length - 1].t : 0);
  // ordered SHOOTOUT result: one entry per kick (Goal = scored, else missed/saved).
  const shootout = events
    .filter((e) => e.shootout && SHOT_TYPES.has(e.type))
    .sort((a, b) => a.t - b.t)                                    // CHRONOLOGICAL kick order (raw order isn't reliably t-sorted → the rings/sky-lean revealed in the wrong sequence)
    .map((e) => ({ team: e.team, scored: e.type === 'Goal' }));

  return {
    matchId: String((rich && rich.matchId) || (raw.matchId) || ''),
    home: { id: homeId, name: (raw.home && raw.home.name) || richHome.name || 'Home', abbr: homeAbbr, color: homeColor },
    away: { id: awayId, name: (raw.away && raw.away.name) || richAway.name || 'Away', abbr: awayAbbr, color: awayColor },
    kickoff: firstT,
    fullT: lastT,
    ...(shootout.length ? { shootout } : {}),
    events,
  };
}

async function main() {
  if (!existsSync(OUT_DIR)) await mkdir(OUT_DIR, { recursive: true });
  const files = (await readdir(RAW_DIR)).filter((f) => f.endsWith('.json'));
  let made = 0;
  for (const f of files) {
    const id = f.replace(/\.json$/, '');
    let raw, rich = null;
    try {
      raw = JSON.parse(await readFile(path.join(RAW_DIR, f), 'utf8'));
    } catch (e) {
      console.warn(`skip ${id}: raw read/parse failed (${e.message})`);
      continue;
    }
    const richPath = path.join(RICH_DIR, `${id}.json`);
    if (existsSync(richPath)) {
      try { rich = JSON.parse(await readFile(richPath, 'utf8')); } catch { /* no rich, xg=null */ }
    }
    const out = buildOne(raw, rich);
    out.matchId = out.matchId || id;
    await writeFile(path.join(OUT_DIR, `${id}.json`), JSON.stringify(out));
    made++;
    const shotsJoined = out.events.filter((e) => e.xg != null).length;
    console.log(`${id}: ${out.events.length} events, fullT=${out.fullT.toFixed(2)}, xg joined=${shotsJoined}`);
  }
  console.log(`done: ${made} timeline file(s) written to ${OUT_DIR}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
