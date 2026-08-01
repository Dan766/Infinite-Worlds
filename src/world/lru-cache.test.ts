import { describe, expect, it } from 'vitest';
import { LruCache } from './lru-cache';

function makeCache(maxEntries: number): { cache: LruCache<string>; evicted: string[] } {
  const evicted: string[] = [];
  const cache = new LruCache<string>({
    maxEntries,
    onEvict: (key) => evicted.push(key),
  });
  return { cache, evicted };
}

describe('LruCache', () => {
  it('never exceeds its cap', () => {
    const { cache } = makeCache(3);
    for (let i = 0; i < 100; i++) cache.set(`k${i}`, `v${i}`);
    expect(cache.size).toBe(3);
  });

  it('evicts the least recently used entry, and only that one', () => {
    const { cache, evicted } = makeCache(3);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.set('c', 'C');
    cache.set('d', 'D');
    expect(evicted).toEqual(['a']);
    expect(cache.keys()).toEqual(['b', 'c', 'd']);
  });

  it('counts as recent on get, but not on peek', () => {
    const { cache, evicted } = makeCache(3);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.set('c', 'C');

    expect(cache.get('a')).toBe('A');
    cache.set('d', 'D');
    expect(evicted).toEqual(['b']);

    expect(cache.peek('c')).toBe('C');
    cache.set('e', 'E');
    expect(evicted).toEqual(['b', 'c']);
  });

  it('delete removes without destroying, because the caller takes ownership back', () => {
    const { cache, evicted } = makeCache(3);
    cache.set('a', 'A');
    expect(cache.delete('a')).toBe('A');
    expect(cache.has('a')).toBe(false);
    expect(cache.size).toBe(0);
    expect(evicted).toEqual([]);
    expect(cache.delete('a')).toBeUndefined();
  });

  it('destroys the old value when a key is replaced', () => {
    const { cache, evicted } = makeCache(3);
    cache.set('a', 'first');
    cache.set('a', 'second');
    expect(evicted).toEqual(['a']);
    expect(cache.size).toBe(1);
    expect(cache.peek('a')).toBe('second');
  });

  it('does not destroy on a no-op replacement with the identical value', () => {
    const { cache, evicted } = makeCache(3);
    cache.set('a', 'same');
    cache.set('a', 'same');
    expect(evicted).toEqual([]);
  });

  it('destroys everything on clear', () => {
    const { cache, evicted } = makeCache(4);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.clear();
    expect(evicted).toEqual(['a', 'b']);
    expect(cache.size).toBe(0);
  });

  it('evicts immediately when the cap shrinks', () => {
    const { cache, evicted } = makeCache(5);
    for (const key of ['a', 'b', 'c', 'd', 'e']) cache.set(key, key.toUpperCase());
    cache.setMaxEntries(2);
    expect(evicted).toEqual(['a', 'b', 'c']);
    expect(cache.keys()).toEqual(['d', 'e']);
  });

  it('refuses a cap below one', () => {
    const { cache } = makeCache(0);
    expect(cache.maxEntries).toBe(1);
    cache.set('a', 'A');
    cache.set('b', 'B');
    expect(cache.size).toBe(1);
  });

  it('counts evictions for the HUD', () => {
    const { cache } = makeCache(2);
    for (let i = 0; i < 10; i++) cache.set(`k${i}`, `v${i}`);
    expect(cache.evictions).toBe(8);
  });
});
