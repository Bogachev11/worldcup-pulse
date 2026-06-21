// app.js — MONUMENT orchestrator.
// Fetches the tournament (real /api/monument, falling back to sample-monument.json),
// owns the single full-screen canvas, drives the MACRO view + time scrubber, and
// handles the smooth zoom into / out of the MICRO single-match replay.

import { MonumentView } from './monument.js';
import { MatchView } from './match.js';
import { clamp, lerp, easeInOutCubic } from './lib.js';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const el = (id) => document.getElementById(id);

// ---------- canvas sizing (DPR aware) ----------
let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.max(1, Math.round(W * DPR));
  canvas.height = Math.max(1, Math.round(H * DPR));
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  // clear to base so resize doesn't leave smear artifacts
  ctx.fillStyle = '#04050a';
  ctx.fillRect(0, 0, W, H);
  if (macro) macro.resize();
}
const getSize = () => ({ W, H, DPR });
window.addEventListener('resize', resize);

// ---------- views ----------
const macro = new MonumentView(ctx, getSize);
const micro = new MatchView(ctx, getSize);

// mode: 'macro' | 'toMicro' | 'micro' | 'toMacro'
let mode = 'macro';
let trans = 0;                 // 0..1 transition progress
let transFrom = null;          // {cx,cy,w,h} cell rect we zoom from
let TRANS_MS = 650;

// ---------- data load ----------
let usingSample = false;
async function loadData() {
  let data = null;
  try {
    const r = await fetch('/api/monument', { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      if (j && j.matches && j.matches.length) { data = j; usingSample = false; }
    }
  } catch (_) { /* fall through */ }

  if (!data) {
    try {
      const r = await fetch('sample-monument.json', { cache: 'no-store' });
      data = await r.json();
      usingSample = true;
    } catch (e) {
      el('boot').textContent = 'no data available';
      return;
    }
  }

  if (usingSample) el('sampleBadge').classList.remove('hidden');

  macro.setData(data.tournament, data.matches);
  setupScrubber(data.tournament);
  wireMacro();

  const boot = el('boot');
  if (boot) boot.classList.add('hidden');
}

// ---------- scrubber + play ----------
let playing = true;
let dayAcc = 0;                  // accumulator for auto-advance
const DAY_ADVANCE_S = 1.1;       // seconds per day while playing
let todayIndex = 0;

function setupScrubber(tournament) {
  const days = tournament?.days || [];
  const range = el('dayRange');
  range.min = 0;
  range.max = Math.max(0, days.length - 1);
  range.step = 1;

  // find "today" (2026-06-20 per env) → default play target
  const today = '2026-06-20';
  todayIndex = days.findIndex((d) => d >= today);
  if (todayIndex < 0) todayIndex = days.length - 1; // tournament fully past → full

  // start playing from the beginning up to today
  macro.setDayIndex(0);
  range.value = 0;
  updateDayLabel();

  range.addEventListener('input', () => {
    playing = false; el('playBtn').textContent = '▶';
    macro.setDayIndex(Number(range.value));
    updateDayLabel();
  });

  el('playBtn').addEventListener('click', () => {
    playing = !playing;
    el('playBtn').textContent = playing ? '❚❚' : '▶';
    // if at/after target, restart growth from the beginning
    if (playing && macro.dayIndex >= macro.dayList().length - 1) {
      macro.setDayIndex(0);
    }
  });
  el('playBtn').textContent = '❚❚';
}

function updateDayLabel() {
  const days = macro.dayList();
  const d = days[clamp(macro.dayIndex, 0, days.length - 1)] || '—';
  el('dayLabel').textContent = d;
  const r = el('dayRange');
  if (Number(r.value) !== macro.dayIndex) r.value = macro.dayIndex;
}

// auto-advance days while playing (rest once we reach "today")
function advanceDays(dt) {
  if (!playing || mode !== 'macro') return;
  const days = macro.dayList();
  if (!days.length) return;
  const target = todayIndex;
  if (macro.dayIndex >= target) {
    // reached today: rest at full (stop auto-advancing, keep play btn as pause)
    return;
  }
  dayAcc += dt;
  if (dayAcc >= DAY_ADVANCE_S) {
    dayAcc = 0;
    macro.setDayIndex(macro.dayIndex + 1);
    updateDayLabel();
  }
}

// ---------- macro interaction ----------
function wireMacro() {
  macro.onHover = (m, sx, sy) => {
    const lbl = el('hoverLabel');
    if (!m || mode !== 'macro') { lbl.classList.add('hidden'); return; }
    const round = (m.round || '').toUpperCase();
    lbl.innerHTML =
      `<span class="hi">${m.home?.abbr ?? '?'} ${m.home?.score ?? 0}–${m.away?.score ?? 0} ${m.away?.abbr ?? '?'}</span>` +
      `<span class="dim"> · ${round}</span>`;
    lbl.style.left = sx + 'px';
    lbl.style.top = sy + 'px';
    lbl.classList.remove('hidden');
    canvas.style.cursor = 'pointer';
  };
  macro.onPick = (m) => enterMicro(m);
}

canvas.addEventListener('mousemove', (e) => {
  if (mode === 'macro') macro.setMouse(e.clientX, e.clientY);
});
canvas.addEventListener('mouseleave', () => { if (mode === 'macro') macro.setMouse(-1, -1); });
canvas.addEventListener('click', (e) => {
  if (mode === 'macro') macro.click(e.clientX, e.clientY);
  else if (mode === 'micro') { /* clicks handled by HUD; click-out via background */ }
});

// ---------- micro enter/exit with zoom ----------
async function enterMicro(m) {
  // optionally refresh full record from /api/match/:id (reuse if it fails)
  let full = m;
  try {
    const r = await fetch(`/api/match/${encodeURIComponent(m.id)}`, { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      if (j && j.fingerprint) full = j;
    }
  } catch (_) { /* reuse already-loaded record */ }

  micro.setMatch(full);
  fillMicroHud(full);

  // capture the source cell rect for the zoom-from animation
  const cell = macro.layout.find((c) => c.m.id === m.id);
  transFrom = cell ? { cx: cell.cx, cy: cell.cy, w: cell.w, h: cell.h } : { cx: W / 2, cy: H / 2, w: W * 0.2, h: H * 0.2 };

  mode = 'toMicro'; trans = 0;
  el('macroUI').classList.add('hidden');
  el('hoverLabel').classList.add('hidden');
}

function exitMicro() {
  mode = 'toMacro'; trans = 0;
  el('microUI').classList.add('hidden');
}

function fillMicroHud(m) {
  el('mHomeAbbr').textContent = m.home?.abbr ?? '?';
  el('mAwayAbbr').textContent = m.away?.abbr ?? '?';
  document.documentElement.style.setProperty('--home-color', m.home?.colorHex || '#6cf');
  document.documentElement.style.setProperty('--away-color', m.away?.colorHex || '#f96');
  const round = (m.round || '').toUpperCase();
  const grp = m.group ? ` · GROUP ${m.group}` : '';
  el('mMeta').textContent = `${round}${grp} · ${m.day || ''}`;
  el('mClock').max = micro.duration;
}

// micro HUD wiring
const mCurveCanvas = el('mCurve');
const mCurveCtx = mCurveCanvas.getContext('2d');
function sizeMicroCurve() {
  const r = mCurveCanvas.getBoundingClientRect();
  mCurveCanvas.width = Math.max(1, r.width * DPR);
  mCurveCanvas.height = Math.max(1, r.height * DPR);
  mCurveCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', sizeMicroCurve);

micro.onClock = (clock, dur, score) => {
  el('mHomeScore').textContent = score.h;
  el('mAwayScore').textContent = score.a;
  el('mClockLabel').textContent = `${Math.floor(clock)}'`;
  const slider = el('mClock');
  if (document.activeElement !== slider) slider.value = clock;
};

el('mClock').addEventListener('input', (e) => {
  micro.playing = false; el('mPlayBtn').textContent = '▶';
  micro.setClock(Number(e.target.value));
});
el('mPlayBtn').addEventListener('click', () => {
  if (micro.clock >= micro.duration) micro.setClock(0);
  micro.playing = !micro.playing;
  el('mPlayBtn').textContent = micro.playing ? '❚❚' : '▶';
});
el('backBtn').addEventListener('click', exitMicro);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && (mode === 'micro' || mode === 'toMicro')) exitMicro();
});

// ---------- main loop ----------
let lastT = performance.now();
function frame(now) {
  let dt = (now - lastT) / 1000;
  if (!Number.isFinite(dt) || dt < 0) dt = 0;
  dt = Math.min(dt, 0.05);
  lastT = now;

  // guard against an early resize() that ran before the viewport had a size,
  // and against missed resize events — re-sync whenever the window changes.
  if (W !== window.innerWidth || H !== window.innerHeight) resize();

  advanceDays(dt);

  if (mode === 'macro') {
    macro.draw(dt, now, 1);
  } else if (mode === 'micro') {
    micro.draw(dt, now, 1);
  } else if (mode === 'toMicro' || mode === 'toMacro') {
    trans += (dt * 1000) / TRANS_MS;
    const e = easeInOutCubic(clamp(trans, 0, 1));
    // wipe to base each transition frame to avoid double-exposure
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(4,5,10,1)';
    ctx.fillRect(0, 0, W, H);

    if (mode === 'toMicro') {
      // macro zooms in toward the cell; micro fades up
      drawScaled(() => macro.draw(0, now, 1 - e), transFrom, e, 'in');
      micro.draw(0, now, e);
      if (trans >= 1) { mode = 'micro'; el('microUI').classList.remove('hidden'); sizeMicroCurve(); }
    } else {
      // micro zooms back out into the cell; macro fades in
      micro.draw(0, now, 1 - e);
      macro.draw(0, now, e);
      if (trans >= 1) { mode = 'macro'; el('macroUI').classList.remove('hidden'); }
    }
  }

  // micro curve overlay
  if (mode === 'micro') micro.drawCurve(mCurveCtx, mCurveCanvas.width / DPR, mCurveCanvas.height / DPR);

  requestAnimationFrame(frame);
}

// scale a draw callback around a focal cell (used for the zoom illusion).
// We approximate by translating/scaling the canvas transform for the frame.
function drawScaled(drawFn, rect, e, dir) {
  if (!rect) { drawFn(); return; }
  ctx.save();
  // zoom so the focal cell grows to fill the screen as e→1
  const targetScale = lerp(1, Math.max(W / rect.w, H / rect.h) * 0.9, e);
  const focX = rect.cx, focY = rect.cy;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.translate(W / 2, H / 2);
  ctx.scale(targetScale, targetScale);
  ctx.translate(-focX, -focY);
  drawFn();
  ctx.restore();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}

// ---------- boot ----------
resize();
sizeMicroCurve();
requestAnimationFrame(frame);
loadData();
