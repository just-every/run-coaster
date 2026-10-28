import type { Bindings } from '../../auth.server';
import { sha256Hex } from '../session';
import { batchLines, type Batch } from '../batches';
import { requireThat, type Data } from '../types';
import type { PayrollLine } from './model';

export const cents = (value: unknown): number => {
  requireThat(typeof value === 'string' && /^\d+(\.\d{1,2})?$/.test(value), 'Gusto returned an invalid money amount', 502);
  const [whole, fraction = ''] = value.split('.'), amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  requireThat(Number.isSafeInteger(amount), 'Gusto amount exceeds supported precision', 502);
  return amount;
};
export const dollars = (amount: number) => (amount / 100).toFixed(2);
export async function payrollLines(env: Bindings, batch: Batch): Promise<PayrollLine[]> {
  requireThat(batch.entity_id==='primary','This payroll connection belongs to the primary legal entity',409);
  const { people } = await batchLines(env.DB, batch.id);
  const mappings = (await env.DB.prepare('SELECT email,employee_uuid FROM c_gusto_employees').all<{ email: string; employee_uuid: string }>()).results;
  return people.map(p => ({ email: p.email, name: p.name, employeeUuid: mappings.find(m => m.email === p.email)?.employee_uuid ?? '', reimbursementMinor: p.amountMinor - p.taxableMinor, taxableMinor: p.taxableMinor }));
}

/** Preserve existing payroll amounts. A versioned update touches only the selected employees. */
export function compensationPlan(payroll: Data, lines: PayrollLine[], reference: string, bonusAvailable: boolean) {
  requireThat(Array.isArray(payroll.employee_compensations), 'Prepare the Gusto run before adding amounts', 409);
  return lines.map(line => {
    const employee = payroll.employee_compensations.find((e: Data) => e.employee_uuid === line.employeeUuid);
    requireThat(employee && typeof employee.version === 'string', 'A mapped employee is missing from this payroll', 409);
    requireThat(Array.isArray(employee.reimbursements) && Array.isArray(employee.fixed_compensations), 'This payroll does not support separate reimbursement lines; no amounts were sent', 409);
    const reimbursements = employee.reimbursements.map((r: Data) => ({ ...(typeof r.uuid==='string'?{uuid:r.uuid}:{}), amount:r.amount, description:r.description??'' }));
    requireThat(!reimbursements.some((r: Data) => r.description === reference), 'This batch reference already exists in Gusto; reconcile it before proceeding', 409);
    if (line.reimbursementMinor) reimbursements.push({ amount: dollars(line.reimbursementMinor), description: reference });
    const fixed = employee.fixed_compensations.map((f: Data) => ({ name:f.name, amount:f.amount, ...(typeof f.job_uuid==='string'?{job_uuid:f.job_uuid}:{}), ...(Array.isArray(f.breakdowns)&&f.breakdowns.length?{breakdowns:f.breakdowns}:{}) }));
    if (line.taxableMinor) {
      const bonus = fixed.find((f: Data) => f.name === 'Bonus');
      requireThat(bonusAvailable, 'The Gusto company does not offer the taxable Bonus earning required by this batch', 409);
      if (bonus) {
        requireThat(!bonus.breakdowns?.length, 'The existing Gusto Bonus has workweek allocations; reconcile those in Gusto before adding taxable amounts', 409);
        bonus.amount = dollars(cents(bonus.amount) + line.taxableMinor);
      }
      else fixed.push({ name: 'Bonus', amount: dollars(line.taxableMinor) });
    }
    return { employee_uuid: line.employeeUuid, version: employee.version, excluded: false, payment_method: employee.payment_method, fixed_compensations: fixed, reimbursements };
  });
}
const sorted = (values: Data[]) => values.map(value => JSON.stringify(value)).sort();
/** Provider-generated reimbursement UUIDs and compensation versions may change; financial evidence may not. */
export async function compensationEvidence(row: Data) {
  const refunds = (row.reimbursements ?? []).map((r: Data) => ({ amount: cents(r.amount), description: r.description ?? '' }));
  const fixed = (row.fixed_compensations ?? []).filter((f: Data) => cents(f.amount) !== 0).map((f: Data) => ({ name: f.name, amount: cents(f.amount) }));
  return { employee_uuid: row.employee_uuid, payment_method: row.payment_method, reimbursementMinor: refunds.reduce((sum: number,r: Data)=>sum+r.amount,0), reimbursementDigest: await sha256Hex(JSON.stringify(sorted(refunds))), fixedDigest: await sha256Hex(JSON.stringify(sorted(fixed))) };
}
export async function sameCompensation(actual: Data, expected: Data) {
  return actual.excluded !== true && JSON.stringify(await compensationEvidence(actual)) === JSON.stringify(expected);
}
