// FEED-002 privacy assertions shared by the existing HTTP flow and matching CLI journey.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { command } from './browser-runtime.mjs';
import { records, rows, tampered } from './browser-archive.mjs';

const numbers = ['4111111111111111', '5500000000000004'];
const formats = number => [number, ...[' ', '-', ' - ', '.', '/'].map(separator => number.match(/.{4}/g).join(separator))];
const masked = ['************1111', '**** **** **** 1111', '****-****-****-1111', '**** - **** - **** - 1111', '****.****.****.1111', '****/****/****/1111', '************0004', '**** **** **** 0004', '****-****-****-0004', '**** - **** - **** - 0004', '****.****.****.0004', '****/****/****/0004'];

/** Expected bytes are independent fixture values, not output from the masking implementation. */
export function statementPrivacyFixtures(category) {
  return ['ofx', 'qfx', 'csv', 'ofx', 'qfx', 'csv'].map((format, index) => {
    const partial = index >= 3;
    const account = format === 'csv' ? numbers[1] : numbers[0], variants = formats(account);
    const fields = variants.join(' ; '), safeFields = masked.slice(format === 'csv' ? 6 : 0, format === 'csv' ? 12 : 6).join(' ; ');
    const build = (card, values) => format === 'csv'
      ? `Date,Merchant,Amount,Card,Ref,Unmapped\n2026-10-02,Synthetic ${values},12.34,${card},synthetic-coaster-${index}-${values},${values}\n`
      : `${format === 'qfx' ? '<?xml version="1.0"?>' : 'OFXHEADER:100\n'}<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>AUD</CURDEF><CCACCTFROM><ACCTID>${card}</ACCTID></CCACCTFROM><BANKTRANLIST><DTSTART>20261001</DTSTART><DTEND>20261031</DTEND><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261002120000</DTPOSTED><TRNAMT>-12.34</TRNAMT><FITID>synthetic-coaster-${index}-${values}</FITID><NAME>Synthetic ${values}</NAME><MEMO>${values}</MEMO></STMTTRN></BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;
    const card = partial ? (format === 'csv' ? '550000******0004' : '411111******1111') : variants[index];
    const safeCard = partial ? (format === 'csv' ? '************0004' : '************1111') : masked[(format === 'csv' ? 6 : 0) + index];
    const filenameCard = index === 3 ? '411111**********1111' : variants[index % 3];
    const filenameMasked = index === 3 ? '****************1111' : masked[(format === 'csv' ? 6 : 0) + index % 3];
    const input = { format, name: `synthetic-privacy-${String.fromCharCode(97 + index)}-${filenameCard}.${format}`, issuer: `Synthetic privacy ${index}`, category, content: build(card, partial ? card : fields).replace('<ACCTID>', '<ACCTID >'), ...(format === 'csv' ? { mapping: { dateFormat: 'YYYY-MM-DD', sign: 'purchases-positive', postedDate: 'Date', description: 'Merchant', amount: 'Amount', card: 'Card', transactionId: 'Ref' } } : {}) };
    return { input, expected: build(safeCard, partial ? safeCard : safeFields).replace('<ACCTID>', '<ACCTID >'), name: `synthetic-privacy-${String.fromCharCode(97 + index)}-${filenameMasked}.${format}`, last4: account.slice(-4) };
  });
}

export function assertNoStatementNumbers(value, label = 'retained data') {
  if (value === null || value === undefined) return;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value) || (Array.isArray(value) && value.every(n => Number.isInteger(n) && n >= 0 && n <= 255))) {
    const body = value instanceof ArrayBuffer ? Buffer.from(value) : ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.from(value);
    return assertNoStatementNumbers(body.toString('utf8'), label);
  }
  if (typeof value === 'string') {
    const compact = value.replace(/[\s./-]/g, '');
    for (const number of numbers) assert.equal(compact.includes(number), false, `${label} retains no full fixture card number`);
    assert.doesNotMatch(value, /(?:411111|550000)[*\s./-]*\d{4}/, `${label} retains no leading digits from a partially masked account`);
    // JSON snapshots and encoded BLOB cells are inspected recursively too.
    try { const decoded = JSON.parse(value); if (typeof decoded === 'object' && decoded !== null) assertNoStatementNumbers(decoded, label); } catch (error) { if (error instanceof assert.AssertionError) throw error; }
  } else if (typeof value === 'object') {
    for (const [key, cell] of Object.entries(value)) {
      assertNoStatementNumbers(key, label);
      if (key === 'blob' && typeof cell === 'string') assertNoStatementNumbers(Buffer.from(cell, 'base64'), label);
      else assertNoStatementNumbers(cell, label);
    }
  }
}

export async function scanStatementStorage(h) {
  // Read persisted SQLite, including platform metadata that the D1 SQL API deliberately hides.
  const databases = (await readdir(h.persistencePath, { recursive: true })).filter(name => name.endsWith('.sqlite'));
  let cells = 0, tables = 0;
  for (const name of databases) {
    const db = new DatabaseSync(join(h.persistencePath, name), { readOnly: true });
    try {
      for (const { name: table } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()) {
        tables++;
        for (const row of db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all()) {
          cells += Object.keys(row).length; assertNoStatementNumbers(row, `database table ${table}`);
        }
      }
    } finally { db.close(); }
  }
  assert.ok(databases.length > 0 && tables > 0 && cells > 0, 'the full database scan is nonempty');
  const bucket = await h.mf.getR2Bucket('COASTER_RECEIPTS');
  let cursor, objects = 0;
  do {
    const page = await bucket.list({ cursor, include: ['httpMetadata', 'customMetadata'] });
    for (const entry of page.objects) {
      objects++; assertNoStatementNumbers(entry, 'R2 object metadata');
      assertNoStatementNumbers(await (await bucket.get(entry.key)).arrayBuffer(), 'R2 object bytes');
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  assert.ok(objects > 0, 'the R2 scan includes a retained receipt object');
  return { databases: databases.length, tables, cells, objects };
}

export async function importPrivateStatements(door, category, employee) {
  const fixtures = statementPrivacyFixtures(category), imported = [];
  for (const { input, expected, name, last4 } of fixtures) {
    await door.post(['statements', 'cards'].join('/'), { issuer: input.issuer, last4, employee });
    const preview = await door.post(['statements', 'preview'].join('/'), input);
    assertNoStatementNumbers(preview, 'statement preview');
    assert.deepEqual([preview.importable, preview.totalMinor, preview.errors], [1, 1234, []]);
    const committed = await door.post(['statements', 'commit'].join('/'), { ...input, fingerprint: preview.fingerprint });
    imported.push({ id: committed.file, expected, name, format: input.format });
    assertNoStatementNumbers(committed, 'statement commit');
  }
  await verifyPrivateStatementDownloads(door, imported);
  return imported;
}

export async function verifyPrivateStatementDownloads(door, imported) {
  const state = await door.get('statements');
  for (const { id, expected, name } of imported) {
    const file = state.files.find(file => file.id === id);
    assert.ok(file, 'the imported statement is listed');
    assert.equal(file.label, 'card numbers masked');
    assert.equal(file.name, name, 'the persisted filename retains only the last four');
    const body = Buffer.from(expected);
    assert.equal(file.size, body.length, 'retained size is the masked UTF-8 byte length');
    assert.equal(file.sha256, createHash('sha256').update(body).digest('hex'), 'retained SHA-256 authenticates masked bytes');
    const downloaded = await door.download(id);
    assert.deepEqual(downloaded.bytes, body, 'the public download returns the exact labelled masked original');
    assert.match(downloaded.disposition, /card-numbers-masked/);
    assertNoStatementNumbers(downloaded.bytes, 'statement download');
    assertNoStatementNumbers(downloaded.disposition, 'statement download filename');
  }
}

export async function scanStatementArchive(archive) {
  const input = await records(archive), binary = new Map();
  assertNoStatementNumbers(input, 'archive fields and decoded BLOBs');
  for (const item of rows(input).filter(item => ['object', 'payload'].includes(item.kind))) {
    const key = JSON.stringify([item.kind, item.bucket, item.key, item.name]);
    const chunks = binary.get(key) ?? []; chunks.push(item); binary.set(key, chunks);
  }
  // Join chunks before scanning so a number split at a binary boundary cannot escape.
  for (const chunks of binary.values()) assertNoStatementNumbers(Buffer.concat(chunks.sort((a, b) => a.offset - b.offset).map(item => Buffer.from(item.data, 'base64'))), 'decoded archive binary');
  assert.ok(binary.size > 0, 'the archive scan includes retained object bytes');
  return input;
}

export async function rejectUnsafeStatementArchives(destination, archive, { part = 0, of = 1 } = {}) {
  await command(destination, ['export', '--output', 'exports/statement-empty.rer']);
  const empty = rows(await records(join(destination, 'exports/statement-empty.rer')));
  const cases = [
    ...['ofx', 'qfx', 'csv'].map(format => ({ code: `number-${format}`, format, change: () => statementPrivacyFixtures('unused').find(fixture => fixture.input.format === format).input.content })),
    { code: 'number-partial', format: 'ofx', change: () => statementPrivacyFixtures('unused')[3].input.content },
    { code: 'number-filename', format: 'csv', error: 'number', metadata: row => { row.name = 'synthetic-' + numbers[1] + '.csv'; } },
    { code: 'number-memo', format: 'ofx', change: text => text.replace('<MEMO>', '<MEMO>5500 - 0000 - 0000 - 0004 ; ') },
    { code: 'number-date', format: 'qfx', change: text => text.replace('20261002120000', numbers[0]) },
    { code: 'size', format: 'csv', metadata: row => { row.size++; } },
    { code: 'sha256', format: 'qfx', metadata: row => { row.sha256 = '0'.repeat(64); } },
  ];
  for (const [index, entry] of cases.entries()) {
    if (index % of !== part) continue;
    const invalid = await tampered(archive, 'c_statement_files', row => {
      if (entry.metadata) entry.metadata(row);
      else {
        const body = Buffer.from(entry.change(Buffer.from(row.bytes.blob, 'base64').toString('utf8')));
        row.bytes.blob = body.toString('base64'); row.size = body.length; row.sha256 = createHash('sha256').update(body).digest('hex');
      }
    }, row => row.format === entry.format);
    const name = `exports/statement-${entry.code}.rer`;
    await writeFile(join(destination, name), invalid, { mode: 0o600 });
    const log = await command(destination, ['import', '--input', name, '--yes'], { expected: 4 });
    assert.match(log, new RegExp(entry.error === 'number' || !entry.metadata ? 'coaster_statement_number' : 'coaster_statement_bytes'));
    const after = `exports/statement-after-${entry.code}.rer`;
    await command(destination, ['export', '--output', after]);
    assert.deepEqual(rows(await records(join(destination, after))), empty, 'unsafe statement restore writes no row or object');
  }
}
