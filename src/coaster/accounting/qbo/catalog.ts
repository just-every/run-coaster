import { sha256Hex } from '../../session';
import { catalogState, advanceCatalog } from '../../coding/model';
import { requireThat, type Data } from '../../types';
import { companyKey, type Connection } from './model';
import type { Metadata } from './network';

type Kind = 'account' | 'class' | 'location' | 'department' | 'customer' | 'vendor' | 'project';
const labels: Record<Kind, string> = { account: 'Accounts', class: 'Classes', location: 'Locations', department: 'Departments', customer: 'Customers', vendor: 'Vendors', project: 'Projects' };
/** Provider ids are stable and separate from native choices. No provider field is treated as instructions. */
export async function catalogWrites(db: D1Database, c: Connection, data: Metadata, at: string) {
  const company = companyKey(c), namespace = (await sha256Hex(company)).slice(0, 20);
  const dimension = (kind: Kind) => `qbo-${namespace}-${kind}`;
  const valueId = async (kind: Kind, source: string) => `qbo-${await sha256Hex(`${company}|${kind}|${source}`)}`;
  const v = await db.prepare('SELECT version FROM c_coding_version WHERE id=1').first<{ version: number }>();
  requireThat(v, 'The accounting-dimension catalog is not installed', 409);
  const groups: Record<Kind, Data[]> = { account: data.Account, class: data.Class, location: data.Department, department: data.Department, customer: data.Customer, vendor: data.Vendor, project: data.Customer.filter(r => r.IsProject === true || r.Job === true) };
  const statements: D1PreparedStatement[] = [], counts: Record<string, number> = {};
  for (const kind of Object.keys(groups) as Kind[]) {
    statements.push(db.prepare("INSERT INTO c_coding_dimensions(id,name,kind,parent_id,required,active,source,source_company,updated_at) VALUES(?,?,?,?,0,1,'quickbooks',?,?) ON CONFLICT(id) DO UPDATE SET active=1,updated_at=excluded.updated_at").bind(dimension(kind), `QuickBooks ${labels[kind]} (${company})`, kind, kind === 'project' ? dimension('customer') : null, company, at));
    // Reset only inside the successful complete snapshot's batch; a failed request preserves the old catalog.
    statements.push(db.prepare('UPDATE c_coding_values SET active=0,updated_at=? WHERE dimension_id=?').bind(at, dimension(kind)));
    counts[kind] = 0;
    for (const row of groups[kind]) {
      const name = row.FullyQualifiedName ?? row.DisplayName ?? row.Name;
      requireThat(typeof name === 'string' && name.trim() && name.length <= 500, 'QuickBooks returned a choice without a usable name', 502);
      const parent = kind === 'project' ? row.ParentRef?.value : null;
      requireThat(kind !== 'project' || typeof parent === 'string' && data.Customer.some(p => p.Id === parent), 'QuickBooks returned a project without its customer', 502);
      const active = row.Active === true ? 1 : 0;
      statements.push(db.prepare('INSERT INTO c_coding_values(id,dimension_id,name,parent_value_id,owner_email,active,source_id,updated_at) VALUES(?,?,?,?,NULL,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,parent_value_id=excluded.parent_value_id,active=excluded.active,updated_at=excluded.updated_at').bind(await valueId(kind, row.Id), dimension(kind), name.trim(), parent ? await valueId('customer', parent) : null, active, row.Id, at));
      counts[kind] += active;
    }
  }
  statements.push(advanceCatalog(db), db.prepare('INSERT INTO c_coding_refreshes(company,refreshed_at,counts) VALUES(?,?,?)').bind(company, at, JSON.stringify(counts)));
  return { guard: catalogState(v.version), statements, counts };
}
