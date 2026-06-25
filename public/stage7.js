// stage7.js — "BATTLE OF MASSES · CINEMATIC" — stage6's exact real-data sim and
// colour logic, re-rendered to a "rendered-in-Blender" grade: a PBR
// MeshStandardMaterial (height displacement + data colour injected via
// onBeforeCompile so we keep three's full lighting/shadow/tonemapping pipeline),
// soft image-based lighting (RoomEnvironment + PMREM), a shadow-casting key
// light onto a receiving slab, screen-space-ish AO, and an EffectComposer post
// chain (bloom + vignette/colour-grade + SMAA). The DATA path is identical to
// stage6 — only the rendering is upgraded.
//
// Hard rule respected: NO invented signals. Every visual element is driven by the
// same real match data stage6 uses. Lighting/AO/bloom/grade only render that
// data-driven geometry better; randomness is micro-texture only.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { clamp, lerp, smoothstep, fbm, buildModel, at, rgb01, xgUpTo } from './claybattle.js';

const ID = new URLSearchParams(location.search).get('id') || '1953888';
const el = (id) => document.getElementById(id);

// baked-in default camera (user-tuned)
const DEFAULT_CAM = { pos: [-11.962, 18.664, 17.842], target: [-0.621, 1.826, 0.268] };
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
const WORLD_X = 16, WORLD_Z = 9.6;       // pitch footprint (16:9.6 ~ pitch)

// ---- scene state ------------------------------------------------------------
let renderer, scene, camera, controls, composer;
let bloomPass, gradePass, smaaPass;
let heightTex, heightData;               // DataTexture (R32F) of per-vertex H
let mesh, skirt, material, slab, keyLight;
let injected = null;                     // ref to the compiled onBeforeCompile shader.uniforms
let model = null;                        // built data model
let clock = 0, playing = true;
let lastSimT = -1;                       // last match-time we recomputed H at
let uPossCur = 0.5;                      // smoothed live away-possession share (0 home..1 away)

// tuning (bound to sliders) — stage6 defaults preserved + cinematic additions
const tune = {
  // sim / data (identical to stage6)
  speed: 3.7,
  heightScale: 2.2,
  turbulence: 3.0,
  ridgeSharp: 1.0,
  flowSpeed: 0.48,
  seamPoss: 0.46,
  ownerDim: 0.64,   // tint floor for the passive team (it relaxes toward neutral clay, not black)
  glow: 0.42,       // ember ceiling — gentle quadratic curve + tied to real match intensity
  glowCol: '#f0d8c1',
  homeCol: null,    // null = use THIS match's real team colour (vivid-lifted); pickers override per session
  awayCol: null,
  sat: 0.86,        // natural saturation (no neon boost)
  tint: 1.0,        // how strongly the clay is tinted by the team colour
  clay: '#6a6560',  // neutral clay/stone base the team colour tints
  light: 0.7,
  lightCol: '#ffffff', // key-light colour
  amb: 0.16,
  tex: 0.86,
  wobble: 0.42,
  // SOLID BODY + SURFACE PATTERN (fine volumetric mesh)
  thickness: 0,     // THIN CLOTH: 0 = no block body (skirt collapses to surface); raise for a solid extruded block
  pattern: 4,       // surface pattern: 0 grid · 1 weave · 2 lines · 3 dots · 4 hex · 5 grain
  detail: 1.1,      // pattern depth/strength
  detailScale: 2.58,// pattern density (frequency)
  lines: 0.6,       // football PITCH MARKINGS strength on the top surface (0 = off)
  // GOAL-ENTRY RINGS (contracting, scoring-team colour, flat on the cloth)
  ringSize: 1.0,    // settled-ring size multiplier
  ringStr: 1.0,     // ring emissive brightness multiplier
  // material / render
  rough: 1.0,
  metal: 0.81,
  env: 1.24,
  shadow: 0.32,
  ao: 0.42,
  // post
  bloomStr: 0.12,
  bloomRad: 0.3,
  bloomThr: 0.52,
  vig: 1.28,
  expo: 1.72,
  contr: 1.12,
  gsat: 1.3,
};

// transient eruption bumps that decay (built lazily as clock passes goals/shots)
let activeEruptions = [];
let eruptionCursor = 0;

// GOAL-ENTRY RINGS: one flat ring mesh per goal, contracting big→small in the
// scoring team's colour, lying on the relief surface at the goal-line crossing.
let goalRings = [];                       // [{ goal, mesh, mat, uPos, vPos }]
const RING_GROW_LIFE = 5.0;               // match-minutes over which the ring contracts
const RING_R_BIG = 1.7;                   // start radius (world units)
const RING_R_SMALL = 0.34;                // settled radius (world units)

// ---- boot -------------------------------------------------------------------
init().catch((e) => fail(e.message || String(e)));

async function init() {
  if (!window.WebGLRenderingContext) throw new Error('WebGL not available in this browser');

  const raw = await fetch('/api/rich/' + ID).then((r) => {
    if (!r.ok) throw new Error('api ' + r.status);
    return r.json();
  });
  model = buildModel(raw);
  attachGoalMouth(raw);   // carry onGoalX/onGoalY from the raw shots onto model goals

  setupThree();
  buildHeightfield();
  setupComposer();
  bindUI();
  setupHudLayout();
  applyTeamColors();
  applyLookUniforms();

  el('title2').textContent =
    `BATTLE · CINEMATIC · ${model.home.abbr || 'HOME'} ${model.home.score}–${model.away.score} ${model.away.abbr || 'AWAY'}`;
  el('hAbbr').textContent = model.home.abbr || 'HOME';
  el('aAbbr').textContent = model.away.abbr || 'AWAY';

  window.addEventListener('resize', onResize);
  onResize();
  requestAnimationFrame(loop);
}

function fail(msg) {
  const t = el('title2'); if (t) t.textContent = 'BATTLE · CINEMATIC · failed: ' + msg;
  const o = document.createElement('div');
  o.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'color:#f88;font:14px system-ui;text-align:center;padding:40px;z-index:99;background:#04050a';
  o.textContent = 'BATTLE · CINEMATIC could not start: ' + msg +
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
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  // graded dark vertical gradient background (instead of flat black)
  scene.background = makeGradientTexture();
  // light fog for depth
  scene.fog = new THREE.FogExp2(0x05070d, 0.035);

  // soft image-based lighting via RoomEnvironment + PMREM
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new RoomEnvironment();
  scene.environment = pmrem.fromScene(envScene, 0.04).texture;
  pmrem.dispose();

  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(DEFAULT_CAM.pos[0], DEFAULT_CAM.pos[1], DEFAULT_CAM.pos[2]);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 4;
  controls.maxDistance = 36;
  controls.maxPolarAngle = Math.PI * 0.495;   // keep above the ground plane
  controls.target.set(DEFAULT_CAM.target[0], DEFAULT_CAM.target[1], DEFAULT_CAM.target[2]);

  // shadow-casting key light (warm), plus a cool rim fill + hemisphere floor.
  keyLight = new THREE.DirectionalLight(0xffffff, 2.6);
  keyLight.position.set(-9, 14, 7);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.camera.near = 1;
  keyLight.shadow.camera.far = 60;
  const sc = keyLight.shadow.camera;
  sc.left = -14; sc.right = 14; sc.top = 12; sc.bottom = -12;
  sc.updateProjectionMatrix();
  keyLight.shadow.bias = -0.0008;
  keyLight.shadow.normalBias = 0.04;
  keyLight.shadow.radius = 6;
  scene.add(keyLight);
  scene.add(keyLight.target);

  const rim = new THREE.DirectionalLight(0x9fc0ff, 0.6);
  rim.position.set(8, 5, -7);
  scene.add(rim);
  const hemi = new THREE.HemisphereLight(0x6f86b0, 0x0a0d16, 0.5);
  scene.add(hemi);
}

// A subtle dark vertical gradient as a CanvasTexture scene.background.
function makeGradientTexture() {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.0, '#0a1020');
  grad.addColorStop(0.55, '#070a12');
  grad.addColorStop(1.0, '#020308');
  g.fillStyle = grad; g.fillRect(0, 0, 16, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Build the SKIRT geometry: vertical wall quads around the 4 perimeter edges of
// the displaced top plane PLUS a flat bottom cap, as one BufferGeometry that
// SHARES the mesh material. Each TOP-ring vertex carries the EXACT plane-edge uv
// (aBase=0) so the injected vertex shader displaces it by H(uv) identically to
// the plane edge (walls meet the relief edge with no gap). Each BOTTOM vertex
// (aBase=1) is pinned to y=-uThickness → the flat base. UV↔position mapping
// mirrors PlaneGeometry(WORLD_X,WORLD_Z)+rotateX(-90°):
//   localX = (u-0.5)*WORLD_X ;  localZ = (0.5-v)*WORLD_Z
function buildSkirtGeometry(segX, segY) {
  const pos = [], uvs = [], base = [], idx = [];
  const X = (u) => (u - 0.5) * WORLD_X;
  const Z = (v) => (0.5 - v) * WORLD_Z;

  // One vertical quad for a perimeter edge (u0,v0)→(u1,v1). top0,top1,bot0,bot1.
  const addWall = (u0, v0, u1, v1, flip) => {
    const o = pos.length / 3;
    const x0 = X(u0), z0 = Z(v0), x1 = X(u1), z1 = Z(v1);
    pos.push(x0, 0, z0,  x1, 0, z1,  x0, 0, z0,  x1, 0, z1);
    uvs.push(u0, v0,  u1, v1,  u0, v0,  u1, v1);
    base.push(0, 0, 1, 1);                 // top, top, bottom, bottom
    const t0 = o, t1 = o + 1, b0 = o + 2, b1 = o + 3;
    if (!flip) idx.push(t0, b0, t1,  t1, b0, b1);
    else       idx.push(t0, t1, b0,  t1, b1, b0);
  };
  // Walk the 4 edges at the SAME sample points the plane uses (segX/segY).
  for (let i = 0; i < segX; i++) addWall(i / segX, 0, (i + 1) / segX, 0, false);          // v=0
  for (let i = 0; i < segY; i++) addWall(1, i / segY, 1, (i + 1) / segY, false);          // u=1
  for (let i = 0; i < segX; i++) addWall((segX - i) / segX, 1, (segX - i - 1) / segX, 1, false); // v=1
  for (let i = 0; i < segY; i++) addWall(0, (segY - i) / segY, 0, (segY - i - 1) / segY, false); // u=0

  // BOTTOM CAP — single quad at the base rectangle (all aBase=1 → y=-uThickness).
  {
    const o = pos.length / 3;
    pos.push(X(0), 0, Z(0),  X(1), 0, Z(0),  X(1), 0, Z(1),  X(0), 0, Z(1));
    uvs.push(0, 0,  1, 0,  1, 1,  0, 1);
    base.push(1, 1, 1, 1);
    idx.push(o, o + 1, o + 2,  o, o + 2, o + 3);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('aBase', new THREE.Float32BufferAttribute(base, 1));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
  g.setIndex(idx);
  return g;
}

// ---- heightfield mesh: MeshStandardMaterial + onBeforeCompile injection ------
function buildHeightfield() {
  const geo = new THREE.PlaneGeometry(WORLD_X, WORLD_Z, GX, GY);
  geo.rotateX(-Math.PI / 2);              // lay flat: plane now in XZ, +Y up
  // The plane is the TOP surface — every vertex is a displaced-top vertex
  // (aBase=0). Supply the attribute explicitly so the SHARED material binds it
  // for the plane too (never rely on a missing attribute defaulting to 0).
  geo.setAttribute('aBase', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count), 1));

  heightData = new Float32Array(NV);
  heightTex = new THREE.DataTexture(heightData, VX, VY, THREE.RedFormat, THREE.FloatType);
  heightTex.magFilter = THREE.NearestFilter;
  heightTex.minFilter = THREE.NearestFilter;
  heightTex.needsUpdate = true;

  material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: tune.rough,
    metalness: tune.metal,
    envMapIntensity: tune.env,
  });

  // Custom uniforms shared into the injected shader.
  const u = {
    uHeight: { value: heightTex },
    uTexel: { value: new THREE.Vector2(1 / VX, 1 / VY) },
    uHScale: { value: tune.heightScale },
    uWorld: { value: new THREE.Vector2(WORLD_X, WORLD_Z) },
    uHome: { value: new THREE.Color(0x335a9a) },
    uAway: { value: new THREE.Color(0x12a060) },
    uFront: { value: 0.5 },
    uPoss: { value: 0.5 },
    uDim: { value: tune.ownerDim },
    uGlow: { value: tune.glow },
    uGlowCol: { value: new THREE.Color(tune.glowCol) },
    uSat: { value: tune.sat },
    uClay: { value: new THREE.Color(tune.clay) },
    uTint: { value: tune.tint },
    uTex: { value: tune.tex },
    uWobble: { value: tune.wobble },
    uAO: { value: tune.ao },
    uIntensity: { value: 0 },        // REAL match intensity (event rate) → drives the ember
    uTime: { value: 0 },
    // SOLID BODY + MICRO-SURFACE
    uThickness: { value: tune.thickness },
    uDetail: { value: tune.detail },
    uDetailScale: { value: tune.detailScale },
    uPattern: { value: tune.pattern },
    uLines: { value: tune.lines },     // football pitch-marking line strength (top surface only)
  };
  material.userData.u = u;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    injected = shader.uniforms;

    // ---- VERTEX ----
    shader.vertexShader = `
      uniform sampler2D uHeight;
      uniform vec2 uTexel;
      uniform float uHScale;
      uniform vec2 uWorld;
      uniform float uThickness;       // SOLID BODY depth: base verts pin to y=-uThickness
      attribute float aBase;          // 1.0 = bottom/base vertex, 0.0 = top/displaced
      varying float vHd;
      varying vec2 vUvN;
      varying float vBaseMix;         // 0 at the displaced top .. 1 at the base (wall shading)
      float H7(vec2 uv){
        float h = texture2D(uHeight, uv).r * uHScale;
        // NaN/Inf guard so the surface never opens see-through holes.
        if (!(h == h)) h = 0.0;
        return clamp(h, 0.0, 40.0);
      }
    ` + shader.vertexShader;

    // NORMAL: top verts get the finite-difference height normal; skirt walls get
    // an outward horizontal normal (so they shade as lit solid faces, not black);
    // the bottom cap points straight down.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>
        vUvN = uv;
        vBaseMix = aBase;
        if (aBase > 0.5) {
          // base ring / bottom cap. Outward-down wall normal from the uv (which
          // edge of the perimeter this vert sits on); interior bottom-cap verts
          // (uv not on an edge) get a straight-down normal.
          vec2 e = uv - vec2(0.5);
          float onX = step(0.49, abs(e.x));    // u≈0 or u≈1 → side wall
          float onZ = step(0.49, abs(e.y));    // v≈0 or v≈1 → side wall
          vec3 wn = vec3(sign(e.x) * onX, -0.35, -sign(e.y) * onZ);
          objectNormal = (onX + onZ > 0.5) ? normalize(wn) : vec3(0.0, -1.0, 0.0);
        } else {
          float hl = H7(uv - vec2(uTexel.x, 0.0));
          float hr = H7(uv + vec2(uTexel.x, 0.0));
          float hd = H7(uv - vec2(0.0, uTexel.y));
          float hu = H7(uv + vec2(0.0, uTexel.y));
          float dx = (uWorld.x * uTexel.x) * 2.0;
          float dz = (uWorld.y * uTexel.y) * 2.0;
          objectNormal = normalize(vec3(-(hr - hl)/max(dx,1e-4), 1.0, -(hu - hd)/max(dz,1e-4)));
        }
      `
    );

    // DISPLACEMENT: top verts (aBase<0.5) ride the height field; base verts
    // (aBase>0.5) pin to the flat base at y=-uThickness → a solid extruded block.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
        float h7 = H7(uv);
        vHd = h7;
        transformed.y = (aBase > 0.5) ? (-uThickness) : (transformed.y + h7);
      `
    );

    // ---- FRAGMENT ----
    shader.fragmentShader = `
      uniform vec3 uHome;
      uniform vec3 uAway;
      uniform float uFront;
      uniform float uPoss;
      uniform float uDim;
      uniform float uGlow;
      uniform vec3 uGlowCol;
      uniform float uSat;
      uniform vec3 uClay;
      uniform float uTint;
      uniform float uTex;
      uniform float uWobble;
      uniform float uAO;
      uniform float uIntensity;     // real match intensity → ember strength
      uniform float uTime;
      uniform float uDetail;        // surface pattern depth/strength
      uniform float uDetailScale;   // surface pattern density (frequency)
      uniform float uPattern;       // which pattern (0 grid · 1 weave · 2 lines · 3 dots · 4 hex · 5 grain)
      uniform float uLines;         // football pitch-marking line strength
      varying float vHd;
      varying vec2 vUvN;
      varying float vBaseMix;       // 0 displaced top .. 1 base (side-wall body)

      float h21_7(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
      float vn7(vec2 p){
        vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        float a=h21_7(i), b=h21_7(i+vec2(1,0)), c=h21_7(i+vec2(0,1)), d=h21_7(i+vec2(1,1));
        return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
      }
      float fbm7(vec2 p){
        float s=0.0, a=0.5;
        for (int i=0;i<4;i++){ s += a*vn7(p); p = p*2.03 + vec2(11.3,7.7); a *= 0.5; }
        return s;
      }
      // FINE VOLUMETRIC SURFACE PATTERN — a tactile relief HEIGHT in [0,1].
      // Built ONLY from continuous (sin/cos/noise) primitives so its screen-space
      // derivative is smooth → drives a stable bump WITHOUT the firefly/white
      // speckle that a hash-noise micro-grain produced. Micro-texture only.
      const float PI7 = 3.14159265;
      float pat7(vec2 p){
        if (uPattern < 0.5) {            // GRID — grooved lattice (raised cells)
          float lx = abs(sin(PI7 * p.x));
          float ly = abs(sin(PI7 * p.y));
          return smoothstep(0.0, 0.45, min(lx, ly));
        } else if (uPattern < 1.5) {     // WEAVE
          return 0.5 + 0.5 * sin(p.x * 6.2831853) * sin(p.y * 6.2831853);
        } else if (uPattern < 2.5) {     // LINES — parallel ridges
          return 0.5 + 0.5 * sin(p.y * 6.2831853);
        } else if (uPattern < 3.5) {     // DOTS — bump per cell
          return (0.5 + 0.5*cos(p.x*6.2831853)) * (0.5 + 0.5*cos(p.y*6.2831853));
        } else if (uPattern < 4.5) {     // HEX-ish — three rotated sine waves
          float a = sin(p.x*6.2831853);
          float b = sin((p.x*0.5 + p.y*0.8660254)*6.2831853);
          float c = sin((p.x*0.5 - p.y*0.8660254)*6.2831853);
          return clamp(0.5 + 0.22*(a+b+c), 0.0, 1.0);
        }
        return fbm7(p * 0.9);            // GRAIN — smooth organic
      }

      // ---- FOOTBALL PITCH MARKINGS -------------------------------------------
      // Standard FIFA-ish pitch (105m × 68m) drawn in normalised pitch uv
      // (u = length 0..1, v = width 0..1). Anti-aliased to ~1px via fwidth so the
      // lines stay crisp and don't shimmer at any distance. Returns line coverage
      // in [0,1]. Pure overlay — sits UNDER the data colour intensity.
      const float PL = 105.0;   // pitch length (m)
      const float PW = 68.0;    // pitch width (m)
      // a straight segment in uv between two metre points, with metre half-width.
      float seg7(vec2 puv, vec2 a, vec2 b, float halfW){
        // work in metres so the line width is uniform on both axes.
        vec2 P = vec2(puv.x * PL, puv.y * PW);
        vec2 ab = b - a, ap = P - a;
        float t = clamp(dot(ap, ab) / max(dot(ab, ab), 1e-5), 0.0, 1.0);
        float d = length(P - (a + t * ab));
        // convert metre distance to a screen-stable AA band using fwidth of P.
        float aa = (fwidth(P.x) + fwidth(P.y)) * 0.5 + 1e-4;
        return 1.0 - smoothstep(halfW, halfW + aa, d);
      }
      // rectangle outline (metres), half-width line.
      float rect7(vec2 puv, vec2 lo, vec2 hi, float halfW){
        float c = 0.0;
        c = max(c, seg7(puv, vec2(lo.x, lo.y), vec2(hi.x, lo.y), halfW));
        c = max(c, seg7(puv, vec2(hi.x, lo.y), vec2(hi.x, hi.y), halfW));
        c = max(c, seg7(puv, vec2(hi.x, hi.y), vec2(lo.x, hi.y), halfW));
        c = max(c, seg7(puv, vec2(lo.x, hi.y), vec2(lo.x, lo.y), halfW));
        return c;
      }
      // circle/arc ring (metres), centre c, radius r, half-width.
      float ring7(vec2 puv, vec2 cen, float r, float halfW){
        vec2 P = vec2(puv.x * PL, puv.y * PW);
        float d = abs(length(P - cen) - r);
        float aa = (fwidth(P.x) + fwidth(P.y)) * 0.5 + 1e-4;
        return 1.0 - smoothstep(halfW, halfW + aa, d);
      }
      float dot7(vec2 puv, vec2 cen, float r){
        vec2 P = vec2(puv.x * PL, puv.y * PW);
        float d = length(P - cen);
        float aa = (fwidth(P.x) + fwidth(P.y)) * 0.5 + 1e-4;
        return 1.0 - smoothstep(r, r + aa, d);
      }
      // full pitch-marking coverage at pitch uv.
      float pitchLines7(vec2 uv){
        float hw = 0.10;            // line half-width in metres (~0.12m FIFA line)
        float inset = 1.6;          // pull the boundary a touch in from the cloth edge (m)
        vec2 lo = vec2(inset, inset);
        vec2 hi = vec2(PL - inset, PW - inset);
        float c = 0.0;
        // outer boundary
        c = max(c, rect7(uv, lo, hi, hw));
        // halfway line
        c = max(c, seg7(uv, vec2(PL*0.5, lo.y), vec2(PL*0.5, hi.y), hw));
        // centre circle (r 9.15m) + centre spot
        c = max(c, ring7(uv, vec2(PL*0.5, PW*0.5), 9.15, hw));
        c = max(c, dot7(uv, vec2(PL*0.5, PW*0.5), 0.35));
        // penalty + goal areas, penalty spots & arcs — both ends.
        for (int s = 0; s < 2; s++){
          float dir = (s == 0) ? 1.0 : -1.0;
          float gx  = (s == 0) ? inset : PL - inset;     // goal-line x (m)
          // penalty area 16.5m deep × 40.32m wide
          float pax = gx + dir * 16.5;
          c = max(c, rect7(uv, vec2(min(gx,pax), PW*0.5 - 20.16), vec2(max(gx,pax), PW*0.5 + 20.16), hw));
          // goal area 5.5m deep × 18.32m wide
          float gax = gx + dir * 5.5;
          c = max(c, rect7(uv, vec2(min(gx,gax), PW*0.5 - 9.16), vec2(max(gx,gax), PW*0.5 + 9.16), hw));
          // penalty spot 11m from goal line
          vec2 pSpot = vec2(gx + dir * 11.0, PW*0.5);
          c = max(c, dot7(uv, pSpot, 0.35));
          // penalty arc (r 9.15m around the spot) — only the part OUTSIDE the box.
          float arc = ring7(uv, pSpot, 9.15, hw);
          vec2 P = vec2(uv.x * PL, uv.y * PW);
          float outside = (dir > 0.0) ? step(pax, P.x) : step(P.x, pax);
          c = max(c, arc * outside);
          // corner arcs (r 1.0m) at the two corners of this goal line
          c = max(c, ring7(uv, vec2(gx, inset),       1.0, hw));
          c = max(c, ring7(uv, vec2(gx, PW - inset),  1.0, hw));
        }
        return clamp(c, 0.0, 1.0);
      }
    ` + shader.fragmentShader;

    // inject the data-driven team/seam colour into diffuseColor
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      {
        // OWNERSHIP — seam (uFront) tracks live possession+momentum, boundary
        // domain-warped by two noise scales (broad warp + fine ripple teeth).
        float warpBroad = fbm7(vUvN * vec2(2.0, 3.2) + vec2(uTime*0.06, uTime*0.045));
        float warpFine  = fbm7(vUvN * vec2(11.0, 16.0) + vec2(-uTime*0.16, uTime*0.12));
        float warp = mix(warpBroad, warpFine, 0.35);
        // amplified meander so even a modest wobble value SNAKES the ownership
        // boundary organically (not a straight diagonal line).
        float warpX = vUvN.x + uWobble * (warp - 0.5) * 1.7;
        float side = smoothstep(uFront - 0.06, uFront + 0.06, warpX);
        vec3 team = mix(uHome, uAway, side);

        // gentle saturation control (natural, not neon)
        float lum = dot(team, vec3(0.299, 0.587, 0.114));
        team = max(mix(vec3(lum), team, uSat), 0.0);

        // NATURAL MATERIAL: the surface is a believable clay/stone (uClay) that is
        // only TINTED by the owning team's colour. Possession sets how strongly it
        // is tinted — the passive side relaxes toward neutral clay (floor uDim),
        // so ownership still reads without neon or going black.
        float possActive = mix(1.0 - uPoss, uPoss, side);
        float tintAmt = clamp(uTint * mix(uDim, 1.0, possActive), 0.0, 1.0);
        vec3 baseCol = mix(uClay, team, tintAmt);

        // subtle clay micro-texture, amount = uTex.
        float marble = fbm7(vUvN * 22.0 + vec2(0.0, uTime*0.05));
        baseCol *= (1.0 - 0.5*uTex) + uTex*marble;

        // cheap curvature/height ambient occlusion in valleys (shader fallback,
        // layered with the GTAO-style post pass via uAO). Low ground + concave
        // seam troughs darken; tall crests stay open.
        float lowAO = 1.0 - smoothstep(0.0, 0.55, vHd);   // valleys are occluded
        float crevAO = 1.0 - 0.5*abs(warp - 0.5)*2.0;      // warped seam crease
        float ao = clamp(1.0 - uAO * 0.5 * (lowAO*0.7 + (1.0-crevAO)*0.5), 0.25, 1.0);
        baseCol *= ao;

        // CAVITY AO from the surface pattern: the pattern grooves (low pat7) sink
        // into shadow so the lattice reads as real recessed volume, not a decal.
        float pc = pat7(vUvN * (46.0 * uDetailScale));
        float cavity = 1.0 - uDetail * 0.5 * (1.0 - pc);
        baseCol *= clamp(cavity, 0.3, 1.0);

        // SOLID-BLOCK SIDE WALLS: as vBaseMix ramps 0→1 down the skirt, mix the
        // colour toward a dark slate body so walls read as the block's MASS, not a
        // coloured continuation of the top. Quadratic → the top edge stays close
        // to the top colour. Top surface (vBaseMix=0) is untouched.
        float wall = clamp(vBaseMix, 0.0, 1.0);
        baseCol = mix(baseCol, baseCol * vec3(0.32, 0.34, 0.40), wall * wall * 0.85);

        // FOOTBALL PITCH MARKINGS — faint white lines on the TOP surface only.
        // Overlay (mix toward white) so the possession colour still shows through.
        float topMaskL = 1.0 - clamp(vBaseMix, 0.0, 1.0);
        float lines = pitchLines7(vUvN) * uLines * topMaskL;
        baseCol = mix(baseCol, vec3(0.92, 0.94, 0.96), clamp(lines * 0.5, 0.0, 0.6));

        diffuseColor.rgb = baseCol;
      }
      `
    );

    // MICRO-ROUGHNESS: modulate roughnessFactor by the same fine micro-relief so
    // some patches are duller/shinier. Uniform roughness is the #1 CG tell — this
    // breaks it up. Only the top surface gets it; walls stay matte body.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
      {
        // pattern grooves read slightly ROUGHER (matte recess) than the raised
        // cells; floor kept well above 0 so nothing turns into a shiny sparkle.
        float pr = pat7(vUvN * (46.0 * uDetailScale));
        float topMask = 1.0 - clamp(vBaseMix, 0.0, 1.0);
        roughnessFactor = clamp(roughnessFactor + uDetail * 0.22 * (0.5 - pr) * topMask, 0.16, 1.0);
      }
      `
    );

    // MICRO-NORMAL: high-frequency procedural normal perturbation via screen-space
    // derivatives of a fine noise height → grazing light catches fine surface
    // relief, making it feel like real clay/stone, not smooth CG plastic. Done
    // after the normal is set up, before lights. Top surface only.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
      {
        float topMask = 1.0 - clamp(vBaseMix, 0.0, 1.0);
        float amp = uDetail * 0.3 * topMask;
        if (amp > 0.0001) {
          vec2 mp = vUvN * (46.0 * uDetailScale);
          float hC = pat7(mp);
          // perturb the shading normal by the screen-space gradient of the SMOOTH
          // pattern height. Because pat7 is continuous (no hash noise), dFdx/dFdy
          // are stable → a clean volumetric relief with no white speckle blowout.
          vec3 dpdx = dFdx(-vViewPosition);
          vec3 dpdy = dFdy(-vViewPosition);
          float dhx = dFdx(hC);
          float dhy = dFdy(hC);
          vec3 r1 = cross(dpdy, normal);
          vec3 r2 = cross(normal, dpdx);
          float det = dot(dpdx, r1);
          vec3 surfGrad = (abs(det) > 1e-8) ? (dhx * r1 + dhy * r2) / det : vec3(0.0);
          // clamp the perturbation so steep groove walls can't fling the normal
          // to a grazing sliver that catches a blown-out specular spark.
          surfGrad = clamp(surfGrad, vec3(-4.0), vec3(4.0));
          normal = normalize(normal - amp * surfGrad);
        }
      }
      `
    );

    // inject the fiery glowing-crest highlight into emissive
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      {
        vec3 Nw = normalize(vNormal);
        float steep = 1.0 - clamp(Nw.y, 0.0, 1.0);
        float hot = smoothstep(0.3, 1.3, vHd) * smoothstep(0.12, 0.62, steep);
        float flick = 0.82 + 0.18*vn7(vUvN*40.0 + uTime*0.7);
        // GENTLE + DATA-DRIVEN ember: quadratic in the slider (so the low end is
        // genuinely faint, not a hard jump from 0), and scaled by REAL match
        // intensity — the crease barely smoulders in calm play and flares when the
        // match is hot. Far smaller base multiplier than before so min is subtle.
        float ember = uGlow * uGlow * mix(0.18, 1.0, clamp(uIntensity, 0.0, 1.0));
        vec3 hi = uGlowCol * (1.0 + smoothstep(0.7, 1.4, vHd) * 0.5);
        totalEmissiveRadiance += hi * hot * ember * 1.3 * flick;
      }
      `
    );
  };

  mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);

  // SKIRT (side walls + bottom cap) sharing the SAME material so colour/lighting
  // match. Its top ring shares the plane-edge uv (aBase=0) → displaced by H(uv)
  // identically to the plane edge (no gaps); bottom ring (aBase=1) pins to the
  // flat base at y=-uThickness. Together: a thick carved solid block.
  skirt = new THREE.Mesh(buildSkirtGeometry(GX, GY), material);
  skirt.castShadow = true;
  skirt.receiveShadow = true;
  scene.add(skirt);

  // ground/slab plane that receives the mesh's shadow so masses sit grounded.
  // Parked just below the solid block's base (y=-uThickness) so there's a floor
  // under the bottom cap without z-fighting it.
  slab = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD_X * 1.6, WORLD_Z * 1.8),
    new THREE.MeshStandardMaterial({ color: 0x0a0e18, roughness: 0.92, metalness: 0.0 })
  );
  slab.rotation.x = -Math.PI / 2;
  slab.position.y = -tune.thickness - 0.12;
  slab.receiveShadow = true;
  scene.add(slab);

  buildGoalRings();
}

// Build one flat, emissive RingGeometry per GOAL, positioned at the goal-line
// crossing point on the cloth. Real data: model.shots filtered to isGoal.
//   along length u : home attacks → u≈1 (away end); away attacks → u≈0 (home end)
//                    (matches the eruption convention max(e.x,0.7)/min(e.x,0.3))
//   across width v : 7.32m goal mouth centred at v=0.5, placed by onGoalX (1=centre).
//                    onGoalX is in the shooter's own attacking frame; away's frame
//                    is mirrored in normShot (x=1-x, y=1-y) so we flip the away sign
//                    to keep the ring inside the believable goal mouth.
// claybattle's normShot drops the goal-mouth crossing point, so re-attach it from
// the RAW shots. model.shots is built as raw.shots.filter(Number.isFinite(x)).map(...)
// — same order — so the isGoal entries line up; we also keep team+minute as a guard.
function attachGoalMouth(raw) {
  const rawGoals = (raw.shots || []).filter((s) => Number.isFinite(s.x) && s.isGoal);
  const modelGoals = (model.shots || []).filter((s) => s.isGoal);
  for (let i = 0; i < modelGoals.length; i++) {
    const r = rawGoals[i] || rawGoals.find((g) => g.team === modelGoals[i].team && (Number(g.minute) || 0) === modelGoals[i].minute);
    if (r) {
      modelGoals[i].onGoalX = Number.isFinite(r.onGoalX) ? r.onGoalX : null;
      modelGoals[i].onGoalY = Number.isFinite(r.onGoalY) ? r.onGoalY : null;
    }
  }
}

function buildGoalRings() {
  goalRings = [];
  const goals = (model.shots || []).filter((s) => s.isGoal);
  // goal mouth (7.32m) as a fraction of pitch WIDTH (68m), expressed in v.
  const mouthHalfV = (7.32 / 68) * 0.5;
  for (const g of goals) {
    const u = g.team === 'home' ? 0.985 : 0.015;     // attacking goal line
    // onGoalX 0..2 (1 = centre). Map offset-from-centre into the goal mouth in v.
    const ogx = Number.isFinite(g.onGoalX) ? g.onGoalX : 1.0;
    const off = (ogx - 1) / 2;                        // -0.5..0.5 across the mouth
    const sign = g.team === 'home' ? 1 : -1;          // away frame mirrored → flip
    const v = clamp(0.5 + sign * off * (mouthHalfV * 2), 0.04, 0.96);

    const col = (g.team === 'home' ? uHome() : uAway()).clone();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: col,
      emissiveIntensity: 2.4,
      roughness: 0.5, metalness: 0.0,
      transparent: true, opacity: 1.0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    // unit ring; we re-scale per frame to animate the contraction.
    const geo = new THREE.RingGeometry(0.78, 1.0, 96);
    geo.rotateX(-Math.PI / 2);                        // lie flat on XZ
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = 5;
    m.visible = false;
    scene.add(m);
    goalRings.push({ goal: g, mesh: m, mat, u, v });
  }
}

// Update every goal ring for the current clock. settled=true (scrub) snaps each
// past goal to its tidy small settled state; otherwise animates the contraction.
function updateGoalRings(settled) {
  if (!goalRings.length) return;
  for (const r of goalRings) {
    const g = r.goal;
    if (clock < g.t) { r.mesh.visible = false; continue; }
    const age = clock - g.t;                          // match-minutes since the goal
    let p;                                            // 0 = just scored (big), 1 = settled
    if (settled) p = 1.0;
    else p = clamp(age / RING_GROW_LIFE, 0, 1);
    const ease = p * p * (3 - 2 * p);                 // smoothstep contraction
    const radius = lerp(RING_R_BIG, RING_R_SMALL, ease) * tune.ringSize;
    // brightness: bright on spawn, easing to a faint-but-visible settled glow.
    const bright = lerp(3.6, 1.3, ease) * tune.ringStr;
    const opacity = lerp(0.96, 0.7, ease);
    r.mesh.scale.set(radius, 1, radius);
    const y = reliefHeightAt(r.u, r.v) + 0.08;        // sit just above the cloth/eruption
    r.mesh.position.set(worldX(r.u), y, worldZ(r.v));
    r.mat.emissiveIntensity = bright;
    r.mat.opacity = opacity;
    // keep the colour in sync with any live team-colour picker change
    r.mat.emissive.copy(g.team === 'home' ? uHome() : uAway());
    r.mesh.visible = true;
  }
}

// ---- post-processing composer ----------------------------------------------
function setupComposer() {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  // UnrealBloom — soft bloom on the bright crests/glow (the big "expensive" tell)
  bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), tune.bloomStr, tune.bloomRad, tune.bloomThr);
  composer.addPass(bloomPass);

  // custom grade: vignette + exposure/contrast/saturation
  gradePass = new ShaderPass(GradeShader);
  composer.addPass(gradePass);

  // anti-aliasing pass for clean edges
  smaaPass = new SMAAPass(1, 1);
  composer.addPass(smaaPass);

  composer.addPass(new OutputPass());
}

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uVig: { value: 0.5 },
    uExpo: { value: 1.0 },
    uContr: { value: 1.06 },
    uGsat: { value: 1.04 },
    uRes: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uVig;
    uniform float uExpo;
    uniform float uContr;
    uniform float uGsat;
    varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      // exposure
      c *= uExpo;
      // saturation
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uGsat);
      // contrast around mid-grey
      c = (c - 0.5) * uContr + 0.5;
      // vignette
      vec2 d = vUv - 0.5;
      float vig = smoothstep(0.85, 0.25, length(d) * 1.4);
      c *= mix(1.0, vig, clamp(uVig, 0.0, 1.5));
      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }
  `,
};

// ---- colors -----------------------------------------------------------------
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
function uHome() { return material.userData.u.uHome.value; }
function uAway() { return material.userData.u.uAway.value; }
function applyTeamColors() {
  const h = vivid(model.home.rgb), a = vivid(model.away.rgb);
  const hHex = tune.homeCol || rgbToHex(h);
  const aHex = tune.awayCol || rgbToHex(a);
  if (tune.homeCol) uHome().set(hHex); else uHome().setRGB(h[0], h[1], h[2]);
  if (tune.awayCol) uAway().set(aHex); else uAway().setRGB(a[0], a[1], a[2]);
  const hc = el('homecol'), ac = el('awaycol');
  if (hc) hc.value = hHex; if (ac) ac.value = aHex;
  document.documentElement.style.setProperty('--home-color', hHex);
  document.documentElement.style.setProperty('--away-color', aHex);
}

// ============================================================================
// THE SIMULATION — identical to stage6 (real data only).
// ============================================================================
const A_INSTANT = 0.27;   // live momentum push (gentler so swings aren't twitchy)
const B_ACCUM = 0.22;
const H_MAX = 0.9;
const BASE_AMP = 0.05;
const TURB_SCALE = 0.55;
const RIDGE_H = 1.3;
const RIDGE_W = 0.07;
const SEAM_EASE = 1.8;    // how fast the seam's dynamic part glides to its target (lower = softer)

let permFrontShove = 0;
let seamDyn = 0;          // SMOOTHED dynamic seam offset (momentum + attack surge), eased per frame

// A shot is an attack on a goal: away shots shove the seam toward the HOME goal
// (x→0, green crashes onto the blue goal), home shots toward the away goal (x→1).
// Swells in then recedes over a few match-minutes — softened so it's not abrupt.
const PUSH_LIFE = 6;      // match-minutes
function attackPushAt(t) {
  let s = 0;
  for (let i = 0; i < model.eruptions.length; i++) {
    const e = model.eruptions[i];
    if (e.t > t) break;                       // shots are time-sorted
    const age = t - e.t;
    if (age > PUSH_LIFE) continue;
    const rise = smoothstep(0, 1.4, age);     // gentle swell (was a quick snap)
    const fall = 1 - smoothstep(PUSH_LIFE * 0.5, PUSH_LIFE, age);
    const w = (0.35 + (e.xg || 0) * 1.6) * (e.isGoal ? 1.7 : 1.0);
    s += (e.team === 'away' ? -1 : 1) * w * rise * fall;
  }
  return clamp(s * 0.48, -0.55, 0.55);
}
// target for the dynamic seam offset (eased into seamDyn each frame)
function seamDynTarget(t) {
  return A_INSTANT * at(model.series.mom, t, model.STEP) + attackPushAt(t);
}

function frontAt(yN, t) {
  const possHomeLive = clamp(at(model.series.possHome, t, model.STEP), 0.05, 0.95);
  const wave = (fbm(yN * 2.2, 0.0, t * 0.03, 3)) * 0.06;
  const base = lerp(0.5, possHomeLive, clamp(tune.seamPoss, 0, 1));
  // possession base (already smooth) + the EASED dynamic offset (momentum + attack
  // surge). The easing makes the back-and-forth glide instead of snapping.
  return clamp(base + seamDyn + wave, 0.06, 0.94);
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

// Sample the relief HEIGHT (world Y) at normalised pitch (u,v) — bilinear over
// the height field, scaled by uHScale, so a ring can lie ON the undulating cloth.
function reliefHeightAt(u, v) {
  if (!heightData) return 0;
  const fx = clamp(u, 0, 1) * (VX - 1);
  const fy = clamp(v, 0, 1) * (VY - 1);
  const i0 = Math.floor(fx), j0 = Math.floor(fy);
  const i1 = Math.min(i0 + 1, VX - 1), j1 = Math.min(j0 + 1, VY - 1);
  const tx = fx - i0, ty = fy - j0;
  const h00 = heightData[j0 * VX + i0], h10 = heightData[j0 * VX + i1];
  const h01 = heightData[j1 * VX + i0], h11 = heightData[j1 * VX + i1];
  const h = lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), ty);
  return h * tune.heightScale;
}
// World X/Z from normalised pitch (u,v) — same mapping the plane/skirt use.
const worldX = (u) => (u - 0.5) * WORLD_X;
const worldZ = (v) => (0.5 - v) * WORLD_Z;

// ---- resize -----------------------------------------------------------------
function onResize() {
  const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (composer) {
    composer.setPixelRatio(dpr);
    composer.setSize(w, h);
    if (bloomPass) bloomPass.setSize(w * dpr, h * dpr);
    if (smaaPass) smaaPass.setSize(w * dpr, h * dpr);
  }
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

  // glide the seam's dynamic part toward its target (softens the back-and-forth)
  if (model) {
    const target = seamDynTarget(clock);
    seamDyn += (target - seamDyn) * (1 - Math.exp(-dt * SEAM_EASE));
  }

  simAccum += dt;
  if (model && (simAccum >= 1 / 30 || lastSimT < 0)) { simAccum = 0; computeHeight(clock); }

  if (material && model) {
    updateFrameUniforms(dt);
    applyLookUniforms();
  }

  updateGoalRings(false);

  controls.update();
  composer.render();
  updateHud();
  updateCamReadout();
  requestAnimationFrame(loop);
}

// per-frame data-driven uniform updates (live seam + possession gate)
function updateFrameUniforms(dt) {
  const u = material.userData.u;
  u.uHScale.value = tune.heightScale;
  u.uTime.value = clock * 0.5 * tune.flowSpeed;
  u.uFront.value = frontAt(0.5, clock);
  const possHome = clamp(at(model.series.possHome, clock, model.STEP), 0, 1);
  const targetAway = 1 - possHome;
  uPossCur += (targetAway - uPossCur) * Math.min(1, dt * 3.0);
  u.uPoss.value = uPossCur;
  u.uIntensity.value = clamp(at(model.series.intensity, clock, model.STEP), 0, 1);
}

// ---- dev hook ---------------------------------------------------------------
// Set the clock, resim the height field, update all uniforms, render exactly one
// frame via the composer (so it works in a throttled/hidden tab).
window.__setClock = (min) => {
  if (!model) return;
  clock = clamp(+min || 0, 0, model.duration);
  playing = false;
  const playBtn = el('play'); if (playBtn) playBtn.textContent = '▶ play';
  lastSimT = -1;
  seamDyn = seamDynTarget(clock);   // snap (scrub shows the right seam position immediately)
  computeHeight(clock);
  if (material) {
    const u = material.userData.u;
    u.uHScale.value = tune.heightScale;
    u.uTime.value = clock * 0.5 * tune.flowSpeed;
    u.uFront.value = frontAt(0.5, clock);
    const possHome = clamp(at(model.series.possHome, clock, model.STEP), 0, 1);
    uPossCur = 1 - possHome;
    u.uPoss.value = uPossCur;
    u.uIntensity.value = clamp(at(model.series.intensity, clock, model.STEP), 0, 1);
    applyLookUniforms();
  }
  updateGoalRings(true);   // scrub → show each past goal's ring in its settled small state
  controls.update();
  composer.render();
  updateHud();
  updateCamReadout();
};

// Push all the colour/lighting/effect/material/post tunables into uniforms.
function applyLookUniforms() {
  if (!material) return;
  const u = material.userData.u;
  u.uDim.value = tune.ownerDim;
  u.uGlow.value = tune.glow;
  u.uGlowCol.value.set(tune.glowCol);
  u.uSat.value = tune.sat;
  u.uClay.value.set(tune.clay);
  u.uTint.value = tune.tint;
  u.uTex.value = tune.tex;
  u.uWobble.value = tune.wobble;
  u.uAO.value = tune.ao;
  // SOLID BODY + MICRO-SURFACE
  const th = clamp(tune.thickness, 0, 8);
  u.uThickness.value = th;
  u.uDetail.value = tune.detail;
  u.uDetailScale.value = tune.detailScale;
  u.uPattern.value = tune.pattern;
  u.uLines.value = tune.lines;
  if (slab) slab.position.y = -th - 0.12;

  // PBR material
  material.roughness = tune.rough;
  material.metalness = tune.metal;
  material.envMapIntensity = tune.env;

  // lighting: map stage6's "light" + "amb" onto the real light rig.
  // key/fill intensity from `light`; ambient floor from `amb` (env intensity
  // also lifts the IBL ambient). Shadow strength via key opacity-ish.
  keyLight.intensity = 1.0 + tune.light * 3.0;
  keyLight.color.set(tune.lightCol);
  // ambient floor: scale the hemisphere up with `amb`.
  scene.children.forEach((c) => {
    if (c.isHemisphereLight) c.intensity = 0.25 + tune.amb * 1.4;
  });
  renderer.toneMappingExposure = 1.0;

  // shadow strength: fade shadow darkness by easing intensity contribution.
  if (renderer.shadowMap) renderer.shadowMap.needsUpdate = false;
  keyLight.castShadow = tune.shadow > 0.001;
  keyLight.shadow.intensity !== undefined && (keyLight.shadow.intensity = clamp(tune.shadow, 0, 1));

  // post
  if (bloomPass) { bloomPass.strength = tune.bloomStr; bloomPass.radius = tune.bloomRad; bloomPass.threshold = tune.bloomThr; }
  if (gradePass) {
    gradePass.uniforms.uVig.value = tune.vig;
    gradePass.uniforms.uExpo.value = tune.expo;
    gradePass.uniforms.uContr.value = tune.contr;
    gradePass.uniforms.uGsat.value = tune.gsat;
  }
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
  const mm = Math.floor(t);
  el('clk').textContent = mm + "'";
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

  // sim / data
  bindSlider('speed', 'speedV', (v) => { tune.speed = v; return v.toFixed(1) + '×'; });
  bindSlider('hscale', 'hscaleV', (v) => { tune.heightScale = v; return v.toFixed(2); });
  bindSlider('turb', 'turbV', (v) => { tune.turbulence = v; return v.toFixed(2); });
  bindSlider('ridge', 'ridgeV', (v) => { tune.ridgeSharp = v; lastSimT = -1; return v.toFixed(2); });
  bindSlider('flow', 'flowV', (v) => { tune.flowSpeed = v; return v.toFixed(2); });
  bindSlider('seam', 'seamV', (v) => { tune.seamPoss = v; lastSimT = -1; return v.toFixed(2); });
  bindSlider('wobble', 'wobbleV', (v) => { tune.wobble = v; return v.toFixed(2); });
  // colour
  bindSlider('ownerdim', 'ownerdimV', (v) => { tune.ownerDim = v; return v.toFixed(2); });
  bindSlider('sat', 'satV', (v) => { tune.sat = v; return v.toFixed(2); });
  bindSlider('tint', 'tintV', (v) => { tune.tint = v; return v.toFixed(2); });
  bindSlider('tex', 'texV', (v) => { tune.tex = v; return v.toFixed(2); });
  bindSlider('glow', 'glowV', (v) => { tune.glow = v; return v.toFixed(2); });
  // material
  bindSlider('rough', 'roughV', (v) => { tune.rough = v; return v.toFixed(2); });
  bindSlider('metal', 'metalV', (v) => { tune.metal = v; return v.toFixed(2); });
  bindSlider('env', 'envV', (v) => { tune.env = v; return v.toFixed(2); });
  // lighting
  bindSlider('light', 'lightV', (v) => { tune.light = v; return v.toFixed(2); });
  bindSlider('amb', 'ambV', (v) => { tune.amb = v; return v.toFixed(2); });
  bindSlider('shadow', 'shadowV', (v) => { tune.shadow = v; return v.toFixed(2); });
  bindSlider('ao', 'aoV', (v) => { tune.ao = v; return v.toFixed(2); });
  // solid body + micro-surface
  bindSlider('thickness', 'thicknessV', (v) => { tune.thickness = v; return v.toFixed(2); });
  bindSlider('detail', 'detailV', (v) => { tune.detail = v; return v.toFixed(2); });
  bindSlider('detailScale', 'detailScaleV', (v) => { tune.detailScale = v; return v.toFixed(2); });
  bindSlider('lines', 'linesV', (v) => { tune.lines = v; if (material) material.userData.u.uLines.value = v; return v.toFixed(2); });
  // goal-entry rings
  bindSlider('ringSize', 'ringSizeV', (v) => { tune.ringSize = v; return v.toFixed(2); });
  bindSlider('ringStr', 'ringStrV', (v) => { tune.ringStr = v; return v.toFixed(2); });
  // surface pattern selector
  const pat = el('pattern');
  if (pat) {
    pat.value = String(tune.pattern);
    pat.addEventListener('change', () => {
      tune.pattern = +pat.value;
      if (material) material.userData.u.uPattern.value = tune.pattern;
    });
  }
  // post
  bindSlider('bloomStr', 'bloomStrV', (v) => { tune.bloomStr = v; return v.toFixed(2); });
  bindSlider('bloomRad', 'bloomRadV', (v) => { tune.bloomRad = v; return v.toFixed(2); });
  bindSlider('bloomThr', 'bloomThrV', (v) => { tune.bloomThr = v; return v.toFixed(2); });
  bindSlider('vig', 'vigV', (v) => { tune.vig = v; return v.toFixed(2); });
  bindSlider('expo', 'expoV', (v) => { tune.expo = v; return v.toFixed(2); });
  bindSlider('contr', 'contrV', (v) => { tune.contr = v; return v.toFixed(2); });
  bindSlider('gsat', 'gsatV', (v) => { tune.gsat = v; return v.toFixed(2); });

  // key-light colour picker
  const lc = el('lightcol');
  if (lc) {
    lc.value = tune.lightCol;
    const applyLc = () => { tune.lightCol = lc.value; if (keyLight) keyLight.color.set(lc.value); };
    lc.addEventListener('input', applyLc);
    applyLc();
  }

  // clay (material base) colour picker
  const cl = el('claycol');
  if (cl) {
    cl.value = tune.clay;
    const applyCl = () => { tune.clay = cl.value; if (material) material.userData.u.uClay.value.set(cl.value); };
    cl.addEventListener('input', applyCl);
    applyCl();
  }

  // glow colour picker
  const gc = el('glowcol');
  if (gc) {
    gc.value = tune.glowCol;
    const applyGc = () => { tune.glowCol = gc.value; if (material) material.userData.u.uGlowCol.value.set(gc.value); };
    gc.addEventListener('input', applyGc);
    applyGc();
  }

  // per-team colour pickers (override the data colours)
  const hc = el('homecol');
  if (hc) hc.addEventListener('input', () => {
    tune.homeCol = hc.value;
    if (material) uHome().set(hc.value);
    document.documentElement.style.setProperty('--home-color', hc.value);
  });
  const ac = el('awaycol');
  if (ac) ac.addEventListener('input', () => {
    tune.awayCol = ac.value;
    if (material) uAway().set(ac.value);
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

// Snapshot EVERY tunable + the camera as a JSON blob.
function settingsBlob() {
  const r2 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
  return {
    tune: {
      speed: r2(tune.speed), heightScale: r2(tune.heightScale), turbulence: r2(tune.turbulence),
      ridgeSharp: r2(tune.ridgeSharp), flowSpeed: r2(tune.flowSpeed),
      seamPoss: r2(tune.seamPoss), wobble: r2(tune.wobble), ownerDim: r2(tune.ownerDim),
      sat: r2(tune.sat), tint: r2(tune.tint), clay: tune.clay,
      light: r2(tune.light), lightCol: tune.lightCol, amb: r2(tune.amb), tex: r2(tune.tex),
      glow: r2(tune.glow), glowCol: tune.glowCol,
      homeCol: (el('homecol') && el('homecol').value) || tune.homeCol,
      awayCol: (el('awaycol') && el('awaycol').value) || tune.awayCol,
      // cinematic additions
      rough: r2(tune.rough), metal: r2(tune.metal), env: r2(tune.env),
      shadow: r2(tune.shadow), ao: r2(tune.ao),
      // solid body + surface pattern
      thickness: r2(tune.thickness), pattern: tune.pattern,
      detail: r2(tune.detail), detailScale: r2(tune.detailScale), lines: r2(tune.lines),
      ringSize: r2(tune.ringSize), ringStr: r2(tune.ringStr),
      bloomStr: r2(tune.bloomStr), bloomRad: r2(tune.bloomRad), bloomThr: r2(tune.bloomThr),
      vig: r2(tune.vig), expo: r2(tune.expo), contr: r2(tune.contr), gsat: r2(tune.gsat),
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

// ---- draggable / resizable HUD layout --------------------------------------
// Each HUD widget (team names, score, clock, possession, momentum, xG) can be
// freely positioned and scaled with the mouse in "edit" mode, then saved
// (localStorage + clipboard JSON). Display-only and click-through otherwise.
const HUD_KEYS = ['teams', 'score', 'clock'];
const HUD_STORE = 'stage7_hud_v2';
function setupHudLayout() {
  const widget = (k) => el('w_' + k);
  // user-baked default layout (poss / mom / xG removed)
  const defaults = () => ({
    teams: { x: 558, y: 155, s: 5.213 },
    score: { x: 572, y: 243, s: 1.827 },
    clock: { x: 1385, y: 165, s: 2.537 },
  });
  let layout;
  try { layout = JSON.parse(localStorage.getItem(HUD_STORE)) || defaults(); } catch { layout = defaults(); }

  const curOf = (k) => {
    const w = widget(k);
    return { x: Math.round(parseFloat(w.style.left) || 0), y: Math.round(parseFloat(w.style.top) || 0), s: +(parseFloat(w.dataset.s) || 1).toFixed(3) };
  };
  const apply = () => {
    for (const k of HUD_KEYS) {
      const w = widget(k); if (!w) continue;
      const p = layout[k] || { x: 20, y: 20, s: 1 };
      w.style.left = p.x + 'px'; w.style.top = p.y + 'px';
      w.style.transform = 'scale(' + (p.s || 1) + ')';
      w.dataset.s = String(p.s || 1);
    }
  };
  apply();

  const editing = () => document.body.classList.contains('hud-edit');
  for (const k of HUD_KEYS) {
    const w = widget(k); if (!w) continue;
    const handle = w.querySelector('.rsz');
    // DRAG (move) — anywhere on the widget except the resize handle. Move/up are
    // bound to window so the drag follows the cursor anywhere on screen.
    w.addEventListener('pointerdown', (e) => {
      if (!editing() || e.target === handle) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY;
      const ox = parseFloat(w.style.left) || 0, oy = parseFloat(w.style.top) || 0;
      const mv = (ev) => { w.style.left = (ox + ev.clientX - sx) + 'px'; w.style.top = (oy + ev.clientY - sy) + 'px'; };
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); layout[k] = curOf(k); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    });
    // RESIZE (scale) — drag the corner handle (move/up on window too).
    if (handle) handle.addEventListener('pointerdown', (e) => {
      if (!editing()) return;
      e.preventDefault(); e.stopPropagation();
      const sx = e.clientX, sy = e.clientY, os = parseFloat(w.dataset.s) || 1;
      const mv = (ev) => {
        const s = clamp(os + ((ev.clientX - sx) + (ev.clientY - sy)) / 180, 0.3, 6);
        w.style.transform = 'scale(' + s + ')'; w.dataset.s = String(s);
      };
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); layout[k] = curOf(k); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    });
  }

  const editBtn = el('hudedit');
  if (editBtn) editBtn.addEventListener('click', () => {
    document.body.classList.toggle('hud-edit');
    editBtn.textContent = editing() ? '✓ готово' : '✥ двигать HUD';
  });
  const saveBtn = el('hudsave');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    for (const k of HUD_KEYS) layout[k] = curOf(k);
    const json = JSON.stringify(layout);
    try { localStorage.setItem(HUD_STORE, json); } catch {}
    try { await navigator.clipboard.writeText(json); } catch {}
    const o = saveBtn.textContent; saveBtn.textContent = 'saved ✓';
    setTimeout(() => { saveBtn.textContent = o; }, 1300);
  });
  const resetBtn = el('hudreset');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    try { localStorage.removeItem(HUD_STORE); } catch {}
    layout = defaults(); apply();
  });
}
