import { requireThat } from '../types';
import { maskStatementNumbers } from './statement-numbers';
import type { StatementBalance, StatementCard, StatementRow } from './statement';

type Node = { name: string; value: string; children: Node[] };

/** OFX 1.x (SGML, leaf elements unclosed) and 2.x (XML) share one tag grammar: `<TAG>value` with optional `</TAG>`.
 * Aggregates have no value of their own and are closed by their end tag. */
function tree(text: string): Node {
  const root: Node = { name: '#root', value: '', children: [] }, stack = [root];
  const start = text.search(/<OFX>/i);
  requireThat(start >= 0, 'This is not an OFX or QFX file: no <OFX> element');
  const tag = /<(\/?)([A-Za-z0-9.]+)\s*\/?>([^<]*)/g;
  tag.lastIndex = start;
  for (let m = tag.exec(text); m; m = tag.exec(text)) {
    const name = m[2].toUpperCase(), value = m[3].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    if (m[1]) { const at = stack.map(n => n.name).lastIndexOf(name); if (at > 0) stack.length = at; continue; }
    const node: Node = { name, value, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!value) stack.push(node);
  }
  return root;
}
const find = (node: Node, ...path: string[]): Node | undefined => path.reduce<Node | undefined>((n, p) => n?.children.find(c => c.name === p), node);
const all = (node: Node, name: string): Node[] => node.children.flatMap(c => c.name === name ? [c] : all(c, name));
const text = (node: Node | undefined, ...path: string[]) => (path.length ? find(node!, ...path) : node)?.value ?? '';
const dateOf = (v: string) => { const m = /^(\d{4})(\d{2})(\d{2})/.exec(v.trim()); if (!m) return null; const iso = `${m[1]}-${m[2]}-${m[3]}`; return new Date(iso + 'T00:00:00Z').toISOString().slice(0, 10) === iso ? iso : null; };
const money = (v: string) => { const m = /^([+-]?)(\d{1,10})(?:\.(\d{1,2}))?$/.exec(v.trim()); return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'))) : null; };
const kind = (type: string): StatementRow['kind'] => {
  const t = type.toUpperCase();
  if (t === 'DEBIT' || t === 'POS') return 'purchase';
  if (t === 'CREDIT') return 'credit';
  if (t === 'PAYMENT') return 'payment';
  if (t === 'FEE' || t === 'SRVCHG') return 'fee';
  if (t === 'INT') return 'interest';
  return 'other';
};

export type Parsed = { cards: StatementCard[]; rows: StatementRow[]; period: { start: string | null; end: string | null }; currency: string; masked: string; errors: string[]; balances: Record<string, StatementBalance> };

/** A credit-card statement response (CCSTMTRS) or nothing: bank, investment and other message sets are refused, and any
 * full account number is masked to its last four before the caller keeps or stores anything (SEC-001). */
export function parseOfx(raw: string): Parsed {
  const root = tree(raw);
  const sets = find(root, 'OFX')?.children.map(c => c.name) ?? [];
  const refused = sets.filter(s => s.endsWith('MSGSRSV1') && s !== 'CREDITCARDMSGSRSV1' && s !== 'SIGNONMSGSRSV1');
  requireThat(!refused.length, `Only credit-card statements are accepted; this file carries ${refused.join(', ')}`);
  requireThat(!all(root, 'BANKACCTFROM').length && !all(root, 'BANKID').length && !all(root, 'BANKACCTTO').length, 'Bank account and routing numbers are never accepted; export the credit-card statement');
  const statements = all(root, 'CCSTMTRS');
  requireThat(statements.length > 0, 'No credit-card statement (CCSTMTRS) in this file');
  const accounts = new Map<string, string>();
  for (const s of statements) {
    const account = text(s, 'CCACCTFROM', 'ACCTID').replace(/[\s-]/g, ''), last4 = account.slice(-4);
    requireThat(!accounts.has(last4) || accounts.get(last4) === account, `Two cards in this file share the last four ${last4}; import them in separate files`);
    accounts.set(last4, account);
  }
  const masked = maskStatementNumbers(raw, accounts.values());
  // Re-read only masked input: descriptions, memos, transaction keys and diagnostics must never retain the number.
  if (masked !== raw) return parseOfx(masked);
  const cards: StatementCard[] = [], rows: StatementRow[] = [], errors: string[] = [], full = new Map<string, string>(), balances: Record<string, StatementBalance> = {};
  let currency = '', start: string | null = null, end: string | null = null;
  for (const s of statements) {
    const account = text(s, 'CCACCTFROM', 'ACCTID').replace(/[\s-]/g, '');
    // A retained original is already masked (asterisks before the last four digits); a file may arrive that way too.
    requireThat(/^[\d*]{4,19}$/.test(account) && /^\d{4}$/.test(account.slice(-4)), 'The statement has no card number in ACCTID (at least the last four digits)');
    const last4 = account.slice(-4);
    const known = full.get(last4);
    requireThat(!known || known === account, `Two cards in this file share the last four ${last4}; import them in separate files`);
    full.set(last4, account);
    if (!cards.some(c => c.last4 === last4)) cards.push({ last4, label: `····${last4}` });
    const cur = text(s, 'CURDEF').toUpperCase();
    requireThat(/^[A-Z]{3}$/.test(cur), 'The statement names no currency (CURDEF)');
    requireThat(!currency || currency === cur, 'One file holds one statement currency');
    currency = cur;
    // LEDGERBAL follows the OFX credit-card convention: a negative BALAMT is the amount the cardholder owes.
    const owed = money(text(s, 'LEDGERBAL', 'BALAMT')), asOf = dateOf(text(s, 'LEDGERBAL', 'DTASOF'));
    if (owed !== null) balances[last4] = { owedMinor: -owed, asOf };
    const list = find(s, 'BANKTRANLIST');
    const from = dateOf(text(list, 'DTSTART')), to = dateOf(text(list, 'DTEND'));
    if (from && (!start || from < start)) start = from;
    if (to && (!end || to > end)) end = to;
    for (const t of list ? all(list, 'STMTTRN') : []) {
      const fitid = text(t, 'FITID'), posted = dateOf(text(t, 'DTPOSTED')), user = dateOf(text(t, 'DTUSER')), amount = money(text(t, 'TRNAMT'));
      const type = text(t, 'TRNTYPE'), descriptor = (text(t, 'NAME') || text(t, 'PAYEE', 'NAME')).replace(/\s+/g, ' '), memo = text(t, 'MEMO').replace(/\s+/g, ' ');
      const orig = find(t, 'ORIGCURRENCY') ?? find(t, 'CURRENCY'), originalCurrency = text(orig, 'CURSYM').toUpperCase(), rate = Number(text(orig, 'CURRATE'));
      const row: StatementRow = { ...(text(t,'MCC')?{mcc:text(t,'MCC')}:{}), line: rows.length + 1, last4, key: fitid ? `fitid:${fitid}` : '', kind: kind(type), postedOn: posted, transactionOn: user, descriptor, memo, amountMinor: amount === null ? null : Math.abs(amount), signed: amount, currency: cur, originalCurrency: originalCurrency && originalCurrency !== cur ? originalCurrency : '', originalMinor: originalCurrency && originalCurrency !== cur && rate > 0 && amount !== null ? Math.round(Math.abs(amount) * rate) : null, pending: false, problems: [] };
      if(row.mcc&&!/^\d{4}$/.test(row.mcc))row.problems.push('merchant category code must have four digits');
      if (!fitid) row.problems.push('no FITID');
      if (row.kind === 'purchase' && amount !== null && amount > 0) row.problems.push('a DEBIT with a positive amount');
      if (row.kind === 'credit' && amount !== null && amount < 0) row.problems.push('a CREDIT with a negative amount');
      if (!posted) row.problems.push(`DTPOSTED "${text(t, 'DTPOSTED')}" is not a date`);
      if (amount === null) row.problems.push(`TRNAMT "${text(t, 'TRNAMT')}" is not an amount`);
      rows.push(row);
    }
  }
  return { cards, rows, period: { start, end }, currency, masked, errors, balances };
}
