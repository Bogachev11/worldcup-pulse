#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
harvest_one.py - Harvest a SINGLE WhoScored match by id (incl. knockout games
that harvest_rich.py's group-stage enumeration never finds), reusing all of
harvest_rich.py's proven fetch + normalization logic.

The FotMob match is auto-discovered by scanning a date window for the same
team-pair (knockout dates fall outside the group-stage window, so we scan a
separate window here). Falls back to writing the rich record with WhoScored
data only (shots/momentum empty) if FotMob can't be joined.

Run:  D:/Python/python.exe server/harvest_one.py --url <whoscored_url> \
          [--date YYYYMMDD] [--round knockout] [--fotmob <id>]

Outputs (same as harvest_rich.py):
  data/raw/whoscored/{id}.json
  data/raw/fotmob/{fotmobId}.json
  data/rich/{id}.json
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

import harvest_rich as H  # reuse everything
from playwright.sync_api import sync_playwright


def log(*a):
    print(*a, flush=True)


def fotmob_find(pg_fm, home_name, away_name, date_window):
    """Scan dates for a finished WC match with the same team-pair."""
    target_pair = tuple(sorted([H.norm_team(home_name), H.norm_team(away_name)]))
    for ds in date_window:
        lst = H.with_retry(lambda ds=ds: H.fotmob_list_wc_matches(pg_fm, ds),
                           f"fotmob list {ds}") or []
        for m in lst:
            pair = tuple(sorted([H.norm_team(m["home"]), H.norm_team(m["away"])]))
            if pair == target_pair:
                log(f"  [fotmob] found match id={m['id']} on {ds} "
                    f"({m['home']} vs {m['away']}, {m.get('scoreStr')})")
                return m
        time.sleep(0.3)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True, help="WhoScored /matches/{id}/live/... URL")
    ap.add_argument("--date", default=None, help="match date YYYYMMDD (centers fotmob scan)")
    ap.add_argument("--round", default="knockout", help="round label for rich record")
    ap.add_argument("--fotmob", default=None, help="explicit FotMob match id (skip discovery)")
    args = ap.parse_args()

    m = re.search(r"/matches/(\d+)/", args.url)
    if not m:
        log("ERROR: could not parse WhoScored id from --url")
        sys.exit(2)
    ws_id = m.group(1)

    # date window for fotmob discovery
    if args.date:
        base = datetime.datetime.strptime(args.date, "%Y%m%d")
    else:
        base = datetime.datetime(2026, 6, 30)
    date_window = [(base + datetime.timedelta(days=d)).strftime("%Y%m%d")
                   for d in (-1, 0, 1)]

    with sync_playwright() as p:
        b = p.chromium.launch(
            channel="chrome",
            headless=False,
            args=["--disable-blink-features=AutomationControlled"],
        )
        ctx = b.new_context(
            user_agent=H.UA,
            viewport={"width": 1366, "height": 900},
            locale="en-US",
        )
        pg_fm = ctx.new_page()
        pg_ws = ctx.new_page()
        for _p in (pg_fm, pg_ws):
            _p.set_default_navigation_timeout(45000)
            _p.set_default_timeout(45000)

        try:
            # ---- WhoScored ----
            log("== WhoScored warmup ==")
            H.with_retry(lambda: H.whoscored_warmup(pg_ws), "ws warmup")
            log(f"== WhoScored extract {ws_id} ==")
            mcd = H.with_retry(lambda: H.whoscored_extract(pg_ws, args.url),
                               f"ws extract {ws_id}")
            if not mcd:
                log(f"  FAIL {ws_id}: no matchCentreData (Imperva block?)")
                sys.exit(3)
            with open(os.path.join(H.RAW_WHOSCORED, f"{ws_id}.json"), "w",
                      encoding="utf-8") as f:
                json.dump(mcd, f, ensure_ascii=False)
            ws_parsed = H.parse_whoscored(mcd)
            log(f"  WS: {ws_parsed['homeName']} {ws_parsed['homeScore']}-"
                f"{ws_parsed['awayScore']} {ws_parsed['awayName']} | "
                f"events={len(mcd.get('events', []))} passes={len(ws_parsed['passes'])} "
                f"date={ws_parsed['date']}")

            # ---- FotMob ----
            log("== FotMob warmup ==")
            H.with_retry(lambda: H.fotmob_warmup(pg_fm), "fotmob warmup")
            fm_parsed = None
            fm_id = None
            if args.fotmob:
                fm_id = int(args.fotmob)
            else:
                fmm = fotmob_find(pg_fm, ws_parsed["homeName"], ws_parsed["awayName"],
                                  date_window)
                if fmm:
                    fm_id = fmm["id"]
            if fm_id:
                det = H.with_retry(lambda: H.fotmob_match_details(pg_fm, fm_id),
                                   f"fotmob details {fm_id}", tries=4)
                if det:
                    with open(os.path.join(H.RAW_FOTMOB, f"{fm_id}.json"), "w",
                              encoding="utf-8") as f:
                        json.dump(det, f, ensure_ascii=False)
                    fm_parsed = H.parse_fotmob(det)
                    log(f"  FM: shots={len(fm_parsed['shots'])} "
                        f"momentum={len(fm_parsed['momentum'])} "
                        f"colors home={fm_parsed['homeColor']} away={fm_parsed['awayColor']}")
            else:
                log("  [fotmob] no match found; rich will have WS-only data")

            # ---- build rich ----
            rich = H.build_rich(ws_id, fm_id, ws_parsed, fm_parsed)
            rich["round"] = args.round
            with open(os.path.join(H.RICH, f"{ws_id}.json"), "w",
                      encoding="utf-8") as f:
                json.dump(rich, f, ensure_ascii=False)

            log(f"\n== DONE {ws_id}: {rich['home']['name']} ({rich['home']['abbr']}) "
                f"{rich['home']['score']}-{rich['away']['score']} "
                f"{rich['away']['name']} ({rich['away']['abbr']}) | "
                f"passes={len(rich['passes'])} shots={len(rich['shots'])} "
                f"momentum={len(rich['momentum'])} "
                f"colors home={rich['home']['colorHex']} away={rich['away']['colorHex']}")
        finally:
            ctx.close()
            b.close()


if __name__ == "__main__":
    main()
