// espn.js — thin client for ESPN's hidden FIFA World Cup API + normalizers.
// No auth, no key. Uses Node 18+ built-in fetch.

import { buildTimeline, momentumAt, momentumSeries } from './momentum.js';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world';

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'worldcup-pulse/0.1 (+local demo)' },
  });
  if (!res.ok) throw new Error(`ESPN ${res.status} for ${url}`);
  return res.json();
}

export async function fetchScoreboard(dates) {
  const url = dates ? `${BASE}/scoreboard?dates=${dates}` : `${BASE}/scoreboard`;
  return getJson(url);
}

export async function fetchSummary(eventId) {
  return getJson(`${BASE}/summary?event=${eventId}`);
}

// Normalize the scoreboard into a compact match list for the UI dropdown.
export function normalizeScoreboard(sb) {
  const events = Array.isArray(sb?.events) ? sb.events : [];
  return events.map((e) => {
    const comp = e.competitions?.[0] || {};
    const competitors = comp.competitors || [];
    const home = competitors.find((c) => c.homeAway === 'home') || competitors[0] || {};
    const away = competitors.find((c) => c.homeAway === 'away') || competitors[1] || {};
    const mkTeam = (c) => ({
      abbrev: c.team?.abbreviation || '?',
      displayName: c.team?.displayName || c.team?.name || 'Unknown',
      colorHex: normalizeColor(c.team?.color, c.homeAway === 'home' ? '2266ff' : 'ff5522'),
      score: c.score != null ? Number(c.score) : 0,
    });
    return {
      id: e.id,
      shortName: e.shortName,
      state: comp.status?.type?.state || 'pre',
      clock: comp.status?.displayClock || e.status?.displayClock || "0'",
      home: mkTeam(home),
      away: mkTeam(away),
    };
  });
}

function normalizeColor(hex, fallback) {
  if (!hex) return '#' + fallback;
  const clean = String(hex).replace('#', '').trim();
  if (/^[0-9a-fA-F]{6}$/.test(clean)) return '#' + clean;
  return '#' + fallback;
}

// Pull a named stat from a boxscore team's statistics array.
function stat(statistics, name) {
  const s = (statistics || []).find((x) => x.name === name);
  if (!s) return null;
  const v = s.displayValue;
  const num = parseFloat(v);
  return Number.isFinite(num) ? num : v;
}

// Build the full normalized STATE for a match at virtual match-time `nowSec`.
// `nowSec` lets REPLAY mode recompute everything at a virtual clock; for live
// matches pass the real elapsed seconds (or Infinity to use all events).
export function normalizeState(summary, scoreboardEntry, nowSec, mode) {
  const header = summary?.header?.competitions?.[0];
  const competitors = header?.competitors || [];
  const homeC = competitors.find((c) => c.homeAway === 'home') || competitors[0] || {};
  const awayC = competitors.find((c) => c.homeAway === 'away') || competitors[1] || {};

  const homeName = homeC.team?.displayName || homeC.team?.name || scoreboardEntry?.home?.displayName;
  const awayName = awayC.team?.displayName || awayC.team?.name || scoreboardEntry?.away?.displayName;

  const timeline = buildTimeline(summary, homeName, awayName);

  // Determine the upper bound of revealed time.
  const lastEventT = timeline.length ? timeline[timeline.length - 1].t : 0;
  const effectiveNow = nowSec === Infinity ? lastEventT + 1 : nowSec;

  // Revealed events up to effectiveNow.
  const revealed = timeline.filter((e) => e.t <= effectiveNow);

  // Live score = goals revealed so far (so replay scores climb in time).
  let homeScore = 0;
  let awayScore = 0;
  for (const e of revealed) {
    if (e.pulse === 'goal') {
      if (e.side === 'home') homeScore++; else awayScore++;
    }
  }
  // For live/post, trust the official score if we've revealed everything.
  if (nowSec === Infinity) {
    homeScore = Number(homeC.score ?? scoreboardEntry?.home?.score ?? homeScore);
    awayScore = Number(awayC.score ?? scoreboardEntry?.away?.score ?? awayScore);
  }

  const momentum = momentumAt(timeline, effectiveNow);
  const series = momentumSeries(timeline, effectiveNow, 30, 120);

  // Recent pulse events (last 8 with a visual pulse), tagged with stable ids.
  const pulses = revealed
    .filter((e) => e.pulse)
    .map((e, i) => ({
      id: `${e.side}-${Math.round(e.t)}-${e.pulse}-${i}`,
      t: e.t,
      type: e.pulse,
      team: e.side,
      text: e.text,
    }));
  const recentPulses = pulses.slice(-8);

  // Boxscore stats.
  const teams = summary?.boxscore?.teams || [];
  const findTeamStats = (name, abbrev) => {
    const tm = teams.find((t) =>
      (t.team?.displayName && t.team.displayName === name) ||
      (t.team?.abbreviation && t.team.abbreviation === abbrev));
    return tm?.statistics || [];
  };
  const homeStats = findTeamStats(homeName, scoreboardEntry?.home?.abbrev);
  const awayStats = findTeamStats(awayName, scoreboardEntry?.away?.abbrev);

  const box = {
    possession: {
      home: stat(homeStats, 'possessionPct') ?? 50,
      away: stat(awayStats, 'possessionPct') ?? 50,
    },
    shots: { home: stat(homeStats, 'totalShots') ?? 0, away: stat(awayStats, 'totalShots') ?? 0 },
    shotsOnTarget: { home: stat(homeStats, 'shotsOnTarget') ?? 0, away: stat(awayStats, 'shotsOnTarget') ?? 0 },
    corners: { home: stat(homeStats, 'wonCorners') ?? 0, away: stat(awayStats, 'wonCorners') ?? 0 },
    yellowCards: { home: stat(homeStats, 'yellowCards') ?? 0, away: stat(awayStats, 'yellowCards') ?? 0 },
    redCards: { home: stat(homeStats, 'redCards') ?? 0, away: stat(awayStats, 'redCards') ?? 0 },
    fouls: { home: stat(homeStats, 'foulsCommitted') ?? 0, away: stat(awayStats, 'foulsCommitted') ?? 0 },
  };

  // Event rate over the last 5 minutes -> drives particle activity on frontend.
  const windowStart = effectiveNow - 5 * 60;
  const recentCount = revealed.filter((e) => e.t >= windowStart && e.thrust !== 0).length;
  const activity = Math.min(1, recentCount / 8); // 0..1

  const displayMin = Math.floor(effectiveNow / 60);
  const clockDisplay = `${displayMin}'`;

  return {
    matchId: scoreboardEntry?.id || summary?.header?.id,
    mode, // 'live' | 'replay' | 'pre' | 'post'
    clock: { seconds: Math.round(effectiveNow), display: clockDisplay },
    state: scoreboardEntry?.state || 'in',
    home: {
      abbrev: homeC.team?.abbreviation || scoreboardEntry?.home?.abbrev || 'HOM',
      displayName: homeName || 'Home',
      colorHex: normalizeColor(homeC.team?.color, '2266ff'),
      score: homeScore,
    },
    away: {
      abbrev: awayC.team?.abbreviation || scoreboardEntry?.away?.abbrev || 'AWY',
      displayName: awayName || 'Away',
      colorHex: normalizeColor(awayC.team?.color, 'ff5522'),
      score: awayScore,
    },
    momentum, // current, normalized [-1,1] (+ = home pressing)
    momentumSeries: series, // [{t, value}]
    activity, // 0..1 recent event density
    box,
    recentPulses, // [{id, t, type, team, text}]
  };
}
