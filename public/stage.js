// stage.js — ISOMETRIC / orbitable 3D polishing stage for ONE match (default
// France–Senegal, id 1953888). Minimalist. Every event sits at (x, y, z) where
// z = the acting team's POSSESSION SHARE at that moment (derived live from the
// real pass stream). Passes & shots accumulate and fade with age (controllable).
// Free camera: yaw + elevation + zoom (drag to orbit; values shown to copy).
// Macro monument is untouched. Pure Canvas 2D projection — no three.js.

import { clamp, lerp, prepareMatch, xgUpTo, rgbStr } from './lib.js';

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
let prep = null, possSeries = null;
let clock = 0, playing = true;
let speed = +el('speed').value;
let fadeTime = +el('fadet').value;   // minutes: half-life of fade (smaller = sooner)
let fadeFloor = +el('fadef').value;  // 0..1 minimum alpha old events keep
let zScale = +el('zscale').value;
let pwin = +el('pwin').value;
const cam = { yaw: 45, elev: 32, zoom: 1 };

// ---- possession (real-data derived): rolling home pass-share per minute ----
function buildPossession(passes, duration, win) {
  const n = Math.ceil(duration) + 1;
  const out = new Array(n).fill(0.5);
  for (let m = 0; m < n; m++) {
    let h = 0, a = 0;
    for (const p of passes) if (Math.abs(p.minute - m) <= win) { if (p.team === 'home') h++; else a++; }
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
function zFor(team, t) { const h = possHomeAt(t); return team === 'home' ? h : 1 - h; }

// ---- camera projection (yaw around vertical, elevation, zoom) ----
let P = { cx: 0, cy: 0, len: 1, wid: 1, ht: 1 };
function computeProjection() {
  const s = Math.min(W * 0.6, H * 1.0);
  P.len = s; P.wid = s * 0.64; P.ht = s * 0.42 * zScale;
  P.cx = W / 2; P.cy = H * 0.56;
}
function proj(x, y, z) {
  const wx = (x - 0.5) * P.len, wy = (y - 0.5) * P.wid, wz = z * P.ht;
  const fy = cam.yaw * Math.PI / 180, fe = cam.elev * Math.PI / 180;
  const rx = wx * Math.cos(fy) - wy * Math.sin(fy);
  const ry = wx * Math.sin(fy) + wy * Math.cos(fy);
  return [P.cx + rx * cam.zoom, P.cy + (ry * Math.sin(fe) - wz * Math.cos(fe)) * cam.zoom];
}

// ---- colors ----
const FAIL = { r: 150, g: 160, b: 180 };
const SHOT_ACC = { r: 255, g: 240, b: 205 };
const SHOT_INACC = { r: 150, g: 165, b: 190 };
function teamRgb(team) { return team === 'home' ? prep.home.rgb : prep.away.rgb; }
function mix(a, b, t) { return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) }; }

// age fade: exponential half-life in match-minutes; floor keeps old ones faint.
function ageAlpha(minute) {
  const age = Math.max(0, clock - minute);
  const decay = Math.pow(0.5, age / Math.max(0.1, fadeTime));
  return fadeFloor + (1 - fadeFloor) * decay;
}

// ---- drawing ----
function drawPitch() {
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1;
  const poly = (pts) => { ctx.beginPath(); pts.forEach(([x, y], i) => { const p = proj(x, y, 0); i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); }); };
  poly([[0, 0], [1, 0], [1, 1], [0, 1]]); ctx.closePath(); ctx.stroke();
  let a = proj(0.5, 0, 0), b = proj(0.5, 1, 0);
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i <= 40; i++) { const ang = i / 40 * Math.PI * 2; const pt = proj(0.5 + Math.cos(ang) * 0.083, 0.5 + Math.sin(ang) * 0.13, 0); i ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1]); }
  ctx.stroke();
  poly([[0, 0.21], [0.17, 0.21], [0.17, 0.79], [0, 0.79]]); ctx.stroke();
  poly([[1, 0.21], [0.83, 0.21], [0.83, 0.79], [1, 0.79]]); ctx.stroke();
}

function drawPasses() {
  ctx.lineCap = 'round';
  for (const p of prep.passes) {
    if (p.minute > clock) break;
    const z = zFor(p.team, p.minute);
    const a = proj(p.x0, p.y0, z), b = proj(p.x1, p.y1, z);
    const base = p.ok ? teamRgb(p.team) : mix(teamRgb(p.team), FAIL, 0.7);
    const alpha = (p.ok ? 0.55 : 0.3) * ageAlpha(p.minute);
    if (alpha < 0.012) continue;
    ctx.strokeStyle = rgbStr(base, alpha);
    ctx.lineWidth = p.ok ? 1.1 : 0.8;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  }
}

function drawShots() {
  for (const sh of prep.shots) {
    if (sh.minute > clock) continue;
    const z = zFor(sh.team, sh.minute);          // shots sit at the possession level too
    const pt = proj(sh.x, sh.y, z);
    const accurate = sh.isGoal || sh.xgot > 0 || sh.type === 'SavedShot' || sh.type === 'AttemptSaved';
    const col = mix(teamRgb(sh.team), accurate ? SHOT_ACC : SHOT_INACC, 0.55);
    const af = ageAlpha(sh.minute);
    const r = Math.max(2.5, (3 + sh.xg * 34)) * (Math.min(W, H) / 900);
    if (sh.isGoal) {
      ctx.fillStyle = rgbStr({ r: 255, g: 250, b: 235 }, 0.9 * af);
      ctx.beginPath(); ctx.arc(pt[0], pt[1], r * 1.2, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = rgbStr(col, 0.85 * af); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(pt[0], pt[1], r * 2.0, 0, Math.PI * 2); ctx.stroke();
    } else {
      ctx.fillStyle = rgbStr(col, (accurate ? 0.75 : 0.5) * af);
      ctx.beginPath(); ctx.arc(pt[0], pt[1], r, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function render() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#05060b'; ctx.fillRect(0, 0, W, H);
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
  if (t >= prep.duration - 0.01) { gH = prep.home.score; gA = prep.away.score; }
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

// ---- camera readout + controls ----
function camString() { return `yaw ${cam.yaw}° · elev ${cam.elev}° · zoom ${cam.zoom.toFixed(2)}`; }
function syncCamUI() {
  el('yaw').value = String(Math.round(cam.yaw)); el('yawV').textContent = Math.round(cam.yaw) + '°';
  el('elev').value = String(Math.round(cam.elev)); el('elevV').textContent = Math.round(cam.elev) + '°';
  el('zoom').value = String(cam.zoom.toFixed(2)); el('zoomV').textContent = cam.zoom.toFixed(2);
  el('camread').textContent = camString();
}
el('yaw').addEventListener('input', () => { cam.yaw = +el('yaw').value; syncCamUI(); });
el('elev').addEventListener('input', () => { cam.elev = +el('elev').value; syncCamUI(); });
el('zoom').addEventListener('input', () => { cam.zoom = +el('zoom').value; syncCamUI(); });
el('resetcam').addEventListener('click', () => { cam.yaw = 45; cam.elev = 32; cam.zoom = 1; syncCamUI(); });
el('copycam').addEventListener('click', async () => {
  const s = `{ yaw: ${cam.yaw}, elev: ${cam.elev}, zoom: ${cam.zoom.toFixed(2)} }`;
  try { await navigator.clipboard.writeText(s); el('camread').textContent = 'copied: ' + s; }
  catch { el('camread').textContent = s; }
});

// drag-to-orbit on the canvas
let dragging = false, lastX = 0, lastY = 0;
canvas.addEventListener('mousedown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.classList.add('drag'); });
window.addEventListener('mouseup', () => { dragging = false; canvas.classList.remove('drag'); });
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  cam.yaw = (cam.yaw + (e.clientX - lastX) * 0.4 + 360) % 360;
  cam.elev = clamp(cam.elev - (e.clientY - lastY) * 0.3, 4, 89);
  lastX = e.clientX; lastY = e.clientY; syncCamUI();
});
canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.zoom = clamp(cam.zoom * (e.deltaY < 0 ? 1.06 : 0.94), 0.4, 2.4); syncCamUI(); }, { passive: false });

// ---- playback controls ----
const playBtn = el('play');
playBtn.addEventListener('click', () => { if (!prep) return; if (!playing && clock >= prep.duration) clock = 0; playing = !playing; playBtn.textContent = playing ? '❚❚ pause' : '▶ play'; });
el('restart').addEventListener('click', () => { clock = 0; playing = true; playBtn.textContent = '❚❚ pause'; });
el('clock').addEventListener('input', () => { if (!prep) return; clock = (+el('clock').value / 100) * prep.duration; playing = false; playBtn.textContent = '▶ play'; });
el('speed').addEventListener('input', () => { speed = +el('speed').value; el('speedV').textContent = speed.toFixed(1) + '×'; });
el('fadet').addEventListener('input', () => { fadeTime = +el('fadet').value; el('fadetV').textContent = fadeTime.toFixed(1) + 'm'; });
el('fadef').addEventListener('input', () => { fadeFloor = +el('fadef').value; el('fadefV').textContent = fadeFloor.toFixed(2); });
el('zscale').addEventListener('input', () => { zScale = +el('zscale').value; el('zscaleV').textContent = zScale.toFixed(2); });
el('pwin').addEventListener('input', () => { pwin = +el('pwin').value; el('pwinV').textContent = pwin + 'm'; if (prep) possSeries = buildPossession(prep.passes, prep.duration, pwin); });

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
    syncCamUI();
  } catch (e) { el('title2').textContent = 'STAGE 3D · failed: ' + e.message; }
  requestAnimationFrame(loop);
})();

let last = performance.now();
function loop(now) {
  if (W !== window.innerWidth || H !== window.innerHeight) resize();
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000)); last = now;
  if (prep && playing) { clock += dt * speed; if (clock >= prep.duration) { clock = prep.duration; playing = false; playBtn.textContent = '▶ play'; } }
  render();
  updateHud();
  requestAnimationFrame(loop);
}
