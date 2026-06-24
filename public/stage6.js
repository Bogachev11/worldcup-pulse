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

// baked-in default camera (user-tuned)
const DEFAULT_CAM = { pos: [-12.86, 18.18, 17.62], target: [-1.43, 1.97, -0.48] };
function applyDefaultCamera() {
  camera.position.set(DEFAULT_CAM.pos[0], DEFAULT_CAM.pos[1], DEFAULT_CAM.pos[2]);
  controls.target.set(DEFAULT_CAM.target[0], DEFAULT_CAM.target[1], DEFAULT_CAM.target[2]);
  controls.update();
}

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
  ownerDim: 0.46,   // brightness floor of the team NOT currently in possession
  glow: 0.48,       // glowing-crest highlight amount (the bright "высветленный" special-effect)
  glowCol: '#ff6f1f', // glow / crest highlight colour (default fiery)
  homeCol: null,    // home team colour override (null = use the data team colour)
  awayCol: null,    // away team colour override
  sat: 2.0,         // colour saturation boost
  light: 0.32,      // key/fill light intensity
  amb: 0.26,        // ambient floor
  tex: 0.9,         // clay texture (marble) amount
  wobble: 0.47,     // organic churn of the colour seam
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
  camera.position.set(DEFAULT_CAM.pos[0], DEFAULT_CAM.pos[1], DEFAULT_CAM.pos[2]);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 4;
  controls.maxDistance = 36;
  controls.maxPolarAngle = Math.PI * 0.495;   // keep above the ground plane
  controls.target.set(DEFAULT_CAM.target[0], DEFAULT_CAM.target[1], DEFAULT_CAM.target[2]);

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
      uDim: { value: 0.45 },              // passive-team brightness floor
      uGlow: { value: 0.48 },             // highlight / glowing-crest special-effect amount
      uGlowCol: { value: new THREE.Color(0xff6f1f) }, // crest highlight colour (fiery by default)
      uSat: { value: 2.0 },               // colour saturation boost (kills the muddy look)
      uLight: { value: 0.7 },             // key/fill light intensity
      uAmb: { value: 0.42 },              // ambient floor
      uTex: { value: 0.35 },              // clay texture (marble) amount
      uWobble: { value: 0.28 },           // organic churn of the colour seam (NOT a straight line)
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
  uniform vec3 uGlowCol;
  uniform float uSat;
  uniform float uLight;
  uniform float uAmb;
  uniform float uTex;
  uniform float uWobble;
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
  // multi-octave noise → organic churn (seam wobble + clay marbling)
  float fbm2(vec2 p){
    float s=0.0, a=0.5;
    for (int i=0;i<4;i++){ s += a*vn(p); p = p*2.03 + vec2(11.3,7.7); a *= 0.5; }
    return s;
  }

  void main(){
    vec3 N = normalize(vNormalW);

    // OWNERSHIP — the seam position (uFront) tracks possession+momentum, but the
    // boundary is DOMAIN-WARPED by animated multi-octave noise so it churns and
    // wobbles instead of riding as a straight vertical line.
    float warp = fbm2(vUvN * vec2(3.0, 5.0) + vec2(uTime*0.06, uTime*0.045));
    float warpX = vUvN.x + uWobble * (warp - 0.5);
    float side = smoothstep(uFront - 0.04, uFront + 0.04, warpX); // 0 home → 1 away
    vec3 team = mix(uHome, uAway, side);

    // SATURATION boost so the hues read vivid, not pale/muddy.
    float lum = dot(team, vec3(0.299, 0.587, 0.114));
    team = max(mix(vec3(lum), team, uSat), 0.0);

    // POSSESSION GATE (H2): the side with the ball NOW stays bright; other dims.
    float possActive = mix(1.0 - uPoss, uPoss, side);
    float possGate = mix(uDim, 1.0, possActive);
    vec3 base = team * possGate;

    // CLAY TEXTURE — churning multi-octave marble, amount = uTex.
    float marble = fbm2(vUvN * 22.0 + vec2(0.0, uTime*0.05));
    base *= (1.0 - 0.5*uTex) + uTex*marble;

    // LIGHTING — key + fill (uLight) over an ambient floor (uAmb).
    float d1 = max(dot(N, normalize(uLightDir)), 0.0);
    float d2 = max(dot(N, normalize(uLightDir2)), 0.0) * 0.5;
    vec3 col = base * (uAmb + d1*uLight + d2*uLight*0.6);

    // GLOWING-CREST special-effect: brightened/whitened team colour blazing on
    // the steep, tall, contested ridges (the "высветленный" highlight), with a
    // live flicker. Amount = uGlow.
    float steep = 1.0 - clamp(N.y, 0.0, 1.0);
    float hot = smoothstep(0.3, 1.3, vH) * smoothstep(0.12, 0.62, steep);
    float flick = 0.82 + 0.18*vn(vUvN*40.0 + uTime*0.7);
    // chosen glow colour (default fiery), pushed bright so it blazes on crests;
    // its hottest core whitens out for a molten look.
    vec3 hi = uGlowCol * 2.2 + smoothstep(0.7, 1.4, vH) * 0.6;
    col += hi * hot * uGlow * 2.4 * flick;

    // cinematic fresnel rim
    vec3 V = normalize(cameraPosition - vWorldPos);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    col += fres * 0.12 * base;

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
  const k = 0.95 / m;
  return [clamp(c[0] * k, 0, 1), clamp(c[1] * k, 0, 1), clamp(c[2] * k, 0, 1)];
}
function rgbToHex(c) {
  const f = (v) => ('0' + Math.round(clamp(v, 0, 1) * 255).toString(16)).slice(-2);
  return '#' + f(c[0]) + f(c[1]) + f(c[2]);
}
function applyTeamColors() {
  // default = the vivid data team colour; a user override (tune.homeCol/awayCol
  // from the colour pickers) wins.
  const h = vivid(model.home.rgb), a = vivid(model.away.rgb);
  const hHex = tune.homeCol || rgbToHex(h);
  const aHex = tune.awayCol || rgbToHex(a);
  if (tune.homeCol) material.uniforms.uHome.value.set(hHex); else material.uniforms.uHome.value.setRGB(h[0], h[1], h[2]);
  if (tune.awayCol) material.uniforms.uAway.value.set(aHex); else material.uniforms.uAway.value.setRGB(a[0], a[1], a[2]);
  // seed the pickers with the current colours (so they show what's on screen)
  const hc = el('homecol'), ac = el('awaycol');
  if (hc) hc.value = hHex; if (ac) ac.value = aHex;
  document.documentElement.style.setProperty('--home-color', hHex);
  document.documentElement.style.setProperty('--away-color', aHex);
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

let permFrontShove = 0;   // (kept for the goal height-bumps path; no longer shoves the seam)

// Front (colour seam) at row yN, time t. Driven by the LIVE, two-way signals so
// the boundary ebbs and flows with who is on the ball RIGHT NOW:
//   - possHome(t): instantaneous ±4min home pass-share (REAL, swings 0..1)
//   - mom(t): live momentum (REAL, signed)
// NB: we deliberately do NOT use the cumulative integrals (cumPossHome/cumMom)
// or a permanent goal shove here — those only ratchet toward whoever led overall
// (France), which made Senegal never come back in the 2nd half. Territory now
// follows live possession, so a real 2nd-half Senegal spell pushes the seam.
function frontAt(yN, t) {
  const mom = at(model.series.mom, t, model.STEP);
  const possHomeLive = clamp(at(model.series.possHome, t, model.STEP), 0.05, 0.95); // live home share, SWINGS
  const wave = (fbm(yN * 2.2, 0.0, t * 0.03, 3)) * 0.06;
  // seamPoss=1 → seam sits exactly at home's current share; 0 → stays centred.
  const base = lerp(0.5, possHomeLive, clamp(tune.seamPoss, 0, 1));
  return clamp(base + A_INSTANT * mom + wave, 0.12, 0.88);
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
    applyLookUniforms();
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
    applyLookUniforms();
  }
  controls.update();
  renderer.render(scene, camera);
  updateHud();
  updateCamReadout();
};

// Push all the colour/lighting/effect tunables into the material uniforms.
function applyLookUniforms() {
  if (!material) return;
  const u = material.uniforms;
  u.uDim.value = tune.ownerDim;
  u.uGlow.value = tune.glow;
  u.uGlowCol.value.set(tune.glowCol);
  u.uSat.value = tune.sat;
  u.uLight.value = tune.light;
  u.uAmb.value = tune.amb;
  u.uTex.value = tune.tex;
  u.uWobble.value = tune.wobble;
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
    lastSimT = -1;
  });

  bindSlider('speed', 'speedV', (v) => { tune.speed = v; return v.toFixed(1) + '×'; });
  bindSlider('hscale', 'hscaleV', (v) => { tune.heightScale = v; return v.toFixed(2); });
  bindSlider('turb', 'turbV', (v) => { tune.turbulence = v; return v.toFixed(2); });
  bindSlider('ridge', 'ridgeV', (v) => { tune.ridgeSharp = v; lastSimT = -1; return v.toFixed(2); });
  bindSlider('flow', 'flowV', (v) => { tune.flowSpeed = v; return v.toFixed(2); });
  bindSlider('seam', 'seamV', (v) => { tune.seamPoss = v; lastSimT = -1; return v.toFixed(2); });
  bindSlider('wobble', 'wobbleV', (v) => { tune.wobble = v; return v.toFixed(2); });
  bindSlider('ownerdim', 'ownerdimV', (v) => { tune.ownerDim = v; return v.toFixed(2); });
  bindSlider('sat', 'satV', (v) => { tune.sat = v; return v.toFixed(2); });
  bindSlider('light', 'lightV', (v) => { tune.light = v; return v.toFixed(2); });
  bindSlider('amb', 'ambV', (v) => { tune.amb = v; return v.toFixed(2); });
  bindSlider('tex', 'texV', (v) => { tune.tex = v; return v.toFixed(2); });
  bindSlider('glow', 'glowV', (v) => { tune.glow = v; return v.toFixed(2); });

  // glow colour picker
  const gc = el('glowcol');
  if (gc) {
    gc.value = tune.glowCol;
    const applyGc = () => { tune.glowCol = gc.value; if (material) material.uniforms.uGlowCol.value.set(gc.value); };
    gc.addEventListener('input', applyGc);
    applyGc();
  }

  // per-team colour pickers (override the data colours)
  const hc = el('homecol');
  if (hc) hc.addEventListener('input', () => {
    tune.homeCol = hc.value;
    if (material) material.uniforms.uHome.value.set(hc.value);
    document.documentElement.style.setProperty('--home-color', hc.value);
  });
  const ac = el('awaycol');
  if (ac) ac.addEventListener('input', () => {
    tune.awayCol = ac.value;
    if (material) material.uniforms.uAway.value.set(ac.value);
    document.documentElement.style.setProperty('--away-color', ac.value);
  });

  // COPY SETTINGS → clipboard (with a textarea fallback)
  const copyBtn = el('copyset');
  if (copyBtn) {
    const dump = el('copysetDump');
    let flashT = 0;
    copyBtn.addEventListener('click', async () => {
      const json = JSON.stringify(settingsBlob(), null, 2);
      const flash = () => { copyBtn.textContent = 'copied ✓'; clearTimeout(flashT); flashT = setTimeout(() => { copyBtn.textContent = 'COPY SETTINGS'; }, 1400); };
      try { await navigator.clipboard.writeText(json); if (dump) dump.style.display = 'none'; flash(); }
      catch { if (dump) { dump.value = json; dump.style.display = 'block'; dump.focus(); dump.select(); } copyBtn.textContent = 'copy below ↓'; clearTimeout(flashT); flashT = setTimeout(() => { copyBtn.textContent = 'COPY SETTINGS'; }, 1800); }
    });
  }

  el('resetcam').addEventListener('click', () => { applyDefaultCamera(); });
  el('copycam').addEventListener('click', async () => {
    const s = `{ pos: [${camera.position.x.toFixed(2)}, ${camera.position.y.toFixed(2)}, ${camera.position.z.toFixed(2)}], ` +
      `target: [${controls.target.x.toFixed(2)}, ${controls.target.y.toFixed(2)}, ${controls.target.z.toFixed(2)}] }`;
    try { await navigator.clipboard.writeText(s); el('camread').textContent = 'copied'; }
    catch { el('camread').textContent = s; }
  });
}

// Snapshot every tunable + the camera as a JSON blob (paste back to set defaults).
function settingsBlob() {
  const r2 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
  return {
    tune: {
      speed: r2(tune.speed), heightScale: r2(tune.heightScale), turbulence: r2(tune.turbulence),
      ridgeSharp: r2(tune.ridgeSharp), flowSpeed: r2(tune.flowSpeed),
      seamPoss: r2(tune.seamPoss), wobble: r2(tune.wobble), ownerDim: r2(tune.ownerDim),
      sat: r2(tune.sat), light: r2(tune.light), amb: r2(tune.amb), tex: r2(tune.tex),
      glow: r2(tune.glow), glowCol: tune.glowCol,
      homeCol: (el('homecol') && el('homecol').value) || tune.homeCol,
      awayCol: (el('awaycol') && el('awaycol').value) || tune.awayCol,
    },
    camera: {
      pos: [r2(camera.position.x), r2(camera.position.y), r2(camera.position.z)],
      target: [r2(controls.target.x), r2(controls.target.y), r2(controls.target.z)],
    },
  };
}

function bindSlider(id, valId, fn) {
  const s = el(id), v = el(valId);
  const apply = () => { v.textContent = fn(+s.value); };
  s.addEventListener('input', apply);
  apply();
}
