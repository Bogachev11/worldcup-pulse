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
// flip at half-time. So we place teams on a SHARED pitch on OPPOSITE sides and
// KEEP those sides for the WHOLE match (no mid-match swap): home always uses its
// raw frame (attacks one way), away is always mirrored to the other side. The
// half-time break is rendered as a fade/rebuild in stage4, not a side swap.

export const HALFTIME = 45;            // match-minutes (rendered as a fade in stage4)

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
export function lerp(a, b, t) { return a + (b - a) * t; }

// Place a raw per-team coord (xn,yn in [0,1]) onto the shared pitch for a team.
// Base opposite-sides orientation, KEPT for the whole match (no half-time swap):
// home uses its raw frame, away is always mirrored to the other side. The `t`
// argument is retained for call-site compatibility but no longer used. {x,y}.
export function placeXY(xn, yn, team, t) {
  let X = xn, Y = yn;
  const flip = (team === 'away');       // away always mirrored; no half dependence
  if (flip) { X = 1 - X; Y = 1 - Y; }   // 180° to the opposite side
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
    // POSSESSION FLOOD (the tide) — a CONTIGUOUS field, not scattered splats.
    // fInt = flood intensity (relief height); fOwner accumulates per-team weight
    // so a cell can be re-owned as the tide washes back the other way.
    this.fInt = new Float32Array(n);     // flood intensity (height)
    this.fHome = new Float32Array(n);    // home flood weight
    this.fAway = new Float32Array(n);    // away flood weight
    // DUEL channel — sharp transient spikes, kept separate from possession swells.
    // dInt = spike intensity; dWin accumulates winner-weighted share (0=home..1=away)
    this.dInt = new Float32Array(n);     // intensity (height)
    this.dHome = new Float32Array(n);    // winner weight home
    this.dAway = new Float32Array(n);    // winner weight away
    // H1 MACRO — accumulated DOMINANCE field (real, slowly decaying). Every pass
    // adds to its cell for the acting team; LONG half-life → the WHOLE-match
    // territorial story (not the instant). mHome/mAway are the raw per-team
    // accumulators; mBlur is the heavily-smoothed signed net (away−home) swell
    // that the vertex shader displaces. NO procedural noise — only real deposits.
    this.mHome = new Float32Array(n);    // macro home presence (slow decay)
    this.mAway = new Float32Array(n);    // macro away presence (slow decay)
    this.mBlur = new Float32Array(n);    // blurred signed net swell (real macro relief)
    this._mTmp = new Float32Array(n);    // scratch for the separable blur
  }

  clear() {
    this.hHome.fill(0);
    this.hAway.fill(0);
    this.fInt.fill(0);
    this.fHome.fill(0);
    this.fAway.fill(0);
    this.dInt.fill(0);
    this.dHome.fill(0);
    this.dAway.fill(0);
    this.mHome.fill(0);
    this.mAway.fill(0);
    this.mBlur.fill(0);
    this._mTmp.fill(0);
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

  // ---- POSSESSION FLOOD / TIDE ---------------------------------------------
  // Fill a CONTIGUOUS corridor for `team` from its OWN side up to the ball's
  // current penetration `headX` (unit x, the furthest point the ball reached
  // toward the opponent goal), in a lateral band of half-width `halfW` (unit y)
  // around `ballY`. ownGoalX is the team's own goal x (0 or 1): the corridor is
  // the swath from ownGoalX to headX. `amp` is added per frame; the leading edge
  // is softened so the tide has a rolling front, not a hard wall.
  //   This is the connected swath "the space the ball has reached" — NOT blobs.
  floodCorridor(ownGoalX, headX, ballY, halfW, team, amp, edgeSoft) {
    const GX = this.GX, GY = this.GY;
    if (!Number.isFinite(headX) || !Number.isFinite(ballY)) return;
    const lo = Math.min(ownGoalX, headX);
    const hi = Math.max(ownGoalX, headX);
    const i0 = Math.max(0, Math.floor(lo * (GX - 1)));
    const i1 = Math.min(GX - 1, Math.ceil(hi * (GX - 1)));
    const cy = ballY * (GY - 1);
    const hwCells = Math.max(0.8, halfW * (GY - 1));
    const j0 = Math.max(0, Math.floor(cy - hwCells));
    const j1 = Math.min(GY - 1, Math.ceil(cy + hwCells));
    // leading-edge feather (in cells) so the front rolls in instead of snapping.
    // H2 SMOOTHNESS (edgeSoft 0..1) widens the feather: high = soft gradient
    // tide front, low = crisp wall. Defaults to 0.5-equivalent when omitted.
    const soft = Number.isFinite(edgeSoft) ? Math.max(0, edgeSoft) : 0.5;
    const edge = Math.max(1.0, (0.015 + 0.10 * soft) * (GX - 1));
    const headCell = headX * (GX - 1);
    const ownCell = ownGoalX * (GX - 1);
    const dirToHead = (headCell >= ownCell) ? 1 : -1;
    const fArr = team === 'away' ? this.fAway : this.fHome;
    for (let j = j0; j <= j1; j++) {
      const dy = (j - cy) / hwCells;
      // smooth lateral falloff (cosine-ish) → soft band edges, still contiguous
      const latLater = Math.max(0, 1 - dy * dy);
      const lat = latLater * latLater;
      if (lat <= 0) continue;
      for (let i = i0; i <= i1; i++) {
        // leading-edge softness: 1 well behind the front, ramps to ~0 at the head
        const ahead = dirToHead * (headCell - i);   // cells before reaching head
        const front = clamp(ahead / edge, 0, 1);     // 0 at/over head, 1 behind
        const w = amp * lat * (0.35 + 0.65 * front);
        if (!(w > 0)) continue;
        const k = j * GX + i;
        this.fInt[k] += w;
        fArr[k] += w;
      }
    }
  }

  // Decay the flood field with ASYMMETRIC per-team rates so the POSSESSOR's tide
  // lingers while the OTHER (stale counter-attack) flood recedes fast. keepHome /
  // keepAway are the per-team keep factors; fInt is rebuilt from the surviving
  // per-team weights so a cell's height follows whichever flood remains. When the
  // two keeps are equal this is identical to a uniform decay.
  floodDecay(keepHome, keepAway) {
    if (keepAway === undefined) keepAway = keepHome;     // back-compat: uniform
    const fi = this.fInt, fh = this.fHome, fa = this.fAway, n = fi.length;
    for (let k = 0; k < n; k++) {
      fh[k] *= keepHome;
      fa[k] *= keepAway;
      fi[k] = fh[k] + fa[k];     // rebuild intensity from surviving team weights
    }
  }

  // Clear ONLY the flood (tide) fields — used at the half-time break to wipe the
  // possession relief so the 2nd half rebuilds from a clean, even pitch.
  clearFlood() { this.fInt.fill(0); this.fHome.fill(0); this.fAway.fill(0); }

  // Flood total + away-share for a cell (drives possession relief + colour).
  floodTotal(k) { return this.fInt[k]; }
  floodShare(k) { const t = this.fHome[k] + this.fAway[k]; return t > 1e-6 ? this.fAway[k] / t : 0.5; }

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

  // ---- H1 MACRO — accumulated dominance field (REAL data only) -------------
  // Deposit one real event/pass for `team` at unit (x,y) into the COARSE macro
  // accumulator. Broad gaussian footprint (radius in CELLS) so the whole-match
  // territorial story builds as soft swells, not pin-points. amp is added per
  // event; the long-half-life decay (macroDecay) keeps the relief slow-moving.
  macroDeposit(x, y, team, amp, radiusCells) {
    const GX = this.GX, GY = this.GY;
    const cx = x * (GX - 1);
    const cy = y * (GY - 1);
    const r = Math.max(1, radiusCells);
    const i0 = Math.max(0, Math.floor(cx - r)), i1 = Math.min(GX - 1, Math.ceil(cx + r));
    const j0 = Math.max(0, Math.floor(cy - r)), j1 = Math.min(GY - 1, Math.ceil(cy + r));
    const inv2s2 = 1 / (2 * (r * 0.6) * (r * 0.6) + 1e-6);
    const arr = team === 'away' ? this.mAway : this.mHome;
    for (let j = j0; j <= j1; j++) {
      const dy = j - cy;
      for (let i = i0; i <= i1; i++) {
        const dx = i - cx;
        const g = Math.exp(-(dx * dx + dy * dy) * inv2s2);
        const add = amp * g;
        if (Number.isFinite(add)) arr[j * GX + i] += add;
      }
    }
  }

  // Decay the macro accumulators with a SLOW per-second keep (long half-life) so
  // the field represents the whole-match territory, not the instant.
  macroDecay(keep) {
    const mh = this.mHome, ma = this.mAway, n = mh.length;
    for (let k = 0; k < n; k++) { mh[k] *= keep; ma[k] *= keep; }
  }

  // Clear ONLY the macro accumulators (kept separate from flood; macro spans the
  // whole match and is NOT wiped at half-time, so this is only used on reset).
  clearMacro() { this.mHome.fill(0); this.mAway.fill(0); this.mBlur.fill(0); }

  // Build the heavily-BLURRED signed macro swell (away−home net) into mBlur.
  // Separable box blur of integer radius `rad` (in cells), `passes` repetitions
  // (a few box passes ≈ a wide gaussian → broad swells). Larger rad/passes =
  // smoother, broader relief. The result is the REAL macro relief the shader
  // displaces; +ve = away-leaning swell, −ve = home-leaning. No procedural noise.
  macroBlur(rad, passes) {
    const GX = this.GX, GY = this.GY, n = GX * GY;
    const src = this.mBlur, tmp = this._mTmp, mh = this.mHome, ma = this.mAway;
    // seed mBlur with the raw signed net (away − home)
    for (let k = 0; k < n; k++) src[k] = ma[k] - mh[k];
    const R = Math.max(0, Math.floor(rad));
    if (R === 0) return;
    const np = Math.max(1, Math.floor(passes));
    const win = 2 * R + 1;
    for (let p = 0; p < np; p++) {
      // horizontal box blur (rows) src → tmp
      for (let j = 0; j < GY; j++) {
        const row = j * GX;
        let acc = 0;
        for (let i = -R; i <= R; i++) acc += src[row + Math.min(GX - 1, Math.max(0, i))];
        for (let i = 0; i < GX; i++) {
          tmp[row + i] = acc / win;
          const iAdd = Math.min(GX - 1, i + R + 1);
          const iSub = Math.max(0, i - R);
          acc += src[row + iAdd] - src[row + iSub];
        }
      }
      // vertical box blur (cols) tmp → src
      for (let i = 0; i < GX; i++) {
        let acc = 0;
        for (let j = -R; j <= R; j++) acc += tmp[Math.min(GY - 1, Math.max(0, j)) * GX + i];
        for (let j = 0; j < GY; j++) {
          src[j * GX + i] = acc / win;
          const jAdd = Math.min(GY - 1, j + R + 1);
          const jSub = Math.max(0, j - R);
          acc += tmp[jAdd * GX + i] - tmp[jSub * GX + i];
        }
      }
    }
  }

  // Largest absolute macro-swell value (for normalising the shader displacement).
  macroAbsMax() {
    const b = this.mBlur, n = b.length; let m = 0;
    for (let k = 0; k < n; k++) { const v = Math.abs(b[k]); if (v > m) m = v; }
    return m;
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
