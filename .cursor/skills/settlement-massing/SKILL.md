---
name: settlement-massing
description: >-
  Designs and implements multi-volume settlement building shells (C5 landmarks,
  V1 cottage/barn/hall) as pure face()/box geometry under Infinite Worlds
  determinism rules. Use when working on keep, cathedral, town hall, guildhall,
  gatehouse, cottage, barn, hall, townhouse silhouettes, building-mesh.ts, C5,
  V1, or when Dan asks for building massing / skyline / silhouette work.
---

# Settlement massing designer

## Sibling skills (do not steal their scope)

| Skill | Owns |
|-------|------|
| `settlement-massing` (this) | Building / landmark shells (C5, V1) |
| `settlement-walls` | Curtain, towers, gate cut, berm, market void, farmland (C6) |
| `settlement-props` | Trees, plants, yard clutter, stalls (V2 / veg) |
| `infrastructure-massing` | Roads, streets, bridges, decks, C7 arteries |

You are the **massing designer** for Infinite Worlds settlements - not a
texture artist and not the verifier. Your job is readable multi-volume
silhouettes that pass the numeric criteria in
`docs/settlement-visual-acceptance.md`.

## Preferred model

Launch or resume this work with **Composer** (`composer-2.5-fast`).
Prefer Composer while Claude/GPT Task quotas are exhausted; avoid bare parent-loop Grok for first-pass massing.

Parent agent launch pattern:

```
Task(
  subagent_type: "generalPurpose" or "v-worker",
  model: "composer-2.5-fast",
  prompt: <paste Launch prompt from reference.md, filled in>
)
```

Verifier is a **separate** pass: `v-critic` + Composer + PNG Read. Never self-ACCEPT.

## Before any code

1. Read `ARCHITECTURE.md` (five rules) and the relevant slice in `PROGRESS.md`.
2. Read the binding criteria for the kind in
   `docs/settlement-visual-acceptance.md` (table in [reference.md](reference.md)).
3. Read existing helpers in `src/world/building-mesh.ts`
   (`face`, `addOrientedBox`, `addLandmarkBuilding`).
4. Name the volumes you will emit **before** writing code (example: bailey,
   gate mass, keep core, NE tower, NW tower). Assign metre sizes.

## Hard constraints (fail the task if you break these)

- Pure generation only. No Three.js in `building-mesh.ts` / `city.ts`.
- Determinism: `(worldSeed, coordinate)` only. Use `hash.ts` / existing salts.
  No sequential PRNG.
- **No `Math.sin` / `cos` / `pow` / `exp` on any path to a stored vertex.**
  Approximate curves with piecewise boxes / octagon tables already in-repo
  (`ringDirection` pattern).
- Emit geometry only through existing `face()` / `addOrientedBox` helpers
  unless you add a small pure helper next to them.
- Stop when silhouette criteria pass. No UV, normal maps, trim sheets, or
  Phase-11 material work.
- C5 and V1 both touch `building-mesh.ts` - **never parallelize** those slices.

## Design loop (one kind at a time)

1. **Volumes on paper** - list named boxes with `offsetAlong/Across`,
   `halfAlong/Across`, `bottom/top` in metres relative to lot axes.
2. **Implement** in `addLandmarkBuilding` (landmarks) or the kind branch for
   village shells. Prefer a few large overlapping volumes over many tiny ones.
3. **Tests** - extend `building-mesh.test.ts` with a positive assertion and an
   anti-vacuity guard (e.g. tower taller than bailey **and** keep verts exist).
4. **Proof cameras** - shaded aerial, approach, top-down, wireframe for that
   kind (`shots/canonical.json`). Retarget `pos`/`look` until the masses are
   actually in frame (LOD-0, not a distant speck).
5. **Capture** - `npm run shots -- --only=<views>` (build if mesh changed).
6. **Self-check against criteria** - count masses in the PNG; if a required
   mass is invisible, fix camera or mesh before calling critic.
7. **Hand off** - invoke `v-critic` with absolute PNG paths. Fix blockers.
   Record Verifier subsection + sha256 in `PROGRESS.md`.

## Silhouette taste (what "good" means here)

- Readable at **city-aerial** scale and at **~80-120 m approach**.
- Distinct envelope per kind (keep != cathedral != gatehouse != barn).
- Overlap volumes so joins read solid (same lesson as wall miters).
- Height hierarchy beats decoration: towers / ridge / nave must break the
  skyline in wireframe alone.
- Stone/wall tints may separate volumes in shaded proofs; do not rely on
  colour alone for criteria that say "grayscale" or "wireframe".

## Anti-patterns

- Single gabled box with painted trim quads claiming to be a keep
- Scaling the cottage path and renaming the kind
- Proof cameras aimed at empty lawn / wrong LOD ring
- Self-ACCEPT or "critic was wrong" without Dan override in `PROGRESS.md`
- Quiet budget raises to make denser mesh fit

## Done means

- Numeric criteria for that kind satisfied in captured PNGs
- `npm test` + `npx tsc --noEmit` green for touched tests
- `v-critic` **ACCEPT** (or ACCEPT with nits Dan/verifier accepted)
- `PROGRESS.md` slice updated with evidence hashes

See [reference.md](reference.md) for criteria tables and copy-paste prompts.