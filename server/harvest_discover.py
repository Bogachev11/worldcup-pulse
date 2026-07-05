#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
harvest_discover.py - FULLY AUTOMATIC discovery + harvest of finished FIFA
World Cup 2026 matches (GROUP and KNOCKOUT) for a rolling DATE WINDOW.

Why this exists
---------------
`harvest_rich.py` enumerates only the 12 WhoScored GROUP-stage fixtures pages,
so knockout games are never found there. `harvest_one.py` can fetch a single
knockout game but needs a WhoScored URL pasted by a human. This script removes
the human: it uses FotMob (which lists ALL WC matches — group AND knockout — by
date) as the source of truth, then resolves each match's WhoScored URL
automatically, falling back to a FotMob-only rich record when WhoScored can't be
resolved (so the match still appears with score + shots + momentum).

Discovery pipeline (per run)
----------------------------
 1. FotMob: list finished WC matches for every date in the window
    (default: today and the previous 3 days).
 2. WhoScored: build an anchor POOL from the season landing page (current +
    recent knockout matchday) PLUS all 12 group-stage fixtures pages. Index each
    /matches/{id}/ anchor by its normalised team-pair (the slug carries both
    team names, e.g. ...-brazil-japan).
 3. For each finished FotMob match NOT already harvested (idempotent — checked
    by normalised team-pair against existing data/rich/*.json):
      a. If the team-pair resolves to a WhoScored anchor -> full harvest
         (WhoScored passes/events + FotMob shots/momentum), reusing
         harvest_rich's proven logic.
      b. Else -> FotMob-only rich record (score + shots + momentum, no pass
         geometry), written under data/rich/fm_{fotmobId}.json.

Fail-soft: one match failing never aborts the run. Safe to re-run.

Run:
  D:/Python/python.exe server/harvest_discover.py [--days N] [--date YYYYMMDD]
      [--start YYYYMMDD --end YYYYMMDD] [--no-whoscored]

Outputs (same shape as harvest_rich.py):
  data/raw/whoscored/{wsId}.json      (only for WhoScored-resolved matches)
  data/raw/fotmob/{fmId}.json
  data/rich/{wsId}.json  OR  data/rich/fm_{fmId}.json
"""

import sys
import os
import re
import json
import time
import argparse
import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import harvest_rich as H  # reuse fetch + normalization logic
from playwright.sync_api import sync_playwright


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------------------
# Existing-rich index (idempotency)
# ---------------------------------------------------------------------------
def pair_key(home, away):
    a, b = sorted([H.norm_team(home), H.norm_team(away)])
    return f"{a}|{b}"


def load_existing_pairs():
    """Map normalised team-pair -> rich filename, for every rich record on disk.

    Knockout rematches of the same pair are possible in theory but never happen
    inside a single World Cup, so a team-pair uniquely identifies a played match
    for idempotency purposes.
    """
    pairs = {}
    if not os.path.isdir(H.RICH):
        return pairs
    for fn in os.listdir(H.RICH):
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(H.RICH, fn), "r", encoding="utf-8") as f:
                r = json.load(f)
            hn = (r.get("home") or {}).get("name")
            an = (r.get("away") or {}).get("name")
            if hn and an:
                pairs[pair_key(hn, an)] = fn
        except Exception:
            continue
    return pairs


# ---------------------------------------------------------------------------
# WhoScored anchor pool (season landing + all group fixtures pages)
# ---------------------------------------------------------------------------
def _anchors_on_page(pg):
    return pg.evaluate("""()=>{
        const o=[];
        for(const a of document.querySelectorAll('a[href]')){
            const h=a.getAttribute('href')||'';
            if(/\\/matches\\/\\d+\\/(live|show|preview)\\//i.test(h)) o.push(h);
        }
        return [...new Set(o)];
    }""")


def build_ws_pool(pg):
    """Return { team-pair -> {id, slug, url} } for every WhoScored WC anchor we
    can see: the season landing page (current + recent knockout matchday) and the
    12 group-stage fixtures pages. Team names come straight from the slug."""
    pool = {}

    def ingest(anchors):
        for h in anchors or []:
            m = re.search(r"/matches/(\d+)/(?:live|show|preview)/"
                          r"(international-fifa-world-cup-2026-[a-z0-9-]+)", h)
            if not m:
                continue
            mid, slug = m.group(1), m.group(2)
            teams = slug.replace("international-fifa-world-cup-2026-", "")
            # slug is "{home}-{away}" with hyphenated multiword names. We cannot
            # split reliably on '-', so index by a normalised bag of the whole
            # team portion and also try every hyphen split point; the caller
            # matches by checking both team tokens are present.
            key_full = re.sub(r"[^a-z0-9]", "", teams)
            url = (f"https://www.whoscored.com/matches/{mid}/live/"
                   f"international-fifa-world-cup-2026-{teams}")
            pool.setdefault(key_full, []).append(
                {"id": mid, "slug": teams, "url": url})

    # season landing page (has current + recent knockout matchday)
    try:
        log("  [ws] season landing page ...")
        pg.goto(H.WS_SEASON_URL, wait_until="domcontentloaded")
        pg.wait_for_timeout(4000)
        ingest(_anchors_on_page(pg))
    except Exception as e:
        log(f"  [ws] season page failed: {str(e)[:80]}")

    # all 12 group-stage fixtures pages
    for sid in H.WS_GROUP_STAGE_IDS:
        try:
            pg.goto(H._ws_stage_fixtures_url(sid), wait_until="domcontentloaded")
            pg.wait_for_timeout(1800)
            ingest(_anchors_on_page(pg))
        except Exception as e:
            log(f"  [ws] stage {sid} failed: {str(e)[:60]}")
        time.sleep(0.25)

    log(f"  [ws] anchor pool size: {sum(len(v) for v in pool.values())}")
    return pool


def resolve_ws(pool, home, away):
    """Find the WhoScored anchor whose slug contains BOTH team names (any order).
    Returns {id, url} or None."""
    hn = H.norm_team(home).replace(" ", "")
    an = H.norm_team(away).replace(" ", "")
    # a slug token-set match: the slug (hyphen-joined) must contain both team
    # name fragments. Compare on the compact alnum form.
    for entries in pool.values():
        for e in entries:
            compact = re.sub(r"[^a-z0-9]", "", e["slug"])
            if hn and an and hn in compact and an in compact:
                return e
    return None


# ---------------------------------------------------------------------------
# FotMob-only rich record (fallback when WhoScored is unavailable)
# ---------------------------------------------------------------------------
def build_rich_fotmob_only(fm_id, fm_parsed):
    """Build a rich record from FotMob alone: score, colors, shots, momentum.
    No passes/events (WhoScored not resolved). Keyed by fm_{fmId}."""
    date = None
    md = fm_parsed.get("matchDate")
    if md:
        mm = re.search(r"(\d{4})-(\d{2})-(\d{2})", str(md))
        if mm:
            date = f"{mm.group(1)}-{mm.group(2)}-{mm.group(3)}"

    rich = {
        "matchId": f"fm_{fm_id}",
        "date": date,
        "round": "knockout",
        "group": None,
        "home": {
            "name": fm_parsed.get("homeName"),
            "abbr": H.abbr_of(fm_parsed.get("homeName")),
            "colorHex": fm_parsed.get("homeColor"),
            "score": fm_parsed.get("homeScore"),
        },
        "away": {
            "name": fm_parsed.get("awayName"),
            "abbr": H.abbr_of(fm_parsed.get("awayName")),
            "colorHex": fm_parsed.get("awayColor"),
            "score": fm_parsed.get("awayScore"),
        },
        "pitch": {"x": 100, "y": 100},
        "momentum": fm_parsed.get("momentum", []),
        "shots": [
            {
                "minute": s.get("minute"), "team": s.get("team"),
                "player": s.get("player"), "x": s.get("x"), "y": s.get("y"),
                "xg": s.get("xg"), "xgot": s.get("xgot"), "type": s.get("type"),
                "situation": s.get("situation"), "isGoal": s.get("isGoal"),
                "onGoalX": s.get("onGoalX"), "onGoalY": s.get("onGoalY"),
            } for s in fm_parsed.get("shots", [])
        ],
        "passes": [],
        "events": [],
        "source": {"fotmobId": fm_id, "whoscoredId": None, "fotmobOnly": True},
    }
    return rich


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def date_window(args):
    if args.start and args.end:
        d = datetime.datetime.strptime(args.start, "%Y%m%d")
        end = datetime.datetime.strptime(args.end, "%Y%m%d")
    else:
        end = (datetime.datetime.strptime(args.date, "%Y%m%d")
               if args.date else datetime.datetime.now())
        d = end - datetime.timedelta(days=max(0, args.days))
    out = []
    while d <= end:
        out.append(d.strftime("%Y%m%d"))
        d += datetime.timedelta(days=1)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=3,
                    help="how many days back from --date/today to scan (default 3)")
    ap.add_argument("--date", default=None, help="window end YYYYMMDD (default today)")
    ap.add_argument("--start", default=None, help="explicit window start YYYYMMDD")
    ap.add_argument("--end", default=None, help="explicit window end YYYYMMDD")
    ap.add_argument("--no-whoscored", action="store_true",
                    help="skip WhoScored entirely; FotMob-only for every new match")
    args = ap.parse_args()

    window = date_window(args)
    log(f"== discovery window: {window[0]} .. {window[-1]} ({len(window)} days) ==")

    existing = load_existing_pairs()
    log(f"== already harvested: {len(existing)} matches on disk ==")

    with sync_playwright() as p:
        b = p.chromium.launch(
            channel="chrome", headless=False,
            args=["--disable-blink-features=AutomationControlled"])
        ctx = b.new_context(user_agent=H.UA,
                            viewport={"width": 1366, "height": 900}, locale="en-US")
        pg_fm = ctx.new_page()
        pg_ws = ctx.new_page()
        for _p in (pg_fm, pg_ws):
            _p.set_default_navigation_timeout(45000)
            _p.set_default_timeout(45000)

        harvested, skipped, failed = [], [], []
        try:
            # 1) FotMob: finished matches in the window
            log("== FotMob warmup ==")
            H.with_retry(lambda: H.fotmob_warmup(pg_fm), "fotmob warmup")
            fm_matches = {}  # pair-key -> match dict (dedup across dates)
            for ds in window:
                lst = H.with_retry(lambda ds=ds: H.fotmob_list_wc_matches(pg_fm, ds),
                                   f"fotmob list {ds}") or []
                fin = [m for m in lst if m.get("finished")]
                if fin:
                    log(f"  {ds}: {len(fin)} finished WC matches")
                for m in fin:
                    fm_matches[pair_key(m["home"], m["away"])] = m
                time.sleep(0.3)
            log(f"== FotMob finished matches in window: {len(fm_matches)} ==")

            # which are NEW?
            new_matches = {pk: m for pk, m in fm_matches.items() if pk not in existing}
            log(f"== NEW (not yet harvested): {len(new_matches)} ==")
            for pk, m in new_matches.items():
                log(f"    fm={m['id']} {m['home']} {m.get('scoreStr')} {m['away']} ({m['date']})")
            for pk in fm_matches:
                if pk in existing:
                    skipped.append(pk)

            if not new_matches:
                log("== nothing new to harvest ==")
                return

            # 2) WhoScored anchor pool (unless disabled)
            pool = {}
            if not args.no_whoscored:
                log("== WhoScored warmup + anchor pool ==")
                H.with_retry(lambda: H.whoscored_warmup(pg_ws), "ws warmup")
                pool = H.with_retry(lambda: build_ws_pool(pg_ws), "ws pool") or {}

            # 3) harvest each new match (fail-soft)
            for pk, m in new_matches.items():
                fm_id = m["id"]
                home, away = m["home"], m["away"]
                log(f"\n== harvest {home} vs {away} (fm={fm_id}) ==")
                try:
                    ws_entry = resolve_ws(pool, home, away) if pool else None

                    # -- FotMob details (needed for both paths) --
                    det = H.with_retry(
                        lambda fm_id=fm_id: H.fotmob_match_details(pg_fm, fm_id),
                        f"fotmob details {fm_id}", tries=4)
                    fm_parsed = H.parse_fotmob(det) if det else None
                    if det:
                        with open(os.path.join(H.RAW_FOTMOB, f"{fm_id}.json"),
                                  "w", encoding="utf-8") as f:
                            json.dump(det, f, ensure_ascii=False)

                    if ws_entry:
                        log(f"  [resolve] WhoScored id={ws_entry['id']} "
                            f"({ws_entry['slug']})")
                        mcd = H.with_retry(
                            lambda u=ws_entry["url"]: H.whoscored_extract(pg_ws, u),
                            f"ws extract {ws_entry['id']}")
                        if mcd and mcd.get("events"):
                            ws_parsed = H.parse_whoscored(mcd)
                            # verify team-pair actually matches (guard vs bad slug)
                            got = pair_key(ws_parsed.get("homeName"),
                                           ws_parsed.get("awayName"))
                            if got != pk:
                                log(f"  [verify] WS pair {got} != {pk}; "
                                    f"falling back to FotMob-only")
                                mcd = None
                        if mcd and mcd.get("events"):
                            with open(os.path.join(H.RAW_WHOSCORED,
                                      f"{ws_entry['id']}.json"), "w",
                                      encoding="utf-8") as f:
                                json.dump(mcd, f, ensure_ascii=False)
                            rich = H.build_rich(ws_entry["id"], fm_id,
                                                ws_parsed, fm_parsed)
                            rich["round"] = "knockout"
                            out_fn = f"{ws_entry['id']}.json"
                            with open(os.path.join(H.RICH, out_fn), "w",
                                      encoding="utf-8") as f:
                                json.dump(rich, f, ensure_ascii=False)
                            log(f"  OK (whoscored) {rich['home']['name']} "
                                f"{rich['home']['score']}-{rich['away']['score']} "
                                f"{rich['away']['name']} | passes={len(rich['passes'])} "
                                f"shots={len(rich['shots'])} "
                                f"momentum={len(rich['momentum'])} -> {out_fn}")
                            harvested.append((pk, out_fn, "whoscored"))
                            time.sleep(2.0)
                            continue
                        log("  [resolve] WhoScored data unavailable; FotMob-only")

                    # -- FotMob-only fallback --
                    if not fm_parsed:
                        log(f"  FAIL {home} vs {away}: no FotMob details either")
                        failed.append((pk, fm_id))
                        continue
                    rich = build_rich_fotmob_only(fm_id, fm_parsed)
                    out_fn = f"fm_{fm_id}.json"
                    with open(os.path.join(H.RICH, out_fn), "w",
                              encoding="utf-8") as f:
                        json.dump(rich, f, ensure_ascii=False)
                    log(f"  OK (fotmob-only) {rich['home']['name']} "
                        f"{rich['home']['score']}-{rich['away']['score']} "
                        f"{rich['away']['name']} | shots={len(rich['shots'])} "
                        f"momentum={len(rich['momentum'])} -> {out_fn}")
                    harvested.append((pk, out_fn, "fotmob-only"))
                    time.sleep(1.5)
                except Exception as e:
                    log(f"  FAIL {home} vs {away}: {str(e)[:120]}")
                    failed.append((pk, fm_id))
                    continue
        finally:
            ctx.close()
            b.close()

        log(f"\n== SUMMARY ==")
        log(f"  harvested: {len(harvested)}")
        for pk, fn, how in harvested:
            log(f"    [{how}] {pk} -> {fn}")
        log(f"  skipped (already had): {len(skipped)}")
        log(f"  failed: {len(failed)}")
        for pk, fid in failed:
            log(f"    {pk} (fm={fid})")


if __name__ == "__main__":
    main()
