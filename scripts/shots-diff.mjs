#!/usr/bin/env node
/**
 * Describe the difference between two PNGs.
 *
 *   npm run shots:diff -- shots/road-bridge.png shots/.check/road-bridge.png
 *   npm run shots:diff -- a.png b.png mask.png
 *
 * `npm run shots:check` answers "did this view change", which is the question
 * that matters when it is green. When it goes red the next question is always
 * "changed HOW", and until Phase 6a the only way to answer it was to open two
 * screenshots side by side and squint. This prints how many pixels differ, by
 * how much, and the bounding box they occupy, and will write a greyscale mask of
 * the differences if given a third path.
 *
 * It earned its place by settling the Phase 5 wireframe instability. Three
 * hashes disagreed and the hashes alone said nothing; the masks said "0.5% of
 * pixels, all of them tracing distant road decks", which is what turned a
 * mystery into a one-line fix in `renderer.ts`. Keep it: a byte-comparison
 * harness with no way to describe a difference eventually gets ignored.
 *
 * Deliberately dependency-free. Chromium screenshots are 8-bit non-interlaced
 * PNGs, so a decoder is a page of code, and adding an image library to a project
 * whose only runtime dependency is Three.js is a worse trade than writing it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

/** Decode an 8-bit non-interlaced PNG to raw interleaved samples. */
function decodePng(path) {
  const file = readFileSync(path);
  let at = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (at < file.length) {
    const length = file.readUInt32BE(at);
    const type = file.toString('ascii', at + 4, at + 8);
    const data = file.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error(`${path}: interlaced PNGs are not supported`);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`${path}: bit depth ${bitDepth} is not supported`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (channels === undefined) throw new Error(`${path}: colour type ${colorType} is not supported`);

  // Undo the per-scanline filters. Every filter is defined against the byte one
  // pixel to the left and the byte above, so this has to run in order.
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const line = raw.subarray(src, src + stride);
    src += stride;
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = prior === null ? 0 : prior[i];
      const c = i >= channels && prior !== null ? prior[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[i] = value & 0xff;
    }
  }
  return { width, height, channels, pixels: out };
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) crc = CRC_TABLE[(crc ^ out[i]) & 0xff] ^ (crc >>> 8);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return out;
}

/** An 8-bit greyscale PNG, so the mask can be opened in anything. */
function encodeGrayPng(width, height, gray) {
  const raw = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    gray.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const [pathA, pathB, maskPath] = process.argv.slice(2);
if (pathA === undefined || pathB === undefined) {
  console.error('usage: npm run shots:diff -- <a.png> <b.png> [mask.png]');
  process.exit(2);
}

const a = decodePng(pathA);
const b = decodePng(pathB);
if (a.width !== b.width || a.height !== b.height) {
  console.error(`different dimensions: ${a.width}x${a.height} against ${b.width}x${b.height}`);
  process.exit(1);
}

const { width, height, channels } = a;
const mask = Buffer.alloc(width * height);
const histogram = new Map();
let differing = 0;
let maxDelta = 0;
let sumDelta = 0;
let minX = Infinity;
let maxX = -Infinity;
let minY = Infinity;
let maxY = -Infinity;

for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const at = (y * width + x) * channels;
    let delta = 0;
    for (let c = 0; c < Math.min(3, channels); c++) {
      const d = Math.abs(a.pixels[at + c] - b.pixels[at + c]);
      if (d > delta) delta = d;
    }
    if (delta === 0) continue;
    differing++;
    sumDelta += delta;
    if (delta > maxDelta) maxDelta = delta;
    histogram.set(delta, (histogram.get(delta) ?? 0) + 1);
    // Scaled by 8 so a one-step difference is visible rather than black.
    mask[y * width + x] = Math.min(255, delta * 8);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
}

const total = width * height;
console.log(`a: ${pathA}`);
console.log(`b: ${pathB}`);
console.log(`${width}x${height}, ${channels} channels`);
console.log(`differing pixels: ${differing} of ${total} (${((differing / total) * 100).toFixed(4)}%)`);

if (differing === 0) {
  console.log('identical');
  process.exit(0);
}

console.log(
  `channel delta: max ${maxDelta}, mean ${(sumDelta / differing).toFixed(2)} over differing pixels`,
);
console.log(`bounding box: x ${minX}..${maxX}, y ${minY}..${maxY}`);
const top = [...histogram.entries()].sort((p, q) => q[1] - p[1]).slice(0, 8);
console.log(`commonest deltas: ${top.map(([d, n]) => `${d} (x${n})`).join(', ')}`);
if (maskPath !== undefined) {
  writeFileSync(maskPath, encodeGrayPng(width, height, mask));
  console.log(`mask written to ${maskPath}`);
}
process.exit(1);
