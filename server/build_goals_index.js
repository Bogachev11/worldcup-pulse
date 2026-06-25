// build_goals_index.js — collect every GOAL's on-goal placement (where it crossed
// the goal mouth) into a tiny index for stage8 ("goals as blobs on the goal plane").
// Uses onGoalX (≈0..2 across, 1 = centre) / onGoalY (0 ground .. ~1 crossbar) from
// the rich shot data — real data only. Run: node server/build_goals_index.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.dirname(__dirname);
const RICH = path.join(PROJECT, 'data', 'rich');

const goals = [];
for (const f of fs.readdirSync(RICH).filter((x) => x.endsWith('.json'))) {
  const m = JSON.parse(fs.readFileSync(path.join(RICH, f), 'utf8'));
  const homeC = (m.home && m.home.colorHex) || '#6cf';
  const awayC = (m.away && m.away.colorHex) || '#f96';
  for (const s of (m.shots || [])) {
    if (!s.isGoal) continue;
    if (!Number.isFinite(s.onGoalX) || !Number.isFinite(s.onGoalY)) continue;
    const home = s.team === 'home';
    goals.push({
      x: +s.onGoalX.toFixed(4),       // across the goal mouth (~0..2, 1 = centre)
      y: +s.onGoalY.toFixed(4),       // height (0 ground .. ~1 crossbar)
      c: home ? homeC : awayC,        // scoring team colour
      xg: +((s.xg || 0)).toFixed(3),
      xgot: +((s.xgot || 0)).toFixed(3),
      t: s.minute,
      who: s.player || '',
      foot: s.shotType || '',
      sit: s.situation || '',
      m: m.matchId,
      team: home ? (m.home.abbr || 'HOME') : (m.away.abbr || 'AWAY'),
      opp: home ? (m.away.abbr || '') : (m.home.abbr || ''),
    });
  }
}
// sort by match then minute (stable, deterministic)
goals.sort((a, b) => (a.m === b.m ? a.t - b.t : (a.m < b.m ? -1 : 1)));

const out = JSON.stringify(goals);
fs.writeFileSync(path.join(PROJECT, 'data', 'goals.json'), out);
fs.writeFileSync(path.join(PROJECT, 'public', 'goals.json'), out);
console.log(`goals.json: ${goals.length} goals from ${fs.readdirSync(RICH).filter((x) => x.endsWith('.json')).length} matches`);
