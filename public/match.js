// match.js — MICRO view (the HERO). A single match drawn full-screen on a real
// pitch, all layers driven by real data, animated over a scrubbable match clock.
//
// Layers (back -> front):
//   1. pitch frame (faint lines)
//   2. territory / momentum membrane (soft additive field, tinted by momentum)
//   3. pass-flow tapestry — persistent network baked offscreen + live "recent"
//      passes glowing brightest (the informational core)
//   4. shot / xG blooms at real coords; goals pierce + leave scars
//   5. dense HUD (handled in app.js via DOM + the momentum curve)

import {
  clamp, rgbStr, prepareMatch, momAt, xgUpTo,
} from './lib.js';

export class MicroView {
  constructor(ctx) {
    this.ctx = ctx;
    this.prep = null;
    this.W = 0; this.H = 0; this.dpr = 1;
    this.clock = 0;        // current match-minute revealed
    this.playing = true;
    this.net = null;       // offscreen canvas of the persistent pass network
    this.netCtx = null;
    this.netUpTo = -1;     // last minute baked into the network
    this.pitchRect = null;
    this.recentWindow = 4; // minutes; newest passes animate live & glow
  }

  setMatch(rich) {
    this.prep = prepareMatch(rich);
    this.clock = 0;
    this.net = null;
    this.netUpTo = -1;
    this.playing = true;
    return this.prep;
  }

  // pitch rect inside the viewport (football aspect, centered, generous margins)
  layout(W, H, dpr) {
    this.W = W; this.H = H; this.dpr = dpr;
    const margX = W * 0.07, margY = H * 0.16;
    let pw = Math.max(10, W - margX * 2), ph = Math.max(10, H - margY * 2);
    const aspect = 1.55;
    if (pw / ph > aspect) pw = ph * aspect; else ph = pw / aspect;
    const px = (W - pw) / 2, py = (H - ph) / 2 + H * 0.01;
    this.pitchRect = { x: px, y: py, w: pw, h: ph };
    this.net = null; this.netUpTo = -1; // invalidate bake on resize
  }

  X(u) { const r = this.pitchRect; return r.x + u * r.w; }
  Y(u) { const r = this.pitchRect; return r.y + u * r.h; }

  setClock(min) {
    if (!this.prep) return;
    this.clock = clamp(min, 0, this.prep.duration);
    if (this.clock < this.netUpTo - 0.5) { this.net = null; this.netUpTo = -1; }
  }

  step(dtSec, speedMul) {
    if (!this.prep || !this.playing) return;
    this.clock += dtSec * (speedMul || 1);
    if (this.clock >= this.prep.duration) {
      this.clock = this.prep.duration;
      this.playing = false; // pause at full time
    }
  }

  // Build / extend the persistent network offscreen canvas up to settleBefore.
  ensureNetwork(settleBefore) {
    const r = this.pitchRect;
    if (!r || r.w <= 0 || r.h <= 0) return;
    const needW = Math.max(1, Math.round(r.w * this.dpr));
    const needH = Math.max(1, Math.round(r.h * this.dpr));
    if (!this.net || this.net.width !== needW || this.net.height !== needH) {
      this.net = document.createElement('canvas');
      this.net.width = needW; this.net.height = needH;
      this.netCtx = this.net.getContext('2d');
      this.netCtx.scale(this.dpr, this.dpr);
      this.netUpTo = -1;
    }
    if (settleBefore <= this.netUpTo + 0.001) return;
    const nctx = this.netCtx;
    nctx.globalCompositeOperation = 'lighter';
    nctx.lineCap = 'round';
    const home = this.prep.home.rgb, away = this.prep.away.rgb;
    for (const p of this.prep.passes) {
      if (p.minute <= this.netUpTo || p.minute > settleBefore) continue;
      const col = p.team === 'home' ? home : away;
      const x0 = p.x0 * r.w, y0 = p.y0 * r.h, x1 = p.x1 * r.w, y1 = p.y1 * r.h;
      nctx.strokeStyle = rgbStr(col, p.ok ? 0.085 : 0.035);
      nctx.lineWidth = p.ok ? 1.0 : 0.7;
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      const dx = x1 - x0, dy = y1 - y0;
      const cx = mx - dy * 0.12, cy = my + dx * 0.12;
      nctx.beginPath();
      nctx.moveTo(x0, y0);
      nctx.quadraticCurveTo(cx, cy, x1, y1);
      nctx.stroke();
    }
    this.netUpTo = settleBefore;
  }

  draw(opts = {}) {
    const ctx = this.ctx, r = this.pitchRect;
    if (!this.prep || !r) return;
    const t = this.clock;
    const showPass = opts.pass !== false;
    const showShot = opts.shot !== false;
    const showMom = opts.mom !== false;

    // 1. pitch frame
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.beginPath();
    ctx.moveTo(r.x + r.w / 2, r.y); ctx.lineTo(r.x + r.w / 2, r.y + r.h);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(r.x + r.w / 2, r.y + r.h / 2, r.h * 0.13, 0, Math.PI * 2);
    ctx.stroke();
    const bw = r.w * 0.16, bh = r.h * 0.46;
    ctx.strokeRect(r.x, r.y + (r.h - bh) / 2, bw, bh);
    ctx.strokeRect(r.x + r.w - bw, r.y + (r.h - bh) / 2, bw, bh);
    ctx.restore();

    // 2. momentum / territory membrane
    if (showMom) this.drawMembrane(t);

    // 3a. settled pass network (baked offscreen, blit)
    if (showPass) {
      const settleBefore = Math.max(0, t - this.recentWindow);
      this.ensureNetwork(settleBefore);
      if (this.net) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(this.net, r.x, r.y, r.w, r.h);
        ctx.restore();
      }
      // 3b. recent passes drawn live, glowing brightest
      this.drawRecentPasses(t, settleBefore);
    }

    // 4. shots / xG blooms
    if (showShot) this.drawShots(t);

    ctx.globalCompositeOperation = 'source-over';
  }

  drawMembrane(t) {
    const ctx = this.ctx, r = this.pitchRect;
    const home = this.prep.home.rgb, away = this.prep.away.rgb;
    ctx.save();
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    ctx.globalCompositeOperation = 'lighter';

    const v = momAt(this.prep.momentum, t);          // [-1,1], + = home pressing
    const frontU = clamp(0.5 + v * 0.40, 0.08, 0.92);
    const frontX = r.x + frontU * r.w;

    const gh = ctx.createLinearGradient(r.x, 0, frontX, 0);
    gh.addColorStop(0, rgbStr(home, 0.22));
    gh.addColorStop(0.7, rgbStr(home, 0.05));
    gh.addColorStop(1, rgbStr(home, 0));
    ctx.fillStyle = gh;
    ctx.fillRect(r.x, r.y, Math.max(0, frontX - r.x), r.h);

    const ga = ctx.createLinearGradient(r.x + r.w, 0, frontX, 0);
    ga.addColorStop(0, rgbStr(away, 0.22));
    ga.addColorStop(0.7, rgbStr(away, 0.05));
    ga.addColorStop(1, rgbStr(away, 0));
    ctx.fillStyle = ga;
    ctx.fillRect(frontX, r.y, Math.max(0, r.x + r.w - frontX), r.h);

    // luminous wavering membrane line
    ctx.beginPath();
    const detail = 40;
    for (let i = 0; i <= detail; i++) {
      const vy = i / detail;
      const vv = momAt(this.prep.momentum, t);
      const fx = r.x + clamp(0.5 + vv * 0.40, 0.08, 0.92) * r.w
        + Math.sin(vy * 9 + t * 0.4) * r.w * 0.012;
      if (i === 0) ctx.moveTo(fx, r.y + vy * r.h);
      else ctx.lineTo(fx, r.y + vy * r.h);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.30)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();
  }

  drawRecentPasses(t, settleBefore) {
    const ctx = this.ctx, r = this.pitchRect;
    const home = this.prep.home.rgb, away = this.prep.away.rgb;
    ctx.save();
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const p of this.prep.passes) {
      if (p.minute <= settleBefore || p.minute > t) continue;
      const age = clamp((t - p.minute) / this.recentWindow, 0, 1);
      const fresh = 1 - age;
      const col = p.team === 'home' ? home : away;
      const x0 = this.X(p.x0), y0 = this.Y(p.y0);
      const x1 = this.X(p.x1), y1 = this.Y(p.y1);
      const baseA = p.ok ? 0.6 : 0.28;
      const a = baseA * (0.18 + fresh * 0.82);
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      const dx = x1 - x0, dy = y1 - y0;
      const cx = mx - dy * 0.12, cy = my + dx * 0.12;
      ctx.strokeStyle = rgbStr(col, a);
      ctx.lineWidth = (p.ok ? 1.6 : 1.0) * (0.6 + fresh * 0.9);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(cx, cy, x1, y1);
      ctx.stroke();
      if (fresh > 0.5) {
        const hr = (1.5 + fresh * 3.5);
        const g = ctx.createRadialGradient(x1, y1, 0, x1, y1, hr);
        g.addColorStop(0, rgbStr(col, 0.9 * fresh));
        g.addColorStop(1, rgbStr(col, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x1, y1, hr, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  }

  drawShots(t) {
    const ctx = this.ctx, r = this.pitchRect;
    const home = this.prep.home.rgb, away = this.prep.away.rgb;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const sh of this.prep.shots) {
      if (sh.minute > t) continue;
      const col = sh.team === 'home' ? home : away;
      const cx = this.X(sh.x), cy = this.Y(sh.y);
      const age = clamp((t - sh.minute) / 6, 0, 1);
      const fresh = 1 - age;
      const baseR = (4 + sh.xg * 70) * (r.w / 1100 + 0.5);

      if (sh.isGoal) {
        const goalX = sh.team === 'home' ? r.x + r.w : r.x;
        const grad = ctx.createLinearGradient(cx, cy, goalX, cy);
        grad.addColorStop(0, `rgba(255,245,210,${0.55 + 0.4 * fresh})`);
        grad.addColorStop(1, 'rgba(255,245,210,0)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2 + fresh * 4;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(goalX, cy); ctx.stroke();
        const rr = baseR * (1.6 + fresh * 1.4);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
        g.addColorStop(0, `rgba(255,250,235,${0.5 + 0.45 * fresh})`);
        g.addColorStop(0.35, rgbStr(col, 0.5 + 0.3 * fresh));
        g.addColorStop(1, rgbStr(col, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.fill();
      } else {
        const rr = baseR * (1 + fresh * 0.6);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
        const peak = 0.25 + fresh * 0.5;
        g.addColorStop(0, rgbStr(col, peak));
        g.addColorStop(1, rgbStr(col, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.fill();
        if (sh.xgot > 0 && fresh > 0.05) {
          ctx.strokeStyle = rgbStr(col, 0.5 * fresh);
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(cx, cy, rr + (1 - fresh) * baseR * 2.2, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  hud() {
    const t = this.clock;
    const p = this.prep;
    // Progressive score from real timed goal-strikes (isGoal shots). Some
    // matches' shot feeds miss penalties/own-goals, so the OFFICIAL final score
    // (p.home.score / p.away.score) is authoritative; once the clock reaches
    // full time we snap to it so the HUD never contradicts the real result.
    let goalsH = p.shots.filter((s) => s.team === 'home' && s.isGoal && s.minute <= t).length;
    let goalsA = p.shots.filter((s) => s.team === 'away' && s.isGoal && s.minute <= t).length;
    const atFT = t >= p.duration - 0.01;
    if (atFT) {
      if (Number.isFinite(p.home.score)) goalsH = p.home.score;
      if (Number.isFinite(p.away.score)) goalsA = p.away.score;
    } else {
      if (Number.isFinite(p.home.score)) goalsH = Math.min(goalsH, p.home.score);
      if (Number.isFinite(p.away.score)) goalsA = Math.min(goalsA, p.away.score);
    }
    return {
      minute: t,
      scoreHome: goalsH, scoreAway: goalsA,
      xgHome: xgUpTo(p.shots, 'home', t),
      xgAway: xgUpTo(p.shots, 'away', t),
      passHome: p.passes.filter((q) => q.team === 'home' && q.minute <= t).length,
      passAway: p.passes.filter((q) => q.team === 'away' && q.minute <= t).length,
      momentum: momAt(p.momentum, t),
    };
  }
}
