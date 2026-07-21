// stage13 — RED-CARD LIGHTNING overlay. Extracted VERBATIM from stage13.js as a FACTORY
// (initLightning) during the module refactor. It OWNS its own full-viewport <canvas> (created
// lazily on the first strike) and has NO coupling to the render state beyond two injected
// accessors — so moving it out of the stage13 closure is a no-op. Dependencies
// (getCardEvents / wallSecondsSinceGoal) are passed in; clamp + the bolt geometry helpers
// (_seededRng / _boltPath / _strokePoly / _lightEnv) are imported directly. Does NOT import
// stage13.js — no circular dependency.
//
// The factory returns { update(t), size(), clear() }:
//   • update(t) — draw the bolt for the currently-active red card (clears when none is striking).
//   • size()    — re-size the backing store on resize (no-op until the canvas exists).
//   • clear()   — clear the overlay (used on the OG-neutral + penbeat-dark suppression paths).

import { clamp } from '../claybattle.js?v=1f97922a92';
import { _seededRng, _boltPath, _strokePoly, _lightEnv } from './util.js?v=1f97922a92';

const LIGHT_WALL = 0.5;          // wall-seconds a red-card lightning bolt lives

export function initLightning({ getCardEvents, wallSecondsSinceGoal }) {
  // ---- LIGHTNING OVERLAY ------------------------------------------------------
  // A full-viewport <canvas> above the composition, drawn only while a RED card is
  // mid-strike. Created lazily so it costs nothing until the first red.
  let _lightCanvas = null, _lightCtx = null, _lightDpr = 1;
  let _lightCSSW = 0, _lightCSSH = 0;
  function ensureLightningCanvas() {
    if (_lightCanvas) return _lightCanvas;
    const c = document.createElement('canvas');
    c.id = 'lightning';
    // Above the 3D scene + HUD, below the floating panel/back button. pointer-events off so
    // it never eats clicks; screen blend so the bolt reads as pure emitted light on the dark sky.
    // CSS width/height are pinned to 100vw/100vh so the (dpr-scaled) backing store maps 1:1 onto
    // the viewport — WITHOUT this a canvas keeps its intrinsic (2×) pixel size and overflows right.
    c.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:45;pointer-events:none;mix-blend-mode:screen;';
    document.body.appendChild(c);
    _lightCanvas = c; _lightCtx = c.getContext('2d');
    sizeLightningCanvas();
    return c;
  }
  function sizeLightningCanvas() {
    if (!_lightCanvas) return;
    _lightDpr = Math.min(window.devicePixelRatio || 1, 2);
    _lightCSSW = window.innerWidth; _lightCSSH = window.innerHeight;
    _lightCanvas.width = Math.round(_lightCSSW * _lightDpr);
    _lightCanvas.height = Math.round(_lightCSSH * _lightDpr);
  }
  // Clear the overlay (no-op until the canvas exists). Mirrors the inline
  // `if (_lightCtx && _lightCanvas && _lightCanvas.width) _lightCtx.clearRect(...)` guard.
  function clearLightning() {
    if (_lightCtx && _lightCanvas && _lightCanvas.width) _lightCtx.clearRect(0, 0, _lightCanvas.width, _lightCanvas.height);
  }
  // Lightning geometry helpers _seededRng / _boltPath / _strokePoly / _lightEnv
  // -> ./util.js (imported at top). Pure (args + Math + clamp only).
  // Draw the lightning for the currently-active red card (if any) at clock t. Clears the
  // canvas when nothing is striking. Deterministic in t (env + seeded shape) → scrub-safe.
  function updateLightning(t) {
    const cardEvents = getCardEvents();
    // find the strongest active RED strike + its phase.
    let bestP = -1, seedT = 0, env = 0;
    if (cardEvents && cardEvents.length) {
      for (const c of cardEvents) {
        if (!c.red) continue;
        const w = wallSecondsSinceGoal(c.t, t);
        if (!Number.isFinite(w) || w < 0 || w >= LIGHT_WALL) continue;
        const p = w / LIGHT_WALL;
        const e = _lightEnv(p);
        if (e > env) { env = e; bestP = p; seedT = c.t; }
      }
    }
    if (env <= 0.001) {              // nothing striking → make sure the overlay is clear/hidden
      if (_lightCtx && _lightCanvas && _lightCanvas.width) _lightCtx.clearRect(0, 0, _lightCanvas.width, _lightCanvas.height);
      return;
    }
    ensureLightningCanvas();
    if (_lightCSSW !== window.innerWidth || _lightCSSH !== window.innerHeight) sizeLightningCanvas();
    const ctx = _lightCtx, W = _lightCanvas.width, H = _lightCanvas.height;
    ctx.setTransform(_lightDpr, 0, 0, _lightDpr, 0, 0);
    const CW = _lightCSSW, CH = _lightCSSH;
    ctx.clearRect(0, 0, CW, CH);

    // seeded geometry — a main bolt from near the top down to ~mid-lower frame, plus forks.
    // Kept in a central band (0.30..0.70 of width) so it never clips off the edge and reads as
    // the composition's own strike, with a modest lateral drift between entry and strike point.
    const rng = _seededRng(seedT);
    const x0 = CW * (0.40 + 0.20 * rng());   // entry x, upper third — central band
    const y0 = -CH * 0.04;
    const drift = (rng() - 0.5) * 0.24;      // small lateral drift down the frame
    const x1 = clamp(x0 / CW + drift, 0.28, 0.72) * CW;   // strike x stays on-frame
    const y1 = CH * (0.60 + 0.16 * rng());
    const span = Math.hypot(x1 - x0, y1 - y0);
    const main = _boltPath(rng, x0, y0, x1, y1, 11, span * 0.13);

    // a brief full-frame brightness POP so the WHOLE scene reacts to the strike (screen blend).
    // RED discharge — the lift is warm/red-hot so it matches the red bolt (was cool blue).
    ctx.save();
    ctx.globalAlpha = clamp(env * 0.11, 0, 0.24);
    ctx.fillStyle = 'rgba(255,90,70,1)';         // red-hot electric lift
    ctx.fillRect(0, 0, CW, CH);
    ctx.globalAlpha = clamp(env * 0.06, 0, 0.16);
    ctx.fillStyle = 'rgba(255,180,150,1)';       // warm near-white bias so the flash reads searing
    ctx.fillRect(0, 0, CW, CH);
    ctx.restore();

    // the bolt — RED-HOT electric discharge, WIDER + more powerful. Four passes so the glow
    // has depth: deep-red bloom → saturated red → bright red-orange → white-hot pink-tinted core
    // (the near-white core is what makes it read as GLOWING red lightning, not a dull red line).
    const A = clamp(env, 0, 1);
    _strokePoly(ctx, main, 26, '#c40000', 0.42 * A, 48);   // outer deep-red bloom (wide, big glow)
    _strokePoly(ctx, main, 14, '#ff2a1e', 0.72 * A, 30);   // saturated red body
    _strokePoly(ctx, main, 6.5, '#ff6a55', 0.9 * A, 16);   // bright red-orange
    _strokePoly(ctx, main, 3.0, '#fff0ec', 1.0 * A, 9);    // white-hot core (faint pink tint)

    // 2–3 forks branching off interior nodes — also wider + red-hot, matching the trunk.
    const nForks = 2 + (rng() < 0.6 ? 1 : 0);
    for (let k = 0; k < nForks; k++) {
      const bi = 2 + Math.floor(rng() * (main.length - 4));
      const b = main[clamp(bi, 1, main.length - 2)];
      const fl = span * (0.16 + 0.18 * rng());
      const ang = (rng() < 0.5 ? -1 : 1) * (0.5 + 0.7 * rng());   // splay away from trunk
      const fx = clamp(b.x + Math.sin(ang) * fl, CW * 0.06, CW * 0.94);
      const fy = clamp(b.y + Math.cos(ang) * fl * 0.9 + fl * 0.3, 0, CH * 0.96);
      const fork = _boltPath(rng, b.x, b.y, fx, fy, 6, fl * 0.26);
      _strokePoly(ctx, fork, 13, '#c40000', 0.34 * A, 28);   // deep-red bloom
      _strokePoly(ctx, fork, 6, '#ff3a2a', 0.68 * A, 15);    // bright red
      _strokePoly(ctx, fork, 2.2, '#fff0ec', 0.92 * A, 7);   // white-hot core
    }
  }

  return { update: updateLightning, size: sizeLightningCanvas, clear: clearLightning };
}
