// stage4.js — "PASS LANDSCAPE" — a living Variable.io-style wave terrain whose
// relief shows WHERE THE PLAY IS, by PASSES. A gently undulating wave base PLUS
// a team-coloured pass-zone relief: cells where passes happen RISE; cells that
// go quiet sink back. Colour = the team currently in possession in that zone.
// When possession flips, the relief shifts toward the other team's colour.
//
// Real data only: /api/rich/{id} (default 1953888 France–Senegal; ?id=).
// model = buildModel(raw) gives shots/colours/duration/abbr; we normalize the
// RAW pass stream ourselves (buildModel drops pass x/y). Rendering is based on
// stage2's GPU height-texture displacement + ACES dark premium look.
//
// Self-contained: three.js (CDN) + claybattle.js (data) + passfield.js (sim).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildModel, at, xgUpTo, rgb01, hexToRgb, liftColor } from './claybattle.js';
import { normPasses, placeXY, PassGrid, RunningMax, clamp, lerp } from './passfield.js';

const ID = new URLSearchParams(location.search).get('id') || '1953888';
const el = (id) => document.getElementById(id);

// Reproduce the real JERSEY colours worn in this match (by team abbr).
// France home shirt = NAVY blue, Senegal = WHITE. Fall back to model hex.
const KIT = {
  FRA: '#22356d',   // France navy
  SEN: '#eef1f6',   // Senegal white
};

// ---- grid resolution (sim cells = vertices; texture is GX×GY) ---------------
// Fine extruded-cell landscape (Variable look). Default 120×72; up to 360×216.
let GX = 120, GY = 72;          // default fine zone relief
const GX_MIN = 24, GY_MIN = 14;
const GX_MAX = 360, GY_MAX = 216;
const MESH_SEG_CAP = 256;       // cap plane segments per axis for perf

// ---- scene state ------------------------------------------------------------
let renderer, scene, camera, controls;
let mesh, material, slab;
let heightTex, heightData;      // R32F, GX×GY normalized cell height
let colTex, colData;            // R32F, GX×GY away-share (0=home .. 1=away), -1=empty
let model = null, passes = [];
let grid, hMaxTrack;
let clock = 0, prevClock = 0, playing = true;
let passCursor = 0;             // next pass to deposit (passes sorted by t)
let domHome = 0.5;              // smoothed "who dominates recent passes" for HUD

// tuning (bound to sliders)
const tune = {
  speed: 14.8,        // stage2 default 3.7 × 4
  height: 1.6,        // relief height multiplier
  fade: 0.85,         // zone sink rate (per second decay rate)
  wave: 0.5,          // base noise wave amount
  steps: 14,          // terrace levels (height quantisation) — the Variable look
};

// transient event spikes (goals) that rise fast then settle.
let activeEvents = [];
let eventCursor = 0;

// ---- boot -------------------------------------------------------------------
init().catch((e) => fail(e && e.message || String(e)));

async function init() {
  if (!window.WebGLRenderingContext) throw new Error('WebGL not available in this browser');

  const raw = await fetch('/api/rich/' + ID).then((r) => {
    if (!r.ok) throw new Error('api ' + r.status);
    return r.json();
  });
  model = buildModel(raw);
  passes = normPasses(raw.passes);
  if (!passes.length) throw new Error('no passes in match data');

  setupThree();
  buildHeightfield();
  resetSim();
  bindUI();
  applyTeamColors();

  el('title4').textContent =
    `PASS LANDSCAPE · ${model.home.abbr || 'HOME'} ${model.home.score}–${model.away.score} ${model.away.abbr || 'AWAY'}`;
  el('hAbbr').textContent = model.home.abbr || 'HOME';
  el('aAbbr').textContent = model.away.abbr || 'AWAY';

  window.addEventListener('resize', onResize);
  onResize();
  requestAnimationFrame(loop);
}

function fail(msg) {
  const t = el('title4'); if (t) t.textContent = 'PASS LANDSCAPE · failed: ' + msg;
  const o = document.createElement('div');
  o.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'color:#f88;font:14px system-ui;text-align:center;padding:40px;z-index:99;background:#04050a;white-space:pre-wrap';
  o.textContent = 'PASS LANDSCAPE could not start: ' + msg +
    '\n\n(If three.js failed to load from the CDN, check your connection — it is loaded via esm.sh.)';
  document.body.appendChild(o);
}

// Cinematic 3/4 default angle (more side-on than top-down).
const DEFAULT_CAM = { az: 0.5, pol: 1.3, dist: 9 };   // radians, radians, world

// Position the camera from spherical angles (azimuth, polar, distance) around
// the current orbit target. polar≈1.3 sits closer to the horizon (side-on).
function setCamera(az, pol, dist) {
  const t = controls.target;
  const sp = Math.sin(pol), cp = Math.cos(pol);
  camera.position.set(
    t.x + dist * sp * Math.sin(az),
    t.y + dist * cp,
    t.z + dist * sp * Math.cos(az)
  );
  camera.lookAt(t);
  controls.update();
}

// ---- three.js setup (based on stage2) ---------------------------------------
function setupThree() {
  const canvas = el('stage');
  renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x04050a);
  scene.fog = new THREE.FogExp2(0x04050a, 0.072);

  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 4;
  controls.maxDistance = 30;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.target.set(0, 0.4, 0);

  // Cinematic 3/4 default: lower (closer to horizon), slightly side-on.
  setCamera(DEFAULT_CAM.az, DEFAULT_CAM.pol, DEFAULT_CAM.dist);

  const key = new THREE.DirectionalLight(0xfff2e6, 1.7);
  key.position.set(-6, 9, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x88aaff, 0.55);
  rim.position.set(7, 4, -6);
  scene.add(rim);
  scene.add(new THREE.HemisphereLight(0x44557a, 0x070a12, 0.55));
  scene.add(new THREE.AmbientLight(0x0e1220, 0.5));
}

// World footprint (pitch-ish 16:9.6).
const WORLD_X = 16, WORLD_Z = 9.6;

// ---- heightfield mesh (GPU displacement from DataTextures) ------------------
function buildHeightfield() {
  rebuildMesh();
}

function rebuildMesh() {
  if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); }
  if (heightTex) heightTex.dispose();
  if (colTex) colTex.dispose();

  // Mesh segments ≥ grid resolution (≈2× grid dim) so flat cell tops + near-
  // vertical step walls are crisp, but capped for perf at fine grids.
  const segX = Math.min(MESH_SEG_CAP, Math.max(GX, Math.min(GX * 2, MESH_SEG_CAP)));
  const segY = Math.min(MESH_SEG_CAP, Math.max(GY, Math.min(GY * 2, MESH_SEG_CAP)));
  const geo = new THREE.PlaneGeometry(WORLD_X, WORLD_Z, segX, segY);
  geo.rotateX(-Math.PI / 2);                 // flat in XZ, +Y up

  heightData = new Float32Array(GX * GY);
  colData = new Float32Array(GX * GY).fill(-1);
  heightTex = new THREE.DataTexture(heightData, GX, GY, THREE.RedFormat, THREE.FloatType);
  colTex = new THREE.DataTexture(colData, GX, GY, THREE.RedFormat, THREE.FloatType);
  for (const tx of [heightTex, colTex]) {
    // NEAREST → each grid cell becomes a FLAT-TOPPED plateau with hard edges
    // (extruded-cell look), not a smooth interpolated surface.
    tx.magFilter = THREE.NearestFilter;
    tx.minFilter = THREE.NearestFilter;
    tx.wrapS = THREE.ClampToEdgeWrapping;
    tx.wrapT = THREE.ClampToEdgeWrapping;
    tx.needsUpdate = true;
  }

  if (!material) {
    material = new THREE.ShaderMaterial({
      uniforms: {
        uHeight: { value: heightTex },
        uCol: { value: colTex },
        uTexel: { value: new THREE.Vector2(1 / GX, 1 / GY) },
        uHScale: { value: tune.height },
        uWave: { value: tune.wave },
        uLevels: { value: tune.steps },
        uHome: { value: new THREE.Color(0x22356d) },
        uAway: { value: new THREE.Color(0xeef1f6) },
        uLightDir: { value: new THREE.Vector3(-6, 9, 4).normalize() },
        uLightDir2: { value: new THREE.Vector3(7, 4, -6).normalize() },
        uWorld: { value: new THREE.Vector2(WORLD_X, WORLD_Z) },
        uTime: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
    });
    applyTeamColors();
  } else {
    material.uniforms.uHeight.value = heightTex;
    material.uniforms.uCol.value = colTex;
    material.uniforms.uTexel.value.set(1 / GX, 1 / GY);
  }

  mesh = new THREE.Mesh(geo, material);
  scene.add(mesh);

  if (!slab) {
    slab = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_X * 1.02, WORLD_Z * 1.02),
      new THREE.MeshStandardMaterial({ color: 0x06080f, roughness: 1, metalness: 0 })
    );
    slab.rotation.x = -Math.PI / 2;
    slab.position.y = -0.02;
    scene.add(slab);
  }
}

// ---- shaders ----------------------------------------------------------------
// Vertex: H = wave base (animated noise) + pass relief (height texture). Normal
// via finite differences of the SAME H so lighting reads the relief.
const VERT = /* glsl */`
  uniform sampler2D uHeight;
  uniform vec2 uTexel;
  uniform float uHScale;
  uniform float uWave;
  uniform float uLevels;   // terrace count (height quantisation)
  uniform vec2 uWorld;
  uniform float uTime;
  varying float vH;        // pass-relief only (for colour intensity)
  varying vec2 vUvN;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;

  // value noise for the living wave base
  float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
  float vn(vec2 p){
    vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    float a=h21(i), b=h21(i+vec2(1,0)), c=h21(i+vec2(0,1)), d=h21(i+vec2(1,1));
    return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
  }
  float waveBase(vec2 uv){
    float w = 0.0;
    w += sin(uv.x*6.2831*1.5 + uTime*0.6) * 0.5;
    w += sin((uv.x*0.7+uv.y*1.3)*6.2831 - uTime*0.4) * 0.3;
    w += (vn(uv*3.0 + vec2(uTime*0.05, uTime*0.03))-0.5) * 0.9;
    // subtler now — the stepped relief is the star
    return w * uWave * 0.10;
  }
  // Relief sampled with NEAREST (flat cell tops), then QUANTISED into discrete
  // terraces → the staged "лесенка" / extruded-blocks Variable aesthetic.
  float relief(vec2 uv){
    float r = texture2D(uHeight, uv).r;            // 0..~1.4, flat per cell
    float L = max(uLevels, 1.0);
    r = floor(r * L + 0.5) / L;                    // terrace into L steps
    return r * uHScale;
  }
  float H(vec2 uv){ return waveBase(uv) + relief(uv); }

  void main(){
    vec2 fuv = uv;
    vUvN = fuv;
    float h = H(fuv);
    vH = relief(fuv);

    float hl = H(fuv - vec2(uTexel.x, 0.0));
    float hr = H(fuv + vec2(uTexel.x, 0.0));
    float hd = H(fuv - vec2(0.0, uTexel.y));
    float hu = H(fuv + vec2(0.0, uTexel.y));
    float dx = (uWorld.x * uTexel.x) * 2.0;
    float dz = (uWorld.y * uTexel.y) * 2.0;
    vec3 n = normalize(vec3(-(hr-hl)/max(dx,1e-4), 1.0, -(hu-hd)/max(dz,1e-4)));
    vNormalW = n;

    vec3 pos = position;
    pos.y += h;
    vec4 wp = modelMatrix * vec4(pos, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

// Fragment: colour = team of recent passes in this cell. uCol holds away-share
// in [0,1]; -1 marks empty (no recent passes) → base wave colour. Relief height
// drives how strongly the team colour saturates above the calm base.
const FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D uCol;
  uniform vec3 uHome;
  uniform vec3 uAway;
  uniform vec3 uLightDir;
  uniform vec3 uLightDir2;
  uniform float uTime;
  varying float vH;
  varying vec2 vUvN;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;

  float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
  float vn(vec2 p){
    vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    float a=h21(i), b=h21(i+vec2(1,0)), c=h21(i+vec2(0,1)), d=h21(i+vec2(1,1));
    return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
  }

  void main(){
    vec3 N = normalize(vNormalW);

    // base calm landscape colour (cool slate) where no passes are happening
    vec3 baseCol = vec3(0.10, 0.13, 0.20);

    float share = texture2D(uCol, vUvN).r;       // -1 empty, else away-share 0..1
    float occupied = step(0.0, share);
    vec3 team = mix(uHome, uAway, clamp(share, 0.0, 1.0));

    // how risen this cell is → how much team colour shows over the base
    float lift = clamp(vH * 1.4, 0.0, 1.0);
    vec3 col = mix(baseCol, team, occupied * (0.25 + 0.75 * lift));

    // subtle marble so the surface reads as textured landscape
    float marble = vn(vUvN*26.0 + vec2(0.0, uTime*0.03))*0.5 + vn(vUvN*70.0)*0.25;
    col *= 0.78 + 0.34*marble;

    // lighting: two directional + ambient
    float d1 = max(dot(N, normalize(uLightDir)), 0.0);
    float d2 = max(dot(N, normalize(uLightDir2)), 0.0) * 0.5;
    col *= (0.24 + d1*1.0 + d2);

    // peaks read brighter, valleys sink darker (relief AO-ish)
    col *= 0.82 + clamp(vH*0.6, 0.0, 0.5);

    // gentle emissive glow on risen team zones (where the action is hot)
    col += team * occupied * smoothstep(0.35, 1.0, vH) * 0.35;

    // cinematic fresnel rim
    vec3 V = normalize(cameraPosition - vWorldPos);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    col += fres * 0.08 * mix(baseCol, team, occupied);

    gl_FragColor = vec4(col, 1.0);
  }
`;

// ---- colours ----------------------------------------------------------------
function teamRgb(side) {
  const abbr = model[side].abbr;
  if (abbr && KIT[abbr]) return rgb01(hexToRgb(KIT[abbr]));
  return rgb01(model[side].rgb);                // already lifted in buildModel
}
function teamCss(side) {
  const abbr = model[side].abbr;
  const c = (abbr && KIT[abbr]) ? hexToRgb(KIT[abbr]) : model[side].rgb;
  return `rgb(${c.r | 0},${c.g | 0},${c.b | 0})`;
}
function applyTeamColors() {
  if (!material || !model) return;
  const h = teamRgb('home'), a = teamRgb('away');
  material.uniforms.uHome.value.setRGB(h[0], h[1], h[2]);
  material.uniforms.uAway.value.setRGB(a[0], a[1], a[2]);
  document.documentElement.style.setProperty('--home-color', teamCss('home'));
  document.documentElement.style.setProperty('--away-color', teamCss('away'));
}

// ============================================================================
// THE SIMULATION — a decaying pass-density grid.
// Each frame: advance clock; for every pass in (prevClock, clock] deposit a soft
// gaussian splat into that team's accumulator at the pass start (+ a lighter
// splat at the pass end); then decay all cells toward 0 (fade). Cell height =
// normalized (hHome+hAway) → relief; cell colour = away-share = hAway/(hH+hA).
// Backward scrub → reset grid + cursor and fast-forward to the new clock.
// ============================================================================
// Splat radius in PITCH units (fraction of pitch width). Converted to cells per
// resolution so pass zones read the same physical size at any grid fineness.
const SPLAT_PITCH = 0.04;       // ~4% of pitch width
const END_SPLAT = 0.45;         // lighter splat weight at the pass end

function resetSim() {
  grid = new PassGrid(GX, GY);
  hMaxTrack = new RunningMax(0.4);
  passCursor = 0;
  eventCursor = 0;
  activeEvents = [];
  prevClock = 0;            // sim cursor only; module `clock` is owned by callers
  domHome = 0.5;
  heightData.fill(0);
  colData.fill(-1);
  heightTex.needsUpdate = true;
  colTex.needsUpdate = true;
}

// Deposit all passes whose t falls in (a, b].
function depositRange(a, b) {
  // splat radius in CELLS = pitch fraction × grid width (physically constant)
  const radius = Math.max(1, SPLAT_PITCH * GX);
  while (passCursor < passes.length && passes[passCursor].t <= b) {
    const p = passes[passCursor];
    if (p.t > a) {
      // half-time end-swap placement (per-team normalised → shared pitch)
      const s = placeXY(p.xn, p.yn, p.team, p.t);
      const e = placeXY(p.exn, p.eyn, p.team, p.t);
      grid.splat(s.x, s.y, p.team, 1.0, radius);
      grid.splat(e.x, e.y, p.team, END_SPLAT, radius);
    }
    passCursor++;
  }
}

// Goal events: a sharp tall spike near the scoring team's attacking third that
// rises fast then settles. (Event-glyph hook: add raised triangles/markers here.)
function syncEvents(t) {
  while (eventCursor < model.shots.length && model.shots[eventCursor].t <= t) {
    const s = model.shots[eventCursor++];
    if (s.isGoal) {
      // place the goal on the shared pitch with the half-time end-swap, then
      // bias toward whichever goal this team is ATTACKING at that moment.
      const pl = placeXY(s.x, s.y, s.team, s.t);
      const secondHalf = s.t >= 45;
      // home attacks x=1 in 1st half, x=0 in 2nd (and vice-versa for away)
      const attacksRight = (s.team === 'home') ? !secondHalf : secondHalf;
      const ex = attacksRight ? Math.max(pl.x, 0.72) : Math.min(pl.x, 0.28);
      activeEvents.push({ x: ex, y: pl.y, team: s.team, tStart: s.t, life: 5 });
      // >>> EVENT GLYPH HOOK: place a raised triangle / marker mesh here later.
    }
  }
}
function applyEventSpikes(t) {
  const radius = Math.max(1, SPLAT_PITCH * GX);
  for (let i = activeEvents.length - 1; i >= 0; i--) {
    const e = activeEvents[i];
    const age = t - e.tStart;
    if (age < 0) continue;
    if (age > e.life) { activeEvents.splice(i, 1); continue; }
    // fast rise (~0.15 min) then ease down; finer + taller than base relief
    const rise = Math.min(1, age / 0.15);
    const fall = 1 - clamp((age - 0.15) / (e.life - 0.15), 0, 1);
    const amp = 2.6 * rise * fall;
    grid.splat(e.x, e.y, e.team, amp, radius);
  }
}

// Advance the sim to match-time `t`, then write height + colour textures.
function stepSim(t, dt) {
  // handle backward scrub: reset and fast-forward
  if (t < prevClock - 1e-4) {
    resetSim();
    fastForward(t);
    prevClock = t;
    writeTextures();
    return;
  }

  depositRange(prevClock, t);
  syncEvents(t);
  applyEventSpikes(t);

  // decay everything: rate scaled by fade slider; dt is REAL seconds (so the
  // visible sink speed is tied to wall time, feels consistent across speeds)
  const rate = tune.fade * 1.1;
  grid.decay(Math.exp(-rate * Math.max(dt, 1e-4)));

  prevClock = t;
  writeTextures();
}

// Fast-forward the grid from 0 to t in coarse chunks (used after a backward
// scrub / restart-to-middle). Decays as it goes so the result matches.
function fastForward(t) {
  const CHUNK = 0.5;     // match-minutes per step
  const rate = tune.fade * 1.1;
  let a = 0;
  // approximate sim-seconds per chunk from current speed so decay looks right
  const secPerMin = 1 / Math.max(0.2, tune.speed);
  while (a < t) {
    const b = Math.min(t, a + CHUNK);
    depositRange(a, b);
    syncEvents(b);
    applyEventSpikes(b);
    grid.decay(Math.exp(-rate * (b - a) * secPerMin));
    a = b;
  }
}

// Write normalized cell height + away-share into the DataTextures.
function writeTextures() {
  const n = GX * GY;
  // find frame max to feed the running-max normalizer
  let frameMax = 0;
  for (let k = 0; k < n; k++) { const v = grid.total(k); if (v > frameMax) frameMax = v; }
  hMaxTrack.observe(frameMax);
  const inv = 1 / hMaxTrack.m;

  let hSum = 0, aSum = 0;
  for (let k = 0; k < n; k++) {
    const hh = grid.hHome[k], ha = grid.hAway[k];
    const tot = hh + ha;
    let nh = tot * inv;
    if (!Number.isFinite(nh)) nh = 0;
    heightData[k] = nh > 0 ? Math.min(nh, 1.4) : 0;
    // colour: away-share where occupied, else -1 (empty → base wave colour)
    colData[k] = tot > 1e-4 ? (ha / tot) : -1;
    hSum += hh; aSum += ha;
  }
  // smoothed "who dominates recent passes" for the HUD
  const tot = hSum + aSum;
  const targetHome = tot > 1e-4 ? hSum / tot : 0.5;
  domHome = lerp(domHome, targetHome, 0.12);

  heightTex.needsUpdate = true;
  colTex.needsUpdate = true;
}

// ---- grid-resolution change -------------------------------------------------
function setResolution(gx, gy) {
  GX = clamp(gx | 0, GX_MIN, GX_MAX);
  GY = clamp(gy | 0, GY_MIN, GY_MAX);
  rebuildMesh();
  resetSim();
  // re-run the sim up to the current clock so the new grid matches the moment
  fastForward(clock);
  prevClock = clock;
  writeTextures();
}

// ---- resize -----------------------------------------------------------------
function onResize() {
  const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// ---- main loop --------------------------------------------------------------
let lastNow = performance.now();
function loop(now) {
  const dt = Math.min(0.1, Math.max(0, (now - lastNow) / 1000));
  lastNow = now;

  if (model && playing) {
    clock += dt * tune.speed;
    if (clock >= model.duration) { clock = model.duration; playing = false; el('play').textContent = '▶ play'; }
  }

  if (model && grid) stepSim(clock, dt);

  if (material) {
    material.uniforms.uHScale.value = tune.height;
    material.uniforms.uWave.value = tune.wave;
    material.uniforms.uLevels.value = tune.steps;
    hMaxTrack.ease(dt);
    material.uniforms.uTime.value = now / 1000;
  }

  controls.update();
  renderer.render(scene, camera);
  updateHud();
  updateCamReadout();
  requestAnimationFrame(loop);
}

// ---- HUD --------------------------------------------------------------------
function updateHud() {
  if (!model) return;
  const t = clock;
  let gH = model.shots.filter((s) => s.team === 'home' && s.isGoal && s.t <= t).length;
  let gA = model.shots.filter((s) => s.team === 'away' && s.isGoal && s.t <= t).length;
  if (t >= model.duration - 0.01) { gH = model.home.score; gA = model.away.score; }
  else { gH = Math.min(gH, model.home.score); gA = Math.min(gA, model.away.score); }

  el('hScore').textContent = gH; el('aScore').textContent = gA;
  el('clk').textContent = Math.floor(t) + "'";

  const ph = Math.round(domHome * 100);
  el('hPoss').textContent = ph; el('aPoss').textContent = 100 - ph;
  // who currently dominates by recent passes
  const dom = domHome >= 0.5 ? (model.home.abbr || 'HOME') : (model.away.abbr || 'AWAY');
  const domEl = el('dom');
  domEl.textContent = dom;
  domEl.className = domHome >= 0.5 ? 'home' : 'away';

  el('hXg').textContent = xgUpTo(model.shots, 'home', t).toFixed(2);
  el('aXg').textContent = xgUpTo(model.shots, 'away', t).toFixed(2);
  if (document.activeElement !== el('clock')) el('clock').value = String((t / model.duration) * 100);
}

// ---- camera readout + copy --------------------------------------------------
function updateCamReadout() {
  if (!controls) return;
  const az = THREE.MathUtils.radToDeg(controls.getAzimuthalAngle());
  const pol = THREE.MathUtils.radToDeg(controls.getPolarAngle());
  const dist = camera.position.distanceTo(controls.target);
  el('camread').textContent = `az ${az.toFixed(0)}° · pol ${pol.toFixed(0)}° · d ${dist.toFixed(1)}`;
}

// ---- UI binding -------------------------------------------------------------
function bindUI() {
  const playBtn = el('play');
  playBtn.addEventListener('click', () => {
    if (!model) return;
    if (!playing && clock >= model.duration) { resetSim(); clock = 0; }
    playing = !playing;
    playBtn.textContent = playing ? '❚❚ pause' : '▶ play';
  });
  el('restart').addEventListener('click', () => {
    resetSim(); clock = 0; playing = true; playBtn.textContent = '❚❚ pause';
  });
  el('clock').addEventListener('input', () => {
    if (!model) return;
    clock = (+el('clock').value / 100) * model.duration;
    playing = false; playBtn.textContent = '▶ play';
    // stepSim handles backward scrub; forward scrub just deposits the gap.
  });

  bindSlider('speed', 'speedV', (v) => { tune.speed = v; return v.toFixed(1) + '×'; });
  bindSlider('height', 'heightV', (v) => { tune.height = v; return v.toFixed(2); });
  bindSlider('fade', 'fadeV', (v) => { tune.fade = v; return v.toFixed(2); });
  bindSlider('wave', 'waveV', (v) => { tune.wave = v; return v.toFixed(2); });
  bindSlider('steps', 'stepsV', (v) => { tune.steps = Math.round(v); return String(Math.round(v)); });

  // grid resolution: one slider drives both axes (keeps ~5:3 aspect)
  const gridS = el('grid'), gridV = el('gridV');
  const applyGrid = () => {
    const gx = clamp(+gridS.value, GX_MIN, GX_MAX);
    const gy = clamp(Math.round(gx * 0.6), GY_MIN, GY_MAX);
    gridV.textContent = `${gx}×${gy}`;
    setResolution(gx, gy);
  };
  gridS.addEventListener('change', applyGrid);     // rebuild on release (cheaper)
  gridV.textContent = `${GX}×${GY}`;

  el('resetcam').addEventListener('click', () => {
    controls.target.set(0, 0.4, 0);
    setCamera(DEFAULT_CAM.az, DEFAULT_CAM.pol, DEFAULT_CAM.dist);
  });
  el('copycam').addEventListener('click', async () => {
    const s = `{ pos: [${camera.position.x.toFixed(2)}, ${camera.position.y.toFixed(2)}, ${camera.position.z.toFixed(2)}], ` +
      `target: [${controls.target.x.toFixed(2)}, ${controls.target.y.toFixed(2)}, ${controls.target.z.toFixed(2)}] }`;
    try { await navigator.clipboard.writeText(s); el('camread').textContent = 'copied'; }
    catch { el('camread').textContent = s; }
  });
}

function bindSlider(id, valId, fn) {
  const s = el(id), v = el(valId);
  const apply = () => { v.textContent = fn(+s.value); };
  s.addEventListener('input', apply);
  apply();
}

// ---- dev hook ---------------------------------------------------------------
// Set the clock (match-minutes), step the sim, render exactly one frame.
window.__setClock = (min) => {
  if (!model) return;
  clock = clamp(+min || 0, 0, model.duration);
  playing = false;
  const playBtn = el('play'); if (playBtn) playBtn.textContent = '▶ play';
  if (grid) stepSim(clock, 1 / 60);
  if (material) {
    material.uniforms.uHScale.value = tune.height;
    material.uniforms.uWave.value = tune.wave;
    material.uniforms.uLevels.value = tune.steps;
  }
  controls.update();
  renderer.render(scene, camera);
  updateHud();
  updateCamReadout();
};
