export type ReceiptMetadata = {
  status: 'checked' | 'no metadata to check' | 'unsupported';
  fields: { software?: string; dateTimeOriginal?: string; dateTime?: string };
  signals: { code: 'editing-software' | 'image-date-mismatch'; label: 'possible, needs review'; reason: string }[];
};
type Fields = ReceiptMetadata['fields'];

/** Local metadata observations only: neither missing fields nor these signals establish authenticity. */
export function inspectReceiptMetadata(bytes: Uint8Array, media: string, spentOn: string): ReceiptMetadata {
  const fields: Fields = {}, signals: ReceiptMetadata['signals'] = [];
  const jpeg = media === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216;
  const png = media === 'image/png' && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v);
  if (!jpeg && !png) return { status: 'unsupported', fields, signals };
  if (jpeg) jpegFields(bytes, fields); else pngFields(bytes, fields);
  if (fields.software && /\b(?:photoshop|gimp|affinity photo|pixelmator)\b/i.test(fields.software)) {
    signals.push({ code: 'editing-software', label: 'possible, needs review', reason: `Software metadata names image-editing software: ${fields.software}. This can reflect legitimate receipt preparation; review the receipt.` });
  }
  const originalDate = imageDate(fields.dateTimeOriginal || '');
  if (originalDate && imageDate(spentOn) === spentOn && originalDate !== spentOn) {
    signals.push({ code: 'image-date-mismatch', label: 'possible, needs review', reason: `Image DateTimeOriginal date ${originalDate} differs from expense date ${spentOn}. Later photographs can be legitimate; review the receipt.` });
  }
  return { status: Object.keys(fields).length ? 'checked' : 'no metadata to check', fields, signals };
}

function imageDate(value: string): string | undefined {
  const match = /^(\d{4})([:-])(\d{2})\2(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/.exec(value);
  if (!match) return;
  const [, year, , month, day, hour, minute, second] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!y || !m || m > 12 || !d || d > days[m - 1] || Number(hour || 0) > 23 || Number(minute || 0) > 59 || Number(second || 0) > 59) return;
  return `${year}-${month}-${day}`;
}

function text(bytes: Uint8Array): string | undefined {
  if (!bytes.length || bytes.length > 1024 || bytes.some(v => v < 32 || (v > 126 && v < 160))) return;
  return String.fromCharCode(...bytes).trim() || undefined;
}

// Only follow the two declared IFDs. Offsets are relative to this bounded TIFF payload.
function tiffFields(bytes: Uint8Array, fields: Fields) {
  if (bytes.length < 8) return;
  const order = String.fromCharCode(bytes[0], bytes[1]);
  if (order !== 'II' && order !== 'MM') return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), little = order === 'II';
  const u16 = (p: number) => view.getUint16(p, little), u32 = (p: number) => view.getUint32(p, little);
  if (u16(2) !== 42) return;
  const directory = (offset: number, original: boolean): number | undefined => {
    if (offset < 8 || offset + 2 > bytes.length) return;
    const count = u16(offset);
    if (count > 256 || offset + 2 + count * 12 + 4 > bytes.length) return;
    let child: number | undefined;
    for (let i = 0; i < count; i++) {
      const p = offset + 2 + i * 12, tag = u16(p), type = u16(p + 2), size = u32(p + 4);
      if (!original && tag === 0x8769 && type === 4 && size === 1) child ??= u32(p + 8);
      const key = original ? (tag === 0x9003 ? 'dateTimeOriginal' : undefined) : tag === 0x0131 ? 'software' : tag === 0x0132 ? 'dateTime' : undefined;
      if (!key || type !== 2 || size < 2 || size > 1024) continue;
      const start = size <= 4 ? p + 8 : u32(p + 8), end = start + size;
      if (start < 8 || end > bytes.length || bytes[end - 1] !== 0) continue;
      const value = text(bytes.subarray(start, end - 1));
      if (!value || (key !== 'software' && (size !== 20 || !/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(value) || !imageDate(value)))) continue;
      if (bytes.subarray(start, end - 1).some(v => v > 127)) continue; // TIFF ASCII, not PNG Latin-1.
      fields[key] ??= value;
    }
    return child;
  };
  const child = directory(u32(4), false);
  if (child !== undefined) directory(child, true);
}

function jpegFields(bytes: Uint8Array, fields: Fields) {
  let p = 2;
  for (let segments = 0; segments < 4096 && p < bytes.length; segments++) {
    if (bytes[p++] !== 255) return;
    while (p < bytes.length && bytes[p] === 255) p++;
    if (p >= bytes.length) return;
    const marker = bytes[p++];
    if (marker === 0xda || marker === 0xd9) return; // Never search scan data or bytes after EOI.
    if (marker === 0 || marker === 0xd8) return;
    if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (p + 2 > bytes.length) return;
    const size = bytes[p] * 256 + bytes[p + 1], end = p + size;
    if (size < 2 || end > bytes.length) return;
    if (marker === 0xe1 && size >= 8 && [69, 120, 105, 102, 0, 0].every((v, i) => bytes[p + 2 + i] === v)) {
      tiffFields(bytes.subarray(p + 8, end), fields);
    }
    p = end;
  }
}

function crcMatches(bytes: Uint8Array, start: number, end: number, expected: number): boolean {
  let crc = 0xffffffff;
  for (let p = start; p < end; p++) {
    crc ^= bytes[p];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return ((crc ^ 0xffffffff) >>> 0) === expected;
}

// PNG: https://www.w3.org/TR/png-3/ (tEXt and eXIf); compressed text is outside this slice.
function pngFields(bytes: Uint8Array, fields: Fields) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 8;
  for (let chunks = 0; chunks < 4096 && p + 12 <= bytes.length; chunks++) {
    const size = view.getUint32(p), end = p + 8 + size;
    if (size > 0x7fffffff || end + 4 > bytes.length) return;
    const kind = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    if (p === 8 && (kind !== 'IHDR' || size !== 13)) return;
    if (kind === 'IEND') return; // Ignore all trailing bytes.
    if ((kind === 'tEXt' || kind === 'eXIf') && size <= 131072 && crcMatches(bytes, p + 4, end, view.getUint32(end))) {
      const payload = bytes.subarray(p + 8, end);
      if (kind === 'eXIf') tiffFields(payload, fields);
      else if (size <= 1104) {
        const separator = payload.indexOf(0);
        if (separator > 0 && separator <= 79) {
          const key = String.fromCharCode(...payload.subarray(0, separator)), value = text(payload.subarray(separator + 1));
          if (value && key === 'Software') fields.software ??= value;
          if (value && key === 'Creation Time') fields.dateTime ??= value; // Format is undefined by PNG; preserve it.
          if (value && key === 'DateTimeOriginal' && imageDate(value)) fields.dateTimeOriginal ??= value;
        }
      }
    }
    p = end + 4;
  }
}
