import assert from 'node:assert/strict';
// `vitest`, not `node:test`. `npm test` is `vitest run`, and vitest's default
// include glob picks up `.mjs` -- so under `node:test` these seven tests ran
// (inside vitest's own import of the file) while vitest found no suite of its
// own and failed the file outright. The assertions stay on `node:assert/strict`
// rather than moving to `expect`: they are the only thing in this repo testing
// a `scripts/` module, and they read the same under either runner.
import { describe, it } from 'vitest';
import {
  clusterViews,
  filterViews,
  inPageCamera,
  matchOnly,
  parseShotArgs,
  reloadKey,
} from './shots-select.mjs';

describe('parseShotArgs', () => {
  it('parses --only and --no-build', () => {
    assert.deepEqual(parseShotArgs(['--only=city-*', '--no-build']), {
      build: false,
      only: ['city-*'],
    });
    assert.deepEqual(parseShotArgs(['--only', 'city-*,vegetation-*']), {
      build: true,
      only: ['city-*', 'vegetation-*'],
    });
  });
});

describe('matchOnly / filterViews', () => {
  const views = [{ name: 'city-aerial' }, { name: 'city-keep' }, { name: 'cube-default' }];
  it('matches globs', () => {
    assert.equal(matchOnly('city-aerial', ['city-*']), true);
    assert.equal(matchOnly('cube-default', ['city-*']), false);
  });
  it('filters', () => {
    assert.deepEqual(
      filterViews(views, ['city-*']).map((v) => v.name),
      ['city-aerial', 'city-keep'],
    );
  });
});

describe('reloadKey / clusterViews', () => {
  it('ignores pos/look/wireframe in the reload key', () => {
    assert.equal(
      reloadKey('?time=3&pos=1,2,3&look=0,-8'),
      reloadKey('?time=3&pos=9,9,9&look=90,-22&wireframe=1'),
    );
  });
  it('treats walk as a reload boundary', () => {
    assert.notEqual(reloadKey('?time=3'), reloadKey('?time=3&walk=1'));
  });
  it('treats tod as a reload boundary, so a view cannot inherit the wrong sky', () => {
    assert.notEqual(reloadKey('?time=3'), reloadKey('?time=3&tod=21'));
    assert.notEqual(reloadKey('?time=3&tod=12'), reloadKey('?time=3&tod=21'));
    assert.equal(reloadKey('?time=3&tod=12&pos=1,2,3'), reloadKey('?time=3&tod=12&pos=9,9,9'));
  });
  it('clusters consecutive same-key views only', () => {
    const views = [
      { name: 'a', params: '?time=3&pos=1,2,3' },
      { name: 'b', params: '?time=3&pos=4,5,6' },
      { name: 'c', params: '?time=3&walk=1&pos=1,2,3' },
      { name: 'd', params: '?time=3&pos=7,8,9' },
    ];
    const clusters = clusterViews(views);
    assert.equal(clusters.length, 3);
    assert.deepEqual(
      clusters.map((c) => c.views.map((v) => v.name)),
      [['a', 'b'], ['c'], ['d']],
    );
  });
  it('reads camera from params', () => {
    assert.deepEqual(inPageCamera('?pos=-1,2,-3&look=10,-20&wireframe=1'), {
      pos: { x: -1, y: 2, z: -3 },
      look: { yaw: 10, pitch: -20 },
      wireframe: true,
    });
  });
});