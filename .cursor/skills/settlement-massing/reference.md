# Settlement massing - reference

Binding source: `docs/settlement-visual-acceptance.md`. If this file disagrees,
the acceptance doc wins.

## C5 landmark criteria (must show)

| Kind | Must show |
|------|-----------|
| Keep | ≥5 silhouette masses: central keep, ≥2 towers, bailey mass, gate/approach mass; towers ≥20% taller than bailey roof |
| Cathedral | ≥3 masses: nave, transept/crossing, west front/tower; top-view non-rectangular; transept width ≥125% nave width |
| Town hall | Plinth visible on ≥3 sides; frontage rule in acceptance doc; ≥2 roof height levels |
| Guildhall | Workshop mass + loading opening on approach; IoU vs barn ≤ 0.80 |
| Gatehouse | Twin towers + visible traversable opening; towers ≥125% curtain height (`WALL_HEIGHT` = 14 → tower top ≥ 17.5 above floor); no curtain mesh across opening |

Proof views per kind: `?time=3` shaded aerial, shaded approach, top-down
(`look=0,-90` or equiv), wireframe.

## V1 village criteria

| Kind | Must show |
|------|-----------|
| Cottage | Chimney closed volume with side faces in wireframe; rises ≥1 m above roof |
| Barn | Ridge length ≥150% cottage; lower eaves; entrance ≥25% front width |
| Hall | Ridge height ≥125% cottage; porch or cross-wing changes top-view silhouette |

Pairwise IoU cottage/barn/hall ≤ 0.80 (protocol in acceptance doc).

## Key code anchors

| Concern | Where |
|---------|--------|
| Landmark shells | `src/world/building-mesh.ts` → `addLandmarkBuilding` |
| Oriented volumes | `addOrientedBox` / `face` in same file |
| Lot kinds | `src/world/lots.ts` / contracts kind constants |
| Footprints | `src/world/city.ts` landmark halfW/halfD |
| Curtain / towers | `src/world/wall-mesh.ts` |
| Curtain height | `WALL_HEIGHT = 14` in `wall-mesh.ts` |
| Acceptance | `docs/settlement-visual-acceptance.md` |
| Verifier process | `.cursor/rules/settlement-visual-verifier.mdc` |

## Launch prompt (parent → Composer implementer)

```
Settlement massing design for slice <C5|V1> kind <KEEP|CATHEDRAL|...>.

Read and follow the project skill `.cursor/skills/settlement-massing/SKILL.md`
and `docs/settlement-visual-acceptance.md` criteria for this kind.
Also read ARCHITECTURE.md + the slice section in PROGRESS.md.

Constraints: pure face()/box geometry; no sin/cos/pow/exp on stored verts;
no Three in gen; determinism; stop at silhouette pass.

Deliver:
1. Named volume list with metres
2. Code in building-mesh.ts (and city.ts footprints only if required)
3. Tests with positive + anti-vacuity asserts
4. Retargeted canonical proof views + captured PNGs under shots/
5. Self-check vs numeric criteria (mass count / heights)
6. Do NOT mark Done - hand off to v-critic with absolute PNG paths

Model: composer-2.5-fast
```

## Launch prompt (parent → Composer v-critic)

```
Settlement Visual Epic verifier for slice <ID> kind <KIND>.
Read docs/settlement-visual-acceptance.md (binding), PROGRESS.md, ARCHITECTURE.md.
Inspect these PNG paths by Read (required):
  <absolute paths to shaded + wireframe proof shots>
Be ruthless. Diff-only review is invalid.
Return: Verdict REJECT|REVISE|ACCEPT; Blocking; Nits; sniff-test vs numeric
criteria; concrete edits.
```

## Volume sketch template

```
Kind: KEEP
Axes: along = street tangent, across = into lot
Volumes:
  - bailey:     along±W, across±D, y=base..baileyTop
  - gate:       ...
  - keep core:  ...
  - tower NE:   ... top >= baileyRoof * 1.2
  - tower NW:   ...
Acceptance mapping: bailey=…, gate=…, keep=…, towers=…
```