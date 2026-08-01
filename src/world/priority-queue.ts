/**
 * Keyed binary min-heap.
 *
 * The chunk queue needs three things a plain sorted array cannot give cheaply
 * at the sizes involved (hundreds of entries, re-ranked every time the camera
 * crosses a chunk boundary):
 *
 *  - pop the most urgent entry,
 *  - change an entry's priority in place (the camera moved),
 *  - remove an entry by key (it fell out of range and was cancelled).
 *
 * Equal priorities are broken by insertion order, so the queue's behaviour is
 * fully determined by the sequence of calls and is therefore unit testable.
 */

interface Node<T> {
  key: string;
  value: T;
  priority: number;
  /** Insertion counter, used only to break priority ties deterministically. */
  sequence: number;
}

export interface QueueEntry<T> {
  key: string;
  value: T;
  priority: number;
}

export class PriorityQueue<T> {
  private readonly heap: Node<T>[] = [];
  /** key -> index into `heap`, kept in sync by every sift. */
  private readonly positions = new Map<string, number>();
  private sequence = 0;

  get size(): number {
    return this.heap.length;
  }

  has(key: string): boolean {
    return this.positions.has(key);
  }

  /** Insert, or re-rank an existing key in place. */
  push(key: string, value: T, priority: number): void {
    const existing = this.positions.get(key);
    if (existing !== undefined) {
      const node = this.heap[existing] as Node<T>;
      node.value = value;
      const previous = node.priority;
      node.priority = priority;
      if (priority < previous) this.siftUp(existing);
      else if (priority > previous) this.siftDown(existing);
      return;
    }

    const node: Node<T> = { key, value, priority, sequence: this.sequence++ };
    this.heap.push(node);
    this.positions.set(key, this.heap.length - 1);
    this.siftUp(this.heap.length - 1);
  }

  /** Change priority only. Returns false if the key is not queued. */
  reprioritize(key: string, priority: number): boolean {
    const index = this.positions.get(key);
    if (index === undefined) return false;
    const node = this.heap[index] as Node<T>;
    this.push(key, node.value, priority);
    return true;
  }

  peek(): QueueEntry<T> | undefined {
    const node = this.heap[0];
    return node === undefined ? undefined : { key: node.key, value: node.value, priority: node.priority };
  }

  pop(): QueueEntry<T> | undefined {
    const top = this.heap[0];
    if (top === undefined) return undefined;
    this.removeAt(0);
    return { key: top.key, value: top.value, priority: top.priority };
  }

  remove(key: string): QueueEntry<T> | undefined {
    const index = this.positions.get(key);
    if (index === undefined) return undefined;
    const node = this.heap[index] as Node<T>;
    this.removeAt(index);
    return { key: node.key, value: node.value, priority: node.priority };
  }

  /** Snapshot in priority order. For tests and the debug panel; O(n log n). */
  toSortedArray(): QueueEntry<T>[] {
    return [...this.heap]
      .sort((a, b) => a.priority - b.priority || a.sequence - b.sequence)
      .map((node) => ({ key: node.key, value: node.value, priority: node.priority }));
  }

  clear(): void {
    this.heap.length = 0;
    this.positions.clear();
  }

  private removeAt(index: number): void {
    const last = this.heap.length - 1;
    const node = this.heap[index] as Node<T>;
    this.positions.delete(node.key);

    if (index === last) {
      this.heap.pop();
      return;
    }

    const moved = this.heap.pop() as Node<T>;
    this.heap[index] = moved;
    this.positions.set(moved.key, index);
    this.siftDown(index);
    this.siftUp(index);
  }

  /** Lower priority first; ties go to whichever was inserted first. */
  private isBefore(a: Node<T>, b: Node<T>): boolean {
    return a.priority < b.priority || (a.priority === b.priority && a.sequence < b.sequence);
  }

  private swap(a: number, b: number): void {
    const nodeA = this.heap[a] as Node<T>;
    const nodeB = this.heap[b] as Node<T>;
    this.heap[a] = nodeB;
    this.heap[b] = nodeA;
    this.positions.set(nodeB.key, a);
    this.positions.set(nodeA.key, b);
  }

  private siftUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.isBefore(this.heap[index] as Node<T>, this.heap[parent] as Node<T>)) break;
      this.swap(index, parent);
      index = parent;
    }
  }

  private siftDown(start: number): void {
    const count = this.heap.length;
    let index = start;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let best = index;
      if (left < count && this.isBefore(this.heap[left] as Node<T>, this.heap[best] as Node<T>)) {
        best = left;
      }
      if (right < count && this.isBefore(this.heap[right] as Node<T>, this.heap[best] as Node<T>)) {
        best = right;
      }
      if (best === index) break;
      this.swap(index, best);
      index = best;
    }
  }
}
