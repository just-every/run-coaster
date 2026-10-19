import { PDFDocument, PDFImage, concatTransformationMatrix, drawObject, pushGraphicsState, popGraphicsState, degrees, type PDFPage } from 'pdf-lib';
import { decode as decodeWebp } from '@stacksjs/ts-webp';
import { sha256Hex } from './session';
import { Fault, requireThat, type Data } from './types';
import { MARGIN, PAGE, type PdfLayout } from './pdf-layout';

/** Keep original bytes inside the PDF too, so the stamped SHA-256 can be independently verified. */
export async function appendReceipt(layout: PdfLayout, item: Data, receipt: Data, label: string) {
  const bytes = new Uint8Array(receipt.bytes as ArrayBuffer);
  requireThat(await sha256Hex(bytes) === receipt.sha256, `Receipt ${receipt.name} failed its fingerprint check`, 409);
  try {
    await layout.doc.attach(bytes, `${label.replace(/[^a-zA-Z0-9-]/g, '-')}-${receipt.sha256}.${String(receipt.name).split('.').at(-1)?.replace(/[^a-zA-Z0-9]/g, '') || 'receipt'}`, { mimeType: receipt.media_type, description: `Expense ${item.id}; SHA-256 ${receipt.sha256}; original ${receipt.name}` });
    if (receipt.media_type === 'application/pdf') {
      const source = await PDFDocument.load(bytes);
      for (const [index, original] of source.getPages().entries()) {
        const page = receiptPage(layout, item, receipt, label, index + 1, source.getPageCount());
        // A genuinely blank source page still occupies its place in the receipt.
        if (!original.node.Contents()) continue;
        const embedded = await layout.doc.embedPage(original);
        const rotation = ((original.getRotation().angle % 360) + 360) % 360;
        const sideways = rotation === 90 || rotation === 270;
        const available = Math.min(650, layout.y - 90);
        const scale = Math.min((PAGE[0] - MARGIN * 2) / (sideways ? embedded.height : embedded.width), available / (sideways ? embedded.width : embedded.height));
        const width = embedded.width * scale, height = embedded.height * scale;
        const x = (PAGE[0] - (sideways ? height : width)) / 2, y = 73 + (available - (sideways ? width : height)) / 2;
        const offset = rotation === 90 ? [0, width] : rotation === 180 ? [width, height] : rotation === 270 ? [height, 0] : [0, 0];
        page.drawPage(embedded, { x: x + offset[0], y: y + offset[1], width, height, rotate: degrees(-rotation) });
      }
    } else {
      const images = receipt.media_type === 'image/heic' ? await heicImages(bytes, layout) : [receipt.media_type === 'image/jpeg' ? await layout.doc.embedJpg(bytes) : receipt.media_type === 'image/png' ? await layout.doc.embedPng(bytes) : rawImage(layout, decodeWebp(bytes))];
      images.forEach((image, index) => {
        const page = receiptPage(layout, item, receipt, label, index + 1, images.length);
        const available = Math.min(650, layout.y - 90);
        const scale = Math.min((PAGE[0] - MARGIN * 2) / image.width, available / image.height);
        const box = { x: (PAGE[0] - image.width * scale) / 2, y: 73 + (available - image.height * scale) / 2, width: image.width * scale, height: image.height * scale };
        if (image instanceof PDFImage) page.drawImage(image, box);
        else image.draw(page, box);
      });
    }
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault(422, `Cannot render receipt ${receipt.name}; its original file must be a readable, unencrypted image or PDF`);
  }
}

function receiptPage(layout: PdfLayout, item: Data, receipt: Data, label: string, page: number, total: number): PDFPage {
  const result = layout.newPage(`${label} - receipt ${page} of ${total}`);
  layout.text(`${item.spent_on} | ${item.merchant} | ${receipt.name}`, 9);
  result.drawText(`Expense ${item.id}`, { x: MARGIN, y: 55, font: layout.font, size: 7 });
  result.drawText(`SHA-256 ${receipt.sha256}`, { x: MARGIN, y: 42, font: layout.font, size: 7 });
  return result;
}

/** PDF supports RGB image streams directly: no lossy conversion or external image service. */
function rawImage(layout: PdfLayout, image: { width: number; height: number; data: Uint8Array | Uint8ClampedArray }) {
  const rgb = new Uint8Array(image.width * image.height * 3);
  for (let p = 0, q = 0; p < image.data.length; p += 4) {
    const alpha = image.data[p + 3] / 255;
    for (let channel = 0; channel < 3; channel++) rgb[q++] = Math.round(image.data[p + channel] * alpha + 255 * (1 - alpha));
  }
  const ref = layout.doc.context.register(layout.doc.context.flateStream(rgb, { Type: 'XObject', Subtype: 'Image', Width: image.width, Height: image.height, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
  return { width: image.width, height: image.height, draw(page: PDFPage, box: { x: number; y: number; width: number; height: number }) {
    const name = page.node.newXObject('Receipt', ref);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(box.width, 0, 0, box.height, box.x, box.y), drawObject(name), popGraphicsState());
  } };
}

async function heicImages(bytes: Uint8Array, layout: PdfLayout) {
  const { default: heif } = await import('libheif-js');
  const decoder = new heif.HeifDecoder(), images = decoder.decode(bytes);
  try {
    requireThat(images.length, 'The HEIC receipt has no readable images', 422);
    // Top-level images are retained in file order; thumbnails are not returned by the decoder.
    const output = [];
    for (const image of images) {
      const width = image.get_width(), height = image.get_height();
      requireThat(width > 0 && height > 0 && width * height <= 24_000_000, 'The HEIC receipt exceeds the 24 megapixel rendering limit', 422);
      const data = await new Promise<{ width: number; height: number; data: Uint8ClampedArray }>((resolve, reject) => image.display({ width, height, data: new Uint8ClampedArray(width * height * 4) }, result => result ? resolve(result) : reject(new Error('HEIC decoding failed'))));
      output.push(rawImage(layout, data));
    }
    return output;
  } finally { images.forEach(image => image.free()); if (decoder.decoder) heif.heif_context_free(decoder.decoder); }
}
