// stage11.js — "LAYER CONSTRUCTOR" for France–Senegal (id 1953888).
//
// Cloned from stage10.js. Changes on top of stage10 (this stage):
//  1) SPEED 2× SLOWER — DRAMA_TOTAL_S 30 → 60.
//  2) SKY as a true BACKDROP behind everything (large sky sphere; scene.background
//     kept but the pitch + overlays never intersect it).
//  3) NO goal FREEZE/hold/dilation — goals play in the normal 2×-slower flow.
//  4) GOAL = a directional WAVE that rolls onto the opponent's goal END, fully
//     covers the conceded side → HEIGHT FLATTEN → territory RESETS to the middle.
//  5) GOAL MARKERS ROW above the pitch (2D canvas): open-play from the LEFT,
//     penalties from the RIGHT; slider "отметки ▸ высота".
//  6) BOTTOM momentum/PULSE strip (2D canvas seismograph, adapted from
//     fingerprint.js) with a playhead at the current match-time.
//  7) TEAM FLAGS beside the names + a tidy recomposed default HUD layout.
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
// STAGE11 CHANGE #4 — the goal is now a directional WAVE, not a uniform flood. These
// PHASE durations (WALL seconds) shape it (see goalWaveAt):
//   ROLL  — X's colour rolls from midfield toward end E and fully covers the conceded
//           side (the front sweeps to the E extreme). A READABLE roll, not a snap.
//   FLATTEN — a brief height level-out (the relief eases flat) once the side is covered.
//   RESET — the front eases back to the MIDDLE (50/50, kickoff) and normal play resumes.
// Kept as FLOOD_* names for minimal churn downstream. No held freeze (change #3).
const FLOOD_SWEEP_S = 0.9;      // ROLL: colour rolls to fully cover the conceded end
const FLOOD_HOLD_DEFAULT_S = 0.6;   // FLATTEN: brief height level-out at full cover
const FLOOD_RELAX_S = 1.8;      // RESET: front eases back to centre (kickoff)

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
    // ОТМЕТКИ ▸ ВЫСОТА (STAGE11 CHANGE #5) — vertical position of the goal-token row
    // above the pitch. 0 = low (near the field), 1 = high (top of the screen). Purely
    // a 2D-overlay layout knob (see drawMarkers).
    markerH: 0.55,
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

  // STAGE11 CHANGE #6 — REAL per-minute momentum for the bottom pulse strip. The
  // timeline doc carries no momentum, so fetch the RICH record (has momentum:
  // [{minute,value,valueNorm}], +home/−away). Best-effort: if it's missing the strip
  // simply draws the playhead over an empty ribbon (no mock data is fabricated).
  try {
    const rich = await fetch('/api/rich/' + ID).then((r) => (r.ok ? r.json() : null));
    if (rich && Array.isArray(rich.momentum)) momentum = rich.momentum
      .map((d) => ({ minute: Number(d.minute) || 0, v: Number(d.valueNorm) || 0 }))
      .filter((d) => Number.isFinite(d.minute));
  } catch { momentum = []; }
  buildGoalMarkers();        // STAGE11 CHANGE #5 — persistent goal-token row (open-play/penalty)

  setupThree();
  buildCloth();
  setupComposer();
  bindGlobalUI();
  buildLayerUI();
  setupHudLayout();
  setupOverlays();           // STAGE11 #5/#6 — the two 2D canvas overlays (markers + pulse)

  el('hAbbr').textContent = teamMeta.home.abbr || 'FRA';
  el('aAbbr').textContent = teamMeta.away.abbr || 'SEN';
  setTeamFlags();            // STAGE11 CHANGE #7 — flags beside the names
  document.documentElement.style.setProperty('--home-color', FRA_HEX);
  document.documentElement.style.setProperty('--away-color', SEN_HEX);
  el('title2').textContent =
    `STAGE 11 · ${teamMeta.home.abbr} ${teamMeta.score.home}–${teamMeta.score.away} ${teamMeta.away.abbr}`;

  syncCfgToUI();
  window.addEventListener('resize', onResize);
  onResize();
  requestAnimationFrame(loop);
}

// ============================================================================
// STAGE11 CHANGE #7 — TEAM FLAGS. abbr → ISO code (flagcdn), reused from
// public/matches.js so it includes FRA/SEN and ICO='ci' (Ivory Coast) / NOR='no'
// (Norway). Sets the two <img class="flag"> beside the team names in the HUD.
// ============================================================================
const FLAG = {
  MEX: 'mx', SAF: 'za', SKO: 'kr', CZE: 'cz', CAN: 'ca', BAN: 'ba', QAT: 'qa',
  SWI: 'ch', BRA: 'br', MOR: 'ma', USA: 'us', PAR: 'py', HAI: 'ht', SCO: 'gb-sct',
  GER: 'de', CUR: 'cw', NET: 'nl', JAP: 'jp', AUS: 'at', TUR: 'tr', ICO: 'ci',
  ECU: 'ec', BEL: 'be', EGY: 'eg', SPA: 'es', CVE: 'cv', SAR: 'sa', URU: 'uy',
  SWE: 'se', TUN: 'tn', IRA: 'iq', NZE: 'nz', FRA: 'fr', SEN: 'sn', NOR: 'no',
  JOR: 'jo', ARG: 'ar', ALG: 'dz', ENG: 'gb-eng', CRO: 'hr', POR: 'pt',
  DCO: 'cd', UZB: 'uz', COL: 'co', GHA: 'gh', PAN: 'pa',
};
function flagSrc(abbr) {
  const code = FLAG[abbr];
  return code ? `https://flagcdn.com/${code}.svg` : '';
}
function setTeamFlags() {
  const hf = el('hFlag'), af = el('aFlag');
  const hs = flagSrc(teamMeta.home.abbr), as = flagSrc(teamMeta.away.abbr);
  if (hf) { if (hs) { hf.src = hs; hf.alt = teamMeta.home.abbr; hf.style.display = ''; } else hf.style.display = 'none'; }
  if (af) { if (as) { af.src = as; af.alt = teamMeta.away.abbr; af.style.display = ''; } else af.style.display = 'none'; }
}

function fail(msg) {
  const t = el('title2'); if (t) t.textContent = 'STAGE 11 · failed: ' + msg;
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
  buildSky();                       // dynamic score-tinted gradient sky (see updateSky)
  scene.background = skyTex;
  // STAGE11 CHANGE #2 — the score-tinted sky must sit as a true BACKDROP BEHIND the
  // whole composition. scene.background already draws at infinite depth, but to make it
  // unambiguously a background layer (and to keep a soft lit dome around the pitch that
  // can never intersect/occlude it), add a LARGE inward-facing sky DOME carrying the
  // same gradient texture: radius far beyond the scene, BackSide, depthWrite off,
  // renderOrder −1 (drawn first), fog off. It surrounds everything and shares the sky's
  // score-tint (buildSky/updateSky repaint skyTex, which this dome samples).
  buildSkyDome();
  // STAGE11 CHANGE #2 — fog kept MINIMAL (0.018→0.010) and NEUTRAL (updateSky no longer
  // leans its colour toward the leader) so it never washes the pitch's true colours. The
  // score-tint glow lives in the full-bleed CSS backdrop halo + the sky dome, not the fog.
  scene.fog = new THREE.FogExp2(0x05070d, 0.010);

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

// ============================================================================
// SKY — an ambient SCORE indicator (the feature the user loved). A soft vertical
// gradient behind the pitch whose COLOUR leans toward the CURRENTLY-LEADING team's
// hue, strength ∝ the score margin; a DRAW / 0-0 stays neutral-dark. It EASES toward
// the new leader over ~1s after a goal. On a CARD it briefly FLASHES the sky the card
// colour then settles. Kept SUBTLE — a tint of the void, gallery-grade, never garish.
// The sky also faintly tints the scene fog so the whole piece feels lit by that sky.
// ============================================================================
let skyCanvas = null, skyCtx = null, skyTex = null;
// eased sky tint state (0..1 lean toward home(+)/away(−) leader) + card flash.
let skyLeanEased = 0;        // −1 (away leads big) .. +1 (home leads big), eased
let skyLeanReset = true;     // snap on scrub
let skyFlash = 0;            // 0..1 card-flash intensity (eased down each frame)
const skyFlashCol = new THREE.Color('#ffd24a');   // current flash colour (yellow default)
let _lastCardT = -1;         // most-recent card time already flashed (for live playback)
// dark neutral void endpoints (top→bottom) — the base gallery sky.
const SKY_TOP = new THREE.Color('#0a1020');
const SKY_MID = new THREE.Color('#070a12');
const SKY_BOT = new THREE.Color('#020308');
function buildSky() {
  skyCanvas = document.createElement('canvas'); skyCanvas.width = 16; skyCanvas.height = 256;
  skyCtx = skyCanvas.getContext('2d');
  skyTex = new THREE.CanvasTexture(skyCanvas);
  skyTex.colorSpace = THREE.SRGBColorSpace;
  paintSky(0, new THREE.Color('#000000'), 0);   // initial neutral paint
}
// STAGE11 CHANGE #2 — large inward-facing sky DOME carrying the score-tinted gradient.
// It sits FAR behind the composition (radius 70, camera far=100), maps the gradient
// bottom→top so the tint leans up like a horizon glow, and is drawn FIRST (renderOrder
// −1) with depthWrite off + fog off so it is a pure BACKDROP that never intersects or
// occludes the pitch/overlays. Shares skyTex, so updateSky's score-tint repaints it live.
let skyDome = null;
function buildSkyDome() {
  const geo = new THREE.SphereGeometry(70, 32, 24);
  const mat = new THREE.MeshBasicMaterial({
    map: skyTex, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false, toneMapped: false,
  });
  skyDome = new THREE.Mesh(geo, mat);
  skyDome.renderOrder = -1;          // draw before the pitch/blankets → always behind
  skyDome.frustumCulled = false;
  scene.add(skyDome);
}
const _sc0 = new THREE.Color(), _sc1 = new THREE.Color(), _sc2 = new THREE.Color();
const _tintCol = new THREE.Color();
// paint the gradient: lean (−1..+1) picks the leader colour + strength; tintCol is the
// leader hue; flash (0..1) washes the whole sky toward the card colour.
function paintSky(lean, tintCol, flash) {
  const g = skyCtx.createLinearGradient(0, 0, 0, 256);
  const strength = Math.abs(lean);
  // tint amount — gallery-subtle but READABLE: a leader at max margin lifts the sky
  // meaningfully toward its hue, strongest near the horizon (bottom, behind the pitch)
  // and fading up so the top stays a deep void. A draw/0-0 (strength≈0) leaves the base
  // neutral gradient. (Raised from the near-invisible first pass so the lean actually
  // reads through the fog + vignette.)
  const topT = 0.14 * strength, midT = 0.34 * strength, botT = 0.58 * strength;
  _sc0.copy(SKY_TOP).lerp(tintCol, topT);
  _sc1.copy(SKY_MID).lerp(tintCol, midT);
  _sc2.copy(SKY_BOT).lerp(tintCol, botT);
  // CARD FLASH — a brief wash of the whole sky toward the card colour, strongest here so
  // it clearly reads then settles back (skyFlash eases to 0 in updateSky).
  const f = clamp(flash, 0, 1) * 0.6;
  if (f > 0) { _sc0.lerp(skyFlashCol, f); _sc1.lerp(skyFlashCol, f * 0.85); _sc2.lerp(skyFlashCol, f * 0.7); }
  g.addColorStop(0.0, '#' + _sc0.getHexString());
  g.addColorStop(0.55, '#' + _sc1.getHexString());
  g.addColorStop(1.0, '#' + _sc2.getHexString());
  skyCtx.fillStyle = g; skyCtx.fillRect(0, 0, 16, 256);
  if (skyTex) skyTex.needsUpdate = true;
}
// Update the sky each frame from the current SCORE (leader + margin) at clock t, ease
// the tint toward it (~1s), decay any card flash, detect new cards to flash, and gently
// tint the fog so the whole scene feels lit by the sky. Deterministic tint TARGET from
// t (scrub-safe); the ease + flash decay are dt-smoothed (snap on scrub via dt=Inf).
function updateSky(t, dt) {
  const sc = scoreAt(t);
  const margin = sc.home - sc.away;                  // + = home leads
  // lean magnitude grows with margin but saturates (a 3-goal lead isn't 3× a 1-goal
  // lead visually) — sqrt-ish curve, capped at 1.
  const mag = clamp(Math.abs(margin) / 2, 0, 1);
  const target = margin === 0 ? 0 : Math.sign(margin) * (0.4 + 0.6 * mag);
  const a = expA(dt, 1.0);                            // ~1s ease toward the new leader
  if (skyLeanReset || a >= 1) { skyLeanEased = target; skyLeanReset = false; }
  else skyLeanEased += (target - skyLeanEased) * a;
  // leader hue for the current eased lean (blend the two team colours so a swing passes
  // through neutral rather than snapping between hues).
  const lean = skyLeanEased;
  if (lean >= 0) _tintCol.copy(COL_HOME);
  else _tintCol.copy(COL_AWAY);
  // CARD FLASH detection — during live playback fire a flash when the clock crosses a
  // card event. On scrub/snap we still show a flash if we land within the flash window
  // of a card (deterministic), so a captured card frame reads.
  detectCardFlash(t, dt);
  // decay the flash smoothly (dt-aware) — a card flash settles over ~0.9s.
  const fa = expA(dt, 0.45);
  if (fa >= 1) skyFlash = _snapFlash(t);
  else skyFlash += (0 - skyFlash) * fa;
  paintSky(lean, _tintCol, skyFlash);
  // STAGE11 CHANGE #2 — the sky's score-tint must colour ONLY the BACKDROP/halo, NOT
  // wash the pitch. Previously the scene FOG was tinted up to ~45% toward the leader hue,
  // which washed the whole field. The fog is now kept a NEUTRAL deep void (barely any
  // lean — 8%) so the pitch/cloth colours stay TRUE; the leader-tint lives in the
  // full-bleed CSS backdrop halo (paintBackdrop) and the WebGL sky dome behind the pitch.
  if (scene && scene.fog) {
    _tintCol.copy(SKY_BOT).lerp(lean >= 0 ? COL_HOME : COL_AWAY, 0.08 * Math.abs(lean));
    scene.fog.color.copy(_tintCol);
  }
  // paint the full-bleed CSS backdrop halo (behind the centered column) with the eased
  // leader lean — this is where the score-tint glow now lives.
  paintBackdrop(lean, skyFlash);
}
// STAGE11 CHANGE #2 — the full-bleed backdrop halo. A radial glow (centered) that leans
// to the LEADER's hue, strength ∝ |lean|; neutral-dark on a draw. Sits BEHIND the
// centered composition column (CSS #backdrop). A card flash briefly washes it too.
const _bdCol = new THREE.Color();
function paintBackdrop(lean, flash) {
  const bd = el('backdrop'); if (!bd) return;
  const strength = Math.abs(lean);
  _bdCol.copy(lean >= 0 ? COL_HOME : COL_AWAY);
  if ((flash || 0) > 0.01) _bdCol.lerp(skyFlashCol, flash * 0.6);
  const glow = _bdCol.getStyle ? _bdCol.getStyle() : ('#' + _bdCol.getHexString());
  // glow alpha grows with margin; a draw leaves the deep void. Tightened so it reads as a
  // centered HALO behind the column, not a full-frame red wash.
  const a1 = (0.38 * strength).toFixed(3);
  const a2 = (0.12 * strength).toFixed(3);
  bd.style.background =
    `radial-gradient(78% 62% at 50% 44%, rgba(${_rgb(_bdCol)},${a1}) 0%, rgba(${_rgb(_bdCol)},${a2}) 40%, #05070d 74%)`;
}
function _rgb(c) { return `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`; }
// CARD FLASH — the harvested data carries only a generic 'Card' event (no yellow/red
// qualifier survives the FotMob/WhoScored harvest), so every card flashes YELLOW. The
// hook reads skyFlashCol, so if a RedCard/SecondYellow type is ever harvested we can
// colour it red here. See report.
function detectCardFlash(t, dt) {
  if (!cardEvents || !cardEvents.length) return;
  // live playback: fire once when the clock passes a card time.
  if (Number.isFinite(dt) && dt > 0) {
    for (const c of cardEvents) {
      if (c.t > _lastCardT && c.t <= t && (t - c.t) < 0.5) {
        skyFlashCol.set(c.red ? '#ff2a2a' : '#ffd24a');
        skyFlash = 1; _lastCardT = c.t;
      }
    }
    if (t < _lastCardT) _lastCardT = -1;   // looped/rewound → allow re-fire
  }
}
// On a SNAP render (scrub/__setClock, dt=Inf) return the deterministic flash intensity
// if t lands within a card's flash window, so a captured card frame reads.
function _snapFlash(t) {
  if (!cardEvents || !cardEvents.length) return 0;
  let best = 0;
  for (const c of cardEvents) {
    // flash window in MATCH-MINUTES ≈ 0.9s of wall time from the card.
    const w = wallSecondsSinceGoal ? null : null;   // (kept simple below)
    const elapsedWall = wallSecondsSinceGoal(c.t, t);
    if (Number.isFinite(elapsedWall) && elapsedWall >= 0 && elapsedWall < 0.9) {
      skyFlashCol.set(c.red ? '#ff2a2a' : '#ffd24a');
      const f = 1 - (elapsedWall / 0.9);
      if (f > best) best = f;
    }
  }
  return best;
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
  buildGoalRings();          // STAGE11 CHANGE #1 — thin white rings on the conceded торец
}

// ============================================================================
// STAGE11 CHANGE #1 — GOAL RINGS ON THE ТОРЕЦ. A thin WHITE vector ring per goal,
// standing in the goal-mouth VERTICAL plane at the CONCEDED end (home scores →
// away's goal end at u=1/x=+WORLD_X/2; away scores → home's goal end at u=0/x=−WORLD_X/2).
// White + line weight to MATCH the pitch markings (same vocabulary), NOT team-coloured,
// NOT filled. They appear at the goal moment (t ≥ goal time) and PERSIST; multiple at
// the same end are offset laterally (in z) + slightly in height so they don't overlap.
// Built once (one mesh per goal); per-frame we just toggle visibility by the clock.
// ============================================================================
let goalRings = [];   // [{mesh, t}] in match-time order
const RING_COL = 0xf0f2f8;      // ≈ the pitch line colour vec3(0.92,0.94,0.97)
function buildGoalRings() {
  // dispose any prior rings (match switch rebuild)
  for (const r of goalRings) { if (r.mesh) { scene.remove(r.mesh); r.mesh.geometry.dispose(); r.mesh.material.dispose(); } }
  goalRings = [];
  if (!goalsByTime || !goalsByTime.length) return;
  // ring stroke weight ≈ the pitch markings line weight (~0.05 world reads like a field line).
  const stroke = 0.05;
  const R = 0.55;                           // ring radius (world units) — a touch smaller so a row of them fits across the end
  const endX = WORLD_X / 2 + 0.05;          // right at the goal-line end (torец)
  // STAGE11 CHANGE #4 — line the rings up FROM THE LEFT EDGE and SIDEWAYS along the
  // goal-line: a HORIZONTAL ROW starting at the left corner and extending across the
  // end, NOT centred and NOT stacked upward. The row lives in the goal-mouth VERTICAL
  // plane (faces ±X) at a low, constant height, marching along z from the left corner.
  const zLeft = WORLD_Z / 2 - (R + 0.12);   // first ring seated near the LEFT corner of the end
  const dz = R * 2 + 0.18;                  // lateral spacing between successive rings along the line
  const yRow = R + 0.12;                    // constant low height — the row sits on the end line
  let nHomeEnd = 0, nAwayEnd = 0;           // conceded-end counters
  const mat = new THREE.MeshBasicMaterial({ color: RING_COL, side: THREE.DoubleSide, transparent: true, opacity: 0.95, toneMapped: false, depthWrite: false });
  for (const g of goalsByTime) {
    // conceded end: home scores → away's end (+X); away scores → home's end (−X).
    const homeScored = g.team === 'home';
    const x = homeScored ? endX : -endX;
    const idx = homeScored ? nAwayEnd++ : nHomeEnd++;
    // march along the goal-line from the LEFT corner; extras step SIDEWAYS (−z), staying
    // within the pitch width so several goals at one end read as a tidy horizontal row.
    const z = zLeft - idx * dz;
    const y = yRow;
    const geo = new THREE.RingGeometry(R - stroke, R, 48);
    const m = new THREE.Mesh(geo, mat.clone());
    // ring plane = the goal-mouth Y-Z plane (faces along ±X): rotate the XY ring about Y.
    m.rotation.y = Math.PI / 2;
    m.position.set(x, y, z);
    m.renderOrder = 3;
    m.visible = false;
    scene.add(m);
    goalRings.push({ mesh: m, t: g.t });
  }
}
// per-frame: show the rings whose goal has occurred by clock t (persist thereafter).
function updateGoalRings(t) {
  for (const r of goalRings) if (r.mesh) r.mesh.visible = (t >= r.t);
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
    // GOAL FLOOD — uniform full-field colour override. uFlood 0..1 = how strongly THIS
    // cell's colour is blended toward the scorer colour (uFloodTeam) across the WHOLE
    // sheet, uniformly (NOT a moving front). At uFlood=1 every visible cell is the
    // scorer colour → instant 100% fill, no wave. Both sheets get the SAME uFlood so
    // whichever laps on top shows the scorer colour → no residual opponent strip.
    uFlood: { value: 0.0 }, uFloodTeam: { value: new THREE.Color(teamCol) },
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
      uniform float uFlood; uniform vec3 uFloodTeam;
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
        // GOAL FLOOD — uniform full-field OVERRIDE. Blend the whole cell toward the
        // scorer colour by uFlood (same on both sheets), so at uFlood=1 the ENTIRE
        // pitch is instantly the scorer colour — no wave, no seam move. Saturate the
        // flood colour slightly with uSat parity so it reads vivid like the territory.
        col = mix(col, uFloodTeam, clamp(uFlood, 0.0, 1.0));
        diffuseColor.rgb = col;
        float covEff = covAt();
        // During the flood, force THIS sheet to cover its whole area so the scorer
        // colour fills 100% of the pitch with NO gap/opponent strip: the seam discard
        // is lifted as uFlood rises, so both sheets paint fully and the visible surface
        // is uniformly the scorer colour.
        covEff = max(covEff, clamp(uFlood, 0.0, 1.0));
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
         // During the goal flood the emissive floor follows the SCORER colour too, so
         // the glow that keeps the flat territory vivid doesn't tint the flood with the
         // opponent's hue on the opponent sheet — the whole field glows the scorer colour.
         vec3 glowTeam = mix(uTeam, uFloodTeam, clamp(uFlood, 0.0, 1.0));
         vec3 emit = glowTeam * (0.34 * uGlow) * litMul;
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
let _dbgMomFront = 0.5, _dbgBallMean = 0.5;   // verification read-out (see __frontStats)
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
  // STAGE11 CHANGE #1 — the front must SWING END-TO-END with the real attack flow,
  // not hover at midfield. Root cause of the old "stuck near centre" was OVER-AVERAGING:
  // a long ball window (rel·4≈6.4min) averaged both ends toward u≈0.5. FIX = drive the
  // front from a BLEND of (a) a SHORT-window recent ball depth (where play is RIGHT NOW)
  // and (b) the real MOMENTUM signal (the backbone), then EXPAND the amplitude around
  // centre so a strong lean pushes the front CLOSE to the attacking goal. The momentum
  // backbone guarantees the swing even when the ball locus is sparse.
  //
  // (a) SHORT-window ball depth — a much tighter спад so the front tracks the CURRENT
  // phase of play (~1 minute of match time) instead of smearing the whole half over it.
  const winMin = Math.min(rel * 1.3 + atk, 1.4);   // was rel·4+atk·2 (~8min) → ~1min
  const N = 48;
  const dt = winMin / N;
  const accU = A_frontTmp; accU.fill(0);
  const accW = new Float32Array(gy);
  const sigV = 0.16;                 // a ball sample bleeds ~this far across channels
  const inv2sig2 = 1 / (2 * sigV * sigV);
  // short-window pure decay (fast release) so recent ball position dominates.
  const relBall = Math.max(0.25, rel * 0.45);
  let anyW = false;
  let globU = 0, globW = 0;          // window-mean ball-u (whole pitch) as a fallback backbone
  for (let k = 0; k <= N; k++) {
    const tt = t - k * dt;
    const w = arWeight(k * dt, atk, relBall);
    if (w < 0.02) continue;
    const b = ballAt(tt);
    anyW = true;
    globU += b.u * w; globW += w;
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
  const ballMean = globW > 1e-4 ? (globU / globW) : 0.5;
  // (b) MOMENTUM BACKBONE — the real per-minute momentum m∈[−1,+1] (+ = home on top).
  // Home dominant → territory front pushed toward the AWAY goal (u→1, home owns most of
  // the pitch); away dominant → toward the HOME goal (u→0).
  // Backbone momentum sampled DIRECTLY (per-minute data is already coarse/smooth) so the
  // front reaches deep when momentum spikes; the playback's temporal low-pass (TAU_FRONT)
  // supplies the smooth glide between minutes. No heavy window that would blunt real swings.
  const mom = momentumAt(t);   // −1..+1  (+ = home on top)
  // momentum target front-u: 0.5 + big amplitude · mom (near-goal at the extremes).
  // Steepen the map so even a MODERATE momentum lean pushes the front DEEP toward the
  // attacking goal (a linear map made mid-range mom a timid nudge); |mom|=1 → hard at
  // the goal band. This is what makes the territory swing END-TO-END, not around centre.
  const momFront = 0.5 + 0.5 * Math.sign(mom) * Math.pow(Math.abs(mom), 0.65);
  _dbgMomFront = momFront; _dbgBallMean = ballMean;   // verification read-out only
  // per-channel ball front (channels with no nearby ball fall back to the window mean).
  for (let j = 0; j < gy; j++) {
    A_frontRaw[j] = accW[j] > 1e-4 ? (accU[j] / accW[j]) : ballMean;
  }
  // EXPAND the ball front's amplitude around centre so a genuinely deep phase reads
  // near-goal, not a timid nudge (the ball u already spans the pitch, but the lateral
  // gaussian + fallback pull it inward; this gain restores the full swing).
  const BALL_GAIN = 1.35;
  for (let j = 0; j < gy; j++) {
    A_frontRaw[j] = clamp(0.5 + (A_frontRaw[j] - 0.5) * BALL_GAIN, 0, 1);
  }
  // BLEND ball-position (fast, spatial, keeps tongues) with the MOMENTUM backbone
  // (guarantees the end-to-end swing). Momentum-weighted so the backbone dominates the
  // gross swing while the ball adds per-channel variation. This is what makes momentum
  // the backbone the brief asks for.
  // momentum is the BACKBONE (dominant): it sets the gross end-to-end position; the ball
  // front only perturbs it (per-channel tongues + the current phase within the momentum
  // window). High wMom so a strong lean actually pushes the front DEEP toward the goal,
  // not a timid nudge — this is what makes the territory swing side-to-side like the pulse.
  const wMom = 0.9;    // backbone weight — the swing driver (momentum). Ball keeps enough
                       // voice that sustained territorial CAMPING (real recent ball depth)
                       // also reads: a side that parks the ball in the opponent half shows a
                       // deep front even when the per-minute momentum swing is modest.
  for (let j = 0; j < gy; j++) {
    A_frontRaw[j] = lerp(A_frontRaw[j], momFront, wMom);
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
  if (A.cXg && isShot) {
    // sharp tall crest at EVERY shot (goals INCLUDED), scaled by xg. Kept SEPARATE
    // (A_xH/A_xA) so it stays a tall spire above the gentle swells. A GOAL now shows
    // BOTH the instant full-field colour FLOOD (goalFloodAt) AND this height spire —
    // goals are typically the tallest since they are high-xg chances. Non-goal shots
    // get the spire only. The spire stands exactly at the shot's pitch spot and fades
    // a couple seconds after (arWeight decay).
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
  // from grid only (not blur), then scale by the dedicated xgW slider. Kept a SHARP
  // spire, but NOT sub-cell: with grid≈0.45 the coarse activity grid is ~23 cells, so
  // a <1-cell stamp becomes a thin needle that barely survives bilinear sampling into
  // the 160-wide render mesh (the "xG не поднимается" bug). Floor the radius near ~1
  // cell so a shot reads as a clear, distinct spire that stands proud of the mounds.
  const xgW = Number.isFinite(cfg.A.xgW) ? clamp(cfg.A.xgW, 0.2, 4) : 1;
  const baseSharp = lerp(2.6, 1.4, clamp(cfg.A.grid, 0, 1)) * 0.9;
  // FLOOR the spire radius near ~2 cells (was 1): a ~1-cell gaussian on the coarse
  // activity grid (~23 cells) barely survived bilinear sampling into the 160-wide render
  // mesh — the interpolated peak collapsed, so "xG не поднимается". A ~2-cell base makes
  // each shot a distinct MOUND/SPIRE that stands clearly proud of the surrounding cloth.
  const sharpRad = Math.max(2.0, baseSharp * xgW);
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
  // GOAL FLOOD — the scoring team's colour fills the WHOLE pitch AT ONCE (a uniform
  // full-field colour OVERRIDE), then fades back. This is NO LONGER a moving front /
  // wave: the front (seam) is left ALONE, and the flood is applied purely as a colour
  // blend in the blanket shaders (mix(territoryColour, scorerColour, floodAmt) on EVERY
  // cell, uniformly). See the uFlood/uFloodTeam plumbing after the vertex loop in
  // computeField. So at floodAmt=1 the ENTIRE pitch is the scorer colour instantly,
  // 100% coverage, no wave, no residual opponent strip. Deterministic via goalFloodAt.
  // Build the EFFECTIVE per-channel front (eased front only — no flood wash) and store
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
  // STAGE11 CHANGE #1 — a thrust finger is a LOCAL tongue/stab, NOT a territory flip.
  // With the momentum backbone now driving the gross front, an away counter-pass must not
  // be able to yank the whole boundary from deep-in-away-half all the way back across the
  // pitch (that's what made the front collapse toward centre). So CAP how far a finger can
  // pull the front PAST the backbone toward its attacker — beyond that, it just tongues.
  const THRUST_MAX_PULL = 0.10;   // max u-units a finger advances the front past the backbone — LOWERED 0.22→0.10: both teams pass forward constantly, so ±0.22 fingers were cancelling the momentum backbone's swing and pinning the front near centre. A finger is now a small local tongue that DOESN'T yank the gross boundary off the momentum backbone.
  for (let j = 0; j < gy; j++) {
    let fr = A_front[j];
    const base = A_front[j];       // the momentum-backed slow base for this channel
    if (A_thrustWH[j] > 1e-4) {                              // home stabs toward u=1
      const endU = A_thrustH[j] / A_thrustWH[j];
      const conf = clamp(A_thrustWH[j], 0, 1);
      const target = lerp(fr, endU, conf);
      if (target > fr) fr = Math.min(target, base + THRUST_MAX_PULL);
    }
    if (A_thrustWA[j] > 1e-4) {                              // away stabs toward u=0
      const endU = A_thrustA[j] / A_thrustWA[j];
      const conf = clamp(A_thrustWA[j], 0, 1);
      const target = lerp(fr, endU, conf);
      if (target < fr) fr = Math.max(target, base - THRUST_MAX_PULL);
    }
    A_frontEff[j] = fr;   // raw COMBINED front this frame (eased base + fingers). NO flood
                          // wash — the flood is a uniform colour override, not a front move.
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
  // STAGE11 CHANGE #4 — GOAL WAVE override of the per-channel front. During a goal the
  // scorer's colour ROLLS onto the opponent's goal END: we blend every channel's
  // displayed front toward the wave's target front (goalWaveAt → wave.front, which
  // itself sweeps 0.5→E during the roll then E→0.5 during the reset) by wave.cover
  // (0..1, rising through the roll, ~1 during flatten, falling through the reset). So
  // the seam sweeps across to fully cover the conceded side, then eases back to centre
  // (kickoff) as cover releases. Deterministic from the clock (goalWaveAt) → scrub-safe.
  const wave = goalWaveAt(t);
  for (let j = 0; j < gy; j++) {
    A_frontDisp[j] += (A_frontEff[j] - A_frontDisp[j]) * kd;
    let fr = A_frontDisp[j];
    if (wave && wave.cover > 0) fr = lerp(fr, wave.front, wave.cover);
    const row = j * gx;
    for (let i = 0; i < gx; i++) A_own[row + i] = fr;   // front-u, constant along u
  }
  A_sown.set(A_own);
  return win.length > 0;
}

// ---- GOAL WAVE (STAGE11 CHANGE #4) — directional roll onto the conceded end -----
// The DEFINITIVE goal spec, replacing stage10's instant uniform full-field flood.
// When team X scores it attacks toward end E (the opponent's goal-mouth/торец):
//   home attacks u→1 (away goal at u=1), away attacks u→0 (home goal at u=0).
// Sequence, all in WALL seconds (screen time), driven DETERMINISTICALLY from the
// clock (elapsed = wallSecondsSinceGoal) so it is scrub-safe:
//   ROLL (FLOOD_SWEEP_S)     — X's colour front ROLLS from midfield toward end E and
//                              fully COVERS that whole side up to E (front → E extreme).
//   FLATTEN (FLOOD_HOLD_*)   — a brief HEIGHT flatten; the front holds at the covered end.
//   RESET (FLOOD_RELAX_S)    — the front EASES back to the MIDDLE (50/50, kickoff) so
//                              normal play resumes.
// Returns { team, front, cover } where `front` = the wave's target front-u for this
// phase and `cover` (0..1) = how strongly the wave OVERRIDES the natural per-channel
// front (blended in computeA). Null when no wave is active. `cover` rises with the roll,
// stays ~1 through flatten, then falls off through reset so the boundary eases back to
// the natural contested tide. No held freeze (change #3): the whole thing is flowing.
function goalWaveAt(t) {
  if (!goalsByTime || !goalsByTime.length) return null;
  // LATEST GOAL WINS: newest goal ≤ t. A second goal restarts the wave cleanly for the
  // new scorer (elapsed resets to ~0) — the two never composite/fight.
  let g = null;
  for (let i = 0; i < goalsByTime.length; i++) {
    if (goalsByTime[i].t <= t) g = goalsByTime[i]; else break;
  }
  if (!g) return null;
  const elapsed = wallSecondsSinceGoal(g.t, t);
  if (!Number.isFinite(elapsed)) return null;
  const roll = FLOOD_SWEEP_S;
  const flat = Number.isFinite(cfg.A.floodHold) ? clamp(cfg.A.floodHold, 0, 12) : FLOOD_HOLD_DEFAULT_S;
  const reset = FLOOD_RELAX_S;
  const total = roll + flat + reset;
  if (elapsed < 0 || elapsed >= total) return null;
  // end E extreme front-u: home covers everything up to u=1 (E=1), away up to u=0 (E=0).
  const endE = g.team === 'home' ? 1.0 : 0.0;
  const mid = 0.5;
  let front, cover;
  if (elapsed < roll) {
    // ROLL — the front sweeps from the midline out to end E. smoothstep ease so the
    // colour is visibly seen rolling across (a readable roll, not a snap). cover ramps
    // to full so the wave takes over the boundary as it rolls.
    const f = elapsed / roll; const e = f * f * (3 - 2 * f);
    front = lerp(mid, endE, e);
    cover = e;
  } else if (elapsed < roll + flat) {
    // FLATTEN — the conceded side is fully covered; the front holds at E while the
    // height levels out (goalLullAt handles the height flatten). Full cover.
    front = endE; cover = 1;
  } else {
    // RESET — the front EASES back to the middle (kickoff) and the wave releases the
    // boundary back to the natural tide. front→mid AND cover→0 together.
    const f = (elapsed - roll - flat) / reset; const e = f * f * (3 - 2 * f);
    front = lerp(endE, mid, e);
    cover = 1 - e;
  }
  return { team: g.team, front: clamp(front, 0, 1), cover: clamp(cover, 0, 1) };
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

// GOAL HEIGHT FLATTEN (STAGE11 CHANGE #4) — the brief "then a brief HEIGHT FLATTEN
// (the relief levels out)" step, sequenced AFTER the colour roll. The wave rolls onto
// the conceded end with the relief still present (so the roll reads as a moving swell),
// THEN, once the side is covered (during the FLATTEN phase), the whole A relief eases
// FLAT; through the RESET phase (front easing back to centre) the height RECOVERS. All
// functions of WALL time → continuously moving, never a dead freeze. Deterministic from
// the clock → scrub-safe. Returns 0..1 = how flat the relief is pressed at clock t.
function goalLullAt(t) {
  if (!goalsByTime || !goalsByTime.length) return 0;
  let g = null;
  for (let i = 0; i < goalsByTime.length; i++) {
    if (goalsByTime[i].t <= t) g = goalsByTime[i]; else break;
  }
  if (!g) return 0;
  const roll = FLOOD_SWEEP_S;
  const flat = Number.isFinite(cfg.A.floodHold) ? clamp(cfg.A.floodHold, 0, 12) : FLOOD_HOLD_DEFAULT_S;
  const reset = FLOOD_RELAX_S;
  const elapsed = wallSecondsSinceGoal(g.t, t);
  if (!Number.isFinite(elapsed)) return 0;
  const total = roll + flat + reset;
  if (elapsed < 0 || elapsed >= total) return 0;
  if (elapsed < roll) {
    // ROLL — keep the relief (the wave rolls as a moving swell); a tiny lead-in flatten
    // near the end of the roll so the covered end is settling as it fills.
    const f = clamp((elapsed - roll * 0.6) / (roll * 0.4), 0, 1); return 0.35 * (f * f * (3 - 2 * f));
  }
  if (elapsed < roll + flat) {
    // FLATTEN — level the relief out fully over the flatten phase.
    const f = clamp((elapsed - roll) / Math.max(flat, 1e-3), 0, 1);
    return lerp(0.35, 1.0, f * f * (3 - 2 * f));
  }
  // RESET — recover the height as the front eases back to centre.
  const f = (elapsed - roll - flat) / reset;
  const s = f * f * (3 - 2 * f); return 1 - s;
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
  // SKY — ambient score indicator + card flash (updated every frame from the score at
  // clock t; eased tint + flash decay use the dt filter, snap on scrub).
  updateSky(t, dt);
  updateGoalRings(t);        // STAGE11 #1 — show the торец rings whose goal has occurred
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
  // scrub) so it never flickers per frame. STAGE11 #4: the goal WAVE forces the scorer
  // on top while it is covering the conceded end (cover>0.5) so its colour laps over.
  const wave2 = goalWaveAt(t);
  let topTargetHome = ball.team === 'away' ? 0 : 1;
  if (wave2 && wave2.cover > 0.5) topTargetHome = wave2.team === 'home' ? 1 : 0;
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
        // by the dedicated xgH slider (× a fixed base so amp doesn't gate it). RAISED
        // 2.6→4.2 so every shot's mound clearly STANDS as a readable rise (the user
        // "stopped seeing xG as a rise"); goals (highest xg → tallest) tower plainly.
        const crestK = 4.2 * xgH;
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
        // The general mounds get the full seam NOTCH (so no tall hill sits under the lip
        // fold). The xG CREST gets only a GENTLE notch (crestNotch, floored high) so a
        // shot spire still rises clearly even in the rare case a shot lands near the
        // possession seam — a shot must always read as a rise. Both melt in the lull.
        const crestNotch = 0.6 + 0.4 * notch;   // ≥0.6 everywhere → spire never fully suppressed
        // AMPLITUDE CEILING 8 — a high-xG (goal) crest could otherwise tower absurdly;
        // clamp each sheet's relief so the spire reads tall but bounded.
        let reliefH = (rH * 0.5 * amp * moundMask * notch + xH * crestK * fmCrest * crestNotch) * reliefMul;
        let reliefA = (rA * 0.5 * amp * moundMask * notch + xA * crestK * fmCrest * crestNotch) * reliefMul;
        reliefH = Math.min(reliefH, 8); reliefA = Math.min(reliefA, 8);
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
  // STAGE11 #4 — the goal is now a directional WAVE that rolls the FRONT onto the
  // conceded end (see computeA's goalWaveAt front override), NOT a uniform full-field
  // colour override. So uFlood stays 0: the scorer's colour covers the conceded side
  // through the ordinary coverage/front mechanic (the seam sweeps to end E), not a flat
  // blend. uFloodTeam is left harmless. (The shader uFlood path is thus inert here.)
  bH.u.uFlood.value = 0; bA.u.uFlood.value = 0;
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
const TAU_FRONT = 0.18;   // possession-tide boundary per channel — LOWERED so the momentum backbone's end-to-end swing isn't damped toward centre (the backbone is smooth per-minute, so jitter stays low even here). was 0.7 for CHANGE #2: the CHANGE #1 momentum backbone + BALL_GAIN sharpen the per-channel front, so a slightly heavier temporal low-pass removes the re-introduced per-frame jitter. The big END-TO-END swing is driven by the momentum backbone (per-minute cadence), which glides regardless of this τ, so the front stays SMOOTH yet still swings with full amplitude (not frozen).
const TAU_THRUST = 0.14;  // final low-pass on the COMBINED/displayed front (base+fingers) — kills the per-frame seam trembling from stepping finger weights; raised 0.22→0.28 to finish off the residual seam shimmer (seam-delta dropped ~45% busy, ~35-55% counter) while a counter still reaches ~66% of its depth within ~0.3s (still a quick stab)
const TAU_GRID = 0.5;     // per-cell height / xG crest fields
const TAU_HILL = 0.25;    // focus-hill centre glide
const TAU_LOCUS = 0.25;   // low-pass on the ball locus point feeding hill+front
const TAU_TOP = 0.4;      // possessor-on-top (which blanket laps over) transition
// Force the A smoothing to SNAP on the next computeA (used after a scrub or a
// slider change so the eased grids don't lag behind a jump-cut / new setting).
function snapASmoothing() { A_smoothReset = true; focusReset = true; A_frontReset = true; A_frontDispReset = true; locusReset = true; seamTopReset = true; skyLeanReset = true; }

// ---- resize -----------------------------------------------------------------
function onResize() {
  // STAGE11 CHANGE #4 — the 3D canvas is framed to the centered ~1000px COLUMN, so we
  // size the renderer to the STAGE canvas's own client box (the column), NOT the whole
  // window. The full-bleed backdrop halo lives in a separate CSS layer behind the column.
  const canvas = el('stage');
  const w = Math.max(1, canvas ? canvas.clientWidth : window.innerWidth);
  const h = Math.max(1, canvas ? canvas.clientHeight : window.innerHeight);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr); renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  if (composer) {
    composer.setPixelRatio(dpr); composer.setSize(w, h);
    if (bloomPass) bloomPass.setSize(w * dpr, h * dpr);
    if (smaaPass) smaaPass.setSize(w * dpr, h * dpr);
  }
  resizeOverlays();          // STAGE11 #5/#6 — keep the 2D overlay canvases crisp
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
  drawOverlays(clock);        // STAGE11 #5/#6 — markers row + pulse strip advance with playback
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
  drawOverlays(clock);
};
// dev/verification hook — current per-channel DISPLAYED front (A_frontDisp) stats +
// the momentum backbone target at the clock, so the end-to-end SWING of the territory
// can be measured objectively (front-u near 0 = deep in home's half, near 1 = deep in
// away's half). Pure read-out; leaves the sim untouched.
window.__frontStats = () => {
  if (!A_frontDisp || !A_frontDisp.length) return null;
  let mn = Infinity, mx = -Infinity, s = 0;
  for (let j = 0; j < A_frontDisp.length; j++) { const v = A_frontDisp[j]; if (v < mn) mn = v; if (v > mx) mx = v; s += v; }
  let rmn = Infinity, rmx = -Infinity, rs = 0;
  if (A_frontRaw) for (let j = 0; j < A_frontRaw.length; j++) { const v = A_frontRaw[j]; if (v < rmn) rmn = v; if (v > rmx) rmx = v; rs += v; }
  return { clock: +clock.toFixed(2), mean: +(s / A_frontDisp.length).toFixed(3), min: +mn.toFixed(3), max: +mx.toFixed(3), mom: +momentumAt(clock).toFixed(3), momFront: +_dbgMomFront.toFixed(3), ballMean: +_dbgBallMean.toFixed(3), rawMean: A_frontRaw ? +(rs / A_frontRaw.length).toFixed(3) : null, rawMin: +rmn.toFixed(3), rawMax: +rmx.toFixed(3) };
};
window.__step = (min, dt) => {
  clock = clamp(+min || 0, 0, teamMeta.duration);
  wallProgress = progressOfMatchT(clock);
  playing = false;
  renderFrame(clock, Number.isFinite(+dt) ? +dt : 0.016);
  drawOverlays(clock);
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
const DRAMA_TOTAL_S = 40.0;    // ×1.5 FASTER (60→40) — the whole match pass now runs ~40s. Continuous-minute cap unchanged (DRAMA_MAX_MIN_PER_SEC below), so no teleport.
// k — how strongly importance dilates time (multiplies I(t) which is normalised
// to peak 1). calmFloor — the baseline "screen-time density" of routine play so
// calm still GLIDES (never freezes) and the calm-vs-busy contrast reads. RAISED the
// floor (1→3) and LOWERED k (9→6) so the peak:floor density ratio drops from ~10:1
// to ~3:1 — routine now gets far more relative screen time and the match-minute
// SWEEPS continuously through it instead of teleporting a big chunk in a sliver.
const DRAMA_K = 6.0;
const DRAMA_CALMFLOOR = 3.0;
// HARD CEILING on local playback speed — the maximum match-minutes consumed per
// SCREEN-SECOND at any point. Even the flattest routine can't leap more than this
// per second of wall time, so the minute always reads as a fast-but-SMOOTH
// fast-forward, never a jump. Enforced by flooring the per-bin density (screen-sec
// per match-min) to 1/MAX so speed = 1/dens ≤ MAX. See applySpeedCap in buildDramaticClock.
const DRAMA_MAX_MIN_PER_SEC = 13.0;  // ≤ 13 match-minutes per screen-second anywhere.
// At 13/s the fastest routine advances ~1.3 match-min per 0.1s frame — a brisk but
// visibly CONTINUOUS fast-forward, no teleport — while leaving more of the budget for
// the goal/chance dilations so beats still linger ~3s.
// Guaranteed SCREEN-TIME (seconds) for the distinct key beats, so two beats close in
// match-time stay visibly SEPARATED. STAGE11 CHANGE #3 — the GOAL room/lull constants
// were REMOVED with the goal dilation (goals now play in the normal flow). Only the
// non-goal CHANCE room remains (the "visible-beats warp for shots").
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

  // Deposit a weighted, spatially-instant impulse at match-time t.
  const add = (t, w) => { if (w > 0) I[binOf(t)] += w; };

  for (let i = 0; i < timeline.length; i++) {
    const e = timeline[i];
    // VISIBLE-BEATS ONLY — the dramatic-time warp must slow ONLY where something is
    // actually on screen: a GOAL (the full-field colour flood) or a SHOT (the xG height
    // spire, goals included). Box-entries, final-third arrivals, fast transitions,
    // momentum, cards and penalties have NO visual now, so they must NOT dilate time
    // (that caused the clock to "hang on 38' where nothing happens"). Their weights are
    // ZEROED — only shots/goals feed I(t). The dilation is made ASYMMETRIC downstream
    // (buildDramaticClock): minimal room BEFORE the beat, room AT and AFTER it, where
    // the flood/spire actually plays.
    if (e.kind === 'shot') {
      const xg = Number.isFinite(e.xg) ? e.xg : 0;
      // STAGE11 CHANGE #3 — a GOAL no longer gets the big (26) importance hump that
      // made the clock crawl/hold around it. It's now weighted like any dangerous
      // on-target shot (∝ xG + on-target bonus), so it plays WITHIN the normal
      // 2×-slower flow. The visible SHOT warp (xG-spire beats) is kept.
      const onTarget = (e.type === 'SavedShot' || e.type === 'ShotOnPost' || e.outcome === 'Successful' || e.isGoal);
      add(e.t, 3.0 + 14.0 * xg + (onTarget ? 3.0 : 0));
      continue;
    }
    // (box-entry / final-third / transition / card / penalty importance intentionally
    //  removed — they are INVISIBLE beats; keeping them zeroed keeps the minute
    //  running continuously through routine and slowing only at a flood/spire.)
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
  // ASYMMETRIC dilation — each beat's hump has a SMALL sigma BEFORE the event (minimal
  // pre-event slow-down, so the minute doesn't drag on the approach where nothing is on
  // screen yet) and a LARGER sigma AT/AFTER it (the room where the flood/spire actually
  // plays). sigPre ≪ sigPost. So the clock runs continuously into the beat, then dwells
  // ON and AFTER the visual. This is what stops the "hang before the goal on an empty
  // minute" — the pre-event side is tight.
  const CHANCE_SIG_PRE = 0.05, CHANCE_SIG_POST = 0.42;
  const guaranteed = [];
  // STAGE11 CHANGE #3 — REMOVE the goal FREEZE/hold/dilation. In stage10 every goal
  // (and its post-goal lull) got a WIDE guaranteed screen-time plateau so the clock
  // crawled/held around goals. The user wants goals to play WITHIN the normal
  // (2×-slower) flow now — no extra room, no hold, no pause. So we DON'T push any goal
  // beat here. Non-goal CHANCES keep their small warp below (the "visible-beats warp
  // for shots").
  for (const beat of dramaKeyBeats) {
    const nearGoal = guaranteed.some((g) => Math.abs(g.t - beat.t) < 1.0);
    if (beat.w > 0.55 && !nearGoal) guaranteed.push({ t: beat.t, sec: CHANCE_ROOM_S * beat.w, sigPre: CHANCE_SIG_PRE, sigPost: CHANCE_SIG_POST });
  }
  // asymmetric gaussian weight at bin-offset dt (dt<0 = before the beat → tight sigPre;
  // dt≥0 = at/after → wide sigPost).
  const asymG = (dt, sigPre, sigPost) => { const s = dt < 0 ? sigPre : sigPost; return Math.exp(-(dt * dt) / (2 * s * s)); };

  // --- SPEED CAP (applied FIRST, on the base routine density) — floor the per-bin
  // density so no bin plays faster than DRAMA_MAX_MIN_PER_SEC match-minutes per
  // screen-second. Local speed = Wtot / (dens[b] · DRAMA_TOTAL_S), so speed ≤ MAX ⇔
  // dens[b] ≥ Wtot / (DRAMA_TOTAL_S · MAX). Wtot depends on dens → iterate to converge.
  // Doing this BEFORE the beat top-up means the flattest routine is already held to a
  // smooth fast-forward (the minute never teleports), and the goal/chance humps are
  // then added ON TOP of that floor so beats still reclaim their guaranteed room.
  {
    let Wtot = 0; for (let b = 0; b < N; b++) Wtot += dens[b] * DRAMA_DT;
    for (let pass = 0; pass < 6; pass++) {
      const minDens = Wtot / (DRAMA_TOTAL_S * DRAMA_MAX_MIN_PER_SEC);
      let changed = false, newTot = 0;
      for (let b = 0; b < N; b++) {
        if (dens[b] < minDens) { dens[b] = minDens; changed = true; }
        newTot += dens[b] * DRAMA_DT;
      }
      Wtot = newTot;
      if (!changed) break;
    }
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
      const sigPre = g.sigPre || 0.28, sigPost = g.sigPost || 0.42;
      const HALF_PRE = sigPre * 2.3, HALF_POST = sigPost * 2.3;   // asymmetric window
      const b0 = clamp(Math.floor((g.t - HALF_PRE) / DRAMA_DT), 0, N - 1);
      const b1 = clamp(Math.ceil((g.t + HALF_POST) / DRAMA_DT), 0, N - 1);
      let localSec = 0;
      for (let b = b0; b <= b1; b++) { const dt = b * DRAMA_DT - g.t; const wt = asymG(dt, sigPre, sigPost); localSec += dens[b] * DRAMA_DT * secPerDensMin * wt; }
      if (localSec < g.sec) {
        // solve amp so the ADDED (asym-Gaussian-weighted) screen-seconds reaches target.
        let gArea = 0;
        for (let b = b0; b <= b1; b++) { const dt = b * DRAMA_DT - g.t; const gv = asymG(dt, sigPre, sigPost); gArea += gv * DRAMA_DT * secPerDensMin * gv; }
        const amp = (g.sec - localSec) / Math.max(gArea, 1e-4);
        for (let b = b0; b <= b1; b++) { const dt = b * DRAMA_DT - g.t; dens[b] += amp * asymG(dt, sigPre, sigPost); }
      }
    }
  }

  // --- SPEED CAP (final enforcement) — the beat top-up above added density, growing
  // Wtot, which nudges the required floor up; re-floor so routine bins that fell
  // behind are lifted back to the cap. Beats keep their (much higher) humps untouched.
  // This makes the ceiling a HARD guarantee: no bin plays faster than the cap → the
  // minute never teleports, even in the opening/closing routine stretches.
  {
    let Wtot = 0; for (let b = 0; b < N; b++) Wtot += dens[b] * DRAMA_DT;
    for (let pass = 0; pass < 6; pass++) {
      const minDens = Wtot / (DRAMA_TOTAL_S * DRAMA_MAX_MIN_PER_SEC);
      let changed = false, newTot = 0;
      for (let b = 0; b < N; b++) {
        if (dens[b] < minDens) { dens[b] = minDens; changed = true; }
        newTot += dens[b] * DRAMA_DT;
      }
      Wtot = newTot;
      if (!changed) break;
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
let cardEvents = [];   // {t, team, red} — drives the SKY card-flash (see updateSky)
// STAGE11 CHANGE #5/#6 — persistent goal-token list (built in buildGoalMarkers) +
// real per-minute momentum (fetched in init) for the pulse strip.
let goalMarkers = [];  // {t, minute, team, pen} in match-time order, for the markers row
let momentum = [];     // [{minute, v}] valueNorm +home/−away, real data (rich record)
function countGoals() {
  goalsByTime = timeline.filter((it) => it.kind === 'shot' && it.isGoal).map((g) => ({ t: g.t, team: g.team }));
  teamMeta.score = { home: goalsByTime.filter((g) => g.team === 'home').length, away: goalsByTime.filter((g) => g.team === 'away').length };
  // CARD events for the sky flash. The harvest only emits a generic 'Card' type (no
  // yellow/red qualifier), so `red` is inferred from any explicit red-ish type/outcome
  // if one ever appears; otherwise a card flashes yellow. See report.
  cardEvents = timeline
    .filter((it) => /Card/.test(it.type || '') || it.type === 'RedCard' || it.type === 'YellowCard' || it.type === 'SecondYellow')
    .map((c) => ({ t: c.t, team: c.team, red: /Red|Second/.test(c.type || '') }))
    .sort((a, b) => a.t - b.t);
}
// STAGE11 CHANGE #5 — build the persistent goal-token row source. One token per goal,
// coloured by the scoring team. `pen` (penalty) is detected from the goal event's
// situation/type (situation === 'Penalty' or a Penalty type). Open-play tokens
// accumulate FROM THE LEFT edge rightward; penalty tokens FROM THE RIGHT edge leftward
// (drawn in drawMarkers). In these two matches there are NO penalties (both are
// RegularPlay/FastBreak/FromCorner/SetPiece), so every token is open-play (left).
function buildGoalMarkers() {
  const isPen = (e) => {
    const s = (e.situation || '').toLowerCase();
    const ty = (e.type || '').toLowerCase();
    return s === 'penalty' || ty === 'penalty' || /penalt/.test(s) || /penalt/.test(ty);
  };
  goalMarkers = timeline
    .filter((it) => it.kind === 'shot' && it.isGoal)
    .map((g) => ({ t: g.t, minute: g.minute || Math.floor(g.t), team: g.team, pen: isPen(g) }))
    .sort((a, b) => a.t - b.t);
}
// SCORE at clock t — counts every goal whose goalTime ≤ t, the EXACT same time
// basis and goal set that goalFloodAt uses (goalFloodAt picks the latest goal with
// g.t ≤ t and floods it). Sharing this predicate guarantees the displayed score
// increments on the SAME frame the flood starts — the number bumps up exactly as the
// field floods, never a beat before. Scrub-safe (pure function of t).
function scoreAt(t) {
  let h = 0, a = 0;
  for (const g of goalsByTime) {
    if (g.t <= t) { if (g.team === 'away') a++; else h++; }
  }
  return { home: h, away: a };
}
// STAGE11 CHANGE #1 — real per-minute MOMENTUM sampled at clock t (match-minutes),
// linearly interpolated between the per-minute samples. v = valueNorm ∈ [−1,+1],
// +1 = home fully on top, −1 = away fully on top (rich record). Returns 0 when no
// momentum data (best-effort; no mock). Deterministic from t → scrub-safe. This is
// the BACKBONE that swings the territory front end-to-end with the real attack flow.
let _momCursor = 0;
function momentumAt(t) {
  const M = momentum;
  if (!M || !M.length) return 0;
  if (t <= M[0].minute) return M[0].v;
  const last = M[M.length - 1];
  if (t >= last.minute) return last.v;
  if (_momCursor >= M.length - 1 || M[_momCursor].minute > t) _momCursor = 0;
  while (_momCursor < M.length - 2 && M[_momCursor + 1].minute <= t) _momCursor++;
  const a = M[_momCursor], b = M[_momCursor + 1];
  const span = Math.max(1e-4, b.minute - a.minute);
  const f = clamp((t - a.minute) / span, 0, 1);
  return lerp(a.v, b.v, f);
}
function updateHud() {
  const t = clock;
  // Drive the HUD score from the SAME goal-time trigger as the flood (scoreAt uses the
  // identical g.t ≤ t test on the same clock), so score + colour flood change together.
  const sc = scoreAt(t);
  const gH = sc.home, gA = sc.away;
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
// STAGE11 — 2D CANVAS OVERLAYS (clean, gallery-grade, pinned to the viewport):
//   #markers  (CHANGE #5) — a ROW of team-coloured goal TOKENS above the pitch. Open
//              -play goals accumulate FROM THE LEFT; penalty goals FROM THE RIGHT. Each
//              token appears at its goal's match-time and PERSISTS. Height above the
//              field is the "отметки ▸ высота" slider (cfg.A.markerH, 0..1 → screen y).
//   #pulse    (CHANGE #6) — a whole-match momentum SEISMOGRAPH (adapted from
//              fingerprint.js) with a PLAYHEAD at the current match-time. Leans UP in
//              the home colour / DOWN in the away colour from real per-minute momentum.
// Both advance with playback (drawn each frame in loop from the current clock).
// ============================================================================
let mkCanvas = null, mkCtx = null, plCanvas = null, plCtx = null, _ovDpr = 1;
function setupOverlays() {
  mkCanvas = el('markers'); mkCtx = mkCanvas ? mkCanvas.getContext('2d') : null;
  plCanvas = el('pulse');   plCtx = plCanvas ? plCanvas.getContext('2d') : null;
  resizeOverlays();
}
function resizeOverlays() {
  _ovDpr = Math.min(window.devicePixelRatio || 1, 2);
  for (const c of [mkCanvas, plCanvas]) {
    if (!c) continue;
    const w = c.clientWidth || window.innerWidth;
    const h = c.clientHeight || (c === plCanvas ? 88 : 96);
    c.width = Math.round(w * _ovDpr); c.height = Math.round(h * _ovDpr);
  }
}
// current momentum-strip duration (last momentum minute, else match duration).
function pulseDuration() {
  if (momentum.length && Number.isFinite(momentum[momentum.length - 1].minute)) {
    return Math.max(1, momentum[momentum.length - 1].minute);
  }
  return Math.max(1, teamMeta.duration || 93);
}

// ---- CHANGE #5 — goal-markers row ------------------------------------------
function drawMarkers(t) {
  if (!mkCtx) return;
  const dpr = _ovDpr;
  const W = mkCanvas.width, H = mkCanvas.height;
  mkCtx.clearRect(0, 0, W, H);
  // token geometry (in CSS px, scaled by dpr).
  const r = 11 * dpr;                 // token radius
  const gap = 30 * dpr;               // centre-to-centre spacing
  const edge = 26 * dpr;              // inset from each screen edge
  // adjustable HEIGHT above the pitch: slider 0 (near the field/bottom of this strip)
  // → 1 (top). The strip is pinned to the top of the screen; higher slider = higher up.
  const mh = clamp(Number.isFinite(cfg.A.markerH) ? cfg.A.markerH : 0.55, 0, 1);
  const cy = H - (0.18 + 0.62 * mh) * H;   // vertical centre of the row
  // split visible (goal already happened by clock t) tokens into open-play vs penalty.
  const open = [], pen = [];
  for (const g of goalMarkers) { if (g.t <= t) (g.pen ? pen : open).push(g); }
  const paint = (list, fromLeft) => {
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      const cx = fromLeft ? (edge + r + i * gap) : (W - edge - r - i * gap);
      const col = g.team === 'home' ? FRA_HEX : SEN_HEX;
      // soft glow underlay
      mkCtx.beginPath(); mkCtx.arc(cx, cy, r * 1.7, 0, Math.PI * 2);
      mkCtx.fillStyle = hexA(col, 0.16); mkCtx.fill();
      // token
      mkCtx.beginPath(); mkCtx.arc(cx, cy, r, 0, Math.PI * 2);
      mkCtx.fillStyle = col; mkCtx.fill();
      mkCtx.lineWidth = 1.5 * dpr; mkCtx.strokeStyle = 'rgba(4,5,10,0.85)'; mkCtx.stroke();
      // minute label under the token
      mkCtx.fillStyle = 'rgba(255,255,255,0.82)';
      mkCtx.font = `${11 * dpr}px Barlow, sans-serif`;
      mkCtx.textAlign = 'center'; mkCtx.textBaseline = 'top';
      mkCtx.fillText(g.minute + "'", cx, cy + r + 3 * dpr);
    }
  };
  paint(open, true);    // open-play → from the LEFT edge rightward
  paint(pen, false);    // penalties → from the RIGHT edge leftward
}

// ---- CHANGE #6 — bottom momentum / pulse strip (seismograph + playhead) -----
function drawPulse(t) {
  if (!plCtx) return;
  const dpr = _ovDpr;
  const W = plCanvas.width, H = plCanvas.height;
  plCtx.clearRect(0, 0, W, H);
  const padX = 24 * dpr, padY = 12 * dpr;
  const x0 = padX, x1 = W - padX, innerW = x1 - x0;
  const mid = H * 0.52;
  const ribH = (mid - padY) * 0.95;
  const dur = pulseDuration();
  const xOf = (min) => x0 + clamp(min / dur, 0, 1) * innerW;
  // STAGE11 #3 — the compressed strip reads as a CONTAINED rounded band (not edge-to-edge):
  // a rounded translucent panel with a hairline border spanning the (already-narrowed)
  // canvas, so it sits as a distinct element within the centered column.
  const rr = 10 * dpr;
  const rrect = (x, y, w, h, r) => {
    plCtx.beginPath();
    plCtx.moveTo(x + r, y); plCtx.arcTo(x + w, y, x + w, y + h, r); plCtx.arcTo(x + w, y + h, x, y + h, r);
    plCtx.arcTo(x, y + h, x, y, r); plCtx.arcTo(x, y, x + w, y, r); plCtx.closePath();
  };
  rrect(1 * dpr, 1 * dpr, W - 2 * dpr, H - 2 * dpr, rr);
  plCtx.fillStyle = 'rgba(8,10,17,0.62)'; plCtx.fill();
  plCtx.lineWidth = 1 * dpr; plCtx.strokeStyle = 'rgba(255,255,255,0.10)'; plCtx.stroke();
  // halftime marker
  plCtx.strokeStyle = 'rgba(255,255,255,0.14)'; plCtx.lineWidth = 1 * dpr;
  plCtx.setLineDash([3 * dpr, 4 * dpr]);
  plCtx.beginPath(); plCtx.moveTo(xOf(45), padY * 0.5); plCtx.lineTo(xOf(45), H - padY * 0.5); plCtx.stroke();
  plCtx.setLineDash([]);
  if (momentum.length >= 2) {
    const pts = momentum.map((d) => ({ x: xOf(d.minute), y: mid - d.v * ribH, v: d.v }));
    // HOME area (above midline) + AWAY area (below midline), split at the baseline.
    const fillArea = (clampFn, col) => {
      plCtx.beginPath();
      plCtx.moveTo(x0, mid);
      for (const p of momentum) plCtx.lineTo(xOf(p.minute), mid - clampFn(p.v) * ribH);
      plCtx.lineTo(x1, mid); plCtx.closePath();
      plCtx.fillStyle = hexA(col, 0.5); plCtx.fill();
    };
    fillArea((v) => Math.max(0, v), FRA_HEX);   // home pressure up
    fillArea((v) => Math.min(0, v), SEN_HEX);   // away pressure down
    // crisp momentum line for definition
    plCtx.beginPath();
    pts.forEach((p, i) => (i ? plCtx.lineTo(p.x, p.y) : plCtx.moveTo(p.x, p.y)));
    plCtx.strokeStyle = 'rgba(255,255,255,0.30)'; plCtx.lineWidth = 1 * dpr; plCtx.stroke();
  }
  // midline
  plCtx.strokeStyle = 'rgba(255,255,255,0.45)'; plCtx.lineWidth = 1.2 * dpr;
  plCtx.beginPath(); plCtx.moveTo(x0, mid); plCtx.lineTo(x1, mid); plCtx.stroke();
  // goal spikes (subtle) so the pulse ties to the score story
  for (const g of goalMarkers) {
    if (g.t > t) continue;
    const gx = xOf(g.minute); const up = g.team === 'home';
    const col = up ? FRA_HEX : SEN_HEX;
    const tip = up ? padY * 0.7 : H - padY * 0.7;
    plCtx.strokeStyle = hexA(col, 0.6); plCtx.lineWidth = 1.5 * dpr;
    plCtx.beginPath(); plCtx.moveTo(gx, mid); plCtx.lineTo(gx, tip); plCtx.stroke();
    plCtx.beginPath(); plCtx.arc(gx, tip, 3 * dpr, 0, Math.PI * 2); plCtx.fillStyle = col; plCtx.fill();
  }
  // PLAYHEAD at the current match-time
  const px = xOf(clamp(t, 0, dur));
  plCtx.strokeStyle = 'rgba(255,255,255,0.9)'; plCtx.lineWidth = 1.5 * dpr;
  plCtx.beginPath(); plCtx.moveTo(px, padY * 0.3); plCtx.lineTo(px, H - padY * 0.3); plCtx.stroke();
  plCtx.beginPath(); plCtx.arc(px, mid, 3.5 * dpr, 0, Math.PI * 2);
  plCtx.fillStyle = '#fff'; plCtx.fill();
}
// #rrggbb + alpha → rgba() string.
function hexA(hex, a) {
  const h = (hex || '#888888').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function drawOverlays(t) { drawMarkers(t); drawPulse(t); }

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
    { id: 'markerH', label: 'отметки ▸ высота', min: 0, max: 1, step: 0.02, fmt: (v) => v.toFixed(2) },
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
        drawOverlays(clock);   // STAGE11 — reflect e.g. отметки ▸ высота live while paused
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
const STORE_KEY = 'wcp_stage11_cfg';   // STAGE11: own persistence key (independent of stage10)

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
const HUD_STORE = 'stage11_hud_v2';   // STAGE11 #4: v2 — coords are now COLUMN-relative (1000px), not viewport
function setupHudLayout() {
  const widget = (k) => el('w_' + k);
  // STAGE11 CHANGE #4/#7 — the HUD widgets live INSIDE the centered ~1000px column, so
  // these coords are COLUMN-relative (0..1000 wide). Tidy default: team names+flags top
  // -left and the big score under it (below the goal-markers row), the minute clock
  // top-right within the column. The user will send a sketch to finalize.
  const defaults = () => ({
    teams: { x: 70, y: 116, s: 2.2 },     // team names + flags, below the markers row
    score: { x: 70, y: 152, s: 3.0 },     // big score under the team line
    clock: { x: 820, y: 116, s: 2.0 },    // minute clock, top-right within the 1000px column
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
