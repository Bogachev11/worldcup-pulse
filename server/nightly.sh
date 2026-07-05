#!/usr/bin/env bash
# nightly.sh — end-to-end NIGHTLY pipeline for World Cup Pulse.
#
# Discovers + harvests any newly-finished WC-2026 matches (GROUP and KNOCKOUT)
# from the last few days, rebuilds the derived data, commits it to the `dev`
# branch, and redeploys the static site to gh-pages (wc26.bogachev.fr).
#
# Design goals:
#   * FULLY AUTOMATIC — no human pastes a URL (see server/harvest_discover.py).
#   * FAIL-SOFT — one match (or even a whole stage) failing never aborts the run;
#     each stage is guarded so we always rebuild/redeploy whatever data we have.
#   * IDEMPOTENT — safe to re-run; already-harvested matches are skipped.
#   * NO SECRETS committed — push auth comes from the `gh` credential helper;
#     no token is ever written to a committed file or to .git/config.
#   * NEVER touches port 5280 (the dev server) — this script only reads/writes
#     files, git, and runs the deploy (which pushes to an isolated temp git).
#
# Schedule this daily (~04:30 local) via Windows Task Scheduler — see
# server/nightly_task.cmd / server/schedule_nightly.cmd.
#
# Run manually:  sh server/nightly.sh
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOG="$ROOT/server/nightly.log"
PY="D:/Python/python.exe"

# ---- logging helpers --------------------------------------------------------
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }
run() { # run a stage, log it, never let a failure abort the script
  local name="$1"; shift
  log ">>> $name"
  if "$@" >>"$LOG" 2>&1; then
    log "<<< $name OK"
    return 0
  else
    log "!!! $name FAILED (continuing)"
    return 1
  fi
}

log "===================== NIGHTLY RUN START ====================="
log "root=$ROOT node=$(node --version 2>/dev/null) py=$PY"

# ---- 1) discover + harvest new/finished matches -----------------------------
# Scan today + the previous 4 days so a match that goes final late (or a rerun
# that missed a day) is still caught. Fail-soft inside the script itself.
run "harvest (auto-discovery, last 4 days)" \
    "$PY" server/harvest_discover.py --days 4 || true

# ---- 2) rebuild derived data ------------------------------------------------
run "build_timeline"       node server/build_timeline.js       || true
run "build_matches_index"  node server/build_matches_index.js  || true

# ---- 3) commit new data to dev + push (gh cred helper; no embedded token) ---
commit_and_push() {
  git rev-parse --abbrev-ref HEAD >/dev/null 2>&1 || return 1
  # only stage the DATA we produced (never .git internals, never launch.json drift)
  git add data/rich data/raw data/timeline data/matches.json public/matches.json 2>/dev/null || true
  if git diff --cached --quiet 2>/dev/null; then
    echo "no data changes to commit"
    return 0
  fi
  # make sure we commit onto dev (create/switch if needed, non-fatal if already there)
  local br; br="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if [ "$br" != "dev" ]; then
    git checkout dev 2>/dev/null || git checkout -b dev || true
  fi
  git -c user.name="Alexander Bogachev" -c user.email="bogachev11@gmail.com" \
      commit -m "nightly: harvest WC-2026 matches $(date -u +%Y-%m-%d)" || return 1
  # push via origin (https) — auth provided by the gh credential helper
  git push origin dev
}
run "commit + push (dev)" commit_and_push || true

# ---- 4) rebuild dist + redeploy gh-pages → wc26.bogachev.fr ------------------
run "deploy (gh-pages)" sh server/deploy.sh || true

log "===================== NIGHTLY RUN END ======================="
echo "" >>"$LOG"
