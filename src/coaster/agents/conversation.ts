import { proposeConversationClaim } from '../agents';
import { categories } from '../items';
import { requireBusiness } from '../settings';
import { spend } from '../spend';
import { budgetReport } from '../budgets';
import { can } from '../permissions';
import { inScope, scopeParams } from '../departments';
import { localDate } from '../reports';
import { perDiemLocations, tripDates } from '../per-diem';
import { requireThat, text, type Actor, type Data } from '../types';

/** Bounded native grammar. Text selects records and dates; it never executes an instruction from a receipt. */
export async function conversation(db: D1Database, actor: Actor, b: Data) {
  requireThat(actor.kind === 'person' && !actor.delegate && !actor.publicCredential, 'Use your own native session', 403);
  const message = text(b.message, 'Message', 500), settings = await requireBusiness(db);
  const today = localDate(new Date().toISOString(), settings.timezone);
  const comparison = /^what did (.+?) spend on (.+?) in Q([1-4]) (?:compared with|versus|vs\.?) Q([1-4])(?: (\d{4}))?\??$/i.exec(message);
  if (comparison) {
    requireThat(actor.roles.manager || actor.roles.finance || actor.roles.owner, 'Manager or finance access required', 403);
    const year = comparison[5] ?? String(b.year ?? '');
    if (!/^\d{4}$/.test(year)) return { kind: 'question', question: 'Which year should I compare?' };
    const department = await db.prepare('SELECT id,name,head_email FROM c_departments WHERE active=1 AND lower(name)=lower(?)').bind(comparison[1]).first<{id:string;name:string;head_email:string}>();
    requireThat(department, 'That department is outside your reporting scope', 403);
    if (!can(actor, 'readAll') && department.head_email !== actor.email) {
      const outside = await db.prepare(`SELECT 1 FROM c_members m WHERE m.active=1 AND m.department_id=? AND NOT (${inScope('m.email')}) LIMIT 1`).bind(department.id, ...scopeParams(actor.email)).first();
      const inside = await db.prepare(`SELECT 1 FROM c_members m WHERE m.active=1 AND m.department_id=? AND ${inScope('m.email')} LIMIT 1`).bind(department.id, ...scopeParams(actor.email)).first();
      requireThat(inside && !outside, 'That department is outside your reporting scope', 403);
    }
    const category = (await categories(db)).find(c => c.active && c.name.toLowerCase() === comparison[2].toLowerCase());
    requireThat(category, 'Choose an active spend category');
    const periods = [];
    for (const quarter of [Number(comparison[3]), Number(comparison[4])]) {
      const first = (quarter - 1) * 3 + 1, last = quarter * 3;
      const from = `${year}-${String(first).padStart(2, '0')}-01`, to = new Date(Date.UTC(Number(year), last, 0)).toISOString().slice(0, 10);
      const query = { by: 'category', key: category.id, department: department.id, from, to };
      const report = await spend(db, actor, query);
      requireThat(report.lines, 'Spend detail unavailable', 409);
      const lines: Data[] = report.lines.filter((l: Data) => l.department === department.id);
      periods.push({ quarter, from, to, totalMinor: lines.reduce((sum, l) => sum + l.amountMinor, 0),
        reportLink: `/api/coaster/spend?${new URLSearchParams(query)}`,
        expenses: lines.map(l => ({ claim: l.claim, item: l.item, amountMinor: l.amountMinor, link: `/app#/claims/${l.claim}` })) });
    }
    return { kind: 'spend', currency: settings.currency, department: department.name, category: category.name, year: Number(year), periods,
      differenceMinor: periods[0].totalMinor - periods[1].totalMinor };
  }
  const budget = /^how much of (?:the )?(.+?) budget is left(?: (?:for )?(?:this month|in (\d{4}-\d{2})))?\??$/i.exec(message);
  if (budget) {
    requireThat(actor.roles.manager || actor.roles.finance || actor.roles.owner, 'Manager or finance access required', 403);
    // An explicit month is useful for historical questions; otherwise use the business's current local month.
    const month = budget[2] ?? today.slice(0, 7);
    requireThat(/^\d{4}-(0[1-9]|1[0-2])$/.test(month), 'Choose a real month');
    const rows = (await budgetReport(db, actor, month + '-01')).filter(r => r.name.toLowerCase() === budget[1].toLowerCase() && r.period === 'monthly');
    requireThat(rows.length, 'That monthly budget is unavailable in your scope', 403);
    return { kind: 'budget', currency: settings.currency, month, budgets: rows.map(r => ({ id: r.id, name: r.name, period: r.period_key,
      ...('members' in r ? { members: r.members } : { budgetMinor: r.budgetMinor, actualMinor: r.actualMinor, remainingMinor: r.remainingMinor }),
      link: `/api/coaster/budgets?day=${month}-01` })) };
  }
  const trip = /^(?:add my )?(.+?) (?:client )?trip,? ([A-Za-z]+) (\d{1,2})[–-](\d{1,2})(?:,? (\d{4}))?$/i.exec(message);
  if (trip) {
    requireThat(actor.roles.employee, 'Employee access required', 403);
    const year = trip[5] ?? String(b.year ?? '');
    if (!/^\d{4}$/.test(year)) return { kind: 'question', question: 'Which year was this trip?' };
    const month = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(trip[2].slice(0,3).toLowerCase()) + 1;
    requireThat(month > 0, 'Choose a travel month');
    const date = `${year}-${String(month).padStart(2,'0')}-${trip[3].padStart(2,'0')}`;
    const endDate = `${year}-${String(month).padStart(2,'0')}-${trip[4].padStart(2,'0')}`;
    tripDates(date, endDate);
    requireThat(Array.isArray(b.receipts) && b.receipts.length >= 1 && b.receipts.length <= 20, 'Attach receipts with reviewed date, merchant, amount and category');
    const items = b.receipts.map((r: Data) => {
      requireThat(r && r.receipt && r.date >= date && r.date <= endDate, 'Each receipt needs reviewed details within the trip dates');
      return { kind: 'receipt', date: r.date, merchant: r.merchant, amount: r.amount, category: r.category, receipt: r.receipt,
        description: b.purpose === undefined ? '' : text(b.purpose, 'Business purpose', 500) };
    });
    const known = await categories(db), category = known.find(c => c.active && c.name.toLowerCase() === 'travel');
    requireThat(category, 'Set up an active Travel category first', 409);
    const locations = perDiemLocations('gsa').locations.filter(l => l.label.split(' · ')[0].split(' / ').some(city => city.toLowerCase() === trip[1].toLowerCase()));
    requireThat(locations.length === 1, 'Choose an unambiguous published GSA destination', 409);
    const purpose = b.purpose === undefined ? '' : text(b.purpose, 'Business purpose', 500);
    const proposal = await proposeConversationClaim(db, actor, { title: message, note: purpose || 'What is the business purpose of this trip? Review receipt details and furnished meals before accepting.',
      items: [...items, { kind: 'per_diem', date, category: category.id, description: purpose,
        manualRate: b.manualRate, perDiem: { method: 'gsa', locationId: locations[0].id, endDate, component: 'mie' } }] });
    return { kind: 'proposal', proposal, question: purpose ? null : 'What is the business purpose of this trip?', reviewRequired: true, link: '/app#/claims' };
  }
  return { kind: 'question', question: 'Ask about department spend by quarter, a monthly budget, or a dated trip with reviewed receipt details. Submission, approval and payment stay in their ordinary workflows.' };
}
