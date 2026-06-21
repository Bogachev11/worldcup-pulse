// massbattle.js — small pure helpers for stage3 ("COLLISION").
// Self-contained: no three.js, no DOM. Provides the VIVID palette derivation
// (the previous attempt looked dirty because it used raw dark team-kit hex;
// here we push saturation high and lift lightness so colors GLOW and bloom),
// plus a couple of tiny math utilities not exported by claybattle.js.

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---- RGB <-> HSL --------------------------------------------------------------
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  const d = max - min;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h, s, l };
}
function hue2rgb(p, q, t) {
  if (t < 0) t += 1; if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

// Take a team's kit color and produce a JUICY, BRIGHT version that survives
// ACES tone mapping and reads as emissive once bloom hits it. We keep the hue,
// slam saturation to ~targetSat, and raise lightness into the glowing band.
// If the kit color is near-grey (no hue), nudge toward a default vivid hue so it
// still pops instead of going muddy.
export function vivid(rgb, targetSat = 0.88, targetLight = 0.56, fallbackHue = 0.58) {
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  let h = hsl.h;
  if (hsl.s < 0.08) h = fallbackHue;          // grey kit → give it a hue
  const s = Math.max(targetSat, hsl.s * 0.4 + targetSat * 0.6);
  // bias lightness up but keep some of the original character
  const l = clamp(targetLight + (hsl.l - 0.5) * 0.25, 0.46, 0.68);
  return hslToRgb(h, clamp(s, 0, 1), l);
}

export const rgbCss = (c) => `rgb(${c.r | 0},${c.g | 0},${c.b | 0})`;
export const rgb01 = (c) => [c.r / 255, c.g / 255, c.b / 255];

// Gentle ease used for eruption rise/fall.
export function easeOut(x) { return 1 - Math.pow(1 - clamp(x, 0, 1), 3); }
