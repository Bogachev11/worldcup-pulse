// match.js — MICRO view. Full-screen replay of one match's Territory battle over
// its 90+ minutes. A virtual clock advances ~60x (scrubbable). Goals/reds/
// yellows/penalties fire as light-strikes/burns/cracks at their real minute.

import { drawTerritory, hexToRgb, clamp, lerp, momAt, matchDuration, rgbStr } from './lib.js';

export class MatchView {
  constructor(ctx, getSize) {
    this.ctx = ctx;
    this.getSize = getSize;
    this.match = null;
    this.rgbHome = { r: 90, g: 150, b: 255 };
    this.rgbAway = { r: 255, g: 120, b: 60 };
    this.duration = 95;            // match-minutes
    this.clock = 0;                // current match-minute (virtual)
    this.playing = true;
    this.speed = 60;               // 60x real time → 1 match-min ≈ 1 real-sec
    this.firedGoals = new Set();   // goal indices that already triggered a flash
    this.flashes = [];             // transient bloom flashes
    this.onClock = null;           // callback(clock, duration, score)
  }

  setMatch(m) {
    this.match = m;
    this.rgbHome = hexToRgb(m.home?.colorHex);
    this.rgbAway = hexToRgb(m.away?.colorHex);
    this.duration = matchDuration(m.fingerprint);
    this.clock = 0;
    this.playing = true;
    this.firedGoals.clear();
    this.flashes.length = 0;
  }

  setClock(min) {
    const c = clamp(min, 0, this.duration);
    // scrubbing backward should let goals re-fire if you pass them again
    if (c < this.clock) {
      for (const i of [...this.firedGoals]) {
        const g = this.match?.fingerprint?.goals?.[i];
        if (g && g.t > c) this.firedGoals.delete(i);
      }
    }
    this.clock = c;
  }

  scoreAt(t) {
    const fp = this.match?.fingerprint;
    let h = 0, a = 0;
    if (fp?.goals) for (const g of fp.goals) {
      if (g.t <= t) (g.team === 'home' ? h++ : a++);
    }
    return { h, a };
  }

  // bright transient flash when the clock crosses a goal minute
  triggerGoalFlashes() {
    const fp = this.match?.fingerprint;
    if (!fp?.goals) return;
    fp.goals.forEach((g, i) => {
      if (g.t <= this.clock && !this.firedGoals.has(i)) {
        this.firedGoals.add(i);
        const { W, H } = this.getSize();
        const v = momAt(fp.momentumSeries, g.t);
        const fx = (0.5 + clamp(v, -1, 1) * 0.42) * W;
        const fy = clamp(g.t / this.duration, 0, 1) * H;
        this.flashes.push({ x: fx, y: fy, born: performance.now(), dur: 1400 });
      }
    });
  }

  step(dt) {
    if (this.playing && this.match) {
      // advance virtual clock: speed multiplier over real seconds
      this.clock = clamp(this.clock + dt * (this.speed / 60), 0, this.duration);
      if (this.clock >= this.duration) this.playing = false;
    }
    this.triggerGoalFlashes();
  }

  draw(dt, now, globalAlpha = 1) {
    const ctx = this.ctx;
    const { W, H } = this.getSize();
    if (!this.match) return;

    this.step(dt);

    // dark veil for trails
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(4,5,10,0.28)';
    ctx.fillRect(0, 0, W, H);

    ctx.globalAlpha = globalAlpha;

    // big atmospheric base territory
    drawTerritory(ctx, 0, 0, W, H, {
      home: { rgb: this.rgbHome }, away: { rgb: this.rgbAway },
      fp: this.match.fingerprint,
      revealT: this.clock,
      intensity: 0.85,
      detail: 120,
      showFloor: true,
    });

    // current-clock horizontal sweep line (where "now" is on the time axis)
    const cy = clamp(this.clock / this.duration, 0, 1) * H;
    ctx.globalCompositeOperation = 'lighter';
    const sweep = ctx.createLinearGradient(0, cy - 30, 0, cy + 30);
    sweep.addColorStop(0, 'rgba(255,255,255,0)');
    sweep.addColorStop(0.5, 'rgba(255,255,255,0.10)');
    sweep.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sweep;
    ctx.fillRect(0, cy - 30, W, 60);

    // goal flashes
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      const p = (now - f.born) / f.dur;
      if (p >= 1) { this.flashes.splice(i, 1); continue; }
      const r = (0.05 + p * 0.55) * Math.max(W, H);
      const a = (1 - p) * 0.5;
      const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, r);
      g.addColorStop(0, `rgba(255,248,225,${a})`);
      g.addColorStop(0.5, `rgba(255,230,170,${a * 0.4})`);
      g.addColorStop(1, 'rgba(255,230,170,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(f.x, f.y, r, 0, Math.PI * 2); ctx.fill();
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    if (this.onClock) this.onClock(this.clock, this.duration, this.scoreAt(this.clock));
  }

  // thin momentum curve for the HUD canvas
  drawCurve(curveCtx, cw, ch) {
    curveCtx.clearRect(0, 0, cw, ch);
    const fp = this.match?.fingerprint;
    const series = fp?.momentumSeries || [];
    // zero line
    curveCtx.strokeStyle = 'rgba(255,255,255,0.12)';
    curveCtx.lineWidth = 1;
    curveCtx.beginPath();
    curveCtx.moveTo(0, ch / 2); curveCtx.lineTo(cw, ch / 2); curveCtx.stroke();
    if (series.length < 2) return;

    const dur = this.duration || 95;
    curveCtx.lineWidth = 1.6;
    curveCtx.beginPath();
    for (let i = 0; i < series.length; i++) {
      const x = (clamp(series[i].t / dur, 0, 1)) * cw;
      const v = clamp(series[i].v || 0, -1, 1);
      const y = ch / 2 - v * (ch / 2 - 3);
      if (i === 0) curveCtx.moveTo(x, y); else curveCtx.lineTo(x, y);
    }
    const lastV = momAt(series, this.clock);
    curveCtx.strokeStyle = lastV >= 0 ? rgbStr(this.rgbHome) : rgbStr(this.rgbAway);
    curveCtx.stroke();

    // playhead
    const px = clamp(this.clock / dur, 0, 1) * cw;
    curveCtx.strokeStyle = 'rgba(255,255,255,0.55)';
    curveCtx.lineWidth = 1;
    curveCtx.beginPath(); curveCtx.moveTo(px, 0); curveCtx.lineTo(px, ch); curveCtx.stroke();
  }
}
