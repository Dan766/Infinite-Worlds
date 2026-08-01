/**
 * URL parameters. The whole verification strategy rests on this module: if the
 * app's visible state is a pure function of the query string, then a screenshot
 * is reproducible, a bug report is a link, and checking the agent's work costs
 * nothing but opening a URL.
 *
 * Supported:
 *   ?seed=<string>        world seed; hashed to uint32
 *   ?pos=x,y,z            camera position
 *   ?look=yaw,pitch       camera orientation, degrees
 *   ?freeze=1             start paused, so the frame is a still
 *   ?time=<seconds>       seek the simulation to an absolute time
 *   ?hud=0                hide the perf HUD -- required for stable screenshots,
 *                         because fps and heap can never match between runs
 *   ?panel=0              hide the debug panel
 *   ?wireframe=1          start in wireframe
 *   ?fly=<m/s>            deterministic autopilot along X; 0 is off
 *   ?flyleg=<seconds>     seconds per autopilot leg before it reverses
 *
 * Unknown or malformed values fall back to the default rather than throwing; a
 * typo in a URL should not produce a blank page.
 */

import { hashString } from './hash';

export interface Vec3Params {
  x: number;
  y: number;
  z: number;
}

export interface LookParams {
  /** Degrees, left/right. */
  yaw: number;
  /** Degrees, up/down. */
  pitch: number;
}

export interface AppParams {
  seed: string;
  /** uint32 world seed derived from `seed`. */
  seedHash: number;
  pos: Vec3Params;
  look: LookParams;
  freeze: boolean;
  /** Simulation time in seconds to start at. */
  time: number;
  hud: boolean;
  panel: boolean;
  wireframe: boolean;
  /**
   * Autopilot speed in m/s along X. Zero means off. Used by `npm run soak` to
   * fly a repeatable path with no human at the keyboard.
   */
  fly: number;
  /** Seconds the autopilot travels before reversing. */
  flyLeg: number;
}

export const DEFAULT_PARAMS: Omit<AppParams, 'seedHash'> = {
  seed: 'infinite-world',
  // Framed on the origin: from (3.5, 2.5, 5.5) the direction to (0,0,0) is a
  // yaw of +32.5 degrees and a pitch of -21.
  pos: { x: 3.5, y: 2.5, z: 5.5 },
  look: { yaw: 32.5, pitch: -21 },
  freeze: false,
  time: 0,
  hud: true,
  panel: true,
  wireframe: false,
  fly: 0,
  flyLeg: 120,
};

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function parseBool(raw: string | null, fallback: boolean): boolean {
  if (raw === null) return fallback;
  const v = raw.trim().toLowerCase();
  // A bare `?freeze` with no value reads as "on".
  if (v === '') return true;
  if (TRUE_VALUES.has(v)) return true;
  if (FALSE_VALUES.has(v)) return false;
  return fallback;
}

function parseNumber(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const v = Number(raw.trim());
  return Number.isFinite(v) ? v : fallback;
}

function parseNumberList(raw: string | null, count: number): number[] | null {
  if (raw === null) return null;
  const parts = raw.split(',').map((p) => Number(p.trim()));
  if (parts.length !== count) return null;
  if (!parts.every((p) => Number.isFinite(p))) return null;
  return parts;
}

function parseVec3(raw: string | null, fallback: Vec3Params): Vec3Params {
  const parts = parseNumberList(raw, 3);
  if (parts === null) return { ...fallback };
  return { x: parts[0] as number, y: parts[1] as number, z: parts[2] as number };
}

function parseLook(raw: string | null, fallback: LookParams): LookParams {
  const parts = parseNumberList(raw, 2);
  if (parts === null) return { ...fallback };
  return { yaw: parts[0] as number, pitch: parts[1] as number };
}

/** Parse a query string (with or without a leading `?`) into app parameters. */
export function parseParams(search: string): AppParams {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const seedRaw = q.get('seed');
  const seed = seedRaw !== null && seedRaw.trim() !== '' ? seedRaw : DEFAULT_PARAMS.seed;

  return {
    seed,
    seedHash: hashString(seed),
    pos: parseVec3(q.get('pos'), DEFAULT_PARAMS.pos),
    look: parseLook(q.get('look'), DEFAULT_PARAMS.look),
    freeze: parseBool(q.get('freeze'), DEFAULT_PARAMS.freeze),
    time: Math.max(0, parseNumber(q.get('time'), DEFAULT_PARAMS.time)),
    hud: parseBool(q.get('hud'), DEFAULT_PARAMS.hud),
    panel: parseBool(q.get('panel'), DEFAULT_PARAMS.panel),
    wireframe: parseBool(q.get('wireframe'), DEFAULT_PARAMS.wireframe),
    fly: parseNumber(q.get('fly'), DEFAULT_PARAMS.fly),
    flyLeg: Math.max(1, parseNumber(q.get('flyleg'), DEFAULT_PARAMS.flyLeg)),
  };
}

/** Round to a fixed number of decimals so serialised URLs stay stable and short. */
function round(v: number, decimals = 3): number {
  const factor = 10 ** decimals;
  return Math.round(v * factor) / factor;
}

/**
 * Serialise parameters back into a query string, omitting anything still at its
 * default. Used by the debug panel's "copy link" so the current view can be
 * handed to another session verbatim.
 */
export function serializeParams(params: AppParams): string {
  const q = new URLSearchParams();

  if (params.seed !== DEFAULT_PARAMS.seed) q.set('seed', params.seed);

  const { pos } = params;
  const dp = DEFAULT_PARAMS.pos;
  if (round(pos.x) !== dp.x || round(pos.y) !== dp.y || round(pos.z) !== dp.z) {
    q.set('pos', `${round(pos.x)},${round(pos.y)},${round(pos.z)}`);
  }

  const { look } = params;
  const dl = DEFAULT_PARAMS.look;
  if (round(look.yaw) !== dl.yaw || round(look.pitch) !== dl.pitch) {
    q.set('look', `${round(look.yaw)},${round(look.pitch)}`);
  }

  if (params.freeze !== DEFAULT_PARAMS.freeze) q.set('freeze', params.freeze ? '1' : '0');
  if (round(params.time) !== DEFAULT_PARAMS.time) q.set('time', String(round(params.time)));
  if (params.hud !== DEFAULT_PARAMS.hud) q.set('hud', params.hud ? '1' : '0');
  if (params.panel !== DEFAULT_PARAMS.panel) q.set('panel', params.panel ? '1' : '0');
  if (params.wireframe !== DEFAULT_PARAMS.wireframe) {
    q.set('wireframe', params.wireframe ? '1' : '0');
  }
  if (round(params.fly) !== DEFAULT_PARAMS.fly) q.set('fly', String(round(params.fly)));
  if (round(params.flyLeg) !== DEFAULT_PARAMS.flyLeg) q.set('flyleg', String(round(params.flyLeg)));

  const s = q.toString();
  return s === '' ? '' : `?${s}`;
}
