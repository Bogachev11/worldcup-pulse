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
import { normPasses, placeXY, PassGrid, RunningMax, clamp, lerp,
         buildDuels, normTurnovers } from './passfield.js';

const ID = new URLSearchParams(location.search).get('id') || '1953888';
const el = (id) => document.getElementById(id);

// PRIMARY team colour ONLY (Layer 2 carries colour). France blue, Senegal green.
// Keyed by abbr; falls back to the model hex if the abbr is unknown.
const PRIMARY = {
  FRA: '#1a37c8',   // France blue
  SEN: '#00b85a',   // Senegal green
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
let duelTex, duelData;          // RG32F, GX×GY: R=spike height, G=winner share
let model = null, passes = [];
let duels = [], turnovers = [];
let grid, hMaxTrack, dMaxTrack;
let clock = 0, prevClock = 0, playing = true;
let passCursor = 0;             // next pass to deposit (passes sorted by t)
let duelCursor = 0;            // next duel to spawn
let turnCursor = 0;           // next turnover to credit
let domHome = 0.5;              // smoothed "who dominates recent passes" for HUD
let lastDeposited = null;       // last pass deposited (for flow interpolation)

// LAYER 1 — cumulative DOMINANCE bias. Slowly accumulating territory/possession
// differential (home minus away), smoothed; raises the half of the pitch the
// dominant team has controlled more. Sent to the shader as uDomBias.
let domAccum = 0;              // raw cumulative differential (decays slowly)
let domBias = 0;              // smoothed signal → -1 (home leans) .. +1 (away leans)

// ---- exclusive possession signal -------------------------------------------
// uPoss ∈ [0,1]: 0 = home has the ball, 1 = away. Computed from a trailing window
// of recent passes (decaying home/away weights) PLUS turnover events crediting
// the winning team. SMOOTHED with a slow time constant (~4–6 match-seconds) so a
// brief interception only nudges; a sustained counter-attack flips the colour.
let possHomeW = 0, possAwayW = 0;   // decaying recent-pass + turnover weights
let uPossTarget = 0.5;              // raw target from the window
let uPoss = 0.5;                    // smoothed signal sent to the shader
const POSS_WINDOW = 10;            // trailing window in match-seconds
const POSS_DECAY = 1 / (POSS_WINDOW / 60); // decay rate per match-minute
const POSS_TAU_SEC = 5.0;          // smoothing time constant in MATCH-seconds (~4–6)
const TURNOVER_W = 1.4;            // weight a turnover adds (a bit more than 1 pass)

// tuning (bound to sliders)
const tune = {
  speed: 14.8,        // stage2 default 3.7 × 4
  height: 1.6,        // relief height multiplier
  fade: 0.85,         // zone sink rate (per second decay rate)
  wave: 1.1,          // macro rolling-wave amplitude
  steps: 14,          // terrace levels (height quantisation) — the Variable look
  duels: 1.0,         // duel spike amount (Layer 3)
  dim: 0.08,          // how hard the passive (non-possessing) team fades
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
  // on-ball events: raw.events[] ({t,team,type,x,y,outcome,...}). buildDuels /
  // normTurnovers tolerate an empty list, so this never throws on sparse feeds.
  const evt = raw.events || [];
  duels = buildDuels(evt);
  turnovers = normTurnovers(evt);

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

// Default camera — exact pos/target the user dialed in. Stored as pos+target
// (most robust) and applied directly; we also keep a spherical helper for orbit.
const DEFAULT_CAM = {
  pos: { x: -8.45, y: 10.96, z: 12.31 },
  target: { x: -1.96, y: -0.92, z: 1.17 },
};

// Snap the camera+orbit target to the dialed-in default and sync controls.
function applyDefaultCamera() {
  const d = DEFAULT_CAM;
  controls.target.set(d.target.x, d.target.y, d.target.z);
  camera.position.set(d.pos.x, d.pos.y, d.pos.z);
  camera.lookAt(controls.target);
  controls.update();
}

// Position the camera from spherical angles (azimuth, polar, distance) around
// the current orbit target. Kept for completeness; default uses pos+target.
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

  // Default to the exact pos/target the user dialed in.
  applyDefaultCamera();

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
  if (duelTex) duelTex.dispose();

  // Mesh segments ≥ grid resolution (≈2× grid dim) so flat cell tops + near-
  // vertical step walls are crisp, but capped for perf at fine grids.
  const segX = Math.min(MESH_SEG_CAP, Math.max(GX, Math.min(GX * 2, MESH_SEG_CAP)));
  const segY = Math.min(MESH_SEG_CAP, Math.max(GY, Math.min(GY * 2, MESH_SEG_CAP)));
  const geo = new THREE.PlaneGeometry(WORLD_X, WORLD_Z, segX, segY);
  geo.rotateX(-Math.PI / 2);                 // flat in XZ, +Y up

  heightData = new Float32Array(GX * GY);
  colData = new Float32Array(GX * GY).fill(-1);
  // DUEL texture: RG → R = spike height (0..~1.4), G = winner share (0=home..1=away)
  duelData = new Float32Array(GX * GY * 2);
  heightTex = new THREE.DataTexture(heightData, GX, GY, THREE.RedFormat, THREE.FloatType);
  colTex = new THREE.DataTexture(colData, GX, GY, THREE.RedFormat, THREE.FloatType);
  duelTex = new THREE.DataTexture(duelData, GX, GY, THREE.RGFormat, THREE.FloatType);
  for (const tx of [heightTex, colTex, duelTex]) {
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
        uDuel: { value: duelTex },
        uTexel: { value: new THREE.Vector2(1 / GX, 1 / GY) },
        uHScale: { value: tune.height },
        uWave: { value: tune.wave },
        uLevels: { value: tune.steps },
        uDuelAmt: { value: tune.duels },
        // PRIMARY team colours ONLY (Layer 2 carries colour). Home / away.
        uHome: { value: new THREE.Color(0x1a37c8) },
        uAway: { value: new THREE.Color(0x00b85a) },
        uLightDir: { value: new THREE.Vector3(-6, 9, 4).normalize() },
        uLightDir2: { value: new THREE.Vector3(7, 4, -6).normalize() },
        uWorld: { value: new THREE.Vector2(WORLD_X, WORLD_Z) },
        uTime: { value: 0 },
        uPoss: { value: 0.5 },           // 0 home has ball .. 1 away has ball
        uDim: { value: tune.dim },       // brightness floor for non-possessing team
        uDomBias: { value: 0.0 },        // Layer 1 dominance lean (-1 home .. +1 away)
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,   // strong waves + low camera → render backfaces (no see-through holes)
    });
    applyTeamColors();
  } else {
    material.uniforms.uHeight.value = heightTex;
    material.uniforms.uCol.value = colTex;
    material.uniforms.uDuel.value = duelTex;
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
  uniform sampler2D uDuel;
  uniform vec2 uTexel;
  uniform float uHScale;
  uniform float uWave;
  uniform float uLevels;    // terrace count (height quantisation)
  uniform float uDuelAmt;   // duel spike amount (Layer 3)
  uniform float uDomBias;   // Layer 1 dominance lean (-1 home .. +1 away)
  uniform vec2 uWorld;
  uniform float uTime;
  varying float vH;         // pass-relief only (for colour intensity)
  varying float vDuel;      // duel spike intensity (for colour)
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
  // LAYER 1 — MACRO ROLLING WAVES (NEUTRAL): two+ wave trains travelling in
  // DIFFERENT directions so the whole surface visibly rolls. PLUS a low-frequency
  // DOMINANCE lean: raise the half of the pitch the dominant team controlled more
  // (height += domBias * (x-0.5)). uDomBias is a slow cumulative signal.
  float waveBase(vec2 uv){
    // P is a VEC2 (world-ish coords) — use only .x / .y, never .z.
    vec2 P = (uv - 0.5) * vec2(uWorld.x, uWorld.y);
    float t = uTime;
    float w  = 0.55 * sin(P.x * 0.95 + t * 0.85) * cos(P.y * 0.70 - t * 0.45);
    float w2 = 0.38 * sin((P.x + P.y) * 0.62 - t * 0.65);
    float w3 = 0.22 * sin(P.y * 0.40 + t * 0.30);
    float wn = (vn(uv * 3.0 + vec2(t * 0.05, t * 0.03)) - 0.5) * 0.35;
    float wave = (w + w2 + w3 + wn) * uWave * 0.78;
    // dominance lean: low-frequency tilt across X toward the dominant side
    float lean = uDomBias * (uv.x - 0.5) * 1.1;
    return wave + lean;
  }
  // LAYER 2 — Relief sampled with NEAREST (flat cell tops), QUANTISED into
  // discrete terraces → the staged extruded-blocks Variable aesthetic.
  float relief(vec2 uv){
    float r = texture2D(uHeight, uv).r;            // 0..~1.4, flat per cell
    float L = max(uLevels, 1.0);
    r = floor(r * L + 0.5) / L;                    // terrace into L steps
    return r * uHScale;
  }
  // LAYER 3 — duel spike height (sharp, NOT terraced, capped so no vertical facet)
  float duelH(vec2 uv){
    float d = texture2D(uDuel, uv).r;              // already capped on CPU side
    return min(d, 1.4) * uHScale * 0.9 * uDuelAmt;
  }
  float H(vec2 uv){ return waveBase(uv) + relief(uv) + duelH(uv); }

  void main(){
    vec2 fuv = uv;
    vUvN = fuv;
    float h = H(fuv);
    if (!(h == h)) h = 0.0;          // NaN guard → no degenerate (see-through) triangles
    h = clamp(h, -4.0, 7.0);         // clamp so extreme spikes can't tear the mesh
    vH = relief(fuv);
    vDuel = duelH(fuv);

    float hl = H(fuv - vec2(uTexel.x, 0.0));
    float hr = H(fuv + vec2(uTexel.x, 0.0));
    float hd = H(fuv - vec2(0.0, uTexel.y));
    float hu = H(fuv + vec2(0.0, uTexel.y));
    float dx = (uWorld.x * uTexel.x) * 2.0;
    float dz = (uWorld.y * uTexel.y) * 2.0;
    vec3 n = vec3(-(hr-hl)/max(dx,1e-4), 1.0, -(hu-hd)/max(dz,1e-4));
    // robust normal: if it collapses, fall back to straight up (no black facets)
    n = (length(n) > 1e-4) ? normalize(n) : vec3(0.0, 1.0, 0.0);
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
  uniform sampler2D uDuel;
  uniform vec3 uHome;      // home PRIMARY colour
  uniform vec3 uAway;      // away PRIMARY colour
  uniform vec3 uLightDir;
  uniform vec3 uLightDir2;
  uniform float uTime;
  uniform float uPoss;     // 0 home has ball .. 1 away has ball
  uniform float uDim;      // brightness floor for the team NOT in possession
  varying float vH;
  varying float vDuel;
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
    // NORMAL GUARD: collapsed finite-difference normal → fall back to straight up
    // so dot(N,L) never zeroes (no black facets on flat plateaus).
    vec3 N = vNormalW;
    float nlen = length(N);
    N = (nlen > 1e-4) ? N / nlen : vec3(0.0, 1.0, 0.0);

    // LAYER 1 base: NEUTRAL dark slate (carries NO team colour — this is the tide)
    vec3 baseNeutral = vec3(0.15, 0.18, 0.26);
    vec3 col = baseNeutral;

    // ---- LAYER 2: POSSESSION colour (the ball) ------------------------------
    float share = texture2D(uCol, vUvN).r;       // -1 empty, else away-share 0..1
    if (!(share == share)) share = -1.0;          // NaN guard
    float occupied = step(0.0, share);
    float shareC = clamp(share, 0.0, 1.0);
    // SOLID PRIMARY colour per occupied cell (no flag tri-band).
    vec3 team = mix(uHome, uAway, step(0.5, shareC));

    // possession gate: how much THIS cell's team currently has the ball.
    // possActive ≈1 if cell-team == possessing team, ≈0 otherwise.
    float possActive = mix(1.0 - uPoss, uPoss, shareC);
    // STRENGTHENED dim: passive team falls hard toward the neutral base (uDim).
    float possGate = mix(uDim, 1.0, possActive);

    float relief = max(vH, 0.0);
    float lift = clamp(relief * 1.4, 0.0, 1.0);
    // add the possessing team's colour where its relief rises; passive team's
    // cells barely lift off the neutral base.
    float teamMix = occupied * (0.30 + 0.70 * lift) * possGate;
    col = mix(baseNeutral, team, clamp(teamMix, 0.0, 1.0));

    // subtle marble so the surface reads as a textured landscape
    float marble = vn(vUvN*26.0 + vec2(0.0, uTime*0.03))*0.5 + vn(vUvN*70.0)*0.25;
    col *= 0.80 + 0.30*marble;

    // lighting: two directional + raised ambient floor (so nothing goes black)
    float d1 = max(dot(N, normalize(uLightDir)), 0.0);
    float d2 = max(dot(N, normalize(uLightDir2)), 0.0) * 0.5;
    col *= (0.60 + d1*0.85 + d2);

    // peaks read brighter, valleys sink (relief AO-ish)
    col *= 0.86 + clamp(relief*0.6, 0.0, 0.5);

    // gentle emissive on hot possessing zones
    col += team * occupied * possGate * smoothstep(0.35, 1.0, relief) * 0.35;

    // ---- LAYER 3: DUEL sparks (winner-tinted, bright, ON TOP) ---------------
    vec2 duel = texture2D(uDuel, vUvN).rg;        // r = spike height, g = winner share
    float dInt = duel.r;
    float dShareC = clamp(duel.g, 0.0, 1.0);
    if (!(dInt == dInt)) dInt = 0.0;              // NaN guard
    vec3 duelTeam = mix(uHome, uAway, step(0.5, dShareC));
    // crisp spark: sharp response to intensity, ACCENT brighter than the base.
    float spark = smoothstep(0.04, 0.7, dInt);
    col += duelTeam * spark * 1.15;               // additive accent so they pop
    col += vec3(1.0) * spark * 0.18;              // tiny white-hot core

    // cinematic fresnel rim
    vec3 V = normalize(cameraPosition - vWorldPos);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    col += fres * 0.07 * mix(baseNeutral, team, occupied * possGate);

    // BRIGHTNESS FLOOR: never darker than the lit neutral base (kills black spots).
    // Empty / quiet cells therefore render as the neutral tide, never pure black.
    col = max(col, baseNeutral * 0.85);
    // final NaN guard
    if (!(col.r == col.r) || !(col.g == col.g) || !(col.b == col.b)) col = baseNeutral * 0.5;

    gl_FragColor = vec4(col, 1.0);
  }
`;

// ---- colours ----------------------------------------------------------------
// PRIMARY team colour only (Layer 2). By abbr, else the lifted model hex.
function teamRgb(side) {
  const abbr = model[side].abbr;
  if (abbr && PRIMARY[abbr]) return rgb01(hexToRgb(PRIMARY[abbr]));
  return rgb01(model[side].rgb);                // already lifted in buildModel
}
function primaryCss(side) {
  const abbr = model[side].abbr;
  const c = (abbr && PRIMARY[abbr]) ? hexToRgb(PRIMARY[abbr]) : (model[side].rgb || { r: 200, g: 200, b: 200 });
  return `rgb(${c.r | 0},${c.g | 0},${c.b | 0})`;
}
function applyTeamColors() {
  if (!material || !model) return;
  const h = teamRgb('home'), a = teamRgb('away');
  material.uniforms.uHome.value.setRGB(h[0], h[1], h[2]);
  material.uniforms.uAway.value.setRGB(a[0], a[1], a[2]);
  // HUD label colour = each team's primary colour
  document.documentElement.style.setProperty('--home-color', primaryCss('home'));
  document.documentElement.style.setProperty('--away-color', primaryCss('away'));
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
  dMaxTrack = new RunningMax(0.4);
  passCursor = 0;
  duelCursor = 0;
  turnCursor = 0;
  eventCursor = 0;
  activeEvents = [];
  prevClock = 0;            // sim cursor only; module `clock` is owned by callers
  domHome = 0.5;
  domAccum = 0; domBias = 0;
  possHomeW = 0; possAwayW = 0;
  uPossTarget = 0.5; uPoss = 0.5;
  lastDeposited = null;
  heightData.fill(0);
  colData.fill(-1);
  duelData.fill(0);
  heightTex.needsUpdate = true;
  colTex.needsUpdate = true;
  duelTex.needsUpdate = true;
}

// Deposit a chain of light splats along a segment so the lit crest GLIDES across
// the pitch instead of popping cell-to-cell. n interpolated points, total weight
// ≈ amp (so flow doesn't inflate height vs. a single splat).
function splatSeg(x0, y0, x1, y1, team, amp, radius, n) {
  const steps = Math.max(1, n | 0);
  const w = amp / steps;
  for (let i = 0; i < steps; i++) {
    const u = (i + 0.5) / steps;
    grid.splat(lerp(x0, x1, u), lerp(y0, y1, u), team, w, radius);
  }
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
      // FLOW: glide the crest along start→end of this pass (interpolated splats)
      // plus from the previous deposited pass into this one, so the bright zone
      // streams across the field following where the ball is going.
      splatSeg(s.x, s.y, e.x, e.y, p.team, 1.0, radius, 4);
      grid.splat(e.x, e.y, p.team, END_SPLAT, radius);
      if (lastDeposited && lastDeposited.team === p.team) {
        splatSeg(lastDeposited.x, lastDeposited.y, s.x, s.y, p.team, 0.6, radius, 4);
      }
      lastDeposited = { x: e.x, y: e.y, team: p.team };

      // feed the possession window (recent-pass weights per team)
      if (p.team === 'away') possAwayW += 1.0; else possHomeW += 1.0;

      // LAYER 1 — cumulative DOMINANCE: count this pass's TERRITORY toward the
      // attacking team. Pass placed on the shared pitch; how far into the
      // attacking half it is (x for home, 1-x for away) scores possession+
      // territory differential. Home positive, away negative.
      const adv = (p.team === 'home') ? s.x : (1 - s.x);   // 0..1 attacking depth
      const sign = (p.team === 'home') ? 1 : -1;
      domAccum += sign * (0.4 + 0.6 * clamp(adv, 0, 1));
    }
    passCursor++;
  }
}

// Spawn DUEL spikes (Layer 3) for duels whose t falls in (a,b]. Sharp/narrow.
function spawnDuels(a, b) {
  const radius = Math.max(0.7, SPLAT_PITCH * GX * 0.45);   // ~1 cell core, very small
  while (duelCursor < duels.length && duels[duelCursor].t <= b) {
    const d = duels[duelCursor];
    if (d.t > a) {
      const pl = placeXY(d.xn, d.yn, d.team, d.t);
      // tall+narrow but CAPPED amplitude so no near-vertical facet
      grid.duelSplat(pl.x, pl.y, d.team, 1.4 * tune.duels, radius);
    }
    duelCursor++;
  }
}

// Credit TURNOVERS to the possession window (Layer 2). A turnover nudges the
// winning team's weight; only SUSTAINED pressure (many) flips the smoothed colour.
function creditTurnovers(a, b) {
  while (turnCursor < turnovers.length && turnovers[turnCursor].t <= b) {
    const to = turnovers[turnCursor];
    if (to.t > a) {
      if (to.team === 'away') possAwayW += TURNOVER_W; else possHomeW += TURNOVER_W;
    }
    turnCursor++;
  }
}

// Decay the possession window and recompute the raw target. Called per sim step
// with the match-minutes elapsed so the trailing window stays ~POSS_WINDOW sec.
function updatePossession(dtMin) {
  const keep = Math.exp(-POSS_DECAY * Math.max(dtMin, 0));
  possHomeW *= keep; possAwayW *= keep;
  const tot = possHomeW + possAwayW;
  uPossTarget = tot > 1e-4 ? (possAwayW / tot) : uPossTarget;
  // decay the cumulative dominance slowly (long memory) and recompute the bias.
  // domAccum spans roughly ±(#passes); squash to ~[-1,1] with a soft saturate.
  domAccum *= Math.exp(-0.02 * Math.max(dtMin, 0));
  // away positive lean → +; home → -. tanh-ish saturate.
  const x = -domAccum / 40;          // sign: home accum positive → lean home (x<0)
  domBias = clamp(x / (1 + Math.abs(x)), -1, 1);
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
    // fast rise (~0.15 min) then ease down; finer + taller than base relief.
    // CAPPED so no near-vertical facet appears (black-spot fix).
    const rise = Math.min(1, age / 0.15);
    const fall = 1 - clamp((age - 0.15) / (e.life - 0.15), 0, 1);
    let amp = 2.6 * rise * fall;
    if (!Number.isFinite(amp)) amp = 0;
    amp = Math.min(amp, 3.0);
    if (amp > 0) grid.splat(e.x, e.y, e.team, amp, radius);
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
  creditTurnovers(prevClock, t);
  spawnDuels(prevClock, t);
  syncEvents(t);
  applyEventSpikes(t);
  updatePossession(Math.max(0, t - prevClock));

  // decay everything: rate scaled by fade slider; dt is REAL seconds (so the
  // visible sink speed is tied to wall time, feels consistent across speeds).
  // DUELS decay much faster (~3×) so sparks are brief (≈0.6–1.2 match-min).
  const rate = tune.fade * 1.1;
  const keep = Math.exp(-rate * Math.max(dt, 1e-4));
  const duelKeep = Math.exp(-rate * 3.0 * Math.max(dt, 1e-4));
  grid.decay(keep, duelKeep);

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
    creditTurnovers(a, b);
    spawnDuels(a, b);
    syncEvents(b);
    applyEventSpikes(b);
    updatePossession(b - a);
    const dtSec = (b - a) * secPerMin;
    grid.decay(Math.exp(-rate * dtSec), Math.exp(-rate * 3.0 * dtSec));
    a = b;
  }
}

// Write normalized cell height + away-share + duel channel into the DataTextures.
// EVERY write is finite-guarded and clamped so NO NaN/Inf ever reaches the GPU
// (black-spot fix) and heights are capped so no near-vertical facet appears.
function writeTextures() {
  const n = GX * GY;
  // find frame max (possession + duel) to feed the running-max normalizers
  let frameMax = 0, duelMax = 0;
  for (let k = 0; k < n; k++) {
    const v = grid.total(k); if (Number.isFinite(v) && v > frameMax) frameMax = v;
    const dv = grid.dInt[k]; if (Number.isFinite(dv) && dv > duelMax) duelMax = dv;
  }
  hMaxTrack.observe(frameMax);
  dMaxTrack.observe(duelMax);
  const inv = (Number.isFinite(hMaxTrack.m) && hMaxTrack.m > 1e-6) ? 1 / hMaxTrack.m : 0;
  const dinv = (Number.isFinite(dMaxTrack.m) && dMaxTrack.m > 1e-6) ? 1 / dMaxTrack.m : 0;

  let hSum = 0, aSum = 0;
  for (let k = 0; k < n; k++) {
    const hh = grid.hHome[k], ha = grid.hAway[k];
    const tot = hh + ha;
    let nh = tot * inv;
    if (!Number.isFinite(nh)) nh = 0;
    heightData[k] = nh > 0 ? Math.min(nh, 1.4) : 0;
    // colour: away-share where occupied, else -1 (empty → neutral base)
    let cs = tot > 1e-4 ? (ha / tot) : -1;
    if (!Number.isFinite(cs)) cs = -1;
    colData[k] = cs;
    // DUEL channel: R = normalized+capped spike height, G = winner away-share
    let dh = grid.dInt[k] * dinv;
    if (!Number.isFinite(dh)) dh = 0;
    dh = dh > 0 ? Math.min(dh, 1.4) : 0;
    let ds = grid.duelShare(k);
    if (!Number.isFinite(ds)) ds = 0.5;
    duelData[k * 2] = dh;
    duelData[k * 2 + 1] = clamp(ds, 0, 1);
    hSum += hh; aSum += ha;
  }
  // smoothed "who dominates recent passes" for the HUD
  const tot = hSum + aSum;
  const targetHome = tot > 1e-4 ? hSum / tot : 0.5;
  domHome = lerp(domHome, targetHome, 0.12);

  heightTex.needsUpdate = true;
  colTex.needsUpdate = true;
  duelTex.needsUpdate = true;
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

  // smooth possession toward its target with a MATCH-seconds time constant
  // (~POSS_TAU_SEC). dtMatch = real dt × speed, so a brief interception only
  // nudges uPoss; a sustained counter-attack flips the colour.
  const dtMatchSec = dt * Math.max(0.2, tune.speed);
  const kPoss = 1 - Math.exp(-dtMatchSec / POSS_TAU_SEC);
  uPoss = lerp(uPoss, uPossTarget, kPoss);

  if (material) {
    material.uniforms.uHScale.value = tune.height;
    material.uniforms.uWave.value = tune.wave;
    material.uniforms.uLevels.value = tune.steps;
    material.uniforms.uDuelAmt.value = tune.duels;
    material.uniforms.uDim.value = tune.dim;
    material.uniforms.uDomBias.value = Number.isFinite(domBias) ? domBias : 0;
    material.uniforms.uPoss.value = uPoss;
    hMaxTrack.ease(dt);
    dMaxTrack.ease(dt);
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

  // inject the new DUELS + DIM slider rows (HTML untouched: build them in JS).
  injectSlider('duels', 'duelsV', 'duels', 0, 3, 0.05, tune.duels, 'wave');
  injectSlider('dim', 'dimV', 'dim', 0, 0.4, 0.01, tune.dim, 'duels');

  bindSlider('speed', 'speedV', (v) => { tune.speed = v; return v.toFixed(1) + '×'; });
  bindSlider('height', 'heightV', (v) => { tune.height = v; return v.toFixed(2); });
  bindSlider('fade', 'fadeV', (v) => { tune.fade = v; return v.toFixed(2); });
  bindSlider('wave', 'waveV', (v) => { tune.wave = v; return v.toFixed(2); });
  bindSlider('steps', 'stepsV', (v) => { tune.steps = Math.round(v); return String(Math.round(v)); });
  if (el('duels')) bindSlider('duels', 'duelsV', (v) => { tune.duels = v; return v.toFixed(2); });
  if (el('dim')) bindSlider('dim', 'dimV', (v) => { tune.dim = v; return v.toFixed(2); });

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
    applyDefaultCamera();
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
  if (!s || !v) return;
  const apply = () => { v.textContent = fn(+s.value); };
  s.addEventListener('input', apply);
  apply();
}

// Build a new slider row in the control panel (HTML is not edited). Inserts the
// row after the row containing `afterId` so ordering stays sensible. Idempotent.
function injectSlider(id, valId, label, min, max, step, value, afterId) {
  if (el(id)) return;                              // already present
  const anchor = el(afterId);
  const row = anchor && anchor.closest ? anchor.closest('.row') : null;
  const panel = row ? row.parentNode : (document.querySelector('.pnl') || document.body);
  if (!panel) return;
  const div = document.createElement('div');
  div.className = 'row';
  div.innerHTML =
    `<label>${label}</label>` +
    `<input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}">` +
    `<span class="val" id="${valId}">${(+value).toFixed(2)}</span>`;
  if (row && row.nextSibling) panel.insertBefore(div, row.nextSibling);
  else panel.appendChild(div);
}

// ---- dev hook ---------------------------------------------------------------
// Set the clock (match-minutes), step the sim, render exactly one frame.
window.__setClock = (min) => {
  if (!model) return;
  clock = clamp(+min || 0, 0, model.duration);
  playing = false;
  const playBtn = el('play'); if (playBtn) playBtn.textContent = '▶ play';
  if (grid) stepSim(clock, 1 / 60);
  uPoss = uPossTarget;   // snap (no animation in single-frame mode)
  if (material) {
    material.uniforms.uHScale.value = tune.height;
    material.uniforms.uWave.value = tune.wave;
    material.uniforms.uLevels.value = tune.steps;
    material.uniforms.uDuelAmt.value = tune.duels;
    material.uniforms.uDim.value = tune.dim;
    material.uniforms.uDomBias.value = Number.isFinite(domBias) ? domBias : 0;
    material.uniforms.uPoss.value = uPoss;
  }
  controls.update();
  renderer.render(scene, camera);
  updateHud();
  updateCamReadout();
};
