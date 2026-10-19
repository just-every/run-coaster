/** A stored (uncompressed) ZIP archive: receipts are already compressed, and a stored entry keeps every byte exact. */
const table = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (bytes: Uint8Array) => { let c = 0xffffffff; for (const b of bytes) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export function zip(files: { name: string; bytes: Uint8Array }[], at: Date) {
  const time = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1);
  const date = ((at.getUTCFullYear() - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  const locals: Uint8Array[] = [], centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.name), crc = crc32(file.bytes), size = file.bytes.length;
    // The fields both headers share, from "version needed" to the name length; flag 0x0800 marks UTF-8 names.
    const common = (v: DataView, from: number) => {
      v.setUint16(from, 20, true); v.setUint16(from + 2, 0x0800, true); v.setUint16(from + 4, 0, true); v.setUint16(from + 6, time, true); v.setUint16(from + 8, date, true);
      v.setUint32(from + 10, crc, true); v.setUint32(from + 14, size, true); v.setUint32(from + 18, size, true); v.setUint16(from + 22, name.length, true);
    };
    const local = new Uint8Array(30 + name.length + size), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); common(lv, 4); local.set(name, 30); local.set(file.bytes, 30 + name.length);
    const central = new Uint8Array(46 + name.length), cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); common(cv, 6); cv.setUint32(42, offset, true); central.set(name, 46);
    locals.push(local); centrals.push(central); offset += local.length;
  }
  const directory = centrals.reduce((n, c) => n + c.length, 0), end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true); ev.setUint32(12, directory, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + directory + 22);
  let position = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, position); position += part.length; }
  return out;
}
