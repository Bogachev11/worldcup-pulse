// app.js — orchestrator for World Cup Pulse (RICH rebuild).
// Owns the single full-screen stage canvas, the rAF loop, DPR/resize guard,
// view switching (MACRO organism <-> MICRO hero match), the dense HUD DOM, the
// scrubbers, hover labels, and the zoom transition.

import { clamp, rgbStr } from './lib.js';
import { Monument } from './monument.js';
import { MicroView } from './match.js';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');

let W = 0, H = 0, dpr = 1;
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth || 1;
  H = window.innerHeight || 1;
  canvas.width = Math.max(1, Math.round(W * dpr));
  canvas.height = Math.max(1, Math.round(H * dpr));
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  monument.layout(W, H, dpr);
  micro.layout(W, H, dpr);
  layoutCurve();
}

const monument = new Monument(ctx);
const micro = new MicroView(ctx);

let view = 'macro';           // 'macro' | 'micro'

// ---- DOM refs ----
const macroUI = document.getElementById('macroUI');
const microUI = document.getElementById('microUI');
const boot = document.getElementById('boot');
const hoverLabel = document.getElementById('hoverLabel');

const playBtn = document.getElementById('playBtn');
const dayRange = document.getElementById('dayRange');
const dayLabel = document.getElementById('dayLabel');

const backBtn = document.getElementById('backBtn');
const mHomeAbbr = document.getElementById('mHomeAbbr');
const mAwayAbbr = document.getElementById('mAwayAbbr');
const mHomeScore = document.getElementById('mHomeScore');
const mAwayScore = document.getElementById('mAwayScore');
const mMeta = document.getElementById('mMeta');
const mPlayBtn = document.getElementById('mPlayBtn');
const mClock = document.getElementById('mClock');
const mClockLabel = document.getElementById('mClockLabel');
const mCurve = document.getElementById('mCurve');
const curveCtx = mCurve.getContext('2d');
const mStats = document.getElementById('mStats');

const MICRO_SPEED = 1.4; // match-minutes per real second

// ---- boot ----
(async function init() {
  try {
    await monument.load();
    resize();
    dayRange.min = '0';
    dayRange.max = String(Math.max(0, monument.days.length - 1));
    dayRange.value = String(monument.dayIdx);
    updateDayLabel();
    boot.classList.add('hidden');
  } catch (e) {
    boot.textContent = 'failed to load rich data: ' + e.message;
  }
  requestAnimationFrame(loop);
})();

// ---- macro controls ----
playBtn.addEventListener('click', () => {
  monument.playing = !monument.playing;
  playBtn.textContent = monument.playing ? '❚❚' : '▶';
});
dayRange.addEventListener('input', () => {
  monument.dayIdx = Number(dayRange.value);
  monument.playing = false;
  playBtn.textContent = '▶';
  updateDayLabel();
});
function updateDayLabel() {
  if (!monument.days.length) { dayLabel.textContent = '—'; return; }
  const d = monument.days[clamp(monument.dayIdx, 0, monument.days.length - 1)] || '—';
  const revealed = monument.cells.filter((c) => monument.isRevealed(c)).length;
  dayLabel.textContent = `${d} · ${revealed}/${monument.cells.length}`;
}
function syncDaySlider() {
  if (document.activeElement !== dayRange) dayRange.value = String(monument.dayIdx);
  updateDayLabel();
}

// ---- hover + click on macro ----
canvas.addEventListener('mousemove', (e) => {
  if (view !== 'macro') { hoverLabel.classList.add('hidden'); return; }
  const c = monument.pick(e.clientX, e.clientY);
  monument.hoverCell = c;
  if (c) {
    const m = c.meta;
    hoverLabel.innerHTML =
      `<span class="hi">${m.home.abbr} ${m.home.score}–${m.away.score} ${m.away.abbr}</span>` +
      `<br><span class="dim">Group ${m.group} · ${m.date} · ${m.counts ? m.counts.shots + ' shots' : ''}</span>`;
    hoverLabel.style.left = c.cx + 'px';
    hoverLabel.style.top = (c.cy - c.r) + 'px';
    hoverLabel.classList.remove('hidden');
    canvas.style.cursor = 'pointer';
  } else {
    hoverLabel.classList.add('hidden');
    canvas.style.cursor = 'default';
  }
});
canvas.addEventListener('click', (e) => {
  if (view !== 'macro') return;
  const c = monument.pick(e.clientX, e.clientY);
  if (c) enterMicro(c);
});

backBtn.addEventListener('click', exitMicro);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && view === 'micro') exitMicro(); });

mPlayBtn.addEventListener('click', () => {
  if (!micro.prep) return;
  if (!micro.playing && micro.clock >= micro.prep.duration) micro.clock = 0;
  micro.playing = !micro.playing;
  mPlayBtn.textContent = micro.playing ? '❚❚' : '▶';
});
mClock.addEventListener('input', () => {
  if (!micro.prep) return;
  const t = (Number(mClock.value) / 100) * micro.prep.duration;
  micro.setClock(t);
  micro.playing = false;
  mPlayBtn.textContent = '▶';
});

// ---- view transitions ----
async function enterMicro(cell) {
  hoverLabel.classList.add('hidden');
  let rich = null;
  try {
    const res = await fetch('/api/rich/' + cell.meta.matchId);
    if (!res.ok) throw new Error('rich ' + res.status);
    rich = await res.json();
  } catch (e) { return; }
  micro.setMatch(rich);
  micro.layout(W, H, dpr);
  view = 'micro';
  micro.playing = true;
  mPlayBtn.textContent = '❚❚';
  mHomeAbbr.textContent = micro.prep.home.abbr || 'HOM';
  mAwayAbbr.textContent = micro.prep.away.abbr || 'AWY';
  document.documentElement.style.setProperty('--home-color', rgbStr(micro.prep.home.rgb));
  document.documentElement.style.setProperty('--away-color', rgbStr(micro.prep.away.rgb));
  mMeta.textContent = `Group ${micro.prep.group} · ${micro.prep.date} · FT ${micro.prep.home.score}–${micro.prep.away.score}`;
  macroUI.classList.add('hidden');
  microUI.classList.remove('hidden');
  layoutCurve();
}
function exitMicro() {
  view = 'macro';
  microUI.classList.add('hidden');
  macroUI.classList.remove('hidden');
}

// ---- micro HUD + momentum curve ----
function layoutCurve() {
  const r = mCurve.getBoundingClientRect();
  if (r.width <= 0) return;
  mCurve.width = Math.max(1, Math.round(r.width * dpr));
  mCurve.height = Math.max(1, Math.round(r.height * dpr));
  curveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function drawCurve() {
  if (!micro.prep) return;
  const r = mCurve.getBoundingClientRect();
  const w = r.width, ht = r.height;
  if (w <= 0 || ht <= 0) return;
  curveCtx.clearRect(0, 0, w, ht);
  const series = micro.prep.momentum;
  if (!series.length) return;
  const dur = micro.prep.duration || 90;
  const home = micro.prep.home.rgb, away = micro.prep.away.rgb;
  const xAt = (t) => (t / dur) * w;
  const yAt = (v) => ht / 2 - v * (ht / 2 - 4);
  curveCtx.strokeStyle = 'rgba(255,255,255,0.12)';
  curveCtx.lineWidth = 1;
  curveCtx.beginPath(); curveCtx.moveTo(0, ht / 2); curveCtx.lineTo(w, ht / 2); curveCtx.stroke();
  const t = micro.clock;
  // filled area up to playhead
  curveCtx.beginPath();
  curveCtx.moveTo(0, ht / 2);
  for (const s of series) { if (s.t > t) break; curveCtx.lineTo(xAt(s.t), yAt(s.v)); }
  curveCtx.lineTo(xAt(Math.min(t, dur)), ht / 2);
  curveCtx.closePath();
  const grad = curveCtx.createLinearGradient(0, 0, 0, ht);
  grad.addColorStop(0, rgbStr(home, 0.5));
  grad.addColorStop(0.5, 'rgba(255,255,255,0.05)');
  grad.addColorStop(1, rgbStr(away, 0.5));
  curveCtx.fillStyle = grad;
  curveCtx.fill();
  // stroke
  curveCtx.beginPath();
  let first = true;
  for (const s of series) {
    if (s.t > t) break;
    const X = xAt(s.t), Y = yAt(s.v);
    if (first) { curveCtx.moveTo(X, Y); first = false; } else curveCtx.lineTo(X, Y);
  }
  curveCtx.strokeStyle = 'rgba(255,255,255,0.7)';
  curveCtx.lineWidth = 1.4;
  curveCtx.stroke();
  // playhead
  const px = xAt(Math.min(t, dur));
  curveCtx.strokeStyle = 'rgba(255,255,255,0.5)';
  curveCtx.beginPath(); curveCtx.moveTo(px, 0); curveCtx.lineTo(px, ht); curveCtx.stroke();
}

function updateMicroHud() {
  if (!micro.prep) return;
  const h = micro.hud();
  mHomeScore.textContent = h.scoreHome;
  mAwayScore.textContent = h.scoreAway;
  mClockLabel.textContent = Math.floor(h.minute) + "'";
  if (document.activeElement !== mClock)
    mClock.value = String((h.minute / (micro.prep.duration || 90)) * 100);
  if (mStats) {
    mStats.innerHTML =
      `<span class="stat"><b style="color:var(--home-color)">${h.passHome}</b> PASSES <b style="color:var(--away-color)">${h.passAway}</b></span>` +
      `<span class="stat"><b style="color:var(--home-color)">${h.xgHome.toFixed(2)}</b> xG <b style="color:var(--away-color)">${h.xgAway.toFixed(2)}</b></span>`;
  }
  drawCurve();
}

// ---- main loop ----
let last = performance.now();
function loop(now) {
  if (W !== window.innerWidth || H !== window.innerHeight) resize();
  const dt = clamp((now - last) / 1000, 0, 0.1);
  last = now;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#04050a';
  ctx.fillRect(0, 0, W, H);

  if (view === 'macro') {
    monument.step(dt);
    monument.draw();
    syncDaySlider();
  } else {
    micro.step(dt, MICRO_SPEED);
    micro.draw();
    updateMicroHud();
    if (!micro.playing && micro.prep && micro.clock >= micro.prep.duration) {
      mPlayBtn.textContent = '▶';
    }
  }
  requestAnimationFrame(loop);
}
