// stage8.js — "GOAL MOUTH": every goal as a soft glowing blob on the plane of the
// goal, placed by where it actually crossed the line. Real data only:
//   across = onGoalX (≈0..2, 1 = centre of goal)
//   height = onGoalY (0 = ground .. ~1 = crossbar)
//   colour = scoring team
// Default = ALL goals (aggregate, from goals.json). ?id={matchId} = one match.
// Pure canvas2D, additive blend so overlapping goals glow. Static-friendly.

const ID = new URLSearchParams(location.search).get('id');
const cv = document.getElementById('stage');
const ctx = cv.getContext('2d');
const el = (id) => document.getElementById(id);

let goals = [];   // [{x, y, c, xg, ...}]
let heading = '';

boot();

async function boot() {
  try {
    if (ID) {
      const m = await fetch('/api/rich/' + ID).then((r) => { if (!r.ok) throw new Error('api ' + r.status); return r.json(); });
      const hc = (m.home && m.home.colorHex) || '#6cf';
      const ac = (m.away && m.away.colorHex) || '#f96';
      goals = (m.shots || []).filter((s) => s.isGoal && Number.isFinite(s.onGoalX) && Number.isFinite(s.onGoalY))
        .map((s) => ({ x: s.onGoalX, y: s.onGoalY, c: s.team === 'home' ? hc : ac, xg: s.xg || 0, who: s.player || '', t: s.minute }));
      heading = `${m.home.abbr || 'HOME'} ${m.home.score}–${m.away.score} ${m.away.abbr || 'AWAY'}`;
    } else {
      goals = await fetch('goals.json', { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error('goals.json ' + r.status); return r.json(); });
      heading = `${goals.length} goals · ${new Set(goals.map((g) => g.m)).size} matches`;
    }
    el('sub').textContent = heading;
    window.addEventListener('resize', resize);
    resize();
  } catch (e) {
    el('sub').textContent = 'failed: ' + e.message;
    console.error(e);
  }
}

function hexToRgb(hex) {
  let h = (hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h || '66ccff', 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
// lift a colour so even dark team hues (e.g. navy) glow — scale so the brightest
// channel reaches ~210, keeping the hue.
function lift(rgb) {
  const m = Math.max(rgb[0], rgb[1], rgb[2], 1);
  const k = Math.min(2.4, 210 / m);
  return [Math.min(255, rgb[0] * k), Math.min(255, rgb[1] * k), Math.min(255, rgb[2] * k)];
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth, h = window.innerHeight;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  cv.style.width = w + 'px'; cv.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw(w, h);
}

// Goal mouth is 7.32m wide × 2.44m high → 3:1. Lay it out centred.
function draw(W, H) {
  ctx.clearRect(0, 0, W, H);
  // background gradient (subtle, darker at edges)
  const bg = ctx.createRadialGradient(W / 2, H * 0.52, H * 0.1, W / 2, H * 0.52, Math.max(W, H) * 0.75);
  bg.addColorStop(0, '#0a0e16'); bg.addColorStop(1, '#04050a');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  // goal frame rect (3:1), centred horizontally, sitting a touch below middle
  const goalW = Math.min(W * 0.74, (H * 0.62) * 3);
  const goalH = goalW / 3;
  const fx = (W - goalW) / 2;          // left post x
  const groundY = H * 0.5 + goalH * 0.62;  // ground line
  const topY = groundY - goalH;        // crossbar y

  // ground line + faint net
  drawFrame(fx, topY, goalW, goalH, groundY, W);

  // map a goal (onGoalX 0..2, onGoalY 0..~1) → canvas point
  const px = (gx) => fx + (gx / 2) * goalW;
  const py = (gy) => groundY - gy * goalH;

  // BLOBS — additive so overlaps build glowing colour fields
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const base = goalH * 0.16;
  for (const g of goals) {
    const x = px(g.x), y = py(g.y);
    const r = base * (0.7 + Math.min(1, g.xg || 0) * 1.5);
    const [rr, gg, bb] = lift(hexToRgb(g.c));
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(${rr},${gg},${bb},0.62)`);
    grad.addColorStop(0.35, `rgba(${rr},${gg},${bb},0.28)`);
    grad.addColorStop(1, `rgba(${rr},${gg},${bb},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  // bright cores on top (still additive) so each goal reads as a point
  for (const g of goals) {
    const x = px(g.x), y = py(g.y);
    const [rr, gg, bb] = lift(hexToRgb(g.c));
    ctx.fillStyle = `rgba(${Math.min(255, rr + 50)},${Math.min(255, gg + 50)},${Math.min(255, bb + 50)},0.55)`;
    ctx.beginPath(); ctx.arc(x, y, Math.max(1.5, base * 0.12), 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawFrame(fx, topY, goalW, goalH, groundY, W) {
  ctx.save();
  // faint net grid inside the goal
  ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
  const cells = 18;
  for (let i = 1; i < cells; i++) {
    const x = fx + (i / cells) * goalW;
    ctx.beginPath(); ctx.moveTo(x, topY); ctx.lineTo(x, groundY); ctx.stroke();
  }
  const rows = 6;
  for (let j = 1; j < rows; j++) {
    const y = topY + (j / rows) * goalH;
    ctx.beginPath(); ctx.moveTo(fx, y); ctx.lineTo(fx + goalW, y); ctx.stroke();
  }
  // ground line (full width, faint)
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, groundY); ctx.lineTo(W, groundY); ctx.stroke();
  // posts + crossbar (the frame)
  ctx.strokeStyle = 'rgba(235,240,250,0.55)'; ctx.lineWidth = 4; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(fx, groundY); ctx.lineTo(fx, topY);
  ctx.lineTo(fx + goalW, topY); ctx.lineTo(fx + goalW, groundY);
  ctx.stroke();
  ctx.restore();
}
