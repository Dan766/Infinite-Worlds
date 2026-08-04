# Settlement props - reference

Binding: `docs/settlement-visual-acceptance.md` (V2 yards; C6 market stalls).

## Criteria

- V2: canonical village shallow shows >=3 composed yards, each with a
  boundary/path plus >=2 non-building props. Soak counters alone insufficient.
- C6 market (with walls skill): >=6 stall prop masses in the market void.
- Vegetation context shots: `vegetation-canopy`, `vegetation-shallow` (and
  wireframe if massing claimed).

## Code anchors

| Concern | Where |
|---------|--------|
| Placement / species | `src/world/props.ts` |
| Batched meshes | `src/world/prop-mesh.ts` |
| Chunk wiring | `src/world/chunk-gen.ts`, `chunk-mesh.ts` |
| City veg refusal | curtain radius checks in `props.ts` |
| Soak floors | `scripts/soak.mjs` props SEEN / species counts |

## Launch prompt (Composer implementer)

```
Settlement props design for topic <vegetation|yards-V2|market-stalls>.

Follow `.cursor/skills/settlement-props/SKILL.md` and acceptance criteria.
Read ARCHITECTURE.md + PROGRESS (7b/V2/C6 stalls as relevant).

Constraints: deterministic hash placement; no sin/cos/pow/exp on stored verts;
respect city curtain veg rules; watch prop budgets; pure gen.

Deliver: composition plan, code, tests (+ anti-vacuity), proof PNGs, self-check.
Do NOT mark Done - hand off to v-critic with absolute PNG paths.
Model: composer-2.5-fast
```