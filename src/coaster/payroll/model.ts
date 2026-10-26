import type { Bindings } from '../../auth.server';
import { authority, need, type Sql } from '../session';
import { requireThat, type Actor } from '../types';

export type Connection = { company_uuid: string; company_name: string; token_sealed: string; connected_by: string; connected_at: string };
export type PayrollLine = { email: string; name: string; employeeUuid: string; reimbursementMinor: number; taxableMinor: number };
export type Handoff = { id: string; batch_id: string; company_uuid: string; payroll_uuid: string; check_date: string; status: string; lines: string; expected: string; created_by: string; created_at: string; confirmed_at: string | null };
export const connection = (env: Bindings) => env.DB.prepare('SELECT * FROM c_gusto_connection WHERE id=1').first<Connection>();
export const handoff = (env: Bindings, batch: string) => env.DB.prepare('SELECT * FROM c_payroll_handoffs WHERE batch_id=?').bind(batch).first<Handoff>();
export function nativeOwner(actor: Actor) {
  need(actor, 'owner');
  requireThat(actor.kind === 'person' && !actor.delegate && !actor.publicCredential, 'Use the owner’s own native session for payroll', 403);
  return authority(actor, 'owner');
}
export const connectionState = (c: Connection): Sql => ({ sql: 'EXISTS(SELECT 1 FROM c_gusto_connection WHERE id=1 AND company_uuid=? AND token_sealed=?)', params: [c.company_uuid, c.token_sealed] });
export const publicHandoff = (h: Handoff | null) => h ? { ...h, expected: undefined, lines: JSON.parse(h.lines) } : null;
export function providerId(value: unknown) {
  requireThat(typeof value === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(value), 'Choose a valid Gusto identifier');
  return value;
}
