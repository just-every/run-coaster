import { authority, type Role, type Sql } from './session';
import { requireThat, type Actor } from './types';

/** ADMIN-001's role permission matrix, one entry per row: the roles whose cell is allowed. A person's powers are the union
 * of their roles and the owner holds every row; `employee` stands for every role that submits its own expenses (owner, admin,
 * finance, card admin, approver, employee) and `manager` is the approver role (what a workflow step names, APPROVE-001). Cells
 * with a limit (an approver's own decisions or reports, a card admin's card spend, an employee's own records) are applied
 * where the door reads or writes the record. The matrix table in CONTRACT.md is the source the permission journey reads. */
export const MATRIX = {
  settings: ['owner', 'admin'],
  people: ['owner', 'admin'],
  policy: ['owner', 'admin', 'finance'],
  funding: ['owner'],
  connections: ['owner', 'admin', 'finance'],
  cards: ['owner', 'admin', 'cardAdmin'],
  submit: ['employee'],
  decide: ['manager'],
  unapprove: ['owner', 'admin', 'finance'],
  readAll: ['owner', 'admin', 'finance', 'auditor', 'bookkeeper'],
  coding: ['owner', 'finance', 'bookkeeper'],
  batches: ['owner', 'finance'],
  release: ['owner', 'finance'],
  bank: ['owner', 'finance'],
  sync: ['owner', 'finance', 'bookkeeper'],
  exportFiles: ['owner', 'admin', 'finance', 'auditor', 'bookkeeper'],
  auditPack: ['owner', 'admin', 'finance', 'auditor'],
  history: ['owner', 'admin', 'finance', 'auditor'],
} as const satisfies Record<string, readonly Role[]>;
export type Row = keyof typeof MATRIX;

const WORDS: Record<Role, string> = { owner: 'owner', admin: 'admin', finance: 'finance', cardAdmin: 'card admin', manager: 'approver', employee: 'employee', auditor: 'auditor', bookkeeper: 'bookkeeper' };
export const can = (actor: Actor, row: Row) => MATRIX[row].some(role => actor.roles[role]);
/** Refuses with 403 and no write unless one of the row's roles is held. */
export function needRow(actor: Actor, row: Row, message?: string) {
  requireThat(can(actor, row), message ?? `${MATRIX[row].map(r => WORDS[r]).join(', ')} access required`, 403);
}
/** Authority SQL for a write under the row: any of its roles, the owner always. */
export const rowAuthority = (actor: Actor, row: Row): Sql => authority(actor, [...MATRIX[row]]);
