import { personalCharge } from './personal-charges';
import { prepareTarget } from '../coding/automatic/storage';
import { insertItem } from '../claims';
import { chargeStatements } from '../cards/charges';
import { categoryFor, type Held } from '../cards/plan';
import { type ItemInput } from '../items';
import { sha256Hex } from '../session';
import { now, uid, type Actor, type Data } from '../types';
import type { Transaction } from './transactions';

/** Retain a minimized provider fact snapshot and use the existing immutable card, coding and expense doors. */
export async function plaidExpense(db: D1Database, actor: Actor, connection: string, scope: string, tx: Transaction, assignment: Data, held: Held, claim: string, position: number) {
  const source = uid(), at = now(), category = await categoryFor(db, assignment.category_id);
  const bytes = new TextEncoder().encode(JSON.stringify(Object.fromEntries(['transaction_id','account_id','pending_transaction_id','pending','spent_on','posted_on','merchant','amount_minor','currency'].map(k=>[k,(tx as unknown as Data)[k]]))));
  const sourceWrite = db.prepare('INSERT INTO c_plaid_sources VALUES(?,?,?,?,?,?,?,?)').bind(source, connection, tx.transaction_id, bytes, await sha256Hex(bytes), bytes.length, JSON.stringify({ provider: 'Plaid sandbox', coding: { category: category.id, costCentre: '' } }), at);
  if (scope === 'company') {
    const card = await db.prepare('SELECT issuer FROM c_cards WHERE id=?').bind(assignment.card_id).first<{issuer:string}>();
    const result = await chargeStatements(db, actor, { file: source, issuer: card!.issuer, category, costCentre: '', held, claim, position, at });
    return { item: result.item, charge: result.charge, guard: result.guard, statements: [sourceWrite, ...result.statements] };
  }
  const id = uid(), automatic = await prepareTarget(db, { kind: 'item', id, employee: held.employee, claim, merchant: tx.merchant }, {}, {}, [], true);
  const verified=(JSON.parse((await db.prepare('SELECT accounts FROM c_plaid_connections WHERE id=?').bind(connection).first<{accounts:string}>())!.accounts) as Data[]).find(account=>account.id===tx.account_id)!;
  const provenance=personalCharge(db,source,connection,tx,held.employee,id,category.id,claim,verified.last4);
  const values = automatic.values;
  const input: ItemInput = { personal_card_charge_id:provenance.id, kind: 'receipt', spent_on: tx.spent_on, merchant: tx.merchant, description: values.memo ?? '', amount_minor: tx.amount_minor, distance_hundredths: null, days: null, rate_thousandths: null, explanation: '', allocations: [{ category_id: values.category ?? category.id, cost_centre: '', amount_minor: tx.amount_minor }], sales_tax_minor: 0, sales_tax_account: '', sales_tax_code: '', attendees: [], fields: {}, billable: false, customer: values.customer ?? '', project: values.project ?? '', coding: values.dimensions ?? {} };
  return { item: id, charge: null, guard: automatic.guard, statements: [sourceWrite, provenance.statement, ...insertItem(db, claim, id, position, input, null), ...automatic.writes] };
}
