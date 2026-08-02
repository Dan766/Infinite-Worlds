/**
 * A deterministic binary min-heap over lattice cell indices.
 *
 * Extracted from `rivers.ts` in Phase 4a so the river flood and the road
 * router share one implementation. Two copies of a heap whose ORDERING is a
 * determinism guarantee is exactly the kind of duplication that drifts: the day
 * one of them loses its tie-break, the symptom is a world that regenerates
 * differently on a different engine, and a byte-comparison harness cannot tell
 * that from a real regression.
 *
 * WHY THE INDEX TIE-BREAK IS NOT TIDINESS. Both callers feed this thousands of
 * cells at exactly equal keys -- a flooded plateau for rivers, a flat plain for
 * the road router's A* frontier. Ordering by `key` alone leaves the pop sequence
 * to the heap's internal shuffling, which is stable in practice and is not a
 * property anything guarantees. RULE 1 does not accept "stable in practice", so
 * the order is `(key[i], i)`, which is total.
 *
 * The key array is held by reference, not copied. Callers mutate keys before
 * pushing a cell (the flood writes `filled[n]` then pushes `n`); they must not
 * mutate the key of a cell already in the heap, which would invalidate the heap
 * property. Both callers push each cell exactly once.
 */
export class CellHeap {
  private readonly items: Int32Array;
  private size = 0;

  constructor(
    capacity: number,
    private readonly key: Float64Array,
  ) {
    this.items = new Int32Array(capacity);
  }

  get length(): number {
    return this.size;
  }

  private before(a: number, b: number): boolean {
    const ka = this.key[a] as number;
    const kb = this.key[b] as number;
    return ka < kb || (ka === kb && a < b);
  }

  push(cell: number): void {
    let i = this.size++;
    this.items[i] = cell;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(this.items[i] as number, this.items[parent] as number)) break;
      const swap = this.items[i] as number;
      this.items[i] = this.items[parent] as number;
      this.items[parent] = swap;
      i = parent;
    }
  }

  pop(): number {
    const top = this.items[0] as number;
    this.size--;
    if (this.size > 0) {
      this.items[0] = this.items[this.size] as number;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let best = i;
        if (left < this.size && this.before(this.items[left] as number, this.items[best] as number)) {
          best = left;
        }
        if (right < this.size && this.before(this.items[right] as number, this.items[best] as number)) {
          best = right;
        }
        if (best === i) break;
        const swap = this.items[i] as number;
        this.items[i] = this.items[best] as number;
        this.items[best] = swap;
        i = best;
      }
    }
    return top;
  }
}
