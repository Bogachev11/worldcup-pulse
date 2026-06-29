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
import { clamp, lerp } from './claybattle.js';

const ID = new URLSearchParams(location.search).get('id') || '1953888';
const el = (id) => document.getElementById(id);

// FRA / SEN colours (per the brief).
const FRA_HEX = '#387ef0';
const SEN_HEX = '#0c954e';

// baked-in default camera (reuse stage9's tuned ракурс)
const DEFAULT_CAM = { pos: [-11.962, 18.664, 17.842], target: [-0.621, 1.826, 0.268] };
function applyDefaultCamera() {
  camera.position.set(DEFAULT_CAM.pos[0], DEFAULT_CAM.pos[1], DEFAULT_CAM.pos[2]);
  controls.target.set(DEFAULT_CAM.target[0], DEFAULT_CAM.target[1], DEFAULT_CAM.target[2]);
  controls.update();
}

// ---- pitch / mesh dims ------------------------------------------------------
const WORLD_X = 16, WORLD_Z = 9.6;       // pitch footprint
const M2W = WORLD_Z / 68;                 // metres → world units
const CROSSBAR_M = 2.44;
// the displayed cloth mesh (smooth) — sampled from the low-res field grids.
const GX = 160, GY = 96;
const VX = GX + 1, VY = GY + 1, NV = VX * VY;

const worldX = (u) => (u - 0.5) * WORLD_X;
const worldZ = (v) => (0.5 - v) * WORLD_Z;
const LOCUS_Y = 0.02;

// ---- scene state ------------------------------------------------------------
let renderer, scene, camera, controls, composer;
let bloomPass, gradePass, smaaPass;
let mesh, material, keyLight;
let pitchPlane, pitchMat;
let heightTex, heightData;                 // per-vertex displaced height (mesh res)
let colTex, colData;                        // per-vertex RGB (mesh res)
let heightBaseline = 0;
let timeline = null;                        // merged, mirrored, real-t event stream
let ballLocus = null;                       // locus anchors for ballAt()
let teamMeta = { home: { abbr: 'FRA' }, away: { abbr: 'SEN' }, score: { home: 0, away: 0 }, duration: 100 };

let clock = 0, playing = true;

const COL_HOME = new THREE.Color(FRA_HEX);
const COL_AWAY = new THREE.Color(SEN_HEX);
const teamColor = (team) => (team === 'away' ? COL_AWAY : COL_HOME);

// ============================================================================
// CONFIG — every layer's enable flag + its own knobs. This whole object is what
// gets serialised to the URL hash / COPY CONFIG and restored from a preset.
// ============================================================================
const DEFAULTS = () => ({
  speed: 0.9,
  // A · TWO TEAM BLANKETS (одеяла) — one cloth per team, meeting at an
  //  activity-shaped front with a small НАХЛЁСТ overlap. Height per team = amplitude
  //  · Σ ENABLED contributors through the asymmetric atk/rel envelope on the grid.
  //  height=amplitude, atk=attack/rise τ, rel=release/decay τ, grid=detail,
  //  blur=smoothing, colour=intensity, sharp=hill contrast/gamma, floor=threshold,
  //  lap=НАХЛЁСТ overlap band. cOWN..cALL = contributor on/off; wOWN..wALL = weights.
  A: {
    on: true, open: false, atk: 0.15, rel: 1.6, grid: 0.45, height: 1.0,
    colour: 1.0, blur: 0.75, sharp: 1.0, floor: 0.0, lap: 0.08,
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
    // xG SPIRE — regulated INDEPENDENTLY of сглаживание (which only widens the
    // activity swell grain) and of amplitude. xgW = spire WIDTH (scales the xG
    // stamp radius), xgH = spire HEIGHT (scales the crest term). Defaults = 1.0
    // reproduce the current sharp tall spire.
    xgW: 1.0, xgH: 1.0,
    // ФОКУС ▸ зона игры — radius of the spatial focus mask that anchors the
    // HEIGHT relief to the single live play locus (ballAt(t)). Tight = one
    // coherent swell where play is; wide → approaches the old free-form field.
    // Colour/coverage stay BROAD; only height is gated. 0..1 → σ in world units.
    focus: 0.2,
    // contributors (☑ default = true): which signals RAISE a team's blanket
    cOwn: true,  wOwn: 1.0,   // Владение — on-ball control density
    cXg: true,   wXg: 1.0,    // Удары · xG — sharp tall crest at the shot, ×xg
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
  timeline = buildTimelineFromDoc(tlDoc);
  ballLocus = buildBallLocus(timeline);
  countGoals();

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

  keyLight = new THREE.DirectionalLight(0xffffff, 3.0);
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
  scene.add(new THREE.HemisphereLight(0x6f86b0, 0x0a0d16, 0.55));
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
// SHARED CLOTH (Layer B surface) — a single thin sheet displaced by heightTex,
// coloured by colTex. Written from layer B; also carries the combined A+B height
// so C/D accents + cometY ride the visible surface. Layer A renders as two
// SEPARATE team blankets (see buildTeamBlankets) composited over this.
// ============================================================================
function buildCloth() {
  const geo = new THREE.PlaneGeometry(WORLD_X, WORLD_Z, GX, GY);
  geo.rotateX(-Math.PI / 2);

  heightData = new Float32Array(NV);
  heightTex = new THREE.DataTexture(heightData, VX, VY, THREE.RedFormat, THREE.FloatType);
  heightTex.magFilter = THREE.LinearFilter; heightTex.minFilter = THREE.LinearFilter;
  heightTex.needsUpdate = true;

  colData = new Float32Array(NV * 4);        // RGB + A(brightness gate)
  colTex = new THREE.DataTexture(colData, VX, VY, THREE.RGBAFormat, THREE.FloatType);
  colTex.magFilter = THREE.LinearFilter; colTex.minFilter = THREE.LinearFilter;
  colTex.needsUpdate = true;

  material = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.95, metalness: 0.12, envMapIntensity: 1.1,
    transparent: true,
  });
  const u = {
    uHeight: { value: heightTex },
    uColTex: { value: colTex },
    uTexel: { value: new THREE.Vector2(1 / VX, 1 / VY) },
    uHScale: { value: 1.0 },
    uBaseline: { value: 0 },
    uWorld: { value: new THREE.Vector2(WORLD_X, WORLD_Z) },
    uClay: { value: new THREE.Color('#3a3f4a') },
  };
  material.userData.u = u;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = `
      uniform sampler2D uHeight; uniform vec2 uTexel; uniform float uHScale;
      uniform float uBaseline; uniform vec2 uWorld;
      varying float vHd; varying vec2 vUvN;
      float H10(vec2 uv){ float h = texture2D(uHeight, uv).r * uHScale; if(!(h==h)) h=0.0; return h; }
    ` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>
        vUvN = uv;
        float hl = H10(uv - vec2(uTexel.x,0.0)); float hr = H10(uv + vec2(uTexel.x,0.0));
        float hd = H10(uv - vec2(0.0,uTexel.y)); float hu = H10(uv + vec2(0.0,uTexel.y));
        float dx = (uWorld.x*uTexel.x)*2.0; float dz = (uWorld.y*uTexel.y)*2.0;
        objectNormal = normalize(vec3(-(hr-hl)/max(dx,1e-4), 1.0, -(hu-hd)/max(dz,1e-4)));`);
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
      `#include <begin_vertex>
        float h10 = H10(uv); vHd = h10; transformed.y += (h10 - uBaseline);`);
    shader.fragmentShader = `
      uniform sampler2D uColTex; uniform vec3 uClay;
      varying float vHd; varying vec2 vUvN;
    ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>',
      `#include <color_fragment>
      {
        vec4 cd = texture2D(uColTex, vUvN);
        // The B relief rises out of the VIVID flat territory below it, so it must
        // glow the SAME vivid team colour — otherwise a lit-only dome reads as a
        // dark navy "hole" inside the bright field. Saturate the (dim, ×w) team
        // colour back to full chroma so the dome is uniformly vivid, shape coming
        // from the height shading + emissive, never from a brightness dip.
        vec3 chroma = cd.rgb / max(max(cd.r, max(cd.g, cd.b)), 1e-4);  // full-sat team hue
        vec3 baseCol = mix(uClay, chroma, clamp(length(cd.rgb)*4.0, 0.0, 1.0));
        diffuseColor.rgb = baseCol;
        diffuseColor.a *= clamp(cd.a, 0.0, 1.0);   // B fades out where it has no relief
      }`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      {
        vec4 cd = texture2D(uColTex, vUvN);
        // Strong emissive at the full-saturation team hue so a B dome over a team's
        // territory GLOWS that vivid colour (no dark hole), matching the flat field.
        vec3 chroma = cd.rgb / max(max(cd.r, max(cd.g, cd.b)), 1e-4);
        float on = clamp(length(cd.rgb)*4.0, 0.0, 1.0);
        totalEmissiveRadiance += chroma * on * 0.95 * clamp(cd.a, 0.0, 1.0);
      }`);
  };
  mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true; mesh.receiveShadow = true; mesh.renderOrder = 0;
  scene.add(mesh);

  buildTeamBlankets();
  buildPitchPlane();
  buildAccentLayer();
  buildCometLayer();
}

// ============================================================================
// A · TWO TEAM BLANKETS — one full-pitch cloth per team. Each has its own height
// texture (from its enabled contributors) and a coverage(alpha) texture (crisp
// front from local presence share, extended by НАХЛЁСТ so the two laps overlap).
// Solid team colour where covered, transparent where the opponent owns. The
// taller team's sheet laps ON TOP (set per-frame via renderOrder).
// ============================================================================
let blankets = null;  // { home:{mesh,hData,hTex,aData,aTex,u}, away:{...} }
function makeBlanket(teamCol) {
  const geo = new THREE.PlaneGeometry(WORLD_X, WORLD_Z, GX, GY);
  geo.rotateX(-Math.PI / 2);
  const hData = new Float32Array(NV);
  const hTex = new THREE.DataTexture(hData, VX, VY, THREE.RedFormat, THREE.FloatType);
  hTex.magFilter = THREE.LinearFilter; hTex.minFilter = THREE.LinearFilter; hTex.needsUpdate = true;
  const aData = new Float32Array(NV);    // coverage alpha 0..1
  const aTex = new THREE.DataTexture(aData, VX, VY, THREE.RedFormat, THREE.FloatType);
  aTex.magFilter = THREE.LinearFilter; aTex.minFilter = THREE.LinearFilter; aTex.needsUpdate = true;

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.92, metalness: 0.1, envMapIntensity: 1.1,
    transparent: true, depthWrite: true, side: THREE.DoubleSide,
  });
  const u = {
    uHeight: { value: hTex }, uCov: { value: aTex },
    uTexel: { value: new THREE.Vector2(1 / VX, 1 / VY) },
    uBaseline: { value: 0 }, uWorld: { value: new THREE.Vector2(WORLD_X, WORLD_Z) },
    uTeam: { value: new THREE.Color(teamCol) },
    uGlow: { value: 1.0 },     // ЯРКОСТЬ ЦВЕТА — emissive strength of flat territory
  };
  mat.userData.u = u;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = `
      uniform sampler2D uHeight; uniform vec2 uTexel; uniform float uBaseline; uniform vec2 uWorld;
      varying float vHd; varying vec2 vUvN;
      float HB(vec2 uv){ float h = texture2D(uHeight, uv).r; if(!(h==h)) h=0.0; return h; }
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
        float hb = HB(uv); vHd = hb; transformed.y += (hb - uBaseline);`);
    shader.fragmentShader = `
      uniform sampler2D uCov; uniform vec3 uTeam; uniform float uGlow;
      varying float vHd; varying vec2 vUvN;
    ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>',
      `#include <color_fragment>
      {
        // FLAT painted territory: solid team colour, height adds a touch of
        // luminance only on the (rare) raised hill so the crest still reads.
        vec3 col = uTeam * (0.9 + 0.35 * clamp(vHd*0.5, 0.0, 1.0));
        diffuseColor.rgb = col;
        // Effective coverage = the partition mask, BUT a tall xG SPIRE always shows
        // even if the OPPONENT owns that territory (a shot into the rival's half must
        // still poke through). Threshold is high (3→5) so ONLY the sharp xG spire
        // forces through — the gentler focus SWELL (≲2) never pokes into the
        // opponent's colour zone (that would look like an enclave).
        float cov = texture2D(uCov, vUvN).r;
        float covEff = max(clamp(cov, 0.0, 1.0), smoothstep(3.0, 5.0, vHd));
        diffuseColor.a *= covEff;
      }`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>',
      `if (diffuseColor.a < 0.02) discard;
       #include <alphatest_fragment>`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
       {
         // The territory lies FLAT on the pitch, so lit shading alone renders it
         // dark. Drive a strong EMISSIVE = team colour × coverage × glow so the
         // flat paint glows its team colour vividly regardless of height. The one
         // raised hill (+xG spire) gets an extra hot boost so crests still pop.
         float cov = texture2D(uCov, vUvN).r;
         float covEff = max(clamp(cov, 0.0, 1.0), smoothstep(3.0, 5.0, vHd));
         vec3 emit = uTeam * covEff * (0.9 * uGlow);
         float hot = smoothstep(0.5, 3.0, vHd);
         emit += uTeam * hot * (0.6 * uGlow);
         totalEmissiveRadiance += emit;
       }`);
  };
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true; m.receiveShadow = true;
  scene.add(m);
  return { mesh: m, hData, hTex, aData, aTex, u };
}
function buildTeamBlankets() {
  blankets = { home: makeBlanket(FRA_HEX), away: makeBlanket(SEN_HEX) };
}

// ---- STATIC PITCH-MARKINGS PLANE at y=0 (from stage9) -----------------------
function buildPitchPlane() {
  const geo = new THREE.PlaneGeometry(WORLD_X, WORLD_Z, 1, 1);
  geo.rotateX(-Math.PI / 2);
  pitchMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: true, side: THREE.DoubleSide,
    uniforms: { uLines: { value: 0.6 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: PITCH_FRAG,
  });
  pitchPlane = new THREE.Mesh(geo, pitchMat);
  pitchPlane.position.y = 0.0; pitchPlane.renderOrder = -1;
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
    vec3 ground = vec3(0.02,0.03,0.05); vec3 lineCol = vec3(0.92,0.94,0.97);
    vec3 col = mix(ground, lineCol, lines); float alpha = max(0.12*clamp(uLines,0.0,1.0), lines);
    gl_FragColor = vec4(col, alpha); }
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
// A is now TWO team blankets: per-team HEIGHT grids (hH/hA — from enabled
// contributors) + per-team PRESENCE grids (pH/pA — control density, drives the
// coverage mask / front, independent of which height contributors are ticked).
let A_gx = 0, A_gy = 0, A_hH = null, A_hA = null, A_pH = null, A_pA = null;
let A_xH = null, A_xA = null;     // xG SHARP crests (kept separate so they stay tall)
// COVERAGE presence — a SEPARATE, heavily-diffused pair of presence grids used
// ONLY to decide which team OWNS each cell of the colour partition. Distinct from
// the height presence (A_pH/A_pA): coverage gets a wide spatial blur + a faint
// per-half prior so ownership fills the WHOLE pitch (no black quiet zones), while
// HEIGHT keeps its tight grain/focus. cH owns left (home defends u<0.5), cA right.
let A_cH = null, A_cA = null, A_cTmp = null;
// temporally-SMOOTHED copies of the per-team height/presence grids. Each frame
// the freshly computed grids are lerped INTO these (see smoothA), and rendering
// reads from these — so the surface + colour edges glide instead of twitching.
let A_shH = null, A_shA = null, A_spH = null, A_spA = null, A_sxH = null, A_sxA = null;
let A_scH = null, A_scA = null;   // smoothed COVERAGE presence (drives the partition)
let A_own = null, A_sown = null, A_lbl = null, A_stack = null;   // ownership (raw + eased) + flood-fill scratch
let A_smoothReset = true;         // first frame after a grid resize: snap, don't lerp
let focusCX = NaN, focusCZ = NaN, focusReset = true;   // eased focus-hill centre (glides)
let B_gx = 0, B_gy = 0, B_h = null, B_hH = null, B_hA = null;

function ensureA(gx, gy) {
  if (gx === A_gx && gy === A_gy) return;
  A_gx = gx; A_gy = gy; const n = gx * gy;
  A_hH = new Float32Array(n); A_hA = new Float32Array(n);
  A_pH = new Float32Array(n); A_pA = new Float32Array(n);
  A_xH = new Float32Array(n); A_xA = new Float32Array(n);
  A_cH = new Float32Array(n); A_cA = new Float32Array(n); A_cTmp = new Float32Array(n);
  A_shH = new Float32Array(n); A_shA = new Float32Array(n);
  A_spH = new Float32Array(n); A_spA = new Float32Array(n);
  A_sxH = new Float32Array(n); A_sxA = new Float32Array(n);
  A_scH = new Float32Array(n); A_scA = new Float32Array(n);
  A_own = new Float32Array(n);          // 1 = home owns cell, 0 = away (enclave-free)
  A_sown = new Float32Array(n);         // temporally-eased ownership (sampled by partition)
  A_lbl = new Int32Array(n); A_stack = new Int32Array(n);
  A_smoothReset = true;
}
// Kill ENCLAVES: build ownership from sign(scH - scA), then keep only the LARGEST
// connected component for EACH team — any smaller island is flipped to the
// opponent. Guarantees each team is ONE connected region meeting at a single
// front. 4-connected flood fill on the A-grid; cheap at this resolution.
function cleanOwnership(gx, gy) {
  const n = gx * gy;
  for (let i = 0; i < n; i++) A_own[i] = A_scH[i] >= A_scA[i] ? 1 : 0;
  // two passes: for each team value (1 then 0), find the largest component and
  // flip every OTHER component of that team to the opponent.
  for (let pass = 0; pass < 2; pass++) {
    const team = pass === 0 ? 1 : 0, other = pass === 0 ? 0 : 1;
    A_lbl.fill(0);
    let curLabel = 0, bestLabel = 0, bestSize = -1;
    const sizes = [];
    for (let s = 0; s < n; s++) {
      if (A_own[s] !== team || A_lbl[s] !== 0) continue;
      curLabel++; let sp = 0, size = 0; A_stack[sp++] = s; A_lbl[s] = curLabel;
      while (sp > 0) {
        const c = A_stack[--sp]; size++;
        const cx = c % gx, cy = (c / gx) | 0;
        if (cx > 0)      { const nb = c - 1;  if (A_own[nb] === team && A_lbl[nb] === 0) { A_lbl[nb] = curLabel; A_stack[sp++] = nb; } }
        if (cx < gx - 1) { const nb = c + 1;  if (A_own[nb] === team && A_lbl[nb] === 0) { A_lbl[nb] = curLabel; A_stack[sp++] = nb; } }
        if (cy > 0)      { const nb = c - gx; if (A_own[nb] === team && A_lbl[nb] === 0) { A_lbl[nb] = curLabel; A_stack[sp++] = nb; } }
        if (cy < gy - 1) { const nb = c + gx; if (A_own[nb] === team && A_lbl[nb] === 0) { A_lbl[nb] = curLabel; A_stack[sp++] = nb; } }
      }
      sizes[curLabel] = size;
      if (size > bestSize) { bestSize = size; bestLabel = curLabel; }
    }
    // flip every cell of this team that is NOT in the largest component.
    if (curLabel > 1) for (let s = 0; s < n; s++) if (A_lbl[s] !== 0 && A_lbl[s] !== bestLabel) A_own[s] = other;
  }
}
// Separable box blur (radius r cells) of `src` into itself, using A_cTmp scratch.
// Heavy blur diffuses event-spot presence across a team's whole controlled region
// so quiet cells inherit an owner. Edges clamp (no wrap).
function blurGrid(src, gx, gy, r) {
  if (r < 1) return;
  const win = 2 * r + 1, inv = 1 / win, tmp = A_cTmp;
  // horizontal
  for (let j = 0; j < gy; j++) {
    const row = j * gx;
    for (let i = 0; i < gx; i++) {
      let s = 0;
      for (let k = -r; k <= r; k++) { const ii = clamp(i + k, 0, gx - 1); s += src[row + ii]; }
      tmp[row + i] = s * inv;
    }
  }
  // vertical
  for (let i = 0; i < gx; i++) {
    for (let j = 0; j < gy; j++) {
      let s = 0;
      for (let k = -r; k <= r; k++) { const jj = clamp(j + k, 0, gy - 1); s += tmp[jj * gx + i]; }
      src[j * gx + i] = s * inv;
    }
  }
}
// Ease each smoothed grid toward the freshly computed one. `k` is the per-frame
// blend (0..1); small k = calmer. On a resize / scrub we SNAP (k=1) once so a
// jump-cut doesn't smear. Scrub-safety: the smoothing is purely cosmetic glide
// on top of the deterministic per-t fields.
function smoothA(k, kCov) {
  const snap = A_smoothReset;
  const kk = snap ? 1 : clamp(k, 0, 1);
  const kc = snap ? 1 : clamp(kCov, 0, 1);   // coverage glides SLOWER (calm front)
  A_smoothReset = false;
  for (let i = 0; i < A_hH.length; i++) {
    A_shH[i] += (A_hH[i] - A_shH[i]) * kk;
    A_shA[i] += (A_hA[i] - A_shA[i]) * kk;
    A_spH[i] += (A_pH[i] - A_spH[i]) * kk;
    A_spA[i] += (A_pA[i] - A_spA[i]) * kk;
    A_sxH[i] += (A_xH[i] - A_sxH[i]) * kk;
    A_sxA[i] += (A_xA[i] - A_sxA[i]) * kk;
    A_scH[i] += (A_cH[i] - A_scH[i]) * kc;
    A_scA[i] += (A_cA[i] - A_scA[i]) * kc;
  }
}
function ensureB(gx, gy) {
  if (gx === B_gx && gy === B_gy) return;
  B_gx = gx; B_gy = gy; const n = gx * gy;
  B_h = new Float32Array(n); B_hH = new Float32Array(n); B_hA = new Float32Array(n);
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
  if (A.cXg && isShot) {
    // sharp tall crest at the shot, scaled by xg; goals tallest. Kept SEPARATE
    // (A_xH/A_xA) so it stays a tall spire above the gentle swells.
    const xg = clamp(e.xg || 0, 0, 1);
    sharp += A.wXg * (1.0 + 4.5 * xg + (e.isGoal ? 2.5 : 0));
  }
  return { lift, sharp };
}

// Recompute the TWO team A grids for time t (height + presence). Returns whether
// any A activity fell in the window.
function computeA(t) {
  const atk = Math.max(0.02, cfg.A.atk);
  const rel = Math.max(0.1, cfg.A.rel);
  // coarse → fine. grid 0 = ~14 cells long, grid 1 = ~34.
  const { gx, gy } = gridDims(cfg.A.grid, 14, 34);
  ensureA(gx, gy);
  A_hH.fill(0); A_hA.fill(0); A_pH.fill(0); A_pA.fill(0); A_xH.fill(0); A_xA.fill(0);
  A_cH.fill(0); A_cA.fill(0);
  // base radius from detail; smoothing (blur) widens the swells; the xG crest uses
  // a much tighter radius so the chance reads as a sharp spire, not a swell.
  const radCells = lerp(2.6, 1.4, clamp(cfg.A.grid, 0, 1)) * lerp(0.6, 2.2, clamp(cfg.A.blur, 0, 1));
  // xG spire WIDTH is INDEPENDENT of сглаживание/grid: derive the base sharp radius
  // from grid only (not blur), then scale by the dedicated xgW slider.
  const xgW = Number.isFinite(cfg.A.xgW) ? clamp(cfg.A.xgW, 0.2, 4) : 1;
  const baseSharp = lerp(2.6, 1.4, clamp(cfg.A.grid, 0, 1)) * 0.3;
  const sharpRad = Math.max(0.5, baseSharp * xgW);
  // coverage presence uses a WIDE stamp so each event paints a broad ownership
  // claim, not a spot — combined with the heavy blur below this fills the pitch.
  const covRad = radCells * 2.2;
  const win = eventsInWindow(t, rel * 5 + atk * 3);
  for (const e of win) {
    const env = arWeight(t - e.t, atk, rel);
    if (env < 0.02) continue;
    const isH = e.team === 'home';
    if (!isH && e.team !== 'away') continue;
    const Hgrid = isH ? A_hH : A_hA, Pgrid = isH ? A_pH : A_pA, Xgrid = isH ? A_xH : A_xA;
    const Cgrid = isH ? A_cH : A_cA;
    // PRESENCE (coverage/front) — on-ball control + every touch, weighted by env.
    const pw = (POSSESSION_TYPES.has(e.type) || e.isTouch || e.kind === 'pass') ? 1.0 : 0.5;
    stamp(Pgrid, gx, gy, e.u, e.v, env * pw, radCells);
    // COVERAGE claim — wide stamp into the diffused ownership field.
    stamp(Cgrid, gx, gy, e.u, e.v, env * pw, covRad);
    // HEIGHT — gentle swells from the enabled contributors.
    const { lift, sharp } = contribLift(e);
    if (lift > 0) stamp(Hgrid, gx, gy, e.u, e.v, lift * env, radCells);
    if (sharp > 0) {
      // xG crest: tall, tight, kept separate; also FORCE coverage at the shot so
      // the danger spire is never masked away even if the team has little presence.
      stamp(Xgrid, gx, gy, e.u, e.v, sharp * env, sharpRad);
      stamp(Pgrid, gx, gy, e.u, e.v, env * 2.0, sharpRad * 1.4);
      stamp(Cgrid, gx, gy, e.u, e.v, env * 2.0, covRad);
    }
  }
  // ---- COVERAGE PARTITION prep: make ownership fill the WHOLE pitch ----------
  // 1) Faint per-half PRIOR: home defends the left (u<0.5), away the right. This
  //    seeds genuinely empty cells so they default to the nearer team's colour
  //    (no black) — but it's weak enough that real activity bends the boundary.
  // 2) HEAVY box blur diffuses each team's event presence across its controlled
  //    region, so the boundary is smooth + activity-shaped (bulges left/right),
  //    not a spotty per-event mask. Much wider than the height grain.
  let cMax = 1e-4;
  for (let k = 0; k < A_cH.length; k++) { if (A_cH[k] > cMax) cMax = A_cH[k]; if (A_cA[k] > cMax) cMax = A_cA[k]; }
  const prior = cMax * 0.05;            // weak — only decides truly empty zones
  // OWN-GOAL BAND PRIOR — each team ALWAYS holds a strip at its own goal. Home's
  // own goal is at u≈0, away's at u≈1 (home attacks u→1, see toUV). Inside the
  // band the team's own coverage gets a STRONG positional boost (≫ cMax) so the
  // opponent's activity can never out-claim it; the boost fades to neutral by the
  // band's inner edge, so the contested front stays activity-shaped beyond it.
  const band = clamp(Number.isFinite(cfg.A.ownBand) ? cfg.A.ownBand : 0, 0, 0.45);
  const bandBoost = cMax * 6.0;         // dominant inside the band → guarantees ownership
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      const u = i / (gx - 1);
      A_cH[j * gx + i] += prior * (1 - u);   // home prior strongest at u=0 (left)
      A_cA[j * gx + i] += prior * u;          // away prior strongest at u=1 (right)
      if (band > 0.001) {
        // home band: u in [0, band] → boost fades 1→0 across the band.
        const fh = clamp(1 - u / band, 0, 1);
        if (fh > 0) A_cH[j * gx + i] += bandBoost * (fh * fh * (3 - 2 * fh));
        // away band: u in [1-band, 1] → boost fades 0→1 toward u=1.
        const fa = clamp((u - (1 - band)) / band, 0, 1);
        if (fa > 0) A_cA[j * gx + i] += bandBoost * (fa * fa * (3 - 2 * fa));
      }
    }
  }
  // HEAVY blur (two passes) so small local pockets dissolve into the surrounding
  // owner → one clean connected front, no speckles. Much wider than height grain.
  const covBlur = Math.max(3, Math.round(gx * 0.18));   // wide diffusion radius
  blurGrid(A_cH, gx, gy, covBlur);
  blurGrid(A_cA, gx, gy, covBlur);
  blurGrid(A_cH, gx, gy, covBlur);
  blurGrid(A_cA, gx, gy, covBlur);
  // glide the smoothed grids toward this frame's fields. The COLOUR/front and the
  // HEIGHT/hill must run on the SAME clock: the raw coverage presence (A_cH/A_cA)
  // already decays at the user's спад (cfg.A.rel) via arWeight — the SAME window
  // as the height contributors — so the front advances AND recedes with play. The
  // per-frame temporal ease here is now MINOR and shared between height and
  // coverage (no separate multi-minute lag): it only damps per-frame popping; the
  // dominant time constant is the спад window itself. A faster спад → quicker ease
  // so the colour can't lag the спад it's meant to follow.
  const snapNow = A_smoothReset;          // capture before smoothA clears it
  const easeK = covEaseK();
  smoothA(easeK, easeK);
  // From the (slowly-eased) coverage presence, build an ENCLAVE-FREE ownership map
  // (largest connected component per team), then lightly blur it so the boundary
  // reads as a clean soft front with a small overlap. A_own becomes the 0..1 home
  // share sampled by the partition in computeField.
  cleanOwnership(gx, gy);
  // HARD-FORCE the own-goal bands: regardless of the diffused presence + flood
  // fill, every cell inside a team's own-goal band is owned by that team. This
  // guarantees the defender keeps a visible strip even under total siege (the
  // prior boost above already bends the front; this makes the band absolute and
  // keeps the flood from being overridden away — flood is applied AFTER this).
  if (band > 0.001) {
    for (let j = 0; j < gy; j++) {
      const row = j * gx;
      for (let i = 0; i < gx; i++) {
        const u = i / (gx - 1);
        if (u <= band) A_own[row + i] = 1;          // home keeps its band (home=1)
        else if (u >= 1 - band) A_own[row + i] = 0; // away keeps its band (away=0)
      }
    }
  }
  // GOAL FLOOD override — the scoring team's colour sweeps to fill the WHOLE
  // pitch then recedes. amt=1 → every cell the scorer's owner value; partial amt
  // pushes ownership toward the scorer proportionally (so the sweep reads as the
  // colour washing across). Overrides the own-goal bands only during the flood.
  const flood = goalFloodAt(t);
  if (flood && flood.amt > 0.001) {
    const target = flood.team === 'home' ? 1 : 0;   // owner value of the scorer
    const a = flood.amt;
    // SPATIAL WASH: the scorer's colour advances as a soft front from the
    // scorer's OWN end across the whole pitch as amt rises 0→1. Home (own goal at
    // u≈0) washes u: 0→1; away (own goal at u≈1) washes u: 1→0. A soft edge
    // (width ~0.22) makes it read as a sweeping wave rather than a hard line.
    const ew = 0.22;
    for (let j = 0; j < gy; j++) {
      const row = j * gx;
      for (let i = 0; i < gx; i++) {
        const u = i / (gx - 1);
        // distance from the scorer's own end, 0 at their goal → 1 at the far end.
        const d = flood.team === 'home' ? u : (1 - u);
        // front reaches distance `a*(1+ew)`; cells behind it are fully scorer.
        const cover = clamp(((a * (1 + ew)) - d) / ew, 0, 1);
        const sm = cover * cover * (3 - 2 * cover);
        A_own[row + i] = lerp(A_own[row + i], target, sm);
      }
    }
  }
  blurGrid(A_own, gx, gy, Math.max(1, Math.round(gx * 0.05)));
  // ease the ownership field TEMPORALLY too, only to keep a boundary cell from
  // POPPING when the threshold flips — MINOR, same shared clock as the coverage
  // presence (covEaseK). The real time constant is the спад window, so the front
  // tracks play instead of dragging a multi-minute tail. Snaps on scrub; during an
  // active flood we SNAP so the deterministic sweep/recede envelope is exact.
  const ko = (snapNow || flood) ? 1 : easeK;
  for (let i = 0; i < A_own.length; i++) A_sown[i] += (A_own[i] - A_sown[i]) * ko;
  return win.length > 0;
}
// Shared per-frame ease for BOTH the height/hill grids and the coverage/ownership
// front, so colour and hill move on ONE clock. It is deliberately MINOR (just
// anti-pop): the dominant temporal behaviour comes from the спад (cfg.A.rel)
// window baked into arWeight. Scale the ease with спад — a SHORT спад (snappy
// play) eases faster so the front keeps up; a LONG спад can ease a touch calmer.
// Never a fixed long lag: clamped to a brisk band well above the old k≈0.06.
function covEaseK() {
  const rel = Math.max(0.1, cfg.A.rel);
  // rel 0.3→fast (~0.30), rel 5→calmer (~0.16); always ≥ A_SMOOTH-ish, never slow.
  return clamp(0.34 - rel * 0.036, 0.16, 0.34);
}

// ---- GOAL FLOOD — the ONLY full-pitch single colour --------------------------
// On a goal the SCORING team's colour sweeps to fill the ENTIRE pitch (a
// celebratory symbol), then recedes to the normal contested front. The envelope
// is driven DETERMINISTICALLY from the clock: at time t we find the most recent
// isGoal ≤ t, compute elapsed = t − goalTime (in CLOCK match-minutes, the same
// unit __setClock / the scrubber use), and shape a 0..1 intensity. Scrub-safe:
// no frame state — scrubbing onto a goal shows the flood, away shows normal.
// Phases (clock-minutes): sweep up over FLOOD_SWEEP, hold full for FLOOD_HOLD,
// relax back over FLOOD_RELAX. Total ~1.15 match-minutes so it reads FULL around
// goalTime+0.5min and has fully RECEDED to the normal split well before the next
// minute of play (FRA's 72.5' goal must not still be flooding at 74'). Short and
// celebratory — the whole blanket flashes the scorer's colour, then settles.
const FLOOD_SWEEP = 0.3, FLOOD_HOLD = 0.45, FLOOD_RELAX = 0.4;
const FLOOD_TOTAL = FLOOD_SWEEP + FLOOD_HOLD + FLOOD_RELAX;
// Returns { team:'home'|'away', amt:0..1 } for the active flood at clock t, or
// null when no flood is active. amt = how fully the scorer's colour covers the
// pitch (1 = whole pitch the scorer colour).
function goalFloodAt(t) {
  if (!goalsByTime || !goalsByTime.length) return null;
  // most recent goal at or before t
  let g = null;
  for (let i = 0; i < goalsByTime.length; i++) {
    if (goalsByTime[i].t <= t) g = goalsByTime[i]; else break;
  }
  if (!g) return null;
  const elapsed = t - g.t;
  if (elapsed < 0 || elapsed >= FLOOD_TOTAL) return null;
  let amt;
  if (elapsed < FLOOD_SWEEP) {
    const f = elapsed / FLOOD_SWEEP; amt = f * f * (3 - 2 * f);          // smooth sweep up
  } else if (elapsed < FLOOD_SWEEP + FLOOD_HOLD) {
    amt = 1;                                                            // hold full
  } else {
    const f = (elapsed - FLOOD_SWEEP - FLOOD_HOLD) / FLOOD_RELAX;
    const e = f * f * (3 - 2 * f); amt = 1 - e;                         // relax back
  }
  return { team: g.team, amt: clamp(amt, 0, 1) };
}

// Recompute layer B's grid (finer pass relief). aggr 0 = each pass a small sharp
// bump; aggr 1 = broad smoothed density.
function computeB(t) {
  const atk = Math.max(0.02, cfg.B.atk);
  const rel = Math.max(0.1, cfg.B.rel);
  const { gx, gy } = gridDims(1, 40, 40);     // B is always fine
  ensureB(gx, gy);
  B_h.fill(0); B_hH.fill(0); B_hA.fill(0);
  // aggregation knob → stamp radius (sharp small bumps ↔ smoothed density)
  const radCells = lerp(0.9, 4.2, clamp(cfg.B.aggr, 0, 1));
  const amp = lerp(1.0, 0.55, clamp(cfg.B.aggr, 0, 1));   // keep total mass ~steady
  const win = eventsInWindow(t, rel * 5 + atk * 3);
  for (const e of win) {
    if (e.kind !== 'pass') continue;
    let w = arWeight(t - e.t, atk, rel) * amp;
    if (w < 0.02) continue;
    if (cfg.B.longw > 0) {                                  // optional long-pass weighting
      const lenW = 1 + cfg.B.longw * (e.long ? 1.2 : clamp(e.len / 40, 0, 1));
      w *= lenW;
    }
    stamp(B_h, gx, gy, e.u, e.v, w, radCells);
    if (e.team === 'home') stamp(B_hH, gx, gy, e.u, e.v, w, radCells);
    else stamp(B_hA, gx, gy, e.u, e.v, w, radCells);
  }
  return win.length > 0;
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

// Rebuild the field surfaces at time t: TWO team A blankets (height + crisp
// coverage) plus the shared B relief. Folds A+B into heightData so accents ride.
function computeField(t) {
  const aOn = cfg.A.on, bOn = cfg.B.on;
  let bMax = 1e-4;
  if (aOn) computeA(t);
  if (bOn) { computeB(t); for (let k = 0; k < B_h.length; k++) bMax = Math.max(bMax, B_h[k]); }

  const ball = ballAt(t);
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
    const d = Math.hypot(tgtX - focusCX, tgtZ - focusCZ);
    const ke = clamp(0.10 + d * 0.04, 0.10, 0.5);   // base glide; speeds up for big jumps
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
  // wide focus (slider near max) lets the mask approach 1 everywhere (old field).
  const focusFloor = clamp((cfg.A.focus - 0.82) / 0.18, 0, 1) * 0.6;
  const focusMask = (wx, wz) => {
    let m = 0;
    for (const p of focusPts) {
      const dx = wx - p.fx, dz = wz - p.fz;
      const g = p.w * Math.exp(-(dx * dx + dz * dz) / focus2);
      if (g > m) m = g;
    }
    return clamp(m + focusFloor, 0, 1);
  };
  const cH = COL_HOME, cA = COL_AWAY;
  // fabric wobble phase — gentle undulation so each blanket drapes like cloth.
  const ph = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.00018;
  const amp = clamp(cfg.A.height, 0, 3);
  const xgH = Number.isFinite(cfg.A.xgH) ? clamp(cfg.A.xgH, 0, 4) : 1;   // xG spire height (independent of amp)
  // TERRITORY LIES FLAT. The old uniform base body raised EVERY covered cell, so
  // a team whose coverage spanned multiple zones (e.g. both wings) showed several
  // detached raised domes. The base is now ~0 — covered-but-quiet zones stay flat
  // coloured (vivid via emissive, see the blanket shader), and the ONLY relief is
  // the FOCUS-gated swell (one coherent hill at the live locus) + the xG spire.
  const A_BASE = 0.0;                   // flat painted territory (no body)
  const A_WOBBLE = 0.04 * amp;         // tiny cloth wobble only (≤0.05·amp)
  const flr = clamp(cfg.A.floor, 0, 0.9);
  const gamma = clamp(cfg.A.sharp, 0.3, 4);
  const lap = clamp(cfg.A.lap, 0, 0.45);    // НАХЛЁСТ: extend coverage past the 50% front

  // normalisation for the two A height grids (shared so relative team height is
  // honest). Read the SMOOTHED grids — that's what we render — so the normaliser
  // tracks the eased fields and doesn't itself jump frame-to-frame.
  let aMax = 1e-4;
  if (aOn) {
    for (let k = 0; k < A_shH.length; k++) { if (A_shH[k] > aMax) aMax = A_shH[k]; if (A_shA[k] > aMax) aMax = A_shA[k]; }
  }

  const bH = blankets.home, bA = blankets.away;
  let idx = 0, sumH = 0;
  let totH = 0, totA = 0;   // total raised mass per team (decides who laps on top)
  for (let j = 0; j < VY; j++) {
    const v = j / (VY - 1);
    for (let i = 0; i < VX; i++, idx++) {
      const u = i / (VX - 1);
      const wob = Math.sin(u * 6.1 + ph) * Math.cos(v * 5.3 - ph * 0.8)
                + 0.5 * Math.sin((u + v) * 9.7 - ph * 1.3);

      // ---- Layer A: per-team blanket height + crisp coverage ----
      let hH = 0, hA = 0, covH = 0, covA = 0;
      let ownerShare = 0.5;   // A partition home-share at this cell (for B dome colour)
      if (aOn) {
        // height from contributors (per team), normalised + floor + gamma.
        // All sampling reads the SMOOTHED grids so the surface glides.
        let rH = sampleGrid(A_shH, A_gx, A_gy, u, v) / aMax;
        let rA = sampleGrid(A_shA, A_gx, A_gy, u, v) / aMax;
        if (flr > 0) { rH = clamp((rH - flr) / (1 - flr), 0, 1); rA = clamp((rA - flr) / (1 - flr), 0, 1); }
        if (gamma !== 1) { rH = Math.pow(rH, gamma); rA = Math.pow(rA, gamma); }
        // xG SHARP crest added ON TOP of the swell (not normalised/floored) so a
        // chance reads as a tall spire well above the GENTLE control swells: swells
        // are kept low (×1.5) and the crest towers (×2.6, uncapped by xg).
        const xH = sampleGrid(A_sxH, A_gx, A_gy, u, v);
        const xA = sampleGrid(A_sxA, A_gx, A_gy, u, v);
        // FOCUS mask: dissolve detached far swells, keep ONE coherent hill at the
        // locus. Gates BOTH teams' swells (both cluster around the ball; the
        // possessing team rises higher via the Владение contributor). The xG crest
        // uses a SOFTENED mask (√, lifted) so a shot near the locus stays a tall
        // spire and is never flattened away.
        const wx = worldX(u), wz = worldZ(v);
        const fm = focusMask(wx, wz);
        // crest is its own TIGHT spatial spike (A_sxH/A_sxA), so it doesn't need
        // the focus gate to stay coherent. Keep it mostly UNGATED (floor 0.55) so a
        // recent shot always reads as a tall spire even when the live locus has
        // already moved off the shot spot — only softly attenuated far from play.
        const fmCrest = clamp(0.55 + 0.45 * Math.sqrt(fm), 0, 1);
        // xG spire HEIGHT is INDEPENDENT of A.amplitude: the crest term is scaled
        // by the dedicated xgH slider (× a fixed base so amp doesn't gate it).
        const crestK = 2.6 * xgH;
        hH = A_BASE + A_WOBBLE * wob + rH * 2.0 * amp * fm + xH * crestK * fmCrest;
        hA = A_BASE + A_WOBBLE * wob + rA * 2.0 * amp * fm + xA * crestK * fmCrest;
        // COVERAGE = FULL-PITCH PARTITION, ENCLAVE-FREE. Sample the cleaned, eased
        // ownership field A_sown (0..1 home share): it was built from the heavily
        // diffused presence, reduced to the LARGEST connected component per team
        // (no islands), lightly blurred (soft front) and temporally eased (glides).
        // Every cell is FILLED with its owner; the two colours meet at ONE
        // continuous activity-shaped front. No black field, no speckles.
        const shareH = sampleGrid(A_sown, A_gx, A_gy, u, v);   // 0..1; 0.5 = the boundary
        ownerShare = shareH;
        // FULL-UNION partition: a single steep edge at the 50% share decides the
        // owner, and the two sheets are COMPLEMENTARY (covH = edge, covA = 1-edge)
        // so together they fill EVERY cell — no gaps, no black band at the front.
        // The НАХЛЁСТ then ADDS a shared overlap: a soft bump straddling the
        // boundary that lifts BOTH sheets to 1 within a `lap`-wide band.
        const edge = smoothstepC(0.5 - 0.03, 0.5 + 0.03, shareH);   // crisp; 1 = home owns
        covH = edge;
        covA = 1 - edge;
        if (lap > 0.001) {
          const band = 1 - smoothstepC(0, lap, Math.abs(shareH - 0.5));  // 1 at boundary → 0 at |Δ|=lap
          covH = Math.max(covH, band);
          covA = Math.max(covA, band);
        }
        totH += rH + xH * 1.5; totA += rA + xA * 1.5;   // crest weighs into who laps on top
      }
      bH.hData[idx] = hH; bH.aData[idx] = covH;
      bA.hData[idx] = hA; bA.aData[idx] = covA;

      // ---- combined A height (max of covered team blankets) for cometY/baseline ----
      let hCombined = Math.max(covH > 0.05 ? hH : 0, covA > 0.05 ? hA : 0);

      // ---- Layer B: shared relief mesh ----
      let h = 0, rr = 0, gg = 0, bb = 0;
      if (bOn) {
        let b = sampleGrid(B_h, B_gx, B_gy, u, v) / bMax;
        if (cfg.B.sharp !== 1) b = Math.pow(b, clamp(cfg.B.sharp, 0.3, 4));
        h += b * 1.4 * cfg.B.height;
        // A B dome rises out of A's flat territory, so colour it the OWNER'S colour
        // at this cell (from the A partition `shareH`), NOT B's own pass blend —
        // otherwise a mixed pass cluster tints the dome cyan/green inside a blue
        // zone. Keeps each territory ONE uniform colour, dome included.
        const oCol = ownerShare >= 0.5 ? cH : cA;
        const w = clamp(b * 0.6 * clamp(cfg.B.opacity, 0, 2), 0, 1);
        rr += oCol.r * w; gg += oCol.g * w; bb += oCol.b * w;
      }
      const gate = clamp(h, 0, 1);
      heightData[idx] = Math.max(h, hCombined); sumH += heightData[idx];
      colData[idx * 4] = rr; colData[idx * 4 + 1] = gg; colData[idx * 4 + 2] = bb; colData[idx * 4 + 3] = gate;
    }
  }
  heightBaseline = sumH / NV;
  // shared B mesh
  material.userData.u.uBaseline.value = heightBaseline;
  heightTex.needsUpdate = true; colTex.needsUpdate = true;
  mesh.visible = bOn;
  // team blankets: the territory is now FLAT (height ~0 except the one hill), so
  // the baseline must be ~0 — otherwise subtracting the mean height would sink the
  // flat sheet BELOW the pitch plane (where it gets occluded and reads black). A
  // tiny lift keeps the flat paint just above y=0; only the focus hill + xG spire
  // rise above it. (sumHH/sumHA/nCov* are no longer used for the baseline.)
  // Lift must exceed the cloth wobble amplitude (max |wob|≈1.5 → A_WOBBLE·1.5) so a
  // wobble TROUGH never dips the flat sheet below the pitch plane (y=0), which
  // would let the dark ground show through as a black hole. (The flat partition
  // no longer needs a per-team mean baseline.)
  const BLANKET_LIFT = 0.12 + A_WOBBLE * 1.6;
  bH.u.uBaseline.value = -BLANKET_LIFT; bA.u.uBaseline.value = -BLANKET_LIFT;
  // colour-glow strength (graceful for old cfgs lacking A.glow).
  const glow = Number.isFinite(cfg.A.glow) ? cfg.A.glow : 1.0;
  bH.u.uGlow.value = glow; bA.u.uGlow.value = glow;
  bH.hTex.needsUpdate = true; bH.aTex.needsUpdate = true;
  bA.hTex.needsUpdate = true; bA.aTex.needsUpdate = true;
  bH.mesh.visible = aOn; bA.mesh.visible = aOn;
  // taller (more raised mass right now) team's sheet laps ON TOP at the overlap.
  // HYSTERESIS: only flip who's on top when one team clearly out-masses the other
  // (>15% margin), so the order doesn't jitter every frame when they're close.
  if (homeOnTopState) { if (totA > totH * 1.15) homeOnTopState = false; }
  else { if (totH > totA * 1.15) homeOnTopState = true; }
  const homeOnTop = homeOnTopState;
  bH.mesh.position.y = homeOnTop ? 0.012 : 0.0;
  bA.mesh.position.y = homeOnTop ? 0.0 : 0.012;
  bH.mesh.renderOrder = homeOnTop ? 2 : 1;
  bA.mesh.renderOrder = homeOnTop ? 1 : 2;
}
let homeOnTopState = true;   // hysteresis latch for the lap-on-top swap
// clamped smoothstep helper (steep edge for the crisp front)
function smoothstepC(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

// ============================================================================
// C · LIVE LOCUS COMET — moving orb + fading trail, on-ball team colour.
// ============================================================================
let cometGroup, cometOrb, cometCore, cometTrail, cometTG, cometTPos, cometTCol;
const TRAIL_N = 120;
function buildCometLayer() {
  cometGroup = new THREE.Group(); cometGroup.visible = false; scene.add(cometGroup);
  const orbMat = new THREE.SpriteMaterial({ map: discTex(), color: 0xffffff, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false });
  cometOrb = new THREE.Sprite(orbMat); cometOrb.scale.setScalar(1.6); cometGroup.add(cometOrb);
  const coreMat = new THREE.SpriteMaterial({ map: discTex(), color: 0xffffff, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false });
  cometCore = new THREE.Sprite(coreMat); cometCore.scale.setScalar(0.6); cometGroup.add(cometCore);
  cometTG = new THREE.BufferGeometry();
  cometTPos = new Float32Array(TRAIL_N * 3); cometTCol = new Float32Array(TRAIL_N * 3);
  cometTG.setAttribute('position', new THREE.BufferAttribute(cometTPos, 3));
  cometTG.setAttribute('color', new THREE.BufferAttribute(cometTCol, 3));
  const trailMat = new THREE.PointsMaterial({ size: 0.85, map: discTex(), vertexColors: true,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
  cometTrail = new THREE.Points(cometTG, trailMat); cometGroup.add(cometTrail);
}
function updateComet(t) {
  if (!cfg.C.on) { cometGroup.visible = false; return; }
  cometGroup.visible = true;
  const hop = clamp(cfg.C.hop, 0, 4);
  const b = ballAt(t);
  const yTop = cometY(b.u, b.v) + 0.12 + 0.5 * hop;     // amplitude: how high the orb rides
  cometOrb.position.set(worldX(b.u), yTop, worldZ(b.v));
  cometCore.position.copy(cometOrb.position);
  cometOrb.material.color.copy(teamColor(b.team));
  cometOrb.scale.setScalar(1.6 * cfg.C.size);
  cometCore.scale.setScalar(0.6 * cfg.C.size);
  cometOrb.material.opacity = clamp(cfg.C.bright, 0, 2);
  cometCore.material.opacity = clamp(cfg.C.bright, 0, 2);
  cometTrail.material.size = 0.85 * clamp(cfg.C.twidth, 0.1, 4);   // trail width
  const fadePow = clamp(cfg.C.fade, 0.2, 4);                       // trail fade rate
  const span = Math.max(0.05, cfg.C.trail);
  const c = new THREE.Color();
  for (let i = 0; i < TRAIL_N; i++) {
    const tt = t - (i / TRAIL_N) * span;
    const bb = ballAt(tt);
    cometTPos[i * 3] = worldX(bb.u); cometTPos[i * 3 + 1] = cometY(bb.u, bb.v) + 0.1 + 0.5 * hop; cometTPos[i * 3 + 2] = worldZ(bb.v);
    const fade = Math.pow(1 - i / TRAIL_N, fadePow) * clamp(cfg.C.bright, 0, 2);
    c.copy(teamColor(bb.team));
    cometTCol[i * 3] = c.r * fade; cometTCol[i * 3 + 1] = c.g * fade; cometTCol[i * 3 + 2] = c.b * fade;
  }
  cometTG.attributes.position.needsUpdate = true; cometTG.attributes.color.needsUpdate = true;
}
// world Y of the cloth surface at (u,v) if field layers are on, else the flat plane.
function cometY(u, v) {
  if (!(cfg.A.on || cfg.B.on) || !heightData) return LOCUS_Y;
  const fx = clamp(u, 0, 1) * (VX - 1), fy = clamp(1 - v, 0, 1) * (VY - 1);
  const i0 = Math.floor(fx), j0 = Math.floor(fy);
  const i1 = Math.min(i0 + 1, VX - 1), j1 = Math.min(j0 + 1, VY - 1);
  const tx = fx - i0, ty = fy - j0;
  const h00 = heightData[j0 * VX + i0], h10 = heightData[j0 * VX + i1];
  const h01 = heightData[j1 * VX + i0], h11 = heightData[j1 * VX + i1];
  const h = lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), ty);
  return (h - heightBaseline) + LOCUS_Y;
}

// ============================================================================
// D · EVENT ACCENTS — instant pop + fast fade, rebuilt per frame (few in window).
// Shots = spike + beam to goal mouth; duels = sparks; corners = marker; fouls = mark.
// ============================================================================
let accentGroup, accentDyn;
const DUEL_TYPES = new Set(['Tackle', 'Interception', 'Aerial', 'Challenge']);
function buildAccentLayer() {
  accentGroup = new THREE.Group(); accentGroup.visible = false; scene.add(accentGroup);
  accentDyn = new THREE.Group(); accentGroup.add(accentDyn);
}
function clearGroup(g) { while (g.children.length) { const m = g.children.pop(); m.geometry && m.geometry.dispose(); m.material && m.material.dispose(); } }
function updateAccents(t) {
  if (!cfg.D.on) { accentGroup.visible = false; clearGroup(accentDyn); return; }
  accentGroup.visible = true;
  clearGroup(accentDyn);
  const fade = Math.max(0.2, cfg.D.fade);
  const amp = clamp(cfg.D.amp, 0, 4);        // shot-spike amplitude
  const beamW = clamp(cfg.D.beam, 0, 2);     // beam length (fraction toward goal)
  const spark = clamp(cfg.D.spark, 0.1, 4);  // duel spark size
  const marker = clamp(cfg.D.marker, 0.1, 4);// corner/foul marker size
  const win = eventsInWindow(t, 0.6 / fade + 0.2);
  for (const it of win) {
    const age = t - it.t;
    if (it.kind === 'shot' && cfg.D.shots) {
      const life = clamp(1 - age / (0.45 / fade), 0, 1); if (life <= 0) continue;
      const gu = it.team === 'home' ? 0.99 : 0.01;
      const sign = it.team === 'home' ? 1 : -1;
      const gv = clamp(0.5 + sign * ((it.onGoalX - 1) / 2) * (7.32 / 68), 0.04, 0.96);
      const gy = clamp(it.onGoalY, 0, 1.2) * CROSSBAR_M * M2W;
      const y0 = cometY(it.u, it.v);
      const col = it.isGoal ? new THREE.Color('#fff1c0') : teamColor(it.team);
      // beam length: interpolate the goal endpoint from the shot spot by beamW.
      const bx = lerp(it.u, gu, beamW), bv = lerp(it.v, gv, beamW), by = lerp(y0, gy, beamW);
      addBeam(accentDyn, worldX(it.u), y0, worldZ(it.v), worldX(bx), by, worldZ(bv), col, 0.85 * life);
      addSpike(accentDyn, worldX(it.u), y0, worldZ(it.v), (1.0 + (it.xg || 0) * 3) * amp, col, 0.9 * life);
      addPoint(accentDyn, worldX(it.u), y0 + 0.15, worldZ(it.v), (it.isGoal ? 3.2 : 2.0) * amp * life, col, life);
    } else if (it.kind === 'event' && DUEL_TYPES.has(it.type) && cfg.D.duels) {
      const life = clamp(1 - age / (0.28 / fade), 0, 1); if (life <= 0) continue;
      addPoint(accentDyn, worldX(it.u), cometY(it.u, it.v) + 0.1, worldZ(it.v), 1.1 * spark * life, new THREE.Color('#ffd9a0'), 0.9 * life);
    } else if (it.type === 'CornerAwarded' && cfg.D.corners) {
      const life = clamp(1 - age / (0.7 / fade), 0, 1); if (life <= 0) continue;
      addRing(accentDyn, worldX(it.u), cometY(it.u, it.v), worldZ(it.v), 0.6 * marker, teamColor(it.team), 0.8 * life);
    } else if (it.type === 'Foul' && cfg.D.fouls) {
      const life = clamp(1 - age / (0.5 / fade), 0, 1); if (life <= 0) continue;
      addPoint(accentDyn, worldX(it.u), cometY(it.u, it.v) + 0.08, worldZ(it.v), 0.7 * marker * life, new THREE.Color('#ff9a8a'), 0.7 * life);
    }
  }
}

// ---- primitive helpers ------------------------------------------------------
let _discTex = null;
function makeDiscTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)'); grad.addColorStop(0.35, 'rgba(255,255,255,0.85)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
function discTex() { return _discTex || (_discTex = makeDiscTexture()); }
function addPoint(parent, x, y, z, size, col, alpha) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([x, y, z]), 3));
  const m = new THREE.PointsMaterial({ size, map: discTex(), color: col, transparent: true,
    opacity: alpha, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
  parent.add(new THREE.Points(g, m));
}
function addRing(parent, x, y, z, r, col, alpha) {
  const g = new THREE.RingGeometry(r * 0.78, r, 40); g.rotateX(-Math.PI / 2);
  const m = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: alpha,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, m); mesh.position.set(x, y + 0.05, z); parent.add(mesh);
}
function addBeam(parent, x0, y0, z0, x1, y1, z1, col, alpha) {
  const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x0, y0 + 0.1, z0), new THREE.Vector3(x1, y1 + LOCUS_Y, z1)]);
  const m = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: alpha, blending: THREE.AdditiveBlending, depthWrite: false });
  parent.add(new THREE.Line(g, m));
}
function addSpike(parent, x, y, z, h, col, alpha) {
  const g = new THREE.ConeGeometry(0.18, h, 14);
  const m = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: alpha, blending: THREE.AdditiveBlending, depthWrite: false });
  const mesh = new THREE.Mesh(g, m); mesh.position.set(x, y + h * 0.5, z); parent.add(mesh);
}
// ============================================================================
// POST chain (cloned from stage9)
// ============================================================================
function setupComposer() {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.4, 0.5);
  composer.addPass(bloomPass);
  gradePass = new ShaderPass(GradeShader);
  gradePass.uniforms.uVig.value = 1.1; gradePass.uniforms.uExpo.value = 1.35;
  gradePass.uniforms.uContr.value = 1.1; gradePass.uniforms.uGsat.value = 1.18;
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
function renderFrame(t) {
  if (cfg.A.on || cfg.B.on) computeField(t);
  else mesh.visible = false;
  updateComet(t);
  updateAccents(t);
}
// Force the A smoothing to SNAP on the next computeA (used after a scrub or a
// slider change so the eased grids don't lag behind a jump-cut / new setting).
function snapASmoothing() { A_smoothReset = true; focusReset = true; }

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
let lastNow = performance.now();
function loop(now) {
  const dt = Math.min(0.1, Math.max(0, (now - lastNow) / 1000));
  lastNow = now;
  if (playing) {
    clock += dt * cfg.speed;
    if (clock >= teamMeta.duration) { clock = teamMeta.duration; playing = false; el('play').textContent = '▶'; }
  }
  renderFrame(clock);
  controls.update();
  composer.render();
  updateHud();
  updateCamReadout();
  requestAnimationFrame(loop);
}

// ---- dev hook (hidden-tab safe: render exactly one frame via composer) -------
window.__setClock = (min) => {
  clock = clamp(+min || 0, 0, teamMeta.duration);
  playing = false; const pb = el('play'); if (pb) pb.textContent = '▶';
  _ballCursor = 0; snapASmoothing();
  renderFrame(clock);
  controls.update();
  composer.render();
  updateHud();
  updateCamReadout();
};

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
  if (document.activeElement !== el('clock')) el('clock').value = String((t / teamMeta.duration) * 100);
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
function bindGlobalUI() {
  const playBtn = el('play');
  playBtn.addEventListener('click', () => {
    if (!playing && clock >= teamMeta.duration) clock = 0;
    playing = !playing; playBtn.textContent = playing ? '❚❚' : '▶';
  });
  el('restart').addEventListener('click', () => { clock = 0; playing = true; playBtn.textContent = '❚❚'; });
  el('clock').addEventListener('input', () => {
    clock = (+el('clock').value / 100) * teamMeta.duration; playing = false; playBtn.textContent = '▶'; _ballCursor = 0; snapASmoothing();
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
    { id: 'height', label: 'амплитуда ▸ высота', min: 0, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'atk', label: 'скорость ▸ нарастание', min: 0.02, max: 2, step: 0.02, fmt: (v) => v.toFixed(2) },
    { id: 'rel', label: 'затухание ▸ спад', min: 0.3, max: 5, step: 0.1, fmt: (v) => v.toFixed(1) },
    { id: 'grid', label: 'детализация ▸ грид', min: 0, max: 1, step: 0.02, fmt: (v) => v.toFixed(2) },
    { id: 'focus', label: 'фокус ▸ зона игры', min: 0, max: 1, step: 0.02, fmt: (v) => v.toFixed(2) },
    { id: 'blur', label: 'сглаживание ▸ размытие', min: 0, max: 1, step: 0.02, fmt: (v) => v.toFixed(2) },
    { id: 'colour', label: 'насыщ. цвета ▸ цвет', min: 0, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'glow', label: 'яркость цвета ▸ свечение', min: 0, max: 2.5, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'sharp', label: 'резкость ▸ контраст', min: 0.3, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'floor', label: 'порог ▸ скрыть низ', min: 0, max: 0.8, step: 0.02, fmt: (v) => v.toFixed(2) },
    { id: 'lap', label: 'нахлёст ▸ перекрытие', min: 0, max: 0.4, step: 0.01, fmt: (v) => v.toFixed(2) },
    { id: 'ownBand', label: 'мин. территория ▸ у ворот', min: 0, max: 0.35, step: 0.01, fmt: (v) => v.toFixed(2) },
    { id: 'xgW', label: 'xG ▸ ширина шпиля', min: 0.2, max: 4, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'xgH', label: 'xG ▸ высота шпиля', min: 0, max: 4, step: 0.05, fmt: (v) => v.toFixed(2) },
  ], contribHead: 'ПОДЪЁМ ИЗ:', contributors: [
    { on: 'cOwn',  w: 'wOwn',  label: 'Владение' },
    { on: 'cXg',   w: 'wXg',   label: 'Удары · xG' },
    { on: 'cProg', w: 'wProg', label: 'Продвижение' },
    { on: 'cPass', w: 'wPass', label: 'Пасы' },
    { on: 'cDuel', w: 'wDuel', label: 'Единоборства' },
    { on: 'cDrib', w: 'wDrib', label: 'Обводки' },
    { on: 'cAll',  w: 'wAll',  label: 'Общая активность' },
  ] },
  { key: 'B', name: 'B · пасы', controls: [
    { id: 'height', label: 'амплитуда ▸ высота', min: 0, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'atk', label: 'скорость ▸ нарастание', min: 0.02, max: 2, step: 0.02, fmt: (v) => v.toFixed(2) },
    { id: 'rel', label: 'затухание ▸ спад', min: 0.3, max: 5, step: 0.1, fmt: (v) => v.toFixed(1) },
    { id: 'aggr', label: 'слитность ▸ агрегация', min: 0, max: 1, step: 0.02, fmt: (v) => v.toFixed(2) },
    { id: 'longw', label: 'вес длинных ▸ длина', min: 0, max: 1, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'opacity', label: 'интенсивность ▸ цвет', min: 0, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'sharp', label: 'резкость ▸ контраст', min: 0.3, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) },
  ] },
  { key: 'C', name: 'C · мяч', controls: [
    { id: 'hop', label: 'амплитуда ▸ подъём', min: 0, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'size', label: 'размер шара ▸ орб', min: 0.2, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'trail', label: 'длина хвоста ▸ сек', min: 0.05, max: 1.5, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'twidth', label: 'толщина хвоста ▸ ширина', min: 0.1, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'bright', label: 'яркость ▸ свечение', min: 0.2, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'fade', label: 'затухание ▸ хвост', min: 0.3, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) },
  ] },
  { key: 'D', name: 'D · события', controls: [
    { id: 'amp', label: 'амплитуда ▸ пик удара', min: 0, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'beam', label: 'луч к воротам ▸ длина', min: 0, max: 1.5, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'spark', label: 'искры ▸ единоборства', min: 0.2, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'marker', label: 'маркеры ▸ угл./фолы', min: 0.2, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'fade', label: 'затухание ▸ время жизни', min: 0.3, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) },
  ], toggles: [
    { id: 'shots', label: 'удары' }, { id: 'duels', label: 'единоборства' },
    { id: 'corners', label: 'угловые' }, { id: 'fouls', label: 'фолы' },
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
