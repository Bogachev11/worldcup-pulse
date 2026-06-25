// Build a lightweight match-index from the rich per-match JSONs.
//
// Reads every data/rich/*.json and writes a single data/matches.json (and a
// copy at public/matches.json so the static server serves it at /matches.json).
//
// Each index entry is small enough to render a gallery card + fingerprint SVG
// WITHOUT fetching the full rich file:
//   { id, date, round, group,
//     home:{name,abbr,colorHex,score}, away:{name,abbr,colorHex,score},
//     momentum:[valueNorm,...],            // the ~94 valueNorm numbers
//     goals:[{minute,team,player}],        // derived from shots where isGoal
//     shotCount, xgHome, xgAway }
//
// Re-run after harvesting new matches:  node server/build_matches_index.js

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RICH_DIR = path.join(ROOT, 'data', 'rich');
const OUT_DATA = path.join(ROOT, 'data', 'matches.json');
const OUT_PUBLIC = path.join(ROOT, 'public', 'matches.json');

function round2(n) { return Math.round(n * 100) / 100; }

function teamLite(t) {
  return {
    name: t?.name ?? '',
    abbr: t?.abbr ?? '',
    colorHex: t?.colorHex ?? '#888888',
    score: typeof t?.score === 'number' ? t.score : 0,
  };
}

function buildEntry(rich) {
  const shots = Array.isArray(rich.shots) ? rich.shots : [];
  const momentum = Array.isArray(rich.momentum) ? rich.momentum : [];

  const goals = shots
    .filter((s) => s.isGoal)
    .map((s) => ({ minute: s.minute, team: s.team, player: s.player || '' }))
    .sort((a, b) => a.minute - b.minute);

  let xgHome = 0;
  let xgAway = 0;
  for (const s of shots) {
    const xg = Number(s.xg) || 0;
    if (s.team === 'home') xgHome += xg;
    else if (s.team === 'away') xgAway += xg;
  }

  return {
    id: String(rich.matchId),
    date: rich.date,
    round: rich.round,
    group: rich.group ?? null,
    home: teamLite(rich.home),
    away: teamLite(rich.away),
    momentum: momentum.map((m) => round2(Number(m.valueNorm) || 0)),
    goals,
    shotCount: shots.length,
    xgHome: round2(xgHome),
    xgAway: round2(xgAway),
  };
}

async function main() {
  const files = (await readdir(RICH_DIR)).filter((f) => f.endsWith('.json'));
  const entries = [];
  for (const f of files) {
    try {
      const rich = JSON.parse(await readFile(path.join(RICH_DIR, f), 'utf8'));
      if (rich && rich.matchId) entries.push(buildEntry(rich));
    } catch (e) {
      console.warn(`skip ${f}: ${e.message}`);
    }
  }

  // sort by date then numeric matchId
  entries.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return Number(a.id) - Number(b.id);
  });

  const json = JSON.stringify(entries, null, 0);
  await writeFile(OUT_DATA, json);
  await mkdir(path.dirname(OUT_PUBLIC), { recursive: true });
  await writeFile(OUT_PUBLIC, json);

  const noGoals = entries.filter((e) => e.goals.length === 0).length;
  const noMomentum = entries.filter((e) => e.momentum.length === 0).length;
  console.log(`wrote ${entries.length} matches -> ${OUT_DATA} and ${OUT_PUBLIC}`);
  console.log(`  goalless matches: ${noGoals}; matches w/o momentum: ${noMomentum}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
