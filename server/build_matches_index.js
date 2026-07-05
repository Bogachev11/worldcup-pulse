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
const FM_DIR = path.join(ROOT, 'data', 'raw', 'fotmob');
const OUT_DATA = path.join(ROOT, 'data', 'matches.json');
const OUT_PUBLIC = path.join(ROOT, 'public', 'matches.json');

function round2(n) { return Math.round(n * 100) / 100; }

// The true tournament STAGE + GROUP live only in the FotMob raw (general.leagueRoundName,
// e.g. "1/16" = Round of 32, "1/8" = Round of 16, "1/4", "1/2", "Final", or "Group A"). The
// rich record only carries a generic round ("knockout"/null), so we join the FotMob raws by
// normalised team-pair (+ date) to recover the real stage/group for the gallery.
const normTeam = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const pairKey = (a, b, d) => [normTeam(a), normTeam(b)].sort().join('|') + '@' + (d || '').slice(0, 10);
const STAGE_MAP = { '1/16': 'Round of 32', '1/8': 'Round of 16', '1/4': 'Quarter-final', '1/2': 'Semi-final', 'Final': 'Final' };
const STAGE_RANK = { 'Final': 0, 'Semi-final': 1, 'Quarter-final': 2, 'Round of 16': 3, 'Round of 32': 4 };
function deriveStage(lrn) {
  const s = String(lrn || '').trim();
  if (STAGE_MAP[s]) return STAGE_MAP[s];
  if (/3rd|third/i.test(s)) return 'Third place';
  if (/^final$/i.test(s)) return 'Final';
  return null;
}
function deriveGroup(lrn) {
  const m = String(lrn || '').match(/group\s*([a-l])/i);
  return m ? m[1].toUpperCase() : null;
}
// Map normalised team-pair(@date) → FotMob leagueRoundName, from every FotMob raw on disk.
async function loadFotmobRounds() {
  const map = new Map();
  let files = [];
  try { files = (await readdir(FM_DIR)).filter((f) => f.endsWith('.json')); } catch { return map; }
  for (const f of files) {
    try {
      const g = (JSON.parse(await readFile(path.join(FM_DIR, f), 'utf8')).general) || {};
      const lrn = g.leagueRoundName || g.matchRound;
      const h = g.homeTeam && g.homeTeam.name, a = g.awayTeam && g.awayTeam.name;
      const d = g.matchTimeUTCDate || g.matchTimeUTC;
      if (!lrn || !h || !a) continue;
      map.set(pairKey(h, a, d), lrn);          // dated (exact)
      map.set([normTeam(h), normTeam(a)].sort().join('|'), lrn);   // undated fallback
    } catch { /* skip */ }
  }
  return map;
}

function teamLite(t) {
  return {
    name: t?.name ?? '',
    abbr: t?.abbr ?? '',
    colorHex: t?.colorHex ?? '#888888',
    score: typeof t?.score === 'number' ? t.score : 0,
  };
}

function buildEntry(rich, fmMap) {
  const shots = Array.isArray(rich.shots) ? rich.shots : [];
  const momentum = Array.isArray(rich.momentum) ? rich.momentum : [];
  // recover the true stage/group from the FotMob raw (join by team-pair + date, undated fallback).
  const hn = rich.home && rich.home.name, an = rich.away && rich.away.name;
  const lrn = (fmMap && (fmMap.get(pairKey(hn, an, rich.date)) || fmMap.get([normTeam(hn), normTeam(an)].sort().join('|')))) || null;
  const stage = deriveStage(lrn);
  const groupLetter = deriveGroup(lrn) || (rich.group ? String(rich.group).replace(/[^A-La-l]/g, '').toUpperCase() || null : null);

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
    group: groupLetter,
    stage: stage,                                   // true KO stage ("Round of 32"… "Final") or null
    stageRank: stage ? (STAGE_RANK[stage] ?? 9) : null,   // 0 = Final … 4 = R32 (for gallery ordering)
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
  const fmMap = await loadFotmobRounds();
  const files = (await readdir(RICH_DIR)).filter((f) => f.endsWith('.json'));
  const entries = [];
  for (const f of files) {
    try {
      const rich = JSON.parse(await readFile(path.join(RICH_DIR, f), 'utf8'));
      if (rich && rich.matchId) entries.push(buildEntry(rich, fmMap));
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
