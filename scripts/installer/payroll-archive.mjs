import { PortabilityError } from '@runeditrun/rer/modules/portability';

/** Financial handoffs travel without any credential, mapping, scheduler or dispatch authority. */
export async function validatePayrollArchive(read) {
  const [handoffs,batches,events] = await Promise.all(['c_payroll_handoffs','c_batches','c_events'].map(read));
  const check = ok => { if(!ok)throw new PortabilityError('coaster_payroll',409); };
  for(const h of handoffs) {
    const batch=batches.find(b=>b.id===h.batch_id);
    let lines,expected;
    try {lines=JSON.parse(h.lines);expected=JSON.parse(h.expected);}catch{check(false);}
    check(batch && Array.isArray(lines) && lines.length>0 && Array.isArray(expected) && expected.length===lines.length);
    check(new Set(lines.map(l=>l.employeeUuid)).size===lines.length && lines.every(l=>typeof l.email==='string' && typeof l.employeeUuid==='string' && Number.isSafeInteger(l.reimbursementMinor) && l.reimbursementMinor>=0 && Number.isSafeInteger(l.taxableMinor) && l.taxableMinor>=0));
    check(lines.reduce((sum,l)=>sum+l.reimbursementMinor+l.taxableMinor,0)===batch.total_minor);
    check(['reserved','sent','confirmed'].includes(h.status) && typeof h.company_uuid==='string' && typeof h.payroll_uuid==='string' && /^\d{4}-\d{2}-\d{2}$/.test(h.check_date));
    check(h.status==='confirmed' ? batch.status==='reimbursed' && batch.paid_reference===`Gusto ${h.payroll_uuid}` && batch.paid_on===h.check_date && h.confirmed_at : batch.status==='approved' && !h.confirmed_at);
    check(expected.every(e=>lines.some(l=>e.employee_uuid===l.employeeUuid) && Array.isArray(e.reimbursements) && Array.isArray(e.fixed_compensations)));
    check(events.some(e=>e.batch_id===batch.id && e.action==='payroll-handoff-reserved' && JSON.parse(e.detail).handoff===h.id));
    if(h.status==='confirmed')check(events.some(e=>e.batch_id===batch.id && e.action==='batch-reimbursed' && JSON.parse(e.detail).handoff===h.id));
  }
}
