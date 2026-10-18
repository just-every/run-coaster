import { useState, type ReactNode } from 'react';
import { claimNumber, money, shortDay, statusTone, type D } from './api';
import { Badge, Initials } from './parts';

const order = ['submitted', 'returned', 'draft', 'approved', 'batched', 'reimbursed', 'rejected'];
const columns: { key: string; label: string; figure?: boolean; value: (c: D) => string | number }[] = [
  { key: 'person', label: 'Person', value: c => c.employee_name.toLowerCase() },
  { key: 'title', label: 'Claim', value: c => c.title.toLowerCase() },
  { key: 'amount', label: 'Amount', figure: true, value: c => c.total_minor },
  { key: 'approver', label: 'Approver', value: c => (c.approver_name ?? '').toLowerCase() },
  { key: 'status', label: 'Status', value: c => order.indexOf(c.status) },
  { key: 'updated', label: 'Updated', value: c => c.updated_at },
];

function SortMark() {
  return <span className="sort-mark" aria-hidden="true"><svg viewBox="0 0 10 6"><path d="M1.5 5 5 1.5 8.5 5" /></svg><svg viewBox="0 0 10 6"><path d="M1.5 1 5 4.5 8.5 1" /></svg></span>;
}

/** The pick's dense table of claims: person with initials, the claim and its number, a tabular amount, approver,
    status pill and last change, sortable by any column. A row opens its claim in the panel. */
export function ClaimsTable({ claims, selected, view, label, foot, initialSort = 'updated' }: { claims: D[]; selected?: string; view: string; label: string; foot?: ReactNode; initialSort?: string }) {
  const [sort, setSort] = useState({ key: initialSort, dir: initialSort === 'updated' ? -1 : 1 });
  const column = columns.find(c => c.key === sort.key)!;
  const rows = [...claims].sort((a, b) => { const x = column.value(a), y = column.value(b); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir || b.number - a.number; });
  return <div className="table-wrap">
    <table className="data" aria-label={label}>
      <colgroup><col style={{ width: '20%' }} /><col style={{ width: '25%' }} /><col style={{ width: '11%' }} /><col style={{ width: '13%' }} /><col style={{ width: '18%' }} /><col style={{ width: '13%' }} /></colgroup>
      <thead><tr>{columns.map(c => <th key={c.key} className={c.figure ? 'figure' : undefined} aria-sort={sort.key === c.key ? sort.dir > 0 ? 'ascending' : 'descending' : undefined}>
        <button className="sort" type="button" onClick={() => setSort({ key: c.key, dir: sort.key === c.key ? -sort.dir : c.figure || c.key === 'updated' ? -1 : 1 })}>{c.label}<SortMark /></button>
      </th>)}</tr></thead>
      <tbody>{rows.map(c => <tr key={c.id} className={c.id === selected ? `selected row-${statusTone[c.status] ?? 'quiet'}` : undefined}>
        <td data-cell="person"><span className="person"><Initials name={c.employee_name} /><span>{c.employee_name}</span></span></td>
        <td data-cell="title"><a className="title-link" title={c.title} href={`#/${view}/${c.id}`} aria-current={c.id === selected ? 'true' : undefined}>{c.title}</a><span className="sub">{claimNumber(c.number)}{c.prepared_by ? ` · prepared by ${c.prepared_by}` : ''}</span></td>
        <td data-cell="amount" className="figure amount">{money(c.total_minor, c.currency)}</td>
        <td data-cell="approver" className="soft">{c.approver_name ?? <span aria-label="Set at submission" title="Set at submission">—</span>}</td>
        <td data-cell="status"><Badge status={c.status} /></td>
        <td data-cell="updated" className="soft nowrap">{shortDay(c.updated_at)}</td>
      </tr>)}</tbody>
    </table>
    {foot && <div className="table-foot">{foot}</div>}
  </div>;
}
