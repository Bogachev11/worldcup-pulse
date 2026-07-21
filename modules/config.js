// stage13 — CONFIG factory + the goal-flood phase constants it seeds from.
// Extracted VERBATIM from stage13.js. DEFAULTS() returns a fresh literal each call
// (pure), so it is a no-op to move it here. The three FLOOD_* durations live here too
// because DEFAULTS() reads FLOOD_HOLD_DEFAULT_S; keeping them in one module means one
// source of truth (the wave engine imports the same constants back into stage13).

// GOAL-FLOOD phase durations in SECONDS of wall time (see goalFloodAt). Declared
// here so DEFAULTS() can seed cfg.A.floodHold without a temporal-dead-zone error.
// STAGE11 CHANGE #4 — the goal is now a directional WAVE, not a uniform flood. These
// PHASE durations (WALL seconds) shape it (see goalWaveAt):
//   ROLL  — X's colour rolls from midfield toward end E and fully covers the conceded
//           side (the front sweeps to the E extreme). A READABLE roll, not a snap.
//   FLATTEN — a brief height level-out (the relief eases flat) once the side is covered.
//   RESET — the front eases back to the MIDDLE (50/50, kickoff) and normal play resumes.
// Kept as FLOOD_* names for minimal churn downstream. No held freeze (change #3).
export const FLOOD_SWEEP_S = 0.9;      // ROLL: colour rolls to fully cover the conceded end
export const FLOOD_HOLD_DEFAULT_S = 0.6;   // FLATTEN: brief height level-out at full cover
export const FLOOD_RELAX_S = 1.8;      // RESET: front eases back to centre (kickoff)

// ============================================================================
// CONFIG — every layer's enable flag + its own knobs. This whole object is what
// gets serialised to the URL hash / COPY CONFIG and restored from a preset.
// ============================================================================
export const DEFAULTS = () => ({
  // 1.0 = the intended ~15s dramatic-time pass (DRAMA_TOTAL_S). The slider is now a
  // global tempo trim on that pass, not a linear match-minute rate.
  speed: 1.0,
  // SHOOTOUT choreography timing (post-match penalties) — adjustable in the left panel:
  // pause0 = seconds of stillness after the match before the 1st kick; gap = seconds between kicks.
  shoot: { pause0: 0.8, gap: 1.7 },   // pause0 = stillness after full time before the 1st kick — kept SHORT (was 2.4) so the shootout starts promptly
  // A · TWO TEAM BLANKETS (одеяла) — one cloth per team, meeting at an
  //  activity-shaped front with a small НАХЛЁСТ overlap. Height per team = amplitude
  //  · Σ ENABLED contributors through the asymmetric atk/rel envelope on the grid.
  //  height=amplitude, atk=attack/rise τ, rel=release/decay τ, grid=detail,
  //  blur=smoothing, colour=intensity, sharp=hill contrast/gamma, floor=threshold,
  //  lap=НАХЛЁСТ ▸ глубина (finite OVERLAP depth, fraction of pitch length: each
  //  opaque sheet tucks this far PAST the front under the other). cOWN..cALL =
  //  contributor on/off; wOWN..wALL = weights.
  A: {
    on: true, open: false, atk: 0.15, rel: 1.6, grid: 0.45, height: 7.0,
    colour: 1.0, blur: 0.75, sharp: 1.0, floor: 0.0, lap: 0.005,
    // КРОМКА ▸ подъём — LIP HEIGHT (world-Y) of the fabric fold where the TOP
    // blanket laps OVER the under one at the seam. A SHORT, thin folded edge so the
    // two blankets read as two separate sheets (one over the other) WITHOUT a tall
    // wall that would cross through a hill near the front. The possessor laps on top.
    // 0 = flush (no lap), ~0.1 = a thin clean fold, up to 0.35 = a deeper lap.
    lipH: 0.01,
    // МИН. ТЕРРИТОРИЯ ▸ у ворот — each team ALWAYS keeps a guaranteed band of
    // ownership around ITS OWN goal line (home own-goal at u≈0, away at u≈1), so
    // the opponent can never take the whole pitch in normal play. The contested
    // front lives between the two bands and can be pushed deep, but never erases
    // the defender's band. Fraction of pitch LENGTH per team. Overridden only by
    // the celebratory goal-flood. 0 = no guaranteed band (old behaviour).
    ownBand: 0.13,
    // ЯРКОСТЬ ЦВЕТА — emissive strength of the FLAT painted territory. The
    // coverage colour lies flat on the pitch (no tall body), so under scene
    // lighting it would render dark; this glow term makes it read VIVID team
    // colour regardless of height. 0 = lit only, ~1 = strong glow.
    glow: 1.0,
    // xG SPIRE (kept — but ONLY at real shots). xgW = spire WIDTH (scales the xG
    // stamp radius), xgH = spire HEIGHT (scales the crest term). The spire stands
    // at each REAL shot's pitch spot and fades a couple seconds after; NO spire
    // appears anywhere there was no shot.
    xgW: 1.0, xgH: 1.0,
    // ФОКУС ▸ зона игры — radius of the spatial focus mask that anchors the
    // HEIGHT relief to the single live play locus (ballAt(t)). Tight = one
    // coherent swell where play is; wide → approaches the old free-form field.
    // Colour/coverage stay BROAD; only height is gated. 0..1 → σ in world units.
    focus: 0.2,
    // ГОЛ ▸ держать заливку — how long the celebratory goal-flood HOLDS the
    // scorer's colour over the whole pitch, in SECONDS of wall time (at the
    // current speed). Default 3s (was ~1.2). Sweep-in/relax are fixed.
    // BRISK-SETTLE (2026-07-14): shrunk from 0.6 → 0.2. The FLATTEN phase pins the seam at the
    // conceded end AND presses the relief flat; while the drama-clock DWELLS on the goal (minute
    // frozen) that made a DEAD ~1-2s window where nothing moved (owner: «зависает на 1-2 сек»). A
    // short 0.2s apex touch reads the flood without a static plateau; the goal then retreats to
    // centre continuously. NO-POST-GOAL-STATIC (2026-07-14): the minute DWELL (goalRoom in
    // buildDramaticClock) is now CAPPED at ≈ this flood-settle duration and its post hump tightened
    // (GOAL_SIG_POST 0.6→0.28), so the minute RESUMES as the seam reaches centre instead of creeping
    // on past the hand-off — that residual creep was the seam-freeze «зависает на 1-2 сек». The flood
    // plays over WALL time (independent of the minute), so shortening the dwell does NOT shorten it.
    // ARG-EGY HOLD RESTORE (2026-07-15): 0.2 → 0.45. Owner: «держание гола как в эталонной Аргентина-
    // Египет — там все тайминги ПО ЭТОЙ ЧАСТИ были идеальными». The 5ef986b reference held the flood
    // peak longer (floodHold 0.6 + lull 0.5 = 1.1s FLATTEN). We restore as much of that HELD feel as the
    // anti-freeze gate allows: the FLATTEN static window (floodHold+lull, seam pinned at the conceded end
    // while the minute is frozen) must stay ≤0.5s or hangScan FAILs (it reads the same as the old «зависает
    // на 1-2 сек» freeze). So floodHold=0.45 (max under the gate), lull kept 0 — the rest of the arg-egy
    // «held» feel comes from the slower goalReset (1.1→1.8, pure MOTION, no static) + the longer wave.
    floodHold: 0.45,
    // ГОЛ ▸ ПАУЗА (штиль после гола) — after the flood recedes, a LONGER calm
    // breather where the colour settles AND the relief flattens toward ~0 (the
    // surface "выпрямилось, обнулилось") for this many SECONDS of wall time, then
    // normal play resumes. Coordinated with the dramatic clock so the goal beat
    // gets its room. 0 = no post-goal lull (old behaviour).
    // BRISK-SETTLE (2026-07-14): 0.5 → 0.0. The separate held-flat «штиль» plateau added a second
    // dead interval on top of FLATTEN (both pin the seam + hold the relief melted). Removing it
    // keeps the post-goal motion continuous (roll → brief apex → brisk retreat) with no static gap.
    lull: 0.0,
    // ── GOAL CREST + POST-GOAL TIMING (all adjustable in the panel) ──────────────
    // goalH   — HEIGHT of the dedicated goal spire, SEPARATE from the xG spire (xgH).
    //           Rendered from its OWN grid (A_gH/A_gA) so a goal can tower above or sit
    //           below the xG peaks independently. World-Y units.
    goalH: 7.5,
    // goalHold — hold the goal spire AT ITS PEAK for this many WALL seconds before it
    //           decays (rise → HOLD → decay). Rendered outside the lull-flatten so the
    //           held peak isn't pressed down by the post-goal штиль.
    goalHold: 1.3,
    // goalReset — the front's ROLLBACK-to-centre duration after the flood (was the hard
    //           FLOOD_RELAX_S). Wall seconds.
    // BRISK-SETTLE (2026-07-14): 1.8 → 1.1. The retreat-to-centre after a goal was too SLOW (owner:
    // «очень медленный откат на центр»); make it fairly fast like the ET-goal pace he likes. Still a
    // smooth eased sweep, just brisker.
    // ARG-EGY HOLD RESTORE (2026-07-15): 1.1 → 1.8 (= the 5ef986b reference). Owner wants the goal HELD
    // like arg-egy; the dominant «held/lingering» lever is this rollback-to-centre duration. A slower
    // 1.8s ОТКАТ makes the scorer's colour recede to centre luxuriously (the goal «sits»), matching the
    // reference feel. This is pure MOTION (the front eases endE→centre), so it does NOT add any static
    // window — hangScan is unaffected. The eased seam RELEASE after the beat (KICK_RELEASE_S=1.0, ease-
    // out) is KEPT — we are NOT reintroducing 5ef986b's 0.15s hard snap (that was the «странная позиция»).
    goalReset: 1.8,
    // goalPause — the KICKOFF-HOLD: after the seam levels to CENTRE (seams выровнялись) the front
    //           RESTS at centre, cover full, for this many WALL seconds — a small intentional exhale
    //           before play resumes. On top of the auto goal room. Wall seconds.
    // BRISK-SETTLE (2026-07-14): 0.3 → 0.1 killed the post-goal freeze.
    // 0.3s-BEAT (2026-07-14): 0.1 → 0.3. Owner: «небольшую паузу после выравнивания швов всё-таки
    // можно сделать, типа 0,3 сек» — a small ~0.3s beat once the blankets settle to centre, then
    // resume. NOT the old 1-2s freeze; the minute-dwell (goalRoom) is extended by exactly this beat
    // so the minute stays frozen THROUGH the centre-hold and resumes right after it. Applies to a
    // scored penalty too (it settles to centre like a goal → same beat).
    // LONGER-EXHALE (2026-07-14): 0.3 → 0.45. Owner wanted the beat «чуточку больше» — a touch more
    // room after the seams level, still a deliberate exhale (≤~0.5s), NOT the old dead 1-2s freeze.
    // goalRoom (buildDramaticClock) derives from this (0.9·(settleToCentre+goalPause)=2.385s < its
    // 2.4 cap), so the minute-dwell extends with it and the beat is not cut off.
    goalPause: 0.45,
    // ВЫПАД ▸ сила — THRUST FINGER strength. A FAST FORWARD pass by the attacking
    // team makes the colour front STAB FORWARD as a sharp, narrow FINGER of that
    // team's colour into the opponent half (in the PLANE of the blanket — the
    // front(v) boundary moving forward, NOT a vertical height peak). Forward
    // distance (endX−x in the team's attacking frame) is the primary signal, boosted
    // for through/long balls and for passes that gain ground QUICKLY (fast counter).
    // The finger appears almost immediately and decays on its OWN fast half-life
    // (~few seconds), so an unsustained foray recedes fast while a sustained attack
    // lets the SLOW territorial base catch up and consolidate. 0 = off (front stays
    // the smooth lateral tide). Default keeps counters clearly visible but not noisy.
    thrust: 1.5,
    // ── TERRITORIAL DRAMA in the DRAMATIC CLOCK (A + a pinch of B) ───────────────
    // The dramatic warp used to slow ONLY for shots/goals, so a sharp forward
    // penetration (a «выпад» finger) that ends without a shot got ZERO room → the
    // clock raced past it and the transient finger was smeared away. These feed the
    // SAME penetration signal the finger uses into the importance curve I(t), so the
    // clock lingers a beat wherever a real deep thrust happens (verifiable structure,
    // not decoration — the core of the piece).
    // penImp — how much dramatic ROOM a penetration earns (0 = old behaviour, off).
    penImp: 1.0,
    // penMin — min forward gain (u-units) for a pass to COUNT as a penetration. LOWER
    // = more thrusts qualify (the «побольше» dial); HIGHER = only the deepest.
    penMin: 0.10,
    // thrustHold — (pinch of B) the finger's HALF-LIFE in wall-seconds. LONGER = the
    // finger lingers and survives fast playback instead of being averaged out.
    thrustHold: 4.0,
    // xgImp — how strongly a SHOT'S xG dilates the dramatic clock. The xG spire is a
    // tall peak that gets SMEARED on fast playback unless the clock lingers on it. The
    // importance is now STEEPLY xG-weighted (low base, steep xG term) so a DANGEROUS
    // chance earns real room and its spire plays out, while a positional/fruitless shot
    // barely slows the clock — the piece distinguishes danger from possession. 0 = flat.
    xgImp: 1.0,
    // streakK — EMOTIONAL ESCALATION: how much a RUN of dangerous moments amplifies each
    // shot's xG crest (consecutive chances build taller → the match's emotional swings).
    // 0 = off (each chance stands alone).
    streakK: 0.4,
    // dangerPush — how hard a DANGEROUS shot pushes the TERRITORY (front) toward the attacked
    // goal, so a side with the better CHANCES on the counter shows on the cloth even without
    // the ball. Higher = counters/threat win the territory over tame possession. Fixes «теряем
    // контратаки». 0 = danger doesn't move territory (possession-only).
    dangerPush: 1.5,
    // dangerFlood — a dangerous NON-goal shot briefly washes the WHOLE field toward the
    // shooter's colour (soft mini-goal-flood), so the more dangerous side «пробивает всем
    // цветом» during its chances (NOT a local island in the opponent's half). 0 = off.
    dangerFlood: 0.7,
    // УГЛОВЫЕ (STAGE11) — corner-ripple layer. cCorner on/off; wCorner strength
    // (0..~2, ×CORNER_AMP). When cCorner is off there is NO corner ripple/tint at all.
    // Old cfgs without these keys default to on + the reduced strength (loads gracefully).
    // Default 1.0 = the reduced CORNER_AMP (see CORNER_STRENGTH_DEFAULT below; inlined
    // here as a literal to avoid a temporal-dead-zone at module init, like FLOOD_HOLD).
    cCorner: true, wCorner: 0.02,
    // ОТМЕТКИ ▸ ВЫСОТА (STAGE11 CHANGE #5) — vertical position of the goal-token row
    // above the pitch. 0 = low (near the field), 1 = high (top of the screen). Purely
    // a 2D-overlay layout knob (see drawMarkers).
    markerH: 0.55,
    // contributors (☑ default = true): which signals RAISE a team's blanket.
    // The general relief (Владение/Продвижение/…) is now capped to GENTLE LOW
    // MOUNDS — the ONLY tall spires in the scene are the real xG shot crests
    // (cXg, placed exactly at each shot's pitch spot; see contribLift/computeA).
    cOwn: true,  wOwn: 1.0,   // Владение — on-ball control density
    cXg: true,   wXg: 1.0,    // Удары · xG — sharp tall crest at the REAL shot spot, ×xg
    cProg: true, wProg: 1.0,  // Продвижение — final-third / box entries, forward passes
    cPass: false, wPass: 1.0, // Пасы — pass density
    cDuel: false, wDuel: 1.0, // Единоборства — Tackle/Aerial/Challenge/Interception/Dispossessed
    cDrib: false, wDrib: 1.0, // Обводки — TakeOn
    cAll: false,  wAll: 1.0,  // Общая активность — all events
  },
  // B · pass relief (fine overlay)
  //  height=amplitude, atk=attack/rise τ, rel=release/decay τ, aggr=aggregation,
  //  longw=long-pass weight, opacity=intensity, sharp=contrast/gamma.
  B: { on: true, open: false, atk: 0.12, rel: 1.2, aggr: 0.5, height: 0.6, longw: 0, opacity: 1.0, sharp: 1.0 },
  // C · live locus comet
  //  hop=amplitude (ride height), size=orb size, trail=trail length (min),
  //  twidth=trail width, bright=brightness, fade=trail fade.
  C: { on: true, open: false, trail: 0.5, size: 1.0, bright: 1.0, hop: 1.0, twidth: 1.0, fade: 1.0 },
  // D · event accents
  //  amp=shot-spike amplitude, beam=beam length to goal, spark=duel spark size,
  //  marker=corner/foul marker size, fade=lifetime, + per-type sub-toggles.
  D: { on: true, open: false, amp: 1.0, beam: 1.0, spark: 1.0, marker: 1.0, fade: 1.0, shots: true, duels: true, corners: true, fouls: true },
});

// the "Матч" combo is the default startup state (A+B+C+D all on).
export const MATCH_DEFAULT = () => DEFAULTS();
