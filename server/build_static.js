// Assemble a STATIC export in dist/ for GitHub Pages (custom domain wc26.bogachev.fr).
//
// The app is otherwise served dynamically by server/index.js (/api/rich/{id},
// /api/timeline/{id}). GitHub Pages serves plain files, so we materialise those endpoints
// as extensionless JSON files (fetch(...).json() parses them regardless of content-type),
// alongside a full copy of public/. Deterministic; safe to re-run every night before deploy.
//
//   node server/build_static.js         →  dist/  (deployable to the gh-pages branch)

import { readFile, writeFile, mkdir, cp, rm, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const RICH = path.join(ROOT, 'data', 'rich');
const TL = path.join(ROOT, 'data', 'timeline');
// DIST defaults to ROOT/dist, but can be redirected via DIST_DIR — the nightly
// deploy builds into an OS-temp dir OUTSIDE the Mail.ru-synced project folder so
// Mail.ru Cloud can't hold a lock on dist/ and EBUSY the rebuild.
const DIST = process.env.DIST_DIR ? path.resolve(process.env.DIST_DIR) : path.join(ROOT, 'dist');

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

async function main() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  // 1) copy ONLY the public-launch files (not the dev stage2–12 / v1–v10 iterations).
  //    stage13.js imports ./claybattle.js; stage13.html links style.css; the pages fetch
  //    /matches.json + /api/* at runtime; three.js + fonts are CDN.
  const FILES = ['index.html', 'about.html', 'stage13.html', 'stage13.js', 'claybattle.js', 'style.css', 'matches.json', 'og-cover.png'];
  for (const f of FILES) {
    const src = path.join(PUBLIC, f);
    if (await exists(src)) await cp(src, path.join(DIST, f));
    else console.warn(`  (missing public/${f})`);
  }
  // per-match 3D essence thumbnails for the gallery cards
  const THUMBS = path.join(PUBLIC, 'thumbs');
  if (await exists(THUMBS)) await cp(THUMBS, path.join(DIST, 'thumbs'), { recursive: true });

  // 2) materialise /api/rich/{id} and /api/timeline/{id} (extensionless) for every match
  //    that has BOTH a rich record and a timeline (what stage13 fetches).
  await mkdir(path.join(DIST, 'api', 'rich'), { recursive: true });
  await mkdir(path.join(DIST, 'api', 'timeline'), { recursive: true });
  const ids = (await readdir(RICH)).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  let n = 0;
  for (const id of ids) {
    const rp = path.join(RICH, `${id}.json`);
    const tp = path.join(TL, `${id}.json`);
    if (!(await exists(tp))) continue;                 // need both to render
    await cp(rp, path.join(DIST, 'api', 'rich', id));       // extensionless
    await cp(tp, path.join(DIST, 'api', 'timeline', id));
    n++;
  }

  // 3) also expose the matches index at /api/matches (the gallery uses /matches.json which is
  //    already copied from public/, but keep this for parity with the dynamic server).
  const matches = path.join(PUBLIC, 'matches.json');
  if (await exists(matches)) { await mkdir(path.join(DIST, 'api'), { recursive: true }); await cp(matches, path.join(DIST, 'api', 'matches')); }

  // 4) GitHub Pages: custom domain + disable Jekyll (so /api paths + any _underscore files serve).
  await writeFile(path.join(DIST, 'CNAME'), 'wc26.bogachev.fr\n');
  await writeFile(path.join(DIST, '.nojekyll'), '');

  console.log(`dist/ built: public/ copied + ${n} matches × {rich,timeline} materialised under /api/`);
}
main().catch((e) => { console.error(e); process.exit(1); });
