import { Fault, requireThat, text } from '../types';

export const CAPTURE_RECEIPT_LIMIT = 10_000_000;
const REQUEST_LIMIT = CAPTURE_RECEIPT_LIMIT + 65_536;

/** Bound actual streamed bytes too: Content-Length is not a trust boundary. */
async function multipart(request: Request): Promise<FormData> {
  requireThat(/^multipart\/form-data\s*;/i.test(request.headers.get('content-type') ?? ''), 'Send one receipt as multipart form data', 415);
  const length = request.headers.get('content-length');
  requireThat(!length || (/^\d+$/.test(length) && Number(length) <= REQUEST_LIMIT), 'Each receipt can be at most 10 MB', 413);
  requireThat(request.body, 'Choose a receipt file');
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > REQUEST_LIMIT) {
        await reader.cancel();
        throw new Fault(413, 'Each receipt can be at most 10 MB');
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try { return await new Response(body, { headers: { 'content-type': request.headers.get('content-type')! } }).formData(); }
  catch { throw new Fault(400, 'The receipt upload could not be read; choose the file again'); }
}

/** The file's signature decides its media type, never its name or browser MIME. */
export function receiptMedia(bytes: Uint8Array): string {
  const starts = (signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (starts([255,216,255])) return 'image/jpeg';
  if (starts([137,80,78,71,13,10,26,10])) return 'image/png';
  if (ascii(0,5) === '%PDF-') return 'application/pdf';
  if (bytes.length >= 20 && ascii(0,4) === 'RIFF' && ascii(8,12) === 'WEBP' && ['VP8 ','VP8L','VP8X'].includes(ascii(12,16))) return 'image/webp';
  if (bytes.length >= 20 && ascii(4,8) === 'ftyp') {
    const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (boxSize >= 20 && boxSize <= bytes.length && boxSize <= 4096 && boxSize % 4 === 0) {
      const brands = [ascii(8,12)];
      for (let offset = 16; offset < boxSize; offset += 4) brands.push(ascii(offset,offset+4));
      if (brands.some(brand => ['heic','heix','hevc','hevx'].includes(brand))) return 'image/heic';
    }
  }
  throw new Fault(415, 'Receipts must be JPEG, PNG, WebP, HEIC or PDF files');
}

export async function receiptUpload(request: Request) {
  const form = await multipart(request), files = form.getAll('file');
  requireThat(files.length === 1 && typeof files[0] !== 'string', 'Choose exactly one receipt file per upload');
  for (const [key] of form) requireThat(key === 'file' || key === 'source' || key === 'merchant', 'Only a file, capture source and optional entered merchant may be supplied');
  requireThat(form.getAll('source').length <= 1, 'Choose one capture source');
  const source = form.get('source') ?? 'upload';
  requireThat(source === 'upload' || source === 'camera', 'Capture source must be upload or camera');
  const file = files[0];
  requireThat(file.size > 0, 'Choose a receipt file');
  requireThat(file.size <= CAPTURE_RECEIPT_LIMIT, 'Each receipt can be at most 10 MB', 413);
  const name = text(file.name, 'File name', 200);
  requireThat(!/[\u0000-\u001f\u007f]/.test(name), 'File names cannot contain control characters');
  const bytes = new Uint8Array(await file.arrayBuffer());
  requireThat(form.getAll('merchant').length<=1,'Enter one merchant');
  const merchant=form.get('merchant');requireThat(merchant===null||typeof merchant==='string','Merchant must be entered text');
  return { ...(merchant?{merchant:text(merchant,'Merchant',200)}:{}), bytes, mediaType: receiptMedia(bytes), name, source };
}
