// stage13 — "HOW TO READ IT" explainer overlay. Extracted VERBATIM from stage13.js as a
// FACTORY (initHowRead) during the module refactor. It self-wires its own overlay DOM +
// localStorage + matchMedia and has NO coupling to the render state — so moving it out of the
// stage13 closure is a no-op. Dependencies (el / HOWEDIT / HOWEDIT_KEY) are passed in; clamp is
// imported directly. The dev hooks window.__howMeasure / window.__howDump close over THIS module's
// internal closures only (not the render engine), so they live here with the factory.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// ── "HOW TO READ IT" — THE ONE EDITABLE DESIGN BLOCK (literal 1282×1273 Figma canvas) ────────────
// EVERY tunable the explainer draws lives HERE so exact Figma values can be dropped in verbatim.
// Coordinates are LITERAL px in a 1282×1273 design canvas; the whole canvas is uniformly scaled to
// fit the viewport (S = min(iw/1282, ih/1273)) so these numbers land EXACTLY (no feature-anchoring
// heuristics). DESKTOP uses them as-is. MOBILE (portrait/touch) is a readable adaptation: the still
// is fit to viewport WIDTH and the 3 labels sit in the dark bands with short leaders — its knobs are
// under HOW_DESIGN.mobile.

import { clamp } from '../claybattle.js?v=1f97922a92';

export const HOW_DESIGN = {
  // The still is the USER'S grab (MEX-ENG @ 69', transparent, full canvas) shown FULL-VIEWPORT over the
  // live cloth. Feature points are FRACTIONS of the displayed still rect, so leaders land on the real
  // features at any width. Labels break ONLY at <br> (white-space:nowrap) — project grotesk, white.
  // WebP (re-encoded ~122 KB, from a 1.16 MB PNG) is the primary; the PNG stays as a graceful
  // onerror fallback for any browser without WebP support (see applyLayout / stillPngFor).
  still: { src: '/dev/howread/peak_mantle_user.webp', png: '/dev/howread/peak_mantle_user.png' },
  // MOBILE uses the SAME desktop landscape grab (no separate portrait capture): it's CONTAIN-fit into
  // the phone width (letterboxed top/bottom) so the whole mantle — with the correct peak — stays visible
  // at NATURAL proportions, just scaled down. The 3 mobile labels sit in the dark bands above/below it.
  // (peak_mantle_mobile.png, a distinct distorted portrait grab, is no longer used.)
  // MOBILE points at a TIGHT CROP of the user grab (peak_mantle_crop.png, 1212×742) — the desktop grab
  // has a wide black margin around the tilted cloth, so fit-to-width made the CLOTH look narrow. The crop
  // trims that margin so the CLOTH itself touches the image edges → fills the full phone-frame width.
  stillMobile: { src: '/dev/howread/peak_mantle_crop.webp', png: '/dev/howread/peak_mantle_crop.png' },
  // MOMENTUM legend (heading + Goal/Red card/Substitution key). Anchored by STAGE-% on mobile so it
  // renders INSIDE the phone frame in the editor emulation AND at the matching spot on a real phone —
  // the old CSS `left:27%` was VIEWPORT-relative, so beside the centered narrow editor frame it landed
  // in the masked area. Desktop clears the inline override and keeps the CSS anchor (left:27%/bottom:21vh).
  legendMobile: { leftPct: 5, bottomPct: 23 },
  labelFontDesktop: 15, labelFontMobile: 11, dotR: 3,
  // Feature points are fractions of the DISPLAYED still rect. They are PER-LAYOUT because the desktop
  // (landscape) and mobile (portrait) stills frame the cloth differently — so a dot on "the spike" sits
  // at different fractions in each. `feat` = DESKTOP; `featMobile` = MOBILE (seeded as a copy of feat,
  // then re-placed by the user in the phone-frame editor). Editing one never clobbers the other.
  feat:       { spike: [0.612, 0.189], seam: [0.744, 0.428], green: [0.519, 0.324], blue: [0.562, 0.256] },
  featMobile: { spike: [0.687, 0.058], seam: [0.838, 0.343], green: [0.584, 0.128], blue: [0.365, 0.487] },
  // DESKTOP — viewport-% label anchors placed by the user in the ?howedit=1 editor. Each lead is a
  // feature key (or {key,dir}); the leader always emanates from the END of the label's last line.
  desktop: [
    { id: 'l1', leftPct: 42.7, topPct: 8.8,  html: 'Sharp spikes are shots. The taller the<br>spike, the better the chance', leads: [{ key: 'spike', dir: 'h' }] },
    { id: 'l2', leftPct: 42.7, topPct: 19.7, html: 'The two colours are the<br>two teams', leads: [{ key: 'green', dir: 'v' }, 'blue'] },
    { id: 'l3', leftPct: 57.5, topPct: 65.3, html: 'The seam is who’s on top. Which<br>team is pushing right now', leads: [{ key: 'seam', dir: 'h', anchorLine: 'first' }] },
  ],
  // MOBILE — same texts, readable size, in the dark bands.
  mobile: [
    { id: 'l1', leftPct: 4.5, topPct: 31.7, html: 'Sharp spikes are shots. The taller the<br>spike, the better the chance', leads: [{ key: 'spike', dir: 'h' }] },
    { id: 'l2', leftPct: 4.9, topPct: 41.1, html: 'The two colours are the<br>two teams', leads: [{ key: 'green', dir: 'h', anchorLine: 'first' }, { key: 'blue', dir: 'v' }] },
    { id: 'l3', leftPct: 35, topPct: 56.8, html: 'The seam is who’s on top. Which<br>team is pushing right now', leads: [{ key: 'seam', dir: 'h', anchorLine: 'first' }] },
  ],
};
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export function initHowRead(deps) {
  const { el, HOWEDIT, HOWEDIT_KEY } = deps;
  const link = el('howToReadLink');
  const still = el('howStill'), scrim = el('howScrim'), ann = el('howAnn');
  const peak = el('howPeak'), closeX = el('howOverlayClose');
  const svg = ann && ann.querySelector('.howframe-svg');
  const legend = ann && ann.querySelector('.howlegend-wrap');
  if (!link || !still || !scrim || !ann || !peak || !svg) return;

  // LAZY — the still image (~122 KB WebP) is NOT loaded at init. Its src is set only the first time
  // the overlay opens (applyLayout, called from show()), so visitors who never open "how to read it"
  // never download it. This alone more than halves the page weight for the common case.

  const isMobile = () => window.matchMedia('(max-width: 640px)').matches ||
    (window.matchMedia('(orientation: portrait)').matches && window.matchMedia('(hover: none)').matches);

  // HOWEDIT layout override — null = auto by viewport (normal ?dev behavior). When the editor forces a
  // layout ('desktop'|'mobile'), applyLayout + the editor pick THAT config regardless of viewport width.
  let _editLayout = null;
  // effective "is this the mobile layout?" — honors the forced edit layout, else viewport.
  const editMobile = () => (_editLayout ? _editLayout === 'mobile' : isMobile());

  // RESIZE OBSERVER — device/timing-INDEPENDENT backstop for leader placement. ANY reflow that changes a
  // measured rect the leaders depend on — a label text box (webfont swap / metrics change), the still
  // image (decode/fit), or the SVG frame itself (address-bar show/hide, orientation, visualViewport) —
  // fires this and recomputes the leaders against the ACTUAL rendered geometry. Unlike fonts.ready (which
  // may never fire on a given browser, or fire before the swap lands), a ResizeObserver fires for
  // WHATEVER actually changed size, on every engine — so the leaders track the real text/frame regardless
  // of which font renders or when. `relayout`/`isOpen` are referenced lazily (defined below); the callback
  // only ever runs asynchronously after the module has fully initialised.
  let _ro = null;
  const observe = (node) => { if (node && _ro) { try { _ro.observe(node); } catch (_) {} } };
  if (typeof ResizeObserver !== 'undefined') {
    _ro = new ResizeObserver(() => { if (isOpen()) relayout(); });
    observe(peak); observe(svg); observe(ann);
  }

  const labelEls = {};
  const ensureLabel = (id) => {
    if (labelEls[id]) return labelEls[id];
    const d = document.createElement('div'); d.className = 'hcall2'; d.id = 'hc-' + id;
    ann.appendChild(d); labelEls[id] = d; observe(d); return d;
  };

  const LEAD_GAP = 5;   // px of empty space between the end of the last line and where the leader starts

  // A lead is a bare feature key ('green') OR an object {key, dir:'v'|'h'}. `dir` FORCES the leader's
  // first-leg direction ('v' = vertical-first, 'h' = horizontal-first); absent → auto dominant-axis.
  // The leader ORIGIN is NOT stored — it is ALWAYS derived at draw time as the end of the label's last
  // line (see lastLineAnchor), so the line emanates from the last phrase in both view and editor.
  const leadKey = (L) => (typeof L === 'string' ? L : L.key);
  const leadDir = (L) => (L && typeof L === 'object' && (L.dir === 'v' || L.dir === 'h')) ? L.dir : null;
  // Optional per-lead `anchorLine`: which text line the leader attaches to. 'first'/'last' or a 0-based
  // numeric index; absent → last line (default). Returns the raw selector (null when absent).
  const leadAnchorLine = (L) => {
    if (!L || typeof L !== 'object') return null;
    const a = L.anchorLine;
    return (a === 'first' || a === 'last' || typeof a === 'number') ? a : null;
  };
  // Ensure lead i is an object and set (or clear, when dir is falsy) its forced first-leg direction.
  const setLeadDir = (lab, i, dir) => {
    let L = lab.leads[i];
    if (typeof L === 'string') L = lab.leads[i] = { key: L };
    if (dir) L.dir = dir; else delete L.dir;
  };
  // Ensure lead i is an object and set (or clear, when aln is falsy/'last') its anchorLine selector.
  // Independent of `dir` (mirrors setLeadDir): only touches `anchorLine`, never the direction.
  const setLeadAnchor = (lab, i, aln) => {
    let L = lab.leads[i];
    if (typeof L === 'string') L = lab.leads[i] = { key: L };
    if (aln === 'first' || typeof aln === 'number') L.anchorLine = aln; else delete L.anchorLine;
  };
  // Right-angle L from a start (px) to a feature (px). `dir` FORCES the first leg: 'h' = horizontal
  // first (→ corner at feature-x / start-y), 'v' = vertical first (→ corner at start-x / feature-y).
  // With no dir it falls back to the DOMINANT axis (a start directly ABOVE a feature drops straight down).
  const routeLeader = (sx, sy, fx, fy, dir) => {
    const horiz = dir === 'h' ? true : dir === 'v' ? false : (Math.abs(fx - sx) >= Math.abs(fy - sy));
    const corner = horiz ? [fx, sy] : [sx, fy];
    return `${sx.toFixed(1)},${sy.toFixed(1)} ${corner[0].toFixed(1)},${corner[1].toFixed(1)} ${fx.toFixed(1)},${fy.toFixed(1)}`;
  };
  // LAST-LINE anchor (viewport px) — every leader ATTACHES just past the END of the label's LAST text
  // line, then routes to its feature (with the per-lead `dir`), so the line comes cleanly off the last
  // phrase and NEVER crosses the words. Labels are 1–2 lines split by <br> (white-space:nowrap); we
  // measure the LAST line's own rect via a Range over the label's contents (getClientRects → one rect
  // per line) — NOT the whole label box, whose right edge follows the LONGER (usually top) line. The
  // anchor is label-relative (re-measured each layout) so it tracks the text as the viewport scales.
  // `anchorLine` (optional) picks WHICH visual line to attach to: 'first' → line 0, a number → that
  // 0-based index (clamped), 'last'/absent → the last line (default). Same Range/getClientRects split.
  const lastLineAnchor = (d, anchorLine) => {
    let rect = null;
    try {
      const rng = document.createRange(); rng.selectNodeContents(d);
      const rects = rng.getClientRects();
      if (rects && rects.length) {
        let idx = rects.length - 1;                                // default: last visual line
        if (anchorLine === 'first') idx = 0;
        else if (typeof anchorLine === 'number') idx = Math.max(0, Math.min(rects.length - 1, anchorLine));
        rect = rects[idx];
      }
    } catch (_) {}
    if (!rect) rect = d.getBoundingClientRect();                   // fallback: whole box
    return [rect.right + LEAD_GAP, (rect.top + rect.bottom) / 2];   // end of the chosen line + gap, line centre
  };

  // ── EDITOR PHONE-FRAME EMULATION (HOWEDIT only) ───────────────────────────────────────────────
  // When the editor forces the MOBILE layout, we render the whole overlay inside a narrow portrait
  // "phone" column so the user can arrange the REAL mobile composition from a wide desktop window.
  // The stage rect (below) becomes that frame; the still, labels + leaders + drag math all lay out
  // relative to it, while the dump stays in the same fractional units so it round-trips to a real
  // phone. Real phones / ?dev=1 never emulate (emulatingMobile needs HOWEDIT) — they use the viewport.
  //
  // APPROACH (B): the phone-frame emulation is ONLY for previewing/editing mobile FROM A WIDE window.
  // When the REAL browser viewport is already mobile-width (`isMobile()`), we DON'T draw a phone frame
  // — the editor composes against the real viewport so the genuine mobile HUD (score top-left, minute
  // clock top-right, placed by the CSS @media query) is visible at its true positions and the labels/
  // dots/leaders are dragged directly over it. `emulatingMobile()` therefore requires !isMobile().
  const PHONE_W = 390, PHONE_H = 844;
  const emulatingMobile = () => HOWEDIT && _editLayout === 'mobile' && !isMobile();
  const frameRect = () => {
    const m = 24;                                                   // breathing room top/bottom
    const scale = Math.min(1, (window.innerHeight - m * 2) / PHONE_H, (window.innerWidth - m * 2) / PHONE_W);
    const w = PHONE_W * scale, h = PHONE_H * scale;
    const left = (window.innerWidth - w) / 2, top = (window.innerHeight - h) / 2;
    return { left, top, width: w, height: h, right: left + w, bottom: top + h };
  };
  // The rect the overlay composes into: the phone frame when emulating, else the full viewport.
  const stageRect = () => emulatingMobile() ? frameRect()
    : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight, right: window.innerWidth, bottom: window.innerHeight };
  // Which still src the layout wants: PORTRAIT for mobile (real phones + the editor phone frame),
  // the desktop LANDSCAPE grab otherwise. Swapped in applyLayout so features/labels lay out against
  // the still that actually matches the composition.
  const stillSrcFor = (mobile) => (mobile && HOW_DESIGN.stillMobile && HOW_DESIGN.stillMobile.src)
    ? HOW_DESIGN.stillMobile.src : HOW_DESIGN.still.src;
  // The PNG fallback that matches the layout's WebP (used via onerror when WebP is unsupported).
  const stillPngFor = (mobile) => (mobile && HOW_DESIGN.stillMobile && HOW_DESIGN.stillMobile.png)
    ? HOW_DESIGN.stillMobile.png : (HOW_DESIGN.still && HOW_DESIGN.still.png) || null;
  // Active feature-point set for a layout: mobile → featMobile, desktop → feat (see HOW_DESIGN).
  const featFor = (mobile) => (mobile && HOW_DESIGN.featMobile) ? HOW_DESIGN.featMobile : HOW_DESIGN.feat;
  // FIT-TO-WIDTH the (landscape) still into the stage rect: it spans the FULL frame width EDGE-TO-EDGE
  // (left→right), preserving natural proportions (no stretch), so it's a wide band centred vertically —
  // well inside the frame height (390-wide → ~235 tall), never overflowing/cropped. Same image as
  // desktop, just scaled down. Mobile only (real mobile: stage = viewport; editor: stage = phone frame).
  // Desktop clears the inline overrides so the normal CSS layout resumes.
  const sizeStill = (mobile) => {
    if (!mobile) { peak.style.cssText = ''; return; }
    const st = stageRect();
    const iw = peak.naturalWidth || 1212, ih = peak.naturalHeight || 742;  // CROPPED mobile still (natural) — cloth fills frame edge-to-edge
    const s = st.width / iw;                          // FIT TO WIDTH — full frame width, natural proportions, no crop
    const w = st.width, h = ih * s;                   // displayed = full width × proportional height
    const left = st.left, top = st.top + (st.height - h) / 2;   // flush to frame-left, centred vertically
    peak.style.cssText = `position:fixed;left:${left.toFixed(1)}px;top:${top.toFixed(1)}px;width:${w.toFixed(1)}px;height:${h.toFixed(1)}px;max-width:none;max-height:none;transform:none;margin:0;display:block;pointer-events:none;`;
  };
  // Editor-only phone frame: a rounded border around the column + a near-opaque mask over everything
  // outside it, so the user composes the ACTUAL narrow mobile view. No-op / hidden unless emulating.
  let _phoneMask = null;
  const applyPhoneMask = () => {
    if (!HOWEDIT) return;
    if (emulatingMobile()) {
      const f = frameRect();
      if (!_phoneMask) { _phoneMask = document.createElement('div'); _phoneMask.id = 'howPhoneMask'; document.body.appendChild(_phoneMask); }
      _phoneMask.style.cssText = `position:fixed;left:${f.left.toFixed(1)}px;top:${f.top.toFixed(1)}px;width:${f.width.toFixed(1)}px;height:${f.height.toFixed(1)}px;z-index:60;pointer-events:none;border-radius:26px;border:1px solid rgba(120,140,170,.5);box-shadow:0 0 0 9999px rgba(2,3,6,.95);`;
      _phoneMask.style.display = 'block';
    } else if (_phoneMask) {
      _phoneMask.style.display = 'none';
    }
  };
  // Re-run the layout once the (async) still image loads so the COVER math uses real natural dims.
  // In the editor a bare applyLayout() rewrites every label's inline style (wiping the pointer-events/
  // cursor the drag needs) and leaves the handle set at stale positions — so when editing we also run
  // the editor's rebuild+refresh hook so labels stay grabbable and handles track the re-fit still.
  let _editRefresh = null;
  // Bounded counter for the PROJECTION GUARD in applyLayout (re-runs the layout on later frames until
  // the still <img> has real on-screen dimensions, so feature dots are never placed off a 0×0 rect).
  let _projTries = 0;
  peak.addEventListener('load', () => { if (isOpen()) { applyLayout(); if (_editRefresh) _editRefresh(); } });

  // FULL-VIEWPORT layout (desktop + mobile): the still fills the screen (or the phone frame while the
  // editor emulates mobile); features are fractions of the DISPLAYED still rect; labels are anchored
  // by stage-% and break only at <br>; leaders are L-shapes.
  const applyLayout = () => {
    // In edit mode the forced layout wins (so a wide desktop window can preview the mobile layout);
    // otherwise fall back to the viewport. body.howmobile is matched to the effective layout so the
    // forced-mobile preview gets the SAME visual treatment real mobile does.
    const mobile = (HOWEDIT && _editLayout) ? (_editLayout === 'mobile') : isMobile();
    document.body.classList.toggle('howmobile', mobile);
    const wantSrc = stillSrcFor(mobile);   // PORTRAIT still on mobile, LANDSCAPE on desktop (WebP)
    const wantPng = stillPngFor(mobile);   // matching PNG fallback for no-WebP browsers
    // Set the src lazily here (first open) and on layout swaps. Treat the WebP and its PNG fallback
    // as equivalent for THIS layout so a browser that already fell back to the PNG isn't bounced back
    // to the failing WebP on every re-layout (which would loop via the load/onerror handlers).
    const curSrc = peak.getAttribute('src');
    if (curSrc !== wantSrc && curSrc !== wantPng) {
      peak.onerror = () => { peak.onerror = null; if (wantPng && peak.getAttribute('src') !== wantPng) peak.setAttribute('src', wantPng); };
      peak.setAttribute('src', wantSrc);
    }
    sizeStill(mobile);                     // COVER-fit the still to the stage (viewport, or phone frame in edit)
    applyPhoneMask();                      // editor-only: draw the phone frame + mask outside (edit-mobile only)
    const cfg = mobile ? HOW_DESIGN.mobile : HOW_DESIGN.desktop;
    const font = mobile ? HOW_DESIGN.labelFontMobile : HOW_DESIGN.labelFontDesktop;
    const vw = window.innerWidth, vh = window.innerHeight;
    // COORDINATE SYSTEM — CRITICAL (was the "crooked/detached leaders on Android Chrome" bug). The
    // leaders (SVG polylines) and the labels (DOM divs) MUST live in ONE coordinate space or the leaders
    // tear away from the text. Labels + feature dots are measured with getBoundingClientRect → LIVE
    // viewport CSS px. The SVG must therefore map its user units 1:1 to those same CSS px. The SVG's CSS
    // box is 100vw×100vh, and on mobile Chrome `100vh` is the LARGE (toolbar-retracted) viewport, which
    // does NOT equal window.innerHeight while the address bar is shown. Setting the viewBox to
    // innerWidth×innerHeight (the OLD code) stretched the box vertically (preserveAspectRatio:none), so
    // every leader drifted DOWN-screen from its label by a fixed, per-device offset that grew toward the
    // bottom — deterministic, not a font race. It was crooked in Chrome but fine in Xiaomi Mi Browser
    // ONLY because Mi's toolbar behaviour makes 100vh==innerHeight there. FIX: set the viewBox to the
    // SVG's OWN measured box so user-px == CSS-px == getBoundingClientRect space (identity map) at ANY
    // toolbar state / DPR / orientation. OX/OY re-base every screen coord to the box's screen origin, so a
    // point drawn at user (X-OX, Y-OY) lands exactly on screen point (X,Y) — bulletproof to any transform.
    const svgBox = svg.getBoundingClientRect();
    const VBW = svgBox.width || vw, VBH = svgBox.height || vh;
    const OX = svgBox.left, OY = svgBox.top;
    svg.setAttribute('viewBox', `0 0 ${VBW} ${VBH}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    // hide any stale labels, then place + size the active ones (so their rects are measurable).
    // Anchors are % of the STAGE rect (full viewport normally, the phone frame while emulating mobile),
    // emitted as viewport px so the labels sit inside the frame. Normal stage == viewport, so px == vw/vh.
    const st = stageRect();
    for (const id in labelEls) labelEls[id].style.display = 'none';
    for (const lab of cfg) {
      const d = ensureLabel(lab.id); d.style.display = 'block'; d.innerHTML = lab.html;
      const hpos = (lab.leftPct != null)
        ? `left:${(st.left + lab.leftPct / 100 * st.width).toFixed(1)}px;`
        : `right:${(vw - (st.right - lab.rightPct / 100 * st.width)).toFixed(1)}px;`;
      const vpos = (lab.topPct != null)
        ? `top:${(st.top + lab.topPct / 100 * st.height).toFixed(1)}px;`
        : `bottom:${(vh - (st.bottom - lab.bottomPct / 100 * st.height)).toFixed(1)}px;`;
      d.style.cssText = `${hpos} ${vpos} font-size:${font}px;`;
      // EDITOR — cssText above wiped any inline interactivity; re-assert it every layout so labels stay
      // draggable even when applyLayout re-runs on its own (e.g. the async still-image load). The
      // onpointerdown handler is a property (survives cssText), so restoring these styles is enough.
      if (HOWEDIT) { d.style.pointerEvents = 'auto'; d.style.cursor = 'move'; d.style.touchAction = 'none'; }
    }
    // MOMENTUM legend — position FRAME-RELATIVE on mobile (same stageRect as the still + labels) so it
    // sits INSIDE the phone frame in the editor emulation and at the matching spot on a real phone. The
    // static markup is anchored by viewport-% CSS (left:27%), which lands in the mask beside the centered
    // editor frame — so we override with stage-% px here. Desktop clears the override → CSS anchor resumes.
    if (legend) {
      // VERTICAL ANCHOR — the legend MUST sit ABOVE the live momentum pulse graph with clear separation
      // on BOTH layouts. The legend is position:absolute inside .howframe--ann, whose box is height:100vh
      // = the LARGE (toolbar-retracted) viewport, while the pulse graph (#pulse13wrap, anchored to the HUD
      // by bottom:98px) tracks window.innerHeight. A FIXED CSS `bottom` (the old desktop `bottom:21vh`, or
      // a vh estimate) is viewport-HEIGHT dependent, so on SHORT laptop viewports (≈700–900px, less with
      // browser chrome) — AND on mobile Chrome with the address bar shown (100vh≠innerHeight) — the legend
      // fell ONTO the pulse. FIX (both layouts): pin the legend's BOTTOM edge a fixed gap ABOVE the graph's
      // LIVE measured top, using the ann box's LIVE height so `bottom` resolves correctly at ANY height.
      const GAP = 18;                                                // clear separation above the pulse graph
      const graph = document.getElementById('pulse13wrap') || document.querySelector('#hud13 .console');
      const gr = graph && graph.getBoundingClientRect();
      const annH = ann.getBoundingClientRect().height || vh;
      const abovePulse = (gr && gr.height) ? (annH - (gr.top - GAP)) : null;   // legend bottom = GAP px above graph top
      if (mobile) {
        const lg = HOW_DESIGN.legendMobile || { leftPct: 5, bottomPct: 23 };
        legend.style.left = `${(st.left + lg.leftPct / 100 * st.width).toFixed(1)}px`;
        legend.style.right = 'auto';
        legend.style.top = 'auto';
        legend.style.bottom = `${(abovePulse != null ? abovePulse
          : (vh - (st.bottom - lg.bottomPct / 100 * st.height))).toFixed(1)}px`;   // fallback: legacy vh estimate
      } else {
        // DESKTOP — keep the CSS HORIZONTAL anchor (left:27%; clear the inline left/right/top) but pin the
        // BOTTOM above the LIVE pulse so it never overlaps on short laptop viewports (was fixed bottom:21vh).
        legend.style.left = ''; legend.style.right = ''; legend.style.top = '';
        legend.style.bottom = (abovePulse != null) ? `${abovePulse.toFixed(1)}px` : '';   // fallback: CSS 21vh
      }
    }
    // features as fractions of the DISPLAYED still rect → viewport px; draw L-leaders + dots.
    // The ACTIVE layout's feature set (desktop → feat, mobile → featMobile).
    const feat = featFor(mobile);
    const r = peak.getBoundingClientRect();
    // PROJECTION GUARD — feature dots are fractions of the still's ON-SCREEN rect. If the still hasn't
    // been laid out yet (0×0 before the WebP decodes / before the mobile viewport settles), placing the
    // dots now lands them against a bad viewport (the stray long-leader tell). Defer this pass and re-run
    // on the next frame until the still has real dims — bounded so a genuinely missing image can't spin
    // forever (the img 'load' handler + the settle passes below also re-drive it).
    if (!r.width || !r.height) {
      svg.innerHTML = '';
      if (isOpen() && _projTries < 60) { _projTries++; requestAnimationFrame(applyLayout); }
      return;
    }
    _projTries = 0;
    let s = ''; const seen = new Set();
    for (const lab of cfg) {
      const d = labelEls[lab.id]; if (!d) continue;
      for (const L of lab.leads) {
        const key = leadKey(L);
        const fr = feat[key]; if (!fr) continue;
        // Re-base every screen-px coordinate to the SVG box origin (OX/OY) so it maps 1:1 into the viewBox.
        const fx = (r.left + fr[0] * r.width) - OX, fy = (r.top + fr[1] * r.height) - OY;
        // Leader ATTACHES at the end of the label's LAST line (supersedes any legacy per-lead `start`
        // fraction, which used to begin mid-text and overdraw the words), then routes to the feature.
        // The per-lead `dir` (v/h) still forces the first leg; absent → dominant axis. Both leads of a
        // 2-lead label (L2 green+blue) share this last-line-end anchor and diverge to their features.
        const dir = leadDir(L);
        const [sx0, sy0] = lastLineAnchor(d, leadAnchorLine(L));
        const sx = sx0 - OX, sy = sy0 - OY;   // last-line end, re-based to the SVG box origin (see above)
        const pts = routeLeader(sx, sy, fx, fy, dir);
        s += `<polyline points="${pts}"/>`;
        if (!seen.has(key)) { seen.add(key); s += `<circle cx="${fx.toFixed(1)}" cy="${fy.toFixed(1)}" r="${HOW_DESIGN.dotR}"/>`; }
      }
    }
    svg.innerHTML = s;
  };

  // OPEN/CLOSE — show the frozen mantle still + scrim + annotations. Playback is NOT paused: the live
  // scene keeps running behind (the still just covers the cloth), and the live HUD + pulse stay live
  // (dimmed by the scrim). body.howactive drives visibility + hides the dev chrome / xG labels /
  // scorer card. Nothing to restore on close.
  const isOpen = () => document.body.classList.contains('howactive');
  // IDEMPOTENT re-layout guard. applyLayout is cheap + stateless, so it's safe to run on ANY signal
  // that its two async inputs may have settled: the WEBFONT (Space Grotesk, font-display:swap — until
  // it swaps in, the label last-line rects that ORIGIN each leader are measured with fallback metrics)
  // and the STILL <img> being laid out (feature DOTS are fractions of its rect). In the editor a bare
  // applyLayout wipes the drag handles, so refresh them too when editing.
  const relayout = () => { if (!isOpen()) return; applyLayout(); if (HOWEDIT && _editRefresh) _editRefresh(); };
  const show = () => {
    if (isOpen()) return;
    document.body.classList.add('howactive');
    applyLayout();
    // BELT-AND-BRACES SETTLE PASSES — the still <img>, the webfont swap and the mobile browser toolbar
    // can each settle on a DIFFERENT later tick; re-run the (idempotent) layout next frame and after
    // short + long delays so a late font/image/viewport change is ALWAYS corrected. This is the core
    // fix for the mobile-Chrome cold-cache "crooked leaders": the layout used to run once against
    // fallback-font metrics and never recompute after the real font swapped in (leaders left ~15px off).
    requestAnimationFrame(applyLayout);
    setTimeout(relayout, 150);
    setTimeout(relayout, 500);
    // FONT LOADING API — recompute the instant the webfont is ready (guarded for browsers without it).
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout).catch(() => {});
  };
  const hide = () => {
    document.body.classList.remove('howactive');
    document.body.classList.remove('howmobile');
  };
  const toggle = () => { isOpen() ? hide() : show(); };

  // keep the annotations aligned on resize while open (recompute S + mobile geometry)
  window.addEventListener('resize', () => { if (isOpen()) applyLayout(); });
  // FONT SWAP — the webfont finishing AFTER the overlay opened is the core mobile-Chrome race: the
  // leader origins (end of each label's last line) shift when the fallback face is replaced, and nothing
  // recomputed. Recompute on the global ready promise AND every subsequent 'loadingdone' (covers late or
  // secondary faces, and reopening the overlay after the font later swaps).
  if (document.fonts) {
    document.fonts.ready.then(relayout).catch(() => {});
    try { document.fonts.addEventListener('loadingdone', relayout); } catch (_) {}
  }
  // MOBILE VIEWPORT churn: a rotate fires 'orientationchange' and the address-bar/toolbar show/hide fires
  // visualViewport 'resize' (NOT window 'resize') — both move the still + labels. Re-lay-out on each,
  // with a couple of trailing frames on rotate (its metrics settle a beat after the event fires).
  window.addEventListener('orientationchange', () => { relayout(); requestAnimationFrame(relayout); setTimeout(relayout, 250); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', relayout);
  // dev/verification hook — force a re-layout and report the current scale + label/dot geometry.
  window.__howMeasure = () => {
    if (!isOpen()) return null; applyLayout();
    const mob = document.body.classList.contains('howmobile');
    return { mobile: mob,
      still: (() => { const r = el('howPeak').getBoundingClientRect(); return { w: +r.width.toFixed(0), h: +r.height.toFixed(0) }; })(),
      feat: featFor(mob) };
  };

  // HOVER-CAPABLE? — a real laptop/desktop can hover EVEN IF it ALSO has a touchscreen. The OLD test
  // `(hover: hover) and (pointer: fine)` keys off the PRIMARY pointer, which on a touchscreen laptop is
  // the TOUCH digitiser (hover:none / pointer:coarse) → it wrongly fell into TAP mode (close-X, no
  // hover-to-open) on the owner's laptop. FIX: ask whether ANY attached input can hover / is fine
  // (`any-hover`/`any-pointer` — true via the trackpad/mouse on a touch laptop, false on a touch-only
  // phone/tablet). Some engines under-report those on touch laptops, so a WIDE viewport (≥1024px) is
  // also treated as hover-capable — a phone/small tablet is narrow AND touch-only, so it still lands in
  // TAP mode. This is the desktop-vs-touch decision the overlay's hover/tap wiring hangs off of.
  const canHover = window.matchMedia('(any-hover: hover)').matches ||
    window.matchMedia('(any-pointer: fine)').matches ||
    window.matchMedia('(min-width: 1024px)').matches;
  if (!HOWEDIT && canHover) {
    // HOVER mode — reveal while the link is hovered or keyboard-focused.
    link.addEventListener('mouseenter', show);
    link.addEventListener('mouseleave', hide);
    link.addEventListener('focus', show);
    link.addEventListener('blur', hide);
  } else if (!HOWEDIT) {
    // TAP mode — body.howtap reveals the X and lets the scrim/X catch taps.
    document.body.classList.add('howtap');
    link.addEventListener('click', (e) => { e.preventDefault(); toggle(); });
    [scrim, closeX].forEach((n) => n && n.addEventListener('click', (e) => { e.preventDefault(); hide(); }));
  }

  // ── HOWEDIT — drag the labels + feature dots, then COPY the coords to paste back ────────────
  if (HOWEDIT) {
    document.body.classList.remove('howtap');            // no accidental close while editing

    // ── PERSISTENCE (DEV/editor-only) ─────────────────────────────────────────────────────────
    // Snapshot the EDITABLE geometry only: for BOTH desktop + mobile, each label's positional
    // fields (leftPct/topPct/rightPct/bottomPct) + its leads (per-lead `dir` only), plus the shared
    // feature dots. html/text/ids are NOT persisted — they stay from the file. Leaders store NO start:
    // the origin is always the end of the label's last line (see lastLineAnchor).
    const POS_KEYS = ['leftPct', 'topPct', 'rightPct', 'bottomPct'];
    // Serialize a lead: bare key when auto-routed, else {key, dir} so the forced direction round-trips.
    const snapLead = (L) => {
      const key = leadKey(L), dir = leadDir(L), aln = leadAnchorLine(L);
      if (!dir && aln == null) return key;
      const o = { key };
      if (dir) o.dir = dir;
      if (aln != null) o.anchorLine = aln;
      return o;
    };
    const snapLabels = (arr) => arr.map((l) => {
      const o = { id: l.id };
      for (const k of POS_KEYS) if (typeof l[k] === 'number') o[k] = l[k];
      o.leads = l.leads.map((L) => snapLead(L));
      return o;
    });
    // Persist BOTH feature sets (desktop `feat` + mobile `featMobile`) so editing one never loses the other.
    const buildState = () => ({ v: 1, desktop: snapLabels(HOW_DESIGN.desktop), mobile: snapLabels(HOW_DESIGN.mobile),
      feat: HOW_DESIGN.feat, featMobile: HOW_DESIGN.featMobile });
    const saveState = () => { try { localStorage.setItem(HOWEDIT_KEY, JSON.stringify(buildState())); } catch (_) {} };
    // Merge saved geometry back into HOW_DESIGN (match labels by id). Robust to missing/partial/
    // corrupt data — anything unexpected is ignored so the editor falls back to file defaults.
    const mergeLabels = (arr, saved) => {
      if (!Array.isArray(saved)) return;
      for (const lab of arr) {
        const s = saved.find((x) => x && x.id === lab.id); if (!s) continue;
        if (POS_KEYS.some((k) => typeof s[k] === 'number')) {           // replace the whole anchor when any pos field is present
          for (const k of POS_KEYS) delete lab[k];
          for (const k of POS_KEYS) if (typeof s[k] === 'number') lab[k] = s[k];
        }
        if (Array.isArray(s.leads)) {
          const leads = s.leads.map((L) => {
            if (typeof L === 'string') return L;
            if (L && typeof L === 'object' && typeof L.key === 'string') {
              // `start` from any older saved state is intentionally IGNORED — leaders no longer store one.
              const o = { key: L.key };
              if (L.dir === 'v' || L.dir === 'h') o.dir = L.dir;
              if (L.anchorLine === 'first' || L.anchorLine === 'last' || typeof L.anchorLine === 'number') o.anchorLine = L.anchorLine;
              return (o.dir || o.anchorLine != null) ? o : L.key;
            }
            return null;
          }).filter((x) => x != null);
          if (leads.length) lab.leads = leads;
        }
      }
    };
    // Merge a saved feature set into a target, key by key (skip anything not a numeric [x,y] pair).
    const mergeFeat = (target, saved) => {
      if (!saved || typeof saved !== 'object') return;
      for (const k in target) {
        const f = saved[k];
        if (Array.isArray(f) && typeof f[0] === 'number' && typeof f[1] === 'number') target[k] = [f[0], f[1]];
      }
    };
    const loadState = () => {
      try {
        const raw = localStorage.getItem(HOWEDIT_KEY); if (!raw) return;
        const st = JSON.parse(raw); if (!st || typeof st !== 'object') return;
        mergeLabels(HOW_DESIGN.desktop, st.desktop);
        mergeLabels(HOW_DESIGN.mobile, st.mobile);
        mergeFeat(HOW_DESIGN.feat, st.feat);
        mergeFeat(HOW_DESIGN.featMobile, st.featMobile);
      } catch (_) {}
    };
    loadState();                                          // BEFORE first applyLayout — restore last placement

    // Start editing the layout that MATCHES the real viewport: a narrow phone opens straight into the
    // MOBILE layout (rendered against the real viewport — real mobile HUD visible, no phone frame),
    // a wide window opens into DESKTOP. The Mobile/Desktop toggle still switches freely afterwards;
    // on a wide window "Mobile" previews the phone-frame emulation, on a phone it uses the real viewport.
    _editLayout = isMobile() ? 'mobile' : 'desktop';
    // editCfg — the ACTIVE layout being edited (forced layout wins over viewport).
    const cfg = () => (_editLayout ? HOW_DESIGN[_editLayout] : (isMobile() ? HOW_DESIGN.mobile : HOW_DESIGN.desktop));
    const stillRect = () => peak.getBoundingClientRect();
    const dump = () => {
      const mob = editMobile();
      const src = featFor(mob);                 // the ACTIVE layout's feature set
      const feat = {}; for (const k in src) feat[k] = [+src[k][0].toFixed(3), +src[k][1].toFixed(3)];
      const labels = cfg().map((l) => {
        const o = { id: l.id };
        if (l.leftPct != null) o.leftPct = +l.leftPct.toFixed(1);
        if (l.topPct != null) o.topPct = +l.topPct.toFixed(1);
        if (l.rightPct != null) o.rightPct = +l.rightPct.toFixed(1);
        if (l.bottomPct != null) o.bottomPct = +l.bottomPct.toFixed(1);
        // leads round-trip: bare key when auto-routed, else {key,dir}. No start (auto last-line origin).
        o.leads = l.leads.map((L) => snapLead(L));
        return o;
      });
      // feature set is emitted under the ACTIVE layout's key so the two COPYs are unambiguous:
      // DESKTOP → `feat`, MOBILE → `featMobile`.
      const out = {};
      out[mob ? 'featMobile' : 'feat'] = feat;
      out.labels = labels;
      return out;
    };
    window.__howDump = dump;
    // COPY panel — top-left, in the dark side-band (outside the central square). On a narrow (real
    // mobile) viewport the composition IS the full width, so the mobile labels (pinned to the left
    // edge, leftPct≈4) sit under this panel — hence: (a) bounded height + scroll so it doesn't blanket
    // the whole left column, and (b) a DRAG grip on its header (below) so the user can shove it aside
    // to reach any label. z stays above the handles so its own buttons remain clickable.
    const panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;left:12px;top:12px;z-index:100001;background:rgba(0,0,0,.82);color:#cfe;font:12px/1.45 ui-monospace,monospace;padding:10px 12px;border-radius:8px;pointer-events:auto;max-width:300px;max-height:44vh;overflow:auto';
    // DESKTOP/MOBILE toggle — shows which layout is being edited + switches _editLayout on click.
    // The header doubles as a DRAG GRIP: pointer-drag it to reposition the whole panel (so it can be
    // moved off a label on a narrow phone). Repositioning is view-only — nothing is persisted.
    const lblEl = document.createElement('div');
    lblEl.style.cssText = 'font:700 12px/1.3 ui-monospace,monospace;color:#fff;margin:0 0 6px;cursor:move;touch-action:none;user-select:none';
    lblEl.title = 'drag to move this panel out of the way';
    lblEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const pr = panel.getBoundingClientRect();
      const ox = e.clientX - pr.left, oy = e.clientY - pr.top;
      try { lblEl.setPointerCapture(e.pointerId); } catch (_) {}
      const mv = (ev) => {
        panel.style.left = clamp(ev.clientX - ox, 0, window.innerWidth - 44).toFixed(0) + 'px';
        panel.style.top = clamp(ev.clientY - oy, 0, window.innerHeight - 28).toFixed(0) + 'px';
        panel.style.right = 'auto';
      };
      const up = () => { try { lblEl.releasePointerCapture(e.pointerId); } catch (_) {} lblEl.removeEventListener('pointermove', mv); lblEl.removeEventListener('pointerup', up); };
      lblEl.addEventListener('pointermove', mv); lblEl.addEventListener('pointerup', up);
    });
    const seg = document.createElement('div');
    seg.style.cssText = 'display:flex;gap:6px;margin:0 0 9px';
    const mkTog = (mode, txt) => {
      const b = document.createElement('button'); b.textContent = txt;
      b.style.cssText = 'flex:1;padding:6px 8px;border:1px solid #2fe0a8;border-radius:6px;font:700 11px/1 ui-monospace,monospace;cursor:pointer';
      b.addEventListener('click', () => setLayout(mode));
      return b;
    };
    const togD = mkTog('desktop', 'Desktop'), togM = mkTog('mobile', 'Mobile');
    seg.appendChild(togD); seg.appendChild(togM);
    const paint = (b, on) => { b.style.background = on ? '#2fe0a8' : 'transparent'; b.style.color = on ? '#03110c' : '#2fe0a8'; };
    const updateToggleUI = () => {
      lblEl.textContent = 'Editing: ' + String(_editLayout || 'auto').toUpperCase();
      paint(togD, _editLayout === 'desktop'); paint(togM, _editLayout === 'mobile');
    };
    // COPY + RESET on one row. COPY writes the live geometry to the clipboard; RESET clears the saved
    // localStorage overlay and reloads so the editor reverts to the FILE defaults (HOW_DESIGN).
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:stretch;margin:0 0 8px';
    const btn = document.createElement('button');
    btn.textContent = 'COPY COORDS';
    btn.style.cssText = 'flex:1;padding:7px 12px;background:#2fe0a8;color:#03110c;border:0;border-radius:6px;font:700 12px/1 ui-monospace,monospace;cursor:pointer';
    const resetBtn = document.createElement('button');
    resetBtn.textContent = 'RESET';
    resetBtn.title = 'Clear saved placement and reload to file defaults';
    resetBtn.style.cssText = 'padding:7px 12px;background:transparent;color:#9fb3c8;border:1px solid #55636f;border-radius:6px;font:700 11px/1 ui-monospace,monospace;cursor:pointer';
    resetBtn.addEventListener('click', () => { try { localStorage.removeItem(HOWEDIT_KEY); } catch (_) {} location.reload(); });
    row.appendChild(btn); row.appendChild(resetBtn);
    const pre = document.createElement('pre'); pre.style.cssText = 'margin:0;white-space:pre-wrap';
    panel.appendChild(lblEl); panel.appendChild(seg); panel.appendChild(row); panel.appendChild(pre); document.body.appendChild(panel);
    const refresh = () => { pre.textContent = JSON.stringify(dump(), null, 1); };
    // Switch the layout under edit — re-layout (with forced treatment), rebuild handles, refresh dump,
    // and persist the geometry (the toggle can settle label rects, so snapshot the current state too).
    const setLayout = (mode) => {
      _editLayout = mode; updateToggleUI();
      applyLayout(); rebuild(); refresh(); saveState();
    };
    btn.addEventListener('click', () => {
      const t = JSON.stringify(dump(), null, 1); console.log('[howedit]\n' + t);
      const ok = () => { btn.textContent = 'COPIED ✓'; setTimeout(() => (btn.textContent = 'COPY COORDS'), 1200); };
      const fb = () => { btn.textContent = '(console) ✓'; setTimeout(() => (btn.textContent = 'COPY COORDS'), 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(ok).catch(fb); else fb();
    });
    let handles = [];
    // POINTER-based drag (works for mouse AND touch): capture the pointer on the grabbed element so
    // moves/ups keep flowing to it — even on touch, where the pointerdown target gets IMPLICIT capture.
    // We must NOT remove `target` mid-drag (that would kill the capture), so during move we only redraw
    // leaders (applyLayout) + make the dragged handle follow the pointer; the full handle set is rebuilt
    // once on release. `follow` = small square/dot handles that track the pointer clamped to the still.
    const drag = (target, e, onMove, follow) => {
      e.preventDefault();
      try { target.setPointerCapture(e.pointerId); } catch (_) {}
      const move = (ev) => {
        onMove(ev);
        if (follow) { const rc = stillRect(); target.style.left = clamp(ev.clientX, rc.left, rc.right).toFixed(1) + 'px'; target.style.top = clamp(ev.clientY, rc.top, rc.bottom).toFixed(1) + 'px'; }
        applyLayout(); refresh();
      };
      const up = () => { try { target.releasePointerCapture(e.pointerId); } catch (_) {} target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up); rebuild(); saveState(); };
      target.addEventListener('pointermove', move); target.addEventListener('pointerup', up); target.addEventListener('pointercancel', up);
    };
    const bindLabels = () => {
      for (const id in labelEls) {
        const d = labelEls[id]; if (d.style.display === 'none') continue;
        d.style.pointerEvents = 'auto'; d.style.cursor = 'move'; d.style.touchAction = 'none'; d.title = 'drag to place';
        d.onpointerdown = (e) => {
          const lab = cfg().find((l) => l.id === id); if (!lab) return;
          drag(d, e, (ev) => { const st = stageRect(); lab.leftPct = clamp((ev.clientX - st.left) / st.width * 100, 0, 100); lab.topPct = clamp((ev.clientY - st.top) / st.height * 100, 0, 100); delete lab.bottomPct; delete lab.rightPct; });
        };
      }
    };
    const rebuild = () => {
      handles.forEach((h) => h.remove()); handles = [];
      const rr = stillRect();
      const feat = featFor(editMobile());   // edit the ACTIVE layout's feature set (feat | featMobile)
      // RED feature dots — the leader END points (fractions of the still).
      for (const key in feat) {
        const fr = feat[key];
        const h = document.createElement('div'); h.title = key + ' (feature · ' + (editMobile() ? 'mobile' : 'desktop') + ')';
        h.style.cssText = `position:fixed;z-index:99998;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;background:rgba(255,70,70,.85);border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.5);cursor:grab;pointer-events:auto;touch-action:none;left:${(rr.left + fr[0] * rr.width).toFixed(1)}px;top:${(rr.top + fr[1] * rr.height).toFixed(1)}px`;
        h.onpointerdown = (e) => drag(h, e, (ev) => { const r2 = stillRect(); feat[key] = [clamp((ev.clientX - r2.left) / r2.width, 0, 1), clamp((ev.clientY - r2.top) / r2.height, 0, 1)]; }, true);
        document.body.appendChild(h); handles.push(h);
      }
      // V/H DIRECTION chips — one per leader, sat at the LAST-LINE anchor (end of the label's last line,
      // the fixed leader origin — see lastLineAnchor / applyLayout). There is NO draggable start handle
      // anymore: the origin is derived from the text, not stored. The editable knobs are the label
      // position (drag the text), the feature dot (red), and this V/H chip.
      if (rr.width) for (const lab of cfg()) {
        const d = labelEls[lab.id]; if (!d || d.style.display === 'none') continue;
        lab.leads.forEach((L, i) => {
          const key = leadKey(L); const fr = feat[key]; if (!fr) return;
          const [sx, sy] = lastLineAnchor(d, leadAnchorLine(L));
          // V/H direction chip — sits at the leader origin; click cycles AUTO → V → H → AUTO. Forces the
          // leader's first-leg direction (overrides dominant axis). Updates live + persists.
          const cur = leadDir(lab.leads[i]);
          const chip = document.createElement('div');
          chip.textContent = cur ? cur.toUpperCase() : 'A';
          chip.title = `${lab.id} → ${key}: first leg ${cur === 'v' ? 'VERTICAL' : cur === 'h' ? 'HORIZONTAL' : 'AUTO'} — click to cycle A/V/H`;
          chip.style.cssText = `position:fixed;z-index:100000;transform:translate(-50%,-50%);min-width:16px;height:16px;padding:0 3px;display:flex;align-items:center;justify-content:center;border-radius:4px;background:${cur ? '#3cdcf0' : 'rgba(10,18,26,.92)'};color:${cur ? '#03110c' : '#8fb3c8'};border:1px solid #3cdcf0;font:700 10px/1 ui-monospace,monospace;cursor:pointer;pointer-events:auto;touch-action:none;left:${(sx + 15).toFixed(1)}px;top:${(sy - 15).toFixed(1)}px`;
          chip.onpointerdown = (ev) => { ev.stopPropagation(); ev.preventDefault(); };   // don't start a drag
          chip.onclick = (ev) => {
            ev.stopPropagation();
            const now = leadDir(lab.leads[i]);
            const next = now === null ? 'v' : now === 'v' ? 'h' : null;   // A → V → H → A
            setLeadDir(lab, i, next);
            applyLayout(); rebuild(); refresh(); saveState();
          };
          document.body.appendChild(chip); handles.push(chip);
          // ANCHOR-LINE chip — sits just right of the V/H chip. Click cycles which text line the leader
          // emanates from: LAST (default) ↔ FIRST. Independent of the V/H `dir` chip (touches only
          // anchorLine, via setLeadAnchor). anchorLine flows through snapLead/__howDump + mergeLabels,
          // so COPY COORDS includes it and a reload restores it.
          const curAln = leadAnchorLine(lab.leads[i]);
          const isFirst = curAln === 'first' || (typeof curAln === 'number' && curAln === 0);
          const achip = document.createElement('div');
          achip.textContent = isFirst ? 'L1' : 'L2';                      // L1 = first line, L2 = last line
          achip.title = `${lab.id} → ${key}: leader origin line ${isFirst ? 'FIRST' : 'LAST'} — click to toggle first/last`;
          achip.style.cssText = `position:fixed;z-index:100000;transform:translate(-50%,-50%);min-width:16px;height:16px;padding:0 3px;display:flex;align-items:center;justify-content:center;border-radius:4px;background:${isFirst ? '#3cdcf0' : 'rgba(10,18,26,.92)'};color:${isFirst ? '#03110c' : '#8fb3c8'};border:1px solid #3cdcf0;font:700 10px/1 ui-monospace,monospace;cursor:pointer;pointer-events:auto;touch-action:none;left:${(sx + 40).toFixed(1)}px;top:${(sy - 15).toFixed(1)}px`;
          achip.onpointerdown = (ev) => { ev.stopPropagation(); ev.preventDefault(); };   // don't start a drag
          achip.onclick = (ev) => {
            ev.stopPropagation();
            const nowAln = leadAnchorLine(lab.leads[i]);
            const nowFirst = nowAln === 'first' || (typeof nowAln === 'number' && nowAln === 0);
            setLeadAnchor(lab, i, nowFirst ? 'last' : 'first');           // FIRST ↔ LAST
            applyLayout(); rebuild(); refresh(); saveState();
          };
          document.body.appendChild(achip); handles.push(achip);
        });
      }
      bindLabels();
    };
    // expose rebuild+refresh so the async still-image `load` handler (which re-runs applyLayout) also
    // rebuilds the editor handles + refreshes the dump — keeps everything live after a late image load.
    _editRefresh = () => { rebuild(); refresh(); };
    show();
    updateToggleUI();
    requestAnimationFrame(() => { applyLayout(); rebuild(); refresh(); });
    window.addEventListener('resize', () => { if (isOpen()) { applyLayout(); rebuild(); refresh(); } });
  }
}
