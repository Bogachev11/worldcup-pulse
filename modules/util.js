// stage13 — pure leaf helpers (math, colour strings, seeded RNG, lightning geometry).
// Extracted VERBATIM from stage13.js during the module refactor. Zero behaviour change:
// every function here depends only on its arguments (plus Math and the imported `clamp`),
// so moving it out of the stage13 closure is a no-op for the render.

import { clamp } from '../claybattle.js?v=1f97922a92';

// dt-aware exponential smoothing factor: fraction to move toward target this frame.
export function expA(dt, tau) {
  if (!(dt > 0)) return 0;
  if (!Number.isFinite(dt)) return 1;
  return 1 - Math.exp(-dt / Math.max(1e-3, tau));
}

// THREE.Color -> "r,g,b" (0..255) string for canvas fills.
export function _rgb(c) { return `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`; }

// "#rrggbb" | "#rgb" (+ alpha) -> "rgba(r,g,b,a)".
export function hexA(hex, a) {
  const h = (hex || '#888888').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// card colour: red sending-off vs yellow booking.
export function _cardCol(red) { return red ? '#ff3a2a' : '#ffd24a'; }

// LIFT a dark team colour so it reads on the dark pitch WITHOUT destroying identity.
//   • near-NEUTRAL dark (a black / dark-grey KIT — e.g. New Zealand's black) → kept clearly DARK,
//     only floored just off pure #000 to DARK_KIT so cloth relief + white pitch lines stay faintly
//     visible. It is NOT lifted to mid-grey — a white-vs-black match must read as white-vs-DARK
//     with strong luminance contrast, not white-vs-grey (that looked like the same team).
//   • SATURATED dark (dark green / navy) → the SAME hue raised in LIGHTNESS so it reads as its true
//     colour. Bright colours are untouched.
// The THREE namespace is passed in (util.js stays free of a `three` import); pure otherwise.
export const DARK_KIT = '#454c58';   // dark slate/charcoal — clearly a dark shirt that STANDS OFF the dark navy scene (not near-black → not lost in the background, not the old mid-grey)
export function _lift(THREE, hex) {
  const c = new THREE.Color(hex);
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  if (lum >= 0.34) return hex;                            // bright enough already
  const hsl = { h: 0, s: 0, l: 0 }; c.getHSL(hsl);
  if (hsl.s < 0.22) return DARK_KIT;                     // neutral/black kit → stay DARK, not grey
  c.setHSL(hsl.h, hsl.s, Math.max(hsl.l, 0.46));          // saturated dark → brighten, keep hue
  return '#' + c.getHexString();
}

// small deterministic PRNG seeded from a time value (mulberry32-ish). Same seed -> same
// stream, so a card's lightning bolt shape is identical across redraws.
export function _seededRng(seed) {
  let a = (Math.floor(seed * 1000) ^ 0x9e3779b9) >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Build one jagged polyline from (x0,y0) toward (x1,y1) with `segs` kinks; jitter ∝ span.
export function _boltPath(rng, x0, y0, x1, y1, segs, jitter) {
  const pts = [{ x: x0, y: y0 }];
  for (let i = 1; i < segs; i++) {
    const f = i / segs;
    const bx = x0 + (x1 - x0) * f, by = y0 + (y1 - y0) * f;
    pts.push({ x: bx + (rng() - 0.5) * jitter, y: by + (rng() - 0.5) * jitter * 0.5 });
  }
  pts.push({ x: x1, y: y1 });
  return pts;
}

export function _strokePoly(ctx, pts, w, col, alpha, blur) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.lineWidth = w; ctx.strokeStyle = col; ctx.globalAlpha = alpha;
  if (blur > 0) { ctx.shadowColor = col; ctx.shadowBlur = blur; }
  ctx.stroke();
  ctx.restore();
}

// Strobe envelope over the strike window: a hard first crack, then 2 quick after-flashes,
// the whole thing decaying. p in 0..1. Returns 0..1 brightness.
export function _lightEnv(p) {
  if (p < 0 || p > 1) return 0;
  // three flashes centred at 0.0, 0.30, 0.58 with fast rise/fall, amplitudes tapering.
  const flash = (c, amp, wdt) => { const d = Math.abs(p - c) / wdt; return d < 1 ? amp * (1 - d) * (1 - d) : 0; };
  const e = Math.max(flash(0.03, 1.0, 0.10), flash(0.30, 0.72, 0.09), flash(0.58, 0.5, 0.10));
  return clamp(e * (1 - 0.35 * p), 0, 1);   // slight overall decay
}
