/**
 * Least-recently-used cache with a hard entry cap.
 *
 * The streamer keeps chunks that have left the camera's radius here instead of
 * destroying them immediately, so turning around does not re-run the workers.
 * The cap is what makes that safe: without one, "keep chunks around in case we
 * come back" is just a leak with a friendly name, which is exactly the failure
 * the five-minute flat-heap criterion exists to catch.
 *
 * `onEvict` is where GPU resources are released. `delete` deliberately does NOT
 * call it -- deleting means the caller is taking ownership back (a cached chunk
 * re-entering the scene), and disposing it there would be a use-after-free.
 *
 * Recency order is the insertion order of a `Map`: the least recently used
 * entry is always the first one iterated.
 */

export interface LruCacheOptions<V> {
  /** Hard cap on entries. Must be at least 1. */
  maxEntries: number;
  /** Called with every entry the cache destroys. */
  onEvict: (key: string, value: V) => void;
}

export class LruCache<V> {
  private readonly entries = new Map<string, V>();
  private readonly onEvict: (key: string, value: V) => void;
  private capacity: number;
  private evictionCount = 0;

  constructor(options: LruCacheOptions<V>) {
    this.capacity = Math.max(1, Math.floor(options.maxEntries));
    this.onEvict = options.onEvict;
  }

  get size(): number {
    return this.entries.size;
  }

  get maxEntries(): number {
    return this.capacity;
  }

  /** Total entries evicted since construction. Surfaced in the HUD. */
  get evictions(): number {
    return this.evictionCount;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Read and mark as most recently used. */
  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /** Read without affecting recency. */
  peek(key: string): V | undefined {
    return this.entries.get(key);
  }

  /**
   * Insert or replace, then evict from the least recently used end until the
   * cap is respected. Replacing an existing key evicts the old value.
   */
  set(key: string, value: V): void {
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.entries.delete(key);
      if (previous !== value) this.evict(key, previous);
    }
    this.entries.set(key, value);
    this.trim();
  }

  /** Remove without destroying. The caller takes ownership of the value. */
  delete(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    return value;
  }

  /** Change the cap at runtime (debug panel), evicting immediately if it shrank. */
  setMaxEntries(maxEntries: number): void {
    this.capacity = Math.max(1, Math.floor(maxEntries));
    this.trim();
  }

  /** Keys from least to most recently used. */
  keys(): string[] {
    return [...this.entries.keys()];
  }

  /** Destroy every entry. */
  clear(): void {
    for (const [key, value] of this.entries) this.evict(key, value);
    this.entries.clear();
  }

  private trim(): void {
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) return;
      const key = oldest.value;
      const value = this.entries.get(key) as V;
      this.entries.delete(key);
      this.evict(key, value);
    }
  }

  private evict(key: string, value: V): void {
    this.evictionCount++;
    this.onEvict(key, value);
  }
}
