# Settlement walls - reference

Binding: `docs/settlement-visual-acceptance.md` (C6 section).

## C6 criteria

- Wall approach: >=6 alternating merlon gaps; towers project beyond both wall
  faces; not cube-identical to curtain sections.
- Market aerial: contiguous building-free square >=25 m with >=6 stall prop
  masses (stall props may be emitted with `settlement-props`; void ownership
  is C6/city plan).
- Farmland aerial: >=3 adjacent parcels with distinct boundaries; identifiable
  in grayscale.

## C5 vs C6 gate boundary

- C5: twin-tower gatehouse landmark shell.
- C6: curtain cut, crenellation, wall-tower stations, opening aligned to C5.

## Code anchors

| Concern | Where |
|---------|--------|
| Curtain / towers / merlons | `src/world/wall-mesh.ts` |
| Wall half / height / gate clear | `WALL_HALF_THICK`, `WALL_HEIGHT`, `GATE_CLEAR_M`, `WALL_BURY` |
| Plan ring / gates / towers / farms | `src/world/city.ts` |
| Collision trim | `src/world/collision.ts` |
| Berm / grade | `src/world/grading.ts` |
| Proof views | `city-aerial`, `city-gate-approach`, `*-wireframe`, `city-market`, `city-farmland` |

## Launch prompt (Composer implementer)

```
Settlement walls design for C6 topic <curtain|towers|berm|market|farmland>.

Follow `.cursor/skills/settlement-walls/SKILL.md` and C6 criteria in
`docs/settlement-visual-acceptance.md`. Read ARCHITECTURE.md + PROGRESS C6.

Constraints: pure geometry; no sin/cos/pow/exp on stored verts; keep curtain
continuous (miters); no competing wall-mesh gatehouse; determinism.

Deliver: named design, code, tests (+ anti-vacuity), proof PNGs, self-check.
Do NOT mark Done - hand off to v-critic with absolute PNG paths.
Model: composer-2.5-fast
```