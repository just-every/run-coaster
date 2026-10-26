import type { Bindings } from '../../auth.server';
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
  const { people } = await batchLines(env.DB, batch.id);
  const mappings = (await env.DB.prepare('SELECT email,employee_uuid FROM c_gusto_employees').all<{ email: string; employee_uuid: string }>()).results;
  return people.map(p => ({ email: p.email, name: p.name, employeeUuid: mappings.find(m => m.email === p.email)?.employee_uuid ?? '', reimbursementMinor: p.amountMinor - p.taxableMinor, taxableMinor: p.taxableMinor }));
}

/** Preserve existing payroll amounts. A versioned update touches only the selected employees. */
export function compensationPlan(payroll: Data, lines: PayrollLine[], reference: string) {
  requireThat(Array.isArray(payroll.employee_compensations), 'Prepare the Gusto run before adding amounts', 409);
  return lines.map(line => {
    const employee = payroll.employee_compensations.find((e: Data) => e.employee_uuid === line.employeeUuid);
    requireThat(employee && typeof employee.version === 'string', 'A mapped employee is missing from this payroll', 409);
    requireThat(Array.isArray(employee.reimbursements) && Array.isArray(employee.fixed_compensations), 'This payroll does not support separate reimbursement lines; no amounts were sent', 409);
    const reimbursements = employee.reimbursements.map((r: Data) => ({ ...r }));
    requireThat(!reimbursements.some((r: Data) => r.description === reference), 'This batch reference already exists in Gusto; reconcile it before proceeding', 409);
    if (line.reimbursementMinor) reimbursements.push({ amount: dollars(line.reimbursementMinor), description: reference });
    const fixed = employee.fixed_compensations.map((f: Data) => ({ ...f }));
    if (line.taxableMinor) {
      const bonus = fixed.find((f: Data) => f.name === 'Bonus');
      requireThat(bonus && typeof bonus.job_uuid === 'string', 'This employee needs a taxable Bonus earning on the next Gusto payroll', 409);
      bonus.amount = dollars(cents(bonus.amount) + line.taxableMinor);
    }
    return { employee_uuid: line.employeeUuid, version: employee.version, excluded: false, payment_method: employee.payment_method, fixed_compensations: fixed, reimbursements };
  });
}
const sorted = (values: Data[]) => values.map(value => JSON.stringify(value)).sort();
/** Provider-generated reimbursement UUIDs and compensation versions may change; financial evidence may not. */
export function sameCompensation(actual: Data, expected: Data) {
  const refunds = (row: Data) => sorted((row.reimbursements ?? []).map((r: Data) => ({ amount: cents(r.amount), description: r.description ?? '' })));
  const fixed = (row: Data) => sorted((row.fixed_compensations ?? []).filter((f: Data) => cents(f.amount) !== 0).map((f: Data) => ({ name: f.name, job: f.job_uuid, amount: cents(f.amount) })));
  return actual.employee_uuid === expected.employee_uuid && actual.excluded !== true && actual.payment_method === expected.payment_method && JSON.stringify(refunds(actual)) === JSON.stringify(refunds(expected)) && JSON.stringify(fixed(actual)) === JSON.stringify(fixed(expected));
}
