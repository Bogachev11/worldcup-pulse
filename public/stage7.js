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
  thickness: 0,     // NO-OP: the cloth is now a single thin sheet floating in air (no skirt/slab)
  pattern: 4,       // surface pattern: 0 grid · 1 weave · 2 lines · 3 dots · 4 hex · 5 grain
  detail: 1.1,      // pattern depth/strength
  detailScale: 2.58,// pattern density (frequency)
  lines: 0.6,       // football PITCH MARKINGS strength on the top surface (0 = off)
  // GOAL-ENTRY RINGS (contracting, scoring-team colour, flat on the cloth)
  ringSize: 1.0,    // settled-ring size multiplier
  ringStr: 1.6,     // ring emissive brightness multiplier
  // SHOT DOTS + Z (height) controls for shots and goals
  shotSize: 1.0,    // shot-dot radius multiplier
  shotZ: 1.0,       // multiplier on shot dots' onGoalY→worldY mapping
  goalZ: 1.0,       // multiplier on the goal rings' onGoalY→worldY mapping
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
  setupSectionCopy();
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
      heightData[idx] = h;                 // NO clamp: surface may dip below 0
    }
  }
  heightTex.needsUpdate = true;
  lastSimT = t;

  // BASELINE so the sheet straddles y=0: subtract the mean displaced height so
  // roughly half the surface sits below the markings plane. Computed in the same
  // scaled units the vertex shader applies (× uHScale).
  let sum = 0;
  for (let k = 0; k < NV; k++) sum += heightData[k];
  heightBaseline = (sum / NV) * tune.heightScale;
  if (material) material.userData.u.uBaseline.value = heightBaseline;
}

// World X/Z from normalised pitch (u,v) — same mapping the plane uses.
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

  // glide the seam's dynamic part toward its target (softens the back-and-forth)
  if (model) {
    const target = seamDynTarget(clock);
    seamDyn += (target - seamDyn) * (1 - Math.exp(-dt * SEAM_EASE));
  }

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
  updateShotDots(true);    // scrub → show all shots up to this minute
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
  bindSlider('lines', 'linesV', (v) => { tune.lines = v; if (pitchMat) pitchMat.uniforms.uLines.value = v; return v.toFixed(2); });
  // goal-entry rings
  bindSlider('ringSize', 'ringSizeV', (v) => { tune.ringSize = v; return v.toFixed(2); });
  bindSlider('ringStr', 'ringStrV', (v) => { tune.ringStr = v; return v.toFixed(2); });
  // shots · goals (dot size + Z height for shots and goals)
  bindSlider('shotSize', 'shotSizeV', (v) => { tune.shotSize = v; return v.toFixed(2); });
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
      shotSize: r2(tune.shotSize), shotZ: r2(tune.shotZ), goalZ: r2(tune.goalZ),
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

// Per-section "copy" button: copies just that block's controls (every input/select
// between this .sec header and the next) as JSON, so each block can be shared/baked
// on its own. Walks the DOM so it always matches what's shown in the section.
function setupSectionCopy() {
  const panel = el('panel');
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
