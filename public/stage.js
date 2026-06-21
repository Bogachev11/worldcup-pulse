// stage.js — ISOMETRIC 3D polishing stage for ONE match (default France–Senegal,
// id 1953888). Minimalist iso projection of the pitch. Every event sits at
// (x, y, z) where z = the acting team's POSSESSION SHARE at that moment (derived
// live from the real pass stream). Passes & shots accumulate for the whole match
// and gradually fade with age (never fully gone). Successful vs unsuccessful, and
// accurate vs inaccurate shots, use distinct hues.
//
// Macro monument is untouched. Pure Canvas 2D iso math — no three.js.

import { clamp, lerp, prepareMatch, momAt, xgUpTo, rgbStr } from './lib.js';

const ID = new URLSearchParams(location.search).get('id') || '1953888';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const el = (id) => document.getElementById(id);

let W = 0, H = 0, dpr = 1;
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth || 1; H = window.innerHeight || 1;
  canvas.width = Math.max(1, Math.round(W * dpr));
  canvas.height = Math.max(1, Math.round(H * dpr));
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);

// ---- state ----
let prep = null;            // normalized match
let possSeries = null;      // per-minute home-possession share [0..1]
let clock = 0;              // current match-minute
let playing = true;
let speed = Number(el('speed').value);
let fade = Number(el('fade').value);
let zScale = Number(el('zscale').value);
let pwin = Number(el('pwin').value);

// ---- possession (real-data derived): rolling home pass-share per minute ----
function buildPossession(passes, duration, win) {
  const n = Math.ceil(duration) + 1;
  const out = new Array(n).fill(0.5);
  for (let m = 0; m < n; m++) {
    let h = 0, a = 0;
    for (const p of passes) {
      if (Math.abs(p.minute - m) <= win) { if (p.team === 'home') h++; else a++; }
    }
    out[m] = (h + a) > 0 ? h / (h + a) : 0.5;
  }
  return out;
}
function possHomeAt(t) {
  if (!possSeries || !possSeries.length) return 0.5;
  const i = clamp(Math.floor(t), 0, possSeries.length - 1);
  const j = Math.min(i + 1, possSeries.length - 1);
  return lerp(possSeries[i], possSeries[j], clamp(t - i, 0, 1));
}
// z for an event of `team` at minute t = that team's possession share (0..1)
function zFor(team, t) {
  const h = possHomeAt(t);
  return team === 'home' ? h : 1 - h;
}

// ---- isometric projection ----
// pitch units: x,y in [0,1] (x=length home->away goal, y=width), z in [0,1].
const ISO = Math.PI / 6; // 30°
const COSA = Math.cos(ISO), SINA = Math.sin(ISO);
let P = { cx: 0, cy: 0, len: 1, wid: 1, ht: 1 };
function computeProjection() {
  const s = Math.min(W * 0.62, H * 1.05);
  P.len = s;            // along x (pitch length)
  P.wid = s * 0.64;     // along y (pitch width)
  P.ht = s * 0.42 * zScale; // max vertical lift for z=1
  P.cx = W / 2;
  P.cy = H * 0.60;      // sit pitch a bit low to leave headroom for height
}
function proj(x, y, z) {
  const wx = (x - 0.5) * P.len, wy = (y - 0.5) * P.wid, wz = z * P.ht;
  return [P.cx + (wx - wy) * COSA, P.cy + (wx + wy) * SINA - wz];
}

// ---- colors ----
const FAIL = { r: 150, g: 160, b: 180 };   // muted slate for unsuccessful passes
const SHOT_ACC = { r: 255, g: 240, b: 205 }; // warm = accurate / on target
const SHOT_INACC = { r: 150, g: 165, b: 190 }; // cool muted = inaccurate
function teamRgb(team) { return team === 'home' ? prep.home.rgb : prep.away.rgb; }
function mix(a, b, t) { return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) }; }

// age-based fade: newest = 1, oldest -> floor. `fade` scales how much it drops.
function ageAlpha(minute) {
  const age = clamp((clock - minute) / (prep.duration || 90), 0, 1);
  return clamp(1 - fade * age, 1 - fade, 1); // floor = 1-fade
}

// ---- drawing ----
function drawPitch() {
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 1;
  // outline
  ctx.beginPath();
  corners.forEach(([x, y], i) => { const p = proj(x, y, 0); i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
  ctx.closePath(); ctx.stroke();
  // halfway line
  let p = proj(0.5, 0, 0), q = proj(0.5, 1, 0);
  ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
  // center circle (projected ellipse via sampled points)
  ctx.beginPath();
  for (let i = 0; i <= 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    const cx = 0.5 + Math.cos(a) * 0.083, cy = 0.5 + Math.sin(a) * 0.13;
    const pt = proj(cx, cy, 0); i ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1]);
  }
  ctx.stroke();
  // penalty boxes
  const boxes = [[[0, 0.21], [0.17, 0.21], [0.17, 0.79], [0, 0.79]],
                 [[1, 0.21], [0.83, 0.21], [0.83, 0.79], [1, 0.79]]];
  for (const b of boxes) {
    ctx.beginPath();
    b.forEach(([x, y], i) => { const pt = proj(x, y, 0); i ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1]); });
    ctx.stroke();
  }
}

function drawPasses() {
  ctx.lineCap = 'round';
  // older first so newer overlay
  for (const p of prep.passes) {
    if (p.minute > clock) break; // passes are minute-sorted
    const z = zFor(p.team, p.minute);
    const a = proj(p.x0, p.y0, z), b = proj(p.x1, p.y1, z);
    const base = p.ok ? teamRgb(p.team) : mix(teamRgb(p.team), FAIL, 0.7);
    const alpha = (p.ok ? 0.5 : 0.28) * ageAlpha(p.minute);
    ctx.strokeStyle = rgbStr(base, alpha);
    ctx.lineWidth = p.ok ? 1.1 : 0.8;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  }
}

function drawShots() {
  for (const sh of prep.shots) {
    if (sh.minute > clock) continue;
    const z = zFor(sh.team, sh.minute);
    const top = proj(sh.x, sh.y, z), ground = proj(sh.x, sh.y, 0);
    const accurate = sh.isGoal || sh.xgot > 0 || sh.type === 'SavedShot' || sh.type === 'AttemptSaved';
    const tint = accurate ? SHOT_ACC : SHOT_INACC;
    const col = mix(teamRgb(sh.team), tint, 0.55);
    const af = ageAlpha(sh.minute);
    // stem to ground (shows height = possession at the moment)
    ctx.strokeStyle = rgbStr(col, 0.25 * af);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ground[0], ground[1]); ctx.lineTo(top[0], top[1]); ctx.stroke();
    // marker sized by xG
    const r = Math.max(2.5, (3 + sh.xg * 34)) * (Math.min(W, H) / 900);
    if (sh.isGoal) {
      ctx.fillStyle = rgbStr({ r: 255, g: 250, b: 235 }, 0.9 * af);
      ctx.beginPath(); ctx.arc(top[0], top[1], r * 1.2, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = rgbStr(col, 0.8 * af); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(top[0], top[1], r * 1.9, 0, Math.PI * 2); ctx.stroke();
    } else {
      ctx.fillStyle = rgbStr(col, (accurate ? 0.7 : 0.5) * af);
      ctx.beginPath(); ctx.arc(top[0], top[1], r, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function render() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#05060b';
  ctx.fillRect(0, 0, W, H);
  if (!prep) return;
  computeProjection();
  if (el('lGrid').checked) drawPitch();
  ctx.globalCompositeOperation = 'lighter';
  if (el('lPass').checked) drawPasses();
  if (el('lShot').checked) drawShots();
  ctx.globalCompositeOperation = 'source-over';
}

// ---- HUD ----
function updateHud() {
  if (!prep) return;
  const t = clock;
  let gH = prep.shots.filter((s) => s.team === 'home' && s.isGoal && s.minute <= t).length;
  let gA = prep.shots.filter((s) => s.team === 'away' && s.isGoal && s.minute <= t).length;
  const atFT = t >= prep.duration - 0.01;
  if (atFT) { gH = prep.home.score; gA = prep.away.score; }
  else { gH = Math.min(gH, prep.home.score); gA = Math.min(gA, prep.away.score); }
  const ph = Math.round(possHomeAt(t) * 100);
  el('hScore').textContent = gH; el('aScore').textContent = gA;
  const mm = Math.floor(t); el('clk').textContent = mm + "'"; el('clockV').textContent = mm + "'";
  el('hPoss').textContent = ph; el('aPoss').textContent = 100 - ph;
  el('hXg').textContent = xgUpTo(prep.shots, 'home', t).toFixed(2);
  el('aXg').textContent = xgUpTo(prep.shots, 'away', t).toFixed(2);
  el('hPass').textContent = prep.passes.filter((q) => q.team === 'home' && q.minute <= t).length;
  el('aPass').textContent = prep.passes.filter((q) => q.team === 'away' && q.minute <= t).length;
  if (document.activeElement !== el('clock')) el('clock').value = String((t / prep.duration) * 100);
}

// ---- controls ----
const playBtn = el('play');
playBtn.addEventListener('click', () => {
  if (!prep) return;
  if (!playing && clock >= prep.duration) clock = 0;
  playing = !playing; playBtn.textContent = playing ? '❚❚ pause' : '▶ play';
});
el('restart').addEventListener('click', () => { clock = 0; playing = true; playBtn.textContent = '❚❚ pause'; });
el('clock').addEventListener('input', () => { if (!prep) return; clock = (Number(el('clock').value) / 100) * prep.duration; playing = false; playBtn.textContent = '▶ play'; });
el('speed').addEventListener('input', () => { speed = Number(el('speed').value); el('speedV').textContent = speed.toFixed(1) + '×'; });
el('fade').addEventListener('input', () => { fade = Number(el('fade').value); el('fadeV').textContent = fade.toFixed(2); });
el('zscale').addEventListener('input', () => { zScale = Number(el('zscale').value); el('zscaleV').textContent = zScale.toFixed(2); });
el('pwin').addEventListener('input', () => {
  pwin = Number(el('pwin').value); el('pwinV').textContent = pwin + 'm';
  if (prep) possSeries = buildPossession(prep.passes, prep.duration, pwin);
});

// ---- boot ----
(async function init() {
  try {
    const rich = await fetch('/api/rich/' + ID).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
    prep = prepareMatch(rich);
    possSeries = buildPossession(prep.passes, prep.duration, pwin);
    resize();
    el('title2').textContent = `STAGE 3D · ${prep.home.abbr} ${prep.home.score}–${prep.away.score} ${prep.away.abbr}`;
    el('hAbbr').textContent = prep.home.abbr; el('aAbbr').textContent = prep.away.abbr;
    document.documentElement.style.setProperty('--home-color', rgbStr(prep.home.rgb));
    document.documentElement.style.setProperty('--away-color', rgbStr(prep.away.rgb));
  } catch (e) {
    el('title2').textContent = 'STAGE 3D · failed: ' + e.message;
  }
  requestAnimationFrame(loop);
})();

let last = performance.now();
function loop(now) {
  if (W !== window.innerWidth || H !== window.innerHeight) resize();
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000)); last = now;
  if (prep && playing) {
    clock += dt * speed;
    if (clock >= prep.duration) { clock = prep.duration; playing = false; playBtn.textContent = '▶ play'; }
  }
  render();
  updateHud();
  requestAnimationFrame(loop);
}
