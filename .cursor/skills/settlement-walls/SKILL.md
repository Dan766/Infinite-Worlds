---
name: settlement-walls
description: >-
  Designs city curtain walls, towers, gate clearances, berm grading, market
  voids, stalls, and farmland stamps (C6) as pure deterministic geometry. Use
  when working on wall-mesh.ts, city wall rings, crenellations, wall towers,
  GATE_CLEAR, berms, market districts, farmland parcels, city-gate-approach,
  city-aerial fortification, or C6 wall/district visual work.
---

# Settlement walls designer

You own **fortification + city district ground plane** massing for Infinite
Worlds - curtain, towers, gate openings, berms, market voids/stalls, farmland
stamps. Building landmark shells are **not** your job (use
`settlement-massing`). Vegetation/yard clutter is **not** your job (use
`settlement-props`).

## Preferred model

Composer (`composer-2.5-fast`) via Task `generalPurpose` or
`v-worker`. Verifier is a separate Composer `v-critic` with PNG Read. Never
self-ACCEPT.

## Before any code

1. Read `ARCHITECTURE.md`, C6 notes in `PROGRESS.md`, and C6 criteria in
   `docs/settlement-visual-acceptance.md` (see [reference.md](reference.md)).
2. Read `src/world/wall-mesh.ts`, gate/collision trim in `collision.ts`, and
   relevant `city.ts` plan fields (`wallX/Z`, `gateIndex`, `towerIndex`,
   districts, farmland).
3. Sketch the change as named volumes / ribbon rules before coding.

## Hard constraints

- Pure gen only. No Three in `wall-mesh.ts` / `city.ts` / `grading.ts`.
- Determinism via `hash.ts`. No sequential PRNG.
- No `sin`/`cos`/`pow`/`exp` on stored verts (`ringDirection` / boxes / miters).
- Curtain must stay **continuous**: miter non-gate corners; square butts + end
  caps only at `GATE_CLEAR_M` openings. Do not regress to open slab wedges.
- C6 must not invent a second gatehouse silhouette - C5 owns the landmark shell;
  you own the curtain cut and tower stations.
- Stop at silhouette / aerial readability. No Phase-11 materials.

## Design loop

1. Name the change (e.g. "miter ribbon", "berm apron", "market void 30m").
2. Implement in `wall-mesh.ts` / `city.ts` / grading as needed.
3. Match collision clearance to mesh (`collision.ts` + `GATE_CLEAR_M`).
4. Tests: positive + anti-vacuity (continuity, gate empty, tower projection,
   market void size, farmland parcel count).
5. Proof shots: `city-aerial`, `city-gate-approach` (+ wireframe),
   `city-market`, `city-farmland` as claimed.
6. Capture, self-check criteria, hand off to `v-critic` with PNG paths.
7. Update `PROGRESS.md` Verifier subsection + sha256.

## Taste

- Curtain reads as one fortification, not dashed segments.
- Towers project past both faces; not cube-identical to curtain sections.
- Gate opening aligns to C5 gatehouse; road terminates at the gate.
- Market void is a real empty square, not sparse luck.
- Farmland parcels readable in grayscale, not colour-only.

## Anti-patterns

- Open corner wedges / missing miters
- Wall-mesh gatehouse box competing with C5
- Whole-segment holes instead of `GATE_CLEAR_M` trim
- Soak floors without rendered district proof
- Quiet budget raises

## Done means

Criteria PNGs pass, tests/tsc green, `v-critic` ACCEPT, `PROGRESS.md` updated.

See [reference.md](reference.md).