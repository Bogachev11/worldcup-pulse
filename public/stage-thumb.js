// stage13.js — FINALIZED HUD (clone of stage12.js).
//
// STAGE13 changes on top of stage12 (CHROME/HUD ONLY — engine untouched):
//   · The surrounding HUD chrome is rebuilt to match public/design/vB2.html
//     (Space Grotesk + Space Mono). Two teams top-left (flag + abbr + country-colour
//     rail + very large mono score), with per-team event ROWS UNDER each score:
//       - GOALS  : filled disc (team colour) + minute
//       - RED    : upright red card rect + minute (RED only; yellows hidden)
//       - PENS   : shootout rings (hollow=scored / filled=missed) — design-ready,
//                  renders NOTHING until a real `penaltyShootout` source exists.
//     Top-right = mono match clock + half sub-label (NO "LIVE" indicator anywhere).
//     Bottom   = transparent play button merged into a clean off-white seismograph
//                (drawPulse restyled; the old top goal-token row is DISABLED).
//   · New updateEventBlocks() renders the per-team rows from the LIVE data every
//     frame (called from updateHud, which runs each frame in loop()).
//   · Wiring uses the SAME live data hooks as stage12: scoreAt(t), clock,
//     goalMarkers, cardEvents, goalLanded(), momentum, pulseDuration(), teamMeta,
//     FRA_HEX/SEN_HEX. No mock data.
// Everything else (3D engine, pitch, camera, constructor panel, sky, data loading)
// is inherited from stage12 UNCHANGED.
//
// ---- (original stage12 header follows) -------------------------------------
// stage12.js — "LAYER CONSTRUCTOR" for France–Senegal (id 1953888).
//
// Cloned from stage11.js. STAGE12 changes on top of stage11:
//   A) FRONT RECONCILIATION — new ATTACK REACH signal (buildAttackReach): deep REAL
//      attacking events (shots, corners, box/final-third passes, crosses) push the
//      front toward the attacked goal with a MEDIUM ~12s wall-time memory, combined
//      into the momentum backbone via max-toward-attacker. So the territory now
//      reflects the pulse AND the real attacking reach (ICO 74' reads DEEP for ICO).
//   B) DEFAULT CAMERA baked to the user's tuned ortho view (DEFAULT_CAM).
// Everything else is inherited from stage11 unchanged.
//
// (stage11 was cloned from stage10.js. stage11 changes on top of stage10:)
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

// PUBLIC vs DEV chrome — the dev constructor/camera panels + match switcher are
// hidden by default (CSS: body:not(.dev) …). Reveal them with ?dev=1 (or ?dev, or
// #dev) in the URL. All dev bindings still resolve their elements via el(), so
// nothing throws while the panels are merely display:none.
(() => {
  const q = location.search.toLowerCase(), h = location.hash.toLowerCase();
  if (/(^|[?&#])dev(=1|=true|\b)/.test(q) || /(^|[?&#])dev\b/.test(h)) {
    document.body.classList.add('dev');
  }
})();

// TEAM COLOURS — derived per match from the loaded timeline doc (home/away .color).
// FRA/SEN default fallbacks match the brief (#387ef0 / #0c954e); ICO/NOR (and any
// other match) get their own real data colours. Populated in init() from tlDoc, so
// switching matches via the tabs recolours the two blankets correctly.
let FRA_HEX = '#387ef0';   // home colour (fallback = France blue)
let SEN_HEX = '#0c954e';   // away colour (fallback = Senegal green)

// baked-in default camera. STAGE-THUMB uses a slightly LOWER, more oblique isometric
// ракурс than stage13's near-top-down view so the cumulative-xG RELIEF (the essence's
// "where danger was created" hills) casts readable silhouette/shadow instead of reading
// flat. (stage13's tuned view was pos [-17.33,16.41,15.40] / target [-0.62,1.83,0.27].)
// This is a KNOB — retune freely; the ?dev camera panel + copy-camera still work.
const DEFAULT_CAM = { pos: [-17.80, 15.27, 15.98], target: [-1.09, 0.69, 0.85] };
function applyDefaultCamera() {
  camera.position.set(DEFAULT_CAM.pos[0], DEFAULT_CAM.pos[1], DEFAULT_CAM.pos[2]);
  controls.target.set(DEFAULT_CAM.target[0], DEFAULT_CAM.target[1], DEFAULT_CAM.target[2]);
  if (camera.isOrthographicCamera) camera.zoom = 1;
  controls.update();
}
// STAGE11 — ORTHOGRAPHIC frustum sizing. ORTHO_VIEW = world-unit VERTICAL half-extent of
// the frustum at zoom 1. The pitch (WORLD_X 16 × WORLD_Z 9.6) viewed at the tuned tilt
// spans ~22 world units tall on screen, so a half-height of ~11.5 frames the whole
// cloth+relief comfortably in the centered column with a little margin. Width follows the
// aspect. camera.zoom (driven by OrbitControls dolly) scales it in updateProjectionMatrix.
const ORTHO_VIEW = 9.2;
function setOrthoFrustum(aspect) {
  if (!camera || !camera.isOrthographicCamera) return;
  const h = ORTHO_VIEW;
  const w = h * Math.max(0.0001, aspect);
  camera.left = -w; camera.right = w; camera.top = h; camera.bottom = -h;
  camera.updateProjectionMatrix();
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
// STAGE11 CHANGE #3 — END-OF-MATCH SETTLE. When the pass reaches the final whistle we do
// NOT loop; instead `settle` eases 0→1 over ~SETTLE_S seconds while playback still runs,
// damping the surface to a calm resolved state (relief + territory ease flat/centre and
// motion quiets), then playback STOPS and the final calm frame is held. Manual restart /
// scrub resets it. settle is deterministic-friendly: snapped to 0 on scrub/restart.
let settle = 0;               // 0 = live, 1 = fully settled/quiet
let settling = false;         // true during the brief ease at the end (playback still on)
const SETTLE_S = 1.6;         // graceful ease duration (~1-2s), not an abrupt freeze
// POST-MATCH PENALTY-SHOOTOUT choreography state (see the shootout block far below).
let shootoutOrder = null;     // flat ordered [{team, scored}] kick sequence (from the timeline) | null
let shootActive = false;      // the match has settled INTO the directed shootout sequence
let shootWall = 0;            // wall-seconds since the shootout began (drives the sequence)
let shootoutRevealed = 0;     // how many kicks' dots are shown so far
function resetSettle() { settle = 0; settling = false; shootActive = false; shootWall = 0; shootoutRevealed = 0; }

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
// EVENT LAG — the HUD events tied to a goal (SCORE increment, SKY leader tint, goal
// markers/rings) must fire a beat AFTER the cloth has moved, never before it. The blanket
// GOAL FLOOD leads (starts at the goal instant, rolls over FLOOD_SWEEP_S); these overlay
// events trail by EVENT_LAG_S of WALL time so the eye reads: cloth floods → THEN the score
// ticks and the sky shifts, almost together but clearly after the pitch. (Authored in wall
// seconds via wallSecondsSinceGoal so it is scrub-safe and warp-independent.)
const EVENT_LAG_S = 0.7;

// ============================================================================
// CONFIG — every layer's enable flag + its own knobs. This whole object is what
// gets serialised to the URL hash / COPY CONFIG and restored from a preset.
// ============================================================================
const DEFAULTS = () => ({
  // 1.0 = the intended ~15s dramatic-time pass (DRAMA_TOTAL_S). The slider is now a
  // global tempo trim on that pass, not a linear match-minute rate.
  speed: 1.0,
  // SHOOTOUT choreography timing (post-match penalties) — adjustable in the left panel:
  // pause0 = seconds of stillness after the match before the 1st kick; gap = seconds between kicks.
  shoot: { pause0: 2.4, gap: 1.7 },
  // A · TWO TEAM BLANKETS (одеяла) — one cloth per team, meeting at an
  //  activity-shaped front with a small НАХЛЁСТ overlap. Height per team = amplitude
  //  · Σ ENABLED contributors through the asymmetric atk/rel envelope on the grid.
  //  height=amplitude, atk=attack/rise τ, rel=release/decay τ, grid=detail,
  //  blur=smoothing, colour=intensity, sharp=hill contrast/gamma, floor=threshold,
  //  lap=НАХЛЁСТ ▸ глубина (finite OVERLAP depth, fraction of pitch length: each
  //  opaque sheet tucks this far PAST the front under the other). cOWN..cALL =
  //  contributor on/off; wOWN..wALL = weights.
  A: {
    on: true, open: false, atk: 0.46, rel: 2.3, grid: 0.78, height: 6.15,
    colour: 1.1, blur: 0.22, sharp: 1.0, floor: 0.0, lap: 0.005,
    // КРОМКА ▸ подъём — LIP HEIGHT (world-Y) of the fabric fold where the TOP
    // blanket laps OVER the under one at the seam. A SHORT, thin folded edge so the
    // two blankets read as two separate sheets (one over the other) WITHOUT a tall
    // wall that would cross through a hill near the front. The possessor laps on top.
    // 0 = flush (no lap), ~0.1 = a thin clean fold, up to 0.35 = a deeper lap.
    lipH: 0.01,
    // МИН. ТЕРРИТОРИЯ ▸ у ворот — each team ALWAYS keeps a guaranteed band of
    // ownership around ITS OWN goal line (home own-goal at u≈0, away at u≈1), so
    // the opponent can never take the whole pitch in normal play. The contested
    // front lives between the two bands and can be pushed deep, but never erases
    // the defender's band. Fraction of pitch LENGTH per team. Overridden only by
    // the celebratory goal-flood. 0 = no guaranteed band (old behaviour).
    ownBand: 0.14,
    // ЯРКОСТЬ ЦВЕТА — emissive strength of the FLAT painted territory. The
    // coverage colour lies flat on the pitch (no tall body), so under scene
    // lighting it would render dark; this glow term makes it read VIVID team
    // colour regardless of height. 0 = lit only, ~1 = strong glow.
    glow: 1.0,
    // xG SPIRE (kept — but ONLY at real shots). xgW = spire WIDTH (scales the xG
    // stamp radius), xgH = spire HEIGHT (scales the crest term). The spire stands
    // at each REAL shot's pitch spot and fades a couple seconds after; NO spire
    // appears anywhere there was no shot.
    xgW: 0.95, xgH: 3.0,
    // ФОКУС ▸ зона игры — radius of the spatial focus mask that anchors the
    // HEIGHT relief to the single live play locus (ballAt(t)). Tight = one
    // coherent swell where play is; wide → approaches the old free-form field.
    // Colour/coverage stay BROAD; only height is gated. 0..1 → σ in world units.
    focus: 0.92,
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
    // УГЛОВЫЕ (STAGE11) — corner-ripple layer. cCorner on/off; wCorner strength
    // (0..~2, ×CORNER_AMP). When cCorner is off there is NO corner ripple/tint at all.
    // Old cfgs without these keys default to on + the reduced strength (loads gracefully).
    // Default 1.0 = the reduced CORNER_AMP (see CORNER_STRENGTH_DEFAULT below; inlined
    // here as a literal to avoid a temporal-dead-zone at module init, like FLOOD_HOLD).
    cCorner: true, wCorner: 0.02,
    // ОТМЕТКИ ▸ ВЫСОТА (STAGE11 CHANGE #5) — vertical position of the goal-token row
    // above the pitch. 0 = low (near the field), 1 = high (top of the screen). Purely
    // a 2D-overlay layout knob (see drawMarkers).
    markerH: 0.66,
    // contributors (☑ default = true): which signals RAISE a team's blanket.
    // The general relief (Владение/Продвижение/…) is now capped to GENTLE LOW
    // MOUNDS — the ONLY tall spires in the scene are the real xG shot crests
    // (cXg, placed exactly at each shot's pitch spot; see contribLift/computeA).
    cOwn: true,  wOwn: 2.7,   // Владение — on-ball control density
    cXg: true,   wXg: 2.4,    // Удары · xG — sharp tall crest at the REAL shot spot, ×xg
    cProg: true, wProg: 2.0,  // Продвижение — final-third / box entries, forward passes
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

// ============================================================================
// STAGE-THUMB — ESSENCE knobs. The thumbnail is ONE static frame that distils a
// whole match into its statistical fingerprint. Two contributions, each easy to tweak:
//   1) FRONT / colour-split  = the TIME-AVERAGED possession (mean of the momentum
//      series over the whole match) → a single flat lean. POSS_GAIN steepens how far a
//      given average lean pushes the split toward the dominant team's goal.
//   2) RELIEF / hills = the CUMULATIVE xG — every shot's crest stamped and SUMMED with
//      NO time-decay, so the hills show WHERE each team created danger over 90'.
//      XG_CREST_H scales the summed crest height; XG_MIN keeps only shots ≥ this xg
//      (goals always kept) so near-zero-xg noise doesn't stipple the terrain.
// This v1 formula is a STARTING POINT — retune these constants freely.
// ============================================================================
const ESSENCE = {
  // FRONT (avg possession — the colour split):
  POSS_GAIN: 0.78,      // steepness of avg-lean → front-u.
  POSS_MAX: 0.34,       // max the flat front may sit from centre.
  // RELIEF = ACTIVITY DENSITY (where each team PLAYED most, over the whole match) + shots.
  // Every on-ball event with a position raises its team's mound; the busiest zones stand
  // tallest, so the terrain is the match's SHAPE — not a flat split with a few pips.
  ACT_RAD_CELLS: 2.6,   // gaussian stamp radius per event on the density grid.
  ACT_GAMMA: 0.75,      // contrast on the normalised density (lower = flatter, higher = punchier peaks).
  ACT_H: 2.2,           // world-Y height of the activity mounds (× cfg.A.height in the render).
  // SHOTS / danger as sharper PEAKS on top of the density:
  XG_MIN: 0.03,         // ignore shots below this xg (goals always kept).
  XG_RAD_CELLS: 2.0,    // gaussian radius per shot crest (tighter than the mounds → a peak).
  // stamp values are multiplied by crestK (=4.2·xgH ≈ 12.6) in the render, so they are SMALL.
  XG_BASE: 0.05,        // base shot-crest stamp (a weak shot barely rises).
  XG_AMP: 0.20,         // + per unit xg → a dangerous shot ≈ 2–3 world-Y peak.
  // GOALS = BIG HILLS. Every goal MUST read as a big distinct hill regardless of its xG (a
  // tap-in goal still matters), so it gets a fixed TALL peak (well above shots) + an xG bonus.
  GOAL_PEAK: 0.67,      // goal-crest stamp → ≈ 8.4 world-Y (towers over shots/mounds; xgH-scaled)
  GOAL_XG_K: 0.6,       // extra height fraction for a high-xG goal (×xg on top of GOAL_PEAK)
  GOAL_RAD_CELLS: 3.0,  // goal hill radius (WIDER than a shot crest → a rounded HILL, not a spike)
  // ACTIVITY SCALE — a busier match (more events + more xG) rides visibly TALLER than a sparse
  // one, so quiet and frantic games look different (not all the same height). Multiplies the
  // whole mound field. Combines total xG and event count, clamped to a sane band.
  ACT_SCALE_BASE: 0.45, // floor height factor for a very quiet match
  ACT_SCALE_XG: 0.28,   // + per unit of total match xG
  ACT_SCALE_EV: 0.00035,// + per on-ball event (a busy match has ~1000+ events)
  ACT_SCALE_MIN: 0.5,   // clamp low
  ACT_SCALE_MAX: 1.8,   // clamp high
  // SEAM CURVE — the possession boundary is NOT a straight line: it bows per lateral channel
  // toward whoever was quieter there, from the home/away activity balance in that row. 0 = flat.
  SEAM_CURVE: 0.16,     // max per-channel deflection of the front (u-units)
  // GRID resolution of the activity grid (coarse→fine long-axis cells).
  GRID_LONG: 34,
};

// ---- boot -------------------------------------------------------------------
init().catch((e) => fail(e.message || String(e)));

async function init() {
  if (!window.WebGLRenderingContext) throw new Error('WebGL not available');

  // STAGE-THUMB — start from the built-in default (NOT the user's stage13 localStorage,
  // so every thumbnail renders deterministically the same), then apply the ESSENCE relief
  // tuning below. A #cfg= share link still wins for dev experimentation.
  // The ESSENCE relief tuning now lives in DEFAULTS() (A.height/xgH/focus/… baked to the
  // user's tuned values), so DEFAULTS() alone drives every thumbnail deterministically.
  // NO post-load override here — that hardcoded block used to clobber A.height/xgH/focus
  // back to old values, so panel-tuned defaults never showed. A #cfg= share link still wins.
  cfg = loadCfgFromHash() || MATCH_DEFAULT();

  let tlDoc = null;
  try { tlDoc = await fetch('/api/timeline/' + ID).then((r) => (r.ok ? r.json() : null)); } catch { tlDoc = null; }
  if (!tlDoc || !Array.isArray(tlDoc.events) || !tlDoc.events.length) {
    throw new Error('timeline ' + ID + ' missing (need /api/timeline/' + ID + ')');
  }
  teamMeta.home = tlDoc.home || teamMeta.home;
  teamMeta.away = tlDoc.away || teamMeta.away;
  teamMeta.duration = Number.isFinite(tlDoc.fullT) ? tlDoc.fullT : 100;
  // POST-MATCH PENALTY SHOOTOUT (only present on matches that went to penalties) → per-team
  // ordered scored/missed for the .shoot rings under each team. Absent → block stays empty.
  if (Array.isArray(tlDoc.shootout) && tlDoc.shootout.length) {
    shootoutOrder = tlDoc.shootout.map((k) => ({ team: k.team, scored: !!k.scored }));
    penaltyShootout = {
      home: shootoutOrder.filter((k) => k.team === 'home').map((k) => k.scored),
      away: shootoutOrder.filter((k) => k.team === 'away').map((k) => k.scored),
    };
  } else { penaltyShootout = undefined; shootoutOrder = null; }
  // Per-match REAL team colours (FRA/SEN default fallbacks). Set BEFORE buildCloth so
  // the two blankets are constructed with the right colours; also update COL_HOME/AWAY.
  const isHex = (s) => typeof s === 'string' && /^#?[0-9a-fA-F]{6}$/.test(s);
  if (isHex(teamMeta.home.color)) FRA_HEX = teamMeta.home.color;
  if (isHex(teamMeta.away.color)) SEN_HEX = teamMeta.away.color;
  COL_HOME.set(FRA_HEX); COL_AWAY.set(SEN_HEX);
  timeline = buildTimelineFromDoc(tlDoc);
  ballLocus = buildBallLocus(timeline);
  countGoals();
  buildFootballMinuteTable();   // expanded-clock → football-minute map for the on-screen clock
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
    `STAGE 12 · ${teamMeta.home.abbr} ${teamMeta.score.home}–${teamMeta.score.away} ${teamMeta.away.abbr}`;

  syncCfgToUI();
  window.addEventListener('resize', onResize);
  onResize();

  // STAGE-THUMB — NO playback loop. Render ONE static essence frame. We keep a light
  // rAF that only re-renders when needed (camera drag in ?dev mode) so the dev panel is
  // still interactive for tuning, but nothing animates on its own.
  playing = false;
  essenceRender();
  applyDefaultCamera();
  essenceRender();
  // dev/capture hooks for tuning the essence camera + forcing a re-render.
  window.__camera = camera; window.__controls = controls;
  window.__cfg = cfg; window.__ESSENCE = ESSENCE;
  window.__renderOnce = () => { renderFrame(clock); renderer.render(scene, camera); };
  // signal to the headless capture script that the first essence frame has been drawn.
  window.__thumbReady = true;
  requestAnimationFrame(thumbLoop);
}

// ESSENCE STATIC RENDER — pin the clock past the final whistle (so no goal-wave /
// corner / penalty transient is active), zero the settle so the relief is NOT flattened,
// snap all smoothing, then render exactly one frame through the composer.
function essenceRender() {
  resetSettle();
  settle = 0; settling = false;
  clock = Number.isFinite(teamMeta.duration) ? teamMeta.duration : 100;
  playing = false;
  snapASmoothing();
  renderFrame(clock);      // dt = Infinity → all exp filters snap to target
  if (controls) controls.update();
  // STAGE-THUMB — render the scene DIRECTLY (NOT through the composer). The post chain's
  // OutputPass/GradeShader writes gl_FragColor.a = 1.0 (and adds a vignette), which would
  // fill the whole frame OPAQUE + dark and destroy the transparency we need. Direct
  // rendering respects renderer's transparent clear colour → the PNG keeps its alpha.
  renderer.render(scene, camera);
}

// Lightweight idle loop: keep OrbitControls damping alive + re-render on camera change
// (dev tuning only). No simulation advances — the frame stays the static essence.
let _thumbLastCam = '';
function thumbLoop() {
  if (controls) {
    controls.update();
    const cam = camera.position.toArray().concat(controls.target.toArray()).map((n) => n.toFixed(2)).join(',');
    if (cam !== _thumbLastCam) {
      _thumbLastCam = cam;
      renderFrame(clock);
      renderer.render(scene, camera);   // direct render → keep transparency
      updateCamReadout();
    }
  }
  requestAnimationFrame(thumbLoop);
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
  // STAGE-THUMB — TRANSPARENT renderer: alpha:true + a fully transparent clear colour so
  // the clay/cloth + pitch lines composite over nothing (the captured PNG keeps its alpha).
  renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);   // clear to fully transparent (alpha 0)
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  // STAGE-THUMB — NO sky dome, NO scene.background, NO fog: nothing may fill the frame.
  // The composite must be transparent so the thumbnail drops onto any card background.
  scene.background = null;
  buildSky();   // build the tiny sky canvas/texture ONLY so downstream refs (skyTex) exist;
                // it is never attached to the scene, so it paints nothing on screen.

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  // STAGE11 — ORTHOGRAPHIC camera (flatter, more graphic look). The frustum is sized from
  // ORTHO_VIEW (world-unit VERTICAL half-extent) × aspect; OrbitControls drives orbit +
  // camera.zoom (dolly maps to zoom in ortho). setOrthoFrustum() (called on resize) keeps
  // the pitch framed in the centered ~1000px column at any aspect. Kept at the same
  // position/target as the tuned perspective ракурс so the composition reads the same.
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 200);
  camera.position.set(DEFAULT_CAM.pos[0], DEFAULT_CAM.pos[1], DEFAULT_CAM.pos[2]);
  camera.zoom = 1;
  setOrthoFrustum(1);   // seed with aspect 1; onResize() re-sizes to the real client box

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  // dolly in ortho scales camera.zoom; bound it so the pitch can't be zoomed to nothing
  // or blown up past the frame (mirrors the old perspective min/maxDistance feel).
  controls.minZoom = 0.45;
  controls.maxZoom = 4.0;
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
// the new leader over ~1s after a goal. The sky is driven ONLY by the SCORE now — cards
// no longer touch it (they live in the markers panel). Kept SUBTLE — a tint of the void,
// gallery-grade, never garish.
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
  // STAGE13 — softer, more EVEN score-tint (was 0.14/0.34/0.58): the leader hue washes the
  // whole sky gently rather than pooling into a bright bottom disc that read as a circle.
  const topT = 0.09 * strength, midT = 0.14 * strength, botT = 0.22 * strength;
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
  // STAGE-THUMB — the sky/backdrop/fog are all removed for the transparent essence
  // render, so this ambient score-tint updater is a no-op (nothing to paint).
  return;
  // eslint-disable-next-line no-unreachable
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
  const lc = (lean >= 0) ? COL_HOME : COL_AWAY;
  _tintCol.copy(lc);
  // A GREY / low-chroma leader (e.g. Germany #464646) must NOT wash the black sky — grey-on-
  // black is muddy, so we keep the BACKGROUND BLACK and let ONLY a clearly-COLOURED leader
  // glow. Scale the whole atmosphere tint (sky + fog + backdrop) by the leader's chroma.
  const chroma = Math.max(lc.r, lc.g, lc.b) - Math.min(lc.r, lc.g, lc.b);
  const glowLean = lean * smoothstep(0.05, 0.22, chroma);
  skyFlash = 0;
  paintSky(glowLean, _tintCol, 0);
  // The FOG stays a NEUTRAL deep void (barely any lean) so the pitch/cloth colours stay TRUE;
  // the leader-tint lives in the CSS backdrop halo + the WebGL sky dome. Grey leader → 0.
  if (scene && scene.fog) {
    _tintCol.copy(SKY_BOT).lerp(lc, 0.08 * Math.abs(glowLean));
    scene.fog.color.copy(_tintCol);
  }
  paintBackdrop(glowLean, 0);
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
  // STAGE13 — the backdrop is NO LONGER an obvious centred disc fading to black corners.
  // It's a FULL-FRAME atmosphere: an OFF-CENTRE leader-tinted glow + a second deeper pool
  // for asymmetry, over a soft diagonal deep-plum wash (no crisp vignette ring). Kept
  // gallery-subtle so the blanket stays the star; a draw (strength≈0) leaves just the wash.
  const c = _rgb(_bdCol);
  const a1 = (0.26 * strength).toFixed(3);
  const a2 = (0.14 * strength).toFixed(3);
  const a3 = (0.09 * strength).toFixed(3);
  bd.style.background =
    // primary leader glow — off-centre (upper-left), large & soft, bleeds past the frame
    `radial-gradient(128% 108% at 37% 27%, rgba(${c},${a1}) 0%, rgba(${c},${a2}) 33%, rgba(${c},0) 67%),` +
    // secondary deeper pool lower-right — breaks the symmetry so it never reads as one disc
    `radial-gradient(120% 132% at 79% 83%, rgba(${c},${a3}) 0%, rgba(${c},0) 57%),` +
    // base — soft diagonal deep-plum wash filling the whole frame (no black-corner ring)
    `linear-gradient(158deg, #0b0a1a 0%, #06060e 52%, #0a0714 100%)`;
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
// a small billboard sprite showing the scoring MINUTE (white), sits INSIDE the ring.
function makeMinuteSprite(minute) {
  const cv = document.createElement('canvas'); cv.width = 96; cv.height = 48;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = 'rgba(240,242,248,0.96)';
  ctx.font = "600 30px Barlow, ui-sans-serif, sans-serif";
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(minute + "'", 48, 25);
  const tex = new THREE.CanvasTexture(cv); tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, toneMapped: false });
  const sp = new THREE.Sprite(mat); sp.scale.set(0.62, 0.31, 1);
  return sp;
}
function buildGoalRings() {
  // dispose any prior rings + labels (match switch rebuild)
  for (const r of goalRings) {
    if (r.mesh) { scene.remove(r.mesh); r.mesh.geometry.dispose(); r.mesh.material.dispose(); }
    if (r.label) { scene.remove(r.label); if (r.label.material.map) r.label.material.map.dispose(); r.label.material.dispose(); }
  }
  goalRings = [];
  // STAGE13 — the white outlined goal RINGS on the pitch/touchline are REMOVED (goals now
  // live under the teams in the HUD). Clear any existing and build none.
  return;
  // eslint-disable-next-line no-unreachable
  if (!goalsByTime || !goalsByTime.length) return;
  const stroke = 0.05;                       // ≈ pitch-markings line weight
  const R = 0.5;                             // ring radius (world units)
  // ALL goals in ONE CHRONOLOGICAL ROW starting at the LEFT edge and marching RIGHT
  // along the near touchline — NOT split by which goal was conceded. White vector
  // rings (pitch-line style), the scoring MINUTE inside each. Rings sit in the X-Y
  // plane (face ±Z, toward the camera) so they read as clean circles.
  const y = R + 0.18;                        // low constant height above the pitch
  const z = WORLD_Z / 2 + 0.45;             // just outside the NEAR touchline (toward the camera)
  const dx = R * 2 + 0.3;                    // spacing between successive rings
  const x0 = -WORLD_X / 2 + R + 0.1;         // first ring at the LEFT edge
  const mat = new THREE.MeshBasicMaterial({ color: RING_COL, side: THREE.DoubleSide, transparent: true, opacity: 0.95, toneMapped: false, depthWrite: false, depthTest: false });
  for (let i = 0; i < goalsByTime.length; i++) {
    const g = goalsByTime[i];
    const minute = Number.isFinite(g.minute) ? g.minute : Math.floor(g.t);
    const x = x0 + i * dx;
    const geo = new THREE.RingGeometry(R - stroke, R, 48);
    const m = new THREE.Mesh(geo, mat.clone());   // XY-plane ring, faces the camera
    m.position.set(x, y, z);
    m.renderOrder = 4; m.visible = false;
    scene.add(m);
    const lab = makeMinuteSprite(minute);
    lab.position.set(x, y, z + 0.02);
    lab.renderOrder = 5; lab.visible = false;
    scene.add(lab);
    goalRings.push({ mesh: m, label: lab, t: g.t });
  }
}
// per-frame: show the rings + minute labels whose goal has occurred by clock t.
function updateGoalRings(t) {
  for (const r of goalRings) {
    const on = goalLanded(r.t, t);
    if (r.mesh) r.mesh.visible = on;
    if (r.label) r.label.visible = on;
  }
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
  // CORNER-WAVE tint strength 0..1 per vertex — where a corner ripple crest passes over
  // this sheet, the fragment shader blends the surface toward the ATTACKING colour (uCornerCol).
  const cData = new Float32Array(NV);
  const cTex = new THREE.DataTexture(cData, VX, VY, THREE.RedFormat, THREE.FloatType);
  cTex.magFilter = THREE.LinearFilter; cTex.minFilter = THREE.LinearFilter; cTex.needsUpdate = true;

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
    // CORNER WAVE — per-vertex ripple-crest tint strength (uCorner tex, 0..1) blended
    // toward the ATTACKING team's colour (uCornerCol, set per-frame in computeField).
    uCorner: { value: cTex }, uCornerCol: { value: new THREE.Color(teamCol) },
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
      uniform sampler2D uCorner; uniform vec3 uCornerCol;   // CORNER WAVE — crest tint
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
        // CORNER WAVE — a transient radial ripple crest (uCorner tex, 0..1, built in
        // computeField from cornerWavesAt) tints THIS cell toward the ATTACKING team's
        // colour (uCornerCol). A faint travelling colour band riding the height ripple —
        // a surface transient, NOT a territory flip (coverage/front are untouched).
        float cw = clamp(texture2D(uCorner, vUvN).r, 0.0, 1.0);
        if (cw > 0.001) col = mix(col, uCornerCol, cw);
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
         // CORNER WAVE glow — the ripple crest lies mostly flat on the pitch, so give it a
         // gentle emissive lift in the ATTACKING colour so the travelling wave reads vividly.
         float cwE = clamp(texture2D(uCorner, vUvN).r, 0.0, 1.0);
         emit += uCornerCol * cwE * 0.55 * litMul;
         totalEmissiveRadiance += emit;
       }`);
  };
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true; m.receiveShadow = true;
  scene.add(m);
  return { mesh: m, hData, hTex, aData, aTex, cData, cTex, u };
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
    if (e.shootout) continue;   // post-match shootout kicks live in penaltyShootout, NOT the engine timeline
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
  // STAGE12 — ATTACK REACH per-channel accumulators (deep real attacking events push the
  // front toward the attacked goal, held with a MEDIUM ~10-15s wall-time memory).
  A_reachH = new Float32Array(gy); A_reachA = new Float32Array(gy);     // reach depth accum (u)
  A_reachWH = new Float32Array(gy); A_reachWA = new Float32Array(gy);   // reach weights
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
// STAGE12 — ATTACK REACH per-team per-channel targets (see buildAttackReach).
let A_reachH = null, A_reachA = null, A_reachWH = null, A_reachWA = null;
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
    const isShot = e.kind === 'shot';
    const isPass = e.kind === 'pass' && Number.isFinite(e.eu);
    if (!isShot && !isPass) continue;
    const isH = e.team === 'home';
    if (!isH && e.team !== 'away') continue;
    const age = t - e.t;
    const env = arWeight(age, atkMin, relMin);   // fast attack + fast decay
    if (env < 0.03) continue;
    // the team's prior on-ball touch time → "fast counter" estimate (short gap = quick
    // forward move right after regaining/receiving).
    let prevT = -Infinity;
    for (let k = wi - 1; k >= 0; k--) {
      const pe = win[k];
      if (pe.team === e.team && (ONBALL_TYPES.has(pe.type) || pe.isTouch)) { prevT = pe.t; break; }
    }
    const gap = e.t - prevT;
    const fast = clamp(1 - gap / 0.12, 0, 1);      // 1 = quick after regaining
    // STAGE11 — a THRUST is a SHARP LOCAL ACCENT at a REAL DANGER ZONE (the user: the
    // sharp in-plane lunges were lost when the edge went even). We accent exactly the
    // zones the data flags as dangerous: a SHOT (∝ xg), a pass REACHING the final
    // third/box, a THROUGH ball, or a FAST counter gaining ground. Ordinary midfield
    // forward passes no longer finger (that is what made the edge roll up even).
    let fv, endU, w;
    if (isShot) {
      fv = Number.isFinite(e.ev) ? e.ev : (Number.isFinite(e.v) ? e.v : 0.5);
      endU = isH ? hi : lo;                        // stab to the goal band
      const xg = clamp(e.xg || 0, 0, 1);
      w = (0.7 + 2.6 * xg) * env * strength;       // a real chance = a strong tongue
    } else {
      const fwd = isH ? (e.eu - e.u) : (e.u - e.eu);
      if (fwd < THRUST_MIN_FWD) continue;
      const deep = isH ? (e.eu >= 0.60) : (e.eu <= 0.40);   // reached the final third
      if (!deep && !e.through && !(fast > 0.4 && fwd > 0.12)) continue;   // DANGER GATE
      const fastBoost = 1 + 0.6 * fast;
      const thruBoost = e.through ? 1.8 : 1;
      const longBoost = e.long ? 1.4 : 1;
      w = clamp(fwd * 3.0, 0, 1.2) * fastBoost * thruBoost * longBoost * env * strength;
      fv = e.ev;
      endU = clamp(e.eu, lo, hi);
    }
    if (w < 0.02) continue;
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

// ============================================================================
// ATTACK REACH (STAGE12) — the territory must reflect the REAL ATTACKING REACH ---
// Problem: the momentum pulse can read 100% for a team (ICO at their 74' goal, or a
// team winning a run of corners) while the coloured territory only shows them a bit
// ahead — because the front is a smoothed/lagged blend of momentum. But physically a
// SHOT / CORNER / BOX-ENTRY / CROSS MEANS that team reached the opponent's goal, so
// the territory should be pushed DEEP there.
//
// This builds a per-channel per-team "reach" signal from REAL deep attacking events:
//   · SHOTS            — at the shot's flank, reaching to the goal band (deepest).
//   · CORNERS          — won at the byline → deep at that flank (goal band, corner v).
//   · CROSSES (e.cross)— a ball swung into the box → deep at the cross's end flank.
//   · BOX / final-third passes — passes ENDING deep in the attacking third → to eu.
// Each pushes the front at its lateral channel(s) toward the attacked goal, reaching
// to its depth. MEDIUM decay: "territorial memory" ~REACH_MEM_S seconds of WALL time
// (longer than the ~3s transient thrust fingers, shorter than permanent), so the
// ground GAINED by attacking deep is HELD while the team keeps attacking there, then
// recedes when the phase ends. Authored in WALL seconds via wallSecondsSinceGoal()
// (like the thrust/goal/corner timing) → scrub-safe & deterministic from t.
//
// Combined in computeA as: front(v) = max-toward-attacker(momentumBackbone, reach).
// The momentum backbone still sets the gross baseline; the reach pushes the front
// DEEPER where real penetration happened. Own-goal band clamp is respected.
// The whole match plays in ~DRAMA_TOTAL_S wall-seconds, so "territorial memory" is a
// FRACTION of that pass. A ~7s wall half-life is clearly MEDIUM (vs the ~3s thrust,
// shorter than permanent) — a real attacking PHASE is held ~7s then recedes, without
// smearing the whole 40s pass into one team's colour.
const REACH_MEM_S = 7.0;       // MEDIUM decay — territorial memory half-life in WALL seconds
const REACH_ATK_S = 0.6;       // gentle ease-IN (wall seconds) so a reach push grows in, doesn't pop
const REACH_SIGV = 0.13;       // lateral half-width in v (WIDER than a thrust finger — a phase, not a stab)
const REACH_MAX_PULL = 0.34;   // max u-units the reach advances the front PAST the backbone (per side)
function buildAttackReach(t, gx, gy, band) {
  A_reachH.fill(0); A_reachA.fill(0); A_reachWH.fill(0); A_reachWA.fill(0);
  if (!timeline) return;
  const lo = clamp(band, 0, 0.45), hi = 1 - lo;
  // window a few memory-lengths back, converted to CLOCK match-minutes via the playback
  // rate so the memory is in WALL time (like the goal flood / corner ripple / thrust).
  const spd = Math.max(0.05, Number(cfg.speed) || 0.9);
  const relS = REACH_MEM_S / Math.LN2;                 // decay τ (wall seconds)
  // WINDOW in match-minutes: cover ~4 half-lives of WALL time. Convert wall-seconds →
  // match-minutes via the average playback rate (match-min per wall-sec = duration /
  // passSeconds). The dramatic clock is non-uniform (calm plays FAST), so widen ×1.6 as a
  // safety margin — the EXACT wall-time envelope (wallSecondsSinceGoal below) does the real
  // culling, this just bounds how far back to scan.
  const passSeconds = Math.max(1, DRAMA_TOTAL_S / spd);
  const dur = (teamMeta && teamMeta.duration) ? teamMeta.duration : 100;
  const matchMinPerWall = dur / passSeconds;
  const wallWinS = relS * 4 + REACH_ATK_S * 2;
  const winMin = wallWinS * matchMinPerWall * 1.6;     // match-minute scan window
  const win = eventsInWindow(t, winMin);
  const reach = REACH_SIGV * 3;
  const inv2sig2 = 1 / (2 * REACH_SIGV * REACH_SIGV);
  for (let wi = 0; wi < win.length; wi++) {
    const e = win[wi];
    const isH = e.team === 'home';
    if (!isH && e.team !== 'away') continue;
    // envelope in WALL time: gentle ease-in + medium decay (deterministic from t).
    const wall = wallSecondsSinceGoal(e.t, t);
    if (!Number.isFinite(wall) || wall < 0) continue;
    const env = arWeight(wall, REACH_ATK_S, relS);
    if (env < 0.03) continue;
    // Classify a DEEP attacking event and derive its (flank v, reach depth endU, weight).
    let fv = Number.isFinite(e.ev) ? e.ev : (Number.isFinite(e.v) ? e.v : 0.5);
    let endU, w = 0;
    if (e.kind === 'shot') {
      // a shot = the team reached the goal. Depth = the goal band; weight ∝ xg (a real
      // chance holds the territory harder) with a solid floor so even a low-xg shot pushes.
      endU = isH ? hi : lo;
      const xg = clamp(e.xg || 0, 0, 1);
      w = (0.85 + 1.6 * xg) * env;
      fv = Number.isFinite(e.v) ? e.v : fv;             // shot spot flank
    } else if (e.type === 'CornerAwarded' && e.outcome === 'Successful') {
      // a won corner = deep at that flank/byline. Snap to the attacked goal band + the
      // corner's touchline (like buildCorners) so it reads as a deep flank push.
      endU = isH ? hi : lo;
      fv = (Number.isFinite(e.v) ? e.v : 0.5) < 0.5 ? 0.06 : 0.94;
      w = 1.15 * env;                                   // corners are strong, sustained reach
    } else if (e.kind === 'pass' && Number.isFinite(e.eu)) {
      // CROSS (e.cross) → into the box; or a pass ENDING deep in the attacking third
      // (box / final-third entry). Ignore passes that don't reach deep.
      const deepEnd = isH ? e.eu : (1 - e.eu);          // 0..1, 1 = at the attacked goal
      const isCross = !!e.cross;
      if (!isCross && deepEnd < 0.66) continue;         // BOX/FINAL-THIRD gate (attacking third ≥0.66)
      endU = clamp(isH ? e.eu : e.eu, lo, hi);          // reach to the pass END depth
      // deeper endings + crosses push harder; a final-third entry is a moderate hold.
      w = (isCross ? 1.0 : 0.75) * clamp((deepEnd - 0.5) / 0.5, 0, 1) * env;
    } else {
      continue;
    }
    if (w < 0.03) continue;
    const jLo = Math.max(0, Math.floor((1 - (fv + reach)) * (gy - 1)));
    const jHi = Math.min(gy - 1, Math.ceil((1 - (fv - reach)) * (gy - 1)));
    for (let j = jLo; j <= jHi; j++) {
      const vv = 1 - j / (gy - 1);
      const dv = vv - fv;
      const lw = Math.exp(-dv * dv * inv2sig2) * w;
      if (lw < 0.02) continue;
      if (isH) { A_reachH[j] += endU * lw; A_reachWH[j] += lw; }
      else     { A_reachA[j] += endU * lw; A_reachWA[j] += lw; }
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

// ============================================================================
// STAGE-THUMB — ESSENCE field. Replaces the live, time-windowed computeA with a
// STATIC distillation of the whole match:
//   · FRONT  — a FLAT front-u from the TIME-AVERAGED momentum (mean of the whole
//              series). Home-dominant average → front pushed toward the away goal
//              (home owns more of the pitch), and vice-versa.
//   · RELIEF — CUMULATIVE xG: every shot's crest stamped into the xG grids and
//              SUMMED with NO time decay, so the terrain shows where each team made
//              danger over 90'. The general (possession) mounds are left flat so the
//              xG hills are the whole relief story.
// Writes the SAME buffers the vertex loop in computeField reads (A_shH/A_shA = mounds,
// A_sxH/A_sxA = xG crests, A_sown/A_own = front-u), so the inherited render machinery
// (clay material, seam lip, pitch-line weave) draws the essence unchanged.
// ============================================================================
function essenceAvgMomentum() {
  // mean of the whole momentum series (valueNorm ∈ [−1,+1], + = home on top). No data
  // → 0 (a centred 50/50 split). Real data only; nothing fabricated.
  const M = momentum;
  if (!M || !M.length) return 0;
  let s = 0, n = 0;
  for (const d of M) { if (Number.isFinite(d.v)) { s += d.v; n++; } }
  return n ? clamp(s / n, -1, 1) : 0;
}
let _essenceFrontU = 0.5;   // dev read-out of the computed flat front
function essenceComputeA() {
  const gx = Math.max(8, Math.round(ESSENCE.GRID_LONG));
  const gy = Math.max(6, Math.round(gx * WORLD_Z / WORLD_X));
  ensureA(gx, gy);
  A_hH.fill(0); A_hA.fill(0); A_xH.fill(0); A_xA.fill(0);

  // ---- RELIEF PART 1: ACTIVITY DENSITY (where each team PLAYED most) -----------
  // Every on-ball event with a real pitch position raises its team's MOUND grid at (u,v)
  // (already mirrored into the shared frame by toUV). Summed over the whole match → the
  // busiest zones (where a team camped / built play) stand tallest. This is the match's
  // SHAPE, not a flat split. Real events only — nothing fabricated.
  let nEv = 0;
  for (const e of (timeline || [])) {
    if (!Number.isFinite(e.u) || !Number.isFinite(e.v)) continue;
    const isH = e.team === 'home';
    if (!isH && e.team !== 'away') continue;
    stamp(isH ? A_hH : A_hA, gx, gy, e.u, e.v, 1.0, ESSENCE.ACT_RAD_CELLS);
    nEv++;
  }
  // normalise each team's density to 0..1 + gamma so the busiest zones read as clear mounds.
  const norm = (g) => { let mx = 1e-4; for (const v of g) if (v > mx) mx = v; const inv = 1 / mx; for (let i = 0; i < g.length; i++) g[i] = Math.pow(g[i] * inv, ESSENCE.ACT_GAMMA); };
  norm(A_hH); norm(A_hA);
  // ACTIVITY SCALE — busier matches ride TALLER. After the shape-normalise above, multiply the
  // WHOLE mound field by a factor from total xG + event count, so a frantic game clearly towers
  // over a sparse one (they no longer all look the same height).
  let sumXg = 0;
  for (const e of (timeline || [])) { if (e.kind === 'shot') sumXg += Number(e.xg) || 0; }
  const actScale = clamp(ESSENCE.ACT_SCALE_BASE + ESSENCE.ACT_SCALE_XG * sumXg + ESSENCE.ACT_SCALE_EV * nEv,
                         ESSENCE.ACT_SCALE_MIN, ESSENCE.ACT_SCALE_MAX);
  for (let i = 0; i < A_hH.length; i++) { A_hH[i] *= actScale; A_hA[i] *= actScale; }

  // ---- RELIEF PART 2: GOALS as BIG HILLS + dangerous shots as sharper peaks ----
  for (const e of (timeline || [])) {
    if (e.kind !== 'shot') continue;
    const xg = Number(e.xg) || 0;
    const isH = e.team === 'home';
    if (!isH && e.team !== 'away') continue;
    if (e.isGoal) {
      // GOAL — a BIG hill, height mostly INDEPENDENT of xg (every goal reads clearly), with a
      // bonus for a high-xg goal. Wider radius → a rounded HILL, not a needle.
      stamp(isH ? A_xH : A_xA, gx, gy, e.u, e.v, ESSENCE.GOAL_PEAK * (1 + ESSENCE.GOAL_XG_K * clamp(xg, 0, 1)), ESSENCE.GOAL_RAD_CELLS);
    } else if (xg >= ESSENCE.XG_MIN) {
      // a non-goal dangerous shot: a sharper, MUCH lower peak scaled by xg.
      stamp(isH ? A_xH : A_xA, gx, gy, e.u, e.v, ESSENCE.XG_BASE + ESSENCE.XG_AMP * clamp(xg, 0, 1), ESSENCE.XG_RAD_CELLS);
    }
  }
  // static → copy straight into the SMOOTHED grids the renderer samples. Mounds = activity
  // density (A_shH/A_shA); xG crests + goal hills = danger peaks (A_sxH/A_sxA).
  A_shH.set(A_hH); A_shA.set(A_hA);
  A_sxH.set(A_xH); A_sxA.set(A_xA);

  // ---- FRONT: a CURVED seam — base lean from avg possession, then a per-channel deflection
  // from the home/away activity BALANCE in that lateral row, so the boundary BOWS toward
  // whoever was quieter there (a living, curved seam, not a straight diagonal). ------------
  const mom = essenceAvgMomentum();               // −1..+1 mean lean (+ = home)
  const lean = Math.sign(mom) * Math.pow(Math.abs(mom), ESSENCE.POSS_GAIN);
  const baseFront = clamp(0.5 + ESSENCE.POSS_MAX * lean, 0.5 - ESSENCE.POSS_MAX, 0.5 + ESSENCE.POSS_MAX);
  _essenceFrontU = baseFront;
  const loF = 0.5 - ESSENCE.POSS_MAX - 0.15, hiF = 0.5 + ESSENCE.POSS_MAX + 0.15;
  for (let j = 0; j < gy; j++) {
    let sh = 0, sa = 0;
    for (let i = 0; i < gx; i++) { sh += A_hH[j * gx + i]; sa += A_hA[j * gx + i]; }
    const bal = (sh - sa) / (sh + sa + 1e-4);       // −1..+1, + = home busier in this channel
    const fr = clamp(baseFront + ESSENCE.SEAM_CURVE * bal, loF, hiF);
    A_front[j] = fr; A_frontRaw[j] = fr; A_frontDisp[j] = fr;
    for (let i = 0; i < gx; i++) A_own[j * gx + i] = fr;   // per-cell ownership follows the curved front
  }
  A_sown.set(A_own);
}
// dev/verify read-out: the cumulative-xG crest field + the flat front, so the essence
// contributions can be measured objectively (no browser needed for QA).
window.__essenceStats = () => {
  const gmax = (a) => { let m = 0; for (const v of (a || [])) if (v > m) m = v; return +m.toFixed(2); };
  let nShots = 0, sumXg = 0;
  for (const e of (timeline || [])) if (e.kind === 'shot' && ((Number(e.xg) || 0) >= ESSENCE.XG_MIN || e.isGoal)) { nShots++; sumXg += Number(e.xg) || 0; }
  return {
    frontU: +_essenceFrontU.toFixed(3), avgMom: +essenceAvgMomentum().toFixed(3),
    shotsStamped: nShots, sumXg: +sumXg.toFixed(2),
    xgCrestMaxHome: gmax(A_sxH), xgCrestMaxAway: gmax(A_sxA),
    hDataMaxHome: blankets ? gmax(blankets.home.hData) : null,
    hDataMaxAway: blankets ? gmax(blankets.away.hData) : null,
    surfYMax: gmax(surfYData),
    grid: [A_gx, A_gy],
  };
};

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
  // ATTACK REACH (STAGE12) — FRONT RECONCILIATION. Deep REAL attacking events (shots,
  // corners, box/final-third passes, crosses) push the front toward the attacked goal
  // with a MEDIUM ~12s wall-time memory. Combine into the momentum backbone (A_frontRaw,
  // the smooth target that then eases into A_front) as:
  //     front(v) = max-toward-attacker( momentumBackbone(v), attackReach(v) )
  // i.e. the front reaches AS DEEP AS the deeper of (momentum-implied, recent real reach).
  // The backbone still sets the gross baseline; the reach pushes DEEPER where real
  // penetration happened. Because this feeds A_frontRaw (which then goes through the
  // TAU_FRONT temporal low-pass into A_front), the reach EASES IN smoothly, never pops.
  // Own-goal band clamp preserved (defender always keeps a sliver).
  buildAttackReach(t, gx, gy, band);
  {
    const lo = clamp(band, 0, 0.45), hi = 1 - lo;
    // COMBINE = max-toward-attacker(backbone, reach), but NETTED per channel so the
    // side that reached DEEPER/MORE wins that flank — a lone opponent foray can't flip a
    // channel the backbone (momentum) already owns. For each side we form a reach TARGET
    // (weighted-mean end depth) + an INTENSITY (saturating recent reach weight). The side
    // with the greater intensity pushes the front toward ITS goal by a strength ∝ its NET
    // dominance (its intensity minus the opponent's), capped so it can't erase the other's
    // territory in one go (like the thrust cap). Only pushes DEEPER than the backbone.
    for (let j = 0; j < gy; j++) {
      const base = A_frontRaw[j];        // momentum backbone target for this channel
      let fr = base;
      const wH = A_reachWH[j], wA = A_reachWA[j];
      const iH = 1 - Math.exp(-wH), iA = 1 - Math.exp(-wA);   // 0..1 saturating intensities
      // net dominance decides direction; magnitude = how much one side out-attacked the other.
      const net = iH - iA;               // >0 home reached more here, <0 away reached more
      if (net > 0.02 && wH > 1e-4) {     // HOME pushes front toward u=1 (its attacking goal)
        const target = A_reachH[j] / wH; // home's weighted reach depth (deep, toward hi)
        if (target > base) {
          const pull = clamp((target - base) * net, 0, REACH_MAX_PULL);
          fr = base + pull;
        }
      } else if (net < -0.02 && wA > 1e-4) {  // AWAY pushes front toward u=0
        const target = A_reachA[j] / wA;      // away's weighted reach depth (deep, toward lo)
        if (target < base) {
          const pull = clamp((base - target) * (-net), 0, REACH_MAX_PULL);
          fr = base - pull;
        }
      }
      A_frontRaw[j] = clamp(fr, lo, hi);      // keep the defender's own-goal sliver
    }
    // light lateral smoothing so the reach push is organic/blobby at the seam, not stepped.
    smoothChannels(A_frontRaw, gy, 1);
  }
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
  const THRUST_MAX_PULL = 0.35;   // max u-units a finger advances the front past the backbone. Fingers are now DANGER-GATED (only real chances: shots ∝xg, box-reaching/through/fast passes) + NARROW (1-2 channels), so they're sparse sharp tongues at real danger zones — they can stab DEEP into the box without cancelling the momentum backbone's gross swing (which ordinary forward passes used to do at ±0.22 across the whole edge).
  const rlo = clamp(band, 0, 0.45), rhi = 1 - rlo;
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
    // ATTACK-REACH HOLD (STAGE12) — the ground a team GAINED by attacking deep is HELD
    // against the OPPONENT's transient thrust tongues. Where home holds strong deep reach
    // (weighted end-depth rH, intensity iH), an away thrust can't dent the front below a
    // floor at rH; symmetric for away. Scaled by intensity so a faint reach barely holds
    // and a sustained deep spell holds firmly. This is what makes a corner/shot-heavy
    // phase read DEEP even while the opponent pokes the odd counter. Own-band respected.
    const wH = A_reachWH[j], wA = A_reachWA[j];
    const iH = wH > 1e-4 ? 1 - Math.exp(-wH) : 0;
    const iA = wA > 1e-4 ? 1 - Math.exp(-wA) : 0;
    const net = iH - iA;                                     // which side holds this channel
    if (net > 0.02 && wH > 1e-4) {
      const rH = A_reachH[j] / wH;                           // home's held reach depth (toward hi)
      const hold = lerp(base, Math.min(rH, rhi), net);       // hold strength ∝ net home dominance
      if (fr < hold) fr = hold;                              // away thrust can't pull below the hold
    } else if (net < -0.02 && wA > 1e-4) {
      const rA = A_reachA[j] / wA;                           // away's held reach depth (toward lo)
      const hold = lerp(base, Math.max(rA, rlo), -net);
      if (fr > hold) fr = hold;                              // home thrust can't pull above the hold
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
  // …or, after full time, a SCORED shootout kick floods the whole field the kicker's colour.
  const wave = goalWaveAt(t) || (shootActive ? shootoutWaveAt() : null);
  for (let j = 0; j < gy; j++) {
    A_frontDisp[j] += (A_frontEff[j] - A_frontDisp[j]) * kd;
    // during the shootout the base is a CLEAN 50/50 colour split (not the jagged end-of-match
    // territory); a SCORED kick floods it fully to the kicker's colour, a MISS leaves the split.
    let fr = shootActive ? 0.5 : A_frontDisp[j];
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
// Has the goal at gt "landed" as a HUD event by clock t? True once EVENT_LAG_S wall-seconds
// have passed since the goal — so score/sky/markers trail the cloth flood. Falls back to the
// plain time test before the dramatic clock is warmed up (wall time not yet computable).
function goalLanded(gt, t) {
  const w = wallSecondsSinceGoal(gt, t);
  if (!Number.isFinite(w)) return gt <= t;
  return w >= EVENT_LAG_S;
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

// ============================================================================
// CORNER WAVES — a corner kick = a WAVE rippling OUT FROM THE PITCH CORNER, in the
// ATTACKING team's colour, across the cloth, appearing at the corner moment and fading.
//
// DETECTION. The harvest emits `CornerAwarded` events in MIRRORED PAIRS at the same t
// (one per team). The event with outcome==='Successful' is the team that WON/TOOK the
// corner (the ATTACKER); after toUV mirroring its (u,v) lands deep toward the attacked
// goal near a touchline. We keep those, and SNAP each to the nearest real PITCH CORNER
// on the attacked end: home attacks u→1, away attacks u→0; touchline v→0 or v→1 by which
// half of the pitch the corner is in. buildCorners() builds the list once per match.
// ============================================================================
let cornersByTime = [];   // {t, team, u, v} — corner spot snapped to the pitch corner, match-time order
function buildCorners() {
  cornersByTime = [];
  if (!timeline) return;
  for (const e of timeline) {
    if (e.type !== 'CornerAwarded' || e.outcome !== 'Successful') continue;
    if (e.team !== 'home' && e.team !== 'away') continue;
    // e.u/e.v are already mirrored into the shared pitch frame (buildTimelineFromDoc).
    // Snap to the actual pitch CORNER on the attacked end: home attacks u→1, away → u→0;
    // touchline = nearer of v=0 / v=1.
    const cu = e.team === 'home' ? 1.0 : 0.0;
    const cv = (Number.isFinite(e.v) ? e.v : 0.5) < 0.5 ? 0.0 : 1.0;
    cornersByTime.push({ t: e.t, team: e.team, u: cu, v: cv });
  }
  cornersByTime.sort((a, b) => a.t - b.t);
}

// CORNER WAVE timing — authored in WALL seconds (screen time), like goalFloodAt, so it
// plays fully under the dramatic clock and is scrub-safe (elapsed = wallSecondsSinceGoal).
const CORNER_WAVE_S = 2.6;     // total screen-time life of one ripple (appear → expand → fade)
const CORNER_SPEED = 0.30;     // ring EXPANSION speed in u-units of pitch length per wall-second — SLOWED (0.42→0.30) so the ripple stays nearer its corner and doesn't sweep the whole sheet
const CORNER_K = 15.0;         // radial wavenumber (ring spacing) — a couple of concentric rings
const CORNER_AMP = 0.85;       // ripple HEIGHT amplitude (world-Y) — HALVED (1.7→0.85): the corner ripple was heaving the whole cloth. Scaled by cfg.A.height AND the cCorner/wCorner strength control below.
const CORNER_TINT = 0.55;      // max colour-tint strength toward the attacking colour at the crest (softened 0.72→0.55 to match the weaker ripple)
const CORNER_FALLOFF = 4.2;    // amplitude ∝ 1/(1+FALLOFF·dist) — RAISED (2.2→4.2) so the ripple decays faster with distance → stays LOCAL to the corner instead of carrying across the sheet
// default corner strength (cfg.A.wCorner) — 1.0 = the (already reduced) CORNER_AMP above.
const CORNER_STRENGTH_DEFAULT = 1.0;
// SET-PIECE NEUTRALITY — the corner & penalty WAVES are a NEUTRAL "threat" pulse, NOT the
// taking team's colour (a set piece is a danger MOMENT, not owned territory). Only an
// actual GOAL floods a team colour. Both waves' crest tints toward this pitch-line white.
const SETPIECE_COL = new THREE.Color(0xf0f2f8);
// PENALTY WAVE — a neutral DIRECTIONAL pulse travelling from the penalty spot toward the
// attacked goal (authored in WALL seconds → scrub-safe). A SCORED penalty is a goal, so the
// team GOAL FLOOD fills the end; a MISSED/SAVED penalty shows ONLY this wave — no flood.
const PEN_WAVE_S = 1.7;   // total screen-time life of one penalty pulse (spot → goal → fade)

// Active corner ripples at clock t: the most-recent corner per SIDE (team) whose ripple
// is still alive (elapsed wall-seconds < CORNER_WAVE_S). Deterministic from the clock →
// scrub-safe. Returns [] when none active. Each entry carries the centre (u,v), the
// attacking `team`, the ring `radius` (grows with elapsed) and a 0..1 `env` envelope.
function cornerWavesAt(t) {
  if (!cornersByTime || !cornersByTime.length) return [];
  // newest corner ≤ t per team (home/away) — one live ripple per side at most.
  let latest = { home: null, away: null };
  for (let i = 0; i < cornersByTime.length; i++) {
    const c = cornersByTime[i];
    if (c.t <= t) latest[c.team] = c; else break;
  }
  const out = [];
  for (const team of ['home', 'away']) {
    const c = latest[team];
    if (!c) continue;
    const elapsed = wallSecondsSinceGoal(c.t, t);   // wall seconds since the corner (screen time)
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= CORNER_WAVE_S) continue;
    const f = elapsed / CORNER_WAVE_S;              // 0..1 life fraction
    // envelope: quick rise, long decay so the ripple appears crisply then fades out.
    const env = Math.sin(Math.PI * clamp(f, 0, 1)) ** 0.7;   // 0→1→0, front-loaded
    const radius = CORNER_SPEED * elapsed;          // ring radius in u-units, growing outward
    out.push({ u: c.u, v: c.v, team: c.team, radius, elapsed, env });
  }
  return out;
}

// ============================================================================
// PENALTIES — a penalty is a shot event with situation==='Penalty'. SCORED = isGoal
// (it also lands in goalsByTime → the team goal flood fills). MISSED/SAVED = not a goal
// → shows ONLY the neutral directional wave below. Spot (u,v) is already mirrored into
// the shared pitch frame (buildTimelineFromDoc): home attacks u→1, away attacks u→0.
// ============================================================================
let penaltiesByTime = [];   // {t, team, u, v, scored} — penalty spot, match-time order
function buildPenalties() {
  penaltiesByTime = [];
  if (!timeline) return;
  for (const e of timeline) {
    if (e.kind !== 'shot') continue;
    if (String(e.situation).toLowerCase() !== 'penalty') continue;
    if (e.team !== 'home' && e.team !== 'away') continue;
    penaltiesByTime.push({ t: e.t, team: e.team, u: e.u, v: e.v, scored: !!e.isGoal });
  }
  penaltiesByTime.sort((a, b) => a.t - b.t);
}
// Active penalty pulses at clock t — the newest penalty ≤ t per team still within its wall
// life. Each carries the spot (u,v), the attack `dir` (+1 home → goal at u=1, −1 away → u=0),
// life fraction `f` (0..1), an `env` envelope and `scored`. Deterministic from t → scrub-safe.
function penaltyWavesAt(t) {
  if (!penaltiesByTime || !penaltiesByTime.length) return [];
  let latest = { home: null, away: null };
  for (let i = 0; i < penaltiesByTime.length; i++) {
    const p = penaltiesByTime[i];
    if (p.t <= t) latest[p.team] = p; else break;
  }
  const out = [];
  for (const team of ['home', 'away']) {
    const p = latest[team];
    if (!p) continue;
    const elapsed = wallSecondsSinceGoal(p.t, t);
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= PEN_WAVE_S) continue;
    const f = elapsed / PEN_WAVE_S;
    const env = Math.sin(Math.PI * clamp(f, 0, 1)) ** 0.6;   // 0→1→0 envelope
    out.push({ u: p.u, v: p.v, team, dir: team === 'home' ? 1 : -1, f, env, scored: p.scored });
  }
  return out;
}

// ============================================================================
// POST-MATCH PENALTY SHOOTOUT — the DIRECTED end sequence. After the match settles, kicks
// are taken ONE AT A TIME (with a pause between): a neutral wave from the spot to the ONE
// goal (the far/"upper" end, u→1), then SCORED → the whole field FLOODS the kicker's colour;
// MISSED → no flood + a small recoil in the wave. Driven by the dedicated wall clock
// `shootWall` (the match clock is frozen at full time). Timing from cfg.shoot (adjustable).
// ============================================================================
const SHOOT_WAVE_S = 0.85;     // spot→goal wave duration per kick
const SHOOT_FLOOD_S = 1.25;    // flood dwell on a SCORED kick
const SHOOT_SPOT_U = 0.885;    // penalty spot (~12yd) — both teams kick at the u→1 goal
function shootTiming() {
  const s = (cfg && cfg.shoot) || {};
  return { pause0: clamp(Number(s.pause0) || 2.4, 0, 12), gap: clamp(Number(s.gap) || 1.7, 0.4, 8) };
}
// Current kick + phase from shootWall. {i, kick:{team,scored}|null, tIn (sec into kick), reveal}.
function shootoutSeq() {
  if (!shootoutOrder || !shootoutOrder.length) return null;
  const { pause0, gap } = shootTiming();
  const w = shootWall - pause0;
  if (w < 0) return { i: -1, kick: null, tIn: 0, reveal: 0 };
  const i = Math.min(Math.floor(w / gap), shootoutOrder.length - 1);
  const tIn = w - i * gap;
  let reveal = 0;                                   // a dot appears once its wave has hit the goal
  for (let k = 0; k < shootoutOrder.length; k++) if (w - k * gap >= SHOOT_WAVE_S * 0.55) reveal++;
  return { i, kick: shootoutOrder[i], tIn, reveal: Math.min(reveal, shootoutOrder.length) };
}
// FLOOD override for a SCORED kick — same {team, front, cover} shape as goalWaveAt, so the
// front-blend fills the WHOLE field the kicker's colour. Null on a miss / between kicks.
function shootoutWaveAt() {
  const seq = shootoutSeq(); if (!seq) return null;
  const n = shootoutOrder.length;
  const { pause0, gap } = shootTiming();
  // FINALE — once the last kick has fully resolved, HOLD the WINNER's colour flooded.
  const lastEnd = pause0 + (n - 1) * gap + SHOOT_WAVE_S * 0.5 + SHOOT_FLOOD_S + 0.9;
  if (shootWall >= lastEnd) {
    const hs = shootoutOrder.filter((k) => k.team === 'home' && k.scored).length;
    const as = shootoutOrder.filter((k) => k.team === 'away' && k.scored).length;
    const win = hs >= as ? 'home' : 'away';
    return { team: win, front: win === 'home' ? 1 : 0, cover: 1 };
  }
  if (!seq.kick || !seq.kick.scored) return null;   // between kicks / a miss → no flood
  const roll = SHOOT_WAVE_S, flood = SHOOT_FLOOD_S, reset = 0.9;
  const s = seq.tIn - roll * 0.5;                   // flood starts as the wave reaches goal
  if (s < 0 || s >= flood + reset) return null;
  const endE = seq.kick.team === 'home' ? 1.0 : 0.0;
  let cover;
  if (s < roll * 0.5) cover = s / (roll * 0.5);
  else if (s < flood) cover = 1;
  else { const f = (s - flood) / reset; cover = 1 - f * f * (3 - 2 * f); }
  return { team: seq.kick.team, front: endE, cover: clamp(cover, 0, 1) };
}
// NEUTRAL wave (spot→goal) for the CURRENT kick — added to penWaves (SETPIECE_COL channel).
// A missed kick gets a small recoil/damp near the end. Both teams kick at the u→1 goal.
function shootoutPenPulse() {
  const seq = shootoutSeq(); if (!seq || !seq.kick || seq.tIn < 0 || seq.tIn >= SHOOT_WAVE_S) return null;
  const f = clamp(seq.tIn / SHOOT_WAVE_S, 0, 1);
  let env = Math.sin(Math.PI * f) ** 0.6;
  if (!seq.kick.scored) env *= (1 - 0.4 * smoothstep(0.55, 1, f));   // recoil/gашение on a miss
  // teams kick at OPPOSITE goals: home → the u→1 goal (spot 0.885, dir +1); away → the u→0
  // goal (spot 0.115, dir −1). The wave rolls from the spot toward that goal.
  const home = seq.kick.team === 'home';
  return { u: home ? SHOOT_SPOT_U : 1 - SHOOT_SPOT_U, v: 0.5, team: seq.kick.team, dir: home ? 1 : -1, f, env, scored: seq.kick.scored };
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
  // SKY — no-op in stage-thumb (sky/backdrop/fog removed for the transparent render).
  updateSky(t, dt);
  const aOn = cfg.A.on;
  // STAGE-THUMB — build the STATIC essence field (cumulative xG + avg-possession front)
  // instead of the live time-windowed computeA. The rest of computeField (vertex loop,
  // clay material, seam lip, pitch-line weave) runs unchanged over these buffers.
  if (aOn) essenceComputeA();

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
  const wave2 = goalWaveAt(t) || (shootActive ? shootoutWaveAt() : null);
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
  // ESSENCE OVERRIDE — this is a STATIC, cumulative WHOLE-MATCH portrait (essenceComputeA
  // sums every event, t-independent). The stage13 melts are WRONG here: the end-of-match
  // SETTLE (settle→1 after the final whistle) and the post-goal LULL both flatten the
  // relief, and since the essence auto-plays then settles, the held frame we capture was
  // rendering the FLATTENED end state — «всё плоское, где холмы?». Force NO melt so the
  // terrain (activity mounds + goal/xG crests) always stands at full height, at any frame.
  const settleEase = 0;              // never settle the essence toward the flat final-whistle state
  const reliefMul = 1;               // no lull/settle flatten — cumulative relief always full

  // CORNER WAVES — active ripples this frame (most-recent corner per side, deterministic
  // from the clock → scrub-safe). Each ripples OUTWARD from its pitch corner (cu,cv) in
  // the attacking team's colour. Precompute here so the vertex loop just evaluates the
  // radial ripple per cell. Distances use the pitch ASPECT (WORLD_X:WORLD_Z) so rings are
  // circular in world space, not stretched in u,v. The dominant attacking colour drives
  // uCornerCol on both sheets (corners of the two sides essentially never overlap in the
  // ~2.4s wall window; if they do, each cell still takes its strongest ripple's height/tint).
  // УГЛОВЫЕ on/off — corners only exist when Layer A is on AND the corner toggle is on
  // (old cfgs without cCorner default to on via DEFAULTS). When off: no ripple, no tint.
  const cornersOn = cfg.A.on && (cfg.A.cCorner !== false);
  const cornerWaves = cornersOn ? cornerWavesAt(t) : [];
  const penWaves = aOn ? penaltyWavesAt(t) : [];    // penalty pulses always show when Layer A is on
  if (aOn && shootActive) { const sp = shootoutPenPulse(); if (sp) penWaves.push(sp); }   // shootout kick wave
  const cwAspect = WORLD_Z / WORLD_X;                 // v-distance weight so rings are round
  let cornerColHome = false;                          // whether the dominant live corner is home's
  if (cornerWaves.length) {
    // pick the freshest (smallest elapsed) as the dominant colour source.
    let best = cornerWaves[0];
    for (const w of cornerWaves) if (w.elapsed < best.elapsed) best = w;
    cornerColHome = best.team === 'home';
  }
  // amplitude of the ripple height, scaled by the A.height slider (falls to 0 with amp)
  // AND by the corner STRENGTH control (cfg.A.wCorner, 0..~2; default = the reduced 1.0).
  const cwStrength = Number.isFinite(cfg.A.wCorner) ? clamp(cfg.A.wCorner, 0, 3) : CORNER_STRENGTH_DEFAULT;
  const cwAmp = CORNER_AMP * cwStrength * clamp(cfg.A.height, 0, 8) / 3.0;
  // penalty pulse height — tied to the A.height slider but INDEPENDENT of the corner
  // strength control (a penalty shows regardless of the corner toggle/strength).
  const penAmp = CORNER_AMP * clamp(cfg.A.height, 0, 8) / 3.0;

  // normalisation for the two A height grids (shared so relative team height is
  // honest). Read the SMOOTHED grids — that's what we render — so the normaliser
  // tracks the eased fields and doesn't itself jump frame-to-frame.
  let aMax = 1e-4;
  if (aOn) {
    for (let k = 0; k < A_shH.length; k++) { if (A_shH[k] > aMax) aMax = A_shH[k]; if (A_shA[k] > aMax) aMax = A_shA[k]; }
  }

  const bH = blankets.home, bA = blankets.away;
  // CORNER-WAVE tint textures — cleared each frame; the loop writes the ripple crest tint
  // (0..1) into BOTH sheets so whichever laps on top shows the travelling attacking-colour band.
  bH.cData.fill(0); bA.cData.fill(0);
  let idx = 0;
  for (let j = 0; j < VY; j++) {
    const v = j / (VY - 1);
    for (let i = 0; i < VX; i++, idx++) {
      const u = i / (VX - 1);
      const wob = Math.sin(u * 6.1 + ph) * Math.cos(v * 5.3 - ph * 0.8)
                + 0.5 * Math.sin((u + v) * 9.7 - ph * 1.3);
      // ---- CORNER WAVE ripple at this cell (radial travelling rings from each corner) --
      let cwH = 0, cwTint = 0;
      if (cornerWaves.length) {
        for (const w of cornerWaves) {
          const du = (u - w.u);
          const dv = (v - w.v) * cwAspect;            // aspect-correct so rings are round
          const dist = Math.sqrt(du * du + dv * dv);
          // radial travelling ripple: sin(k·(dist − radius)) · envelope(age) · falloff(dist).
          // Rings expand OUTWARD (radius grows with elapsed). A leading-edge gate keeps the
          // ripple to a growing disc (nothing ahead of the wavefront), so it reads as a
          // wave emanating FROM the corner, not a full-field standing pattern.
          const lead = smoothstep(w.radius + 0.16, w.radius, dist);   // 1 inside front → 0 ahead
          if (lead <= 0.001) continue;
          const falloff = 1 / (1 + CORNER_FALLOFF * dist);   // amplitude decays with distance from corner
          const ripple = Math.sin(CORNER_K * (dist - w.radius));
          const a = ripple * w.env * lead * falloff;
          cwH += a * cwAmp;
          // tint follows the ripple CREST (positive lobes) so the colour band rides the wave.
          const crest = clamp(a, 0, 1);
          if (crest > cwTint) cwTint = crest;
        }
        // tint scales with the corner STRENGTH control too, so wCorner=0 → no tint at all
        // and lower strength softens the colour band along with the (already gentler) ripple.
        cwTint = clamp(cwTint * CORNER_TINT * clamp(cwStrength, 0, 1.5), 0, 1);
      }
      // ---- PENALTY WAVE: a NEUTRAL directional pulse from the spot toward the attacked
      // goal. A moving crest band advances spot→goal over the pulse life, in a central cone.
      // Writes into the SAME neutral crest channel as corners (SETPIECE_COL). SCORED penalties
      // also get the team goal flood; MISSED ones show only this wave. ----
      if (penWaves.length) {
        let penCrest = 0;
        for (const w of penWaves) {
          const s = (u - w.u) * w.dir;                 // signed distance toward goal (>0 = ahead of spot)
          const dv = (v - w.v) * cwAspect;             // lateral offset (penalty is central)
          const goalDist = (w.dir > 0 ? (1 - w.u) : w.u) + 0.03;
          const front = clamp(w.f, 0, 1) * goalDist;   // wavefront advances spot → goal over the life
          const along = Math.exp(-((s - front) * (s - front)) / (2 * 0.055 * 0.055));  // moving crest band
          const gate = smoothstep(-0.03, 0.02, s);     // nothing behind the spot
          const lat = Math.exp(-(dv * dv) / (2 * 0.11 * 0.11));   // central cone toward goal
          const a = along * gate * lat * w.env;
          cwH += a * penAmp * 0.85;
          if (a > penCrest) penCrest = a;
        }
        penCrest = clamp(penCrest * CORNER_TINT * 1.5, 0, 1);   // neutral crest, a touch brighter than corners
        if (penCrest > cwTint) cwTint = penCrest;
      }

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
        let front = sampleGrid(A_sown, A_gx, A_gy, u, v);   // front-u for this cell
        // END-OF-MATCH SETTLE — the territory front eases toward the halfway line (50/50,
        // a calm resolved split) as the match resolves, so neither side is heaving at the
        // final held frame. Purely visual settling of the boundary; snapped off on restart.
        if (settleEase > 0 && !shootActive) front = lerp(front, 0.5, 0.85 * settleEase);
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
        // STAGE13 — a tall xG spire sitting EXACTLY on the possession seam tore the two
        // sheets apart (visible black holes flanking it), because the tiny lap can't bridge
        // a steep crest there. Damp the crest much harder right at the seam (floor 0.22 vs
        // 0.6) so no tall spike stands on the boundary; away from the seam (notch→1) the
        // spire still rises to full height. This closes the holes without touching lap.
        const crestNotch = 0.22 + 0.78 * notch;
        // AMPLITUDE CEILING — a high-xG crest (or two overlapping shots that stack) could
        // otherwise tower absurdly into a monstrous spire (the user's "what IS this?" spike).
        // Lowered 8 → 4.5 so a shot still reads as a clear RISE but never a monster.
        let reliefH = (rH * 0.5 * amp * moundMask * notch + xH * crestK * fmCrest * crestNotch) * reliefMul;
        let reliefA = (rA * 0.5 * amp * moundMask * notch + xA * crestK * fmCrest * crestNotch) * reliefMul;
        reliefH = Math.min(reliefH, 9.5); reliefA = Math.min(reliefA, 9.5);   // ESSENCE: raised cap so goals tower + activity height differentiates (was 4.5 → everything flat-capped)
        // PER-TEAM RELIEF — each blanket carries its OWN (notched-at-seam) height, so
        // the two sheets are TWO DISTINCT surfaces; the visible LAP is the TOP sheet's
        // short lip fold (vertex shader), never a merged plane.
        // END-OF-MATCH SETTLE also quiets the tiny cloth wobble so the held final frame
        // is truly still (motion damps), not gently breathing forever.
        const wobMul = A_WOBBLE * (1 - 0.95 * settleEase);
        hH = A_BASE + wobMul * wob + reliefH;
        hA = A_BASE + wobMul * wob + reliefA;
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
      // CORNER WAVE — add the radial ripple to BOTH sheets' height (a transient surface
      // ripple, added AFTER the seam clamp so it isn't flattened), and write the crest
      // tint into both sheets' cData so whichever laps on top shows the travelling band.
      if (cwH !== 0 || cwTint > 0) {
        hH += cwH; hA += cwH;
        bH.cData[idx] = cwTint; bA.cData[idx] = cwTint;
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
  // CORNER WAVE — colour to blend the ripple crest toward = the dominant live corner's
  // ATTACKING team colour (same on both sheets so the top sheet shows it wherever it laps).
  // NEUTRAL set-piece crest — corners AND penalties tint toward pitch-line white, never the
  // taking team's colour (a set piece is a THREAT, not owned territory; only a goal floods a
  // colour). Same uniform for both since they share the crest channel.
  const cwCol = SETPIECE_COL;
  bH.u.uCornerCol.value.copy(cwCol); bA.u.uCornerCol.value.copy(cwCol);
  bH.cTex.needsUpdate = true; bA.cTex.needsUpdate = true;
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
  gradePass.uniforms.uVig.value = 1.28; gradePass.uniforms.uExpo.value = 1.72;   // vignette restored (user liked it) — the "obvious circle" is tamed via the low sky tint instead
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
const TAU_FRONT = 0.09;   // possession-tide boundary per channel — LOWERED so the momentum backbone's end-to-end swing isn't damped toward centre (the backbone is smooth per-minute, so jitter stays low even here). was 0.7 for CHANGE #2: the CHANGE #1 momentum backbone + BALL_GAIN sharpen the per-channel front, so a slightly heavier temporal low-pass removes the re-introduced per-frame jitter. The big END-TO-END swing is driven by the momentum backbone (per-minute cadence), which glides regardless of this τ, so the front stays SMOOTH yet still swings with full amplitude (not frozen).
const TAU_THRUST = 0.09;  // final low-pass on the COMBINED/displayed front (base+fingers) — kills the per-frame seam trembling from stepping finger weights; raised 0.22→0.28 to finish off the residual seam shimmer (seam-delta dropped ~45% busy, ~35-55% counter) while a counter still reaches ~66% of its depth within ~0.3s (still a quick stab)
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
  // ORTHOGRAPHIC — resize the frustum from the stage client box aspect (keeps the pitch
  // framed + un-stretched at any column size), preserving the current OrbitControls zoom.
  if (camera.isOrthographicCamera) setOrthoFrustum(w / h);
  else { camera.aspect = w / h; camera.updateProjectionMatrix(); }
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
// STAGE13 — the bottom timeline button (#play13) is the ONLY play/pause control now. Keep
// its SVG glyph in sync with `playing` (and the hidden #play's text), for every state change
// incl. the auto-stop at the final whistle. Synced once per frame in loop() on change.
const _PLAY_SVG  = '<svg width="16" height="18" viewBox="0 0 16 18" aria-hidden="true"><path d="M1 1 L15 9 L1 17 Z" fill="none" stroke="#e9e7f4" stroke-width="1.4" stroke-linejoin="round"/></svg>';
const _PAUSE_SVG = '<svg width="16" height="18" viewBox="0 0 16 18" aria-hidden="true"><rect x="2.5" y="1.5" width="3.6" height="15" fill="none" stroke="#e9e7f4" stroke-width="1.4"/><rect x="9.9" y="1.5" width="3.6" height="15" fill="none" stroke="#e9e7f4" stroke-width="1.4"/></svg>';
function setPlayGlyph(isPlaying) {
  const pb = el('play'); if (pb) pb.textContent = isPlaying ? '❚❚' : '▶';
  const p13 = el('play13'); if (p13) p13.innerHTML = isPlaying ? _PAUSE_SVG : _PLAY_SVG;
}
let _glyphState = null;
let lastNow = performance.now();
function loop(now) {
  const dt = Math.min(0.1, Math.max(0, (now - lastNow) / 1000));
  lastNow = now;
  if (playing !== _glyphState) { setPlayGlyph(playing); _glyphState = playing; }
  if (playing) {
    // cfg.speed (default 0.9) scales the pass duration: effective total =
    // DRAMA_TOTAL_S / cfg.speed. 1.0× ⇒ ~15s; leaving the slider as a global
    // tempo trim. dt is real wall seconds.
    const spd = Math.max(0.05, Number(cfg.speed) || 1);
    if (settling) {
      // STAGE11 CHANGE #3 — the match is over. Hold the clock at the final whistle and ease
      // the surface to a calm resolved state over ~SETTLE_S. When settled, STOP (no loop).
      clock = teamMeta.duration;
      settle = clamp(settle + dt / SETTLE_S, 0, 1);
      if (settle >= 1) {
        settling = false; playing = false;
        setPlayGlyph(false); _glyphState = false;
        // MATCH OVER — if it went to penalties, begin the DIRECTED shootout sequence.
        if (shootoutOrder && shootoutOrder.length && !shootActive) { shootActive = true; shootWall = 0; }
      }
    } else {
      wallProgress += (dt / DRAMA_TOTAL_S) * spd;
      if (wallProgress >= 1) {
        // FINAL WHISTLE — do NOT loop. Pin to the end and begin the calm settle.
        wallProgress = 1; clock = matchT(1);
        settling = true; settle = 0;
      } else {
        clock = matchT(wallProgress);
      }
    }
  }
  // advance the post-match shootout choreography (runs while playback is stopped, driven by
  // its own wall clock; the match clock stays frozen at full time).
  if (shootActive) { shootWall += dt; const sq = shootoutSeq(); shootoutRevealed = sq ? sq.reveal : 0; }
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
  resetSettle();
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
// dev hook — jump straight into the post-match SHOOTOUT at wall-second `w` and render one
// frame (so the directed sequence can be inspected without waiting out full playback).
window.__shoot = (w) => {
  settling = false; playing = false; settle = 1; clock = teamMeta.duration;
  shootActive = !!(shootoutOrder && shootoutOrder.length);
  shootWall = Math.max(0, +w || 0);
  const sq = shootoutSeq(); shootoutRevealed = sq ? sq.reveal : 0;
  snapASmoothing();
  renderFrame(clock, 1 / 60); controls.update(); composer.render();
  updateHud(); drawOverlays(clock);
  return sq ? { i: sq.i, kick: sq.kick, tIn: +sq.tIn.toFixed(2), reveal: sq.reveal } : null;
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
// STAGE11 CHANGE #3 dev/verify hook — force the END-OF-MATCH settled state (clock at the
// final whistle, settle=amount 0..1, playback stopped) and render one snapped frame, so
// the calm resolved final frame can be captured deterministically. amount defaults to 1.
window.__endSettle = (amount) => {
  const a = Number.isFinite(+amount) ? clamp(+amount, 0, 1) : 1;
  clock = teamMeta.duration;
  wallProgress = 1;
  settle = a; settling = false; playing = false;
  const pb = el('play'); if (pb) pb.textContent = '▶';
  _dramaCursor = 0; _ballCursor = 0; snapASmoothing();
  renderFrame(clock);
  controls.update();
  composer.render();
  updateHud();
  updateCamReadout();
  drawOverlays(clock);
};
window.__step = (min, dt) => {
  resetSettle();
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
let cardEvents = [];   // {t, minute, team, red} — drawn as CARDS in the markers panel (drawMarkers)
// STAGE11 CHANGE #5/#6 — persistent goal-token list (built in buildGoalMarkers) +
// real per-minute momentum (fetched in init) for the pulse strip.
let goalMarkers = [];  // {t, minute, team, pen} in match-time order, for the markers row
let shotMarks = [];    // {minute, team, xg, isGoal} — xG/shot markers on the momentum pulse
let momentum = [];     // [{minute, v}] valueNorm +home/−away, real data (rich record)
function countGoals() {
  goalsByTime = timeline.filter((it) => it.kind === 'shot' && it.isGoal).map((g) => ({ t: g.t, team: g.team }));
  // xG/shot markers for the pulse: every real shot (skip near-zero-xG noise; always keep goals).
  shotMarks = timeline
    .filter((it) => it.kind === 'shot')
    .map((s) => ({ minute: Number(s.minute) || 0, team: s.team, xg: Number(s.xg) || 0, isGoal: !!s.isGoal }))
    .filter((s) => s.xg >= 0.03 || s.isGoal);
  teamMeta.score = { home: goalsByTime.filter((g) => g.team === 'home').length, away: goalsByTime.filter((g) => g.team === 'away').length };
  buildCorners();   // CORNER WAVES — source list of corners taken (t, team, snapped pitch-corner u,v)
  buildPenalties(); // PENALTY WAVES — neutral directional pulse from the spot toward goal (scored→flood, missed→wave only)
  // CARD events for the sky flash. The harvest only emits a generic 'Card' type (no
  // yellow/red qualifier), so `red` is inferred from any explicit red-ish type/outcome
  // if one ever appears; otherwise a card flashes yellow. See report.
  cardEvents = timeline
    .filter((it) => /Card/.test(it.type || '') || it.type === 'RedCard' || it.type === 'YellowCard' || it.type === 'SecondYellow')
    .map((c) => ({ t: c.t, minute: c.minute || Math.floor(c.t), team: c.team, red: /Red|Second/.test(c.type || '') }))
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
    if (goalLanded(g.t, t)) { if (g.team === 'away') a++; else h++; }
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
// FOOTBALL MINUTE for the on-screen clock. The engine clock `t` is EXPANDED minutes
// (continuous incl. all stoppage → runs to ~137' on an ET match). Broadcasts show FOOTBALL
// minutes: the 2nd half tops out at 90 (+stoppage → 96), then extra time RESTARTS the count
// at 90 → 105 → 120. The timeline events carry BOTH (t = expanded, minute = football), so we
// map the current clock to the nearest event's football minute. (The engine still runs on the
// expanded clock — only the DISPLAY changes; period LABEL still uses the monotonic expanded t.)
let _fmTable = null;
function buildFootballMinuteTable() {
  _fmTable = (timeline || [])
    .filter((e) => Number.isFinite(e.t) && Number.isFinite(e.minute))
    .map((e) => ({ t: e.t, m: e.minute }))
    .sort((a, b) => a.t - b.t);
}
function footballMinuteAt(t) {
  if (!_fmTable || !_fmTable.length) return Math.floor(t);
  let lo = 0, hi = _fmTable.length - 1, ans = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (_fmTable[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  const a = _fmTable[ans], b = _fmTable[Math.min(ans + 1, _fmTable.length - 1)];
  // interpolate WITHIN a period; never across the ET boundary (where football minute drops).
  if (b.t > a.t && b.m >= a.m) return Math.floor(a.m + (b.m - a.m) * clamp((t - a.t) / (b.t - a.t), 0, 1));
  return Math.floor(a.m);
}
function updateHud() {
  const t = clock;
  // Drive the HUD score from the SAME goal-time trigger as the flood (scoreAt uses the
  // identical g.t ≤ t test on the same clock), so score + colour flood change together.
  const sc = scoreAt(t);
  const gH = sc.home, gA = sc.away;
  el('hScore').textContent = gH; el('aScore').textContent = gA;
  const mm = Math.floor(t);
  // STAGE13 — the playbar readout keeps the apostrophe (#clk); the top-right clock
  // numeral (#clk2) is the number ONLY (its trailing "'" is a static <em> in the DOM).
  const clkEl = el('clk'); if (clkEl) clkEl.textContent = mm + "'";
  // TOP-RIGHT clock shows the FOOTBALL minute (2nd half → 90/96, ET restarts 90→120), NOT the
  // raw expanded minute; the period LABEL below still keys off the monotonic expanded `mm`.
  const clk2El = el('clk2'); if (clk2El) clk2El.textContent = String(footballMinuteAt(t));
  // STAGE13 — half sub-label (vB2 "2ND HALF" style). Simple minute split; NO "LIVE".
  const halfEl = el('clkHalf');
  if (halfEl) {
    const dur = teamMeta.duration || 90;
    const isET = dur >= 100;   // match went to extra time (expanded-minute duration ≳ 2×ET)
    let lab;
    if (isET) {
      lab = mm >= dur - 1 ? 'Full Time' : mm >= 98 ? 'Extra Time' : mm >= 48 ? '2nd Half' : '1st Half';
    } else {
      lab = mm >= dur - 1 ? 'Full Time' : mm >= 45 ? '2nd Half' : '1st Half';
    }
    halfEl.textContent = lab;
  }
  // STAGE13 — per-team event rows (goals / red / shootout) from live data.
  updateEventBlocks(t);
  // the scrubber tracks WALL-PROGRESS through the 15s dramatic pass (not linear
  // match-minutes), so its position matches how long each moment holds on screen.
  if (document.activeElement !== el('clock')) el('clock').value = String(wallProgress * 100);
}

// ============================================================================
// STAGE13 — per-team EVENT BLOCKS under each score. NO word labels; the marker
// shape carries the meaning (disc = goal, upright rect = red card, ring = shootout
// kick). Rebuilt each frame from the LIVE data so goals/reds appear as the clock
// passes them (respecting the event-lag via goalLanded), exactly like the score.
//   · GOALS  — goalMarkers filtered by team, only those that have LANDED (goalLanded).
//   · RED    — cardEvents filtered to c.red && c.t <= clock (yellows are NEVER shown).
//   · PENS   — a penalty SHOOTOUT row (rings). There is NO shootout data source yet;
//              `penaltyShootout` is intentionally absent, so this row renders NOTHING
//              for current matches. When a real source lands (shape below), it lights up.
// ============================================================================
// SHOOTOUT DATA (design-ready, currently absent): expected shape when it exists —
//   penaltyShootout = { home: [true,false,...], away: [true,...] }  (true = scored)
// No mock data is fabricated; `penaltyShootout` stays undefined until a real source
// is wired in init(), so shootoutFor() returns [] and the .shoot row stays empty.
let penaltyShootout = undefined;   // { home:boolean[], away:boolean[] } | undefined
function shootoutFor(team) {
  if (!penaltyShootout) return [];
  const arr = penaltyShootout[team];
  return Array.isArray(arr) ? arr : [];
}
let _evSig = { home: '', away: '' };   // last-rendered signature per team (skip needless DOM writes)
function eventsMarkupFor(team, t) {
  // GOALS — one disc-row per goal that has landed for this team (chronological).
  const goals = (goalMarkers || [])
    .filter((g) => g.team === team && goalLanded(g.t, t))
    .sort((a, b) => a.t - b.t);
  // RED cards — red only, already occurred (yellows excluded by the c.red filter).
  const reds = (cardEvents || [])
    .filter((c) => c.red && c.t <= t && c.team === team)
    .sort((a, b) => a.t - b.t);
  // PEN shootout — revealed ONE KICK AT A TIME during the directed post-match sequence
  // (shootoutRevealed grows as each kick's wave hits the goal), so it reads as the finale.
  let pens = [];
  if (shootActive && shootoutOrder) {
    let cnt = 0;
    for (const k of shootoutOrder) { if (cnt >= shootoutRevealed) break; if (k.team === team) pens.push(k.scored); cnt++; }
  }

  let html = '';
  for (const g of goals) {
    html += `<div class="ev"><span class="v"><span class="mk goal"></span>${g.minute}'</span></div>`;
  }
  for (const c of reds) {
    html += `<div class="ev"><span class="v"><span class="mk red"></span>${c.minute}'</span></div>`;
  }
  if (pens.length) {
    let ring = '';
    for (const scored of pens) ring += `<span class="pk ${scored ? 'scored' : 'miss'}"></span>`;
    html += `<div class="ev shoot">${ring}</div>`;
  }
  return html;
}
function updateEventBlocks(t) {
  const hE = el('hEvents'), aE = el('aEvents');
  if (hE) {
    const m = eventsMarkupFor('home', t);
    if (m !== _evSig.home) { hE.innerHTML = m; _evSig.home = m; }
  }
  if (aE) {
    const m = eventsMarkupFor('away', t);
    if (m !== _evSig.away) { aE.innerHTML = m; _evSig.away = m; }
  }
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

// ---- STAGE13 — OLD top goal-token row DISABLED ------------------------------
// Goals + red cards now render UNDER the teams (updateEventBlocks). This function
// is a NO-OP in stage13 so there are no duplicate goal indicators; the #markers
// canvas is also hidden via CSS. Kept as a stub so drawOverlays()/loop() are
// unchanged. The original stage12 body is retained below (dead) for reference.
function drawMarkers(t) {
  return;   // STAGE13: disabled — goals/reds live in the per-team event blocks now.
  // eslint-disable-next-line no-unreachable
  if (!mkCtx) return;
  const dpr = _ovDpr;
  const W = mkCanvas.width, H = mkCanvas.height;
  mkCtx.clearRect(0, 0, W, H);
  // token geometry (in CSS px, scaled by dpr).
  const r = 13.5 * dpr;               // token radius (holds the minute inside)
  const gap = 34 * dpr;               // centre-to-centre spacing
  const edge = 26 * dpr;              // inset from the LEFT edge
  // adjustable HEIGHT above the pitch: slider 0 (near the field/bottom of this strip)
  // → 1 (top). The strip is pinned to the top of the screen; higher slider = higher up.
  const mh = clamp(Number.isFinite(cfg.A.markerH) ? cfg.A.markerH : 0.55, 0, 1);
  const cy = H - (0.18 + 0.62 * mh) * H;   // vertical centre of the row
  // ALL goals (already scored by clock t), CHRONOLOGICAL, accumulate FROM THE LEFT edge
  // rightward — each next goal to the RIGHT of the previous. The scoring MINUTE is drawn
  // INSIDE the token. (goalMarkers is kept in match-time order.)
  const list = [];
  for (const g of goalMarkers) { if (goalLanded(g.t, t)) list.push(g); }
  for (let i = 0; i < list.length; i++) {
    const g = list[i];
    const cx = edge + r + i * gap;
    const col = g.team === 'home' ? FRA_HEX : SEN_HEX;
    // soft glow underlay
    mkCtx.beginPath(); mkCtx.arc(cx, cy, r * 1.7, 0, Math.PI * 2);
    mkCtx.fillStyle = hexA(col, 0.16); mkCtx.fill();
    // token
    mkCtx.beginPath(); mkCtx.arc(cx, cy, r, 0, Math.PI * 2);
    mkCtx.fillStyle = col; mkCtx.fill();
    mkCtx.lineWidth = 1.5 * dpr; mkCtx.strokeStyle = 'rgba(4,5,10,0.9)'; mkCtx.stroke();
    // scoring MINUTE drawn INSIDE the token
    mkCtx.fillStyle = 'rgba(255,255,255,0.96)';
    mkCtx.font = `600 ${9.5 * dpr}px Barlow, sans-serif`;
    mkCtx.textAlign = 'center'; mkCtx.textBaseline = 'middle';
    mkCtx.fillText(g.minute + "'", cx, cy + 0.5 * dpr);
  }
  // ---- CARDS — their own little cluster in the SAME strip, accumulating FROM THE RIGHT
  // edge leftward (mirror of the goal circles). Each is a small rounded-rect CARD (yellow,
  // or red for a sending-off) with a thin team-colour bar along its bottom and the booking
  // MINUTE to its left — instantly readable as a football card, distinct from a goal. ----
  const cw = 15 * dpr, ch = 21 * dpr;    // card face size
  const cgap = 42 * dpr;                  // slot spacing (card + minute)
  const rEdge = 26 * dpr;                 // inset from the RIGHT edge
  const rr = 2.5 * dpr;                   // card corner radius
  const rrectMk = (x, y, w, h, rad) => {
    mkCtx.beginPath();
    mkCtx.moveTo(x + rad, y); mkCtx.arcTo(x + w, y, x + w, y + h, rad); mkCtx.arcTo(x + w, y + h, x, y + h, rad);
    mkCtx.arcTo(x, y + h, x, y, rad); mkCtx.arcTo(x, y, x + w, y, rad); mkCtx.closePath();
  };
  const clist = [];
  for (const c of cardEvents) { if (c.t <= t) clist.push(c); }
  for (let i = 0; i < clist.length; i++) {
    const c = clist[i];
    const ccx = W - rEdge - cw / 2 - i * cgap;   // oldest at the right edge, newer to the left
    const cx0 = ccx - cw / 2, cy0 = cy - ch / 2;
    const face = c.red ? '#e5484d' : '#ffd24a';  // red card vs yellow (harvest is yellow unless a red-ish type appears)
    // soft glow underlay
    mkCtx.beginPath(); mkCtx.ellipse(ccx, cy, cw * 1.05, ch * 0.85, 0, 0, Math.PI * 2);
    mkCtx.fillStyle = hexA(face, 0.16); mkCtx.fill();
    // card face
    rrectMk(cx0, cy0, cw, ch, rr);
    mkCtx.fillStyle = face; mkCtx.fill();
    mkCtx.lineWidth = 1.3 * dpr; mkCtx.strokeStyle = 'rgba(4,5,10,0.85)'; mkCtx.stroke();
    // team-colour bar along the bottom of the card (who was booked)
    const barCol = c.team === 'home' ? FRA_HEX : SEN_HEX;
    mkCtx.fillStyle = barCol;
    mkCtx.fillRect(cx0 + 1.5 * dpr, cy0 + ch - 4 * dpr, cw - 3 * dpr, 3 * dpr);
    // booking MINUTE to the LEFT of the card, on the row line
    mkCtx.fillStyle = 'rgba(240,242,248,0.92)';
    mkCtx.font = `600 ${9.5 * dpr}px Barlow, sans-serif`;
    mkCtx.textAlign = 'right'; mkCtx.textBaseline = 'middle';
    mkCtx.fillText(c.minute + "'", cx0 - 5 * dpr, cy + 0.5 * dpr);
  }
}

// ---- STAGE13 — clean off-white seismograph (vB2 look) -----------------------
// A single centred waveform whose amplitude is the real per-minute momentum
// (|v| ∈ 0..1), NOT split into home/away fills — matching vB2's Direction-A pulse.
// The played portion (up to the playhead at the current clock) is bright off-white;
// the unplayed remainder is dim. TRANSPARENT background — no plate, no oscilloscope
// graticule/axis-cap. A subtle playhead cursor sits at the clock position.
function drawPulse(t) {
  if (!plCtx) return;
  const dpr = _ovDpr;
  const W = plCanvas.width, H = plCanvas.height;
  plCtx.clearRect(0, 0, W, H);           // transparent — no plate/background fill
  const padX = 6 * dpr, padY = 8 * dpr;
  const x0 = padX, x1 = W - padX, innerW = Math.max(1, x1 - x0);
  const mid = H * 0.5;                    // CLEAR centre line (halfway)
  const ribH = (mid - padY) * 0.98;      // vertical half-amplitude
  const dur = pulseDuration();
  const xOf = (min) => x0 + clamp(min / dur, 0, 1) * innerW;
  const yOf = (v) => mid - clamp(v, -1, 1) * ribH;
  // PLAYHEAD synced to the DISPLAYED (football) minute — the pulse must not run ahead of the
  // clock. nowMin also gates everything so the pulse DRAWS AS THE MATCH RUNS (no faint preview
  // of the future — that would spoil the intrigue).
  const nowMin = clamp(footballMinuteAt(t), 0, dur);
  const px = xOf(nowMin);
  const hasMom = momentum && momentum.length >= 2;

  // CENTRE LINE — only up to the playhead (grows with the match).
  plCtx.strokeStyle = 'rgba(233,231,244,0.5)'; plCtx.lineWidth = 1.3 * dpr;
  plCtx.beginPath(); plCtx.moveTo(x0, mid); plCtx.lineTo(px, mid); plCtx.stroke();

  // MOMENTUM — home pressure ABOVE the midline (home colour), away BELOW (away colour), plus a
  // crisp trace. Everything CLIPPED to x ≤ playhead so only the PLAYED part is ever drawn.
  if (hasMom) {
    plCtx.save(); plCtx.beginPath(); plCtx.rect(0, 0, Math.max(px, x0), H); plCtx.clip();
    const fillArea = (pick, col) => {
      plCtx.beginPath();
      plCtx.moveTo(xOf(momentum[0].minute), mid);
      for (const d of momentum) plCtx.lineTo(xOf(d.minute), mid - pick(d.v) * ribH);
      plCtx.lineTo(xOf(momentum[momentum.length - 1].minute), mid);
      plCtx.closePath(); plCtx.fillStyle = hexA(col, 0.5); plCtx.fill();
    };
    fillArea((v) => Math.max(0, v), FRA_HEX);
    fillArea((v) => Math.min(0, v), SEN_HEX);
    const pts = momentum.map((d) => ({ x: xOf(d.minute), y: yOf(d.v) }));
    plCtx.lineJoin = 'round'; plCtx.lineCap = 'round';
    plCtx.strokeStyle = 'rgba(233,231,244,0.85)'; plCtx.lineWidth = 1.6 * dpr;
    plCtx.beginPath(); pts.forEach((p, i) => (i ? plCtx.lineTo(p.x, p.y) : plCtx.moveTo(p.x, p.y)));
    plCtx.stroke();
    plCtx.restore();
  }

  // PERIOD markers — reveal ONLY once reached (like the pulse itself): halftime 45', full time
  // / extra-time start 90', ET boundaries 105'/120'. So they never pre-announce extra time.
  {
    const marks = dur > 100 ? [45, 90, 105, 120] : [45, 90];
    const labels = { 45: "45'", 90: "90'", 120: "120'" };
    plCtx.font = `${8.5 * dpr}px 'Space Mono', ui-monospace, monospace`;
    plCtx.textAlign = 'center'; plCtx.textBaseline = 'top';
    for (const mn of marks) {
      if (mn >= dur || mn > nowMin) continue;
      const mx = xOf(mn);
      const key = (mn === 90 || mn === 120);
      plCtx.strokeStyle = key ? 'rgba(233,231,244,0.26)' : 'rgba(233,231,244,0.13)';
      plCtx.lineWidth = 1 * dpr; plCtx.setLineDash([2 * dpr, 3 * dpr]);
      plCtx.beginPath(); plCtx.moveTo(mx, padY * 0.2); plCtx.lineTo(mx, H - padY * 0.2); plCtx.stroke();
      plCtx.setLineDash([]);
      if (labels[mn]) { plCtx.fillStyle = key ? 'rgba(233,231,244,0.5)' : 'rgba(233,231,244,0.3)'; plCtx.fillText(labels[mn], mx, padY * 0.25); }
    }
  }

  // PLAYHEAD.
  plCtx.strokeStyle = 'rgba(233,231,244,0.6)'; plCtx.lineWidth = 1 * dpr;
  plCtx.beginPath(); plCtx.moveTo(px, padY * 0.3); plCtx.lineTo(px, H - padY * 0.3); plCtx.stroke();
  plCtx.beginPath(); plCtx.arc(px, mid, 4 * dpr, 0, Math.PI * 2);
  plCtx.fillStyle = '#ffffff'; plCtx.fill();
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
async function bindMatchTabs() {
  const isDev = document.body.classList.contains('dev');
  const go = (id) => { if (id && id !== ID) location.search = '?id=' + id + (isDev ? '&dev=1' : ''); };
  // quick tabs (kept for the few pinned matches)
  for (const tab of document.querySelectorAll('#matchtabs .mtab')) {
    const id = tab.dataset.id;
    if (id === ID) tab.classList.add('on');
    tab.addEventListener('click', () => go(id));
  }
  // FULL match selector (dev panel) — EVERY harvested match, grouped by stage, so any match
  // is one pick away. Reads the same /matches.json the gallery uses.
  const sel = el('matchsel');
  if (!sel) return;
  try {
    const list = await fetch('/matches.json').then((r) => (r.ok ? r.json() : []));
    const ko = list.filter((m) => m.round === 'knockout').sort((a, b) => (a.stageRank ?? 9) - (b.stageRank ?? 9) || (a.date < b.date ? 1 : -1));
    const gr = list.filter((m) => m.round !== 'knockout').sort((a, b) => (a.date < b.date ? 1 : -1));
    const optFor = (m) => { const o = document.createElement('option'); o.value = m.id; o.textContent = `${m.home.abbr} ${m.home.score}–${m.away.score} ${m.away.abbr}`; if (String(m.id) === String(ID)) o.selected = true; return o; };
    const grp = (label, arr) => { if (!arr.length) return; const og = document.createElement('optgroup'); og.label = label; for (const m of arr) og.appendChild(optFor(m)); sel.appendChild(og); };
    for (const st of [...new Set(ko.map((m) => m.stage || 'Knockout'))]) grp(st, ko.filter((m) => (m.stage || 'Knockout') === st));
    grp('Group stage', gr);
    sel.addEventListener('change', () => go(sel.value));
  } catch { /* offline / no index — selector stays empty */ }
}

function bindGlobalUI() {
  bindMatchTabs();
  const playBtn = el('play');
  // STAGE13 — the finalized HUD's circular play button (#play13) drives the SAME
  // play/pause/restart logic as the old #play. It has an SVG glyph (no text), so we
  // keep #play's textual toggle and just share the click handler.
  const togglePlay = () => {
    // STAGE11 CHANGE #3 — the match plays ONCE then settles + stops. If the user presses
    // play again from that settled/finished end state, RESTART from the top (don't resume
    // straight into the settle). Otherwise it's a normal play/pause toggle.
    if (!playing && (settle > 0 || settling || wallProgress >= 1)) {
      resetSettle(); wallProgress = 0; _dramaCursor = 0; clock = matchT(0); snapASmoothing();
      playing = true;
    } else {
      playing = !playing;
    }
    setPlayGlyph(playing); _glyphState = playing;
  };
  if (playBtn) playBtn.addEventListener('click', togglePlay);
  const play13 = el('play13');
  if (play13) play13.addEventListener('click', togglePlay);
  el('restart').addEventListener('click', () => {
    resetSettle();
    wallProgress = 0; _dramaCursor = 0; clock = matchT(0); playing = true; playBtn.textContent = '❚❚'; snapASmoothing();
  });
  el('clock').addEventListener('input', () => {
    // slider is WALL-PROGRESS 0..100 through the dramatic pass → warp to match-min.
    resetSettle();
    wallProgress = clamp(+el('clock').value / 100, 0, 1);
    _dramaCursor = 0; clock = matchT(wallProgress);
    playing = false; playBtn.textContent = '▶'; _ballCursor = 0; snapASmoothing();
  });
  // seed the slider from the loaded cfg BEFORE binding, so bindSlider's initial
  // apply() reads the restored value instead of clobbering cfg.speed with the HTML
  // default (the old speed-not-restored bug). syncCfgToUI later re-affirms it.
  el('speed').value = cfg.speed;
  bindSlider('speed', 'speedV', (v) => { cfg.speed = v; writeHash(); return v.toFixed(1) + '×'; });

  // STAGE13 — SPEED now lives in the LEFT settings panel (#speed2); mirror it to the hidden
  // #speed so both stay consistent. RESTART also has a panel button.
  const speed2 = el('speed2'), speedV2 = el('speedV2');
  if (speed2) {
    speed2.value = cfg.speed;
    if (speedV2) speedV2.textContent = cfg.speed.toFixed(1) + '×';
    speed2.addEventListener('input', () => {
      cfg.speed = clamp(+speed2.value, 0.2, 6);
      if (speedV2) speedV2.textContent = cfg.speed.toFixed(1) + '×';
      const s1 = el('speed'), sv = el('speedV');
      if (s1) s1.value = cfg.speed; if (sv) sv.textContent = cfg.speed.toFixed(1) + '×';
      writeHash();
    });
  }
  const restart2 = el('restart2');
  if (restart2) restart2.addEventListener('click', () => {
    resetSettle(); wallProgress = 0; _dramaCursor = 0; clock = matchT(0); playing = true; snapASmoothing();
  });
  // SHOOTOUT timing (adjustable) — pause before the 1st kick + gap between kicks.
  const bindShoot = (id, valId, key) => {
    const s = el(id), v = el(valId);
    if (!s) return;
    cfg.shoot = cfg.shoot || { pause0: 2.4, gap: 1.7 };
    if (!Number.isFinite(cfg.shoot[key])) cfg.shoot[key] = key === 'pause0' ? 2.4 : 1.7;
    s.value = cfg.shoot[key];
    if (v) v.textContent = Number(cfg.shoot[key]).toFixed(1) + 's';
    s.addEventListener('input', () => { cfg.shoot[key] = +s.value; if (v) v.textContent = (+s.value).toFixed(1) + 's'; writeHash(); });
  };
  bindShoot('shPause', 'shPause2', 'pause0');
  bindShoot('shGap', 'shGap2', 'gap');

  // STAGE13 — SEEK by clicking / dragging the pulse timeline (linear in match-minute; the
  // pulse plots momentum by minute, so x maps straight to a minute → wall-progress).
  const pw = el('pulse13wrap');
  if (pw) {
    let scrubbing = false;
    const seekTo = (clientX) => {
      const r = pw.getBoundingClientRect();
      const f = clamp((clientX - r.left) / Math.max(1, r.width), 0, 1);
      const min = f * pulseDuration();
      resetSettle(); clock = min; wallProgress = clamp(progressOfMatchT(min), 0, 1);
      _dramaCursor = 0; _ballCursor = 0; playing = false; snapASmoothing();
    };
    pw.addEventListener('pointerdown', (e) => { scrubbing = true; try { pw.setPointerCapture(e.pointerId); } catch (_) {} seekTo(e.clientX); });
    pw.addEventListener('pointermove', (e) => { if (scrubbing) seekTo(e.clientX); });
    const stop = () => { scrubbing = false; };
    pw.addEventListener('pointerup', stop);
    pw.addEventListener('pointercancel', stop);
  }

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
    { id: 'wCorner', label: 'угловые ▸ сила', min: 0, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'markerH', label: 'отметки ▸ высота', min: 0, max: 1, step: 0.02, fmt: (v) => v.toFixed(2) },
  ], toggles: [
    { id: 'cCorner', label: 'угловые' },   // on/off for the corner-ripple layer
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
        writeHash(); _ballCursor = 0; if (!playing) snapASmoothing(); renderFrame(clock);
        renderer.render(scene, camera);   // STAGE-THUMB — direct render (keep transparency)
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
