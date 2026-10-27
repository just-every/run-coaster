import { createHash } from 'node:crypto';
import { PortabilityError } from '@runeditrun/rer/modules/portability';
import { parseCsv } from '../../src/coaster/imports/csv-parser.mjs';

const check = (ok, code) => { if (!ok) throw new PortabilityError('coaster_statement_' + code, 409); };
const bytes = value => value && typeof value.blob === 'string' ? Buffer.from(value.blob, 'base64') : Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value ?? []);
const luhn = digits => {
  let sum = 0;
  for (let i = digits.length - 1, double = false; i >= 0; i--, double = !double) {
    let n = Number(digits[i]);
    if (double) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
};
const timestamp = value => {
  const date = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})(?:\.\d{1,3})?)?(?:\[[+-]?\d{1,2}(?::[A-Z]+)?\])?$/.exec(value.trim());
  return date && Number(date[2]) >= 1 && Number(date[2]) <= 12 && Number(date[3]) >= 1 && Number(date[3]) <= 31
    && Number(date[4] ?? 0) <= 23 && Number(date[5] ?? 0) <= 59 && Number(date[6] ?? 0) <= 59;
};

/** Inspect staged originals without touching the destination. Re-sealing an unsafe archive grants no custody. */
export async function validateStatementArchive(read) {
  for (const file of await read('c_statement_files')) {
    for (const match of String(file.name).matchAll(/[\d*](?:[ \t._/-]*[\d*]){4,}/g)) {
      check(match[0].replace(/\D/g, '').length <= 4, 'number');
    }
    const body = bytes(file.bytes);
    check(body.length === file.size && createHash('sha256').update(body).digest('hex') === file.sha256, 'bytes');
    const text = body.toString('utf8'), lastFour = new Set();
    if (file.format === 'csv') {
      let mapping, parsed;
      try { mapping = JSON.parse(file.mapping); parsed = parseCsv(text); } catch { check(false, 'format'); }
      check(mapping && typeof mapping === 'object' && !Array.isArray(mapping), 'format');
      if (mapping.card) {
        check(parsed.headers.includes(mapping.card), 'format');
        for (const row of parsed.rows) {
          const digits = row[mapping.card].replace(/\D/g, '');
          check(digits.length <= 4, 'number');
          if (digits.length === 4) lastFour.add(digits);
        }
      } else {
        check(typeof mapping.wholeFileLast4 === 'string' && /^\d{4}$/.test(mapping.wholeFileLast4.trim()), 'format');
        lastFour.add(mapping.wholeFileLast4.trim());
      }
    } else {
      check(['ofx', 'qfx'].includes(file.format), 'format');
      const accounts = [...text.matchAll(/<ACCTID\s*\/?>([^<]*)/gi)];
      check(accounts.length > 0, 'format');
      for (const [, account] of accounts) {
        const normalized = account.replace(/[\s-]/g, '');
        check(/^[*]*\d{4}$/.test(normalized), 'number');
        lastFour.add(normalized.slice(-4));
      }
    }
    // OFX timestamps are not card fields. Elsewhere refuse a full card-shaped number matching this
    // statement's last four, or a valid PAN even when its account field was already masked.
    const content = file.format === 'csv' ? text : text.replace(/<DT[A-Z.]*\s*\/?>([^<\r\n]*)/gi, (field, value) => timestamp(value) ? '' : field);
    for (const match of content.matchAll(/(?<!\d)\d(?:[ \t./-]*\d){12,18}(?![ \t./-]*\d)/g)) {
      const digits = match[0].replace(/\D/g, '');
      check(!lastFour.has(digits.slice(-4)) && !luhn(digits), 'number');
    }
  }
}
