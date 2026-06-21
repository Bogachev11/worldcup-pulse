// stage2.js — "BATTLE OF MASSES" — a real 3D WebGL heightfield stage driven by
// REAL match data (default France 3–1 Senegal, id 1953888). Two textured
// clay/lava masses fight across the pitch; the contested seam grows a glowing
// ridge; goals erupt; the whole terrain rises as the match is played.
//
// Self-contained: only depends on three.js (CDN) + claybattle.js (local pure
// helpers). Does NOT import any existing pipeline file. Aesthetic north star:
// Variable.io "Maintel Digital Landscape" — calm when stable, churning during
// disruption, color-coded regions, gallery-grade dark.

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

// tuning (bound to sliders)
const tune = {
  speed: 2.0,
  heightScale: 1.0,
  turbulence: 1.0,
  ridgeSharp: 1.0,
  flowSpeed: 1.0,
};

// transient eruption bumps that decay (built lazily as clock passes goals/shots)
// each: {x,y,team,amp0,tStart,life,perm} — perm bumps don't decay.
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
    `BATTLE 3D · ${model.home.abbr || 'HOME'} ${model.home.score}–${model.away.score} ${model.away.abbr || 'AWAY'}`;
  el('hAbbr').textContent = model.home.abbr || 'HOME';
  el('aAbbr').textContent = model.away.abbr || 'AWAY';

  window.addEventListener('resize', onResize);
  onResize();
  requestAnimationFrame(loop);
}

function fail(msg) {
  const t = el('title2'); if (t) t.textContent = 'BATTLE 3D · failed: ' + msg;
  const o = document.createElement('div');
  o.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'color:#f88;font:14px system-ui;text-align:center;padding:40px;z-index:99;background:#04050a';
  o.textContent = 'BATTLE 3D could not start: ' + msg +
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
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x04050a);
  scene.fog = new THREE.FogExp2(0x04050a, 0.085);

  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(0.0, 8.2, 11.5);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 4;
  controls.maxDistance = 30;
  controls.maxPolarAngle = Math.PI * 0.495;   // keep above the ground plane
  controls.target.set(0, 0.6, 0);

  // lighting: a warm key + cool fill + hemisphere for matte clay body
  const key = new THREE.DirectionalLight(0xfff0e0, 2.0);
  key.position.set(-6, 9, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x88aaff, 0.6);
  rim.position.set(7, 4, -6);
  scene.add(rim);
  const hemi = new THREE.HemisphereLight(0x445577, 0x080a10, 0.55);
  scene.add(hemi);
  scene.add(new THREE.AmbientLight(0x101420, 0.5));
}

// ---- heightfield mesh (custom shader; H comes from a DataTexture) -----------
function buildHeightfield() {
  // unit plane in XZ; we map u=x(length), v=y(width). World scale below.
  const WORLD_X = 16, WORLD_Z = 9.6;      // pitch footprint (16:9.6 ~ pitch)
  const geo = new THREE.PlaneGeometry(WORLD_X, WORLD_Z, GX, GY);
  geo.rotateX(-Math.PI / 2);              // lay flat: plane now in XZ, +Y up

  // height texture (one float per vertex)
  heightData = new Float32Array(NV);
  heightTex = new THREE.DataTexture(heightData, VX, VY, THREE.RedFormat, THREE.FloatType);
  // NearestFilter avoids needing OES_texture_float_linear; grid is dense (200x120)
  // and the shader smooths via finite-difference normals, so it reads smooth.
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
      uFront: { value: 0.5 },             // unused fallback; per-vertex via attr
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
    new THREE.MeshStandardMaterial({ color: 0x070910, roughness: 1, metalness: 0 })
  );
  slab.rotation.x = -Math.PI / 2;
  slab.position.y = -0.02;
  scene.add(slab);
}

// ---- shaders ----------------------------------------------------------------
// Vertex: read H from the height texture at this vertex's uv, displace +Y,
// and compute a normal by sampling neighbor heights (finite differences) so the
// terrain is lit without a CPU computeVertexNormals each frame.
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
    vec2 fuv = uv;           // plane uv 0..1 (built-in attribute)
    vUvN = fuv;
    float h = H(fuv);
    vH = h;

    // neighbor heights for normal (finite difference in world units)
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

// Fragment: color = blend of team hues across the frontline (carried in the
// height field's sign convention is not enough, so we pass front via texture's
// green-less channel? — instead we encode region in vUvN.x vs a per-frame front
// approximated by a uniform band). For richer color we marble by H + noise and
// add warm emissive in high/steep stress zones (glowing magma).
const FRAG = /* glsl */`
  precision highp float;
  uniform vec3 uHome;
  uniform vec3 uAway;
  uniform vec3 uLightDir;
  uniform vec3 uLightDir2;
  uniform float uTime;
  varying float vH;
  varying vec2 vUvN;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;

  // cheap hash noise for surface marbling
  float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
  float vn(vec2 p){
    vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    float a=h21(i), b=h21(i+vec2(1,0)), c=h21(i+vec2(0,1)), d=h21(i+vec2(1,1));
    return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
  }

  void main(){
    vec3 N = normalize(vNormalW);

    // region color: home left, away right; the seam location is encoded in the
    // green of nothing — we approximate the front as where the surface is
    // tallest-ridge-ish. Use uUvN.x with a soft marble jitter for an organic seam.
    float seam = 0.5;
    float jitter = (vn(vUvN.yy*7.0 + uTime*0.05) - 0.5) * 0.10;
    float side = smoothstep(seam - 0.12 + jitter, seam + 0.12 + jitter, vUvN.x);
    vec3 base = mix(uHome, uAway, side);

    // marble the body with height + noise so it reads as textured clay
    float marble = vn(vUvN*22.0 + vec2(0.0, uTime*0.04)) * 0.5 + vn(vUvN*60.0)*0.25;
    base *= 0.65 + 0.5*marble;

    // lighting (two directional + ambient)
    float d1 = max(dot(N, normalize(uLightDir)), 0.0);
    float d2 = max(dot(N, normalize(uLightDir2)), 0.0) * 0.5;
    float amb = 0.22;
    vec3 col = base * (amb + d1*1.0 + d2);

    // height ambient occlusion-ish darkening in valleys, brightening on peaks
    col *= 0.7 + clamp(vH*0.5, 0.0, 0.6);

    // ---- warm magma emissive in steep/high stress zones (lava in cracks) ----
    // steepness: how far the normal tilts from up
    float steep = 1.0 - clamp(N.y, 0.0, 1.0);
    float hot = smoothstep(0.35, 1.2, vH) * smoothstep(0.18, 0.7, steep);
    float flicker = 0.85 + 0.15*vn(vUvN*40.0 + uTime*0.6);
    vec3 magma = mix(vec3(1.0,0.35,0.06), vec3(1.0,0.85,0.4), hot) * hot * 1.6 * flicker;
    col += magma;

    // subtle fresnel rim for cinematic edge
    vec3 V = normalize(cameraPosition - vWorldPos);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    col += fres * 0.10 * base;

    // tone-ish clamp; ACES applied by renderer
    gl_FragColor = vec4(col, 1.0);
  }
`;

// ---- colors -----------------------------------------------------------------
function applyTeamColors() {
  const h = rgb01(model.home.rgb), a = rgb01(model.away.rgb);
  material.uniforms.uHome.value.setRGB(h[0], h[1], h[2]);
  material.uniforms.uAway.value.setRGB(a[0], a[1], a[2]);
  document.documentElement.style.setProperty('--home-color', `rgb(${model.home.rgb.r|0},${model.home.rgb.g|0},${model.home.rgb.b|0})`);
  document.documentElement.style.setProperty('--away-color', `rgb(${model.away.rgb.r|0},${model.away.rgb.g|0},${model.away.rgb.b|0})`);
}

// ============================================================================
// THE SIMULATION — compute the per-vertex height field H(x,y,t).
// Updated on the CPU at <=30Hz into heightData, then lerped/uploaded each frame.
//
//   front(y,t) = clamp(0.5 + A*mom + B*cumMom + ridgeWave(y,t), 0.12, 0.88)
//   teamBase(side,t) = hMax * cumPoss{side}(t)
//   ridge(x,y,t)     = stressHeight(t) * gaussian(|x-front(y)|, ridgeWidth)
//   noiseTex(x,y,t)  = (baseAmp + intensity(t)*turbScale) * fbm(x,y, t*flow)
//   eruptions(x,y,t) = Σ goal/shot bumps (transient gaussian, +permanent surge)
//   H = teamBase + ridge + noiseTex + eruptions
// ============================================================================
const A_INSTANT = 0.18;   // instant momentum push on the front
const B_ACCUM = 0.22;     // accumulated territorial drift
const H_MAX = 0.9;        // ceiling of a team's accumulated base height
const BASE_AMP = 0.05;    // calm surface texture amplitude
const TURB_SCALE = 0.55;  // extra texture during intense play
const RIDGE_H = 1.3;      // ridge height per unit stress
const RIDGE_W = 0.07;     // ridge half-width (smaller = sharper, scaled by slider)

function frontAt(yN, t) {
  const mom = at(model.series.mom, t, model.STEP);
  const cum = at(model.series.cumMom, t, model.STEP);
  const wave = (fbm(yN * 2.2, 0.0, t * 0.03, 3)) * 0.06; // wavy seam
  return clamp(0.5 + A_INSTANT * mom + B_ACCUM * cum + wave + permFrontShove, 0.12, 0.88);
}

let permFrontShove = 0;   // accumulated goal shoves on the front

// advance the discrete eruption list as the clock passes events
function syncEruptions(t) {
  // reset if we scrubbed backwards
  if (t < lastSimT - 0.001) {
    activeEruptions = [];
    eruptionCursor = 0;
    permFrontShove = 0;
  }
  while (eruptionCursor < model.eruptions.length && model.eruptions[eruptionCursor].t <= t) {
    const e = model.eruptions[eruptionCursor++];
    if (e.isGoal) {
      // transient tall eruption near the scoring team's attacking third
      const ex = e.team === 'home' ? Math.max(e.x, 0.7) : Math.min(e.x, 0.3);
      activeEruptions.push({ x: ex, y: e.y, amp0: 1.5, tStart: e.t, life: 6, perm: false });
      // permanent surge to that side + frontline shove toward opponent
      activeEruptions.push({ x: ex, y: e.y, amp0: 0.5, tStart: e.t, life: 1e9, perm: true });
      permFrontShove += (e.team === 'home' ? 0.05 : -0.05);
    } else {
      // non-goal shot: small transient bump scaled by xG
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
      // fast rise (~0.6 min) then decay over life
      const rise = smoothstep(0, 0.6, age);
      const fall = 1 - smoothstep(e.life * 0.3, e.life, age);
      amp *= rise * fall;
    }
    const dx = xN - e.x, dy = yN - e.y;
    const r2 = dx * dx + dy * dy;
    sum += amp * Math.exp(-r2 / (2 * 0.0045)); // tight gaussian
  }
  return sum;
}

// recompute the full height field at match-time t into heightData
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

  // precompute front per row (depends only on yN, t)
  const fronts = new Float32Array(VY);
  for (let j = 0; j < VY; j++) fronts[j] = frontAt(j / (VY - 1), t);

  let idx = 0;
  for (let j = 0; j < VY; j++) {
    const yN = j / (VY - 1);
    const front = fronts[j];
    for (let i = 0; i < VX; i++, idx++) {
      const xN = i / (VX - 1);
      // team base: blend across the seam so the two masses meet
      const side = smoothstep(front - 0.10, front + 0.10, xN); // 0 home → 1 away
      let h = lerp(homeBase, awayBase, side);

      // contested ridge along the seam
      const dF = (xN - front) / ridgeW;
      h += ridgeHeight * Math.exp(-0.5 * dF * dF);

      // multi-octave surface texture (churns with flow & intensity)
      h += turbAmp * fbm(xN * 6.0, yN * 4.0, flowZ, 4);

      // eruptions (goals/shots)
      h += eruptionAt(xN, yN, t);

      // never below the slab
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

  // recompute height at <=30Hz (CPU heightfield)
  simAccum += dt;
  if (model && (simAccum >= 1 / 30 || lastSimT < 0)) { simAccum = 0; computeHeight(clock); }

  if (material) {
    material.uniforms.uHScale.value = tune.heightScale;
    material.uniforms.uTime.value = clock * 0.5 * tune.flowSpeed;
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
    lastSimT = -1; // force resim (handles scrub backwards)
  });

  bindSlider('speed', 'speedV', (v) => { tune.speed = v; return v.toFixed(1) + '×'; });
  bindSlider('hscale', 'hscaleV', (v) => { tune.heightScale = v; return v.toFixed(2); });
  bindSlider('turb', 'turbV', (v) => { tune.turbulence = v; return v.toFixed(2); });
  bindSlider('ridge', 'ridgeV', (v) => { tune.ridgeSharp = v; lastSimT = -1; return v.toFixed(2); });
  bindSlider('flow', 'flowV', (v) => { tune.flowSpeed = v; return v.toFixed(2); });

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
