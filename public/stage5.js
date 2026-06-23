// stage5.js — "PASS LANDSCAPE +SHOTS" — stage4's wave terrain (GPU heightfield
// H1 macro + H2 possession flood + H3 duels, solid block + skirt + terraces +
// orbit camera + half-time fade) PLUS a NEW 3D SHOT-ARC layer (H4 SHOTS).
//
// For every REAL shot a parabolic arc is drawn from the LAUNCH point on the
// terrain to the true GOAL crossing point (goalY across + goalZ height). The arc
// is rendered PIXELATED: sampled into N quantised positions and drawn as CHUNKY
// voxel CUBES (THREE.InstancedMesh) → a stair-stepped, blocky, thick trail. Goals
// are fatter + brighter; misses thinner/dimmer; off-target slightly desaturated.
// Timed to the match clock: an impact DROP-RIPPLE on the terrain at the launch,
// then the voxel trail draws on launch→goal, then it persists and slowly fades.
// Plain THREE meshes (InstancedMesh boxes + ring) — the terrain ShaderMaterial is
// UNTOUCHED, so the shot layer can never break the GLSL.
//
// (original stage4 header follows)
// stage4.js — "PASS LANDSCAPE" — a living Variable.io-style wave terrain whose
// relief shows WHERE THE PLAY IS, by PASSES. A REAL macro dominance swell (a
// heavily-blurred, slow-decaying accumulation of every pass/event, tilted by the
// cumulative dominance and rolled by the live momentum series) PLUS
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
// Fine extruded-cell landscape (Variable look). Default 120×72; up to 640×384
// (coords are precise to 0.1 on a 0–100 frame, so fine detail is meaningful).
let GX = 190, GY = 114;         // default zone-relief resolution (user-tuned)
const GX_MIN = 24, GY_MIN = 14;
const GX_MAX = 640, GY_MAX = 384;   // ~16:9.6 ratio, much finer ceiling
const MESH_SEG_CAP = 512;       // cap plane segments per axis for perf

// ---- scene state ------------------------------------------------------------
let renderer, scene, camera, controls;
let mesh, skirt, material, slab;
let heightTex, heightData;      // R32F, GX×GY normalized cell height
let colTex, colData;            // R32F, GX×GY away-share (0=home .. 1=away), -1=empty
let duelTex, duelData;          // RG32F, GX×GY: R=spike height, G=winner share
let macroTex, macroData;        // R32F, GX×GY signed blurred dominance swell (−1..1)
let model = null, passes = [];
let duels = [], turnovers = [];
let shots = [];                 // H4 SHOTS: normalized raw shots (with goalY/goalZ)
let grid, hMaxTrack, dMaxTrack;
let clock = 0, prevClock = 0, playing = true;
let passCursor = 0;             // next pass to deposit (passes sorted by t)
let duelCursor = 0;            // next duel to spawn
let turnCursor = 0;           // next turnover to credit
let domHome = 0.5;              // smoothed "who dominates recent passes" for HUD

// ---- BALL RECONSTRUCTION (drives the possession FLOOD/TIDE) ------------------
// We reconstruct an approximate ball position on the SHARED pitch over time:
//  • between events the ball ≈ the latest pass, interpolated start→end across
//    that pass's short flight (PASS_FLIGHT match-minutes);
//  • a turnover (Interception/BallRecovery/Tackle/Dispossessed) hands the ball
//    to the winning team (we re-anchor the ball at the turnover location).
// ballTeam = who currently has it; ballX/ballY = its shared-pitch position;
// ballX0/ballX1 + ball anchor times let us interpolate between deposits.
let ballTeam = 'home';         // current possessor (from the ball, not smoothed)
let ballX = 0.5, ballY = 0.5;  // current shared-pitch ball position
let segT0 = 0, segT1 = 0;      // current pass segment time window
let segX0 = 0.5, segY0 = 0.5;  // segment start (shared pitch)
let segX1 = 0.5, segY1 = 0.5;  // segment end (shared pitch)
const PASS_FLIGHT = 0.03;      // match-minutes a pass takes to travel (~1.8 s)
// Furthest penetration the possessing team's ball has reached toward the
// opponent goal, measured as "attacking depth" 0..1 (own side .. opp goal).
// Recedes slowly when they stop; resets on turnover (new team floods from 0).
let headDepth = 0;             // current possessing team's furthest reach (0..1)

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

// tuning (bound to sliders). The panel is organised into THREE activity LAYERS,
// each with its OWN amplitude / speed / smoothness / detail controls, plus a
// GLOBAL group. NOT 8 harmonics of one wave — three independent layers:
//   H1 MACRO      — global dominance: REAL blurred territorial swell (no sine)
//   H2 POSSESSION — ball movement / passes: the contiguous flood-tide
//   H3 DUELS      — единоборства: the sharp contact spikes
const tune = {
  // ---- GLOBAL ----
  speed: 2.8,         // match (playback) speed (default 2.8×)
  steps: 32,          // terrace levels (height quantisation) — the Variable look
  dim: 0.08,          // how hard the passive (non-possessing) team fades
  htFade: 2.5,        // half-time transition length in MATCH-minutes (~2–3)
  fade: 0.85,         // base zone sink rate (per second decay rate)
  thickness: 2.5,     // SOLID BLOCK depth: side walls drop to y=-thickness (→ uThickness)

  // ---- H1 MACRO (REAL territorial-dominance relief — NO procedural waves) ----
  // The macro height is a heavily-BLURRED accumulation of every real pass/event
  // (long half-life), tilted by the cumulative dominance (domBias) and ROLLED by
  // the real per-minute momentum series. No sine sum, no fbm — 100% match data.
  macroAmp: 1.94,     // amplitude — height of the dominance relief (→ uWave)
  macroSpeed: 1.0,    // speed — how fast the field decays-and-rebuilds + momentum-roll rate
  macroSmooth: 0.84,  // smoothness — how heavily the dominance field is blurred (more = broader swells)
  macroScale: 1.55,   // scale — blur radius / spatial wavelength of the field (fold size)

  // ---- H2 POSSESSION (the flood / tide) ----
  height: 1.44,       // amplitude — flood relief height multiplier (→ uHScale)
  possSpeed: 0.35,    // speed — how fast the tide advances/flows (scales head-advance + flow)
  possSmooth: 0.14,   // smoothness — softness of the flood leading edge (front feather)
  possDetail: 0.88,   // detail — flood footprint fineness (corridor/cell splat size)
  floodHold: 0.35,    // hold — possessor-flood persistence (small = lingers)
  floodClear: 2.4,    // clear — non-possessor / stale-flood recede rate (big = vanishes fast)

  // ---- H3 DUELS (sharp contact spikes) ----
  duels: 1.0,         // amplitude — duel spike HEIGHT (→ uDuelAmt)
  duelSpeed: 1.0,     // speed — spike rise + fade speed (how fast a spark appears/decays)
  duelSmooth: 0.5,    // smoothness — spike edge softness (high = soft bump, low = sharp needle)
  duelDetail: 0.5,    // detail — spike footprint fineness (radius; finer = smaller, sharper)

  // ---- H4 SHOTS (3D stepped voxel arcs to goal) ----
  shotThick: 0.42,    // voxel cube SIZE (arc thickness, world units) — THICK chunky steps
  shotArc: 0.85,      // apex lift multiplier (parabola height over the chord)
  shotHeight: 0.5,    // STRIKE height — scales how high the ball ends at the goal (real goalZ reach), independent of the arc apex
  rippleSize: 1.0,    // impact drop-ripple radius multiplier
  shotFade: 0.5,      // how fast settled (non-goal) arcs dim (per real second)
  goalBoost: 1.8,     // extra cube size + brightness for GOAL arcs
};

// ---- H1 MACRO (real dominance field) tuning constants -----------------------
// MACRO_DEPOSIT — how much each real pass/event adds to its macro cell.
// MACRO_HALFLIFE_MIN — half-life (MATCH-minutes) of the macro accumulator: LONG
//   so the relief is the whole-match territorial story, not the instant.
// MACRO_RADIUS_PITCH — deposit footprint as a fraction of pitch width (broad).
// MACRO_BLUR_PASSES — box-blur repetitions (≈ gaussian) for broad swells.
// macroRoll is the SMOOTHED real momentum (−1 home pressing .. +1 away pressing),
// eased toward the live momentum sample so the swell rolls toward whoever presses.
const MACRO_DEPOSIT = 1.0;
const MACRO_HALFLIFE_MIN = 18;                 // long memory (whole-match story)
const MACRO_DECAY_PER_MIN = Math.LN2 / MACRO_HALFLIFE_MIN;
const MACRO_RADIUS_PITCH = 0.06;               // broad footprint per deposit
const MACRO_BLUR_PASSES = 3;                   // box passes → ~gaussian swells
let macroRoll = 0;                             // smoothed momentum (−1 home .. +1 away)

// ---- HALF-TIME BREAK envelope ----------------------------------------------
// htEnv ∈ [0,1]: 1 normally; dips toward ~0 around HALFTIME (45') over ~htFade
// match-minutes, then eases back up. Multiplies flood + duel amplitude and
// drives a colour desaturate at the dip. At the crossing of 45' we clear the
// flood fields and reset possession to a clean 50-50 so it rebuilds even.
let htEnv = 1.0;            // current half-time envelope
let htCleared = false;      // whether we've performed the 45' clear this pass
const HALFTIME_MIN = 45;    // match-minutes (kept local; passfield no longer swaps)

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
  // H4 SHOTS: normalize the RAW shots ourselves — buildModel/normShot drops the
  // height fields (goalY/goalZ) and onTarget/shotType, so we keep the raw stream.
  shots = normShots(raw.shots);
  // on-ball events: raw.events[] ({t,team,type,x,y,outcome,...}). buildDuels /
  // normTurnovers tolerate an empty list, so this never throws on sparse feeds.
  const evt = raw.events || [];
  duels = buildDuels(evt);
  turnovers = normTurnovers(evt);

  setupThree();
  buildHeightfield();
  setupShots();        // H4 SHOTS: build the voxel InstancedMesh pool + ripple ring
  resetSim();
  bindUI();
  applyTeamColors();

  el('title4').textContent =
    `PASS LANDSCAPE +SHOTS · ${model.home.abbr || 'HOME'} ${model.home.score}–${model.away.score} ${model.away.abbr || 'AWAY'}`;
  el('hAbbr').textContent = model.home.abbr || 'HOME';
  el('aAbbr').textContent = model.away.abbr || 'AWAY';

  window.addEventListener('resize', onResize);
  onResize();
  requestAnimationFrame(loop);
}

function fail(msg) {
  const t = el('title4'); if (t) t.textContent = 'PASS LANDSCAPE +SHOTS · failed: ' + msg;
  const o = document.createElement('div');
  o.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'color:#f88;font:14px system-ui;text-align:center;padding:40px;z-index:99;background:#04050a;white-space:pre-wrap';
  o.textContent = 'PASS LANDSCAPE +SHOTS could not start: ' + msg +
    '\n\n(If three.js failed to load from the CDN, check your connection — it is loaded via esm.sh.)';
  document.body.appendChild(o);
}

// Default camera — exact pos/target the user dialed in. Stored as pos+target
// (most robust) and applied directly; we also keep a spherical helper for orbit.
const DEFAULT_CAM = {
  pos: { x: -16.78, y: 18.18, z: 18.93 },
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
  if (skirt) { scene.remove(skirt); skirt.geometry.dispose(); }
  if (heightTex) heightTex.dispose();
  if (colTex) colTex.dispose();
  if (duelTex) duelTex.dispose();
  if (macroTex) macroTex.dispose();

  // Mesh segments ≥ grid resolution (≈2× grid dim) so flat cell tops + near-
  // vertical step walls are crisp, but capped for perf at fine grids.
  const segX = Math.min(MESH_SEG_CAP, Math.max(GX, Math.min(GX * 2, MESH_SEG_CAP)));
  const segY = Math.min(MESH_SEG_CAP, Math.max(GY, Math.min(GY * 2, MESH_SEG_CAP)));
  const geo = new THREE.PlaneGeometry(WORLD_X, WORLD_Z, segX, segY);
  geo.rotateX(-Math.PI / 2);                 // flat in XZ, +Y up
  // The plane is the TOP surface only → every plane vertex is a displaced-top
  // vertex (aBase=0). We still supply the attribute explicitly so the SHARED
  // ShaderMaterial (which declares `attribute float aBase;`) compiles & binds for
  // the plane too — never rely on a missing attribute defaulting to 0.
  {
    const nPlane = geo.attributes.position.count;
    const planeBase = new Float32Array(nPlane);   // all zeros = top/displaced
    geo.setAttribute('aBase', new THREE.BufferAttribute(planeBase, 1));
  }

  heightData = new Float32Array(GX * GY);
  colData = new Float32Array(GX * GY).fill(-1);
  // DUEL texture: RG → R = spike height (0..~1.4), G = winner share (0=home..1=away)
  duelData = new Float32Array(GX * GY * 2);
  // MACRO texture: R = signed, blurred dominance swell (−1..1) — the REAL H1 relief.
  macroData = new Float32Array(GX * GY);
  heightTex = new THREE.DataTexture(heightData, GX, GY, THREE.RedFormat, THREE.FloatType);
  colTex = new THREE.DataTexture(colData, GX, GY, THREE.RedFormat, THREE.FloatType);
  duelTex = new THREE.DataTexture(duelData, GX, GY, THREE.RGFormat, THREE.FloatType);
  // MACRO uses LINEAR filtering: the blurred field is meant to read as a smooth
  // broad swell (the macro relief), unlike the NEAREST stepped possession cells.
  macroTex = new THREE.DataTexture(macroData, GX, GY, THREE.RedFormat, THREE.FloatType);
  macroTex.magFilter = THREE.LinearFilter;
  macroTex.minFilter = THREE.LinearFilter;
  macroTex.wrapS = THREE.ClampToEdgeWrapping;
  macroTex.wrapT = THREE.ClampToEdgeWrapping;
  macroTex.needsUpdate = true;
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
        uMacro: { value: macroTex },     // H1 MACRO: REAL blurred dominance swell (−1..1)
        uTexel: { value: new THREE.Vector2(1 / GX, 1 / GY) },
        uHScale: { value: tune.height },
        uWave: { value: tune.macroAmp },      // H1 MACRO amplitude (relief height)
        uLevels: { value: tune.steps },
        uDuelAmt: { value: tune.duels },
        // H1 MACRO: momentum-roll offset (real momentum shifts the swell sideways
        // toward whoever is pressing NOW). −ve = roll toward home, +ve = toward away.
        uMacroRoll: { value: 0.0 },
        // H3 DUELS edge softness (smoothstep window).
        uDuelSmooth: { value: tune.duelSmooth },
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
        uHtEnv: { value: 1.0 },          // half-time envelope (1 normal .. 0 at break dip)
        uThickness: { value: tune.thickness }, // SOLID BLOCK depth: base sits at y=-uThickness
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
    material.uniforms.uMacro.value = macroTex;
    material.uniforms.uTexel.value.set(1 / GX, 1 / GY);
  }

  mesh = new THREE.Mesh(geo, material);
  scene.add(mesh);

  // SKIRT (side walls + bottom cap) sharing the SAME material so colour/lighting
  // match. Its top ring of verts carry the plane-edge uv (aBase=0) → displaced by
  // H(uv) IDENTICALLY to the plane edge (no gaps); its bottom ring is flagged
  // aBase=1 → pinned to y=-uThickness. Rebuilt with the plane on every resolution
  // change because the perimeter segment count tracks segX/segY.
  const skirtGeo = buildSkirtGeometry(segX, segY);
  skirt = new THREE.Mesh(skirtGeo, material);
  scene.add(skirt);

  if (!slab) {
    slab = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_X * 1.02, WORLD_Z * 1.02),
      // slate (matches the neutral base) + slight emissive so troughs that dip
      // below it read as a floor, NOT as black "floods" of empty background.
      new THREE.MeshStandardMaterial({ color: 0x222a3e, emissive: 0x141a28, roughness: 1, metalness: 0 })
    );
    slab.rotation.x = -Math.PI / 2;
    scene.add(slab);
  }
  // Park the slab just BELOW the solid block's base (y=-uThickness) so there is
  // still a floor under the bottom cap without z-fighting it. Kept in sync with
  // the thickness slider in syncMaterialUniforms().
  slab.position.y = -tune.thickness - 0.12;
}

// Build the SKIRT geometry: a ring of vertical quads around the 4 perimeter edges
// of the displaced plane, plus a bottom cap, as a single BufferGeometry. Shares
// the plane's vertex shader, so each TOP vertex carries the EXACT same uv as the
// plane edge at that point → it is displaced by H(uv) identically (walls follow
// the relief edge, no gaps). Each BOTTOM vertex sits at the same x,z but is
// flagged aBase=1 so the shader pins it to y=-uThickness (the flat base).
//
// UV↔position mapping mirrors PlaneGeometry+rotateX(-90°):
//   localX = (u-0.5)*WORLD_X ;  localZ = (0.5-v)*WORLD_Z ;  localY=0 (displaced in VS)
function buildSkirtGeometry(segX, segY) {
  const nx = segX + 1, ny = segY + 1;     // verts per axis along the plane edges
  const pos = [];      // xyz (localY=0 — shader displaces via aBase + H(uv))
  const uvs = [];      // uv (top verts use plane-edge uv; bottom reuse same uv)
  const base = [];     // aBase: 0 = top/displaced-edge, 1 = bottom/base
  const idx = [];

  const X = (u) => (u - 0.5) * WORLD_X;
  const Z = (v) => (0.5 - v) * WORLD_Z;

  // Add one vertical quad for a perimeter EDGE between two consecutive uv points
  // (u0,v0)→(u1,v1). Emits 4 verts: top0, top1, bot0, bot1, then two triangles.
  // `flip` chooses winding so the wall's front face points OUTWARD.
  const addWall = (u0, v0, u1, v1, flip) => {
    const o = pos.length / 3;
    const x0 = X(u0), z0 = Z(v0), x1 = X(u1), z1 = Z(v1);
    // top0, top1 (displaced), bot0, bot1 (base)
    pos.push(x0, 0, z0,  x1, 0, z1,  x0, 0, z0,  x1, 0, z1);
    uvs.push(u0, v0,  u1, v1,  u0, v0,  u1, v1);
    base.push(0, 0, 1, 1);                  // top, top, bottom, bottom
    const t0 = o, t1 = o + 1, b0 = o + 2, b1 = o + 3;
    if (!flip) {
      idx.push(t0, b0, t1,  t1, b0, b1);
    } else {
      idx.push(t0, t1, b0,  t1, b1, b0);
    }
  };

  // Perimeter, walking each of the 4 edges segment-by-segment. uv ranges: the
  // plane covers u∈[0,1] (X) and v∈[0,1] (Z). We use the SAME sample points the
  // plane uses on each edge so top verts coincide with plane edge verts exactly.
  // Edge A: v=0 (one Z extreme), u: 0→1
  for (let i = 0; i < segX; i++) addWall(i / segX, 0, (i + 1) / segX, 0, false);
  // Edge B: u=1, v: 0→1
  for (let i = 0; i < segY; i++) addWall(1, i / segY, 1, (i + 1) / segY, false);
  // Edge C: v=1 (other Z extreme), u: 1→0
  for (let i = 0; i < segX; i++) addWall((segX - i) / segX, 1, (segX - i - 1) / segX, 1, false);
  // Edge D: u=0, v: 1→0
  for (let i = 0; i < segY; i++) addWall(0, (segY - i) / segY, 0, (segY - i - 1) / segY, false);

  // BOTTOM CAP — a single quad across the base rectangle at y=-uThickness so the
  // solid is closed when seen from below. All 4 verts are aBase=1 (pinned base).
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
  g.setIndex(idx);
  g.computeVertexNormals();   // overwritten by the shader's relief normal anyway
  return g;
}

// ---- shaders ----------------------------------------------------------------
// Vertex: H = REAL macro dominance relief (uMacro, blurred accumulation + momentum
// roll) + pass relief (height texture) + duel spikes. No procedural waves/noise.
// Normal via finite differences of the SAME H so lighting reads the relief.
const VERT = /* glsl */`
  uniform sampler2D uHeight;
  uniform sampler2D uDuel;
  uniform sampler2D uMacro;  // H1 MACRO: REAL blurred dominance swell, signed −1..1
  uniform vec2 uTexel;
  uniform float uHScale;
  uniform float uWave;      // H1 MACRO amplitude (height of the dominance relief)
  uniform float uLevels;    // terrace count (height quantisation)
  uniform float uDuelAmt;   // duel spike amount (Layer 3)
  uniform float uDomBias;   // Layer 1 dominance lean (-1 home .. +1 away)
  uniform float uMacroRoll; // H1 MACRO real-momentum roll offset (−home .. +away)
  uniform float uHtEnv;     // half-time envelope (1 normal .. 0 at break dip)
  uniform float uThickness; // SOLID BLOCK depth: base verts (aBase=1) pin to y=-uThickness
  uniform vec2 uWorld;
  uniform float uTime;
  attribute float aBase;    // 1.0 = bottom/base vertex (skirt), 0.0 = top/displaced
  varying float vH;         // pass-relief only (for colour intensity)
  varying float vDuel;      // duel spike intensity (for colour)
  varying float vDuelShare; // duel winner share (0 home..1 away), per-vertex
  varying vec2 vUvN;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;
  varying float vBaseMix;   // 0 at the displaced top .. 1 at the base (side-wall shading)

  // LAYER 1 (H1 MACRO) — REAL TERRITORIAL DOMINANCE relief. NO sine sum, NO noise.
  //   height = uWave · macroField  + dominance lean (uDomBias)
  // macroField is a heavily-BLURRED accumulation of every real pass/event over the
  // whole match (long half-life), uploaded in uMacro as a SIGNED net swell
  // (−1 home-leaning .. +1 away-leaning). The real per-minute MOMENTUM rolls the
  // swell sideways via uMacroRoll: we sample uMacro at an x offset proportional to
  // momentum so as the game's pressure swings the broad swells visibly SHIFT
  // toward whoever is pressing now — the real ebb and flow, not a procedural wave.
  // The swell is terraced into the same discrete steps as the rest of the terrain.
  float waveBase(vec2 uv){
    // momentum roll: shift the sample point along the pitch length (x). Positive
    // uMacroRoll (away pressing) rolls the swell toward the away side and back.
    float ux = clamp(uv.x - uMacroRoll, 0.0, 1.0);
    float field = texture2D(uMacro, vec2(ux, uv.y)).r;       // signed −1..1, REAL data
    if (!(field == field)) field = 0.0;                       // NaN guard
    field = clamp(field, -1.5, 1.5);
    float wave = field * uWave;                               // height of the relief
    // TERRACE the macro into the same discrete levels as the possession/duel relief
    // so it reads as STEPS, not one smooth fold. Quantise in amplitude units.
    float L = max(uLevels, 1.0);
    float qScale = max(uWave, 1e-3);
    wave = floor((wave / qScale) * L + 0.5) / L * qScale;
    // dominance lean: low-frequency standing tilt across X toward the dominant side
    // (the cumulative possession/territory differential). Real signal (uDomBias).
    float lean = uDomBias * (uv.x - 0.5) * 1.1;
    return wave + lean;
  }
  // LAYER 2 — POSSESSION FLOOD relief sampled with NEAREST (flat cell tops),
  // QUANTISED into discrete terraces → the staged extruded-blocks aesthetic.
  // Scaled ONLY by the possession-height slider (uHScale).
  float relief(vec2 uv){
    float r = texture2D(uHeight, uv).r;            // 0..~1.4, flat per cell
    float L = max(uLevels, 1.0);
    r = floor(r * L + 0.5) / L;                    // terrace into L steps
    return r * uHScale * uHtEnv;                    // sink at the half-time break
  }
  // LAYER 3 — duel spike height (sharp, NOT terraced, capped so no vertical
  // facet). Scaled ONLY by the duel-height slider (uDuelAmt) — independent of
  // the possession-height slider so each layer scales on its own.
  float duelH(vec2 uv){
    float d = texture2D(uDuel, uv).r;              // already capped on CPU side
    return min(d, 1.4) * 0.9 * uDuelAmt * uHtEnv;  // sink at the half-time break
  }
  float H(vec2 uv){ return waveBase(uv) + relief(uv) + duelH(uv); }

  void main(){
    vec2 fuv = uv;
    vUvN = fuv;
    float h = H(fuv);
    if (!(h == h)) h = 0.0;          // NaN guard → no degenerate (see-through) triangles
    h = clamp(h, -0.3, 7.0);         // keep terrain above the slab (no dark show-through) + spike clamp
    vH = relief(fuv);
    vDuel = duelH(fuv);
    vDuelShare = texture2D(uDuel, fuv).g;   // carry winner share across the whole spike body

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

    // SOLID BLOCK: base verts (skirt bottoms + bottom cap) pin to the flat base
    // at y=-uThickness; top verts (plane + skirt top ring) follow the relief H().
    // The skirt's top ring shares the plane-edge uv so its H(uv) matches the plane
    // edge EXACTLY (walls follow the relief edge, no gaps).
    float worldY = (aBase > 0.5) ? (-uThickness) : h;
    vBaseMix = aBase;   // 0 top .. 1 base → drives the darker side-wall body colour

    vec3 pos = position;
    pos.y += worldY;
    vec4 wp = modelMatrix * vec4(pos, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

// Fragment: colour = the FLOOD owner (the team whose tide has reached this cell).
// uCol holds the flood away-share in [0,1]; -1 marks dry (no flood) → neutral
// tide base. Colour is ALWAYS full brightness on owned cells (decoupled from
// relief height); only lighting + the possession gate shape it.
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
  uniform float uDuelSmooth; // H3 DUELS smoothness: spark edge softness (0 sharp .. 1 soft)
  uniform float uHtEnv;    // half-time envelope (1 normal .. 0 at break dip)
  varying float vH;
  varying float vDuel;
  varying float vDuelShare;
  varying vec2 vUvN;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;
  varying float vBaseMix;  // 0 at the displaced top .. 1 at the base (side-wall body)

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
    // ALWAYS BRIGHT: an owned/flooded cell shows its FULL team colour regardless
    // of how tall the relief is. Colour saturation is DECOUPLED from height —
    // it depends only on occupancy + the possession gate, NOT on relief/lift.
    // 3D form still comes from the normal/lighting below; height no longer dims
    // the colour. Passive (non-possessing) flood is dimmed via possGate.
    float teamMix = occupied * possGate;
    col = mix(baseNeutral, team, clamp(teamMix, 0.0, 1.0));

    // (No procedural marble/noise — surface variation comes only from the REAL
    // relief + lighting below. Plain shading keeps H1 100% data-driven.)

    // lighting: two directional + raised ambient floor (so nothing goes black)
    float d1 = max(dot(N, normalize(uLightDir)), 0.0);
    float d2 = max(dot(N, normalize(uLightDir2)), 0.0) * 0.5;
    col *= (0.60 + d1*0.85 + d2);

    // peaks read brighter, valleys sink (relief AO-ish)
    col *= 0.86 + clamp(relief*0.6, 0.0, 0.5);

    // gentle emissive on hot possessing zones
    col += team * occupied * possGate * smoothstep(0.35, 1.0, relief) * 0.35;

    // ---- LAYER 3: DUEL sparks (winner-tinted, bright, ON TOP) ---------------
    // Drive the spark from the INTERPOLATED varyings (vDuel/vDuelShare) instead of
    // re-sampling the duel texture per fragment: a sharp spike's side faces sample
    // neighbouring zero-duel texels and would otherwise stay dark slate (the old
    // near-black France needles). The varyings glow across the whole spike body.
    float dInt = max(vDuel, 0.0);
    if (!(dInt == dInt)) dInt = 0.0;              // NaN guard
    float dShareC = clamp(vDuelShare, 0.0, 1.0);
    if (!(dShareC == dShareC)) dShareC = 0.0;     // NaN guard
    // winner tint, LIFTED in luminance so low-luminance (blue) spikes still ring
    // out and survive tone-mapping — no dark-navy needles.
    vec3 duelTeam = mix(uHome, uAway, step(0.5, dShareC)) * 1.9;
    // crisp spark: sharp response to intensity, ACCENT brighter than the base.
    // H3 smoothness widens the smoothstep window: low = sharp needle, high = soft bump.
    float sm = clamp(uDuelSmooth, 0.0, 1.0);
    float sEdge = mix(0.30, 0.04, sm);            // low smooth → narrow window (sharp)
    float spark = smoothstep(0.02, 0.02 + sEdge, dInt);
    col += duelTeam * spark * 1.15;               // additive accent so they pop
    col += vec3(1.0) * spark * 0.18;              // tiny white-hot core

    // cinematic fresnel rim
    vec3 V = normalize(cameraPosition - vWorldPos);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    col += fres * 0.07 * mix(baseNeutral, team, occupied * possGate);

    // HALF-TIME WASH-OUT: as uHtEnv dips toward 0 around 45', desaturate the
    // colour toward grey luminance so the pitch visibly "breathes" (sink → blank
    // → rebuild even). At uHtEnv=1 (normal play) this is a no-op.
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(lum), col, clamp(uHtEnv, 0.0, 1.0));

    // BRIGHTNESS FLOOR: never darker than the lit neutral base (kills black spots).
    // Empty / quiet cells therefore render as the neutral tide, never pure black.
    col = max(col, baseNeutral * 0.85);

    // ---- SOLID-BLOCK SIDE WALLS --------------------------------------------
    // The skirt verts ramp vBaseMix 0→1 as they go DOWN the wall (top edge → base).
    // Mix the surface colour toward a dark slate body so the walls read as the
    // block's MASS, not a coloured continuation of the top. Top surface (vBaseMix=0)
    // is untouched. Quadratic so the very top edge stays close to the top colour.
    float wall = clamp(vBaseMix, 0.0, 1.0);
    vec3 wallBody = vec3(0.045, 0.055, 0.085);   // dark neutral slate (block mass)
    col = mix(col, wallBody, wall * wall * 0.92);

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
// Push all live `tune` values into the material uniforms. Most H1/H2/H3 knobs
// (macro smoothness/scale/speed, flood detail/smooth/speed, duel detail/speed)
// act on the CPU sim (blur radius / decay / deposit) and are read directly in
// writeTextures / floodTick / spawnDuels / updateMacro, so they are NOT uniforms.
// The macro relief itself arrives via the uMacro texture (real blurred field);
// only its amplitude (uWave) and momentum roll (uMacroRoll) are uniforms here.
function syncMaterialUniforms() {
  if (!material) return;
  const u = material.uniforms;
  u.uHScale.value = tune.height;                                   // H2 amplitude
  u.uWave.value = tune.macroAmp;                                   // H1 amplitude
  u.uLevels.value = tune.steps;                                    // GLOBAL steps
  u.uDuelAmt.value = tune.duels;                                   // H3 amplitude
  u.uDim.value = tune.dim;                                         // GLOBAL dim
  u.uDomBias.value = Number.isFinite(domBias) ? domBias : 0;
  u.uPoss.value = uPoss;
  // H1 MACRO real-momentum roll: smoothed momentum (−home .. +away) scaled into a
  // small UV x-offset so the real swell shifts toward whoever is pressing now.
  u.uMacroRoll.value = Number.isFinite(macroRoll) ? clamp(macroRoll, -1, 1) * 0.18 : 0;
  u.uDuelSmooth.value = clamp(tune.duelSmooth, 0, 1);            // H3 smoothness
  u.uHtEnv.value = Number.isFinite(htEnv) ? clamp(htEnv, 0, 1) : 1;
  // SOLID BLOCK depth → side walls drop to y=-uThickness; keep the floor slab
  // parked just below the base so there's no z-fight and no black show-through.
  const th = Number.isFinite(tune.thickness) ? clamp(tune.thickness, 0, 8) : 2.5;
  u.uThickness.value = th;
  if (slab) slab.position.y = -th - 0.12;
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
const SPLAT_PITCH = 0.04;       // ~4% of pitch width (goal-spike footprint)

// Which direction a team attacks on the SHARED pitch. Teams KEEP their sides for
// the whole match (no half-time swap — placeXY puts home/away on opposite sides
// permanently): home attacks x=1 (right), away attacks x=0 (left) throughout.
// Returns the OPPONENT-goal x (where the team is pushing toward) and the team's
// OWN-goal x (where its flood corridor starts). `t` retained for compatibility.
function attackGeom(team, t) {
  const teamAttacksRight = (team === 'home');       // fixed sides all match
  const oppGoalX = teamAttacksRight ? 1 : 0;        // the goal they push toward
  const ownGoalX = teamAttacksRight ? 0 : 1;        // where their corridor starts
  return { oppGoalX, ownGoalX, attacksRight: teamAttacksRight };
}

// Convert a shared-pitch ball x into "attacking depth" 0..1 for `team` at t:
// 0 = at the team's own goal, 1 = at the opponent goal. This is how far the
// tide has rolled toward the other half.
function attackDepth(team, t, x) {
  const g = attackGeom(team, t);
  return g.attacksRight ? clamp(x, 0, 1) : clamp(1 - x, 0, 1);
}

function resetSim() {
  grid = new PassGrid(GX, GY);
  hMaxTrack = new RunningMax(0.4);
  dMaxTrack = new RunningMax(0.4);
  passCursor = 0;
  duelCursor = 0;
  turnCursor = 0;
  eventCursor = 0;
  activeEvents = [];
  // H4 SHOTS: (re)build arcs for the current resolution + reset the shot cursor
  // and clear any in-flight ripples so a backward scrub / restart is clean.
  buildShotArcs();
  shotCursor = 0;
  for (const r of ripplePool) { r.userData.active = false; r.visible = false; r.material.opacity = 0; }
  prevClock = 0;            // sim cursor only; module `clock` is owned by callers
  domHome = 0.5;
  domAccum = 0; domBias = 0;
  possHomeW = 0; possAwayW = 0;
  uPossTarget = 0.5; uPoss = 0.5;
  ballTeam = 'home'; ballX = 0.5; ballY = 0.5;
  segT0 = 0; segT1 = 0; segX0 = 0.5; segY0 = 0.5; segX1 = 0.5; segY1 = 0.5;
  headDepth = 0;
  htEnv = 1.0; htCleared = false;
  macroRoll = 0;
  simAccum = 0;
  heightData.fill(0);
  colData.fill(-1);
  duelData.fill(0);
  macroData.fill(0);
  heightTex.needsUpdate = true;
  colTex.needsUpdate = true;
  duelTex.needsUpdate = true;
  macroTex.needsUpdate = true;
}

// Process all passes whose t falls in (a, b]. NO blob splats anymore — instead
// each pass updates the BALL SEGMENT (start→end on the shared pitch) so the ball
// position can be interpolated between events. The pass's team becomes the ball
// owner. Possession-window + dominance bookkeeping unchanged.
function depositRange(a, b) {
  while (passCursor < passes.length && passes[passCursor].t <= b) {
    const p = passes[passCursor];
    if (p.t > a) {
      // half-time end-swap placement (per-team normalised → shared pitch)
      const s = placeXY(p.xn, p.yn, p.team, p.t);
      const e = placeXY(p.exn, p.eyn, p.team, p.t);
      // BALL SEGMENT: ball flies start→end across PASS_FLIGHT match-minutes.
      ballTeam = p.team;
      segT0 = p.t; segT1 = p.t + PASS_FLIGHT;
      segX0 = s.x; segY0 = s.y; segX1 = e.x; segY1 = e.y;

      // feed the possession window (recent-pass weights per team)
      if (p.team === 'away') possAwayW += 1.0; else possHomeW += 1.0;

      // H1 MACRO — accumulate this REAL pass into the coarse dominance field for
      // its team (broad footprint, long half-life). This is the whole-match
      // territorial story that becomes the macro relief after blurring. We deposit
      // at BOTH the pass start and end so the corridor of play builds the swell.
      const macroR = Math.max(1, MACRO_RADIUS_PITCH * GX);
      grid.macroDeposit(s.x, s.y, p.team, MACRO_DEPOSIT, macroR);
      grid.macroDeposit(e.x, e.y, p.team, MACRO_DEPOSIT * 0.5, macroR);

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

// Advance the reconstructed ball to match-time t by interpolating the current
// pass segment (start→end across its short flight, then held at the end).
function updateBall(t) {
  if (segT1 > segT0) {
    const u = clamp((t - segT0) / (segT1 - segT0), 0, 1);
    ballX = lerp(segX0, segX1, u);
    ballY = lerp(segY0, segY1, u);
  } else {
    ballX = segX1; ballY = segY1;
  }
}

// ---- THE TIDE: advance/recede the flood head and fill the corridor ----------
// The SMOOTHED possessor (uPoss, same signal as the colour) floods a contiguous
// swath from its OWN side up to the ball's furthest penetration. Each frame:
//   • compute the smoothed possessor and the ball's CURRENT attacking depth;
//   • the flood head ADVANCES toward the ball when they push forward, and
//     RECEDES slowly when they stop / the ball sits back (rolling leading edge);
//   • fill the corridor [own side .. head] in a lateral band around the ball y
//     into the flood field with owner = possessor. This is the wave that rolls
//     onto the other team. On a turnover the OTHER team floods back the other way
//     (its head was reset to its own side in creditTurnovers).
const HEAD_ADV = 5.0;          // how fast the head chases the ball forward (per match-min)
const HEAD_RECEDE = 0.9;       // how fast it slides back when play sits (per match-min)
const FLOOD_BAND = 0.16;       // corridor lateral half-width (unit y) around the ball
function floodTick(t, dtMatchMin) {
  // smoothed possessor (matches the colour): uPoss 0=home .. 1=away
  const possTeam = (uPoss < 0.5) ? 'home' : 'away';
  // ball depth measured FOR the possessing team (0 own side .. 1 opp goal)
  const ballDepth = attackDepth(possTeam, t, ballX);
  // ADVANCE toward the ball, RECEDE slowly when the ball sits behind the head.
  // H2 SPEED scales how fast the head chases the ball / slides back (the flow rate).
  const flow = Math.max(0.1, tune.possSpeed);
  const dt = Math.max(0, dtMatchMin);
  if (ballDepth > headDepth) {
    const k = 1 - Math.exp(-HEAD_ADV * flow * dt);
    headDepth = headDepth + (ballDepth - headDepth) * k;       // roll forward
  } else {
    const k = 1 - Math.exp(-HEAD_RECEDE * flow * dt);
    headDepth = headDepth + (ballDepth - headDepth) * k;       // ease back
  }
  headDepth = clamp(headDepth, 0, 1);

  // map attacking depth → shared-pitch x of the head, and the own-goal x.
  const g = attackGeom(possTeam, t);
  const headX = g.attacksRight ? headDepth : (1 - headDepth);
  // deposit amount scales with dt so the tide builds at a consistent wall-rate.
  // Scaled by the half-time envelope so the tide sinks toward 0 during the break.
  const amp = 26.0 * Math.min(dt, 0.2) * htEnv;
  // H2 SMOOTHNESS → leading-edge feather softness; H2 DETAIL → corridor band
  // fineness (finer detail = narrower band = crisper coverage).
  const edgeSoft = clamp(tune.possSmooth, 0, 1);
  const band = FLOOD_BAND * (1.6 - clamp(tune.possDetail, 0, 1));   // finer detail → tighter band
  grid.floodCorridor(g.ownGoalX, headX, ballY, band, possTeam, amp, edgeSoft);
}

// ---- H1 MACRO — real dominance field update ---------------------------------
// Decay the macro accumulator (long half-life, sped up by macroSpeed so the field
// decays-and-rebuilds faster at higher speed), then ease the smoothed momentum
// roll toward the REAL per-minute momentum sample (model.series.mom, −1..1,
// +=home; we flip to +=away so it matches the macro net sign). dtMatchMin is the
// match-minutes elapsed for this step. Real data only — no synthetic signal.
function updateMacro(t, dtMatchMin) {
  const spd = Math.max(0.05, tune.macroSpeed);
  // slow decay (long memory); macroSpeed scales how fast it decays-and-rebuilds.
  const keep = Math.exp(-MACRO_DECAY_PER_MIN * spd * Math.max(0, dtMatchMin));
  grid.macroDecay(keep);
  // REAL momentum sample at match-time t: +1 = home pressing .. −1 = away pressing.
  // Macro net is (away − home), so the swell leans +away; flip momentum sign to
  // match (away pressing → +) before rolling.
  const momHome = (model && model.series) ? at(model.series.mom, t, model.STEP) : 0;
  const rollTarget = -clamp(Number.isFinite(momHome) ? momHome : 0, -1, 1); // +away pressing
  // ease toward the live momentum; macroSpeed sets the roll rate (per match-min).
  const kRoll = 1 - Math.exp(-0.6 * spd * Math.max(0, dtMatchMin));
  macroRoll = macroRoll + (rollTarget - macroRoll) * clamp(kRoll, 0, 1);
}

// ---- HALF-TIME BREAK ---------------------------------------------------------
// Drive the htEnv envelope from match-time t and perform the one-shot 45' clear.
// htEnv is a V-shaped dip: 1 outside the break window, easing down to ~0 AT 45'
// over htFade match-minutes total, then easing back to 1. The instant we cross
// 45' forward we wipe the flood fields and reset possession to a clean 50-50 so
// the 2nd half rebuilds even. On backward scrub the clear flag is reset so it can
// fire again. uPoss/htEnv are also recomputed for scrubbed (single-frame) frames.
function updateHalftime(t) {
  const half = HALFTIME_MIN;
  const w = Math.max(0.2, tune.htFade) * 0.5;   // half-width of the dip window
  const d = Math.abs(t - half);
  // smoothstep up from the dip: 0 at 45', → 1 at the window edges (and beyond).
  if (d >= w) {
    htEnv = 1.0;
  } else {
    const u = d / w;                 // 0 at 45' .. 1 at edge
    htEnv = u * u * (3.0 - 2.0 * u); // smoothstep → smooth sink/rebuild
  }
  htEnv = clamp(htEnv, 0, 1);

  // one-shot clear at the forward crossing of 45'.
  if (t >= half) {
    if (!htCleared) {
      grid.clearFlood();
      possHomeW = 0; possAwayW = 0;
      uPossTarget = 0.5; uPoss = 0.5;
      headDepth = 0;
      htCleared = true;
    }
  } else {
    htCleared = false;   // before the break again (scrub back) → allow re-fire
  }
}

// Apply ASYMMETRIC flood decay over REAL seconds dt: the possessing team's tide
// uses the slow `floodHold` rate; the non-possessing team's stale tide uses the
// fast `floodClear` rate. base rate = fade slider × 1.1 (matches grid.decay).
function applyFloodDecay(dt) {
  const base = tune.fade * 1.1;
  const sdt = Math.max(dt, 1e-4);
  const keepHold = Math.exp(-base * tune.floodHold * sdt);     // possessor: lingers
  const keepClear = Math.exp(-base * tune.floodClear * sdt);   // other: vanishes fast
  if (uPoss < 0.5) grid.floodDecay(keepHold, keepClear);       // home possesses
  else             grid.floodDecay(keepClear, keepHold);       // away possesses
}

// Spawn DUEL spikes (Layer 3) for duels whose t falls in (a,b]. FINER + SHARPER
// than before: ~1 fine cell footprint so they read as tiny contact sparks,
// distinct from the broad possession flood. Display HEIGHT is the duels slider
// (uDuelAmt in the shader); CPU amplitude is constant here.
function spawnDuels(a, b) {
  // ~1 fine cell core (independent of grid res), crisp. H3 DETAIL controls the
  // footprint fineness: finer detail → smaller, sharper spark radius.
  const detail = clamp(tune.duelDetail, 0, 1);
  const radius = Math.max(0.6, GX * (0.012 - 0.010 * detail));
  while (duelCursor < duels.length && duels[duelCursor].t <= b) {
    const d = duels[duelCursor];
    if (d.t > a) {
      const pl = placeXY(d.xn, d.yn, d.team, d.t);
      // tall+narrow but CAPPED amplitude so no near-vertical facet.
      let height = 1.4;
      // YELLOW-CARD hook: a carded duel spikes twice as tall. THIS match's data
      // has no cards so d.bigCard is never set — this never triggers here.
      if (d.bigCard) height *= 2;
      grid.duelSplat(pl.x, pl.y, d.team, height, radius);
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
      // HAND THE BALL to the winning team and re-anchor the flood: the new owner
      // starts flooding from THEIR side. The ball is physically where it was, but
      // for the gainer that maps to a (usually shallow) attacking depth, so their
      // tide begins low and rolls the OTHER way as they push forward.
      ballTeam = to.team;
      headDepth = attackDepth(to.team, to.t, ballX);
      // hold the ball at its current spot until the next pass moves it
      segT0 = to.t; segT1 = to.t;
      segX0 = segX1 = ballX; segY0 = segY1 = ballY;
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
      // place the goal on the shared pitch (fixed sides all match), then bias
      // toward whichever goal this team is ATTACKING (home → right, away → left).
      const pl = placeXY(s.x, s.y, s.team, s.t);
      const attacksRight = (s.team === 'home');     // fixed sides all match
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

// ============================================================================
// H4 SHOTS — 3D STEPPED VOXEL ARCS + IMPACT RIPPLE (the new layer)
// ============================================================================
// Plain THREE meshes only (InstancedMesh of box voxels + a ring mesh per active
// ripple). The terrain ShaderMaterial is never touched, so this layer cannot
// break the GLSL.
//
// MAPPING (P0/P1 → world):
//   Shared pitch frame matches stage4: u = pitch-x 0..1, v = pitch-y 0..1, with
//   worldX = (u-0.5)*WORLD_X, worldZ = (0.5-v)*WORLD_Z (PlaneGeometry+rotateX).
//   • LAUNCH P0: the shot's raw per-team (x/100,y/100) is placed on the SHARED
//     pitch with placeXY (away mirrored — same as every other layer), giving
//     (u0,v0); worldY0 = approximate terrain surface height there (so the arc
//     sits ON the relief).
//   • GOAL P1: the attacking goal end. The team's target end gives u1 (home →
//     away goal at u=1, away → home goal at u=0). ACROSS the goal mouth comes
//     from goalY/68 → v1 (clamped). HEIGHT goalZ (metres) → worldY1 via
//     GOALZ_SCALE so the crossbar (2.44 m) sits a clear height above the block
//     and over-the-bar misses rise higher.
//
// ARC: a quadratic Bézier P0→P1 with a lifted control point (apex above the
// chord midpoint; lift scales with chord length + the arc slider). Sampled into
// N points and SNAPPED to a voxel grid (quantised) → a stair-stepped blocky
// trail of chunky cubes. Goals get bigger + brighter cubes.
//
// ANIMATION vs clock: as the clock passes a shot's t → (1) impact drop-ripple
// expands+fades ~0.7 s; (2) the voxel trail draws on launch→goal ~0.5 s; (3) the
// arc persists and slowly fades (goals brighter/longer). Scrub-safe.

const SHOT = {
  MAX_PER: 150,        // max voxels in one arc (adaptive count is capped here)
  VOX: 6000,           // instance pool capacity (adaptive voxel counts × ~40 live arcs)
  GOALZ_SCALE: 1.05,   // metres → world Y for goalZ (crossbar 2.44 m → ~2.56 above the relief edge)
  RIPPLE_LIFE: 0.75,   // ripple lifetime in REAL seconds
  DRAW_TIME: 0.5,      // arc draw-on time in REAL seconds (launch → goal)
  RIPPLE_MAX: 360,     // max simultaneous ripple rings (pooled)
};
// Pure blue is intrinsically low-luminance vs green, so France's arcs read darker
// than Senegal's at equal brightness. Use a lifted periwinkle-blue so the blue
// arcs ring out as vividly as the green ones.
const FRA_BLUE = new THREE.Color(0x6699ff);   // luminous France blue
const SEN_GREEN = new THREE.Color(0x18de72);  // Senegal green

let shotInst = null;            // InstancedMesh of voxel cubes (the whole pool)
let shotInstColor = null;       // instanceColor buffer
let shotArcs = [];              // built per-shot arc descriptors (precomputed)
let shotCursor = 0;             // next shot whose impact ripple is yet to fire
let ripplePool = [];            // pooled ring meshes (drop ripples on the relief)
let shotTime = 0;               // REAL-seconds accumulator that drives shot anim
const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _col = new THREE.Color();

// Normalize the RAW shots, keeping minute/t/team/x/y/xg/isGoal/onTarget/shotType
// + the NEW height fields goalY (metres across, ~0..68) and goalZ (metres high).
// Real data only — no synthetic fields. Sorted by time.
function normShots(rawShots) {
  const out = [];
  for (const s of (rawShots || [])) {
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
    const t = Number.isFinite(s.t) ? s.t : (Number(s.minute) || 0);
    out.push({
      t,
      team: s.team === 'away' ? 'away' : 'home',
      xn: clamp(s.x / 100, 0, 1),       // raw per-team frame (attack toward x=100)
      yn: clamp(s.y / 100, 0, 1),
      xg: Number.isFinite(s.xg) ? s.xg : 0,
      isGoal: !!s.isGoal,
      onTarget: !!s.onTarget,
      shotType: s.shotType || '',
      goalY: Number.isFinite(s.goalY) ? s.goalY : 34,   // metres across (centre ≈34)
      goalZ: Number.isFinite(s.goalZ) ? s.goalZ : 0,    // metres high (0 ground, 2.44 bar)
    });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// Approximate terrain surface world-Y at shared-pitch (u,v) so the launch voxel
// SITS ON the relief. Mirrors the shader H() roughly: macro swell (uMacro, the
// big signed blurred field × uWave, terraced) + possession flood relief
// (heightData × uHScale, terraced). Sampled from the CPU arrays the sim already
// maintains; approximate is fine (the spec allows block-top sampling).
function sampleTerrainY(u, v) {
  if (!heightData || !macroData) return 0;
  const i = clamp(Math.round(u * (GX - 1)), 0, GX - 1);
  const j = clamp(Math.round(v * (GY - 1)), 0, GY - 1);
  const k = j * GX + i;
  const L = Math.max(1, tune.steps);
  // H1 macro: signed −1..1 × amplitude, terraced like the shader.
  let mv = macroData[k]; if (!Number.isFinite(mv)) mv = 0;
  let wave = mv * tune.macroAmp;
  const qScale = Math.max(1e-3, tune.macroAmp);
  wave = Math.round((wave / qScale) * L) / L * qScale;
  // H2 possession flood relief, terraced × amplitude × half-time env.
  let r = heightData[k]; if (!Number.isFinite(r)) r = 0;
  r = Math.round(r * L) / L;
  const relief = r * tune.height * (Number.isFinite(htEnv) ? htEnv : 1);
  let y = wave + relief;
  if (!Number.isFinite(y)) y = 0;
  return clamp(y, -0.3, 7.0);
}

// Build the InstancedMesh voxel pool + the ripple ring pool ONCE. The pool is
// big enough for all live arcs (N voxels each, ~17–25 shots). Unused instances
// are parked at scale 0 (invisible). Vertex-colour material so each cube can be
// tinted per team / per goal-emphasis without extra draw calls.
function setupShots() {
  if (shotInst) return;
  const box = new THREE.BoxGeometry(1, 1, 1);
  // UNLIT basic material: each cube shows its assigned instanceColor exactly,
  // independent of scene lighting. toneMapped:false keeps colours vivid (ACES
  // tone-mapping was crushing the dimmer France blue arcs to near-black).
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: false, toneMapped: false, fog: false,  // arcs are the signal: never let scene fog dim them to near-black at depth
  });
  shotInst = new THREE.InstancedMesh(box, mat, SHOT.VOX);
  shotInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shotInst.count = SHOT.VOX;
  // per-instance colour
  const colArr = new Float32Array(SHOT.VOX * 3);
  shotInstColor = new THREE.InstancedBufferAttribute(colArr, 3);
  shotInst.instanceColor = shotInstColor;
  // park everything at scale 0
  for (let i = 0; i < SHOT.VOX; i++) {
    _m4.compose(_v3.set(0, -999, 0), _q.identity(), _scl.set(0, 0, 0));
    shotInst.setMatrixAt(i, _m4);
  }
  shotInst.instanceMatrix.needsUpdate = true;
  shotInst.frustumCulled = false;
  scene.add(shotInst);

  // RIPPLE RING POOL — thin flat torus rings that expand+fade on the relief.
  const ringGeo = new THREE.RingGeometry(0.72, 1.0, 40);
  ringGeo.rotateX(-Math.PI / 2);     // lie flat on XZ (on the relief surface)
  for (let i = 0; i < SHOT.RIPPLE_MAX; i++) {
    const rm = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0, depthWrite: false,
      side: THREE.DoubleSide, color: 0xffffff,
    });
    const ring = new THREE.Mesh(ringGeo, rm);
    ring.visible = false;
    ring.frustumCulled = false;
    scene.add(ring);
    ripplePool.push(ring);
  }
}

// Map a shot to world P0/P1 + a parabola apex, build N quantised voxel centres,
// and stash per-shot render params (colour, base cube size, brightness). Called
// when the arcs are (re)built for the current resolution / on reset.
function buildShotArcs() {
  shotArcs = [];
  for (const s of shots) {
    // LAUNCH on the shared pitch (away mirrored, same as every other layer).
    const pl = placeXY(s.xn, s.yn, s.team, s.t);
    const u0 = pl.x, v0 = pl.y;
    const x0 = (u0 - 0.5) * WORLD_X;
    const z0 = (0.5 - v0) * WORLD_Z;

    // GOAL end: the team's attacking goal. home attacks u=1, away attacks u=0.
    const attacksRight = (s.team === 'home');
    const u1 = attacksRight ? 1 : 0;
    // ACROSS the goal mouth: goalY metres (0..68) → v across the pitch width.
    // For the AWAY team (mirrored to the opposite side) the across axis flips too.
    let vAcross = clamp(s.goalY / 68, 0, 1);
    if (!attacksRight) vAcross = 1 - vAcross;
    const v1 = vAcross;
    const x1 = (u1 - 0.5) * WORLD_X;
    const z1 = (0.5 - v1) * WORLD_Z;

    shotArcs.push({
      ref: s,
      u0, v0, x0, z0,                 // launch (worldY sampled live on the relief)
      u1, v1, x1, z1,                  // goal-line landing (worldY sampled live on the relief edge + goalZ)
      goalZ: s.goalZ,
      isGoal: s.isGoal,
      onTarget: s.onTarget,
      xg: s.xg,
      team: s.team,
      t: s.t,
    });
  }
}

// Quadratic Bézier point at parameter p∈[0,1] for control points a,c,b (apex c).
function qbez(a, c, b, p, out) {
  const mp = 1 - p;
  out.set(
    mp * mp * a.x + 2 * mp * p * c.x + p * p * b.x,
    mp * mp * a.y + 2 * mp * p * c.y + p * p * b.y,
    mp * mp * a.z + 2 * mp * p * c.z + p * p * b.z
  );
  return out;
}

// Spawn a ripple ring at a launch point (uses an idle pooled ring).
function spawnRipple(arc, ageReal) {
  for (const r of ripplePool) {
    if (!r.userData.active) {
      r.userData.active = true;
      r.userData.t0 = shotTime - Math.max(0, ageReal);
      r.userData.team = arc.team;
      r.position.set(arc.x0, sampleTerrainY(arc.u0, arc.v0) + 0.04, arc.z0);
      r.material.color.copy(arc.team === 'away' ? SEN_GREEN : FRA_BLUE);
      r.visible = true;
      return;
    }
  }
}

// Drive every active ripple (expand + fade), recycling finished ones.
function updateRipples() {
  const base = 0.5 + 1.6 * tune.rippleSize;     // peak radius in world units
  for (const r of ripplePool) {
    if (!r.userData.active) continue;
    const age = shotTime - r.userData.t0;
    const u = age / SHOT.RIPPLE_LIFE;
    if (u >= 1 || age < 0) { r.userData.active = false; r.visible = false; r.material.opacity = 0; continue; }
    const rad = base * (0.15 + u);                // grows outward
    r.scale.set(rad, 1, rad);
    r.material.opacity = (1 - u) * 0.85;          // fade out
  }
}

// Rebuild + redraw ALL shot voxels for the current clock. settled state for all
// shots with t≤clock (scrub-safe); recent ones draw-on; goals fatter+brighter.
// Returns nothing — writes the InstancedMesh directly.
function drawShots(t) {
  if (!shotInst || !shotArcs.length) return;
  let inst = 0;
  const baseSize = Math.max(0.02, tune.shotThick);
  const cap = SHOT.VOX;
  for (const arc of shotArcs) {
    if (arc.t > t) continue;                       // not taken yet
    const ageReal = (t - arc.t) / Math.max(0.2, tune.speed); // match-min → real-sec at current speed
    // draw-on progress 0..1 over DRAW_TIME real seconds after the shot.
    const drawn = clamp(ageReal / SHOT.DRAW_TIME, 0, 1);
    // persistence fade: goals stay bright/long; others dim by shotFade per real sec.
    let bright;
    if (arc.isGoal) {
      bright = clamp(1.0 - 0.04 * Math.max(0, ageReal - SHOT.DRAW_TIME), 0.55, 1.6);
    } else {
      const fadeAge = Math.max(0, ageReal - SHOT.DRAW_TIME);
      bright = clamp(1.0 - tune.shotFade * 0.18 * fadeAge, 0.6, 1.0);  // floor kept high so settled arcs stay vividly coloured
    }
    // endpoints. Launch sits on the relief at the shot spot (so the drop-ripple
    // reads as "struck here"), but its height is CLAMPED so shots from tall
    // possession peaks don't rocket off-screen as near-vertical columns.
    const y0 = Math.min(sampleTerrainY(arc.u0, arc.v0), 2.6) + baseSize * 0.5;
    const P0 = _tmpA.set(arc.x0, y0, arc.z0);
    // STRIKE height: the goal end rides on the CURRENT relief height at the goal
    // edge (dynamic — rises/falls with the live terrain there), plus the real
    // shot height (goalZ) above that ground, scaled by the shot-height slider.
    const goalGround = sampleTerrainY(arc.u1, arc.v1);
    const y1 = goalGround + Math.max(0, arc.goalZ) * SHOT.GOALZ_SCALE * tune.shotHeight + baseSize * 0.5;
    const P1 = _tmpB.set(arc.x1, y1, arc.z1);
    // apex lift keyed to the HORIZONTAL span only (not vertical), so steep
    // near-goal shots stay shallow arcs instead of tall spikes.
    const horiz = Math.hypot(arc.x1 - arc.x0, arc.z1 - arc.z0);
    const lift = (1.0 + horiz * 0.32) * tune.shotArc;
    const apexY = Math.max(P0.y, P1.y) + lift;
    const C = _tmpC.set((P0.x + P1.x) * 0.5, apexY, (P0.z + P1.z) * 0.5);

    // team colour, brightened/boosted for goals, desaturated for off-target.
    _col.copy(arc.team === 'away' ? SEN_GREEN : FRA_BLUE);
    if (arc.isGoal) {
      _col.multiplyScalar(1.0).lerp(WHITE, 0.18);   // brighter, slight whiten
    } else if (!arc.onTarget) {
      // desaturate slightly toward grey
      const lum = _col.r * 0.299 + _col.g * 0.587 + _col.b * 0.114;
      _col.lerp(_grey.setRGB(lum, lum, lum), 0.35);
    }
    // xg nudges brightness a touch; persistence fade applies.
    const xgB = 0.85 + 0.5 * clamp(arc.xg, 0, 1);
    const goalMul = arc.isGoal ? tune.goalBoost : 1.0;
    const finalBright = clamp(bright * xgB * (arc.isGoal ? 1.25 : 1.0), 0.55, 2.2);
    _col.multiplyScalar(finalBright);

    // cube size: goals fatter (× goalBoost), off-target a touch thinner.
    let cube = baseSize * (arc.isGoal ? (1.0 + 0.6 * (tune.goalBoost - 1)) : 1.0);
    if (!arc.onTarget && !arc.isGoal) cube *= 0.82;

    // VOXEL COUNT adaptive to arc length & cube size so the trail stays a
    // CONTINUOUS line at ANY thickness: consecutive cubes overlap by ~half a
    // cube. Thin arcs get MORE steps instead of breaking into fragments.
    const arcLen = 0.5 * (P0.distanceTo(P1) + P0.distanceTo(C) + C.distanceTo(P1));
    const nVox = Math.max(8, Math.min(SHOT.MAX_PER, Math.ceil(arcLen / (cube * 0.5))));
    // how many voxels to show given the draw-on progress.
    const shown = Math.max(1, Math.round(nVox * drawn));
    for (let s = 0; s < shown; s++) {
      if (inst >= cap) break;
      const p = nVox <= 1 ? 0 : s / (nVox - 1);
      qbez(P0, C, P1, p, _v3);
      // QUANTISE to a voxel grid → stair-stepped blocky look.
      const q = cube;                       // snap step = cube size (chunky stairs)
      _v3.x = Math.round(_v3.x / q) * q;
      _v3.y = Math.round(_v3.y / q) * q;
      _v3.z = Math.round(_v3.z / q) * q;
      _m4.compose(_v3, _q.identity(), _scl.set(cube, cube, cube));
      shotInst.setMatrixAt(inst, _m4);
      shotInst.setColorAt(inst, _col);
      inst++;
    }
    if (inst >= cap) break;
  }
  // park the unused tail.
  for (let i = inst; i < cap; i++) {
    _m4.compose(_v3.set(0, -999, 0), _q.identity(), _scl.set(0, 0, 0));
    shotInst.setMatrixAt(i, _m4);
  }
  shotInst.instanceMatrix.needsUpdate = true;
  if (shotInst.instanceColor) shotInst.instanceColor.needsUpdate = true;
}
const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _tmpC = new THREE.Vector3();
const WHITE = new THREE.Color(0xffffff);
const _grey = new THREE.Color();

// Fire impact ripples for shots crossing into (a,b]. Scrub-safe: forward only;
// backward scrub resets shotCursor (see resetSim / stepSim).
function fireShotRipples(a, b) {
  while (shotCursor < shotArcs.length && shotArcs[shotCursor].t <= b) {
    const arc = shotArcs[shotCursor];
    if (arc.t > a) spawnRipple(arc, 0);
    shotCursor++;
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

  const dtMatchMin = Math.max(0, t - prevClock);
  depositRange(prevClock, t);
  creditTurnovers(prevClock, t);
  spawnDuels(prevClock, t);
  syncEvents(t);
  applyEventSpikes(t);
  fireShotRipples(prevClock, t);     // H4 SHOTS: impact drop-ripple on crossing t
  updatePossession(dtMatchMin);
  updateBall(t);

  // HALF-TIME: update the dip envelope and (once) clear flood + reset to 50-50.
  updateHalftime(t);

  // advance the smoothed possession (uPoss) toward its target by the match-time
  // elapsed so the FLOOD owner is current before we roll the tide this frame.
  const kP = 1 - Math.exp(-(dtMatchMin * 60) / POSS_TAU_SEC);  // dtMatchMin in min → sec
  uPoss = lerp(uPoss, uPossTarget, clamp(kP, 0, 1));
  floodTick(t, dtMatchMin);

  // H1 MACRO: decay the real dominance accumulator + roll toward live momentum.
  updateMacro(t, dtMatchMin);

  // decay everything: rate scaled by fade slider; dt is REAL seconds (so the
  // visible sink speed is tied to wall time, feels consistent across speeds).
  // DUELS decay much faster (~3×) so sparks are brief (≈0.6–1.2 match-min).
  // FLOOD recedes SLOWLY (the tide lingers) — a gentle decay so the coloured
  // swath persists where the ball reached, then eases back when play moves on.
  const rate = tune.fade * 1.1;
  const keep = Math.exp(-rate * Math.max(dt, 1e-4));
  // H3 SPEED scales the duel decay: faster speed → sparks rise & fade quicker.
  const duelRate = rate * 3.0 * Math.max(0.1, tune.duelSpeed);
  const duelKeep = Math.exp(-duelRate * Math.max(dt, 1e-4));
  grid.decay(keep, duelKeep);
  // ASYMMETRIC FLOOD DECAY: the team currently in possession persists (floodHold,
  // slow); the OTHER team's stale flood recedes fast (floodClear). So an old
  // counter-attack tide vanishes quickly once possession flips.
  applyFloodDecay(dt);

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
    updateBall(b);
    // advance smoothed possession by the match-time of this chunk, then roll the
    // tide so a fast-forwarded grid matches a played-through one.
    const kP = 1 - Math.exp(-((b - a) * 60) / POSS_TAU_SEC);
    uPoss = lerp(uPoss, uPossTarget, clamp(kP, 0, 1));
    floodTick(b, b - a);
    updateMacro(b, b - a);            // H1 MACRO: decay + roll during fast-forward too
    const dtSec = (b - a) * secPerMin;
    const ffDuelRate = rate * 3.0 * Math.max(0.1, tune.duelSpeed);
    grid.decay(Math.exp(-rate * dtSec), Math.exp(-ffDuelRate * dtSec));
    // asymmetric flood decay (same possessor-vs-stale split as live play)
    const keepHold = Math.exp(-rate * tune.floodHold * dtSec);
    const keepClear = Math.exp(-rate * tune.floodClear * dtSec);
    if (uPoss < 0.5) grid.floodDecay(keepHold, keepClear);
    else             grid.floodDecay(keepClear, keepHold);
    // half-time envelope + clear must also run during fast-forward so a scrubbed
    // frame past 45' matches a played-through one.
    updateHalftime(b);
    a = b;
  }
  // H4 SHOTS: advance the shot cursor PAST every shot already taken by `t` WITHOUT
  // spawning visible ripples (those are for live forward play / very recent shots).
  // drawShots() still renders all settled arcs with t≤clock, so the result matches.
  shotCursor = 0;
  while (shotCursor < shotArcs.length && shotArcs[shotCursor].t <= t) shotCursor++;
}

// Write normalized cell height + away-share + duel channel into the DataTextures.
// EVERY write is finite-guarded and clamped so NO NaN/Inf ever reaches the GPU
// (black-spot fix) and heights are capped so no near-vertical facet appears.
function writeTextures() {
  const n = GX * GY;
  // POSSESSION relief now comes from the contiguous FLOOD field (the tide), PLUS
  // the brief goal-spike accumulators (hHome/hAway). find the frame max (flood +
  // goal spikes + duel) to feed the running-max normalizers.
  let frameMax = 0, duelMax = 0;
  for (let k = 0; k < n; k++) {
    const v = grid.fInt[k] + grid.total(k);
    if (Number.isFinite(v) && v > frameMax) frameMax = v;
    const dv = grid.dInt[k]; if (Number.isFinite(dv) && dv > duelMax) duelMax = dv;
  }
  hMaxTrack.observe(frameMax);
  dMaxTrack.observe(duelMax);
  const inv = (Number.isFinite(hMaxTrack.m) && hMaxTrack.m > 1e-6) ? 1 / hMaxTrack.m : 0;
  const dinv = (Number.isFinite(dMaxTrack.m) && dMaxTrack.m > 1e-6) ? 1 / dMaxTrack.m : 0;

  let hSum = 0, aSum = 0;
  for (let k = 0; k < n; k++) {
    // possession height = flood intensity + goal-spike density (both per-team).
    const fi = grid.fInt[k];
    const hh = grid.hHome[k], ha = grid.hAway[k];
    const tot = fi + hh + ha;
    let nh = tot * inv;
    if (!Number.isFinite(nh)) nh = 0;
    heightData[k] = nh > 0 ? Math.min(nh, 1.4) : 0;
    // colour: FLOOD owner where the tide has reached; else goal-spike owner;
    // else -1 (dry → neutral tide base). Flood dominates the signal.
    let cs;
    if (fi > 1e-4) cs = grid.floodShare(k);
    else if (hh + ha > 1e-4) cs = ha / (hh + ha);
    else cs = -1;
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
    // HUD possession % follows the FLOOD ownership (the tide) plus goal spikes.
    hSum += grid.fHome[k] + hh; aSum += grid.fAway[k] + ha;
  }
  // smoothed "who dominates recent passes" for the HUD
  const tot = hSum + aSum;
  const targetHome = tot > 1e-4 ? hSum / tot : 0.5;
  domHome = lerp(domHome, targetHome, 0.12);

  // ---- H1 MACRO: blur the real accumulator → signed swell, then normalise -----
  // Blur radius (cells) = scale × smoothness. SCALE sets the spatial wavelength /
  // fold size; SMOOTHNESS sets how heavily it's blurred (broader swells). Both
  // scale with grid resolution so the swell reads the same size at any fineness.
  const baseR = 0.05 * GX;                                   // ~5% of pitch width base
  const rad = Math.max(1, Math.round(baseR * Math.max(0.1, tune.macroScale)
                                     * (0.4 + 1.6 * clamp(tune.macroSmooth, 0, 1))));
  const blurPasses = MACRO_BLUR_PASSES;
  grid.macroBlur(rad, blurPasses);
  const mAbs = grid.macroAbsMax();
  const minv = (Number.isFinite(mAbs) && mAbs > 1e-6) ? 1 / mAbs : 0;
  const mb = grid.mBlur;
  for (let k = 0; k < n; k++) {
    let mv = mb[k] * minv;                                   // signed −1..1 (real, blurred)
    if (!Number.isFinite(mv)) mv = 0;
    macroData[k] = clamp(mv, -1.5, 1.5);
  }
  macroTex.needsUpdate = true;

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
// SIM-RATE THROTTLE: at fine grids the typed-array decay/flood loops over up to
// ~246k cells are the cost; cap the SIM (not the render) at ≤30 Hz so rendering
// + camera stay smooth. Small grids step every frame (threshold by cell count).
const SIM_MIN_INTERVAL = 1 / 30;   // ≤30 Hz when throttling
const SIM_THROTTLE_CELLS = 60000;  // throttle once the grid is this large
let simAccum = 0;
function loop(now) {
  const dt = Math.min(0.1, Math.max(0, (now - lastNow) / 1000));
  lastNow = now;

  if (model && playing) {
    clock += dt * tune.speed;
    if (clock >= model.duration) { clock = model.duration; playing = false; el('play').textContent = '▶ play'; }
  }

  // uPoss is smoothed INSIDE stepSim (with the match-time elapsed) so the FLOOD
  // owner is current when the tide rolls; we just read it here for the uniform.
  if (model && grid) {
    const throttle = (GX * GY) >= SIM_THROTTLE_CELLS;
    if (!throttle) {
      stepSim(clock, dt);
    } else {
      // accumulate real-seconds; run one sim step per ≤30 Hz tick with the
      // accumulated dt so decay/flood stay rate-correct at coarse step cadence.
      simAccum += dt;
      if (simAccum >= SIM_MIN_INTERVAL) {
        stepSim(clock, simAccum);
        simAccum = 0;
      }
    }
  }

  if (material) {
    syncMaterialUniforms();
    hMaxTrack.ease(dt);
    dMaxTrack.ease(dt);
    material.uniforms.uTime.value = now / 1000;
  }

  // H4 SHOTS: advance the shot-anim clock, expand/fade ripples, redraw the
  // voxel arcs for the current match clock (draw-on + persistence/fade).
  if (model) {
    shotTime += dt;
    updateRipples();
    drawShots(clock);
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

  // ============================================================================
  // CONTROL PANEL — rebuilt entirely in JS (HTML can't be relied on). The pre-
  // existing tuning slider rows are removed and replaced with FOUR clearly
  // labelled groups: GLOBAL · H1 MACRO · H2 POSSESSION · H3 DUELS. Each of the
  // three LAYERS gets its own amplitude / speed / smoothness / detail set (H2
  // also gets hold + clear). play / restart / clock + the title are kept.
  // ============================================================================
  buildControlPanel();

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

// ---- COPY SETTINGS ----------------------------------------------------------
// Build a single JSON blob with the CURRENT value of EVERY slider/tunable plus
// the grid resolution and camera, so the user can paste their dialed-in setup
// back. Round numbers for readability.
function settingsBlob() {
  const r2 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
  return {
    tune: {
      // GLOBAL
      speed: r2(tune.speed), steps: Math.round(tune.steps), dim: r2(tune.dim),
      htFade: r2(tune.htFade), fade: r2(tune.fade), thickness: r2(tune.thickness),
      // H1 MACRO (real dominance relief — amplitude / speed / smoothness / scale)
      macroAmp: r2(tune.macroAmp), macroSpeed: r2(tune.macroSpeed),
      macroSmooth: r2(tune.macroSmooth), macroScale: r2(tune.macroScale),
      // H2 POSSESSION
      height: r2(tune.height), possSpeed: r2(tune.possSpeed),
      possSmooth: r2(tune.possSmooth), possDetail: r2(tune.possDetail),
      floodHold: r2(tune.floodHold), floodClear: r2(tune.floodClear),
      // H3 DUELS
      duels: r2(tune.duels), duelSpeed: r2(tune.duelSpeed),
      duelSmooth: r2(tune.duelSmooth), duelDetail: r2(tune.duelDetail),
      // H4 SHOTS (3D stepped voxel arcs)
      shotThick: r2(tune.shotThick), shotArc: r2(tune.shotArc),
      shotHeight: r2(tune.shotHeight),
      rippleSize: r2(tune.rippleSize), shotFade: r2(tune.shotFade),
      goalBoost: r2(tune.goalBoost),
    },
    grid: { gx: GX, gy: GY },
    camera: {
      pos: [r2(camera.position.x), r2(camera.position.y), r2(camera.position.z)],
      target: [r2(controls.target.x), r2(controls.target.y), r2(controls.target.z)],
    },
  };
}

// Per-section field lists (keyed by the EXACT header text) so each block can be
// copied on its own. GLOBAL also carries the grid resolution.
const SECTION_FIELDS = {
  'GLOBAL': ['speed', 'steps', 'dim', 'htFade', 'fade', 'thickness'],
  'H1 MACRO': ['macroAmp', 'macroSpeed', 'macroSmooth', 'macroScale'],
  'H2 POSSESSION': ['height', 'possSpeed', 'possSmooth', 'possDetail', 'floodHold', 'floodClear'],
  'H3 DUELS': ['duels', 'duelSpeed', 'duelSmooth', 'duelDetail'],
  'H4 SHOTS': ['shotThick', 'shotArc', 'shotHeight', 'rippleSize', 'shotFade', 'goalBoost'],
};
// Build the settings object for ONE section (just its tune fields + grid for GLOBAL).
function sectionBlob(key) {
  const r2 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
  const o = {};
  for (const f of (SECTION_FIELDS[key] || [])) o[f] = (f === 'steps') ? Math.round(tune[f]) : r2(tune[f]);
  const out = { tune: o };
  if (key === 'GLOBAL') out.grid = { gx: GX, gy: GY };
  return out;
}
// Copy a settings object to the clipboard, flashing the button; on failure
// dump the JSON into the shared fallback textarea for hand-copying.
async function copyJSON(obj, btn, okLabel) {
  const json = JSON.stringify(obj, null, 2);
  const orig = btn.textContent;
  try {
    await navigator.clipboard.writeText(json);
    btn.textContent = okLabel || 'copied ✓';
    clearTimeout(btn._flashT);
    btn._flashT = setTimeout(() => { btn.textContent = orig; }, 1200);
  } catch {
    const dump = el('copysetDump');
    if (dump) { dump.value = json; dump.style.display = 'block'; dump.focus(); dump.select(); }
  }
}

// Append a "COPY SETTINGS" button to the control panel (with a hidden readable
// fallback element). On click → copy the settings JSON to the clipboard; on
// failure dump it into the fallback element for hand-copying. Flash "copied ✓".
function addCopySettingsButton() {
  const panel = el('panel');
  if (!panel || el('copyset')) return;
  const row = document.createElement('div');
  row.className = 'row';
  const btn = document.createElement('button');
  btn.id = 'copyset';
  btn.type = 'button';
  btn.textContent = 'COPY SETTINGS';
  btn.style.cssText = 'flex:1;cursor:pointer';
  row.appendChild(btn);
  panel.appendChild(row);

  // readable fallback (hidden until a clipboard write fails)
  const dump = document.createElement('textarea');
  dump.id = 'copysetDump';
  dump.readOnly = true;
  dump.style.cssText = 'display:none;width:100%;height:120px;margin-top:4px;' +
    'font:10px/1.3 monospace;background:#0a0e16;color:#9fd;border:1px solid rgba(255,255,255,0.18);' +
    'border-radius:4px;padding:6px;box-sizing:border-box';
  panel.appendChild(dump);

  let flashT = 0;
  btn.addEventListener('click', async () => {
    const json = JSON.stringify(settingsBlob(), null, 2);
    const flash = () => {
      btn.textContent = 'copied ✓';
      clearTimeout(flashT);
      flashT = setTimeout(() => { btn.textContent = 'COPY SETTINGS'; }, 1400);
    };
    try {
      await navigator.clipboard.writeText(json);
      dump.style.display = 'none';
      flash();
    } catch {
      // clipboard blocked → show the JSON so it can be hand-copied + select it.
      dump.value = json;
      dump.style.display = 'block';
      dump.focus(); dump.select();
      btn.textContent = 'copy below ↓';
      clearTimeout(flashT);
      flashT = setTimeout(() => { btn.textContent = 'COPY SETTINGS'; }, 1800);
    }
  });
}

// ---- control-panel builder (all sliders rebuilt in JS) ----------------------
// We OWN the tuning panel: strip the HTML-authored slider rows (keep title +
// play/restart + clock) and rebuild the GLOBAL / H1 / H2 / H3 groups so the
// three layers read clearly. Each addSlider() wires a live `tune` field.
function buildControlPanel() {
  const panel = el('panel');
  if (!panel) return;
  // section-header + tighter-panel styling (HTML untouched → inject once).
  if (!document.getElementById('grpStyle')) {
    const st = document.createElement('style');
    st.id = 'grpStyle';
    st.textContent =
      '#panel{max-height:94vh;overflow-y:auto;gap:6px}' +
      '#panel .grp{margin-top:7px;color:#9fd;font-size:10px;font-weight:600;' +
      'letter-spacing:0.18em;text-transform:uppercase;border-top:1px solid rgba(255,255,255,0.12);padding-top:6px;' +
      'display:flex;align-items:center;justify-content:space-between;gap:8px}' +
      '#panel .grp:first-of-type{border-top:none;margin-top:2px}' +
      '#panel .grpcopy{cursor:pointer;font-size:9px;font-weight:600;letter-spacing:0.1em;' +
      'color:#9fd;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.18);' +
      'border-radius:5px;padding:2px 8px;text-transform:uppercase}' +
      '#panel .grpcopy:hover{border-color:rgba(255,255,255,0.4)}';
    document.head.appendChild(st);
  }
  // Remove every .row except the play/restart row and the clock row (keep core
  // playback controls); the title (#title4) is not a .row so it stays.
  const keep = new Set();
  const playRow = el('play') && el('play').closest('.row');
  const clockRow = el('clock') && el('clock').closest('.row');
  if (playRow) keep.add(playRow);
  if (clockRow) keep.add(clockRow);
  Array.from(panel.querySelectorAll('.row')).forEach((r) => { if (!keep.has(r)) r.remove(); });

  // small section header — with a per-block "copy" button for its settings.
  const header = (text) => {
    const d = document.createElement('div');
    d.className = 'grp';
    const lab = document.createElement('span');
    lab.textContent = text;
    d.appendChild(lab);
    if (SECTION_FIELDS[text]) {
      const cp = document.createElement('button');
      cp.type = 'button';
      cp.className = 'grpcopy';
      cp.textContent = 'copy';
      cp.title = 'copy ' + text + ' settings';
      cp.addEventListener('click', (e) => { e.stopPropagation(); copyJSON(sectionBlob(text), cp, '✓'); });
      d.appendChild(cp);
    }
    panel.appendChild(d);
  };
  // one slider row → fmt(v) returns the readout string and applies the value.
  const addSlider = (label, min, max, step, value, fmt) => {
    const div = document.createElement('div');
    div.className = 'row';
    const lab = document.createElement('label'); lab.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = String(min); inp.max = String(max);
    inp.step = String(step); inp.value = String(value);
    const val = document.createElement('span'); val.className = 'val';
    const apply = () => { val.textContent = fmt(+inp.value); };
    inp.addEventListener('input', apply);
    div.appendChild(lab); div.appendChild(inp); div.appendChild(val);
    panel.appendChild(div);
    apply();
    return inp;
  };

  // ---- GLOBAL ----------------------------------------------------------------
  header('GLOBAL');
  addSlider('match spd', 1, 40, 0.2, tune.speed, (v) => { tune.speed = v; return v.toFixed(1) + '×'; });
  // grid res: one slider drives both axes (~16:9.6 ≈ 0.6 aspect). Rebuild on
  // release (change) since it re-allocates the mesh + textures.
  const gridS = addSlider('grid res', GX_MIN, GX_MAX, 2, GX, (v) => {
    const gx = clamp(v | 0, GX_MIN, GX_MAX);
    const gy = clamp(Math.round(gx * 0.6), GY_MIN, GY_MAX);
    return `${gx}×${gy}`;
  });
  gridS.addEventListener('change', () => {
    const gx = clamp(+gridS.value, GX_MIN, GX_MAX);
    const gy = clamp(Math.round(gx * 0.6), GY_MIN, GY_MAX);
    setResolution(gx, gy);
  });
  addSlider('steps', 4, 40, 1, tune.steps, (v) => { tune.steps = Math.round(v); return String(Math.round(v)); });
  addSlider('dim', 0, 0.4, 0.01, tune.dim, (v) => { tune.dim = v; return v.toFixed(2); });
  addSlider('half-time', 0.5, 8, 0.1, tune.htFade, (v) => { tune.htFade = v; return v.toFixed(1); });
  // SOLID BLOCK depth: how far the side walls drop below the relief to the base.
  addSlider('thickness', 0, 8, 0.1, tune.thickness, (v) => { tune.thickness = v; return v.toFixed(1); });

  // ---- H1 MACRO (REAL territorial dominance — no procedural waves) ------------
  header('H1 MACRO');
  // amplitude: height of the real dominance relief.
  addSlider('amplitude', 0, 10, 0.02, tune.macroAmp, (v) => { tune.macroAmp = v; return v.toFixed(2); });
  // speed: how fast the field reacts to momentum / decays-and-rebuilds (roll rate).
  addSlider('speed', 0, 3, 0.02, tune.macroSpeed, (v) => { tune.macroSpeed = v; return v.toFixed(2); });
  // smoothness: how heavily the dominance field is blurred (more = broader swells).
  addSlider('smoothness', 0, 1, 0.01, tune.macroSmooth, (v) => { tune.macroSmooth = v; return v.toFixed(2); });
  // scale: blur radius / spatial wavelength of the REAL field (fold size).
  addSlider('scale', 0.1, 6, 0.05, tune.macroScale, (v) => { tune.macroScale = v; return v.toFixed(2); });
  // (detail/octaves removed — it was harmonic decoration, no real data.)

  // ---- H2 POSSESSION (flood) -------------------------------------------------
  header('H2 POSSESSION');
  addSlider('amplitude', 0.2, 4, 0.02, tune.height, (v) => { tune.height = v; return v.toFixed(2); });
  addSlider('speed', 0.1, 3, 0.05, tune.possSpeed, (v) => { tune.possSpeed = v; return v.toFixed(2); });
  addSlider('smoothness', 0, 1, 0.01, tune.possSmooth, (v) => { tune.possSmooth = v; return v.toFixed(2); });
  addSlider('detail', 0, 1, 0.01, tune.possDetail, (v) => { tune.possDetail = v; return v.toFixed(2); });
  addSlider('hold', 0, 2, 0.05, tune.floodHold, (v) => { tune.floodHold = v; return v.toFixed(2); });
  addSlider('clear', 0, 8, 0.1, tune.floodClear, (v) => { tune.floodClear = v; return v.toFixed(2); });

  // ---- H3 DUELS --------------------------------------------------------------
  header('H3 DUELS');
  addSlider('amplitude', 0, 3, 0.05, tune.duels, (v) => { tune.duels = v; return v.toFixed(2); });
  addSlider('speed', 0.1, 3, 0.05, tune.duelSpeed, (v) => { tune.duelSpeed = v; return v.toFixed(2); });
  addSlider('smoothness', 0, 1, 0.01, tune.duelSmooth, (v) => { tune.duelSmooth = v; return v.toFixed(2); });
  addSlider('detail', 0, 1, 0.01, tune.duelDetail, (v) => { tune.duelDetail = v; return v.toFixed(2); });

  // ---- H4 SHOTS (3D stepped voxel arcs to goal) ------------------------------
  header('H4 SHOTS');
  // arc thickness = voxel cube size (world units).
  addSlider('thickness', 0.04, 0.5, 0.01, tune.shotThick, (v) => { tune.shotThick = v; return v.toFixed(2); });
  // arc height = apex-lift multiplier of the parabola.
  addSlider('arc height', 0.2, 3, 0.05, tune.shotArc, (v) => { tune.shotArc = v; return v.toFixed(2); });
  // strike height = how high the ball ends at the goal (real goalZ reach), independent of the apex.
  addSlider('strike height', 0, 2, 0.02, tune.shotHeight, (v) => { tune.shotHeight = v; return v.toFixed(2); });
  // ripple size = impact drop-ripple radius multiplier.
  addSlider('ripple', 0.2, 3, 0.05, tune.rippleSize, (v) => { tune.rippleSize = v; return v.toFixed(2); });
  // fade = how fast settled (non-goal) arcs dim.
  addSlider('fade', 0, 3, 0.05, tune.shotFade, (v) => { tune.shotFade = v; return v.toFixed(2); });
  // goal boost = extra cube size + brightness for GOAL arcs.
  addSlider('goal boost', 1, 3.5, 0.05, tune.goalBoost, (v) => { tune.goalBoost = v; return v.toFixed(2); });

  // ---- COPY SETTINGS (bottom of panel) --------------------------------------
  addCopySettingsButton();
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
  if (material) syncMaterialUniforms();
  // H4 SHOTS: scrub-safe — show ALL arcs up to `clock` in their SETTLED state
  // (advance shotTime well past the draw-on window so trails are fully drawn),
  // and clear in-flight ripples so a scrubbed frame shows only settled arcs.
  for (const r of ripplePool) { r.userData.active = false; r.visible = false; r.material.opacity = 0; }
  shotTime += 10;
  drawShots(clock);
  controls.update();
  renderer.render(scene, camera);
  updateHud();
  updateCamReadout();
};
