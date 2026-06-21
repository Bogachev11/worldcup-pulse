// stage3.js — "ERUPTION" — two LIVING coherent masses raymarched as SDFs that
// FIGHT at a deforming seam (they do NOT merge).
//
// Vision: from t=0 the two country-masses already stand in contact at the
// centre, pressing into each other. They keep their OWN identity and colour —
// the contact is a CLIPPED, deforming seam (max(blob, ±seam)), never a smooth
// smin union. When a team has momentum it BULGES into the opponent and DENTS
// its surface; momentum reverses → the other side dents back. Both masses grow
// continuously and powerfully through the match (swelling + rising upward like
// erupting/overflowing matter). On vigorous play each sprouts a few organic
// tendrils (capsules smin'd INTO its own blob). A slow churn keeps the surface
// alive even when paused.
//
// Tech: a single full-screen quad with a fragment shader that RAYMARCHES the
// signed-distance field. ONE growing ellipsoid per country + a few intra-team
// branch capsules. fbm noise displaces the surface (foam/clay). The two teams
// meet via a clipped, fbm-deformed seam plane — momentum shoves the plane.
// Matte clay/foam shading with a key + soft fill + faint fresnel rim. NO bloom,
// NO emissive glow.
//
// Hosted in three.js (CDN). Data model from claybattle.js; palette/math helpers
// from massbattle.js. Does NOT modify any other file.

import * as THREE from 'three';
import { buildModel, at, xgUpTo } from './claybattle.js';
import { clamp, rgb01, rgbCss, easeOut } from './massbattle.js';

const ID = new URLSearchParams(location.search).get('id') || '1953888';
const el = (id) => document.getElementById(id);
const lerp = (a, b, t) => a + (b - a) * t;

// ---- scene state ------------------------------------------------------------
let renderer, scene, camera, quad, material;
let model = null;
let clock = 0, playing = true;
let homeColor, awayColor;                  // THREE.Color (real kit, matte)
let resScale = 1.0;                        // raymarch resolution scale

// orbit camera (driven into shader uniforms; we do NOT use OrbitControls)
const cam = { az: 0.55, pol: 1.02, dist: 8.0 };
const camLimits = { polMin: 0.18, polMax: 1.50, distMin: 5.0, distMax: 26.0 };

const tune = {
  speed: 4.0,
  growth: 1.0,      // overall size multiplier (both masses)
  push: 1.0,        // how hard the winner dents the loser (seam shove gain)
  bulge: 1.0,       // living seam deformation amount
  branches: 1.0,    // tendril amount
  foam: 1.0,        // surface noise amount
};

// transient eruptions (goals / shots) advanced as the clock passes them
let activeEruptions = [];
let eruptionCursor = 0;
let permHome = 0, permAway = 0;            // permanent size bumps from goals
let permPush = 0;                          // permanent seam shove from goals
let lastSimT = -1;

// ---- boot -------------------------------------------------------------------
init().catch((e) => fail(e && (e.message || String(e))));

async function init() {
  if (!window.WebGLRenderingContext) throw new Error('WebGL not available in this browser');

  const raw = await fetch('/api/rich/' + ID).then((r) => {
    if (!r.ok) throw new Error('api ' + r.status);
    return r.json();
  });
  model = buildModel(raw);
  deriveColors();

  setupThree();
  bindUI();

  el('title3').textContent =
    `ERUPTION · ${model.home.abbr || 'HOME'} ${model.home.score}–${model.away.score} ${model.away.abbr || 'AWAY'}`;
  el('hAbbr').textContent = model.home.abbr || 'HOME';
  el('aAbbr').textContent = model.away.abbr || 'AWAY';

  window.addEventListener('resize', onResize);
  onResize();
  requestAnimationFrame(loop);
}

function fail(msg) {
  const t = el('title3'); if (t) t.textContent = 'ERUPTION · failed: ' + (msg || 'error');
  const o = document.createElement('div');
  o.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'color:#f88;font:14px system-ui;text-align:center;padding:40px;z-index:99;background:#06070d;white-space:pre-wrap';
  o.textContent = 'ERUPTION could not start: ' + (msg || 'error') +
    '\n\n(If three.js failed to load from the CDN, check your connection — it is loaded via esm.sh.)';
  document.body.appendChild(o);
}

// ---- real kit colours (matte, NOT vivid/emissive) ---------------------------
function deriveColors() {
  const KITS = {
    FRA: '#1a37c8',   // France royal blue
    SEN: '#00b85a',   // Senegal green
  };
  const toRgb = (hex) => {
    const h = String(hex).replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    if (!Number.isFinite(n)) return { r: 120, g: 120, b: 120 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  };
  const homeRgb = toRgb(KITS[model.home.abbr] || model.home.colorHex || '#26406A');
  const awayRgb = toRgb(KITS[model.away.abbr] || model.away.colorHex || '#0c954e');
  // store in linear-ish; shader lights them, tone-map handles output curve.
  homeColor = new THREE.Color(...rgb01(homeRgb)).convertSRGBToLinear();
  awayColor = new THREE.Color(...rgb01(awayRgb)).convertSRGBToLinear();

  document.documentElement.style.setProperty('--home-color', rgbCss(homeRgb));
  document.documentElement.style.setProperty('--away-color', rgbCss(awayRgb));
}

// ---- three.js setup: ONE fullscreen quad + raymarch ShaderMaterial ----------
function setupThree() {
  const canvas = el('stage');
  renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  // Fullscreen quad rendered with an identity camera; the SDF camera is fully
  // computed inside the shader from uAzimuth/uPolar/uDist.
  camera = new THREE.Camera();

  material = new THREE.ShaderMaterial({
    uniforms: {
      uRes: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uAzimuth: { value: cam.az },
      uPolar: { value: cam.pol },
      uDist: { value: cam.dist },
      // two-mass geometry (data driven, set per frame).
      // Each blob is an ellipsoid: centre + per-axis radii (rx,ry,rz). It grows
      // outward from its own side and rises (+y) over the match.
      uCenHome: { value: new THREE.Vector3(-0.95, 0.9, 0) },
      uCenAway: { value: new THREE.Vector3(0.95, 0.9, 0) },
      uRadHome: { value: new THREE.Vector3(1.2, 1.4, 1.0) },
      uRadAway: { value: new THREE.Vector3(1.2, 1.4, 1.0) },
      // fighting seam: plane x = uSeamX + bulge; uPush shoves it (momentum).
      uSeamX: { value: 0.0 },
      uPush: { value: 0.0 },
      uSeamBulge: { value: 0.25 },
      // branches/tendrils per team (intra-team smin)
      uBranchHome: { value: 0.0 },     // amount [0..1]*tune.branches
      uBranchAway: { value: 0.0 },
      uFoam: { value: tune.foam },
      uTurb: { value: 0.0 },        // extra turbulence from intensity/goals
      uColHome: { value: new THREE.Vector3(0.1, 0.2, 0.8) },
      uColAway: { value: new THREE.Vector3(0.0, 0.7, 0.35) },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    depthTest: false,
    depthWrite: false,
  });
  material.uniforms.uColHome.value.set(homeColor.r, homeColor.g, homeColor.b);
  material.uniforms.uColAway.value.set(awayColor.r, awayColor.g, awayColor.b);

  quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  scene.add(quad);
}

// ============================================================================
// SIMULATION — set the SDF uniforms for match-time t each frame.
//
//   Each country = ONE growing ellipsoid on its own side, already in contact at
//   the centre from t=0. Both grow CONTINUOUSLY (swell + rise upward) over the
//   match, the dominant side growing more. Momentum drives uPush, which shoves
//   the deforming seam plane toward the loser so the winner BULGES into and
//   DENTS the loser; momentum reversal dents back. They are combined by a
//   CLIPPED seam (max(blob, ±seam)), NOT smin → no fusing, distinct colours.
//   Vigorous play sprouts intra-team tendrils. Goals = a smooth ~6-min surge
//   (extra growth + stronger shove) settling to a small permanent bump.
// ============================================================================
function syncEruptions(t) {
  if (t < lastSimT - 0.001) {           // scrubbed backwards → reset transients
    activeEruptions = []; eruptionCursor = 0;
    permHome = 0; permAway = 0; permPush = 0;
  }
  while (eruptionCursor < model.eruptions.length && model.eruptions[eruptionCursor].t <= t) {
    const e = model.eruptions[eruptionCursor++];
    if (e.isGoal) {
      activeEruptions.push({ t0: e.t, life: 6, amp0: 1.0, team: e.team, kind: 'goal' });
      if (e.team === 'home') { permHome += 0.12; permPush += 0.05; }
      else { permAway += 0.12; permPush -= 0.05; }
    } else {
      activeEruptions.push({ t0: e.t, life: 3, amp0: 0.22 + (e.xg || 0) * 0.8, team: e.team, kind: 'shot' });
    }
  }
}

// current goal/shot transient surge per team, plus a turbulence boost
function eruptionState(t) {
  let surgeHome = 0, surgeAway = 0, turb = 0;
  for (let i = 0; i < activeEruptions.length; i++) {
    const e = activeEruptions[i];
    const age = t - e.t0;
    if (age < 0 || age > e.life) continue;
    const rise = easeOut(clamp(age / 0.7, 0, 1));                          // fast rise
    const fall = 1 - clamp((age - e.life * 0.35) / (e.life * 0.65), 0, 1); // slow decay
    const a = e.amp0 * rise * fall;
    if (e.team === 'home') surgeHome = Math.max(surgeHome, a);
    else surgeAway = Math.max(surgeAway, a);
    turb = Math.max(turb, a * (e.kind === 'goal' ? 1.0 : 0.4));
  }
  return { surgeHome, surgeAway, turb };
}

function updateUniforms(t) {
  syncEruptions(t);
  const S = model.series;
  const u = material.uniforms;

  const dur = Math.max(1, model.duration);
  const intensity = clampSafe(at(S.intensity, t, model.STEP));
  const cumPH = clampSafe(at(S.cumPossHome, t, model.STEP));
  const cumPA = clampSafe(at(S.cumPossAway, t, model.STEP));
  const mom = clampSafe(at(S.mom, t, model.STEP), -1, 1);
  const cumMom = clampSafe(at(S.cumMom, t, model.STEP), -1, 1);
  const er = eruptionState(t);

  // --- continuous growth: starts solid (already touching), swells to full -----
  // growH ∈ ~[0.35..1] * dominance. Smooth + monotonic (tiny alive pulse only).
  const timeF = clamp(t / dur, 0, 1);
  const baseGrow = 0.35 + 0.65 * timeF;
  const alive = 0.04 * Math.sin(t * 0.55 + 0.4) + 0.03 * intensity; // gentle, non-jerky
  const growH = clamp((baseGrow * (0.7 + 0.6 * cumPH) + permHome + er.surgeHome * 0.35 + alive)
    * tune.growth, 0.2, 2.4);
  const growA = clamp((baseGrow * (0.7 + 0.6 * cumPA) + permAway + er.surgeAway * 0.35 + alive)
    * tune.growth, 0.2, 2.4);

  // ellipsoid radii: swell outward + rise (taller as it grows). Keep z slimmer.
  const rxH = 0.85 + 0.85 * growH, ryH = 1.05 + 1.35 * growH, rzH = 0.72 + 0.55 * growH;
  const rxA = 0.85 + 0.85 * growA, ryA = 1.05 + 1.35 * growA, rzA = 0.72 + 0.55 * growA;

  // centres sit just off the seam so the contact faces touch at the middle, and
  // drift outward + rise as the masses swell (erupting/overflowing read).
  const cyH = 0.6 + 0.55 * growH, cyA = 0.6 + 0.55 * growA;
  u.uCenHome.value.set(-(0.55 + 0.35 * growH), cyH, 0);
  u.uCenAway.value.set(+(0.55 + 0.35 * growA), cyA, 0);
  u.uRadHome.value.set(rxH, ryH, rzH);
  u.uRadAway.value.set(rxA, ryA, rzA);

  // --- the fighting seam: momentum shoves it into the loser -------------------
  // +push  → home presses, seam moves toward away (+x): home bulges in, dents away.
  // -push  → away presses back. Goals add permPush. Driven by live + cumulative.
  const push = clamp(0.6 * (0.25 * mom + 0.3 * cumMom + permPush), -0.9, 0.9) * tune.push;
  u.uSeamX.value = 0.0;
  u.uPush.value = push;

  // seam deformation churns harder during intense play / goals.
  u.uSeamBulge.value = clamp((0.18 + 0.45 * intensity + 0.6 * er.turb) * tune.bulge, 0.0, 1.4);

  // --- branches/tendrils: sprout on vigorous play, retract when calm ----------
  const vigorH = clamp(0.55 * intensity + 0.7 * Math.max(0, mom) + er.surgeHome, 0, 1.6);
  const vigorA = clamp(0.55 * intensity + 0.7 * Math.max(0, -mom) + er.surgeAway, 0, 1.6);
  u.uBranchHome.value = clamp(vigorH * tune.branches, 0, 1.6);
  u.uBranchAway.value = clamp(vigorA * tune.branches, 0, 1.6);

  u.uFoam.value = tune.foam;
  u.uTurb.value = clamp(0.4 * intensity + 1.0 * er.turb, 0, 2);
  u.uTime.value = t;
}

function clampSafe(v, lo = 0, hi = 1) {
  if (!Number.isFinite(v)) return lo;
  return clamp(v, lo, hi);
}

// ---- resize -----------------------------------------------------------------
function onResize() {
  const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * resScale);
  renderer.setSize(w, h, false);
  const dpr = renderer.getPixelRatio();
  material.uniforms.uRes.value.set(Math.max(1, w * dpr), Math.max(1, h * dpr));
}

// ---- main loop --------------------------------------------------------------
let lastNow = performance.now();
let fpsAccum = 0, fpsFrames = 0;
function loop(now) {
  const dt = Math.min(0.1, Math.max(0, (now - lastNow) / 1000));
  lastNow = now;

  if (model && playing) {
    clock += dt * tune.speed;
    if (clock >= model.duration) { clock = model.duration; playing = false; el('play').textContent = '▶ play'; }
  }
  simulateAndRender();

  // adaptive resolution: if we drop below ~45fps for a stretch, lower resScale.
  fpsAccum += dt; fpsFrames++;
  if (fpsAccum >= 1.0) {
    const fps = fpsFrames / fpsAccum;
    if (fps < 45 && resScale > 0.75) { resScale = 0.75; onResize(); }
    fpsAccum = 0; fpsFrames = 0;
  }
  requestAnimationFrame(loop);
}

function simulateAndRender() {
  if (!model || !renderer) return;
  const w = renderer.domElement.width, h = renderer.domElement.height;
  if (w < 2 || h < 2) return;             // resize guard for 0-size viewport
  updateUniforms(clock);
  lastSimT = clock;
  material.uniforms.uAzimuth.value = cam.az;
  material.uniforms.uPolar.value = cam.pol;
  material.uniforms.uDist.value = cam.dist;
  renderer.render(scene, camera);
  updateHud();
  updateCamReadout();
}

// dev hook for offscreen verification — set clock, force one sim+render.
window.__setClock = (min) => {
  if (!model) return;
  clock = clamp(Number(min) || 0, 0, model.duration);
  playing = false; lastSimT = -1;
  const pb = el('play'); if (pb) pb.textContent = '▶ play';
  simulateAndRender();
  return clock;
};

// ---- HUD --------------------------------------------------------------------
function updateHud() {
  const t = clock;
  let gH = model.shots.filter((s) => s.team === 'home' && s.isGoal && s.t <= t).length;
  let gA = model.shots.filter((s) => s.team === 'away' && s.isGoal && s.t <= t).length;
  if (t >= model.duration - 0.01) { gH = model.home.score; gA = model.away.score; }
  else { gH = Math.min(gH, model.home.score); gA = Math.min(gA, model.away.score); }

  const ph = Math.round(clampSafe(at(model.series.possHome, t, model.STEP)) * 100);
  const mom = clampSafe(at(model.series.mom, t, model.STEP), -1, 1);
  el('hScore').textContent = gH; el('aScore').textContent = gA;
  el('clk').textContent = Math.floor(t) + "'";
  el('hPoss').textContent = ph; el('aPoss').textContent = 100 - ph;
  el('mom').textContent = (mom >= 0 ? '+' : '') + mom.toFixed(2);
  el('hXg').textContent = xgUpTo(model.shots, 'home', t).toFixed(2);
  el('aXg').textContent = xgUpTo(model.shots, 'away', t).toFixed(2);
  const clk = el('clock');
  if (document.activeElement !== clk) clk.value = String((t / model.duration) * 100);
  el('clockV').textContent = Math.floor(t) + "'";
}

function updateCamReadout() {
  const az = THREE.MathUtils.radToDeg(cam.az);
  const pol = THREE.MathUtils.radToDeg(cam.pol);
  el('camread').textContent = `az ${az.toFixed(0)}° · pol ${pol.toFixed(0)}° · d ${cam.dist.toFixed(1)}`;
}

// ---- UI binding -------------------------------------------------------------
function bindUI() {
  const playBtn = el('play');
  playBtn.addEventListener('click', () => {
    if (!playing && clock >= model.duration) clock = 0;
    playing = !playing;
    playBtn.textContent = playing ? '❚❚ pause' : '▶ play';
  });
  el('restart').addEventListener('click', () => {
    clock = 0; lastSimT = -1; playing = true; playBtn.textContent = '❚❚ pause';
  });
  el('clock').addEventListener('input', () => {
    clock = (+el('clock').value / 100) * model.duration;
    playing = false; playBtn.textContent = '▶ play'; lastSimT = -1;
  });

  bindSlider('speed', 'speedV', (v) => { tune.speed = v; return v.toFixed(1) + '×'; });
  bindSlider('growth', 'growthV', (v) => { tune.growth = v; return v.toFixed(2); });
  bindSlider('push', 'pushV', (v) => { tune.push = v; return v.toFixed(2); });
  bindSlider('bulge', 'bulgeV', (v) => { tune.bulge = v; return v.toFixed(2); });
  bindSlider('branches', 'branchesV', (v) => { tune.branches = v; return v.toFixed(2); });
  bindSlider('foam', 'foamV', (v) => { tune.foam = v; return v.toFixed(2); });

  el('resetcam').addEventListener('click', () => {
    cam.az = 0.55; cam.pol = 1.02; cam.dist = 11.0;
  });
  el('copycam').addEventListener('click', async () => {
    const s = `{ az: ${cam.az.toFixed(3)}, pol: ${cam.pol.toFixed(3)}, dist: ${cam.dist.toFixed(2)} }`;
    try { await navigator.clipboard.writeText(s); el('camread').textContent = 'copied'; }
    catch { el('camread').textContent = s; }
  });

  bindOrbit();
}

function bindSlider(id, valId, fn) {
  const s = el(id), v = el(valId);
  if (!s) return;
  const apply = () => { v.textContent = fn(+s.value); };
  s.addEventListener('input', apply);
  apply();
}

// Orbit camera: drag updates az/polar, wheel updates dist. Computed in-shader.
function bindOrbit() {
  const canvas = el('stage');
  let dragging = false, lastX = 0, lastY = 0;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    cam.az -= dx * 0.006;
    cam.pol = clamp(cam.pol - dy * 0.006, camLimits.polMin, camLimits.polMax);
  });
  const endDrag = () => { dragging = false; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    cam.dist = clamp(cam.dist * (1 + Math.sign(e.deltaY) * 0.08), camLimits.distMin, camLimits.distMax);
  }, { passive: false });
}

// ============================================================================
// SHADERS
// ============================================================================
const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;

  uniform vec2  uRes;
  uniform float uTime;
  uniform float uAzimuth, uPolar, uDist;

  uniform vec3  uCenHome, uCenAway;     // ellipsoid centres
  uniform vec3  uRadHome, uRadAway;     // ellipsoid per-axis radii
  uniform float uSeamX, uPush, uSeamBulge;
  uniform float uBranchHome, uBranchAway;
  uniform float uFoam, uTurb;
  uniform vec3  uColHome, uColAway;

  // ---- smooth minimum (used ONLY intra-team, for tendrils) ------------------
  float smin(float a, float b, float k){
    float h = clamp(0.5 + 0.5*(b-a)/k, 0.0, 1.0);
    return mix(b, a, h) - k*h*(1.0-h);
  }

  // ellipsoid SDF (bounded, ~Lipschitz). r = per-axis radii.
  float sdEllipsoid(vec3 p, vec3 c, vec3 r){
    vec3 q = (p - c) / r;
    float k0 = length(q);
    float k1 = length(q / r);
    return k0 * (k0 - 1.0) / max(k1, 1e-4);
  }

  // capsule (line segment a->b, radius rr) — for organic tendrils
  float sdCapsule(vec3 p, vec3 a, vec3 b, float rr){
    vec3 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
    return length(pa - ba * h) - rr;
  }
  float h11(float n){ return fract(sin(n) * 43758.5453); }

  // ---- value noise + fbm (foam) ---------------------------------------------
  float h31(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float vn3(vec3 p){
    vec3 i = floor(p), f = fract(p);
    f = f*f*(3.0 - 2.0*f);
    float n = mix(
      mix(mix(h31(i+vec3(0,0,0)), h31(i+vec3(1,0,0)), f.x),
          mix(h31(i+vec3(0,1,0)), h31(i+vec3(1,1,0)), f.x), f.y),
      mix(mix(h31(i+vec3(0,0,1)), h31(i+vec3(1,0,1)), f.x),
          mix(h31(i+vec3(0,1,1)), h31(i+vec3(1,1,1)), f.x), f.y), f.z);
    return n*2.0 - 1.0;
  }
  float fbm(vec3 p){
    float s = 0.0, a = 0.5, n = 0.0;
    for (int o = 0; o < 4; o++){
      s += a * vn3(p);
      n += a; a *= 0.5; p *= 2.03;
    }
    return s / max(n, 1e-4);
  }

  // foam displacement amount (shared so normals match the surface)
  float foamAmp(){ return uFoam * (0.14 + 0.10 * uTurb); }

  // a few wandering tendrils sprouting from a blob centre, smin'd into it.
  // dir seeds vary with a hash over time so they slowly wander (living growth).
  float teamBlobWithBranches(vec3 p, vec3 cen, vec3 rad, float branch, float seed){
    float d = sdEllipsoid(p, cen, rad);
    if (branch <= 0.001) return d;
    float churn = uTime * 0.18;
    // up to 3 tendrils; count scales with branch amount
    for (int i = 0; i < 3; i++){
      float fi = float(i);
      if (branch < fi * 0.45) break;
      float s = seed + fi * 17.13;
      // wandering direction (mostly upward/outward), hash-jittered over time
      float a = h11(s + floor(churn)) * 6.2831 + churn;
      float upw = 0.55 + 0.4 * h11(s + 3.0);
      vec3 dir = normalize(vec3(cos(a) * 0.9, upw + 0.7, sin(a) * 0.6));
      // root just inside the surface, tip reaches outward
      float reach = (0.9 + 0.8 * h11(s + 7.0)) * (0.6 + branch);
      vec3 a0 = cen + dir * (0.35 * length(rad));
      vec3 b0 = cen + dir * (0.35 * length(rad) + reach);
      float rr = 0.18 + 0.10 * h11(s + 11.0);
      float dc = sdCapsule(p, a0, b0, rr);
      d = smin(d, dc, 0.35);            // intra-team blend → part of same entity
    }
    return d;
  }

  // ---- the scene SDF: two living blobs that FIGHT at a clipped seam ----------
  // returns distance; writes which mass is closer into sel (0=home..1=away)
  float mapBlend(vec3 p, out float sel){
    float dHome = teamBlobWithBranches(p, uCenHome, uRadHome, uBranchHome, 11.0);
    float dAway = teamBlobWithBranches(p, uCenAway, uRadAway, uBranchAway, 91.0);

    // churning foam surface: displace inward by fbm (flows upward, swirls).
    float flow = uTime * 0.25;
    float f = fbm(p * 1.15 + vec3(0.0, -flow, flow*0.4))
            + 0.5 * fbm(p * 2.7 + vec3(flow*0.3, flow*0.6, 0.0));
    float disp = foamAmp() * f;
    dHome -= disp;
    dAway -= disp;

    // --- deforming-seam clip: each team owns one side of a living plane ------
    // bulge: fbm-driven living deformation of the contact + momentum shove.
    float bulge = fbm(vec3(p.y * 1.3, p.z * 1.3, uTime * 0.25)) * uSeamBulge + uPush;
    float seam = p.x - (uSeamX + bulge);     // <0 home side, >0 away side
    dHome = max(dHome,  seam);                // home occupies x < seam; face carved by seam
    dAway = max(dAway, -seam);                // away occupies x > seam; the loser is dented

    // colour: pick by closer mass with a tiny smooth band at the seam.
    sel = clamp(0.5 + 0.5 * (dHome - dAway) / 0.06, 0.0, 1.0);

    return min(dHome, dAway);                 // NOT smin → sharp fighting seam
  }
  float map(vec3 p){ float s; return mapBlend(p, s); }

  // tetrahedron-gradient normal
  vec3 calcNormal(vec3 p){
    const vec2 e = vec2(1.0, -1.0) * 0.0015;
    return normalize(
      e.xyy * map(p + e.xyy) +
      e.yyx * map(p + e.yyx) +
      e.yxy * map(p + e.yxy) +
      e.xxx * map(p + e.xxx));
  }

  // cheap soft AO from SDF samples along the normal
  float calcAO(vec3 p, vec3 n){
    float occ = 0.0, sca = 1.0;
    for (int i = 0; i < 5; i++){
      float hr = 0.02 + 0.12 * float(i);
      float dd = map(p + n * hr);
      occ += (hr - dd) * sca;
      sca *= 0.72;
    }
    return clamp(1.0 - 2.2 * occ, 0.0, 1.0);
  }

  // build a ray from orbit uniforms (origin/dir in world space)
  void makeRay(vec2 uv, out vec3 ro, out vec3 rd){
    vec3 target = vec3(0.0, 1.4, 0.0);    // look at the collision zone
    float cp = cos(uPolar), sp = sin(uPolar);
    float ca = cos(uAzimuth), sa = sin(uAzimuth);
    vec3 dirToCam = vec3(sp * sa, cp, sp * ca);   // polar from +Y
    ro = target + dirToCam * uDist;

    vec3 fwd = normalize(target - ro);
    vec3 right = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
    vec3 up = cross(right, fwd);
    float aspect = uRes.x / max(uRes.y, 1.0);
    vec2 ndc = (uv * 2.0 - 1.0);
    ndc.x *= aspect;
    float fov = 0.80;                      // ~ tan(half-fov)
    rd = normalize(fwd + right * ndc.x * fov + up * ndc.y * fov);
  }

  void main(){
    vec3 ro, rd;
    makeRay(vUv, ro, rd);

    // raymarch
    float t = 0.0;
    float tmax = 30.0;
    bool hit = false;
    float sel = 0.5;
    vec3 p = ro;
    for (int i = 0; i < 96; i++){
      p = ro + rd * t;
      float d = mapBlend(p, sel);
      if (d < 0.001){ hit = true; break; }
      // clip(max) + fbm break the Lipschitz bound → conservative step factor.
      t += clamp(d * 0.6, 0.004, 0.5);    // shrink near surface; cap big leaps
      if (t > tmax) break;
    }

    // background: dark with faint vertical gradient
    vec3 bg = mix(vec3(0.030, 0.036, 0.052), vec3(0.020, 0.024, 0.036), vUv.y);

    vec3 col = bg;
    if (hit){
      vec3 n = calcNormal(p);
      float ao = calcAO(p, n);

      // matte clay/foam colour: pick by closer mass, blended across seam
      vec3 base = mix(uColHome, uColAway, smoothstep(0.0, 1.0, sel));

      // lighting: 1 key + soft fill + faint fresnel rim (low). No emissive.
      vec3 key = normalize(vec3(-0.5, 0.95, 0.45));
      vec3 fill = normalize(vec3(0.6, 0.3, -0.5));
      float kd = max(dot(n, key), 0.0);
      float fd = max(dot(n, fill), 0.0);
      vec3 viewDir = normalize(ro - p);
      float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);

      vec3 lit = base * (0.22 + 0.95 * kd)         // key
               + base * (0.28 * fd)                // soft fill
               + vec3(0.45, 0.50, 0.62) * (0.10 * fres); // subtle cool rim
      lit *= (0.55 + 0.45 * ao);

      // gentle specular sheen for a slightly waxy foam (low, not glow)
      vec3 h = normalize(key + viewDir);
      float spec = pow(max(dot(n, h), 0.0), 24.0) * 0.18;
      lit += vec3(spec);

      // distance fade into background
      float fog = 1.0 - exp(-0.018 * t * t * 0.04);
      col = mix(lit, bg, clamp(fog, 0.0, 0.85));
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;
