import { decode as decodeJpeg } from 'jpeg-js';
import { decode as decodePng, convertIndexedToRgb } from 'fast-png';
import { decode as decodeWebp, getWebpInfo, parseRiff } from '@stacksjs/ts-webp';
import { SIDE, IDENTITY, normalizeRaster, packInk, unpackInk, landmarks, register, sample, type Raster, type Transform } from './receipt-image-raster';

export type ReceiptImageFingerprint = { version: 1; width: number; height: number; ink: string; landmarks: string; coverage: number; skew: number };
export type ImageObservation = { code: 'compression-grid'; label: 'possible, needs review'; reason: string; evidence: Record<string, number> };
export type ReceiptImageInspection = { status: 'checked' | 'unsupported' | 'corrupt' | 'limited'; fingerprint?: ReceiptImageFingerprint; observations: ImageObservation[]; reason?: string };
export type ImageComparison = {
  status: 'compared' | 'insufficient';
  evidence: { inkSimilarity: number; overlap: number; changedInkFraction: number; changedRegions: number; changedBands: number; registrationInliers: number; registrationMatches: number; transform: Transform };
  signals: { code: 'near-duplicate-image' | 'image-content-change'; label: 'possible, needs review'; reason: string }[];
};
type Pixels = { width: number; height: number; data: Uint8Array | Uint8ClampedArray | Uint16Array; channels: number; max: number };
const MAX_PIXELS = 24_000_000;
const inkCache = new WeakMap<ReceiptImageFingerprint, Uint8Array>();
const inkFor = (fingerprint: ReceiptImageFingerprint) => {
  if (!inkCache.has(fingerprint)) inkCache.set(fingerprint, unpackInk(fingerprint.ink));
  return inkCache.get(fingerprint)!;
};
class InspectionLimit extends Error {}
function dimensions(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('Invalid image dimensions');
  if (width * height > MAX_PIXELS) throw new InspectionLimit('Image exceeds the 24 megapixel local inspection limit');
}
async function pixels(bytes: Uint8Array, media: string): Promise<Pixels> {
  if (media === 'image/jpeg') return { ...decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true, tolerantDecoding: false, maxResolutionInMP: 24, maxMemoryUsageInMB: 256 }), channels: 4, max: 255 };
  if (media === 'image/webp') {
    const info = getWebpInfo(parseRiff(bytes)); dimensions(info.width, info.height);
    if (info.hasAnimation) throw new InspectionLimit('Animated WebP inspection requires individual frame review');
    return { ...decodeWebp(bytes), channels: 4, max: 255 };
  }
  if (media === 'image/png') {
    if (bytes.length < 24) throw new Error('Truncated PNG');
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); dimensions(header.getUint32(16), header.getUint32(20));
    const image = decodePng(bytes, { checkCrc: true });
    if (image.palette) { const data = convertIndexedToRgb(image); return { ...image, data, channels: image.palette[0].length, max: 255 }; }
    if (image.depth < 8) {
      const data = new Uint8Array(image.width * image.height), stride = Math.ceil(image.width * image.depth / 8), mask = (1 << image.depth) - 1;
      for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) data[y * image.width + x] = ((image.data[y * stride + (x * image.depth >> 3)] >> (8 - image.depth - (x * image.depth % 8))) & mask) * 255 / mask;
      return { ...image, data, channels: 1, max: 255 };
    }
    // tRNS applies to whole samples. Composite transparent pixels against paper white.
    if (image.transparency?.length) {
      const source = image.data, channels = image.channels, alphaMax = image.depth === 16 ? 65535 : 255;
      const data = new Uint16Array(image.width * image.height * (channels + 1));
      for (let p = 0; p < image.width * image.height; p++) { let transparent = true; for (let c = 0; c < channels; c++) { const value = source[p * channels + c]; data[p * (channels + 1) + c] = value; transparent &&= value === image.transparency[c]; } data[p * (channels + 1) + channels] = transparent ? 0 : alphaMax; }
      return { ...image, data, channels: channels + 1, max: alphaMax };
    }
    return { ...image, max: image.depth === 16 ? 65535 : 255 };
  }
  const { default: heif } = await import('libheif-js'), decoder = new heif.HeifDecoder(), images = decoder.decode(bytes);
  try {
    if (!images.length) throw new Error('HEIC contains no decodable image');
    if (images.length > 1) throw new InspectionLimit('Multi-image HEIC inspection requires individual image review');
    const image = images[0], width = image.get_width(), height = image.get_height(); dimensions(width, height);
    const result = await new Promise<{ width: number; height: number; data: Uint8ClampedArray }>((resolve, reject) => image.display({ width, height, data: new Uint8ClampedArray(width * height * 4) }, value => value ? resolve(value) : reject(new Error('HEIC pixel decoding failed'))));
    return { ...result, channels: 4, max: 255 };
  } finally { images.forEach(image => image.free()); if (decoder.decoder) heif.heif_context_free(decoder.decoder); }
}
function grayRaster(image: Pixels): Raster {
  const scale = Math.min(1, 768 / Math.max(image.width, image.height)), width = Math.max(1, Math.round(image.width * scale)), height = Math.max(1, Math.round(image.height * scale)), gray = new Uint8Array(width * height);
  const at = (x: number, y: number) => {
    const p = (Math.min(image.height - 1, y) * image.width + Math.min(image.width - 1, x)) * image.channels, monochrome = image.channels <= 2;
    const light = monochrome ? image.data[p] : image.data[p] * 0.2126 + image.data[p + 1] * 0.7152 + image.data[p + 2] * 0.0722;
    const alpha = image.channels === 2 || image.channels === 4 ? image.data[p + image.channels - 1] / image.max : 1;
    return 255 * (light / image.max * alpha + 1 - alpha);
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let total = 0; for (const dy of [0.25, 0.75]) for (const dx of [0.25, 0.75]) total += at(Math.floor((x + dx) / scale), Math.floor((y + dy) / scale)); gray[y * width + x] = total / 4;
  }
  return { width, height, gray };
}
/** Local pixel observations only. No image-only algorithm can establish generation or authenticity. */
export async function inspectReceiptImage(bytes: Uint8Array, media: string): Promise<ReceiptImageInspection> {
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/heic'].includes(media)) return { status: 'unsupported', observations: [], reason: 'Local content inspection supports JPEG, PNG, WebP and single-image HEIC' };
  if (bytes.length > 25_000_000) return { status: 'limited', observations: [], reason: 'Image exceeds the 25 MB local inspection limit' };
  try {
    const decoded = await pixels(bytes, media); dimensions(decoded.width, decoded.height);
    const raster = grayRaster(decoded), normalized = normalizeRaster(raster);
    if (normalized.coverage < 0.001 || normalized.coverage > 0.65) return { status: 'limited', observations: [], reason: 'Insufficient separable receipt ink for a content comparison' };
    const observations: ImageObservation[] = [];
    if (media === 'image/jpeg' && raster.width === decoded.width) {
      let edges = 0, interior = 0, edgeCount = 0, interiorCount = 0;
      for (let y = 1; y < raster.height; y++) for (let x = 1; x < raster.width; x++) for (const [offset, boundary] of [[1, x % 8 === 0], [raster.width, y % 8 === 0]] as const) {
        const difference = Math.abs(raster.gray[y * raster.width + x] - raster.gray[y * raster.width + x - offset]);
        if (boundary) { edges += difference; edgeCount++; } else { interior += difference; interiorCount++; }
      }
      const contrast = edges / Math.max(1, edgeCount), ratio = contrast / Math.max(1, interior / Math.max(1, interiorCount));
      if (contrast > 10 && ratio > 2.5) observations.push({ code: 'compression-grid', label: 'possible, needs review', reason: 'Visible 8-pixel compression-grid discontinuities; ordinary JPEG compression can produce this artifact. This does not identify an editor or generator.', evidence: { boundaryContrast: contrast, boundaryToInteriorRatio: ratio } });
    }
    return { status: 'checked', fingerprint: { version: 1, width: decoded.width, height: decoded.height, ink: packInk(normalized.ink), landmarks: landmarks(normalized.ink), coverage: normalized.coverage, skew: normalized.skew }, observations };
  } catch (error) { return { status: error instanceof InspectionLimit ? 'limited' : 'corrupt', observations: [], reason: error instanceof InspectionLimit ? error.message : `Image bytes could not be decoded for local content inspection: ${error instanceof Error ? error.message : 'decoder refused'}` }; }
}
function measure(a: Uint8Array, b: Uint8Array, t: Transform) {
  let shared = 0, union = 0, available = 0, total = 0, changed = 0;
  const tiles = new Float64Array(24 * 24), masses = new Float64Array(24 * 24);
  for (let y = 1; y < SIDE - 1; y++) for (let x = 1; x < SIDE - 1; x++) {
    const v = a[y * SIDE + x], bx = t[0] * x + t[1] * y + t[2], by = t[3] * x + t[4] * y + t[5]; total += v;
    if (bx < 1 || by < 1 || bx >= SIDE - 1 || by >= SIDE - 1) continue;
    available += v; const w = sample(b, bx, by), difference = Math.abs(v - w), mass = Math.max(v, w), tile = (y >> 3) * 24 + (x >> 3);
    shared += Math.min(v, w); union += mass; masses[tile] += mass;
    // Differences smaller than quantization / gentle resampling do not form changed regions.
    const change = Math.max(0, difference - 38); changed += change; tiles[tile] += change;
  }
  const active = tiles.map((v, i) => Number(v > 110 && v / Math.max(1, masses[i]) > 0.12)), seen = new Set<number>(); let regions = 0;
  for (let p = 0; p < active.length; p++) if (active[p] && !seen.has(p)) {
    regions++; const queue = [p]; seen.add(p);
    for (const q of queue) for (const d of [-24, -1, 1, 24]) { const n = q + d; if (n >= 0 && n < 576 && Math.abs(n % 24 - q % 24) + Math.abs(Math.floor(n / 24) - Math.floor(q / 24)) === 1 && active[n] && !seen.has(n)) { seen.add(n); queue.push(n); } }
  }
  let changedBands = 0, previous = false;
  for (let y = 0; y < 24; y++) { const present = active.slice(y * 24, (y + 1) * 24).some(Boolean); if (present && !previous) changedBands++; previous = present; }
  return { changedBands, inkSimilarity: shared / Math.max(1, union), overlap: available / Math.max(1, total), changedInkFraction: changed / Math.max(1, union), changedRegions: regions };
}
/** Reusable fingerprints contain no merchant/date assumptions or fixture-specific recognition. */
export function compareReceiptImages(first: ReceiptImageFingerprint, second: ReceiptImageFingerprint): ImageComparison {
  const empty = { inkSimilarity: 0, overlap: 0, changedInkFraction: 0, changedRegions: 0, changedBands: 0, registrationInliers: 0, registrationMatches: 0, transform: IDENTITY };
  if (first.version !== 1 || second.version !== 1) return { status: 'insufficient', evidence: empty, signals: [] };
  try {
    const a = inkFor(first), b = inkFor(second);
    if (a.length !== SIDE * SIDE || b.length !== a.length) return { status: 'insufficient', evidence: empty, signals: [] };
    let transform = IDENTITY, evidence = measure(a, b, transform), registrationInliers = 0, registrationMatches = 0;
    if (evidence.inkSimilarity < 0.93) {
      const alignment = register(first.landmarks, second.landmarks); registrationInliers = alignment.inliers; registrationMatches = alignment.matches;
      if (alignment.inliers >= 8 && alignment.inliers / Math.max(1, alignment.matches) >= 0.3) {
        const candidate = measure(a, b, alignment.transform);
        if (candidate.inkSimilarity * candidate.overlap > evidence.inkSimilarity * evidence.overlap) { evidence = candidate; transform = alignment.transform; }
      }
    }
    const signals: ImageComparison['signals'] = [], { inkSimilarity: similarity, overlap, changedInkFraction: fraction, changedRegions: regions } = evidence;
    if (overlap >= 0.72 && (similarity >= 0.91 && fraction < 0.012 && regions === 0 || similarity >= 0.8 && registrationInliers >= 64 && registrationInliers / Math.max(1, registrationMatches) >= 0.95)) signals.push({ code: 'near-duplicate-image', label: 'possible, needs review', reason: 'The overlapping visible receipt ink closely matches an earlier image after geometric normalization. Recompression, a crop, or a later photograph can explain this; compare the original receipts.' });
    else if (overlap >= 0.9 && similarity >= 0.87 && fraction >= 0.001 && fraction < 0.05 && evidence.changedBands === 1) signals.push({ code: 'image-content-change', label: 'possible, needs review', reason: 'Most visible receipt ink matches an earlier image, with a localized changed region. This can be an edit or legitimate receipt variation; review the changed area and source receipts.' });
    return { status: 'compared', evidence: { ...evidence, registrationInliers, registrationMatches, transform }, signals };
  } catch { return { status: 'insufficient', evidence: empty, signals: [] }; }
}
