import { SIDE, sample, type Transform } from './receipt-image-raster';

function score(a: Uint8Array, b: Uint8Array, t: Transform) {
  let shared = 0, union = 0;
  for (let y = 2; y < SIDE - 2; y += 3) for (let x = 2; x < SIDE - 2; x += 3) {
    const bx = t[0] * x + t[1] * y + t[2], by = t[3] * x + t[4] * y + t[5];
    const v = a[y * SIDE + x], w = sample(b, bx, by);
    shared += Math.min(v, w); union += Math.max(v, w);
  }
  return shared / Math.max(1, union);
}

/** Landmark coordinates are integer pixels. Refine their affine transform against
 * actual ink, around the image centre, before interpreting any residual as edits.
 * There is no independent landmark-only duplicate verdict. */
export function refineAlignment(a: Uint8Array, b: Uint8Array, initial: Transform): Transform {
  let best = [...initial] as Transform, value = score(a, b, best);
  for (const step of [1, 0.5, 0.25]) for (let pass = 0; pass < 2; pass++) {
    let improved = false;
    for (const parameter of [2, 5, 0, 4, 1, 3]) {
      let winner = best, winnerScore = value;
      for (const direction of [-1, 1]) {
        const next = [...best] as Transform, delta = direction * step * (parameter === 2 || parameter === 5 ? 1 : 1 / SIDE);
        next[parameter] += delta;
        if (parameter === 0 || parameter === 1) next[2] -= delta * SIDE / 2;
        if (parameter === 3 || parameter === 4) next[5] -= delta * SIDE / 2;
        const candidate = score(a, b, next);
        if (candidate > winnerScore + 0.00001) { winner = next; winnerScore = candidate; }
      }
      if (winner !== best) { best = winner; value = winnerScore; improved = true; }
    }
    if (!improved) break;
  }
  return best;
}

export type RowShift = { top: number; bottom: number; dx: number; dy: number };
/** A camera can bend or shear a paper receipt below the landmark grid's pixel
 * precision. Align each whole ink line by at most 1.5 normalized pixels; never
 * move individual glyphs or replace their residual content. */
export function alignInkRows(a: Uint8Array, b: Uint8Array, t: Transform): RowShift[] {
  const bands: RowShift[] = [];
  for (let y = 1; y < SIDE - 1; y++) {
    let count = 0; for (let x = 1; x < SIDE - 1; x++) if (a[y * SIDE + x] > 85) count++;
    if (count < 3) continue;
    const band = bands.at(-1);
    if (band && band.bottom >= y - 1) band.bottom = y; else bands.push({ top: y, bottom: y, dx: 0, dy: 0 });
  }
  for (const band of bands) {
    const value = (dx: number, dy: number) => {
      let shared = 0, union = 0;
      for (let y = band.top; y <= band.bottom; y++) for (let x = 1; x < SIDE - 1; x++) {
        const v = a[y * SIDE + x], w = sample(b, t[0] * x + t[1] * y + t[2] + dx, t[3] * x + t[4] * y + t[5] + dy);
        shared += Math.min(v, w); union += Math.max(v, w);
      }
      return shared / Math.max(1, union);
    };
    let best = value(0, 0);
    for (let pass = 0; pass < 2; pass++) for (const axis of ['dx', 'dy'] as const) for (let delta = -1.5; delta <= 1.5; delta += 0.25) { const candidate = value(axis === 'dx' ? delta : band.dx, axis === 'dy' ? delta : band.dy); if (candidate > best + 0.00001) { best = candidate; band[axis] = delta; } }
  }
  return bands;
}
