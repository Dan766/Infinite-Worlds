/**
 * Tests for the shared deterministic min-heap.
 *
 * This module exists because two generators depend on its ORDERING for RULE 1,
 * so the tests are about the total order, not about heap mechanics. The ones
 * that matter are the ties: a flooded plateau and a flat A* frontier both hand
 * it thousands of cells at exactly equal keys, and the pop sequence there has to
 * be a property of the code rather than of the shuffling.
 */

import { describe, expect, it } from 'vitest';
import { CellHeap } from './cell-heap';

function drain(heap: CellHeap): number[] {
  const out: number[] = [];
  while (heap.length > 0) out.push(heap.pop());
  return out;
}

describe('CellHeap', () => {
  it('pops in ascending key order', () => {
    const keys = Float64Array.from([5, 1, 4, 2, 3]);
    const heap = new CellHeap(keys.length, keys);
    for (let i = 0; i < keys.length; i++) heap.push(i);
    expect(drain(heap)).toEqual([1, 3, 4, 2, 0]);
  });

  it('breaks ties by cell index, whatever order the cells went in', () => {
    // Every key identical: the ONLY thing that can order these is the index
    // tie-break. Pushed in reverse so a heap without one would very likely
    // return them in some other order.
    const keys = new Float64Array(64).fill(7);
    const heap = new CellHeap(64, keys);
    for (let i = 63; i >= 0; i--) heap.push(i);
    expect(drain(heap)).toEqual(Array.from({ length: 64 }, (_, i) => i));
  });

  it('gives the same sequence for the same keys pushed in any order', () => {
    // The property the flood and the router actually rely on: the pop order is
    // a function of the keys, not of the insertion order.
    const keys = Float64Array.from([3, 1, 3, 1, 2, 2, 3, 1]);
    const forward = new CellHeap(keys.length, keys);
    for (let i = 0; i < keys.length; i++) forward.push(i);
    const backward = new CellHeap(keys.length, keys);
    for (let i = keys.length - 1; i >= 0; i--) backward.push(i);
    expect(drain(forward)).toEqual(drain(backward));
  });

  it('orders equal keys before a strictly larger one regardless of index', () => {
    // Guards the comparison itself: `key` must dominate, and the index must
    // only ever decide a tie.
    const keys = Float64Array.from([9, 1, 9, 1]);
    const heap = new CellHeap(keys.length, keys);
    for (let i = 0; i < keys.length; i++) heap.push(i);
    expect(drain(heap)).toEqual([1, 3, 0, 2]);
  });

  it('handles negative and fractional keys', () => {
    // Altitudes are signed metres and A* costs are fractional; neither is an
    // integer index in disguise.
    const keys = Float64Array.from([0, -152.5, 361.25, -0.5]);
    const heap = new CellHeap(keys.length, keys);
    for (let i = 0; i < keys.length; i++) heap.push(i);
    expect(drain(heap)).toEqual([1, 3, 0, 2]);
  });

  it('reports its length and empties completely', () => {
    const keys = Float64Array.from([2, 0, 1]);
    const heap = new CellHeap(keys.length, keys);
    expect(heap.length).toBe(0);
    heap.push(0);
    heap.push(1);
    heap.push(2);
    expect(heap.length).toBe(3);
    heap.pop();
    expect(heap.length).toBe(2);
    drain(heap);
    expect(heap.length).toBe(0);
  });

  it('survives a single element', () => {
    const keys = Float64Array.from([42]);
    const heap = new CellHeap(1, keys);
    heap.push(0);
    expect(heap.pop()).toBe(0);
    expect(heap.length).toBe(0);
  });
});
