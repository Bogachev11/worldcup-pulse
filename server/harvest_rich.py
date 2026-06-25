#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
harvest_rich.py - RELIABLE, REPRODUCIBLE harvester for FIFA World Cup 2026.

Downloads RICH real data for all played group-stage matches from FotMob
(shots + xG + momentum) and WhoScored (full Opta event stream incl. all passes),
joins them by (date + teams) with a team-name alias map, and writes normalized
per-match records.

NO mock data. Everything is fetched live via Playwright + system Chrome.

Run:  D:/Python/python.exe server/harvest_rich.py [--smoke N] [--limit N] [--match WSID]

Outputs:
  data/raw/fotmob/{fotmobId}.json
  data/raw/whoscored/{whoscoredId}.json
  data/rich/{whoscoredId}.json
  data/rich_index.json

Idempotent: overwrites cleanly. Safe to re-run.
"""

import sys
import os
import re
import json
import time
import argparse
import unicodedata

from playwright.sync_api import sync_playwright

# ----------------------------------------------------------------------------
# Paths
# ----------------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
DATA = os.path.join(PROJECT, "data")
RAW_FOTMOB = os.path.join(DATA, "raw", "fotmob")
RAW_WHOSCORED = os.path.join(DATA, "raw", "whoscored")
RICH = os.path.join(DATA, "rich")
RICH_INDEX = os.path.join(DATA, "rich_index.json")

for d in (RAW_FOTMOB, RAW_WHOSCORED, RICH):
    os.makedirs(d, exist_ok=True)

# ----------------------------------------------------------------------------
# Browser config (PROVEN recipe)
# ----------------------------------------------------------------------------
CHROME_PATH = "C:/Program Files/Google/Chrome/Application/chrome.exe"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36")

# WC2026 group stage runs roughly 2026-06-11 .. 2026-06-27.
# We scan a generous window; missing dates simply yield no matches.
WC_DATE_START = "20260611"
WC_DATE_END = "20260627"


def log(*a):
    print(*a, flush=True)


# ----------------------------------------------------------------------------
# Team-name normalization / alias map
# ----------------------------------------------------------------------------
_ALIASES = {
    "turkiye": "turkey",
    "korea republic": "south korea",
    "republic of korea": "south korea",
    "korea dpr": "north korea",
    "cote d ivoire": "ivory coast",
    "cote divoire": "ivory coast",
    "usa": "united states",
    "united states of america": "united states",
    "us": "united states",
    "curacao": "curacao",
    "ir iran": "iran",
    "iran islamic republic": "iran",
    "czechia": "czech republic",
    "bosnia herzegovina": "bosnia and herzegovina",
    "cape verde": "cabo verde",
    "drc": "dr congo",
    "congo dr": "dr congo",
    "uae": "united arab emirates",
}


def norm_team(name):
    if not name:
        return ""
    s = unicodedata.normalize("NFKD", str(name))
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower().strip()
    s = s.replace("&", " and ")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return _ALIASES.get(s, s)


def iso_date(date):
    """Normalize any date form to YYYY-MM-DD (accepts YYYYMMDD or YYYY-MM-DD)."""
    if not date:
        return ""
    s = str(date)
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    m = re.match(r"^(\d{4})(\d{2})(\d{2})$", s)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    return s


def match_key(date, home, away):
    """Order-independent join key: ISO date + sorted normalized team pair."""
    a, b = sorted([norm_team(home), norm_team(away)])
    return f"{iso_date(date)}|{a}|{b}"


def color_to_hex(c):
    if not c:
        return None
    c = str(c).strip()
    if c.startswith("#"):
        return c
    m = re.match(r"rgba?\((\d+)\D+(\d+)\D+(\d+)", c)
    if m:
        return "#%02x%02x%02x" % (int(m.group(1)), int(m.group(2)), int(m.group(3)))
    return None


# ----------------------------------------------------------------------------
# FotMob
# ----------------------------------------------------------------------------
def fotmob_warmup(pg):
    pg.goto("https://www.fotmob.com/", wait_until="domcontentloaded")
    pg.wait_for_timeout(2500)


def fotmob_fetch(pg, path):
    """In-page fetch from the fotmob origin (no token needed)."""
    js = """async (p) => {
        const r = await fetch(p, {headers: {'Accept':'application/json'}});
        if (!r.ok) throw new Error('HTTP '+r.status+' for '+p);
        return await r.text();
    }"""
    txt = pg.evaluate(js, path)
    return json.loads(txt)


def fotmob_list_wc_matches(pg, date):
    """Return list of finished WC matches for a date."""
    try:
        data = fotmob_fetch(pg, f"/api/data/matches?date={date}&timezone=Europe/Paris")
    except Exception as e:
        log(f"  [fotmob] list {date} failed: {e}")
        return []
    out = []
    for lg in data.get("leagues", []) or []:
        pid = lg.get("primaryId")
        nm = (lg.get("name") or "")
        is_wc = (pid == 77) or bool(re.search(r"world cup", nm, re.I))
        if not is_wc:
            continue
        for m in lg.get("matches", []) or []:
            st = m.get("status", {}) or {}
            out.append({
                "id": m.get("id"),
                "home": ((m.get("home") or {}).get("name")),
                "away": ((m.get("away") or {}).get("name")),
                "finished": bool(st.get("finished")),
                "scoreStr": st.get("scoreStr"),
                "date": date,
            })
    return out


def fotmob_match_details(pg, mid):
    return fotmob_fetch(pg, f"/api/data/matchDetails?matchId={mid}")


def parse_fotmob(details):
    """Extract teams, score, colors, shots, momentum from FotMob matchDetails."""
    content = details.get("content", {}) or {}
    general = details.get("general", {}) or {}
    header = details.get("header", {}) or {}

    home_t = general.get("homeTeam", {}) or {}
    away_t = general.get("awayTeam", {}) or {}
    home_id = home_t.get("id")
    away_id = away_t.get("id")
    home_name = home_t.get("name")
    away_name = away_t.get("name")

    # team colors - capture whatever exists
    colors = general.get("teamColors") or {}
    home_color = None
    away_color = None
    if isinstance(colors, dict):
        # fotmob commonly: {darkMode:{home,away}, lightMode:{home,away}} OR {home,away}
        def pick(side):
            if side in colors:
                return colors.get(side)
            for mode in ("lightMode", "darkMode"):
                sub = colors.get(mode) or {}
                if isinstance(sub, dict) and sub.get(side):
                    return sub.get(side)
            return None
        home_color = color_to_hex(pick("home"))
        away_color = color_to_hex(pick("away"))

    # score
    home_score = away_score = None
    # try header.teams
    teams = header.get("teams") or []
    if isinstance(teams, list) and len(teams) == 2:
        try:
            home_score = teams[0].get("score")
            away_score = teams[1].get("score")
            if not home_name:
                home_name = teams[0].get("name")
            if not away_name:
                away_name = teams[1].get("name")
        except Exception:
            pass
    if home_score is None:
        st = (general.get("matchStatus") or {})
        # fallback: from scoreStr elsewhere - leave None

    match_date = general.get("matchTimeUTCDate") or general.get("matchTimeUTC") or general.get("matchDate")

    # shots
    shots = []
    shotmap = (content.get("shotmap") or {})
    raw_shots = shotmap.get("shots") or []
    for s in raw_shots:
        tid = s.get("teamId")
        side = "home" if tid == home_id else ("away" if tid == away_id else None)
        og = bool(s.get("isOwnGoal"))
        on_goal = s.get("onGoalShot") or {}
        shots.append({
            "minute": s.get("min"),
            "minAdded": s.get("minAdded"),
            "teamId": tid,
            "team": side,
            "player": s.get("playerName"),
            "playerId": s.get("playerId"),
            "x": s.get("x"),
            "y": s.get("y"),
            "xg": s.get("expectedGoals"),
            "xgot": s.get("expectedGoalsOnTarget"),
            "type": s.get("eventType"),
            "situation": s.get("situation"),
            "shotType": s.get("shotType"),
            "period": s.get("period"),
            "isOnTarget": s.get("isOnTarget"),
            "isBlocked": s.get("isBlocked"),
            "isGoal": (s.get("eventType") == "Goal"),
            "isOwnGoal": og,
            "onGoalX": on_goal.get("x"),
            "onGoalY": on_goal.get("y"),
            "goalCrossedY": s.get("goalCrossedY"),
            "goalCrossedZ": s.get("goalCrossedZ"),
        })

    # momentum.  FotMob momentum can live under content.momentum OR
    # content.matchFacts.momentum; values range roughly +/-100 (varies per match),
    # so normalize by the series' own max magnitude into [-1,1].
    momentum = []
    mf = content.get("matchFacts") or {}
    mom = (content.get("momentum") or mf.get("momentum") or {})
    main = mom.get("main") or {}
    mdata = main.get("data") or []
    vmax = 0.0
    for p in mdata:
        v = p.get("value")
        if isinstance(v, (int, float)):
            vmax = max(vmax, abs(v))
    if vmax <= 0:
        vmax = 1.0
    for p in mdata:
        v = p.get("value")
        vn = None
        if isinstance(v, (int, float)):
            vn = max(-1.0, min(1.0, v / vmax))
        momentum.append({"minute": p.get("minute"), "value": v, "valueNorm": vn})

    return {
        "homeId": home_id, "awayId": away_id,
        "homeName": home_name, "awayName": away_name,
        "homeColor": home_color, "awayColor": away_color,
        "homeScore": home_score, "awayScore": away_score,
        "matchDate": match_date,
        "shots": shots,
        "momentum": momentum,
    }


# ----------------------------------------------------------------------------
# WhoScored
# ----------------------------------------------------------------------------
def whoscored_warmup(pg):
    pg.goto("https://www.whoscored.com/", wait_until="domcontentloaded")
    pg.wait_for_timeout(3500)


# WC2026: tournament 36, season 10498.
#
# IMPORTANT (enumeration mechanism, discovered by live inspection 2026-06-25):
# On WhoScored the WC2026 group stage is split into ONE STAGE PER GROUP. Each
# group's "fixtures" page reliably lists exactly that group's 6 matches as
# /matches/{id}/live anchors. The stage ids are consecutive:
#     Group A=23753, B=23754, C=23755, D=23756, E=23757, F=23758,
#     G=23759, H=23760, I=23761, J=23762, K=23763, L=23764
# The season landing page only ever shows the *current* matchday (~6 fixtures),
# and the in-page day-change arrow / ?d=YYYYMMDD param are pure client-side
# widgets that DO NOT change the embedded fixture set -> they cannot be used to
# page through matchdays. The reliable approach is to visit each group-stage
# fixtures page and harvest its 6 anchors. That yields all 72 group fixtures.
WS_SEASON_URL = ("https://www.whoscored.com/regions/247/tournaments/36/"
                 "seasons/10498/international-fifa-world-cup-2026")
# All 12 group-stage stage ids (A..L). Probed live: 23744..23752 and 23765+
# fall back to a single default match (1988523), so we restrict to A..L.
WS_GROUP_STAGE_IDS = list(range(23753, 23765))  # 23753 .. 23764 inclusive

def _ws_stage_fixtures_url(sid):
    return (f"https://www.whoscored.com/regions/247/tournaments/36/"
            f"seasons/10498/stages/{sid}/fixtures/"
            f"international-fifa-world-cup-2026")


def whoscored_enumerate(pg):
    """Collect all /matches/{id}/live/... anchors for the WC2026 group stage.

    Primary strategy: iterate over the 12 per-group stage *fixtures* pages
    (one stage per group on WhoScored) and harvest each group's 6 fixture
    anchors. Falls back to the season landing page if a stage fails.
    """
    found = {}  # matchId -> url

    def harvest_anchors():
        anchors = pg.evaluate("""()=>{
            const out=[];
            for(const a of document.querySelectorAll('a[href]')){
                const h=a.getAttribute('href')||'';
                if(/\\/matches\\/\\d+\\/(live|show|preview)\\//i.test(h)) out.push(h);
            }
            return out;
        }""")
        for h in anchors or []:
            m = re.search(r"/matches/(\d+)/(?:live|show|preview)/([^\"'\s]+)", h)
            if m:
                mid = m.group(1)
                slug = m.group(2)
                url = f"https://www.whoscored.com/matches/{mid}/live/{slug}"
                found[mid] = url

    # 1) Iterate every per-group stage fixtures page (A..L). Each lists its 6
    #    group fixtures. try/except per stage so one bad page never hangs/aborts
    #    the crawl.
    for sid in WS_GROUP_STAGE_IDS:
        url = _ws_stage_fixtures_url(sid)
        before = len(found)
        try:
            log(f"  [ws] group stage {sid} fixtures ...")
            pg.goto(url, wait_until="domcontentloaded")
            pg.wait_for_timeout(2500)
            harvest_anchors()
            log(f"  [ws] stage {sid}: +{len(found)-before} (total {len(found)})")
        except Exception as e:
            log(f"  [ws] stage {sid} failed: {str(e)[:80]}")
        time.sleep(0.3)

    # 2) Fallback: if the per-stage crawl somehow under-delivered, also scrape
    #    the season landing page (current matchday) so we at least get those.
    if len(found) < 60:
        try:
            log(f"  [ws] only {len(found)} anchors; scraping season landing page ...")
            pg.goto(WS_SEASON_URL, wait_until="domcontentloaded")
            pg.wait_for_timeout(4000)
            harvest_anchors()
            log(f"  [ws] after season page: {len(found)} anchors")
        except Exception as e:
            log(f"  [ws] season page failed: {str(e)[:80]}")

    return found


def whoscored_extract(pg, url):
    """Navigate to a Live page and extract matchCentreData JSON (PROVEN)."""
    pg.goto(url, wait_until="domcontentloaded")
    pg.wait_for_timeout(4000)
    raw = pg.evaluate("""()=>{
      for(const sc of document.querySelectorAll('script')){
        const t=sc.textContent||''; const i=t.indexOf('matchCentreData');
        if(i>-1 && t.indexOf('events')>-1){
          const start=t.indexOf('{', i); let depth=0,end=-1;
          for(let k=start;k<t.length;k++){const c=t[k];if(c==='{')depth++;else if(c==='}'){depth--;if(depth===0){end=k;break;}}}
          if(end>-1) return t.slice(start,end+1);
        }
      } return null;
    }""")
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception as e:
        log(f"  [ws] JSON parse failed for {url}: {e}")
        return None


def parse_whoscored(mcd):
    """Extract teams, score, passes, events from WhoScored matchCentreData."""
    home = mcd.get("home", {}) or {}
    away = mcd.get("away", {}) or {}
    home_id = home.get("teamId")
    away_id = away.get("teamId")
    home_name = home.get("name")
    away_name = away.get("name")

    # score string like "2 : 1"
    score = mcd.get("score") or ""
    home_score = away_score = None
    m = re.match(r"\s*(\d+)\s*:\s*(\d+)", str(score))
    if m:
        home_score = int(m.group(1))
        away_score = int(m.group(2))

    start_time = mcd.get("startTime") or mcd.get("startDate")

    def side_of(tid):
        return "home" if tid == home_id else ("away" if tid == away_id else None)

    passes = []
    events = []
    for ev in mcd.get("events", []) or []:
        et = ((ev.get("type") or {}).get("displayName")) or ""
        tid = ev.get("teamId")
        side = side_of(tid)
        minute = ev.get("minute")
        if ev.get("second") is not None and isinstance(minute, int):
            pass  # keep minute as-is; second available if needed
        oc = ((ev.get("outcomeType") or {}).get("displayName"))
        if et == "Pass":
            passes.append({
                "minute": minute,
                "team": side,
                "playerId": ev.get("playerId"),
                "x": ev.get("x"),
                "y": ev.get("y"),
                "endX": ev.get("endX"),
                "endY": ev.get("endY"),
                "outcome": oc,
            })
        else:
            events.append({
                "minute": minute,
                "team": side,
                "type": et,
                "x": ev.get("x"),
                "y": ev.get("y"),
                "endX": ev.get("endX"),
                "endY": ev.get("endY"),
                "outcome": oc,
            })

    # date YYYY-MM-DD from startTime
    date = None
    if start_time:
        mm = re.search(r"(\d{4})-(\d{2})-(\d{2})", str(start_time))
        if mm:
            date = f"{mm.group(1)}-{mm.group(2)}-{mm.group(3)}"
        else:
            mm = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})", str(start_time))
            if mm:
                date = f"{mm.group(3)}-{int(mm.group(1)):02d}-{int(mm.group(2)):02d}"

    return {
        "homeId": home_id, "awayId": away_id,
        "homeName": home_name, "awayName": away_name,
        "homeScore": home_score, "awayScore": away_score,
        "date": date,
        "startTime": start_time,
        "passes": passes,
        "events": events,
    }


def abbr_of(name):
    if not name:
        return None
    s = re.sub(r"[^A-Za-z ]", "", str(name)).strip()
    parts = s.split()
    if len(parts) >= 2:
        return (parts[0][0] + parts[1][0] + parts[1][1:2]).upper()[:3]
    return s[:3].upper()


# ----------------------------------------------------------------------------
# Join + normalize
# ----------------------------------------------------------------------------
def build_rich(ws_id, fm_id, ws_parsed, fm_parsed):
    """Join WhoScored (passes/events, canonical pitch) + FotMob (shots/xg/momentum)."""
    date = ws_parsed.get("date")
    if not date and fm_parsed:
        md = fm_parsed.get("matchDate")
        if md:
            mm = re.search(r"(\d{4})-(\d{2})-(\d{2})", str(md))
            if mm:
                date = f"{mm.group(1)}-{mm.group(2)}-{mm.group(3)}"

    home_name = ws_parsed.get("homeName") or (fm_parsed or {}).get("homeName")
    away_name = ws_parsed.get("awayName") or (fm_parsed or {}).get("awayName")

    # Determine WS vs FM home orientation. If FM home == WS away (flipped), we
    # must remap shots/momentum to WS orientation so "home" is consistent.
    flip = False
    if fm_parsed:
        ws_home_n = norm_team(ws_parsed.get("homeName"))
        fm_home_n = norm_team(fm_parsed.get("homeName"))
        fm_away_n = norm_team(fm_parsed.get("awayName"))
        if ws_home_n and fm_home_n:
            if ws_home_n == fm_away_n and ws_home_n != fm_home_n:
                flip = True

    def remap_side(side):
        if not flip or side is None:
            return side
        return "away" if side == "home" else "home"

    home_score = ws_parsed.get("homeScore")
    away_score = ws_parsed.get("awayScore")
    if home_score is None and fm_parsed:
        if flip:
            home_score = fm_parsed.get("awayScore")
            away_score = fm_parsed.get("homeScore")
        else:
            home_score = fm_parsed.get("homeScore")
            away_score = fm_parsed.get("awayScore")

    home_color = away_color = None
    if fm_parsed:
        if flip:
            home_color = fm_parsed.get("awayColor")
            away_color = fm_parsed.get("homeColor")
        else:
            home_color = fm_parsed.get("homeColor")
            away_color = fm_parsed.get("awayColor")

    shots = []
    momentum = []
    if fm_parsed:
        for s in fm_parsed.get("shots", []):
            shots.append({
                "minute": s.get("minute"),
                "team": remap_side(s.get("team")),
                "player": s.get("player"),
                "x": s.get("x"),
                "y": s.get("y"),
                "xg": s.get("xg"),
                "xgot": s.get("xgot"),
                "type": s.get("type"),
                "situation": s.get("situation"),
                "isGoal": s.get("isGoal"),
                "onGoalX": s.get("onGoalX"),
                "onGoalY": s.get("onGoalY"),
            })
        # momentum is home-positive in FM orientation; if flipped, invert sign
        for mpt in fm_parsed.get("momentum", []):
            v = mpt.get("value")
            vn = mpt.get("valueNorm")
            if flip:
                if isinstance(v, (int, float)):
                    v = -v
                if isinstance(vn, (int, float)):
                    vn = -vn
            momentum.append({"minute": mpt.get("minute"), "value": v, "valueNorm": vn})

    rich = {
        "matchId": str(ws_id),
        "date": date,
        "round": "group",
        "group": None,
        "home": {
            "name": home_name,
            "abbr": abbr_of(home_name),
            "colorHex": home_color,
            "score": home_score,
        },
        "away": {
            "name": away_name,
            "abbr": abbr_of(away_name),
            "colorHex": away_color,
            "score": away_score,
        },
        "pitch": {"x": 100, "y": 100},
        "momentum": momentum,
        "shots": shots,
        "passes": ws_parsed.get("passes", []),
        "events": ws_parsed.get("events", []),
        "source": {"fotmobId": fm_id, "whoscoredId": str(ws_id)},
    }
    return rich


# ----------------------------------------------------------------------------
# Retry helper
# ----------------------------------------------------------------------------
def with_retry(fn, what, tries=3):
    last = None
    for attempt in range(1, tries + 1):
        try:
            return fn()
        except Exception as e:
            last = e
            wait = 2 * attempt
            log(f"  retry {attempt}/{tries} for {what}: {e} (backoff {wait}s)")
            time.sleep(wait)
    log(f"  GIVE UP {what}: {last}")
    return None


# ----------------------------------------------------------------------------
# Main harvest
# ----------------------------------------------------------------------------
def harvest(smoke=None, limit=None, only_match=None):
    with sync_playwright() as p:
        b = p.chromium.launch(
            channel="chrome",
            headless=False,
            args=["--disable-blink-features=AutomationControlled"],
        )
        ctx = b.new_context(
            user_agent=UA,
            viewport={"width": 1366, "height": 900},
            locale="en-US",
        )
        # Two dedicated pages: in-page fetch() to the FotMob API only works from a
        # page whose origin IS fotmob.com (cross-origin -> HTTP 406). So keep one
        # page parked on fotmob.com and a separate page for WhoScored navigation.
        pg_fm = ctx.new_page()
        pg_ws = ctx.new_page()
        for _p in (pg_fm, pg_ws):
            _p.set_default_navigation_timeout(45000)
            _p.set_default_timeout(45000)

        try:
            # ---- 1) FotMob: list finished WC matches across the date window ----
            log("== FotMob warmup ==")
            with_retry(lambda: fotmob_warmup(pg_fm), "fotmob warmup")

            log("== FotMob: listing WC matches ==")
            fm_matches = []
            import datetime
            d = datetime.datetime.strptime(WC_DATE_START, "%Y%m%d")
            dend = datetime.datetime.strptime(WC_DATE_END, "%Y%m%d")
            while d <= dend:
                ds = d.strftime("%Y%m%d")
                lst = with_retry(lambda ds=ds: fotmob_list_wc_matches(pg_fm, ds),
                                 f"fotmob list {ds}") or []
                fin = [m for m in lst if m["finished"]]
                if fin:
                    log(f"  {ds}: {len(fin)} finished WC matches")
                fm_matches.extend(fin)
                d += datetime.timedelta(days=1)
                time.sleep(0.4)
            log(f"FotMob total finished WC matches: {len(fm_matches)}")

            # build FotMob join indexes.
            #  fm_index    : exact (date + team-pair) key
            #  fm_pairs    : team-pair -> list of matches (date may differ by a
            #                day due to timezone boundary between sources)
            fm_index = {}
            fm_pairs = {}
            for m in fm_matches:
                k = match_key(m["date"], m["home"], m["away"])
                fm_index[k] = m
                a, bteam = sorted([norm_team(m["home"]), norm_team(m["away"])])
                fm_pairs.setdefault(f"{a}|{bteam}", []).append(m)

            # ---- 2) WhoScored: enumerate match URLs ----
            log("== WhoScored warmup ==")
            with_retry(lambda: whoscored_warmup(pg_ws), "ws warmup")
            log("== WhoScored: enumerating matches ==")
            ws_urls = with_retry(lambda: whoscored_enumerate(pg_ws), "ws enumerate") or {}
            log(f"WhoScored candidate matches: {len(ws_urls)}")

            if only_match:
                ws_urls = {k: v for k, v in ws_urls.items() if k == str(only_match)}

            ws_items = sorted(ws_urls.items(), key=lambda kv: int(kv[0]))
            if smoke:
                ws_items = ws_items[:smoke]
            elif limit:
                ws_items = ws_items[:limit]

            # ---- 3) Per match: WhoScored extract + FotMob join ----
            results = []
            for i, (ws_id, url) in enumerate(ws_items, 1):
                log(f"\n[{i}/{len(ws_items)}] WhoScored {ws_id}")
                mcd = with_retry(lambda url=url: whoscored_extract(pg_ws, url),
                                 f"ws extract {ws_id}")
                if not mcd:
                    log(f"  SKIP {ws_id}: no matchCentreData")
                    continue
                # save raw whoscored
                with open(os.path.join(RAW_WHOSCORED, f"{ws_id}.json"), "w",
                          encoding="utf-8") as f:
                    json.dump(mcd, f, ensure_ascii=False)
                ws_parsed = parse_whoscored(mcd)

                # only finished group-stage matches: require some events
                if not ws_parsed.get("passes"):
                    log(f"  SKIP {ws_id}: no passes (likely not played)")
                    continue

                # join to FotMob
                date = ws_parsed.get("date")
                fm_parsed = None
                fm_id = None
                if date:
                    hn = ws_parsed.get("homeName")
                    an = ws_parsed.get("awayName")
                    k = match_key(date, hn, an)
                    fmm = fm_index.get(k)
                    # fallback A: same team-pair on an adjacent date (+/- 1 day)
                    if not fmm:
                        import datetime as _dt
                        try:
                            base = _dt.datetime.strptime(iso_date(date), "%Y-%m-%d")
                            for delta in (-1, 1):
                                alt = (base + _dt.timedelta(days=delta)).strftime("%Y-%m-%d")
                                cand = fm_index.get(match_key(alt, hn, an))
                                if cand:
                                    fmm = cand
                                    log(f"  [join] matched via adjacent date {alt}")
                                    break
                        except Exception:
                            pass
                    # fallback B: unique team-pair anywhere in the tournament
                    if not fmm:
                        a, bteam = sorted([norm_team(hn), norm_team(an)])
                        cands = fm_pairs.get(f"{a}|{bteam}", [])
                        if len(cands) == 1:
                            fmm = cands[0]
                            log(f"  [join] matched via unique team-pair (date {fmm['date']})")
                    if fmm:
                        fm_id = fmm["id"]
                        # fotmob fetch runs on the dedicated fotmob-origin page
                        det = with_retry(lambda fm_id=fm_id: fotmob_match_details(pg_fm, fm_id),
                                         f"fotmob details {fm_id}", tries=4)
                        if det:
                            with open(os.path.join(RAW_FOTMOB, f"{fm_id}.json"), "w",
                                      encoding="utf-8") as f:
                                json.dump(det, f, ensure_ascii=False)
                            fm_parsed = parse_fotmob(det)
                    else:
                        log(f"  [join] no FotMob match for key {k}")

                rich = build_rich(ws_id, fm_id, ws_parsed, fm_parsed)
                with open(os.path.join(RICH, f"{ws_id}.json"), "w",
                          encoding="utf-8") as f:
                    json.dump(rich, f, ensure_ascii=False)

                np_ = len(rich["passes"])
                ns = len(rich["shots"])
                nm = len(rich["momentum"])
                complete = (np_ > 0 and ns > 0 and nm > 0)
                tag = "rich-complete" if complete else "PARTIAL"
                log(f"  OK {rich['home']['name']} {rich['home']['score']}-"
                    f"{rich['away']['score']} {rich['away']['name']} | "
                    f"passes={np_} shots={ns} momentum={nm} fotmob={fm_id} [{tag}]")

                results.append({
                    "matchId": str(ws_id),
                    "date": rich["date"],
                    "group": rich["group"],
                    "home": {"abbr": rich["home"]["abbr"],
                             "score": rich["home"]["score"],
                             "colorHex": rich["home"]["colorHex"]},
                    "away": {"abbr": rich["away"]["abbr"],
                             "score": rich["away"]["score"],
                             "colorHex": rich["away"]["colorHex"]},
                    "counts": {"passes": np_, "shots": ns, "momentum": nm},
                })

                time.sleep(2.5)  # polite delay

            # ---- 4) write index ----
            results.sort(key=lambda r: (r["date"] or "", r["matchId"]))
            index = {
                "generatedAtNote": "(no timestamp - Date unavailable in scripts; stamp externally)",
                "count": len(results),
                "matches": results,
            }
            with open(RICH_INDEX, "w", encoding="utf-8") as f:
                json.dump(index, f, ensure_ascii=False, indent=2)
            log(f"\n== DONE: {len(results)} rich matches; index -> {RICH_INDEX} ==")

            # summary table
            tot_p = sum(r["counts"]["passes"] for r in results)
            tot_s = sum(r["counts"]["shots"] for r in results)
            log(f"TOTAL passes={tot_p} shots={tot_s}")
            log(f"{'match':<14}{'passes':>8}{'shots':>7}{'momentum':>10}")
            for r in results:
                lbl = f"{r['home']['abbr']}-{r['away']['abbr']}"
                log(f"{lbl:<14}{r['counts']['passes']:>8}"
                    f"{r['counts']['shots']:>7}{r['counts']['momentum']:>10}")

            return results
        finally:
            ctx.close()
            b.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", type=int, default=None,
                    help="only process first N matches (smoke test)")
    ap.add_argument("--limit", type=int, default=None,
                    help="cap number of matches")
    ap.add_argument("--match", type=str, default=None,
                    help="only process a single WhoScored match id")
    args = ap.parse_args()
    harvest(smoke=args.smoke, limit=args.limit, only_match=args.match)
