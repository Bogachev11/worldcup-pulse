#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
build_thumbs.py — headlessly render EVERY match's ESSENCE thumbnail (public/stage-thumb)
to a TRANSPARENT PNG at public/thumbs/{id}.png.

The essence render is a small 3D-isometric mini-portrait distilling a whole match into
its statistical fingerprint (time-averaged possession split + cumulative-xG relief), on a
transparent background, for the gallery cards.

Approach (matches the project's existing Playwright + system-Chrome capture pipeline):
  · Playwright drives the SYSTEM Chrome (browsers are not downloaded in this env) against
    the already-running supervised server on http://localhost:5280 (public/).
  · For each match id we load stage-thumb.html?id={id}, wait for window.__thumbReady, let
    the WebGL textures settle, then screenshot the #stage canvas with omit_background=True
    so the PNG keeps its ALPHA channel (no black/colour fill behind the pitch).
  · Idempotent: skips ids that already have a PNG unless --force. --only <id,id> limits the set.

Run:  D:/Python/python.exe server/build_thumbs.py           (all missing)
      D:/Python/python.exe server/build_thumbs.py --force   (rebuild all)
      D:/Python/python.exe server/build_thumbs.py --only 1953888,1990967
      D:/Python/python.exe server/build_thumbs.py --limit 3 --force   (quick smoke test)

Constraints honoured: never binds/kills port 5280 (uses the supervised server); real data only.
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MATCHES_JSON = os.path.join(ROOT, "data", "matches.json")
OUT_DIR = os.path.join(ROOT, "public", "thumbs")
BASE_URL = "http://localhost:5280"

# capture geometry. 480x360 logical @ deviceScaleFactor 2 → 960x720 physical PNG.
CAP_W, CAP_H = 480, 360
SCALE = 2
CHROME_PATHS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]


def find_chrome():
    for p in CHROME_PATHS:
        if os.path.exists(p):
            return p
    return None  # fall back to Playwright's bundled chromium if present


def load_ids():
    with open(MATCHES_JSON, "r", encoding="utf-8") as f:
        matches = json.load(f)
    return [str(m["id"]) for m in matches if m.get("id") is not None]


def alpha_stats(png_path):
    """Return (has_alpha, min_alpha, frac_transparent) to verify true transparency."""
    try:
        from PIL import Image
    except Exception:
        return (None, None, None)
    im = Image.open(png_path).convert("RGBA")
    a = im.getchannel("A")
    lo, hi = a.getextrema()
    # fraction of fully/near-transparent pixels (the background around the pitch)
    hist = a.histogram()
    transp = sum(hist[0:8])
    total = im.width * im.height
    return (lo < 250, lo, transp / total if total else 0.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="rebuild even if the PNG exists")
    ap.add_argument("--only", default="", help="comma-separated match ids to render")
    ap.add_argument("--limit", type=int, default=0, help="cap number of matches (smoke test)")
    ap.add_argument("--settle-ms", type=int, default=900, help="ms to wait after __thumbReady")
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    ids = load_ids()
    if args.only:
        want = {s.strip() for s in args.only.split(",") if s.strip()}
        ids = [i for i in ids if i in want]
    if args.limit > 0:
        ids = ids[: args.limit]

    todo = [i for i in ids if args.force or not os.path.exists(os.path.join(OUT_DIR, i + ".png"))]
    print(f"[thumbs] {len(ids)} matches selected, {len(todo)} to render "
          f"(skip {len(ids) - len(todo)} existing).", flush=True)
    if not todo:
        print("[thumbs] nothing to do.")
        return 0

    from playwright.sync_api import sync_playwright

    chrome = find_chrome()
    ok, fail, first_alpha = 0, [], None
    with sync_playwright() as p:
        launch_kwargs = dict(headless=True, args=[
            "--use-gl=angle", "--use-angle=default", "--enable-webgl",
            "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader",
        ])
        if chrome:
            launch_kwargs["executable_path"] = chrome
        browser = p.chromium.launch(**launch_kwargs)
        ctx = browser.new_context(
            viewport={"width": CAP_W, "height": CAP_H},
            device_scale_factor=SCALE,
        )
        page = ctx.new_page()

        for n, mid in enumerate(todo, 1):
            url = f"{BASE_URL}/stage-thumb.html?id={mid}"
            out = os.path.join(OUT_DIR, mid + ".png")
            try:
                page.goto(url, wait_until="load", timeout=30000)
                # wait for the essence frame to be drawn
                page.wait_for_function("() => window.__thumbReady === true", timeout=25000)
                # let the clay textures / IBL / SMAA settle a couple of frames
                page.wait_for_timeout(args.settle_ms)
                canvas = page.query_selector("#stage")
                if canvas is None:
                    raise RuntimeError("#stage canvas not found")
                # omit_background → keep the PNG's alpha (transparent everywhere the
                # cloth/lines don't paint). The page bg is already transparent.
                canvas.screenshot(path=out, omit_background=True)
                has_alpha, lo, frac = alpha_stats(out)
                if first_alpha is None:
                    first_alpha = (mid, has_alpha, lo, frac)
                tag = "" if has_alpha in (True, None) else "  [WARN: no transparency!]"
                print(f"[thumbs] {n}/{len(todo)}  {mid}  ->  {out}"
                      f"  (alpha min={lo}, transp={frac:.0%}){tag}", flush=True)
                ok += 1
            except Exception as e:
                print(f"[thumbs] {n}/{len(todo)}  {mid}  FAILED: {e}", flush=True)
                fail.append((mid, str(e)))

        ctx.close()
        browser.close()

    print(f"\n[thumbs] done: {ok} ok, {len(fail)} failed.")
    if first_alpha:
        mid, ha, lo, frac = first_alpha
        print(f"[thumbs] alpha check on {mid}: has_transparency={ha}, "
              f"min_alpha={lo}, transparent_fraction={frac:.1%}")
    if fail:
        print("[thumbs] failures:")
        for mid, err in fail:
            print(f"   - {mid}: {err}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
