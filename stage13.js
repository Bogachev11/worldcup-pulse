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
import { clamp, lerp, smoothstep } from './claybattle.js?v=1f97922a92';
import { expA, _rgb, hexA, _cardCol, _lift } from './modules/util.js?v=1f97922a92';
import { FLAG, flagSrc } from './modules/flags.js?v=1f97922a92';
import { FLOOD_SWEEP_S, FLOOD_HOLD_DEFAULT_S, FLOOD_RELAX_S, DEFAULTS, MATCH_DEFAULT } from './modules/config.js?v=1f97922a92';
import { initHowRead } from './modules/howread.js?v=1f97922a92';
import { initLightning } from './modules/lightning.js?v=1f97922a92';

// Match id resolution: a per-match static page at /m/<slug>/ injects
// window.__MATCH_ID (clean shareable URL, no query string). Otherwise fall back to
// the classic ?id= query param (back-compat), then the pinned default.
const ID = window.__MATCH_ID || new URLSearchParams(location.search).get('id') || '1953888';
const el = (id) => document.getElementById(id);

// PUBLIC vs DEV chrome — the dev constructor/camera panels + match switcher are
// hidden by default (CSS: body:not(.dev) …). Reveal them with ?dev=1 (or ?dev, or
// #dev) in the URL. All dev bindings still resolve their elements via el(), so
// nothing throws while the panels are merely display:none.
(() => {
  const q = location.search.toLowerCase(), h = location.hash.toLowerCase();
  // ?howedit=1 (the "how to read it" coordinate editor) also implies dev so the overlay + its
  // chrome resolve exactly as under ?dev — see HOWEDIT below and the editor at the end of setupHowToRead().
  if (/(^|[?&#])dev(=1|=true|\b)/.test(q) || /(^|[?&#])dev\b/.test(h) || /[?&]howedit=1/.test(q)) {
    document.body.classList.add('dev');
  }
})();
// ?howread=1 — CLEAN mobile/prod view WITH the "how to read it" link + overlay, but NONE of the dev
// chrome (no constructor/camera/console panels, no match tabs). For testing the explainer on a phone
// without the dev clutter blocking the link. Does NOT add body.dev; adds body.howread (and only when
// dev isn't already on) so the CSS reveals just the howlink/overlay while keeping the panels hidden.
const HOWREAD = /[?&]howread=1\b/.test(location.search);
if (HOWREAD && !document.body.classList.contains('dev')) document.body.classList.add('howread');
// HOWEDIT — DEV coordinate editor for the "how to read it" overlay. When ?howedit=1 is present the
// overlay auto-opens and its labels + feature dots become draggable, with a COPY COORDS button that
// writes the current geometry to the clipboard (see setupHowEdit at the end of setupHowToRead()).
const HOWEDIT = /[?&]howedit=1/.test(location.search);
// HOWEDIT persistence — DEV-only. The editor writes the user's live geometry (label positions,
// per-lead starts, feature dots) here on every change so it SURVIVES page reloads; the file's
// HOW_DESIGN stays the canonical default and localStorage is the working overlay on top of it.
const HOWEDIT_KEY = 'wcp_howedit_v1';
// DEV boolean — one source of truth for the DEV-ONLY prototype layers (shot-location
// dots on the pitch + extra seismograph marks). Both are strictly gated on this so the
// live site / prod video render (never carrying ?dev) look EXACTLY as before. Same flag
// as the chrome above (?dev=1 / ?dev / #dev); also expose window.__DEV for the export
// pipeline to force it on for a verification frame if ever needed.
const DEV = document.body.classList.contains('dev') || window.__DEV === true;
// PENBEAT — the "in-match penalty beat" (Option A: soft, scrub-safe, no clock-freeze). Each in-match
// penalty rises a hill in the KICKER's colour at the spot, recolours the directional wave to the
// kicker, and darkens/tightens the frame ("spotlight on the kick") over a ~1.9s wall envelope. It does
// NOT add a flood — a SCORED pen is resolved by the existing goal flood (goalWaveAt); a SAVED/MISSED
// pen resolves with just the small/recoil beat. All pure of the clock → scrub-safe.
// DEFAULT-ON for every visitor (owner-approved for prod 2026-07-14). `?pen=0` opts OUT (byte-identical
// to the old neutral-wave-only behaviour); `?pen=1` (or no flag) is ON. Matches WITHOUT any penalty are
// unaffected either way — this is only a capability gate, the beat only fires on a real penalty event.
const PENBEAT = !/[?&]pen=0\b/.test(location.search);

// PROD-DEFAULT PORTRAIT LAYERS — the scorer CARD (#scorerphotos) and the timeline
// EVENT MARKERS (#tlicons: goal dots, red-card rects, substitution ↑↓) are now LIVE
// for every visitor by DEFAULT (owner request), no longer behind ?dev. They were
// prototyped under DEV; this flag un-gates them from the dev chrome while keeping the
// rest (constructor/camera panels, match tabs, "how to read it") dev-only. Always true.
// (Kept as a named flag rather than inlining `true` so the intent is explicit at every
//  call site and easy to re-gate if ever needed.)
const CARD_PULSE = true;

// ── LOW-END / MOBILE GPU BUDGET ─────────────────────────────────────────────
// PROD BUG (MEX-ENG on a real phone): the WebGL mantle failed to render while the
// DOM HUD (scorer cards + pulse) kept working. Root cause = the GPU context was LOST
// at runtime (low-memory Android reclaims WebGL contexts aggressively) with NO handler
// and NO fallback, so `composer.render()` silently no-ops forever while the rAF loop
// (and thus the DOM overlay) keeps running. IS_LOW_END trims the GPU footprint UP FRONT
// on small / low-memory / touch devices to PREVENT the OOM that triggers the loss:
// lower DPR, a smaller shadow map, and no bloom render-target chain. Desktop is untouched
// (flag stays false), so the full-fat look is byte-identical there.
// NARROWED (mobile-quality fix): the old rule also flagged EVERY touch device with a
// small screen (`coarse && small`), i.e. essentially every phone — including high-end
// Androids and ALL iPhones (iOS never reports deviceMemory). That stripped bloom + AA and
// forced DPR 1.0 on capable phones, making the blankets flat, aliased and dull. We now
// reduce ONLY for genuinely memory-starved devices (deviceMemory ≤ 3 GB, Chromium-only).
// Devices that don't report deviceMemory (undefined → not a number) are treated as CAPABLE
// and get the full look. The real OOM safety net is installContextLossHandling(): if a weak
// device actually loses its WebGL context we recover/surface it gracefully, so we no longer
// need this blanket preventive downgrade. Desktop stays false (unchanged).
const IS_LOW_END = (() => {
  try {
    const dm = navigator.deviceMemory;                       // GB, Chromium only (undefined elsewhere)
    return (typeof dm === 'number' && dm <= 3);
  } catch { return false; }
})();
// PHONE / TABLET tier — a COARSE primary pointer + touch. A touch-LAPTOP has a fine primary pointer
// (trackpad), so `pointer: coarse` cleanly separates real phones/tablets from touch laptops. Used by
// the adaptive controller to TARGET ~30fps on mobile (a steady 30 at a GOOD-looking tier is the
// mobile ideal — do NOT degrade a phone toward the floor just because it can't hold a full 60).
const IS_MOBILE_TIER = (() => {
  try {
    const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    const touch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
    return coarse && touch;
  } catch { return false; }
})();
// DPR ceiling. Low-end → 1.0 (unchanged: fewest shaded pixels / smallest render targets).
// Capable → min(devicePixelRatio, 2.0): 2.0 is crisp on a retina phone (e.g. 390×844 @ DPR3,
// where native 3.0 would triple the shaded-pixel count for little visible gain and risk VRAM
// on the bloom mip chain), while still supersampling ~4× over the old 1.0. Desktop is
// unaffected — typical desktop DPR is 1 so min(1,2.0)=1 (and a HiDPI desktop that previously
// capped at 1.25 now gets slightly MORE, never less, so the desktop look never degrades).
// ============================================================================
// ADAPTIVE QUALITY — runtime safety net for weak / integrated / SOFTWARE GPUs.
// The visualization is fill-rate + post-pass heavy (bloom mip chain, 2048² shadow
// depth pass, 4× pixels at DPR 2.0 on a HiDPI panel). On a software rasteriser
// (Microsoft Basic Render Driver / SwiftShader / llvmpipe) the full path runs at
// ~3 fps and can hang the tab. This system (a) picks a SAFE STARTING LEVEL from the
// real GPU string, and (b) watches the true rAF frame interval and ratchets quality
// DOWN when it can't hold budget (and cautiously back UP only with lots of headroom).
// A confirmed-strong discrete GPU starts at — and never leaves — the full award look.
//
// LADDER — index 0 = best (award look) → last = software floor. Each rung is a full
// set of the levers: dpr (DPR ceiling), bloom (post glow on/off), shadow (depth map
// size; 0 = shadows off), stride (field-recompute cadence: recompute 1 of every N frames).
// PERF NOTE — the low/software rungs were REWORKED after profiling (see profile_split.py). The
// old floor slammed dpr to 0.66 + stride 5, which was BOTH ugly (soft, low-res pixels) AND still
// laggy: the true bottleneck is the JS field loop (computeField over VX×VY verts), NOT fill-rate.
// GPU render at the floor was only ~4ms @6× throttle vs ~18ms for the field. So the real fix is
// the COARSER GRID chosen per-class at startup (configureGrid → ~37% of the verts on software),
// which cuts the JS cost directly; that freed the budget to RAISE dpr back to 1.0 (crisp again).
// The floor now steadies cadence with an ADAPTIVE frame cap (capAdaptive) that locks to an EVEN
// fps divisor (30/20/15) the machine can actually hold, instead of forcing a 30 it can't.
// EACH RUNG carries EVERY quality lever, INCLUDING the terrain `grid` — so grid is now a runtime-
// promotable function of the LEVEL (not fixed once from the GPU string). The controller rebuilds
// the blanket geometry when a level change crosses a grid threshold (rebuildTerrainGrid), so a
// device that PROVES headroom climbs all the way to the full 120×72 award look, and one that
// genuinely struggles drops to a coarser-but-smooth grid. Grid is the dominant JS cost AND the
// dominant "looks coarse/blocky" quality signal, so it MUST move with the tier — the old build
// pinned it from the GPU label at startup and never upgraded, which is why a capable-but-
// mislabelled ('weak'/integrated) GPU stayed stuck looking degraded even with 60fps of headroom.
// SACRED-DETAIL REWORK (2026-07-12) — the owner's PRIORITY-1 principle: terrain GRID resolution
// (160×96) and event DENSITY (per-frame field recompute, stride 1) are NEVER cut, on ANY device or
// in the video export. They carry the whole "many distinct movements" reading the owner values. So
// every rung below now pins grid:[160,96] + stride:1 (the baseline 5ef986b arg-egy-era detail) and
// the ladder degrades EFFECTS ONLY — bloom, shadows, the expensive fragment (fbm/hex/dFdx/ember,
// gated separately by _cheapFrag on level≥WEAK), and DPR (fill/sharpness) as the LAST resort. A weak
// device therefore keeps the FULL flow of events; it just loses glow/shadows/PBR sheen/sharpness.
const QUAL_LADDER = [
  { dpr: 2.0,  bloom: true,  shadow: 2048, stride: 1, grid: [160, 96] },   // 0 — STRONG desktop / phone + VIDEO: full award look (bloom + shadows + retina)
  { dpr: 1.5,  bloom: false, shadow: 2048, stride: 1, grid: [160, 96] },   // 1 — bloom off, shadows kept, DPR 1.5
  { dpr: 1.25, bloom: false, shadow: 1024, stride: 1, grid: [160, 96] },   // 2 — DEFAULT median start: smaller shadow map, DPR 1.25
  { dpr: 1.0,  bloom: false, shadow: 1024, stride: 1, grid: [160, 96] },   // 3 — WEAK: cheap fragment kicks in (level≥WEAK), DPR 1.0
  { dpr: 1.0,  bloom: false, shadow: 512,  stride: 1, grid: [160, 96] },   // 4 — smaller shadow map
  { dpr: 1.0,  bloom: false, shadow: 0,    stride: 1, grid: [160, 96] },   // 5 — shadows OFF (pure effect cut; grid + density untouched)
  { dpr: 0.85, bloom: false, shadow: 0,    stride: 1, grid: [160, 96], capAdaptive: true },   // 6 — SOFTWARE intermediate: DPR 0.85 (fill savings) + adaptive even-cadence cap. Grid/density STILL full.
  { dpr: 0.66, bloom: false, shadow: 0,    stride: 1, grid: [160, 96], capAdaptive: true },   // 7 — SOFTWARE floor: DPR ⅔ (CSS-upscaled soft, cuts fill to ~44%). LAST-RESORT effect/DPR cut only — grid stays 160×96 + per-frame density (detail wins over framerate, per the owner). capAdaptive locks to the smallest EVEN fps divisor it can hold.
];
const QL_STRONG = 0, QL_DEFAULT = 1, QL_MEDIAN = 2, QL_WEAK = 3, QL_FLOOR = QUAL_LADDER.length - 1;
// CHEAP-but-UNCAPPED effects tier the desktop hardware-integrated (weak/unknown) path starts + pins
// on: bloom off, shadows off, cheap fragment, NO frame cap → maximum headroom for the decoupled DPR
// sharp-climb + a steady 60fps, full 160×96 per-frame detail. (Levels 6/7 add a fps cap → reserved
// for genuine software rasterisers; a hardware GPU should never be fps-capped.)
const QL_DESKTOP_WEAK = 5;
// classify the WEBGL_debug_renderer_info UNMASKED_RENDERER_WEBGL string into a GPU class.
function classifyGPU(str) {
  const s = String(str || '').toLowerCase();
  // SOFTWARE rasterisers — no hardware WebGL. Owner's laptop reports "Microsoft Basic Render
  // Driver"; the SwiftShader test path reports "swiftshader"; Linux software GL is "llvmpipe".
  if (/swiftshader|llvmpipe|microsoft basic|basic render|\bwarp\b|software|softpipe/.test(s)) return 'software';
  // Confirmed-STRONG discrete GPUs — keep the full look. (Apple M-series checked before generic apple.)
  if (/geforce|\brtx\b|\bgtx\b|quadro|nvidia|tesla|radeon rx|\brx ?\d{3,}|\bvega ?(56|64|frontier)|apple m\d|arc a\d|instinct/.test(s)) return 'strong';
  // Integrated / mobile / weak GPUs — start low.
  if (/intel|uhd|iris|hd graphics|apple|mali|adreno|powervr|vega|radeon|microsoft|parallel|virgl|vmware/.test(s)) return 'weak';
  return 'unknown';
}
// DESKTOP-SOFTWARE NUDGE — GA shows ~16% Windows, some of whom (like the owner's laptop) run with
// hardware acceleration DISABLED → the browser falls back to a software rasteriser (Microsoft Basic
// Render Driver / SwiftShader), which forces the soft graceful floor. On DESKTOP only (never mobile,
// where nothing can be done about it) show a subtle, dismissible one-time hint that turning on the
// browser's hardware acceleration restores full quality. Remembered in localStorage so it appears
// once. Self-contained (inline styles), non-blocking, tasteful — matches the dark premium chrome.
let _hintSuppress = false;   // set by the programmatic-drive hooks (__setClock/__step) so exports/tests never show the hint
function maybeShowHwAccelHint() {
  try {
    if (GPU_CLASS !== 'software' || IS_MOBILE_TIER) return;
    if (/[?&#]nohint\b/.test((location.search + location.hash).toLowerCase())) return;
    if (localStorage.getItem('wcHwHintDismissed') === '1') return;
    const build = () => {
      if (!document.body || document.getElementById('hwAccelHint')) return;
      // NEVER show in export/capture/dev/how-to-read modes (the video pipeline adds body.capfoot and
      // drives via __setClock/__step → _hintSuppress) so the nudge can never leak into a rendered video.
      if (_hintSuppress) return;
      const cl = document.body.classList;
      if (cl.contains('capfoot') || cl.contains('howread') || cl.contains('howmobile') || cl.contains('dev') || cl.contains('howtap')) return;
      // RESTYLE (owner: "никаких плашек") — NO pill/box/background/border/shadow of any kind. Just a
      // small, faint GRAY line of ENGLISH text along the very bottom, unobtrusive, matching the site's
      // restrained chrome. The whole line is (subtly) clickable to dismiss — no boxy X-button — and it
      // auto-fades so it never lingers over the piece. Remembered dismissed in localStorage.
      const w = document.createElement('div');
      w.id = 'hwAccelHint'; w.setAttribute('role', 'note');
      w.style.cssText = 'position:fixed;left:0;right:0;bottom:9px;z-index:60;'
        + 'text-align:center;pointer-events:none;padding:0 16px;'
        + 'font:400 11.5px/1.4 Barlow,ui-sans-serif,system-ui,sans-serif;letter-spacing:0.2px;'
        + 'color:rgba(233,231,244,0.34);opacity:0;transition:opacity .6s ease;';
      const txt = document.createElement('span');
      txt.textContent = 'Enable hardware acceleration in your browser for full graphics quality.';
      txt.title = 'Dismiss';
      txt.style.cssText = 'pointer-events:auto;cursor:pointer;';
      txt.addEventListener('mouseenter', () => { w.style.color = 'rgba(233,231,244,0.5)'; });
      txt.addEventListener('mouseleave', () => { w.style.color = 'rgba(233,231,244,0.34)'; });
      const dismiss = () => { w.style.opacity = '0'; setTimeout(() => w.remove(), 600); try { localStorage.setItem('wcHwHintDismissed', '1'); } catch {} };
      txt.addEventListener('click', dismiss);
      w.appendChild(txt);
      document.body.appendChild(w);
      requestAnimationFrame(() => { w.style.opacity = '1'; });
      // auto-fade after a while so it never lingers over the piece (still remembered as shown).
      setTimeout(() => { if (document.getElementById('hwAccelHint')) dismiss(); }, 14000);
    };
    // DEFER ~2.2s: gives the export pipeline / test harness time to drive a frame (__setClock/__step
    // → _hintSuppress) or add body.capfoot BEFORE the nudge would appear, so it only ever shows to a
    // genuine desktop visitor sitting on a software renderer.
    setTimeout(build, 2200);
  } catch {}
}
let GPU_STR = '';          // UNMASKED_RENDERER_WEBGL (probed in setupThree, before renderer AA is fixed)
let GPU_CLASS = 'unknown'; // classifyGPU(GPU_STR)
let AA_ON = false;         // antialias at context creation — only the confirmed-strong desktop gets it
let _qLevel = QL_DEFAULT;  // current ladder index (set from GPU class at startup)
let _qMaxLevel = 0;        // best (lowest) index the step-UP ratchet may reach; raised when a step-up regresses
let _qLocked = false;      // once a step-up immediately regresses, stop trying to climb (one-way ratchet)
let fieldStride = 1;       // SACRED: field recomputes EVERY advancing frame on ALL tiers (per-frame event density, baseline 5ef986b). Never raised by the ladder.
let DPR_CAP = 1.5;         // DPR ceiling — DEFAULT 1.5 for everyone; only confirmed-strong is bumped to 2.0.
// MOBILE render-DPR ceiling — ADAPTIVE (was a hard 2.0 for ALL phones, which SOFTENED a flagship).
// Real iOS/Android phones report devicePixelRatio 2–3 at ~390–440 CSS px, so a full-DPR backing
// buffer is enormous (e.g. 430×932 @ DPR3 ≈ 1290×2796 px) and fill-wasteful on a WEAK phone. But a
// POWERFUL phone (DPR-3 flagship) that SUSTAINS 60fps-class headroom at the TOP tier can afford the
// crisp retina pixels it rendered before the adaptive rework — pinning it to 2.0 made the mantle
// visibly softer for no reason. So the mobile cap now STARTS conservative (2.0, fill savings for the
// median/weak phone) and the adaptive controller RAISES it toward the device's native DPR (up to 3.0)
// only once the phone has reached level 0 (full grid + bloom + shadows) AND held clean headroom — with
// its own regress-latch so a phone that can't hold the sharper pixels reverts to 2.0 and never retries
// (no dpr oscillation). Weak phones that never reach level 0 stay capped at 2.0. Desktop is unaffected.
const MOBILE_DPR_BASE = 2.0;   // conservative mobile start cap (fill savings for the weak/median phone)
const MOBILE_DPR_MAX  = 3.0;   // proven-strong ceiling — native retina (guards the extreme DPR-4 panels)
let   _mobileDprCap      = MOBILE_DPR_BASE;  // current adaptive mobile DPR ceiling (raised on a proven strong phone)
let   _mobileDprLatched  = false;            // once a raise regresses, stop retrying this session (anti-oscillation)
let   _mobileDprPendingAt = 0;               // performance.now() of a just-applied raise being judged for regress
let   _mobileDprGoodSince = 0;               // start of the clean-headroom window that gates the raise
// DESKTOP SHARP-CLIMB DPR (2026-07-13) — on a HARDWARE integrated desktop GPU (class weak/unknown,
// e.g. the owner's Intel HD 520 with hw-accel ON) DPR is DECOUPLED from the effects level and treated
// as the LAST-resort quality cut: the owner values SHARPNESS + DETAIL over glow/shadows, so we hold
// DPR as HIGH as the device sustains SMOOTHLY. It starts conservative-but-sharp (native on a standard
// 1.0 laptop → no blur from frame one), then CLIMBs toward native while frame time stays 60fps-clean,
// crossfading each raise and LOCKING once native is reached or a raise regresses (no wandering). This
// is what fixes the owner's "blurry" (the effects ladder used to bundle a LOW dpr into the rung it
// settled on) and the "гуляло" (the level no longer climbs into expensive effects it can't hold — the
// only runtime move is a monotonic DPR sharpen that settles ONCE). Genuinely SOFTWARE rasterisers
// (class 'software') are EXCLUDED — they keep the ladder's low DPR floor (0.66–0.85) to avoid a hang.
// Strong desktops and all phones are UNTOUCHED (own paths below).
const DESKTOP_DPR_START = 1.0;   // conservative-but-sharp start: native on a standard 1.0-DPR laptop (no blur); HiDPI panels climb up from here
const DESKTOP_DPR_MAX   = 2.0;   // hard ceiling; the real target is min(native, this) — never supersample past native (wasteful fill)
let   _desktopDpr        = DESKTOP_DPR_START;  // current decoupled desktop DPR ceiling (climbed toward native)
let   _desktopDprLatched = false;              // climb finished (reached native target OR a raise regressed) → locked, no more moves
let   _desktopDprPendingAt = 0;                // performance.now() of a just-applied raise being judged for regress
let   _desktopDprGoodSince = 0;                // start of the clean-headroom window that gates the next raise
// TRUE on the desktop hardware-integrated path that owns the decoupled sharp-climb DPR (weak/unknown,
// not mobile, not strong, not software). GPU_CLASS is resolved in setupThree, so this is a function.
function _desktopDprPath() {
  return SMOOTH_WEAK && !IS_MOBILE_TIER && (GPU_CLASS === 'weak' || GPU_CLASS === 'unknown');
}
// effective device-pixel-ratio actually handed to the renderer: min(native, current tier cap). On
// mobile the ceiling is the ADAPTIVE _mobileDprCap (2.0 → native); on the desktop weak/unknown path
// the ceiling is the DECOUPLED _desktopDpr (sharp-climb, independent of the effects level); elsewhere
// (strong desktop, software floor) it honours the ladder rung's DPR_CAP.
function effectiveDPR() {
  const nat = window.devicePixelRatio || 1;
  if (IS_MOBILE_TIER) {
    let cap = _mobileDprCap;
    if (_qLevel > 0) cap = Math.min(cap, DPR_CAP);   // degraded rungs keep the ladder's stricter DPR
    return Math.min(nat, cap);
  }
  // VIDEO/export & programmatic capture: honour the ladder rung's DPR_CAP (an export forces ?qstart=0
  // → level 0 → 2.0 → native) so a render is never softened by the runtime sharp-climb (which is
  // frozen in capture mode anyway). Only a genuine interactive visitor takes the decoupled climb.
  if (_desktopDprPath() && !_isCaptureMode()) return Math.min(nat, _desktopDpr);   // sharp-climb DPR, decoupled from the effects level
  return Math.min(nat, DPR_CAP);
}
let _cw = 0, _ch = 0;      // PERF — cached #stage client box (updated in onResize); read by the per-frame overlay draws instead of the DOM (no layout thrash).
let glLost = false;                          // set by the webglcontextlost handler; gates rendering + shows the fallback.

// FLOAT-TEXTURE LINEAR FILTERING capability. The two team blankets store their height /
// coverage / corner-tint fields in float DataTextures (RedFormat + FloatType) that the
// cloth shader samples with LinearFilter for smooth relief. LINEAR filtering of a FLOAT
// texture is gated behind the OES_texture_float_linear extension (a hardware feature on
// BOTH WebGL1 and WebGL2 — float textures themselves are core in WebGL2, but *linear*
// sampling of them is not). Some older mobile GPUs lack it, and there sampling a float
// texture with LinearFilter returns nothing → the cloth comes out flat / blank. When it is
// absent we fall back to NearestFilter (slightly less smooth, but the cloth still renders).
// Detected once against the real renderer context in setupThree(); capable devices are
// completely unaffected. `?nofloatlin` (or #nofloatlin) forces the fallback for testing.
let FLOAT_LINEAR_OK = true;
const FORCE_NO_FLOAT_LINEAR = (() => {
  try {
    const q = location.search.toLowerCase(), h = location.hash.toLowerCase();
    return /[?&]nofloatlin\b/.test(q) || /(^|[?&#])nofloatlin\b/.test(h);
  } catch { return false; }
})();

// TEAM COLOURS — derived per match from the loaded timeline doc (home/away .color).
// FRA/SEN default fallbacks match the brief (#387ef0 / #0c954e); ICO/NOR (and any
// other match) get their own real data colours. Populated in init() from tlDoc, so
// switching matches via the tabs recolours the two blankets correctly.
let FRA_HEX = '#387ef0';   // home colour (fallback = France blue)
let SEN_HEX = '#0c954e';   // away colour (fallback = Senegal green)

// baked-in default camera (STAGE12 — the user's tuned ortho ракурс)
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
// CONTENT_HALF_W = world-unit HORIZONTAL half-extent that the tilted pitch (+relief) spans
// on screen along the camera's right axis. On WIDE aspects the height-driven width already
// exceeds this so it's inert (desktop unchanged). On NARROW/PORTRAIT aspects (phones) the
// height-driven width shrinks below the pitch → it overflows the sides; we then grow the
// frustum (zoom out) so the FULL pitch width is contained. "contain" fit, not "cover".
const CONTENT_HALF_W = 9.2;
// STAGE13 FIX — the #stage canvas is now FULL-VIEWPORT (full-bleed) so the score-tinted sky
// dome fills the whole page (one uniform background, no centred rectangle). But the pitch must
// keep the EXACT on-screen size + centring it had when the canvas was framed to the ~1000px
// column. So the frustum HALF-HEIGHT is anchored to the OLD COLUMN framing — computed from the
// aspect the column WOULD have had (COL_W / viewportHeight), NOT the wide full-viewport aspect.
// The frustum WIDTH then follows the REAL full-viewport aspect, so the extra viewport width just
// becomes more background on the sides while the pitch stays put + same size. On NARROW/PORTRAIT
// viewports (phones) the column is already 100vw, so colW≈vw and the contain-fit still grows the
// frustum to keep the full pitch width on screen (mobile framing unchanged).
const COL_W_PX = 1000;   // the design column width (CSS --col-w on desktop)
function setOrthoFrustum(aspect, viewH, viewW) {
  if (!camera || !camera.isOrthographicCamera) return;
  const a = Math.max(0.0001, aspect);   // real full-viewport aspect (w/h)
  // Effective COLUMN width in px: the smaller of the design column and the actual viewport
  // (matches the CSS `width: var(--col-w); max-width: 100vw`). Falls back to deriving it from
  // the aspect when explicit sizes aren't passed (seed call).
  const vw = viewW || (viewH ? viewH * a : COL_W_PX);
  const vh = viewH || (vw / a);
  const colW = Math.min(COL_W_PX, vw);
  const colAspect = Math.max(0.0001, colW / vh);   // aspect the old 1000px column had
  // half-height: same contain-fit as before but on the COLUMN aspect → pitch keeps its size.
  const h = Math.max(ORTHO_VIEW, CONTENT_HALF_W / colAspect);
  // width follows the REAL viewport aspect (wider screen = more side background, pitch centred).
  const w = h * a;
  camera.left = -w; camera.right = w; camera.top = h; camera.bottom = -h;
  camera.updateProjectionMatrix();
}

// ---- pitch / mesh dims ------------------------------------------------------
const WORLD_X = 16, WORLD_Z = 9.6;       // pitch footprint
// the blanket meshes (smooth) — sampled from the low-res field grids.
// PERF/ADAPTIVE — the terrain grid resolution is the DOMINANT per-frame cost on a slow CPU /
// software rasteriser: the profiled bottleneck is NOT fill-rate but the JS field loop over these
// VX×VY vertices (computeField) + the 6× float-DataTexture re-upload — ~18ms/recompute at 6× CPU
// throttle on the full 120×72 grid, vs only ~4ms for the actual GPU render. The grid is now a
// runtime lever of the quality LEVEL (QUAL_LADDER[idx].grid): the initial value is picked from the
// start level (a hint from the GPU class), and the adaptive controller RE-BUILDS the geometry to a
// finer grid when it climbs into a higher tier (headroom proven) or a coarser one when it drops.
let GX = 160, GY = 96;   // SACRED terrain grid — 160×96 (baseline 5ef986b arg-egy detail) on ALL tiers/devices/video; never reduced by the ladder (see gridForLevel/applyGrid).
let VX = GX + 1, VY = GY + 1, NV = VX * VY;
// ?grid=WxH forces a FIXED terrain resolution for A/B testing; when present, runtime promotion is
// disabled so the measured grid stays put across the whole session.
let _gridForced = false;
function _gridOverride() {
  try {
    const q = (new URLSearchParams(location.search).get('grid') || '').toLowerCase();
    const m = q.match(/^(\d+)x(\d+)$/);
    if (m) return [Math.max(8, +m[1]), Math.max(6, +m[2])];
  } catch {}
  return null;
}
// terrain grid for a ladder level (honours the ?grid override, which pins it).
function gridForLevel(idx) {
  const o = _gridOverride(); if (o) return o;
  const L = QUAL_LADDER[clamp(idx | 0, 0, QL_FLOOR)];
  return (L && L.grid) || [160, 96];
}
// set the module grid dims (no geometry rebuild — used at startup BEFORE geometry is built).
function applyGrid(gx, gy) {
  GX = gx; GY = gy; VX = GX + 1; VY = GY + 1; NV = VX * VY;
  try { console.info(`[stage13] terrain grid ${GX}×${GY} (${NV} verts)`); } catch {}
}
// startup grid = the start level's grid (or the ?grid override). Records whether the grid is pinned.
function configureGrid(startLevel) {
  const o = _gridOverride();
  _gridForced = !!o;
  const g = o || gridForLevel(startLevel);
  applyGrid(g[0], g[1]);
}

// ============================================================================
// SMOOTH-WEAK (DEV) — perceived-quality polish for the WEAK / SOFTWARE / LOW tiers ONLY.
// A confirmed-STRONG GPU — and ANY device that holds the full 120×72 grid (a flagship phone
// that climbs to level 0, a fast desktop) — takes NONE of this: the award look is byte-
// identical. Every lever below is gated on GPU_CLASS≠'strong' AND the ACTIVE terrain grid
// being coarser than full (GX<120 ⟺ the controller has settled the device on a degraded rung).
//   A · START at the target tier (a startup GPU probe picks the settling rung so the user never
//       sees the jarring step-DOWN from a high tier) + CROSS-FADE quality changes (a brief blur
//       pulse hides the grid-rebuild / dpr pop instead of a hard snap).
//   B · SMOOTHER low tier: tessellate the drawn GEOMETRY finer than the (cheap, low-res) FIELD
//       grid so the bilinearly-sampled height texture reads as smooth undulations — silhouette +
//       relief smooth out with ZERO extra JS field cost (only cheap GPU vertex work). A LIGHTER
//       fragment path (drop the 4-octave fbm, the triple hex-pattern eval, the dFdx micro-normal
//       and the ember-noise) frees the fill an integrated GPU pours into the mantle, so the finer
//       grid costs nothing net — and ordered dithering kills the low-DPR gradient banding.
//   C · INTERPOLATE the terrain height between field recomputes (fieldStride>1) so the cloth
//       flows smoothly rather than stepping every N frames.
// DEV master switch for the weak-device polish. Default ON; ?smooth=0 forces the exact LEGACY path
// (for A/B capture on the same running server — verify BEFORE=?smooth=0 vs AFTER on the low tiers).
const SMOOTH_WEAK = (() => { try { return !/[?&]smooth=0\b/.test(location.search); } catch { return true; } })();
// EFFECT-ONLY DEGRADATION — on the WEAK/SOFTWARE tiers (level ≥ QL_WEAK) the heavy PBR fragment
// (4-octave fbm, triple hex eval, dFdx micro-normal, ember noise) is both unaffordable AND barely
// perceptible, so we take the LIGHTER fragment path (an EFFECT cut, exactly what the sacred-detail
// principle permits — the terrain grid + per-frame density are untouched). Rungs 0–2 and every
// STRONG device keep the full award shader. Re-keyed off the LEVEL, not the grid (grid is now always
// 160×96): a device that SETTLES on a weak rung recompiles to the cheap fragment via _applyQualityLevel.
function _cheapFrag() { return SMOOTH_WEAK && GPU_CLASS !== 'strong' && _qLevel >= QL_WEAK; }
let _builtCheapFrag = false;   // the _cheapFrag() verdict the live blanket shaders were compiled under (see _syncCheapFrag)
// GEOMETRY render resolution for a given FIELD grid. The field arrays/textures stay at the (cheap)
// field res — only the DRAWN plane is subdivided finer, so the low-res height texture interpolates
// into a smooth surface. The dominant "looks blocky" signal (the coarse silhouette + faceted
// relief) is fixed for free on the CPU (just extra GPU vertices). Only the genuinely coarse
// software rungs (≤62 wide — the 56×34 floor the owner's HD 520 settles on) are tessellated up,
// capped so the geometry never exceeds ~full-grid (120-wide) vertex density.
function renderGridForField(gx, gy) {
  if (!SMOOTH_WEAK || GPU_CLASS === 'strong' || gx > 62) return [gx, gy];
  const mul = Math.max(1, Math.floor(120 / gx));   // 56→2 (→112×68), capped so gx*mul ≤ 120
  return [gx * mul, gy * mul];
}
// C · FIELD INTERPOLATION timing — the height texture updates every fieldStride PRESENTED frames;
// between recomputes the vertex shader eases the displaced height from the previous field to the
// new one (uFieldMix 0→1) so the relief FLOWS. Set at each recompute; read per presented frame.
let _fieldMixStart = 0, _fieldMixDurMs = 0;
// DEV capture/drive guard — never let the probe or the cross-fade blur leak into an exported video
// or a programmatically-driven test frame (the pipeline sets _hintSuppress + body.capfoot/howread).
function _isCaptureMode() {
  try {
    if (_hintSuppress) return true;
    const cl = document.body && document.body.classList;
    if (cl && (cl.contains('capfoot') || cl.contains('howread') || cl.contains('howmobile') || cl.contains('howtap'))) return true;
  } catch {}
  return false;
}
// A2 · CROSS-FADE a quality change — apply an INSTANT soft blur (hiding the discrete grid-rebuild /
// dpr pop) then ease it back to sharp over ~0.4s, so a level change reads as a gentle settle, not a
// snap. Gated to the weak/low path (a STRONG device never changes level, so it never blurs).
let _qFadeArmed = false;
function _qCrossfade() {
  if (!SMOOTH_WEAK || GPU_CLASS === 'strong' || _isCaptureMode()) return;
  let s; try { s = el('stage'); } catch { s = null; }
  if (!s) return;
  s.style.transition = 'none';
  s.style.filter = 'blur(2px)';
  s.style.willChange = 'filter';
  _qFadeArmed = true;
  requestAnimationFrame(() => { requestAnimationFrame(() => {
    if (!_qFadeArmed) return;
    s.style.transition = 'filter .42s ease';
    s.style.filter = 'blur(0px)';
    setTimeout(() => { if (s.style.filter === 'blur(0px)') { s.style.willChange = ''; } }, 480);
  }); });
}

const worldX = (u) => (u - 0.5) * WORLD_X;
const worldZ = (v) => (0.5 - v) * WORLD_Z;

// ---- scene state ------------------------------------------------------------
let renderer, scene, camera, controls, composer;
let bloomPass, gradePass, smaaPass, renderPass;
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
// ---- IN-PAGE CROWD AUDIO (Web Audio API, site-timed) — see setupCrowdAudio()/syncCrowdAudio() ----
// The mp3 is fetched FULLY up front, decoded ONCE into an AudioBuffer, and played via an
// AudioBufferSourceNode on the AUDIO THREAD. That makes it glitch-free on mobile: no MP3-seek
// stutter, no mid-play network buffering, and the audio clock is immune to main-thread / WebGL jank.
// Audio position maps 1:1 to `wallProgress`:  bufferPos == clamp(wallProgress,0,1) * bodyDurationS.
// It FREE-RUNS at a constant rate (crowdRate()); we only touch the audio on DISCRETE events (start,
// pause/resume, scrub, or a rare >0.75s drift) — NEVER per frame. SOUND is ON by default, but the
// AudioContext must be resumed inside the first user gesture (autoplay policy).
let _crowdCfg = null;      // parsed /audio/<id>.json (the sync contract)
let _crowdOn = true;       // SOUND toggle state — ON by default
let _crowdBytes = null;    // fetched mp3 ArrayBuffer (held until decoded)
let _actx = null;          // AudioContext (created at setup or on first gesture)
let _abuf = null;          // decoded AudioBuffer (decoded ONCE, fully in memory)
let _asrc = null;          // current AudioBufferSourceNode (one-shot; recreated on each (re)start)
let _again = null;         // GainNode → destination
let _crowdReady = false;   // mp3 bytes fully fetched → toggle may be shown
let _crowdPlaying = false; // is a source node currently running
let _aStartCtxTime = 0;    // _actx.currentTime when the current source started
let _aStartOffset = 0;     // buffer offset (s) the current source started at (== frozen pos when stopped)
let _crowdRateCur = 1;     // playbackRate currently applied to the live source
let _crowdDesiredPrev = false;  // edge-detect play/pause/toggle/ctx-resume transitions
let _crowdWpPrev = 0;      // edge-detect scrubs (wallProgress jumps)
let _audioGestureArmed = false; // one-time first-gesture unlock listeners attached?
let _audioGestureDisarm = null; // () => remove the first-gesture listeners; kept until playback truly begins
let _crowdLastDriftChk = 0;     // throttle the (cheap, read-only) drift check
let _crowdReseeks = 0;          // DEBUG — count of source (re)starts (verification: ~0 during free play)
// SINGLE BACKEND — Web Audio for ALL matches (2026-07-15). The old hybrid used an HTMLAudioElement
// with preservesPitch for penalty/penWarp matches because their audio body was SHORT of the stretched
// pass (crowdRate ≈ 0.895 → a resampled buffer would drop pitch ~11%). That time-stretch produced the
// watery/metallic artifacts the owner heard. Now crowd_audio.py BAKES the 4.7s penWarp freeze block(s)
// into the site audio (bodyDurationS == penWarp.totalWall == effTotal), so crowdRate() == 1.0 for EVERY
// match — clean, resample-free AudioBufferSourceNode playback, natural pitch, correct sync.
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

// GOAL-FLOOD phase durations FLOOD_SWEEP_S / FLOOD_HOLD_DEFAULT_S / FLOOD_RELAX_S
// -> ./modules/config.js (imported at top), alongside DEFAULTS() which seeds from them.
// EVENT LAG — the HUD events tied to a goal (SCORE increment, SKY leader tint, goal
// markers/rings) must fire a beat AFTER the cloth has moved, never before it. The blanket
// GOAL FLOOD leads (starts at the goal instant, rolls over FLOOD_SWEEP_S); these overlay
// events trail by EVENT_LAG_S of WALL time so the eye reads: cloth floods → THEN the score
// ticks and the sky shifts, almost together but clearly after the pitch. (Authored in wall
// seconds via wallSecondsSinceGoal so it is scrub-safe and warp-independent.)
const EVENT_LAG_S = 0.7;

// GOAL CREST — every goal MUST be preceded by a big height spike (rising danger), then
// the flood. The per-shot xG spire (contribLift) is xG-scaled and appears only AT/AFTER
// the shot, so a low-xG or own goal gets no visible build. This dedicated goal crest
// BUILDS over GOAL_CREST_LEAD_MIN match-minutes BEFORE the goal, peaks AT the goal
// instant, then decays — a guaranteed tall spire regardless of the shot's recorded xG.
// EMOTIONAL ESCALATION — dangerous moments in quick succession build tension and read
// TALLER (a flurry of chances = an emotional swing). Each shot counts the dangerous shots
// (either team) in the preceding STREAK_WIN_MIN match-minutes → e._streakN; contribLift
// multiplies the xG crest by 1 + streakK·min(streakN, STREAK_MAX).
// DANGER FLOOD — a dangerous NON-goal shot briefly washes the WHOLE field toward the SHOOTING
// team's colour (a soft mini-goal-flood), so the more dangerous side visibly «floods with its
// colour» during its chances — NEVER a local island in the opponent's half (that was wrong).
// In WALL seconds so it plays under the dramatic clock (scrub-safe). Strength ∝ xG × the knob.
const DANGER_XG = 0.05;            // LOW bar so every dangerous episode shows a finger-выпад (goals excluded — own flood). On-target/saved shots qualify regardless of xG (see dangerShots build). Depth follows shot POSITION, not xG.
const DANGER_FLOOD_S = 1.7;        // wall-seconds life of the danger wash (rise → peak → recede)
const XG_SPIRE_MAX = 2.5;          // hard cap on a (non-goal) xG spire's world-Y — a chance PEAKS clearly LOWER than a GOAL crest (xG ≈ half a goal, per the user: «xG всегда меньше гола раза в два»).
const STREAK_XG = 0.08;            // a shot counts toward a streak if xg ≥ this (goals always count)
const STREAK_WIN_MIN = 6.0;        // look-back window (match-minutes) for the streak
const STREAK_MAX = 4;              // cap the streak count so a chaotic spell doesn't tower absurdly
const GOAL_CREST_LEAD_S = 0.5;     // WALL-seconds of pre-goal build — a short RISE that peaks AT the goal
const GOAL_CREST_DECAY_S = 1.1;    // WALL-seconds decay τ AFTER the hold — the GOAL peak stands during the goal MOMENT (roll+hold ~2s) then RECEDES with the flood/rollback, NOT a bump lingering long after. Magnitude = cfg.A.goalH.

// CONFIG factory DEFAULTS() + MATCH_DEFAULT() -> ./modules/config.js (imported at top).
// `cfg` (the live mutable instance) is owned HERE; DEFAULTS() just seeds/merges it.
let cfg = DEFAULTS();


// ---- boot -------------------------------------------------------------------
init().catch((e) => fail(e.message || String(e)));

// LOADING SPINNER — shown from initial load; hidden once the scene is TRULY ready: the first real
// frame has rendered (composer.render() succeeded → _glHealthy) AND both HUD flags have finished
// loading (the owner flagged flags as slow). img.complete is true after a load OR an error, so a 404
// flag can't wedge it; forceHideSpinner (safety timeout) hides it after 10s no matter what.
let _firstFrameRendered = false, _spinnerHidden = false;
function maybeHideSpinner() {
  if (_spinnerHidden || !_firstFrameRendered) return;
  const flagDone = (id) => { const img = el(id); return !img || !img.getAttribute('src') || img.complete; };
  if (!flagDone('hFlag') || !flagDone('aFlag')) return;
  _spinnerHidden = true;
  const sp = el('loadSpinner'); if (sp) sp.classList.add('hidden');
}
function forceHideSpinner() { _spinnerHidden = true; const sp = el('loadSpinner'); if (sp) sp.classList.add('hidden'); }

async function init() {
  if (!window.WebGLRenderingContext) throw new Error('WebGL not available');

  // load precedence: URL #cfg= (explicit share link, DEV-ONLY) > saved localStorage
  // (user's SAVE) > built-in "Матч" default.
  // PROD ignores any inbound #cfg entirely (renders canonical defaults) — the hash is a dev
  // tuning artefact; a shared/polluted link must never override the live look. Gated on DEV.
  cfg = (DEV && loadCfgFromHash()) || loadCfgFromStore() || MATCH_DEFAULT();
  // PROD hygiene: if a stray/polluted #cfg= tail arrived on a shared link (from before this
  // guard), scrub it from the address bar so the URL reads clean. DEV keeps its hash intact.
  if (!DEV && /cfg=/.test(location.hash || '')) clearHash();

  let tlDoc = null;
  try { tlDoc = await fetch('/api/timeline/' + ID).then((r) => (r.ok ? r.json() : null)); } catch { tlDoc = null; }
  if (!tlDoc || !Array.isArray(tlDoc.events) || !tlDoc.events.length) {
    throw new Error('timeline ' + ID + ' missing (need /api/timeline/' + ID + ')');
  }
  timelineDoc = tlDoc;   // keep the raw loaded doc around (coolingBreaks() reads doc-level break timing from it if present)
  teamMeta.home = tlDoc.home || teamMeta.home;
  teamMeta.away = tlDoc.away || teamMeta.away;
  teamMeta.duration = Number.isFinite(tlDoc.fullT) ? tlDoc.fullT : 100;
  // PERF — issue the two HUD flag requests AS EARLY AS POSSIBLE. setTeamFlags() (below, after
  // all the three.js/init work) would otherwise be the first place the flag PNGs are requested,
  // so they'd only start fetching once the big JS has finished parsing. Set .src here — the URL
  // is byte-identical to what setTeamFlags() computes (same flagSrc()), so this is a cache hit
  // both from the gallery and when setTeamFlags() runs again. setTeamFlags() stays idempotent.
  try {
    const _hf = el('hFlag'), _af = el('aFlag');
    const _hs = flagSrc(teamMeta.home.abbr, teamMeta.home.name);
    const _as = flagSrc(teamMeta.away.abbr, teamMeta.away.name);
    if (_hf && _hs) _hf.src = _hs;
    if (_af && _as) _af.src = _as;
  } catch {}
  // POST-MATCH PENALTY SHOOTOUT (only present on matches that went to penalties) → per-team
  // ordered scored/missed for the .shoot rings under each team. Absent → block stays empty.
  if (Array.isArray(tlDoc.shootout) && tlDoc.shootout.length) {
    shootoutOrder = tlDoc.shootout.map((k) => ({ team: k.team, scored: !!k.scored, player: k.player || null }));
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
  // LIFT near-BLACK team colours (Germany's black, etc.) to a visible neutral GREY — pure black
  // reads as a dead "hole" on the dark pitch. Genuinely coloured teams are untouched. If BOTH
  // teams are near-black, give them two DISTINCT greys so the halves still read apart.
  {
    // DARK team colours read as washed-out "holes" on the dark pitch. LIFT them: a near-NEUTRAL
    // dark (a black KIT, e.g. New Zealand) → kept clearly DARK (off pure black, not grey — so a
    // white-vs-black match reads with strong luminance contrast); a SATURATED dark (dark green/navy)
    // → the SAME hue raised in LIGHTNESS so it reads as its true colour. Bright colours untouched.
    // Two near-identical darks can't co-occur here: build_timeline's clash logic (which now tests
    // the RENDERED/lifted colours) already switches the away team off any pair that would collide.
    FRA_HEX = _lift(THREE, FRA_HEX);
    SEN_HEX = _lift(THREE, SEN_HEX);
  }
  COL_HOME.set(FRA_HEX); COL_AWAY.set(SEN_HEX);
  timeline = buildTimelineFromDoc(tlDoc);
  ballLocus = buildBallLocus(timeline);
  countGoals();
  buildFootballMinuteTable();   // expanded-clock → football-minute map for the on-screen clock
  buildDramaticClock();      // importance curve I(t) + warped playback mapping W(t)
  buildPenWarp();            // PENBEAT — insert fixed beat blocks at each in-match penalty (needs the warp)

  // STAGE11 CHANGE #6 — REAL per-minute momentum for the bottom pulse strip. The
  // timeline doc carries no momentum, so fetch the RICH record (has momentum:
  // [{minute,value,valueNorm}], +home/−away). Best-effort: if it's missing the strip
  // simply draws the playhead over an empty ribbon (no mock data is fabricated).
  try {
    const rich = await fetch('/api/rich/' + ID).then((r) => (r.ok ? r.json() : null));
    if (rich && Array.isArray(rich.momentum)) momentum = rich.momentum
      .map((d) => ({ minute: Number(d.minute) || 0, v: Number(d.valueNorm) || 0 }))
      .filter((d) => Number.isFinite(d.minute));
    // real ball-possession % (backfilled from FotMob into the rich record) for the post-match stats
    if (rich && rich.possession && Number.isFinite(rich.possession.home)) matchPossession = rich.possession;
    if (rich && Array.isArray(rich.shots)) richShots = rich.shots;   // player names for the xG-peak labels
  } catch { momentum = []; }
  buildGoalScorers();        // resolve each goal's scorer NAME by team+order (robust to minute/xg drift)
  backfillPenTakers();       // PENBEAT — now that scorers + rich shots exist, resolve each pen's TAKER name
  buildXgLabels();           // floating player-name labels on the strongest xG peaks
  buildGoalMarkers();        // STAGE11 CHANGE #5 — persistent goal-token row (open-play/penalty)
  buildMatchStats();         // aggregate post-match stats (shown after the animation settles)
  if (CARD_PULSE) { await loadPlayerPhotos(); buildScorerPhotos(); window.__scorerPhotos = scorerPhotos; }   // PROD-DEFAULT — scorer photo card at each goal (was ?dev, now live)

  setupThree();
  buildCloth();
  setupComposer();
  _probeStartLevel();   // SMOOTH-WEAK (A1) — start at the settling tier so the first frames are the settled look (no visible step-down). No-op on strong/mobile/capture.
  bindGlobalUI();
  setupCrowdAudio(ID);   // IN-PAGE CROWD AUDIO — lazy-load /audio/<id>.{json,mp3}; hides the SOUND control if absent
  buildLayerUI();
  setupHudLayout();
  setupOverlays();           // STAGE11 #5/#6 — the two 2D canvas overlays (markers + pulse)
  if (CARD_PULSE) buildTimelineIcons();   // PROD-DEFAULT — event-marker layer on the seismograph (goals/reds/subs), was ?dev
  initHowRead({ el, HOWEDIT, HOWEDIT_KEY });   // "how to read it" explainer — UNGATED, live for ALL visitors (hover on desktop, tap on mobile). The ?howedit=1 coordinate EDITOR inside it stays dev-only (gated on HOWEDIT). Moved to ./modules/howread.js.

  el('hAbbr').textContent = teamMeta.home.abbr || '';   // no FRA/SEN placeholder — real teams only (2026-07-14, kill the load flash)
  el('aAbbr').textContent = teamMeta.away.abbr || '';
  setTeamFlags();            // STAGE11 CHANGE #7 — flags beside the names
  // LOADING SPINNER — re-check readiness when a (slow) flag image finishes; safety-hide after 10s.
  try { for (const id of ['hFlag', 'aFlag']) { const img = el(id); if (img) { img.addEventListener('load', maybeHideSpinner); img.addEventListener('error', maybeHideSpinner); } } } catch {}
  setTimeout(forceHideSpinner, 10000);
  document.documentElement.style.setProperty('--home-color', FRA_HEX);
  document.documentElement.style.setProperty('--away-color', SEN_HEX);
  el('title2').textContent =
    `STAGE 12 · ${teamMeta.home.abbr} ${teamMeta.score.home}–${teamMeta.score.away} ${teamMeta.away.abbr}`;

  syncCfgToUI();
  // PERF — DEBOUNCE resize (~150ms trailing). Mobile URL-bar show/hide fires a burst of resize
  // events; coalescing them to ONE onResize avoids thrashing renderer/composer/bloom setSize
  // (render-target reallocation) on every intermediate pixel. Initial layout stays immediate below.
  window.addEventListener('resize', onResizeDebounced);
  onResize();
  requestAnimationFrame(loop);

  // DEV-ONLY — ?pin=<matchMinute> pins the clock to one frame after load (no cross-origin
  // scripting needed), so a dev contact-sheet can embed several goal frames via iframes.
  if (DEV) {
    const pin = new URLSearchParams(location.search).get('pin');
    if (pin != null && Number.isFinite(+pin)) setTimeout(() => { try { window.__setClock(+pin); } catch {} }, 2200);
  }
}

// ============================================================================
// STAGE11 CHANGE #7 — TEAM FLAGS. abbr → ISO code (flagcdn), reused from
// public/matches.js so it includes FRA/SEN and ICO='ci' (Ivory Coast) / NOR='no'
// (Norway). Sets the two <img class="flag"> beside the team names in the HUD.
// ============================================================================
// FLAG table + flagSrc() -> ./modules/flags.js (imported at top)
function setTeamFlags() {
  const hf = el('hFlag'), af = el('aFlag');
  const hs = flagSrc(teamMeta.home.abbr, teamMeta.home.name), as = flagSrc(teamMeta.away.abbr, teamMeta.away.name);
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

// ── WebGL CONTEXT-LOSS RECOVERY ─────────────────────────────────────────────
// PROD BUG FIX. Low-memory phones reclaim WebGL contexts under pressure; three then
// silently stops drawing (render() early-returns while _isContextLost) but our rAF loop
// keeps running, so the DOM HUD (scorer cards + pulse) stays live while the mantle goes
// blank — the exact reported symptom. Previously there was NO handler at all.
//   • on `webglcontextlost`  → preventDefault() (mandatory, else the browser will never
//     fire a restore), pause rendering, and show a quiet, on-brand fallback so the user
//     isn't staring at a broken-looking blank frame.
//   • on `webglcontextrestored` → the scene graph + EffectComposer render targets are gone;
//     the robust, correct recovery is a single reload (guarded so a device that keeps OOMing
//     can't get stuck in a reload loop — after one attempt we leave the manual "Reload" CTA).
let _glFallbackEl = null;
function showGlFallback() {
  if (_glFallbackEl) { _glFallbackEl.style.display = 'flex'; return; }
  const o = document.createElement('div');
  o.id = 'glfallback';
  o.style.cssText = 'position:fixed;inset:0;z-index:70;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;gap:16px;text-align:center;padding:40px;' +
    'background:rgba(4,5,10,0.86);backdrop-filter:blur(3px);' +
    "font-family:'Space Grotesk',system-ui,sans-serif;color:#e9e7f4;pointer-events:auto;";
  const h = document.createElement('div');
  h.style.cssText = 'font-size:15px;letter-spacing:.04em;max-width:340px;line-height:1.5;color:#c8c4dc;';
  h.textContent = 'The 3D visualisation was paused by your device to free up memory.';
  const b = document.createElement('button');
  b.textContent = 'Reload';
  b.style.cssText = 'pointer-events:auto;cursor:pointer;border:1px solid rgba(255,255,255,.28);' +
    'background:rgba(255,255,255,.06);color:#fff;border-radius:9px;padding:9px 20px;' +
    "font:600 13px 'Space Grotesk',system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;";
  b.addEventListener('click', () => location.reload());
  o.appendChild(h); o.appendChild(b);
  document.body.appendChild(o);
  _glFallbackEl = o;
}
function hideGlFallback() { if (_glFallbackEl) _glFallbackEl.style.display = 'none'; }
// Probe the real GPU renderer string on a THROWAWAY WebGL context (so the main renderer's
// antialias can be chosen from it — AA is fixed at context creation). Returns '' if blocked.
function probeGPURenderer() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return '';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const s = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : (gl.getParameter(gl.RENDERER) || '');
    const lose = gl.getExtension('WEBGL_lose_context'); if (lose) { try { lose.loseContext(); } catch {} }
    return s || '';
  } catch { return ''; }
}
function installContextLossHandling(canvas) {
  if (!canvas) return;
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();          // REQUIRED — lets the browser attempt a restore later.
    glLost = true;
    // RELOAD GUARD (#7) — if we NEVER rendered a healthy frame, this GPU is choking at the
    // current quality. PIN the next attempt to the floor so it can't OOM-loop at full quality.
    if (!_glHealthy) { try { sessionStorage.setItem('glStartFloor', '1'); } catch {} }
    showGlFallback();
  }, false);
  canvas.addEventListener('webglcontextrestored', () => {
    glLost = false;
    // RELOAD GUARD (#7) — only auto-reload if the piece WAS healthy before the loss (it worked,
    // then the GPU died → a clean rebuild recovers it). If it was lost BEFORE the first healthy
    // render, don't reload at full quality repeatedly; reload ONCE pinned to the floor (the
    // glStartFloor flag set above → startLevel=FLOOR on the next load), else show the manual CTA.
    let everHealthy = false;
    try { everHealthy = _glHealthy || sessionStorage.getItem('glWasHealthy') === '1'; } catch { everHealthy = _glHealthy; }
    let tries = 0;
    try { tries = +(sessionStorage.getItem('glRestoreTries') || 0); } catch {}
    const cap = everHealthy ? 2 : 1;   // never-healthy devices get a single floor-quality retry, not a flurry
    if (tries < cap) {
      try { sessionStorage.setItem('glRestoreTries', String(tries + 1)); } catch {}
      location.reload();
    } else {
      showGlFallback();          // keep the manual "Reload" CTA; don't loop reloads on a chronically-OOM device.
    }
  }, false);
}

// ============================================================================
// THREE setup (cloned from stage9)
// ============================================================================
function setupThree() {
  const canvas = el('stage');
  // ADAPTIVE — PROBE the real GPU string on a THROWAWAY context BEFORE creating the main
  // renderer, because `antialias` is fixed at context creation and we want it OFF on weak/
  // software GPUs. WEBGL_debug_renderer_info exposes UNMASKED_RENDERER_WEBGL in Chromium.
  GPU_STR = probeGPURenderer();
  GPU_CLASS = classifyGPU(GPU_STR);
  // Test/diagnostic overrides: ?gpu=software|strong|weak|unknown forces the class; ?qstart=N
  // forces the starting ladder index. Lets Playwright exercise the ladder from any start.
  try {
    const q = new URLSearchParams(location.search);
    const g = (q.get('gpu') || '').toLowerCase();
    if (g && ['software', 'strong', 'weak', 'unknown'].includes(g)) GPU_CLASS = g;
    // A prior context-loss BEFORE the first healthy render pins the reloaded attempt to the
    // floor (see installContextLossHandling / reload guard) so it can't OOM-loop.
    if (sessionStorage.getItem('glStartFloor') === '1') GPU_CLASS = 'software';
  } catch {}
  // STARTING LEVEL from the GPU class — a HINT for where to BEGIN, never a ceiling. The class picks
  // a SAFE-but-good-looking start; the runtime controller then climbs to full quality on any device
  // that PROVES headroom (see _qMaxLevel below) and drops only if it genuinely can't hold.
  //  · strong   → 0 (full award look, pinned — a discrete GPU never needs to move).
  //  · software → floor (genuine software rasteriser: the soft-but-smooth graceful floor).
  //  · low-end  → 3 (deviceMemory≤3 GB is a real "constrained" signal → start one rung safer).
  //  · everyone else (weak / UNKNOWN) → 2, the MEDIAN good-looking start: FULL grid + crisp DPR +
  //    shadows, looks GOOD from the first frames, then climbs to 0/1 on headroom or steps down if it
  //    can't hold. This is the critical path for the ~43% iOS-Safari audience: iOS MASKS the WebGL
  //    renderer (generic "Apple GPU" → 'weak', or an empty string → 'unknown'), so classification is
  //    unreliable for half of real users — both land on this good-looking mid tier and are then driven
  //    purely by MEASURED frame time (A-series GPUs typically climb to the full look within seconds).
  // DESKTOP HARDWARE-INTEGRATED (weak/unknown, not a phone) → start on a CHEAP but UNCAPPED effects
  // tier (level 5: bloom off, shadows off, cheap fragment, NO frame cap). DPR is DECOUPLED here and
  // sharp-climbed toward native separately (see _desktopDprPath), so the visitor gets the SHARP,
  // 60fps, full-detail look with only the lowest-priority effects trimmed — matching the owner's
  // priority (detail + sharpness ≫ glow/shadows) and avoiding the capped 6/7 rungs (a hardware GPU
  // should not have its fps capped). The effects level is PINNED (see _qMaxLevel below) so it never
  // climbs into the expensive shadow/bloom/PBR tiers it can't hold — that climb→regress was the
  // owner's "гуляло" (visible wandering). Mobile weak/unknown keeps the median start + its own path.
  const _deskWeak = !IS_MOBILE_TIER && (GPU_CLASS === 'weak' || GPU_CLASS === 'unknown');
  let start = GPU_CLASS === 'strong' ? QL_STRONG
            : GPU_CLASS === 'software' ? QL_FLOOR
            : _deskWeak ? QL_DESKTOP_WEAK
            : IS_LOW_END ? QL_WEAK
            : QL_MEDIAN;
  try { const qs = new URLSearchParams(location.search).get('qstart'); if (qs != null && qs !== '') start = clamp(+qs | 0, 0, QL_FLOOR); } catch {}
  _qLevel = clamp(start, 0, QL_FLOOR);
  // PERF — pick the INITIAL terrain grid from the START LEVEL (BEFORE any geometry / DataTexture is
  // built). Unlike the old build this is NOT fixed for the session: rebuildTerrainGrid() promotes/
  // demotes it as the level moves (unless ?grid pins it).
  configureGrid(_qLevel);
  // CEILING FIX — the step-UP ratchet may climb to the TOP of the ladder (0) on ANY device that
  // sustains headroom. The old code pinned _qMaxLevel to the START level, so a 'weak'/integrated GPU
  // (or a mislabelled capable one) could NEVER reach full quality even with 60fps to spare — the
  // owner's "quality still poor on a now-capable GPU" bug. Classification is a start hint, not a cap.
  // (The regress-guard still LOCKS the climb at the first tier that measurably regresses, so a device
  // that truly can't hold a higher tier settles cleanly without oscillating.)
  _qMaxLevel = 0;
  // DESKTOP WEAK/UNKNOWN — PIN the effects level (no step-UP into expensive shadow/bloom/PBR tiers it
  // can't hold, which was the visible wandering). Setting the ratchet ceiling to the start level makes
  // `_qLevel > _qMaxLevel` false forever → step-UP is inert; the step-DOWN safety still works if the
  // device genuinely can't hold even this cheap tier. All sharpness recovery happens on the DECOUPLED
  // DPR climb instead. (?qstart overrides `start` above but we still pin to whatever it resolved to.)
  if (_deskWeak) _qMaxLevel = _qLevel;
  const L0 = QUAL_LADDER[_qLevel];
  DPR_CAP = L0.dpr; fieldStride = L0.stride;
  AA_ON = GPU_CLASS === 'strong';     // only the confirmed-strong desktop gets MSAA (integrated/software → off)
  try { console.info(`[stage13] GPU="${GPU_STR}" class=${GPU_CLASS} startLevel=${_qLevel} dprCap=${DPR_CAP} aa=${AA_ON}`); } catch {}
  maybeShowHwAccelHint();   // DESKTOP + software renderer → one-time "enable hardware acceleration" nudge
  renderer = new THREE.WebGLRenderer({
    // alpha:true gives the canvas an alpha buffer so the PORTRAIT/REELS full-bleed fix can
    // make the (CSS-scaled) #stage TRANSPARENT and let the full-bleed CSS #backdrop show
    // through. All non-portrait modes keep clearAlpha=1 (opaque), so they are visually
    // identical to before.
    // ADAPTIVE — antialias only on a confirmed-strong desktop; weak/software GPUs pay too much
    // for MSAA. (Fixed at context creation, so it's decided from the probed GPU class above.)
    canvas, antialias: AA_ON, alpha: true, powerPreference: 'high-performance',
  });
  installContextLossHandling(canvas);   // PROD BUG FIX — recover/surface a lost GPU context (see IS_LOW_END note).
  // FLOAT-TEXTURE FILTER capability probe (see FLOAT_LINEAR_OK note). Works for both WebGL1
  // and WebGL2 contexts: the extension name is the same. If missing (or forced off for
  // testing), the blankets drop to NearestFilter so they still render on older mobile GPUs.
  try {
    const gl = renderer.getContext();
    FLOAT_LINEAR_OK = !FORCE_NO_FLOAT_LINEAR && !!gl.getExtension('OES_texture_float_linear');
  } catch { FLOAT_LINEAR_OK = !FORCE_NO_FLOAT_LINEAR; }
  if (!FLOAT_LINEAR_OK) console.warn('[stage13] OES_texture_float_linear unavailable — blanket fields fall back to NearestFilter.');
  renderer.setPixelRatio(effectiveDPR());   // PERF — cap DPR (tier cap + a hard 2.0 mobile ceiling): crisp on retina phones without the full native-DPR shaded-pixel cost.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  buildSky();                       // dynamic score-tinted gradient sky (see updateSky)
  // STAGE13 FIX — the score-tinted 2D composition is drawn as scene.background, which three
  // renders as a FLAT full-screen pass (screen-space, undistorted). This fills the whole
  // full-bleed viewport with ONE continuous, layered atmosphere. (The old spherical sky DOME
  // is removed: a sphere's UV mapping flattened the off-centre pools into a plain centred
  // ellipse — the opposite of the rich, asymmetric background we want.)
  scene.background = skyTex;
  // STAGE11 CHANGE #2 — the score-tinted sky must sit as a true BACKDROP BEHIND the
  // whole composition. scene.background already draws at infinite depth, but to make it
  // unambiguously a background layer (and to keep a soft lit dome around the pitch that
  // can never intersect/occlude it), add a LARGE inward-facing sky DOME carrying the
  // same gradient texture: radius far beyond the scene, BackSide, depthWrite off,
  // renderOrder −1 (drawn first), fog off. It surrounds everything and shares the sky's
  // score-tint (buildSky/updateSky repaint skyTex, which this dome samples).
  // (sky DOME removed — scene.background above IS the full-screen atmosphere now)
  // STAGE11 CHANGE #2 — fog kept MINIMAL (0.018→0.010) and NEUTRAL (updateSky no longer
  // leans its colour toward the leader) so it never washes the pitch's true colours. The
  // score-tint glow lives in the full-bleed CSS backdrop halo + the sky dome, not the fog.
  scene.fog = new THREE.FogExp2(0x05070d, 0.010);

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
  // ADAPTIVE — mark interaction so the controller EXCLUDES orbit/dolly frames (their spikes are
  // not steady-state cost). Use start/end (actual pointer drag), NOT 'change' — with damping,
  // 'change' fires every frame during the settle, which would permanently mask the frame budget.
  controls.addEventListener('start', () => { _interacting = true; _lastInteract = performance.now(); });
  controls.addEventListener('end', () => { _interacting = false; _lastInteract = performance.now(); });

  keyLight = new THREE.DirectionalLight(0xffffff, 3.1);   // stage7: 1.0 + light(0.7)*3.0
  keyLight.position.set(-9, 14, 7);
  // ADAPTIVE — shadow depth-map size from the STARTING quality level (0 → shadows off).
  const _sh0 = QUAL_LADDER[_qLevel].shadow;
  keyLight.castShadow = _sh0 > 0;
  keyLight.shadow.mapSize.set(_sh0 > 0 ? _sh0 : 512, _sh0 > 0 ? _sh0 : 512);   // PERF/OOM — a smaller depth map is a fraction of the VRAM/fill of 2048²; shadows stay clean at this framing.
  keyLight.shadow.camera.near = 1; keyLight.shadow.camera.far = 60;
  const sc = keyLight.shadow.camera;
  sc.left = -14; sc.right = 14; sc.top = 12; sc.bottom = -12; sc.updateProjectionMatrix();
  keyLight.shadow.bias = -0.0008; keyLight.shadow.normalBias = 0.04; keyLight.shadow.radius = 6;
  scene.add(keyLight, keyLight.target);

  scene.add(new THREE.DirectionalLight(0x9fc0ff, 0.6).translateX(8).translateY(5).translateZ(-7));
  const rim = scene.children[scene.children.length - 1]; rim.position.set(8, 5, -7);
  // STAGE13 PREMIUM LIGHT LIFT — the ground/trough colour of the hemisphere was near-black
  // (0x0a0d16), so shadowed valleys between shot-peaks crushed to black and lost their team
  // hue. Lift the ground tone so troughs keep colour, and add a soft AmbientLight (there was
  // NONE) as a gentle fill so no valley reads pure black. Both are SUBTLE fills — they raise
  // the floor of the shadows without flattening the peaks (the key light still defines relief).
  scene.add(new THREE.HemisphereLight(0x6f86b0, 0x54507e, 0.47));   // ground lifted 0x0a0d16 → 0x54507e (keeps trough colour)
  scene.add(new THREE.AmbientLight(0x9aa0d0, 0.40));                // soft cool fill so shadowed valleys don't crush to black
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
// dark neutral void endpoints — the base gallery atmosphere. STAGE13 FIX: nudged off pure
// blue toward a deep neutral PLUM so the full-bleed background reads as a rich gallery void
// (not a cold blue cast) and blends cleanly with any leader hue.
const SKY_TOP = new THREE.Color('#0d0e1c');
const SKY_MID = new THREE.Color('#0a0812');
const SKY_BOT = new THREE.Color('#06040a');
// A WHITE / near-neutral-LIGHT leader kit (e.g. England #EAEAEC) has almost no chroma, so a raw
// additive-white glow reads as a flat grey brighten. Steer a light leader's atmosphere toward this
// clean COOL PEARL so it glows as a crisp luminous "white kit" mood — clearly LIGHTER than the
// cool-indigo neutral floor and unmistakably not the opponent's saturated hue.
const SKY_LIGHT_LEADER = new THREE.Color('#e6ecfb');
function buildSky() {
  // STAGE13 FIX — the sky dome now fills the WHOLE viewport (full-bleed canvas), so this
  // texture IS the page background. A 16×256 vertical strip reads as a plain one-point
  // radial; instead paint a real 2D composition (layered off-centre pools + a diagonal
  // wash) onto a larger canvas so the background is rich + asymmetric, never simplistic.
  skyCanvas = document.createElement('canvas'); skyCanvas.width = 512; skyCanvas.height = 512;
  skyCtx = skyCanvas.getContext('2d');
  skyTex = new THREE.CanvasTexture(skyCanvas);
  skyTex.colorSpace = THREE.SRGBColorSpace;
  skyTex.wrapS = THREE.ClampToEdgeWrapping; skyTex.wrapT = THREE.ClampToEdgeWrapping;
  paintSky(0, new THREE.Color('#000000'), 0);   // initial neutral paint
}
// STAGE13 FIX — the old spherical sky DOME was REMOVED. Its sphere UV mapping flattened the
// off-centre gradient pools into a plain centred ellipse (the opposite of the rich, asymmetric
// full-page atmosphere we want). The score-tinted 2D composition (paintSky) is now drawn as
// scene.background, which three renders as a FLAT screen-space fill — one continuous, layered
// background edge-to-edge, undistorted, filling the full-bleed canvas.
const _sc0 = new THREE.Color(), _sc1 = new THREE.Color(), _sc2 = new THREE.Color();
const _tintCol = new THREE.Color();
// paint the gradient: lean (−1..+1) picks the leader colour + strength; tintCol is the
// leader hue; flash (0..1) washes the whole sky toward the card colour.
const _scFlash = new THREE.Color();
function paintSky(lean, tintCol, flash) {
  // STAGE13 FIX — a COMPLEX, beautiful full-page atmosphere (the dome fills the whole
  // viewport now). NOT a single straight radial from one point: we layer a diagonal
  // base wash + several soft OFF-CENTRE leader-tinted pools of different size/opacity, so
  // the background has depth + asymmetry across the frame while staying calm enough that
  // the field stays the star. A draw/0-0 (strength≈0) leaves an elegant near-neutral void
  // with a whisper of cool/warm variation; a clear leader washes the pools toward its hue.
  const S = 512;
  const ctx = skyCtx;
  const strength = Math.abs(lean);
  // ---- palette: deep void endpoints, gently varied by tint strength ----
  // STAGE13 — score-tint SOFTENED (owner: background read too aggressive/saturated). The base
  // wash takes a gentler dose of the leader hue so the horizon stays a calm premium void rather
  // than a saturated colour field. (Was 0.10 / 0.15 / 0.24.)
  _sc0.copy(SKY_TOP).lerp(tintCol, 0.06 * strength);   // upper void
  _sc1.copy(SKY_MID).lerp(tintCol, 0.09 * strength);   // mid
  _sc2.copy(SKY_BOT).lerp(tintCol, 0.15 * strength);   // horizon/base
  const f = clamp(flash, 0, 1) * 0.6;
  if (f > 0) { _sc0.lerp(skyFlashCol, f); _sc1.lerp(skyFlashCol, f * 0.85); _sc2.lerp(skyFlashCol, f * 0.7); }
  const hx0 = '#' + _sc0.getHexString(), hx1 = '#' + _sc1.getHexString(), hx2 = '#' + _sc2.getHexString();
  // ---- 1) base: a soft DIAGONAL wash (top-left cooler void → bottom-right deeper),
  //         not a vertical strip, so nothing reads as a straight one-axis gradient. ----
  const base = ctx.createLinearGradient(S * 0.12, 0, S * 0.9, S);
  base.addColorStop(0.0, hx0);
  base.addColorStop(0.52, hx1);
  base.addColorStop(1.0, hx2);
  ctx.fillStyle = base; ctx.fillRect(0, 0, S, S);
  const prevComp0 = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'lighter';
  // ---- 1b) NEUTRAL ATMOSPHERE FLOOR — so a DRAW / 0-0 is never dead-flat black but a rich
  //          gallery void. Two whisper-soft desaturated accents (a cool indigo upper-left, a
  //          faint warm ember lower-right) give depth + a hint of colour temperature. They
  //          FADE OUT as a leader tint takes over (fade = 1-strength), so a clear leader's
  //          own pools dominate and this never muddies a saturated score-tint. ----
  const floorFade = (1 - Math.min(1, strength)).toFixed(3);
  const floorPools = [
    // [cx, cy, radius, alpha, r,g,b]
    [0.32, 0.28, 0.85, 0.30, 78, 104, 168],   // cool indigo glow, upper-left (primary)
    [0.74, 0.82, 0.78, 0.22, 168, 100, 86],   // warm ember pool, lower-right
    [0.86, 0.26, 0.48, 0.13, 96, 116, 172],   // cool accent, upper-right
    [0.14, 0.66, 0.46, 0.10, 120, 92, 150],   // faint violet counter-pool, lower-left
  ];
  for (const [cx, cy, rad, a, r, g, bl] of floorPools) {
    const aa = (a * floorFade).toFixed(3);
    const gr = ctx.createRadialGradient(cx * S, cy * S, 0, cx * S, cy * S, rad * S);
    gr.addColorStop(0.0, `rgba(${r},${g},${bl},${aa})`);
    gr.addColorStop(0.5, `rgba(${r},${g},${bl},${(a * 0.35 * floorFade).toFixed(3)})`);
    gr.addColorStop(1.0, `rgba(${r},${g},${bl},0)`);
    ctx.fillStyle = gr; ctx.fillRect(0, 0, S, S);
  }
  ctx.globalCompositeOperation = prevComp0;
  // ---- 2) layered off-centre leader-tinted POOLS — the "rich" part. Each is a soft
  //         radial of a different centre/size/alpha; screen-blended so they build a
  //         luminous, asymmetric atmosphere rather than one disc. Strength scales alpha,
  //         so a draw is subtle and a strong leader glows. ----
  const tint = _rgb(tintCol);
  const pools = [
    // [cx, cy, radius, innerAlpha, midStop]  — in 0..1 canvas fractions
    [0.30, 0.30, 0.72, 0.30, 0.38],   // primary glow, upper-left, large & soft
    [0.78, 0.24, 0.48, 0.16, 0.34],   // secondary, upper-right, tighter
    [0.62, 0.82, 0.66, 0.20, 0.40],   // deep pool lower-centre-right (horizon warmth)
    [0.14, 0.74, 0.40, 0.12, 0.36],   // faint lower-left counter-pool (breaks symmetry)
  ];
  const prevComp = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'lighter';   // additive → luminous layering
  // STAGE13 — leader-pool alpha SOFTENED (owner: background too aggressive). Lower the base
  // presence AND the score-driven lift so even a strong leader glows GENTLY, not punchy. This
  // is the dominant tint element, so the calming happens mostly here. (Was 0.32 + 0.68*strength.)
  const poolLift = 0.24 + 0.40 * strength;
  for (const [cx, cy, rad, ia, ms] of pools) {
    const a0 = (ia * poolLift).toFixed(3);   // base presence + score lift (softened)
    const gr = ctx.createRadialGradient(cx * S, cy * S, 0, cx * S, cy * S, rad * S);
    gr.addColorStop(0.0, `rgba(${tint},${a0})`);
    gr.addColorStop(ms, `rgba(${tint},${(ia * 0.4 * poolLift).toFixed(3)})`);
    gr.addColorStop(1.0, `rgba(${tint},0)`);
    ctx.fillStyle = gr; ctx.fillRect(0, 0, S, S);
  }
  // ---- 3) card FLASH pool — a brief bright wash centred high, over the pools ----
  if (f > 0.01) {
    _scFlash.copy(skyFlashCol); const ft = _rgb(_scFlash);
    const gf = ctx.createRadialGradient(S * 0.5, S * 0.32, 0, S * 0.5, S * 0.32, S * 0.8);
    gf.addColorStop(0.0, `rgba(${ft},${(f * 0.55).toFixed(3)})`);
    gf.addColorStop(1.0, `rgba(${ft},0)`);
    ctx.fillStyle = gf; ctx.fillRect(0, 0, S, S);
  }
  ctx.globalCompositeOperation = prevComp;
  // NOTE: NO corner vignette painted here — the post-processing GradeShader (uVig) already
  // darkens the screen corners. Painting another here would double it into a hard black ring.
  if (skyTex) skyTex.needsUpdate = true;
}
// Update the sky each frame from the current SCORE (leader + margin) at clock t, ease
// the tint toward it (~1s), decay any card flash, detect new cards to flash, and gently
// tint the fog so the whole scene feels lit by the sky. Deterministic tint TARGET from
// t (scrub-safe); the ease + flash decay are dt-smoothed (snap on scrub via dt=Inf).
function updateSky(t, dt) {
  // OG-render hook: force a NEUTRAL dark sky/backdrop (no leader tint) so the social
  // cover reads as an epic dark scene with the blankets popping. Set window.__OG_NEUTRAL.
  if (typeof window !== 'undefined' && window.__OG_NEUTRAL) {
    skyLeanEased = 0;
    paintSky(0, _tintCol, 0);
    if (scene && scene.fog) scene.fog.color.copy(SKY_BOT);
    paintBackdrop(0, 0);
    _lightning.clear();
    return;
  }
  // IN-MATCH PENALTY BEAT (PENBEAT) — during a beat the FIELD goes to the neutral dark shootout
  // stage (uFlood→SHOOT_DARK), so the SKY/backdrop must go with it: NO leader lean, NO card
  // flash, NO red-card lightning — a clean dark stage, not the frozen live sky (which showed the
  // leader-tint magenta wash + a red bolt frozen mid-strike). Ramp the suppression with the beat's
  // `dark` presence (the SETTLE envelope) so the background eases into the dark stage and back on
  // RESUME, exactly like the field. penBeat only exists when !shootActive (the shootout owns its
  // own sky above), so this never fights the shootout path.
  let penDark = 0;
  if (PENBEAT && !shootActive) {
    const _pb = penBeatFromWall(wallProgress);
    if (_pb) penDark = clamp(penBeatVisual(_pb).dark, 0, 1);
  }
  const sc = scoreAt(t);
  let margin = sc.home - sc.away;                     // + = home leads
  // SHOOTOUT SKY — regulation is tied, so the advantage comes from the shootout. CRUCIAL
  // (user rule): advantage arises PER PAIR, not per kick — a lone scored penalty gives NO
  // advantage until its pair (the opponent's reply) is taken. So we count scored kicks only
  // over COMPLETE PAIRS (kicks 2i, 2i+1): a pair where both score (or both miss) is even; a
  // pair where one scores and the other misses swings the lead. The sky leans by that net,
  // and only updates when a pair completes — so the winner's colour washes the sky at the end.
  if (shootActive && shootoutOrder && shootoutOrder.length) {
    const sq = shootoutSeq();
    const rev = sq ? sq.reveal : 0;
    const nPairs = Math.floor(rev / 2);                // completed home+away pairs
    let hs = 0, as = 0;
    for (let k = 0; k < nPairs * 2 && k < shootoutOrder.length; k++) {
      const kk = shootoutOrder[k];
      if (kk && kk.scored) { if (kk.team === 'home') hs++; else if (kk.team === 'away') as++; }
    }
    if (hs !== as) margin = (hs > as ? 1 : -1) * 3;    // net of decisive PAIRS → the shootout leader
  }
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
  // ATMOSPHERE GATE — how strongly the leader hue may wash the near-black sky.
  //   · A muddy MID/DARK GREY leader (e.g. Germany #464646) must NOT wash it — grey-on-black is
  //     just muddy, so it stays suppressed and the void reads neutral.
  //   · BUT a clearly-COLOURED leader (chroma) OR a clearly LIGHT leader (a WHITE/pearl kit like
  //     England #EAEAEC) is a legitimate, distinctive "mood" and MUST show. A white kit has almost
  //     ZERO chroma, so the OLD chroma-only gate zeroed it → England's 1-0 looked identical to the
  //     0-0 neutral (whose floor pools are cool-indigo) i.e. it "stayed blue-ish". FIX: gate on
  //     chroma OR luminance, so a light leader glows as a luminous cool-white atmosphere.
  const chroma = Math.max(lc.r, lc.g, lc.b) - Math.min(lc.r, lc.g, lc.b);
  const lum = 0.2126 * lc.r + 0.7152 * lc.g + 0.0722 * lc.b;
  const colourGate = smoothstep(0.05, 0.22, chroma);   // clearly-COLOURED leader
  const lightGate = smoothstep(0.60, 0.86, lum);        // WHITE/pearl leader (light-on-black is fine)
  const tintable = Math.max(colourGate, lightGate);
  // A very LIGHT + low-chroma leader (white kit): steer its additive glow toward a clean COOL PEARL
  // (SKY_LIGHT_LEADER) so it reads as a crisp luminous "English white" mood — clearly LIGHTER than
  // the cool-blue neutral floor — instead of a flat grey brighten. Coloured leaders are untouched.
  const whiteLeader = lightGate * (1 - colourGate);
  if (whiteLeader > 0.01) _tintCol.lerp(SKY_LIGHT_LEADER, whiteLeader);
  // During a pen beat, drain the leader lean toward 0 (× (1−penDark)) so the sky is a clean dark
  // stage at the SETTLE/PAUSE/HILL peak and eases back to the live lean through RESUME.
  const glowLean = lean * tintable * (1 - penDark);
  // CARD FLASH — a brief scene-wide wash toward the card colour (warm for a booking, red for a
  // sending-off). Live playback fires it via detectCardFlash (dt) then it eases down; a SNAP
  // render derives it deterministically from the wall-time window (_snapFlash). Combine both so
  // the flash reads whether we're playing OR scrubbing to a card minute. On a red it also arms
  // the lightning (drawn separately). skyFlashCol is set inside detect/snap to the right hue.
  detectCardFlash(t, dt);
  skyFlash = Math.max(skyFlash * (1 - expA(dt, 0.16)), _snapFlash(t));
  // The sky/backdrop wash stays RESTRAINED (esp. for a red, so it doesn't become a solid red
  // spotlight) — the drama is carried by the LIGHTNING overlay. Ease the wash to ~0.55 of the
  // raw flash so a red reads as a sharp tinted PULSE, not a saturated field.
  // Card flash also yields to the beat — a flash frozen at the pinned pen minute would wash the
  // clean dark stage (and, on a red, freeze a bolt mid-strike). Scale it out by penDark too.
  const flashF = clamp(skyFlash, 0, 1) * 0.55 * (1 - penDark);
  paintSky(glowLean, _tintCol, flashF);
  // The FOG stays a NEUTRAL deep void (barely any lean) so the pitch/cloth colours stay TRUE;
  // the leader-tint lives in the CSS backdrop halo + the WebGL sky dome. Grey leader → 0.
  if (scene && scene.fog) {
    _tintCol.copy(SKY_BOT).lerp(lc, 0.08 * Math.abs(glowLean));
    scene.fog.color.copy(_tintCol);
  }
  // PORTRAIT/REELS FULL-BLEED FIX — in the vertical CAPTURE (body.capfoot + portrait aspect)
  // the #stage canvas is CSS-scaled to 0.58 into the safe band, so its OPAQUE WebGL sky
  // (scene.background = skyTex) shrinks into a CENTRED RECTANGLE → the "square-in-a-square".
  // Outside that rectangle only the dimmer full-bleed CSS #backdrop showed. FIX: in this mode
  // ONLY, make the WebGL canvas TRANSPARENT (scene.background = null + clearAlpha 0) so the
  // scaled #stage paints NO sky rectangle — the terrain floats over the full-bleed #backdrop,
  // which we drive at FULL glow strength so the score-tint fills the ENTIRE 1080×1920 frame
  // edge-to-edge. Square/landscape/live (no .capfoot OR not portrait) are UNCHANGED. */
  const portraitCap = (typeof document !== 'undefined')
    && document.body.classList.contains('capfoot')
    && (typeof window !== 'undefined')
    && window.matchMedia('(max-aspect-ratio: 3/4)').matches;
  if (portraitCap !== _portraitCapPrev) {
    if (portraitCap) {
      scene.background = null;                 // no opaque WebGL sky rectangle in the scaled canvas
      renderer.setClearColor(0x000000, 0);     // transparent canvas → CSS #backdrop shows through
      // Carry the transparency THROUGH the post chain: the RenderPass must clear its target
      // with alpha too, and the grade pass must PRESERVE (not force-opaque) the source alpha.
      // Otherwise the composer composites the scaled #stage onto opaque black → the visible
      // "square-in-a-square". (Non-portrait keeps clearAlpha=0/1 as before; uKeepAlpha=0.)
      if (renderPass) { renderPass.clearAlpha = 0; }
      if (gradePass) gradePass.uniforms.uKeepAlpha.value = 1.0;
    } else {
      scene.background = skyTex;               // restore the full-viewport WebGL sky (all other modes)
      renderer.setClearColor(0x000000, 1);
      if (renderPass) { renderPass.clearAlpha = 1; }
      if (gradePass) gradePass.uniforms.uKeepAlpha.value = 0.0;
    }
    _portraitCapPrev = portraitCap;
  }
  // In portrait-capture the CSS #backdrop is the SOLE score-tint layer, so drive it at full
  // strength (amplify the lean toward ±1) so the glow reads strong edge-to-edge; other modes
  // keep the restrained halo (the WebGL sky carries the main tint there).
  const bdLean = portraitCap
    ? Math.sign(glowLean) * Math.min(1, Math.abs(glowLean) * 1.9 + 0.10)
    : glowLean;
  paintBackdrop(bdLean, flashF);
  // RED-card bolt overlay (no-op / clears when no red is striking). During a pen beat the clock is
  // FROZEN, so a red near the pinned minute would freeze a bolt mid-strike across the clean dark
  // stage — suppress it once the beat has settled in (clear any existing bolt).
  if (penDark > 0.5) {
    _lightning.clear();
  } else {
    _lightning.update(t);
  }
}
let _portraitCapPrev = null;   // last portrait-capture state (so the bg toggle runs only on change)
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
// _rgb() -> ./modules/util.js (imported at top)
// ============================================================================
// CARD FLASH + RED-CARD LIGHTNING ⚡
// The timeline now carries the real sending-off flag (build_timeline sets `red`).
//   · YELLOW booking → a brief, subtle warm sky/backdrop flash (existing behaviour).
//   · RED sending-off → a dramatic LIGHTNING STRIKE: a jagged forked electric bolt
//     cracks across the frame (full-bleed overlay), the whole scene gets a sharp
//     red-tinged brightness pop, then fast decay (~0.45s, 2–3 strobes).
// Both modes are supported and share ONE deterministic timing basis (wall-seconds
// since the card, via wallSecondsSinceGoal → scrub-safe):
//   (1) LIVE playback — detectCardFlash(t,dt) fires the flash once as the clock passes.
//   (2) SNAP render   — _snapFlash(t) returns the flash intensity for a grabbed frame,
//       and updateLightning(t) draws the bolt mid-strike from the same window.
// The bolt SHAPE is seeded from the card's time so it's identical across redraws.
// ============================================================================
const CARD_FLASH_WALL = 0.55;    // wall-seconds a card washes the sky/backdrop — a SHARP pop, not a lingering red spotlight
const LIGHT_WALL = 0.5;          // wall-seconds a red-card lightning bolt lives
// _cardCol() -> ./modules/util.js (imported at top)
function detectCardFlash(t, dt) {
  if (!cardEvents || !cardEvents.length) return;
  // live playback: fire once when the clock passes a card time.
  // YELLOWS ARE NEVER SHOWN — only a RED sending-off arms the flash + lightning.
  if (Number.isFinite(dt) && dt > 0) {
    for (const c of cardEvents) {
      if (!c.red) continue;   // yellow → no flash, no lightning, no visual at all
      if (c.t > _lastCardT && c.t <= t && (t - c.t) < 0.5) {
        skyFlashCol.set(_cardCol(c.red));
        skyFlash = 1; _lastCardT = c.t;
      }
    }
    if (t < _lastCardT) _lastCardT = -1;   // looped/rewound → allow re-fire
  }
}
// Deterministic flash intensity (0..1) at clock t + the colour of the active card, from
// the wall-time window. Used on SNAP renders AND to keep the live flash scrub-coherent.
function _snapFlash(t) {
  if (!cardEvents || !cardEvents.length) return 0;
  let best = 0;
  for (const c of cardEvents) {
    if (!c.red) continue;   // yellow bookings produce NO flash (scrub-safe path)
    const elapsedWall = wallSecondsSinceGoal(c.t, t);
    if (Number.isFinite(elapsedWall) && elapsedWall >= 0 && elapsedWall < CARD_FLASH_WALL) {
      const f = 1 - (elapsedWall / CARD_FLASH_WALL);
      if (f > best) { best = f; skyFlashCol.set(_cardCol(c.red)); }
    }
  }
  return best;
}
// ---- LIGHTNING OVERLAY -> ./modules/lightning.js (initLightning factory, imported at top).
// OWNS its own full-viewport <canvas> (lazily created on the first red). Injected accessors are
// allocation-free: getCardEvents() returns the live cardEvents array REFERENCE (no per-frame
// closure/copy) and wallSecondsSinceGoal is passed once. update(t)/size()/clear() replace the
// old inline updateLightning(t)/sizeLightningCanvas()/clearRect(...) — behaviour is byte-identical.
const _lightning = initLightning({
  getCardEvents: () => cardEvents,
  wallSecondsSinceGoal,
});

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
  // OWNER-REJECTED — shot-location dots on the pitch were removed (the terrain must have no
  // accumulating shot circles). buildShotDots()/updateShotDots() are kept defined but never
  // called, so the pitch stays clean in every mode (dev and prod).
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
  // SMOOTH-WEAK (B) — decouple the DRAWN geometry resolution from the FIELD grid. On the coarse
  // low/software rungs the plane is subdivided finer than the height texture (renderGridForField),
  // so the bilinear height sampling reads as a smooth surface at NO extra JS cost. Full grid /
  // strong device → RGX,RGY == GX,GY (award geometry unchanged).
  const [RGX, RGY] = renderGridForField(GX, GY);
  const geo = new THREE.PlaneGeometry(WORLD_X, WORLD_Z, RGX, RGY);
  geo.rotateX(-Math.PI / 2);
  // SMOOTH-WEAK (B/C) — this device is on a coarse low/software rung → take the lighter fragment
  // path (CHEAP) + interpolate the field between recomputes (INTERP). Decided ONCE at build time
  // (the material is rebuilt on every grid change, so CHEAP/INTERP always match the live tier).
  const CHEAP = _cheapFrag();
  const INTERP = CHEAP;
  // LinearFilter for smooth relief on capable GPUs; NearestFilter fallback where
  // OES_texture_float_linear is missing (see FLOAT_LINEAR_OK) so the cloth still renders.
  const fldFilter = FLOAT_LINEAR_OK ? THREE.LinearFilter : THREE.NearestFilter;
  const hData = new Float32Array(NV);
  const hTex = new THREE.DataTexture(hData, VX, VY, THREE.RedFormat, THREE.FloatType);
  hTex.magFilter = fldFilter; hTex.minFilter = fldFilter; hTex.needsUpdate = true;
  // C · PREVIOUS-field height texture (only on the interpolating low tiers). The vertex shader eases
  // the displaced height from this to the live one over each fieldStride interval → the cloth flows.
  let hPrevData = null, hPrevTex = null;
  if (INTERP) {
    hPrevData = new Float32Array(NV);
    hPrevTex = new THREE.DataTexture(hPrevData, VX, VY, THREE.RedFormat, THREE.FloatType);
    hPrevTex.magFilter = fldFilter; hPrevTex.minFilter = fldFilter; hPrevTex.needsUpdate = true;
  }
  const aData = new Float32Array(NV);    // coverage alpha 0..1
  const aTex = new THREE.DataTexture(aData, VX, VY, THREE.RedFormat, THREE.FloatType);
  aTex.magFilter = fldFilter; aTex.minFilter = fldFilter; aTex.needsUpdate = true;
  // CORNER-WAVE tint strength 0..1 per vertex — where a corner ripple crest passes over
  // this sheet, the fragment shader blends the surface toward the ATTACKING colour (uCornerCol).
  const cData = new Float32Array(NV);
  const cTex = new THREE.DataTexture(cData, VX, VY, THREE.RedFormat, THREE.FloatType);
  cTex.magFilter = fldFilter; cTex.minFilter = fldFilter; cTex.needsUpdate = true;

  // OPAQUE sheets: no alpha blending (the old alpha НАХЛЁСТ caused the ugly blur).
  // The seam is a HARD discard (alphaTest 0.5) inside the shader, and depth-test +
  // the per-sheet owner LIP resolve which sheet laps on top — no transparency sort,
  // no z-fighting.
  const mat = new THREE.MeshStandardMaterial({
    // STAGE13 PREMIUM TUNE — softened from stage7's roughness~1.0 / metalness~0.81. That high
    // metalness dulled the team hues (a metal surface reflects the environment instead of
    // showing its own colour) and the full roughness killed any sheen. roughness 0.65 gives a
    // soft satin highlight that reads as premium cloth; metalness 0.5 lets the team colour sing
    // again while keeping a hint of specular. envMapIntensity unchanged so IBL balance holds.
    // SMOOTH-WEAK (B) — the lighter tiers pull back the IBL reflection a touch (cheaper + the soft
    // low-DPR look reads better slightly less glossy) and turn on ORDERED DITHERING to kill the
    // gradient banding a reduced DPR would otherwise show. Strong/full tiers: unchanged award tune.
    color: 0xffffff, roughness: 0.65, metalness: 0.5, envMapIntensity: CHEAP ? 0.85 : 1.24,
    dithering: CHEAP,
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
    // C · previous-field height + ease factor (identity 1.0 / prev==cur off the interp tiers).
    uHeightPrev: { value: hPrevTex || hTex }, uFieldMix: { value: 1.0 },
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
    // GOAL-FLOOD SLIVER FADE — in regulation the goal floods via the swept FRONT (uFlood stays
    // 0). At the flood peak the winner's front reaches the conceded end and its sheet covers the
    // whole pitch, but the LOSING sheet keeps a thin uLap-wide coverage sliver at that edge (a
    // leftover opponent strip). This uniform is set per-frame to the live flood strength ONLY on
    // the conceding sheet (0 on the scorer, 0 in normal play); the shader fades this sheet's
    // coverage out by it, removing the sliver with NO colour recolour. Rises + RECEDES with the
    // front so each half cleanly returns to its own colour after the goal.
    uFloodFade: { value: 0.0 },
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
      ${INTERP ? 'uniform sampler2D uHeightPrev; uniform float uFieldMix; float HBP(vec2 uv){ float h = texture2D(uHeightPrev, uv).r; if(!(h==h)) h=0.0; return h; }' : ''}
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
        // C · ease the DISPLACED height from the previous field to the live one over each
        // fieldStride interval (uFieldMix 0→1) so the relief FLOWS instead of stepping. Off the
        // interp tiers uFieldMix is absent → the exact legacy displacement.
        ${INTERP ? 'float hbDisp = mix(HBP(uv), hb, clamp(uFieldMix, 0.0, 1.0));' : 'float hbDisp = hb;'}
        transformed.y += (hbDisp - uBaseline) + uLipH * vFold;`);
    shader.fragmentShader = `
      uniform vec3 uTeam; uniform float uGlow;
      uniform float uFlood; uniform vec3 uFloodTeam;
      uniform float uFloodFade;                              // GOAL-FLOOD sliver fade (conceding sheet only)
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
        // this sheet's coverage OVERHANG past the front. Normally uLap (a small НАХЛЁСТ so the
        // two sheets tuck under each other with no gap). GOAL-FLOOD SLIVER FIX: on the LOSING
        // sheet, shrink the overhang toward 0 as uFloodFade→1 so at the flood peak the loser
        // covers ONLY up to the front (no uLap sliver at the conceded edge). The cutoff stays a
        // CRISP razor edge the whole time (we move it, we don't dim it) → no partial-alpha
        // flicker under the hard alphaTest. The winner keeps full uLap so there's never a gap at
        // the seam; on the откат uFloodFade recedes and the overhang returns to uLap.
        float lap = uLap * (1.0 - clamp(uFloodFade, 0.0, 1.0));
        // distance from THIS sheet's far cutoff edge (positive = inside coverage).
        float d = mix(lap - vDu, vDu + lap, uAway);   // home: lap−du ; away: du+lap
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
        // plastic flat-matte look without speckle (continuous fbm). SMOOTH-WEAK (B): the low
        // tiers use a single value-noise octave (1 tap vs the 4-octave fbm) — the clay still
        // breaks up but the fill is a fraction of the cost.
        ${CHEAP ? 'float marble = vn_s10(vUvN * 22.0);' : 'float marble = fbm_s10(vUvN * 22.0 + vec2(0.0, uTime * 0.05));'}
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
        // NOTE: the goal flood in regulation is NOT a colour override here — it is driven purely
        // by the swept FRONT (the winner's territory grows to cover the whole pitch) so every cell
        // keeps its own honest per-team colour. The only defect was a thin uLap-wide SLIVER of the
        // LOSING sheet surviving at the conceded edge; that is removed inside covAt() by shrinking
        // the loser's coverage OVERHANG to 0 at the flood peak (uFloodFade) — NOT by recolouring
        // cells. Single colour source (the front) → no double-mix, no latch, clean revert.
        // CORNER WAVE — a transient radial ripple crest (uCorner tex, 0..1, built in
        // computeField from cornerWavesAt) tints THIS cell toward the ATTACKING team's
        // colour (uCornerCol). A faint travelling colour band riding the height ripple —
        // a surface transient, NOT a territory flip (coverage/front are untouched).
        float cw = clamp(texture2D(uCorner, vUvN).r, 0.0, 1.0);
        if (cw > 0.001) col = mix(col, uCornerCol, cw);
        diffuseColor.rgb = col;
        float covEff = covAt();
        // During the shootout flood, force THIS sheet to cover its whole area so the wash
        // colour fills 100% of the pitch (uFlood is the shootout dark→kicker wash; 0 in
        // regulation, so inert in normal play).
        covEff = max(covEff, clamp(uFlood, 0.0, 1.0));
        // (the goal-flood sliver removal happens INSIDE covAt: the loser's coverage overhang is
        //  shrunk to 0 at the flood peak via uFloodFade, so the loser stops painting past the
        //  front — no leftover opponent sliver — with a crisp cutoff, no partial-alpha flicker.)
        diffuseColor.a *= covEff;
      }`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>',
      `if (diffuseColor.a < 0.5) discard;     // OPAQUE: hard binary cut, no alpha blur
       #include <alphatest_fragment>`);
    // STAGE-7 MICRO-ROUGHNESS: modulate roughnessFactor by the same fine clay
    // micro-relief so some patches read duller/shinier. Uniform roughness is the
    // #1 CG/plastic tell — breaking it up gives the rich material look.
    // STAGE-7 MICRO-ROUGHNESS: the HEX pattern grooves read slightly ROUGHER (matte recess) than
    // the raised cells; floor kept well above 0 so nothing turns shiny. Uniform in height → no
    // plastic tell, no band. SMOOTH-WEAK (B): the low tiers DROP this extra pat_s10 eval (the
    // uniform base roughness is close enough, and the fill saving pays for the finer grid).
    if (!CHEAP) shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
       {
         float pr = pat_s10(vUvN * (46.0 * uDetailScale));
         roughnessFactor = clamp(roughnessFactor + uDetail * 0.22 * (0.5 - pr), 0.16, 1.0);
       }`);
    // STAGE-7 MICRO-NORMAL: perturb the shading normal by the screen-space gradient of the SMOOTH
    // HEX pattern height, so grazing IBL catches the fine hex relief and it feels like real clay/
    // stone, not smooth CG plastic. Continuous pat → stable. SMOOTH-WEAK (B): the low tiers DROP
    // this block ENTIRELY — the dFdx/dFdy derivatives + extra pat eval are the single most
    // expensive fragment cost on an integrated/software rasteriser, and the coarse-DPR micro-relief
    // isn't resolvable anyway. This is the biggest fill saving that buys back the finer geometry.
    if (!CHEAP) shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>',
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
         // SMOOTH-WEAK (B): the low tiers DROP the ember (its vn_s10 flicker noise + double
         // smoothstep is fill an integrated GPU can't spare, and the effect is tiny at coarse DPR).
         ${CHEAP ? '' : `vec3 Nw = normalize(vNormal);
         float steep = 1.0 - clamp(Nw.y, 0.0, 1.0);
         float hot = smoothstep(1.2, 3.0, vHd) * smoothstep(0.14, 0.6, steep);
         float flick = 0.82 + 0.18 * vn_s10(vUvN * 40.0 + uTime * 0.7);
         float ember = uEmber * mix(0.18, 1.0, clamp(uIntensity, 0.0, 1.0));
         vec3 hi = uGlowCol * (1.0 + smoothstep(2.0, 3.6, vHd) * 0.5);
         emit += hi * hot * ember * 0.9 * flick * litMul;`}
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
  return { mesh: m, hData, hTex, aData, aTex, cData, cTex, u, hPrevData, hPrevTex };
}
function buildTeamBlankets() {
  blankets = { home: makeBlanket(FRA_HEX, false), away: makeBlanket(SEN_HEX, true) };
  // STAGE13 — give each blanket real THICKNESS: a downward SKIRT (the торец/edge wall) that
  // hangs from the displaced top surface down by SLAB_THICK, so the two territories read as
  // solid slabs of cloth instead of paper-thin sheets. Ported from the stage14 experiment.
  // Built once; shares the top sheet's height/coverage textures + team colour so it welds
  // seamlessly and tracks warps/goal-floods/resets for free (same uniform objects).
  blankets.home.skirt = makeBlanketSkirt(blankets.home, false);
  blankets.away.skirt = makeBlanketSkirt(blankets.away, true);
  _builtCheapFrag = _cheapFrag();   // remember which fragment path these shaders were compiled with (see _syncCheapFrag)
}
// EFFECT-ONLY tier flip — the cheap-vs-full FRAGMENT path is chosen at shader-compile time in
// makeBlanket. When a device SETTLES onto (or climbs out of) a weak rung the _cheapFrag() verdict
// flips, so recompile the blankets (same 160×96 geometry → detail/density untouched, only the shader
// complexity changes). One-time, gated by the controller's hysteresis. No-op when the verdict matches.
function _syncCheapFrag() {
  if (!blankets || _cheapFrag() === _builtCheapFrag) return;
  rebuildTerrainGrid(GX, GY, true);   // force a same-dimension rebuild → shaders recompile with the new fragment path
}
// RUNTIME GRID PROMOTION/DEMOTION — rebuild the two blanket meshes + skirts + their DataTextures at
// a NEW terrain resolution when the adaptive controller crosses a grid tier (see gridForLevel /
// _applyQualityLevel). This is what lets a capable device climb to the full 120×72 award look and a
// struggling one drop to a smooth coarse grid — the grid is no longer frozen at startup. Disposes the
// old GPU resources (geometry/material/textures) so repeated adaptation never leaks VRAM, then snaps
// a fresh field compute so the new textures are populated before the next render (no blank frame).
// Runs at most once per level change (rare, gated by the controller's hysteresis) — a brief one-frame
// hitch that the post-change settle window (_changeSettleUntil) intentionally excludes from the EMA.
function rebuildTerrainGrid(gx, gy, force) {
  if (_gridForced && !force) return;       // ?grid pins the resolution — never rebuild (except a forced fragment-path recompile)
  if (!blankets || (!force && gx === GX && gy === GY)) return;
  for (const key of ['home', 'away']) {
    const b = blankets[key]; if (!b) continue;
    if (b.skirt && b.skirt.mesh) { scene.remove(b.skirt.mesh); try { b.skirt.mesh.geometry.dispose(); b.skirt.mesh.material.dispose(); } catch {} }
    if (b.mesh) { scene.remove(b.mesh); try { b.mesh.geometry.dispose(); b.mesh.material.dispose(); } catch {} }
    for (const t of ['hTex', 'aTex', 'cTex', 'hPrevTex']) { try { if (b[t]) b[t].dispose(); } catch {} }
  }
  blankets = null;
  applyGrid(gx, gy);
  // per-vertex surface buffers are sized to NV — reallocate for the new resolution.
  surfYData = new Float32Array(NV); surfTopH = new Float32Array(NV); surfTopDu = new Float32Array(NV);
  buildTeamBlankets();
  // snap the eased fields + force ONE full field compute so the fresh textures render populated.
  try { snapASmoothing(); computeField(typeof clock === 'number' ? clock : 0, Infinity); } catch {}
}

// ============================================================================
// STAGE13 — SLAB THICKNESS + PREMIUM ТОРЕЦ (edge wall). Ported from stage14.js.
//
// The top blanket is a flat displaced PlaneGeometry (zero thickness → "cheap").
// We add a SKIRT: vertical wall quads along the outer pitch PERIMETER that hang
// from the top surface down by a constant SLAB_THICK, so every visible edge of a
// territory becomes a solid side face. The skirt samples the SAME uHeight/uCov
// textures as the top sheet, so its top rim tracks the relief exactly; its bottom
// rim is that minus the thickness. The internal SEAM is left to the top sheet's own
// raised LIP FOLD (a hung curtain there only fought the under-sheet as picket-fence
// teeth), so we wall ONLY the perimeter — the торец the viewer actually sees.
//
// The wall shader: computes Y from the height texture in the vertex stage, discards
// non-covered fragments, and shades the торец as a premium rim — base-darkening
// gradient toward the contact shadow + a bright micro-bevel highlight at the very
// top rim + goal-flood recolour so a goal floods the walls too (no leftover strip).
// ============================================================================
const SLAB_THICK = 0.15;   // world-Y slab thickness (pitch 16×9.6, ORTHO half-h ~9.2). Thin
                           // premium plate — owner halved it from 0.30 ("ещё в два раза тоньше").
                           // Single knob — tune here.
function makeBlanketSkirt(blanket, isAway) {
  // SMOOTH-WEAK (C) — the top sheet is on the interpolating low path? then ease the wall's top rim
  // with the same uFieldMix so it stays welded to the eased surface (GX matches makeBlanket's tier).
  const INTERP = _cheapFrag() && !!blanket.u.uHeightPrev && blanket.hPrevTex;
  // Emit a vertical wall quad per grid step along each of the 4 pitch borders (the
  // perimeter ring). Each vertex carries its top-rim uv so the shader samples the
  // surface height/coverage there; a `sideT` attribute (0 top rim, 1 bottom rim)
  // tells the shader which vertices to hang SLAB_THICK below the surface.
  const positions = [];
  const uvsTop = [];      // uv of the TOP rim vertex (to sample height/cov)
  const side = [];        // 0 = top rim vertex, 1 = bottom rim vertex
  const edgeDir = [];     // boundary kind: 0 = perimeter (seam machinery kept inert)
  function pushQuad(u0, v0, u1, v1, kind) {
    const verts = [
      [u0, v0, 0], [u1, v1, 0], [u1, v1, 1],
      [u0, v0, 0], [u1, v1, 1], [u0, v0, 1],
    ];
    for (const [uu, vv, sd] of verts) {
      positions.push((uu - 0.5) * WORLD_X, 0, (0.5 - vv) * WORLD_Z);
      uvsTop.push(uu, vv);
      side.push(sd);
      edgeDir.push(kind, 0);
    }
  }
  // PERIMETER RING — one wall quad per grid step along each of the 4 borders.
  for (let i = 0; i < GX; i++) {
    const u0 = i / GX, u1 = (i + 1) / GX;
    pushQuad(u0, 0, u1, 0, 0);          // v=0 border
    pushQuad(u0, 1, u1, 1, 0);          // v=1 border
  }
  for (let j = 0; j < GY; j++) {
    const v0 = j / GY, v1 = (j + 1) / GY;
    pushQuad(0, v0, 0, v1, 0);          // u=0 border
    pushQuad(1, v0, 1, v1, 0);          // u=1 border
  }
  // (SEAM curtain deliberately omitted — the top sheet's LIP FOLD already carries the
  //  seam's thickness; a hung curtain there read as picket-fence teeth. The seam-wall
  //  shader machinery below is retained but inert now that no kind=1 quads are emitted.)

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uvTop', new THREE.Float32BufferAttribute(uvsTop, 2));
  geo.setAttribute('sideT', new THREE.Float32BufferAttribute(side, 1));
  geo.setAttribute('edgeKind', new THREE.Float32BufferAttribute(edgeDir, 2));

  // The skirt shares the top sheet's clay/team look, re-lit for a solid rim. It reuses the
  // SAME uniform objects (team colour, height/cov textures, lap, lipH, flood, fade, time) so it
  // updates in lockstep with the top surface during warps/goal-floods/resets. It also SHARES the
  // top sheet's uFloodFade, so the loser's wall fades out with its top face at the flood peak (no
  // leftover opponent torec) and returns with it on the откат. Skirt-only: uThick, uRimCol.
  const uTop = blanket.u;
  const su = {
    uHeight: uTop.uHeight, uCov: uTop.uCov, uTexel: uTop.uTexel,
    uHeightPrev: uTop.uHeightPrev, uFieldMix: uTop.uFieldMix,   // C · shared field-interp (wall follows the eased top)
    uBaseline: uTop.uBaseline, uWorld: uTop.uWorld,
    uLap: uTop.uLap, uLipH: uTop.uLipH, uTop: uTop.uTop, uAway: uTop.uAway,
    uTeam: uTop.uTeam, uFlood: uTop.uFlood, uFloodTeam: uTop.uFloodTeam, uGlow: uTop.uGlow,
    uClay: uTop.uClay, uSat: uTop.uSat, uTint: uTop.uTint, uTime: uTop.uTime,
    uFloodFade: uTop.uFloodFade,   // shared with the top sheet — loser wall fades with loser face
    // skirt-only:
    uThick: { value: SLAB_THICK },
    uRimCol: { value: new THREE.Color('#0b0d13') },   // deep, premium slab-edge tone the wall fades to
  };
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.94, metalness: 0.55, envMapIntensity: 1.1,
    transparent: false, alphaTest: 0.5, depthWrite: true, depthTest: true,
    side: THREE.DoubleSide,
  });
  mat.userData.u = su;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, su);
    shader.vertexShader = `
      uniform sampler2D uHeight; uniform sampler2D uCov; uniform vec2 uTexel;
      uniform float uBaseline; uniform float uThick;
      uniform float uLap; uniform float uLipH; uniform float uTop; uniform float uAway;
      attribute vec2 uvTop; attribute float sideT; attribute vec2 edgeKind;
      varying float vSideT; varying vec2 vUvTop; varying float vKind;
      varying float vDuS; varying float vSurfY;
      varying float vGraze;   // 0 = face-on, 1 = fully grazing (fade fine detail here to kill moiré)
      ${INTERP ? 'uniform sampler2D uHeightPrev; uniform float uFieldMix; float SBP(vec2 uv){ float h = texture2D(uHeightPrev, uv).r; if(!(h==h)) h=0.0; return h; }' : ''}
      float SB(vec2 uv){ float h = texture2D(uHeight, uv).r; if(!(h==h)) h=0.0; return h; }
      float SF(vec2 uv){ float f = texture2D(uCov, uv).r; if(!(f==f)) f=0.5; return f; }
      float SFOLD(float du){
        float s = mix(-du, du, uAway);
        float fw = max(uLap * 0.6, 0.001);
        float ow = max(uLap * 0.4, 0.001);
        float own = 1.0 - smoothstep(0.0, fw, s);
        float opp = smoothstep(-ow, 0.0, s);
        return clamp(min(own, opp + step(0.0, s)), 0.0, 1.0);
      }
    ` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>
        float _hl = SB(uvTop - vec2(uTexel.x,0.0)); float _hr = SB(uvTop + vec2(uTexel.x,0.0));
        float _hd = SB(uvTop - vec2(0.0,uTexel.y)); float _hu = SB(uvTop + vec2(0.0,uTexel.y));
        vec3 _wn = normalize(vec3(-(_hr-_hl), 0.0, -(_hu-_hd)) + vec3(0.0001,0.0,0.0));
        objectNormal = _wn;`);
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
      `#include <begin_vertex>
        vUvTop = uvTop; vSideT = sideT; vKind = edgeKind.x;
        float _frnt = SF(uvTop);
        float _isSeam = step(0.5, edgeKind.x);
        vec2 _sampUv = mix(uvTop, vec2(_frnt, uvTop.y), _isSeam);
        ${INTERP ? 'float _hb = mix(SBP(_sampUv), SB(_sampUv), clamp(uFieldMix, 0.0, 1.0));' : 'float _hb = SB(_sampUv);'}
        vDuS = uvTop.x - _frnt;
        float _fold = uTop * SFOLD(vDuS);
        float _surfY = (_hb - uBaseline) + uLipH * _fold;
        vSurfY = _surfY;
        transformed.x = mix(transformed.x, (_frnt - 0.5) * ${WORLD_X.toFixed(1)}, _isSeam);
        // top rim (sideT=0) sits ON the surface; bottom rim (sideT=1) hangs uThick below.
        transformed.y = _surfY - sideT * uThick;
        vec3 _nv = normalize(normalMatrix * objectNormal);
        vec3 _pv = (modelViewMatrix * vec4(transformed.x, _surfY - sideT * uThick, transformed.z, 1.0)).xyz;
        vec3 _vd = normalize(-_pv);
        vGraze = 1.0 - clamp(abs(dot(_nv, _vd)), 0.0, 1.0);`);

    shader.fragmentShader = `
      uniform vec3 uTeam; uniform float uGlow; uniform float uFlood; uniform vec3 uFloodTeam;
      uniform vec3 uClay; uniform float uSat; uniform float uTint; uniform float uTime;
      uniform float uLap; uniform float uAway; uniform float uThick; uniform vec3 uRimCol;
      uniform float uTop;
      uniform vec2 uTexel;
      uniform float uFloodFade;   // GOAL-FLOOD sliver fade (conceding sheet only) — fades this wall out at the peak
      varying float vSideT; varying vec2 vUvTop; varying float vKind;
      varying float vDuS; varying float vSurfY;
      varying float vGraze;
      float h21_w(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
      float vn_w(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        float a=h21_w(i), b=h21_w(i+vec2(1,0)), c=h21_w(i+vec2(0,1)), d=h21_w(i+vec2(1,1));
        return mix(mix(a,b,f.x),mix(c,d,f.x),f.y); }
      float fbm_w(vec2 p){ float s=0.0,a=0.5; for(int k=0;k<3;k++){ s+=a*vn_w(p); p=p*2.03+vec2(11.3,7.7); a*=0.5; } return s; }
      float wallCov(){
        // match the top sheet's coverage: shrink THIS wall's overhang to 0 on the LOSING sheet at
        // the flood peak (uFloodFade→1) so the loser's perimeter torec stops past the front — no
        // leftover opponent wall at the conceded edge. Recedes with the front on the откат.
        float lap = uLap * (1.0 - clamp(uFloodFade, 0.0, 1.0));
        float d = mix(lap - vDuS, vDuS + lap, uAway);
        return step(0.0, d);
      }
    ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>',
      `#include <color_fragment>
      {
        float cov = wallCov();
        float seamW = max(uTexel.x * 1.6, 0.010);
        float seamKeep = 1.0 - smoothstep(seamW*0.6, seamW, abs(vDuS));
        float onTop = smoothstep(0.35, 0.65, uTop);
        float keep = (vKind > 0.5) ? (cov * seamKeep * onTop) : cov;
        // GOAL-FLOOD: fully drop the LOSER's whole perimeter torec at the flood peak. wallCov's
        // overhang-shrink retreats the side borders, but the conceded-end border wall sits exactly
        // AT the front (vDuS≈0) so the shrink alone can't push it off — multiply keep by (1−fade)
        // so the loser's entire wall discards at the peak (winner's front has swept over the whole
        // perimeter, so the winner's wall is the torec now). Recedes with the front → wall returns.
        keep *= (1.0 - clamp(uFloodFade, 0.0, 1.0));
        if (keep < 0.5) discard;
        vec3 team = uTeam;
        float lum = dot(team, vec3(0.299,0.587,0.114));
        team = max(mix(vec3(lum), team, uSat), 0.0);
        vec3 col = mix(uClay, team, clamp(uTint,0.0,1.0));
        col = mix(col, uFloodTeam, clamp(uFlood,0.0,1.0));
        float wlum = dot(col, vec3(0.299,0.587,0.114));
        col = mix(vec3(wlum), col, 0.82);
        float streakCoord = vUvTop.x*13.0 + vUvTop.y*13.0;
        float grain = fbm_w(vec2(streakCoord, vSideT*3.0)) - 0.5;
        float streakLod = fwidth(streakCoord);
        float lodFade = 1.0 - smoothstep(0.08, 0.28, streakLod);
        float grazeFade = 1.0 - smoothstep(0.55, 0.9, vGraze);
        col *= 1.0 + grain * 0.05 * lodFade * grazeFade;
        float down = clamp(vSideT, 0.0, 1.0);
        vec3 baseTone = uRimCol * vec3(0.85, 0.9, 1.15);
        col = mix(col, baseTone, down*down*0.82);
        diffuseColor.rgb = col;
        diffuseColor.a = 1.0;
      }`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>',
      `if (diffuseColor.a < 0.5) discard;
       #include <alphatest_fragment>`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
       {
         vec3 glowTeam = mix(uTeam, uFloodTeam, clamp(uFlood,0.0,1.0));
         float rim = smoothstep(0.14, 0.0, vSideT);        // 1 at the top rim → 0 down the wall
         vec3 emit = glowTeam * (0.11 * uGlow) * (1.0 - vSideT) * (1.0 - vSideT);
         emit += glowTeam * rim * 0.55;                     // bright bevel lip at the top rim
         totalEmissiveRadiance += emit;
       }`);
  };
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true; m.receiveShadow = true;
  m.frustumCulled = false;   // the shader moves verts in Y beyond the flat bbox
  m.renderOrder = 0;         // draw walls before the top sheets composite over them
  scene.add(m);
  return { mesh: m, u: su };
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

// ============================================================================
// DEV-ONLY PROTOTYPE — SHOT-LOCATION DOTS ON THE PITCH (behind ?dev).
//
// Each real shot (timeline kind==='shot') carries an Opta pitch position, already
// mirrored into the shared pitch frame as (u,v) by buildTimelineFromDoc/toUV. We drop
// a small flat disc at that (u,v) IN THE SAME y=0 MARKINGS PLANE as the pitch lines —
// so a dot WEAVES through the relief exactly like a pitch line does (cloth above y=0
// occludes it, cloth below shows it on top). This is why the dots read AGAINST the
// terrain rather than floating as a flat scatter-plot overlay.
//
// Language kept minimal + tasteful: a soft team-coloured disc, size gently scaled by xG;
// a GOAL is distinguished by a brighter core + a thin ring (the same white-ring vocabulary
// as the goal rings on the торец). Dots ACCUMULATE as the match plays (revealed at t≥shot.t)
// as a light persistent layer. Strictly DEV — never built on the live site / video render.
// ============================================================================
let shotDotGroup = null;      // THREE.Group holding every shot's dot mesh(es); toggled by clock
let shotDotItems = [];        // [{ t, objs:[mesh,…] }] — per-shot reveal gate by engine time
function buildShotDots() {
  if (shotDotGroup) { scene.remove(shotDotGroup); shotDotGroup = null; }
  shotDotItems = [];
  if (!timeline || !timeline.length) return;
  const grp = new THREE.Group();
  grp.renderOrder = 1;        // just after the pitch markings (0), so it woves with the same depth logic
  // a shared circle geometry (unit radius, in the XZ plane) we scale per-shot
  const disc = new THREE.CircleGeometry(1, 24); disc.rotateX(-Math.PI / 2);
  const EPS = 0.004;          // lift a hair off y=0 so it never z-fights the markings plane
  const shots = timeline.filter((it) => it.kind === 'shot' && Number.isFinite(it.u) && Number.isFinite(it.v));
  for (const s of shots) {
    const col = s.team === 'away' ? SEN_HEX : FRA_HEX;
    // xG → radius (world units). A tiny floor so a 0-xG shot still shows; goals read a touch bigger.
    const xg = Math.max(0, Number(s.xg) || 0);
    const r = (s.isGoal ? 0.14 : 0.075) + Math.sqrt(Math.min(1, xg)) * 0.11;
    const x = worldX(s.u), z = worldZ(s.v);
    const objs = [];
    // soft filled disc (team colour). Additive-free, translucent so it sits UNDER the light.
    const dMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(col), transparent: true,
      opacity: s.isGoal ? 0.9 : 0.5, depthWrite: false, depthTest: true,
    });
    const d = new THREE.Mesh(disc, dMat);
    d.position.set(x, EPS, z); d.scale.set(r, 1, r); d.renderOrder = 1;
    grp.add(d); objs.push(d);
    // GOAL — a thin bright ring around the disc (matches the white goal-ring vocabulary),
    // plus a brighter white-ish core so a goal reads distinctly from an ordinary shot.
    if (s.isGoal) {
      const ringGeo = new THREE.RingGeometry(r * 1.5, r * 1.5 + 0.03, 28); ringGeo.rotateX(-Math.PI / 2);
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: new THREE.Color('#eef3fa'), transparent: true, opacity: 0.85,
        depthWrite: false, depthTest: true,
      }));
      ring.position.set(x, EPS, z); ring.renderOrder = 1;
      grp.add(ring); objs.push(ring);
    }
    for (const o of objs) o.visible = false;   // hidden until the playhead reaches the shot
    // remember the pitch (u,v) so we can lift the dot onto the LIVE relief each frame.
    shotDotItems.push({ t: Number(s.t) || 0, u: s.u, v: s.v, objs });
  }
  shotDotGroup = grp; scene.add(grp);
  updateShotDots(clock);
}
// Bilinear sample of the LIVE blanket surface world-Y at pitch (u,v) — surfYData is the
// true top-A-surface height per mesh vertex (VX×VY), the SAME field B/C/D used to ride the
// cloth. Lets a dot sit ON the relief the eye sees (so it reads against the terrain) instead
// of hiding at y=0 under a raised billow. Returns 0 when the surface buffer isn't ready.
function sampleSurfY(u, v) {
  if (!surfYData || !surfYData.length) return 0;
  const fx = clamp(u, 0, 1) * GX, fy = clamp(v, 0, 1) * GY;
  const ix = Math.min(GX - 1, Math.floor(fx)), iy = Math.min(GY - 1, Math.floor(fy));
  const tx = fx - ix, ty = fy - iy;
  const i00 = iy * VX + ix, i10 = i00 + 1, i01 = i00 + VX, i11 = i01 + 1;
  const a = surfYData[i00] * (1 - tx) + surfYData[i10] * tx;
  const b = surfYData[i01] * (1 - tx) + surfYData[i11] * tx;
  return a * (1 - ty) + b * ty;
}
// per-frame: reveal a dot once the clock reaches its shot time, and LIFT it onto the live
// blanket surface so it rides the relief (a hair proud of the cloth). Scrub-safe (pure of t).
const SHOTDOT_LIFT = 0.02;   // world-Y offset above the sampled surface (keeps the disc from z-fighting the cloth)
function updateShotDots(t) {
  if (!shotDotGroup) return;
  for (const it of shotDotItems) {
    const on = it.t <= t + 1e-6;
    let y = null;
    for (const o of it.objs) {
      if (o.visible !== on) o.visible = on;
      if (!on) continue;
      if (y === null) y = sampleSurfY(it.u, it.v) + SHOTDOT_LIFT;
      o.position.y = y;
    }
  }
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
      // FotMob DISPLAY minute — 1-indexed with stoppage handling (build_timeline.displayMinute).
      // dispMin = numeric (for placement/sorting), label = on-screen string ("67" / "90+1").
      // Falls back to the raw minute for any old timeline doc that predates these fields.
      dispMin: Number.isFinite(e.dispMin) ? e.dispMin : ((Number(e.minute) || 0) + 1),
      label: (e.label != null ? String(e.label) : String((Number(e.minute) || 0) + 1)),
      u: a.u, v: a.v, type: e.type || kind, outcome: e.outcome || '',
      isTouch: !!e.isTouch, situation: e.situation || '',
      len: Number(e.len) || 0, long: !!e.long, cross: !!e.cross, corner: !!e.corner,
    };
    // CARD sending-off flag from the timeline (build_timeline sets red=true for a `Red`
    // qualifier). Only present on Card events; carried through so cardEvents can read it.
    if (e.type === 'Card') it.red = !!e.red;
    // PLAYER NAMES on card / substitution events (rebuilt mex-eng timeline now emits these):
    //   · Card             → name/surname of the booked/sent-off player
    //   · SubstitutionOff  → name/surname of the player coming OFF + onName/onSurname (player ON)
    //   · SubstitutionOn   → name/surname of the player coming ON
    // Carried through so the DEV timeline-icon hover tooltips can show them (no invented names).
    if (e.name != null) it.name = String(e.name);
    if (e.surname != null) it.surname = String(e.surname);
    if (e.onName != null) it.onName = String(e.onName);
    if (e.onSurname != null) it.onSurname = String(e.onSurname);
    if (Number.isFinite(e.endX) && Number.isFinite(e.endY)) {
      const en = toUV(team, e.endX, e.endY); it.eu = en.u; it.ev = en.v;
    }
    if (kind === 'shot') {
      it.xg = Number.isFinite(e.xg) ? e.xg : 0;
      it.isGoal = !!e.isGoal;
      it.ownGoal = !!e.ownGoal;
      if (e.ogScorer) it.ogScorer = String(e.ogScorer);
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
let A_gH = null, A_gA = null;     // GOAL crests (own grid → height independent of xG's xgH)
// temporally-SMOOTHED copies of the per-team height/crest grids. Each frame the
// freshly computed grids are lerped INTO these (see smoothA), and rendering reads
// from these — so the surface + colour edges glide instead of twitching.
let A_shH = null, A_shA = null, A_sxH = null, A_sxA = null;
let A_sgH = null, A_sgA = null;    // temporally-smoothed GOAL crest grids
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
  A_gH = new Float32Array(n); A_gA = new Float32Array(n);
  A_shH = new Float32Array(n); A_shA = new Float32Array(n);
  A_sxH = new Float32Array(n); A_sxA = new Float32Array(n);
  A_sgH = new Float32Array(n); A_sgA = new Float32Array(n);
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
    A_sgH[i] += (A_gH[i] - A_sgH[i]) * kk;
    A_sgA[i] += (A_gA[i] - A_sgA[i]) * kk;
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
// DANGER-FINGER envelope — a MORPH, not a pop-and-hang. Argument is WALL-SECONDS since the shot
// (via the warp), NOT match-minutes: the drama clock DWELLS on a dangerous moment, so a match-min
// envelope would FREEZE the finger at full extension for the whole dwell (~1–1.5s of "висение без
// движения"). Wall-seconds keep advancing through the dwell → the выпад REACHES IN over DG_REACH
// then PULLS BACK to 0 over DG_PULL at a CONSTANT visual pace, always moving, never stuck.
const DG_REACH = 0.4, DG_PULL = 0.9;   // WALL-seconds
function dangerFingerEnv(wsec) {
  if (!(wsec >= 0)) return 0;   // <0 (before the shot) or NaN (warp not ready)
  if (wsec < DG_REACH) { const f = wsec / DG_REACH; return f * f * (3 - 2 * f); }
  const f = (wsec - DG_REACH) / DG_PULL;
  return f >= 1 ? 0 : (1 - f * f * (3 - 2 * f));
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
const THRUST_SIGV = 0.11;       // finger lateral half-width in v — wide enough that the lunge TONGUE carries the whole xG crest onto the shooting team's (green) blanket, so the peak reads green, not half on the opponent's red
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
  const halfS = Number.isFinite(cfg.A.thrustHold) ? clamp(cfg.A.thrustHold, 0.5, 12) : THRUST_HALF_S;
  const relS = halfS / Math.LN2;
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
    if (PENBEAT && penBeatTimes.has(e.t)) continue;   // PENBEAT — pen shot owned by the beat: no thrust finger
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
      fv = Number.isFinite(e.v) ? e.v : 0.5;       // the SHOT SPOT flank (so the tongue lands under the crest, not at the goal mouth)
      // stab to the SHOT'S ACTUAL depth (a penalty at u≈0.88 is PAST the goal band, so the
      // lunge must reach it, not stop at the defender's band) — but at least to the goal band
      // for a shot from range. This is what carries the shooting team's colour ONTO the shot.
      const su = Number.isFinite(e.u) ? e.u : (isH ? hi : lo);
      endU = isH ? Math.min(1, Math.max(hi, su) + 0.05) : Math.max(0, Math.min(lo, su) - 0.05);   // reach just PAST the shot so its colour fully covers the crest
      const xg = clamp(e.xg || 0, 0, 1);
      // a DANGEROUS shot = a strong forward LUNGE (выпад) — the attacking colour tongues
      // toward the goal band at that flank. Boosted (×~2) + scaled by dangerPush so a side
      // with the better CHANCES visibly lunges into the opponent's half on its counters, even
      // with less possession. This is how attacks/counters read: FRONT movement, not a flood.
      const dPush = Number.isFinite(cfg.A.dangerPush) ? clamp(cfg.A.dangerPush, 0, 4) : 1;
      w = (1.3 + 5.2 * xg) * (0.6 + 0.4 * dPush) * env * strength;
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
const REACH_MEM_S = 4.0;       // territorial memory half-life (WALL sec) — was 7.0, but a counter's reach then HUNG deep long after the play had moved to the other end. Depth (REACH_MAX_PULL) unchanged; it just fades faster so a finger doesn't linger while the OTHER team is already attacking.
const REACH_ATK_S = 0.6;       // gentle ease-IN (wall seconds) so a reach push grows in, doesn't pop
const REACH_SIGV = 0.13;       // lateral half-width in v (WIDER than a thrust finger — a phase, not a stab)
const REACH_MAX_PULL = 0.42;   // max u-units the reach advances the front PAST the backbone (per side) — raised so a DANGER counter can overcome a possession-heavy backbone (see dangerPush)
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
  const passSeconds = Math.max(1, dramaEffTotal / spd);
  const dur = (teamMeta && teamMeta.duration) ? teamMeta.duration : 100;
  const matchMinPerWall = dur / passSeconds;
  const wallWinS = relS * 4 + REACH_ATK_S * 2;
  const winMin = wallWinS * matchMinPerWall * 1.6;     // match-minute scan window
  const win = eventsInWindow(t, winMin);
  const reach = REACH_SIGV * 3;
  const inv2sig2 = 1 / (2 * REACH_SIGV * REACH_SIGV);
  // A GOAL ENDS the scoring team's attack — clear THEIR reach memory from BEFORE that goal, so the
  // front doesn't stay stranded attack-deep in the opponent half after they score (this leftover
  // reach was the phantom post-goal «выпад» toward the goal, hanging after every goal).
  let lastGoalH = -Infinity, lastGoalA = -Infinity;
  for (const g of (goalsByTime || [])) { if (g.t > t) break; if (g.team === 'home') lastGoalH = g.t; else if (g.team === 'away') lastGoalA = g.t; }
  for (let wi = 0; wi < win.length; wi++) {
    const e = win[wi];
    if (PENBEAT && penBeatTimes.has(e.t)) continue;   // PENBEAT — pen shot owned by the beat: no attack-reach push
    const isH = e.team === 'home';
    if (!isH && e.team !== 'away') continue;
    if (e.t < (isH ? lastGoalH : lastGoalA)) continue;   // attack was before this team's latest goal → cleared
    // envelope in WALL time: gentle ease-in + medium decay (deterministic from t).
    const wall = wallSecondsSinceGoal(e.t, t);
    if (!Number.isFinite(wall) || wall < 0) continue;
    const env = arWeight(wall, REACH_ATK_S, relS);
    if (env < 0.03) continue;
    // Classify a DEEP attacking event and derive its (flank v, reach depth endU, weight).
    let fv = Number.isFinite(e.ev) ? e.ev : (Number.isFinite(e.v) ? e.v : 0.5);
    let endU, w = 0;
    if (e.kind === 'shot') {
      // a shot = the team reached the goal. Depth = the goal band; weight ∝ xg. DANGER now
      // pushes the territory HARD (dangerPush): the piece kept reading "the possession team
      // dominated" while the OTHER side had the better CHANCES on the counter — a few
      // dangerous shots must out-push a volume of tame possession events, so territory
      // reflects THREAT, not just who held the ball. Тут и жили потерянные контратаки.
      endU = isH ? hi : lo;
      const xg = clamp(e.xg || 0, 0, 1);
      const dangerPush = Number.isFinite(cfg.A.dangerPush) ? clamp(cfg.A.dangerPush, 0, 4) : 1;
      w = (0.7 + 3.4 * xg) * dangerPush * env;
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
    // EMOTIONAL ESCALATION — a run of dangerous moments close together builds tension, so
    // each shot in a streak rises TALLER than a lone chance. e._streakN (preceding dangerous
    // shots in a short window) is precomputed in countGoals; streakK scales the boost live.
    const streakK = Number.isFinite(A.streakK) ? clamp(A.streakK, 0, 2) : 0;
    const streakMul = 1 + streakK * Math.min(e._streakN || 0, STREAK_MAX);
    sharp += A.wXg * (1.0 + 4.5 * xg) * streakMul;
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
  A_hH.fill(0); A_hA.fill(0); A_xH.fill(0); A_xA.fill(0); A_gH.fill(0); A_gA.fill(0);
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
    // PENBEAT — a penalty shot is owned by the BEAT (dark stage + kicker hill). Skip its ambient
    // height/xG-spire so it doesn't fire a duplicate reaction when the beat unfreezes into play.
    if (PENBEAT && penBeatTimes.has(e.t)) continue;
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
  // GOAL CREST — a guaranteed spire per goal on its OWN grid (A_gH/A_gA), height applied at
  // render time from cfg.A.goalH (SEPARATE from the xG spire's xgH). Timing is in WALL seconds
  // (scrub-safe via wallSecondsSinceGoal, same basis as the flood phases): a short RISE that
  // PEAKS at the goal, a HOLD at the peak for cfg.A.goalHold wall-seconds («держать пик»),
  // then a decay. Independent of the shot's recorded xG so low-xG / own goals still read as
  // rising danger → GOAL → flood. env is 0..1 (magnitude comes from goalH in the vertex loop).
  // The crest RISES into the goal, holds a BRIEF peak (a punch), then gently DECAYS — its env is
  // ALWAYS in motion. ⚠️ A long held env=1 PLATEAU (was ~3s, through the whole flood-flatten) read
  // as a spike "hanging" frozen at the goal-mouth for 1–2s while the drama-clock dwells on the goal
  // — the phantom "выпад after every goal". The punch comes from the HEIGHT (goalH), not from
  // holding. Wall-seconds (scrub-safe); xG-independent so low-xG/own goals still punch. Decays well
  // before the front rolls back → nothing stranded in the opponent half.
  const gLead = GOAL_CREST_LEAD_S;
  const gPeak = 0.35;    // BRISK-SETTLE (2026-07-14): 0.7 → 0.35 peak-hold (wall-sec). A held spire at full height during the goal DWELL is itself a static «nothing moves» element; a short punch then continuous decay keeps the crest always in motion (no frozen spike at the goal-mouth)
  const gTau = 0.9;      // decay τ (wall-sec) — the spike recedes continuously afterwards, never frozen
  const gTotal = gPeak + 5 * gTau;   // cutoff (env negligible past here)
  for (const g of goalSpots) {
    // PENBEAT — a SCORED pen is in goalSpots, but the beat tells its goal (hill + digit); skip its
    // ambient goal-crest spire so nothing re-punches after the beat unfreezes.
    if (PENBEAT && penBeatTimes.has(g.t)) continue;
    const w = wallSecondsSinceGoal(g.t, t);              // wall-seconds since goal (<0 before)
    if (!Number.isFinite(w) || w < -gLead || w >= gTotal) continue;
    let env;
    if (w < 0) { const f = (w + gLead) / gLead; env = f * f * (3 - 2 * f); }   // RISE → peak at the goal
    else if (w < gPeak) env = 1;                                               // brief punch
    else env = Math.exp(-(w - gPeak) / gTau);                                  // gentle DECAY — always receding
    if (env < 0.02) continue;
    const Ggrid = g.team === 'home' ? A_gH : A_gA;
    stamp(Ggrid, gx, gy, g.u, g.v, env, sharpRad);
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
  const THRUST_MAX_PULL = 0.72;   // max u-units a finger advances the front past the backbone. HIGH so a DANGEROUS shot's lunge REACHES the shot spot (even a penalty at the goal line, deep in the opponent's half) → the shooting team's blanket is on top THERE → the xG peak shows in THEIR colour, on THEIR green. Danger-gated + narrow, so it's a sharp connected TONGUE to the chance, not a blanket flip.
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
  // DANGER FINGER — force a narrow TONGUE of the SHOOTING team's colour to REACH each active
  // dangerous shot, DIRECTLY (bypassing the possession combine — backbone + reach-hold kept a
  // counter's finger from ever arriving). This IS the выпад: a connected finger from the team's
  // own half to the chance, ending exactly where the xG peak stands, so the peak sits on the
  // shooter's colour (green peak in the red half, but a CONNECTED tongue, not an island).
  // Deterministic from t (arWeight) → scrub-safe. Disabled during the shootout.
  const activeDg = [];
  if (!shootActive && !wave) {   // NO danger finger during a GOAL wave — it fought the roll/reset (strange rollback + a spurious 2nd peak near the goal). The goal flood owns the front then.
    for (const e of dangerShots) {
      const env = dangerFingerEnv(wallSecondsSinceGoal(e.t, t));   // WALL-time so it never freezes mid-reach during a drama-dwell
      if (env < 0.12) continue;
      activeDg.push({ home: e.team === 'home', su: e.u, jc: (1 - e.v) * (gy - 1), sig: 0.085 * (gy - 1), env });
    }
  }
  for (let j = 0; j < gy; j++) {
    A_frontDisp[j] += (A_frontEff[j] - A_frontDisp[j]) * kd;
    // during the shootout the base is a CLEAN 50/50 colour split (not the jagged end-of-match
    // territory); a SCORED kick floods it fully to the kicker's colour, a MISS leaves the split.
    let fr = shootActive ? 0.5 : A_frontDisp[j];
    if (wave && wave.cover > 0) {
      // COUNTER-ATTACK FINGER — for a counter goal (wave.narrow>0) the roll's coverage is a NARROW
      // gaussian at the shot flank (wave.v ± wave.wv): off-flank channels keep their natural front so
      // the scorer's colour tongues forward only at that flank. narrow=0 (positional goal, or the
      // widened reset/beat/release of a counter) → full-width wall, exactly as before.
      let cj = wave.cover;
      if (wave.narrow > 0 && Number.isFinite(wave.v)) {
        const jc = (1 - wave.v) * (gy - 1);
        const sigJ = Math.max(1e-3, (wave.wv || COUNTER_FINGER_SIGV) * (gy - 1));
        const dj = j - jc;
        const gmask = Math.exp(-(dj * dj) / (2 * sigJ * sigJ));
        cj = wave.cover * (1 - wave.narrow * (1 - gmask));   // narrow=1 → gaussian; narrow=0 → full cover
      }
      fr = lerp(fr, wave.front, cj);
    }
    for (const d of activeDg) {
      const dj = j - d.jc; const g = Math.exp(-(dj * dj) / (2 * d.sig * d.sig)) * d.env;
      if (g < 0.1) continue;
      const w = Math.min(1, g * 2.2);   // at the finger core the tongue reaches the shot FULLY (env<1 otherwise stops short)
      // reach toward the shot with only the TINIEST margin from the goal line (cap 0.97 / floor
      // 0.03) — the выпад gets right up to the goal but the cloth never spills past the pitch edge.
      if (d.home) { const tgt = lerp(fr, Math.min(0.97, d.su + 0.03), w); if (tgt > fr) fr = tgt; }   // home stabs toward u→1
      else { const tgt = lerp(fr, Math.max(0.03, d.su - 0.03), w); if (tgt < fr) fr = tgt; }           // away stabs toward u→0
    }
    const row = j * gx;
    for (let i = 0; i < gx; i++) A_own[row + i] = fr;   // front-u, constant along u
  }
  A_sown.set(A_own);
  return win.length > 0;
}

// Lateral half-width (in v) of a COUNTER-attack goal's finger flood. Matches the danger-finger /
// thrust half-width (THRUST_SIGV) so the goal tongue reads the same as the pre-goal lunges.
const COUNTER_FINGER_SIGV = 0.11;
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
    if (goalsByTime[i].t > t) break;
    // PENBEAT — a SCORED pen does NOT use this seam flood: the two-sheet seam anchors each team's
    // colour to its OWN (defensive) end, so the scorer's colour can only ever expand FROM the far
    // side toward the pen — the reverse of what a pen wants. Instead a SCORED pen floods on the
    // RESUMED clock via penScoredFloodAt() — a directional colour reveal that EMANATES FROM the pen
    // goal and spreads outward. So we SKIP the pen here (return null below) to avoid a double flood.
    g = goalsByTime[i];
  }
  if (!g) return null;
  if (PENBEAT && penGoalTimes.has(g.t)) {
    // IN-BLOCK SUPPRESSION (black-field pen) — during the pen BEAT block the clock is FROZEN at the pen
    // minute, so elP≈0 and this branch would otherwise emit its flood PEAK (front=endE, cover=1) from the
    // beat ONSET — painting the whole field the scorer's colour BEFORE it drains to the dark pause (the
    // premature full-colour flash). The IN-BLOCK flood is owned entirely by penBeatVisual.floodReveal
    // (the directional reveal that fires at the RESOLVE); this resumed-clock front-blend must NOT run
    // inside the block. So bail out while we are inside this pen's own beat block; it then fires only on
    // the RESUMED clock (block ended), easing the peak flood endE→centre→beat→smooth-release.
    const _pbNow = penBeatFromWall(wallProgress);
    if (_pbNow && _pbNow.pen && _pbNow.pen.t === g.t) return null;
    // SCORED PEN = A GOAL (2026-07-14 rework). Route the aftermath through the EXACT SAME front-blend
    // path a normal goal uses so the seam provably SETTLES to TRUE CENTRE (0.5) and HOLDS the small
    // kickoff BEAT, then resumes — fixing the owner bug where the seam drifted to a RANDOM possession
    // position (the conceding side owning ~2/3) as the old uniform uFlood wash receded. The in-beat
    // flood (penBeatVisual.floodC) has already washed the field the scorer colour, so we SKIP the roll
    // and START at the flood PEAK (front=endE, cover=1), RESET front endE->centre, HOLD the centre
    // kickoff beat (goalPause), then FAST-release — identical to a goal's post-peak sequence. The
    // two-sheet front-blend now OWNS the pen colour (no separate uFlood wash): full-scorer colour ->
    // clean 50/50-at-centre is what the owner sees, then the beat, then live play.
    const elP = wallSecondsSinceGoal(g.t, t);
    if (!Number.isFinite(elP) || elP < 0) return null;
    const endE = g.team === 'home' ? 1.0 : 0.0;   // scorer's colour covers up to this end at the peak
    const mid = 0.5;
    const _fhP = Number.isFinite(cfg.A.floodHold) ? clamp(cfg.A.floodHold, 0, 12) : FLOOD_HOLD_DEFAULT_S;
    const _rsP = Number.isFinite(cfg.A.goalReset) ? clamp(cfg.A.goalReset, 0, 8) : FLOOD_RELAX_S;
    const kickP = Number.isFinite(cfg.A.goalPause) ? clamp(cfg.A.goalPause, 0, 6) : 0.3;   // the ~0.3s BEAT at centre
    const holdP = _fhP;                            // brief hold at the flood peak (matches the in-beat flood hand-off)
    const resetP = _rsP;                           // front eases endE -> centre (brisk, like a goal)
    const REL = 1.0;                               // SMOOTH eased cover 1->0 into live play (mirrors goal KICK_RELEASE_S) — glide centre->possession, no snap
    const total = holdP + resetP + kickP + REL;
    if (elP >= total) return null;                 // handed off to live play
    let front, cover = 1;
    if (elP < holdP) { front = endE; }                                                        // PEAK - full scorer colour
    else if (elP < holdP + resetP) { const f = (elP - holdP) / resetP; const e = f * f * (3 - 2 * f); front = lerp(endE, mid, e); }  // RESET -> centre
    else if (elP < holdP + resetP + kickP) { front = mid; }                                   // KICKOFF BEAT at centre (50/50)
    else { const f = (elP - holdP - resetP - kickP) / REL; front = mid; cover = 1 - f * (2 - f); }   // SMOOTH eased release (ease-out): glide centre->possession, leave immediately then decelerate — no snap, no hang
    const floodTint = clamp(cover, 0, 1) * clamp(Math.abs(front - mid) / Math.max(Math.abs(endE - mid), 1e-4), 0, 1);
    return { team: g.team, front: clamp(front, 0, 1), cover: clamp(cover, 0, 1), floodTint };
  }
  const elapsed = wallSecondsSinceGoal(g.t, t);
  if (!Number.isFinite(elapsed)) return null;
  const roll = FLOOD_SWEEP_S;
  // FLATTEN/HOLD phase = «держать заливку» (floodHold) + «пауза-штиль» (lull). Wiring
  // cfg.A.lull here makes the штиль knob live: the flood colour holds at the conceded end
  // AND the relief stays flat for floodHold+lull wall-seconds before the front resets.
  const floodHoldV = Number.isFinite(cfg.A.floodHold) ? clamp(cfg.A.floodHold, 0, 12) : FLOOD_HOLD_DEFAULT_S;
  const lullV = Number.isFinite(cfg.A.lull) ? clamp(cfg.A.lull, 0, 12) : 0;
  const flat = floodHoldV + lullV;
  const reset = Number.isFinite(cfg.A.goalReset) ? clamp(cfg.A.goalReset, 0, 8) : FLOOD_RELAX_S;
  const kick = Number.isFinite(cfg.A.goalPause) ? clamp(cfg.A.goalPause, 0, 6) : 0.4;  // KICKOFF HOLD at centre (within the drama-dwell)
  const KICK_RELEASE_S = 1.0;   // SMOOTH cover→0 once the drama-dwell ends (clock RESUMED). The seam is
                                // held at CENTRE through the beat, then this EASED window glides it from
                                // centre to the LIVE resumed possession over ~1s. The OLD 0.15s value
                                // SNAPPED it — the seam LURCHED from centre to a lopsided possession
                                // (~0.82) in one step, the owner's "strange position right after the
                                // goal" (2026-07-14). This is a glide, NOT a hold: cover eases 1→0
                                // continuously (smoothstep), the minute is ALREADY resumed here (goalRoom
                                // ends before the beat), so it adds NO static-hang — just a soft settle.
  const total = roll + flat + reset + kick + KICK_RELEASE_S;
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
  } else if (elapsed < roll + flat + reset) {
    // RESET — the front SWEEPS all the way back to the MIDDLE (kickoff) with cover STILL
    // FULL, so the whole field visibly rolls to a clean 50/50 (a firm ОТКАТ НА ЦЕНТР, not
    // a natural-tide bleed-through). endE → mid.
    const f = (elapsed - roll - flat) / reset; const e = f * f * (3 - 2 * f);
    front = lerp(endE, mid, e);
    cover = 1;
  } else if (elapsed < roll + flat + reset + kick) {
    // KICKOFF HOLD — the front RESTS at the centre (kickoff), cover FULL, through the rest of the
    // drama-dwell (the clock is still frozen on the goal). A clean 50/50 — «позиции выровнялись».
    front = mid; cover = 1;
  } else {
    // KICKOFF RELEASE — the drama-dwell is OVER, the clock has RESUMED. GLIDE cover 1→0 over the long
    // KICK_RELEASE_S window so the seam eases from centre into the LIVE post-goal possession (moving with
    // resumed play) as a SMOOTH ~1s settle, NOT the old 0.15s SNAP that lurched it to a lopsided spot.
    // EASE-OUT (f·(2−f)), not smoothstep: the seam LEAVES centre immediately (so it does NOT extend the
    // static beat window → no hang) then DECELERATES into the resumed possession (a gentle settle, no
    // lurch at either end). Kills the phantom «выпад»/«strange position» that snapped in after each goal.
    const f = (elapsed - roll - flat - reset - kick) / KICK_RELEASE_S; const e = f * (2 - f);
    front = mid; cover = 1 - e;
  }
  // floodTint (0..1) — how strongly the pitch is CURRENTLY flooded toward the scorer, used ONLY
  // to drive the uFloodFade sliver-fade (top sheet + skirt) on the LOSING sheet. It RISES as the
  // front rolls out to the conceded end and RECEDES to 0 as the front sweeps back to the midline
  // — so the loser-fade is TEMPORARY: full at the flood peak (loser faded out → no leftover
  // sliver), gone once the front has reset to centre (loser back → each half its OWN colour).
  // We must NOT gate on `cover`: cover STAYS 1 through the whole RESET/KICKOFF phase (the front
  // uses it to hold the sweep), so gating on `cover` would latch the fade and keep the loser
  // hidden. `floodTint` instead tracks the front's DISTANCE from centre toward the extreme end
  // (|front−0.5|/0.5) — exactly "how flooded is it right now" — 1 at the conceded end, 0 back at
  // the midline. cover× keeps the roll-in ramp consistent with the wave's own takeover.
  // COUNTER-ATTACK FINGER (2026-07-14) — for a FastBreak / IndividualPlay / through-ball goal the
  // flood ONSET is a NARROW TONGUE at the shot's flank (penetration), which then BLOOMS to a FULL
  // flood covering the whole field in the scorer's colour, exactly like any goal. `narrow` (0..1) says
  // HOW localised the flood is right now; the per-channel blend (computeA) masks wave.cover by a
  // gaussian centred on the shot flank `wv`-wide when narrow>0. Arc: hold the finger through the FIRST
  // half of the ROLL (the penetration onset), then ease narrow→0 across the rest of the roll + the
  // FLATTEN so the field is FULLY flooded the scorer's colour by the flood PEAK (the bloom). From the
  // peak on (reset→centre→beat→release) narrow=0 → identical full-width center-settle aftermath as a
  // positional goal — the ONLY difference is the finger ONSET. (Owner 2026-07-14: bloom to full at the
  // peak, NOT only at reset; then the usual seam→centre + beat + smooth release.)
  let narrow = 0;
  if (g.isCounter) {
    const onset = roll * 0.5;                                               // finger holds through the first half of the roll (penetration)
    const bloomEnd = roll + flat;                                          // fully bloomed to a FULL flood by the flood PEAK (end of flatten)
    if (elapsed < onset) narrow = 1;                                       // ONSET — narrow finger at the shot flank
    else if (elapsed < bloomEnd) { const f = (elapsed - onset) / Math.max(1e-4, bloomEnd - onset); narrow = 1 - (f * f * (3 - 2 * f)); }  // BLOOM → full field
    else narrow = 0;                                                       // PEAK + RESET + BEAT + RELEASE = full-width (normal center-settle aftermath)
  }
  // floodTint fades the WHOLE losing sheet at the flood peak (removes the sliver). For a narrow finger
  // the loser must STAY visible everywhere except under the tongue, so damp floodTint while narrow.
  const floodTintBase = clamp(cover, 0, 1) * clamp(Math.abs(front - mid) / Math.max(Math.abs(endE - mid), 1e-4), 0, 1);
  const floodTint = floodTintBase * (1 - narrow);
  return { team: g.team, front: clamp(front, 0, 1), cover: clamp(cover, 0, 1), floodTint,
    narrow, v: Number.isFinite(g.v) ? g.v : 0.5, wv: COUNTER_FINGER_SIGV };
}

// WALL-SECONDS since a goal — how many seconds of the ~15s dramatic pass separate
// match-minute gt from the current match-minute t, via the warp's progress mapping.
// One wall pass = DRAMA_TOTAL_S / spd seconds (the speed slider trims the pass), so
// Δprogress · (DRAMA_TOTAL_S / spd) = elapsed wall seconds. Deterministic from the
// clock (no frame state) → scrub-safe. Returns NaN if the warp isn't built yet.
function wallSecondsSinceGoal(gt, t) {
  if (!dramaWcum || dramaWtot <= 0) return NaN;
  const spd = Math.max(0.05, Number(cfg.speed) || 1);
  const passSeconds = dramaEffTotal / spd;
  const dProg = progressOfMatchT(t) - progressOfMatchT(gt);
  return dProg * passSeconds;
}
// Has the goal at gt "landed" as a HUD event by clock t? True once EVENT_LAG_S wall-seconds
// have passed since the goal — so score/sky/markers trail the cloth flood. Falls back to the
// plain time test before the dramatic clock is warmed up (wall time not yet computable).
function goalLanded(gt, t) {
  // PENBEAT — a scored in-match penalty lands (score ticks, markers appear) DURING its frozen
  // beat, at the flood. Pure of (wallProgress, t) → scrub-safe. Before the beat: not landed;
  // after resume (clock past the pen minute): landed.
  if (PENBEAT && penGoalTimes.has(gt)) {
    const pb = penBeatFromWall(wallProgress);
    if (pb && pb.pen.t === gt) return penBeatVisual(pb).scoreLanded;
    return gt <= t;
  }
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
    if (goalsByTime[i].t > t) break;
    g = goalsByTime[i];   // PENBEAT — scored pen uses the normal goal relief-flatten on resumed clock too
  }
  if (!g) return 0;
  const roll = FLOOD_SWEEP_S;
  // FLATTEN/HOLD phase = «держать заливку» (floodHold) + «пауза-штиль» (lull). Wiring
  // cfg.A.lull here makes the штиль knob live: the flood colour holds at the conceded end
  // AND the relief stays flat for floodHold+lull wall-seconds before the front resets.
  const floodHoldV = Number.isFinite(cfg.A.floodHold) ? clamp(cfg.A.floodHold, 0, 12) : FLOOD_HOLD_DEFAULT_S;
  const lullV = Number.isFinite(cfg.A.lull) ? clamp(cfg.A.lull, 0, 12) : 0;
  const flat = floodHoldV + lullV;
  const reset = Number.isFinite(cfg.A.goalReset) ? clamp(cfg.A.goalReset, 0, 8) : FLOOD_RELAX_S;
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

// DANGER FLOOD — the newest dangerous non-goal shot ≤ t, within its wall life, returns the
// {team, amt} of a soft FULL-FIELD colour wash toward the shooter (a partial uFlood override,
// NOT a full goal flood — the territory still reads under it). Strength ∝ xG × cfg.A.dangerFlood.
// Scrub-safe (deterministic from t via wallSecondsSinceGoal). Null when no wash is active.
function dangerFloodAt(t) {
  if (!dangerShots || !dangerShots.length) return null;
  const strength = Number.isFinite(cfg.A.dangerFlood) ? clamp(cfg.A.dangerFlood, 0, 1) : 0;
  if (strength <= 0) return null;
  let g = null;
  for (let i = 0; i < dangerShots.length; i++) { if (dangerShots[i].t <= t) g = dangerShots[i]; else break; }
  if (!g) return null;
  const w = wallSecondsSinceGoal(g.t, t);
  if (!Number.isFinite(w) || w < 0 || w >= DANGER_FLOOD_S) return null;
  const env = Math.pow(Math.sin(Math.PI * clamp(w / DANGER_FLOOD_S, 0, 1)), 0.7);   // 0→1→0
  const amt = clamp(strength * env * clamp(g.xg / 0.4, 0.5, 1.5), 0, 0.95);
  return { team: g.team, amt };
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
let penaltiesByTime = [];   // {t, team, u, v, scored, outcome, player} — penalty spot, match-time order
// SCORED in-match penalty goal times (PENBEAT) — the beat OWNS these goals' flood (via its own
// uFlood roll), so the normal goalWaveAt/goalLullAt path SKIPS them (no double flood / no
// post-resume re-fire). The score digit still counts them (see goalLanded). Set of `t`.
let penGoalTimes = new Set();
// ALL in-match penalty shot times (PENBEAT) — scored AND missed/saved/post. A penalty is ONE
// event: the BEAT owns it entirely, so the ambient terrain reactions (xG spire, goal crest,
// attack-reach, thrust fingers) MUST skip these `t`s (else a second reaction fires when the beat
// unfreezes into resumed play). See the skip guards in computeA/buildAttackReach/buildThrustFingers.
let penBeatTimes = new Set();
function buildPenalties() {
  penaltiesByTime = [];
  penGoalTimes = new Set();
  penBeatTimes = new Set();
  if (!timeline) return;
  for (const e of timeline) {
    if (e.kind !== 'shot') continue;
    if (String(e.situation).toLowerCase() !== 'penalty') continue;
    if (e.team !== 'home' && e.team !== 'away') continue;
    const scored = !!e.isGoal;
    // OUTCOME (dev pen-beat) — derived from the shot type/isGoal. 'scored' also lands in
    // goalsByTime → the existing goal flood resolves it; the others resolve with the beat only.
    let outcome = 'missed';
    if (scored) outcome = 'scored';
    else if (e.type === 'SavedShot') outcome = 'saved';
    else if (e.type === 'ShotOnPost') outcome = 'post';
    // TAKER name — best-effort, carried but not required for the visual beat. Scored pens
    // resolve via the goal-scorer map; others fall back to any name on the timeline event.
    const player = (scored && _goalScorers && _goalScorers.get(e.t)) || e.name || null;
    // minute/xg are kept so backfillPenTakers() can resolve the TAKER from the RICH record once
    // it has loaded (this build runs inside countGoals, BEFORE buildGoalScorers/richShots exist).
    penaltiesByTime.push({ t: e.t, team: e.team, u: e.u, v: e.v, scored, outcome, player, minute: e.minute, xg: e.xg });
    if (scored) penGoalTimes.add(e.t);
    penBeatTimes.add(e.t);   // scored OR missed — the beat owns ALL ambient terrain at this t
  }
  penaltiesByTime.sort((a, b) => a.t - b.t);
}
// TAKER NAME backfill — buildPenalties() runs early (inside countGoals) for the warp geometry,
// before the async RICH record (_goalScorers + richShots) is available. Call this AFTER
// buildGoalScorers() so each pen gets its taker: SCORED via the goal-scorer map, MISSED/SAVED via
// the nearest same-team rich shot on minute+xg (mirrors buildXgLabels' resolvePlayer). Best-effort:
// leaves player=null when nothing matches (the beat's floating label then simply doesn't show).
function backfillPenTakers() {
  if (!penaltiesByTime || !penaltiesByTime.length) return;
  for (const p of penaltiesByTime) {
    let player = (p.scored && _goalScorers && _goalScorers.get(p.t)) || null;
    if (!player && Array.isArray(richShots)) {
      let best = null, bestD = 1e9;
      for (const rs of richShots) {
        if (rs.team && p.team && rs.team !== p.team) continue;   // SAME team only
        const dm = Math.abs((Number(rs.minute) || 0) - (Number(p.minute) || 0));
        if (dm > 1.5) continue;
        const d = dm + Math.abs((Number(rs.xg) || 0) - (Number(p.xg) || 0)) * 3;
        if (d < bestD) { bestD = d; best = rs; }
      }
      player = best && best.player ? String(best.player) : null;
    }
    if (player) p.player = player;
  }
  // propagate into the warp's own pen copies (built earlier from a player-less snapshot) so the
  // floating beat label (which reads pb.pen.player via penBeatFromWall) gets the resolved name.
  if (penWarp && penWarp.pens) {
    for (const wp of penWarp.pens) {
      const src = penaltiesByTime.find((p) => p.t === wp.t && p.team === wp.team);
      if (src && src.player) wp.player = src.player;
    }
  }
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
// IN-MATCH PENALTY BEAT — OPTION B (DEV / PENBEAT). A REAL, self-contained mid-match penalty
// EVENT, mirroring the post-match shootout: EVERYTHING FREEZES, the field goes to the neutral
// DARK stage (no team colour), the kick plays (kicker-colour hill + spot→goal wave), then the
// resolution — SCORED → a full-field FLOOD in the kicker's colour (reusing the shootout's
// uFlood flood shape) and the score digit ticks; MISSED/SAVED → just the small hill (+recoil),
// no flood — and then the match RESUMES.
//
// SCRUB-SAFE MECHANISM: the beat is NOT a stateful pause in loop(). Instead a fixed-width beat
// BLOCK is INSERTED into the wall→clock timeline mapping at each penalty's clock-crossing (see
// clockFromWall / wallFromClock / penBeatFromWall below). The master `wallProgress` (0..1) is
// remapped so a slice of it PINS `clock` at the penalty minute; during that slice the beat is
// driven purely from the local wall-offset. Because the block is a pure function of wallProgress,
// scrubbing/seeking/play/pause all land on the correct frozen frame. The match content keeps its
// exact wall-duration (the blocks are pure ADDITIONS to the total), so every other clock-keyed
// effect (goal floods via wallSecondsSinceGoal) is unaffected.
const PEN_HILL_BIG = 3.2;      // world-Y peak for the SCORED pen hill (matches the shootout SHOOT_HILL_BIG feel)
const PEN_HILL_SMALL = 1.15;   // world-Y peak for the SAVED/MISSED/POST pen hill
const PEN_BEAT_WALL = 4.7;     // total WALL seconds of one inserted beat block (SETTLE→PAUSE→HILL→RESOLVE→RESUME)
// penWarp — the inserted-block layout, rebuilt on match load AFTER the drama warp exists
// (buildPenWarp, called post-buildDramaticClock). Null when PENBEAT is off or there are no
// in-match pens → clockFromWall/wallFromClock fall back to the plain matchT/progressOfMatchT.
let penWarp = null;
function buildPenWarp() {
  penWarp = null;
  if (!PENBEAT || !penaltiesByTime || !penaltiesByTime.length) return;
  if (!dramaWcum || dramaWtot <= 0) return;   // warp not built yet → try again after buildDramaticClock
  // anchor each pen in ORIGINAL match-progress space, sorted; assign each a fixed block.
  const pens = penaltiesByTime.map((p) => ({ t: p.t, team: p.team, u: p.u, v: p.v, outcome: p.outcome, player: p.player, mp: progressOfMatchT(p.t) }))
    .sort((a, b) => a.mp - b.mp);
  const nB = pens.length;
  const totalWall = dramaEffTotal + nB * PEN_BEAT_WALL;   // beats EXTEND the (additive) match wall timeline
  const blockFrac = PEN_BEAT_WALL / totalWall;            // normalized [0,1] width of one beat block
  const matchFrac = dramaEffTotal / totalWall;            // normalized total match share (match wall-time unchanged)
  penWarp = { pens, nB, totalWall, blockFrac, matchFrac };
}
// wall→clock: master wallProgress (0..1) → match-minute. During an inserted block `clock` is
// PINNED at that pen's minute (the freeze); elsewhere it's the normal warped matchT. Pure.
function clockFromWall(wp) {
  if (!penWarp) return matchT(clamp(wp, 0, 1));
  wp = clamp(wp, 0, 1);
  const { pens, blockFrac, matchFrac } = penWarp;
  let acc = 0, prevMp = 0;
  for (let i = 0; i < pens.length; i++) {
    const segW = (pens[i].mp - prevMp) * matchFrac;   // match segment BEFORE this pen
    if (wp < acc + segW) return matchT(prevMp + (wp - acc) / matchFrac);
    acc += segW;
    if (wp < acc + blockFrac) return pens[i].t;        // FROZEN inside the beat block
    acc += blockFrac;
    prevMp = pens[i].mp;
  }
  return matchT(clamp(prevMp + (wp - acc) / matchFrac, 0, 1));   // final match segment
}
// inverse: match-minute → wallProgress. A pen minute maps to the START of its beat block (so
// __setClock/slider land at the freeze-in). Pure.
function wallFromClock(t) {
  if (!penWarp) return progressOfMatchT(t);
  const mp = progressOfMatchT(t);
  const { pens, blockFrac, matchFrac } = penWarp;
  let acc = 0, prevMp = 0;
  for (let i = 0; i < pens.length; i++) {
    if (mp <= pens[i].mp) return clamp(acc + (mp - prevMp) * matchFrac, 0, 1);
    acc += (pens[i].mp - prevMp) * matchFrac + blockFrac;   // consume segment + skip block
    prevMp = pens[i].mp;
  }
  return clamp(acc + (mp - prevMp) * matchFrac, 0, 1);
}
// The live beat at master wallProgress → {i, pen, phase (0..1), localWall (0..PEN_BEAT_WALL)} or
// null when not inside any block. Pure function of wallProgress → the whole beat is scrub-safe.
function penBeatFromWall(wp) {
  if (!penWarp) return null;
  wp = clamp(wp, 0, 1);
  const { pens, blockFrac, matchFrac } = penWarp;
  let acc = 0, prevMp = 0;
  for (let i = 0; i < pens.length; i++) {
    acc += (pens[i].mp - prevMp) * matchFrac;
    if (wp >= acc && wp < acc + blockFrac) {
      const phase = blockFrac > 0 ? (wp - acc) / blockFrac : 0;
      return { i, pen: pens[i], phase, localWall: phase * PEN_BEAT_WALL };
    }
    acc += blockFrac;
    prevMp = pens[i].mp;
  }
  return null;
}
// Beat VISUALS from the local wall-offset — RE-STAGED to read exactly like the POST-MATCH
// SHOOTOUT: the field first CALMS to a clean flat dark plane, HOLDS still, THEN the kicker
// hill rises. Sub-phases (wall-seconds, tuned for feel — see PEN_BEAT_WALL):
//   1. SETTLE  (0 → tSettle):   relief eases FULLY flat + colour drains to SHOOT_DARK.
//   2. PAUSE   (tSettle→tPause): hold on the empty flat dark field — a beat of stillness.
//   3. HILL    (tPause→tHill):   kicker-colour hill rises at the spot (+ spot→goal wave).
//   4. RESOLVE (tHill→tRes):     scored → full-field flood (score ticks); miss → hill recedes + recoil.
//   5. RESUME  (tRes → B):       relief + colour ease back to the live match; play resumes.
// Returns {pen, dark (0..1 neutral-wash presence), flat (0..1 relief-flatten = SETTLE presence,
// drives reliefMul/wobble/goal-crest melt so the SETTLE frame is genuinely flat), floodC (0..1
// kicker flood; 0 for miss), hill {u,v,h,tint}|null, wave {..}|null, scoreLanded}. Pure of
// localWall → the whole beat is scrub-safe. Mirrors the shootout's hill/penPulse/flood vocabulary.
const _PB_SETTLE = 0.9, _PB_PAUSE = 0.7, _PB_HILL = 1.0, _PB_RESOLVE = 0.9;   // MISS sub-phase durations (wall s); RESUME = rest (~1.2s)
// SCORED pen RESOLVE offset (localWall seconds) — the kick lands / score ticks (== scoreLanded's
// `w >= tHill + 0.2`, where scored tHill = _PB_SETTLE + 0.5 + _PB_HILL). The scorer CARD keys its
// envelope origin here so a scored penalty's card fires at the GOAL MOMENT (resolve) exactly like
// any open-play goal card — NOT deferred to the post-flood resume. Keep in sync with penBeatVisual.
const PEN_SCORED_RESOLVE_W = _PB_SETTLE + 0.5 + _PB_HILL + 0.2;
// PENALTY SCORER-CARD origin (2026-07-15) — the card must rise/appear TOGETHER WITH the kicker HILL, not
// ~1-2s later at the resolve (owner: the card lagged the hill). The hill starts rising at tPause
// (=_PB_SETTLE + 0.5, the SCORED sub-phase), so anchor the card envelope's origin EVENT_LAG_S BEFORE that
// — the card then begins its rise exactly as the hill begins its rise and is full as the hill peaks. It
// still runs the SAME envelope once (rise → hold → fade) and is gone before the block ends, so it never
// re-shows post-flood. Distinct from PEN_SCORED_RESOLVE_W (which stays the score-digit/scoreLanded moment).
const PEN_CARD_ORIGIN_W = _PB_SETTLE + 0.5 - EVENT_LAG_S;
function penBeatVisual(pb) {
  if (!pb) return null;
  const ss = (x) => { const f = clamp(x, 0, 1); return f * f * (3 - 2 * f); };
  const w = pb.localWall, B = PEN_BEAT_WALL;
  const scored = pb.pen.outcome === 'scored';
  // SUB-PHASE LAYOUT. SCORED and MISS differ: a SCORED pen's flood is now the NORMAL goal flood on
  // the RESUMED clock (fires only once the block ends, clock unfreezes), so we push the KICK LATE
  // in the block (a longer held-breath dark PAUSE) and keep only a short tail — the flood then
  // picks up right after the kick, minimizing the dark gap. A MISS keeps its rise→recede tail.
  const tSettle = _PB_SETTLE;                       // SETTLE ends (both)
  let tPause, tHill, tRes;
  if (scored) {
    tPause = tSettle + 0.5;                         // held-breath dark PAUSE — SHORTENED AGAIN (2.0 → 1.0 → 0.5) so the kick comes quickly (owner: «чёрная пауза перед пенальти слишком долгая»)
    tHill  = tPause + _PB_HILL;                     // HILL ends ≈ 2.9 (the KICK / conversion)
    tRes   = tHill + 0.3;                           // brief hand-off; the RESUME tail (now ~1.5s) eases the dark out before the block ends
  } else {
    tPause = tSettle + _PB_PAUSE;                   // PAUSE ends (hill starts)
    tHill  = tPause + _PB_HILL;                     // HILL ends (resolve starts)
    tRes   = tHill + _PB_RESOLVE;                   // RESOLVE ends (hill has receded); resume starts
  }
  // SETTLE presence — ONE shared envelope for "the field has calmed to the clean dark stage".
  // CLOTH-SETTLE (2026-07-19): the SETTLE ramp uses a quad ease-OUT eo(x)=x·(2−x) (fast start, smooth
  // decelerate to rest — the cloth drops quickly then eases into stillness) instead of smoothstep, and
  // BOTH the colour wash (flat/dark) AND the relief flatten (reliefFlat, below) read from this ONE
  // shared settleEnv so height + desaturation settle in LOCKSTEP. Holds 1 through PAUSE+HILL+RESOLVE;
  // the colour wash still eases 1→0 over RESUME (relief stays decoupled — see reliefFlat).
  const eo = (x) => { const f = clamp(x, 0, 1); return f * (2 - f); };   // quad ease-out
  const settleEnv = eo(w / _PB_SETTLE);
  let flat;
  if (w < tSettle) flat = settleEnv;
  else if (w < tRes) flat = 1;
  else flat = 1 - ss((w - tRes) / Math.max(B - tRes, 1e-3));
  const dark = flat;                                // wash presence locked to the flatten
  // RELIEF-flatten envelope — SEPARATE from `flat`. It ramps up over SETTLE then HOLDS 1 for the
  // WHOLE REST of the block (NO in-block RESUME ease-out). The ambient match relief must NOT bloom
  // back IN-PLACE at the frozen pen minute during RESUME — that static swell right after the hill
  // read as a phantom SECOND terrain "moment на одеяле" (miss) / a raw-terrain flash before the
  // flood (scored). Instead the relief stays melted to the block end and is eased back on the
  // RESUMED (moving) clock by penRecoveryAt(), so terrain returns AS PLAY RESUMES, not as an
  // in-place bump. `flat`/`dark` keep their RESUME ease-out so the neutral colour wash still drains
  // smoothly into the resumed colour with no boundary pop.
  const reliefFlat = w < tSettle ? settleEnv : 1;   // SAME shared settleEnv → height flattens lockstep with the colour wash
  // KICKER HILL at the spot — rises during HILL, holds, then (scored) fades as the flood takes
  // over / (miss) recedes with a slight recoil during RESOLVE. Nothing before PAUSE ends (the
  // field is a clean flat dark plane during SETTLE+PAUSE).
  const peak = scored ? PEN_HILL_BIG : PEN_HILL_SMALL;
  const riseD = 0.45;
  let hEnv = 0, recoil = 0;
  if (w >= tPause && w < tPause + riseD) hEnv = ss((w - tPause) / riseD);
  else if (w >= tPause + riseD && w < tHill) hEnv = 1;
  else if (w >= tHill) {
    // SCORED — the kicker-colour hill fades all the way to the BLOCK END (B), so it is still
    // present/receding as the block boundary hands into the resumed-clock goal FLOOD (same kicker
    // colour, same pen end). This closes the flat GAP that used to sit between the hill receding
    // (~0.45s tail) and the flood picking up post-block — kick → flood now reads as ONE continuous
    // kicker-colour motion instead of hill · pause · separate flood.
    if (scored) hEnv = 1 - ss((w - tHill) / Math.max(B - tHill, 0.3));   // hand off to the flood at the boundary
    else {
      const f = clamp((w - tHill) / _PB_RESOLVE, 0, 1);
      hEnv = 1 - ss(f);
      recoil = Math.sin(Math.PI * f) * 0.28 * PEN_HILL_SMALL;   // repelled dip on a miss
    }
  }
  const hill = hEnv > 0.001 || recoil > 0.001
    ? { u: pb.pen.u, v: pb.pen.v, h: peak * hEnv - recoil, tint: hEnv } : null;
  // SPOT→GOAL directional wave during HILL (shootoutPenPulse styling). home attacks u→1, away u→0.
  let wave = null;
  if (w >= tPause && w < tHill) {
    const f = clamp((w - tPause) / _PB_HILL, 0, 1);
    let env = Math.sin(Math.PI * f) ** 0.6;
    if (!scored) env *= (1 - 0.4 * smoothstep(0.55, 1, f));
    wave = { u: pb.pen.u, v: pb.pen.v, team: pb.pen.team, dir: pb.pen.team === 'home' ? 1 : -1, f, env, scored };
  }
  // ZONE HIGHLIGHT (during the WAIT) — a FLAT coloured patch (no relief/height) marking the
  // PENALTY ZONE (the goal-mouth/box being attacked) in the TAKER's colour, so the held-breath dark
  // PAUSE reads as "this is where the penalty is happening". Ramps in over SETTLE, HOLDS through the
  // PAUSE, then fades out as the HILL rises (hands the moment to the kick). Rendered via the cData
  // tint channel (uCornerCol = taker colour during the beat) → a flat glow, never a bump.
  let zoneEnv = 0;
  if (w < tPause) zoneEnv = ss(w / _PB_SETTLE);                 // ramp over SETTLE, hold through PAUSE
  else if (w < tPause + riseD) zoneEnv = 1 - ss((w - tPause) / riseD);  // fade as the kicker hill rises
  const zone = zoneEnv > 0.001 ? { u: pb.pen.u, v: pb.pen.v, dir: pb.pen.team === 'home' ? 1 : -1, env: zoneEnv } : null;
  // SCORED FLOOD (2026-07-14 rework) — a scored pen must read like a DECISIVE GOAL: the instant the
  // kick lands, the SCORER's colour floods the WHOLE field, briskly. floodC ramps 0→1 right after the
  // HILL (the conversion) and HOLDS 1 to the block end, driving uFlood (dark→scorer, full strength)
  // via the penVis branch in renderFrame. So there is NO dark-field linger after the kick, NO
  // intermediate where the opponent's prior territory shows, NO slow gradual fill — the field is
  // fully the scorer's colour when the clock resumes, and the resumed-clock penScoredUFloodAt()
  // continues it seamlessly (starts at full) then eases back to live play. A MISS keeps floodC 0
  // (hill + recede only, no flood). The old slow directional cData reveal (penScoredFloodAt) is
  // superseded and disabled.
  const floodC = scored ? ss((w - tHill) / 0.4) : 0;   // 0 before the kick → 1 over 0.4s after → holds 1 to block end
  // DIRECTIONAL FLOOD REVEAL (2026-07-14) — the scorer's colour EMANATES FROM the goal it was scored in
  // and sweeps across the field (owner: «directional from the pen zone», the uniform wash read wrong).
  // A FLAT cData wash (no height) whose front starts AT the pen goal line and rides floodC out to the
  // far end — FAST (the 0.4s floodC ramp), over the dark stage (no opponent territory ever shows). By
  // block end it fully covers the field the scorer's colour, handing off to the resumed clock. Same
  // {sign,revU} convention as penScoredFloodAt: home attacked u→1 (revU 1→0, floods u>revU); away
  // attacked u→0 (revU 0→1, floods u<revU).
  const scGl = pb.pen.team === 'home' ? 1 : 0;          // pen goal line the scorer attacked
  const floodReveal = (scored && floodC > 0.001)
    ? { team: pb.pen.team, sign: pb.pen.team === 'home' ? 1 : -1, revU: scGl + (1 - 2 * scGl) * floodC, strength: 0.96 * floodC }
    : null;
  // the goal digit ticks at the KICK (conversion), so the score reads as scored the instant the kick lands.
  const scoreLanded = scored && w >= tHill + 0.2;
  return { pen: pb.pen, dark, flat, reliefFlat, floodC, hill, wave, zone, scoreLanded, floodReveal };
}
// POST-BEAT RELIEF RECOVERY (PENBEAT) — once a pen BLOCK ends and the clock RESUMES, the ambient
// match relief eases back over PEN_RECOVER_S wall-seconds of RESUMED play (NOT in-place at the
// frozen minute). Deterministic from the clock (wallSecondsSinceGoal) → scrub-safe. Returns the
// residual melt 0..1 (1 = just resumed → still flat; 0 = fully recovered). Keyed on the latest
// pen ≤ t. Only meaningful OUTSIDE a block (inside, penVis.reliefFlat drives the melt); combining
// via the block test in renderFrame keeps the melt CONTINUOUS across the block boundary.
// DURATION (2026-07-15) — 1.3 → 2.8s. At 1.3s the terrain bloomed back FAST, finishing well before the
// seam's ~3.5s glide-to-centre → it read as a SEPARATE "the field rises up again" beat AFTER the flood
// (owner). Stretching it to span the seam's return makes the ambient relief ease back GRADUALLY in
// lockstep with the seam settling — one continuous settle, like a normal goal's post-flood recovery,
// with no discrete secondary rise. Still monotonic + always moving (smoothstep) → no dead-flat freeze.
const PEN_RECOVER_S = 2.8;
function penRecoveryAt(t) {
  if (!PENBEAT || !penaltiesByTime || !penaltiesByTime.length) return 0;
  let p = null;
  for (let i = 0; i < penaltiesByTime.length; i++) { if (penaltiesByTime[i].t > t) break; p = penaltiesByTime[i]; }
  if (!p) return 0;
  const w = wallSecondsSinceGoal(p.t, t);
  if (!Number.isFinite(w) || w < 0 || w >= PEN_RECOVER_S) return 0;
  return 1 - smoothstep(0, PEN_RECOVER_S, w);
}
// SCORED-PENALTY FLOOD (PENBEAT) — the directional replacement for the seam flood on a scored pen.
// A pen must read as the scorer's colour EMANATING FROM the goal it was scored in and spreading
// outward (owner: the seam version was "наоборот" — it expanded from the far side). We can't do that
// with the two-sheet seam (each team's colour is anchored to its own end), so instead we reveal the
// scorer's colour as a FLAT cData wash whose front starts AT the pen goal line and sweeps across to
// the far end. Deterministic from the RESUMED clock (wallSecondsSinceGoal) → scrub-safe. Only fires
// OUTSIDE a beat block (renderFrame gates on !penVis); inside, the dark stage + hill own the frame.
// Returns { team, sign (+1: flood u>revU ; −1: flood u<revU), revU (reveal front u), strength } | null.
function penScoredFloodAt(t) {
  // DISABLED (2026-07-14): the slow directional reveal made the owner-reported bug — after the kick
  // it resumed to the PRIOR possession territory (opponent's colour ~2/3 of the field) then filled the
  // scorer's colour in SLOWLY. Replaced by penScoredUFloodAt() (immediate full-field scorer flood +
  // brisk retreat). Kept as a no-op (returns null) so the debug hook still resolves.
  return null;
  // eslint-disable-next-line no-unreachable
  if (!PENBEAT || !penGoalTimes || !penGoalTimes.size) return null;
  let g = null;
  for (let i = 0; i < goalsByTime.length; i++) { if (goalsByTime[i].t > t) break; g = goalsByTime[i]; }
  if (!g || !penGoalTimes.has(g.t)) return null;                 // latest goal ≤ t must be a scored pen
  const p = penaltiesByTime.find((x) => x.t === g.t && x.outcome === 'scored');
  if (!p) return null;
  const elapsed = wallSecondsSinceGoal(g.t, t);
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const roll = FLOOD_SWEEP_S;                                    // reveal sweeps pen goal → far end
  const floodHoldV = Number.isFinite(cfg.A.floodHold) ? clamp(cfg.A.floodHold, 0, 12) : FLOOD_HOLD_DEFAULT_S;
  const lullV = Number.isFinite(cfg.A.lull) ? clamp(cfg.A.lull, 0, 12) : 0;
  const flat = floodHoldV + lullV;
  const reset = Number.isFinite(cfg.A.goalReset) ? clamp(cfg.A.goalReset, 0, 8) : FLOOD_RELAX_S;
  const total = roll + flat + reset;
  if (elapsed >= total) return null;
  // home scored into the u→1 goal (pen side u=1) → flood the region u>revU, revU sweeps 1→0.
  // away scored into the u→0 goal (pen side u=0) → flood the region u<revU, revU sweeps 0→1.
  const home = p.team === 'home';
  const sign = home ? 1 : -1;
  let cover, strength;
  if (elapsed < roll) { const f = elapsed / roll; cover = f * f * (3 - 2 * f); strength = 0.92; }   // ROLL: reveal spreads outward
  else if (elapsed < roll + flat) { cover = 1; strength = 0.92; }                                    // HOLD: whole field flooded
  else { const f = (elapsed - roll - flat) / reset; cover = 1; strength = 0.92 * (1 - f * f * (3 - 2 * f)); }  // RESET: fade back
  const revU = home ? (1 - cover) : cover;                       // reveal front starts at the pen goal line
  return { team: p.team, sign, revU: clamp(revU, 0, 1), strength: clamp(strength, 0, 1) };
}
// SCORED-PENALTY FLOOD (2026-07-14) — the DEFINITIVE scored-pen flood: a full-field uFlood wash of the
// SCORER's colour, continuing on the RESUMED clock from the in-beat flood (penBeatVisual.floodC reaches
// 1 at the block boundary) so the handoff is seamless — the field is ALREADY fully the scorer's colour
// when the clock unfreezes. It starts at FULL (no roll-in → the opponent's territory never shows) then
// eases back to live play over the goal RESET (brisk). Uniform full-field (like a decisive goal / the
// shootout wash), so there is no "backwards" seam sweep and no dark gap. Keyed on the latest goal ≤ t
// being a scored pen; only fires OUTSIDE a beat block (renderFrame gates on !penVis). Scrub-safe.
function penScoredUFloodAt(t) {
  // DISABLED (2026-07-15) — this uniform full-field uFlood wash of the scorer's colour was a bridge over
  // the in-beat→resume handoff, but on the RESUMED clock it BLENDED the LOSER's half toward the scorer's
  // colour (France blue × Spain red = a MAGENTA/PURPLE band) as its `amt` receded and uncovered the
  // front-blend — a tint a NORMAL goal never has. The two-sheet front-blend (goalWaveAt pen branch)
  // already starts at the flood PEAK (front=endE, cover=1 → whole field the scorer's colour) on resume,
  // so the handoff is seamless WITHOUT this wash, and the return is then IDENTICAL to an open-play goal:
  // clean two-colour seam easing to centre, no purple. Kept as a no-op so the debug hook still resolves.
  return null;
  // eslint-disable-next-line no-unreachable
  if (!PENBEAT || !penGoalTimes || !penGoalTimes.size) return null;
  let g = null;
  for (let i = 0; i < goalsByTime.length; i++) { if (goalsByTime[i].t > t) break; g = goalsByTime[i]; }
  if (!g || !penGoalTimes.has(g.t)) return null;                 // latest goal ≤ t must be a scored pen
  const p = penaltiesByTime.find((x) => x.t === g.t && x.outcome === 'scored');
  if (!p) return null;
  const elapsed = wallSecondsSinceGoal(g.t, t);
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  // 2026-07-14 rework — the two-sheet FRONT-BLEND (goalWaveAt pen branch) now OWNS the pen colour and
  // its settle-to-CENTRE, exactly like a normal goal. This uniform wash is kept ONLY as a brief bridge
  // over the in-beat→resume handoff (the field was full scorer colour when the clock unfroze) and then
  // recedes FAST — well before the front reaches centre — so the seam's glide to centre and the clean
  // 50/50 KICKOFF beat are VISIBLE (front-blend), not masked by a lingering flat wash (that masking was
  // why the owner never saw the centre settle and only saw the seam end at a random possession spot).
  const _fhP = Number.isFinite(cfg.A.floodHold) ? clamp(cfg.A.floodHold, 0, 12) : FLOOD_HOLD_DEFAULT_S;
  const _rsP = Number.isFinite(cfg.A.goalReset) ? clamp(cfg.A.goalReset, 0, 8) : FLOOD_RELAX_S;
  const hold = _fhP;                                             // hold full through the flood PEAK (matches goalWaveAt holdP)
  const reset = Math.max(0.3, 0.45 * _rsP);                      // then recede FAST (first ~half of the front's endE->centre reset)
  if (elapsed >= hold + reset) return null;
  let amt = 1;
  if (elapsed > hold) { const f = (elapsed - hold) / reset; amt = 1 - f * f * (3 - 2 * f); }   // eased retreat, uncovering the front-blend
  return { team: p.team, amt: clamp(amt, 0, 1) };
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
const SHOOT_SPOT_U = 0.885;    // penalty spot (~12yd) — home kicks at u→1, away at u→0
// REDESIGN (user-directed): the shootout field is a DARK NEUTRAL stage (no team split).
// Each kick RISES a HILL in the kicker's colour at the spot — SCORED = tall hill + the
// WHOLE field floods that colour; MISSED = a small hill, no flood. The dark base + the
// flood are both driven through uFlood (uFloodTeam = dark ↔ kicker); the coloured hill
// is a local height bump + tint (survives the dark wash because the tint is applied AFTER
// uFlood in the blanket shader). Dots (○ scored / ● miss) unchanged.
const SHOOT_DARK_COL = new THREE.Color(0x0a0c14);  // neutral dark base wash colour
const SHOOT_DARK_AMT = 0.98;   // uFlood strength at the dark base — near-full wash so no team territory bleeds through (cloth weave still reads via lighting/normals)
const SHOOT_HILL_BIG = 3.4;    // world-Y peak of a SCORED kick's hill
const SHOOT_HILL_SMALL = 1.1;  // world-Y peak of a MISSED kick's hill
const SHOOT_HILL_SIGU = 0.15;  // hill radius along u (pitch length)
const SHOOT_HILL_SIGV = 0.15;  // hill radius along v (pitch width)
const _shootCol = new THREE.Color();   // scratch for the dark↔kicker flood blend
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
// KICK HILL (REDESIGN) — the current kick RISES a hill in the kicker's colour at the spot.
// Envelope in wall-seconds (seq.tIn): rise → HOLD → recede. SCORED hills are TALL and hold
// longer (the moment before the flood); MISSED hills are SMALL and short. Returns
// {u, v, team, h (world-Y peak × envelope), tint (0..1), scored} or null between kicks.
function shootHillAt() {
  const seq = shootoutSeq();
  if (!seq || !seq.kick || seq.tIn < 0) return null;
  const kick = seq.kick;
  const rise = 0.35, hold = kick.scored ? 1.05 : 0.55, fall = 0.8;
  const s = seq.tIn;
  if (s >= rise + hold + fall) return null;
  let env;
  if (s < rise) { const f = s / rise; env = f * f * (3 - 2 * f); }
  else if (s < rise + hold) env = 1;
  else { const f = (s - rise - hold) / fall; env = 1 - f * f * (3 - 2 * f); }
  const home = kick.team === 'home';
  const peak = kick.scored ? SHOOT_HILL_BIG : SHOOT_HILL_SMALL;
  return { u: home ? SHOOT_SPOT_U : 1 - SHOOT_SPOT_U, v: 0.5, team: kick.team, h: peak * env, tint: env, scored: kick.scored };
}
// SHOOTOUT ZONE HIGHLIGHT — the same FLAT goal-mouth glow as the in-match pen wait, in the CURRENT
// kick's colour, shown at the START of each kick's slot (as the kick is set) and fading as the wave
// leaves the spot. home kicks at the u→1 goal, away at the u→0 goal. Returns {dir, v, team, env}|null.
function shootZoneAt() {
  const seq = shootoutSeq();
  if (!seq || !seq.kick || seq.tIn < 0) return null;
  const hold = 0.45, fall = 0.4;
  const s = seq.tIn;
  if (s >= hold + fall) return null;
  const env = s < hold ? 1 : 1 - (() => { const f = (s - hold) / fall; return f * f * (3 - 2 * f); })();
  const home = seq.kick.team === 'home';
  return { dir: home ? 1 : -1, v: 0.5, team: seq.kick.team, env: clamp(env, 0, 1) };
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

// PERF (software-GPU floor) — shared-address bilinear sampler. In computeField's vertex loop
// all SEVEN A-field samples read the SAME (u,v) into grids of the SAME dims (A_gx×A_gy), so the
// bilinear addressing (clamp/floor/min → four cell indices + tx/ty) is IDENTICAL across them.
// The old code recomputed that addressing inside every sampleGrid call — 7× redundant per vertex,
// the dominant JS cost on the owner's software rasteriser. We now compute the addressing ONCE per
// vertex into these module temps and each grid is a cheap 4-read + 3-lerp gather. Numerically
// identical to sampleGrid (fx|0 == Math.floor(fx) for fx≥0; clamps + min match).
let _sb00 = 0, _sb01 = 0, _sb10 = 0, _sb11 = 0, _stx = 0, _sty = 0;
function sampleShared(g) {
  const a = g[_sb00], b = g[_sb01], c = g[_sb10], d = g[_sb11];
  const top = a + (b - a) * _stx;
  return top + ((c + (d - c) * _stx) - top) * _sty;
}
// PERF — per-column cache of sin(u*6.1+ph) for the cloth wobble (rebuilt each recompute; size VX).
// The wobble term sin(u..)·cos(v..) + 0.5·sin((u+v)..) had 3 trig/vertex; the sin(u..) factor
// depends only on the column and cos(v..) only on the row, so we hoist both out and leave ONE
// sin/vertex (the (u+v) cross term). Trig is a heavy per-vertex cost on a software rasteriser.
let _wobU = null;

// Rebuild the field surface at time t: TWO team A blankets (height + crisp
// coverage). B/C/D are removed, so this only drives the two blankets.
let _perfLastClock = null, _perfCadence = 0, _perfLastWall = null, _perfLastShoot = 0;
let _didFieldCompute = false;   // ADAPTIVE — true on frames where computeField actually recomputed (gates the per-frame overlay throttle)
function computeField(t, dt) {
  // PERF — gate the per-frame field recompute + 6× DataTexture re-upload (~375KB/frame
  // texSubImage2D and a ~9k-vertex JS loop). On a SNAP render (dt === Infinity: scrub,
  // slider, single-frame __setClock) ALWAYS compute so the frame is exact on demand.
  // While PLAYING (finite dt): skip when NOTHING has advanced (paused/settled), and
  // otherwise run at HALF cadence (every 2nd frame) so the field updates at ~30Hz while
  // the camera still renders at 60. Snap-safe: a scrub is never dropped by the cadence.
  //
  // KEY on BOTH clock AND wallProgress. An in-match penalty BEAT (PENBEAT) FREEZES the match
  // clock at the pen minute while the master `wallProgress` keeps advancing (the beat visuals
  // — dark wash, hill, flood, relief-flatten — are pure functions of wallProgress, not clock).
  // If we skipped on `clock` alone, every frame of a beat would early-return and the scene would
  // STALL on the last live team-coloured frame (field never goes to the dark stage, sky/lightning
  // frozen mid-strike) even though the beat state advances — the bug. Gating on wallProgress too
  // makes the beat animate in real playback. In normal play clock↔wallProgress move together, so
  // this is byte-identical off-beat (clock stalls ⟺ wallProgress stalls).
  const _snap = !Number.isFinite(dt);
  _didFieldCompute = false;   // PERF/ADAPTIVE — set true below when this frame actually recomputes the field (drives the overlay throttle)
  if (!_snap) {
    // KEY on shootWall too: the POST-MATCH SHOOTOUT freezes BOTH clock and wallProgress (its
    // choreography advances via the separate `shootWall` clock). Without this the beat's dark
    // stage / per-kick hills / zone highlight (all set inside computeField) would never recompute
    // during the shootout — the field would STALL on the end-of-match frame while only the HUD
    // labels (surnames) update. Off-shootout shootWall is a constant 0 → byte-identical.
    if (t === _perfLastClock && wallProgress === _perfLastWall && shootWall === _perfLastShoot) return;   // nothing advanced → nothing to re-upload
    // ADAPTIVE — recompute the field 1 of every `fieldStride` frames (was fixed at every 2nd).
    // The adaptive controller raises fieldStride (2→3→4) under load so the ~9k-vertex JS loop +
    // 6× DataTexture re-upload runs less often; the camera still renders every frame. Countdown
    // form (computes on the FIRST advancing frame, then skips fieldStride-1) — phase-matches the
    // old %2 and tolerates fieldStride changing mid-run.
    if (_perfCadence > 0) { _perfCadence--; return; }
    _perfCadence = Math.max(0, (fieldStride | 0) - 1);
  }
  _perfLastClock = t; _perfLastWall = wallProgress; _perfLastShoot = shootWall;
  _didFieldCompute = true;
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
  const goalK = Number.isFinite(cfg.A.goalH) ? clamp(cfg.A.goalH, 0, 12) : 4.5;  // GOAL spire height (independent of xgH)
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
  // STAGE11 CHANGE #3 — END-OF-MATCH SETTLE: as `settle` eases 0→1 at the final whistle,
  // the whole relief melts toward flat (like the post-goal lull) so the surface resolves to
  // a calm quiet state, then holds. settleEase softens the ramp so it glides, not snaps.
  const settleEase = smoothstep(0, 1, clamp(settle, 0, 1));
  // IN-MATCH PENALTY BEAT (PENBEAT, Option B) — the live beat at the master wallProgress (pure
  // function → scrub-safe) and its visuals from the local wall-offset. null when off / not in a
  // block / during the post-match shootout (which owns its own machinery). During the beat the
  // match is FROZEN (clock is pinned by clockFromWall), the field goes to the neutral DARK stage,
  // the kick plays, then SCORED floods the kicker colour / MISS shows the small hill.
  const penBeat = (PENBEAT && !shootActive) ? penBeatFromWall(wallProgress) : null;
  const penVis = penBeat ? penBeatVisual(penBeat) : null;
  // KEEP ~40% of the terrain during the post-goal lull (was full melt → a DEAD-FLAT field that
  // read as a "freeze" right after the goal/rollback). The goal crest is applied OUTSIDE reliefMul
  // so it still towers alone; the surrounding cloth just keeps some living shape instead of going
  // perfectly flat. Settle still melts fully (final held frame is calm).
  // During a pen beat the match terrain flattens toward the clean dark stage — REUSING the exact
  // end-of-match SETTLE melt (0.92, → ~8% relief) so it looks identical to the shootout's flat
  // dark plane, driven by penVis.flat (the SETTLE presence envelope). Was a weak 0.7 melt that
  // left live bumps under a tint (owner: "вообще не то"); now it genuinely calms to flat.
  // RELIEF melt for the pen beat — INSIDE a block use the beat's own reliefFlat (holds melted to
  // the block end, no in-place RESUME bloom); OUTSIDE a block use the RESUMED-clock recovery so the
  // ambient terrain eases back as play moves (not as a phantom static swell). Continuous across the
  // boundary (both ≈1 there). 0 when PENBEAT is off → reliefMul factor stays 1 (byte-identical).
  const meltRelief = penBeat ? (penVis ? penVis.reliefFlat : 0) : penRecoveryAt(t);
  const reliefMul = (1 - 0.6 * lullFlat) * (1 - 0.92 * settleEase) * (1 - 0.97 * meltRelief);
  // GOAL-CREST melt during a pen beat — a SCORED pen is in goalSpots, so at the FROZEN pen minute
  // wallSecondsSinceGoal≈0 → its goal spire would otherwise stand at FULL height the whole beat
  // (bypassing reliefMul), ruining the flat SETTLE frame. Melt it with penVis.flat so it flattens
  // during SETTLE, stays gone through PAUSE/HILL/RESOLVE (the beat's own hill+flood tell the goal),
  // and eases back on RESUME. 1 (no change) off-beat → byte-identical when PENBEAT is off.
  const goalCrestMul = 1 - meltRelief;

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
  // PENALTY WAVE — with PENBEAT OFF this is today's subtle clock-based pulse (byte-identical).
  // With PENBEAT ON the in-match pen moment is owned entirely by the frozen beat, so the old
  // clock-based pulse is disabled and the beat's own spot→goal wave (penVis.wave) is used.
  const penWaves = PENBEAT ? (penVis && penVis.wave ? [penVis.wave] : []) : (aOn ? penaltyWavesAt(t) : []);
  // SHOOTOUT KICK HILL — the current kick's coloured hill (redesign, replaces the old
  // neutral spot→goal pulse). Precompute its centre + inverse sigmas so the vertex loop
  // just evaluates a gaussian bump. Height goes to BOTH sheets; tint (kicker colour, via
  // uCornerCol below) is written into cData so it survives the dark base wash.
  const shHill = (aOn && shootActive) ? shootHillAt() : null;
  const shInvU = 1 / (2 * SHOOT_HILL_SIGU * SHOOT_HILL_SIGU);
  const shInvV = 1 / (2 * SHOOT_HILL_SIGV * SHOOT_HILL_SIGV);
  // IN-MATCH PENALTY BEAT hill — a kicker-colour gaussian at the spot (reuses the shootout hill's
  // sigmas + crest channel), added in the vertex loop below. null when off / not in a beat.
  const penHill = (penVis && penVis.hill) ? penVis.hill : null;
  // FLAT PENALTY-ZONE GLOW (no relief) — the goal-mouth/box patch shown during the WAIT, in the
  // taker's colour. In-match: penVis.zone (SETTLE/PAUSE). Shootout: shootZoneAt() (per-kick lead-in).
  // Both give {dir, v, env}; rendered as a flat cData tint (uCornerCol = taker/kicker colour).
  const zoneGlow = (penVis && penVis.zone) ? penVis.zone : ((aOn && shootActive) ? shootZoneAt() : null);
  // SCORED-PEN DIRECTIONAL FLOOD — a flat colour reveal (no height) that emanates FROM the pen goal
  // and sweeps outward. IN-BEAT (2026-07-14): the scored flood now RIDES this directional reveal
  // (penVis.floodReveal) over the dark stage — the scorer's colour sweeps out from the goal it was
  // scored in, FAST, no opponent territory — instead of the old uniform dark→scorer crossfade. On the
  // resumed clock the two-sheet front-blend (goalWaveAt pen branch) owns the colour + settle-to-centre.
  const penFlood = (aOn && penVis && penVis.floodReveal && !shootActive) ? penVis.floodReveal
                 : (aOn && !penVis && !shootActive) ? penScoredFloodAt(t) : null;
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
  // SMOOTH-WEAK (C) — FIELD INTERPOLATION. On the interp low path, snapshot the PREVIOUS field
  // (bH.hData still holds the last recompute's heights, not yet overwritten) into the prev texture,
  // then the vertex loop below writes the NEW field into hData. The vertex shader eases prev→new
  // over this recompute interval (uFieldMix 0→1 in renderFrame) so the relief FLOWS between the
  // (strided) recomputes instead of visibly stepping. Snapshot only on real recompute frames.
  // SACRED-DETAIL: with the mandated per-frame recompute (fieldStride === 1) the field is EXACT every
  // frame, so the prev→new interpolation is DISABLED (mix pinned at 1.0 → zero smear of event fingers,
  // matching baseline 5ef986b). The blend only ever engages if a future tier were to raise stride > 1.
  if (!_snap && fieldStride > 1 && bH.hPrevData && bA.hPrevData) {
    bH.hPrevData.set(bH.hData); bA.hPrevData.set(bA.hData);
    bH.hPrevTex.needsUpdate = true; bA.hPrevTex.needsUpdate = true;
    _fieldMixStart = (typeof performance !== 'undefined' ? performance.now() : 0);
    _fieldMixDurMs = Math.max(16, (fieldStride | 0) * Math.max(1, _frameEMA));
  } else {
    _fieldMixDurMs = 0;   // per-frame recompute / scrub → show the exact new field immediately (mix=1)
  }
  // CORNER-WAVE tint textures — cleared each frame; the loop writes the ripple crest tint
  // (0..1) into BOTH sheets so whichever laps on top shows the travelling attacking-colour band.
  bH.cData.fill(0); bA.cData.fill(0);
  // PERF — hoist the column-only wobble factor sin(u*6.1+ph) out of the vertex loop.
  if (!_wobU || _wobU.length !== VX) _wobU = new Float64Array(VX);
  for (let i = 0; i < VX; i++) _wobU[i] = Math.sin((i / (VX - 1)) * 6.1 + ph);
  const _agx = A_gx, _agy = A_gy;
  let idx = 0;
  for (let j = 0; j < VY; j++) {
    const v = j / (VY - 1);
    // PERF — row-only parts of the wobble + A-field bilinear addressing (constant across the row).
    const wobCosV = Math.cos(v * 5.3 - ph * 0.8);
    const _fyv = 1 - v; const _fy = (_fyv < 0 ? 0 : _fyv > 1 ? 1 : _fyv) * (_agy - 1);
    const _j0 = _fy | 0; const _j1 = _j0 + 1 < _agy ? _j0 + 1 : _agy - 1;
    const _r0 = _j0 * _agx, _r1 = _j1 * _agx; const _tyRow = _fy - _j0;
    for (let i = 0; i < VX; i++, idx++) {
      const u = i / (VX - 1);
      const wob = _wobU[i] * wobCosV + 0.5 * Math.sin((u + v) * 9.7 - ph * 1.3);
      // PERF — per-column part of the A-field bilinear addressing, combined with the row part
      // above into the shared cell indices used by all 7 sampleShared() calls in the aOn block.
      const _fx = (u < 0 ? 0 : u > 1 ? 1 : u) * (_agx - 1);
      const _i0 = _fx | 0; const _i1 = _i0 + 1 < _agx ? _i0 + 1 : _agx - 1;
      _sb00 = _r0 + _i0; _sb01 = _r0 + _i1; _sb10 = _r1 + _i0; _sb11 = _r1 + _i1;
      _stx = _fx - _i0; _sty = _tyRow;
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
      // ---- PENALTY-ZONE FLAT GLOW (the WAIT): a calm flat patch (NO height) over the goal-mouth/box
      // being attacked, in the taker's colour (uCornerCol set below). Rounded rectangle straddling the
      // pen goal line, ~box-deep along u and ~box-wide along v. Tint-only → reads as "here's the pen". ----
      if (zoneGlow) {
        const goalU = zoneGlow.dir > 0 ? 1 : 0;
        const uIn = 1 - smoothstep(0.10, 0.24, Math.abs(u - goalU));   // ~box depth from the goal line
        const lat = 1 - smoothstep(0.20, 0.33, Math.abs(v - zoneGlow.v));   // ~box width
        const zt = uIn * lat * zoneGlow.env * 0.55;                    // calm flat glow (not full solid)
        if (zt > cwTint) cwTint = zt;
      }
      // ---- SCORED-PEN DIRECTIONAL FLOOD: reveal the scorer's colour (uCornerCol) as a FLAT wash whose
      // front (penFlood.revU) starts AT the pen goal line and sweeps across to the far end, so the colour
      // EMANATES FROM the pen side and spreads outward (no height; purely the cData tint channel). ----
      if (penFlood) {
        const inF = penFlood.sign > 0 ? smoothstep(penFlood.revU - 0.05, penFlood.revU + 0.05, u)
                                      : smoothstep(penFlood.revU + 0.05, penFlood.revU - 0.05, u);
        const zt = inF * penFlood.strength;
        if (zt > cwTint) cwTint = zt;
      }

      // ---- Layer A: per-team blanket height + crisp coverage ----
      let hH = 0, hA = 0, covH = 0, covA = 0;
      if (aOn) {
        // height from contributors (per team), normalised + floor + gamma.
        // All sampling reads the SMOOTHED grids so the surface glides.
        let rH = sampleShared(A_shH) / aMax;
        let rA = sampleShared(A_shA) / aMax;
        if (flr > 0) { rH = clamp((rH - flr) / (1 - flr), 0, 1); rA = clamp((rA - flr) / (1 - flr), 0, 1); }
        if (gamma !== 1) { rH = Math.pow(rH, gamma); rA = Math.pow(rA, gamma); }
        // xG SHARP crest added ON TOP of the swell (not normalised/floored). This
        // is the ONLY tall SPIRE in the scene, and it stands ONLY where a REAL shot
        // landed (A_sxH/A_sxA are stamped exactly at each shot's pitch spot and fade
        // a couple seconds after — see contribLift/computeA). Away from shots there
        // is NO spire, only the gentle mounds below.
        const xH = sampleShared(A_sxH);
        const xA = sampleShared(A_sxA);
        const gCrH = sampleShared(A_sgH);   // GOAL crest (own grid)
        const gCrA = sampleShared(A_sgA);
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
        let front = sampleShared(A_sown);   // front-u for this cell
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
        // MOUNDS are capped LOW (tame swells); the xG SPIRE + GOAL crest are then added ON
        // TOP so danger clearly TOWERS above the terrain (fixes «не вижу усиление xG»: before,
        // the xG crest shared the mound's 4.5 cap so a busy area swallowed it). Total capped
        // higher so a real chance reads as a distinct rise, streaks even taller (contribLift).
        let moundH = (rH * 0.5 * amp * moundMask * notch) * reliefMul;
        let moundA = (rA * 0.5 * amp * moundMask * notch) * reliefMul;
        moundH = Math.min(moundH, 4.0); moundA = Math.min(moundA, 4.0);
        // xG SPIRE — per team (its OWN blanket), CAPPED LOW (XG_SPIRE_MAX) so a chance's peak
        // is clearly SHORTER than a goal (xG ≈ half a goal). The peak shows in the SHOOTING
        // team's colour because a dangerous shot's LUNGE (thrust finger, high reach) pushes
        // that team's front TO the shot spot → their blanket is on top there → coloured peak.
        const xCrH = Math.min((xH * crestK * fmCrest * crestNotch) * reliefMul, XG_SPIRE_MAX);
        const xCrA = Math.min((xA * crestK * fmCrest * crestNotch) * reliefMul, XG_SPIRE_MAX);
        let reliefH = moundH + xCrH + gCrH * goalK * crestNotch * goalCrestMul;
        let reliefA = moundA + xCrA + gCrA * goalK * crestNotch * goalCrestMul;
        reliefH = Math.min(reliefH, 9.0); reliefA = Math.min(reliefA, 9.0);   // total cap high so a GOAL crest towers
        // PER-TEAM RELIEF — each blanket carries its OWN (notched-at-seam) height, so
        // the two sheets are TWO DISTINCT surfaces; the visible LAP is the TOP sheet's
        // short lip fold (vertex shader), never a merged plane.
        // END-OF-MATCH SETTLE also quiets the tiny cloth wobble so the held final frame
        // is truly still (motion damps), not gently breathing forever.
        // During a pen beat also DAMP the cloth wobble (same 0.95 as the end-of-match settle) so
        // the SETTLE/PAUSE frame is truly STILL — a clean flat dark plane, not breathing cloth.
        const wobMul = A_WOBBLE * (1 - 0.95 * settleEase) * (1 - 0.97 * meltRelief);
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
      // SHOOTOUT KICK HILL — a gaussian rise in the kicker's colour at the spot (added to
      // BOTH sheets so it stands on the dark neutral base). Its tint feeds the same cData
      // channel (uCornerCol = kicker colour during the shootout), applied AFTER uFlood in
      // the shader so the coloured hill shows on top of the dark wash.
      if (shHill) {
        const dU = u - shHill.u, dV = v - shHill.v;
        const g = Math.exp(-(dU * dU) * shInvU - (dV * dV) * shInvV);
        if (g > 0.01) { hH += shHill.h * g; hA += shHill.h * g; const tt = shHill.tint * g; if (tt > cwTint) cwTint = tt; }
      }
      // IN-MATCH PENALTY BEAT hill (PENBEAT) — same gaussian + crest channel as the shootout
      // hill, at the penalty's OWN spot (u,v). Height adds to both sheets so it stands on the
      // dark neutral wash; the tint feeds cwTint (coloured by the kicker via cwCol below).
      if (penHill) {
        const dU = u - penHill.u, dV = v - penHill.v;
        const g = Math.exp(-(dU * dU) * shInvU - (dV * dV) * shInvV);
        if (g > 0.01) { hH += penHill.h * g; hA += penHill.h * g; const tt = penHill.tint * g; if (tt > cwTint) cwTint = tt; }
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
  // In normal play uFlood stays 0 (the goal flood rolls via the FRONT, not this uniform).
  // During the SHOOTOUT it drives the whole redesign: a DARK NEUTRAL base wash, and on a
  // SCORED kick (or the finale) the wash colour eases to the kicker's/winner's colour and
  // the strength to full — the whole field floods that colour. A MISS keeps the dark base.
  if (shootActive) {
    const sw = shootoutWaveAt();                 // {team, cover} on a scored flood / finale, else null
    let amt = SHOOT_DARK_AMT;
    _shootCol.copy(SHOOT_DARK_COL);
    if (sw) { const c = clamp(sw.cover, 0, 1); amt = lerp(SHOOT_DARK_AMT, 1, c); _shootCol.lerp(teamColor(sw.team), c); }
    bH.u.uFlood.value = amt; bA.u.uFlood.value = amt;
    bH.u.uFloodTeam.value.copy(_shootCol); bA.u.uFloodTeam.value.copy(_shootCol);
  } else if (penVis) {
    // IN-MATCH PENALTY BEAT (PENBEAT) — uFlood is the DARK NEUTRAL stage wash ("the field has no
    // colour") that ramps in over SETTLE and holds through the kick. The SCORED flood is NO LONGER a
    // uniform dark→scorer crossfade here (2026-07-14): the scorer's colour now EMANATES DIRECTIONALLY
    // from the pen goal via the cData reveal (penVis.floodReveal → penFlood, painted in the vertex
    // loop) over this dark base — so the owner SEES it sweep out from the goal it was scored in, FAST,
    // with no opponent territory. uFlood therefore stays the dark neutral base for BOTH scored + miss.
    // penScoredUFloodAt() then bridges the resumed clock and the front-blend owns the settle-to-centre.
    _shootCol.copy(SHOOT_DARK_COL);
    const amt = penVis.dark * SHOOT_DARK_AMT;
    bH.u.uFlood.value = amt; bA.u.uFlood.value = amt;
    bH.u.uFloodTeam.value.copy(_shootCol); bA.u.uFloodTeam.value.copy(_shootCol);
  } else {
    // NORMAL PLAY — uFlood stays 0 (a normal GOAL floods via the FRONT/seam). EXCEPTION: a SCORED
    // in-match penalty on the RESUMED clock floods the WHOLE field the scorer's colour (uniform),
    // continuing the beat's flood and easing back to live play. penScoredUFloodAt is null otherwise.
    const psf = penScoredUFloodAt(t);
    if (psf) {
      bH.u.uFlood.value = psf.amt; bA.u.uFlood.value = psf.amt;
      const pc = teamColor(psf.team); bH.u.uFloodTeam.value.copy(pc); bA.u.uFloodTeam.value.copy(pc);
    } else {
      bH.u.uFlood.value = 0; bA.u.uFlood.value = 0;
    }
  }
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
  // Set-piece crest colour = neutral pitch-line white in normal play; during the SHOOTOUT
  // the shared crest/tint channel carries the KICK HILL, so it takes the KICKER's colour.
  let cwCol = (shootActive && shHill) ? teamColor(shHill.team) : SETPIECE_COL;
  // SHOOTOUT ZONE glow (per-kick lead-in, before/with the hill) reads in the KICKER's colour.
  if (shootActive && zoneGlow && zoneGlow.team && !shHill) cwCol = teamColor(zoneGlow.team);
  // PENBEAT — during an in-match penalty beat the hill + directional wave + zone glow read in the
  // KICKER's colour (matching the shootout). Off-flag / off-beat this stays SETPIECE_COL, so the
  // regulation corner/penalty crest is neutral exactly as today.
  if (penVis && !(shootActive && shHill)) cwCol = teamColor(penVis.pen.team);
  // SCORED-PEN DIRECTIONAL FLOOD (resumed clock) reads in the SCORER's colour.
  if (penFlood) cwCol = teamColor(penFlood.team);
  bH.u.uCornerCol.value.copy(cwCol); bA.u.uCornerCol.value.copy(cwCol);
  bH.cTex.needsUpdate = true; bA.cTex.needsUpdate = true;
  bH.hTex.needsUpdate = true; bH.aTex.needsUpdate = true;
  bA.hTex.needsUpdate = true; bA.aTex.needsUpdate = true;
  bH.mesh.visible = aOn; bA.mesh.visible = aOn;
  // STAGE13 — the thickness skirts (торец walls) share the top sheets' uniforms
  // (height/cov/flood/lap/lipH/time), so their geometry updates for free; just track
  // visibility.
  if (bH.skirt) bH.skirt.mesh.visible = aOn;
  if (bA.skirt) bA.skirt.mesh.visible = aOn;
  // GOAL-FLOOD SLIVER FADE. The regulation goal floods the pitch via the swept FRONT alone: the
  // scorer's territory grows to cover the whole pitch, so every cell keeps its OWN honest colour
  // (no recolour). The only defect was a thin uLap-wide SLIVER of the LOSING sheet surviving at
  // the conceded edge (its own colour → a leftover opponent strip on the surface + its perimeter
  // wall). We remove it by FADING the LOSER sheet's coverage to zero at the flood peak — driven
  // by `floodTint`, which RISES as the front rolls to the conceded end and RECEDES to 0 as the
  // front sweeps back to centre. So: peak → loser faded out, only the winner's colour shows, no
  // sliver; откат → loser fades back in and each half is its OWN colour again. uFloodFade is set
  // ONLY on the conceding (losing) sheet; the scorer's sheet stays 0 (it's the one covering). The
  // skirts SHARE each top sheet's uFloodFade uniform, so the loser's wall fades with its face.
  // Shootout floods are handled by uFlood (full-field dark→kicker wash on both sheets); there is
  // no per-half revert there, so uFloodFade stays 0 during a shootout.
  {
    const ft = (!shootActive && wave2 && wave2.floodTint != null) ? clamp(wave2.floodTint, 0, 1) : 0;
    // conceding sheet = the one that did NOT score; fade only it.
    const homeFade = (ft > 0 && wave2.team !== 'home') ? ft : 0;
    const awayFade = (ft > 0 && wave2.team !== 'away') ? ft : 0;
    bH.u.uFloodFade.value = homeFade;   // skirt shares this uniform object → wall fades too
    bA.u.uFloodFade.value = awayFade;
  }
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
  // The EffectComposer's default read/write RenderTargets need an ALPHA channel so the
  // PORTRAIT/REELS full-bleed fix can carry through transparency (empty scene → alpha 0 →
  // the full-bleed CSS #backdrop shows edge-to-edge, no opaque "square-in-a-square"). Without
  // an alpha buffer here the chain composites onto opaque black regardless of clearAlpha.
  composer.renderTarget1.texture.format = THREE.RGBAFormat;
  composer.renderTarget2.texture.format = THREE.RGBAFormat;
  // RenderPass must CLEAR to the renderer's current clear (color+ALPHA). updateSky flips the
  // renderer clearAlpha to 0 in portrait-capture; keep the pass honouring that (don't force it).
  renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  // STAGE-7 POST — soft UnrealBloom on the bright crests/ember (gentle, not a haze),
  // then the vignette/exposure/contrast/saturation grade, SMAA, output. Values are
  // stage7's tuned defaults so the look matches (pleasant IBL, no plastic wash).
  // PERF/OOM — the bloom pass allocates a chain of mip render targets (extra VRAM + fill).
  // ADAPTIVE — ALWAYS create it (EffectComposer honours pass.enabled), but start it enabled
  // ONLY when the active quality level allows bloom (strong desktop → on; everyone else → off).
  // The runtime controller flips .enabled as it steps up/down; onResize keeps its size in sync.
  bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.12, 0.3, 0.52);
  bloomPass.enabled = !!QUAL_LADDER[_qLevel].bloom;
  composer.addPass(bloomPass);
  gradePass = new ShaderPass(GradeShader);
  gradePass.uniforms.uVig.value = 0.82; gradePass.uniforms.uExpo.value = 1.72;   // STAGE13 FIX — softened (was 1.28): the canvas is FULL-BLEED now, so a strong post vignette crushed the whole page into black corners around a bright disc. A gentle vignette lets the layered leader-tinted atmosphere breathe edge-to-edge while still settling the far corners.
  gradePass.uniforms.uContr.value = 1.12; gradePass.uniforms.uGsat.value = 1.3;
  composer.addPass(gradePass);
  // PERF — SMAA edge pass dropped (extra full-res pass). The DPR cap + bloom carry the look;
  // edge shimmer is negligible at this framing and the FPS win is worth it. (smaaPass stays
  // undefined; the onResize guards below no-op.)
  // smaaPass = new SMAAPass(1, 1); composer.addPass(smaaPass);
  composer.addPass(new OutputPass());
}
const GradeShader = {
  // uKeepAlpha: 0 = force opaque (default, every non-portrait mode — byte-identical to before);
  //             1 = PRESERVE the source alpha so the transparent empty scene stays transparent
  //             through the grade (portrait/reels full-bleed). The vignette then must NOT crush
  //             alpha toward black either, so we apply it to RGB only and pass alpha straight.
  uniforms: { tDiffuse: { value: null }, uVig: { value: 0.5 }, uExpo: { value: 1.0 }, uContr: { value: 1.06 }, uGsat: { value: 1.04 }, uKeepAlpha: { value: 0.0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uVig; uniform float uExpo; uniform float uContr; uniform float uGsat; uniform float uKeepAlpha; varying vec2 vUv;
    void main(){ vec4 src = texture2D(tDiffuse, vUv); vec3 c = src.rgb; c *= uExpo;
      float l = dot(c, vec3(0.2126,0.7152,0.0722)); c = mix(vec3(l), c, uGsat);
      c = (c - 0.5) * uContr + 0.5;
      vec2 d = vUv - 0.5; float vig = smoothstep(0.85, 0.25, length(d)*1.4); c *= mix(1.0, vig, clamp(uVig,0.0,1.5));
      float a = mix(1.0, src.a, clamp(uKeepAlpha, 0.0, 1.0));
      gl_FragColor = vec4(max(c,0.0), a); }`,
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
  // SMOOTH-WEAK (C) — advance the field-interpolation ease every PRESENTED frame so the cloth flows
  // between (strided) recomputes. uFieldMix stays 1.0 (identity) off the interp tiers and on SNAP
  // renders (scrub/single-frame → exact new field). The skirt shares this uniform object.
  if (blankets && blankets.home.hPrevData) {
    let mix = 1;
    if (Number.isFinite(dt) && _fieldMixDurMs > 0) {
      mix = (performance.now() - _fieldMixStart) / _fieldMixDurMs;
      mix = mix < 0 ? 0 : mix > 1 ? 1 : mix;
    }
    blankets.home.u.uFieldMix.value = mix; blankets.away.u.uFieldMix.value = mix;
  }
  // OWNER-REJECTED — shot-dot reveal disabled (shotDotGroup is never built; see buildTeamBlankets).
}
// Frame-rate-independent exponential smoothing factor for a given time constant
// tau (seconds): state += (target - state) * expA(dt, tau). dt = Infinity → 1
// (instant snap). Small dt → small step → glide. tau bigger = calmer/slower.
// expA() -> ./modules/util.js (imported at top)
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
// PERF — trailing-debounced resize handler (~150ms). Bound to the window 'resize' event so a
// rapid burst (mobile URL-bar collapse/expand, live drag) triggers only ONE renderer/composer/
// bloom setSize once the stream settles. Direct onResize() calls (initial layout, orientation)
// stay synchronous. Pure timing wrapper — the resize math is unchanged.
let _resizeTimer = null;
function onResizeDebounced() {
  if (_resizeTimer) clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => { _resizeTimer = null; onResize(); }, 150);
}
function onResize() {
  // STAGE13 FIX — the 3D canvas is now FULL-VIEWPORT (full-bleed) so the sky dome fills the
  // whole page (one background, no centred rectangle). Size the renderer to the stage canvas's
  // client box (= the viewport). The frustum HALF-HEIGHT is anchored to the old ~1000px-column
  // framing (see setOrthoFrustum) so the pitch keeps its previous on-screen size + centring.
  const canvas = el('stage');
  const w = Math.max(1, canvas ? canvas.clientWidth : window.innerWidth);
  const h = Math.max(1, canvas ? canvas.clientHeight : window.innerHeight);
  _cw = w; _ch = h;   // PERF — cache the canvas client box so the per-frame overlay draws never read it (layout thrash after HUD innerHTML writes).
  const dpr = effectiveDPR();   // PERF — DPR cap (adaptive tier cap + a hard 2.0 mobile ceiling; down to 0.5 on the software floor).
  renderer.setPixelRatio(dpr); renderer.setSize(w, h, false);
  // ORTHOGRAPHIC — pass the real viewport w/h so the frustum anchors its height to the column
  // framing while width follows the full aspect (preserving the current OrbitControls zoom).
  if (camera.isOrthographicCamera) setOrthoFrustum(w / h, h, w);
  else { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  if (composer) {
    composer.setPixelRatio(dpr); composer.setSize(w, h);
    if (bloomPass) bloomPass.setSize(w * dpr * 0.5, h * dpr * 0.5);   // PERF — render UnrealBloom at half resolution (bloom is a soft glow; 0.5× is imperceptible).
    if (smaaPass) smaaPass.setSize(w * dpr, h * dpr);   // no-op: SMAA pass dropped for perf (smaaPass undefined).
  }
  resizeOverlays();          // STAGE11 #5/#6 — keep the 2D overlay canvases crisp
  _lightning.size();         // keep the full-viewport red-card lightning overlay crisp
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
// PLAY triangle nudged slightly RIGHT (~1.3px ≈ 9% of glyph width) so its OPTICAL centre —
// which sits right of the geometric centre for a triangle — lands in the middle of the circle.
// SOLID WHITE circle (see .play13 CSS) with a DARK filled glyph — standard filled play button.
const _PLAY_SVG  = '<svg width="16" height="18" viewBox="0 0 16 18" aria-hidden="true"><path d="M1 1 L15 9 L1 17 Z" fill="#05060c" stroke="#05060c" stroke-width="1.4" stroke-linejoin="round" transform="translate(1.3 0)"/></svg>';
const _PAUSE_SVG = '<svg width="16" height="18" viewBox="0 0 16 18" aria-hidden="true"><rect x="2.5" y="1.5" width="3.6" height="15" rx="0.6" fill="#05060c"/><rect x="9.9" y="1.5" width="3.6" height="15" rx="0.6" fill="#05060c"/></svg>';
// SUBSTITUTION LOOP — two arrows chasing around a horizontal oval (broadcast sub glyph),
// ref Noun Project loop-7438951. Defined ONCE here; also inlined in the how-to-read legend
// (stage13.html .hl-sub) — keep the two in sync if you refine the glyph. Monochrome
// (currentColor) so it tints to the team colour on the timeline / white in the legend.
// Circular swap (variant #3): two arcs, each ending in an arrowhead — one source of truth, reused by
// the timeline sub markers (glyph()) and the how-to-read legend. Tiny markers use a thicker stroke so
// the thin arcs still read at ~13px (viewBox 0 0 48 48; 4.2 ≈ the old 22-box 2.1 weight when scaled).
const SUB_LOOP_SVG = '<svg width="10" height="10" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 22A13 13 0 0 1 35 16"/><path d="M37 26A13 13 0 0 1 13 32"/><path d="M34.27 9.04 35 16 28 15.75"/><path d="M13.73 38.96 13 32 20 32.25"/></svg>';
function setPlayGlyph(isPlaying) {
  const pb = el('play'); if (pb) pb.textContent = isPlaying ? '❚❚' : '▶';
  const p13 = el('play13'); if (p13) p13.innerHTML = isPlaying ? _PAUSE_SVG : _PLAY_SVG;
}
let _glyphState = null;
let _glHealthy = false;   // set true after the first successful composer.render() → clears the reload-loop guard.

// ============================================================================
// ADAPTIVE QUALITY CONTROLLER — the real safety net. The rAF inter-frame interval
// IS the true GPU-inclusive frame time, so we smooth it (EMA) and ratchet the
// quality ladder to hold a usable budget. A fast desktop never breaches the
// step-DOWN threshold → it stays pinned at its starting (full) level forever.
// ============================================================================
let _frameEMA = 16.7;          // EMA of the rAF interval (ms); seeded near 60fps
let _lastInteract = 0;         // performance.now() of the last orbit/scrub (spiky frames → excluded)
let _interacting = false;      // true WHILE a pointer drag (orbit/dolly/pan) is in progress
let _warmupUntil = 0;          // controller ignores everything until ~1s after the first healthy render
// SMOOTH-WEAK (A1 backstop) — for the first ~2.5s on a non-strong desktop the controller reacts
// MUCH faster (short warmup + a low step-down trigger) so any descent the startup probe didn't
// pre-empt (e.g. a JS-bound cost the gl.finish snap under-read) lands within ~0.3s and is cross-
// faded, instead of the old ~2s multi-rung cascade the owner watched happen. After the window the
// calm, stability-biased thresholds take over. Strong/mobile: inert (never over budget / own path).
let _fastConvergeUntil = 0;
let _changeSettleUntil = 0;    // after a level change, ignore a few frames while it stabilises
let _downFrames = 0, _downMs = 0;   // consecutive over-budget frames + accumulated over-budget time
let _goodSince = 0;            // start of the current sustained-good window (for cautious step-UP)
let _pendingUpFrom = -1, _pendingUpAt = 0;   // watch a just-taken step-UP for an immediate regress → lock
// STABILITY LATCH (anti-hunt) — a SESSION ratchet. Every forced step-DOWN records the level we are
// LEAVING as unsustainable and raises the ceiling (_qMaxLevel) one notch worse, so the controller
// may NEVER re-attempt that level this session. Repeated failures ratchet the ceiling down until it
// lands on a tier the device holds, then it STAYS there — no more climb→fail→climb hunting (the
// owner's HD-520 "иногда хорошее, иногда сваливается" popping). _qConverged is a readout of "the
// ceiling has met the current level, there is nowhere left to climb" (also implied by _qLocked).
let _qConverged = false;
// DEFERRED / COOLDOWN'd GRID — the terrain rebuild is the single most expensive lever (dispose +
// rebuild both blankets + textures + a full field recompute = a GPU stall = the intermittent
// hitches). It is DECOUPLED from fast adaptation: a level change adjusts the cheap levers
// (dpr/cap/bloom/shadow/stride) IMMEDIATELY but only SCHEDULES the grid; the rebuild fires once the
// level has stopped moving for GRID_SETTLE_MS and a global GRID_COOLDOWN_MS has elapsed since the
// last one. So a fast multi-step descent rebuilds the geometry ONCE at its resting tier instead of
// 3–4× on the way down, and a converged tier never rebuilds again.
let _gridPendingGX = 0, _gridPendingGY = 0, _gridPendingAt = 0, _lastGridBuildAt = 0;
const GRID_SETTLE_MS = 2000;   // level must be quiet this long before the (deferred) grid rebuilds
const GRID_COOLDOWN_MS = 5000; // and at least this long since the previous rebuild (thrash guard)
const Q_DOWN_MS = 24;          // > ~24ms EMA (≈ <42fps) = over budget → step down
// rAF is vsync-capped, so a machine comfortably holding 60fps reads ~16.7ms and can NEVER dip
// below 15ms — the "headroom" signal must sit just ABOVE the 60fps floor. EMA < 18ms ≈ "holding
// 60fps, not dropping frames" → there's room to try one step up. (On a 120Hz panel it reads ~8ms,
// also < 18, so the same rule works.)
const Q_UP_MS = 18;            // < 18ms EMA sustained = holding target → cautious step up
const Q_REGRESS_MS = 22;       // after a step-UP, EMA climbing past this (short of a full step-down) = the up-move cost frames → revert + lock
// HYSTERESIS — step-UP demands a MUCH longer, cleaner sustained-headroom window than step-down, so
// the controller is heavily biased toward STAYING PUT. Any frame at/over Q_UP_MS resets the window,
// so the whole 7s must be uninterrupted 60fps-class headroom before a single cautious climb.
const Q_UP_HOLD_MS = 7000;     // step-UP needs this long a CLEAN good window (was 4000; lengthened for stability)
// DESKTOP DPR SHARP-CLIMB tuning. DPR is cheap to evaluate, so it climbs FAST (short hold) toward
// native and settles in a few monotonic sharpen steps — no long wandering. The climb is gated on the
// SAME 60fps-clean signal as a step-up (Q_UP_MS) so it never overshoots into lag (protects the "no
// lag" win); a raise that DOES cost too much (EMA past the down threshold) reverts one step + latches.
const DPR_CLIMB_STEP    = 0.25;    // gentle per-step sharpen (1.0 → 1.25 → 1.5 → … → native), each crossfaded
const DPR_CLIMB_HOLD_MS = 1100;    // clean-headroom hold before each raise — short (reach sharp in a few seconds, then lock)
function _applyQualityLevel(idx, reason) {
  idx = clamp(idx | 0, 0, QL_FLOOR);
  if (idx === _qLevel && reason !== 'init') { /* still re-apply on init */ return; }
  // SMOOTH-WEAK (A2) — cross-fade the dpr/bloom/shadow pop of a runtime level change (never on the
  // initial apply, the dev __setQual, or the pre-first-frame startup probe → nothing to hide there).
  if (reason !== 'init' && reason !== 'manual' && reason !== 'startup probe') _qCrossfade();
  _qLevel = idx;
  const L = QUAL_LADDER[idx];
  fieldStride = L.stride;
  if (bloomPass) bloomPass.enabled = !!L.bloom;
  _setQualityShadow(L.shadow);
  DPR_CAP = L.dpr;
  try { onResize(); } catch {}   // re-applies DPR to renderer+composer+bloom (mirrors the resize path)
  // GRID PROMOTION/DEMOTION — DEFERRED. Do NOT rebuild the geometry inline (that stall on every tick
  // is the hitch source). Just SCHEDULE the target grid; the cooldown'd executor in adaptiveTick
  // rebuilds it once the level settles. Cancel a pending change that this move made moot.
  // SACRED-DETAIL: the terrain grid is FIXED at 160×96 on every rung, so there is no grid promotion/
  // demotion to schedule (that lever is retired). The ONLY per-level geometry change is the EFFECT-only
  // fragment-path flip when a device settles on / climbs out of a weak rung — a same-dimension recompile.
  _gridPendingGX = 0; _gridPendingGY = 0;
  if (reason !== 'init') { try { _syncCheapFrag(); } catch {} }
  _changeSettleUntil = performance.now() + 500;
  _frameEMA = Q_UP_MS;   // neutral reseed at the up/hold boundary so the next window re-measures the NEW cost cleanly (neither up nor down fires until real frames arrive)
  _downFrames = 0; _downMs = 0; _goodSince = 0;
  // reset the adaptive cap: run uncapped for the measure window, then re-lock to this tier's cost.
  _capLocked = false; _capMeasureUntil = performance.now() + 2500; _capMeasPeak = 0;
  try { console.info(`[stage13] quality → L${idx} (${reason}) dpr${L.dpr} bloom${L.bloom ? 1 : 0} shadow${L.shadow} stride${L.stride} grid${GX}×${GY}`); } catch {}
}
function _setQualityShadow(state) {
  if (!keyLight) return;
  if (state <= 0) {
    if (keyLight.castShadow) { keyLight.castShadow = false; if (renderer) renderer.shadowMap.needsUpdate = true; }
    return;
  }
  if (!keyLight.castShadow) { keyLight.castShadow = true; if (renderer) renderer.shadowMap.needsUpdate = true; }
  if (keyLight.shadow.mapSize.width !== state) {
    keyLight.shadow.mapSize.set(state, state);
    if (keyLight.shadow.map) { try { keyLight.shadow.map.dispose(); } catch {} keyLight.shadow.map = null; }
    if (renderer) renderer.shadowMap.needsUpdate = true;
  }
}
function adaptiveTick(now, interval) {
  if (document.hidden) return;
  if (_isCaptureMode()) return;                  // VIDEO/export & test drive → FREEZE quality (never downgrade the rendered video); paired with ?qstart=0 the export renders at full level 0 (bloom+shadows+full fragment, 160×96 per-frame)
  if (!_glHealthy) return;                       // wait for the first healthy render
  const _fastCvg = SMOOTH_WEAK && GPU_CLASS !== 'strong' && !IS_MOBILE_TIER;
  if (_warmupUntil === 0) {
    _warmupUntil = now + (_fastCvg ? 400 : 1000);   // shorter warmup on weak desktop → react sooner
    if (_fastCvg) _fastConvergeUntil = now + 2500;
  }
  if (now < _warmupUntil || now < _changeSettleUntil) return;   // warmup / post-change settle
  // Exclude spiky frames: a tab-return / long stall, or frames right after an orbit/scrub.
  if (interval > 1000) return;
  if (_interacting || (now - _lastInteract) < 350) return;   // skip active drags + a short settle tail
  // ---- DEFERRED GRID EXECUTOR — rebuild the terrain geometry only after the level has been quiet
  // for GRID_SETTLE_MS and a cooldown since the last rebuild. A fast descent keeps bumping
  // _gridPendingAt, so the (single) rebuild lands only once the tier has settled. Once converged the
  // level stops moving → no new pending grid → this never fires again = no post-convergence thrash.
  if (_gridPendingGX && (_gridPendingGX !== GX || _gridPendingGY !== GY)
      && (now - _gridPendingAt) >= GRID_SETTLE_MS && (now - _lastGridBuildAt) >= GRID_COOLDOWN_MS) {
    const gx = _gridPendingGX, gy = _gridPendingGY;
    _gridPendingGX = 0; _gridPendingGY = 0; _lastGridBuildAt = now;
    _qCrossfade();   // SMOOTH-WEAK (A2) — blur-mask the geometry snap so the grid rebuild doesn't visibly pop
    try { rebuildTerrainGrid(gx, gy); } catch {}
    _changeSettleUntil = now + 600;   // the rebuild is a one-off stall → don't let it trip a step-down
    _frameEMA = Q_UP_MS; _downFrames = 0; _downMs = 0; _goodSince = 0;
    // the geometry just changed → re-measure + re-lock the cap on the FINAL grid (not the old one).
    _capLocked = false; _capMeasureUntil = now + 2500; _capMeasPeak = 0;
    return;
  }
  _frameEMA = _frameEMA * 0.9 + interval * 0.1;
  const _downMsThresh = IS_MOBILE_TIER ? 34 : Q_DOWN_MS;   // mobile tolerates ~30fps (see step-down note)
  // ---- MOBILE DPR REGRESS GUARD — judge a just-applied native-DPR raise. Runs BEFORE the level
  // step-down so that if the sharper pixels cost too much we revert the (cheap) DPR lever instead of
  // dropping the whole tier and barring level 0. Reverts to 2.0 + LATCHES (never retries this session)
  // → no dpr oscillation. Accepts the raise once it has held clean for the measure window.
  if (_mobileDprPendingAt) {
    if (_frameEMA > _downMsThresh) {
      _mobileDprPendingAt = 0; _mobileDprLatched = true; _mobileDprCap = MOBILE_DPR_BASE;
      try { onResize(); } catch {}
      _changeSettleUntil = now + 600; _frameEMA = Q_UP_MS; _downFrames = 0; _downMs = 0; _goodSince = 0;
      try { console.info('[stage13] mobile DPR raise regressed → revert 2.0 + latch'); } catch {}
      return;
    } else if (now - _mobileDprPendingAt > 2500) {
      _mobileDprPendingAt = 0;   // the sharper pixels have held → keep native DPR
      try { console.info(`[stage13] mobile DPR raise held → ${_mobileDprCap} accepted`); } catch {}
    }
  }
  // ---- DESKTOP DPR REGRESS GUARD — judge a just-applied sharp-climb raise. Runs BEFORE the level
  // step-down so a raise that cost too much reverts the (cheap, decoupled) DPR lever by one step and
  // LATCHES — it never drops the effects level (that would be a visible wander) and never retries.
  if (_desktopDprPendingAt) {
    if (_frameEMA > _downMsThresh) {
      _desktopDprPendingAt = 0; _desktopDprLatched = true;
      _desktopDpr = Math.max(DESKTOP_DPR_START, +(_desktopDpr - DPR_CLIMB_STEP).toFixed(3));
      _qCrossfade(); try { onResize(); } catch {}
      _changeSettleUntil = now + 600; _frameEMA = Q_UP_MS; _downFrames = 0; _downMs = 0; _goodSince = 0;
      try { console.info(`[stage13] desktop DPR raise regressed → revert ${_desktopDpr} + latch`); } catch {}
      return;
    } else if (now - _desktopDprPendingAt > 2500) {
      _desktopDprPendingAt = 0;   // the sharper pixels have held → keep them
      try { console.info(`[stage13] desktop DPR raise held → ${_desktopDpr} accepted`); } catch {}
    }
  }
  // ---- REGRESS GUARD — if a recent step-UP made things WORSE (EMA creeping back up, even short
  // of a full step-down), REVERT it and LOCK the ratchet: never try to climb past that level
  // again. This is the one-way-ish ratchet that stops oscillation on a machine sitting right at
  // the edge of a level's budget.
  if (_pendingUpAt) {
    if (_frameEMA > Q_REGRESS_MS) {
      const back = _pendingUpFrom;
      _pendingUpFrom = -1; _pendingUpAt = 0;
      _qMaxLevel = Math.max(_qMaxLevel, back); _qLocked = true; _qConverged = true;
      if (_qLevel < back) { _applyQualityLevel(back, 'step-up regressed → lock'); return; }
    } else if (now - _pendingUpAt > 2500) {
      _pendingUpFrom = -1; _pendingUpAt = 0;   // the step-up has held → accept it
    }
  }
  // ---- STEP DOWN — over budget. React on EITHER a run of bad frames OR accumulated bad time
  // (so a machine at 5fps, where 30 frames would be 6s, still steps within ~1s). When the EMA
  // is catastrophic, jump MULTIPLE rungs at once so a hanging start reaches a usable rate fast.
  // MOBILE targets ~30fps: a phone/tablet holding a steady ~30 at a GOOD-looking tier is the ideal,
  // so tolerate up to ~34ms (≈29fps) before degrading — do NOT chase 60 and strip quality on a
  // device whose panel/GPU simply caps near 30. Desktop keeps the tighter 60fps budget (24ms).
  // (_downMsThresh computed once at the top of the tick.)
  if (_frameEMA > _downMsThresh && _qLevel < QL_FLOOR) {
    _downFrames++; _downMs += interval; _goodSince = 0;
    // SMOOTH-WEAK (A1 backstop) — during the fast-converge window trip on a much shorter run of
    // bad frames / accumulated time so the initial descent is near-instant (and cross-faded).
    const _fastNow = now < _fastConvergeUntil;
    const _needFrames = _fastNow ? 8 : 30, _needMs = _fastNow ? 250 : 700;
    if (_downFrames >= _needFrames || _downMs >= _needMs) {
      const jump = _frameEMA > 120 ? 3 : _frameEMA > 60 ? 2 : 1;   // collapse fast when it's really bad
      const from = _qLevel;
      // SESSION RATCHET — ANY forced step-down means the level we are LEAVING proved unsustainable.
      // Raise the ceiling one notch worse than it so the controller can never climb back to (or past)
      // it this session. This is what kills the hunt: a level that briefly held and then blew its
      // budget (delayed regress — even after a prior step-up was "accepted") is now permanently barred,
      // so the controller converges downward and STAYS. Any pending step-up is moot.
      _qMaxLevel = clamp(Math.max(_qMaxLevel, from + 1), 0, QL_FLOOR);
      _pendingUpFrom = -1; _pendingUpAt = 0;
      const to = clamp(from + jump, 0, QL_FLOOR);
      // No headroom left to climb back to (single-rung drop) → LATCH. A catastrophic multi-rung
      // overshoot may still recover UP to the (new, lower) ceiling, then holds there.
      if (to <= _qMaxLevel) { _qLocked = true; _qConverged = true; }
      _applyQualityLevel(to, `step-down ratchet→ceil${_qMaxLevel}`);
    }
    return;
  }
  _downFrames = 0; _downMs = 0;
  // ---- STEP UP — cautious recovery. Only while holding target (EMA below the vsync-aware up
  // threshold) for a window MUCH longer than a step-down, never above the ratchet floor, never
  // while locked, never mid-interaction, and never while a prior step-up is still being judged.
  if (!_qLocked && !_pendingUpAt && _qLevel > _qMaxLevel && _frameEMA < Q_UP_MS) {
    if (_goodSince === 0) _goodSince = now;
    else if (now - _goodSince >= Q_UP_HOLD_MS) {
      _pendingUpFrom = _qLevel; _pendingUpAt = now;
      _applyQualityLevel(_qLevel - 1, 'step-up');
    }
  } else if (_frameEMA >= Q_UP_MS) {
    _goodSince = 0;
  }
  // ---- MOBILE STRONG-PHONE DPR CLIMB — a phone that has reached the TOP tier (level 0: full grid +
  // bloom + shadows) AND sustains 60fps-class headroom has PROVEN it can afford the crisp native pixels
  // it rendered before the adaptive rework. Raise the mobile DPR ceiling from the conservative 2.0
  // toward the device's native DPR (≤ 3) so the mantle is retina-sharp again. Gated on a long clean
  // window (same hold as a level step-up) and its own regress-latch above → weak phones (which never
  // reach level 0) and phones that can't hold the sharper pixels stay at 2.0.
  if (IS_MOBILE_TIER && !_mobileDprLatched && !_mobileDprPendingAt && _qLevel === 0 && !_pendingUpAt
      && _mobileDprCap < MOBILE_DPR_MAX && (window.devicePixelRatio || 1) > _mobileDprCap + 0.01
      && _frameEMA < Q_UP_MS) {
    if (_mobileDprGoodSince === 0) _mobileDprGoodSince = now;
    else if (now - _mobileDprGoodSince >= Q_UP_HOLD_MS) {
      _mobileDprGoodSince = 0;
      _mobileDprCap = Math.min(window.devicePixelRatio || 1, MOBILE_DPR_MAX);
      _mobileDprPendingAt = now;
      try { onResize(); } catch {}   // re-applies the higher DPR to renderer + composer + bloom
      _changeSettleUntil = now + 500; _frameEMA = Q_UP_MS; _downFrames = 0; _downMs = 0; _goodSince = 0;
      try { console.info(`[stage13] mobile DPR climb → ${_mobileDprCap} (native ${window.devicePixelRatio})`); } catch {}
    }
  } else if (_frameEMA >= Q_UP_MS || _qLevel !== 0) {
    _mobileDprGoodSince = 0;
  }
  // ---- DESKTOP DPR SHARP-CLIMB — a hardware-integrated desktop GPU (weak/unknown) with 60fps-clean
  // headroom should render at the SHARPEST DPR it sustains (owner values sharpness; DPR is the last
  // cut). Decoupled from the effects level: raise _desktopDpr one gentle step toward native while the
  // frame is clean, crossfade it, and judge for a regress (guard above → revert + latch). Latch once
  // native is reached (nothing left to sharpen) so it settles ONCE and stays flat — no wandering.
  if (_desktopDprPath() && !_desktopDprLatched && !_desktopDprPendingAt && !_pendingUpAt) {
    const nat = window.devicePixelRatio || 1;
    const target = Math.min(nat, DESKTOP_DPR_MAX);
    if (_desktopDpr + 0.01 >= target) {
      _desktopDprLatched = true;   // already at native → sharp; lock, no further moves
      try { console.info(`[stage13] desktop DPR at native ${_desktopDpr} → locked`); } catch {}
    } else if (_frameEMA < Q_UP_MS) {
      if (_desktopDprGoodSince === 0) _desktopDprGoodSince = now;
      else if (now - _desktopDprGoodSince >= DPR_CLIMB_HOLD_MS) {
        _desktopDprGoodSince = 0;
        _desktopDpr = Math.min(target, +(_desktopDpr + DPR_CLIMB_STEP).toFixed(3));
        _desktopDprPendingAt = now;
        _qCrossfade();
        try { onResize(); } catch {}   // re-applies the sharper DPR to renderer + composer + bloom
        _changeSettleUntil = now + 500; _frameEMA = Q_UP_MS; _downFrames = 0; _downMs = 0; _goodSince = 0;
        try { console.info(`[stage13] desktop DPR climb → ${_desktopDpr} (native ${nat})`); } catch {}
      }
    } else {
      _desktopDprGoodSince = 0;   // frame not clean → reset the hold (don't sharpen into lag)
    }
  }
}
// SMOOTH-WEAK (A1) — STARTUP TIER PROBE. The visible "jarring step-down" the owner sees is the
// controller starting a weak device at the MEDIAN good-looking rung and then, over ~1s, ratcheting
// DOWN to the rung it can actually hold — a high→low pop he watches happen. This probe renders a
// few gl.finish'd frames BEFORE the first presented frame to read the true GPU-inclusive cost, then
// STARTS the device at (near) its settling rung, so the first frames he sees are already the settled
// look. DESKTOP non-strong only (mobile keeps its own DPR-adaptive path; strong stays level 0); the
// step-UP ratchet still lets a mislabelled-capable device climb back up (cross-faded, not jarring).
function _probeStartLevel() {
  if (!SMOOTH_WEAK || GPU_CLASS === 'strong') return;
  if (IS_MOBILE_TIER || _isCaptureMode() || _gridForced) return;
  // DESKTOP hardware-integrated (weak/unknown): the effects level is already PINNED to the cheap,
  // UNCAPPED tier (QL_DESKTOP_WEAK) and sharpness is recovered on the decoupled DPR climb — so there
  // is no settling rung to pre-empt. Skipping the probe also stops it from dropping the device onto a
  // fps-CAPPED rung (6/7) on a slow gl.finish read; a hardware GPU should never be fps-capped.
  if (_desktopDprPath()) return;
  if (!renderer || !composer || !blankets) return;
  try {
    const gl = renderer.getContext();
    let best = Infinity;
    for (let i = 0; i < 7; i++) {
      const a = performance.now();
      renderFrame((typeof clock === 'number' ? clock : 0) + i * 1e-4, Infinity);
      composer.render();
      if (gl && gl.finish) gl.finish();
      const ms = performance.now() - a;
      if (i >= 2 && ms < best) best = ms;   // drop the first couple (shader compile / warm-up)
    }
    if (!Number.isFinite(best)) return;
    // map the per-frame cost (measured at the START grid) to the settling rung. Conservative
    // thresholds — the runtime controller refines from here; the point is to skip the visible drop.
    let lvl = best > 90 ? QL_FLOOR : best > 60 ? 6 : best > 42 ? 5 : best > 30 ? QL_WEAK : _qLevel;
    lvl = clamp(lvl, _qLevel, QL_FLOOR);   // the probe may only START LOWER than the class hint, never higher
    try { console.info(`[stage13] startup probe ${best.toFixed(1)}ms → start L${lvl} (was L${_qLevel})`); } catch {}
    if (lvl !== _qLevel) {
      _applyQualityLevel(lvl, 'startup probe');
      const g = gridForLevel(lvl);
      if (g[0] !== GX || g[1] !== GY) { try { rebuildTerrainGrid(g[0], g[1]); } catch {} }
    }
  } catch {}
}
// dev/owner readout — current adaptive state. Owner can run window.__qual() on his laptop.
window.__qual = () => {
  const L = QUAL_LADDER[_qLevel] || {};
  const cap = L.capAdaptive ? (_capLocked ? +_adaptiveCapMs.toFixed(1) : 0) : (L.capMs || 0);
  return { level: _qLevel, of: QL_FLOOR, dpr: _desktopDprPath() ? _desktopDpr : DPR_CAP, effDpr: +effectiveDPR().toFixed(2),
           desktopDpr: _desktopDprPath() ? _desktopDpr : null, desktopDprLatched: _desktopDprPath() ? _desktopDprLatched : null,
           mobileDprCap: IS_MOBILE_TIER ? _mobileDprCap : null, nativeDpr: +(window.devicePixelRatio || 1).toFixed(2),
           mobileDprLatched: IS_MOBILE_TIER ? _mobileDprLatched : null,
           bloom: !!(bloomPass && bloomPass.enabled),
           shadow: keyLight ? (keyLight.castShadow ? keyLight.shadow.mapSize.width : 0) : null,
           stride: fieldStride, grid: `${GX}×${GY}`, verts: NV,
           renderGrid: (() => { try { const p = blankets && blankets.home && blankets.home.mesh.geometry.parameters; return p ? `${p.widthSegments}×${p.heightSegments}` : null; } catch { return null; } })(),
           cheapFrag: (typeof _cheapFrag === 'function' ? _cheapFrag() : null), smoothWeak: (typeof SMOOTH_WEAK !== 'undefined' ? SMOOTH_WEAK : null),
           cap: cap, capFps: cap ? +(1000 / cap).toFixed(1) : 0,
           frameEMA: +_frameEMA.toFixed(1), fps: +(1000 / Math.max(0.001, _frameEMA)).toFixed(1),
           workMs: +_workEMA.toFixed(1), workPeakMs: +_workPeak.toFixed(1),
           gpu: GPU_STR, gpuClass: GPU_CLASS, aa: AA_ON, locked: _qLocked, maxLevel: _qMaxLevel, converged: _qConverged,
           healthy: _glHealthy, sinceInteractMs: Math.round(performance.now() - _lastInteract), warmupLeftMs: Math.max(0, Math.round(_warmupUntil - performance.now())) };
};
// dev — force a level (verification hook). window.__setQual(n). Builds the level's grid IMMEDIATELY
// (bypasses the deferred executor) so a forced level is fully applied for screenshots/A-B.
window.__setQual = (n) => {
  _qLocked = true; _qMaxLevel = 0; _qConverged = false; _gridPendingGX = 0; _gridPendingGY = 0;
  _applyQualityLevel(n, 'manual');
  if (!_gridForced) { const g = gridForLevel(clamp(n | 0, 0, QL_FLOOR)); try { rebuildTerrainGrid(g[0], g[1]); } catch {} }
  return window.__qual();
};
// dev — force the decoupled desktop DPR + latch it (verification hook). window.__setDpr(d) lets an
// A/B screenshot compare the blurry low-DPR state (e.g. 0.66) against the settled sharp one (native)
// on the desktop weak/unknown path without waiting for the runtime climb.
window.__setDpr = (d) => {
  _desktopDpr = Math.max(0.4, Math.min(DESKTOP_DPR_MAX, +d || DESKTOP_DPR_START));
  _desktopDprLatched = true; _desktopDprPendingAt = 0; _desktopDprGoodSince = 0;
  try { onResize(); } catch {}
  return window.__qual();
};
let lastNow = performance.now();
let _lastPresent = performance.now();
// ADAPTIVE FRAME CAP — the even-fps intervals the floor rung may lock to (ms). We deliberately do
// NOT offer 60fps here: on a machine that needs a cap, chasing 60 is what makes it bounce 60↔30.
const CAP_STEPS = [1000 / 30, 1000 / 20, 1000 / 15];   // 33.33 (30fps) · 50 (20fps) · 66.67 (15fps)
let _workEMA = 16;     // smoothed RAW per-frame work (render+field+hud), ms — NOT the capped interval
let _workPeak = 16;    // decaying peak of the work — tracks the HEAVY (recompute) frame so the cap fits it
let _adaptiveCapMs = 1000 / 30;   // current locked interval on a capAdaptive rung
// MEASURE-THEN-LOCK cap (no feedback runaway). A capAdaptive rung first runs UNCAPPED for a short
// window so _frameEMA converges to the TRUE, uncontaminated GPU-inclusive frame time; then we lock
// the cap to the even-fps step that fits it and FREEZE it for that tier. Without the measure window
// the cap would feed back on itself (once it bites, _frameEMA only echoes the cap → it ratchets to
// the slowest step and pins there). Reset whenever the tier or the grid changes so the next lock
// reflects the new geometry.
let _capLocked = false;           // false = still measuring uncapped; true = frozen at _adaptiveCapMs
let _capMeasureUntil = 0;         // measure the true frame cost until this time, then lock
let _capMeasPeak = 0;             // WORST (peak) frameEMA seen during the current measure window — the cap must fit the heavy beat, not a lucky light phase
let _capOver = 0;                 // consecutive frames the locked cap couldn't be held → ratchet it SLOWER
function _nextSlowerCap(ms) { for (const T of CAP_STEPS) if (T > ms + 0.5) return T; return CAP_STEPS[CAP_STEPS.length - 1]; }
function _pickCap(peakMs, frameMs) {
  // Pick the smallest EVEN-fps interval the device can actually hold. Two signals:
  //  · peakMs*1.18 — the JS work peak (render+field+hud) with headroom for the heavy recompute frame.
  //  · _frameEMA   — the TRUE GPU-inclusive frame time, measured UNCAPPED (see measure window). On a
  //    FILL-BOUND integrated GPU (owner's HD 520: ~43ms GPU for only ~6ms JS) the JS peak badly
  //    UNDER-reads the real cost, so a work-only cap picked 30fps the device could never hold → it
  //    ran uncapped and juddered 20↔23fps. Taking the WORSE of the two locks to the honest steady
  //    rate (his floor → 50ms/20fps) so the cadence is EVEN. Steady 20 beats a bouncing 30.
  const need = Math.max(peakMs * 1.18, frameMs);
  for (const T of CAP_STEPS) if (T >= need - 2) return T;   // −2ms slack so a frame sitting just over a step still locks to it
  return CAP_STEPS[CAP_STEPS.length - 1];   // slower than 15fps even → present as fast as the work allows
}
function loop(now) {
  // ADAPTIVE SMOOTHNESS (low tiers only) — on a SOFTWARE rasteriser the render-only frames are
  // much cheaper than the field-recompute frames, so an uncapped rAF loop hovers on the 16.7ms
  // vsync edge and BOUNCES 60↔30fps (visible judder), while the heavier frames occasionally slip
  // a whole vsync interval (33→66ms hitch). A frame-rate CAP on the floor rung (capMs) presents at
  // an EVEN 30fps cadence — skip the intermediate vsync tick — so the interval is steady and each
  // presented frame has ample headroom under its 33ms budget. Only the FLOOR rung carries a cap
  // (elsewhere a 33ms interval would trip the step-down threshold; at the floor step-down is a
  // no-op). Desktop/strong tiers have no capMs → this whole gate is skipped, behaviour unchanged.
  // ADAPTIVE — a capAdaptive rung runs UNCAPPED while measuring (so the true frame cost is read
  // without the cap contaminating it), then locks/freezes at the even interval it can hold
  // (_adaptiveCapMs). A legacy fixed capMs rung uses its literal value.
  const _capAd = QUAL_LADDER[_qLevel].capAdaptive;
  const _capMs = _capAd ? (_capLocked ? _adaptiveCapMs : 0) : (QUAL_LADDER[_qLevel].capMs || 0);
  if (_capMs && (now - _lastPresent) < _capMs) { requestAnimationFrame(loop); return; }
  try { if (window.__perfLog) { const a = (window.__frameTimes || (window.__frameTimes = [])); a.push(now); if (a.length > 2000) a.shift(); } } catch {}   // DEBUG — presented-frame timestamps for the perf harness
  _lastPresent = now;
  const _interval = now - lastNow;   // raw rAF inter-frame gap (ms) — the true GPU-inclusive frame time
  const dt = Math.min(0.1, Math.max(0, _interval / 1000));
  lastNow = now;
  adaptiveTick(now, _interval);      // ADAPTIVE — measure + ratchet quality (no-op on a fast desktop)
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
      // PENBEAT — the inserted beat blocks EXTEND the total wall timeline, so advance
      // wallProgress against the extended total (penWarp.totalWall) rather than DRAMA_TOTAL_S.
      // Off-flag / no pens → identical to before (DRAMA_TOTAL_S).
      const effTotal = penWarp ? penWarp.totalWall : dramaEffTotal;
      wallProgress += (dt / effTotal) * spd;
      if (wallProgress >= 1) {
        // FINAL WHISTLE — do NOT loop. Pin to the end and begin the calm settle.
        wallProgress = 1; clock = clockFromWall(1);
        settling = true; settle = 0;
      } else {
        clock = clockFromWall(wallProgress);
      }
    }
  }
  // advance the post-match shootout choreography (runs while playback is stopped, driven by
  // its own wall clock; the match clock stays frozen at full time).
  if (shootActive) { shootWall += dt; const sq = shootoutSeq(); shootoutRevealed = sq ? sq.reveal : 0; }
  syncCrowdAudio();   // IN-PAGE CROWD AUDIO — pin audio.currentTime to wallProgress (drift-corrected, not per-frame seek)
  const _wStart = performance.now();   // ADAPTIVE — measure the RAW frame work (render+field+hud) to drive the adaptive cap
  renderFrame(clock, dt);
  controls.update();
  // GUARD — if the GPU context was lost, three's render() no-ops anyway; skip it (and the
  // fallback is shown by the loss handler). try/catch so ANY GL exception can never break the
  // rAF chain (which would silently freeze the whole piece). The DOM HUD below still updates.
  if (!glLost) {
    try {
      composer.render();
      if (!_glHealthy) { _glHealthy = true; try { sessionStorage.removeItem('glRestoreTries'); sessionStorage.setItem('glWasHealthy', '1'); sessionStorage.removeItem('glStartFloor'); } catch {} }
      if (!_firstFrameRendered) { _firstFrameRendered = true; maybeHideSpinner(); }   // first real frame → hide spinner once flags are also loaded
    } catch (err) { /* transient GL error — keep the loop alive, next frame retries */ }
  }
  updateHud();
  updateCamReadout();
  drawOverlays(clock, true);  // STAGE11 #5/#6 — markers row + pulse strip advance (gated=true → pulse redraws at the field cadence, not every rAF)
  // ADAPTIVE — RAW work this frame (excludes the cap idle-wait). EMA smooths, peak tracks the heavy
  // field-recompute frame so the cap fits the WORST frame, not the average. Recompute the locked
  // interval only on a capAdaptive rung (no cost elsewhere).
  const _work = performance.now() - _wStart;
  _workEMA = _workEMA * 0.9 + _work * 0.1;
  // decaying peak: rises instantly to a new max, decays ~8%/frame. With stride N the heavy
  // field-recompute frame recurs every N frames and re-arms the peak (0.92^4≈0.72, still ≈ the
  // heavy cost), so the cap fits the WORST frame — yet a one-off spike (GC/orbit) decays out in
  // ~2s instead of pinning the cap at a slow fps for many seconds.
  _workPeak = Math.max(_work, _workPeak * 0.92);
  // MEASURE-THEN-LOCK — while on a capAdaptive rung and past the (uncapped) measure window, freeze
  // the cap to the even step that fits the now-settled TRUE frame cost. Locked once per tier/grid;
  // reset on any tier or grid change so the cap always reflects the current geometry, and never
  // ratchets away on its own echo.
  if (_capAd && !_capLocked && now < _capMeasureUntil && now >= _changeSettleUntil) {
    _capMeasPeak = Math.max(_capMeasPeak, _frameEMA);   // track the WORST sustained cost in the window
  }
  if (_capAd && !_capLocked && _glHealthy && now >= _capMeasureUntil && now >= _changeSettleUntil) {
    _adaptiveCapMs = _pickCap(_workPeak, _capMeasPeak);
    _capLocked = true; _capOver = 0;
    try { console.info(`[stage13] cap locked ${_adaptiveCapMs.toFixed(1)}ms (${(1000 / _adaptiveCapMs).toFixed(0)}fps) @ L${_qLevel} grid${GX}×${GY} measPeak${_capMeasPeak.toFixed(1)} workPeak${_workPeak.toFixed(1)}`); } catch {}
  } else if (_capAd && _capLocked && now >= _changeSettleUntil) {
    // FROZEN — but ratchet the cap SLOWER (in place, never uncapping) if the locked rate genuinely
    // can't be held for a SUSTAINED spell (the cap is still biting through, frames overrun it). We
    // never speed the cap back up (a capped interval just echoes the cap → a 30↔20 hop), so the cap
    // only converges DOWN to the rate the device holds, then stays. This keeps the cadence EVEN in
    // both calm and busy phases (no unlock→uncapped churn) — steady beats bouncing.
    if (_frameEMA > _adaptiveCapMs + 8) {
      if (++_capOver >= 45) { const s = _nextSlowerCap(_adaptiveCapMs); if (s > _adaptiveCapMs) { _adaptiveCapMs = s; _capOver = 0; try { console.info(`[stage13] cap ratchet → ${_adaptiveCapMs.toFixed(1)}ms (${(1000 / _adaptiveCapMs).toFixed(0)}fps)`); } catch {} } else _capOver = 0; }
    } else if (_capOver > 0) { _capOver--; }
  }
  requestAnimationFrame(loop);
}

// ---- dev hook (hidden-tab safe: render exactly one frame via composer) -------
// __setClock SNAPS the smoothing (jump-cut to an instant). For verifying MOTION
// in a hidden tab (rAF paused) use __step(min, dt): it renders WITHOUT snapping,
// feeding the dt-aware exponential filters a real dt — so calling it repeatedly
// with small advancing min + dt reproduces the live glide deterministically.
window.__setClock = (min) => {
  _hintSuppress = true;   // programmatic drive (export / tests) → never show the desktop-software hint
  resetSettle();
  clock = clamp(+min || 0, 0, teamMeta.duration);
  wallProgress = wallFromClock(clock);   // keep the warped scrubber coherent (PENBEAT-aware)
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
// dev/capture hook — render ONE frame with a TRANSPARENT background (mantle only) for the
// "how to read it" still export, then (transparent=false) restore the score-tinted sky. Lets
// Playwright screenshot just the cloth on alpha. Uses the renderer's alpha buffer (alpha:true).
window.__howCaptureBg = (transparent) => {
  try {
    if (transparent) { if (scene) scene.background = null; renderer.setClearColor(0x000000, 0); }
    else { if (scene) scene.background = skyTex; renderer.setClearColor(0x000000, 1); }
    renderFrame(clock); controls.update(); composer.render();
  } catch (err) {}
};
// DEV EXPORT TOOL — grab the CURRENT #stage cloth as a downloaded PNG so the user can pose the scene
// exactly (camera / clock) in the browser and hand back that frame to drop in as the "how to read it"
// still. The renderer has NO preserveDrawingBuffer, so we MUST render THIS tick right before
// toDataURL (same synchronous block) or the drawing buffer reads back blank. DEFAULT = transparent,
// MANTLE-ONLY: scene.background is nulled + clearAlpha 0 (same technique that made #howStill clean)
// AND the CSS #backdrop is hidden so nothing composites behind the cloth. Pass {transparent:false}
// for the score-tinted sky. Filename carries the minute + buffer dims. Returns the dataURL length as
// a sanity check (>1000 ⇒ non-blank). Available on any view. Usage: pose the scene, then run __grabMantle() in the console.
window.__grabMantle = (opts = {}) => {
  const transparent = (opts.transparent !== false);   // DEFAULT transparent (mantle only)
  const cv = renderer.domElement;                      // the #stage canvas
  const prevBg = scene ? scene.background : null;
  const prevAlpha = renderer.getClearAlpha();
  const bd = el('backdrop'); const prevBdDisp = bd ? bd.style.display : null;
  if (transparent) {
    if (scene) scene.background = null;
    if (renderer.setClearAlpha) renderer.setClearAlpha(0); else renderer.setClearColor(0x000000, 0);
    if (bd) bd.style.display = 'none';                  // hide the CSS backdrop so the cloth is truly isolated
  }
  // force a fresh render THIS tick so the drawing buffer is populated for toDataURL
  renderFrame(clock); controls.update(); composer.render();
  const url = cv.toDataURL('image/png');
  if (transparent) {
    if (scene) scene.background = prevBg;
    if (renderer.setClearAlpha) renderer.setClearAlpha(prevAlpha); else renderer.setClearColor(0x000000, prevAlpha);
    if (bd) bd.style.display = prevBdDisp;
    renderFrame(clock); controls.update(); composer.render();   // restore the live look immediately
  }
  const a = document.createElement('a');
  a.href = url; a.download = `mantle_${Math.round(clock)}_${cv.width}x${cv.height}.png`; a.click();
  return url.length;                                   // sanity: >1000 ⇒ non-blank
};
// clean-capture toggle: press "d" to HIDE all surrounding chrome/UI ("обвес") and leave ONLY the
// #stage terrain (mantle) visible; press again to restore. Pure show/hide via body.cleanview (CSS).
window.addEventListener('keydown', (e) => {
  if (e.key !== 'd' && e.key !== 'D') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
  document.body.classList.toggle('cleanview');
});
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
// dev/export hook — shootout summary for the video exporter: number of kicks and the finale
// WALL-second (when the last kick's hill + winner-flood have fully resolved), so the exporter
// can step __shoot(0..lastEnd) at a fixed cadence and land on the held winner state. Returns
// null for a match with NO shootout, so the exporter's shootout phase stays a no-op there.
window.__shootInfo = () => {
  if (!shootoutOrder || !shootoutOrder.length) return null;
  const { pause0, gap } = shootTiming();
  const n = shootoutOrder.length;
  // mirror the finale moment used by shootoutWaveAt() / drawStatsPanel(): the point past which
  // the winner-flood is held and the resolved stats panel is shown.
  const lastEnd = pause0 + (n - 1) * gap + SHOOT_WAVE_S * 0.5 + SHOOT_FLOOD_S + 0.9;
  return { n, pause0, gap, lastEnd: +lastEnd.toFixed(3) };
};
// dev/verification hook — render-time state snapshot (shootout/pen/flood diagnostics).
window.__dbg = () => {
  const bH = blankets && blankets.home;
  return {
    shootActive, playing, settle: +settle.toFixed(3), settling, shootWall: +shootWall.toFixed(2),
    aOn: cfg.A.on, PENBEAT, clock: +clock.toFixed(2), wallProgress: +wallProgress.toFixed(4),
    uFloodH: bH ? +bH.u.uFlood.value.toFixed(3) : null,
    uFloodTeamH: bH ? '#' + bH.u.uFloodTeam.value.getHexString() : null,
    shHill: (typeof shootHillAt === 'function') ? shootHillAt() : null,
    zone: (typeof shootZoneAt === 'function') ? shootZoneAt() : null,
    seq: (typeof shootoutSeq === 'function') ? shootoutSeq() : null,
    order: shootoutOrder ? shootoutOrder.length : null,
    pen: (() => {
      try {
        const pb = (PENBEAT && !shootActive) ? penBeatFromWall(wallProgress) : null;
        const pv = pb ? penBeatVisual(pb) : null;
        if (!pv) return null;
        return { team: pv.pen.team, outcome: pv.pen.outcome, dark: +pv.dark.toFixed(3),
          floodC: +pv.floodC.toFixed(3), hillH: pv.hill ? +pv.hill.h.toFixed(3) : 0,
          scoreLanded: !!pv.scoreLanded,
          floodRevU: pv.floodReveal ? +pv.floodReveal.revU.toFixed(3) : null,
          floodRevTeam: pv.floodReveal ? pv.floodReveal.team : null };
      } catch { return null; }
    })(),
    penResumeFlood: (() => { try { const f = penScoredUFloodAt(clock); return f ? { team: f.team, amt: +f.amt.toFixed(3) } : null; } catch { return null; } })(),
  };
};
// dev/verification hook — POST-GOAL MOTION SWEEP. Samples the wall-time-driven terrain drivers
// (seam front, cover, relief-lull, goal crest) at UNIFORM wall-progress steps across a goal window,
// so a script can prove the post-goal sequence stays CONTINUOUS (no ~1-2s dead freeze where the seam
// is pinned and the relief holds flat). Uniform wp steps == uniform wall-time steps → a run of
// consecutive steps with ~zero change in (front, lull, crest) IS the freeze. Deterministic, no state
// mutation beyond the read (restores wallProgress/clock). gm = goal match-minute (nearest goal used).
window.__goalSweep = (gm, nSteps, spanWP) => {
  if (!goalsByTime || !goalsByTime.length) return null;
  let g = goalsByTime[0];
  for (const x of goalsByTime) if (Math.abs(x.t - gm) < Math.abs(g.t - gm)) g = x;
  const savedWp = wallProgress, savedClock = clock;
  const wpG = wallFromClock(g.t);
  const span = Number.isFinite(spanWP) ? spanWP : 0.08;
  const n = (nSteps | 0) || 120;
  const effTotal = penWarp ? penWarp.totalWall : dramaEffTotal;
  const gLead = GOAL_CREST_LEAD_S, gPk = 0.35, gTau = 0.9;   // mirror computeField's goal-crest envelope
  const out = [];
  for (let i = 0; i <= n; i++) {
    const wp = clamp(wpG - span + (2 * span) * (i / n), 0, 1);
    const t = clockFromWall(wp);
    const w = goalWaveAt(t);
    const lull = goalLullAt(t);
    const ws = wallSecondsSinceGoal(g.t, t);
    let crest = 0;
    if (Number.isFinite(ws)) {
      if (ws < 0 && ws >= -gLead) { const f = (ws + gLead) / gLead; crest = f * f * (3 - 2 * f); }
      else if (ws >= 0 && ws < gPk) crest = 1;
      else if (ws >= gPk) crest = Math.exp(-(ws - gPk) / gTau);
    }
    out.push({ wp: +wp.toFixed(5), wallSec: Number.isFinite(ws) ? +ws.toFixed(3) : null,
      front: w ? +w.front.toFixed(4) : null, cover: w ? +w.cover.toFixed(4) : null,
      lull: +lull.toFixed(4), crest: +crest.toFixed(4) });
  }
  // restore
  wallProgress = savedWp; clock = savedClock;
  return { goal: { t: +g.t.toFixed(2), team: g.team }, wpG: +wpG.toFixed(5), span, n,
    wallPerStep: +((2 * span / n) * effTotal).toFixed(4), effTotal: +effTotal.toFixed(2), samples: out };
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
// dev/verification hook — the per-CHANNEL displayed ownership front A_own[j] (constant along u), so a
// script can MEASURE the goal flood's lateral extent: a full-width WALL floods every channel to the
// conceded end, a COUNTER FINGER floods only the channels around the shot flank. Returns front-u per
// channel j (j=0 → v=1, j=gy-1 → v=0).
window.__ownProfile = () => {
  if (!A_own || !A_gx) return null;
  const gx = A_gx, gy = A_gy; const out = new Array(gy);
  for (let j = 0; j < gy; j++) out[j] = +A_own[j * gx].toFixed(4);
  return { gy, clock: +clock.toFixed(2), front: out };
};
// dev/verification hook — raw goal-WAVE phase at a match-minute (front target + cover), so the
// post-goal rollback-to-centre can be measured without the front-smoothing lag.
window.__waveAt = (t) => { const w = goalWaveAt(t); return w ? { t: +(+t).toFixed(2), front: +w.front.toFixed(3), cover: +w.cover.toFixed(3), floodTint: +w.floodTint.toFixed(3), team: w.team, narrow: +(+(w.narrow||0)).toFixed(3), v: Number.isFinite(w.v) ? +w.v.toFixed(3) : null } : null; };
// dev/verification hook (PENBEAT) — the directional SCORED-PEN flood at a resumed-clock minute:
// team + the reveal front (revU) that starts AT the pen goal line and sweeps outward + which side is
// flooded (sign). Lets a script confirm the flood EMANATES FROM the pen side. Null outside its window.
window.__penFloodAt = (t) => { const f = penScoredFloodAt(+t); return f ? { t: +(+t).toFixed(2), team: f.team, sign: f.sign, revU: +f.revU.toFixed(3), strength: +f.strength.toFixed(3) } : null; };
// dev/verification hook (PENBEAT) — set the MASTER wallProgress directly (a beat block spans a
// range of wallProgress at a fixed clock, so this is the way to land INSIDE a frozen beat). Snaps
// like __setClock. Returns the resulting {wallProgress, clock, beat}. Read-only otherwise.
window.__setWall = (wp) => {
  resetSettle();
  wallProgress = clamp(+wp || 0, 0, 1);
  clock = clockFromWall(wallProgress);
  _dramaCursor = 0; _ballCursor = 0;
  playing = false; const pb = el('play'); if (pb) pb.textContent = '▶';
  snapASmoothing();
  renderFrame(clock); controls.update(); composer.render();
  updateHud(); updateCamReadout(); drawOverlays(clock);
  return window.__penState();
};
// dev/verification hook (PENBEAT) — the live beat block at the current master wallProgress:
// the pinned clock, sub-phase visuals (dark wash, kicker flood cover, hill height, scoreLanded)
// + outcome. null when off / not inside a beat. Pure read-out.
window.__penState = () => {
  const pb = PENBEAT ? penBeatFromWall(wallProgress) : null;
  if (!pb) return { wallProgress: +wallProgress.toFixed(4), clock: +clock.toFixed(2), beat: null };
  const v = penBeatVisual(pb);
  return {
    wallProgress: +wallProgress.toFixed(4), clock: +clock.toFixed(2),
    beat: { i: pb.i, team: pb.pen.team, outcome: pb.pen.outcome, phase: +pb.phase.toFixed(3),
            localWall: +pb.localWall.toFixed(3), dark: +v.dark.toFixed(3), flat: +v.flat.toFixed(3), floodC: +v.floodC.toFixed(3),
            hillH: v.hill ? +v.hill.h.toFixed(2) : 0, scoreLanded: v.scoreLanded },
  };
};
// dev/verification hook (PENBEAT) — objective relief STATS of the rendered blankets at the
// current frame (min/max/spread of the home+away height grids). Lets a script prove the SETTLE
// frame is genuinely FLAT (tiny spread) vs a live frame (large spread). Pure read-out.
window.__reliefStats = () => {
  const bH = blankets && blankets.home, bA = blankets && blankets.away;
  if (!bH || !bA || !bH.hData) return null;
  let mn = Infinity, mx = -Infinity;
  const scan = (d) => { for (let i = 0; i < d.length; i++) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; } };
  scan(bH.hData); scan(bA.hData);
  return { min: +mn.toFixed(3), max: +mx.toFixed(3), spread: +(mx - mn).toFixed(3) };
};
// dev/verification hook — the in-match penalties detected for this match (spot + outcome) and,
// for PENBEAT, the master-wallProgress at each beat block's START (freeze-in) so a script can
// scrub straight into a beat.
window.__penList = () => (penaltiesByTime || []).map((p) => ({ t: +(+p.t).toFixed(2), team: p.team, outcome: p.outcome, u: +(+p.u).toFixed(3), v: +(+p.v).toFixed(3), player: p.player || null, wallStart: +wallFromClock(p.t).toFixed(4) }));
// dev/verification hook — the inserted-beat warp geometry (block width in wallProgress etc).
window.__penWarpInfo = () => penWarp ? { nB: penWarp.nB, blockFrac: penWarp.blockFrac, matchFrac: penWarp.matchFrac, totalWall: penWarp.totalWall, penBeatWall: PEN_BEAT_WALL } : null;
// dev/verification hook (PEN4 dup-hunt) — LOCAL rendered blanket height near a pitch spot (u,v).
// Scans the ACTUAL displaced hData of both sheets (which INCLUDES mounds + xG spire + goal crest +
// hill + waves) within `rad` (u,v units) of (u,v). Returns the local max per sheet + the GLOBAL
// min (ambient floor) so the LOCAL BUMP above ambient can be measured (NOT an aggregate spread).
window.__hAtSpot = (u, v, rad) => {
  const bH = blankets && blankets.home, bA = blankets && blankets.away;
  if (!bH || !bA || !bH.hData) return null;
  const r = Number.isFinite(+rad) ? +rad : 0.06;
  let locH = -Infinity, locA = -Infinity, gMin = Infinity;
  let idx = 0;
  for (let j = 0; j < VY; j++) {
    const vv = j / (VY - 1);
    for (let i = 0; i < VX; i++, idx++) {
      const uu = i / (VX - 1);
      const dH = bH.hData[idx], dA = bA.hData[idx];
      if (dH < gMin) gMin = dH; if (dA < gMin) gMin = dA;
      if (Math.abs(uu - u) <= r && Math.abs(vv - v) <= r) {
        if (dH > locH) locH = dH; if (dA > locA) locA = dA;
      }
    }
  }
  const top = Math.max(locH, locA);
  return { u, v, rad: r, home: +locH.toFixed(3), away: +locA.toFixed(3),
           topLocal: +top.toFixed(3), ambient: +gMin.toFixed(3), bump: +(top - gMin).toFixed(3) };
};
// dev/verification hook (PEN4 dup-hunt) — the SMOOTHED A-field grid values (the source fields that
// reliefMul melts/re-reveals) at the nearest cell(s) to (u,v): mound height, xG spire, goal crest,
// per team + the current melt factors. Tells us WHICH contributor holds an imprint at the pen spot.
window.__gridAtSpot = (u, v) => {
  if (!A_shH || !A_gx) return null;
  const gx = A_gx, gy = A_gy;
  const ci = clamp(u, 0, 1) * (gx - 1), cj = clamp(1 - v, 0, 1) * (gy - 1);
  const i0 = Math.max(0, Math.floor(ci)), i1 = Math.min(gx - 1, Math.ceil(ci));
  const j0 = Math.max(0, Math.floor(cj)), j1 = Math.min(gy - 1, Math.ceil(cj));
  let shH = 0, shA = 0, sxH = 0, sxA = 0, sgH = 0, sgA = 0;
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const k = j * gx + i;
    if (A_shH[k] > shH) shH = A_shH[k]; if (A_shA[k] > shA) shA = A_shA[k];
    if (A_sxH[k] > sxH) sxH = A_sxH[k]; if (A_sxA[k] > sxA) sxA = A_sxA[k];
    if (A_sgH[k] > sgH) sgH = A_sgH[k]; if (A_sgA[k] > sgA) sgA = A_sgA[k];
  }
  const pb = (PENBEAT && !shootActive) ? penBeatFromWall(wallProgress) : null;
  const pv = pb ? penBeatVisual(pb) : null;
  const meltRelief = pb ? (pv ? pv.reliefFlat : 0) : penRecoveryAt(clock);
  return { u, v, clock: +clock.toFixed(2), inBeat: !!pb,
    meltRelief: +meltRelief.toFixed(3),
    shH: +shH.toFixed(3), shA: +shA.toFixed(3),
    sxH: +sxH.toFixed(3), sxA: +sxA.toFixed(3),
    sgH: +sgH.toFixed(3), sgA: +sgA.toFixed(3) };
};
// dev/verification hook (PEN4 dup-hunt) — the floating xG-peak name-tags actually built (so a
// script can prove NO pen label survives under PENBEAT).
window.__xgLabelsDbg = () => (xgLabels || []).map((L) => ({ t: +(+L.t).toFixed(3), player: L.player,
  isPen: !!L.isPen, isGoal: !!L.isGoal, xg: +(+L.xg).toFixed(3), u: +(+L.u).toFixed(3), v: +(+L.v).toFixed(3) }));
// dev/verification hook (PEN4 dup-hunt) — dump ALL timeline events in a clock window.
window.__evWindow = (t0, t1) => {
  if (!Array.isArray(timeline)) return [];
  const out = [];
  for (const it of timeline) {
    if (it.t < t0 || it.t > t1) continue;
    out.push({ t: +it.t.toFixed(3), kind: it.kind, type: it.type, team: it.team,
      u: Number.isFinite(it.u) ? +it.u.toFixed(3) : null, v: Number.isFinite(it.v) ? +it.v.toFixed(3) : null,
      eu: Number.isFinite(it.eu) ? +it.eu.toFixed(3) : null, ev: Number.isFinite(it.ev) ? +it.ev.toFixed(3) : null,
      situation: it.situation || null, isGoal: !!it.isGoal, xg: Number.isFinite(it.xg) ? +it.xg.toFixed(3) : null,
      isTouch: !!it.isTouch, cross: !!it.cross, through: !!it.through });
  }
  return out;
};
// dev/verification hook (PEN4 dup-hunt) — GUARD audit: does penBeatTimes actually contain each
// pen's t (strict float match, the guard used by computeA/thrust/reach/goal-crest)? Plus every
// timeline SHOT within ±winMin match-minutes of each pen, with its own membership + spot — to expose
// a float mismatch OR a distinct second event (e.g. a rebound) imprinting near the pen spot.
window.__penGuardDbg = (winMin) => {
  const w = Number.isFinite(+winMin) ? +winMin : 2.0;
  const pbt = Array.from(penBeatTimes);
  const pens = (penaltiesByTime || []).map((p) => ({
    t: p.t, team: p.team, outcome: p.outcome, u: +(+p.u).toFixed(3), v: +(+p.v).toFixed(3),
    inPBT: penBeatTimes.has(p.t) }));
  const near = [];
  if (Array.isArray(timeline)) {
    for (const it of timeline) {
      if (it.kind !== 'shot') continue;
      for (const p of (penaltiesByTime || [])) {
        if (Math.abs(it.t - p.t) <= w) {
          near.push({ t: it.t, dt: +(it.t - p.t).toFixed(4), type: it.type,
            situation: it.situation || null, isGoal: !!it.isGoal, team: it.team,
            u: Number.isFinite(it.u) ? +it.u.toFixed(3) : null,
            v: Number.isFinite(it.v) ? +it.v.toFixed(3) : null,
            xg: Number.isFinite(it.xg) ? +it.xg.toFixed(3) : null,
            inPBT: penBeatTimes.has(it.t) });
          break;
        }
      }
    }
  }
  return { penBeatTimes: pbt, pens, nearShots: near };
};
// dev/verification hook — DWELL of the dramatic clock at a match-minute: screen-seconds
// spent on a ±half-minute window around t (higher = the clock lingers there). Lets us
// verify penetration room objectively (e.g. a 14' thrust minute should now out-dwell an
// empty routine minute). Pure read-out of the baked warp.
window.__warpDwell = (t, half) => {
  const h = Number.isFinite(+half) ? +half : 0.5;
  const passSeconds = dramaEffTotal / Math.max(0.05, Number(cfg.speed) || 1);
  return +((progressOfMatchT(t + h) - progressOfMatchT(t - h)) * passSeconds).toFixed(3);
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
  _hintSuppress = true;   // programmatic drive (export / tests) → never show the desktop-software hint
  resetSettle();
  clock = clamp(+min || 0, 0, teamMeta.duration);
  wallProgress = wallFromClock(clock);
  playing = false;
  renderFrame(clock, Number.isFinite(+dt) ? +dt : 0.016);
  drawOverlays(clock);
  controls.update();
  composer.render();
  updateHud();
};
// PERF PROFILING (dev harness) — split the per-frame cost into JS TERRAIN work
// (renderFrame → computeField, the ~9k-vertex field loop + DataTexture re-upload) vs
// GPU RASTER (composer.render + gl.finish, which blocks until the GPU has drawn).
// renderFrame(t, Infinity) forces a FULL field recompute every call (the _snap path
// bypasses the fieldStride cadence gate) so `field` is the worst-case JS terrain cost;
// `fieldStrided` re-measures with the live cadence to show the amortised reality.
window.__profFrame = (min, dt, n) => {
  n = (n | 0) || 60;
  const cv = document.getElementById('stage');
  const gl = cv && (cv.getContext('webgl2') || cv.getContext('webgl'));
  clock = clamp(+min || 0, 0, teamMeta.duration); wallProgress = wallFromClock(clock); playing = false;
  const D = Number.isFinite(+dt) ? +dt : 0.016;
  for (let i = 0; i < 8; i++) { renderFrame(clock + i * 1e-4, Infinity); composer.render(); if (gl) gl.finish(); }
  const stat = (a) => { a.sort((x, y) => x - y); return { median: +a[a.length >> 1].toFixed(2), p95: +a[Math.floor(a.length * 0.95)].toFixed(2), max: +a[a.length - 1].toFixed(2), avg: +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2) }; };
  const F = [], FS = [], R = [];
  for (let i = 0; i < n; i++) {
    const t = clock + (i % 19) * 0.013;
    let a = performance.now(); renderFrame(t, Infinity); F.push(performance.now() - a);      // full recompute (JS terrain, worst case)
    a = performance.now(); composer.render(); if (gl) gl.finish(); R.push(performance.now() - a);  // GPU raster
    a = performance.now(); renderFrame(t + 1e-4, D); FS.push(performance.now() - a);          // strided (live cadence)
  }
  return { field: stat(F), fieldStrided: stat(FS), render: stat(R), n,
           qual: (window.__qual ? window.__qual() : null), NV: (typeof NV !== 'undefined' ? NV : null) };
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
// GOAL room — RE-INTRODUCED (reverses STAGE11 CHANGE #3). Every goal gets a guaranteed
// screen-time plateau so its full flood→hold→штиль→reset envelope PLAYS OUT before the
// next beat — critical when two goals land close in match-time (e.g. an exchange in the
// dying minutes): without this the second goal's «latest-goal-wins» wave instantly
// swallows the first's flood/pause. The room LENGTH now tracks the live flood envelope +
// cfg.A.goalPause (computed as `goalRoom` in buildDramaticClock), so there's no dead dwell.
// Placed ASYMMETRICALLY (tiny sigPre → no pre-goal hang; wide sigPost → room AT/AFTER goal).
// NO pre-goal slowdown — sigPre is TIGHT (like a chance). The clock runs into the goal at
// normal speed (no «замирает перед голом» freeze), then all the room lives AT/AFTER the
// goal where the flood plays. The goal CREST still rises on the fast approach, PEAKS at the
// goal, and stands VISIBLE through the slow post-goal ROLL — so the spike reads WITHOUT any
// pre-goal hang. (An earlier 0.28 gave ~1.5s of pre-goal dwell → the freeze the user hit.)
// NO-POST-GOAL-STATIC (2026-07-14): sigPost 0.6 → 0.28. A WIDE post hump spread the goal room
// over a wide match-minute span, so the MINUTE kept CREEPING (<1 min/s) for ~0.6-0.8s AFTER the
// visual flood had already settled to centre (wave hands off at wall≈2.4s) — the seam, now driven
// by the natural front at that near-frozen minute, sat STATIC = the owner's «зависает на 1-2 сек».
// A TIGHTER post hump makes the minute cross the goal region and RESUME advancing by the time the
// flood reaches centre, so the seam keeps moving continuously into resumed play (verified: 0 static
// >0.35s after the flood). The flood itself is UNAFFECTED — it plays over WALL time via progress
// (wallSecondsSinceGoal), independent of the minute dwell.
const GOAL_SIG_PRE = 0.05, GOAL_SIG_POST = 0.28;
// I(t) sampling resolution (match-minutes per bin) + smoothing window (minutes).
const DRAMA_DT = 0.05;
const DRAMA_SMOOTH_MIN = 0.55;   // short Gaussian: each episode → a localized hump

// warp state (built per loaded match)
let dramaN = 0;                 // number of bins
let dramaWcum = null;           // cumulative screen-time weight W at each bin edge (len N+1)
let dramaWtot = 0;              // W(fullT)
// EFFECTIVE wall budget for one pass. ADDITIVE goal room (2026-07-19): the clock no longer
// squeezes goal dwell into the fixed DRAMA_TOTAL_S — each guaranteed beat's screen-seconds are
// ADDED on top of a STABLE open-play budget, so the total GROWS with goal count while open play
// keeps its seconds (effTotal = OPEN_BUDGET_S · Wtot_final/Wbase). Set in buildDramaticClock;
// the DRAMA_TOTAL_S init keeps pre-build reads safe.
let dramaEffTotal = DRAMA_TOTAL_S;
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
      // STEEPLY xG-weighted so a DANGEROUS chance out-dwells a positional shot: low flat
      // base (a weak effort barely slows the clock) + a steep xG term + an on-target
      // bonus, all scaled by the xgImp dial. This gives each real xG PEAK its own place —
      // the clock lingers on danger so the tall spire plays out instead of being smeared.
      const xgImp = Number.isFinite(cfg.A.xgImp) ? clamp(cfg.A.xgImp, 0, 3) : 1;
      add(e.t, (1.5 + 20.0 * xg + (onTarget ? 2.5 : 0)) * xgImp);
      continue;
    }
    // PENETRATION («выпад») — a sharp forward pass IS a visible beat (the finger stabs
    // the front forward, in-plane), so it now earns dramatic room too — using the SAME
    // penetration signal buildThrustFingers renders, so the clock slows exactly where a
    // finger appears. Gated (deep / through / long, fwd ≥ penMin) so only real thrusts
    // count. Weight ∝ forward depth × boosts × penImp; penImp=0 restores the old
    // shots-only behaviour. This is the "territorial drama" the piece is really about.
    if (e.kind === 'pass' && Number.isFinite(e.eu)) {
      const penImp = Number.isFinite(cfg.A.penImp) ? clamp(cfg.A.penImp, 0, 3) : 0;
      if (penImp <= 0) continue;
      const isH = e.team === 'home';
      if (!isH && e.team !== 'away') continue;
      const fwd = isH ? (e.eu - e.u) : (e.u - e.eu);
      const penMin = Number.isFinite(cfg.A.penMin) ? cfg.A.penMin : 0.10;
      if (fwd < penMin) continue;
      const deep = isH ? (e.eu >= 0.60) : (e.eu <= 0.40);   // reached the final third
      if (!deep && !e.through && !e.long) continue;         // penetration gate
      const w = clamp(fwd * 3.0, 0, 1.2) * (e.through ? 1.8 : 1) * (e.long ? 1.4 : 1) * (deep ? 1.2 : 1);
      add(e.t, 3.2 * penImp * w);   // room ∝ penetration depth; less than a shot so shots/goals still dominate
      continue;
    }
    // (box-entry / final-third / transition / card / penalty importance intentionally
    //  NOT added — they have no distinct on-screen visual; only shots/goals/penetrations do.)
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
  // GOALS FIRST — each goal claims a guaranteed screen-time plateau (GOAL_ROOM_S) so its
  // whole flood→hold→штиль→reset envelope plays before the next beat. Reverses STAGE11
  // CHANGE #3 (which let goals play in normal flow → a rapid exchange lost the first
  // goal's flood/pause). Asymmetric (GOAL_SIG_PRE≪GOAL_SIG_POST) so there's NO pre-goal
  // hang — the room sits AT/AFTER the goal, exactly where the flood plays. Pushed before
  // the chance loop so its nearGoal test suppresses a redundant chance beat on the shot.
  // GOAL room — the MINUTE dwell (how slowly the match-minute reads around the goal). NO-POST-GOAL-
  // STATIC (2026-07-14): this used to TRACK the full wave envelope (roll+hold+штиль+reset+pause ≈
  // 2.3s), which made the minute stay near-frozen for the WHOLE wave AND a Gaussian tail past it —
  // so once the flood settled to centre (wall≈2.2s) and handed off to the natural front, the minute
  // was STILL creeping and the seam sat static (the «зависание»). But the wave plays over WALL time
  // via progress (wallSecondsSinceGoal), so it is INDEPENDENT of this minute dwell — we can shorten
  // the dwell WITHOUT shortening the visible flood. We now cap it BELOW the settle-to-centre time so
  // the minute RESUMES advancing as the flood reaches centre → the seam keeps moving continuously
  // into resumed play (no dead window). The goal is still emphasised by the flood animating + the
  // (tight) minute slow-down through the roll. Kept ≥ a floor so two goals close in match-time still
  // separate. Read live from cfg (rebuilt on the goal sliders).
  const _fh = Number.isFinite(cfg.A.floodHold) ? clamp(cfg.A.floodHold, 0, 12) : FLOOD_HOLD_DEFAULT_S;
  const _lu = Number.isFinite(cfg.A.lull) ? clamp(cfg.A.lull, 0, 12) : 0;
  const _rs = Number.isFinite(cfg.A.goalReset) ? clamp(cfg.A.goalReset, 0, 8) : FLOOD_RELAX_S;
  const _kick = Number.isFinite(cfg.A.goalPause) ? clamp(cfg.A.goalPause, 0, 6) : 0.3;   // the ~0.3s post-settle BEAT
  const settleToCentre = FLOOD_SWEEP_S + _fh + _lu + _rs;   // wall-sec the wave takes to roll → hold → reset to centre
  // Cap the dwell at ≈ the flood-settle duration PLUS the small kickoff BEAT (goalPause): the minute
  // stays slow through the whole flood (the goal keeps its moment) AND through the ~0.3s centre-hold
  // beat, then RESUMES right as the beat ends — so the small exhale is real (the minute is frozen for
  // it) but there is NO long dead tail past it. Owner: a ~0.3s pause after the seams level, not the
  // old 1-2s freeze. The tight sigPost (0.28) keeps the hump from spilling a slow tail PAST this.
  const goalRoom = clamp(0.9 * (settleToCentre + _kick), 1.4, 2.4);
  const goalTimes = timeline.filter((e) => e.kind === 'shot' && e.isGoal).map((e) => e.t);
  for (const gt of goalTimes) {
    guaranteed.push({ t: gt, sec: goalRoom, sigPre: GOAL_SIG_PRE, sigPost: GOAL_SIG_POST });
  }
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

  // --- ADDITIVE-BUDGET BASELINE (2026-07-19) — freeze the seconds-per-density-min from the
  // ROUTINE density (calmFloor + smooth importance, AFTER the first speed cap, BEFORE any
  // guaranteed goal/chance top-up). Because this rate is FIXED, adding a goal's density hump
  // below ADDS its target screen-seconds to the total instead of compressing open play into a
  // fixed budget. Open play (this baseline) keeps ~OPEN_BUDGET_S seconds regardless of goal
  // count; the effective total (dramaEffTotal) then GROWS by Σ goal room. OPEN_BUDGET_S is the
  // single calibration dial: =DRAMA_TOTAL_S keeps open play at today's (goalless) pace.
  const OPEN_BUDGET_S = DRAMA_TOTAL_S;
  let Wbase = 0; for (let b = 0; b < N; b++) Wbase += dens[b] * DRAMA_DT;
  const SEC_PER_DENSMIN = OPEN_BUDGET_S / Math.max(1e-6, Wbase);

  // --- SEPARATION top-up: give every guaranteed beat its target screen share ---
  // Per-beat humps + a Gaussian-weighted local measure so an adjacent beat's tail
  // doesn't count as "this beat already has room" → close beats stay separate. The
  // window half-width scales with the beat's own sigma so a wide goal plateau is
  // measured (and filled) over its full extent.
  for (let pass = 0; pass < 4; pass++) {            // iterate so added humps re-normalise (measure only)
    const secPerDensMin = SEC_PER_DENSMIN;          // FIXED rate → goal room ADDS to total, not compresses open play
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
    // FIXED floor (2026-07-19): minDens = Wbase/(DRAMA_TOTAL_S·MAX) = 1/(MAX·SEC_PER_DENSMIN), so
    // the cap floor does NOT rise as the goal top-up inflates Wtot (additive budget). Routine is
    // already at/above this from the first cap; the top-up only ADDS density → this stays a no-op
    // guard that still guarantees no bin exceeds DRAMA_MAX_MIN_PER_SEC.
    const minDens = Wbase / (DRAMA_TOTAL_S * DRAMA_MAX_MIN_PER_SEC);
    for (let b = 0; b < N; b++) if (dens[b] < minDens) dens[b] = minDens;
  }

  // cumulative W at each bin edge (len N+1), W[0]=0.
  dramaWcum = new Float32Array(N + 1);
  let acc = 0;
  for (let b = 0; b < N; b++) { acc += dens[b] * DRAMA_DT; dramaWcum[b + 1] = acc; }
  dramaWtot = acc;
  // EFFECTIVE total wall = Σ dens · SEC_PER_DENSMIN = OPEN_BUDGET_S · (Wtot_final/Wbase). Open play
  // holds ~OPEN_BUDGET_S; each guaranteed goal/chance ADDS its room on top → total GROWS with goals.
  dramaEffTotal = dramaWtot * SEC_PER_DENSMIN;
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
let goalSpots = [];    // {t, team, u, v} — goal pitch spot, drives the pre-goal height crest (computeA)
let dangerShots = [];  // {t, team, xg} — dangerous non-goal shots that briefly flood the field (dangerFloodAt)
let timelineDoc = null;   // the raw loaded /api/timeline doc (for doc-level fields e.g. coolingBreaks)
let cardEvents = [];   // {t, minute, team, red} — drawn as CARDS in the markers panel (drawMarkers)
// STAGE11 CHANGE #5/#6 — persistent goal-token list (built in buildGoalMarkers) +
// real per-minute momentum (fetched in init) for the pulse strip.
let goalMarkers = [];  // {t, minute, team, pen} in match-time order, for the markers row
let shotMarks = [];    // {minute, team, xg, isGoal} — xG/shot markers on the momentum pulse
let momentum = [];     // [{minute, v}] valueNorm +home/−away, real data (rich record)
let matchPossession = null;   // {home, away} ball-possession % (from the rich record)
let richShots = [];           // rich-record shots (carry PLAYER names, matched to timeline by minute+xg)
let xgLabels = [];            // {t, team, u, v, player, xg} — strongest xG peaks get a floating player-name label
const XGLABEL_MIN = 0.30;     // only the STRONGEST chances get a label (avoid clutter)
// GOAL SCORER resolver — timeline goal → scorer NAME. Matching by minute+xg FAILS for goals:
// FotMob (rich) numbers stoppage/ET differently from WhoScored (timeline) — e.g. a 99' goal in
// the timeline is minute 90 in rich — and a goal's xg is often null. So match goals by TEAM +
// ORDER instead: the Nth goal a team scores in the timeline = the Nth goal that team scores in
// rich (robust to minute/xg drift). Keyed by the timeline goal's t. Built once after load.
let _goalScorers = new Map();
function buildGoalScorers() {
  _goalScorers = new Map();
  const rich = { home: [], away: [] };
  for (const rs of (richShots || [])) {
    if ((rs.isGoal || rs.type === 'Goal') && (rs.team === 'home' || rs.team === 'away') && rs.player) rich[rs.team].push(rs);
  }
  rich.home.sort((a, b) => (a.minute || 0) - (b.minute || 0));
  rich.away.sort((a, b) => (a.minute || 0) - (b.minute || 0));
  const idx = { home: 0, away: 0 };
  const tlGoals = (timeline || []).filter((e) => e.kind === 'shot' && e.isGoal).sort((a, b) => a.t - b.t);
  for (const g of tlGoals) {
    if (g.ownGoal) { _goalScorers.set(g.t, g.ogScorer ? `${g.ogScorer} (OG)` : 'Own goal'); continue; }
    const arr = rich[g.team] || [];
    const i = idx[g.team]++;
    if (i < arr.length && arr[i].player) _goalScorers.set(g.t, String(arr[i].player));
  }
}

// ============================================================================
// DEV-ONLY — SCORER PHOTO AT EVERY GOAL (behind ?dev). A small headshot tinted in
// the scoring team's kit colour + the player's shirt number, floated at the goal
// moment just below the name plate. All strictly DEV-gated (built/drawn only when
// DEV is true, host is display:none unless body.dev), so the live/prod render is
// byte-identical to before. Data:
//   /players/index.json  { byName: { "<scorer name>": {qid, shirtNo, hasNatural} } }
//   /players/overrides/ + dev/player_photo_overrides.json  (owner drop-ins, checked FIRST)
//   /players/<QID>.png            natural crop (fallback baked in where no natural)
//   /players/fallback/<QID>.png   monogram fallback
// Shirt number is NOT in the served timeline (only in the raw WhoScored feed); the
// static index.json above supplies it — no pipeline change needed for the prototype.
// ============================================================================
let _playerIndex = null;          // { byName: {name:{qid,shirtNo,hasNatural,age}}, shirtByNormName:{normName:shirtNo} }
let _photoOverrides = {};         // { "<scorer name>": "overrides/<file>.png" }
let _clubByNormName = {};         // DEV: normName → club (from /dev/players_enriched.json)
let scorerPhotos = [];            // {t, team, u, v, surname, age, club, shirtNo, src}
// accent-insensitive normaliser — mirrors the asset builder so raw "Raúl" matches enriched "Raul".
const _normName = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();
const _surnameOf = (full) => {
  const base = String(full || '').replace(/\s*\(OG\)\s*$/i, '').trim();
  const parts = base.split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
};
async function loadPlayerPhotos() {
  try {
    _playerIndex = await fetch('/players/index.json').then((r) => (r.ok ? r.json() : null));
  } catch { _playerIndex = null; }
  // DEV-ONLY fetches — these two files live under /dev/ and are NOT deployed to prod, so requesting
  // them on the live site is 2 guaranteed 404s + 2 wasted round-trips per load. The card resolver
  // degrades gracefully when they're absent, so gating to DEV is safe (prod behaviour byte-identical).
  if (DEV) {
    try {
      const ovr = await fetch('/dev/player_photo_overrides.json').then((r) => (r.ok ? r.json() : null));
      // strip the doc keys (_comment/_example); keep real name→path entries
      if (ovr && typeof ovr === 'object') {
        _photoOverrides = {};
        for (const k of Object.keys(ovr)) { if (!k.startsWith('_')) _photoOverrides[k] = ovr[k]; }
      }
    } catch { _photoOverrides = {}; }
    // DEV-ONLY — club lookup. index.json has no club; the enriched LIST does. Build normName→club so
    // resolveScorerCard can attach a club the same accent-insensitive way it attaches age.
    try {
      const enr = await fetch('/dev/players_enriched.json').then((r) => (r.ok ? r.json() : null));
      if (Array.isArray(enr)) {
        _clubByNormName = {};
        for (const rec of enr) {
          if (!rec || !rec.name) continue;
          const club = rec.club;
          if (club != null && String(club).trim() !== '') _clubByNormName[_normName(rec.name)] = String(club).trim();
        }
      }
    } catch { _clubByNormName = {}; }
  }
}
// Resolve a scorer name → { surname, age, shirtNo, src } for the card. The SURNAME is ALWAYS
// produced (from the name itself); age/number come from the index when available (else null);
// photo src order: OVERRIDE → natural crop → monogram crop → generated initials monogram (so
// EVERY goal shows a complete card, never a blank). `player` is the full scorer name.
function resolveScorerCard(player) {
  const surname = _surnameOf(player);
  const nm = String(player || '').replace(/\s*\(OG\)\s*$/i, '').trim();
  const byName = (_playerIndex && _playerIndex.byName) || {};
  const shirtIdx = (_playerIndex && _playerIndex.shirtByNormName) || {};
  const rec = byName[nm] || null;
  const age = rec && rec.age != null ? rec.age : null;
  // club (DEV) — resolved like age: FIRST from the joined index record (served with the app), then
  // the accent-insensitive enriched-list map as a fallback (only served by the static dev host).
  const clubRaw = (rec && rec.club != null && String(rec.club).trim() !== '')
    ? rec.club : _clubByNormName[_normName(nm)];
  const club = clubRaw != null && String(clubRaw).trim() !== '' ? String(clubRaw).trim() : null;
  // shirt number — from the enrichment-joined record, else the tournament-wide shirt superset.
  let shirtNo = rec && rec.shirtNo != null ? rec.shirtNo : null;
  if (shirtNo == null && shirtIdx[_normName(nm)] != null) shirtNo = shirtIdx[_normName(nm)];
  // photo src: override first, then natural, then monogram fallback, then generated initials.
  let src = null, srcPng = null;
  const ovr = _photoOverrides[nm] || _photoOverrides[player];
  if (ovr) src = /^(https?:|\/)/.test(ovr) ? ovr : '/players/' + ovr;
  else if (rec && rec.qid) {
    // PHOTO — serve the optimized WebP (~95% smaller) as the PRIMARY src, keeping the original
    // PNG as srcPng so drawScorerPhotos can one-shot fall back if the webp is missing/unsupported.
    const dir = rec.hasNatural ? '' : 'fallback/';
    src = `/players/opt/${dir}${rec.qid}.webp`;
    srcPng = `/players/${dir}${rec.qid}.png`;
  }
  else src = _monogramDataUri(surname);   // no QID at all → draw initials so the card is never empty
  return { surname: surname || 'Goal', age, club, shirtNo, src, srcPng };
}
// Tiny SVG monogram (first two letters) as a data URI — used when a scorer has no crop at all,
// so the card always has a picture. Kept neutral grey (the kit colour is the card accent).
function _monogramDataUri(surname) {
  const s = (surname || '?').trim();
  const initials = (s.slice(0, 2) || '?').toUpperCase();
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'>`
    + `<rect width='120' height='120' fill='#24242e'/>`
    + `<text x='60' y='60' font-family='Arial,sans-serif' font-size='52' font-weight='700' `
    + `fill='#9a9aa6' text-anchor='middle' dominant-baseline='central'>${initials}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}
// Build one card entry per GOAL (ALL goals), carrying the goal's pitch spot (u,v) so the card
// floats at the goal like the name plate. Surname is guaranteed for every goal.
function buildScorerPhotos() {
  scorerPhotos = [];
  const goals = (timeline || []).filter((e) => e.kind === 'shot' && e.isGoal
    && Number.isFinite(e.u) && Number.isFinite(e.v)).sort((a, b) => a.t - b.t);
  for (const g of goals) {
    // scorer NAME: own-goal → the OG scorer surname; else team+order resolver (100% coverage in data).
    const player = g.ownGoal ? (g.ogScorer ? `${g.ogScorer} (OG)` : 'Own goal') : (_goalScorers.get(g.t) || null);
    const card = resolveScorerCard(player);
    scorerPhotos.push({ t: g.t, team: g.team, u: g.u, v: g.v,
      surname: card.surname, age: card.age, club: card.club, shirtNo: card.shirtNo, src: card.src, srcPng: card.srcPng });
  }
}
// Build the floating xG-peak labels: the biggest chances (xg ≥ XGLABEL_MIN), each with the
// shooter's NAME (the timeline shot has no player, so we match the rich shot by minute + xg).
function buildXgLabels() {
  xgLabels = [];
  // resolve a shot's shooter NAME — GOAL by team+order (robust to minute/xg drift), CHANCE by
  // nearest rich shot on minute+xg.
  const resolvePlayer = (e) => {
    if (e.ownGoal) return e.ogScorer ? `${e.ogScorer} (OG)` : 'Own goal';
    let player = e.isGoal ? (_goalScorers.get(e.t) || null) : null;
    if (!player) {
      let best = null, bestD = 1e9;
      for (const rs of richShots) {
        if (rs.team && e.team && rs.team !== e.team) continue;   // SAME team only — else a chance can borrow the opponent's name (Mbappé on a Paraguay chance)
        const dm = Math.abs((Number(rs.minute) || 0) - (Number(e.minute) || 0));
        if (dm > 1.5) continue;
        const d = dm + Math.abs((Number(rs.xg) || 0) - (Number(e.xg) || 0)) * 3;
        if (d < bestD) { bestD = d; best = rs; }
      }
      player = best && best.player ? String(best.player) : null;
    }
    return player;
  };
  const halfOf = (min) => (min <= 45 ? 1 : (min <= 90 ? 2 : 3));   // 1st / 2nd / ET bucket
  const pushLabel = (e) => {
    const player = resolvePlayer(e);
    if (!player && !e.isGoal) return;              // chances need a name; a GOAL is shown regardless
    const isPen = /penalt/i.test(String(e.situation || '')) || /penalt/i.test(String(e.type || ''));
    xgLabels.push({ t: e.t, team: e.team, u: e.u, v: e.v, player: player || 'Goal',
      xg: Number(e.xg) || 0, isGoal: !!e.isGoal, isPen, half: halfOf(Number(e.minute) || 0) });
  };
  let cand = (timeline || []).filter((e) => e.kind === 'shot' && Number.isFinite(e.u) && Number.isFinite(e.v));
  // PENBEAT — a penalty is owned ENTIRELY by the BEAT (dark stage + kicker hill + its own floating
  // taker label). Its ambient terrain reactions are already skipped (computeA / thrust / reach /
  // goal-crest). The floating xG-peak LABEL was the ONE unguarded contributor: it re-anchored a
  // "<taker> penalty" name-tag at the pen spot on RESUMED play (over whatever genuine terrain sits
  // there), which read as the SAME penalty appearing again «в одеяле» after the beat. Drop pens from
  // the label candidate pool so no name-tag is built for them ANYWHERE (main pass AND per-half
  // promotion → the half promotes the next-best NON-pen chance instead). Byte-identical when PENBEAT off.
  if (PENBEAT && penBeatTimes && penBeatTimes.size) cand = cand.filter((e) => !penBeatTimes.has(e.t));
  // STRONGEST chances (xg ≥ XGLABEL_MIN) + EVERY goal.
  for (const e of cand) { if ((Number(e.xg) || 0) >= XGLABEL_MIN || e.isGoal) pushLabel(e); }
  // GUARANTEE a named xG chance PER HALF — if a half has NO labelled non-goal chance, promote its
  // STRONGEST chance (with a matched player) even below XGLABEL_MIN, so ≥1 attempt per half is named.
  const haveHalf = new Set(xgLabels.filter((L) => !L.isGoal).map((L) => L.half));
  const byHalf = {};
  for (const e of cand) { if (e.isGoal) continue; const h = halfOf(Number(e.minute) || 0); (byHalf[h] = byHalf[h] || []).push(e); }
  for (const h of Object.keys(byHalf)) {
    if (haveHalf.has(Number(h))) continue;
    // only promote a chance that ALSO produces a visible выпад — a DANGER shot (on-target/saved OR
    // xg ≥ DANGER_XG). A weak OFF-target shot (e.g. Undav 5', xg 0.03) has NO peak/finger, so its
    // name would float over nothing. Better no forced label than an unanchored one.
    const top = byHalf[h].filter((e) => resolvePlayer(e)
        && (e.type === 'SavedShot' || e.type === 'ShotOnPost' || (Number(e.xg) || 0) >= DANGER_XG))
      .sort((a, b) => (Number(b.xg) || 0) - (Number(a.xg) || 0))[0];
    if (top) pushLabel(top);
  }
  xgLabels.sort((a, b) => a.t - b.t);
  // DEDUPE — a shot + its rebound/follow-up (or two events the rich data maps to the same
  // player) double the label. Merge same-player labels within a wider window; prefer a goal,
  // then the higher xg. Keeps just one clean name-tag per chance.
  const kept = [];
  for (const L of xgLabels) {
    // MERGE a label into an existing one if it's the same shooter close in time, OR the SAME
    // logged chance (same team, identical xG, close in time — a WhoScored double-log the rich
    // match may have named differently). Either way it's one moment → one name-tag.
    const dup = kept.find((k) => Math.abs(k.t - L.t) < 4.0 && (
        k.player === L.player ||
        (k.team === L.team && Math.abs(k.xg - L.xg) < 1e-4)));
    if (!dup) { kept.push(L); continue; }
    if ((L.isGoal && !dup.isGoal) || L.xg > dup.xg) { dup.t = L.t; dup.u = L.u; dup.v = L.v; dup.xg = L.xg; dup.isGoal = L.isGoal; dup.isPen = L.isPen; dup.player = L.player; }
  }
  xgLabels = kept;
}
let matchStats = null;        // aggregated post-match stats {home:{...}, away:{...}} (buildMatchStats)
// Aggregate the REAL post-match stats per team (xG, possession, shots, corners, cards) from
// the timeline + cornersByTime + cardEvents + the rich possession. Shown after the animation
// settles (drawStatsPanel). Real data only — nothing fabricated.
function buildMatchStats() {
  const blank = () => ({ xg: 0, shots: 0, corners: 0, cards: 0, poss: null });
  const s = { home: blank(), away: blank() };
  for (const e of (timeline || [])) {
    if (e.kind !== 'shot') continue;
    const t = e.team; if (t !== 'home' && t !== 'away') continue;
    s[t].shots++; s[t].xg += Number(e.xg) || 0;
  }
  for (const c of (cornersByTime || [])) { if (s[c.team]) s[c.team].corners++; }
  for (const c of (cardEvents || [])) { if (s[c.team]) s[c.team].cards++; }
  if (matchPossession) { s.home.poss = matchPossession.home; s.away.poss = matchPossession.away; }
  s.home.xg = +s.home.xg.toFixed(2); s.away.xg = +s.away.xg.toFixed(2);
  matchStats = s;
}
function countGoals() {
  goalsByTime = timeline.filter((it) => it.kind === 'shot' && it.isGoal).map((g) => {
    // COUNTER-ATTACK goals (2026-07-14) — a FastBreak / IndividualPlay / through-ball goal
    // should flood as a NARROW FINGER at the shot's flank, not a full-width wall (owner ask).
    // Thread the attack type + shot flank v so goalWaveAt can localise the roll. Positional /
    // set-piece / corner / penalty goals keep isCounter=false → full-width wall as before.
    const sit = String(g.situation || '');
    const isCounter = sit === 'FastBreak' || sit === 'IndividualPlay' || g.through === true;
    return { t: g.t, team: g.team, situation: sit, isCounter,
      v: Number.isFinite(g.v) ? g.v : 0.5 };
  });
  // EMOTIONAL-ESCALATION streak count — for every shot, how many DANGEROUS shots (either
  // team, xg ≥ STREAK_XG or a goal) fell in the preceding STREAK_WIN_MIN match-minutes. A
  // flurry of chances then reads TALLER (see contribLift). Deterministic from the timeline.
  {
    // DANGER FLOOD source — dangerous NON-goal shots (goals flood via goalWaveAt). Newest ≤ t
    // washes the whole field toward the shooter's colour (dangerFloodAt).
    dangerShots = timeline.filter((it) => {
                            if (it.kind !== 'shot' || it.isGoal) return false;
                            if (!Number.isFinite(it.u) || !Number.isFinite(it.v)) return false;
                            // DANGEROUS = a shot the keeper had to deal with (ON TARGET / saved / off the
                            // post) OR a decent chance by xG. Low-xG box shots & keeper SAVES are exactly
                            // the dangerous episodes the viz must show — EVERY one earns a coloured
                            // FINGER-выпад toward the goal (its depth follows the shot's pitch POSITION,
                            // not xG, so a saved box shot still reads as a deep thrust). Every match.
                            const onTarget = it.type === 'SavedShot' || it.type === 'ShotOnPost';
                            return onTarget || (Number(it.xg) || 0) >= DANGER_XG;
                          })
                          .map((s) => ({ t: s.t, team: s.team, xg: Number(s.xg) || 0, u: s.u, v: s.v,
                            pen: /penalt/i.test(String(s.situation || '')) || /penalt/i.test(String(s.type || '')) }))
                          .sort((a, b) => a.t - b.t);
    // ONE CHANCE = ONE finger. WhoScored routinely logs a single chance as TWO shot events
    // (e.g. a penalty as award→kick, or a fast break as MissedShots+SavedShot) with an
    // IDENTICAL xG. Collapse consecutive same-team events that are the same logged chance —
    // detected by either both being penalties, or xG matching to full precision — into one
    // (keep the earlier). Prevents duplicate fingers/labels for a single moment.
    {
      const _dd = [];
      for (const s of dangerShots) {
        const p = _dd.length ? _dd[_dd.length - 1] : null;
        const sameChance = p && p.team === s.team && (
          (s.t - p.t) < 0.8 ||                                                      // rebound / same phase (any xg)
          ((s.t - p.t) < 5.0 && ((p.pen && s.pen)                                   // one penalty logged as award+kick
            || (p.xg > 0 && Math.abs(p.xg - s.xg) < 1e-4)))                         // same chance double-logged (identical >0 xG)
        );
        if (sameChance) continue;   // drop the duplicate, keep the earlier event
        _dd.push(s);
      }
      dangerShots = _dd;
    }
    const danger = timeline.filter((it) => it.kind === 'shot' && ((Number(it.xg) || 0) >= STREAK_XG || it.isGoal))
                           .sort((a, b) => a.t - b.t);
    for (const e of timeline) {
      if (e.kind !== 'shot') continue;
      let n = 0;
      for (const d of danger) { if (d === e) continue; if (d.t < e.t && d.t >= e.t - STREAK_WIN_MIN) n++; else if (d.t >= e.t) break; }
      e._streakN = n;
    }
  }
  // GOAL SPOTS for the pre-goal height crest. Use the shot's pitch coords; if a goal
  // lacks u/v (rare), fall back to the attacked goal-mouth (home attacks u→1, away u→0)
  // so EVERY goal still gets its big spire.
  goalSpots = timeline.filter((it) => it.kind === 'shot' && it.isGoal).map((g) => ({
    t: g.t, team: g.team,
    u: Number.isFinite(g.u) ? g.u : (g.team === 'home' ? 0.92 : 0.08),
    v: Number.isFinite(g.v) ? g.v : 0.5,
  }));
  // xG/shot markers for the pulse: every real shot (skip near-zero-xG noise; always keep goals).
  shotMarks = timeline
    .filter((it) => it.kind === 'shot')
    .map((s) => ({ minute: Number(s.minute) || 0, team: s.team, xg: Number(s.xg) || 0, isGoal: !!s.isGoal }))
    .filter((s) => s.xg >= 0.03 || s.isGoal);
  teamMeta.score = { home: goalsByTime.filter((g) => g.team === 'home').length, away: goalsByTime.filter((g) => g.team === 'away').length };
  buildCorners();   // CORNER WAVES — source list of corners taken (t, team, snapped pitch-corner u,v)
  buildPenalties(); // PENALTY WAVES — neutral directional pulse from the spot toward goal (scored→flood, missed→wave only)
  // CARD events for the sky flash / lightning. The timeline now carries the real sending-off
  // flag: `it.red === true` for a `Red` qualifier (straight red OR second-yellow), false for a
  // booking. RED cards fire the lightning strike (detectCardFlash / _snapFlash); yellows keep a
  // subtle flash only. Reds were deduped upstream (build_timeline) so the count is real.
  cardEvents = timeline
    .filter((it) => it.type === 'Card')
    .map((c) => ({ t: c.t, minute: c.minute || Math.floor(c.t),
                   label: c.label != null ? String(c.label) : String((c.minute || Math.floor(c.t)) + 1),
                   team: c.team, red: !!c.red, name: c.name || '', surname: c.surname || '' }))
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
  // scorer NAME from the team+order resolver (robust to minute/xg drift); fall back to a
  // minute+xg rich match if the resolver has no entry.
  const scorerOf = (g) => {
    if (g.ownGoal) return g.ogScorer ? `${g.ogScorer} (OG)` : 'Own goal';
    const byOrder = _goalScorers.get(g.t);
    if (byOrder) return byOrder;
    let best = null, bestD = 1e9;
    for (const rs of richShots) {
      if (rs.team && g.team && rs.team !== g.team) continue;   // same team only
      const dm = Math.abs((Number(rs.minute) || 0) - (Number(g.minute) || 0));
      if (dm > 2) continue;
      const d = dm + Math.abs((Number(rs.xg) || 0) - (Number(g.xg) || 0)) * 3;
      if (d < bestD) { bestD = d; best = rs; }
    }
    return best && best.player ? String(best.player) : null;
  };
  goalMarkers = timeline
    .filter((it) => it.kind === 'shot' && it.isGoal)
    .map((g) => ({ t: g.t, minute: g.minute || Math.floor(g.t),
                   label: g.label != null ? String(g.label) : String((g.minute || Math.floor(g.t)) + 1),
                   team: g.team, pen: isPen(g), player: scorerOf(g) }))
    .sort((a, b) => a.t - b.t);
}

// ============================================================================
// DEV-ONLY PROTOTYPE — INTERACTIVE EVENT-ICON LAYER ON THE SEISMOGRAPH (behind ?dev).
//
// A deliberate SECOND layer: the terrain narrative stays pure/emotional, while the timeline
// carries an optional info-layer of small, tasteful glyphs at each event's minute — GOALS,
// YELLOW cards, RED cards, and SUBSTITUTIONS. These live ONLY here (never baked into the
// terrain). Each is an HTML span positioned over the pulse canvas, so it can reuse the SAME
// CSS hover→detail pattern the goals-under-the-score use (.tl-ic::after { content: attr(data-tip) }).
//
// DATA SOURCES (all REAL — nothing invented; confirmed present in data/timeline/{id}.json):
//   · goals  → goalMarkers (carries the resolved scorer NAME via the team+order resolver)
//   · cards  → cardEvents  (it.red distinguishes yellow booking vs red sending-off)
//   · subs   → timeline 'SubstitutionOff' events (one per swap; team + minute label)
// PLAYER NAMES: the served timeline/rich records carry names for GOALS only (via richShots).
// Cards/subs have no player identity in the served data (names live in the un-served raw
// WhoScored feed), so their tooltip is honestly "<Type> · <minute>' · <TEAM>" — no invented
// names. If build_timeline later emits card/sub player names, they slot straight into `tip`.
// ============================================================================
let tlIconWrap = null;      // the HTML overlay host inside #pulse13wrap
let tlIcons = [];           // [{ fm, type, team, tip, el }] — fm = football minute for x-placement
// COOLING / WATER-BREAK timings — read ONLY from real data; never faked. Looks for a
// `coolingBreaks` array either on the loaded timeline doc (timelineDoc) or as a global the
// pipeline may attach later; each entry may carry { minute } and/or { fm } (football minute).
// VERIFIED 2026-07: the WhoScored/Opta source for these matches has NO cooling-break event,
// qualifier, period or stoppage field, so this returns [] today (the owner must source the
// timing). The icon layer below is fully wired to render the moment such data is present.
function coolingBreaks() {
  const src = (typeof timelineDoc !== 'undefined' && timelineDoc && Array.isArray(timelineDoc.coolingBreaks))
    ? timelineDoc.coolingBreaks
    : (Array.isArray(window.__coolingBreaks) ? window.__coolingBreaks : null);
  return Array.isArray(src) ? src : [];
}
function buildTimelineIcons() {
  const wrap = el('pulse13wrap');
  if (!wrap) return;
  // (re)create a dedicated overlay host so re-inits don't stack layers.
  if (tlIconWrap && tlIconWrap.parentNode) tlIconWrap.parentNode.removeChild(tlIconWrap);
  tlIconWrap = document.createElement('div');
  tlIconWrap.id = 'tlicons';
  wrap.appendChild(tlIconWrap);
  tlIcons = [];

  const ABBR = (team) => (team === 'away' ? (teamMeta.away.abbr || 'AWY') : (teamMeta.home.abbr || 'HOM'));
  const lastName = (full) => String(full || '').split(' ').filter(Boolean).pop() || '';
  const events = [];
  // GOALS — scorer surname when known (own goals keep their verbatim "(OG)" label).
  for (const g of (goalMarkers || [])) {
    let who = '';
    if (g.player) {
      who = (/\(OG\)$/.test(g.player) || g.player === 'Own goal')
        ? String(g.player) : lastName(g.player);
    }
    const tip = `Goal · ${g.label}'${who ? ' · ' + who : ''} · ${ABBR(g.team)}`;
    events.push({ fm: footballMinuteAt(g.t), gt: g.t, type: 'goal', team: g.team, tip });
  }
  // CARDS — yellow booking vs red sending-off. The rebuilt timeline now carries the booked
  // player's name/surname on each Card event, so the tooltip names them (no invented names).
  for (const c of (cardEvents || [])) {
    if (!c.red) continue;   // YELLOW cards are not rendered on the timeline (red cards only)
    const who = c.surname || lastName(c.name);
    const tip = `Red card · ${c.label}'${who ? ' · ' + who : ''} · ${ABBR(c.team)}`;
    events.push({ fm: footballMinuteAt(c.t), type: 'red', team: c.team, tip });
  }
  // SUBSTITUTIONS — one glyph per swap (the 'Off' event; the paired 'On' is the same instant).
  // The rebuilt timeline carries BOTH players on SubstitutionOff (name/surname = OFF,
  // onName/onSurname = ON), so the tooltip reads "Sub · 46' · On ↑ Álvarez ↓ Montes · MEX".
  for (const it of (timeline || [])) {
    if (it.type !== 'SubstitutionOff') continue;
    const offName = it.surname || lastName(it.name);
    const onName = it.onSurname || lastName(it.onName);
    let who = '';
    if (onName || offName) {
      who = ` · ${onName ? '↑ ' + onName : ''}${onName && offName ? ' ' : ''}${offName ? '↓ ' + offName : ''}`;
    }
    const tip = `Sub · ${it.label}'${who} · ${ABBR(it.team)}`;
    events.push({ fm: footballMinuteAt(it.t), type: 'sub', team: it.team, tip });
  }

  // ---- COOLING / WATER BREAK — REMOVED (owner request 2026-07) ---------------------------
  // The cooling-break WATER-DROP icon is intentionally NOT rendered: ZERO drops on the
  // timeline. The coolingBreaks() data source stays in the pipeline (untouched), but stage13
  // draws no drop at all. The `.tl-cool` / `.tl-drop` render below is therefore never reached.
  // (Previously this pushed one 'cool' event per match; that loop is disabled.)

  // tiny inline SVG/text glyph per type (whisper-quiet, seismograph vocabulary).
  const glyph = (type) => {
    if (type === 'goal') return '<span class="tl-goal"></span>';
    if (type === 'yellow') return '<span class="tl-card tl-yellow"></span>';
    if (type === 'red') return '<span class="tl-card tl-red"></span>';
    // COOL / WATER break — a small water-drop glyph (sits ABOVE the events row, see positionTimelineIcons).
    if (type === 'cool') return '<svg class="tl-drop" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.2 C6 1.2 2.6 5.2 2.6 7.6 A3.4 3.4 0 0 0 9.4 7.6 C9.4 5.2 6 1.2 6 1.2 Z"/></svg>';
    return `<span class="tl-sub">${SUB_LOOP_SVG}</span>`;   // substitution loop (two-arrow)
  };
  const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  for (const ev of events) {
    if (!Number.isFinite(ev.fm)) continue;
    const span = document.createElement('div');
    span.className = `tl-ic tl-${ev.type} team-${ev.team}`;
    span.setAttribute('data-tip', escAttr(ev.tip));
    span.innerHTML = glyph(ev.type);
    // team-tint via CSS custom prop (goals/cards read in the scoring/booked team's colour)
    span.style.setProperty('--tc', ev.team === 'away' ? SEN_HEX : FRA_HEX);
    span.style.display = 'none';
    tlIconWrap.appendChild(span);
    ev.el = span;
    tlIcons.push(ev);
  }
}
// per-frame — place each icon at its football-minute x on the SAME axis drawPulse uses, and
// reveal it only once the playhead has reached it (reveal-as-played, no pre-announce). Icons
// are stacked slightly above the midline; multiple icons at the same minute nudge upward so
// they don't fully overlap. Called from drawPulse (DEV only).
// SPLIT BY TEAM around the seismograph centre line, matching the momentum convention:
//   · HOME team events sit ABOVE the centre line (fanning UPWARD on collisions)
//   · AWAY team events sit BELOW the centre line (fanning DOWNWARD on collisions)
// so which team an event belongs to is obvious purely from which side it's on. COOLING-BREAK
// icons (team === null) are pinned ABOVE the whole events row (higher than any home event).
// Module-scoped scratch Maps for positionTimelineIcons — reused + cleared each frame (see below).
const _tlStackHome = new Map(), _tlStackAway = new Map(), _tlStackCool = new Map();
const _tlStackGoalHome = new Map(), _tlStackGoalAway = new Map();
function positionTimelineIcons(nowMin, xOf, H, dpr, t) {
  if (!tlIconWrap || !tlIcons.length) return;
  const cssH = H / dpr;                     // canvas backing store → CSS px
  const midY = cssH * 0.5;
  const GAP = 9;                            // px from the centre line to the first icon row
  const STEP = 11;                          // px between stacked co-incident icons
  // GOAL band — goal markers are SPLIT BY SCORING TEAM, exactly like subs/cards: a HOME goal
  // sits ABOVE the centre line, an AWAY goal BELOW it (the seismograph plots home momentum above /
  // away below, so goals must follow the same convention). Within its team's band the goal marker
  // is pushed toward the OUTER/upper part of that side so it reads as a peak on that team's side:
  // GOAL_TOP is a small inset from the very top (home goals fan DOWNWARD from it); GOAL_BOT is the
  // mirror inset from the bottom (away goals fan UPWARD from it) so co-incident goals stay in-strip.
  const GOAL_TOP = Math.max(7, cssH * 0.16);
  const GOAL_BOT = Math.min(cssH - 7, cssH - Math.max(7, cssH * 0.16));
  // SUB clearance (owner fix #2) — substitution glyphs must sit CLEANLY on their team's side,
  // never on/over the centre line. The sub glyph is ~14px tall (centred via translate -50%), so
  // its half-height ≈ 7px; we push the sub row out to GAP + this margin so even the near edge of
  // the glyph clears the centre line. (Previously a SUB_LIFT dragged subs toward centre → overlap.)
  const SUB_CLEAR = 8;                      // extra px beyond GAP so the sub glyph body clears centre
  const COOL_Y = Math.max(4, midY - GAP - 3 * STEP);   // cooling-break row, above the events
  // stack counters keyed by rounded minute, kept SEPARATE per band so goals/home/away/cool don't
  // interfere (co-incident events in the SAME band fan away from their anchor). PERF — the 5 Maps
  // are module-scoped scratch, cleared each frame (was 5 `new Map()` allocations per frame).
  const stackHome = _tlStackHome, stackAway = _tlStackAway, stackCool = _tlStackCool;
  const stackGoalHome = _tlStackGoalHome, stackGoalAway = _tlStackGoalAway;
  stackHome.clear(); stackAway.clear(); stackCool.clear(); stackGoalHome.clear(); stackGoalAway.clear();
  for (const ev of tlIcons) {
    let on;
    if (ev.type === 'goal' && Number.isFinite(ev.gt) && Number.isFinite(t)) {
      // Goal markers gate on goalLanded (the SAME EVENT_LAG_S wall-clock predicate the terrain
      // flood / score bump use) so the marker pops on the exact frame the pitch floods, instead
      // of leading it on the raw football-minute crossing. Everything else keeps minute-crossing.
      on = goalLanded(ev.gt, t);
    } else {
      on = ev.fm <= nowMin + 1e-6;
    }
    if (!ev.el) continue;
    if (!on) { if (ev.el.style.display !== 'none') ev.el.style.display = 'none'; continue; }
    const key = Math.round(ev.fm);
    const x = xOf(ev.fm) / dpr;             // xOf returns backing-store px → CSS px
    let y;
    if (ev.type === 'goal') {
      // GOALS — SPLIT BY SCORING TEAM. Home goal → outer/upper of the ABOVE side (fan downward
      // from GOAL_TOP); away goal → outer/lower of the BELOW side (fan upward from GOAL_BOT).
      if (ev.team === 'away') {
        const s = stackGoalAway.get(key) || 0; stackGoalAway.set(key, s + 1);
        y = GOAL_BOT - s * STEP;
      } else {
        const s = stackGoalHome.get(key) || 0; stackGoalHome.set(key, s + 1);
        y = GOAL_TOP + s * STEP;
      }
    } else if (ev.type === 'cool') {
      const s = stackCool.get(key) || 0; stackCool.set(key, s + 1);
      y = COOL_Y - s * STEP;                // above the events, fan further up on collisions
    } else if (ev.team === 'away') {
      const s = stackAway.get(key) || 0; stackAway.set(key, s + 1);
      // BELOW the centre line, fan downward. Subs get extra clearance so they never touch centre.
      y = midY + GAP + (ev.type === 'sub' ? SUB_CLEAR : 0) + s * STEP;
    } else {
      const s = stackHome.get(key) || 0; stackHome.set(key, s + 1);
      // ABOVE the centre line, fan upward. Subs get extra clearance so they never touch centre.
      y = midY - GAP - (ev.type === 'sub' ? SUB_CLEAR : 0) - s * STEP;
    }
    ev.el.style.display = 'flex';
    ev.el.style.left = `${x}px`;
    ev.el.style.top = `${y}px`;
  }
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
let _fmMax = 0;   // max FOOTBALL minute reached — the honest ET signal (an ET match reaches ~120)
function buildFootballMinuteTable() {
  // Use the FotMob DISPLAY minute (dispMin: 1-indexed, capped in stoppage) so the playhead axis
  // matches the momentum wave (drawn on rich minutes = ws+1). This makes the playhead reach a
  // goal's momentum spike on the SAME frame the flood fires — no 1-minute desync. dispMin still
  // caps per period (45/90/105/120), so ET detection + the ET restart are preserved.
  _fmTable = (timeline || [])
    .filter((e) => Number.isFinite(e.t) && Number.isFinite(e.minute))
    .map((e) => ({ t: e.t, m: Number.isFinite(e.dispMin) ? e.dispMin : ((Number(e.minute) || 0) + 1) }))
    .sort((a, b) => a.t - b.t);
  _fmMax = 0; for (const e of _fmTable) if (e.m > _fmMax) _fmMax = e.m;
}
// Did the match actually go to EXTRA TIME? Detect from the max FOOTBALL minute, NOT the
// expanded engine duration — a 2nd half with heavy stoppage inflates the expanded duration
// past 100 without any ET (e.g. Brazil-Norway topped out at 101' football = 90+11 stoppage,
// NOT extra time). Real ET restarts and climbs to ~120, so a threshold of 106 cleanly
// separates ET from even a long stoppage.
function matchWentToET() { return _fmMax >= 106; }
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
    const isET = matchWentToET();   // by FOOTBALL minutes, not expanded duration (stoppage ≠ ET)
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
  drawStatsPanel(t);
  // PERF — the floating-label projections (world→screen each) are only worth redoing when the
  // scene actually moved. While PLAYING, gate them to the field-recompute cadence (the same
  // frames the terrain updates); when paused / scrubbing (a snap render sets _didFieldCompute)
  // they always run so a manual seek is exact. Camera orbits still re-run them via the field tick.
  if (!(playing && !_didFieldCompute)) {
    drawXgLabels(t);
    if (CARD_PULSE) drawScorerPhotos(t);   // PROD-DEFAULT — scorer photo card at each goal (was ?dev, now live)
    drawShootLabels();
    drawPenBeatLabel();   // PENBEAT — floating taker surname above the in-match pen hill (scrub-safe)
  }
  // the scrubber tracks WALL-PROGRESS through the 15s dramatic pass (not linear
  // match-minutes), so its position matches how long each moment holds on screen.
  if (document.activeElement !== el('clock')) el('clock').value = String(wallProgress * 100);
  // align the minute-clock digit's cap-top to the score digits' cap-top. PERF: only re-measures when
  // the score/clock text or the viewport actually changed (was an unconditional per-frame layout read).
  alignClockIfNeeded();
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
// HTML-attribute escaper — module-scoped (was redefined on every eventsMarkupFor call, i.e. twice/frame).
const _escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
function eventsMarkupFor(team, t) {
  // GOALS — one disc-row per goal that has landed for this team (chronological).
  const goals = (goalMarkers || [])
    .filter((g) => g.team === team && goalLanded(g.t, t))
    .sort((a, b) => a.t - b.t);
  // RED cards are NOT rendered in this list anymore — they now show as a small red-card
  // icon ABOVE the team name (see redcardsMarkupFor / updateEventBlocks), with no minute.
  // PEN shootout — revealed ONE KICK AT A TIME during the directed post-match sequence
  // (shootoutRevealed grows as each kick's wave hits the goal), so it reads as the finale.
  let pens = [];
  if (shootActive && shootoutOrder) {
    let cnt = 0;
    for (const k of shootoutOrder) { if (cnt >= shootoutRevealed) break; if (k.team === team) pens.push(k.scored); cnt++; }
  }

  let html = '';
  for (const g of goals) {
    // hover reveals the scorer's SURNAME on a plate to the RIGHT of the disc+minute (which stay).
    // An own-goal label already reads "<Surname> (OG)" (or "Own goal") — keep it verbatim
    // rather than splitting on spaces (which would drop everything before the "(OG)" token).
    const surname = g.player
      ? (/\(OG\)$/.test(g.player) || g.player === 'Own goal'
          ? String(g.player)
          : String(g.player).split(' ').filter(Boolean).pop())
      : 'Goal';
    html += `<div class="ev goal-ev" data-tip="${_escAttr(surname)}"><span class="v"><span class="mk goal"></span>${g.label != null ? g.label : g.minute}'</span></div>`;
  }
  if (pens.length) {
    let ring = '';
    for (const scored of pens) ring += `<span class="pk ${scored ? 'scored' : 'miss'}"></span>`;
    html += `<div class="ev shoot">${ring}</div>`;
  }
  return html;
}
// RED-CARD icon(s) shown ABOVE a team's name (no minute). One small upright red card per
// sending-off this team has received by the current clock; empty string when none (the slot
// collapses to zero height in CSS). Yellows are never included (c.red filter).
function redcardsMarkupFor(team, t) {
  const n = (cardEvents || []).filter((c) => c.red && c.t <= t && c.team === team).length;
  if (!n) return '';
  let html = '';
  for (let i = 0; i < n; i++) html += '<span class="rc"></span>';
  return html;
}
let _redSig = { home: '', away: '' };   // last-rendered red-card signature per team
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
  // red-card icon(s) above each team name (no minute)
  const hR = el('hRed'), aR = el('aRed');
  if (hR) {
    const m = redcardsMarkupFor('home', t);
    if (m !== _redSig.home) { hR.innerHTML = m; _redSig.home = m; }
  }
  if (aR) {
    const m = redcardsMarkupFor('away', t);
    if (m !== _redSig.away) { aR.innerHTML = m; _redSig.away = m; }
  }
}
// POST-MATCH STATS panel — revealed under each team's goals once the match has SETTLED (the
// animation is over; for a shootout match, once the shootout has fully resolved). Shows the
// real per-team xG / possession / shots / corners / cards. Signature-diffed so it only writes
// the DOM when the markup changes.
let _statsSig = '';
function drawStatsPanel(t) {
  const host = el('mStats');
  // Does this match have a shootout, and if so is it fully played out yet? For a shootout
  // match the stats panel must stay HIDDEN until the LAST kick has resolved — not merely
  // until regulation settles (settle→1 happens BEFORE the shootout even begins). `pendShoot`
  // is true from the moment regulation starts settling right through to the decisive kick.
  const hasShoot = !!(shootoutOrder && shootoutOrder.length);
  // "done" = the LAST kick's hill AND the winner-flood finale have fully settled — not merely
  // when the final dot reveals (the decisive hill is still rising then). Mirror the finale
  // moment used by shootoutWaveAt(): pause0 + (n-1)*gap + wave + flood + tail.
  let shootDone = false;
  if (hasShoot && shootActive) {
    const { pause0, gap } = shootTiming();
    const lastEnd = pause0 + (shootoutOrder.length - 1) * gap + SHOOT_WAVE_S * 0.5 + SHOOT_FLOOD_S + 0.9;
    shootDone = shootWall >= lastEnd;
  }
  const pendShoot = hasShoot && !shootDone;   // shootout exists but hasn't fully resolved yet
  // END-STATE VIGNETTE — fade the scrim in as the match settles (off while a shootout is still
  // pending so the finale stays bright); the stats then read cleanly over the darkened cloth.
  const scrim = el('endscrim');
  if (scrim) {
    const sv = pendShoot ? 0 : smoothstep(0, 1, clamp((settle - 0.05) / 0.6, 0, 1));
    const op = sv.toFixed(3);
    if (scrim.style.opacity !== op) scrim.style.opacity = op;
  }
  if (!host) return;
  const show = !!matchStats && settle > 0.55 && !pendShoot;
  host.classList.toggle('show', show);
  if (!show) return;
  const h = matchStats.home, a = matchStats.away; if (!h || !a) return;
  // ONE label per metric; home value LEFT, away value RIGHT (matches the scoreboard), all rows
  // on the SAME baseline; a split mini-bar under each shows the share. English labels.
  const rows = [];
  if (h.poss != null && a.poss != null) rows.push(['POSSESSION', h.poss, a.poss, (Number(h.poss) || 0) + '%', (Number(a.poss) || 0) + '%']);
  rows.push(['xG', h.xg, a.xg, (Number(h.xg) || 0).toFixed(2), (Number(a.xg) || 0).toFixed(2)]);
  rows.push(['SHOTS', h.shots, a.shots, Number(h.shots) || 0, Number(a.shots) || 0]);
  rows.push(['CORNERS', h.corners, a.corners, Number(h.corners) || 0, Number(a.corners) || 0]);
  rows.push(['CARDS', h.cards, a.cards, Number(h.cards) || 0, Number(a.cards) || 0]);
  const html = rows.map(([lab, hv, av, hd, ad]) => {
    const tot = (Number(hv) || 0) + (Number(av) || 0);
    const hp = tot > 0 ? (Number(hv) || 0) / tot * 100 : 50;
    const ap = 100 - hp;
    return `<div class="mrow"><div class="mtop">`
      + `<span class="mval mval--h">${hd}</span><span class="mlab">${lab}</span><span class="mval mval--a">${ad}</span>`
      + `</div><div class="mbar"><i class="mbar-h" style="width:${hp.toFixed(1)}%"></i><i class="mbar-gap"></i><i class="mbar-a" style="width:${ap.toFixed(1)}%"></i></div></div>`;
  }).join('');
  if (html !== _statsSig) { host.innerHTML = html; _statsSig = html; }
}
// FLOATING xG-PEAK LABELS — a small "PlayerName · 0.79 xG" pill anchored above the strongest
// chances, appearing WITH the peak (never before → no spoiler) and fading as it decays. The
// peak's pitch spot is projected to screen each frame (works with the ortho camera).
let _xgDivs = [];
const _xgV3 = new THREE.Vector3();
const _xgEnvs = [];   // reused per-frame envelope scratch (see drawXgLabels)
function drawXgLabels(t) {
  const host = el('xglabels'); if (!host) return;
  while (_xgDivs.length < xgLabels.length) {
    const d = document.createElement('div'); d.className = 'xglabel';
    d.innerHTML = '<span class="xg-p"></span><span class="xg-v"></span>';
    host.appendChild(d); _xgDivs.push(d);
  }
  const canvas = el('stage'); if (!canvas || !camera) return;
  const W = _cw, H = _ch;   // PERF — cached client box (no per-frame clientWidth read → no layout thrash after HUD writes)
  // PASS 1 — compute each label's time-envelope (how strongly it wants to show right now).
  // A GOAL label is tied to its flood (wall-seconds); a CHANCE label rises with its peak then
  // decays. Env→0 hides it. Computed for ALL labels first so pass 2 can pick a single winner.
  // PERF — reuse a module-scoped scratch array (was `new Array(...)` every frame). Every index is
  // written below, but fill(0) keeps the pre-write default identical to the old code.
  const envs = _xgEnvs;
  if (envs.length !== xgLabels.length) envs.length = xgLabels.length;
  envs.fill(0);
  for (let i = 0; i < xgLabels.length; i++) {
    const L = xgLabels[i];
    const age = t - L.t;                                  // match-minutes since the shot
    let env = 0;
    // PROD-DEFAULT — the scorer CARD (drawScorerPhotos) now carries the scorer NAME at every
    // goal for ALL visitors, so suppress the old goal name-plate here to avoid showing the name
    // twice. CHANCE (non-goal) labels are untouched — the card is goals-only, so they never
    // duplicate. Follows CARD_PULSE so it tracks the card: when the card renders, this hides the
    // duplicate plate; if the card were ever re-gated off, the plate would return automatically.
    if (CARD_PULSE && L.isGoal) { envs[i] = 0; continue; }
    if (L.isGoal) {
      // GOAL name — tied to the FLOOD in WALL seconds: appears when the goal LANDS (score
      // updates, EVENT_LAG_S — so it never leads the perceived goal), HOLDS while the flood
      // covers the field, then FADES OUT during the rollback — GONE before the kickoff/центр,
      // so no player name is left hanging over the receding wave.
      const w = wallSecondsSinceGoal(L.t, t);
      if (Number.isFinite(w)) {
        const fh = Number.isFinite(cfg.A.floodHold) ? clamp(cfg.A.floodHold, 0, 12) : FLOOD_HOLD_DEFAULT_S;
        const lu = Number.isFinite(cfg.A.lull) ? clamp(cfg.A.lull, 0, 12) : 0;
        const rs = Number.isFinite(cfg.A.goalReset) ? clamp(cfg.A.goalReset, 0, 8) : FLOOD_RELAX_S;
        const holdEnd = FLOOD_SWEEP_S + fh + lu, fadeEnd = holdEnd + rs;
        if (w >= EVENT_LAG_S && w < fadeEnd) {
          const rise = smoothstep(EVENT_LAG_S, EVENT_LAG_S + 0.35, w);
          const fall = w < holdEnd ? 1 : (1 - smoothstep(holdEnd, fadeEnd, w));
          env = rise * fall;
        }
      }
    } else {
      // chance name — appears WITH the peak (age≥0), quick rise then a decay. Shortened τ so a
      // chance clears promptly (never lingers ~5 min into later events / the final frame).
      if (age >= 0) env = Math.min(1, age / 0.25) * Math.exp(-Math.max(0, age - 0.25) / 1.1);
    }
    envs[i] = env;
  }
  // ONE LABEL AT A TIME — pick the SINGLE most-recent event that is currently active (env≥0.06)
  // and show only it; hide every other label. This is the fix for accumulating / stale labels:
  // an older chance's decay tail can no longer coexist with (or linger past) a newer event, and
  // no opponent name is left over on the settled final frame — once the last event's env decays
  // to 0, nothing shows. Ties (same t) resolve to the later index (goal merged onto the chance).
  let win = -1;
  for (let i = 0; i < xgLabels.length; i++) {
    if (envs[i] < 0.06) continue;
    if (win < 0 || xgLabels[i].t >= xgLabels[win].t) win = i;
  }
  for (let i = 0; i < xgLabels.length; i++) {
    const d = _xgDivs[i];
    if (i !== win) { if (d.style.opacity !== '0') d.style.opacity = '0'; continue; }
    const L = xgLabels[i], env = envs[i];
    _xgV3.set(worldX(L.u), 2.8, worldZ(L.v)).project(camera);   // peak spot, lifted a touch above the crest tip
    if (_xgV3.z > 1) { d.style.opacity = '0'; continue; }
    const sx = (_xgV3.x * 0.5 + 0.5) * W, sy = (-_xgV3.y * 0.5 + 0.5) * H;
    d.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
    const tag = L.isPen ? 'penalty' : '';
    const sig = L.player + '|' + tag;
    if (d._sig !== sig) {
      d.querySelector('.xg-p').textContent = L.player;
      d.querySelector('.xg-v').textContent = tag;
      d._sig = sig;
    }
    d.style.opacity = String(clamp(env * 1.35, 0, 1));
  }
  for (let i = xgLabels.length; i < _xgDivs.length; i++) _xgDivs[i].style.opacity = '0';
}

// DEV-ONLY — draw the small kit-tinted scorer photo + shirt number at each goal. Reuses the
// SAME goal-flood wall-time envelope as the name plate (appears when the goal LANDS, holds over
// the flood, fades before kickoff) and the SAME pitch-spot→screen projection, offset DOWN so the
// photo sits just below the name plate. Multiple goals can be active at once (unlike the single
// name plate) so back-to-back goals each show their scorer. Strictly gated: only ever called when
// DEV, host is display:none unless body.dev — live/prod render is unaffected.
const _spDivs = [];
const _spV3 = new THREE.Vector3();
// Auto-shrink the surname to fit the caption row: step the font-size down from the CSS base to a
// floor until the text width fits the available room (card inner width minus the number badge and
// the row gap). Anything still too long at the floor is clipped by the CSS nowrap+ellipsis. Guards
// gracefully when width reads 0 (card display-collapsed / fonts not ready) — leaves the base size.
function _fitScorerName(card, nameEl) {
  if (!card || !nameEl) return;
  nameEl.style.fontSize = '';                       // reset to the CSS base before measuring
  const row = card.querySelector('.sp-line1');
  const txt = card.querySelector('.sp-txt');
  const avail = (txt ? txt.clientWidth : 0);        // padded card inner width (the text column)
  if (!(avail > 0)) return;                          // 0 → not laid out yet; keep CSS base, ellipsis still applies
  const numEl = card.querySelector('.sp-num');
  const badgeW = (numEl && getComputedStyle(numEl).display !== 'none') ? numEl.getBoundingClientRect().width : 0;
  const gap = row ? (parseFloat(getComputedStyle(row).columnGap) || 0) : 0;
  const room = Math.max(0, avail - badgeW - (badgeW ? gap : 0));
  if (!(room > 0)) return;
  const base = parseFloat(getComputedStyle(nameEl).fontSize) || 16;
  const floor = Math.max(9, base * 0.62);            // sensible minimum before we give up and ellipsis
  let px = base;
  // scrollWidth is the untruncated text width even with overflow:hidden set on the element.
  while (px > floor && nameEl.scrollWidth > room) {
    px = Math.max(floor, px - 1);
    nameEl.style.fontSize = px + 'px';
  }
}
function drawScorerPhotos(t) {
  const host = el('scorerphotos'); if (!host) return;
  while (_spDivs.length < scorerPhotos.length) {
    const d = document.createElement('div'); d.className = 'sp-card';
    d.innerHTML = '<div class="sp-photo"><img alt="" decoding="async" loading="lazy"></div>'
      + '<div class="sp-txt">'
      + '<span class="sp-line1"><span class="sp-num"></span><span class="sp-name"></span></span>'
      + '<span class="sp-info"></span></div>';
    host.appendChild(d); _spDivs.push(d);
  }
  const canvas = el('stage'); if (!canvas || !camera) return;
  const W = _cw, H = _ch;   // PERF — cached client box (see drawXgLabels)
  // goal-flood envelope (wall seconds) — identical basis to the goal name plate in drawXgLabels.
  const fh = Number.isFinite(cfg.A.floodHold) ? clamp(cfg.A.floodHold, 0, 12) : FLOOD_HOLD_DEFAULT_S;
  const lu = Number.isFinite(cfg.A.lull) ? clamp(cfg.A.lull, 0, 12) : 0;
  const rs = Number.isFinite(cfg.A.goalReset) ? clamp(cfg.A.goalReset, 0, 8) : FLOOD_RELAX_S;
  const holdEnd = FLOOD_SWEEP_S + fh + lu, fadeEnd = holdEnd + rs;
  // The scorer CARD gets a STABLE minimum on-screen time (~1.6s), DECOUPLED from the brisk goal-flood
  // timing. BRISK-SETTLE (2026-07-14) shrank floodHold/lull (→ holdEnd≈1.1s) to kill the post-goal
  // freeze; keying the card purely off holdEnd would flash it for only ~0.4s. So the card holds through
  // the celebration (well within the goal's dramatic dwell) and fades over the goal RESET, like the
  // name plate. Sequence still reads: peak rises → card appears (after EVENT_LAG_S) → card fades.
  let cardFadeEnd = Math.max(holdEnd + rs, EVENT_LAG_S + 1.6);
  const cardFadeDur = 0.55;
  let cardFadeStart = Math.max(EVENT_LAG_S + 0.4, cardFadeEnd - cardFadeDur);
  if (cardFadeStart >= cardFadeEnd) { cardFadeStart = EVENT_LAG_S + 0.4; cardFadeEnd = cardFadeStart + 0.3; }
  for (let i = 0; i < scorerPhotos.length; i++) {
    const P = scorerPhotos[i], d = _spDivs[i];
    // WALL-SECONDS-SINCE-GOAL feeding the card envelope. For a SCORED in-match penalty the goal
    // MOMENT is the RESOLVE inside its frozen beat (the kick lands), NOT the resumed-clock crossing —
    // wallSecondsSinceGoal only starts counting once the clock UNFREEZES, which made the pen card
    // appear LATE (post-flood). So key the pen card to the beat's OWN wall cursor with its origin at
    // the resolve, and continue that timeline into RESUME so the card runs through the SAME envelope
    // once (rise at the goal → hold → fade), never re-showing after the flood. Mirrors goalLanded's
    // pen branch. Non-pen goals + missed/saved pens are unchanged (missed pens have no card).
    let w;
    if (PENBEAT && !shootActive && penGoalTimes && penGoalTimes.has(P.t)) {
      const pb = penBeatFromWall(wallProgress);
      if (pb && pb.pen && pb.pen.t === P.t) {
        w = pb.localWall - PEN_CARD_ORIGIN_W;                     // inside the beat: origin at the HILL rise (card rises WITH the hill)
      } else if (P.t <= t) {
        const wr = wallSecondsSinceGoal(P.t, t);                 // beat over, clock resumed: continue the beat timeline
        w = (PEN_BEAT_WALL - PEN_CARD_ORIGIN_W) + (Number.isFinite(wr) ? Math.max(0, wr) : 0);
      } else {
        w = -1;                                                  // before the beat: card hidden
      }
    } else {
      w = wallSecondsSinceGoal(P.t, t);
    }
    let env = 0;
    if (Number.isFinite(w) && w >= EVENT_LAG_S && w < cardFadeEnd) {
      const rise = smoothstep(EVENT_LAG_S, EVENT_LAG_S + 0.35, w);
      const fall = w < cardFadeStart ? 1 : (1 - smoothstep(cardFadeStart, cardFadeEnd, w));
      env = rise * fall;
    }
    if (env < 0.06) { if (d.style.opacity !== '0') d.style.opacity = '0'; continue; }
    _spV3.set(worldX(P.u), 2.8, worldZ(P.v)).project(camera);
    if (_spV3.z > 1) { d.style.opacity = '0'; continue; }
    const sx = (_spV3.x * 0.5 + 0.5) * W, sy = (-_spV3.y * 0.5 + 0.5) * H;
    // anchor top-centre a touch BELOW the peak/name spot so photo + name don't overlap.
    d.style.transform = `translate(${sx.toFixed(1)}px, ${(sy + 10).toFixed(1)}px) translate(-50%, 0)`;
    const col = P.team === 'away' ? SEN_HEX : FRA_HEX;   // scoring team's kit colour (card accent)
    // 3rd-tier info line — "age · club" (age·club), one or the other alone, or empty → hide line.
    const infoParts = [];
    if (P.age != null) infoParts.push(`${P.age}`);
    if (P.club) infoParts.push(P.club);
    const infoStr = infoParts.join(' · ');
    const sig = P.src + '|' + P.surname + '|' + (P.age == null ? '' : P.age) + '|' + (P.club || '') + '|' + (P.shirtNo == null ? '' : P.shirtNo) + '|' + col;
    if (d._sig !== sig) {
      d.style.setProperty('--sp-col', col);
      const img = d.querySelector('img');
      if (img.getAttribute('src') !== P.src) {
        // PHOTO — one-shot PNG fallback if the optimized WebP fails to load (guarded: onerror is
        // cleared before retry so a broken PNG can't loop).
        img.onerror = () => { img.onerror = null; if (P.srcPng) img.src = P.srcPng; };
        img.src = P.src;
      }
      const nameEl = d.querySelector('.sp-name');
      nameEl.textContent = P.surname;
      d.querySelector('.sp-num').textContent = P.shirtNo != null ? `${P.shirtNo}` : '';   // white number on a filled team-colour badge
      d.querySelector('.sp-info').textContent = infoStr;                                   // 3rd tier, hidden if empty
      d.classList.toggle('no-info', infoStr === '');
      d.classList.toggle('no-num', P.shirtNo == null);
      _fitScorerName(d, nameEl);   // auto-shrink surname to the card width, ellipsis at the floor
      d._sig = sig;
    }
    d.style.opacity = String(clamp(env * 1.35, 0, 1));
  }
  for (let i = scorerPhotos.length; i < _spDivs.length; i++) _spDivs[i].style.opacity = '0';
}
// FLOATING SHOOTOUT-TAKER LABEL — the CURRENT pen kick raises a coloured hill (shootHillAt);
// float the taker's SURNAME on a small dark plate above that hill, projected to screen each
// frame like the xG / goal-scorer plates. Covers SCORED and MISSED kicks (incl. the decisive
// one) — it appears/fades with the hill's own rise→hold→recede envelope, so it never leads or
// lingers past its kick. Reuses the #xglabels host + .xglabel plate style.
let _shootLabel = null;
const _shootV3 = new THREE.Vector3();
function drawShootLabels() {
  const host = el('xglabels'); if (!host || !camera) return;
  if (!_shootLabel) {
    const d = document.createElement('div');
    d.className = 'xglabel penlabel';
    d.innerHTML = '<span class="xg-p"></span>';
    host.appendChild(d); _shootLabel = d;
  }
  const d = _shootLabel;
  const hill = (shootActive && shootoutOrder) ? shootHillAt() : null;
  const seq = hill ? shootoutSeq() : null;
  const kick = seq && seq.kick;
  if (!hill || !kick || !kick.player) { if (d.style.opacity !== '0') d.style.opacity = '0'; return; }
  const canvas = el('stage'); if (!canvas) { d.style.opacity = '0'; return; }
  const W = _cw, H = _ch;   // PERF — cached client box (see drawXgLabels)
  // project the hill spot, lifted just above the current crest (h is the live peak height).
  _shootV3.set(worldX(hill.u), (hill.h || 0) + 1.4, worldZ(hill.v)).project(camera);
  if (_shootV3.z > 1) { d.style.opacity = '0'; return; }
  const sx = (_shootV3.x * 0.5 + 0.5) * W, sy = (-_shootV3.y * 0.5 + 0.5) * H;
  d.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
  const surname = String(kick.player).split(' ').filter(Boolean).pop() || '';
  const sig = surname + '|' + (kick.scored ? 's' : 'm');
  if (d._sig !== sig) {
    d.querySelector('.xg-p').textContent = surname;
    d.classList.toggle('miss', !kick.scored);
    d._sig = sig;
  }
  // fade with the hill's own envelope (hill.tint 0..1), a touch boosted for legibility.
  d.style.opacity = String(clamp((hill.tint || 0) * 1.3, 0, 1));
}
// FLOATING IN-MATCH PEN-BEAT TAKER LABEL (PENBEAT) — mirrors drawShootLabels for the frozen
// in-match beat: floats the taker's SURNAME on a dark plate above the kicker-colour hill, so the
// mid-match penalty reads exactly like the post-match shootout. Pure function of wallProgress
// (penBeatFromWall/penBeatVisual) → fully scrub-safe; fades with the hill's own envelope so it
// never appears on the clean SETTLE/PAUSE stage and is gone by RESUME. Gated to PENBEAT and hidden
// during the shootout (which owns its own label). No taker name → no plate.
let _penLabel = null;
const _penV3 = new THREE.Vector3();
function drawPenBeatLabel() {
  const d0 = _penLabel;
  if (!PENBEAT || shootActive) { if (d0 && d0.style.opacity !== '0') d0.style.opacity = '0'; return; }
  const host = el('xglabels'); if (!host || !camera) return;
  const pb = penBeatFromWall(wallProgress);
  const v = pb ? penBeatVisual(pb) : null;
  // CARD-ONLY FOR SCORED PENS (2026-07-14) — a SCORED in-match penalty already gets the FULL scorer
  // CARD (drawScorerPhotos, with photo + name), so this small dark surname plate duplicated the name
  // (owner: Oyarzabal shown twice — a black pill THEN the card). Suppress the plate for scored pens
  // (card carries the name); KEEP it for MISSED/SAVED pens, which have NO card. Scoped to the pen
  // outcome — chance xG labels and open-play goal cards are untouched.
  if (pb && pb.pen && pb.pen.outcome === 'scored') { if (d0 && d0.style.opacity !== '0') d0.style.opacity = '0'; return; }
  const hill = v && v.hill;
  const player = pb && pb.pen && pb.pen.player;
  if (!_penLabel) {
    const d = document.createElement('div');
    d.className = 'xglabel penlabel';
    d.innerHTML = '<span class="xg-p"></span>';
    host.appendChild(d); _penLabel = d;
  }
  const d = _penLabel;
  if (!hill || !player || (hill.tint || 0) <= 0.001) { if (d.style.opacity !== '0') d.style.opacity = '0'; return; }
  const canvas = el('stage'); if (!canvas) { d.style.opacity = '0'; return; }
  const W = _cw, H = _ch;   // PERF — cached client box (see drawXgLabels)
  _penV3.set(worldX(hill.u), (hill.h || 0) + 1.4, worldZ(hill.v)).project(camera);
  if (_penV3.z > 1) { d.style.opacity = '0'; return; }
  const sx = (_penV3.x * 0.5 + 0.5) * W, sy = (-_penV3.y * 0.5 + 0.5) * H;
  d.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
  const surname = String(player).split(' ').filter(Boolean).pop() || '';
  const scored = pb.pen.outcome === 'scored';
  const sig = surname + '|' + (scored ? 's' : 'm');
  if (d._sig !== sig) {
    d.querySelector('.xg-p').textContent = surname;
    d.classList.toggle('miss', !scored);
    d._sig = sig;
  }
  d.style.opacity = String(clamp((hill.tint || 0) * 1.3, 0, 1));
}
let _camReadSig = '';
function updateCamReadout() {
  if (!controls) return;
  const host = el('camread'); if (!host) return;
  const az = THREE.MathUtils.radToDeg(controls.getAzimuthalAngle());
  const pol = THREE.MathUtils.radToDeg(controls.getPolarAngle());
  const dist = camera.position.distanceTo(controls.target);
  // PERF — change-gated: the dev camera read-out only writes the DOM when the value actually
  // changes (during static playback the camera is fixed → zero per-frame DOM writes).
  const s = `az ${az.toFixed(0)}° · pol ${pol.toFixed(0)}° · d ${dist.toFixed(1)}`;
  if (s !== _camReadSig) { host.textContent = s; _camReadSig = s; }
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
  if (!_cw || !_ch) {   // seed the cached #stage box if onResize hasn't run yet (defensive; onResize is the authority)
    const st = el('stage');
    _cw = (st && st.clientWidth) || window.innerWidth;
    _ch = (st && st.clientHeight) || window.innerHeight;
  }
  for (const c of [mkCanvas, plCanvas]) {
    if (!c) continue;
    const w = c.clientWidth || window.innerWidth;
    const h = c.clientHeight || (c === plCanvas ? 88 : 96);
    c.width = Math.round(w * _ovDpr); c.height = Math.round(h * _ovDpr);
  }
}
// current momentum-strip duration (last momentum minute, else match duration).
function pulseDuration() {
  // FULL match football span — the pulse axis AND the drag-scrubber must cover the WHOLE match
  // incl. extra time. FotMob momentum data often STOPS early (~83'), which must NOT cap the
  // timeline, or the ET goals (89', 99') become unreachable by the scrubber. Take the max of
  // the momentum end, the last event's football minute (_fmMax), and the full clock's minute.
  const momEnd = (momentum.length && Number.isFinite(momentum[momentum.length - 1].minute))
    ? momentum[momentum.length - 1].minute : 0;
  return Math.max(1, momEnd, _fmMax || 0, footballMinuteAt(teamMeta.duration || 0));
}
// Inverse of footballMinuteAt: given a FOOTBALL minute, the EXPANDED (engine) clock that lands
// on it. Used by the drag-scrubber (the pulse x-axis is football-minute-linear, but `clock` is
// expanded minutes). _fmTable {t:expanded, m:football} is monotonic in t; m non-decreasing.
function expandedOfFootballMinute(fm) {
  if (!_fmTable || !_fmTable.length) return fm;
  const target = clamp(fm, 0, _fmMax || fm);
  let lo = 0, hi = _fmTable.length - 1, ans = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (_fmTable[mid].m <= target) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  const a = _fmTable[ans], b = _fmTable[Math.min(ans + 1, _fmTable.length - 1)];
  if (b.t > a.t && b.m > a.m) return a.t + (b.t - a.t) * clamp((target - a.m) / (b.m - a.m), 0, 1);
  return a.t;
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
    mkCtx.fillText((g.label != null ? g.label : g.minute) + "'", cx, cy + 0.5 * dpr);
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
    mkCtx.fillText((c.label != null ? c.label : c.minute) + "'", cx0 - 5 * dpr, cy + 0.5 * dpr);
  }
}

// ---- STAGE13 — clean off-white seismograph (vB2 look) -----------------------
// A single centred waveform whose amplitude is the real per-minute momentum
// (|v| ∈ 0..1), NOT split into home/away fills — matching vB2's Direction-A pulse.
// The played portion (up to the playhead at the current clock) is bright off-white;
// the unplayed remainder is dim. TRANSPARENT background — no plate, no oscilloscope
// graticule/axis-cap. A subtle playhead cursor sits at the clock position.
// Static period-divider sets (see drawPulse) — hoisted so the per-frame draw reuses them
// instead of rebuilding object literals every frame.
const _PULSE_DIV_BASE = [{ m: 45, w: 'minor' }, { m: 90, w: 'major' }];
const _PULSE_DIV_ET = [{ m: 45, w: 'minor' }, { m: 90, w: 'major' }, { m: 105, w: 'minor' }, { m: 120, w: 'major' }];
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
    // PERF — stroke the trace by iterating momentum directly (was momentum.map(→{x,y}) + forEach,
    // which allocated an array of ~N point objects EVERY frame). Same path, zero per-frame allocation.
    plCtx.lineJoin = 'round'; plCtx.lineCap = 'round';
    plCtx.strokeStyle = 'rgba(233,231,244,0.85)'; plCtx.lineWidth = 1.6 * dpr;
    plCtx.beginPath();
    for (let i = 0; i < momentum.length; i++) {
      const d = momentum[i], px2 = xOf(d.minute), py2 = yOf(d.v);
      if (i) plCtx.lineTo(px2, py2); else plCtx.moveTo(px2, py2);
    }
    plCtx.stroke();
    plCtx.restore();
  }

  // EXTRA-TIME DIVIDER — NO minute numbers on the timeline (user-directed). Extra time is
  // marked by a SINGLE thin WHITE vertical line at 90' (the end of regular time), shown only
  // for matches that went to ET, and revealed once the playhead reaches it (never pre-announced).
  if (matchWentToET() && nowMin >= 90) {
    const mx = xOf(90);
    plCtx.strokeStyle = 'rgba(255,255,255,0.6)';
    plCtx.lineWidth = 1 * dpr; plCtx.setLineDash([]);
    plCtx.beginPath(); plCtx.moveTo(mx, padY * 0.2); plCtx.lineTo(mx, H - padY * 0.2); plCtx.stroke();
  }

  // ---- TIMELINE PERIOD DIVIDERS (PROD-DEFAULT) ------------------------------------------
  // Plain vertical LINES marking the period boundaries — NO dashes, NO text (owner-directed).
  // A clean WEIGHT hierarchy carries the meaning: a THICKER line ends a period (Full Time, and
  // the end of extra time), a THINNER line marks the mid-period break (Half Time, and the ET
  // half). Same reveal-as-played discipline as the ET divider above. Live for all visitors now
  // (was ?dev-gated — the owner asked for the clean half-time line back on the pulse). The HTML
  // icon layer is repositioned on the SAME axis afterwards.
  {
    // weight: 'major' = period END (thicker), 'minor' = mid-break (thinner). Static per match →
    // hoisted to module scope (was two object literals — up to 4 — allocated every frame).
    const dividers = matchWentToET() ? _PULSE_DIV_ET : _PULSE_DIV_BASE;
    plCtx.setLineDash([]);
    for (const d of dividers) {
      if (nowMin < d.m) continue;                 // reveal as played
      if (d.m > dur + 0.5) continue;              // off-axis guard
      const mx = xOf(d.m);
      const major = d.w === 'major';
      plCtx.strokeStyle = major ? 'rgba(233,231,244,0.50)' : 'rgba(233,231,244,0.55)';
      plCtx.lineWidth = (major ? 2.4 : 1.1) * dpr;
      plCtx.beginPath(); plCtx.moveTo(mx, padY * 0.2); plCtx.lineTo(mx, H - padY * 0.2); plCtx.stroke();
    }
  }
  // reposition the HTML event-marker overlay (goals / reds / subs) onto the SAME axis.
  // PROD-DEFAULT now (was inside the DEV block with the dev-only period dividers): the
  // markers are live for all visitors, while the period dividers above stay dev-only.
  if (CARD_PULSE) positionTimelineIcons(nowMin, xOf, H, dpr, t);

  // PLAYHEAD.
  plCtx.strokeStyle = 'rgba(233,231,244,0.6)'; plCtx.lineWidth = 1 * dpr;
  plCtx.beginPath(); plCtx.moveTo(px, padY * 0.3); plCtx.lineTo(px, H - padY * 0.3); plCtx.stroke();
  plCtx.beginPath(); plCtx.arc(px, mid, 4 * dpr, 0, Math.PI * 2);
  plCtx.fillStyle = '#ffffff'; plCtx.fill();
}
// #rrggbb + alpha → rgba() string.
// hexA() -> ./modules/util.js (imported at top)
// gated (loop) = throttle the pulse redraw to the field-recompute cadence while PLAYING (the
// playhead only advances with the clock, which tracks the field tick) — a per-frame canvas
// clear+redraw at 60Hz is pure overhead on a weak GPU. Paused / scrubbing / dev hooks pass no
// flag → always redraw so a manual seek is exact.
function drawOverlays(t, gated) { drawMarkers(t); if (!gated || !playing || _didFieldCompute) drawPulse(t); }

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

// ============================================================================
// DEV-ONLY — "HOW TO READ IT" TRANSPARENT ANNOTATION OVERLAY (behind ?dev).
// Wires the quiet underlined link near the clock to a full-viewport TRANSPARENT
// overlay that annotates the LIVE scene (leader-lines + labels + mini-legend). No
// modal, no scene dimming. Two interaction modes, chosen by the pointer/hover media
// query:
//   • DESKTOP (hover: hover, pointer: fine) — hover/focus the link fades the overlay
//     IN; leaving/blurring fades it OUT. No click-to-open.
//   • TOUCH (no hover) — tap the link TOGGLES the overlay; an X button and tap-outside
//     (on the overlay background) close it. A body.howtap class reveals the X + lets the
//     active overlay accept pointer events.
// Strictly DEV-gated (called only when DEV is true) so the live/prod view is unaffected.
// ============================================================================
// FIX 1 — the terrain plane is a u∈[0,1]×v∈[0,1] square; its four BASE corners in world space are
// (worldX(u), 0, worldZ(v)). Project them (plus the raised centre, which is the highest point of
// the mantle and can jut past a base corner on screen) through the ortho camera and take the
// min/max screen X of the projected silhouette. That is the terrain's on-screen horizontal extent —
// the label columns anchor to THIS, not the full-window canvas edges. Recomputed on overlay-open and
// on window resize so the columns FOLLOW the square as the viewport width changes.
const _howV3 = new THREE.Vector3();
// Project a world point (wx,wy,wz) to canvas pixels.
function _howProject(wx, wy, wz, W, H) {
  _howV3.set(wx, wy, wz).project(camera);
  return { x: (_howV3.x * 0.5 + 0.5) * W, y: (-_howV3.y * 0.5 + 0.5) * H };
}
// FIX 3 — the terrain plane is a u∈[0,1]×v∈[0,1] square whose four BASE corners in world space are
// (worldX(u), 0, worldZ(v)). We project those four corners AND expose them individually (not just the
// bbox), because the labels must sit in the DARK NEGATIVE SPACE between the tilted quad and its
// axis-aligned bounding box. We also return `up` — the screen-pixel delta of a +1 world-Y move — so a
// spike's lifted crest can be placed above its base (u,v). The ortho projection is affine, so any base
// (y=0) point maps to screen via exact BILINEAR interpolation of these four corners (see uvToScreen).
function projectTerrainExtent() {
  const canvas = el('stage');
  if (!canvas || !camera) return null;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  camera.updateMatrixWorld();
  const c00 = _howProject(worldX(0), 0, worldZ(0), W, H);   // home-front  (near touchline, left end)
  const c10 = _howProject(worldX(1), 0, worldZ(0), W, H);   // away-front
  const c01 = _howProject(worldX(0), 0, worldZ(1), W, H);   // home-back   (far touchline)
  const c11 = _howProject(worldX(1), 0, worldZ(1), W, H);   // away-back
  const o0 = _howProject(0, 0, 0, W, H), o1 = _howProject(0, 1, 0, W, H);
  const up = { x: o1.x - o0.x, y: o1.y - o0.y };             // px delta for +1 world-Y (spike lift)
  const xs = [c00.x, c10.x, c01.x, c11.x], ys = [c00.y, c10.y, c01.y, c11.y];
  return {
    W, H,
    left: Math.min(...xs), right: Math.max(...xs),
    top: Math.min(...ys), bottom: Math.max(...ys),
    corners: { c00, c10, c01, c11 }, up,
  };
}
// dev/verification hook — read the projected terrain quad (corners + bbox + up) without opening the overlay.
window.__howExtent = () => projectTerrainExtent();

// ── CLOCK ↔ SCORE cap-top alignment ─────────────────────────────────────────
// The top-right minute clock (.clock .t, 46px) and the big score digits (.score,
// 116px) share the mono font but differ in size, so their box-tops / baselines do
// NOT line up. We measure each glyph's INK cap-top offset (from its content-box top)
// via canvas font metrics and translateY the clock so its cap-top matches the score's
// cap-top. This replaces the old hand-tuned margin-top on .clock .t in the HTML.
let _capCanvas = null;
function capTopWithin(el) {
  // px offset from the element's content-box top down to the glyph ink cap-top,
  // for the element's current font. Both clock+score share the mono font so metrics align.
  const cs = getComputedStyle(el);
  const fs = parseFloat(cs.fontSize) || 16;
  let lh = cs.lineHeight;
  lh = (lh === 'normal') ? fs * 1.2 : parseFloat(lh);
  if (!_capCanvas) _capCanvas = document.createElement('canvas');
  const ctx = _capCanvas.getContext('2d');
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${fs}px ${cs.fontFamily}`;
  const m = ctx.measureText('0');
  const fbAsc = m.fontBoundingBoxAscent, fbDesc = m.fontBoundingBoxDescent;
  const abAsc = m.actualBoundingBoxAscent;
  const halfLeading = (lh - (fbAsc + fbDesc)) / 2;
  return halfLeading + (fbAsc - abAsc);
}
function alignClockToScore() {
  const score = document.getElementById('hScore');
  const hud = document.getElementById('hud13');
  const clockT = hud && hud.querySelector('.clock .t');
  if (!score || !clockT) return;
  // FIX 1 — the minute NUMBER (.t) and its HALF sublabel (.half) must travel TOGETHER by the same
  // dy so their vertical gap is preserved (previously only .t moved and .half overlapped it). The
  // dev "How to read it" link (.clock .howlink) stays put. Reset BOTH transforms before measuring so
  // the cap-top measurement of .t is taken from its natural position (this is what yields the 0px
  // alignment to the score digits).
  const clockHalf = hud.querySelector('.clock .half');
  const clockSound = hud.querySelector('.clock .soundtoggle');   // SOUND toggle rides with the number too
  clockT.style.transform = 'none';
  if (clockHalf) clockHalf.style.transform = 'none';
  if (clockSound) clockSound.style.transform = 'none';
  const sRect = score.getBoundingClientRect();
  const cRect = clockT.getBoundingClientRect();
  if (!sRect.height || !cRect.height) return;
  // CAPFOOT (VIDEO) SCALE — the video render scales .teams and .clock by 1.5 (transform-origin at
  // their top corner). getBoundingClientRect() reports VISUAL (post-scale) tops, but capTopWithin()
  // returns UNSCALED font-metric offsets and the translateY we set on .t lives INSIDE .clock's scaled
  // space. So we (a) multiply each element's cap-top offset by that element's effective vertical scale
  // to get the true VISUAL cap-top, and (b) convert the desired visual dy back into .clock's LOCAL
  // translate (÷ the clock's scale). On the LIVE site every scale is 1, so this reduces EXACTLY to the
  // previous math — the owner-approved live alignment is byte-for-byte unchanged.
  const sScale = effScaleY(score);
  const cScale = effScaleY(clockT);
  const scoreCapTop = sRect.top + capTopWithin(score) * sScale;
  const clockCapTop = cRect.top + capTopWithin(clockT) * cScale;
  const dyVisual = scoreCapTop - clockCapTop;
  const dyLocal = dyVisual / (cScale || 1);   // .t's transform is applied before the parent .clock scale
  const tf = `translateY(${dyLocal.toFixed(2)}px)`;
  clockT.style.transform = tf;
  if (clockHalf) clockHalf.style.transform = tf;   // half-label rides with the number, gap preserved
  if (clockSound) clockSound.style.transform = tf;   // SOUND toggle sits directly under the half, same dy
}
// Effective VERTICAL scale applied to `el` by any transformed ancestors (e.g. the capfoot .clock/.teams
// scale(1.5)), accumulated up to #hud13. Reads each computed transform matrix's vertical component (d),
// so it is exact and self-adjusting if the capfoot scale ever changes. Returns 1 when nothing is scaled
// (the live site) → alignClockToScore reduces to its original, owner-approved behaviour.
function effScaleY(el) {
  let s = 1, n = el;
  while (n && n.id !== 'hud13' && n !== document.body) {
    const t = getComputedStyle(n).transform;
    if (t && t !== 'none') {
      try { s *= (new DOMMatrixReadOnly(t)).d || 1; }
      catch (e) { /* unparseable transform → treat as no scale */ }
    }
    n = n.parentElement;
  }
  return s || 1;
}
// PERF GUARD — alignClockToScore does getBoundingClientRect + getComputedStyle + a canvas metric read,
// so it must NOT run every frame. It only matters when the score digits, the minute number, or the
// viewport size (mobile breakpoint) change. We cache a signature of those inputs and re-measure only
// when it changes. updateHud() calls alignClockIfNeeded() each frame (cheap: a string compare).
let _clockAlignSig = null;
function clockAlignSignature() {
  const h = document.getElementById('hScore'), a = document.getElementById('aScore');
  const c = document.getElementById('clk2');
  return (h ? h.textContent : '') + '|' + (a ? a.textContent : '') + '|' +
         (c ? c.textContent : '') + '|' + window.innerWidth + 'x' + window.innerHeight;
}
function alignClockIfNeeded() {
  const sig = clockAlignSignature();
  if (sig === _clockAlignSig) return;   // nothing that affects the alignment changed
  _clockAlignSig = sig;
  alignClockToScore();
}
// FORCED re-align on viewport resize (font sizes change at the mobile breakpoint) and once after web
// fonts settle (glyph metrics differ before the mono font loads). Clearing the cache forces a measure
// even when the score/clock text is unchanged (fonts.ready) — the signature alone would miss that.
window.addEventListener('resize', () => { _clockAlignSig = null; alignClockIfNeeded(); });
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => requestAnimationFrame(() => { _clockAlignSig = null; alignClockIfNeeded(); }));

// ── "HOW TO READ IT" overlay -> ./modules/howread.js (initHowRead factory, imported at top).
//    HOW_DESIGN + setupHowToRead + the ?howedit editor + the window.__howMeasure/__howDump dev
//    hooks all moved there VERBATIM; it self-wires its own overlay DOM (no render-state coupling).

// ============================================================================
// IN-PAGE CROWD AUDIO (Web Audio API, site-timed) — a per-match mp3 whose body maps
// LINEAR 1:1 to the playback `wallProgress`. Assets live at /audio/<id>.{json,mp3};
// MANY matches have none yet → the SOUND control stays HIDDEN. Sync contract (.json):
//     bufferPos == clamp(wallProgress,0,1) * bodyDurationS
// The mp3 is fetched fully + decoded ONCE, then a single AudioBufferSourceNode FREE-RUNS
// on the audio thread (glitch-free on mobile). We touch the audio only on discrete events.
// SOUND is ON by default; the AudioContext is resumed inside the first user gesture.
// ============================================================================
async function setupCrowdAudio(id) {
  const btn = el('soundToggle');
  if (btn) btn.hidden = true;
  _crowdCfg = null; _crowdOn = true; _crowdReady = false; _abuf = null; _crowdBytes = null;
  _crowdPlaying = false; _asrc = null; _crowdDesiredPrev = false; _crowdReseeks = 0; _aStartOffset = 0;
  try {
    const meta = await fetch('/audio/' + id + '.json').then((r) => (r.ok ? r.json() : null));
    if (!meta || !meta.files || !meta.files.mp3 || !(Number(meta.bodyDurationS) > 0)) return;   // no asset → control stays hidden
    _crowdCfg = meta;
    // ARM THE FIRST-GESTURE UNLOCK NOW — BEFORE the (large, slow) mp3 fetch. The AudioContext starts
    // 'suspended' under the autoplay policy and can ONLY be resumed inside a real user gesture; if we
    // wait until the mp3 has fully downloaded to arm the listener (and create the ctx), a tap/click that
    // lands DURING the download is never captured, the ctx is never resumed, and SOUND=ON plays silent
    // until the user manually toggles (whose own handler resumes the ctx). Arming here — as soon as the
    // JSON confirms audio EXISTS — closes that race; the gesture resumes the ctx while the mp3 loads, and
    // syncCrowdAudio()'s desired-edge starts the source the moment decode finishes.
    ensureAudioContext();                       // create the ctx (suspended is fine) so a gesture can resume it
    armFirstGestureAudio();                      // resume the AudioContext on the first page gesture (armed early)
    // FULLY FETCH the mp3 up front (ArrayBuffer) — nothing streams/buffers during playback.
    const resp = await fetch('/audio/' + meta.files.mp3);
    if (!resp.ok) return;   // mp3 404 → control stays hidden
    _crowdBytes = await resp.arrayBuffer();
    if (!_crowdBytes || _crowdBytes.byteLength < 256) return;   // truncated/bad → stay hidden
    _crowdReady = true;                         // bytes fully loaded → toggle may be shown
    decodeCrowdBytes();                          // decode up front (fire-and-forget; the gesture/edge starts playback)
    _crowdOn = true;
    if (btn) { btn.hidden = false; setSoundToggleUI(true); }   // reveal, SHOWN ON (default)
  } catch { /* no audio for this match → control stays hidden */ }
}

// Lazily create the AudioContext (+ a GainNode to the destination). Safe to call repeatedly.
function ensureAudioContext() {
  if (_actx) return _actx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    _actx = new AC();
    _again = _actx.createGain(); _again.gain.value = 1; _again.connect(_actx.destination);
  } catch { _actx = null; }
  return _actx;
}

// Decode the fetched bytes into an AudioBuffer ONCE (copy: decodeAudioData detaches its input).
async function decodeCrowdBytes() {
  if (_abuf || !_crowdBytes) return;
  if (!ensureAudioContext()) return;
  try {
    const bytes = _crowdBytes.slice(0);
    const buf = await new Promise((res, rej) => {
      let p; try { p = _actx.decodeAudioData(bytes, res, rej); } catch (e) { rej(e); return; }
      if (p && p.then) p.then(res).catch(rej);
    });
    _abuf = buf; _crowdBytes = null;   // decoded → free the compressed bytes
  } catch { /* decode failed — toggle stays visible but playback no-ops; harmless */ }
}

// Constant free-run playbackRate that keeps bufferPos == wallProgress*bodyDurationS with ZERO drift.
// d(wallProgress)/dt_real = speed/effTotal (see loop()), so target advances at speed*body/effTotal;
// the source must advance at exactly that. bodyDurationS == effTotal for EVERY match now (plain:
// effTotal==DRAMA_TOTAL_S==body; penalty: crowd_audio baked the freeze blocks so body==penWarp.
// totalWall==effTotal), so rate == base*speed == 1.0 at the default speed — no resample, natural pitch.
function crowdRate() {
  const c = _crowdCfg; if (!c) return 1;
  const body = Number(c.bodyDurationS) || dramaEffTotal;
  const effTotal = (penWarp ? penWarp.totalWall : dramaEffTotal) || body;
  const base = Number(c.baseSpeed) || 1;
  const spd = Number(cfg.speed) || 1;
  return base * spd * (body / effTotal);
}

// Current playback position within the decoded buffer (s). Uses the AUDIO-THREAD clock
// (_actx.currentTime) → immune to main-thread / rAF jank. Pure read, no side effects.
function crowdBufPos() {
  if (!_actx || !_crowdPlaying) return _aStartOffset;
  const dur = _abuf ? _abuf.duration : 0;
  return clamp(_aStartOffset + Math.max(0, _actx.currentTime - _aStartCtxTime) * _crowdRateCur, 0, dur || 1e9);
}

function crowdStopSource() {
  if (_asrc) {
    _aStartOffset = crowdBufPos();   // freeze position for a clean resume
    try { _asrc.onended = null; } catch {}
    try { _asrc.stop(); } catch {}
    try { _asrc.disconnect(); } catch {}
    _asrc = null;
  }
  _crowdPlaying = false;
}

// (Re)start a fresh source at buffer offset `offset` (s). This is the ONLY audio-touching op used
// for start / resume / scrub / rare drift re-sync — each is a single, instant, in-memory operation.
function crowdStartAt(offset) {
  if (!_actx || !_abuf) return;
  crowdStopSource();
  const dur = _abuf.duration;
  const off = clamp(offset, 0, Math.max(0, dur - 0.02));
  if (off >= dur - 0.02) { _aStartOffset = off; _crowdPlaying = false; return; }   // past end → silent
  let src;
  try {
    src = _actx.createBufferSource();
    src.buffer = _abuf;
    _crowdRateCur = crowdRate();
    src.playbackRate.value = _crowdRateCur;
    src.connect(_again || _actx.destination);
    src.onended = () => { if (_asrc === src) _crowdPlaying = false; };
    src.start(0, off);
  } catch { return; }
  _asrc = src;
  _aStartCtxTime = _actx.currentTime;
  _aStartOffset = off;
  _crowdPlaying = true;
  _crowdReseeks++;
}

// Called every frame from loop() — but CHEAP and EVENT-DRIVEN. It NEVER seeks or restarts per frame;
// it only reacts to discrete transitions (play/pause/toggle/ctx-resume edges, a scrub, a speed change,
// or a rare >0.75s drift). Between events the source free-runs untouched on the audio thread.
function syncCrowdAudio() {
  if (!_crowdCfg) return;
  if (!_actx || !_abuf) return;                  // not decoded yet → nothing to do
  const body = Number(_crowdCfg.bodyDurationS) || dramaEffTotal;
  const target = clamp(wallProgress, 0, 1) * body;
  const desired = playing && _crowdOn && _actx.state === 'running';

  // SCRUB detect — wallProgress jumped far more than a frame of playback could. (Scrub also sets
  // playing=false so it usually resolves via the pause→resume edges; this is a belt-and-suspenders.)
  const perFrameWp = (crowdRate() / (body || 1)) * 0.05;
  const scrubbed = Math.abs(wallProgress - _crowdWpPrev) > Math.max(0.03, perFrameWp * 6);
  _crowdWpPrev = wallProgress;

  if (desired && !_crowdDesiredPrev) {
    crowdStartAt(target);                     // START / RESUME / toggle-ON → one clean (re)start
  } else if (!desired && _crowdDesiredPrev) {
    crowdStopSource();                        // PAUSE / toggle-OFF → stop (offset frozen)
  } else if (desired && _crowdPlaying) {
    if (scrubbed) {
      crowdStartAt(target);                   // scrub while playing → single re-sync
    } else {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (now - _crowdLastDriftChk > 400) {   // throttled ~2.5×/s; a pure read unless it must correct
        _crowdLastDriftChk = now;
        const rate = crowdRate();
        if (Math.abs(_crowdRateCur - rate) > 1e-3 && _asrc) {
          // speed slider changed → adjust the live playback rate WITHOUT a restart (no click), and
          // re-anchor the position math so bufPos stays continuous across the change.
          const pos = crowdBufPos();
          try { _asrc.playbackRate.value = rate; } catch {}
          _aStartOffset = pos; _aStartCtxTime = _actx.currentTime; _crowdRateCur = rate;
        }
        if (Math.abs(crowdBufPos() - target) > 0.75) crowdStartAt(target);   // rare hard re-sync
      }
    }
  }
  _crowdDesiredPrev = desired;
  // Playback TRULY began (source running) → the first-gesture unlock has done its job; drop the
  // listeners. Keeping them armed until now (not at the raw ctx-resume) is what makes an early gesture
  // — one that arrived before the buffer decoded — still start audio when the buffer becomes ready.
  if (_crowdPlaying && typeof _audioGestureDisarm === 'function') _audioGestureDisarm();
}

// FIRST-GESTURE UNLOCK — SOUND is ON by default but the AudioContext can't start before a user
// gesture. Arm one-time document listeners (pointerdown/touchstart/click — also catches the Play
// button, whose click bubbles here). On the first gesture, resume the context (inside the gesture)
// and make sure decode is underway; syncCrowdAudio()'s desired-edge then starts the source in sync.
function armFirstGestureAudio() {
  if (_audioGestureArmed) return;
  _audioGestureArmed = true;
  const disarm = () => {
    _audioGestureArmed = false;
    _audioGestureDisarm = null;
    document.removeEventListener('pointerdown', tryStart, true);
    document.removeEventListener('touchstart', tryStart, true);
    document.removeEventListener('click', tryStart, true);
  };
  _audioGestureDisarm = disarm;                 // syncCrowdAudio() calls this once playback TRULY begins
  function tryStart() {
    if (!_crowdOn) { disarm(); return; }        // user turned SOUND off before any gesture
    if (!ensureAudioContext()) return;          // couldn't create → stay armed
    if (!_abuf && _crowdBytes) decodeCrowdBytes();   // make sure decode is underway (may not be ready yet)
    // Resume the ctx INSIDE this gesture (autoplay policy). We do NOT disarm here — that would drop the
    // listener while the buffer is still decoding (the first gesture can arrive before decode), leaving a
    // resumed-but-silent ctx with no retry. Instead the ctx now runs (sticky), and syncCrowdAudio()'s
    // desired-edge starts the source the moment the buffer is ready; it disarms us once _crowdPlaying is
    // truly true. Every further gesture until then simply re-resumes (idempotent) — belt & suspenders.
    try { const r = _actx.resume(); if (r && r.then) r.catch(() => {}); } catch {}
  }
  document.addEventListener('pointerdown', tryStart, true);
  document.addEventListener('touchstart', tryStart, true);
  document.addEventListener('click', tryStart, true);
}

// Reflect the SOUND toggle state in the UI: .on class (icon waves/slash + brightness), aria-pressed,
// and the second label line (ON / OFF). Single source of truth for the control's visual state.
function setSoundToggleUI(on) {
  const b = el('soundToggle'); if (!b) return;
  b.classList.toggle('on', !!on);
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  const st = el('soundState'); if (st) st.textContent = on ? 'ON' : 'OFF';
}
// dev/verification hooks — read-only sync snapshot + a manual resume (for headless tests).
window.__crowdSync = () => (!_crowdCfg) ? { hasAudio: false } : {
  hasAudio: !!_crowdReady, backend: 'webaudio', decoded: !!_abuf,
  on: _crowdOn, playing,
  ctxState: _actx ? _actx.state : null, audioPlaying: _crowdPlaying,
  bufPos: +crowdBufPos().toFixed(3), ctxTime: _actx ? +_actx.currentTime.toFixed(4) : null,
  wallProgress: +wallProgress.toFixed(4), bodyDurationS: _crowdCfg.bodyDurationS,
  target: +(clamp(wallProgress, 0, 1) * (Number(_crowdCfg.bodyDurationS) || dramaEffTotal)).toFixed(3),
  rate: +crowdRate().toFixed(4), rateCur: +(_crowdRateCur || 0).toFixed(4),
  reseeks: _crowdReseeks, bufDur: _abuf ? +_abuf.duration.toFixed(3) : null,
};
window.__crowdResume = () => {
  ensureAudioContext(); if (!_abuf && _crowdBytes) decodeCrowdBytes(); return _actx ? _actx.resume() : null;
};

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

  // SOUND toggle — the CLICK is the required user gesture that unlocks audio playback.
  // Starting audio.play() synchronously inside this handler satisfies the autoplay policy.
  const soundBtn = el('soundToggle');
  if (soundBtn) soundBtn.addEventListener('click', () => {
    if (!_crowdCfg || !_crowdReady) return;
    _crowdOn = !_crowdOn;
    setSoundToggleUI(_crowdOn);
    if (_crowdOn) {
      // this click is a user gesture → unlock playback; syncCrowdAudio()'s desired-edge (re)starts
      // at the live position on the next frame.
      ensureAudioContext();
      if (!_abuf && _crowdBytes) decodeCrowdBytes();
      if (_actx && _actx.state !== 'running') { try { _actx.resume(); } catch {} }
    }
    // turning OFF: syncCrowdAudio()'s edge stops the source (nothing to do here).
  });
  el('restart').addEventListener('click', () => {
    resetSettle();
    wallProgress = 0; _dramaCursor = 0; clock = matchT(0); playing = true; playBtn.textContent = '❚❚'; snapASmoothing();
  });
  el('clock').addEventListener('input', () => {
    // slider is WALL-PROGRESS 0..100 through the dramatic pass → warp to match-min.
    _lastInteract = performance.now();   // ADAPTIVE — exclude scrub-induced snap spikes from the frame-budget EMA
    resetSettle();
    wallProgress = clamp(+el('clock').value / 100, 0, 1);
    _dramaCursor = 0; clock = clockFromWall(wallProgress);
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
      const fMin = f * pulseDuration();                       // FOOTBALL minute under the cursor
      const min = clamp(expandedOfFootballMinute(fMin), 0, teamMeta.duration || fMin);  // → EXPANDED clock
      resetSettle(); clock = min; wallProgress = wallFromClock(min);
      _dramaCursor = 0; _ballCursor = 0; playing = false; snapASmoothing();
      // scrub to the very END of a penalty match → jump straight to the RESOLVED shootout (rings +
      // winner sky) so it's visible without playing the whole match through. (Play still runs the
      // full choreography.)
      if (f >= 0.99 && shootoutOrder && shootoutOrder.length) {
        clock = teamMeta.duration; wallProgress = 1; settle = 1; settling = false;
        shootActive = true; shootWall = 999; shootoutRevealed = shootoutOrder.length;   // fully resolved (all kicks)
      }
    };
    pw.addEventListener('pointerdown', (e) => { scrubbing = true; _lastInteract = performance.now(); try { pw.setPointerCapture(e.pointerId); } catch (_) {} seekTo(e.clientX); });
    pw.addEventListener('pointermove', (e) => { if (scrubbing) { _lastInteract = performance.now(); seekTo(e.clientX); } });
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
    { id: 'goalH', label: 'гол ▸ высота пика', min: 0, max: 10, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'goalHold', label: 'гол ▸ держать пик', min: 0, max: 4, step: 0.1, fmt: (v) => v.toFixed(1) + ' с' },
    { id: 'floodHold', label: 'гол ▸ держать заливку', min: 0, max: 8, step: 0.1, fmt: (v) => v.toFixed(1) + ' с', rebuildClock: true },
    { id: 'lull', label: 'гол ▸ пауза (штиль)', min: 0, max: 3, step: 0.1, fmt: (v) => v.toFixed(1) + ' с', rebuildClock: true },
    { id: 'goalReset', label: 'гол ▸ откат к центру', min: 0, max: 6, step: 0.1, fmt: (v) => v.toFixed(1) + ' с', rebuildClock: true },
    { id: 'goalPause', label: 'гол ▸ пауза после', min: 0, max: 4, step: 0.1, fmt: (v) => v.toFixed(1) + ' с', rebuildClock: true },
    { id: 'thrust', label: 'выпад ▸ сила', min: 0, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'thrustHold', label: 'выпад ▸ живучесть', min: 0.5, max: 12, step: 0.1, fmt: (v) => v.toFixed(1) + ' с' },
    { id: 'xgImp', label: 'xG ▸ вес во времени', min: 0, max: 3, step: 0.05, fmt: (v) => v.toFixed(2), rebuildClock: true },
    { id: 'streakK', label: 'xG ▸ эскалация серии', min: 0, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'dangerPush', label: 'опасность ▸ двигает территорию', min: 0, max: 4, step: 0.05, fmt: (v) => v.toFixed(2) },
    { id: 'penImp', label: 'прорыв ▸ вес во времени', min: 0, max: 3, step: 0.05, fmt: (v) => v.toFixed(2), rebuildClock: true },
    { id: 'penMin', label: 'прорыв ▸ порог (ниже=больше)', min: 0.02, max: 0.3, step: 0.01, fmt: (v) => v.toFixed(2), rebuildClock: true },
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
        // goal-timing knobs feed the baked dramatic-clock GOAL room (goalRoom) — rebuild it
        // so the post-goal dwell tracks the new envelope live.
        if (c.rebuildClock) { buildDramaticClock(); buildPenWarp(); }
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
  // PROD must stay CLEAN: the dev tuning controls (sliders/keys) call writeHash() to persist
  // cfg to the URL for shareable dev links, but on the LIVE site the shareable pages are the
  // canonical /m/<slug>/ URLs — a #cfg=<base64> tail would pollute every visitor's address bar
  // and ruin shared links. Only ever write the hash in DEV (?dev=1).
  if (!DEV) return;
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
