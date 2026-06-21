// monument.js — MACRO view. Lays every completed match out as one growing
// luminous organism: group-stage matches cluster by group, knockout rounds flow
// toward a central apex. A time scrubber reveals matches as of a chosen day so
// you watch the monument accrete. Hover → label, click → zoom to micro.

import { drawTerritory, hexToRgb, clamp, lerp, easeInOutCubic, hash01, momAt } from './lib.js';

const ROUND_ORDER = ['group', 'r32', 'r16', 'qf', 'sf', '3rd', 'final'];

export class MonumentView {
  constructor(ctx, getSize) {
    this.ctx = ctx;
    this.getSize = getSize;        // () => {W,H,DPR}
    this.tournament = null;
    this.matches = [];
    this.layout = [];              // [{m, cx, cy, w, h, rgbHome, rgbAway, ...}]
    this.threads = [];             // connective lines between shared-team matches
    this.dayIndex = 0;             // current scrubber day index
    this.revealProgress = 1;       // 0..1 fade-in for newly revealed cells
    this.hovered = null;
    this.mouse = { x: -1, y: -1 };
    this.onPick = null;            // callback(match) on click
    this.onHover = null;           // callback(match|null, screenX, screenY)
    this._t = 0;
  }

  setData(tournament, matches) {
    this.tournament = tournament;
    this.matches = (matches || []).slice().sort((a, b) => {
      const ra = ROUND_ORDER.indexOf(a.round), rb = ROUND_ORDER.indexOf(b.round);
      if (ra !== rb) return ra - rb;
      return String(a.day).localeCompare(String(b.day));
    });
    this.computeLayout();
  }

  dayList() { return this.tournament?.days || []; }

  // which matches are revealed at the current day index (inclusive)
  revealedDay() {
    const days = this.dayList();
    if (!days.length) return '9999-99-99';
    return days[clamp(this.dayIndex, 0, days.length - 1)];
  }
  isRevealed(m) { return String(m.day) <= this.revealedDay(); }

  // ---- layout: clusters by group; knockouts converge toward center ----
  computeLayout() {
    const { W, H } = this.getSize();
    this.layout = [];
    if (!this.matches.length) return;

    const group = this.matches.filter((m) => m.round === 'group');
    const knockout = this.matches.filter((m) => m.round !== 'group');

    // --- group stage: soft clustered grid of group blobs across the top 70% ---
    const groups = [...new Set(group.map((m) => m.group).filter(Boolean))].sort();
    const nG = Math.max(1, groups.length);
    const cols = Math.min(6, Math.ceil(Math.sqrt(nG * 1.6)));
    const rows = Math.ceil(nG / cols);
    const padX = W * 0.08, padTop = H * 0.16;
    const areaW = W - padX * 2, areaH = H * 0.62;
    const cellW = areaW / cols, cellH = areaH / Math.max(1, rows);

    groups.forEach((g, gi) => {
      const gc = gi % cols, gr = Math.floor(gi / cols);
      const gx = padX + gc * cellW + cellW / 2;
      const gy = padTop + gr * cellH + cellH / 2;
      const ms = group.filter((m) => m.group === g);
      // arrange a group's matches in a tight soft ring around the cluster center
      ms.forEach((m, i) => {
        const ang = (i / Math.max(1, ms.length)) * Math.PI * 2 + hash01(gi * 7 + 3) * 6;
        const rad = Math.min(cellW, cellH) * (0.10 + 0.16 * (ms.length > 1 ? 1 : 0));
        const jx = Math.cos(ang) * rad * (0.6 + hash01(i + gi) * 0.8);
        const jy = Math.sin(ang) * rad * (0.6 + hash01(i * 3 + gi) * 0.8);
        const cw = Math.min(cellW, cellH) * 0.58;
        const ch = cw * 0.62;
        this.layout.push(this._cell(m, gx + jx, gy + jy, cw, ch));
      });
    });

    // --- knockouts: converge toward the apex (bottom-center) by round ---
    const apexX = W * 0.5, apexY = H * 0.86;
    const ko = knockout.slice().sort(
      (a, b) => ROUND_ORDER.indexOf(a.round) - ROUND_ORDER.indexOf(b.round));
    const byRound = {};
    for (const m of ko) (byRound[m.round] ||= []).push(m);
    const koRounds = ROUND_ORDER.filter((r) => r !== 'group' && byRound[r]);
    const nR = Math.max(1, koRounds.length);
    koRounds.forEach((r, ri) => {
      const ms = byRound[r];
      // later rounds sit closer to apex and higher (toward center vertically)
      const tier = ri / nR;
      const ringR = lerp(W * 0.32, W * 0.05, tier);
      const yBase = lerp(H * 0.82, apexY, tier);
      ms.forEach((m, i) => {
        const spread = ms.length > 1 ? (i / (ms.length - 1) - 0.5) : 0;
        const cx = apexX + spread * ringR * 2;
        const cy = yBase - tier * H * 0.02 + hash01(ri * 5 + i) * 12 - 6;
        const cw = lerp(W * 0.07, W * 0.13, tier);
        const ch = cw * 0.62;
        this.layout.push(this._cell(m, cx, cy, cw, ch));
      });
    });

    this.computeThreads();
  }

  _cell(m, cx, cy, w, h) {
    return {
      m, cx, cy, w, h,
      rgbHome: hexToRgb(m.home?.colorHex),
      rgbAway: hexToRgb(m.away?.colorHex),
      // animated reveal scale (lerps 0→1 when the day arrives)
      appear: 0,
      glow: 0,
      // cached fingerprint bitmap (rendered once, blitted each frame)
      cache: null, cacheW: 0, cacheH: 0, cacheDPR: 0,
    };
  }

  // A cell's fingerprint is static, so render it ONCE into an offscreen canvas
  // and blit that bitmap every frame instead of re-running drawTerritory (with
  // its gradients + shadowBlur) for all cells at 60fps — the freeze culprit.
  _ensureCache(c) {
    const { DPR } = this.getSize();
    const cw = Math.max(2, Math.round(c.w));
    const ch = Math.max(2, Math.round(c.h));
    if (c.cache && c.cacheW === cw && c.cacheH === ch && c.cacheDPR === DPR) return;
    const oc = (c.cache && c.cache.getContext) ? c.cache : document.createElement('canvas');
    oc.width = Math.round(cw * DPR);
    oc.height = Math.round(ch * DPR);
    const octx = oc.getContext('2d');
    octx.setTransform(DPR, 0, 0, DPR, 0, 0);
    octx.clearRect(0, 0, cw, ch);
    drawTerritory(octx, 0, 0, cw, ch, {
      home: { rgb: c.rgbHome }, away: { rgb: c.rgbAway },
      fp: c.m.fingerprint,
      revealT: Infinity,
      intensity: 0.6,
      detail: 22,
      showFloor: true,
    });
    c.cache = oc; c.cacheW = cw; c.cacheH = ch; c.cacheDPR = DPR;
  }

  // faint connective threads between matches sharing a team (woven feel)
  computeThreads() {
    this.threads = [];
    const byTeam = {};
    for (const c of this.layout) {
      for (const ab of [c.m.home?.abbr, c.m.away?.abbr]) {
        if (!ab) continue;
        (byTeam[ab] ||= []).push(c);
      }
    }
    for (const ab in byTeam) {
      const cells = byTeam[ab];
      for (let i = 1; i < cells.length; i++) {
        this.threads.push({ a: cells[i - 1], b: cells[i], abbr: ab });
      }
    }
  }

  resize() { this.computeLayout(); }

  // hit-test (screen coords)
  pickAt(mx, my) {
    let best = null, bestD = Infinity;
    for (const c of this.layout) {
      if (c.appear < 0.4) continue;
      const dx = Math.abs(mx - c.cx), dy = Math.abs(my - c.cy);
      if (dx <= c.w / 2 && dy <= c.h / 2) {
        const d = dx + dy;
        if (d < bestD) { bestD = d; best = c; }
      }
    }
    return best;
  }

  setMouse(x, y) {
    this.mouse.x = x; this.mouse.y = y;
    const hit = (x < 0) ? null : this.pickAt(x, y);
    const hitM = hit?.m || null;
    if ((this.hovered?.m || null) !== hitM) {
      this.hovered = hit;
      if (this.onHover) this.onHover(hitM, hit ? hit.cx : x, hit ? hit.cy - hit.h / 2 : y);
    }
  }

  click(x, y) {
    const hit = this.pickAt(x, y);
    if (hit && this.onPick) this.onPick(hit.m);
  }

  setDayIndex(i) {
    this.dayIndex = clamp(i | 0, 0, Math.max(0, this.dayList().length - 1));
  }

  // ---- draw ----
  draw(dt, now, globalAlpha = 1) {
    const ctx = this.ctx;
    const { W, H } = this.getSize();
    this._t += dt;

    // veil fade for soft trails / bloom accumulation
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(4,5,10,${0.22})`;
    ctx.fillRect(0, 0, W, H);

    // vignette glow base
    const vg = ctx.createRadialGradient(W / 2, H * 0.5, 0, W / 2, H * 0.5, Math.max(W, H) * 0.7);
    vg.addColorStop(0, 'rgba(20,26,48,0.18)');
    vg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);

    ctx.globalAlpha = globalAlpha;

    // connective threads first (under cells)
    ctx.globalCompositeOperation = 'lighter';
    for (const th of this.threads) {
      const a = th.a, b = th.b;
      if (a.appear < 0.5 || b.appear < 0.5) continue;
      const al = 0.05 * Math.min(a.appear, b.appear);
      ctx.strokeStyle = `rgba(150,180,255,${al})`;
      ctx.lineWidth = 0.8;
      const mx = (a.cx + b.cx) / 2;
      const my = (a.cy + b.cy) / 2 - Math.abs(a.cx - b.cx) * 0.08;
      ctx.beginPath();
      ctx.moveTo(a.cx, a.cy);
      ctx.quadraticCurveTo(mx, my, b.cx, b.cy);
      ctx.stroke();
    }

    // cells
    for (const c of this.layout) {
      const revealed = this.isRevealed(c.m);
      const target = revealed ? 1 : 0;
      c.appear += (target - c.appear) * Math.min(1, dt * 2.4);
      if (c.appear < 0.01) continue;

      // hover glow lerp
      const isHover = this.hovered === c;
      c.glow += ((isHover ? 1 : 0) - c.glow) * Math.min(1, dt * 6);

      const ease = easeInOutCubic(clamp(c.appear, 0, 1));
      const w = c.w * (0.6 + 0.4 * ease);
      const h = c.h * (0.6 + 0.4 * ease);
      const x = c.cx - w / 2, y = c.cy - h / 2;

      ctx.save();
      ctx.globalAlpha = globalAlpha * ease;

      // blit the cached fingerprint (additive so cells bloom into one organism)
      this._ensureCache(c);
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(c.cache, x, y, w, h);
      // hover: brighten by blitting once more, scaled by glow
      if (c.glow > 0.02) {
        ctx.globalAlpha = globalAlpha * ease * c.glow * 0.7;
        ctx.drawImage(c.cache, x, y, w, h);
        ctx.globalAlpha = globalAlpha * ease;
      }

      // hover ring
      if (c.glow > 0.02) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = `rgba(255,255,255,${0.22 * c.glow})`;
        ctx.lineWidth = 1;
        ctx.shadowColor = 'rgba(255,255,255,0.5)';
        ctx.shadowBlur = 14 * c.glow;
        ctx.strokeRect(x - 3, y - 3, w + 6, h + 6);
        ctx.shadowBlur = 0;
      }

      // subtle score (low opacity)
      const sc = `${c.m.home?.score ?? 0}–${c.m.away?.score ?? 0}`;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = `rgba(255,255,255,${0.12 + 0.4 * c.glow})`;
      ctx.font = `${Math.max(8, h * 0.16)}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(sc, c.cx, y + h + 3);

      ctx.restore();
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}
