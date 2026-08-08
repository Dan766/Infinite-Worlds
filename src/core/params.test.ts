import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, parseParams, serializeParams } from './params';
import { hashString } from './hash';
import { TOD_AT_TIME_ZERO } from '../sky/celestial';

describe('parseParams', () => {
  it('returns defaults for an empty query string', () => {
    const p = parseParams('');
    expect(p.seed).toBe(DEFAULT_PARAMS.seed);
    expect(p.pos).toEqual(DEFAULT_PARAMS.pos);
    expect(p.look).toEqual(DEFAULT_PARAMS.look);
    expect(p.freeze).toBe(false);
    expect(p.time).toBe(0);
    expect(p.hud).toBe(true);
    expect(p.panel).toBe(true);
    expect(p.map).toBe(false);
    expect(p.wireframe).toBe(false);
  });

  it('accepts a query string with or without the leading ?', () => {
    expect(parseParams('?seed=abc').seed).toBe('abc');
    expect(parseParams('seed=abc').seed).toBe('abc');
  });

  it('derives seedHash from the seed string', () => {
    expect(parseParams('?seed=hello').seedHash).toBe(hashString('hello'));
    expect(parseParams('?seed=hello').seedHash).not.toBe(parseParams('?seed=world').seedHash);
  });

  it('parses pos and look', () => {
    const p = parseParams('?pos=1,-2.5,3&look=90,-45');
    expect(p.pos).toEqual({ x: 1, y: -2.5, z: 3 });
    expect(p.look).toEqual({ yaw: 90, pitch: -45 });
  });

  it('parses boolean flags in every accepted spelling', () => {
    expect(parseParams('?freeze=1').freeze).toBe(true);
    expect(parseParams('?freeze=true').freeze).toBe(true);
    expect(parseParams('?freeze=ON').freeze).toBe(true);
    expect(parseParams('?freeze').freeze).toBe(true);
    expect(parseParams('?hud=0').hud).toBe(false);
    expect(parseParams('?hud=false').hud).toBe(false);
    expect(parseParams('?panel=off').panel).toBe(false);
    expect(parseParams('?map=1').map).toBe(true);
    expect(parseParams('?map').map).toBe(true);
  });

  it('malformed map values fall back to the default rather than throwing', () => {
    expect(parseParams('?map=maybe').map).toBe(DEFAULT_PARAMS.map);
  });

  it('parses time and clamps it to be non-negative', () => {
    expect(parseParams('?time=12.5').time).toBe(12.5);
    expect(parseParams('?time=-4').time).toBe(0);
  });

  it('parses tod and wraps it into [0, 24)', () => {
    expect(parseParams('?tod=0').tod).toBe(0);
    expect(parseParams('?tod=18.75').tod).toBe(18.75);
    // Wrapped, not clamped -- 25:00 is 01:00 and -3:00 is 21:00.
    expect(parseParams('?tod=25').tod).toBe(1);
    expect(parseParams('?tod=-3').tod).toBe(21);
    expect(parseParams('?tod=48').tod).toBe(0);
  });

  it('defaults tod to the sky module’s TOD_AT_TIME_ZERO', () => {
    expect(parseParams('').tod).toBe(TOD_AT_TIME_ZERO);
    expect(DEFAULT_PARAMS.tod).toBe(TOD_AT_TIME_ZERO);
  });

  it('malformed tod values fall back to the default', () => {
    expect(parseParams('?tod=noon').tod).toBe(DEFAULT_PARAMS.tod);
    expect(parseParams('?tod=').tod).toBe(DEFAULT_PARAMS.tod);
    expect(parseParams('?tod=NaN').tod).toBe(DEFAULT_PARAMS.tod);
    expect(parseParams('?tod=Infinity').tod).toBe(DEFAULT_PARAMS.tod);
  });

  describe('malformed input falls back to defaults rather than throwing', () => {
    const cases = [
      '?pos=1,2',
      '?pos=1,2,3,4',
      '?pos=a,b,c',
      '?look=nope',
      '?time=abc',
      '?freeze=maybe',
      '?seed=',
      '?pos=1,NaN,3',
      '?pos=1,Infinity,3',
    ];
    for (const query of cases) {
      it(query, () => {
        const p = parseParams(query);
        expect(p.pos).toEqual(DEFAULT_PARAMS.pos);
        expect(p.look).toEqual(DEFAULT_PARAMS.look);
        expect(p.time).toBe(DEFAULT_PARAMS.time);
        expect(p.freeze).toBe(DEFAULT_PARAMS.freeze);
        expect(p.seed).toBe(DEFAULT_PARAMS.seed);
      });
    }
  });

  it('does not alias the default objects between calls', () => {
    const a = parseParams('');
    const b = parseParams('');
    a.pos.x = 999;
    expect(b.pos.x).toBe(DEFAULT_PARAMS.pos.x);
    expect(DEFAULT_PARAMS.pos.x).not.toBe(999);
  });
});

describe('serializeParams', () => {
  it('omits everything that is still at its default', () => {
    expect(serializeParams(parseParams(''))).toBe('');
  });

  it('round-trips a fully specified state', () => {
    const query =
      '?seed=alpha&pos=10,20,30&look=45,-12&freeze=1&time=7.5&tod=21.25&hud=0&panel=0&map=1&wireframe=1';
    const parsed = parseParams(query);
    const reparsed = parseParams(serializeParams(parsed));
    expect(reparsed).toEqual(parsed);
  });

  it('includes map only when it differs from the default', () => {
    const on = parseParams('?map=1');
    expect(serializeParams(on)).toMatch(/[?&]map=1/);
    const off = parseParams('');
    expect(serializeParams(off)).not.toMatch(/map=/);
  });

  it('includes tod only when it differs from the default', () => {
    expect(serializeParams(parseParams('?tod=23'))).toMatch(/[?&]tod=23/);
    expect(serializeParams(parseParams(''))).not.toMatch(/tod=/);
    // Explicitly asking for the default hour still serialises to nothing, so a
    // shared link is not littered with values that were never chosen.
    expect(serializeParams(parseParams(`?tod=${TOD_AT_TIME_ZERO}`))).not.toMatch(/tod=/);
  });

  it('round-trips repeatedly without drifting', () => {
    let params = parseParams('?seed=drift&pos=1.23456,2,3&look=10,20');
    for (let i = 0; i < 5; i++) {
      params = parseParams(serializeParams(params));
    }
    expect(params.pos.x).toBe(1.235);
    expect(params.seed).toBe('drift');
    expect(params.look).toEqual({ yaw: 10, pitch: 20 });
  });

  it('escapes seeds containing URL-significant characters', () => {
    const parsed = parseParams(`?seed=${encodeURIComponent('a b&c=d')}`);
    expect(parsed.seed).toBe('a b&c=d');
    expect(parseParams(serializeParams(parsed)).seed).toBe('a b&c=d');
  });
});
