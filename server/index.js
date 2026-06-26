// World Cup Pulse — Node HTTP server.
// Serves static frontend, proxies/normalizes ESPN data, computes momentum,
// and streams normalized STATE over Server-Sent Events. NO build step, no deps.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fetchScoreboard,
  fetchSummary,
  normalizeScoreboard,
  normalizeState,
} from './espn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');

// ---- config -----------------------------------------------------------------
// Port: env override, else read .claude/launch.json, else 5280.
function readLaunchPort() {
  try {
    const lj = path.join(ROOT, '.claude', 'launch.json');
    if (existsSync(lj)) {
      const j = JSON.parse(readFileSyncSafe(lj));
      if (j.port) return Number(j.port);
    }
  } catch { /* fall through */ }
  return 5280;
}
import { readFileSync } from 'node:fs';
function readFileSyncSafe(f) { return readFileSync(f, 'utf8'); }
const PORT = process.env.PORT ? Number(process.env.PORT) : readLaunchPort();
const POLL_MS = Number(process.env.POLL_MS || 15000);
const REPLAY_SPEED = Number(process.env.REPLAY_SPEED || 60); // 60x real time
const FORCE_REPLAY = process.env.REPLAY === '1';
const DEFAULT_REPLAY_MATCH = process.env.REPLAY_MATCH || '760415';

// ---- tiny caches ------------------------------------------------------------
let sbCache = { at: 0, data: null };
const SB_TTL = 30_000;

async function getScoreboard() {
  const now = Date.now();
  if (sbCache.data && now - sbCache.at < SB_TTL) return sbCache.data;
  const raw = await fetchScoreboard();
  const data = normalizeScoreboard(raw);
  sbCache = { at: now, data };
  return data;
}

// ---- match poller -----------------------------------------------------------
// One poller per active event id. Holds latest raw summary + replay clock and
// recomputes STATE on demand. SSE subscribers get a tick on each recompute.
class MatchPoller {
  constructor(eventId) {
    this.eventId = eventId;
    this.summary = null;
    this.scoreEntry = null;
    this.mode = 'live';
    this.subscribers = new Set(); // res objects
    this.timer = null;
    this.replayStartWall = null; // wall-clock ms when replay began
    this.lastState = null;
    this.fetchErr = null;
  }

  async start() {
    await this.refreshScoreEntry();
    await this.poll(); // initial fetch
    this.timer = setInterval(() => this.poll().catch(() => {}), POLL_MS);
    // Replay needs frequent ticks so motion is smooth as the virtual clock moves.
    this.tickTimer = setInterval(() => this.tick(), 1000);
  }

  async refreshScoreEntry() {
    try {
      const list = await getScoreboard();
      this.scoreEntry = list.find((m) => m.id === this.eventId) || null;
      if (this.scoreEntry) {
        const st = this.scoreEntry.state;
        if (FORCE_REPLAY || st === 'post') this.mode = 'replay';
        else if (st === 'in') this.mode = 'live';
        else this.mode = st; // 'pre'
      } else if (FORCE_REPLAY || this.eventId === DEFAULT_REPLAY_MATCH) {
        this.mode = 'replay';
      }
    } catch (e) {
      this.fetchErr = String(e);
    }
  }

  async poll() {
    try {
      this.summary = await fetchSummary(this.eventId);
      this.fetchErr = null;
    } catch (e) {
      this.fetchErr = String(e);
      return;
    }
    if (this.scoreEntry == null) await this.refreshScoreEntry();
    // Begin replay clock on first successful summary in replay mode.
    if (this.mode === 'replay' && this.replayStartWall == null) {
      this.replayStartWall = Date.now();
    }
    this.recomputeAndPush();
  }

  // virtual match-time (seconds) currently revealed
  virtualNow() {
    if (this.mode === 'replay') {
      if (this.replayStartWall == null) return 0;
      const elapsedWall = (Date.now() - this.replayStartWall) / 1000;
      return elapsedWall * REPLAY_SPEED;
    }
    if (this.mode === 'live') return Infinity; // reveal everything fetched
    return Infinity;
  }

  buildState() {
    if (!this.summary) return null;
    const modeLabel = this.mode === 'replay' ? 'replay'
      : this.mode === 'live' ? 'live'
      : this.mode === 'pre' ? 'pre' : 'post';
    const s = normalizeState(this.summary, this.scoreEntry, this.virtualNow(), modeLabel);
    this.lastState = s;
    return s;
  }

  recomputeAndPush() {
    const s = this.buildState();
    if (!s) return;
    this.broadcast(s);
  }

  // 1s tick — only meaningful in replay (virtual clock advances).
  tick() {
    if (this.mode !== 'replay') return;
    if (!this.summary) return;
    const s = this.buildState();
    if (s) this.broadcast(s);
  }

  broadcast(state) {
    const payload = `data: ${JSON.stringify(state)}\n\n`;
    for (const res of this.subscribers) {
      try { res.write(payload); } catch { this.subscribers.delete(res); }
    }
  }

  addSubscriber(res) {
    this.subscribers.add(res);
    if (this.lastState) {
      try { res.write(`data: ${JSON.stringify(this.lastState)}\n\n`); } catch {}
    }
  }

  removeSubscriber(res) {
    this.subscribers.delete(res);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.tickTimer) clearInterval(this.tickTimer);
  }
}

const pollers = new Map(); // eventId -> MatchPoller
async function getPoller(eventId) {
  let p = pollers.get(eventId);
  if (!p) {
    p = new MatchPoller(eventId);
    pollers.set(eventId, p);
    await p.start();
  }
  return p;
}

// ---- static file serving ----------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = decodeURIComponent(rel.split('?')[0]);
  const filePath = path.normalize(path.join(PUBLIC, rel));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}

function sendJson(res, obj, status = 200, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    ...extraHeaders,
  });
  res.end(body);
}

// Decide which match to default to: a live one, else the configured replay match.
async function resolveDefaultMatch(list) {
  const live = list.find((m) => m.state === 'in');
  if (live) return live.id;
  return DEFAULT_REPLAY_MATCH;
}

// ---- request router ---------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    // Harvested tournament index (per-match fingerprints). Served from disk.
    if (p === '/api/monument') {
      try {
        const buf = await readFile(path.join(DATA, 'monument.json'), 'utf8');
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=60',
        });
        res.end(buf);
      } catch {
        sendJson(res, { error: 'monument not found; run `node server/harvest.js`' }, 404);
      }
      return;
    }

    // Rich tournament index (real passes/shots/momentum harvest). From disk.
    if (p === '/api/rich') {
      try {
        const buf = await readFile(path.join(DATA, 'rich_index.json'), 'utf8');
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=60',
        });
        res.end(buf);
      } catch {
        sendJson(res, { error: 'rich index not found' }, 404);
      }
      return;
    }

    // Full per-match RICH record (passes/shots/momentum/events). From disk.
    if (p.startsWith('/api/rich/')) {
      const id = decodeURIComponent(p.slice('/api/rich/'.length)).replace(/[^0-9]/g, '');
      if (!id) { sendJson(res, { error: 'missing match id' }, 400); return; }
      try {
        const buf = await readFile(path.join(DATA, 'rich', `${id}.json`), 'utf8');
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=300',
        });
        res.end(buf);
      } catch {
        sendJson(res, { error: `rich match ${id} not found` }, 404);
      }
      return;
    }

    // Per-match REAL per-second event TIMELINE (built by build_timeline.js). From disk.
    if (p.startsWith('/api/timeline/')) {
      const id = decodeURIComponent(p.slice('/api/timeline/'.length)).replace(/[^0-9]/g, '');
      if (!id) { sendJson(res, { error: 'missing match id' }, 400); return; }
      try {
        const buf = await readFile(path.join(DATA, 'timeline', `${id}.json`), 'utf8');
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=300',
        });
        res.end(buf);
      } catch {
        sendJson(res, { error: `timeline match ${id} not found` }, 404);
      }
      return;
    }

    // Full per-match fingerprint record. Served from disk (404 if absent).
    if (p.startsWith('/api/match/')) {
      const id = decodeURIComponent(p.slice('/api/match/'.length)).replace(/[^0-9A-Za-z_-]/g, '');
      if (!id) { sendJson(res, { error: 'missing match id' }, 400); return; }
      try {
        const buf = await readFile(path.join(DATA, 'matches', `${id}.json`), 'utf8');
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=60',
        });
        res.end(buf);
      } catch {
        sendJson(res, { error: `match ${id} not found` }, 404);
      }
      return;
    }

    if (p === '/api/matches') {
      const list = await getScoreboard();
      const def = await resolveDefaultMatch(list);
      sendJson(res, { matches: list, defaultMatch: def }, 200,
        { 'cache-control': 'public, max-age=30' });
      return;
    }

    if (p === '/api/state') {
      const id = url.searchParams.get('event') || DEFAULT_REPLAY_MATCH;
      const poller = await getPoller(id);
      const state = poller.buildState();
      if (!state) {
        sendJson(res, { error: 'no data yet', detail: poller.fetchErr }, 503);
        return;
      }
      sendJson(res, state);
      return;
    }

    if (p === '/api/stream') {
      const id = url.searchParams.get('event') || DEFAULT_REPLAY_MATCH;
      const poller = await getPoller(id);
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      res.write(`retry: 3000\n\n`);
      poller.addSubscriber(res);
      const keepAlive = setInterval(() => {
        try { res.write(`: ping\n\n`); } catch {}
      }, 20000);
      req.on('close', () => {
        clearInterval(keepAlive);
        poller.removeSubscriber(res);
      });
      return;
    }

    // static
    await serveStatic(req, res, p);
  } catch (e) {
    sendJson(res, { error: String(e) }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`World Cup Pulse running at http://localhost:${PORT}`);
  console.log(`mode: poll=${POLL_MS}ms replaySpeed=${REPLAY_SPEED}x forceReplay=${FORCE_REPLAY} defaultReplayMatch=${DEFAULT_REPLAY_MATCH}`);
});
