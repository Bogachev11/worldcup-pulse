// stage3.js — "ERUPTION" — two coherent foam masses raymarched as SDFs.
//
// Vision: a flask-of-cola-and-Mentos battle. Each country is ONE coherent foam
// mass (a tapered capsule / round cone) that ERUPTS upward at ~45° from its goal
// end toward the centre. The two masses are combined with a smooth-minimum
// (smin) so they MERGE and PRESS into each other near the top-centre, forming a
// bulging collision seam that marbles blue↔green. Over match time the masses
// grow taller and bulkier and push harder; goals trigger a cola-burst surge.
//
// Tech: a single full-screen quad with a fragment shader that RAYMARCHES the
// signed-distance field. ONE SDF primitive per country (not many blobs). fbm
// noise displaces the surface for churning foam. Matte clay/foam shading with a
// key + soft fill + faint fresnel rim. NO bloom, NO emissive glow.
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
  mass: 1.0,        // overall radius/thickness multiplier
  rise: 1.0,        // eruption height multiplier
  merge: 0.6,       // smin k — how gooey the press is
  foam: 1.0,        // foam noise amount
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
      // two-mass geometry (data driven, set per frame)
      uBaseHome: { value: new THREE.Vector3(-2.2, 0, 0) },
      uBaseAway: { value: new THREE.Vector3(2.2, 0, 0) },
      uDirHome: { value: new THREE.Vector3(1, 1, 0).normalize() },
      uDirAway: { value: new THREE.Vector3(-1, 1, 0).normalize() },
      uLenHome: { value: 0.6 },
      uLenAway: { value: 0.6 },
      uRadHome: { value: 0.9 },
      uRadAway: { value: 0.9 },
      uTipHome: { value: 0.45 },
      uTipAway: { value: 0.45 },
      uMergeK: { value: tune.merge },
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
//   Each country = ONE round cone from its goal-end base, erupting at 45° toward
//   the centre. LEN grows over the match (more if they dominated possession);
//   RAD (thickness) grows modestly + permanent goal bumps. Momentum pushes the
//   seam (uPush) — the stronger team shoves the collision into the weaker side.
//   Goals = fast LEN/RAD surge decaying over ~6 match-min + a small permanent
//   bump. The smin(k) merges the two cones into a pressing collision ridge.
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

  // --- eruption height: grows over the match, more if they dominated ----------
  const timeF = clamp(t / dur, 0, 1);
  const growthHome = clamp(0.2 + 0.8 * timeF * (0.6 + 0.8 * cumPH), 0, 1);
  const growthAway = clamp(0.2 + 0.8 * timeF * (0.6 + 0.8 * cumPA), 0, 1);
  const lenHome = lerp(0.6, 3.4, growthHome) * tune.rise + er.surgeHome * 0.9 * tune.rise;
  const lenAway = lerp(0.6, 3.4, growthAway) * tune.rise + er.surgeAway * 0.9 * tune.rise;

  // --- thickness: modest growth + permanent goal bumps + active pulsing --------
  const pulse = 0.06 * intensity;
  const radHome = (0.85 + 0.45 * cumPH + permHome + 0.30 * er.surgeHome + pulse) * tune.mass;
  const radAway = (0.85 + 0.45 * cumPA + permAway + 0.30 * er.surgeAway + pulse) * tune.mass;

  // --- pressing: momentum shifts the seam; stronger team pushes into weaker ----
  // uPush ∈ ~[-0.5,0.5]; +push = home advancing (shove seam toward away/+x).
  const push = clamp(0.18 * mom + 0.22 * cumMom + permPush, -0.55, 0.55);

  // Bias the bases & aim along x by push so the collision point moves and the
  // stronger mass leans further over the opponent. Keep z thin but a bit fat.
  const baseHomeX = -2.2 + push * 0.6;
  const baseAwayX = 2.2 + push * 0.6;
  u.uBaseHome.value.set(baseHomeX, 0, 0);
  u.uBaseAway.value.set(baseAwayX, 0, 0);

  // aim: home erupts toward +x,+y; push nudges aim further over centre when
  // dominating. Keep a slight z so masses are not razor-thin.
  const aimHome = new THREE.Vector3(1 + push * 0.5, 1, 0).normalize();
  const aimAway = new THREE.Vector3(-1 + push * 0.5, 1, 0).normalize();
  u.uDirHome.value.copy(aimHome);
  u.uDirAway.value.copy(aimAway);

  u.uLenHome.value = clamp(lenHome, 0.4, 5.5);
  u.uLenAway.value = clamp(lenAway, 0.4, 5.5);
  u.uRadHome.value = clamp(radHome, 0.4, 2.6);
  u.uRadAway.value = clamp(radAway, 0.4, 2.6);
  u.uTipHome.value = clamp(u.uRadHome.value * (0.42 + 0.10 * er.surgeHome), 0.18, 1.4);
  u.uTipAway.value = clamp(u.uRadAway.value * (0.42 + 0.10 * er.surgeAway), 0.18, 1.4);

  u.uMergeK.value = clamp(tune.merge, 0.05, 1.6);
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
  bindSlider('mass', 'massV', (v) => { tune.mass = v; return v.toFixed(2); });
  bindSlider('rise', 'riseV', (v) => { tune.rise = v; return v.toFixed(2); });
  bindSlider('merge', 'mergeV', (v) => { tune.merge = v; return v.toFixed(2); });
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

  uniform vec3  uBaseHome, uBaseAway, uDirHome, uDirAway;
  uniform float uLenHome, uLenAway, uRadHome, uRadAway, uTipHome, uTipAway;
  uniform float uMergeK, uFoam, uTurb;
  uniform vec3  uColHome, uColAway;

  // ---- smooth minimum (the press/merge) -------------------------------------
  float smin(float a, float b, float k){
    float h = clamp(0.5 + 0.5*(b-a)/k, 0.0, 1.0);
    return mix(b, a, h) - k*h*(1.0-h);
  }

  // tapered capsule / round cone between a and b with radii ra (base) -> rb (tip)
  float sdRoundCone(vec3 p, vec3 a, vec3 b, float ra, float rb){
    vec3 ba = b - a;
    float l2 = max(dot(ba, ba), 1e-5);
    float y = clamp(dot(p - a, ba) / l2, 0.0, 1.0);
    vec3 pa = p - a - ba * y;
    return length(pa) - mix(ra, rb, y);
  }

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
  float foamAmp(){ return uFoam * (0.16 + 0.10 * uTurb); }

  // ---- the scene SDF: two round cones merged with smin + foam ---------------
  // returns distance; writes which mass is closer into sel (0=home..1=away)
  float mapBlend(vec3 p, out float sel){
    vec3 tipH = uBaseHome + normalize(uDirHome) * uLenHome;
    vec3 tipA = uBaseAway + normalize(uDirAway) * uLenAway;
    float dH = sdRoundCone(p, uBaseHome, tipH, uRadHome, uTipHome);
    float dA = sdRoundCone(p, uBaseAway, tipA, uRadAway, uTipAway);

    // colour selection blended across the smin contact band → marbled seam
    float band = max(uMergeK, 0.3);
    sel = clamp(0.5 + 0.5*(dH - dA)/band, 0.0, 1.0);

    float d = smin(dH, dA, uMergeK);

    // churning foam surface: displace inward by fbm so the surface looks like
    // erupting foam. Flow upward + swirl over time.
    float flow = uTime * 0.25;
    float f = fbm(p * 1.15 + vec3(0.0, -flow, flow*0.4))
            + 0.5 * fbm(p * 2.7 + vec3(flow*0.3, flow*0.6, 0.0));
    d -= foamAmp() * f;
    return d;
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
      t += max(d * 0.7, 0.004);           // shrink steps near surface for stability
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
