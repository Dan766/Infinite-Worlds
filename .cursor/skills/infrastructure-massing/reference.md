# Infrastructure massing - reference

Binding: `docs/settlement-visual-acceptance.md` (C7 arteries); road phases in
`PROGRESS.md` / `ARCHITECTURE.md` module map.

## Criteria / claims

- C7: arteries read as continuous spines in aerial (not scatter of 2-node stubs).
- Road/bridge/ford/bench views in `shots/canonical.json` must stay meaningful
  when mesh changes (re-baseline only after eye review).
- Determinism / seam tests in `roads.test.ts`, `streets.test.ts`,
  `road-mesh.test.ts`, `grading.test.ts`.

## Code anchors

| Concern | Where |
|---------|--------|
| Region roads / settlements | `src/world/roads.ts` |
| Sector streets / layouts | `src/world/streets.ts` |
| Deck / bridge mesh | `src/world/road-mesh.ts` |
| Grading / bench | `src/world/grading.ts` |
| City gate attachment | `nearestCityGate` in `city.ts` |
| Proof examples | `road-bridge`, `road-benched-hillside`, `deck-lod-aerial`, `city-aerial` |

## Launch prompt (Composer implementer)

```
Infrastructure massing for topic <roads|streets|bridge|deck|C7-arteries>.

Follow `.cursor/skills/infrastructure-massing/SKILL.md`.
Read ARCHITECTURE.md (tier rule) + PROGRESS + C7 criteria if claimed.

Constraints: correct tier ownership; determinism/seams; no sin/cos/pow/exp on
stored verts; city roads end at gates; pure gen for plans.

Deliver: tier+claim, code, tests (+ anti-vacuity), proof PNGs, self-check.
Do NOT mark Done - hand off to v-critic with absolute PNG paths.
Model: composer-2.5-fast
```