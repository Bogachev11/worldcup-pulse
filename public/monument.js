// monument.js — MACRO view (the MONUMENT). All 36 matches as one growing
// organism. Each match = a cached luminous fingerprint encoding real pass-flow +
// momentum front + shot/xG marks in both team colors. Clustered by group into 12
// soft clusters; faint threads connect matches sharing a team. A day scrubber
// reveals matches as played (organism grows). Hover -> label, click -> zoom.
//
// PERF: each fingerprint is rendered ONCE into an offscreen canvas (DPR-aware)
// and blitted every frame. Passes are subsampled inside buildFingerprint. No
// per-frame shadowBlur. Rich match files are fetched lazily and cached.

import {
  clamp, lerp, easeOutCubic, rgbStr, hexToRgb, liftColor, hash01,
  prepareMatch, buildFingerprint,
} from './lib.js';

export class Monument {
  constructor(ctx) {
    this.ctx = ctx;
    this.W = 0; this.H = 0; this.dpr = 1;
    this.index = null;       // rich_index.json
    this.cells = [];         // {meta, cx,cy,r, fp(canvas|null), prep|null, fetching}
    this.days = [];          // sorted unique dates
    this.dayIdx = 0;         // scrubber position (reveal up to this day)
    this.playing = true;
    this.threads = [];       // {a,b} cell index pairs sharing a team
    this.hoverCell = null;
    this.fpSizeCss = 150;    // logical fingerprint resolution
    this.layoutDone = false;
    this.appear = new Map(); // cellIndex -> appear progress 0..1
  }

  async load() {
    const res = await fetch('/api/rich');
    if (!res.ok) throw new Error('rich index ' + res.status);
    this.index = await res.json();
    const matches = this.index.matches || [];
    // days
    this.days = [...new Set(matches.map((m) => m.date))].sort();
    this.dayIdx = this.days.length - 1; // start fully grown
    // cells
    this.cells = matches.map((m) => ({
      meta: m,
      cx: 0, cy: 0, r: this.fpSizeCss / 2,
      fp: null, prep: null, fetching: false,
      home: liftColor(hexToRgb(m.home?.colorHex)),
      away: liftColor(hexToRgb(m.away?.colorHex)),
    }));
    this.computeThreads();
    return this;
  }

  // connective threads: matches sharing a team abbr
  computeThreads() {
    this.threads = [];
    const byTeam = new Map();
    this.cells.forEach((c, i) => {
      for (const t of [c.meta.home?.abbr, c.meta.away?.abbr]) {
        if (!t) continue;
        if (!byTeam.has(t)) byTeam.set(t, []);
        byTeam.get(t).push(i);
      }
    });
    for (const idxs of byTeam.values()) {
      for (let i = 0; i < idxs.length; i++)
        for (let j = i + 1; j < idxs.length; j++)
          this.threads.push({ a: idxs[i], b: idxs[j] });
    }
  }

  layout(W, H, dpr) {
    this.W = W; this.H = H; this.dpr = dpr;
    if (!this.cells.length) return;
    // cluster by group A..L. Place 12 cluster centers on a soft organic ring.
    const groups = [...new Set(this.cells.map((c) => c.meta.group))]
      .filter(Boolean).sort();
    const gCount = groups.length || 1;
    const cxC = W / 2, cyC = H / 2;
    const ringR = Math.min(W, H) * 0.34;
    const centers = new Map();
    groups.forEach((g, gi) => {
      const ang = (gi / gCount) * Math.PI * 2 - Math.PI / 2;
      const jitter = (hash01(gi * 7.3) - 0.5) * ringR * 0.12;
      centers.set(g, {
        x: cxC + Math.cos(ang) * (ringR + jitter),
        y: cyC + Math.sin(ang) * (ringR + jitter),
        ang,
      });
    });

    // fingerprint cell size scales with viewport
    const fpCss = clamp(Math.min(W, H) * 0.11, 90, 170);
    this.fpSizeCss = fpCss;

    // place each cell around its cluster center
    const byGroup = new Map();
    this.cells.forEach((c) => {
      const g = c.meta.group || '?';
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(c);
    });
    for (const [g, arr] of byGroup) {
      const ctr = centers.get(g) || { x: cxC, y: cyC, ang: 0 };
      const n = arr.length;
      arr.forEach((c, i) => {
        c.r = fpCss / 2;
        if (n === 1) { c.cx = ctr.x; c.cy = ctr.y; return; }
        const a = (i / n) * Math.PI * 2 + ctr.ang;
        const spread = fpCss * (n <= 2 ? 0.62 : 0.78);
        c.cx = ctr.x + Math.cos(a) * spread;
        c.cy = ctr.y + Math.sin(a) * spread;
      });
    }
    // invalidate cached fingerprints if cell pixel size changed materially
    for (const c of this.cells) {
      if (c.fp && Math.abs(c.fp._cssSize - fpCss) > 1) c.fp = null;
    }
    this.layoutDone = true;
  }

  // is a cell revealed at the current scrubber day?
  revealedDay() { return this.days[clamp(this.dayIdx, 0, this.days.length - 1)]; }

  isRevealed(c) {
    return c.meta.date <= this.revealedDay();
  }

  // lazily fetch + build a fingerprint for a cell (once)
  async ensureFingerprint(c) {
    if (c.fp || c.fetching) return;
    c.fetching = true;
    try {
      const res = await fetch('/api/rich/' + c.meta.matchId);
      if (!res.ok) throw new Error('rich ' + res.status);
      const rich = await res.json();
      c.prep = prepareMatch(rich);
      const cv = buildFingerprint(c.prep, this.fpSizeCss, this.dpr, 1);
      cv._cssSize = this.fpSizeCss;
      c.fp = cv;
    } catch (e) {
      c.fetching = false; // allow retry
      return;
    }
    c.fetching = false;
  }

  step(dtSec) {
    // auto-advance the day scrubber
    if (this.playing && this.days.length > 1) {
      this._acc = (this._acc || 0) + dtSec;
      if (this._acc > 1.1) { // ~1.1s per day
        this._acc = 0;
        this.dayIdx++;
        if (this.dayIdx >= this.days.length) this.dayIdx = 0; // loop
      }
    }
    // appear animation per revealed cell
    this.cells.forEach((c, i) => {
      const target = this.isRevealed(c) ? 1 : 0;
      const cur = this.appear.get(i) ?? 0;
      const next = lerp(cur, target, clamp(dtSec * 3.2, 0, 1));
      this.appear.set(i, next);
    });
    // prefetch fingerprints for revealed cells (a few per frame to spread load)
    let budget = 2;
    for (const c of this.cells) {
      if (budget <= 0) break;
      if (this.isRevealed(c) && !c.fp && !c.fetching) { this.ensureFingerprint(c); budget--; }
    }
  }

  draw() {
    const ctx = this.ctx;
    if (!this.cells.length) return;

    // connective threads (faint), only between two revealed cells
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 0.6;
    for (const th of this.threads) {
      const a = this.cells[th.a], b = this.cells[th.b];
      const ap = this.appear.get(th.a) ?? 0, bp = this.appear.get(th.b) ?? 0;
      const vis = Math.min(ap, bp);
      if (vis < 0.05) continue;
      ctx.strokeStyle = `rgba(150,180,255,${0.035 * vis})`;
      ctx.beginPath();
      ctx.moveTo(a.cx, a.cy);
      const mx = (a.cx + b.cx) / 2, my = (a.cy + b.cy) / 2 - 18;
      ctx.quadraticCurveTo(mx, my, b.cx, b.cy);
      ctx.stroke();
    }
    ctx.restore();

    // fingerprints
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    this.cells.forEach((c, i) => {
      const ap = this.appear.get(i) ?? 0;
      if (ap < 0.02) return;
      const e = easeOutCubic(clamp(ap, 0, 1));
      const sz = this.fpSizeCss * (0.7 + 0.3 * e);
      const half = sz / 2;
      ctx.globalAlpha = e;
      if (c.fp) {
        ctx.drawImage(c.fp, c.cx - half, c.cy - half, sz, sz);
      } else {
        // placeholder soft glow while fetching
        const g = ctx.createRadialGradient(c.cx, c.cy, 0, c.cx, c.cy, half);
        g.addColorStop(0, rgbStr(c.home, 0.10 * e));
        g.addColorStop(1, rgbStr(c.home, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(c.cx, c.cy, half, 0, Math.PI * 2); ctx.fill();
      }
      // hover ring
      if (this.hoverCell === c) {
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(c.cx, c.cy, half * 0.96, 0, Math.PI * 2); ctx.stroke();
        ctx.globalCompositeOperation = 'lighter';
      }
    });
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // hit-test for hover/click (nearest cell within its radius)
  pick(mx, my) {
    let best = null, bestD = Infinity;
    for (const c of this.cells) {
      if ((this.appear.get(this.cells.indexOf(c)) ?? 0) < 0.4) continue;
      const d = Math.hypot(mx - c.cx, my - c.cy);
      if (d < this.fpSizeCss * 0.5 && d < bestD) { bestD = d; best = c; }
    }
    return best;
  }
}
