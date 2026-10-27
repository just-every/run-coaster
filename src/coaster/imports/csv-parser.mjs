/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF rows. Every row must match the header width. */
export function parseCsv(raw, requireThat = (ok, message) => { if (!ok) throw new Error(message); }) {
  const rows = [];
  let row = [], field = '', state = 'plain';
  const endField = () => { row.push(field); field = ''; state = 'plain'; };
  const endRow = () => { endField(); if (row.some(Boolean)) rows.push(row); row = []; };
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (state === 'quoted') {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else state = 'closed';
    } else if (c === ',') endField();
    else if (c === '\r' || c === '\n') { if (c === '\r' && text[i + 1] === '\n') i++; endRow(); }
    else {
      requireThat(state !== 'closed', `Unexpected characters after a closing quote on CSV line ${rows.length + 1}`);
      if (c === '"') { requireThat(field === '', `Unexpected quote on CSV line ${rows.length + 1}`); state = 'quoted'; }
      else field += c;
    }
  }
  requireThat(state !== 'quoted', 'A quoted CSV field is never closed');
  endRow();
  const headers = (rows.shift() ?? []).map(h => h.trim());
  requireThat(headers.length > 0 && new Set(headers).size === headers.length, 'The CSV needs one header row with unique column names');
  rows.forEach((r, i) => requireThat(r.length === headers.length, `CSV line ${i + 2} has ${r.length} columns; the header has ${headers.length}`));
  return { headers, rows: rows.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i]]))) };
}
