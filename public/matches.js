// Match gallery — fetches matches.json, renders a grid of cards with a static
// fingerprint SVG per match. Clicking a card opens the cinematic viz.

import { fingerprintSVG } from './fingerprint.js';

const grid = document.getElementById('grid');
const statusEl = document.getElementById('status');

function fmtDate(iso) {
  try {
    const d = new Date(iso + 'T00:00:00Z');
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  } catch { return iso; }
}

function roundLabel(m) {
  if (m.round === 'group' || m.round == null) {
    return m.group ? `GROUP ${m.group}` : 'GROUP STAGE';
  }
  return String(m.round).toUpperCase();
}

function card(m) {
  const a = document.createElement('a');
  a.className = 'card';
  a.href = `stage7.html?id=${encodeURIComponent(m.id)}`;

  const hc = m.home.colorHex || '#6cf';
  const ac = m.away.colorHex || '#f96';

  a.innerHTML = `
    <div class="meta">
      <span class="date">${fmtDate(m.date)}</span>
      <span class="round">${roundLabel(m)}</span>
    </div>
    <div class="score">
      <span class="team home" style="--c:${hc}">
        <span class="dot"></span><span class="abbr">${m.home.abbr}</span>
      </span>
      <span class="nums"><b>${m.home.score}</b><span class="dash">–</span><b>${m.away.score}</b></span>
      <span class="team away" style="--c:${ac}">
        <span class="abbr">${m.away.abbr}</span><span class="dot"></span>
      </span>
    </div>
    <div class="fp">${fingerprintSVG(m, { w: 440, h: 150 })}</div>
    <div class="foot">
      <span class="xg"><span class="k">xG</span> <b style="color:${hc}">${m.xgHome.toFixed(2)}</b> · <b style="color:${ac}">${m.xgAway.toFixed(2)}</b></span>
      <span class="shots">${m.shotCount} shots${m.goals.length ? ` · ${m.goals.length} goals` : ''}</span>
    </div>
  `;
  return a;
}

async function main() {
  try {
    const res = await fetch('matches.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`matches.json ${res.status}`);
    const matches = await res.json();
    grid.innerHTML = '';
    for (const m of matches) grid.appendChild(card(m));
    statusEl.textContent = `${matches.length} matches`;
  } catch (e) {
    statusEl.textContent = `Failed to load matches: ${e.message}`;
    console.error(e);
  }
}

main();
