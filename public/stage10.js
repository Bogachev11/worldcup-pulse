// stage10.js — "LAYER CONSTRUCTOR" for France–Senegal (id 1953888).
//
// The user ASSEMBLES the visualization from independent, composable layers and
// tunes each one. The scene = a shared CLOTH whose height+colour are the sum of
// the enabled FIELD layers (A activity terrain, B pass relief), plus separate 3D
// objects for the point/accent layers (C live comet, D event accents). Each layer
// is on/off with its own SPEED (decay half-life) + DETAIL knobs.
//
// Scaffolding (three setup, cloth + onBeforeCompile, pitch plane, camera, HUD,
// post chain, colours, the REAL per-second timeline engine + ballAt/eventsNear)
// is cloned from stage9.js. ONLY real data — no mock, no procedural decoration.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { clamp, lerp, smoothstep } from './claybattle.js';

const ID = new URLSearchParams(location.search).get('id') || '1953888';
const el = (id) => document.getElementById(id);

// TEAM COLOURS — derived per match from the loaded timeline doc (home/away .color).
// FRA/SEN default fallbacks match the brief (#387ef0 / #0c954e); ICO/NOR (and any
// other match) get their own real data colours. Populated in init() from tlDoc, so
// switching matches via the tabs recolours the two blankets correctly.
let FRA_HEX = '#387ef0';   // home colour (fallback = France blue)
let SEN_HEX = '#0c954e';   // away colour (fallback = Senegal green)

// baked-in default camera (reuse stage9's tuned ракурс)
const DEFAULT_CAM = { pos: [-11.962, 18.664, 17.842], target: [-0.621, 1.826, 0.268] };
function applyDefaultCamera() {
  camera.position.set(DEFAULT_CAM.pos[0], DEFAULT_CAM.pos[1], DEFAULT_CAM.pos[2]);
  controls.target.set(DEFAULT_CAM.target[0], DEFAULT_CAM.target[1], DEFAULT_CAM.target[2]);
  controls.update();
}

// ---- pitch / mesh dims ------------------------------------------------------
const WORLD_X = 16, WORLD_Z = 9.6;       // pitch footprint
// the blanket meshes (smooth) — sampled from the low-res field grids.
const GX = 160, GY = 96;
const VX = GX + 1, VY = GY + 1, NV = VX * VY;

const worldX = (u) => (u - 0.5) * WORLD_X;
const worldZ = (v) => (0.5 - v) * WORLD_Z;

// ---- scene state ------------------------------------------------------------
let renderer, scene, camera, controls, composer;
let bloomPass, gradePass, smaaPass;
let keyLight;
let pitchPlane, pitchMat;
// TRUE top-A-surface world-Y per vertex (mesh res) — the height of whichever blanket
// sheet is VISIBLE (laps on top) at each cell, INCLUDING base drape + cloth wobble +
// focus hill + xG spire + the seam LIP fold + BLANKET_LIFT, in the SAME world units
// the blanket vertex shader renders. B/C/D ride this so they sit on the wave we see.
// Built from the SMOOTHED A fields (same as rendering) → no jitter relative to the
// surface; snapped with the rest on scrub.
let surfYData = null, surfTopH = null, surfTopDu = null;
let timeline = null;                        // merged, mirrored, real-t event stream
let ballLocus = null;                       // locus anchors for ballAt()
let teamMeta = { home: { abbr: 'FRA' }, away: { abbr: 'SEN' }, score: { home: 0, away: 0 }, duration: 100 };

let clock = 0, playing = true;
let wallProgress = 0;   // 0..1 across one ~15s dramatic pass; drives the warped clock

const COL_HOME = new THREE.Color(FRA_HEX);
const COL_AWAY = new THREE.Color(SEN_HEX);
const teamColor = (team) => (team === 'away' ? COL_AWAY : COL_HOME);

// GOAL-FLOOD phase durations in SECONDS of wall time (see goalFloodAt). Declared
// here so DEFAULTS() can seed cfg.A.floodHold without a temporal-dead-zone error.
const FLOOD_SWEEP_S = 0.5, FLOOD_RELAX_S = 2.0, FLOOD_HOLD_DEFAULT_S = 1.8;

// ============================================================================
// CONFIG — every layer's enable flag + its own knobs. This whole object is what
// gets serialised to the URL hash / COPY CONFIG and restored from a preset.
// ============================================================================
const DEFAULTS = () => ({
  // 1.0 = the intended ~15s dramatic-time pass (DRAMA_TOTAL_S). The slider is now a
  // global tempo trim on that pass, not a linear match-minute rate.
  speed: 1.0,
  // A · TWO TEAM BLANKETS (одеяла) — one cloth per team, meeting at an
  //  activity-shaped front with a small НАХЛЁСТ overlap. Height per team = amplitude
  //  · Σ ENABLED contributors through the asymmetric atk/rel envelope on the grid.
  //  height=amplitude, atk=attack/rise τ, rel=release/decay τ, grid=detail,
  //  blur=smoothing, colour=intensity, sharp=hill contrast/gamma, floor=threshold,
  //  lap=НАХЛЁСТ ▸ глубина (finite OVERLAP depth, fraction of pitch length: each
  //  opaque sheet tucks this far PAST the front under the other). cOWN..cALL =
  //  contributor on/off; wOWN..wALL = weights.
  A: {
    on: true, open: false, atk: 0.15, rel: 1.6, grid: 0.45, height: 3.0,
    colour: 1.0, blur: 0.75, sharp: 1.0, floor: 0.0, lap: 0.04,
    // КРОМКА ▸ подъём — LIP HEIGHT (world-Y) of the fabric fold where the TOP
    // blanket laps OVER the under one at the seam. A SHORT, thin folded edge so the
    // two blankets read as two separate sheets (one over the other) WITHOUT a tall
    // wall that would cross through a hill near the front. The possessor laps on top.
    // 0 = flush (no lap), ~0.1 = a thin clean fold, up to 0.35 = a deeper lap.
    lipH: 0.1,
    // МИН. ТЕРРИТОРИЯ ▸ у ворот — each team ALWAYS keeps a guaranteed band of
    // ownership around ITS OWN goal line (home own-goal at u≈0, away at u≈1), so
    // the opponent can never take the whole pitch in normal play. The contested
    // front lives between the two bands and can be pushed deep, but never erases
    // the defender's band. Fraction of pitch LENGTH per team. Overridden only by
    // the celebratory goal-flood. 0 = no guaranteed band (old behaviour).
    ownBand: 0.13,
    // ЯРКОСТЬ ЦВЕТА — emissive strength of the FLAT painted territory. The
    // coverage colour lies flat on the pitch (no tall body), so under scene
    // lighting it would render dark; this glow term makes it read VIVID team
    // colour regardless of height. 0 = lit only, ~1 = strong glow.
    glow: 1.0,
    // xG SPIRE (kept — but ONLY at real shots). xgW = spire WIDTH (scales the xG
    // stamp radius), xgH = spire HEIGHT (scales the crest term). The spire stands
    // at each REAL shot's pitch spot and fades a couple seconds after; NO spire
    // appears anywhere there was no shot.
    xgW: 1.0, xgH: 1.0,
    // ФОКУС ▸ зона игры — radius of the spatial focus mask that anchors the
    // HEIGHT relief to the single live play locus (ballAt(t)). Tight = one
    // coherent swell where play is; wide → approaches the old free-form field.
    // Colour/coverage stay BROAD; only height is gated. 0..1 → σ in world units.
    focus: 0.2,
    // ГОЛ ▸ держать заливку — how long the celebratory goal-flood HOLDS the
    // scorer's colour over the whole pitch, in SECONDS of wall time (at the
    // current speed). Default 3s (was ~1.2). Sweep-in/relax are fixed.
    floodHold: FLOOD_HOLD_DEFAULT_S,
    // ГОЛ ▸ ПАУЗА (штиль после гола) — after the flood recedes, a LONGER calm
    // breather where the colour settles AND the relief flattens toward ~0 (the
    // surface "выпрямилось, обнулилось") for this many SECONDS of wall time, then
    // normal play resumes. Coordinated with the dramatic clock so the goal beat
    // gets its room. 0 = no post-goal lull (old behaviour).
    lull: 1.2,
    // ВЫПАД ▸ сила — THRUST FINGER strength. A FAST FORWARD pass by the attacking
    // team makes the colour front STAB FORWARD as a sharp, narrow FINGER of that
    // team's colour into the opponent half (in the PLANE of the blanket — the
    // front(v) boundary moving forward, NOT a vertical height peak). Forward
    // distance (endX−x in the team's attacking frame) is the primary signal, boosted
    // for through/long balls and for passes that gain ground QUICKLY (fast counter).
    // The finger appears almost immediately and decays on its OWN fast half-life
    // (~few seconds), so an unsustained foray recedes fast while a sustained attack
    // lets the SLOW territorial base catch up and consolidate. 0 = off (front stays
    // the smooth lateral tide). Default keeps counters clearly visible but not noisy.
    thrust: 1.0,
    // contributors (☑ default = true): which signals RAISE a team's blanket.
    // The general relief (Владение/Продвижение/…) is now capped to GENTLE LOW
    // MOUNDS — the ONLY tall spires in the scene are the real xG shot crests
    // (cXg, placed exactly at each shot's pitch spot; see contribLift/computeA).
    cOwn: true,  wOwn: 1.0,   // Владение — on-ball control density
    cXg: true,   wXg: 1.0,    // Удары · xG — sharp tall crest at the REAL shot spot, ×xg
    cProg: true, wProg: 1.0,  // Продвижение — final-third / box entries, forward passes
    cPass: false, wPass: 1.0, // Пасы — pass density
    cDuel: false, wDuel: 1.0, // Единоборства — Tackle/Aerial/Challenge/Interception/Dispossessed
    cDrib: false, wDrib: 1.0, // Обводки — TakeOn
    cAll: false,  wAll: 1.0,  // Общая активность — all events
  },
  // B · pass relief (fine overlay)
  //  height=amplitude, atk=attack/rise τ, rel=release/decay τ, aggr=aggregation,
  //  longw=long-pass weight, opacity=intensity, sharp=contrast/gamma.
  B: { on: true, open: false, atk: 0.12, rel: 1.2, aggr: 0.5, height: 0.6, longw: 0, opacity: 1.0, sharp: 1.0 },
  // C · live locus comet
  //  hop=amplitude (ride height), size=orb size, trail=trail length (min),
  //  twidth=trail width, bright=brightness, fade=trail fade.
  C: { on: true, open: false, trail: 0.5, size: 1.0, bright: 1.0, hop: 1.0, twidth: 1.0, fade: 1.0 },
  // D · event accents
  //  amp=shot-spike amplitude, beam=beam length to goal, spark=duel spark size,
  //  marker=corner/foul marker size, fade=lifetime, + per-type sub-toggles.
  D: { on: true, open: false, amp: 1.0, beam: 1.0, spark: 1.0, marker: 1.0, fade: 1.0, shots: true, duels: true, corners: true, fouls: true },
});
let cfg = DEFAULTS();

// the "Матч" combo is the default startup state (A+B+C+D all on).
const MATCH_DEFAULT = () => DEFAULTS();

// ---- boot -------------------------------------------------------------------
init().catch((e) => fail(e.message || String(e)));

async function init() {
  if (!window.WebGLRenderingContext) throw new Error('WebGL not available');

  // load precedence: URL #cfg= (explicit share link) > saved localStorage
  // (user's SAVE) > built-in "Матч" default.
  cfg = loadCfgFromHash() || loadCfgFromStore() || MATCH_DEFAULT();

  let tlDoc = null;
  try { tlDoc = await fetch('/api/timeline/' + ID).then((r) => (r.ok ? r.json() : null)); } catch { tlDoc = null; }
  if (!tlDoc || !Array.isArray(tlDoc.events) || !tlDoc.events.length) {
    throw new Error('timeline ' + ID + ' missing (need /api/timeline/' + ID + ')');
  }
  teamMeta.home = tlDoc.home || teamMeta.home;
  teamMeta.away = tlDoc.away || teamMeta.away;
  teamMeta.duration = Number.isFinite(tlDoc.fullT) ? tlDoc.fullT : 100;
  // Per-match REAL team colours (FRA/SEN default fallbacks). Set BEFORE buildCloth so
  // the two blankets are constructed with the right colours; also update COL_HOME/AWAY.
  const isHex = (s) => typeof s === 'string' && /^#?[0-9a-fA-F]{6}$/.test(s);
  if (isHex(teamMeta.home.color)) FRA_HEX = teamMeta.home.color;
  if (isHex(teamMeta.away.color)) SEN_HEX = teamMeta.away.color;
  COL_HOME.set(FRA_HEX); COL_AWAY.set(SEN_HEX);
  timeline = buildTimelineFromDoc(tlDoc);
  ballLocus = buildBallLocus(timeline);
  countGoals();
  buildDramaticClock();      // importance curve I(t) + warped playback mapping W(t)

  setupThree();
  buildCloth();
  setupComposer();
  bindGlobalUI();
  buildLayerUI();
  setupHudLayout();

  el('hAbbr').textContent = teamMeta.home.abbr || 'FRA';
  el('aAbbr').textContent = teamMeta.away.abbr || 'SEN';
  document.documentElement.style.setProperty('--home-color', FRA_HEX);
  document.documentElement.style.setProperty('--away-color', SEN_HEX);
  el('title2').textContent =
    `STAGE 10 · ${teamMeta.home.abbr} ${teamMeta.score.home}–${teamMeta.score.away} ${teamMeta.away.abbr}`;

  syncCfgToUI();
  window.addEventListener('resize', onResize);
  onResize();
  requestAnimationFrame(loop);
}

function fail(msg) {
  const t = el('title2'); if (t) t.textContent = 'STAGE 10 · failed: ' + msg;
  const o = document.createElement('div');
  o.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'color:#f88;font:14px system-ui;text-align:center;padding:40px;z-index:99;background:#04050a;white-space:pre-wrap';
  o.textContent = 'CONSTRUCTOR could not start: ' + msg;
  document.body.appendChild(o);
}

// ============================================================================
// THREE setup (cloned from stage9)
// ============================================================================
function setupThree() {
  const canvas = el('stage');
  renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = makeGradientTexture();
  scene.fog = new THREE.FogExp2(0x05070d, 0.035);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(DEFAULT_CAM.pos[0], DEFAULT_CAM.pos[1], DEFAULT_CAM.pos[2]);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 4;
  controls.maxDistance = 36;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.target.set(DEFAULT_CAM.target[0], DEFAULT_CAM.target[1], DEFAULT_CAM.target[2]);

  keyLight = new THREE.DirectionalLight(0xffffff, 3.1);   // stage7: 1.0 + light(0.7)*3.0
  keyLight.position.set(-9, 14, 7);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.camera.near = 1; keyLight.shadow.camera.far = 60;
  const sc = keyLight.shadow.camera;
  sc.left = -14; sc.right = 14; sc.top = 12; sc.bottom = -12; sc.updateProjectionMatrix();
  keyLight.shadow.bias = -0.0008; keyLight.shadow.normalBias = 0.04; keyLight.shadow.radius = 6;
  scene.add(keyLight, keyLight.target);

  scene.add(new THREE.DirectionalLight(0x9fc0ff, 0.6).translateX(8).translateY(5).translateZ(-7));
  const rim = scene.children[scene.children.length - 1]; rim.position.set(8, 5, -7);
  scene.add(new THREE.HemisphereLight(0x6f86b0, 0x0a0d16, 0.47));   // stage7: 0.25 + amb(0.16)*1.4
}

function makeGradientTexture() {
  const c = document.createElement('canvas'); c.width = 16; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.0, '#0a1020'); grad.addColorStop(0.55, '#070a12'); grad.addColorStop(1.0, '#020308');
  g.fillStyle = grad; g.fillRect(0, 0, 16, 256);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; return tex;
}

// ============================================================================
// SCENE BUILD — the ONLY field layer is A (the two team blankets). Layers B
// (пасы), C (мяч/comet) and D (события) were REMOVED ("убрать, пока вообще не
// нужны"): no shared B cloth mesh, no comet, no event accents. We still allocate
// the per-vertex surface buffers below because computeField uses surfTop* to build
// the true blanket surface world-Y (surfYData) each frame.
// ============================================================================
function buildCloth() {
  surfYData = new Float32Array(NV);          // true top-A-surface world-Y per vertex
  surfTopH = new Float32Array(NV);           // visible top sheet's displaced height (pre-baseline/lip)
  surfTopDu = new Float32Array(NV);          // signed seam distance (u-units) at each vertex, for the lip fold

  buildTeamBlankets();
  buildPitchPlane();
}

// ============================================================================
// A · TWO TEAM BLANKETS — one full-pitch cloth per team. Each has its own height
// texture (from its enabled contributors) and a coverage(alpha) texture (crisp
// front from local presence share, extended by НАХЛЁСТ so the two laps overlap).
// Solid team colour where covered, transparent where the opponent owns. The
// taller team's sheet laps ON TOP (set per-frame via renderOrder).
// ============================================================================
let blankets = null;  // { home:{mesh,hData,hTex,aData,aTex,u}, away:{...} }
function makeBlanket(teamCol, isAway) {
  const geo = new THREE.PlaneGeometry(WORLD_X, WORLD_Z, GX, GY);
  geo.rotateX(-Math.PI / 2);
  const hData = new Float32Array(NV);
  const hTex = new THREE.DataTexture(hData, VX, VY, THREE.RedFormat, THREE.FloatType);
  hTex.magFilter = THREE.LinearFilter; hTex.minFilter = THREE.LinearFilter; hTex.needsUpdate = true;
  const aData = new Float32Array(NV);    // coverage alpha 0..1
  const aTex = new THREE.DataTexture(aData, VX, VY, THREE.RedFormat, THREE.FloatType);
  aTex.magFilter = THREE.LinearFilter; aTex.minFilter = THREE.LinearFilter; aTex.needsUpdate = true;

  // OPAQUE sheets: no alpha blending (the old alpha НАХЛЁСТ caused the ugly blur).
  // The seam is a HARD discard (alphaTest 0.5) inside the shader, and depth-test +
  // the per-sheet owner LIP resolve which sheet laps on top — no transparency sort,
  // no z-fighting.
  const mat = new THREE.MeshStandardMaterial({
    // STAGE-7 PBR TUNE — roughness~1.0 / metalness~0.81 / envMapIntensity~1.24 so the
    // clay reads as matte stone lit by the IBL, not plastic.
    color: 0xffffff, roughness: 1.0, metalness: 0.81, envMapIntensity: 1.24,
    transparent: false, alphaTest: 0.5, depthWrite: true, depthTest: true,
    side: THREE.DoubleSide,
    // tiny opposite-sign depth bias so that at the exact seam line (du=0, where the
    // owner lips momentarily tie) ONE sheet deterministically wins the depth test —
    // kills the measure-zero z-fight shimmer without affecting the lap elsewhere.
    polygonOffset: true,
    polygonOffsetFactor: isAway ? 0.5 : -0.5,
    polygonOffsetUnits: isAway ? 0.5 : -0.5,
  });
  const u = {
    uHeight: { value: hTex }, uCov: { value: aTex },
    uTexel: { value: new THREE.Vector2(1 / VX, 1 / VY) },
    uBaseline: { value: 0 }, uWorld: { value: new THREE.Vector2(WORLD_X, WORLD_Z) },
    uTeam: { value: new THREE.Color(teamCol) },
    uGlow: { value: 1.0 },     // ЯРКОСТЬ ЦВЕТА — emissive strength of flat territory
    // НАХЛЁСТ ▸ глубина — finite OVERLAP depth (fraction of pitch length, u-units).
    // Each opaque sheet covers its own side AND extends this far PAST the front into
    // the opponent's territory, then ends with a clean ~1px-AA cutoff that tucks
    // UNDER the other sheet. The coverage texture stores the per-channel FRONT u, so
    // the shader works in honest u-units (overlap is directly the pitch fraction).
    uLap: { value: 0.06 },
    // КРОМКА — world-Y height of the fold by which THIS sheet, WHEN IT IS THE TOP
    // sheet, laps OVER the under sheet at the seam. uTop is the smoothed 0..1
    // "this sheet is on top right now" state (the possessor laps over); it eases
    // between 0 and 1 over ~0.4s so the top/bottom choice never flickers per frame.
    uLipH: { value: 0.1 },
    uTop: { value: isAway ? 0.0 : 1.0 },
    uAway: { value: isAway ? 1.0 : 0.0 },  // 1 = this sheet owns u>front (away half)
    // ---- STAGE-7 CLAY/STONE MATERIAL LOOK (faithfully ported) ---------------
    // A believable clay/stone base (uClay) TINTED by this sheet's team colour
    // (uTeam), with natural saturation (uSat), a subtle clay micro-texture
    // (uTex) that also modulates roughness, a tactile HEX surface PATTERN
    // (uPattern=4 "гексагончики" — uDetail depth, uDetailScale density, with
    // cavity-AO + micro-normal so it reads as real recessed volume), and a gentle
    // fiery ember (uGlowCol × real match intensity uIntensity). Values are
    // stage7's tuned defaults. CRITICAL: NONE of these are driven by height (vHd);
    // the material is UNIFORM regardless of relief → no zero→non-zero band.
    uClay: { value: new THREE.Color('#6a6560') },  // neutral clay/stone base
    uSat: { value: 0.86 },                          // natural saturation (no neon)
    uTint: { value: 1.0 },                          // how strongly clay is tinted by team
    uTex: { value: 0.86 },                          // clay micro-texture amount
    uGlowCol: { value: new THREE.Color('#f0d8c1') }, // ember crest colour
    uEmber: { value: 1.0 },                          // ember crest strength (stage7 glow feel)
    uIntensity: { value: 0 },                        // REAL match intensity → gentle ember
    uWobble: { value: 0.42 },                        // stage7 seam-warp meander (unused for the colour band; kept for parity)
    uAO: { value: 0.42 },                            // stage7 cavity/curvature AO amount
    uDetail: { value: 1.1 },                         // HEX pattern depth/strength (stage7)
    uDetailScale: { value: 2.58 },                   // HEX pattern density/frequency (stage7)
    uPattern: { value: 4 },                          // 4 = HEX ("гексагончики") — the stage7 look
    uTime: { value: 0 },                            // animates micro-texture + ember flicker
  };
  mat.userData.u = u;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = `
      uniform sampler2D uHeight; uniform sampler2D uCov; uniform vec2 uTexel;
      uniform float uBaseline; uniform vec2 uWorld;
      uniform float uLap; uniform float uLipH; uniform float uTop; uniform float uAway;
      varying float vHd; varying vec2 vUvN; varying float vDu; varying float vFold;
      float HB(vec2 uv){ float h = texture2D(uHeight, uv).r; if(!(h==h)) h=0.0; return h; }
      float FRONT(vec2 uv){ float f = texture2D(uCov, uv).r; if(!(f==f)) f=0.5; return f; }
      // FABRIC FOLD — only the TOP sheet (uTop→1) gets a SHORT, LOCAL lip right at
      // the seam so it laps OVER the under sheet. NOT a broad raised ridge across the
      // whole overlap and NOT a tall wall: a thin folded edge localised to the
      // boundary, tapering to flat on BOTH sides over a small fixed width so it never
      // crosses through the other sheet's hill. The under sheet (uTop→0) gets none
      // and continues flat beneath. du>0 = away half; s = signed dist into OWN half.
      float FOLD(float du){
        float s = mix(-du, du, uAway);                  // + = own side, − = lapped onto opponent
        // Fold WIDTH (the visible кромка length) tracks the НАХЛЁСТ ▸ глубина slider
        // (uLap) so the user controls how long the lapping edge is. Kept SHORT.
        float fw = max(uLap * 0.6, 0.001);               // fold half-width (own side)
        float ow = max(uLap * 0.4, 0.001);               // shorter taper on the lapped tip
        // 1 in a thin band straddling the seam, falling off quickly each way.
        float own  = 1.0 - smoothstep(0.0, fw, s);      // own side: drop off just past the line
        float opp  = smoothstep(-ow, 0.0, s);           // opponent side: taper the tip so no tall wall
        return clamp(min(own, opp + step(0.0, s)), 0.0, 1.0); // full for small +s, tapered for −s
      }
    ` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>
        vUvN = uv;
        float hl = HB(uv - vec2(uTexel.x,0.0)); float hr = HB(uv + vec2(uTexel.x,0.0));
        float hd = HB(uv - vec2(0.0,uTexel.y)); float hu = HB(uv + vec2(0.0,uTexel.y));
        float dx = (uWorld.x*uTexel.x)*2.0; float dz = (uWorld.y*uTexel.y)*2.0;
        objectNormal = normalize(vec3(-(hr-hl)/max(dx,1e-4), 1.0, -(hu-hd)/max(dz,1e-4)));`);
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
      `#include <begin_vertex>
        float hb = HB(uv);
        float frnt = FRONT(uv);
        vDu = uv.x - frnt;                 // signed dist from seam in u-units (+ = away half)
        vHd = hb;
        // The TOP sheet folds UP by uLipH near the seam (× smoothed uTop); the under
        // sheet gets no lip and lies beneath. Each sheet keeps its OWN relief (hb),
        // so they are TWO distinct surfaces — the lip is the visible lap, not a merge.
        vFold = uTop * FOLD(vDu);
        transformed.y += (hb - uBaseline) + uLipH * vFold;`);
    shader.fragmentShader = `
      uniform vec3 uTeam; uniform float uGlow;
      uniform float uLap; uniform float uAway; uniform float uTop;
      // STAGE-7 material uniforms (clay tint + sat + micro-texture + HEX pattern + ember)
      uniform vec3 uClay; uniform float uSat; uniform float uTint; uniform float uTex;
      uniform vec3 uGlowCol; uniform float uEmber; uniform float uIntensity;
      uniform float uWobble; uniform float uAO;
      uniform float uDetail; uniform float uDetailScale; uniform float uPattern;
      uniform float uTime;
      varying float vHd; varying vec2 vUvN; varying float vDu; varying float vFold;
      // --- stage7 smooth value-noise + fbm (continuous → stable derivatives,
      //     no firefly speckle) for the clay micro-texture ---
      float h21_s10(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
      float vn_s10(vec2 p){
        vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        float a=h21_s10(i), b=h21_s10(i+vec2(1,0)), c=h21_s10(i+vec2(0,1)), d=h21_s10(i+vec2(1,1));
        return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
      }
      float fbm_s10(vec2 p){
        float s=0.0, a=0.5;
        for (int k=0;k<4;k++){ s += a*vn_s10(p); p = p*2.03 + vec2(11.3,7.7); a *= 0.5; }
        return s;
      }
      // STAGE-7 FINE VOLUMETRIC SURFACE PATTERN — a tactile relief HEIGHT in [0,1].
      // Built ONLY from continuous primitives so its screen-space derivative is smooth
      // → a stable bump WITHOUT firefly speckle. Default uPattern=4 = HEX ("гексагончики").
      const float PI_s10 = 3.14159265;
      float pat_s10(vec2 p){
        if (uPattern < 0.5) {            // GRID
          float lx = abs(sin(PI_s10 * p.x));
          float ly = abs(sin(PI_s10 * p.y));
          return smoothstep(0.0, 0.45, min(lx, ly));
        } else if (uPattern < 1.5) {     // WEAVE
          return 0.5 + 0.5 * sin(p.x * 6.2831853) * sin(p.y * 6.2831853);
        } else if (uPattern < 2.5) {     // LINES
          return 0.5 + 0.5 * sin(p.y * 6.2831853);
        } else if (uPattern < 3.5) {     // DOTS
          return (0.5 + 0.5*cos(p.x*6.2831853)) * (0.5 + 0.5*cos(p.y*6.2831853));
        } else if (uPattern < 4.5) {     // HEX-ish — three rotated sine waves
          float a = sin(p.x*6.2831853);
          float b = sin((p.x*0.5 + p.y*0.8660254)*6.2831853);
          float c = sin((p.x*0.5 - p.y*0.8660254)*6.2831853);
          return clamp(0.5 + 0.22*(a+b+c), 0.0, 1.0);
        }
        return fbm_s10(p * 0.9);         // GRAIN
      }
      // OPAQUE finite-overlap coverage. vDu = u − front(v) (u-units). This sheet
      // covers its OWN side fully AND extends uLap past the front into the
      // opponent's half, then ends with a clean ~1px-AA cutoff (NOT a soft gradient).
      // Home (uAway=0) owns du<0, covers up to du = +uLap. Away owns du>0, covers
      // down to du = −uLap. So the band [−uLap,+uLap] is covered by BOTH (no gap),
      // and the cutoff is razor-sharp so there is no blur. Returns coverage 0..1.
      float covAt(){
        // distance from THIS sheet's far cutoff edge (positive = inside coverage).
        float d = mix(uLap - vDu, vDu + uLap, uAway);   // home: uLap−du ; away: du+uLap
        // ~1px-in-u razor edge, but CLAMP the AA half-width to a tiny ceiling. On a
        // steep hill face viewed edge-on, fwidth(vDu) explodes and would widen the
        // cutoff into a discard zone deep inside coverage → a BLACK HOLE behind the
        // hill. Capping keeps the edge a thin AA line and never over-discards.
        float aa = clamp(fwidth(vDu), 1e-4, 0.01);
        return clamp(smoothstep(-aa, aa, d), 0.0, 1.0);
      }
    ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>',
      `#include <color_fragment>
      {
        // STAGE-7 CLAY/STONE LOOK, kept SINGLE-TEAM (no cross-team mix — territories
        // stay crisp). The surface is a believable clay/stone (uClay) TINTED by THIS
        // sheet's team colour. CRITICAL: the tint is UNIFORM across the territory and
        // does NOT depend on height (vHd). Flat cloth and raised cloth are the SAME
        // clay+team+hex material, so there is NO visible zero→non-zero colour band.
        vec3 team = uTeam;
        // gentle saturation control (natural, not neon) — stage7 uSat.
        float lum = dot(team, vec3(0.299, 0.587, 0.114));
        team = max(mix(vec3(lum), team, uSat), 0.0);
        // UNIFORM tint — same everywhere on the sheet (no relief term). stage7 tint.
        float tintAmt = clamp(uTint, 0.0, 1.0);
        vec3 col = mix(uClay, team, tintAmt);
        // subtle clay micro-texture, amount = uTex (stage7 marble fbm). Kills the
        // plastic flat-matte look without speckle (continuous fbm).
        float marble = fbm_s10(vUvN * 22.0 + vec2(0.0, uTime * 0.05));
        col *= (1.0 - 0.5 * uTex) + uTex * marble;
        // STAGE-7 CAVITY AO from the HEX pattern: the pattern grooves (low pat)
        // sink into shadow so the "гексагончики" lattice reads as real recessed
        // volume, not a decal. Same for both sheets, uniform in height.
        float pc = pat_s10(vUvN * (46.0 * uDetailScale));
        float cavity = 1.0 - uDetail * 0.5 * (1.0 - pc);
        col *= clamp(cavity, 0.3, 1.0);
        // CONTACT SHADOW on the UNDER sheet: where THIS sheet is the under one
        // (uTop→0), darken the strip that lies BENEATH the top sheet's raised lip —
        // i.e. across the overlap band near the seam — so the top sheet's lapping
        // edge casts onto the fabric below it and reads as one sheet lying over the
        // other. Strongest right under the seam, fading out beyond the overlap. None
        // on the top sheet itself.
        float dist = abs(vDu);                              // distance from seam (u-units)
        float band = 1.0 - smoothstep(0.0, max(uLap*1.6, 0.04), dist);
        float shadow = (1.0 - uTop) * band;
        col *= mix(1.0, 0.40, shadow);
        diffuseColor.rgb = col;
        float covEff = covAt();
        diffuseColor.a *= covEff;
      }`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>',
      `if (diffuseColor.a < 0.5) discard;     // OPAQUE: hard binary cut, no alpha blur
       #include <alphatest_fragment>`);
    // STAGE-7 MICRO-ROUGHNESS: modulate roughnessFactor by the same fine clay
    // micro-relief so some patches read duller/shinier. Uniform roughness is the
    // #1 CG/plastic tell — breaking it up gives the rich material look.
    shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
       {
         // STAGE-7 MICRO-ROUGHNESS: the HEX pattern grooves read slightly ROUGHER
         // (matte recess) than the raised cells; floor kept well above 0 so nothing
         // turns shiny. Uniform in height → no plastic tell, no band.
         float pr = pat_s10(vUvN * (46.0 * uDetailScale));
         roughnessFactor = clamp(roughnessFactor + uDetail * 0.22 * (0.5 - pr), 0.16, 1.0);
       }`);
    // STAGE-7 MICRO-NORMAL: perturb the shading normal by the screen-space gradient
    // of the SMOOTH HEX pattern height, so grazing IBL catches the fine hex relief and
    // it feels like real clay/stone, not smooth CG plastic. Continuous pat → stable.
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
       {
         float amp = uDetail * 0.3;
         if (amp > 0.0001) {
           vec2 mp = vUvN * (46.0 * uDetailScale);
           float hC = pat_s10(mp);
           vec3 dpdx = dFdx(-vViewPosition);
           vec3 dpdy = dFdy(-vViewPosition);
           float dhx = dFdx(hC);
           float dhy = dFdy(hC);
           vec3 r1 = cross(dpdy, normal);
           vec3 r2 = cross(normal, dpdx);
           float det = dot(dpdx, r1);
           vec3 surfGrad = (abs(det) > 1e-8) ? (dhx * r1 + dhy * r2) / det : vec3(0.0);
           surfGrad = clamp(surfGrad, vec3(-4.0), vec3(4.0));
           normal = normalize(normal - amp * surfGrad);
         }
       }`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
       {
         // Contact-shadow damp on the UNDER sheet's seam strip (unchanged).
         float dist = abs(vDu);
         float band = 1.0 - smoothstep(0.0, max(uLap*1.6, 0.04), dist);
         float shadow = (1.0 - uTop) * band;
         float litMul = mix(1.0, 0.40, shadow);
         // GENTLE TEAM-COLOUR GLOW FLOOR — the territory lies FLAT on the pitch, so lit
         // shading alone would render it dark. A modest, UNIFORM team-hue emissive keeps
         // the field readable as its team colour. CRITICAL: this floor is the SAME at
         // every height (no vHd term) → flat and raised cloth glow identically, so there
         // is NO zero→non-zero emissive band.
         vec3 emit = uTeam * (0.34 * uGlow) * litMul;
         // STAGE-7 GENTLE EMBER — a subtle warm crest glow, tied to REAL match intensity
         // (uIntensity) like stage7, only on the steep faces of the TALL xG spires (not
         // the gentle mounds, whose relief stays below the smoothstep floor). Kept low so
         // it reads as a gentle stage7 ember, never a strong plastic per-height glow.
         vec3 Nw = normalize(vNormal);
         float steep = 1.0 - clamp(Nw.y, 0.0, 1.0);
         float hot = smoothstep(1.2, 3.0, vHd) * smoothstep(0.14, 0.6, steep);
         float flick = 0.82 + 0.18 * vn_s10(vUvN * 40.0 + uTime * 0.7);
         float ember = uEmber * mix(0.18, 1.0, clamp(uIntensity, 0.0, 1.0));
         vec3 hi = uGlowCol * (1.0 + smoothstep(2.0, 3.6, vHd) * 0.5);
         emit += hi * hot * ember * 0.9 * flick * litMul;
         totalEmissiveRadiance += emit;
       }`);
  };
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true; m.receiveShadow = true;
  scene.add(m);
  return { mesh: m, hData, hTex, aData, aTex, u };
}
function buildTeamBlankets() {
  blankets = { home: makeBlanket(FRA_HEX, false), away: makeBlanket(SEN_HEX, true) };
}

// ---- STATIC PITCH-MARKINGS PLANE at y=0 (from stage9) -----------------------
function buildPitchPlane() {
  const geo = new THREE.PlaneGeometry(WORLD_X, WORLD_Z, 1, 1);
  geo.rotateX(-Math.PI / 2);
  // Lines kept in the OPAQUE pass (transparent:false) with depthTest+depthWrite so they
  // participate honestly in the depth buffer and WEAVE through the relief: cloth above
  // y=0 occludes them, cloth below shows them on top. Mild transparency for line AA is
  // still allowed, but depth is written so the interplay is real.
  pitchMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: true, depthTest: true, side: THREE.DoubleSide,
    uniforms: { uLines: { value: 0.6 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: PITCH_FRAG,
  });
  pitchPlane = new THREE.Mesh(geo, pitchMat);
  pitchPlane.position.y = 0.0; pitchPlane.renderOrder = 0;
  scene.add(pitchPlane);
}

const PITCH_FRAG = `
  precision highp float; uniform float uLines; varying vec2 vUv;
  const float PL = 105.0; const float PW = 68.0;
  float seg7(vec2 puv, vec2 a, vec2 b, float halfW){
    vec2 P = vec2(puv.x*PL, puv.y*PW); vec2 ab = b-a, ap = P-a;
    float t = clamp(dot(ap,ab)/max(dot(ab,ab),1e-5),0.0,1.0); float d = length(P-(a+t*ab));
    float aa = (fwidth(P.x)+fwidth(P.y))*0.5+1e-4; return 1.0 - smoothstep(halfW, halfW+aa, d); }
  float rect7(vec2 puv, vec2 lo, vec2 hi, float halfW){ float c=0.0;
    c=max(c,seg7(puv,vec2(lo.x,lo.y),vec2(hi.x,lo.y),halfW)); c=max(c,seg7(puv,vec2(hi.x,lo.y),vec2(hi.x,hi.y),halfW));
    c=max(c,seg7(puv,vec2(hi.x,hi.y),vec2(lo.x,hi.y),halfW)); c=max(c,seg7(puv,vec2(lo.x,hi.y),vec2(lo.x,lo.y),halfW)); return c; }
  float ring7(vec2 puv, vec2 cen, float r, float halfW){ vec2 P = vec2(puv.x*PL, puv.y*PW);
    float d = abs(length(P-cen)-r); float aa = (fwidth(P.x)+fwidth(P.y))*0.5+1e-4; return 1.0 - smoothstep(halfW, halfW+aa, d); }
  float dot7(vec2 puv, vec2 cen, float r){ vec2 P = vec2(puv.x*PL, puv.y*PW);
    float d = length(P-cen); float aa = (fwidth(P.x)+fwidth(P.y))*0.5+1e-4; return 1.0 - smoothstep(r, r+aa, d); }
  float pitchLines7(vec2 uv){ float hw=0.10; float inset=1.6; vec2 lo=vec2(inset,inset); vec2 hi=vec2(PL-inset,PW-inset);
    float c=0.0; c=max(c,rect7(uv,lo,hi,hw)); c=max(c,seg7(uv,vec2(PL*0.5,lo.y),vec2(PL*0.5,hi.y),hw));
    c=max(c,ring7(uv,vec2(PL*0.5,PW*0.5),9.15,hw)); c=max(c,dot7(uv,vec2(PL*0.5,PW*0.5),0.35));
    for(int s=0;s<2;s++){ float dir=(s==0)?1.0:-1.0; float gx=(s==0)?inset:PL-inset; float pax=gx+dir*16.5;
      c=max(c,rect7(uv,vec2(min(gx,pax),PW*0.5-20.16),vec2(max(gx,pax),PW*0.5+20.16),hw));
      float gax=gx+dir*5.5; c=max(c,rect7(uv,vec2(min(gx,gax),PW*0.5-9.16),vec2(max(gx,gax),PW*0.5+9.16),hw));
      vec2 pSpot=vec2(gx+dir*11.0,PW*0.5); c=max(c,dot7(uv,pSpot,0.35));
      float arc=ring7(uv,pSpot,9.15,hw); vec2 P=vec2(uv.x*PL,uv.y*PW);
      float outside=(dir>0.0)?step(pax,P.x):step(P.x,pax); c=max(c,arc*outside); }
    return clamp(c,0.0,1.0); }
  void main(){ float lines = pitchLines7(vUv) * clamp(uLines,0.0,1.0);
    // WEAVE: only the white LINES are drawn (and write depth) at y=0, so they float on
    // the markings plane and the cloth shows everywhere BETWEEN them. Where the cloth
    // dips BELOW y=0 the lines (closer to the top-down camera) occlude it → lines on
    // top; where a hill rises ABOVE y=0 the opaque cloth occludes the lines → hidden.
    // Discarding the empty ground means it neither paints over nor depth-occludes the
    // cloth between lines, so the dipped cloth stays visible with the lines woven over.
    if (lines < 0.02) discard;
    vec3 lineCol = vec3(0.92,0.94,0.97);
    gl_FragColor = vec4(lineCol, lines); }
`;

// ============================================================================
// TIMELINE ENGINE (cloned from stage9): mirror AWAY into the shared pitch frame,
// classify events, build the moving locus + windowed-event helpers.
// ============================================================================
function toUV(team, x, y) {
  let X = (Number(x) || 0) / 100, Y = (Number(y) || 0) / 100;
  if (team === 'away') { X = 1 - X; Y = 1 - Y; }
  return { u: clamp(X, 0, 1), v: clamp(Y, 0, 1) };
}
const SHOT_TYPES_TL = new Set(['SavedShot', 'MissedShots', 'ShotOnPost', 'Goal']);
function buildTimelineFromDoc(doc) {
  const out = [];
  for (const e of doc.events) {
    if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
    const team = e.team === 'home' || e.team === 'away' ? e.team : 'home';
    const kind = SHOT_TYPES_TL.has(e.type) ? 'shot' : (e.type === 'Pass' ? 'pass' : 'event');
    const a = toUV(team, e.x, e.y);
    const it = {
      t: Number(e.t) || 0, minute: Number(e.minute) || 0, team, kind,
      u: a.u, v: a.v, type: e.type || kind, outcome: e.outcome || '',
      isTouch: !!e.isTouch, situation: e.situation || '',
      len: Number(e.len) || 0, long: !!e.long, cross: !!e.cross, corner: !!e.corner,
    };
    if (Number.isFinite(e.endX) && Number.isFinite(e.endY)) {
      const en = toUV(team, e.endX, e.endY); it.eu = en.u; it.ev = en.v;
    }
    if (kind === 'shot') {
      it.xg = Number.isFinite(e.xg) ? e.xg : 0;
      it.isGoal = !!e.isGoal;
      it.onGoalX = Number.isFinite(e.onGoalX) ? e.onGoalX : 1;
      it.onGoalY = Number.isFinite(e.onGoalY) ? e.onGoalY : 0;
    }
    out.push(it);
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

const ONBALL_TYPES = new Set([
  'Pass', 'BallTouch', 'TakeOn', 'BallRecovery', 'Clearance', 'Dispossessed',
  'Tackle', 'Interception', 'Aerial', 'Challenge', 'BlockedPass', 'Foul',
  'KeeperPickup', 'Save', 'CornerAwarded', 'ShieldBallOpp', 'Goal',
  'SavedShot', 'MissedShots', 'ShotOnPost',
]);

// ---- Layer-A contributor classification (which events raise a team blanket) --
// Possession/control = on-ball touches the team keeps. Duels = contests.
const POSSESSION_TYPES = new Set(['Pass', 'BallTouch', 'TakeOn', 'BallRecovery', 'KeeperPickup', 'ShieldBallOpp', 'Goal']);
const DUEL_A_TYPES = new Set(['Tackle', 'Aerial', 'Challenge', 'Interception', 'Dispossessed']);
function buildBallLocus(tl) {
  const anchors = [];
  const onball = tl.filter((it) => ONBALL_TYPES.has(it.type) || it.isTouch);
  for (let i = 0; i < onball.length; i++) {
    const p = onball[i], next = onball[i + 1];
    const gap = next ? Math.max(0.001, next.t - p.t) : 0.02;
    anchors.push({ t: p.t, u: p.u, v: p.v, team: p.team });
    if (Number.isFinite(p.eu)) anchors.push({ t: p.t + gap * 0.6, u: p.eu, v: p.ev, team: p.team });
  }
  anchors.sort((a, b) => a.t - b.t);
  return anchors;
}
let _ballCursor = 0;
const LOCUS_HOLD = 0.12;
function ballAt(t) {
  const A = ballLocus;
  if (!A || !A.length) return { u: 0.5, v: 0.5, team: 'home' };
  if (t <= A[0].t) return { u: A[0].u, v: A[0].v, team: A[0].team };
  const last = A[A.length - 1];
  if (t >= last.t) return { u: last.u, v: last.v, team: last.team };
  if (_ballCursor >= A.length - 1 || A[_ballCursor].t > t) _ballCursor = 0;
  while (_ballCursor < A.length - 2 && A[_ballCursor + 1].t <= t) _ballCursor++;
  const a = A[_ballCursor], b = A[_ballCursor + 1];
  const span = Math.max(1e-4, b.t - a.t);
  let f = clamp((t - a.t) / span, 0, 1);
  if (span > LOCUS_HOLD) {
    const slideStart = 1 - LOCUS_HOLD / span;
    f = f <= slideStart ? 0 : clamp((f - slideStart) / (1 - slideStart), 0, 1);
  }
  const e = f * f * (3 - 2 * f);
  return { u: lerp(a.u, b.u, e), v: lerp(a.v, b.v, e), team: f < 0.5 ? a.team : b.team };
}
// Time-low-passed ball point. Eases the raw ballAt(t) toward a gliding (locusU,
// locusV) with the dt filter (tau ≈ TAU_LOCUS) so teleports/kinks between
// discrete events become gentle drifts. dt = Infinity (snap render / scrub)
// resolves a = 1 → returns the raw point exactly (scrub-safe). team carries from
// the raw point (no smoothing of the discrete ownership).
function smoothedBall(t, dt) {
  const raw = ballAt(t);
  const a = expA(dt, TAU_LOCUS);
  if (locusReset || !Number.isFinite(locusU) || a >= 1) {
    locusU = raw.u; locusV = raw.v; locusReset = false;
  } else {
    locusU += (raw.u - locusU) * a;
    locusV += (raw.v - locusV) * a;
  }
  return { u: locusU, v: locusV, team: raw.team };
}
// events in [t-window, t] (chronological)
function eventsInWindow(t, halfLifeMin) {
  if (!timeline) return [];
  const lo = t - halfLifeMin; const out = [];
  for (const it of timeline) { if (it.t > t) break; if (it.t >= lo) out.push(it); }
  return out;
}

// ============================================================================
// FIELD LAYER GRIDS — A (coarse activity) + B (fine pass relief). Each frame we
// recompute cell values from events in the active window by exp-decay weight,
// then bilinear-sample into the mesh's height/colour textures. Scrub-safe.
// ============================================================================
// Layer A grid resolution is driven by cfg.A.grid (0 coarse → 1 fine).
function gridDims(t01, minC, maxC) {
  const n = Math.round(lerp(minC, maxC, clamp(t01, 0, 1)));
  return { gx: n, gy: Math.max(6, Math.round(n * WORLD_Z / WORLD_X)) };
}

// scratch buffers (reallocated only when a grid resolution changes)
// A is TWO team blankets: per-team HEIGHT grids (hH/hA — from the enabled
// contributors, the focus-hill body) + per-team xG crest grids (xH/xA).
let A_gx = 0, A_gy = 0, A_hH = null, A_hA = null;
let A_xH = null, A_xA = null;     // xG SHARP crests (kept separate so they stay tall)
// temporally-SMOOTHED copies of the per-team height/crest grids. Each frame the
// freshly computed grids are lerped INTO these (see smoothA), and rendering reads
// from these — so the surface + colour edges glide instead of twitching.
let A_shH = null, A_shA = null, A_sxH = null, A_sxA = null;
let A_own = null, A_sown = null;   // ownership (0..1 home share) sampled by the partition
// POSSESSION TIDE front (stage5 feel): per lateral CHANNEL (one value per grid
// row v) the recent BALL depth in u. home owns u<front, away owns u>front, so the
// boundary reflects WHERE PLAY IS (field position), not who has more touches. The
// front advances toward a goal as the ball pushes and recedes over the спад window
// → a ball rushing toward u=0 in some channel drops the front there → a green
// tongue. A_frontRaw = this frame's per-channel target; A_front = temporally eased.
let A_frontRaw = null, A_front = null, A_frontTmp = null, A_frontEff = null;
// A_frontDisp = the COMBINED (eased base + thrust fingers + flood) front after a
// final dt-aware temporal low-pass — this is what's actually rendered. The combine
// is re-evaluated fresh each frame, so when a fast pass enters/leaves the recent
// window its weight STEPS → the raw combined front would jump frame-to-frame at the
// seam (a trembling during busy/counter play). Low-passing the COMBINED front with a
// small TAU_THRUST kills that twitch while keeping a counter a quick stab.
let A_frontDisp = null;
let A_smoothReset = true;         // first frame after a grid resize: snap, don't lerp
let A_frontReset = true;          // snap the eased front on scrub/resize
let A_frontDispReset = true;      // snap the displayed combined front on scrub/resize
let focusCX = NaN, focusCZ = NaN, focusReset = true;   // eased focus-hill centre (glides)
// time-low-passed ball locus point (world u,v). ballAt(t) has kinks/teleports
// between discrete events; this glides so the hill + front feed off a gentle
// point. Snapped on scrub via locusReset.
let locusU = NaN, locusV = NaN, locusReset = true;

function ensureA(gx, gy) {
  if (gx === A_gx && gy === A_gy) return;
  A_gx = gx; A_gy = gy; const n = gx * gy;
  A_hH = new Float32Array(n); A_hA = new Float32Array(n);
  A_xH = new Float32Array(n); A_xA = new Float32Array(n);
  A_shH = new Float32Array(n); A_shA = new Float32Array(n);
  A_sxH = new Float32Array(n); A_sxA = new Float32Array(n);
  A_own = new Float32Array(n);          // 0..1 home share per cell (1 = home owns)
  A_sown = new Float32Array(n);         // sampled by the partition
  A_frontRaw = new Float32Array(gy);    // per-channel target front (this frame)
  A_front = new Float32Array(gy).fill(0.5);   // per-channel eased front (start at mid)
  A_frontTmp = new Float32Array(gy);
  A_frontEff = new Float32Array(gy).fill(0.5); // eased front + goal-flood wash (combined, pre-display-LP)
  A_frontDisp = new Float32Array(gy).fill(0.5); // combined front after the final temporal low-pass (rendered)
  A_thrustH = new Float32Array(gy); A_thrustA = new Float32Array(gy);   // finger end-depth accum
  A_thrustWH = new Float32Array(gy); A_thrustWA = new Float32Array(gy); // finger weights
  A_smoothReset = true; A_frontReset = true; A_frontDispReset = true;
}
// Ease each smoothed grid toward the freshly computed one. `k` is the per-frame
// blend (0..1); small k = calmer. On a resize / scrub we SNAP (k=1) once so a
// jump-cut doesn't smear. Scrub-safety: the smoothing is purely cosmetic glide
// on top of the deterministic per-t fields.
function smoothA(k) {
  const snap = A_smoothReset;
  const kk = snap ? 1 : clamp(k, 0, 1);
  A_smoothReset = false;
  for (let i = 0; i < A_hH.length; i++) {
    A_shH[i] += (A_hH[i] - A_shH[i]) * kk;
    A_shA[i] += (A_hA[i] - A_shA[i]) * kk;
    A_sxH[i] += (A_xH[i] - A_sxH[i]) * kk;
    A_sxA[i] += (A_xA[i] - A_sxA[i]) * kk;
  }
}

// stamp a soft gaussian (radius radCells) into a grid at (u,v).
function stamp(grid, gx, gy, u, v, amt, radCells) {
  const ci = clamp(u, 0, 1) * (gx - 1), cj = clamp(1 - v, 0, 1) * (gy - 1);
  const R = Math.max(1, Math.ceil(radCells)), sig = Math.max(0.5, radCells * 0.6);
  const i0 = Math.max(0, Math.floor(ci - R)), i1 = Math.min(gx - 1, Math.ceil(ci + R));
  const j0 = Math.max(0, Math.floor(cj - R)), j1 = Math.min(gy - 1, Math.ceil(cj + R));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const di = i - ci, dj = j - cj;
    grid[j * gx + i] += amt * Math.exp(-(di * di + dj * dj) / (2 * sig * sig));
  }
}

// Asymmetric attack/release envelope for one event at age a = t - e.t (>=0).
// Rises toward 1 over the attack constant `atk`, then melts at the (slower)
// release constant `rel`. Deterministic from t → scrub-safe (recomputed each
// frame from the event window; no frame-to-frame state). When atk→0 it collapses
// to the old pure-decay exp(-a/rel), keeping load behaviour intact.
function arWeight(a, atk, rel) {
  if (a < 0) return 0;
  const rise = atk > 0.02 ? (1 - Math.exp(-a / atk)) : 1;
  return rise * Math.exp(-a / rel);
}

// ============================================================================
// POSSESSION TIDE — territory by BALL FIELD-POSITION (stage5 feel) -------------
// Replaces per-cell touch-dominance (which gave the possession-heavy team almost
// the whole pitch → a straight band edge). Here a team's colour = the territory
// it has reached, measured from its OWN goal up to where the BALL has been.
//
// For each lateral CHANNEL v (grid row), front(v) ∈ [0,1] = the recent ball DEPTH
// in u within/near that channel, through the SAME asymmetric нарастание/спад
// envelope as the height. home (u→1 attack, own goal u≈0) owns u<front; away owns
// u>front. As the ball pushes toward a goal the front follows; when it comes back
// the front recedes over спад. A ball rushing to u≈0 in some channels drops the
// front there → a GREEN tongue into FRA's half. Clamp to [band,1−band] so neither
// goal-end is erased. Deterministic from t (sampled ball locus) → scrub-safe.
function buildTideFront(t, gx, gy, band) {
  const atk = Math.max(0.02, cfg.A.atk);
  const rel = Math.max(0.1, cfg.A.rel);
  // sample the reconstructed ball locus back over the спад window. Step fine
  // enough to catch quick rushes; cap the count for cost. (ballAt is cheap.)
  const winMin = rel * 4 + atk * 2;
  const N = 80;
  const dt = winMin / N;
  // per-channel weighted accumulation of ball-u (weight = envelope × lateral
  // proximity to the channel). sigV = lateral influence half-width in v.
  const accU = A_frontTmp; accU.fill(0);
  const accW = new Float32Array(gy);
  const sigV = 0.16;                 // a ball sample bleeds ~this far across channels
  const inv2sig2 = 1 / (2 * sigV * sigV);
  let anyW = false;
  for (let k = 0; k <= N; k++) {
    const tt = t - k * dt;
    const w = arWeight(k * dt, atk, rel);
    if (w < 0.02) continue;
    const b = ballAt(tt);
    anyW = true;
    // lateral reach: only channels within ~3·sigV of the ball's v get this sample.
    const reach = sigV * 3;
    const jLo = Math.max(0, Math.floor((1 - (b.v + reach)) * (gy - 1)));
    const jHi = Math.min(gy - 1, Math.ceil((1 - (b.v - reach)) * (gy - 1)));
    for (let j = jLo; j <= jHi; j++) {
      const vv = 1 - j / (gy - 1);
      const dv = vv - b.v;
      const lw = Math.exp(-dv * dv * inv2sig2);
      accU[j] += b.u * w * lw; accW[j] += w * lw;
    }
  }
  // resolve per-channel front; channels with no nearby ball default to 0.5 (mid).
  for (let j = 0; j < gy; j++) {
    A_frontRaw[j] = accW[j] > 1e-4 ? (accU[j] / accW[j]) : 0.5;
  }
  // LATERAL smoothing across channels (light) so the front is organic/blobby, not
  // jagged — but channels still DIFFER (that's what makes tongues). 1-cell box ×2.
  smoothChannels(A_frontRaw, gy, 1);
  smoothChannels(A_frontRaw, gy, 1);
  // clamp so neither team's own-goal band is ever erased.
  const lo = clamp(band, 0, 0.45), hi = 1 - lo;
  for (let j = 0; j < gy; j++) A_frontRaw[j] = clamp(A_frontRaw[j], lo, hi);
  return anyW;
}
// ============================================================================
// THRUST FINGERS — counters/fast breaks STAB the colour front forward ----------
// The slow tide front (buildTideFront) is the territorial BASE — a smooth lateral
// boundary of recent ball depth. On a FAST FORWARD pass the attacking team should
// punch a sharp, narrow FINGER of its colour into the opponent half, IN THE PLANE
// of the blanket (advance front(v) at the pass's flank toward the opponent goal),
// NOT a vertical bump. This is purely a per-channel front modifier.
//
// DETECTION — scan recent passes in a short window before t. A pass is a candidate
// "thrust" when, in the team's ATTACKING FRAME (already mirrored into the shared
// pitch frame so home attacks u→1, away attacks u→0), it gains ground FORWARD:
//   home: fwd = eu − u   (toward u=1) ;  away: fwd = u − eu   (toward u=0).
// Forward distance is the PRIMARY signal. Multipliers:
//   · through ball  → ×1.8   (a slicing pass behind the line)
//   · long ball     → ×1.4
//   · SPEED — a forward pass that lands shortly after the team won/received the
//     ball, OR a quick chain gaining lots of ground, reads as a fast counter. We
//     approximate "fast" from the second-resolution timestamps: the gap to the
//     team's PREVIOUS on-ball touch (a short gap after regaining/receiving →
//     counter). Short gap → up to ×1.6.
// Each candidate's strength = fwd · (multipliers) · cfg.A.thrust, gated by a min
// forward gain so ordinary short sideways passes never finger.
//
// INJECTION — each candidate pushes the front at its lateral channel(s) toward the
// pass's END depth (eu), as a SHARP NARROW finger (~1–2 channels, small lateral
// falloff), with its OWN fast attack (appears ~immediately) and fast decay
// (half-life ~few seconds) so an unsustained foray recedes quickly. Direction is
// per team: a home thrust advances the front toward u=1, an away thrust toward u=0
// — we only ever push the front in the attacker's forward direction (max-toward-
// attacker), never pull it back. Respect the own-goal band clamp.
//
// COMBINE (done in computeA): front(v) = max-toward-attacker(slowBase, finger). The
// finger can advance the front BEYOND the slow base, but the slow base holds the
// territory; if deep activity SUSTAINS, the slow base catches up and consolidates
// automatically (sustained presence keeps the channel deep). Deterministic from t
// (recomputed from the event window each frame) → scrub-safe.
const THRUST_ATK_S = 0.25;      // finger rises ~immediately (fast attack τ, seconds)
const THRUST_HALF_S = 3.0;      // finger half-life (seconds) — unsustained forays recede fast
const THRUST_MIN_FWD = 0.06;    // min forward gain (u-units) to count as a thrust
const THRUST_SIGV = 0.07;       // finger lateral half-width in v (NARROW — ~1–2 channels)
// Per-team thrust targets: A_thrustH[j] = deepest home finger end-depth (u→1) this
// frame at channel j, A_thrustA[j] = deepest away finger end-depth (u→0). NaN/sentinel
// = no finger in that channel. Sized to gy in ensureA.
let A_thrustH = null, A_thrustA = null, A_thrustWH = null, A_thrustWA = null;
function buildThrustFingers(t, gx, gy, band) {
  const strength = Number.isFinite(cfg.A.thrust) ? clamp(cfg.A.thrust, 0, 3) : 1;
  // home fingers stab toward u=1 → start each channel at -inf (take the MAX);
  // away fingers stab toward u=0 → start at +inf (take the MIN). Weighted blend so
  // a finger reads its full depth at its channel and tapers laterally.
  A_thrustH.fill(0); A_thrustA.fill(0); A_thrustWH.fill(0); A_thrustWA.fill(0);
  if (strength <= 0) return;
  // decay constant from half-life; attack τ for the fast rise. Window a few
  // half-lives so a faded finger drops out cheaply.
  const relS = THRUST_HALF_S / Math.LN2;
  // work in CLOCK match-minutes for the event window (timeline.t is match-minutes),
  // but the thrust time constants are authored in SECONDS of wall time → convert via
  // the playback rate (minutes advanced per second) so the finger life is in wall
  // time like the goal flood. So a window of ~4 half-lives of wall time.
  const spd = Math.max(0.05, Number(cfg.speed) || 0.9);
  const relMin = (relS * spd);
  const atkMin = (THRUST_ATK_S * spd);
  const winMin = relMin * 4 + atkMin * 2;
  const win = eventsInWindow(t, winMin);
  const reach = THRUST_SIGV * 3;
  const inv2sig2 = 1 / (2 * THRUST_SIGV * THRUST_SIGV);
  const lo = clamp(band, 0, 0.45), hi = 1 - lo;
  // track each team's previous on-ball touch time to estimate "fast" (short gap).
  for (let wi = 0; wi < win.length; wi++) {
    const e = win[wi];
    if (e.kind !== 'pass' || !Number.isFinite(e.eu)) continue;
    const isH = e.team === 'home';
    if (!isH && e.team !== 'away') continue;
    // forward gain in the team's attacking frame (already mirrored). home attacks
    // u→1, away attacks u→0.
    const fwd = isH ? (e.eu - e.u) : (e.u - e.eu);
    if (fwd < THRUST_MIN_FWD) continue;
    const age = t - e.t;
    const env = arWeight(age, atkMin, relMin);   // fast attack + fast decay
    if (env < 0.03) continue;
    // SPEED multiplier — short gap since the team's previous on-ball touch ⇒ a
    // quick forward pass right after regaining/receiving = a counter. Scan back a
    // little for the team's prior touch time.
    let prevT = -Infinity;
    for (let k = wi - 1; k >= 0; k--) {
      const pe = win[k];
      if (pe.team === e.team && (ONBALL_TYPES.has(pe.type) || pe.isTouch)) { prevT = pe.t; break; }
    }
    const gap = e.t - prevT;                       // match-minutes since prior touch
    // gap small (≲ ~0.08 min ≈ 5s of match time) → fast; convert to a 1..1.6 boost.
    const fastBoost = 1 + 0.6 * clamp(1 - gap / 0.12, 0, 1);
    // through/long multipliers.
    const thruBoost = e.through ? 1.8 : 1;
    const longBoost = e.long ? 1.4 : 1;
    // overall finger weight: forward distance is primary, the rest multiply.
    const w = clamp(fwd * 3.0, 0, 1.2) * fastBoost * thruBoost * longBoost * env * strength;
    if (w < 0.02) continue;
    // end depth the finger reaches, clamped to the opponent band so it never crosses
    // the defender's own-goal band.
    const endU = clamp(e.eu, lo, hi);
    // lateral channels around the pass END's v (where the finger tip lands).
    const fv = e.ev;
    const jLo = Math.max(0, Math.floor((1 - (fv + reach)) * (gy - 1)));
    const jHi = Math.min(gy - 1, Math.ceil((1 - (fv - reach)) * (gy - 1)));
    for (let j = jLo; j <= jHi; j++) {
      const vv = 1 - j / (gy - 1);
      const dv = vv - fv;
      const lw = Math.exp(-dv * dv * inv2sig2) * w;
      if (lw < 0.02) continue;
      if (isH) { A_thrustH[j] += endU * lw; A_thrustWH[j] += lw; }
      else     { A_thrustA[j] += endU * lw; A_thrustWA[j] += lw; }
    }
  }
}

// 1-D box blur of a per-channel array (length gy) in place, radius r.
function smoothChannels(arr, gy, r) {
  if (r < 1) return;
  const tmp = new Float32Array(gy);
  const win = 2 * r + 1;
  for (let j = 0; j < gy; j++) {
    let s = 0; for (let k = -r; k <= r; k++) { const jj = clamp(j + k, 0, gy - 1); s += arr[jj]; }
    tmp[j] = s / win;
  }
  arr.set(tmp);
}

// How much one event lifts a team's blanket = Σ of the ENABLED contributors that
// match it, each scaled by its weight. Returns { lift, sharp } where `sharp` is an
// extra concentrated crest (xG) drawn with a tighter radius so danger reads tall.
function contribLift(e) {
  const A = cfg.A;
  let lift = 0, sharp = 0;
  const isShot = e.kind === 'shot';
  if (A.cOwn && (POSSESSION_TYPES.has(e.type) || e.isTouch)) lift += A.wOwn * 1.0;
  if (A.cPass && e.kind === 'pass') lift += A.wPass * 1.0;
  if (A.cDuel && DUEL_A_TYPES.has(e.type)) lift += A.wDuel * 1.0;
  if (A.cDrib && e.type === 'TakeOn') lift += A.wDrib * 1.0;
  if (A.cAll) lift += A.wAll * 0.6;
  if (A.cProg) {
    // progression: forward passes + final-third / box entries (endX advanced vs x)
    if (Number.isFinite(e.eu)) {
      const adv = e.eu - e.u;                       // toward attacking goal (u→1 in shared frame for the team)
      if (adv > 0.04) lift += A.wProg * (1.2 * clamp(adv * 2.5, 0, 1) + (e.eu > 0.66 ? 0.5 : 0));
    }
  }
  if (A.cXg && isShot && !e.isGoal) {
    // sharp tall crest at the shot, scaled by xg. Kept SEPARATE (A_xH/A_xA) so it
    // stays a tall spire above the gentle swells. GOALS ARE EXCLUDED: a goal is
    // expressed ONLY by the celebratory colour FLOOD (goalFloodAt), never by a
    // height peak — so a goal (a high-xg shot) does NOT raise a relief spire. The
    // tall spire is reserved for NON-GOAL shots (chances) only.
    const xg = clamp(e.xg || 0, 0, 1);
    sharp += A.wXg * (1.0 + 4.5 * xg);
  }
  return { lift, sharp };
}

// Recompute the TWO team A grids for time t (height + presence). Returns whether
// any A activity fell in the window. dt = real seconds since last frame (Infinity
// on a snap render) → drives the frame-rate-independent exponential smoothing.
function computeA(t, dt) {
  const atk = Math.max(0.02, cfg.A.atk);
  const rel = Math.max(0.1, cfg.A.rel);
  // coarse → fine. grid 0 = ~14 cells long, grid 1 = ~34.
  const { gx, gy } = gridDims(cfg.A.grid, 14, 34);
  ensureA(gx, gy);
  A_hH.fill(0); A_hA.fill(0); A_xH.fill(0); A_xA.fill(0);
  // base radius from detail; smoothing (blur) widens the swells; the xG crest uses
  // a much tighter radius so the chance reads as a sharp spire, not a swell.
  const radCells = lerp(2.6, 1.4, clamp(cfg.A.grid, 0, 1)) * lerp(0.6, 2.2, clamp(cfg.A.blur, 0, 1));
  // xG spire WIDTH is INDEPENDENT of сглаживание/grid: derive the base sharp radius
  // from grid only (not blur), then scale by the dedicated xgW slider.
  const xgW = Number.isFinite(cfg.A.xgW) ? clamp(cfg.A.xgW, 0.2, 4) : 1;
  const baseSharp = lerp(2.6, 1.4, clamp(cfg.A.grid, 0, 1)) * 0.3;
  const sharpRad = Math.max(0.5, baseSharp * xgW);
  const win = eventsInWindow(t, rel * 5 + atk * 3);
  for (const e of win) {
    const env = arWeight(t - e.t, atk, rel);
    if (env < 0.02) continue;
    const isH = e.team === 'home';
    if (!isH && e.team !== 'away') continue;
    const Hgrid = isH ? A_hH : A_hA, Xgrid = isH ? A_xH : A_xA;
    // HEIGHT — gentle swells from the enabled contributors (the focus-hill body).
    const { lift, sharp } = contribLift(e);
    if (lift > 0) stamp(Hgrid, gx, gy, e.u, e.v, lift * env, radCells);
    if (sharp > 0) {
      // xG crest: tall, tight, kept separate so the chance reads as a spire.
      stamp(Xgrid, gx, gy, e.u, e.v, sharp * env, sharpRad);
    }
  }
  // glide the HEIGHT/hill grids (presence + xG crest) toward this frame's fields
  // with the frame-rate-independent dt filter (tau = TAU_GRID). dt = Infinity on
  // a snap render → a = 1 → instant.
  const aGrid = expA(dt, TAU_GRID);
  smoothA(aGrid);

  // ---- POSSESSION TIDE PARTITION — colour by BALL FIELD-POSITION --------------
  // front(v) per channel from the recent ball depth (stage5 feel). home owns
  // u<front, away owns u>front → full two-colour fill, every cell owned (no black).
  const band = clamp(Number.isFinite(cfg.A.ownBand) ? cfg.A.ownBand : 0, 0, 0.45);
  buildTideFront(t, gx, gy, band);
  // THRUST FINGERS — fast forward passes punch sharp narrow fingers into the
  // opponent half. Built from the recent-pass window with their OWN fast time
  // constants (NOT the slow TAU_FRONT base), so a counter stabs immediately and an
  // unsustained foray recedes fast. Combined below per channel (max-toward-attacker).
  buildThrustFingers(t, gx, gy, band);
  // ease the per-channel front TEMPORALLY with the dt filter (tau = TAU_FRONT) so
  // the boundary DRIFTS smoothly and per-frame ball jitter can't shake it,
  // combined with the existing light lateral spatial smoothing in buildTideFront.
  // Snap on scrub/resize so the deterministic per-t front is exact.
  const kf = A_frontReset ? 1 : expA(dt, TAU_FRONT); A_frontReset = false;
  for (let j = 0; j < gy; j++) A_front[j] += (A_frontRaw[j] - A_front[j]) * kf;
  // GOAL FLOOD override — the scoring team's colour sweeps to fill the WHOLE pitch
  // then recedes. Push EVERY channel's front toward the scorer's far end as amt
  // rises: home (own goal u≈0) floods front→1 (home owns all); away floods →0.
  // Deterministic from clock via goalFloodAt → scrub-safe; overrides bands only
  // during the flood.
  const flood = goalFloodAt(t);
  let floodFront = NaN;
  if (flood && flood.amt > 0.001) {
    const target = flood.team === 'home' ? 1 : 0;   // front value that gives the scorer the whole pitch
    floodFront = target;
  }
  // Build the EFFECTIVE per-channel front (eased front + goal-flood wash) and store
  // it — as a FRONT-u VALUE, not a home-share — into A_own. The blanket shaders work
  // in honest u-units: vDu = u − front(v), so coverage cutoffs + the owner lip live
  // directly in pitch-length fractions (the НАХЛЁСТ depth slider). Bilinear sampling
  // across channels smooths the front laterally; storing the same value along u keeps
  // it a clean per-channel line.
  // COMBINE THRUST FINGERS — max-TOWARD-ATTACKER per channel, applied to a COPY of
  // the slow base (A_front stays pure so next frame's slow easing isn't polluted by a
  // transient finger). A home finger advances the front toward u=1 (only if its end
  // depth is BEYOND the base); an away finger advances toward u=0. The fingers carry
  // their own fast attack/decay (arWeight in buildThrustFingers), so an unsustained
  // foray collapses on its own and the channel falls straight back to the slow base.
  // A sustained deep attack keeps the slow base advancing underneath, so when the
  // finger fades the territory is already consolidated. `conf` = how strongly the
  // finger asserts (its normalised lateral weight) so a faint finger barely nudges.
  for (let j = 0; j < gy; j++) {
    let fr = A_front[j];
    if (A_thrustWH[j] > 1e-4) {                              // home stabs toward u=1
      const endU = A_thrustH[j] / A_thrustWH[j];
      const conf = clamp(A_thrustWH[j], 0, 1);
      const target = lerp(fr, endU, conf);
      if (target > fr) fr = target;
    }
    if (A_thrustWA[j] > 1e-4) {                              // away stabs toward u=0
      const endU = A_thrustA[j] / A_thrustWA[j];
      const conf = clamp(A_thrustWA[j], 0, 1);
      const target = lerp(fr, endU, conf);
      if (target < fr) fr = target;
    }
    if (!Number.isNaN(floodFront)) fr = lerp(fr, floodFront, flood.amt);   // flood wash
    A_frontEff[j] = fr;   // raw COMBINED front this frame (eased base + fingers + flood)
  }
  // FINAL temporal low-pass on the COMBINED/displayed front. The combine above is
  // re-evaluated fresh each frame; when a fast pass enters/leaves the recent window
  // its finger weight STEPS, so A_frontEff would jump frame-to-frame at the seam
  // during busy/counter moments (the returned trembling). A small dt-aware low-pass
  // (tau = TAU_THRUST) smooths the DISPLAYED boundary in time only — the fingers stay
  // spatially sharp (narrow gaussian, untouched) so a counter still appears within
  // ~0.2s and reads as a sharp stab, just without the per-frame twitch. SNAP on
  // scrub/resize so a jump-cut is exact.
  const kd = A_frontDispReset ? 1 : expA(dt, TAU_THRUST); A_frontDispReset = false;
  for (let j = 0; j < gy; j++) {
    A_frontDisp[j] += (A_frontEff[j] - A_frontDisp[j]) * kd;
    const fr = A_frontDisp[j];
    const row = j * gx;
    for (let i = 0; i < gx; i++) A_own[row + i] = fr;   // front-u, constant along u
  }
  A_sown.set(A_own);
  return win.length > 0;
}

// ---- GOAL FLOOD — the ONLY full-pitch single colour --------------------------
// On a goal the SCORING team's colour sweeps to fill the ENTIRE pitch (a
// celebratory symbol), then recedes to the normal contested front. The envelope
// is driven DETERMINISTICALLY from the clock: at time t we find the most recent
// isGoal ≤ t, compute elapsed = t − goalTime (in CLOCK match-minutes, the same
// unit __setClock / the scrubber use), and shape a 0..1 intensity. Scrub-safe:
// no frame state — scrubbing onto a goal shows the flood, away shows normal.
// Phases — now LONGER so the celebration lingers: sweep in ~0.6s, HOLD full ~3s
// (slider cfg.A.floodHold, was ~1.2s), relax back ~2.5s. The user authors these
// in SECONDS; the envelope clock (elapsed = t − goalTime) is in match-minutes, so
// we convert seconds → match-minutes by dividing by cfg.speed (the playback
// minutes-per-second). At default 0.9× that holds ≈3s of wall time. Deterministic
// from the clock + current speed → scrub-safe. (Phase-duration constants are
// declared near the top of the file so DEFAULTS() can use FLOOD_HOLD_DEFAULT_S.)
// Returns { team:'home'|'away', amt:0..1 } for the active flood at clock t, or
// null when no flood is active. amt = how fully the scorer's colour covers the
// pitch (1 = whole pitch the scorer colour).
function goalFloodAt(t) {
  if (!goalsByTime || !goalsByTime.length) return null;
  // LATEST GOAL WINS: pick the single most-recent goal at or before t and shape its
  // envelope from elapsed = t − g.t. If a second goal lands while the first flood is
  // still active (e.g. SEN 101.50 → FRA 102.63), `g` switches to the newer goal and
  // elapsed resets to ~0, so the flood restarts CLEANLY for the new scorer — the two
  // never composite/fight. Reads as one clean event, then the next.
  let g = null;
  for (let i = 0; i < goalsByTime.length; i++) {
    if (goalsByTime[i].t <= t) g = goalsByTime[i]; else break;
  }
  if (!g) return null;
  // WALL-SECONDS ENVELOPE (screen time), not warped match-minutes. Around a goal the
  // dramatic-time clock CRAWLS (matchT warps time so key beats get room), so a fixed
  // number of match-minutes elapses at a wildly variable wall rate — the old
  // match-minute envelope got CRAMPED (goal warp squeezed the whole sweep/hold/relax
  // into a sliver of screen time). We instead measure elapsed = how many SECONDS OF
  // WALL TIME (of the ~15s dramatic pass) have passed since the goal, via the warp's
  // own progress mapping. Deterministic from the clock (progressOfMatchT) → scrub-safe
  // and robust to the warp: the full BANG→flood→hold→relax always plays out in real
  // screen seconds regardless of how the match-minute clock crawls.
  const elapsed = wallSecondsSinceGoal(g.t, t);
  if (!Number.isFinite(elapsed)) return null;
  const holdS = Number.isFinite(cfg.A.floodHold) ? clamp(cfg.A.floodHold, 0, 12) : FLOOD_HOLD_DEFAULT_S;
  const sweep = FLOOD_SWEEP_S, hold = holdS, relax = FLOOD_RELAX_S;   // all in WALL seconds
  const total = sweep + hold + relax;
  if (elapsed < 0 || elapsed >= total) return null;
  let amt;
  if (elapsed < sweep) {
    const f = elapsed / sweep; amt = f * f * (3 - 2 * f);                // smooth sweep up
  } else if (elapsed < sweep + hold) {
    amt = 1;                                                            // hold full (100%)
  } else {
    const f = (elapsed - sweep - hold) / relax;
    const e = f * f * (3 - 2 * f); amt = 1 - e;                         // relax back
  }
  return { team: g.team, amt: clamp(amt, 0, 1) };
}

// WALL-SECONDS since a goal — how many seconds of the ~15s dramatic pass separate
// match-minute gt from the current match-minute t, via the warp's progress mapping.
// One wall pass = DRAMA_TOTAL_S / spd seconds (the speed slider trims the pass), so
// Δprogress · (DRAMA_TOTAL_S / spd) = elapsed wall seconds. Deterministic from the
// clock (no frame state) → scrub-safe. Returns NaN if the warp isn't built yet.
function wallSecondsSinceGoal(gt, t) {
  if (!dramaWcum || dramaWtot <= 0) return NaN;
  const spd = Math.max(0.05, Number(cfg.speed) || 1);
  const passSeconds = DRAMA_TOTAL_S / spd;
  const dProg = progressOfMatchT(t) - progressOfMatchT(gt);
  return dProg * passSeconds;
}

// POST-GOAL LULL — after the flood recedes, a LONGER calm breather where the A
// relief FLATTENS toward ~0 (the surface "выпрямилось, обнулилось") for a beat,
// then normal play resumes. Returns 0..1 = how flat the relief is pressed at clock
// t (0 = full relief, 1 = fully flattened). Deterministic from the clock (elapsed =
// t − goalTime) → scrub-safe, no frame state. The lull window opens right where the
// flood window closes: [floodTotal, floodTotal + lullTotal]. Phases: ramp DOWN the
// relief (~0.5s), HOLD flat (cfg.A.lull), release back (~0.7s). Authored in seconds
// of wall time → converted to match-minutes via the playback rate like the flood.
const LULL_RAMP_S = 0.5, LULL_RELEASE_S = 0.7;
function goalLullAt(t) {
  if (!goalsByTime || !goalsByTime.length) return 0;
  let g = null;
  for (let i = 0; i < goalsByTime.length; i++) {
    if (goalsByTime[i].t <= t) g = goalsByTime[i]; else break;
  }
  if (!g) return 0;
  // WALL-SECONDS envelope (screen time), same base as goalFloodAt so the lull opens
  // EXACTLY where the flood window closes and never overlaps/fights it. elapsed and
  // all phase durations are in real screen seconds, robust to the dramatic-time warp.
  const holdS = Number.isFinite(cfg.A.floodHold) ? clamp(cfg.A.floodHold, 0, 12) : FLOOD_HOLD_DEFAULT_S;
  const floodTotal = FLOOD_SWEEP_S + holdS + FLOOD_RELAX_S;   // wall seconds
  const lullS = Number.isFinite(cfg.A.lull) ? clamp(cfg.A.lull, 0, 4) : 0;
  if (lullS <= 0) return 0;
  const ramp = LULL_RAMP_S, hold = lullS, rel = LULL_RELEASE_S;   // wall seconds
  const lullTotal = ramp + hold + rel;
  const elapsed = wallSecondsSinceGoal(g.t, t);
  if (!Number.isFinite(elapsed)) return 0;
  const e = elapsed - floodTotal;            // elapsed INTO the lull window (wall sec)
  if (e < 0 || e >= lullTotal) return 0;
  if (e < ramp) { const f = e / ramp; return f * f * (3 - 2 * f); }        // flatten in
  if (e < ramp + hold) return 1;                                           // hold flat
  const f = (e - ramp - hold) / rel; const s = f * f * (3 - 2 * f); return 1 - s;  // release
}

// bilinear sample a grid at normalized (u,v) (v already flipped by caller convention)
function sampleGrid(grid, gx, gy, u, v) {
  const fx = clamp(u, 0, 1) * (gx - 1), fy = clamp(1 - v, 0, 1) * (gy - 1);
  const i0 = Math.floor(fx), j0 = Math.floor(fy);
  const i1 = Math.min(i0 + 1, gx - 1), j1 = Math.min(j0 + 1, gy - 1);
  const tx = fx - i0, ty = fy - j0;
  const a = grid[j0 * gx + i0], b = grid[j0 * gx + i1];
  const c = grid[j1 * gx + i0], d = grid[j1 * gx + i1];
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}

// Rebuild the field surface at time t: TWO team A blankets (height + crisp
// coverage). B/C/D are removed, so this only drives the two blankets.
function computeField(t, dt) {
  const aOn = cfg.A.on;
  if (aOn) computeA(t, dt);

  // The hill + front feed off the TIME-LOW-PASSED locus (smoothedBall) so the
  // raw ballAt teleports between discrete events don't jerk the relief.
  const ball = smoothedBall(t, dt);
  // ---- FOCUS: anchor HEIGHT to the single live play locus -------------------
  // A smooth radial mask centred on ballAt(t) (plus a short memory tail along the
  // recent locus path for body) multiplies each team's HEIGHT field, so detached
  // far activity islands dissolve and the relief becomes ONE coherent swell where
  // play actually is. COLOUR / coverage are NOT touched (territory stays painted).
  // focus 0..1 → Gaussian σ in world units (tight → one region, wide → free-form).
  const focusSig = lerp(1.4, 7.5, clamp(cfg.A.focus, 0, 1));
  const focus2 = 2 * focusSig * focusSig;
  // memory tail: a few recent locus samples give the swell natural body along the
  // path. CRITICAL: a tail sample is kept ONLY if it is contiguous with the live
  // locus (within tailReach of it); when the locus jumped far in the last instants
  // the far sample is DROPPED so it can never anchor a detached second hill.
  // EASE the focus centre toward the live locus so the single hill GLIDES instead
  // of teleporting frame-to-frame (the locus itself can jump between touches). On a
  // scrub we snap. Larger jumps ease a touch faster so the hill keeps up with play.
  const tgtX = worldX(ball.u), tgtZ = worldZ(ball.v);
  if (focusReset || !Number.isFinite(focusCX)) { focusCX = tgtX; focusCZ = tgtZ; focusReset = false; }
  else {
    // dt-aware glide (tau = TAU_HILL) so the single hill drifts in small smooth
    // increments at any frame rate and never teleports. dt = Infinity → snap.
    const ke = expA(dt, TAU_HILL);
    focusCX += (tgtX - focusCX) * ke; focusCZ += (tgtZ - focusCZ) * ke;
  }
  const lbX = focusCX, lbZ = focusCZ;
  const tailReach = focusSig * 1.25;          // max gap that still counts as one path
  const FOCUS_TAIL = [0, 0.12, 0.28, 0.45];   // seconds back along the locus
  const focusPts = [{ fx: lbX, fz: lbZ, w: 1.0 }];
  let prevX = lbX, prevZ = lbZ;
  for (let k = 1; k < FOCUS_TAIL.length; k++) {
    const b = ballAt(t - FOCUS_TAIL[k]);
    const fx = worldX(b.u), fz = worldZ(b.v);
    // keep only if contiguous with the PREVIOUS (more recent) kept sample.
    if (Math.hypot(fx - prevX, fz - prevZ) > tailReach) break;
    focusPts.push({ fx, fz, w: 0.8 - (k - 1) * 0.18 });
    prevX = fx; prevZ = fz;
  }
  // FOCUS FLOOR — the mask never drops below this, so BROAD contributors (Владение,
  // Пасы, Единоборства) whose events spread across the pitch still raise a VISIBLE
  // swell away from the live locus instead of being masked to ~0 (the old bug where
  // ticking those boxes did nothing at the default tight focus). The focus peak
  // still rides ON TOP at the locus, so the "one coherent hill" reads as the tallest
  // point while the rest of a team's territory keeps a gentle, perceptible relief.
  // 0.4 base, ramping to ~1 as the slider approaches max (the old free-form field).
  const FOCUS_FLOOR_BASE = 0.4;
  const focusFloor = clamp(FOCUS_FLOOR_BASE + clamp((cfg.A.focus - 0.82) / 0.18, 0, 1) * 0.6, 0, 1);
  const focusMask = (wx, wz) => {
    let m = 0;
    for (const p of focusPts) {
      const dx = wx - p.fx, dz = wz - p.fz;
      const g = p.w * Math.exp(-(dx * dx + dz * dz) / focus2);
      if (g > m) m = g;
    }
    return clamp(m + focusFloor, 0, 1);
  };
  // fabric wobble phase — VERY gentle undulation so each blanket drapes like
  // cloth. Kept slow (small multiplier) so it never adds to the shaking; it is a
  // continuous drift independent of the simulation clock.
  const ph = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.00011;
  const amp = clamp(cfg.A.height, 0, 8);
  const xgH = Number.isFinite(cfg.A.xgH) ? clamp(cfg.A.xgH, 0, 4) : 1;   // xG spire height (independent of amp)
  // TERRITORY LIES FLAT. The old uniform base body raised EVERY covered cell, so
  // a team whose coverage spanned multiple zones (e.g. both wings) showed several
  // detached raised domes. The base is now ~0 — covered-but-quiet zones stay flat
  // coloured (vivid via emissive, see the blanket shader), and the ONLY relief is
  // the FOCUS-gated swell (one coherent hill at the live locus) + the xG spire.
  const A_BASE = 0.0;                   // flat painted territory (no body)
  const A_WOBBLE = 0.028 * amp;        // tiny cloth wobble only (reduced so it never shakes)
  const flr = clamp(cfg.A.floor, 0, 0.9);
  const gamma = clamp(cfg.A.sharp, 0.3, 4);
  // НАХЛЁСТ ▸ глубина — finite OVERLAP depth (fraction of pitch length). Each opaque
  // sheet extends `lap` PAST the front into the opponent's half, so the band
  // [front−lap, front+lap] is covered by BOTH (no gap/black hole), each sheet ending
  // with a clean cutoff that tucks UNDER the other. Slider range 0–0.2.
  const lap = clamp(Number.isFinite(cfg.A.lap) ? cfg.A.lap : 0.06, 0, 0.25);

  // POSSESSOR ON TOP — which team's blanket laps over (computed BEFORE the vertex
  // loop so the seam-band under-sheet clamp below can use it). The live ball owner
  // laps over; a goal flood forces the scorer on top. Eased over ~0.4s (snap on
  // scrub) so it never flickers per frame.
  const flood2 = goalFloodAt(t);
  let topTargetHome = ball.team === 'away' ? 0 : 1;
  if (flood2 && flood2.amt > 0.5) topTargetHome = flood2.team === 'home' ? 1 : 0;
  const kTop = seamTopReset ? 1 : expA(dt, TAU_TOP); seamTopReset = false;
  seamTopHome += (topTargetHome - seamTopHome) * kTop;
  const homeIsTop = seamTopHome >= 0.5;

  // POST-GOAL LULL — 0..1 how flat the relief is pressed right now (deterministic
  // from the clock). During the lull the whole A relief (mounds + xG spire) melts
  // toward ~0 for a beat, so the surface "выпрямилось, обнулилось" after the goal
  // flood, then recovers. reliefMul multiplies every vertex's relief below.
  const lullFlat = goalLullAt(t);
  const reliefMul = 1 - lullFlat;

  // normalisation for the two A height grids (shared so relative team height is
  // honest). Read the SMOOTHED grids — that's what we render — so the normaliser
  // tracks the eased fields and doesn't itself jump frame-to-frame.
  let aMax = 1e-4;
  if (aOn) {
    for (let k = 0; k < A_shH.length; k++) { if (A_shH[k] > aMax) aMax = A_shH[k]; if (A_shA[k] > aMax) aMax = A_shA[k]; }
  }

  const bH = blankets.home, bA = blankets.away;
  let idx = 0;
  for (let j = 0; j < VY; j++) {
    const v = j / (VY - 1);
    for (let i = 0; i < VX; i++, idx++) {
      const u = i / (VX - 1);
      const wob = Math.sin(u * 6.1 + ph) * Math.cos(v * 5.3 - ph * 0.8)
                + 0.5 * Math.sin((u + v) * 9.7 - ph * 1.3);

      // ---- Layer A: per-team blanket height + crisp coverage ----
      let hH = 0, hA = 0, covH = 0, covA = 0;
      if (aOn) {
        // height from contributors (per team), normalised + floor + gamma.
        // All sampling reads the SMOOTHED grids so the surface glides.
        let rH = sampleGrid(A_shH, A_gx, A_gy, u, v) / aMax;
        let rA = sampleGrid(A_shA, A_gx, A_gy, u, v) / aMax;
        if (flr > 0) { rH = clamp((rH - flr) / (1 - flr), 0, 1); rA = clamp((rA - flr) / (1 - flr), 0, 1); }
        if (gamma !== 1) { rH = Math.pow(rH, gamma); rA = Math.pow(rA, gamma); }
        // xG SHARP crest added ON TOP of the swell (not normalised/floored). This
        // is the ONLY tall SPIRE in the scene, and it stands ONLY where a REAL shot
        // landed (A_sxH/A_sxA are stamped exactly at each shot's pitch spot and fade
        // a couple seconds after — see contribLift/computeA). Away from shots there
        // is NO spire, only the gentle mounds below.
        const xH = sampleGrid(A_sxH, A_gx, A_gy, u, v);
        const xA = sampleGrid(A_sxA, A_gx, A_gy, u, v);
        // GENTLE-MOUND mask for the general (non-shot) relief. The old code used the
        // focus mask to concentrate a TALL hill at the ball locus — that spurious
        // peak (where no shot was) is exactly what the user disliked. We now KEEP the
        // general relief broad and LOW: a soft floor + a mild focus lift, so play
        // reads as rolling low mounds, never a spire. Only the xG crest towers.
        const wx = worldX(u), wz = worldZ(v);
        const fm = focusMask(wx, wz);
        const moundMask = clamp(0.55 + 0.45 * fm, 0, 1);   // broad low mound (no sharp hill)
        // crest is its own TIGHT spatial spike (A_sxH/A_sxA) at the shot spot, so it
        // doesn't need the focus gate to stay coherent — keep it UNGATED so a recent
        // shot reads as a crisp tall spire exactly where it happened, wherever the
        // live locus has drifted to.
        const fmCrest = 1.0;
        // xG spire HEIGHT is INDEPENDENT of A.amplitude: the crest term is scaled
        // by the dedicated xgH slider (× a fixed base so amp doesn't gate it).
        const crestK = 2.6 * xgH;
        // COVERAGE TEXTURE stores the per-channel FRONT-u (from the POSSESSION TIDE).
        // The blanket shaders read it as front(v) and work in honest u-units:
        // vDu = u − front. home owns u<front, away owns u>front; each opaque sheet
        // extends `lap` past the front (finite overlap), so background never shows.
        const front = sampleGrid(A_sown, A_gx, A_gy, u, v);   // front-u for this cell
        const du = u - front;                                  // + = away half
        covH = front;
        covA = front;
        // CROSSING NOTCH — calm the RELIEF (swell + xG crest) of BOTH sheets in a thin
        // band straddling the seam, so neither has a TALL HILL exactly at the crossing
        // for the lip to fold through (the user's interpenetration). A smooth dip that
        // recovers to full height away from the seam: hills/spires still rise fully out
        // in open territory; only the immediate boundary is flattened so the short lip
        // sits on calm ground and the under sheet stays cleanly below — no poke-through,
        // no dark sliver. notchMin = how low the relief is pressed right at the seam.
        const notchW = Math.max(lap * 2.2, 0.09);
        const notchMin = 0.05;                                  // ≈flat relief right at the seam
        const nt = clamp(Math.abs(du) / notchW, 0, 1);
        const notch = notchMin + (1 - notchMin) * (nt * nt * (3 - 2 * nt));   // smooth dip→recover
        // GENTLE MOUND cap (×0.5) so the general territory relief is a soft low swell,
        // NEVER a spire; the xG crest (×crestK) is the only tall feature. reliefMul
        // melts the whole relief toward 0 during the post-goal lull (штиль).
        const reliefH = (rH * 0.5 * amp * moundMask + xH * crestK * fmCrest) * notch * reliefMul;
        const reliefA = (rA * 0.5 * amp * moundMask + xA * crestK * fmCrest) * notch * reliefMul;
        // PER-TEAM RELIEF — each blanket carries its OWN (notched-at-seam) height, so
        // the two sheets are TWO DISTINCT surfaces; the visible LAP is the TOP sheet's
        // short lip fold (vertex shader), never a merged plane.
        hH = A_BASE + A_WOBBLE * wob + reliefH;
        hA = A_BASE + A_WOBBLE * wob + reliefA;
        // SEAM-BAND UNDER-SHEET CLAMP — within the seam band the UNDER sheet is held
        // BELOW the top one (cap = top − margin, blended to none at the band edge) so
        // no residual bump or green/blue TONGUE can stab through the short lip. Wider
        // band + firmer margin than before so a hill-near-the-front never pokes through
        // and leaves a sliver. Open territory (outside the band) is untouched, so hills
        // still rise fully out there.
        const seamW = Math.max(lap * 2.2, 0.09);
        const near = clamp(1 - Math.abs(du) / seamW, 0, 1);   // 1 at seam → 0 at band edge
        if (near > 0) {
          const margin = 0.1;
          if (homeIsTop) { const cap = hH - margin; if (hA > cap) hA = lerp(hA, cap, near); }
          else           { const cap = hA - margin; if (hH > cap) hH = lerp(hH, cap, near); }
        }
      }
      bH.hData[idx] = hH; bH.aData[idx] = covH;
      bA.hData[idx] = hA; bA.aData[idx] = covA;

      // TRUE top-A-surface: the VISIBLE (lapping) sheet's displaced height + its seam
      // distance, so surfaceY() (built after the loop, once lipH/BLANKET_LIFT are known)
      // can add the exact lip fold + lift the blanket shader applies → B/C/D ride the
      // surface we actually see. homeIsTop is the eased global top choice.
      if (aOn) {
        surfTopH[idx] = homeIsTop ? hH : hA;
        // du was computed above only inside the aOn branch; recompute the seam distance
        // from the stored front so the lip fold matches the top sheet's shader.
        surfTopDu[idx] = u - covH;   // covH == front at this cell
      } else {
        surfTopH[idx] = 0; surfTopDu[idx] = 1;
      }

    }
  }
  // STRADDLE THE MARKINGS PLANE (the stage4/5 weave): the cloth now sits BOTH below
  // and above y=0. Calm/flat cloth (relief≈0) is pushed slightly BELOW the plane by
  // A_DOWN_BIAS so the white pitch lines (drawn at y=0, depth-written) show ON TOP of
  // it; wobble TROUGHS dip further below; only the focus hill + xG spire rise ABOVE
  // y=0, where the cloth occludes the lines. world-Y = hb − uBaseline (+ lip), so a
  // POSITIVE uBaseline = A_DOWN_BIAS lowers the body. The mean then sits ≈ at the
  // plane (relief is mostly ~0 with one hill), not above it — the lines weave through.
  const A_DOWN_BIAS = 0.18;
  bH.u.uBaseline.value = A_DOWN_BIAS; bA.u.uBaseline.value = A_DOWN_BIAS;
  // colour-glow strength (graceful for old cfgs lacking A.glow).
  const glow = Number.isFinite(cfg.A.glow) ? cfg.A.glow : 1.0;
  bH.u.uGlow.value = glow; bA.u.uGlow.value = glow;
  // НАХЛЁСТ ▸ глубина (u-units) → both blanket shaders (coverage cutoff + fold width).
  bH.u.uLap.value = lap; bA.u.uLap.value = lap;
  // КРОМКА ▸ подъём — the VISIBLE lip height by which the TOP sheet laps over the
  // under one (graceful for old cfgs lacking A.lipH).
  const lipH = clamp(Number.isFinite(cfg.A.lipH) ? cfg.A.lipH : 0.1, 0, 0.35);
  bH.u.uLipH.value = lipH; bA.u.uLipH.value = lipH;
  // BUILD THE TRUE TOP-A-SURFACE world-Y per vertex now that lipH/baseline are known.
  // world-Y of the blanket = stored top-sheet height − A_DOWN_BIAS + the lip fold
  // (matching the blanket vertex shader exactly: transformed.y += (hb − uBaseline) +
  // uLipH*uTop*FOLD(du), uBaseline=+A_DOWN_BIAS). With the straddle the surface can be
  // BELOW y=0 on calm cloth — B/C/D follow it down/up so they always sit on the cloth.
  // The TOP sheet is home if homeIsTop (uAway=0, uTop≈seamTopHome) else away.
  if (aOn) {
    const topAway = homeIsTop ? 0 : 1;
    const topUTop = homeIsTop ? seamTopHome : (1 - seamTopHome);
    for (let k = 0; k < NV; k++) {
      const fold = foldLip(surfTopDu[k], lap, topAway);
      surfYData[k] = surfTopH[k] - A_DOWN_BIAS + lipH * topUTop * fold;
    }
  } else {
    for (let k = 0; k < NV; k++) surfYData[k] = 0;
  }
  // POSSESSOR ON TOP — seamTopHome was eased BEFORE the vertex loop (so the seam-band
  // under-sheet clamp could use it). Feed it to the shaders: the top sheet gets the
  // lip fold (uTop→1), the under sheet none (uTop→0).
  bH.u.uTop.value = seamTopHome; bA.u.uTop.value = 1 - seamTopHome;
  // STAGE-7 material animation clock — drifts the clay micro-texture + ember flicker.
  // Driven by the playback clock t (match-minutes) so it's deterministic / scrub-safe.
  const matTime = t * 0.5;
  bH.u.uTime.value = matTime; bA.u.uTime.value = matTime;
  // REAL MATCH INTENSITY → gentle stage7 ember (scrub-safe, from event density in a
  // short window). Normalised against a nominal busy rate so it sits in ~0..1.
  const intWin = eventsInWindow(t, 0.35);
  const intensity = clamp(intWin.length / 18, 0, 1);
  bH.u.uIntensity.value = intensity; bA.u.uIntensity.value = intensity;
  bH.hTex.needsUpdate = true; bH.aTex.needsUpdate = true;
  bA.hTex.needsUpdate = true; bA.aTex.needsUpdate = true;
  bH.mesh.visible = aOn; bA.mesh.visible = aOn;
  // RENDER ORDER — draw the TOP sheet LAST so its raised lip composites cleanly over
  // the under sheet (opaque, depth-tested; the real Y lip already separates them, so
  // this just guarantees the visible top is the possessor's). Equal-ish; flip by
  // possession with a clear margin via the smoothed seamTopHome.
  const homeOnTop = seamTopHome >= 0.5;
  bH.mesh.renderOrder = homeOnTop ? 2 : 1;
  bA.mesh.renderOrder = homeOnTop ? 1 : 2;
  bH.mesh.position.y = 0.0; bA.mesh.position.y = 0.0;
}
let seamTopHome = 1;   // smoothed 0..1: home blanket is the TOP (lapping) sheet
let seamTopReset = true;  // snap the top/bottom choice on scrub/resize

// ============================================================================
// JS mirror of the blanket vertex shader's FOLD(du): the short local lip the TOP
// sheet folds up near the seam so it laps over the under sheet. `aw` = the top
// sheet's uAway (0 home, 1 away). Must match the GLSL exactly so surfYData tracks the
// rendered lip. (Still used by computeField to build the blanket surface world-Y.)
function foldLip(du, lap, aw) {
  const s = aw > 0.5 ? du : -du;                 // + = own side
  const fw = Math.max(lap * 0.6, 0.001);
  const ow = Math.max(lap * 0.4, 0.001);
  const own = 1 - smoothstep(0, fw, s);
  const opp = smoothstep(-ow, 0, s);
  return clamp(Math.min(own, opp + (s >= 0 ? 1 : 0)), 0, 1);
}

// ============================================================================
// POST chain (cloned from stage9)
// ============================================================================
function setupComposer() {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  // STAGE-7 POST — soft UnrealBloom on the bright crests/ember (gentle, not a haze),
  // then the vignette/exposure/contrast/saturation grade, SMAA, output. Values are
  // stage7's tuned defaults so the look matches (pleasant IBL, no plastic wash).
  bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.12, 0.3, 0.52);
  composer.addPass(bloomPass);
  gradePass = new ShaderPass(GradeShader);
  gradePass.uniforms.uVig.value = 1.28; gradePass.uniforms.uExpo.value = 1.72;
  gradePass.uniforms.uContr.value = 1.12; gradePass.uniforms.uGsat.value = 1.3;
  composer.addPass(gradePass);
  smaaPass = new SMAAPass(1, 1); composer.addPass(smaaPass);
  composer.addPass(new OutputPass());
}
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uVig: { value: 0.5 }, uExpo: { value: 1.0 }, uContr: { value: 1.06 }, uGsat: { value: 1.04 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uVig; uniform float uExpo; uniform float uContr; uniform float uGsat; varying vec2 vUv;
    void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb; c *= uExpo;
      float l = dot(c, vec3(0.2126,0.7152,0.0722)); c = mix(vec3(l), c, uGsat);
      c = (c - 0.5) * uContr + 0.5;
      vec2 d = vUv - 0.5; float vig = smoothstep(0.85, 0.25, length(d)*1.4); c *= mix(1.0, vig, clamp(uVig,0.0,1.5));
      gl_FragColor = vec4(max(c,0.0), 1.0); }`,
};

// ============================================================================
// FRAME COMPOSITION — recompute all enabled layers for time t, render one frame.
// ============================================================================
// dt = real seconds since the previous rendered frame (clamped ≤0.1 for tab
// spikes). When omitted (a SNAP render: scrub, slider, single-frame __setClock)
// we pass dt = Infinity → every exp filter resolves a = 1 - exp(-∞) = 1 → snap.
function renderFrame(t, dt) {
  const D = Number.isFinite(dt) ? Math.max(0, dt) : Infinity;
  // Only Layer A remains (the two team blankets). B/C/D are removed.
  computeField(t, D);
}
// Frame-rate-independent exponential smoothing factor for a given time constant
// tau (seconds): state += (target - state) * expA(dt, tau). dt = Infinity → 1
// (instant snap). Small dt → small step → glide. tau bigger = calmer/slower.
function expA(dt, tau) {
  if (!(dt > 0)) return 0;
  if (!Number.isFinite(dt)) return 1;
  return 1 - Math.exp(-dt / Math.max(1e-3, tau));
}
// time constants (seconds) for the dt-aware smoothing.
const TAU_FRONT = 0.5;    // possession-tide boundary per channel
const TAU_THRUST = 0.28;  // final low-pass on the COMBINED/displayed front (base+fingers) — kills the per-frame seam trembling from stepping finger weights; raised 0.22→0.28 to finish off the residual seam shimmer (seam-delta dropped ~45% busy, ~35-55% counter) while a counter still reaches ~66% of its depth within ~0.3s (still a quick stab)
const TAU_GRID = 0.5;     // per-cell height / xG crest fields
const TAU_HILL = 0.25;    // focus-hill centre glide
const TAU_LOCUS = 0.25;   // low-pass on the ball locus point feeding hill+front
const TAU_TOP = 0.4;      // possessor-on-top (which blanket laps over) transition
// Force the A smoothing to SNAP on the next computeA (used after a scrub or a
// slider change so the eased grids don't lag behind a jump-cut / new setting).
function snapASmoothing() { A_smoothReset = true; focusReset = true; A_frontReset = true; A_frontDispReset = true; locusReset = true; seamTopReset = true; }

// ---- resize -----------------------------------------------------------------
function onResize() {
  const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr); renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  if (composer) {
    composer.setPixelRatio(dpr); composer.setSize(w, h);
    if (bloomPass) bloomPass.setSize(w * dpr, h * dpr);
    if (smaaPass) smaaPass.setSize(w * dpr, h * dpr);
  }
}

// ---- main loop --------------------------------------------------------------
// Playback is DRAMATIC-TIME: wallProgress advances linearly over DRAMA_TOTAL_S
// seconds of wall time (÷ cfg.speed lets the user still stretch/compress the whole
// portrait), and the match-minute `clock` is the WARPED mapping matchT(progress).
// So the clock crawls around key beats and races through routine, and one pass of
// the whole match takes ~15s. At the end we LOOP (restart) → a living portrait.
let lastNow = performance.now();
function loop(now) {
  const dt = Math.min(0.1, Math.max(0, (now - lastNow) / 1000));
  lastNow = now;
  if (playing) {
    // cfg.speed (default 0.9) scales the pass duration: effective total =
    // DRAMA_TOTAL_S / cfg.speed. 1.0× ⇒ ~15s; leaving the slider as a global
    // tempo trim. dt is real wall seconds.
    const spd = Math.max(0.05, Number(cfg.speed) || 1);
    wallProgress += (dt / DRAMA_TOTAL_S) * spd;
    if (wallProgress >= 1) { wallProgress -= 1; _dramaCursor = 0; snapASmoothing(); }  // LOOP
    clock = matchT(wallProgress);
  }
  renderFrame(clock, dt);
  controls.update();
  composer.render();
  updateHud();
  updateCamReadout();
  requestAnimationFrame(loop);
}

// ---- dev hook (hidden-tab safe: render exactly one frame via composer) -------
// __setClock SNAPS the smoothing (jump-cut to an instant). For verifying MOTION
// in a hidden tab (rAF paused) use __step(min, dt): it renders WITHOUT snapping,
// feeding the dt-aware exponential filters a real dt — so calling it repeatedly
// with small advancing min + dt reproduces the live glide deterministically.
window.__setClock = (min) => {
  clock = clamp(+min || 0, 0, teamMeta.duration);
  wallProgress = progressOfMatchT(clock);   // keep the warped scrubber coherent
  _dramaCursor = 0;
  playing = false; const pb = el('play'); if (pb) pb.textContent = '▶';
  _ballCursor = 0; snapASmoothing();
  renderFrame(clock);
  controls.update();
  composer.render();
  updateHud();
  updateCamReadout();
};
window.__step = (min, dt) => {
  clock = clamp(+min || 0, 0, teamMeta.duration);
  wallProgress = progressOfMatchT(clock);
  playing = false;
  renderFrame(clock, Number.isFinite(+dt) ? +dt : 0.016);
  controls.update();
  composer.render();
  updateHud();
};

// ============================================================================
// DRAMATIC-TIME PLAYBACK — "the whole match in ~15 seconds", but NOT uniform
// fast-forward. We build a per-match IMPORTANCE curve I(t) from the real event
// stream, then WARP the playback clock so that the 15s of wall time is allocated
// ∝ (calmFloor + k·I(t)): routine minutes RACE past, key beats (goals, big
// chances, dangerous counters) get artificial ROOM (slow-mo). The match-minute +
// score HUD ride this warped clock, so the minute flies during calm and crawls
// around key episodes — that ticking anchor is the intended read.
//
// The warp is a monotone mapping matchT(progress) : [0,1]→[0,fullT]. Its inverse
// is used to keep the scrub slider (wall-progress) and __setClock (match-minute)
// coherent. Only real data feeds I(t) — no procedural decoration.
// ============================================================================
const DRAMA_TOTAL_S = 15.0;    // total wall-time for one pass of the whole match
// k — how strongly importance dilates time (multiplies I(t) which is normalised
// to peak 1). calmFloor — the baseline "screen-time density" of routine play so
// calm still GLIDES (never freezes) and the calm-vs-busy contrast reads.
const DRAMA_K = 9.0;
const DRAMA_CALMFLOOR = 1.0;
// Guaranteed SCREEN-TIME (seconds of the 15s) for the distinct key beats, so two
// beats close in match-time (two goals 1 min apart, or a goal near a big chance)
// stay visibly SEPARATED and each reads its own moment (≥ ~0.7s ask, we give more).
// A GOAL's window MUST be long enough (in screen seconds) to play the WHOLE flood
// envelope — BANG → 100% flood → hold → relax — WITHOUT cramping, otherwise the
// wall-seconds flood would spill into the racing post-goal minutes and look rushed.
// So GOAL_ROOM_S is derived from the flood durations (sweep + default hold + relax)
// plus a small margin, and the post-goal LULL beat gets its own room sized to the
// lull envelope (ramp + hold + release). See goalFloodAt / goalLullAt (wall-seconds).
const GOAL_ROOM_S = FLOOD_SWEEP_S + FLOOD_HOLD_DEFAULT_S + FLOOD_RELAX_S + 0.4; // ≈4.7s — the WHOLE flood (BANG→100%→hold→relax) plays out on screen
const GOAL_LULL_ROOM_S = LULL_RAMP_S + 1.2 + LULL_RELEASE_S + 0.4;              // ≈2.8s — the calm breather + reset fits after
const CHANCE_ROOM_S = 1.0;    // ×normalized importance → a big non-goal chance's room
// I(t) sampling resolution (match-minutes per bin) + smoothing window (minutes).
const DRAMA_DT = 0.05;
const DRAMA_SMOOTH_MIN = 0.55;   // short Gaussian: each episode → a localized hump

// warp state (built per loaded match)
let dramaN = 0;                 // number of bins
let dramaWcum = null;           // cumulative screen-time weight W at each bin edge (len N+1)
let dramaWtot = 0;              // W(fullT)
let dramaKeyBeats = [];         // {t, w} detected peaks (for reporting / separation)

// Weight the real events into a per-time importance curve, normalise, smooth.
function buildImportanceCurve() {
  const T = teamMeta.duration || 100;
  const N = Math.max(8, Math.ceil(T / DRAMA_DT));
  dramaN = N;
  const I = new Float32Array(N);          // raw importance accumulator (per bin)
  const binOf = (t) => clamp(Math.floor(t / DRAMA_DT), 0, N - 1);

  // helper: is a pitch point in the attacking final-third / penalty box, in the
  // shared (mirrored) pitch frame. u is the along-pitch coord; each team attacks
  // toward its OWN goal-opposite end. In toUV() home maps x→u directly and away is
  // flipped, so BOTH teams attack toward u→1 (endX large). Final third ≈ u>0.66,
  // box ≈ u>0.83 & v in the central band.
  const inFinalThird = (u) => u > 0.66;
  const inBox = (u, v) => u > 0.83 && v > 0.21 && v < 0.79;

  // Deposit a weighted, spatially-instant impulse at match-time t.
  const add = (t, w) => { if (w > 0) I[binOf(t)] += w; };

  // Track the last turnover time per team to detect FAST forward transitions
  // (a quick sequence after winning the ball that reached danger).
  let lastTurnover = { home: -99, away: -99 };
  const TURNOVER_TYPES = new Set(['Interception', 'Tackle', 'BallRecovery', 'Dispossessed', 'Clearance']);

  for (let i = 0; i < timeline.length; i++) {
    const e = timeline[i];
    // turnover bookkeeping: the winning team is `e.team` for a recovery/tackle/
    // interception; a Dispossessed marks the OTHER team winning it.
    if (TURNOVER_TYPES.has(e.type)) {
      const winner = (e.type === 'Dispossessed') ? (e.team === 'home' ? 'away' : 'home') : e.team;
      lastTurnover[winner] = e.t;
    }

    if (e.kind === 'shot') {
      const xg = Number.isFinite(e.xg) ? e.xg : 0;
      if (e.isGoal) {
        add(e.t, 26);                       // GOAL — highest weight (big)
      } else {
        // dangerous shot ∝ xG; on-target bonus (SavedShot / ShotOnPost were on
        // frame; MissedShots was off). Baseline so even a low-xg shot is a beat.
        const onTarget = (e.type === 'SavedShot' || e.type === 'ShotOnPost' || e.outcome === 'Successful');
        add(e.t, 3.0 + 14.0 * xg + (onTarget ? 3.0 : 0));
      }
      continue;
    }

    // box entry / final-third arrival via a completed forward pass or carry that
    // ENDS in the box / final third (endpoint eu,ev present).
    if (Number.isFinite(e.eu)) {
      const enteredBox = inBox(e.eu, e.ev) && !inBox(e.u, e.v);
      const enteredFT = inFinalThird(e.eu) && !inFinalThird(e.u);
      if (enteredBox || enteredFT) {
        let w = enteredBox ? 4.0 : 2.0;
        if (e.long || e.through) w *= 1.4;   // incisive ball
        // FAST TRANSITION: this arrival came shortly after this team won the ball
        // → a quick counter that reached danger. Boost it (that's a key beat).
        const sinceWin = e.t - (lastTurnover[e.team] ?? -99);
        if (sinceWin >= 0 && sinceWin < 0.28) w *= 2.2;   // ~<17s real → snappy break
        add(e.t, w);
      }
    }

    // cards / penalties if present (smaller). WhoScored types vary; cover the
    // common ones that appear in this feed.
    if (e.type === 'Card' || e.type === 'YellowCard' || e.type === 'RedCard') add(e.t, 4.0);
    if (e.type === 'Penalty' || e.situation === 'Penalty') add(e.t, 8.0);
  }

  // Light Gaussian smooth → each episode becomes a localized hump (not a spike).
  const sigmaBins = Math.max(1, DRAMA_SMOOTH_MIN / DRAMA_DT);
  const rad = Math.ceil(sigmaBins * 3);
  const kern = [];
  let ksum = 0;
  for (let d = -rad; d <= rad; d++) { const g = Math.exp(-(d * d) / (2 * sigmaBins * sigmaBins)); kern.push(g); ksum += g; }
  const Is = new Float32Array(N);
  for (let b = 0; b < N; b++) {
    let acc = 0;
    for (let d = -rad; d <= rad; d++) {
      const j = b + d; if (j < 0 || j >= N) continue;
      acc += I[j] * kern[d + rad];
    }
    Is[b] = acc / ksum;
  }
  // normalise to peak 1 (so DRAMA_K is a clean dilation multiplier).
  let peak = 0; for (let b = 0; b < N; b++) if (Is[b] > peak) peak = Is[b];
  if (peak > 0) for (let b = 0; b < N; b++) Is[b] /= peak;

  // record the key beats (local maxima above a threshold) for reporting +
  // separation bookkeeping.
  dramaKeyBeats = [];
  for (let b = 1; b < N - 1; b++) {
    if (Is[b] > 0.28 && Is[b] >= Is[b - 1] && Is[b] > Is[b + 1]) {
      dramaKeyBeats.push({ t: b * DRAMA_DT, w: Is[b] });
    }
  }
  return Is;
}

// Build the cumulative screen-time-weight W(t) = ∫ (calmFloor + k·I) dt, then the
// clock is played by inverting W(t)/W(total) = progress. To guarantee SEPARATION we
// take a list of GUARANTEED beats (every goal, plus strong non-goal chances) each
// with a target screen-time in seconds, and ADD a compact Gaussian hump at each so
// its local screen-time reaches that target. The humps are TIGHT (small sigma) so
// two beats close in match-time (e.g. two goals 1 min apart) keep DISTINCT humps —
// they're pushed apart in W-space and never collapse into one instant. calmFloor
// keeps routine gliding between them.
function buildDramaticClock() {
  const Is = buildImportanceCurve();
  const N = dramaN;
  // per-bin density d(b) = calmFloor + k·I. (screen-seconds per match-minute, up
  // to a global scale we normalise away when mapping progress.)
  const dens = new Float32Array(N);
  for (let b = 0; b < N; b++) dens[b] = DRAMA_CALMFLOOR + DRAMA_K * Is[b];

  // GUARANTEED beats: every GOAL (biggest room) + strong non-goal chances (a big
  // chance still earns its own moment). Goals are first-class — they always get the
  // most room, so a busy routine passage can never out-shine a goal.
  // Each beat carries its own hump SIGMA (minutes). A GOAL needs a WIDE plateau so
  // the warped clock LINGERS near it for the full flood+lull wall-seconds (BANG →
  // 100% flood → hold → relax → lull), not a narrow spike the clock races through in
  // ~2s (which cramped the flood). A chance keeps the tight spike so close beats stay
  // separated. GOAL_SIG is chosen so the linger spans the whole envelope.
  const GOAL_SIG = 0.9, CHANCE_SIG = 0.32;
  const guaranteed = [];
  for (const e of timeline) {
    if (e.kind === 'shot' && e.isGoal) {
      guaranteed.push({ t: e.t, sec: GOAL_ROOM_S, sig: GOAL_SIG });
      // POST-GOAL LULL room — give the breather (flood recede + relief flatten/reset)
      // its own screen-time slot just AFTER the goal so the calm штиль gets room on
      // screen before play resumes. Offset a bit further so its wider hump sits just
      // after the goal's, extending the lingered block through the relax + lull.
      guaranteed.push({ t: e.t + 0.9, sec: GOAL_LULL_ROOM_S, sig: GOAL_SIG });
    }
  }
  for (const beat of dramaKeyBeats) {
    const nearGoal = guaranteed.some((g) => Math.abs(g.t - beat.t) < 1.0);
    if (beat.w > 0.55 && !nearGoal) guaranteed.push({ t: beat.t, sec: CHANCE_ROOM_S * beat.w, sig: CHANCE_SIG });
  }

  // --- SEPARATION top-up: give every guaranteed beat its target screen share ---
  const densInt = () => { let s = 0; for (let b = 0; b < N; b++) s += dens[b] * DRAMA_DT; return s; };
  // Per-beat humps + a Gaussian-weighted local measure so an adjacent beat's tail
  // doesn't count as "this beat already has room" → close beats stay separate. The
  // window half-width scales with the beat's own sigma so a wide goal plateau is
  // measured (and filled) over its full extent.
  for (let pass = 0; pass < 4; pass++) {            // iterate so added humps re-normalise
    const Wtot0 = densInt();
    const secPerDensMin = DRAMA_TOTAL_S / Wtot0;    // 15s ÷ ∫dens → seconds per (dens·min)
    for (const g of guaranteed) {
      const SIG = g.sig || 0.32;
      const HALF = SIG * 2.3;                        // window half-width ~2.3σ
      const b0 = clamp(Math.floor((g.t - HALF) / DRAMA_DT), 0, N - 1);
      const b1 = clamp(Math.ceil((g.t + HALF) / DRAMA_DT), 0, N - 1);
      let localSec = 0;
      for (let b = b0; b <= b1; b++) { const dt = b * DRAMA_DT - g.t; const wt = Math.exp(-(dt * dt) / (2 * SIG * SIG)); localSec += dens[b] * DRAMA_DT * secPerDensMin * wt; }
      if (localSec < g.sec) {
        // solve amp so the ADDED (Gaussian-weighted) screen-seconds reaches target.
        let gArea = 0;
        for (let b = b0; b <= b1; b++) { const dt = b * DRAMA_DT - g.t; const gv = Math.exp(-(dt * dt) / (2 * SIG * SIG)); gArea += gv * DRAMA_DT * secPerDensMin * gv; }
        const amp = (g.sec - localSec) / Math.max(gArea, 1e-4);
        for (let b = b0; b <= b1; b++) { const dt = b * DRAMA_DT - g.t; dens[b] += amp * Math.exp(-(dt * dt) / (2 * SIG * SIG)); }
      }
    }
  }

  // cumulative W at each bin edge (len N+1), W[0]=0.
  dramaWcum = new Float32Array(N + 1);
  let acc = 0;
  for (let b = 0; b < N; b++) { acc += dens[b] * DRAMA_DT; dramaWcum[b + 1] = acc; }
  dramaWtot = acc;
}

// matchT(progress) — invert W: find match-minute t where W(t)/Wtot = progress.
// progress in [0,1] (wall-progress). Returns match-minutes in [0, fullT].
let _dramaCursor = 0;
function matchT(progress) {
  if (!dramaWcum || dramaWtot <= 0) return clamp(progress, 0, 1) * (teamMeta.duration || 100);
  const p = clamp(progress, 0, 1);
  const target = p * dramaWtot;
  const N = dramaN;
  // reset cursor if we jumped backwards.
  if (_dramaCursor >= N || dramaWcum[_dramaCursor] > target) _dramaCursor = 0;
  while (_dramaCursor < N && dramaWcum[_dramaCursor + 1] < target) _dramaCursor++;
  const b = clamp(_dramaCursor, 0, N - 1);
  const w0 = dramaWcum[b], w1 = dramaWcum[b + 1];
  const f = w1 > w0 ? (target - w0) / (w1 - w0) : 0;
  return clamp((b + f) * DRAMA_DT, 0, teamMeta.duration || 100);
}
// inverse: given a match-minute, the wall-progress that lands on it (for the scrub
// slider position + __setClock coherence). Binary-searchable but N is small.
function progressOfMatchT(t) {
  if (!dramaWcum || dramaWtot <= 0) return clamp(t / (teamMeta.duration || 100), 0, 1);
  const N = dramaN;
  const bf = clamp(t / DRAMA_DT, 0, N);
  const b = Math.min(N - 1, Math.floor(bf));
  const f = bf - b;
  const w = lerp(dramaWcum[b], dramaWcum[b + 1], f);
  return clamp(w / dramaWtot, 0, 1);
}

// ============================================================================
// HUD / camera (cloned from stage9)
// ============================================================================
let goalsByTime = [];
function countGoals() {
  goalsByTime = timeline.filter((it) => it.kind === 'shot' && it.isGoal).map((g) => ({ t: g.t, team: g.team }));
  teamMeta.score = { home: goalsByTime.filter((g) => g.team === 'home').length, away: goalsByTime.filter((g) => g.team === 'away').length };
}
function updateHud() {
  const t = clock;
  let gH = goalsByTime.filter((g) => g.team === 'home' && g.t <= t).length;
  let gA = goalsByTime.filter((g) => g.team === 'away' && g.t <= t).length;
  el('hScore').textContent = gH; el('aScore').textContent = gA;
  const mm = Math.floor(t);
  el('clk').textContent = mm + "'"; el('clk2').textContent = mm + "'";
  // the scrubber tracks WALL-PROGRESS through the 15s dramatic pass (not linear
  // match-minutes), so its position matches how long each moment holds on screen.
  if (document.activeElement !== el('clock')) el('clock').value = String(wallProgress * 100);
}
function updateCamReadout() {
  if (!controls) return;
  const az = THREE.MathUtils.radToDeg(controls.getAzimuthalAngle());
  const pol = THREE.MathUtils.radToDeg(controls.getPolarAngle());
  const dist = camera.position.distanceTo(controls.target);
  el('camread').textContent = `az ${az.toFixed(0)}° · pol ${pol.toFixed(0)}° · d ${dist.toFixed(1)}`;
}

// ============================================================================
// GLOBAL UI — play / restart / scrub / speed / camera / copy config / presets
// ============================================================================
// MATCH SWITCHER TABS — highlight the tab for the current ?id= and, on click, switch
// match by reloading with the new id (the simplest robust way; the whole timeline +
// dramatic clock rebuild on load). ID is the current match id parsed at boot.
function bindMatchTabs() {
  const tabs = document.querySelectorAll('#matchtabs .mtab');
  for (const tab of tabs) {
    const id = tab.dataset.id;
    if (id === ID) tab.classList.add('on');
    tab.addEventListener('click', () => {
      if (id === ID) return;                 // already on this match
      location.search = '?id=' + id;         // reload with the new match
    });
  }
}

function bindGlobalUI() {
  bindMatchTabs();
  const playBtn = el('play');
  playBtn.addEventListener('click', () => {
    playing = !playing; playBtn.textContent = playing ? '❚❚' : '▶';
  });
  el('restart').addEventListener('click', () => {
    wallProgress = 0; _dramaCursor = 0; clock = matchT(0); playing = true; playBtn.textContent = '❚❚'; snapASmoothing();
  });
  el('clock').addEventListener('input', () => {
    // slider is WALL-PROGRESS 0..100 through the dramatic pass → warp to match-min.
    wallProgress = clamp(+el('clock').value / 100, 0, 1);
    _dramaCursor = 0; clock = matchT(wallProgress);
    playing = false; playBtn.textContent = '▶'; _ballCursor = 0; snapASmoothing();
  });
  // seed the slider from the loaded cfg BEFORE binding, so bindSlider's initial
  // apply() reads the restored value instead of clobbering cfg.speed with the HTML
  // default (the old speed-not-restored bug). syncCfgToUI later re-affirms it.
  el('speed').value = cfg.speed;
  bindSlider('speed', 'speedV', (v) => { cfg.speed = v; writeHash(); return v.toFixed(1) + '×'; });

  el('resetcam').addEventListener('click', () => applyDefaultCamera());
  el('copycam').addEventListener('click', async () => {
    const s = `{ pos: [${camera.position.x.toFixed(2)}, ${camera.position.y.toFixed(2)}, ${camera.position.z.toFixed(2)}], ` +
      `target: [${controls.target.x.toFixed(2)}, ${controls.target.y.toFixed(2)}, ${controls.target.z.toFixed(2)}] }`;
    try { await navigator.clipboard.writeText(s); el('camread').textContent = 'copied'; } catch { el('camread').textContent = s; }
  });

  bindCfgButtons();
}

// brief inline confirmation on a button (e.g. "сохранено ✓") then restore label.
const _flashTimers = new WeakMap();
function flashBtn(btn, msg, ms = 1500) {
  if (!btn) return;
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  clearTimeout(_flashTimers.get(btn));
  btn.textContent = msg; btn.classList.add('ok');
  _flashTimers.set(btn, setTimeout(() => { btn.textContent = btn.dataset.label; btn.classList.remove('ok'); }, ms));
}

// COPY (clipboard) · SAVE (localStorage default) · СБРОС (clear + default).
function bindCfgButtons() {
  const copyBtn = el('cfgcopy'), saveBtn = el('cfgsave'), resetBtn = el('cfgreset'), pasteTA = el('cfgPaste');

  copyBtn && copyBtn.addEventListener('click', async () => {
    const json = JSON.stringify(cfg);
    try {
      await navigator.clipboard.writeText(json);
      if (pasteTA) pasteTA.style.display = 'none';
      flashBtn(copyBtn, 'скопировано ✓');
    } catch {
      // fallback: surface the JSON in a textarea + select it for manual copy.
      if (pasteTA) { pasteTA.value = json; pasteTA.style.display = 'block'; pasteTA.focus(); pasteTA.select();
        try { document.execCommand('copy'); flashBtn(copyBtn, 'скопировано ✓'); } catch { flashBtn(copyBtn, 'выдели ↓'); } }
      else flashBtn(copyBtn, 'ошибка');
    }
  });

  saveBtn && saveBtn.addEventListener('click', () => {
    flashBtn(saveBtn, saveCfgToStore() ? 'сохранено ✓' : 'ошибка');
  });

  resetBtn && resetBtn.addEventListener('click', () => {
    clearCfgStore(); clearHash();
    cfg = MATCH_DEFAULT();
    syncCfgToUI(); _ballCursor = 0; renderFrame(clock); composer.render();
    if (pasteTA) pasteTA.style.display = 'none';
    flashBtn(resetBtn, 'сброшено ✓');
  });
}

function bindSlider(id, valId, fn) {
  const s = el(id), v = el(valId);
  const apply = () => { v.textContent = fn(+s.value); };
  s.addEventListener('input', apply); apply();
}

// ============================================================================
// LAYER BUILDER UI — one row per layer (A,B,C,D) with an enable
// checkbox + an expandable group of sliders. Changing anything updates live.
// ============================================================================
const LAYER_DEFS = [
  { key: 'A', name: 'A · активность', controls: [
    { id: 'height', label: 'амплитуда ▸ высота', min: 0, max: 8, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'atk', label: 'скорость ▸ нарастание', min: 0.02, max: 2, step: 0.02, fmt: (v) => v.toFixed(2) },
    { id: 'rel', label: 'затухание ▸ спад', min: 0.3, max: 5, step: 0.1, fmt: (v) => v.toFixed(1) },
    { id: 'grid', label: 'детализация ▸ грид', min: 0, max: 1, step: 0.02, fmt: (v) => v.toFixed(2) },
    { id: 'focus', label: 'фокус ▸ зона игры', min: 0, max: 1, step: 0.02, fmt: (v) => v.toFixed(2) },
    { id: 'blur', label: 'сглаживание ▸ размытие', min: 0, max: 1, step: 0.02, fmt: (v) => v.toFixed(2) },
    { id: 'colour', label: 'насыщ. цвета ▸ цвет', min: 0, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'glow', label: 'яркость цвета ▸ свечение', min: 0, max: 2.5, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'sharp', label: 'резкость ▸ контраст', min: 0.3, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'floor', label: 'порог ▸ скрыть низ', min: 0, max: 0.8, step: 0.02, fmt: (v) => v.toFixed(2) },
    { id: 'lap', label: 'нахлёст ▸ глубина', min: 0, max: 0.2, step: 0.005, fmt: (v) => v.toFixed(3) },
    { id: 'lipH', label: 'кромка ▸ подъём', min: 0, max: 0.35, step: 0.01, fmt: (v) => v.toFixed(2) },
    { id: 'ownBand', label: 'мин. территория ▸ у ворот', min: 0, max: 0.35, step: 0.01, fmt: (v) => v.toFixed(2) },
    { id: 'xgW', label: 'xG ▸ ширина шпиля', min: 0.2, max: 4, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'xgH', label: 'xG ▸ высота шпиля', min: 0, max: 4, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'floodHold', label: 'гол ▸ держать заливку', min: 0, max: 8, step: 0.1, fmt: (v) => v.toFixed(1) + ' с' },
    { id: 'lull', label: 'гол ▸ пауза (штиль)', min: 0, max: 3, step: 0.1, fmt: (v) => v.toFixed(1) + ' с' },
    { id: 'thrust', label: 'выпад ▸ сила', min: 0, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) },
  ], contribHead: 'ПОДЪЁМ ИЗ:', contributors: [
    { on: 'cOwn',  w: 'wOwn',  label: 'Владение' },
    { on: 'cXg',   w: 'wXg',   label: 'Удары · xG (шпиль)' },
    { on: 'cProg', w: 'wProg', label: 'Продвижение' },
    { on: 'cPass', w: 'wPass', label: 'Пасы' },
    { on: 'cDuel', w: 'wDuel', label: 'Единоборства' },
    { on: 'cDrib', w: 'wDrib', label: 'Обводки' },
    { on: 'cAll',  w: 'wAll',  label: 'Общая активность' },
  ] },
];

const layerUIRefs = {};
function buildLayerUI() {
  const host = el('layers');
  for (const def of LAYER_DEFS) {
    const wrap = document.createElement('div');
    wrap.className = 'layer';
    const head = document.createElement('div'); head.className = 'layer-head';
    const ck = document.createElement('div'); ck.className = 'lck';
    const nm = document.createElement('div'); nm.className = 'lname'; nm.textContent = def.name;
    const chev = document.createElement('div'); chev.className = 'chev'; chev.textContent = '▸';
    head.append(ck, nm, chev);
    const body = document.createElement('div'); body.className = 'layer-body';

    const refs = { wrap, sliders: {}, pills: {} };
    layerUIRefs[def.key] = refs;

    for (const c of (def.controls || [])) {
      // two-line control: label + value on top, full-width slider below — so the
      // bigger fonts + longer RU labels never squeeze the slider track.
      const ctl = document.createElement('div'); ctl.className = 'ctl';
      const chead = document.createElement('div'); chead.className = 'ctl-head';
      const lab = document.createElement('label'); lab.textContent = c.label;
      const val = document.createElement('span'); val.className = 'val';
      chead.append(lab, val);
      const inp = document.createElement('input'); inp.type = 'range';
      inp.min = c.min; inp.max = c.max; inp.step = c.step;
      ctl.append(chead, inp); body.append(ctl);
      refs.sliders[c.id] = { inp, val, fmt: c.fmt };
      inp.addEventListener('input', () => {
        cfg[def.key][c.id] = +inp.value; val.textContent = c.fmt(+inp.value);
        writeHash(); _ballCursor = 0; if (!playing) snapASmoothing(); renderFrame(clock); composer.render();
      });
    }
    if (def.toggles) {
      const tg = document.createElement('div'); tg.className = 'subtoggle';
      for (const t of def.toggles) {
        const pill = document.createElement('div'); pill.className = 'pill'; pill.textContent = t.label;
        tg.append(pill); refs.pills[t.id] = pill;
        pill.addEventListener('click', () => {
          cfg[def.key][t.id] = !cfg[def.key][t.id];
          pill.classList.toggle('on', cfg[def.key][t.id]);
          writeHash(); renderFrame(clock); composer.render();
        });
      }
      body.append(tg);
    }
    // contributor checkboxes + weight sliders (Layer A): tick which signals lift.
    if (def.contributors) {
      refs.contribs = {};
      const hdr = document.createElement('div'); hdr.className = 'grp'; hdr.textContent = def.contribHead || '';
      body.append(hdr);
      for (const c of def.contributors) {
        const row = document.createElement('div'); row.className = 'contrib';
        const cbWrap = document.createElement('div'); cbWrap.className = 'contrib-head';
        const cb = document.createElement('div'); cb.className = 'lck sm';
        const lab = document.createElement('label'); lab.textContent = c.label;
        cbWrap.append(cb, lab);
        const wInp = document.createElement('input'); wInp.type = 'range';
        wInp.min = 0; wInp.max = 3; wInp.step = 0.05; wInp.className = 'wslider';
        row.append(cbWrap, wInp); body.append(row);
        refs.contribs[c.on] = { cb, row };
        refs.sliders[c.w] = { inp: wInp, val: { textContent: '' }, fmt: (v) => v.toFixed(2) };
        cb.addEventListener('click', () => {
          cfg[def.key][c.on] = !cfg[def.key][c.on];
          cb.classList.toggle('on', cfg[def.key][c.on]);
          row.classList.toggle('off', !cfg[def.key][c.on]);
          writeHash(); _ballCursor = 0; if (!playing) snapASmoothing(); renderFrame(clock); composer.render();
        });
        wInp.addEventListener('input', () => {
          cfg[def.key][c.w] = +wInp.value;
          writeHash(); _ballCursor = 0; if (!playing) snapASmoothing(); renderFrame(clock); composer.render();
        });
      }
    }
    wrap.append(head, body); host.append(wrap);

    // enable checkbox (stops the expand toggle)
    ck.addEventListener('click', (e) => {
      e.stopPropagation();
      cfg[def.key].on = !cfg[def.key].on;
      wrap.classList.toggle('on', cfg[def.key].on);
      writeHash(); renderFrame(clock); composer.render();
    });
    // expand/collapse
    head.addEventListener('click', () => {
      cfg[def.key].open = !cfg[def.key].open;
      wrap.classList.toggle('open', cfg[def.key].open);
      writeHash();
    });
  }
}

// push the current cfg into every UI control (after preset / hash load).
function syncCfgToUI() {
  el('speed').value = cfg.speed; el('speedV').textContent = cfg.speed.toFixed(1) + '×';
  for (const def of LAYER_DEFS) {
    const refs = layerUIRefs[def.key]; if (!refs) continue;
    const L = cfg[def.key];
    refs.wrap.classList.toggle('on', !!L.on);
    refs.wrap.classList.toggle('open', !!L.open);
    for (const id in refs.sliders) {
      const s = refs.sliders[id]; s.inp.value = L[id]; s.val.textContent = s.fmt(+L[id]);
    }
    for (const id in refs.pills) refs.pills[id].classList.toggle('on', !!L[id]);
    if (refs.contribs) for (const id in refs.contribs) {
      const c = refs.contribs[id]; c.cb.classList.toggle('on', !!L[id]); c.row.classList.toggle('off', !L[id]);
    }
  }
}

// ============================================================================
// CONFIG SAVE/LOAD — three layers of persistence:
//   1. URL #cfg=<base64> — updated live on every change (silent share link).
//   2. localStorage (STORE_KEY) — explicit SAVE → becomes the default on reload.
//   3. built-in MATCH_DEFAULT fallback.
// Load precedence on startup: hash > saved localStorage > default.
// ============================================================================
const STORE_KEY = 'wcp_stage10_cfg';

// merge a parsed config object onto DEFAULTS so partial/old configs stay valid.
// Only known layer keys are copied — an OLD cfg/#cfg= that still carries the
// removed ★ counters (K) key is ignored gracefully (never throws).
function cfgFromParsed(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const base = DEFAULTS();
  base.speed = Number.isFinite(parsed.speed) ? parsed.speed : base.speed;
  for (const k of ['A', 'B', 'C', 'D']) if (parsed[k]) Object.assign(base[k], parsed[k]);
  return base;
}

function writeHash() {
  try {
    const json = JSON.stringify(cfg);
    const b64 = btoa(unescape(encodeURIComponent(json)));
    const url = new URL(location.href); url.hash = 'cfg=' + b64;
    history.replaceState(null, '', url);
  } catch {}
}
function loadCfgFromHash() {
  try {
    const m = (location.hash || '').match(/cfg=([^&]+)/);
    if (!m) return null;
    return cfgFromParsed(JSON.parse(decodeURIComponent(escape(atob(m[1])))));
  } catch { return null; }
}
// localStorage persistence (explicit SAVE / СБРОС).
function loadCfgFromStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? cfgFromParsed(JSON.parse(raw)) : null;
  } catch { return null; }
}
function saveCfgToStore() { try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); return true; } catch { return false; } }
function clearCfgStore() { try { localStorage.removeItem(STORE_KEY); } catch {} }
function clearHash() {
  try { const url = new URL(location.href); url.hash = ''; history.replaceState(null, '', url.pathname + url.search); } catch {}
}

// ============================================================================
// DRAGGABLE HUD (cloned from stage9)
// ============================================================================
const HUD_KEYS = ['teams', 'score', 'clock'];
const HUD_STORE = 'stage10_hud_v1';
function setupHudLayout() {
  const widget = (k) => el('w_' + k);
  const defaults = () => ({
    teams: { x: 558, y: 155, s: 5.213 }, score: { x: 572, y: 243, s: 1.827 }, clock: { x: 1385, y: 165, s: 2.537 },
  });
  let layout;
  try { layout = JSON.parse(localStorage.getItem(HUD_STORE)) || defaults(); } catch { layout = defaults(); }
  const curOf = (k) => { const w = widget(k); return { x: Math.round(parseFloat(w.style.left) || 0), y: Math.round(parseFloat(w.style.top) || 0), s: +(parseFloat(w.dataset.s) || 1).toFixed(3) }; };
  const apply = () => {
    for (const k of HUD_KEYS) { const w = widget(k); if (!w) continue; const p = layout[k] || { x: 20, y: 20, s: 1 };
      w.style.left = p.x + 'px'; w.style.top = p.y + 'px'; w.style.transform = 'scale(' + (p.s || 1) + ')'; w.dataset.s = String(p.s || 1); }
  };
  apply();
  const editing = () => document.body.classList.contains('hud-edit');
  for (const k of HUD_KEYS) {
    const w = widget(k); if (!w) continue; const handle = w.querySelector('.rsz');
    w.addEventListener('pointerdown', (e) => {
      if (!editing() || e.target === handle) return; e.preventDefault();
      const sx = e.clientX, sy = e.clientY, ox = parseFloat(w.style.left) || 0, oy = parseFloat(w.style.top) || 0;
      const mv = (ev) => { w.style.left = (ox + ev.clientX - sx) + 'px'; w.style.top = (oy + ev.clientY - sy) + 'px'; };
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); layout[k] = curOf(k); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    });
    if (handle) handle.addEventListener('pointerdown', (e) => {
      if (!editing()) return; e.preventDefault(); e.stopPropagation();
      const sx = e.clientX, sy = e.clientY, os = parseFloat(w.dataset.s) || 1;
      const mv = (ev) => { const s = clamp(os + ((ev.clientX - sx) + (ev.clientY - sy)) / 180, 0.3, 6); w.style.transform = 'scale(' + s + ')'; w.dataset.s = String(s); };
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); layout[k] = curOf(k); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    });
  }
  const editBtn = el('hudedit');
  if (editBtn) editBtn.addEventListener('click', () => { document.body.classList.toggle('hud-edit'); editBtn.textContent = editing() ? '✓ готово' : '✥ двигать HUD'; });
  const saveBtn = el('hudsave');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    for (const k of HUD_KEYS) layout[k] = curOf(k); const json = JSON.stringify(layout);
    try { localStorage.setItem(HUD_STORE, json); } catch {} try { await navigator.clipboard.writeText(json); } catch {}
    const o = saveBtn.textContent; saveBtn.textContent = 'saved ✓'; setTimeout(() => saveBtn.textContent = o, 1300);
  });
  const resetBtn = el('hudreset');
  if (resetBtn) resetBtn.addEventListener('click', () => { try { localStorage.removeItem(HUD_STORE); } catch {} layout = defaults(); apply(); });
}
