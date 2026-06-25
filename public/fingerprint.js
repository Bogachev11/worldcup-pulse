// Static "match fingerprint" SVG generator.
//
//   import { fingerprintSVG } from './fingerprint.js';
//   el.innerHTML = fingerprintSVG(match, { w: 440, h: 150 });
//
// A STILL (no animation) per-match seismograph over the whole 90' match.
// Accepts either the lightweight index object (from matches.json) or a full
// rich JSON. It encodes:
//   - MIDLINE: neutral baseline across the vertical centre.
//   - MOMENTUM RIBBON: smoothed filled area of valueNorm over minutes; >0 fills
//     UP in the home colour (home pressure), <0 fills DOWN in the away colour.
//   - GOAL PEAKS: a bright vertical spike at each goal's minute (home goals up,
//     away down), in the scoring team's colour, with a circle cap + minute label.
//   - 45' halftime: faint dashed vertical line.
//   - SHOT TICKS: subtle marks at each shot, opacity scaled by xG.
//
// Data-driven only — no decorative/placeholder content.

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Normalise either rich JSON or the lightweight index object into one shape.
function normalize(m) {
  const home = m.home || {};
  const away = m.away || {};

  // momentum: index gives number[]; rich gives [{minute,valueNorm}]
  let mom = [];
  if (Array.isArray(m.momentum)) {
    if (m.momentum.length && typeof m.momentum[0] === 'object') {
      mom = m.momentum.map((d) => ({
        minute: Number(d.minute) || 0,
        v: Number(d.valueNorm) || 0,
      }));
    } else {
      // index form: evenly map index -> minute later; keep raw values
      mom = m.momentum.map((v, i) => ({ idx: i, v: Number(v) || 0 }));
    }
  }

  // goals: index gives goals[]; rich derives from shots
  let goals = [];
  if (Array.isArray(m.goals)) {
    goals = m.goals.map((g) => ({ minute: Number(g.minute) || 0, team: g.team, player: g.player || '' }));
  } else if (Array.isArray(m.shots)) {
    goals = m.shots.filter((s) => s.isGoal)
      .map((s) => ({ minute: Number(s.minute) || 0, team: s.team, player: s.player || '' }));
  }

  // shots: only present on rich (index has shotCount only) — optional layer
  let shots = [];
  if (Array.isArray(m.shots)) {
    shots = m.shots.map((s) => ({ minute: Number(s.minute) || 0, team: s.team, xg: Number(s.xg) || 0 }));
  }

  return {
    homeColor: home.colorHex || '#6cf',
    awayColor: away.colorHex || '#f96',
    mom, goals, shots,
  };
}

// Catmull-Rom -> cubic bezier smoothing through points [{x,y}].
function smoothPath(pts) {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

export function fingerprintSVG(match, opts = {}) {
  const w = opts.w || 440;
  const h = opts.h || 150;
  const padX = opts.padX != null ? opts.padX : 10;
  const padY = opts.padY != null ? opts.padY : 14;
  const { homeColor, awayColor, mom, goals, shots } = normalize(match);

  const mid = h / 2;
  const x0 = padX;
  const x1 = w - padX;
  const innerW = x1 - x0;
  const halfH = mid - padY; // vertical reach above/below midline for ribbon

  // duration = last momentum minute (~93), fallback to 93.
  let duration = 93;
  if (mom.length && mom[0].minute != null) {
    duration = mom[mom.length - 1].minute || 93;
  }
  if (duration <= 0) duration = 93;

  const minuteToX = (min) => x0 + (Math.max(0, Math.min(duration, min)) / duration) * innerW;
  // For index-form momentum we map evenly across the width.
  const momX = (d, i) => (d.minute != null ? minuteToX(d.minute) : x0 + (i / Math.max(1, mom.length - 1)) * innerW);

  // ribbon amplitude scale: valueNorm in -1..1
  const ribH = halfH * 0.78;

  const parts = [];
  parts.push(`<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" font-family="Barlow, sans-serif">`);

  // --- 45' halftime dashed line ---
  const xHalf = minuteToX(45);
  parts.push(`<line x1="${xHalf.toFixed(1)}" y1="${padY * 0.5}" x2="${xHalf.toFixed(1)}" y2="${(h - padY * 0.5).toFixed(1)}" stroke="rgba(255,255,255,0.18)" stroke-width="1" stroke-dasharray="3 4"/>`);

  // --- momentum ribbon (split home-up / away-down) ---
  if (mom.length >= 2) {
    const pts = mom.map((d, i) => ({ x: momX(d, i), y: mid - d.v * ribH, v: d.v }));

    // HOME area = portion above midline (clamp values to >=0 baseline at mid)
    const homePts = mom.map((d, i) => ({ x: momX(d, i), y: mid - Math.max(0, d.v) * ribH }));
    const awayPts = mom.map((d, i) => ({ x: momX(d, i), y: mid - Math.min(0, d.v) * ribH }));

    const homeArea = smoothPath(homePts) + ` L ${x1.toFixed(2)} ${mid} L ${x0.toFixed(2)} ${mid} Z`;
    const awayArea = smoothPath(awayPts) + ` L ${x1.toFixed(2)} ${mid} L ${x0.toFixed(2)} ${mid} Z`;

    parts.push(`<path d="${homeArea}" fill="${esc(homeColor)}" fill-opacity="0.5"/>`);
    parts.push(`<path d="${awayArea}" fill="${esc(awayColor)}" fill-opacity="0.5"/>`);
    // crisp full momentum line for definition
    parts.push(`<path d="${smoothPath(pts)}" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="1"/>`);
  }

  // --- midline (neutral) ---
  parts.push(`<line x1="${x0}" y1="${mid}" x2="${x1}" y2="${mid}" stroke="rgba(255,255,255,0.45)" stroke-width="1.25"/>`);

  // --- shot ticks (subtle, secondary) ---
  for (const s of shots) {
    const x = minuteToX(s.minute);
    const up = s.team === 'home';
    const len = 4 + Math.min(10, (s.xg || 0) * 22);
    const op = (0.12 + Math.min(0.5, (s.xg || 0) * 1.4)).toFixed(2);
    const col = up ? homeColor : awayColor;
    const y2 = up ? mid - len : mid + len;
    parts.push(`<line x1="${x.toFixed(1)}" y1="${mid}" x2="${x.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${esc(col)}" stroke-width="1" stroke-opacity="${op}"/>`);
  }

  // --- goal peaks (the key element) ---
  const spikeTop = padY * 0.7;          // home spike reaches near top
  const spikeBot = h - padY * 0.7;      // away spike reaches near bottom
  for (const g of goals) {
    const x = minuteToX(g.minute);
    const up = g.team === 'home';
    const col = up ? homeColor : awayColor;
    const tipY = up ? spikeTop : spikeBot;
    // spike
    parts.push(`<line x1="${x.toFixed(1)}" y1="${mid}" x2="${x.toFixed(1)}" y2="${tipY.toFixed(1)}" stroke="${esc(col)}" stroke-width="2"/>`);
    // glow underlay
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${tipY.toFixed(1)}" r="7" fill="${esc(col)}" fill-opacity="0.22"/>`);
    // cap
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${tipY.toFixed(1)}" r="4" fill="${esc(col)}" stroke="#04050a" stroke-width="0.75"/>`);
    // minute label near cap
    const labelY = up ? tipY + 12 : tipY - 7;
    parts.push(`<text x="${x.toFixed(1)}" y="${labelY.toFixed(1)}" fill="rgba(255,255,255,0.85)" font-size="9" font-weight="600" text-anchor="middle">${g.minute}'</text>`);
  }

  parts.push(`</svg>`);
  return parts.join('');
}

export default fingerprintSVG;
