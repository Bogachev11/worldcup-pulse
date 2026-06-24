// stage6.js — "BATTLE OF MASSES · BRIGHT" — stage2's real 3D heightfield, but
// with VIVID, CLEAN colours and a colour boundary that actually tracks REAL
// possession + momentum (the H2 idea from stage5), instead of stage2's static
// mid-pitch seam and muddy/grey shading.
//
// Built on stage2 (which is left untouched). Same data + heightfield sim; the
// changes are all in the COLOUR path:
//   - team hues lifted to vivid (max-channel normalised) so blue/green ring out
//   - the colour seam (uFront) MOVES with possession share + live momentum, so
//     the field that each team OWNS matches who is on whom right now
//   - the team currently in possession stays bright; the passive team dims
//     toward `owner dim` (mirrors stage5 H2's possession gate)
//   - no orange magma / heavy marble / valley crush → colour stays clean
//
// Self-contained: only depends on three.js (CDN) + claybattle.js (local pure
// helpers). Does NOT import any existing pipeline file.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { clamp, lerp, smoothstep, fbm, buildModel, at, rgb01, xgUpTo } from './claybattle.js';

const ID = new URLSearchParams(location.search).get('id') || '1953888';
const el = (id) => document.getElementById(id);

// ---- grid resolution (segments) ---------------------------------------------
const GX = 200;   // along length (x: home goal 0 → away goal 1)
const GY = 120;   // across width (y)
const VX = GX + 1, VY = GY + 1;          // vertex counts
const NV = VX * VY;

// ---- scene state ------------------------------------------------------------
let renderer, scene, camera, controls;
let heightTex, heightData;               // DataTexture (R32F) of per-vertex H
let mesh, material;
let model = null;                        // built data model
let clock = 0, playing = true;
let lastSimT = -1;                       // last match-time we recomputed H at
let uPossCur = 0.5;                      // smoothed live away-possession share (0 home..1 away)

// tuning (bound to sliders)
const tune = {
  speed: 3.7,
  heightScale: 2.2,
  turbulence: 3.0,
  ridgeSharp: 1.0,
  flowSpeed: 1.0,
  seamPoss: 0.6,    // how strongly the colour seam tracks possession share (0 = stay centred, 1 = full possession territory)
  ownerDim: 0.4,    // brightness floor of the team NOT currently in possession
  glow: 0.3,        // team-colour emissive lift on ridges/peaks
};

// transient eruption bumps that decay (built lazily as clock passes goals/shots)
let activeEruptions = [];
let eruptionCursor = 0;

// ---- boot -------------------------------------------------------------------
init().catch((e) => fail(e.message || String(e)));

async function init() {
  if (!window.WebGLRenderingContext) throw new Error('WebGL not available in this browser');

  const raw = await fetch('/api/rich/' + ID).then((r) => {
    if (!r.ok) throw new Error('api ' + r.status);
    return r.json();
  });
  model = buildModel(raw);

  setupThree();
  buildHeightfield();
  bindUI();
  applyTeamColors();

  el('title2').textContent =
    `BATTLE · BRIGHT · ${model.home.abbr || 'HOME'} ${model.home.score}–${model.away.score} ${model.away.abbr || 'AWAY'}`;
  el('hAbbr').textContent = model.home.abbr || 'HOME';
  el('aAbbr').textContent = model.away.abbr || 'AWAY';

  window.addEventListener('resize', onResize);
  onResize();
  requestAnimationFrame(loop);
}

function fail(msg) {
  const t = el('title2'); if (t) t.textContent = 'BATTLE · BRIGHT · failed: ' + msg;
  const o = document.createElement('div');
  o.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'color:#f88;font:14px system-ui;text-align:center;padding:40px;z-index:99;background:#04050a';
  o.textContent = 'BATTLE · BRIGHT could not start: ' + msg +
    '\n\n(If three.js failed to load from the CDN, check your connection — it is loaded via esm.sh.)';
  o.style.whiteSpace = 'pre-wrap';
  document.body.appendChild(o);
}

// ---- three.js setup ---------------------------------------------------------
function setupThree() {
  const canvas = el('stage');
  renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, preserveDrawingBuffer: true, // <- screenshot-able
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x04050a);
  // lighter fog so distant masses keep their colour (stage2 used 0.085 → muddy).
  scene.fog = new THREE.FogExp2(0x05070d, 0.042);

  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(0.0, 8.2, 11.5);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 4;
  controls.maxDistance = 30;
  controls.maxPolarAngle = Math.PI * 0.495;   // keep above the ground plane
  controls.target.set(0, 0.6, 0);

  // lighting: brighter, cooler key + fill + raised hemisphere so colour reads
  // vivid rather than dim clay.
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(-6, 9, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fc0ff, 0.8);
  rim.position.set(7, 4, -6);
  scene.add(rim);
  const hemi = new THREE.HemisphereLight(0x6f86b0, 0x0a0d16, 0.7);
  scene.add(hemi);
  scene.add(new THREE.AmbientLight(0x2a3450, 0.6));
}

// ---- heightfield mesh (custom shader; H comes from a DataTexture) -----------
function buildHeightfield() {
  const WORLD_X = 16, WORLD_Z = 9.6;      // pitch footprint (16:9.6 ~ pitch)
  const geo = new THREE.PlaneGeometry(WORLD_X, WORLD_Z, GX, GY);
  geo.rotateX(-Math.PI / 2);              // lay flat: plane now in XZ, +Y up

  heightData = new Float32Array(NV);
  heightTex = new THREE.DataTexture(heightData, VX, VY, THREE.RedFormat, THREE.FloatType);
  heightTex.magFilter = THREE.NearestFilter;
  heightTex.minFilter = THREE.NearestFilter;
  heightTex.needsUpdate = true;

  material = new THREE.ShaderMaterial({
    uniforms: {
      uHeight: { value: heightTex },
      uTexel: { value: new THREE.Vector2(1 / VX, 1 / VY) },
      uHScale: { value: 1.0 },
      uHome: { value: new THREE.Color(0x335a9a) },
      uAway: { value: new THREE.Color(0x12a060) },
      uFront: { value: 0.5 },             // LIVE colour seam (home left .. away right)
      uPoss: { value: 0.5 },              // live away-possession share (0 home..1 away)
      uDim: { value: 0.4 },               // passive-team brightness floor
      uGlow: { value: 0.3 },              // team-colour emissive lift
      uLightDir: { value: new THREE.Vector3(-6, 9, 4).normalize() },
      uLightDir2: { value: new THREE.Vector3(7, 4, -6).normalize() },
      uWorld: { value: new THREE.Vector2(WORLD_X, WORLD_Z) },
      uTime: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
  });

  mesh = new THREE.Mesh(geo, material);
  scene.add(mesh);

  // a faint dark base slab under the masses so edges don't float
  const slab = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD_X * 1.02, WORLD_Z * 1.02),
    new THREE.MeshStandardMaterial({ color: 0x0b0f1a, roughness: 1, metalness: 0 })
  );
  slab.rotation.x = -Math.PI / 2;
  slab.position.y = -0.02;
  scene.add(slab);
}

// ---- shaders ----------------------------------------------------------------
const VERT = /* glsl */`
  uniform sampler2D uHeight;
  uniform vec2 uTexel;
  uniform float uHScale;
  uniform vec2 uWorld;
  varying float vH;
  varying vec2 vUvN;       // normalized field coords [0,1]
  varying vec3 vNormalW;
  varying vec3 vWorldPos;

  float H(vec2 uv){ return texture2D(uHeight, uv).r * uHScale; }

  void main(){
    vec2 fuv = uv;
    vUvN = fuv;
    float h = H(fuv);
    vH = h;

    float hl = H(fuv - vec2(uTexel.x, 0.0));
    float hr = H(fuv + vec2(uTexel.x, 0.0));
    float hd = H(fuv - vec2(0.0, uTexel.y));
    float hu = H(fuv + vec2(0.0, uTexel.y));
    float dx = (uWorld.x * uTexel.x) * 2.0;
    float dz = (uWorld.y * uTexel.y) * 2.0;
    vec3 n = normalize(vec3(-(hr - hl) / max(dx,1e-4), 1.0, -(hu - hd) / max(dz,1e-4)));
    vNormalW = n;

    vec3 pos = position;
    pos.y += h;
    vec4 wp = modelMatrix * vec4(pos, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

// Fragment: COLOUR = the team that OWNS this cell (home left of the live seam
// uFront, away right of it), gated by who is currently in possession (uPoss):
// the possessing side stays vivid, the passive side dims toward uDim. Clean,
// bright clay — no orange magma, only a faint team-colour glow on the ridges.
const FRAG = /* glsl */`
  precision highp float;
  uniform vec3 uHome;
  uniform vec3 uAway;
  uniform float uFront;
  uniform float uPoss;
  uniform float uDim;
  uniform float uGlow;
  uniform vec3 uLightDir;
  uniform vec3 uLightDir2;
  uniform float uTime;
  varying float vH;
  varying vec2 vUvN;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;

  // cheap value noise for a SUBTLE clay texture (kept low so colour stays clean)
  float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
  float vn(vec2 p){
    vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    float a=h21(i), b=h21(i+vec2(1,0)), c=h21(i+vec2(0,1)), d=h21(i+vec2(1,1));
    return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
  }

  void main(){
    vec3 N = normalize(vNormalW);

    // OWNERSHIP: the LIVE seam (uFront) moves with possession + momentum, so the
    // territory each colour fills matches who is on whom. A small organic wobble.
    float jitter = (vn(vUvN.yy*7.0 + uTime*0.05) - 0.5) * 0.05;
    float side = smoothstep(uFront - 0.05 + jitter, uFront + 0.05 + jitter, vUvN.x); // 0 home → 1 away
    vec3 team = mix(uHome, uAway, side);

    // POSSESSION GATE (H2): the side that has the ball NOW stays bright; the
    // other dims toward uDim. possActive ≈1 if this cell's team is possessing.
    float possActive = mix(1.0 - uPoss, uPoss, side);
    float possGate = mix(uDim, 1.0, possActive);
    vec3 base = team * possGate;

    // SUBTLE clay texture (small amplitude → no dirty marbling)
    float marble = vn(vUvN*24.0 + vec2(0.0, uTime*0.04));
    base *= 0.92 + 0.10*marble;

    // lighting tuned so a fully-lit cell reads at ~its own colour (peak ≈ 1.0),
    // with a soft ambient floor so shadows stay coloured, not muddy/black.
    float d1 = max(dot(N, normalize(uLightDir)), 0.0);
    float d2 = max(dot(N, normalize(uLightDir2)), 0.0) * 0.5;
    vec3 col = base * (0.42 + d1*0.50 + d2*0.30);

    // faint TEAM-COLOUR glow on the tall contested ridges (vivid, not orange)
    col += team * possGate * smoothstep(0.6, 1.6, vH) * uGlow;

    // subtle fresnel rim for a cinematic edge
    vec3 V = normalize(cameraPosition - vWorldPos);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    col += fres * 0.08 * base;

    gl_FragColor = vec4(col, 1.0);   // ACES applied by the renderer
  }
`;

// ---- colors -----------------------------------------------------------------
// Lift each team colour to a VIVID version: normalise so the brightest channel
// is ~0.96 (keeps the hue, kills the dim/dirty look). Real team colours, just
// brighter — no invented hues.
function vivid(rgb) {
  const c = rgb01(rgb);
  const m = Math.max(c[0], c[1], c[2], 1e-3);
  const k = 0.85 / m;
  return [clamp(c[0] * k, 0, 1), clamp(c[1] * k, 0, 1), clamp(c[2] * k, 0, 1)];
}
function applyTeamColors() {
  const h = vivid(model.home.rgb), a = vivid(model.away.rgb);
  material.uniforms.uHome.value.setRGB(h[0], h[1], h[2]);
  material.uniforms.uAway.value.setRGB(a[0], a[1], a[2]);
  document.documentElement.style.setProperty('--home-color', `rgb(${model.home.rgb.r|0},${model.home.rgb.g|0},${model.home.rgb.b|0})`);
  document.documentElement.style.setProperty('--away-color', `rgb(${model.away.rgb.r|0},${model.away.rgb.g|0},${model.away.rgb.b|0})`);
}

// ============================================================================
// THE SIMULATION — identical heightfield to stage2 (real data). The only new
// signal feeding the COLOUR is the seam position, which now blends the live
// momentum push with the cumulative POSSESSION territory boundary.
// ============================================================================
const A_INSTANT = 0.18;
const B_ACCUM = 0.22;
const H_MAX = 0.9;
const BASE_AMP = 0.05;
const TURB_SCALE = 0.55;
const RIDGE_H = 1.3;
const RIDGE_W = 0.07;

let permFrontShove = 0;   // accumulated goal shoves on the front

// Front (colour seam) at row yN, time t: possession territory boundary blended
// toward centre by `seamPoss`, plus the live momentum push. All REAL data.
function frontAt(yN, t) {
  const mom = at(model.series.mom, t, model.STEP);
  const cumMom = at(model.series.cumMom, t, model.STEP);
  const possFront = clamp(at(model.series.cumPossHome, t, model.STEP), 0.05, 0.95); // home territory share
  const wave = (fbm(yN * 2.2, 0.0, t * 0.03, 3)) * 0.06;
  const base = lerp(0.5, possFront, clamp(tune.seamPoss, 0, 1));
  return clamp(base + A_INSTANT * mom + B_ACCUM * cumMom + wave + permFrontShove, 0.12, 0.88);
}

function syncEruptions(t) {
  if (t < lastSimT - 0.001) {
    activeEruptions = [];
    eruptionCursor = 0;
    permFrontShove = 0;
  }
  while (eruptionCursor < model.eruptions.length && model.eruptions[eruptionCursor].t <= t) {
    const e = model.eruptions[eruptionCursor++];
    if (e.isGoal) {
      const ex = e.team === 'home' ? Math.max(e.x, 0.7) : Math.min(e.x, 0.3);
      activeEruptions.push({ x: ex, y: e.y, amp0: 1.5, tStart: e.t, life: 6, perm: false });
      activeEruptions.push({ x: ex, y: e.y, amp0: 0.5, tStart: e.t, life: 1e9, perm: true });
      permFrontShove += (e.team === 'home' ? 0.05 : -0.05);
    } else {
      activeEruptions.push({ x: e.x, y: e.y, amp0: 0.3 + e.xg * 1.6, tStart: e.t, life: 3, perm: false });
    }
  }
}

function eruptionAt(xN, yN, t) {
  let sum = 0;
  for (let i = 0; i < activeEruptions.length; i++) {
    const e = activeEruptions[i];
    if (t < e.tStart) continue;
    let amp = e.amp0;
    if (!e.perm) {
      const age = t - e.tStart;
      if (age > e.life) continue;
      const rise = smoothstep(0, 0.6, age);
      const fall = 1 - smoothstep(e.life * 0.3, e.life, age);
      amp *= rise * fall;
    }
    const dx = xN - e.x, dy = yN - e.y;
    const r2 = dx * dx + dy * dy;
    sum += amp * Math.exp(-r2 / (2 * 0.0045));
  }
  return sum;
}

function computeHeight(t) {
  syncEruptions(t);
  const S = model.series;
  const intensity = at(S.intensity, t, model.STEP);
  const cumPH = at(S.cumPossHome, t, model.STEP);
  const cumPA = at(S.cumPossAway, t, model.STEP);
  const stress = at(S.cumStress, t, model.STEP);

  const homeBase = H_MAX * cumPH;
  const awayBase = H_MAX * cumPA;
  const turbAmp = (BASE_AMP + intensity * TURB_SCALE) * tune.turbulence;
  const flowZ = t * 0.5 * tune.flowSpeed;
  const ridgeW = RIDGE_W / Math.max(0.25, tune.ridgeSharp);
  const ridgeHeight = RIDGE_H * stress;

  const fronts = new Float32Array(VY);
  for (let j = 0; j < VY; j++) fronts[j] = frontAt(j / (VY - 1), t);

  let idx = 0;
  for (let j = 0; j < VY; j++) {
    const yN = j / (VY - 1);
    const front = fronts[j];
    for (let i = 0; i < VX; i++, idx++) {
      const xN = i / (VX - 1);
      const side = smoothstep(front - 0.10, front + 0.10, xN);
      let h = lerp(homeBase, awayBase, side);
      const dF = (xN - front) / ridgeW;
      h += ridgeHeight * Math.exp(-0.5 * dF * dF);
      h += turbAmp * fbm(xN * 6.0, yN * 4.0, flowZ, 4);
      h += eruptionAt(xN, yN, t);
      heightData[idx] = Math.max(0, h);
    }
  }
  heightTex.needsUpdate = true;
  lastSimT = t;
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
let simAccum = 0;
function loop(now) {
  const dt = Math.min(0.1, Math.max(0, (now - lastNow) / 1000));
  lastNow = now;

  if (model && playing) {
    clock += dt * tune.speed;
    if (clock >= model.duration) { clock = model.duration; playing = false; el('play').textContent = '▶ play'; }
  }

  simAccum += dt;
  if (model && (simAccum >= 1 / 30 || lastSimT < 0)) { simAccum = 0; computeHeight(clock); }

  if (material && model) {
    material.uniforms.uHScale.value = tune.heightScale;
    material.uniforms.uTime.value = clock * 0.5 * tune.flowSpeed;
    // live colour seam (mid-row front) + possession gate, eased to avoid flicker.
    material.uniforms.uFront.value = frontAt(0.5, clock);
    const possHome = clamp(at(model.series.possHome, clock, model.STEP), 0, 1);
    const targetAway = 1 - possHome;                       // uPoss: 0 home has ball .. 1 away
    uPossCur += (targetAway - uPossCur) * Math.min(1, dt * 3.0);
    material.uniforms.uPoss.value = uPossCur;
    material.uniforms.uDim.value = tune.ownerDim;
    material.uniforms.uGlow.value = tune.glow;
  }

  controls.update();
  renderer.render(scene, camera);
  updateHud();
  updateCamReadout();
  requestAnimationFrame(loop);
}

// ---- dev hook ---------------------------------------------------------------
// Set the clock (match-minutes), resim the height field, render exactly one
// frame. Lets a single frame be inspected even when rAF is throttled (hidden tab).
window.__setClock = (min) => {
  if (!model) return;
  clock = clamp(+min || 0, 0, model.duration);
  playing = false;
  const playBtn = el('play'); if (playBtn) playBtn.textContent = '▶ play';
  lastSimT = -1;
  computeHeight(clock);
  if (material) {
    material.uniforms.uHScale.value = tune.heightScale;
    material.uniforms.uTime.value = clock * 0.5 * tune.flowSpeed;
    material.uniforms.uFront.value = frontAt(0.5, clock);
    const possHome = clamp(at(model.series.possHome, clock, model.STEP), 0, 1);
    uPossCur = 1 - possHome;
    material.uniforms.uPoss.value = uPossCur;
    material.uniforms.uDim.value = tune.ownerDim;
    material.uniforms.uGlow.value = tune.glow;
  }
  controls.update();
  renderer.render(scene, camera);
  updateHud();
  updateCamReadout();
};

// ---- HUD --------------------------------------------------------------------
function updateHud() {
  if (!model) return;
  const t = clock;
  let gH = model.shots.filter((s) => s.team === 'home' && s.isGoal && s.t <= t).length;
  let gA = model.shots.filter((s) => s.team === 'away' && s.isGoal && s.t <= t).length;
  if (t >= model.duration - 0.01) { gH = model.home.score; gA = model.away.score; }
  else { gH = Math.min(gH, model.home.score); gA = Math.min(gA, model.away.score); }

  const ph = Math.round(at(model.series.possHome, t, model.STEP) * 100);
  const mom = at(model.series.mom, t, model.STEP);
  el('hScore').textContent = gH; el('aScore').textContent = gA;
  const mm = Math.floor(t);
  el('clk').textContent = mm + "'";
  el('hPoss').textContent = ph; el('aPoss').textContent = 100 - ph;
  el('mom').textContent = (mom >= 0 ? '+' : '') + mom.toFixed(2);
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
    if (!playing && clock >= model.duration) clock = 0;
    playing = !playing;
    playBtn.textContent = playing ? '❚❚ pause' : '▶ play';
  });
  el('restart').addEventListener('click', () => {
    clock = 0; lastSimT = -1; playing = true; playBtn.textContent = '❚❚ pause';
  });
  el('clock').addEventListener('input', () => {
    if (!model) return;
    clock = (+el('clock').value / 100) * model.duration;
    playing = false; playBtn.textContent = '▶ play';
    lastSimT = -1;
  });

  bindSlider('speed', 'speedV', (v) => { tune.speed = v; return v.toFixed(1) + '×'; });
  bindSlider('hscale', 'hscaleV', (v) => { tune.heightScale = v; return v.toFixed(2); });
  bindSlider('turb', 'turbV', (v) => { tune.turbulence = v; return v.toFixed(2); });
  bindSlider('ridge', 'ridgeV', (v) => { tune.ridgeSharp = v; lastSimT = -1; return v.toFixed(2); });
  bindSlider('flow', 'flowV', (v) => { tune.flowSpeed = v; return v.toFixed(2); });
  bindSlider('seam', 'seamV', (v) => { tune.seamPoss = v; lastSimT = -1; return v.toFixed(2); });
  bindSlider('ownerdim', 'ownerdimV', (v) => { tune.ownerDim = v; return v.toFixed(2); });
  bindSlider('glow', 'glowV', (v) => { tune.glow = v; return v.toFixed(2); });

  el('resetcam').addEventListener('click', () => {
    camera.position.set(0.0, 8.2, 11.5);
    controls.target.set(0, 0.6, 0);
    controls.update();
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
