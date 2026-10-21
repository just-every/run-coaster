/** Small, deterministic local descriptors. Values describe visible ink, never provenance. */
import { decode, encode } from 'fast-png';
export const SIDE = 384;
export type Raster = { width: number; height: number; gray: Uint8Array };
export type Landmark = { x: number; y: number; bits: number[] };
export type Transform = [number, number, number, number, number, number];
export const IDENTITY: Transform = [1, 0, 0, 0, 1, 0];
export function encodeBytes(bytes: Uint8Array): string {
  let value = ''; for (let p = 0; p < bytes.length; p += 8192) value += String.fromCharCode(...bytes.subarray(p, p + 8192));
  return btoa(value);
}
export function decodeBytes(value: string): Uint8Array { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
export function unpackInk(value: string): Uint8Array {
  const image = decode(decodeBytes(value), { checkCrc: true });
  if (image.width !== SIDE || image.height !== SIDE || image.channels !== 1 || image.depth !== 8) throw new Error('Invalid image descriptor');
  return new Uint8Array(image.data);
}
export function packInk(ink: Uint8Array): string {
  return encodeBytes(encode({ width: SIDE, height: SIDE, data: ink, channels: 1, depth: 8 }));
}
export function sample(ink: Uint8Array, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= SIDE - 1 || y >= SIDE - 1) return 0;
  const ix = Math.floor(x), iy = Math.floor(y), dx = x - ix, dy = y - iy, p = iy * SIDE + ix;
  return (ink[p] * (1 - dx) + ink[p + 1] * dx) * (1 - dy) + (ink[p + SIDE] * (1 - dx) + ink[p + SIDE + 1] * dx) * dy;
}
export function normalizeRaster({ width: w, height: h, gray }: Raster): { ink: Uint8Array; coverage: number; skew: number } {
  // Local paper estimate removes broad lighting gradients and uniformly dark backgrounds.
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += gray[y * w + x]; integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row; } }
  const dark = new Uint8Array(w * h), radius = Math.max(5, Math.round(Math.min(w, h) / 20));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.max(0, x - radius), x1 = Math.min(w, x + radius + 1), y0 = Math.max(0, y - radius), y1 = Math.min(h, y + radius + 1);
    const mean = (integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    const contrast = Math.min(255, Math.max(0, (mean - gray[y * w + x] - 8) * 2));
    dark[y * w + x] = contrast < 48 ? 0 : contrast;
  }
  const points: [number, number, number][] = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) if (dark[y * w + x] > 48) points.push([x - w / 2, y - h / 2, dark[y * w + x] / 255]);
  let best = -1, skew = 0;
  for (let degrees = -10; degrees <= 10; degrees += 0.5) {
    const angle = degrees * Math.PI / 180, rows = new Float64Array(Math.ceil(h + w / 2) * 2);
    for (const [x, y, weight] of points) { const row = Math.round(y * Math.cos(angle) - x * Math.sin(angle) + rows.length / 2); if (row >= 0 && row < rows.length) rows[row] += weight; }
    const score = rows.reduce((sum, v) => sum + v * v, 0);
    if (score > best) { best = score; skew = degrees; }
  }
  const angle = skew * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  const xs = points.map(([x, y]) => x * c + y * s).sort((a, b) => a - b), ys = points.map(([x, y]) => y * c - x * s).sort((a, b) => a - b);
  const trim = Math.floor(points.length * 0.003), x0 = xs[trim] ?? -w / 2, x1 = xs[xs.length - 1 - trim] ?? w / 2, y0 = ys[trim] ?? -h / 2, y1 = ys[ys.length - 1 - trim] ?? h / 2;
  const ink = new Uint8Array(SIDE * SIDE), get = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h ? dark[Math.floor(y) * w + Math.floor(x)] : 0;
  for (let y = 0; y < SIDE; y++) for (let x = 0; x < SIDE; x++) {
    let total = 0;
    // Four area samples preserve small text when scaling rather than selecting one pixel.
    for (const dy of [0.25, 0.75]) for (const dx of [0.25, 0.75]) {
      const u = x0 + (x + dx) * (x1 - x0 + 1) / SIDE, v = y0 + (y + dy) * (y1 - y0 + 1) / SIDE;
      total += get(u * c - v * s + w / 2, u * s + v * c + h / 2);
    }
    ink[y * SIDE + x] = Math.round(total / 4);
  }
  return { ink, coverage: points.length / (w * h), skew };
}
const OFFSETS = Array.from({ length: 128 }, (_, i) => [((i * 37 + 11) % 17) - 8, ((i * 53 + 7) % 19) - 9, ((i * 29 + 3) % 19) - 9, ((i * 43 + 13) % 17) - 8]);
export function landmarks(ink: Uint8Array): string {
  const candidates: { x: number; y: number; score: number }[] = [];
  for (let y = 10; y < SIDE - 10; y += 2) for (let x = 10; x < SIDE - 10; x += 2) {
    let xx = 0, yy = 0, xy = 0;
    for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) {
      const p = (y + v) * SIDE + x + u, gx = ink[p + 1] - ink[p - 1], gy = ink[p + SIDE] - ink[p - SIDE]; xx += gx * gx; yy += gy * gy; xy += gx * gy;
    }
    const score = (xx * yy - xy * xy) / (xx + yy + 1); if (score > 1200) candidates.push({ x, y, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const chosen: { x: number; y: number }[] = [], output: number[] = [];
  for (const p of candidates) {
    if (chosen.some(q => Math.hypot(p.x - q.x, p.y - q.y) < 7)) continue;
    chosen.push(p); output.push(Math.round(p.x * 255 / SIDE), Math.round(p.y * 255 / SIDE));
    for (let byte = 0; byte < 16; byte++) { let bits = 0; for (let j = 0; j < 8; j++) { const [x1, y1, x2, y2] = OFFSETS[byte * 8 + j]; if (ink[(p.y + y1) * SIDE + p.x + x1] > ink[(p.y + y2) * SIDE + p.x + x2]) bits |= 1 << j; } output.push(bits); }
    if (chosen.length === 128) break;
  }
  return encodeBytes(Uint8Array.from(output));
}
function readLandmarks(value: string): Landmark[] {
  const bytes = decodeBytes(value), points: Landmark[] = [];
  for (let p = 0; p + 17 < bytes.length; p += 18) points.push({ x: bytes[p] * SIDE / 255, y: bytes[p + 1] * SIDE / 255, bits: [...bytes.subarray(p + 2, p + 18)] }); return points;
}
const COUNTS = Uint8Array.from({ length: 256 }, (_, n) => { let count = 0; for (; n; n &= n - 1) count++; return count; });
export function register(a: string, b: string): { transform: Transform; inliers: number; matches: number } {
  const first = readLandmarks(a), second = readLandmarks(b), matches: [Landmark, Landmark][] = [];
  for (const p of first) {
    let best = 129, next = 129, winner: Landmark | undefined;
    for (const q of second) { const distance = p.bits.reduce((sum, byte, i) => sum + COUNTS[byte ^ q.bits[i]], 0); if (distance < best) { next = best; best = distance; winner = q; } else next = Math.min(next, distance); }
    if (winner && best < 28 && best < next * 0.8) matches.push([p, winner]);
  }
  let best = 0, transform = IDENTITY;
  // Deterministic affine hypotheses tolerate crop, mild perspective, and unequal rescaling.
  for (let n = 0; n < Math.min(320, matches.length * 12); n++) {
    const triple = [matches[n % matches.length], matches[(n * 13 + 1) % matches.length], matches[(n * 29 + 3) % matches.length]];
    const [p, q, r] = triple.map(pair => pair[0]), determinant = (q.x - p.x) * (r.y - p.y) - (r.x - p.x) * (q.y - p.y);
    if (Math.abs(determinant) < 250) continue;
    const axis = (key: 'x' | 'y') => { const [u, v, w] = triple.map(pair => pair[1][key]), aa = ((v - u) * (r.y - p.y) - (w - u) * (q.y - p.y)) / determinant, bb = ((q.x - p.x) * (w - u) - (r.x - p.x) * (v - u)) / determinant; return [aa, bb, u - aa * p.x - bb * p.y]; };
    const candidate = [...axis('x'), ...axis('y')] as Transform;
    const [aa, bb, , dd, ee] = candidate, area = aa * ee - bb * dd;
    if (area < 0.35 || area > 3 || Math.abs(bb) > 0.4 || Math.abs(dd) > 0.4) continue;
    const inliers = matches.filter(([u, v]) => Math.hypot(candidate[0] * u.x + candidate[1] * u.y + candidate[2] - v.x, candidate[3] * u.x + candidate[4] * u.y + candidate[5] - v.y) < 2.5).length;
    if (inliers > best) { best = inliers; transform = candidate; }
  }
  return { transform, inliers: best, matches: matches.length };
}
