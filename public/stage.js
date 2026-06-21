// stage.js — a focused, standalone polishing stage for ONE match (default:
// France–Senegal, id 1953888). Renders the MicroView full-screen with live
// tuning controls so we can iterate on the aesthetic on a fixed target.

import { MicroView } from './match.js';
import { rgbStr } from './lib.js';

const ID = new URLSearchParams(location.search).get('id') || '1953888';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const micro = new MicroView(ctx);

let W = 0, H = 0, dpr = 1;
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth || 1; H = window.innerHeight || 1;
  canvas.width = Math.max(1, Math.round(W * dpr));
  canvas.height = Math.max(1, Math.round(H * dpr));
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  micro.layout(W, H, dpr);
}
window.addEventListener('resize', resize);

// ---- DOM ----
const el = (id) => document.getElementById(id);
const playBtn = el('play'), restartBtn = el('restart');
const clockR = el('clock'), clockV = el('clockV');
const speedR = el('speed'), speedV = el('speedV');
const recentR = el('recent'), recentV = el('recentV');
const lPass = el('lPass'), lShot = el('lShot'), lMom = el('lMom');

let speed = Number(speedR.value);

playBtn.addEventListener('click', () => {
  if (!micro.prep) return;
  if (!micro.playing && micro.clock >= micro.prep.duration) micro.clock = 0;
  micro.playing = !micro.playing;
  playBtn.textContent = micro.playing ? '❚❚ pause' : '▶ play';
});
restartBtn.addEventListener('click', () => { micro.setClock(0); micro.playing = true; playBtn.textContent = '❚❚ pause'; });
clockR.addEventListener('input', () => {
  if (!micro.prep) return;
  micro.setClock((Number(clockR.value) / 100) * micro.prep.duration);
  micro.playing = false; playBtn.textContent = '▶ play';
});
speedR.addEventListener('input', () => { speed = Number(speedR.value); speedV.textContent = speed.toFixed(1) + '×'; });
recentR.addEventListener('input', () => { micro.recentWindow = Number(recentR.value); micro.net = null; micro.netUpTo = -1; recentV.textContent = recentR.value + 'm'; });

// ---- boot ----
(async function init() {
  try {
    const rich = await fetch('/api/rich/' + ID).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
    micro.setMatch(rich);
    resize();
    const p = micro.prep;
    el('title2').textContent = `STAGE · ${p.home.abbr} ${p.home.score}–${p.away.score} ${p.away.abbr}`;
    el('hAbbr').textContent = p.home.abbr; el('aAbbr').textContent = p.away.abbr;
    document.documentElement.style.setProperty('--home-color', rgbStr(p.home.rgb));
    document.documentElement.style.setProperty('--away-color', rgbStr(p.away.rgb));
  } catch (e) {
    el('title2').textContent = 'STAGE · failed: ' + e.message;
  }
  requestAnimationFrame(loop);
})();

let last = performance.now();
function loop(now) {
  if (W !== window.innerWidth || H !== window.innerHeight) resize();
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000)); last = now;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#04050a';
  ctx.fillRect(0, 0, W, H);

  if (micro.prep) {
    micro.step(dt, speed);
    micro.draw({ pass: lPass.checked, shot: lShot.checked, mom: lMom.checked });
    updateHud();
  }
  requestAnimationFrame(loop);
}

function updateHud() {
  const h = micro.hud();
  el('hScore').textContent = h.scoreHome; el('aScore').textContent = h.scoreAway;
  const mm = Math.floor(h.minute);
  el('clk').textContent = mm + "'"; clockV.textContent = mm + "'";
  el('hXg').textContent = h.xgHome.toFixed(2); el('aXg').textContent = h.xgAway.toFixed(2);
  el('hPass').textContent = h.passHome; el('aPass').textContent = h.passAway;
  if (document.activeElement !== clockR && micro.prep) {
    clockR.value = String((micro.clock / micro.prep.duration) * 100);
  }
}
