import { deflateSync } from 'node:zlib';

// Synthetic legible receipts exercise combined detector false positives.
// The measured fixture result is not a real-world accuracy estimate.
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const WIDTH = 432;
const HEIGHT = 208;
const SCALE = 2;

// Five columns by seven rows, kept inline so fixtures need no font dependency.
const GLYPHS = Object.fromEntries(Object.entries({
  A: '01110/10001/10001/11111/10001/10001/10001',
  B: '11110/10001/10001/11110/10001/10001/11110',
  C: '01111/10000/10000/10000/10000/10000/01111',
  D: '11110/10001/10001/10001/10001/10001/11110',
  E: '11111/10000/10000/11110/10000/10000/11111',
  F: '11111/10000/10000/11110/10000/10000/10000',
  G: '01111/10000/10000/10111/10001/10001/01111',
  H: '10001/10001/10001/11111/10001/10001/10001',
  I: '11111/00100/00100/00100/00100/00100/11111',
  J: '00111/00010/00010/00010/10010/10010/01100',
  K: '10001/10010/10100/11000/10100/10010/10001',
  L: '10000/10000/10000/10000/10000/10000/11111',
  M: '10001/11011/10101/10101/10001/10001/10001',
  N: '10001/11001/10101/10011/10001/10001/10001',
  O: '01110/10001/10001/10001/10001/10001/01110',
  P: '11110/10001/10001/11110/10000/10000/10000',
  Q: '01110/10001/10001/10001/10101/10010/01101',
  R: '11110/10001/10001/11110/10100/10010/10001',
  S: '01111/10000/10000/01110/00001/00001/11110',
  T: '11111/00100/00100/00100/00100/00100/00100',
  U: '10001/10001/10001/10001/10001/10001/01110',
  V: '10001/10001/10001/10001/10001/01010/00100',
  W: '10001/10001/10001/10101/10101/10101/01010',
  X: '10001/10001/01010/00100/01010/10001/10001',
  Y: '10001/10001/01010/00100/00100/00100/00100',
  Z: '11111/00001/00010/00100/01000/10000/11111',
  0: '01110/10001/10011/10101/11001/10001/01110',
  1: '00100/01100/00100/00100/00100/00100/01110',
  2: '01110/10001/00001/00010/00100/01000/11111',
  3: '11110/00001/00001/01110/00001/00001/11110',
  4: '00010/00110/01010/10010/11111/00010/00010',
  5: '11111/10000/10000/11110/00001/00001/11110',
  6: '01110/10000/10000/11110/10001/10001/01110',
  7: '11111/00001/00010/00100/01000/01000/01000',
  8: '01110/10001/10001/01110/10001/10001/01110',
  9: '01110/10001/10001/01111/00001/00001/01110',
  '-': '00000/00000/00000/11111/00000/00000/00000',
  '.': '00000/00000/00000/00000/00000/00110/00110',
  ':': '00000/00110/00110/00000/00110/00110/00000',
  '@': '01110/10001/10111/10101/10111/10000/01110',
  ' ': '00000/00000/00000/00000/00000/00000/00000',
}).map(([key, rows]) => [key, rows.split('/')]));

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const result = Buffer.alloc(body.length + 8);
  result.writeUInt32BE(data.length, 0);
  body.copy(result, 4);
  result.writeUInt32BE(crc32(body), result.length - 4);
  return result;
}

/** Insert actual PNG tEXt before IEND; preserves existing chunks and metadata. */
export function addTextMetadata(bytes, key, value) {
  const png = Buffer.from(bytes);
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('Expected a PNG');
  if (!/^[\x20-\x7e]{1,79}$/.test(key) || String(value).includes('\0')) {
    throw new Error('Invalid PNG text metadata');
  }
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > png.length) throw new Error('Truncated PNG chunk');
    if (png.toString('ascii', offset + 4, offset + 8) === 'IEND') {
      const text = chunk('tEXt', Buffer.from(`${key}\0${value}`, 'latin1'));
      return Buffer.concat([png.subarray(0, offset), text, png.subarray(offset)]);
    }
    offset = end;
  }
  throw new Error('PNG has no IEND');
}

function drawText(pixels, text, x, y) {
  for (const [index, letter] of [...text.toUpperCase()].entries()) {
    const rows = GLYPHS[letter];
    if (!rows) throw new Error(`Unsupported receipt glyph: ${letter}`);
    for (let row = 0; row < 7; row++) {
      for (let column = 0; column < 5; column++) {
        if (rows[row][column] !== '1') continue;
        for (let dy = 0; dy < SCALE; dy++) {
          for (let dx = 0; dx < SCALE; dx++) {
            const px = x + (index * 6 + column) * SCALE + dx;
            const py = y + row * SCALE + dy;
            if (px >= WIDTH || py >= HEIGHT) throw new Error('Receipt text overflow');
            pixels[py * WIDTH + px] = 24;
          }
        }
      }
    }
  }
}

/** Render a unique, legible grayscale PNG with matching visible receipt data. */
export function makeReceipt(record) {
  const pixels = Buffer.alloc(WIDTH * HEIGHT, 255);
  const lines = [
    'BUSINESS EXPENSE RECEIPT',
    record.merchant,
    `DATE: ${record.date}`,
    `TOTAL AUD: ${Number(record.amount).toFixed(2)}`,
    `INVOICE: ${record.id}`,
    record.employee,
  ];
  lines.forEach((line, index) => drawText(pixels, line, 12, 12 + index * 30));
  const scanlines = Buffer.alloc((WIDTH + 1) * HEIGHT);
  for (let row = 0; row < HEIGHT; row++) pixels.copy(scanlines, row * (WIDTH + 1) + 1, row * WIDTH, (row + 1) * WIDTH);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8; // Eight-bit grayscale, filter zero on each scanline.
  let png = Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND')]);
  if (record.software) png = addTextMetadata(png, 'Software', record.software);
  if (record.imageDate) png = addTextMetadata(png, 'DateTimeOriginal', `${record.imageDate.replaceAll('-', ':')} 12:00:00`);
  return png;
}
