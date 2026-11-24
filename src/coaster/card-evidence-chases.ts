import { categories } from './items';
import { policyConfiguration } from './policy-configuration';
import type { Business } from './settings';
import type { Data } from './types';

/** Posted card evidence is owed at every amount. The statement's posting date is the age anchor, even when the
 * scheduler first sees an older import. Mutable expense evidence is read afresh; source card facts stay immutable. */
export async function cardEvidenceChases(db: D1Database, settings: Business) {
  const policy = await policyConfiguration(db, settings, await categories(db));
  // Only card expenses that can be missing something are read: no receipt, no memo, or a category whose policy requires
  // fields. Complete ones, however many the business has, are never touched.
  const fieldCategories = [...new Set([...policy.categories.filter(c => c.required_fields.length).map(c => c.id),
    ...policy.rules.flatMap(rule => rule.kind === 'required-field' ? [rule.category] : [])])];
  const select = `SELECT ch.id,ch.posted_on,i.id AS item,i.receipt_id,i.description,i.fields,
    c.id AS claim,c.number,c.title,c.employee_email,
    COALESCE((SELECT json_group_array(a.category_id) FROM c_allocations a WHERE a.item_id=i.id),'[]') AS allocations
    FROM c_items i JOIN c_card_charges ch ON ch.id=i.card_charge_id
    JOIN c_claims c ON c.id=i.claim_id JOIN c_members m ON m.email=c.employee_email
    WHERE m.active=1 AND m.is_employee=1 AND i.card_charge_id IS NOT NULL AND `;
  const rows = (await db.prepare([`${select}i.receipt_id IS NULL`, `${select}trim(i.description)=''`,
    ...(fieldCategories.length ? [`${select}i.id IN (SELECT a.item_id FROM c_allocations a WHERE a.category_id IN (SELECT value FROM json_each(?)))`] : [])].join(' UNION ') + ' ORDER BY 2,1')
    .bind(...(fieldCategories.length ? [JSON.stringify(fieldCategories)] : [])).all<Data>()).results;
  return rows.flatMap(r => {
    const values = JSON.parse(r.fields) as Record<string, string>;
    const allocated = new Set(JSON.parse(r.allocations) as string[]);
    const required = [...policy.categories.filter(c => allocated.has(c.id)).flatMap(c => c.required_fields),
      ...policy.rules.flatMap(rule => rule.kind === 'required-field' && allocated.has(rule.category) ? [rule.field] : [])];
    const fields = [...new Set(required)].filter(name => !Object.hasOwn(values, name) || !values[name].trim());
    const missing = [...(!r.receipt_id ? ['receipt'] : []), ...(!r.description.trim() ? ['memo'] : []), ...fields];
    return missing.length ? [{ key: `card-evidence:${r.id}`, person: r.employee_email as string,
      claim: r.claim as string, number: r.number as number, title: r.title as string,
      action: 'Complete card expense evidence', postedOn: r.posted_on as string }] : [];
  });
}
