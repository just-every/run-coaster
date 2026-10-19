import { sha256, type Diagnostic, type SourceArtifact } from '../../modules/import-kit/src/d1/index';
import { receiptBytes } from '../claims';
import { Fault, requireThat, type Data } from '../types';

export type ConcurReceipt = { name: string; sha256: string; size: number; mediaType: string; imageId: string; report: string; entry: string | null };
export const encoded = (bytes: Uint8Array) => { let out = ''; for (let n = 0; n < bytes.length; n += 8192) out += String.fromCharCode(...bytes.subarray(n, n + 8192)); return btoa(out); };
export const originalArtifact = (name: string, bytes: Uint8Array): SourceArtifact => ({ name, sha256: sha256(bytes), size: bytes.length, original: { status: 'available', base64: encoded(bytes) } });
const decoded = (value: unknown) => { requireThat(typeof value === 'string' && value.length <= 11_000_000, 'Choose a receipt archive or file of at most 8 MB'); try { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); } catch { throw new Fault(400,'The receipt archive could not be read'); } };
const filename = (value: string) => { requireThat(value.length > 0 && value.length <= 200 && !value.includes('\\') && !value.startsWith('/') && !value.split('/').some(p => p === '..' || p === '.') && !/[\u0000-\u001f]/.test(value), 'Receipt archive paths must be relative file names without traversal'); return value; };
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (bytes: Uint8Array) => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** Central-directory sizes bound decompression before retaining any archive member. No path is ever written to disk. */
async function unzip(bytes: Uint8Array) {
  requireThat(bytes.length <= 8_000_000 && bytes.length >= 22, 'Receipt archives can be at most 8 MB');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), u16 = (n: number) => v.getUint16(n, true), u32 = (n: number) => v.getUint32(n, true);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && u32(end) !== 0x06054b50) end--;
  requireThat(end >= 0 && u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length, 'The ZIP directory is missing or malformed');
  requireThat(u16(end + 4) === 0 && u16(end + 6) === 0 && u16(end + 8) === u16(end + 10), 'Use a single-volume receipt ZIP');
  const count = u16(end + 10), start = u32(end + 16), size = u32(end + 12);
  requireThat(count <= 100 && start + size === end, 'Receipt ZIPs can contain at most 100 files and folders');
  const files = new Map<string, Uint8Array>(); let p = start, total = 0;
  for (let i = 0; i < count; i++) {
    requireThat(p + 46 <= end && u32(p) === 0x02014b50, 'The receipt ZIP directory is malformed');
    const flags = u16(p + 8), method = u16(p + 10), packed = u32(p + 20), length = u32(p + 24), nameLength = u16(p + 28), extra = u16(p + 30), comment = u16(p + 32), offset = u32(p + 42), crc = u32(p + 16);
    requireThat(p + 46 + nameLength + extra + comment <= end && !(flags & 1) && [0, 8].includes(method), 'Use a decrypted ZIP with stored or deflated files');
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(p + 46, p + 46 + nameLength));
    p += 46 + nameLength + extra + comment;
    if (name.endsWith('/')) { filename(name.slice(0, -1)); continue; }
    filename(name); requireThat(!files.has(name), 'A receipt ZIP contains a repeated file name');
    total += length; requireThat(length <= 1_500_000 && total <= 8_000_000, 'Each extracted receipt can be at most 1.5 MB and the extracted archive at most 8 MB');
    requireThat(offset + 30 <= start && u32(offset) === 0x04034b50, 'A receipt ZIP member has no local header');
    const from = offset + 30 + u16(offset + 26) + u16(offset + 28);
    requireThat(from + packed <= start && u16(offset + 8) === method && !(u16(offset + 6) & 1), 'A receipt ZIP member is malformed');
    const localName = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset + 30, offset + 30 + u16(offset + 26)));
    requireThat(localName === name, 'Receipt ZIP member names disagree');
    const packedBytes = bytes.subarray(from, from + packed);
    let out = packedBytes;
    if (method === 8) {
      const stream = new Blob([new Uint8Array(packedBytes)]).stream().pipeThrough(new DecompressionStream('deflate-raw' as CompressionFormat)), reader = stream.getReader(), chunks: Uint8Array[] = []; let used = 0;
      try { for (;;) { const r = await reader.read(); if (r.done) break; used += r.value.length; requireThat(used <= length, 'An extracted receipt exceeded its declared size'); chunks.push(r.value); } } finally { await reader.cancel(); }
      out = new Uint8Array(used); let at = 0; for (const c of chunks) { out.set(c, at); at += c.length; }
    }
    requireThat(out.length === length && crc32(out) === crc, 'A receipt ZIP member failed its size or CRC check'); files.set(name, out);
  }
  requireThat(p === end, 'The receipt ZIP directory length is inconsistent'); return files;
}

/** Delimited records, including embedded newlines and doubled quotes, used by SAE and image indexes. */
export function delimited(raw: string, separator: string) {
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false, closed = false;
  const cell = () => { row.push(field); field = ''; closed = false; }, line = () => { cell(); if (row.some(s => s.length)) rows.push(row); row = []; };
  const text = raw.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c !== '"') field += c; else if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } }
    else if (c === separator) cell();
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; line(); }
    else { requireThat(!closed, 'Unexpected data after a quoted field'); if (c === '"') { requireThat(field.length === 0, 'Unexpected quote in an extract field'); quoted = true; } else field += c; }
  }
  requireThat(!quoted, 'An extract field has an unclosed quote'); line(); return rows;
}

/** SAP Image Delivery's CSV index uses report/employee/report-key and entry::image pairs separated by ||.
 * An explicit Receipt File column or reviewed imageFiles crosswalk handles archive names that differ from image ids.
 * Report-level images remain report-level: no invented attachment to each expense. */
export async function concurReceipts(input: unknown, imageFiles: Record<string, string> = {}) {
  const data = (Array.isArray(input) ? { files: input } : input ?? {}) as Data;
  const files = new Map<string, Uint8Array>(), artifacts: SourceArtifact[] = [], diagnostics: Diagnostic[] = [], attachments: ConcurReceipt[] = [];
  if (data.archive) { const bytes = decoded(data.archive.base64), name = filename(data.archive.name || 'concur-receipts.zip'); artifacts.push(originalArtifact(name, bytes)); for (const [n, b] of await unzip(bytes)) files.set(n, b); }
  requireThat(data.files === undefined || (Array.isArray(data.files) && data.files.length <= 50), 'Add at most 50 receipt files');
  for (const f of data.files ?? []) { const name = filename(f.name); requireThat(!files.has(name), 'A receipt file was added twice'); files.set(name, decoded(f.base64)); }
  const indexes = [...files].filter(([n]) => /\.csv$/i.test(n));
  if (data.index) { requireThat(typeof data.index.csv === 'string', 'Choose a receipt index CSV'); const n = filename(data.index.name || 'concur-image-index.csv'); requireThat(!files.has(n), 'The receipt index was added twice'); const b = new TextEncoder().encode(data.index.csv); files.set(n, b); indexes.push([n, b]); }
  requireThat(indexes.length <= 1, 'Choose one receipt index CSV per import');
  if (!files.size) return { artifacts, diagnostics, attachments };
  requireThat(indexes.length === 1, 'Add the SAP image index CSV with the receipt files');
  const [indexName, indexBytes] = indexes[0], rows = delimited(new TextDecoder('utf-8', { fatal: true }).decode(indexBytes), ',');
  const normalize = (s: string) => s.trim().toLowerCase().replace(/[ _-]/g, '');
  const header = rows[0]?.map(normalize) ?? [], hasHeader = header[0] === 'reportid'; if (hasHeader) rows.shift();
  const col = (name: string) => header.indexOf(normalize(name)), used = new Set<string>([indexName]);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i], report = row[hasHeader ? col('Report ID') : 0]?.trim(), location = { artifact: indexName, row: i + (hasHeader ? 2 : 1) };
    const fail = (message: string) => diagnostics.push({ severity: 'error', code: 'RECEIPT_INDEX', message: `Image index row ${location.row}: ${message}`, location });
    if (!report) { fail('Report ID is empty'); continue; }
    const explicitFile = hasHeader && col('Receipt File') >= 0 ? row[col('Receipt File')]?.trim() : '';
    const entry = hasHeader && col('Entry ID') >= 0 ? row[col('Entry ID')]?.trim() : '';
    const pairs = hasHeader && col('Image ID') >= 0 ? [`${entry ? entry + '::' : ''}${row[col('Image ID')] ?? ''}`] : row.slice(3).join('||').split('||');
    for (const pair of pairs.filter(v => v.trim())) {
      const split = pair.trim().split('::'); if (split.length > 2) { fail('Use entry::image pairs'); continue; }
      const imageId = split.at(-1)!.trim(), entryId = split.length === 2 ? split[0].trim() : null;
      if (!imageId) { fail('Image ID is empty'); continue; }
      const requested = explicitFile || imageFiles[imageId] || imageId;
      const candidates = files.has(requested) ? [requested] : [...files.keys()].filter(n => n.replace(/\.[^.\/]+$/, '') === requested);
      if (candidates.length !== 1) { fail(`Image ${imageId} needs exactly one file; map its image id to the archive file name`); continue; }
      const name = candidates[0], bytes = files.get(name)!;
      try {
        const parsed = receiptBytes({ name, base64: encoded(bytes) });
        attachments.push({ name, sha256: sha256(bytes), size: bytes.length, mediaType: parsed.media!, imageId, report, entry: entryId || null }); used.add(name);
      } catch (e) { fail(`Receipt ${name}: ${(e as Error).message}`); }
    }
  }
  for (const [name, bytes] of files) { if (used.has(name)) artifacts.push(originalArtifact(name, bytes)); else diagnostics.push({ severity: 'error', code: 'UNMAPPED_RECEIPT', message: `Receipt archive file ${name} is not mapped by its image index` }); }
  requireThat(attachments.length <= 100, 'Import at most 100 receipt associations at a time');
  return { artifacts, diagnostics, attachments };
}
