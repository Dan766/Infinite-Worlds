import { describe, expect, it } from 'vitest';
import {
  LANDMARK_CATHEDRAL,
  LANDMARK_GATEHOUSE,
  LANDMARK_GUILD,
  LANDMARK_KEEP,
  LANDMARK_TOWNHALL,
} from './city';
import { buildInteriorSurface } from './interior-mesh';

describe('landmark interiors', () => {
  it('emits deterministic non-empty geometry for every enterable kind', () => {
    for (const kind of [
      LANDMARK_KEEP,
      LANDMARK_CATHEDRAL,
      LANDMARK_TOWNHALL,
      LANDMARK_GUILD,
      LANDMARK_GATEHOUSE,
    ]) {
      const first = buildInteriorSurface(kind, 10, 14);
      const again = buildInteriorSurface(kind, 10, 14);
      expect(first.indices.length).toBeGreaterThan(0);
      expect(Array.from(again.positions)).toEqual(Array.from(first.positions));
      expect(Array.from(again.indices)).toEqual(Array.from(first.indices));
    }
  });
});
