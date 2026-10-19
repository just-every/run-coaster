import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import fontBytes from './pdf-assets/noto-sans.json';

const ink = rgb(.12, .18, .17), muted = rgb(.38, .43, .42);
export const PAGE = [595.28, 841.89] as [number, number];
export const MARGIN = 42;

/** Paginated text with measured wrapping, including long fingerprints and comments. */
export class PdfLayout {
  page!: PDFPage;
  y = 0;
  private constructor(readonly doc: PDFDocument, readonly font: PDFFont) {}
  static async create() {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(Uint8Array.from(atob(fontBytes), c => c.charCodeAt(0)), { subset: true });
    doc.setCreator('Coaster');
    doc.setProducer('Coaster');
    return new PdfLayout(doc, font);
  }
  newPage(label: string) {
    this.page = this.doc.addPage(PAGE);
    this.y = PAGE[1] - 45;
    this.page.drawText('COASTER', { x: MARGIN, y: this.y, size: 9, font: this.font, color: muted });
    this.y -= 24;
    this.text(label, 17);
    this.y -= 8;
    return this.page;
  }
  text(value: unknown, size = 10, color = ink) {
    const raw = String(value ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
    const width = PAGE[0] - MARGIN * 2;
    for (const paragraph of raw.split('\n')) {
      let line = '';
      const emit = () => {
        if (this.y < 55 + size) this.newPage('Claim details - continued');
        this.page.drawText(line, { x: MARGIN, y: this.y, font: this.font, size, color });
        this.y -= size * 1.5;
        line = '';
      };
      // Split oversized words (hashes, addresses) as well as ordinary prose.
      for (const word of paragraph.split(/(\s+)/)) {
        if (line && this.font.widthOfTextAtSize(line + word, size) > width) emit();
        for (const char of word) {
          if (this.font.widthOfTextAtSize(line + char, size) > width) emit();
          line += char;
        }
      }
      emit();
    }
  }
  heading(value: string) {
    if (this.y < 105) this.newPage('Claim details - continued');
    this.y -= 10;
    this.text(value, 12);
    this.y -= 3;
  }
  finish() {
    const pages = this.doc.getPages();
    pages.forEach((page, i) => page.drawText(`${i + 1} / ${pages.length}`, { x: PAGE[0] - 80, y: 23, font: this.font, size: 8, color: muted }));
    return this.doc.save();
  }
}
