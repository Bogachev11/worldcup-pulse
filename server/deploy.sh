#!/usr/bin/env sh
# Rebuild the STATIC export (dist/) and deploy it to the gh-pages branch → wc26.bogachev.fr.
# Used by the nightly job after harvesting new matches. Needs `gh` authenticated (token) and
# `node`. Deploys from an isolated temp git (outside the Mail.ru-synced folder) so the drifty
# project .git is never involved in the push.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[deploy] building static export…"
# Build dist OUTSIDE the Mail.ru-synced project folder: Mail.ru Cloud holds a
# lock on the in-repo dist/ and EBUSYs the rmdir during rebuild. DIST_DIR points
# build_static.js at an OS-temp location we fully control.
DISTDIR="${TMPDIR:-/tmp}/wcp-dist"
rm -rf "$DISTDIR" 2>/dev/null || true
DIST_DIR="$DISTDIR" node server/build_static.js

TMP="${TMPDIR:-/tmp}/wcp-deploy"
rm -rf "$TMP"; mkdir -p "$TMP"
cp -r "$DISTDIR"/. "$TMP"/
cd "$TMP"
git init -q
git checkout -q -b gh-pages
git add -A
git -c user.name="Alexander Bogachev" -c user.email="bogachev11@gmail.com" \
    commit -qm "deploy $(date -u +%Y-%m-%dT%H:%MZ)"
git push -f "https://$(gh auth token)@github.com/Bogachev11/worldcup-pulse.git" gh-pages

echo "[deploy] done → https://wc26.bogachev.fr/"
