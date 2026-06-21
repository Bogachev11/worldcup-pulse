// claybattle.js — self-contained helpers for stage2 ("BATTLE OF MASSES").
// Pure functions only: color parsing, clamp/lerp, a deterministic value-noise
// field with fbm octaves, and the per-minute data-series builders that drive the
// heightfield simulation. No three.js, no DOM, no globals.
//
// Everything here is COPIED/adapted from lib.js / stage.js conventions so that
// stage2 stays independent of the existing pipeline files.

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / ((e1 - e0) || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

// ---- color (copied from lib.js) ----------------------------------------------
export function hexToRgb(hex) {
  if (typeof hex !== 'string') return { r: 200, g: 200, b: 200 };
  const h = hex.replace('#', '').trim();
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(s, 16);
  if (Number.isNaN(n) || s.length < 6) return { r: 200, g: 200, b: 200 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
export function lumOf(c) { return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255; }
// Lift near-black team colors so they read on the dark scene (from lib.js).
export function liftColor(c, minLum = 0.28) {
  const l = lumOf(c);
  if (l >= minLum) return c;
  const boost = (minLum + 0.12) / Math.max(l, 0.02);
  return {
    r: clamp(c.r * boost + 30, 0, 255),
    g: clamp(c.g * boost + 30, 0, 255),
    b: clamp(c.b * boost + 30, 0, 255),
  };
}
export const rgb01 = (c) => [c.r / 255, c.g / 255, c.b / 255];

// ---- deterministic value noise + fbm -----------------------------------------
// Cheap, allocation-free 3D value noise (x,y over the field; z = animated flow).
function hash3(x, y, z) {
  let h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const c000 = hash3(xi, yi, zi), c100 = hash3(xi + 1, yi, zi);
  const c010 = hash3(xi, yi + 1, zi), c110 = hash3(xi + 1, yi + 1, zi);
  const c001 = hash3(xi, yi, zi + 1), c101 = hash3(xi + 1, yi, zi + 1);
  const c011 = hash3(xi, yi + 1, zi + 1), c111 = hash3(xi + 1, yi + 1, zi + 1);
  const x00 = lerp(c000, c100, u), x10 = lerp(c010, c110, u);
  const x01 = lerp(c001, c101, u), x11 = lerp(c011, c111, u);
  const y0 = lerp(x00, x10, v), y1 = lerp(x01, x11, v);
  return lerp(y0, y1, w) * 2 - 1; // [-1,1]
}
// Fractal sum of octaves → in [-1,1] roughly.
export function fbm(x, y, z, octaves = 4) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * vnoise(x * freq, y * freq, z * freq);
    norm += amp; amp *= 0.5; freq *= 2.07;
  }
  return sum / (norm || 1);
}

// ---- momentum series → [-1,1] sampler (adapted from lib.js normMomentum/momAt)
export function normMomentum(series) {
  if (!Array.isArray(series) || series.length === 0) return [];
  let maxAbs = 0;
  for (const m of series) { const v = Number(m.value); if (Number.isFinite(v)) maxAbs = Math.max(maxAbs, Math.abs(v)); }
  if (maxAbs <= 0) maxAbs = 1;
  return series.map((m) => {
    let v = Number(m.valueNorm);
    if (!Number.isFinite(v)) v = Number(m.value) / maxAbs;
    if (!Number.isFinite(v)) v = 0;
    return { t: Number(m.minute) || 0, v: clamp(v, -1, 1) };
  }).sort((a, b) => a.t - b.t);
}
export function sampleSeries(series, t) {
  if (!series || series.length === 0) return 0;
  if (series.length === 1) return series[0].v || 0;
  const last = series[series.length - 1];
  if (t <= series[0].t) return series[0].v || 0;
  if (t >= last.t) return last.v || 0;
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1], b = series[i];
    if (t <= b.t) {
      const f = clamp((t - a.t) / ((b.t - a.t) || 1), 0, 1);
      const r = lerp(a.v || 0, b.v || 0, f);
      return Number.isFinite(r) ? r : 0;
    }
  }
  return last.v || 0;
}

// Latest minute referenced anywhere (clock length) — from lib.js richDuration.
export function richDuration(m) {
  let d = 90;
  const consider = (arr, key) => {
    if (!Array.isArray(arr)) return;
    for (const e of arr) { const t = Number(e[key]); if (Number.isFinite(t)) d = Math.max(d, t); }
  };
  consider(m.momentum, 'minute');
  consider(m.shots, 'minute');
  consider(m.passes, 't');
  consider(m.events, 't');
  return Math.ceil(d);
}

// Normalize a shot to unit pitch (home goal x=0, away goal x=1; home attacks
// toward x=1). Shots are in an attacking frame → mirror away (from lib.js).
export function normShot(s) {
  let x = s.x / 100, y = s.y / 100;
  if (s.team === 'away') { x = 1 - x; y = 1 - y; }
  return {
    x: clamp(x, 0, 1), y: clamp(y, 0, 1), team: s.team,
    xg: Number.isFinite(s.xg) ? s.xg : 0,
    xgot: Number.isFinite(s.xgot) ? s.xgot : 0,
    isGoal: !!s.isGoal, type: s.type || '',
    minute: Number(s.minute) || 0,
    t: Number.isFinite(s.t) ? s.t : (Number(s.minute) || 0),
  };
}

// ---- build the full driving model from a raw rich match ----------------------
// Returns per-step series (step = 0.5 min) plus cumulative integrals, all
// normalized to convenient ranges, plus the discrete goal/shot eruption list.
export function buildModel(raw) {
  const duration = richDuration(raw);
  const STEP = 0.5;
  const N = Math.max(2, Math.round(duration / STEP) + 1);
  const timeAt = (i) => i * STEP;

  const momentum = normMomentum(raw.momentum);

  const passes = (raw.passes || []).filter((p) => Number.isFinite(p.t || p.minute))
    .map((p) => ({ t: Number.isFinite(p.t) ? p.t : p.minute, team: p.team }));
  const events = (raw.events || []).filter((e) => Number.isFinite(e.t || e.minute))
    .map((e) => ({ t: Number.isFinite(e.t) ? e.t : e.minute }));
  const shots = (raw.shots || []).filter((s) => Number.isFinite(s.x)).map(normShot)
    .sort((a, b) => a.t - b.t);

  // --- possHome(t): rolling home pass-share in ±4min window (from stage.js) ---
  const POSS_WIN = 4;
  const possHome = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const m = timeAt(i);
    let h = 0, a = 0;
    for (const p of passes) { if (Math.abs(p.t - m) <= POSS_WIN) { if (p.team === 'home') h++; else a++; } }
    possHome[i] = (h + a) > 0 ? h / (h + a) : 0.5;
  }

  // --- intensity(t): event rate in ±1min window, normalized to match max -----
  const INT_WIN = 1;
  const allTimes = [];
  for (const p of passes) allTimes.push(p.t);
  for (const e of events) allTimes.push(e.t);
  for (const s of shots) allTimes.push(s.t);
  allTimes.sort((a, b) => a - b);
  const intensityRaw = new Float32Array(N);
  let maxCount = 1;
  // two-pointer window count over sorted times
  let lo = 0, hi = 0;
  for (let i = 0; i < N; i++) {
    const m = timeAt(i), a = m - INT_WIN, b = m + INT_WIN;
    while (lo < allTimes.length && allTimes[lo] < a) lo++;
    if (hi < lo) hi = lo;
    while (hi < allTimes.length && allTimes[hi] <= b) hi++;
    const c = hi - lo;
    intensityRaw[i] = c;
    if (c > maxCount) maxCount = c;
  }
  const intensity = new Float32Array(N);
  for (let i = 0; i < N; i++) intensity[i] = clamp(intensityRaw[i] / maxCount, 0, 1);

  // --- momentum sampled per step ---------------------------------------------
  const mom = new Float32Array(N);
  for (let i = 0; i < N; i++) mom[i] = sampleSeries(momentum, timeAt(i));

  // --- cumulative integrals (normalized to [-1,1] or [0,1]) ------------------
  const cumMom = new Float32Array(N);     // signed: + = home accumulated control
  const cumPossHome = new Float32Array(N);
  const cumPossAway = new Float32Array(N);
  const cumStress = new Float32Array(N);  // ridge battle stress
  let accMom = 0, accPH = 0, accPA = 0, accStress = 0;
  for (let i = 0; i < N; i++) {
    accMom += mom[i] * STEP;
    accPH += possHome[i] * STEP;
    accPA += (1 - possHome[i]) * STEP;
    accStress += intensity[i] * (1 - Math.abs(mom[i])) * STEP;
    cumMom[i] = accMom; cumPossHome[i] = accPH; cumPossAway[i] = accPA; cumStress[i] = accStress;
  }
  // normalize cumulatives by their final magnitude
  const fMom = Math.max(1e-3, Math.max(...cumMomAbsMax(cumMom)));
  const fPH = Math.max(1e-3, accPH), fPA = Math.max(1e-3, accPA);
  const fStress = Math.max(1e-3, accStress);
  for (let i = 0; i < N; i++) {
    cumMom[i] = clamp(cumMom[i] / fMom, -1, 1);
    cumPossHome[i] /= fPH; cumPossAway[i] /= fPA;
    cumStress[i] /= fStress;
  }

  // --- eruptions list (goals + shots) ----------------------------------------
  // goal: big, permanent surge + frontline shove. shot: small transient ∝ xG.
  const eruptions = shots.map((s) => ({
    t: s.t, team: s.team, x: s.x, y: s.y, xg: s.xg, isGoal: s.isGoal,
  }));

  return {
    duration, STEP, N, timeAt,
    home: { ...(raw.home || {}), rgb: liftColor(hexToRgb(raw.home?.colorHex)) },
    away: { ...(raw.away || {}), rgb: liftColor(hexToRgb(raw.away?.colorHex)) },
    series: { mom, possHome, intensity, cumMom, cumPossHome, cumPossAway, cumStress },
    eruptions, shots,
  };
}
function cumMomAbsMax(arr) { let m = 0; for (let i = 0; i < arr.length; i++) m = Math.max(m, Math.abs(arr[i])); return [m]; }

// Sample any per-step Float32Array at continuous match-time t (linear interp).
export function at(arr, t, STEP) {
  if (!arr || !arr.length) return 0;
  const f = clamp(t / STEP, 0, arr.length - 1);
  const i = Math.floor(f), j = Math.min(i + 1, arr.length - 1);
  return lerp(arr[i], arr[j], f - i);
}

// xG sum for a team up to time t.
export function xgUpTo(shots, team, t) {
  let s = 0; for (const sh of shots) { if (sh.team === team && sh.t <= t) s += sh.xg; } return s;
}
