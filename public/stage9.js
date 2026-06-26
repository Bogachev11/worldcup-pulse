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
import { clamp, lerp, smoothstep, fbm, buildModel, at, rgb01, xgUpTo,
  richDuration, normMomentum, sampleSeries } from './claybattle.js';

const ID = new URLSearchParams(location.search).get('id') || '1953888';
const el = (id) => document.getElementById(id);

// Per-abbreviation team-colour OVERRIDE. If a team's abbr appears here, that hex
// is used for it instead of its per-match data colour (the session colour pickers
// still override on top). Everyone else keeps their per-match colour.
const TEAM_COL = { FRA: '#387ef0' };

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
// metre→world: pitch WIDTH (68m) maps onto WORLD_Z, so 1m = WORLD_Z/68 world units.
// Goal heights (onGoalY, crossbar ≈ 2.44m) lift the rings off the y=0 plane by this.
const M2W = WORLD_Z / 68;                 // metres → world units
const CROSSBAR_M = 2.44;                  // goal crossbar height (m)

// ---- scene state ------------------------------------------------------------
let renderer, scene, camera, controls, composer;
let bloomPass, gradePass, smaaPass;
let heightTex, heightData;               // DataTexture (R32F) of per-vertex H
let mesh, material, keyLight;
let pitchPlane, pitchMat;                 // static flat markings plane at y=0
let heightBaseline = 0;                   // CPU-computed mean height → cloth straddles y=0
let injected = null;                     // ref to the compiled onBeforeCompile shader.uniforms
let model = null;                        // built data model (colours / shots / eruptions scaffolding)
let rawMatch = null;                     // the raw rich record (for the pressure model)
let pm = null;                           // the PRESSURE MODEL: per-step decaying series (see computePressureModel)
let clock = 0, playing = true;
let lastSimT = -1;                       // last match-time we recomputed H at
let uPossCur = 0.5;                      // smoothed live away-possession share (0 home..1 away)
// displayed (visual) wave heights — eased FAST up, SLOW down so a single counter
// shot flashes a sharp wave instead of being smoothed away. Updated each frame.
let waveDispH = 0, waveDispA = 0;

// tuning (bound to sliders) — stage6 defaults preserved + cinematic additions
const tune = {
  // sim / data (identical to stage6)
  speed: 3.7,
  heightScale: 2.2,
  turbulence: 3.0,
  ridgeSharp: 1.0,
  flowSpeed: 0.48,
  seamPoss: 0.46,

  // ============================================================================
  // PRESSURE MODEL · логика — ALL the numbers behind the threat-wave model.
  // Live-wired: changing a τ/weight recomputes the per-step series (recomputeModel).
  // ============================================================================
  // half-lives (match-minutes) for each exponentially-decaying window
  tauThreat: 2.5,    // threat (wave height)
  tauTilt:  3.5,     // territory / field tilt (colour seam)
  tauPoss:  1.5,     // control / possession (colour brightness gate)
  tauDef:   2.0,     // defence / breakwater (chops opponent wave)
  tauTempo: 1.5,     // tempo (surface ripple)
  // threat weights
  wOnTarget: 0.30,   // + per on-target shot
  wBigChance: 0.40,  // + per big chance (xg>0.3)
  wBoxEntry: 0.15,   // + per pass ending in opponent box (×Σ↓ of those)
  wFastBreak: 1.6,   // FastBreak shot multiplier (preserve counters)
  kDef: 0.55,        // defence strength: amplitude *= (1 - kDef·def_opp), clamped
  // visual scales (model → render)
  threatHeight: 1.5, // threat → wave height (world units / unit-threat)
  waveSpread: 0.30,  // how far up-pitch the swell builds (final-third width along u)
  waveWidth:  0.55,  // crest spread across the goal mouth (v), broad-ish
  tiltSeam:   1.0,   // tilt → seam displacement strength (1 = full)
  tempoRipple: 0.18, // tempo → ripple amplitude on the cloth
  waveRise:   9.0,   // displayed-wave rise speed (fast up)
  waveDecay:  2.2,   // displayed-wave decay speed (slow down)
  chop:       1.0,   // breakwater chop strength (high-freq jagged term scaled by def)

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
  thickness: 0,     // NO-OP: the cloth is now a single thin sheet floating in air (no skirt/slab)
  pattern: 4,       // surface pattern: 0 grid · 1 weave · 2 lines · 3 dots · 4 hex · 5 grain
  detail: 1.1,      // pattern depth/strength
  detailScale: 2.58,// pattern density (frequency)
  lines: 0.6,       // football PITCH MARKINGS strength on the top surface (0 = off)
  // GOAL-ENTRY RINGS (contracting, scoring-team colour, flat on the cloth)
  ringSize: 1.0,    // settled-ring size multiplier
  ringStr: 1.6,     // ring emissive brightness multiplier
  // SHOT DOTS + Z (height) controls for shots and goals
  shotSize: 1.0,    // shot-dot radius multiplier (goal-mouth torец)
  shotZ: 1.0,       // multiplier on shot dots' onGoalY→worldY mapping
  goalZ: 1.0,       // multiplier on the goal rings' onGoalY→worldY mapping
  bumpSize: 0,      // cloth shot-marker (подъёмчик) size — DEFAULT HIDDEN (cones read wrong); slider kept
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

// GOAL-ENTRY RINGS: one VERTICAL ring mesh per goal, standing in the goal-mouth
// plane (disc normal points down the pitch length, ±X) at the height the goal was
// scored. Contracts big→small in the scoring team's colour.
let goalRings = [];                       // [{ goal, mesh, mat, u, v, y }]
const RING_GROW_LIFE = 5.0;               // match-minutes over which the ring contracts
const RING_R_BIG = 2.6;                   // start radius (world units)
const RING_R_SMALL = 0.6;                 // settled radius (world units)

// SHOT DOTS: one small emissive sphere per shot (ALL shots, goals included),
// placed at the goal mouth exactly like the goal rings. Smaller + dimmer than the
// rings so the goals still dominate. [{ shot, mesh, mat, u, v, ogy }]
let shotDots = [];
const SHOT_FADE_LIFE = 0.6;               // match-minutes to fade in after the shot
const SHOT_R = 0.16;                       // base dot radius (world units)
let clothShots = [];                       // small cone "подъёмчик" per shot, on the cloth at the shot spot
const BUMP_R = 0.22;                        // base cone radius (world units)
const BUMP_H = 0.55;                        // base cone height (world units)

// ---- boot -------------------------------------------------------------------
init().catch((e) => fail(e.message || String(e)));

async function init() {
  if (!window.WebGLRenderingContext) throw new Error('WebGL not available in this browser');

  const raw = await fetch('/api/rich/' + ID).then((r) => {
    if (!r.ok) throw new Error('api ' + r.status);
    return r.json();
  });
  rawMatch = raw;
  model = buildModel(raw);
  attachGoalMouth(raw);   // carry onGoalX/onGoalY from the raw shots onto model goals
  pm = computePressureModel(raw);   // THE PRESSURE MODEL — decaying-window series

  setupThree();
  buildHeightfield();
  setupComposer();
  bindUI();
  setupHudLayout();
  setupSectionCopy();
  applyTeamColors();
  applyLookUniforms();

  el('title2').textContent =
    `STAGE 9 · PRESSURE · ${model.home.abbr || 'HOME'} ${model.home.score}–${model.away.score} ${model.away.abbr || 'AWAY'}`;
  el('hAbbr').textContent = model.home.abbr || 'HOME';
  el('aAbbr').textContent = model.away.abbr || 'AWAY';

  window.addEventListener('resize', onResize);
  onResize();
  requestAnimationFrame(loop);
}

function fail(msg) {
  const t = el('title2'); if (t) t.textContent = 'STAGE 9 · PRESSURE · failed: ' + msg;
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

// ---- heightfield mesh: MeshStandardMaterial + onBeforeCompile injection ------
// A SINGLE THIN SHEET (like stage2): one PlaneGeometry displaced by H(uv) in the
// vertex shader — no skirt walls, no bottom cap, no base slab. It oscillates
// AROUND y=0 (we subtract a CPU-computed baseline) so it weaves through the flat
// markings plane at y=0.
function buildHeightfield() {
  const geo = new THREE.PlaneGeometry(WORLD_X, WORLD_Z, GX, GY);
  geo.rotateX(-Math.PI / 2);              // lay flat: plane now in XZ, +Y up

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
    uBaseline: { value: 0 },          // CPU mean height → sheet straddles y=0
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
    // MICRO-SURFACE
    uDetail: { value: tune.detail },
    uDetailScale: { value: tune.detailScale },
    uPattern: { value: tune.pattern },
  };
  material.userData.u = u;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    injected = shader.uniforms;

    // ---- VERTEX ----  (single thin sheet, like stage2)
    shader.vertexShader = `
      uniform sampler2D uHeight;
      uniform vec2 uTexel;
      uniform float uHScale;
      uniform float uBaseline;        // subtract so the sheet straddles y=0
      uniform vec2 uWorld;
      varying float vHd;              // raw displaced height (for colour/glow cues)
      varying vec2 vUvN;
      float H7(vec2 uv){
        float h = texture2D(uHeight, uv).r * uHScale;
        // NaN/Inf guard so the surface never opens see-through holes.
        if (!(h == h)) h = 0.0;
        return h;                     // NO lower clamp: H may now go below 0
      }
    ` + shader.vertexShader;

    // NORMAL: finite-difference height normal across the whole sheet.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>
        vUvN = uv;
        float hl = H7(uv - vec2(uTexel.x, 0.0));
        float hr = H7(uv + vec2(uTexel.x, 0.0));
        float hd = H7(uv - vec2(0.0, uTexel.y));
        float hu = H7(uv + vec2(0.0, uTexel.y));
        float dx = (uWorld.x * uTexel.x) * 2.0;
        float dz = (uWorld.y * uTexel.y) * 2.0;
        objectNormal = normalize(vec3(-(hr - hl)/max(dx,1e-4), 1.0, -(hu - hd)/max(dz,1e-4)));
      `
    );

    // DISPLACEMENT: ride the height field, re-centred around the baseline so the
    // sheet floats in air and oscillates BOTH above and below the y=0 plane.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
        float h7 = H7(uv);
        vHd = h7;
        transformed.y += (h7 - uBaseline);
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
      varying float vHd;
      varying vec2 vUvN;

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
        roughnessFactor = clamp(roughnessFactor + uDetail * 0.22 * (0.5 - pr), 0.16, 1.0);
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
        float amp = uDetail * 0.3;
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

  buildPitchPlane();
  buildGoalRings();
}

// ---- STATIC PITCH-MARKINGS PLANE at y=0 -------------------------------------
// A flat plane the full pitch size (WORLD_X × WORLD_Z) at y=0 that draws the
// football markings into a dark, near-transparent ground. Because the cloth now
// straddles y=0, this plane shows through where the cloth dips below 0 and is
// hidden where it rises above — the "weaving" effect. uLines = line intensity.
function buildPitchPlane() {
  const geo = new THREE.PlaneGeometry(WORLD_X, WORLD_Z, 1, 1);
  geo.rotateX(-Math.PI / 2);                 // flat in XZ at y=0
  pitchMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: true,
    side: THREE.DoubleSide,
    uniforms: {
      uLines: { value: tune.lines },
      uHome: material.userData.u.uHome,      // share team colours (boundary tint optional)
      uAway: material.userData.u.uAway,
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
    `,
    fragmentShader: PITCH_FRAG,
  });
  pitchPlane = new THREE.Mesh(geo, pitchMat);
  pitchPlane.position.y = 0.0;
  pitchPlane.renderOrder = -1;               // draw under the cloth
  pitchPlane.receiveShadow = false;
  scene.add(pitchPlane);
}

// FIFA-ish pitch (105×68) markings drawn in the plane's uv. Crisp AA white lines
// on a dark, mostly-transparent ground. Same marking set as before.
const PITCH_FRAG = /* glsl */`
  precision highp float;
  uniform float uLines;
  varying vec2 vUv;
  const float PL = 105.0;   // pitch length (m)
  const float PW = 68.0;    // pitch width (m)
  float seg7(vec2 puv, vec2 a, vec2 b, float halfW){
    vec2 P = vec2(puv.x * PL, puv.y * PW);
    vec2 ab = b - a, ap = P - a;
    float t = clamp(dot(ap, ab) / max(dot(ab, ab), 1e-5), 0.0, 1.0);
    float d = length(P - (a + t * ab));
    float aa = (fwidth(P.x) + fwidth(P.y)) * 0.5 + 1e-4;
    return 1.0 - smoothstep(halfW, halfW + aa, d);
  }
  float rect7(vec2 puv, vec2 lo, vec2 hi, float halfW){
    float c = 0.0;
    c = max(c, seg7(puv, vec2(lo.x, lo.y), vec2(hi.x, lo.y), halfW));
    c = max(c, seg7(puv, vec2(hi.x, lo.y), vec2(hi.x, hi.y), halfW));
    c = max(c, seg7(puv, vec2(hi.x, hi.y), vec2(lo.x, hi.y), halfW));
    c = max(c, seg7(puv, vec2(lo.x, hi.y), vec2(lo.x, lo.y), halfW));
    return c;
  }
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
  float pitchLines7(vec2 uv){
    float hw = 0.10;            // line half-width (m)
    float inset = 1.6;          // boundary inset from the plane edge (m)
    vec2 lo = vec2(inset, inset);
    vec2 hi = vec2(PL - inset, PW - inset);
    float c = 0.0;
    c = max(c, rect7(uv, lo, hi, hw));                                   // outer boundary
    c = max(c, seg7(uv, vec2(PL*0.5, lo.y), vec2(PL*0.5, hi.y), hw));    // halfway line
    c = max(c, ring7(uv, vec2(PL*0.5, PW*0.5), 9.15, hw));               // centre circle
    c = max(c, dot7(uv, vec2(PL*0.5, PW*0.5), 0.35));                    // centre spot
    for (int s = 0; s < 2; s++){
      float dir = (s == 0) ? 1.0 : -1.0;
      float gx  = (s == 0) ? inset : PL - inset;
      float pax = gx + dir * 16.5;                                       // penalty area
      c = max(c, rect7(uv, vec2(min(gx,pax), PW*0.5 - 20.16), vec2(max(gx,pax), PW*0.5 + 20.16), hw));
      float gax = gx + dir * 5.5;                                        // goal area
      c = max(c, rect7(uv, vec2(min(gx,gax), PW*0.5 - 9.16), vec2(max(gx,gax), PW*0.5 + 9.16), hw));
      vec2 pSpot = vec2(gx + dir * 11.0, PW*0.5);                        // penalty spot
      c = max(c, dot7(uv, pSpot, 0.35));
      float arc = ring7(uv, pSpot, 9.15, hw);                           // penalty arc (outside box)
      vec2 P = vec2(uv.x * PL, uv.y * PW);
      float outside = (dir > 0.0) ? step(pax, P.x) : step(P.x, pax);
      c = max(c, arc * outside);
    }
    return clamp(c, 0.0, 1.0);
  }
  void main(){
    float lines = pitchLines7(vUv) * clamp(uLines, 0.0, 1.0);
    // dark ground (faint) + crisp white-ish lines; alpha follows line coverage so
    // the ground is near-transparent and the cloth's troughs reveal the markings.
    vec3 ground = vec3(0.02, 0.03, 0.05);
    vec3 lineCol = vec3(0.92, 0.94, 0.97);
    vec3 col = mix(ground, lineCol, lines);
    float alpha = max(0.12 * clamp(uLines, 0.0, 1.0), lines);
    gl_FragColor = vec4(col, alpha);
  }
`;

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
  // model.shots is built as raw.shots.filter(Number.isFinite(x)).map(normShot) —
  // SAME order — so the goal-mouth crossing (onGoalX/onGoalY) dropped by normShot
  // lines up by index. Attach onto EVERY shot (goals AND off-target shots) so the
  // shot-dot layer can place all of them; the goal rings reuse the same fields.
  const rawShots = (raw.shots || []).filter((s) => Number.isFinite(s.x));
  const modelShots = model.shots || [];
  for (let i = 0; i < modelShots.length; i++) {
    let r = rawShots[i];
    // guard: if order ever drifts, fall back to a team+minute match.
    if (!r || r.team !== modelShots[i].team || (Number(r.minute) || 0) !== modelShots[i].minute) {
      r = rawShots.find((g) => g.team === modelShots[i].team && (Number(g.minute) || 0) === modelShots[i].minute) || r;
    }
    if (r) {
      modelShots[i].onGoalX = Number.isFinite(r.onGoalX) ? r.onGoalX : null;
      modelShots[i].onGoalY = Number.isFinite(r.onGoalY) ? r.onGoalY : null;
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

    // CENTRE HEIGHT from onGoalY: 0 = ground, 1 ≈ crossbar (2.44m) → world units.
    // Stored raw; the goalZ multiplier is applied live in updateGoalRings.
    const ogy = Number.isFinite(g.onGoalY) ? g.onGoalY : 0.0;

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
    // unit ring; we re-scale per frame to animate the contraction. RingGeometry
    // lies in the XY plane (normal +Z); rotate so its disc stands VERTICAL in the
    // goal-mouth plane (normal points DOWN the pitch length, along ±X).
    const geo = new THREE.RingGeometry(0.7, 1.0, 96);
    const m = new THREE.Mesh(geo, mat);
    m.rotation.y = Math.PI / 2;                        // normal +Z → +X (down-pitch)
    m.renderOrder = 5;
    m.visible = false;
    scene.add(m);
    goalRings.push({ goal: g, mesh: m, mat, u, v, ogy });
  }
  buildShotDots();
  buildClothShots();
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
    // brightness: bright on spawn, easing to a clear settled glow.
    const bright = lerp(5.0, 2.2, ease) * tune.ringStr;
    const opacity = lerp(0.98, 0.82, ease);
    // VERTICAL ring (rotated normal→±X): its disc spans local X/Y, which map to
    // world Z (across width) and Y (height). Scale those, leave the normal (Z) 1.
    r.mesh.scale.set(radius, radius, 1);
    // stand at the goal mouth, centred at the goal's entry height above y=0.
    // height: onGoalY → world Y (crossbar mapping) × the live goal-Z multiplier.
    const y = clamp(r.ogy, 0, 1.2) * CROSSBAR_M * M2W * tune.goalZ;
    r.mesh.position.set(worldX(r.u), y, worldZ(r.v));
    r.mat.emissiveIntensity = bright;
    r.mat.opacity = opacity;
    // keep the colour in sync with any live team-colour picker change
    r.mat.emissive.copy(g.team === 'home' ? uHome() : uAway());
    r.mesh.visible = true;
  }
}

// ---- SHOT DOTS --------------------------------------------------------------
// One small emissive sphere per shot in model.shots (ALL 17, goals included).
// Placed at the goal mouth with the SAME convention as the goal rings:
//   along length u : home → u≈1 (away end), away → u≈0 (home end).
//   across width v : 0.5 + sign·((onGoalX−1)/2)·(7.32/68), away frame mirrored.
//   height (world Y): onGoalY × 2.44 × (WORLD_Z/68) × shotZ — same metre→world
//                     mapping the rings use, scaled by the live shot-Z control.
// Off-target shots (onGoalX up to ~1.9, onGoalY up to ~0.7) intentionally spread
// around / above the goal frame — it reads as a real shot map. Dots are smaller +
// dimmer than the goal rings so goals still dominate.
function buildShotDots() {
  shotDots = [];
  const shots = model.shots || [];
  const mouthFracV = 7.32 / 68;                       // goal mouth as a fraction of width
  // one shared unit sphere geometry; per-dot material for team colour + fade.
  const geo = new THREE.SphereGeometry(1.0, 18, 14);
  for (const s of shots) {
    const u = s.team === 'home' ? 0.985 : 0.015;       // attacking goal line (like rings)
    const ogx = Number.isFinite(s.onGoalX) ? s.onGoalX : 1.0;
    const sign = s.team === 'home' ? 1 : -1;           // away frame mirrored → flip
    const v = clamp(0.5 + sign * ((ogx - 1) / 2) * mouthFracV, 0.01, 0.99);
    const ogy = Number.isFinite(s.onGoalY) ? s.onGoalY : 0.0;
    const col = (s.team === 'home' ? uHome() : uAway()).clone();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: col,
      emissiveIntensity: 1.5,                          // dimmer than goal rings (2.2–5)
      roughness: 0.5, metalness: 0.0,
      transparent: true, opacity: 0.0,
      depthWrite: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = 4;                                 // just under the goal rings (5)
    m.visible = false;
    scene.add(m);
    shotDots.push({ shot: s, mesh: m, mat, u, v, ogy });
  }
}

// Show every shot dot up to the current clock. Brief fade-in at its minute, then
// persists (no contraction — that's the goal ring's job). settled=true (scrub)
// snaps each past shot fully visible immediately.
function updateShotDots(settled) {
  if (!shotDots.length) return;
  for (const d of shotDots) {
    const s = d.shot;
    if (clock < s.t) { d.mesh.visible = false; continue; }
    const age = clock - s.t;
    const fade = settled ? 1.0 : clamp(age / SHOT_FADE_LIFE, 0, 1);
    const radius = SHOT_R * tune.shotSize;
    const y = clamp(d.ogy, 0, 1.2) * CROSSBAR_M * M2W * tune.shotZ;
    d.mesh.scale.setScalar(radius);
    d.mesh.position.set(worldX(d.u), y, worldZ(d.v));
    d.mat.opacity = lerp(0.0, 0.92, fade);
    // keep colour synced with live team-colour picker changes
    d.mat.emissive.copy(s.team === 'home' ? uHome() : uAway());
    d.mesh.visible = true;
  }
}

// CLOTH SHOT MARKERS: a small emissive cone ("подъёмчик") standing on the cloth at
// the spot the shot was TAKEN (pitch x,y), in the shooting team's colour. So a shot
// reads in two places — a local bump on the pitch (here) AND a dot on the goal-mouth
// torец (buildShotDots). model.eruptions carries every shot's normalised pitch (x,y).
function buildClothShots() {
  clothShots = [];
  const geo = new THREE.ConeGeometry(1.0, 1.0, 20);   // unit cone (rescaled per frame)
  for (const e of (model.eruptions || [])) {
    const col = (e.team === 'home' ? uHome() : uAway()).clone();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x000000, emissive: col, emissiveIntensity: 1.4,
      roughness: 0.5, metalness: 0.0, transparent: true, opacity: 0.0, depthWrite: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = 3; m.visible = false;
    scene.add(m);
    clothShots.push({ e, mesh: m, mat, u: e.x, v: e.y });
  }
}

// Show every cloth bump up to the current clock; fade in at its minute, then persist.
function updateClothShots(settled) {
  if (!clothShots.length) return;
  for (const c of clothShots) {
    const e = c.e;
    if (clock < e.t) { c.mesh.visible = false; continue; }
    const age = clock - e.t;
    const fade = settled ? 1.0 : clamp(age / SHOT_FADE_LIFE, 0, 1);
    const r = BUMP_R * tune.bumpSize;
    const hh = BUMP_H * tune.bumpSize * (0.7 + Math.min(1, e.xg || 0) * 1.4);   // taller with xG
    c.mesh.scale.set(r, hh, r);
    const base = clothY(c.u, c.v);
    c.mesh.position.set(worldX(c.u), base + hh * 0.5, worldZ(c.v));             // cone base on the cloth
    c.mat.opacity = lerp(0.0, 0.9, fade);
    c.mat.emissive.copy(e.team === 'home' ? uHome() : uAway());
    c.mesh.visible = true;
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
  // per-abbr override (e.g. FRA → #387ef0); session pickers still win on top.
  const hOver = TEAM_COL[model.home.abbr] || null;
  const aOver = TEAM_COL[model.away.abbr] || null;
  const hHex = tune.homeCol || hOver || rgbToHex(h);
  const aHex = tune.awayCol || aOver || rgbToHex(a);
  if (tune.homeCol || hOver) uHome().set(hHex); else uHome().setRGB(h[0], h[1], h[2]);
  if (tune.awayCol || aOver) uAway().set(aHex); else uAway().setRGB(a[0], a[1], a[2]);
  const hc = el('homecol'), ac = el('awaycol');
  if (hc) hc.value = hHex; if (ac) ac.value = aHex;
  document.documentElement.style.setProperty('--home-color', hHex);
  document.documentElement.style.setProperty('--away-color', aHex);
}

// ============================================================================
// THE PRESSURE MODEL — "waves of threat rolling at each goal; defence is a
// breakwater; the coloured field below = territory/control."
//
// CRITICAL DESIGN RULE: there is NO cumulative-over-the-whole-match metric here.
// Every series is a SLIDING, EXPONENTIALLY-DECAYING window (the *current phase*),
// computed per team, two-way. `Σ↓(τ)` = a decaying accumulation with half-life τ
// minutes: contributions older than ~τ fade out, so the surface always shows the
// pressure of the last minute or two, never the season-long average.
//
// Implementation: we precompute every series at STEP resolution by sweeping the
// real events once and decaying a running accumulator from step to step
// (multiplying by 2^(-STEP/τ) each step and adding the events that fall in the
// step). Then we sample with the existing `at(series,t,STEP)` linear-interp
// pattern so scrubbing is exact. recomputeModel() rebuilds them whenever a τ or a
// weight slider changes.
// ============================================================================

// All series share this resolution & length (independent of buildModel's STEP).
const PM_STEP = 0.25;     // finer than buildModel's 0.5 so brief counters survive

// half-life τ (min) → per-step decay multiplier 2^(-STEP/τ)
function decK(tau) { return Math.pow(2, -PM_STEP / Math.max(0.05, tau)); }

// Normalise an event/pass/shot coordinate (0..100) into a COMMON home-attacking
// frame: x→1 = toward the AWAY goal (home's attacking direction). Away rows are
// stored in their own attacking frame, so mirror them. Returns {x,y} in [0,1].
function normXYHome(team, x, y) {
  let X = (Number(x) || 0) / 100, Y = (Number(y) || 0) / 100;
  if (team === 'away') { X = 1 - X; Y = 1 - Y; }
  return { x: clamp(X, 0, 1), y: clamp(Y, 0, 1) };
}
// "attacking final third" for a team in the COMMON home frame: home attacks → x>0.66,
// away attacks → x<0.34. opponent box (home frame): home opp box x>0.83, |y-0.5|<0.21.
const HOME_THIRD = 0.66, BOX_X = 0.83, BOX_HALF_Y = 0.21;

// A small helper: bucket an event time into a PM step index.
function pmIdx(t, N) { return clamp(Math.round((Number(t) || 0) / PM_STEP), 0, N - 1); }

// Build ALL decaying series for the match. Pure of three/DOM. Reads the live
// tune.* numbers so recompute on slider change is just re-calling this.
function computePressureModel(raw) {
  const duration = richDuration(raw);
  const N = Math.max(2, Math.round(duration / PM_STEP) + 1);

  const shots = (raw.shots || []).filter((s) => Number.isFinite(s.x));
  const passes = (raw.passes || []).filter((p) => Number.isFinite(p.x));
  const events = (raw.events || []).filter((e) => Number.isFinite(e.x));
  const momentum = normMomentum(raw.momentum);

  // --- per-step EVENT INJECTIONS (added at the step, then decayed forward) -----
  // threat: one accumulator per team
  const injThreatH = new Float64Array(N), injThreatA = new Float64Array(N);
  // tilt (final-third end-locations): per team
  const injTiltH = new Float64Array(N), injTiltA = new Float64Array(N);
  // possession (on-ball actions): per team
  const injPossH = new Float64Array(N), injPossA = new Float64Array(N);
  // defence (own-third stops + opponent shots blocked/saved): per team
  const injDefH = new Float64Array(N), injDefA = new Float64Array(N);
  // tempo: all events/min
  const injTempo = new Float64Array(N);
  // spatial signatures for the wave shape: where (in v, the goal-mouth offset) the
  // recent threat is concentrated. Decaying weighted mean of shot v per team.
  const injThreatVwH = new Float64Array(N), injThreatVH = new Float64Array(N);
  const injThreatVwA = new Float64Array(N), injThreatVA = new Float64Array(N);

  const ON_TARGET = new Set(['AttemptSaved', 'Goal', 'SavedShot']);
  const STOPPED = new Set(['AttemptSaved', 'SavedShot', 'Post', 'ShotOnPost']); // opponent shot the keeper/woodwork stopped

  // SHOTS → threat (+ counter preservation) and defence (opponent shot stopped)
  for (const s of shots) {
    const team = s.team;                          // 'home' | 'away'
    const i = pmIdx(s.minute, N);
    const xg = Number.isFinite(s.xg) ? s.xg : 0;
    const onT = ON_TARGET.has(s.type) || s.isGoal ? 1 : 0;
    const big = xg > 0.3 ? 1 : 0;
    let w = xg + tune.wOnTarget * onT + tune.wBigChance * big;
    if (s.situation === 'FastBreak') w *= tune.wFastBreak;   // counters get full, boosted weight
    const inj = team === 'home' ? injThreatH : injThreatA;
    inj[i] += w;                                  // decaying SUM (never an average) — a lone counter keeps its full punch
    // goal-mouth offset v (home frame), for shaping the crest across the mouth
    const v = normXYHome(team, s.x, s.y).y;
    if (team === 'home') { injThreatVwH[i] += w; injThreatVH[i] += w * v; }
    else { injThreatVwA[i] += w; injThreatVA[i] += w * v; }
    // opponent shot stopped → credit the DEFENDING team's breakwater
    if (STOPPED.has(s.type)) {
      const d = team === 'home' ? injDefA : injDefH;
      d[i] += 1;
    }
  }

  // PASSES → box-entry threat, tilt (final-third ends), possession
  for (const p of passes) {
    const team = p.team;
    const i = pmIdx(p.minute, N);
    const ok = p.outcome !== 'Unsuccessful';
    // possession: an on-ball action regardless of outcome
    (team === 'home' ? injPossH : injPossA)[i] += 1;
    // box entry (successful pass ending in the opponent box) → threat
    const end = normXYHome(team, p.endX, p.endY);
    if (ok && end.x > BOX_X && Math.abs(end.y - 0.5) < BOX_HALF_Y) {
      (team === 'home' ? injThreatH : injThreatA)[i] += tune.wBoxEntry;
    }
    // tilt: successful pass ENDING in the team's attacking final third
    const inThird = team === 'home' ? end.x > HOME_THIRD : end.x < (1 - HOME_THIRD);
    if (ok && inThird) (team === 'home' ? injTiltH : injTiltA)[i] += 1;
  }
  // SHOTS also count toward tilt (they happen in the final third by definition)
  for (const s of shots) {
    const team = s.team, i = pmIdx(s.minute, N);
    (team === 'home' ? injTiltH : injTiltA)[i] += 1;
  }

  // EVENTS → defence (own-third stops), possession (recoveries), tempo (all)
  const DEF_TYPES = new Set(['Tackle', 'Interception', 'Clearance', 'BallRecovery']);
  for (const e of events) {
    const i = pmIdx(e.minute, N);
    injTempo[i] += 1;                             // every event feeds tempo
    const team = e.team;
    if (team !== 'home' && team !== 'away') continue;
    if (e.type === 'BallRecovery') (team === 'home' ? injPossH : injPossA)[i] += 1; // recoveries = on-ball
    if (DEF_TYPES.has(e.type)) {
      // own third = defensive third in the COMMON home frame (home defends x<0.34)
      const loc = normXYHome(team, e.x, e.y);
      const ownThird = team === 'home' ? loc.x < (1 - HOME_THIRD) : loc.x > HOME_THIRD;
      if (ownThird) (team === 'home' ? injDefH : injDefA)[i] += 1;
    }
  }
  // passes also feed tempo
  for (const p of passes) injTempo[pmIdx(p.minute, N)] += 1;
  for (const s of shots) injTempo[pmIdx(s.minute, N)] += 1;

  // --- DECAY SWEEP: turn injections into decaying accumulations Σ↓(τ) ----------
  const sweep = (inj, tau) => {
    const out = new Float32Array(N);
    const k = decK(tau);
    let acc = 0;
    for (let i = 0; i < N; i++) { acc = acc * k + inj[i]; out[i] = acc; }
    return out;
  };
  const threatH = sweep(injThreatH, tune.tauThreat);
  const threatA = sweep(injThreatA, tune.tauThreat);
  const fT_H = sweep(injTiltH, tune.tauTilt);     // field-tilt accumulation
  const fT_A = sweep(injTiltA, tune.tauTilt);
  const possHraw = sweep(injPossH, tune.tauPoss);
  const possAraw = sweep(injPossA, tune.tauPoss);
  const defH = sweep(injDefH, tune.tauDef);
  const defA = sweep(injDefA, tune.tauDef);
  const tempoRaw = sweep(injTempo, tune.tauTempo);
  // crest-offset v: decaying weighted mean (weight & weighted-value decay together)
  const tvwH = sweep(injThreatVwH, tune.tauThreat), tvH = sweep(injThreatVH, tune.tauThreat);
  const tvwA = sweep(injThreatVwA, tune.tauThreat), tvA = sweep(injThreatVA, tune.tauThreat);

  // --- DERIVED shares & normalisations ----------------------------------------
  const tilt = new Float32Array(N);   // tilt_H = fT_H/(fT_H+fT_A)  (0.5 = balanced)
  const poss = new Float32Array(N);   // poss_H share
  const crestVH = new Float32Array(N), crestVA = new Float32Array(N); // mouth offset
  for (let i = 0; i < N; i++) {
    const ts = fT_H[i] + fT_A[i];
    tilt[i] = ts > 1e-6 ? fT_H[i] / ts : 0.5;
    const ps = possHraw[i] + possAraw[i];
    poss[i] = ps > 1e-6 ? possHraw[i] / ps : 0.5;
    crestVH[i] = tvwH[i] > 1e-4 ? tvH[i] / tvwH[i] : 0.5;
    crestVA[i] = tvwA[i] > 1e-4 ? tvA[i] / tvwA[i] : 0.5;
  }
  // normalise tempo to its own match max (so ripple amplitude reads 0..1)
  let tmax = 1e-6; for (let i = 0; i < N; i++) tmax = Math.max(tmax, tempoRaw[i]);
  const tempo = new Float32Array(N);
  for (let i = 0; i < N; i++) tempo[i] = clamp(tempoRaw[i] / tmax, 0, 1);
  // normalise defence to its own max → kDef gate stays in a sane 0..1 range
  let dmax = 1e-6; for (let i = 0; i < N; i++) dmax = Math.max(dmax, defH[i], defA[i]);
  const defHN = new Float32Array(N), defAN = new Float32Array(N);
  for (let i = 0; i < N; i++) { defHN[i] = clamp(defH[i] / dmax, 0, 1); defAN[i] = clamp(defA[i] / dmax, 0, 1); }
  // momentum per step (FotMob valueNorm, already smooth) — a gentle global lean
  const mom = new Float32Array(N);
  for (let i = 0; i < N; i++) mom[i] = sampleSeries(momentum, i * PM_STEP);

  return {
    duration, N, STEP: PM_STEP,
    threatH, threatA, tilt, poss, def_H: defHN, def_A: defAN, tempo, mom,
    crestVH, crestVA,
  };
}

// Recompute every series after a τ/weight slider change, then re-sim the frame.
function recomputeModel() {
  if (!rawMatch) return;
  pm = computePressureModel(rawMatch);
  lastSimT = -1;
}

// ============================================================================
// HEIGHT/RELIEF = THREAT WAVES (replaces the old possession/ridge/turbulence).
//   H(u,v) = wave(u→away-goal, threat_H, def_A) + wave(u→home-goal, threat_A, def_H)
//            + tempo·ripple(u,v,t)
// A wave is a swell that BUILDS from the attacking final third and CRESTS at the
// opponent goal mouth; defence at that goal suppresses amplitude AND chops the
// crest (a high-frequency jagged "breaking on the breakwater" term).
// ============================================================================

// home attacks u→1 (away goal at u≈0.95); away attacks u→0 (home goal at u≈0.05).
const GOAL_U_HOME = 0.95, GOAL_U_AWAY = 0.05;

// Longitudinal swell profile: ~0 in midfield, builds from the attacking final
// third, crests at the goal mouth. `gu` = goal u (0.95 or 0.05), `dir` = +1 for
// home (build as u rises), -1 for away.
function swellProfileU(u, gu, dir) {
  // start of the swell = final third edge; spread controlled by waveSpread.
  const startU = dir > 0 ? (1 - tune.waveSpread - 0.34) : (tune.waveSpread + 0.34);
  // normalised distance into the swell toward the goal (0 at start → 1 at goal)
  const span = (gu - startU);
  const f = clamp((u - startU) / (Math.abs(span) < 1e-3 ? 1e-3 : span), 0, 1);
  // smooth build then a sharp crest right at the mouth
  const build = f * f * (3 - 2 * f);
  const crest = Math.exp(-Math.pow((u - gu) / 0.06, 2)); // tight peak at the mouth
  return clamp(0.55 * build + 0.85 * crest, 0, 1.6);
}

// one team's wave height at (u,v,t). threat & defOpp are scalar series values.
function teamWave(u, v, t, gu, dir, threat, defOpp, crestV) {
  if (threat <= 1e-4) return 0;
  const prof = swellProfileU(u, gu, dir);
  if (prof <= 1e-4) return 0;
  // across-width: broad-ish, stronger near the goal-mouth centre, biased toward
  // where the recent threat actually came from (crestV).
  const vc = clamp(crestV, 0.15, 0.85);
  const dv = (v - vc) / Math.max(0.08, tune.waveWidth);
  const across = 0.45 + 0.55 * Math.exp(-0.5 * dv * dv);
  // amplitude: threat suppressed by the OPPOSING defence (breakwater holds it down)
  const supp = clamp(1 - tune.kDef * defOpp, 0.15, 1);
  let amp = threat * tune.threatHeight * supp * prof * across;
  // CHOP: where defence is high, break the crest into high-frequency jagged teeth
  // (only near the crest, where the wave meets the breakwater).
  if (defOpp > 0.02) {
    const nearGoal = Math.exp(-Math.pow((u - gu) / 0.10, 2));
    const teeth = Math.sin(v * 70.0 + t * 3.0) * Math.sin(u * 120.0 - t * 2.0);
    amp += amp * tune.chop * 0.6 * defOpp * nearGoal * teeth;
  }
  return amp;
}

function computeHeight(t) {
  const S = pm;
  const threatH = at(S.threatH, t, PM_STEP);
  const threatA = at(S.threatA, t, PM_STEP);
  const defH = at(S.def_H, t, PM_STEP);
  const defA = at(S.def_A, t, PM_STEP);
  const tempo = at(S.tempo, t, PM_STEP);
  const cvH = at(S.crestVH, t, PM_STEP);
  const cvA = at(S.crestVA, t, PM_STEP);

  // EASE the DISPLAYED wave heights: FAST up, SLOW down. A single counter shot
  // jumps threat_A → the wave snaps up almost instantly and lingers, so it
  // FLASHES a sharp wave instead of being averaged away. Stepped per resim call.
  const dStep = (lastSimT >= 0 && t > lastSimT) ? (t - lastSimT) : PM_STEP;
  const kUp = 1 - Math.exp(-dStep * tune.waveRise);
  const kDn = 1 - Math.exp(-dStep * tune.waveDecay);
  waveDispH += (threatH - waveDispH) * (threatH > waveDispH ? kUp : kDn);
  waveDispA += (threatA - waveDispA) * (threatA > waveDispA ? kUp : kDn);

  const flowZ = t * 0.5 * tune.flowSpeed;
  const rippleAmp = tempo * tune.tempoRipple * tune.turbulence;

  let idx = 0;
  for (let j = 0; j < VY; j++) {
    const vN = j / (VY - 1);
    for (let i = 0; i < VX; i++, idx++) {
      const uN = i / (VX - 1);
      // HOME wave crashing the away goal (u→0.95); AWAY wave crashing home goal (u→0.05)
      let h = teamWave(uN, vN, t, GOAL_U_HOME, +1, waveDispH, defA, cvH)
            + teamWave(uN, vN, t, GOAL_U_AWAY, -1, waveDispA, defH, cvA);
      // TEMPO ripple — small surface chop across the whole cloth (midfield stays low)
      h += rippleAmp * fbm(uN * 6.0, vN * 4.0, flowZ, 3);
      // GOAL ERUPTIONS: a brief tall wave breakthrough at the scoring goal.
      h += goalBurstAt(uN, vN, t);
      heightData[idx] = h;                 // NO clamp: surface may dip below 0
    }
  }
  heightTex.needsUpdate = true;
  lastSimT = t;

  // BASELINE so the sheet straddles y=0: subtract the mean displaced height so
  // roughly half the surface sits below the markings plane (same as before).
  let sum = 0;
  for (let k = 0; k < NV; k++) sum += heightData[k];
  heightBaseline = (sum / NV) * tune.heightScale;
  if (material) material.userData.u.uBaseline.value = heightBaseline;
}

// GOAL ERUPTION: a short, tall transient wave breakthrough at the goal that was
// just scored (real isGoal shots only). Decays over a few match-minutes. This is
// the ONE allowed transient bump — not a cumulative accumulation.
const GOAL_BURST_LIFE = 4.0;   // match-minutes
function goalBurstAt(uN, vN, t) {
  if (!model || !model.eruptions) return 0;
  let sum = 0;
  for (let i = 0; i < model.eruptions.length; i++) {
    const e = model.eruptions[i];
    if (!e.isGoal) continue;
    if (e.t > t) break;                          // time-sorted
    const age = t - e.t;
    if (age > GOAL_BURST_LIFE) continue;
    const rise = smoothstep(0, 0.5, age);
    const fall = 1 - smoothstep(GOAL_BURST_LIFE * 0.35, GOAL_BURST_LIFE, age);
    const gu = e.team === 'home' ? GOAL_U_HOME : GOAL_U_AWAY;
    const du = (uN - gu) / 0.07, dv = (vN - e.y) / 0.12;
    sum += 1.7 * tune.threatHeight * rise * fall * Math.exp(-0.5 * (du * du + dv * dv));
  }
  return sum;
}

// World X/Z from normalised pitch (u,v) — same mapping the plane uses.
const worldX = (u) => (u - 0.5) * WORLD_X;
const worldZ = (v) => (0.5 - v) * WORLD_Z;
// World Y of the floating cloth at (u,v): bilinear over the height field, in the
// SAME units the vertex shader applies (×heightScale, minus the straddle baseline).
function clothY(u, v) {
  if (!heightData) return 0;
  const fx = clamp(u, 0, 1) * (VX - 1), fy = clamp(v, 0, 1) * (VY - 1);
  const i0 = Math.floor(fx), j0 = Math.floor(fy);
  const i1 = Math.min(i0 + 1, VX - 1), j1 = Math.min(j0 + 1, VY - 1);
  const tx = fx - i0, ty = fy - j0;
  const h00 = heightData[j0 * VX + i0], h10 = heightData[j0 * VX + i1];
  const h01 = heightData[j1 * VX + i0], h11 = heightData[j1 * VX + i1];
  const h = lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), ty);
  return h * tune.heightScale - heightBaseline;
}

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
let ended = false;        // reached full time (drives the calm-down settle)
let calm = 0;             // 0 normal .. 1 fully settled (waves died down)
const CALM_TIME = 4.0;    // real seconds for the post-match settle
function loop(now) {
  const dt = Math.min(0.1, Math.max(0, (now - lastNow) / 1000));
  lastNow = now;

  if (model && playing) {
    clock += dt * tune.speed;
    if (clock >= model.duration) { clock = model.duration; playing = false; ended = true; el('play').textContent = '▶ play'; }
  }

  // FULL-TIME SETTLE: after the final whistle don't freeze the chaotic peak —
  // let the waves die down (relief eases flat, the ember fades) over CALM_TIME
  // real seconds; goal rings/dots stay. Reset if the user scrubs back.
  if (model && clock < model.duration - 0.01) { ended = false; calm = 0; }
  if (ended && calm < 1) calm = Math.min(1, calm + dt / CALM_TIME);

  simAccum += dt;
  // keep simulating while settling so the surface visibly calms, not just when playing
  if (model && (simAccum >= 1 / 30 || lastSimT < 0)) { simAccum = 0; computeHeight(clock); }

  if (material && model) {
    updateFrameUniforms(dt);
    applyLookUniforms();
    if (calm > 0) {                                  // ease the surface to a calm, flat, quiet end
      const u = material.userData.u;
      const k = calm * calm * (3 - 2 * calm);        // smoothstep
      u.uHScale.value *= (1 - 0.92 * k);
      u.uGlow.value *= (1 - 0.95 * k);
    }
  }

  updateGoalRings(false);
  updateShotDots(false);
  updateClothShots(false);

  controls.update();
  composer.render();
  updateHud();
  updateCamReadout();
  requestAnimationFrame(loop);
}

// COLOUR seam position from territory tilt. tilt_H 0.5 → seam at centre (0.5);
// higher tilt_H (home owns territory) → seam pushed toward the AWAY goal (u→1),
// so blue (home) covers more of the field. tiltSeam scales the displacement.
function frontFromTilt(t) {
  const tilt = clamp(at(pm.tilt, t, PM_STEP), 0, 1);
  return clamp(0.5 + (tilt - 0.5) * tune.tiltSeam, 0.06, 0.94);
}
// per-frame data-driven uniform updates (seam ← tilt, brightness ← possession,
// ember ← tempo). All sampled from the decaying-window pressure model.
function updateFrameUniforms(dt) {
  const u = material.userData.u;
  u.uHScale.value = tune.heightScale;
  u.uTime.value = clock * 0.5 * tune.flowSpeed;
  u.uFront.value = frontFromTilt(clock);
  // brightness gate: uPoss is the AWAY share (shader mixes 1-uPoss/uPoss by side),
  // eased so the live "who has the ball" gate glides.
  const possHome = clamp(at(pm.poss, clock, PM_STEP), 0, 1);
  const targetAway = 1 - possHome;
  uPossCur += (targetAway - uPossCur) * Math.min(1, dt * 3.0);
  u.uPoss.value = uPossCur;
  // ember intensity follows TEMPO (decaying event-rate), not a cumulative.
  u.uIntensity.value = clamp(at(pm.tempo, clock, PM_STEP), 0, 1);
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
  // snap the displayed wave heights to the instantaneous threat so a scrub shows
  // the right wave immediately (no rise/decay lag on a manual jump).
  waveDispH = at(pm.threatH, clock, PM_STEP);
  waveDispA = at(pm.threatA, clock, PM_STEP);
  computeHeight(clock);
  if (material) {
    const u = material.userData.u;
    u.uHScale.value = tune.heightScale;
    u.uTime.value = clock * 0.5 * tune.flowSpeed;
    u.uFront.value = frontFromTilt(clock);
    const possHome = clamp(at(pm.poss, clock, PM_STEP), 0, 1);
    uPossCur = 1 - possHome;
    u.uPoss.value = uPossCur;
    u.uIntensity.value = clamp(at(pm.tempo, clock, PM_STEP), 0, 1);
    applyLookUniforms();
  }
  updateGoalRings(true);   // scrub → show each past goal's ring in its settled small state
  updateShotDots(true);    // scrub → show all shots up to this minute
  updateClothShots(true);
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
  // MICRO-SURFACE (thickness is now a no-op: the cloth is a single thin sheet)
  u.uDetail.value = tune.detail;
  u.uDetailScale.value = tune.detailScale;
  u.uPattern.value = tune.pattern;
  // pitch-markings plane line intensity
  if (pitchMat) pitchMat.uniforms.uLines.value = tune.lines;

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
  bindSlider('wobble', 'wobbleV', (v) => { tune.wobble = v; return v.toFixed(2); });

  // ---- MODEL panel (right) — half-lives & weights recompute the series; ------
  // visual scales just resim the current frame. lastSimT=-1 forces a resim.
  // half-lives & weights → recomputeModel()
  bindSlider('tauThreat', 'tauThreatV', (v) => { tune.tauThreat = v; recomputeModel(); return v.toFixed(1); });
  bindSlider('tauTilt', 'tauTiltV', (v) => { tune.tauTilt = v; recomputeModel(); return v.toFixed(1); });
  bindSlider('tauPoss', 'tauPossV', (v) => { tune.tauPoss = v; recomputeModel(); return v.toFixed(1); });
  bindSlider('tauDef', 'tauDefV', (v) => { tune.tauDef = v; recomputeModel(); return v.toFixed(1); });
  bindSlider('tauTempo', 'tauTempoV', (v) => { tune.tauTempo = v; recomputeModel(); return v.toFixed(1); });
  bindSlider('wOnTarget', 'wOnTargetV', (v) => { tune.wOnTarget = v; recomputeModel(); return v.toFixed(2); });
  bindSlider('wBigChance', 'wBigChanceV', (v) => { tune.wBigChance = v; recomputeModel(); return v.toFixed(2); });
  bindSlider('wBoxEntry', 'wBoxEntryV', (v) => { tune.wBoxEntry = v; recomputeModel(); return v.toFixed(2); });
  bindSlider('wFastBreak', 'wFastBreakV', (v) => { tune.wFastBreak = v; recomputeModel(); return v.toFixed(2); });
  // visual scales → just resim the current frame
  bindSlider('kDef', 'kDefV', (v) => { tune.kDef = v; lastSimT = -1; return v.toFixed(2); });
  bindSlider('threatHeight', 'threatHeightV', (v) => { tune.threatHeight = v; lastSimT = -1; return v.toFixed(2); });
  bindSlider('waveSpread', 'waveSpreadV', (v) => { tune.waveSpread = v; lastSimT = -1; return v.toFixed(2); });
  bindSlider('waveWidth', 'waveWidthV', (v) => { tune.waveWidth = v; lastSimT = -1; return v.toFixed(2); });
  bindSlider('tiltSeam', 'tiltSeamV', (v) => { tune.tiltSeam = v; return v.toFixed(2); });
  bindSlider('tempoRipple', 'tempoRippleV', (v) => { tune.tempoRipple = v; lastSimT = -1; return v.toFixed(2); });
  bindSlider('chop', 'chopV', (v) => { tune.chop = v; lastSimT = -1; return v.toFixed(2); });
  bindSlider('waveRise', 'waveRiseV', (v) => { tune.waveRise = v; return v.toFixed(1); });
  bindSlider('waveDecay', 'waveDecayV', (v) => { tune.waveDecay = v; return v.toFixed(1); });
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
  bindSlider('lines', 'linesV', (v) => { tune.lines = v; if (pitchMat) pitchMat.uniforms.uLines.value = v; return v.toFixed(2); });
  // goal-entry rings
  bindSlider('ringSize', 'ringSizeV', (v) => { tune.ringSize = v; return v.toFixed(2); });
  bindSlider('ringStr', 'ringStrV', (v) => { tune.ringStr = v; return v.toFixed(2); });
  // shots · goals (dot size + Z height for shots and goals)
  bindSlider('shotSize', 'shotSizeV', (v) => { tune.shotSize = v; return v.toFixed(2); });
  bindSlider('bumpSize', 'bumpSizeV', (v) => { tune.bumpSize = v; return v.toFixed(2); });
  bindSlider('shotZ', 'shotZV', (v) => { tune.shotZ = v; return v.toFixed(2); });
  bindSlider('goalZ', 'goalZV', (v) => { tune.goalZ = v; return v.toFixed(2); });
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

  // COPY MODEL → clipboard (just the right-panel model numbers)
  const copyModelBtn = el('copymodel');
  if (copyModelBtn) {
    const dump = el('copymodelDump');
    let flashT = 0;
    copyModelBtn.addEventListener('click', async () => {
      const json = JSON.stringify(modelBlob(), null, 2);
      const flash = () => { copyModelBtn.textContent = 'copied ✓'; clearTimeout(flashT); flashT = setTimeout(() => { copyModelBtn.textContent = 'COPY MODEL'; }, 1400); };
      try { await navigator.clipboard.writeText(json); if (dump) dump.style.display = 'none'; flash(); }
      catch { if (dump) { dump.value = json; dump.style.display = 'block'; dump.focus(); dump.select(); } copyModelBtn.textContent = 'copy below ↓'; clearTimeout(flashT); flashT = setTimeout(() => { copyModelBtn.textContent = 'COPY MODEL'; }, 1800); }
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
      shotSize: r2(tune.shotSize), shotZ: r2(tune.shotZ), goalZ: r2(tune.goalZ), bumpSize: r2(tune.bumpSize),
      bloomStr: r2(tune.bloomStr), bloomRad: r2(tune.bloomRad), bloomThr: r2(tune.bloomThr),
      vig: r2(tune.vig), expo: r2(tune.expo), contr: r2(tune.contr), gsat: r2(tune.gsat),
    },
    model: modelBlob(),
    camera: {
      pos: [r2(camera.position.x), r2(camera.position.y), r2(camera.position.z)],
      target: [r2(controls.target.x), r2(controls.target.y), r2(controls.target.z)],
    },
  };
}

// Just the MODEL panel numbers (right panel) — shared by COPY MODEL + COPY SETTINGS.
function modelBlob() {
  const r2 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
  return {
    tauThreat: r2(tune.tauThreat), tauTilt: r2(tune.tauTilt), tauPoss: r2(tune.tauPoss),
    tauDef: r2(tune.tauDef), tauTempo: r2(tune.tauTempo),
    wOnTarget: r2(tune.wOnTarget), wBigChance: r2(tune.wBigChance), wBoxEntry: r2(tune.wBoxEntry),
    wFastBreak: r2(tune.wFastBreak), kDef: r2(tune.kDef),
    threatHeight: r2(tune.threatHeight), waveSpread: r2(tune.waveSpread), waveWidth: r2(tune.waveWidth),
    tiltSeam: r2(tune.tiltSeam), tempoRipple: r2(tune.tempoRipple), chop: r2(tune.chop),
    waveRise: r2(tune.waveRise), waveDecay: r2(tune.waveDecay),
  };
}

function bindSlider(id, valId, fn) {
  const s = el(id), v = el(valId);
  const apply = () => { v.textContent = fn(+s.value); };
  s.addEventListener('input', apply);
  apply();
}

// Per-section "copy" button: copies just that block's controls (every input/select
// between this .sec header and the next) as JSON, so each block can be shared/baked
// on its own. Walks the DOM so it always matches what's shown in the section.
function setupSectionCopy() {
  setupSectionCopyFor(el('panel'));
  setupSectionCopyFor(el('modelpanel'));   // right MODEL panel gets per-section copy too
}
function setupSectionCopyFor(panel) {
  if (!panel) return;
  for (const sec of panel.querySelectorAll('.sec')) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'seccopy'; btn.textContent = 'copy';
    sec.appendChild(btn);
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const out = {};
      let n = sec.nextElementSibling;
      while (n && !n.classList.contains('sec')) {
        for (const inp of n.querySelectorAll('input, select')) {
          if (!inp.id) continue;
          out[inp.id] = (inp.type === 'range') ? +inp.value : inp.value;
        }
        n = n.nextElementSibling;
      }
      try {
        await navigator.clipboard.writeText(JSON.stringify(out));
        btn.textContent = '✓'; setTimeout(() => { btn.textContent = 'copy'; }, 1000);
      } catch { btn.textContent = JSON.stringify(out).slice(0, 0) || 'err'; setTimeout(() => { btn.textContent = 'copy'; }, 1200); }
    });
  }
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
