import { MARGIN, PAGE, PdfLayout } from '../pdf-layout';
import { Fault, requireThat } from '../types';
import { receiptMedia } from './upload';

/** Structural subset of the normalized inbound message; transport verification precedes this call. */
export type MailReceiptMessage = {
  subject?: string;
  html: string | null;
  text: string | null;
  attachments: {
    filename: string;
    contentType: string;
    content: Uint8Array;
    contentId?: string | null;
  }[];
};

export type MailReceiptFile = { name: string; bytes: Uint8Array; mediaType: string; origin: 'body' | 'attachment' };

/** Inline parts are receipts too; neither their disposition nor declared MIME decides their type. */
export async function mailReceiptFiles(message: MailReceiptMessage): Promise<MailReceiptFile[]> {
  const files: MailReceiptFile[] = [];
  for (const [index, attachment] of message.attachments.entries()) {
    let mediaType: string;
    try { mediaType = receiptMedia(attachment.content); }
    catch (error) {
      if (error instanceof Fault && error.status === 415) continue;
      throw error;
    }
    const extension = mediaType === 'application/pdf' ? 'pdf' : mediaType.slice(6).replace('jpeg', 'jpg');
    files.push({ name: fileName(attachment.filename) || `email-attachment-${index + 1}.${extension}`, bytes: attachment.content.slice(), mediaType, origin: 'attachment' });
  }
  if (files.length && !message.html?.trim()) return files;

  requireThat(!message.attachments.length || files.length || message.html?.trim(), 'The email has no supported receipt attachment', 422);
  const body = message.html?.trim() ? htmlText(message.html) : printable(message.text ?? '').trim();
  requireThat(body.length <= 100_000, 'The receipt body is too long to render; its source must be held', 422);
  requireThat(body.trim(), 'The email has no supported receipt attachment or readable body', 422);
  const subject = printable(message.subject ?? '').replace(/\s+/g, ' ').trim();
  const layout = await PdfLayout.create();
  layout.doc.setTitle(subject || 'Email receipt');
  layout.newPage('Email receipt');
  if (subject) {
    renderText(layout, subject, 12);
    layout.y -= 10;
  }
  renderText(layout, body, 10);
  return [...files, { name: `${fileName(subject).replace(/\.pdf$/i, '') || 'email-receipt'}.pdf`, bytes: await layout.finish(), mediaType: 'application/pdf', origin: 'body' }];
}

function fileName(value: string) {
  return printable(value).replace(/[\\/<>:"|?*]/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+|[. ]+$/g, '').slice(0, 180);
}

function printable(value: string) {
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
}

const entities: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  dollar: '$', cent: '¢', pound: '£', yen: '¥', euro: '€', copy: '©', reg: '®', trade: '™',
  ndash: '–', mdash: '—', minus: '−', bull: '•', middot: '·', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  times: '×', divide: '÷', deg: '°', plusmn: '±', Tab: '\t', NewLine: '\n',
};
const latinEntities = 'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'.split(' ');
latinEntities.forEach((name, index) => { entities[name] ??= String.fromCharCode(160 + index); });

function decodeEntities(value: string) {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]+);/gi, (whole, entity: string) => {
    if (entity[0] !== '#') return entities[entity] ?? whole;
    const hex = entity[1]?.toLowerCase() === 'x';
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
  });
}

/** Reduce markup to inert text. Attributes, embedded documents and active content never reach a renderer. */
export function htmlText(html: string) {
  const blocks = new Set(['address', 'article', 'aside', 'blockquote', 'caption', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul']);
  const omitted = new Set(['head', 'script', 'style', 'iframe', 'object', 'svg', 'math', 'template', 'noscript']);
  const pieces: string[] = [];
  let cursor = 0, suppressed = '', pre = false;
  const append = (value: string) => pieces.push(pre ? decodeEntities(value) : decodeEntities(value).replace(/\s+/g, ' '));
  // Quoted attribute values may contain angle brackets; comments are discarded as a whole.
  const tags = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/?[a-z][a-z\d:-]*(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
  for (const match of html.matchAll(tags)) {
    if (!suppressed) append(html.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const tag = /^<(\/)?([a-z][a-z\d:-]*)\b/i.exec(match[0]);
    if (!tag) continue;
    const closing = Boolean(tag[1]), name = tag[2].toLowerCase();
    if (suppressed) {
      if (closing && name === suppressed) suppressed = '';
      continue;
    }
    if (omitted.has(name)) {
      if (!closing) suppressed = name;
      continue;
    }
    if (name === 'br' || blocks.has(name)) pieces.push('\n');
    if ((name === 'td' || name === 'th') && closing) pieces.push(' | ');
    if (name === 'li' && !closing) pieces.push('• ');
    if (name === 'pre') pre = !closing;
  }
  if (!suppressed) append(html.slice(cursor));
  return printable(pieces.join('')).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Pre-wrap each line so pagination keeps email labels on every continuation page. */
function renderText(layout: PdfLayout, text: string, size: number) {
  const width = PAGE[0] - MARGIN * 2;
  const emit = (line: string) => {
    if (layout.y < 55 + size) layout.newPage('Email receipt - continued');
    layout.text(line, size);
  };
  for (const paragraph of text.replace(/\t/g, '    ').split('\n')) {
    let line = '';
    for (const word of paragraph.split(/(\s+)/)) {
      if (line && layout.font.widthOfTextAtSize(line + word, size) > width) { emit(line); line = ''; }
      for (const char of word) {
        if (line && layout.font.widthOfTextAtSize(line + char, size) > width) { emit(line); line = ''; }
        line += char;
      }
    }
    emit(line);
  }
}
