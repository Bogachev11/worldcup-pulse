// passfield.js — pure helpers for stage4 ("PASS LANDSCAPE").
// No three.js, no DOM. Normalizes the REAL pass stream into a unit-pitch frame
// and runs a decaying, splatting per-cell accumulation grid whose relief +
// colour track WHERE THE PLAY IS, by passes, per team.
//
// Coordinate frame: shared unit pitch x in [0,1] left->right (x=0 left goal,
// x=1 right goal), y in [0,1] top->bottom.
//
// IMPORTANT (verified): WhoScored pass coords are PER-TEAM NORMALISED — each
// team's (x,y) is in its OWN "attack toward x=100" frame and the data does NOT
// flip at half-time. So we place teams on a SHARED pitch and mirror the 2nd
// half ourselves: 1st half home attacks right / away left; at half-time they
// swap ends (like real football). See placeXY below.

export const HALFTIME = 45;            // match-minutes (end swap happens here)

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
export function lerp(a, b, t) { return a + (b - a) * t; }

// Place a raw per-team coord (xn,yn in [0,1]) onto the shared pitch for a team
// at match-minute t, applying the half-time 180° end swap. Returns {x,y}.
export function placeXY(xn, yn, team, t) {
  const secondHalf = t >= HALFTIME;
  let X = xn, Y = yn;
  const flip = (team === 'home') ? secondHalf : !secondHalf;
  if (flip) { X = 1 - X; Y = 1 - Y; }   // 180° end swap
  return { x: clamp(X, 0, 1), y: clamp(Y, 0, 1) };
}

// ---------------------------------------------------------------------------
// TURNOVER EVENTS — credit possession to the team that WON the ball. Used to
// nudge the smoothed possession signal so sustained pressure flips the colour
// but a single interception does not. Returns sorted [{t, team}] where `team`
// is the side that GAINED possession from this event.
//   Interception / BallRecovery / Tackle(Successful) → event.team gains
//   Dispossessed → OPPONENT of event.team gains (event.team lost the ball)
// ---------------------------------------------------------------------------
const OTHER = (team) => (team === 'away' ? 'home' : 'away');

export function normTurnovers(rawEvents) {
  const out = [];
  for (const e of (rawEvents || [])) {
    const type = e.type || e.eventType;
    if (!type) continue;
    const t = Number.isFinite(e.t) ? e.t : (Number(e.minute) || 0);
    const team = e.team === 'away' ? 'away' : 'home';
    let gainer = null;
    if (type === 'Interception' || type === 'BallRecovery') gainer = team;
    else if (type === 'Tackle') gainer = (e.outcome === 'Successful') ? team : OTHER(team);
    else if (type === 'Dispossessed') gainer = OTHER(team);
    if (!gainer) continue;
    out.push({ t, team: gainer });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// ---------------------------------------------------------------------------
// DUELS (единоборства) — sharp transient contests. Build a list with a WINNER:
//   Tackle / Aerial / Challenge / TakeOn → event.team if Successful, else OTHER
//   Dispossessed                         → OTHER(event.team)  (they lost it)
//   Interception (optional)              → event.team
// Location kept RAW per-team (xn,yn 0..1); placeXY applied at spawn time since
// the end-swap depends on t. Returns sorted [{t, xn, yn, team}].
// ---------------------------------------------------------------------------
const DUEL_TYPES = new Set(['Tackle', 'Aerial', 'Challenge', 'TakeOn', 'Dispossessed', 'Interception']);

export function buildDuels(rawEvents) {
  const out = [];
  for (const e of (rawEvents || [])) {
    const type = e.type || e.eventType;
    if (!type || !DUEL_TYPES.has(type)) continue;
    if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
    const t = Number.isFinite(e.t) ? e.t : (Number(e.minute) || 0);
    const team = e.team === 'away' ? 'away' : 'home';
    let winner;
    if (type === 'Dispossessed') winner = OTHER(team);
    else if (type === 'Interception') winner = team;
    else winner = (e.outcome === 'Successful') ? team : OTHER(team);
    out.push({
      t,
      xn: clamp(e.x / 100, 0, 1),
      yn: clamp(e.y / 100, 0, 1),
      team: winner,
    });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// Normalize the raw pass stream to the unit frame. Keeps RAW per-team start/end
// (xn/yn 0..1), team and precise time; the half-time placement transform is
// applied at deposit time (see placeXY) since it depends on t. Sorted ascending
// by t so we can advance a cursor each frame.
export function normPasses(rawPasses) {
  const out = [];
  for (const p of (rawPasses || [])) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const t = Number.isFinite(p.t) ? p.t : (Number(p.minute) || 0);
    out.push({
      t,
      xn: clamp(p.x / 100, 0, 1),
      yn: clamp(p.y / 100, 0, 1),
      exn: Number.isFinite(p.endX) ? clamp(p.endX / 100, 0, 1) : clamp(p.x / 100, 0, 1),
      eyn: Number.isFinite(p.endY) ? clamp(p.endY / 100, 0, 1) : clamp(p.y / 100, 0, 1),
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
    // DUEL channel — sharp transient spikes, kept separate from possession swells.
    // dInt = spike intensity; dWin accumulates winner-weighted share (0=home..1=away)
    this.dInt = new Float32Array(n);     // intensity (height)
    this.dHome = new Float32Array(n);    // winner weight home
    this.dAway = new Float32Array(n);    // winner weight away
  }

  clear() {
    this.hHome.fill(0);
    this.hAway.fill(0);
    this.dInt.fill(0);
    this.dHome.fill(0);
    this.dAway.fill(0);
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

  // Sharp, NARROW duel spike — much tighter falloff than splat() (≈1 cell core)
  // so it reads as a crisp spark, not a swell. amp = intensity; winner team
  // colours it. Kept on the separate duel channel.
  duelSplat(x, y, team, amp, radiusCells) {
    const GX = this.GX, GY = this.GY;
    const cx = x * (GX - 1);
    const cy = y * (GY - 1);
    const r = Math.max(0.6, radiusCells);          // very small core
    const i0 = Math.max(0, Math.floor(cx - r)), i1 = Math.min(GX - 1, Math.ceil(cx + r));
    const j0 = Math.max(0, Math.floor(cy - r)), j1 = Math.min(GY - 1, Math.ceil(cy + r));
    // tight gaussian: sigma ≈ 0.4·r so the spike is finer than possession relief
    const inv2s2 = 1 / (2 * (r * 0.4) * (r * 0.4) + 1e-6);
    const wArr = team === 'away' ? this.dAway : this.dHome;
    for (let j = j0; j <= j1; j++) {
      const dy = j - cy;
      for (let i = i0; i <= i1; i++) {
        const dx = i - cx;
        const g = Math.exp(-(dx * dx + dy * dy) * inv2s2);
        const k = j * GX + i;
        const add = amp * g;
        if (!Number.isFinite(add)) continue;
        this.dInt[k] += add;
        wArr[k] += add;
      }
    }
  }

  // Exponentially decay all cells toward 0. factor in (0,1], applied for this
  // many seconds: keep = exp(-rate * dt). Pass the precomputed keep directly.
  // Duels decay FASTER (their own keep) so sparks are brief.
  decay(keep, duelKeep) {
    const a = this.hHome, b = this.hAway, n = a.length;
    const di = this.dInt, dh = this.dHome, da = this.dAway;
    const dk = (duelKeep === undefined) ? keep : duelKeep;
    for (let k = 0; k < n; k++) {
      a[k] *= keep; b[k] *= keep;
      di[k] *= dk; dh[k] *= dk; da[k] *= dk;
    }
  }

  // Total (home+away) and away-share for a cell. Used to drive height + colour.
  total(k) { return this.hHome[k] + this.hAway[k]; }
  // Duel away-share for a cell (0=home winner .. 1=away winner).
  duelShare(k) { const t = this.dHome[k] + this.dAway[k]; return t > 1e-6 ? this.dAway[k] / t : 0.5; }
}

// Robust normalizer: tracks a running max so the relief auto-scales whatever the
// match traffic is, but eases the max down slowly so quiet stretches still flatten.
export class RunningMax {
  constructor(floor = 0.001) { this.m = floor; this.floor = floor; }
  observe(v) { if (v > this.m) this.m = v; }
  ease(dt) { this.m = Math.max(this.floor, this.m * Math.exp(-0.05 * dt)); }
  norm(v) { return v / this.m; }
}
