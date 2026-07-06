# World Cup Pulse — Colour & Background Research

> Design research for the two-blanket match portrait. Question 1: **how do we encode team
> identity by colour, and why?** Question 2: **the near-black background is "too black" — what
> base tone should replace it?** North star (PROJECT_LOG §1): *functional art* — real honest
> match structure, execution good enough to reach top studios, must read instantly as football
> to a broad audience.
>
> Companion mockups (open each in a browser): `color_v1_current.html`, `color_v2_flag.html`,
> `color_v3_kit.html`, `color_v4_stripes.html`, `color_v5_bg-lift.html`, `color_v6_recommended.html`.

---

## 0. The constraints this piece imposes on colour

Before weighing options, the piece's own mechanics narrow the field. Any colour scheme must survive **all** of these:

1. **Two large fields meet at a moving front.** The whole read of the piece is *"whose territory is where."* If the two colours are close, the front disappears and the piece fails at its core job. So **maximum separation between the two team colours is the #1 requirement** — more important than fidelity to any one team's "true" colour.
2. **Near-black canvas.** Very dark team colours (France navy, Germany grey #464646) risk merging into the background; very light colours (white kits) merge into the neutral set-piece white and read as "empty."
3. **White is already taken.** Corners, penalties and pitch lines use neutral white as the "moment, not territory" colour (PROJECT_LOG §1). A white team blanket collides with that meaning.
4. **Broad audience, instant read.** A layperson must map colour → nation with no legend. This favours whatever signal has the highest public recall.
5. **Gallery restraint.** "Clean, not monstrous" (§1). Rules out anything busy, high-frequency, or garish.
6. **Accessibility.** ~8% of men have a colour-vision deficiency; a piece aimed at a broad audience should not rely on hue alone for two-way distinction.

The real 2026 clash cases make this concrete. Our flagship demo is **France (blue) vs Senegal**, and the hard case is **Canada vs Morocco** — both wear red. Note the trap in the *demo itself*: Senegal's **2026 home kit is white** and their **flag is green** — so "kit colour" would turn Senegal's blanket into a pale wash on the very match we show off most.

---

## 1. The five encoding approaches

### (a) FotMob team colours — *current* (`color_v1_current.html`)
Each blanket = the team's FotMob primary hex, straight from the feed.

- **Pros:** honest to the data source; zero manual curation; usually vivid and modern; already wired into the engine (`COL_HOME`/`COL_AWAY`).
- **Cons:** **no clash defence** — Canada #D3222A vs Morocco #C1272D come through as the *same* red and the front vanishes. Some primaries are near-black (Germany #464646, France navy) and sink into the background. FotMob's "primary" is sometimes a brand/crest colour a layperson wouldn't map to the nation. Not colourblind-audited.
- **Verdict:** good **default anchor**, unacceptable as the whole answer because of clashes and dark-colour sink.

### (b) National flag colours (`color_v2_flag.html`)
Each blanket = the country's flag primary (France #0055A4, Senegal #00853F, Canada #FF0000, Morocco #C1272D).

- **Pros:** **flags are the highest-recall national signal for a broad, non-fan audience** — "France = bleu" needs no legend. Culturally "correct," reads as *nation* rather than *team brand*. Aligns with the piece being about countries at a World Cup.
- **Cons:** **does not solve clashes** — red/red stays red/red (Canada/Morocco), and flags draw from a tiny shared palette (red, white, green, blue), so collisions are *common*. Many nations are white/very-light in their flag field, giving no usable colour on a dark canvas.
- **Verdict:** the best **source of hue** for public legibility, but needs the same de-clash + canvas guard as (a).

### (c) Kit / jersey colours (`color_v3_kit.html`)
Each blanket = the 2026 home-shirt colour.

- **Pros:** most literally "on the pitch"; what a fan actually sees during the match.
- **Cons:** **kits are the worst fit for a dark canvas.** They're designed for a green stadium, not a black data field. **Senegal's 2026 home shirt is white** → their blanket becomes a grey wash that reads as "no team," and collides with the neutral set-piece white. Real matches resolve clashes by one side wearing an **away kit**, so "the kit colour" is ambiguous (which kit did we pick?). Canada/Morocco still both red.
- **Verdict:** the most authentic *idea*, the least robust *execution*. Reject as the primary scheme.

### (d) Stripes / flag-pattern fills (`color_v4_stripes.html`)
The blanket carries the flag's banding or a per-team texture — a **second channel beyond hue**.

- **Pros:** the **only approach that genuinely resolves a same-hue clash** — Canada's white flag-band reads differently from Morocco's green-pentagram weave even when the base red matches. This is exactly the **redundant-encoding** technique data-viz uses for colourblind safety (colour + texture). Richest national read of all.
- **Cons:** on soft, undulating 3D cloth with moving xG relief, **fine stripes become visual noise / moiré** and fight the "calm gallery" north star. Patterns must be broad, low-frequency and low-contrast — essentially a whisper — or they wreck the restraint.
- **Verdict:** too heavy as an *always-on* scheme, but the **right tool held in reserve** — deploy it *only* on a genuine clash, as a whisper.

### (e) Something else — perceptual anchoring + auto de-clash (the recommendation, `color_v6_recommended.html`)
Not a new *source* of colour, but a **process**: keep a real team hue, then guarantee separation and canvas-fitness algorithmically. See §4.

---

## 2. How the clash / accessibility problem is actually solved (references)

Football itself has a codified answer to "two teams, clashing colours": the **away-kit rule**. Under FIFA/UEFA equipment regulations the two teams must wear colours that clearly distinguish them from *each other and the officials*; the home side keeps its first choice and the **away side changes** (second, then third kit) until the referee judges the contrast sufficient (UEFA Equipment Regulations, Art. 9). Two lessons transfer directly:

- **Asymmetry is fine and expected.** One team (home) is the anchor; the *other* moves. We should do the same — keep one blanket's colour fixed, nudge the other.
- **"Sufficient contrast, judged perceptually," not "true colour at all costs."** The sport already prioritises *distinguishability* over fidelity. So can we, guilt-free.

Data-viz practice says the same thing two ways:

- **Redundant encoding.** Never carry meaning on hue alone. Pair colour with a second variable — shape, position, or **pattern/texture** — so a red/red pair (or a colourblind viewer) still separates. This is the textbook colourblind fix (Datawrapper, Tableau, the CatPAW colour+shape work) and it's exactly what approach (d) provides on demand.
- **Measure difference perceptually, not in RGB.** Two hex values can look identical while being numerically apart. Compare in a perceptual space (**OKLCH / CIELAB, ΔE**) to decide whether a pair actually clashes.

**How top studios/publications handle team colour + dark canvases:**

- **FiveThirtyEight** (soccer SPI era) leaned on a **small, controlled team palette** and reached for **blue/orange and blue/red** — pairs that survive all common colour-blindness types — rather than trusting raw brand colours. Their lesson: *curate the pair, don't just inherit it.*
- **The Athletic** uses club/nation colour as an accent but sits it on **restrained, near-neutral** backgrounds and keeps the two sides clearly separated in lightness, not just hue.
- **Nadieh Bremer / Visual Cinnamon** (multiple *Information is Beautiful* wins, NYT/UNESCO work): custom per-dataset palettes, **avoids "pure" hues**, and her dark pieces sit on a **lifted, slightly-hued near-black** with soft luminance gradients — never flat #000. This is the direct reference for our background fix.
- **The Pudding / NYT graphics**: dark editorial pieces use a **deep neutral or faintly-tinted charcoal** with a gentle centre-glow, so the artwork appears lit rather than cut out of a void.

---

## 3. The "too black" background — concrete recommendation (`color_v5_bg-lift.html`)

Pure `#000000` and the current `#05070d` read as a **harsh void**: no atmosphere, and the cloth edge is a hard cut against nothing. General dark-mode guidance in data-viz (storytelling-with-data, Datawrapper, Material dark-surface `#121212`) is unanimous: **don't build on true black.** Use a lifted dark surface (L ≈ 8–14), keep text off pure white (`#F0F0F0`-ish, we use `#e9e7f4`), and let a faint gradient add depth.

For *this* piece specifically:

| Tone | Hex | Read |
|---|---|---|
| Pure black | `#000000` | Harsh void, edges cut — reject |
| **Current** | `#05070d` | Still essentially a void |
| Lifted neutral | `#12141a` | Calmer graphite, but flat/cold |
| **RECOMMENDED** | `#101625` → `#0b0f18` | Lifted deep **plum-navy**, reverse-vignette |
| Warm charcoal | `#16130f` | Subtle warmth, off-brand for this piece |
| Too lifted | `#1c2333` | Blankets stop glowing — too far |

**Recommendation:** replace `#05070d` with a **lifted deep plum-navy, `#101625` at centre easing to `#0b0f18` at the edges** — a soft *reverse* vignette so the middle glows a touch above the corners (the "lit gallery wall" effect). This:

- gives **dark team colours (France navy, Germany grey) an edge to sit against** instead of merging into a black hole;
- adds the **premium atmosphere** the piece is chasing, without stealing focus from the blankets;
- stays **within the plum-navy identity** already used in the HUD (`vB2` used `#17102e` family);
- composes cleanly with the engine's existing **chroma-gated score-tint** sky glow (a clearly-coloured leader can still warm the base without a grey leader turning it black — PROJECT_LOG §5).

Keep the vignette subtle (ΔL of a few percent), and keep all UI text at `#e9e7f4`, never `#ffffff`.

---

## 4. RECOMMENDATION — anchored hue + automatic de-clash on a lifted base (`color_v6_recommended.html`)

**Do not pick one source of colour. Pick a process, anchored on real colour.** Concretely:

1. **Anchor = FotMob team colour** (fall back to flag colour when FotMob's is a low-recall brand hue). Honest to the data, looks right for ~80% of pairings, minimal churn to the engine.
2. **Measure the pair perceptually.** Convert both to **OKLCH/LAB**; compute hue gap + **ΔE**. If they're already well separated → ship as-is (e.g. France vs Senegal: navy vs green, no intervention).
3. **De-clash by moving the AWAY team** (mirrors football's away-kit rule). Rotate the away hue within its own family (red → crimson/maroon) and **split lightness** (one lighter, one darker) until separated. Never invent an off-brand colour — bias *within* the nation's palette.
4. **Guard the canvas.** Clamp lightness so neither blanket is near-black *or* near-white against the lifted base: pull Germany's grey up, pull a white-kit team toward an off-white with a hint of the flag hue, so both blankets always **glow** and neither collides with set-piece white.
5. **Flag whisper only on a true, unresolvable clash.** When hue rotation can't separate them enough (deep red vs deep red), add a **very low-contrast flag-band/star texture** (approach *d*) as a second channel — colourblind-safe, off by default, a whisper not stripes.
6. **Lifted plum-navy base** from §3 under all of it.

**Why this wins against the north star:**

- **Reads instantly as football / nations** — keeps recognisable national hues (blue France, green Senegal, red Canada) rather than an arbitrary categorical palette.
- **Never breaks on a clash** — the piece's core job (a legible possession front) is *guaranteed*, which raw FotMob (v1) and raw flag (v2) can't promise.
- **Survives the dark canvas** — the lightness guard + lifted base stop dark/white teams from disappearing, which raw kit (v3) fails badly (Senegal white).
- **Colourblind-safe by construction** — perceptual ΔE separation + the pattern fallback are exactly the redundant-encoding techniques the field prescribes.
- **Stays a whisper** — pattern is the exception, not the rule, so the "clean, gallery" restraint holds. It looks like art, with the honesty done quietly underneath — *functional art.*

**Runner-up:** national **flag colours** (v2) as the anchor instead of FotMob, if the team wants the piece to read explicitly as *countries* over *clubs/brands* — but it still needs steps 2–6 bolted on. **Reject** kit colours (v3) as a primary scheme (white-kit failure, away-kit ambiguity). Keep **stripes** (v4) strictly as the on-demand clash tool, never always-on.
