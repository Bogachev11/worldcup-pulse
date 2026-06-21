// lib.js — shared helpers for the RICH World Cup Pulse rebuild.
// Pure functions + coordinate normalization + offscreen-cache fingerprint render.
// No global state, so app.js / monument.js / match.js all import from here.

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
export function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function hexToRgb(hex) {
  if (typeof hex !== 'string') return { r: 200, g: 200, b: 200 };
  const h = hex.replace('#', '').trim();
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(s, 16);
  if (Number.isNaN(n) || s.length < 6) return { r: 200, g: 200, b: 200 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
export const rgbStr = (c, a = 1) => `rgba(${c.r | 0},${c.g | 0},${c.b | 0},${a})`;

// Relative luminance 0..1 of an rgb.
export function lumOf(c) {
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
}

// If a color is near-black it disappears on the dark canvas. Lift it toward a
// luminous tint while keeping its hue, so both team colors stay visible.
export function liftColor(c, minLum = 0.30) {
  const l = lumOf(c);
  if (l >= minLum) return c;
  // scale up toward white-ish but preserve relative channel balance
  const boost = (minLum + 0.12) / Math.max(l, 0.02);
  return {
    r: clamp(c.r * boost + 40, 0, 255),
    g: clamp(c.g * boost + 40, 0, 255),
    b: clamp(c.b * boost + 40, 0, 255),
  };
}

export function hash01(n) {
  let x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// ---------------------------------------------------------------------------
// COORDINATE NORMALIZATION (the careful part)
//
// Empirically determined from the data on disk:
//  * SHOTS (FotMob): recorded in an ATTACKING frame — x is distance toward the
//    goal being attacked for BOTH teams (both cluster at x ~ 80-100). So on a
//    shared pitch where HOME attacks LEFT->RIGHT: home shot keeps (x,y); away
//    shot is mirrored to (100-x, 100-y) so it attacks the other goal.
//  * PASSES (WhoScored): recorded in an ABSOLUTE pitch frame (x,y full 0-100),
//    home attacking right by convention; away is already in the opposite
//    direction within the same absolute frame — no per-team mirror needed.
//
// Output frame for BOTH layers: x in [0,1] left->right with HOME goal at x=0,
// AWAY goal at x=1; home attacks toward x=1. y in [0,1] top->bottom.
// ---------------------------------------------------------------------------

// Normalize a pass to unit pitch [0,1]x[0,1]. Absolute frame -> direct map.
export function normPass(p) {
  return {
    x0: clamp(p.x / 100, 0, 1),
    y0: clamp(p.y / 100, 0, 1),
    x1: clamp(p.endX / 100, 0, 1),
    y1: clamp(p.endY / 100, 0, 1),
    team: p.team,
    ok: p.outcome === 'Successful',
    minute: p.minute,
  };
}

// Normalize a shot to unit pitch. Attacking frame -> away mirrored.
export function normShot(s) {
  let x = s.x / 100, y = s.y / 100;
  if (s.team === 'away') { x = 1 - x; y = 1 - y; }
  return {
    x: clamp(x, 0, 1),
    y: clamp(y, 0, 1),
    team: s.team,
    xg: Number.isFinite(s.xg) ? s.xg : 0,
    xgot: Number.isFinite(s.xgot) ? s.xgot : 0,
    isGoal: !!s.isGoal,
    type: s.type || '',
    situation: s.situation || '',
    minute: s.minute,
    player: s.player || '',
  };
}

// Normalize a momentum series to [-1,1] (+ = home). Uses provided valueNorm if
// present & sane, else normalizes by the series max-abs.
export function normMomentum(series) {
  if (!Array.isArray(series) || series.length === 0) return [];
  let maxAbs = 0;
  for (const m of series) {
    const v = Number(m.value);
    if (Number.isFinite(v)) maxAbs = Math.max(maxAbs, Math.abs(v));
  }
  if (maxAbs <= 0) maxAbs = 1;
  return series.map((m) => {
    let v = Number(m.valueNorm);
    if (!Number.isFinite(v)) v = Number(m.value) / maxAbs;
    if (!Number.isFinite(v)) v = 0;
    return { t: Number(m.minute) || 0, v: clamp(v, -1, 1) };
  });
}

// Sample a normalized momentum series at minute t.
export function momAt(series, t) {
  if (!series || series.length === 0) return 0;
  if (series.length === 1) return clamp(series[0].v || 0, -1, 1);
  const last = series[series.length - 1];
  if (t <= series[0].t) return clamp(series[0].v || 0, -1, 1);
  if (t >= last.t) return clamp(last.v || 0, -1, 1);
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1], b = series[i];
    if (t <= b.t) {
      const span = (b.t - a.t) || 1;
      const f = clamp((t - a.t) / span, 0, 1);
      const v = lerp(a.v || 0, b.v || 0, f);
      return clamp(Number.isFinite(v) ? v : 0, -1, 1);
    }
  }
  return clamp(last.v || 0, -1, 1);
}

// Latest minute referenced anywhere in a rich match (the clock length).
export function richDuration(m) {
  let d = 90;
  const consider = (arr, key) => {
    if (!Array.isArray(arr)) return;
    for (const e of arr) { const t = Number(e[key]); if (Number.isFinite(t)) d = Math.max(d, t); }
  };
  consider(m.momentum, 'minute');
  consider(m.shots, 'minute');
  consider(m.passes, 'minute');
  return Math.ceil(d);
}

// Prepare a rich match once: normalize all layers into the shared frame and
// presort by minute. Returns a derived object the views consume.
export function prepareMatch(m) {
  const passes = (m.passes || [])
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.endX))
    .map(normPass)
    .sort((a, b) => a.minute - b.minute);
  const shots = (m.shots || [])
    .filter((s) => Number.isFinite(s.x))
    .map(normShot)
    .sort((a, b) => a.minute - b.minute);
  const momentum = normMomentum(m.momentum);
  const home = { ...(m.home || {}), rgb: liftColor(hexToRgb(m.home?.colorHex)) };
  const away = { ...(m.away || {}), rgb: liftColor(hexToRgb(m.away?.colorHex)) };
  return {
    matchId: m.matchId, date: m.date, round: m.round, group: m.group,
    home, away, passes, shots, momentum,
    duration: richDuration(m),
  };
}

// ---------------------------------------------------------------------------
// FINGERPRINT — a dense luminous miniature of one match, rendered ONCE into an
// offscreen canvas (DPR-aware) and blitted thereafter. Encodes: subsampled
// pass-flow geometry, the momentum membrane, and shot/xG blooms, in both team
// colors. Soft-edged & additive so cells bleed into one field (anti-grid).
//
// `progress` 0..1 = fraction of the match revealed (drives macro time scrubber
// at BUILD time; we bake a few discrete levels and pick the nearest — see
// monument.js). Here we just render the full thing at a given progress.
// ---------------------------------------------------------------------------
export function buildFingerprint(prep, sizeCss, dpr, progress = 1) {
  const cv = document.createElement('canvas');
  const s = Math.max(8, Math.round(sizeCss * dpr));
  cv.width = s; cv.height = s;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  drawFingerprint(ctx, sizeCss, prep, progress);
  return cv;
}

// Draw a fingerprint into ctx occupying [0,0,size,size]. No shadowBlur (baked
// glow via radial gradients only). Passes are subsampled for speed.
export function drawFingerprint(ctx, size, prep, progress = 1) {
  const home = prep.home.rgb, away = prep.away.rgb;
  const dur = prep.duration || 90;
  const revealT = clamp(progress, 0, 1) * dur;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  // --- soft territory floor (two colors bleeding from each side) ---
  const gh = ctx.createRadialGradient(size * 0.18, size * 0.5, 0, size * 0.18, size * 0.5, size * 0.95);
  gh.addColorStop(0, rgbStr(home, 0.16));
  gh.addColorStop(1, rgbStr(home, 0));
  ctx.fillStyle = gh; ctx.fillRect(0, 0, size, size);
  const ga = ctx.createRadialGradient(size * 0.82, size * 0.5, 0, size * 0.82, size * 0.5, size * 0.95);
  ga.addColorStop(0, rgbStr(away, 0.16));
  ga.addColorStop(1, rgbStr(away, 0));
  ctx.fillStyle = ga; ctx.fillRect(0, 0, size, size);

  // --- subsampled pass-flow geometry (the dance of lines, miniaturized) ---
  // Cap the number drawn so cache build stays fast even with ~1000 passes.
  const MAXP = 150;
  const passes = prep.passes.filter((p) => p.minute <= revealT);
  const step = Math.max(1, Math.ceil(passes.length / MAXP));
  ctx.lineCap = 'round';
  for (let i = 0; i < passes.length; i += step) {
    const p = passes[i];
    const col = p.team === 'home' ? home : away;
    const a = p.ok ? 0.16 : 0.06;
    ctx.strokeStyle = rgbStr(col, a);
    ctx.lineWidth = p.ok ? 0.8 : 0.5;
    ctx.beginPath();
    ctx.moveTo(p.x0 * size, p.y0 * size);
    ctx.lineTo(p.x1 * size, p.y1 * size);
    ctx.stroke();
  }

  // --- momentum membrane: a soft vertical front, time-layered top->bottom ---
  ctx.beginPath();
  const detail = 24;
  for (let i = 0; i <= detail; i++) {
    const vy = i / detail;
    const t = revealT * vy;
    const v = momAt(prep.momentum, t);          // [-1,1]
    const fx = (0.5 + v * 0.40) * size;
    if (i === 0) ctx.moveTo(fx, vy * size);
    else ctx.lineTo(fx, vy * size);
  }
  ctx.strokeStyle = `rgba(255,255,255,0.22)`;
  ctx.lineWidth = Math.max(0.6, size * 0.006);
  ctx.stroke();

  // --- shot / xG blooms at real coords; goals brighter & piercing ---
  for (const sh of prep.shots) {
    if (sh.minute > revealT) continue;
    const col = sh.team === 'home' ? home : away;
    const cx = sh.x * size, cy = sh.y * size;
    const r = Math.max(2, (2 + sh.xg * 26) * (size / 120));
    if (sh.isGoal) {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 2.4);
      g.addColorStop(0, 'rgba(255,248,220,0.85)');
      g.addColorStop(0.4, rgbStr(col, 0.45));
      g.addColorStop(1, rgbStr(col, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, r * 2.4, 0, Math.PI * 2); ctx.fill();
    } else {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, rgbStr(col, 0.5));
      g.addColorStop(1, rgbStr(col, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    }
  }

  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
}

// Running xG sum for a team up to minute t.
export function xgUpTo(shots, team, t) {
  let s = 0;
  for (const sh of shots) { if (sh.team === team && sh.minute <= t) s += sh.xg; }
  return s;
}
