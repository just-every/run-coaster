import { business, type Business } from './settings';
import { nextDay, startOf } from './audit';
import { csv } from './batches';
import { claimNumber } from './claims';
import { decimal, isoDate, requireThat, type Actor, type Data } from './types';
import { businessDaysBetween } from './business-days';

/** Operational and compliance reports (REPORT-002). Card spend and feed coverage join when FEED-003 and FEED-004 ship. */
export const REPORTS = {
  aging: 'Reimbursement aging',
  'cycle-time': 'Approval cycle time',
  receipts: 'Receipt compliance',
  unsubmitted: 'Unsubmitted spend for accruals',
  exceptions: 'Policy exception trends',
} as const;
type Name = keyof typeof REPORTS;
type Period = { from: string; to: string; start: string; end: string; today: string };
type Built = { columns: string[]; rows: unknown[][]; totals: Data; totalRow: unknown[] };
export const reportCsv = (built: Built) => csv([built.columns, ...built.rows, built.totalRow]);

const DAY = 86_400_000;
const localDate = (iso: string, timezone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY);
/** Hours and percentages show to one decimal, halves rounded up. */
const tenth = (n: number) => Math.round(n * 10) / 10;
const rate = (part: number, whole: number) => whole ? tenth(part * 100 / whole) : null;
const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const BUCKETS = [[7, '0–7 days'], [14, '8–14 days'], [30, '15–30 days'], [Infinity, 'Over 30 days']] as const;

/** The highest revision of each claim submitted within the period, with its frozen snapshot. */
async function submittedIn(db: D1Database, p: Period) {
  const { results } = await db.prepare('SELECT r.claim_id,r.revision,r.submitted_at,r.snapshot,c.number,c.employee_email FROM c_revisions r JOIN c_claims c ON c.id=r.claim_id WHERE r.submitted_at>=? AND r.submitted_at<? AND r.revision=(SELECT MAX(x.revision) FROM c_revisions x WHERE x.claim_id=r.claim_id AND x.submitted_at>=? AND x.submitted_at<?) ORDER BY c.number').bind(p.start, p.end, p.start, p.end).all<Data>();
  return results.map(r => ({ ...r, snapshot: JSON.parse(r.snapshot) }) as Data);
}

const builders: Record<Name, (db: D1Database, b: Business, p: Period) => Promise<Built>> = {
  /** Every approved claim not yet reimbursed, aged in whole business-time-zone days from its approval to today, and every
   * held claim (APPROVE-005) the employee has not resubmitted yet, aged from its hold. */
  async aging(db, b, p) {
    const { results } = await db.prepare("SELECT c.number,c.employee_email,c.status,c.total_minor,d.at AS since FROM c_claims c JOIN c_decisions d ON d.claim_id=c.id AND d.revision=c.revision AND d.decision='approved' WHERE c.status IN ('approved','batched') UNION ALL SELECT number,employee_email,'held',total_minor,held_at FROM c_claims WHERE held_from IS NOT NULL AND status='returned' AND revision=0 ORDER BY since,number").all<Data>();
    const buckets = Object.fromEntries(BUCKETS.map(([, label]) => [label, { claims: 0, amountMinor: 0 }]));
    const rows = results.map(c => {
      const approved = localDate(c.since, b.timezone), days = daysBetween(approved, p.today), bucket = BUCKETS.find(([limit]) => days <= limit)![1];
      buckets[bucket].claims++; buckets[bucket].amountMinor += c.total_minor;
      return [claimNumber(c.number), c.employee_email, approved, days, bucket, c.status, decimal(c.total_minor)];
    });
    const amountMinor = results.reduce((n, c) => n + c.total_minor, 0);
    return { columns: ['Claim', 'Employee', 'Approved or held', 'Days waiting', 'Bucket', 'Status', 'Amount'], rows, totals: { claims: rows.length, amountMinor, buckets }, totalRow: ['Total', '', '', '', '', rows.length, decimal(amountMinor)] };
  },
  /** Each decision made in the period, timed from its revision's submission to the decision, per person or rule who decided. */
  async 'cycle-time'(db, b, p) {
    const { results } = await db.prepare('SELECT d.actor_email,d.decision,d.at,r.submitted_at FROM c_decisions d JOIN c_revisions r ON r.claim_id=d.claim_id AND r.revision=d.revision WHERE d.at>=? AND d.at<? ORDER BY d.actor_email').bind(p.start, p.end).all<Data>();
    const by = new Map<string, Data[]>();
    for (const d of results) by.set(d.actor_email, [...by.get(d.actor_email) ?? [], d]);
    const hoursOf = (d: Data) => (Date.parse(d.at) - Date.parse(d.submitted_at)) / 3_600_000;
    // Over the approval service level (FOLLOWUP-002): more business days from submission to decision than it allows.
    const late = (d: Data) => businessDaysBetween(localDate(d.submitted_at, b.timezone), localDate(d.at, b.timezone)) > b.service_level_days;
    const rows = [...by].map(([who, decisions]) => {
      const hours = decisions.map(hoursOf), count = (kind: string) => decisions.filter(d => d.decision === kind).length;
      return [who, decisions.length, count('approved'), count('returned'), count('rejected'), tenth(hours.reduce((n, h) => n + h, 0) / hours.length), tenth(median(hours)), tenth(Math.max(...hours)), decisions.filter(late).length];
    });
    const all = results.map(hoursOf), average = all.length ? tenth(all.reduce((n, h) => n + h, 0) / all.length) : null;
    const over = results.filter(late).length;
    return { columns: ['Decided by', 'Decisions', 'Approved', 'Returned', 'Rejected', 'Average hours', 'Median hours', 'Longest hours', `Over ${b.service_level_days}-business-day service level`], rows, totals: { decisions: results.length, averageHours: average, overServiceLevel: over }, totalRow: ['Total', results.length, '', '', '', average ?? '', '', '', over] };
  },
  /** Receipt expenses on each claim's latest revision submitted in the period: the share that carry their receipt. */
  async receipts(db, _b, p) {
    const per = new Map<string, { expenses: number; withReceipt: number; missingExceptions: number }>();
    for (const r of await submittedIn(db, p)) {
      const row = per.get(r.employee_email) ?? { expenses: 0, withReceipt: 0, missingExceptions: 0 };
      for (const item of r.snapshot.items as Data[]) if (item.kind === 'receipt') { row.expenses++; if (item.receipt) row.withReceipt++; }
      row.missingExceptions += (r.snapshot.exceptions as Data[]).filter(e => e.code === 'missing-receipt').length;
      per.set(r.employee_email, row);
    }
    const rows = [...per].sort(([a], [b]) => a.localeCompare(b)).map(([who, r]) => [who, r.expenses, r.withReceipt, r.expenses - r.withReceipt, r.missingExceptions, rate(r.withReceipt, r.expenses)]);
    const sum = (k: 'expenses' | 'withReceipt' | 'missingExceptions') => [...per.values()].reduce((n, r) => n + r[k], 0);
    const totals = { expenses: sum('expenses'), withReceipt: sum('withReceipt'), missingExceptions: sum('missingExceptions'), ratePercent: rate(sum('withReceipt'), sum('expenses')) };
    return { columns: ['Employee', 'Receipt expenses', 'With receipt', 'Without receipt', 'Missing-receipt exceptions', 'Compliance %'], rows, totals, totalRow: ['Total', totals.expenses, totals.withReceipt, totals.expenses - totals.withReceipt, totals.missingExceptions, totals.ratePercent ?? ''] };
  },
  /** Expenses dated on or before the period's last day that sit on draft or returned claims: spend incurred but not yet submitted. */
  async unsubmitted(db, _b, p) {
    const { results } = await db.prepare("SELECT c.employee_email,COUNT(DISTINCT c.id) AS claims,COUNT(i.id) AS expenses,SUM(i.amount_minor) AS amount_minor,MIN(i.spent_on) AS oldest FROM c_items i JOIN c_claims c ON c.id=i.claim_id WHERE c.status IN ('draft','returned') AND i.spent_on<=? GROUP BY c.employee_email ORDER BY c.employee_email").bind(p.to).all<Data>();
    const rows = results.map(r => [r.employee_email, r.claims, r.expenses, r.oldest, decimal(r.amount_minor)]);
    const totals = { claims: results.reduce((n, r) => n + r.claims, 0), expenses: results.reduce((n, r) => n + r.expenses, 0), amountMinor: results.reduce((n, r) => n + r.amount_minor, 0) };
    return { columns: ['Employee', 'Claims', 'Expenses', 'Oldest expense', 'Amount'], rows, totals, totalRow: ['Total', totals.claims, totals.expenses, '', decimal(totals.amountMinor)] };
  },
  /** Exceptions on each claim's latest revision submitted in the period, by the month it was submitted and the exception. */
  async exceptions(db, b, p) {
    const per = new Map<string, { count: number; amountMinor: number }>();
    for (const r of await submittedIn(db, p)) for (const e of r.snapshot.exceptions as Data[]) {
      const key = `${localDate(r.submitted_at, b.timezone).slice(0, 7)}|${e.code}`, row = per.get(key) ?? { count: 0, amountMinor: 0 };
      row.count++; row.amountMinor += (r.snapshot.items as Data[]).find(i => i.id === e.item)?.amount_minor ?? 0;
      per.set(key, row);
    }
    const rows = [...per].sort(([a], [b]) => a.localeCompare(b)).map(([key, r]) => [...key.split('|'), r.count, decimal(r.amountMinor)]);
    const byCode: Record<string, number> = {};
    for (const [key, r] of per) { const code = key.split('|')[1]; byCode[code] = (byCode[code] ?? 0) + r.count; }
    const count = [...per.values()].reduce((n, r) => n + r.count, 0);
    return { columns: ['Month', 'Exception', 'Count', 'Expense amount'], rows, totals: { exceptions: count, byCode }, totalRow: ['Total', '', count, ''] };
  },
};

export const isReport = (name: unknown): name is Name => typeof name === 'string' && Object.hasOwn(REPORTS, name);
export { localDate };

/** Builds one report for calendar dates in the business time zone, both ends inclusive, as of `today`. */
export function runReport(db: D1Database, settings: Business, name: Name, from: string, to: string, today: string) {
  return builders[name](db, settings, { from, to, start: startOf(from, settings.timezone), end: startOf(nextDay(to), settings.timezone), today });
}

/** One report for the period (by default this month to today), as JSON or CSV. */
export async function report(db: D1Database, actor: Actor, name: string, query: Record<string, string>) {
  requireThat(actor.roles.finance || actor.roles.auditor || actor.roles.owner, 'Finance, auditor or owner access required', 403);
  requireThat(isReport(name), 'Report not found', 404);
  const settings = await business(db);
  requireThat(settings, 'The owner has not set up the business yet', 409);
  const today = localDate(new Date().toISOString(), settings.timezone);
  const to = query.to ? isoDate(query.to, 'Until') : today, from = query.from ? isoDate(query.from, 'From') : to.slice(0, 8) + '01';
  requireThat(to >= from, 'The period must end on or after it starts');
  const built = await runReport(db, settings, name, from, to, today);
  if (query.format === 'csv') return new Response(reportCsv(built), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="coaster-${name}-${from}-to-${to}.csv"` } });
  return { report: name, title: REPORTS[name], period: { from, to }, asOf: today, currency: settings.currency, timezone: settings.timezone, columns: built.columns, rows: built.rows, totals: built.totals };
}
