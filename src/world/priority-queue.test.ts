import { describe, expect, it } from 'vitest';
import { PriorityQueue } from './priority-queue';

const drain = (queue: PriorityQueue<string>): string[] => {
  const order: string[] = [];
  for (;;) {
    const entry = queue.pop();
    if (entry === undefined) return order;
    order.push(entry.key);
  }
};

describe('PriorityQueue', () => {
  it('pops in ascending priority order', () => {
    const queue = new PriorityQueue<string>();
    queue.push('far', 'far', 900);
    queue.push('near', 'near', 10);
    queue.push('mid', 'mid', 100);
    expect(drain(queue)).toEqual(['near', 'mid', 'far']);
  });

  it('breaks ties by insertion order', () => {
    const queue = new PriorityQueue<string>();
    queue.push('a', 'a', 5);
    queue.push('b', 'b', 5);
    queue.push('c', 'c', 5);
    expect(drain(queue)).toEqual(['a', 'b', 'c']);
  });

  it('stays correct over a large randomised workload', () => {
    const queue = new PriorityQueue<number>();
    const expected: number[] = [];
    let state = 12345;
    for (let i = 0; i < 500; i++) {
      state = (state * 1103515245 + 12345) % 2147483648;
      const priority = state % 1000;
      expected.push(priority);
      queue.push(`k${i}`, priority, priority);
    }
    expected.sort((a, b) => a - b);

    const popped: number[] = [];
    for (;;) {
      const entry = queue.pop();
      if (entry === undefined) break;
      popped.push(entry.priority);
    }
    expect(popped).toEqual(expected);
  });

  it('re-ranks an existing key in place rather than duplicating it', () => {
    const queue = new PriorityQueue<string>();
    queue.push('a', 'a', 100);
    queue.push('b', 'b', 50);
    queue.push('a', 'a', 1);
    expect(queue.size).toBe(2);
    expect(drain(queue)).toEqual(['a', 'b']);
  });

  it('re-ranks in both directions', () => {
    const queue = new PriorityQueue<string>();
    queue.push('a', 'a', 1);
    queue.push('b', 'b', 2);
    queue.push('c', 'c', 3);
    expect(queue.reprioritize('a', 99)).toBe(true);
    expect(queue.reprioritize('missing', 1)).toBe(false);
    expect(drain(queue)).toEqual(['b', 'c', 'a']);
  });

  it('removes by key without disturbing the rest of the order', () => {
    const queue = new PriorityQueue<string>();
    for (let i = 0; i < 20; i++) queue.push(`k${i}`, `k${i}`, 20 - i);
    expect(queue.remove('k7')?.key).toBe('k7');
    expect(queue.remove('k7')).toBeUndefined();
    expect(queue.has('k7')).toBe(false);
    expect(queue.size).toBe(19);

    const order = drain(queue);
    expect(order).not.toContain('k7');
    expect(order[0]).toBe('k19');
    expect(order.at(-1)).toBe('k0');
  });

  it('removes the last element without corrupting the index map', () => {
    const queue = new PriorityQueue<string>();
    queue.push('a', 'a', 1);
    queue.push('b', 'b', 2);
    queue.remove('b');
    queue.push('c', 'c', 0);
    expect(drain(queue)).toEqual(['c', 'a']);
  });

  it('reports peek and size, and clears', () => {
    const queue = new PriorityQueue<string>();
    expect(queue.peek()).toBeUndefined();
    expect(queue.pop()).toBeUndefined();
    queue.push('a', 'a', 3);
    queue.push('b', 'b', 1);
    expect(queue.peek()?.key).toBe('b');
    expect(queue.size).toBe(2);
    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.has('a')).toBe(false);
  });

  it('exposes a sorted snapshot without consuming the queue', () => {
    const queue = new PriorityQueue<string>();
    queue.push('c', 'c', 3);
    queue.push('a', 'a', 1);
    queue.push('b', 'b', 2);
    expect(queue.toSortedArray().map((e) => e.key)).toEqual(['a', 'b', 'c']);
    expect(queue.size).toBe(3);
  });
});
