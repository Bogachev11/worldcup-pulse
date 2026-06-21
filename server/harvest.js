// harvest.js — enumerate ALL completed FIFA World Cup 2026 matches from ESPN's
// hidden API, derive a per-match "fingerprint" (momentum series + events + box),
// and persist to disk. NO mock/fake data — everything comes from ESPN. No deps.
//
// Run:  node server/harvest.js
//
// Writes:
//   data/matches/{id}.json   — full per-match fingerprint record (one per match)
//   data/monument.json       — tournament index + all match records
//
// Reuses the EXISTING momentum derivation from momentum.js (do NOT change formula).

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchScoreboard, fetchSummary } from './espn.js';
import { buildTimeline, momentumAt } from './momentum.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const MATCHES_DIR = path.join(DATA, 'matches');

const TOURNAMENT_NAME = '2026 FIFA World Cup';
const START_DATE = '2026-06-11';
const END_DATE = '2026-07-19';

// ---- polite-fetch helpers ---------------------------------------------------
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, label, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const wait = 400 * Math.pow(2, i); // 0.4s, 0.8s, 1.6s, 3.2s
      console.warn(`  ! ${label} failed (attempt ${i + 1}/${tries}): ${e.message}; retrying in ${wait}ms`);
      await SLEEP(wait);
    }
  }
  throw lastErr;
}

// ---- date / round helpers ---------------------------------------------------
function ymd(d) {
  // d: Date -> "YYYYMMDD"
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function dayOfISO(iso) {
  // "2026-06-11T19:00Z" -> "2026-06-11"
  return String(iso).slice(0, 10);
}

// Parse an ESPN clock string like "21'", "45'+5'", "90'+12'" -> match-minute (int).
function clockToMinute(disp) {
  if (!disp) return null;
  const m = /(\d+)'(?:\+(\d+)')?/.exec(disp);
  if (!m) {
    const n = parseInt(disp, 10);
    return Number.isFinite(n) ? n : null;
  }
  const base = parseInt(m[1], 10);
  const extra = m[2] ? parseInt(m[2], 10) : 0;
  return base + extra;
}

// Prefer keyEvent clock.value (seconds) -> minute; else parse displayValue.
function keyEventMinute(k) {
  if (typeof k.clock?.value === 'number') return Math.round(k.clock.value / 60);
  return clockToMinute(k.clock?.displayValue);
}

// Map "FIFA World Cup, Group F" / round labels -> {round, group}.
// Group stage -> round:"group", group letter from the note.
// Knockout labels map to our short codes.
function deriveRoundGroup(altGameNote, seasonSlug, header) {
  const note = String(altGameNote || '').toLowerCase();

  // Group stage
  const gm = /group\s+([a-l])/i.exec(altGameNote || '');
  if (gm || /group/.test(note) || seasonSlug === 'group-stage') {
    return { round: 'group', group: gm ? gm[1].toUpperCase() : null };
  }

  // Third-place play-off (header flag is authoritative when present)
  if (header?.isThirdPlace || /third place|3rd place/.test(note)) {
    return { round: '3rd', group: null };
  }
  if (/final/.test(note) && !/semi|quarter/.test(note)) {
    return { round: 'final', group: null };
  }
  if (/semi/.test(note)) return { round: 'sf', group: null };
  if (/quarter/.test(note)) return { round: 'qf', group: null };
  if (/round of 16|last 16/.test(note)) return { round: 'r16', group: null };
  if (/round of 32|last 32/.test(note)) return { round: 'r32', group: null };

  // Fallback by season slug.
  const slugMap = {
    'round-of-32': 'r32',
    'round-of-16': 'r16',
    'quarterfinals': 'qf',
    'semifinals': 'sf',
    'third-place': '3rd',
    'final': 'final',
  };
  if (seasonSlug && slugMap[seasonSlug]) return { round: slugMap[seasonSlug], group: null };

  return { round: 'group', group: null };
}

// ---- color handling ---------------------------------------------------------
function cleanHex(hex) {
  if (!hex) return null;
  const c = String(hex).replace('#', '').trim();
  return /^[0-9a-fA-F]{6}$/.test(c) ? '#' + c.toLowerCase() : null;
}

function luminance(hex) {
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16) / 255;
  const g = parseInt(c.slice(2, 4), 16) / 255;
  const b = parseInt(c.slice(4, 6), 16) / 255;
  // perceived luminance
  return 0.2126 * r + 0.7152 * g + 0.4189 * b;
}

// Euclidean distance in RGB space (0..~441).
function colorDist(a, b) {
  const ca = a.replace('#', ''), cb = b.replace('#', '');
  const ar = parseInt(ca.slice(0, 2), 16), ag = parseInt(ca.slice(2, 4), 16), ab = parseInt(ca.slice(4, 6), 16);
  const br = parseInt(cb.slice(0, 2), 16), bg = parseInt(cb.slice(2, 4), 16), bb = parseInt(cb.slice(4, 6), 16);
  return Math.sqrt((ar - br) ** 2 + (ag - bg) ** 2 + (ab - bb) ** 2);
}

// Pick visually-distinct colors for home/away.
// Prefer summary header competitor color; fall back to scoreboard team color;
// fall back to alternateColor; final fallback to canonical home/away hexes.
// If the two chosen colors are too close (or both very dark), swap one team to
// its alternateColor to keep the membrane readable.
function resolveColors(homeSrc, awaySrc) {
  const FALLBACK_HOME = '#2266ff';
  const FALLBACK_AWAY = '#ff5522';

  let h = cleanHex(homeSrc.headerColor) || cleanHex(homeSrc.teamColor) || FALLBACK_HOME;
  let a = cleanHex(awaySrc.headerColor) || cleanHex(awaySrc.teamColor) || FALLBACK_AWAY;
  const fallbacks = [];

  // If too close, try alternate colors to separate them.
  if (colorDist(h, a) < 80) {
    const aAlt = cleanHex(awaySrc.altColor);
    if (aAlt && colorDist(h, aAlt) >= 80) {
      a = aAlt;
      fallbacks.push('away->alternateColor (home/away too close)');
    } else {
      const hAlt = cleanHex(homeSrc.altColor);
      if (hAlt && colorDist(hAlt, a) >= 80) {
        h = hAlt;
        fallbacks.push('home->alternateColor (home/away too close)');
      } else {
        // last resort canonical
        a = FALLBACK_AWAY;
        fallbacks.push('away->canonical (home/away too close, no usable alt)');
      }
    }
  }

  // If both dark (poor contrast on near-black bg), lift the away to its alt or canonical.
  if (luminance(h) < 0.12 && luminance(a) < 0.12) {
    const aAlt = cleanHex(awaySrc.altColor);
    if (aAlt && luminance(aAlt) >= 0.12) {
      a = aAlt;
      fallbacks.push('away->alternateColor (both too dark)');
    } else {
      a = FALLBACK_AWAY;
      fallbacks.push('away->canonical (both too dark)');
    }
  }

  return { home: h, away: a, fallbacks };
}

// ---- penalty detection ------------------------------------------------------
// ESPN exposes penalties primarily as keyEvent type.text "Penalty - Scored" /
// "Penalty - Missed". As a backstop we also scan goal/keyEvent text for the
// word "penalty" (e.g. "converts the penalty"). scored = whether it resulted in
// a goal. Limitation: shootout penalties (type.shootout / "Penalty Shootout")
// are excluded from the in-play penalties[] list — those are decided after 120'.
function isPenaltyEvent(k) {
  const tt = k.type?.text || '';
  if (/^penalty\s*-\s*(scored|missed|saved)/i.test(tt)) return true;
  // a Goal keyEvent whose text mentions a penalty conversion
  if (/^goal/i.test(tt) && /penalt/i.test(k.text || '')) return true;
  return false;
}

// ---- build one match record -------------------------------------------------
function buildRecord(scoreEvent, summary) {
  const id = scoreEvent.id;
  const comp = scoreEvent.competitions?.[0] || {};
  const header = summary?.header?.competitions?.[0];
  const sbCompetitors = comp.competitors || [];
  const hdCompetitors = header?.competitors || [];

  const sbHome = sbCompetitors.find((c) => c.homeAway === 'home') || sbCompetitors[0] || {};
  const sbAway = sbCompetitors.find((c) => c.homeAway === 'away') || sbCompetitors[1] || {};
  const hdHome = hdCompetitors.find((c) => c.homeAway === 'home') || hdCompetitors[0] || {};
  const hdAway = hdCompetitors.find((c) => c.homeAway === 'away') || hdCompetitors[1] || {};

  const homeName = hdHome.team?.displayName || sbHome.team?.displayName || sbHome.team?.name;
  const awayName = hdAway.team?.displayName || sbAway.team?.displayName || sbAway.team?.name;
  const homeAbbr = hdHome.team?.abbreviation || sbHome.team?.abbreviation || 'HOM';
  const awayAbbr = hdAway.team?.abbreviation || sbAway.team?.abbreviation || 'AWY';

  const homeScore = Number(hdHome.score ?? sbHome.score ?? 0);
  const awayScore = Number(hdAway.score ?? sbAway.score ?? 0);

  // Colors
  const colors = resolveColors(
    { headerColor: hdHome.team?.color, teamColor: sbHome.team?.color, altColor: sbHome.team?.alternateColor || hdHome.team?.alternateColor },
    { headerColor: hdAway.team?.color, teamColor: sbAway.team?.color, altColor: sbAway.team?.alternateColor || hdAway.team?.alternateColor },
  );

  // Round / group
  const altGameNote = comp.altGameNote || header?.altGameNote;
  const seasonSlug = scoreEvent.season?.slug;
  const { round, group } = deriveRoundGroup(altGameNote, seasonSlug, header);

  // Timeline (reused momentum derivation) for the momentum series.
  const timeline = buildTimeline(summary, homeName, awayName);
  const lastT = timeline.length ? timeline[timeline.length - 1].t : 0;
  // Sample every 1 minute, 0..ceil(lastMinute)+1 (covers stoppage time).
  const maxMin = Math.max(90, Math.ceil(lastT / 60) + 1);
  const momentumSeries = [];
  for (let mm = 0; mm <= maxMin; mm++) {
    momentumSeries.push({ t: mm, v: Number(momentumAt(timeline, mm * 60).toFixed(4)) });
  }
  const finalMomentum = momentumSeries.length ? momentumSeries[momentumSeries.length - 1].v : 0;

  // Resolve a team displayName -> "home" | "away" | null.
  const sideOf = (name) => {
    if (!name) return null;
    if (name === homeName) return 'home';
    if (name === awayName) return 'away';
    return null;
  };

  // Goals, reds, yellows, penalties from keyEvents (clock.value seconds available).
  const goals = [];
  const reds = [];
  const yellows = [];
  const penalties = [];
  const seenPenT = new Set();

  for (const k of summary?.keyEvents || []) {
    const tt = k.type?.text || '';
    const side = sideOf(k.team?.displayName || k.team?.name);
    const t = keyEventMinute(k);

    // Goals (incl. headers/volleys/penalty-scored). Own Goal credited to the
    // team that benefits, which ESPN already reports as k.team.
    if (/^goal/i.test(tt) || tt === 'Own Goal' || /^penalty\s*-\s*scored/i.test(tt)) {
      if (side && t != null) {
        const scorer = k.participants?.[0]?.athlete?.displayName
          || (/(?:Goal!|converts).*?\.\s*([A-Z][^\(]+?)\s*\(/.exec(k.text || '')?.[1]?.trim())
          || null;
        goals.push({ t, team: side, scorer });
      }
    }

    if (tt === 'Yellow Card' && side && t != null) yellows.push({ t, team: side });
    if ((tt === 'Red Card' || /red.*card.*upgrade/i.test(tt)) && side && t != null) reds.push({ t, team: side });

    // Penalties (in-play; excludes shootout).
    if (isPenaltyEvent(k) && !k.shootout && side && t != null) {
      const key = `${side}:${t}`;
      if (!seenPenT.has(key)) {
        seenPenT.add(key);
        const scored = /scored/i.test(tt) || (/^goal/i.test(tt) && /penalt/i.test(k.text || ''));
        penalties.push({ t, team: side, scored: !!scored });
      }
    }
  }

  goals.sort((a, b) => a.t - b.t);
  reds.sort((a, b) => a.t - b.t);
  yellows.sort((a, b) => a.t - b.t);
  penalties.sort((a, b) => a.t - b.t);

  // Boxscore stats.
  const teams = summary?.boxscore?.teams || [];
  const findStats = (name, abbr) => {
    const tm = teams.find((t) =>
      (t.team?.displayName && t.team.displayName === name) ||
      (t.team?.abbreviation && t.team.abbreviation === abbr));
    return tm?.statistics || [];
  };
  const statN = (statistics, key) => {
    const s = (statistics || []).find((x) => x.name === key);
    if (!s) return null;
    const num = parseFloat(s.displayValue);
    return Number.isFinite(num) ? num : null;
  };
  const hs = findStats(homeName, homeAbbr);
  const as = findStats(awayName, awayAbbr);

  return {
    id,
    day: dayOfISO(scoreEvent.date),
    kickoffISO: scoreEvent.date,
    round,
    group,
    home: { abbr: homeAbbr, name: homeName || 'Home', colorHex: colors.home, score: homeScore },
    away: { abbr: awayAbbr, name: awayName || 'Away', colorHex: colors.away, score: awayScore },
    fingerprint: {
      momentumSeries,
      goals,
      reds,
      yellows,
      penalties,
      finalMomentum,
      possessionHome: statN(hs, 'possessionPct') ?? 50,
      possessionAway: statN(as, 'possessionPct') ?? 50,
      shotsHome: statN(hs, 'totalShots') ?? 0,
      shotsAway: statN(as, 'totalShots') ?? 0,
      sotHome: statN(hs, 'shotsOnTarget') ?? 0,
      sotAway: statN(as, 'shotsOnTarget') ?? 0,
      cornersHome: statN(hs, 'wonCorners') ?? 0,
      cornersAway: statN(as, 'wonCorners') ?? 0,
    },
    _colorFallbacks: colors.fallbacks.length ? colors.fallbacks : undefined,
  };
}

// ---- enumerate all events across the tournament -----------------------------
async function enumerateEvents() {
  // Paginate by ~10-day windows to be safe (the API also accepts the full range,
  // but windowing avoids any server-side cap and is gentler).
  const start = new Date(START_DATE + 'T00:00:00Z');
  const end = new Date(END_DATE + 'T00:00:00Z');
  const byId = new Map();

  let cur = new Date(start);
  while (cur <= end) {
    const winStart = new Date(cur);
    const winEnd = new Date(cur);
    winEnd.setUTCDate(winEnd.getUTCDate() + 9);
    if (winEnd > end) winEnd.setTime(end.getTime());

    const range = `${ymd(winStart)}-${ymd(winEnd)}`;
    const sb = await withRetry(() => fetchScoreboard(range), `scoreboard ${range}`);
    const events = Array.isArray(sb?.events) ? sb.events : [];
    for (const e of events) byId.set(e.id, e);
    console.log(`  window ${range}: ${events.length} events`);

    cur.setUTCDate(cur.getUTCDate() + 10);
    await SLEEP(200);
  }
  return [...byId.values()];
}

// ---- main -------------------------------------------------------------------
async function main() {
  console.log(`Harvesting ${TOURNAMENT_NAME} (${START_DATE} .. ${END_DATE}) from ESPN...`);
  await mkdir(MATCHES_DIR, { recursive: true });

  const allEvents = await enumerateEvents();
  const postEvents = allEvents.filter((e) => e.competitions?.[0]?.status?.type?.state === 'post');
  const skipped = allEvents.length - postEvents.length;
  console.log(`Found ${allEvents.length} events; ${postEvents.length} completed (post); skipping ${skipped} non-post.`);

  // Sort by kickoff time for stable output.
  postEvents.sort((a, b) => new Date(a.date) - new Date(b.date));

  const records = [];
  const CONCURRENCY = 3;
  for (let i = 0; i < postEvents.length; i += CONCURRENCY) {
    const batch = postEvents.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async (e) => {
      try {
        const summary = await withRetry(() => fetchSummary(e.id), `summary ${e.id}`);
        const rec = buildRecord(e, summary);
        await writeFile(path.join(MATCHES_DIR, `${rec.id}.json`), JSON.stringify(rec, null, 2), 'utf8');
        const fb = rec._colorFallbacks ? `  [color: ${rec._colorFallbacks.join('; ')}]` : '';
        console.log(`  + ${rec.id} ${e.shortName}  ${rec.home.score}-${rec.away.score}  ${rec.day}  ${rec.round}${rec.group ? '/' + rec.group : ''}  goals=${rec.fingerprint.goals.length} y=${rec.fingerprint.yellows.length} r=${rec.fingerprint.reds.length} pen=${rec.fingerprint.penalties.length}${fb}`);
        return rec;
      } catch (err) {
        console.error(`  x ${e.id} ${e.shortName}: ${err.message}`);
        return null;
      }
    }));
    for (const r of results) if (r) records.push(r);
    await SLEEP(250);
  }

  records.sort((a, b) => new Date(a.kickoffISO) - new Date(b.kickoffISO));

  // Index / monument file.
  const days = [...new Set(records.map((r) => r.day))].sort();
  const groups = [...new Set(records.map((r) => r.group).filter(Boolean))].sort();

  const monument = {
    tournament: { name: TOURNAMENT_NAME, startDate: START_DATE, endDate: END_DATE, days },
    groups,
    matches: records,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(DATA, 'monument.json'), JSON.stringify(monument, null, 2), 'utf8');

  console.log(`\nDone. Harvested ${records.length} matches across ${days.length} days, groups: [${groups.join(', ')}].`);
  console.log(`Wrote data/monument.json and data/matches/{id}.json`);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
