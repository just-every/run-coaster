import { batchLines } from '../../batches';
import { decimal, now, uid, requireThat, type Data } from '../../types';
import { ref, tag } from './xml';

/** Queue stable source identities; completed and uncertain requests can never be enqueued again. */
export async function preparePosting(db: D1Database) {
  const out: D1PreparedStatement[]=[];
  const add=(source:string,kind:string,payload:Data)=>out.push(db.prepare("INSERT OR IGNORE INTO c_qbd_requests(id,source,kind,payload,status,created_at) VALUES(?,?,?,?, 'pending',?)").bind(uid(),source,kind,JSON.stringify(payload),now()));
  for(const batch of (await db.prepare("SELECT * FROM c_batches WHERE entity_id='primary' AND status IN('approved','reimbursed') ORDER BY number").all<Data>()).results) {
    const {lines,people}=await batchLines(db,batch.id);
    requireThat(lines.reduce((n,l)=>n+l.amountMinor,0)===batch.total_minor,'Batch accounting lines do not equal its total',409);
    for(const person of people) {
      const source=`bill:${batch.id}:${person.email}`,own=lines.filter(l=>l.employee===person.email);
      requireThat(own.reduce((n,l)=>n+l.amountMinor,0)===person.amountMinor,'Employee bill does not reconcile',409);
      add(source,'BillAdd',{ employee:person.email,date:batch.reviewed_at.slice(0,10),lines:own.map(l=>({account:l.account,amountMinor:l.amountMinor,merchant:l.merchant,description:l.description,costCentre:l.costCentre})),total:person.amountMinor,batch:batch.id,currency:batch.currency });
      const posted=await db.prepare("SELECT txn_id FROM c_qbd_requests WHERE source=? AND status='succeeded'").bind(source).first<{txn_id:string}>();
      if(batch.status==='reimbursed' && posted) add(`payment:${batch.id}:${person.email}`,'BillPaymentCheckAdd',{employee:person.email,date:batch.paid_on,txn:posted.txn_id,total:person.amountMinor,reference:batch.paid_reference,currency:batch.currency});
    }
  }
  const claims=(await db.prepare("SELECT c.id,c.revision,r.snapshot FROM c_claims c JOIN c_revisions r ON r.claim_id=c.id AND r.revision=c.revision WHERE c.entity_id='primary' AND c.status IN('approved','batched','reimbursed') ORDER BY c.number").all<Data>()).results;
  for(const claim of claims) for(const item of JSON.parse(claim.snapshot).items) if(item.card_charge_id) {
    const charge=await db.prepare('SELECT card_id FROM c_card_charges WHERE id=?').bind(item.card_charge_id).first<{card_id:string}>();
    requireThat(charge,'Card expense has no source charge',409);
    const lines=item.allocations.map((p:Data)=>({account:p.account_code,amountMinor:p.amount_minor,costCentre:p.cost_centre,description:item.description,merchant:item.merchant}));
    if(item.sales_tax_minor) lines.push({account:item.sales_tax_account,amountMinor:item.sales_tax_minor,costCentre:'',description:'Sales tax',merchant:item.merchant});
    requireThat(lines.reduce((n:number,l:Data)=>n+l.amountMinor,0)===item.amount_minor,'Card accounting lines do not equal the charge',409);
    add('card:'+item.card_charge_id,'CreditCardChargeAdd',{card:charge.card_id,claim:claim.id,revision:claim.revision,date:item.spent_on,lines,total:item.amount_minor});
  }
  // Purchase lines are already posted as card charges; journals carry only the remaining statement entries.
  for(const line of (await db.prepare("SELECT * FROM c_card_ledger WHERE kind<>'purchase' ORDER BY posted_at,seq").all<Data>()).results)
    add('journal:'+line.id,'JournalEntryAdd',line);
  return out;
}
async function mapped(db:D1Database,name:string,kind='Account') {
  const row=await db.prepare('SELECT m.list_id FROM c_qbd_mappings m JOIN c_qbd_catalog c ON c.kind=m.kind AND c.list_id=m.list_id AND c.active=1 WHERE m.name=? AND m.kind=?').bind(name,kind).first<{list_id:string}>();
  requireThat(row,`Map ${name} to an active QuickBooks ${kind.toLowerCase()} before retrying`,409);
  return row.list_id;
}
export async function renderPosting(db:D1Database,row:Data) {
  const p=JSON.parse(row.payload),rq=row.kind+'Rq',r=ref,t=tag;
  if(p.batch)requireThat(await db.prepare("SELECT 1 FROM c_batches b WHERE b.id=? AND b.entity_id='primary' AND NOT EXISTS(SELECT 1 FROM c_batch_claims bc JOIN c_claims c ON c.id=bc.claim_id WHERE bc.batch_id=b.id AND c.entity_id<>'primary')").bind(p.batch).first(),'This Desktop connection belongs to the primary legal entity',409);
  if(p.claim)requireThat(await db.prepare("SELECT 1 FROM c_claims WHERE id=? AND entity_id='primary'").bind(p.claim).first(),'This Desktop connection belongs to the primary legal entity',409);
  const line=async (l:Data) => {
    return `<ExpenseLineAdd>${r('AccountRef',await mapped(db,'account:'+l.account))}${t('Amount',decimal(l.amountMinor))}${t('Memo',(l.merchant+' '+l.description).slice(0,4095))}${l.costCentre?r('ClassRef',await mapped(db,'class:'+l.costCentre,'Class')):''}</ExpenseLineAdd>`;
  };
  if(row.kind==='CreditCardChargeAdd') requireThat(await db.prepare("SELECT 1 FROM c_claims WHERE id=? AND revision=? AND status IN('approved','batched','reimbursed')").bind(p.claim,p.revision).first(),'The card claim changed after it was queued; reconcile before posting',409);
  let body='';
  if(row.kind==='BillAdd') body=`<BillAdd>${r('VendorRef',await mapped(db,'vendor:'+p.employee,'Vendor'))}${r('APAccountRef',await mapped(db,'payable'))}${t('TxnDate',p.date)}${t('RefNumber',row.id.replaceAll('-','').slice(0,20))}${t('Memo','Coaster batch '+p.batch)}${(await Promise.all(p.lines.map(line))).join('')}</BillAdd>`;
  else if(row.kind==='CreditCardChargeAdd') body=`<CreditCardChargeAdd>${r('AccountRef',await mapped(db,'card:'+p.card))}${t('TxnDate',p.date)}${t('RefNumber',row.id.replaceAll('-','').slice(0,11))}${t('Memo','Coaster '+row.source)}${(await Promise.all(p.lines.map(line))).join('')}</CreditCardChargeAdd>`;
  else if(row.kind==='BillPaymentCheckAdd') body=`<BillPaymentCheckAdd>${r('PayeeEntityRef',await mapped(db,'vendor:'+p.employee,'Vendor'))}${r('APAccountRef',await mapped(db,'payable'))}${t('TxnDate',p.date)}${r('BankAccountRef',await mapped(db,'bank'))}${t('IsToBePrinted','false')}${t('RefNumber',String(p.reference).slice(0,11))}<AppliedToTxnAdd>${t('TxnID',p.txn)}${t('PaymentAmount',decimal(p.total))}</AppliedToTxnAdd></BillPaymentCheckAdd>`;
  else if(row.kind==='JournalEntryAdd') body=`<JournalEntryAdd>${t('TxnDate',p.posted_on)}${t('RefNumber',row.id.replaceAll('-','').slice(0,11))}<JournalDebitLine>${r('AccountRef',await mapped(db,'account:'+p.debit_account))}${t('Amount',decimal(p.amount_minor))}${t('Memo',p.memo)}</JournalDebitLine><JournalCreditLine>${r('AccountRef',await mapped(db,'account:'+p.credit_account))}${t('Amount',decimal(p.amount_minor))}${t('Memo',p.memo)}</JournalCreditLine></JournalEntryAdd>`;
  else requireThat(false,'Unknown Desktop posting kind',409);
  return `<${rq} requestID="${row.id}">${body}</${rq}>`;
}
