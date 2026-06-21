// passfield.js — pure helpers for stage4 ("PASS LANDSCAPE").
// No three.js, no DOM. Normalizes the REAL pass stream into a unit-pitch frame
// and runs a decaying, splatting per-cell accumulation grid whose relief +
// colour track WHERE THE PLAY IS, by passes, per team.
//
// Coordinate frame (matches lib.js): x in [0,1] left->right, HOME goal at x=0,
// AWAY goal at x=1 (home attacks toward x=1). y in [0,1] top->bottom. Passes
// come from WhoScored in an ABSOLUTE pitch frame (0..100) so we map directly,
// no per-team mirror.

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
export function lerp(a, b, t) { return a + (b - a) * t; }

// Normalize the raw pass stream to the unit frame. Keeps start + end + team +
// precise time. Sorted ascending by t so we can advance a cursor each frame.
export function normPasses(rawPasses) {
  const out = [];
  for (const p of (rawPasses || [])) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const t = Number.isFinite(p.t) ? p.t : (Number(p.minute) || 0);
    out.push({
      t,
      x: clamp(p.x / 100, 0, 1),
      y: clamp(p.y / 100, 0, 1),
      ex: Number.isFinite(p.endX) ? clamp(p.endX / 100, 0, 1) : clamp(p.x / 100, 0, 1),
      ey: Number.isFinite(p.endY) ? clamp(p.endY / 100, 0, 1) : clamp(p.y / 100, 0, 1),
      team: p.team === 'away' ? 'away' : 'home',
    });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// A mutable grid of two decaying per-team accumulators. Cell (i along x = GX,
// j across y = GY). hHome/hAway store pass density that fades over time.
export class PassGrid {
  constructor(GX, GY) { this.reset(GX, GY); }

  reset(GX, GY) {
    this.GX = GX; this.GY = GY;
    const n = GX * GY;
    this.hHome = new Float32Array(n);
    this.hAway = new Float32Array(n);
  }

  clear() {
    this.hHome.fill(0);
    this.hAway.fill(0);
  }

  // Deposit a soft gaussian splat of `amp` for `team` centered at unit (x,y).
  // radius is in CELLS. Cheap: only touches a small neighborhood.
  splat(x, y, team, amp, radiusCells) {
    const GX = this.GX, GY = this.GY;
    const cx = x * (GX - 1);
    const cy = y * (GY - 1);
    const r = Math.max(1, radiusCells);
    const i0 = Math.max(0, Math.floor(cx - r)), i1 = Math.min(GX - 1, Math.ceil(cx + r));
    const j0 = Math.max(0, Math.floor(cy - r)), j1 = Math.min(GY - 1, Math.ceil(cy + r));
    const inv2s2 = 1 / (2 * (r * 0.6) * (r * 0.6) + 1e-6);
    const arr = team === 'away' ? this.hAway : this.hHome;
    for (let j = j0; j <= j1; j++) {
      const dy = j - cy;
      for (let i = i0; i <= i1; i++) {
        const dx = i - cx;
        const g = Math.exp(-(dx * dx + dy * dy) * inv2s2);
        arr[j * GX + i] += amp * g;
      }
    }
  }

  // Exponentially decay all cells toward 0. factor in (0,1], applied for this
  // many seconds: keep = exp(-rate * dt). Pass the precomputed keep directly.
  decay(keep) {
    const a = this.hHome, b = this.hAway, n = a.length;
    for (let k = 0; k < n; k++) { a[k] *= keep; b[k] *= keep; }
  }

  // Total (home+away) and away-share for a cell. Used to drive height + colour.
  total(k) { return this.hHome[k] + this.hAway[k]; }
}

// Robust normalizer: tracks a running max so the relief auto-scales whatever the
// match traffic is, but eases the max down slowly so quiet stretches still flatten.
export class RunningMax {
  constructor(floor = 0.001) { this.m = floor; this.floor = floor; }
  observe(v) { if (v > this.m) this.m = v; }
  ease(dt) { this.m = Math.max(this.floor, this.m * Math.exp(-0.05 * dt)); }
  norm(v) { return v / this.m; }
}
