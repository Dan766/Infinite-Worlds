# Settlement Visual Epic — Acceptance Spec

Binding criteria for City C5–C7 and Village V1–V3. The Cursor plan is a
convenience copy; **this file wins** when they disagree.

Related: `PROGRESS.md` (Settlement Visual Epic), `.cursor/rules/settlement-visual-verifier.mdc`.

## Prerequisites (blocking before C5 or V1 code)

All of the following must be **recorded as passed** in `PROGRESS.md` (not merely
attempted):

1. `npm test` and `npx tsc --noEmit` green.
2. Full 300 s `npm run soak` on the city/walk route: **exit 0**, all budget
   ceilings and anti-vacuity floors intact (including `citiesSeen`, walls,
   interiors, layout/kind/species floors as applicable). Budget table pasted
   into `PROGRESS.md`.
3. Eye review of these captures (reviewer + date in `PROGRESS.md`) before any
   baseline replace:
   - City: `city-aerial`, `city-gate-approach`, `city-market`, `city-keep`,
     `city-farmland`
   - Village / settlement: `settlement-buildings`, `settlement-buildings-shallow`,
     `settlement-buildings-wireframe` (plus layout-specific views if present)
   - Vegetation context that frames villages: `vegetation-canopy`,
     `vegetation-shallow` (if still in `shots/canonical.json`)
4. `npm run shots:check` green against the reviewed baselines (or a documented
   intentional re-baseline after eye approval).

## Verifier process

Every slice must pass **v-critic** (Momus) with **actual rendered images**
attached (shaded + wireframe as required below). Diff-only review is REJECT.

- **Blocking** findings: must fix, then re-run v-critic (even if only docs
  changed).
- **Nit acceptance:** only the verifier (ACCEPT with nits) or Dan in
  `PROGRESS.md`. Implementers may not self-accept nits.
- **Blocker waiver:** requires either a second independent v-critic ACCEPT on
  the disputed item, or an explicit Dan override recorded in `PROGRESS.md`.
  Unilateral "critic was wrong" notes by the implementer are invalid.

Each slice's `PROGRESS.md` entry must include a **Verifier** subsection:
agent id, verdict, blockers fixed, accepted nits (who accepted), evidence PNG
paths with **sha256** hashes (required, not optional).

## Slice order and ownership

1. Prerequisites above.
2. **C5** then **V1** (serialized — both touch `building-mesh.ts`).
3. C6 → V2 → C7 → V3.

### C5 vs C6 gatehouse boundary

- **C5** owns the **gatehouse landmark shell** (twin towers + opening massing as
  a building/landmark mesh from `CityPlan` footprints).
- **C6** owns the **curtain integration**: crenellation, tower stations on the
  wall polyline, removing curtain geometry across gate indices, and aligning
  wall-mesh openings to the C5 gatehouse footprint. C6 must not invent a second
  competing gatehouse silhouette.

## Silhouette comparison protocol (IoU)

When a criterion cites grayscale silhouette IoU:

1. Capture at the canonical URL (`shots/canonical.json`), `hud=0`, fixed
   resolution **1280×720**, `time=3`.
2. Convert to grayscale; threshold to binary mask (foreground = settlement
   mesh / landmark of interest; background = sky+terrain). Document the
   threshold used in the slice notes (default: Otsu or fixed mid-gray — pick
   one and keep it for the epic).
3. Crop to the axis-aligned bounding box of the foreground; pad to square;
   resize to **256×256**.
4. IoU = intersection / union of two masks. Criterion fails if IoU exceeds the
   stated cap (e.g. 0.80).
5. Store masks + IoU number under `shots/.visual-epic/<slice>/` (gitignored OK
   if hashes are recorded in `PROGRESS.md`).

If automation is not yet scripted, a v-critic may approximate from Read of PNGs
but must still report estimated IoU and whether the shapes are obviously
same-envelope; ACCEPT requires either scripted IoU or Dan sign-off that the
manual estimate is adequate for that slice.

### Town hall frontage fallback

If the proof node has fewer than 3 townhouses, compare town-hall frontage to
**1.5 × median frontage of all non-landmark buildings** in that node; if the
node has no other buildings, use **≥18 m** absolute frontage.

## Numeric silhouette criteria

### City landmarks (C5)

For every landmark kind: `?time=3` **shaded aerial**, **shaded approach**,
**top-down** (`look=0,-90` or equivalent), and **wireframe** proof views
(add to `shots/canonical.json` if missing).

| Kind | Must show |
|------|-----------|
| Keep | ≥5 silhouette masses: central keep, ≥2 towers, bailey mass, gate/approach mass; towers ≥20% taller than bailey roof |
| Cathedral | ≥3 masses: nave, transept/crossing, west front/tower; top-view non-rectangular; transept width ≥125% nave width |
| Town hall | Plinth visible on ≥3 sides; frontage rule above; ≥2 roof height levels |
| Guildhall | Workshop mass + loading opening on approach; IoU vs barn <= 0.80 |
| Gatehouse | Twin towers + visible traversable opening; towers ≥125% curtain height; no curtain mesh across opening (curtain cut may land in C6, but C5 shell must already read as twin towers) |

### Walls / districts / farmland (C6)

- Wall approach: ≥6 alternating merlon gaps visible; towers project beyond both
  wall faces; not cube-identical to curtain sections.
- Market aerial: contiguous building-free square ≥25 m with ≥6 stall prop masses.
- Farmland aerial: ≥3 adjacent parcels with distinct boundaries; identifiable
  in grayscale (not colour-only).

### Arteries / enter (C7)

- Arteries read as continuous spines in aerial (not a scatter of 2-node stubs).
- When interior overlay is active for a landmark: **automated test** asserts
  zero exterior triangles for that landmark instance (wireframe alone is not
  enough).

### Village buildings (V1)

| Kind | Must show |
|------|-----------|
| Cottage | Chimney is closed volume with side faces in wireframe; rises ≥1 m above roof |
| Barn | Ridge length ≥150% cottage; lower eaves; entrance ≥25% front width |
| Hall | Ridge height ≥125% cottage; porch or cross-wing changes top-view silhouette |

Pairwise IoU cottage/barn/hall <= 0.80 via the protocol above.

### Yards (V2)

Canonical village shallow: ≥3 composed yards, each with a boundary/path plus
≥2 non-building props. Soak counters alone are insufficient.

### Layout readability (V3)

Protocol before V3 starts (record in slice notes):

1. Four HUD-free canonical views (one per layout), order randomized, filenames
   anonymized for the reviewer.
2. One blinded human (Dan or designated) classifies ring / linear / grid /
   hilltop.
3. Pass = **4/4**. Fail = revise massing/streets until pass. Record answers in
   `PROGRESS.md`.

## Evidence per slice

- Before/after shaded views for every new or changed canonical name
- Matching wireframe where massing is claimed; top-down where top-view criteria apply
- Diff mask or side-by-side when replacing baselines
- sha256 of each evidence PNG in the Verifier subsection

## Fail the slice if

Still reads as scaled Phase 6 gabled box; vacuous districts; soak floors without
rendered proof; quiet budget raise; Three in pure gen; `sin`/`cos`/`pow`/`exp`
on stored verts; missing Verifier subsection.