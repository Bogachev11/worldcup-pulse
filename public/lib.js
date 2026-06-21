// lib.js — shared helpers + the "Territory" drawing primitive used by BOTH the
// macro fingerprint cells and the micro full-screen replay. Pure functions, no
// global state, so monument.js and match.js can both import them.

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

// Mild deterministic hash → [0,1). Used only for placement jitter / texture.
export function hash01(n) {
  let x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// Safely read a momentum value, guarding against NaN / out-of-range.
export function momAt(series, t) {
  if (!series || series.length === 0) return 0;
  if (series.length === 1) return clamp(series[0].v || 0, -1, 1);
  // series is sampled by match-minute t; find bracketing samples and lerp.
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

// Largest match-minute referenced by the fingerprint (clock length).
export function matchDuration(fp) {
  let d = 90;
  const s = fp?.momentumSeries;
  if (s && s.length) d = Math.max(d, s[s.length - 1].t || 90);
  for (const arr of [fp?.goals, fp?.reds, fp?.yellows, fp?.penalties]) {
    if (arr) for (const e of arr) if (Number.isFinite(e.t)) d = Math.max(d, e.t);
  }
  return d;
}

// ---------------------------------------------------------------------------
// drawTerritory — the visual signature. Renders into ctx within the rect
// (x,y,w,h). Home color emanates from the left, away from the right; the
// dividing FRONT is the momentum membrane. Events up to `revealT` (match-min)
// are rendered: goals = light strikes, reds = burn notches, yellows = cracks,
// penalties = focal marks.
//
// opts: {
//   home:{rgb}, away:{rgb}, fp (fingerprint),
//   revealT      — reveal events/membrane up to this match-minute (default ∞)
//   intensity    — 0..1 overall luminance (macro cells dimmer than micro)
//   detail       — points sampled along the membrane (macro low, micro high)
//   scarStrength — 0..1 how strongly past goals leave faint scars
//   showFloor    — draw subtle base territory fill (true for cells & micro)
// }
// ctx is expected with globalCompositeOperation already 'source-over' on entry;
// this fn flips to 'lighter' for glow and restores 'source-over' before return.
// ---------------------------------------------------------------------------
export function drawTerritory(ctx, x, y, w, h, opts) {
  const fp = opts.fp || {};
  const series = fp.momentumSeries || [];
  const home = opts.home?.rgb || { r: 90, g: 150, b: 255 };
  const away = opts.away?.rgb || { r: 255, g: 120, b: 60 };
  const revealT = opts.revealT == null ? Infinity : opts.revealT;
  const intensity = clamp(opts.intensity ?? 0.5, 0, 1);
  const detail = Math.max(8, opts.detail || 36);
  const showFloor = opts.showFloor !== false;

  if (w <= 0 || h <= 0) return;

  const dur = matchDuration(fp);
  // duration of the visible window so the membrane fills the cell width
  const winEnd = Math.min(revealT, dur);

  // membrane x for a given match-minute t (mapped to [x, x+w])
  const frontX = (t) => {
    const v = momAt(series, t);            // [-1,1]; + = home pressing right
    const f = 0.5 + clamp(v, -1, 1) * 0.42; // keep margins so colors persist
    return x + clamp(f, 0.06, 0.94) * w;
  };

  // sample the front as a wavering vertical membrane down the cell height.
  // Each vertical position samples a slightly different match-minute so the
  // membrane reads as a time-layered field (top = early, bottom = late window).
  const pts = [];
  for (let i = 0; i <= detail; i++) {
    const vy = i / detail;
    const t = winEnd * vy;
    let fx = frontX(t);
    if (!Number.isFinite(fx)) fx = x + w * 0.5;
    pts.push({ x: fx, y: y + vy * h });
  }

  ctx.save();
  // clip to the cell so glows stay local
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  // ---- base territory floor (additive, soft) ----
  if (showFloor) {
    ctx.globalCompositeOperation = 'lighter';
    // home half
    const gh = ctx.createLinearGradient(x, 0, x + w, 0);
    gh.addColorStop(0, rgbStr(home, 0.20 * intensity));
    gh.addColorStop(0.55, rgbStr(home, 0.05 * intensity));
    gh.addColorStop(1, rgbStr(home, 0));
    ctx.fillStyle = gh;
    ctx.fillRect(x, y, w, h);
    const ga = ctx.createLinearGradient(x + w, 0, x, 0);
    ga.addColorStop(0, rgbStr(away, 0.20 * intensity));
    ga.addColorStop(0.55, rgbStr(away, 0.05 * intensity));
    ga.addColorStop(1, rgbStr(away, 0));
    ctx.fillStyle = ga;
    ctx.fillRect(x, y, w, h);
  }

  // ---- glowing membrane path ----
  ctx.globalCompositeOperation = 'lighter';
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    ctx.quadraticCurveTo(a.x, a.y, mx, my);
  }
  ctx.lineWidth = Math.max(0.6, h * 0.006);
  ctx.strokeStyle = `rgba(255,255,255,${0.5 * intensity})`;
  ctx.shadowColor = `rgba(255,255,255,${0.6 * intensity})`;
  ctx.shadowBlur = Math.max(2, w * 0.02);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // ---- event marks ----
  const evY = (t) => y + clamp(t / (winEnd || 1), 0, 1) * h; // vertical position by minute

  // helper: where on the front is this team attacking toward
  const strikeX = (team, fx) =>
    team === 'home' ? clamp(fx + w * 0.22, x, x + w) : clamp(fx - w * 0.22, x, x + w);

  // penalties = converging focal point
  for (const p of fp.penalties || []) {
    if (!(p.t <= revealT)) continue;
    const fx = frontX(p.t), py = evY(p.t);
    const px = strikeX(p.team, fx);
    const col = p.team === 'home' ? home : away;
    const r = Math.max(4, w * 0.06);
    const g = ctx.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, rgbStr(p.scored ? { r: 255, g: 240, b: 200 } : col, 0.7 * intensity));
    g.addColorStop(1, rgbStr(col, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
  }

  // yellows = small cracks / flashes
  for (const yc of fp.yellows || []) {
    if (!(yc.t <= revealT)) continue;
    const fx = frontX(yc.t), py = evY(yc.t);
    ctx.strokeStyle = `rgba(255,210,60,${0.45 * intensity})`;
    ctx.lineWidth = Math.max(0.6, w * 0.006);
    ctx.beginPath();
    const len = Math.max(3, w * 0.05);
    ctx.moveTo(fx - len, py - len * 0.4);
    ctx.lineTo(fx + len, py + len * 0.4);
    ctx.stroke();
  }

  // goals = bright piercing light strike lancing at the attack direction
  for (const gl of fp.goals || []) {
    if (!(gl.t <= revealT)) continue;
    const fx = frontX(gl.t), gy = evY(gl.t);
    const dir = gl.team === 'home' ? 1 : -1;     // home lances rightward
    const tipX = clamp(fx + dir * w * 0.4, x, x + w);
    const age = clamp((revealT - gl.t) / 12, 0, 1); // fresh strikes brightest
    const fresh = 1 - age;
    // beam
    const grad = ctx.createLinearGradient(fx, gy, tipX, gy);
    grad.addColorStop(0, `rgba(255,240,200,${(0.25 + 0.55 * fresh) * intensity})`);
    grad.addColorStop(1, 'rgba(255,240,200,0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = Math.max(1.2, h * 0.02 * (0.5 + fresh));
    ctx.shadowColor = 'rgba(255,235,180,0.9)';
    ctx.shadowBlur = Math.max(3, w * 0.05 * (0.4 + fresh));
    ctx.beginPath();
    ctx.moveTo(fx, gy);
    ctx.lineTo(tipX, gy);
    ctx.stroke();
    ctx.shadowBlur = 0;
    // bright core flare at origin (leaves a faint scar via low alpha)
    const fr = Math.max(2, w * 0.05) * (0.5 + 0.8 * fresh) + 1;
    const fg = ctx.createRadialGradient(fx, gy, 0, fx, gy, fr);
    fg.addColorStop(0, `rgba(255,250,230,${(0.3 + 0.6 * fresh) * intensity})`);
    fg.addColorStop(1, 'rgba(255,250,230,0)');
    ctx.fillStyle = fg;
    ctx.beginPath(); ctx.arc(fx, gy, fr, 0, Math.PI * 2); ctx.fill();
  }

  // reds = dark burn notch eating into the carded team's territory
  if ((fp.reds || []).length) {
    ctx.globalCompositeOperation = 'source-over';
    for (const rc of fp.reds) {
      if (!(rc.t <= revealT)) continue;
      const fx = frontX(rc.t), ry = evY(rc.t);
      // carded team loses mass: burn sits on their side
      const dir = rc.team === 'home' ? -1 : 1;
      const bx = clamp(fx + dir * w * 0.16, x, x + w);
      const r = Math.max(5, w * 0.1);
      const g = ctx.createRadialGradient(bx, ry, 0, bx, ry, r);
      g.addColorStop(0, 'rgba(0,0,0,0.85)');
      g.addColorStop(0.6, 'rgba(20,0,0,0.55)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(bx, ry, r, 0, Math.PI * 2); ctx.fill();
      // ember rim
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(255,70,40,${0.5 * intensity})`;
      ctx.lineWidth = Math.max(0.8, w * 0.01);
      ctx.beginPath(); ctx.arc(bx, ry, r * 0.6, 0, Math.PI * 2); ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
}
