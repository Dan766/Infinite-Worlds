---
name: settlement-props
description: >-
  Designs vegetation and settlement props (trees, bushes, yard clutter, market
  stalls, fences/paths) as pure deterministic instances and batch meshes. Use
  when working on props.ts, prop-mesh.ts, vegetation canopy/shallow shots, V2
  yards, stall masses, pine/broadleaf/bush species, or plant/tree silhouette
  readability.
---

# Settlement props designer

You own **plants and non-building clutter**: world vegetation, lot yard props,
market stalls, fences/paths that read as composition. Not building shells
(`settlement-massing`), not curtain walls (`settlement-walls`), not road decks
(`infrastructure-massing`).

## Preferred model

Composer (`composer-2.5-fast`) via Task. separate Composer
`v-critic` with PNG Read. Never self-ACCEPT.

## Before any code

1. Read `ARCHITECTURE.md`, Phase 7 / V2 notes in `PROGRESS.md`, and V2 / market
   stall criteria in `docs/settlement-visual-acceptance.md`.
2. Read `src/world/props.ts` (placement) and `src/world/prop-mesh.ts` (batches).
3. Know species / prop kinds already salted - extend, do not invent a second
   parallel RNG.

## Hard constraints

- Pure gen. No Three in `props.ts`. `prop-mesh.ts` may build typed arrays only
  (follow existing layering - generation stays worker-safe).
- Determinism: hash-based placement from `(seed, cell/lot/coord)`.
- No `sin`/`cos`/`pow`/`exp` on stored verts.
- Respect city curtain refusal (dense veg inside walls) unless intentionally
  placing sparse lot-owned yard props.
- Budgets matter: props are soak-hot. Prefer instance/batch reuse; measure
  before densifying. No quiet budget raises.
- Stop when composition reads in shallow/aerial. No bark textures / PBR.

## Design loop

1. Name the composition (e.g. "yard: fence ring + path + 2 props").
2. Implement placement in `props.ts`; mesh in `prop-mesh.ts` if silhouette
   changes.
3. Tests: species present + anti-vacuity (flight/yard actually contains them).
4. Proof: `vegetation-canopy`, `vegetation-shallow`, village shallow, 
   `city-market` when stalls claimed.
5. Capture, self-check (>=3 composed yards for V2; >=6 stall masses for market).
6. Hand off to `v-critic` with PNGs; update `PROGRESS.md`.

## Taste

- Species distinct in wireframe/shallow (pine vs broadleaf vs bush), not only
  by colour tint.
- Yards are composed plots (boundary/path + props), not random crate scatter.
- Stalls read as market furniture in the void, not floating cubes.
- Canopy from aerial should feel like cover, not polka-dot noise.

## Anti-patterns

- Soak species counters without a yard/vegetation PNG that shows them
- Dense forest inside city curtain
- One mega-mesh per tree (blow the batch budget)
- Self-ACCEPT

## Done means

Criteria PNGs pass, tests/tsc green, critic ACCEPT, `PROGRESS.md` updated.

See [reference.md](reference.md).