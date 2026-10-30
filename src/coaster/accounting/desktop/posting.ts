import { correctedItems, correctionsFor } from '../coding-corrections';
import type { Sql } from '../../session';
import { batchLines } from '../../batches';
import { decimal, now, uid, requireThat, type Data } from '../../types';
import { ref, tag } from './xml';

/** Queue stable source identities; completed and uncertain requests can never be enqueued again. */
export async function preparePosting(db: D1Database) {
  const out: D1PreparedStatement[]=[];
  const add=(source:string,kind:string,payload:Data,condition:Sql={sql:'1',params:[]})=>out.push(db.prepare(`INSERT OR IGNORE INTO c_qbd_requests(id,source,kind,payload,status,created_at) SELECT ?,?,?,?,'pending',? WHERE ${condition.sql}`).bind(uid(),source,kind,JSON.stringify(payload),now(),...condition.params));
  for(const batch of (await db.prepare("SELECT * FROM c_batches WHERE status IN('approved','reimbursed') ORDER BY number").all<Data>()).results) {
    const {lines,people}=await batchLines(db,batch.id);
    requireThat(lines.reduce((n,l)=>n+l.amountMinor,0)===batch.total_minor,'Batch accounting lines do not equal its total',409);
    for(const person of people) {
      const source=`bill:${batch.id}:${person.email}`,own=lines.filter(l=>l.employee===person.email);
      requireThat(own.reduce((n,l)=>n+l.amountMinor,0)===person.amountMinor,'Employee bill does not reconcile',409);
      add(source,'BillAdd',{ employee:person.email,date:batch.reviewed_at.slice(0,10),lines:own.map(l=>({account:l.account,amountMinor:l.amountMinor,merchant:l.merchant,description:l.description,costCentre:l.costCentre})),total:person.amountMinor,batch:batch.id,currency:batch.currency,claims:(await db.prepare('SELECT claim_id FROM c_batch_claims WHERE batch_id=? AND claim_id IN(SELECT id FROM c_claims WHERE employee_email=?)').bind(batch.id,person.email).all<{claim_id:string}>()).results.map(c=>c.claim_id) },{sql:"EXISTS(SELECT 1 FROM c_batches WHERE id=? AND version=? AND status IN('approved','reimbursed'))",params:[batch.id,batch.version]});
      const posted=await db.prepare("SELECT txn_id FROM c_qbd_requests WHERE source=? AND status='succeeded'").bind(source).first<{txn_id:string}>();
      if(batch.status==='reimbursed' && posted) add(`payment:${batch.id}:${person.email}`,'BillPaymentCheckAdd',{employee:person.email,date:batch.paid_on,txn:posted.txn_id,total:person.amountMinor,reference:batch.paid_reference,currency:batch.currency});
    }
  }
  const claims=(await db.prepare("SELECT c.id,c.revision,c.version,r.snapshot FROM c_claims c JOIN c_revisions r ON r.claim_id=c.id AND r.revision=c.revision WHERE c.status IN('approved','batched','reimbursed') ORDER BY c.number").all<Data>()).results;
  for(const claim of claims) {
   const corrections=await correctionsFor(db,claim.id,claim.revision);
   for(const item of correctedItems(JSON.parse(claim.snapshot).items,corrections)) if(item.card_charge_id && (item.card_liability ?? 'company')==='company') {
    const charge=await db.prepare('SELECT card_id FROM c_card_charges WHERE id=?').bind(item.card_charge_id).first<{card_id:string}>();
    requireThat(charge,'Card expense has no source charge',409);
    const lines=item.allocations.map((p:Data)=>({account:p.account_code,amountMinor:p.amount_minor,costCentre:p.cost_centre,description:item.description,merchant:item.merchant}));
    if(item.sales_tax_minor) lines.push({account:item.sales_tax_account,amountMinor:item.sales_tax_minor,costCentre:'',description:'Sales tax',merchant:item.merchant});
    requireThat(lines.reduce((n:number,l:Data)=>n+l.amountMinor,0)===item.amount_minor,'Card accounting lines do not equal the charge',409);
    add('card:'+item.card_charge_id,'CreditCardChargeAdd',{card:charge.card_id,claim:claim.id,revision:claim.revision,date:item.spent_on,lines,total:item.amount_minor,item:item.id,corrections:corrections.filter(c=>c.item_id===item.id).map(c=>c.id)},{sql:"EXISTS(SELECT 1 FROM c_claims WHERE id=? AND version=? AND revision=? AND status IN('approved','batched','reimbursed'))",params:[claim.id,claim.version,claim.revision]});
  }
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
  const line=async (l:Data) => {
    return `<ExpenseLineAdd>${r('AccountRef',await mapped(db,'account:'+l.account))}${t('Amount',decimal(l.amountMinor))}${t('Memo',(l.merchant+' '+l.description).slice(0,4095))}${l.costCentre?r('ClassRef',await mapped(db,'class:'+l.costCentre,'Class')):''}</ExpenseLineAdd>`;
  };
  if(row.kind==='CreditCardChargeAdd' && p.corrections) requireThat(JSON.stringify((await correctionsFor(db,p.claim,p.revision)).filter(c=>c.item_id===p.item).map(c=>c.id))===JSON.stringify(p.corrections),'The card coding changed after it was queued; sync the current coding again',409);
  if(row.kind==='CreditCardChargeAdd') requireThat(await db.prepare("SELECT 1 FROM c_claims WHERE id=? AND revision=? AND status IN('approved','batched','reimbursed')").bind(p.claim,p.revision).first(),'The card claim changed after it was queued; reconcile before posting',409);
  let body='';
  if(row.kind==='BillAdd') requireThat(await db.prepare("SELECT 1 FROM c_batches b WHERE b.id=? AND b.status IN('approved','reimbursed') AND (SELECT COALESCE(SUM(bc.amount_minor),0) FROM c_batch_claims bc JOIN c_claims c ON c.id=bc.claim_id WHERE bc.batch_id=b.id AND c.employee_email=?)=?").bind(p.batch,p.employee,p.total).first(),'The bill batch changed after it was queued; review and sync again',409);
  if(row.kind==='BillAdd') body=`<BillAdd>${r('VendorRef',await mapped(db,'vendor:'+p.employee,'Vendor'))}${r('APAccountRef',await mapped(db,'payable'))}${t('TxnDate',p.date)}${t('RefNumber',row.id.replaceAll('-','').slice(0,20))}${t('Memo','Coaster batch '+p.batch)}${(await Promise.all(p.lines.map(line))).join('')}</BillAdd>`;
  else if(row.kind==='CreditCardChargeAdd') body=`<CreditCardChargeAdd>${r('AccountRef',await mapped(db,'card:'+p.card))}${t('TxnDate',p.date)}${t('RefNumber',row.id.replaceAll('-','').slice(0,11))}${t('Memo','Coaster '+row.source)}${(await Promise.all(p.lines.map(line))).join('')}</CreditCardChargeAdd>`;
  else if(row.kind==='BillPaymentCheckAdd') body=`<BillPaymentCheckAdd>${r('PayeeEntityRef',await mapped(db,'vendor:'+p.employee,'Vendor'))}${r('APAccountRef',await mapped(db,'payable'))}${t('TxnDate',p.date)}${r('BankAccountRef',await mapped(db,'bank'))}${t('IsToBePrinted','false')}${t('RefNumber',String(p.reference).slice(0,11))}<AppliedToTxnAdd>${t('TxnID',p.txn)}${t('PaymentAmount',decimal(p.total))}</AppliedToTxnAdd></BillPaymentCheckAdd>`;
  else if(row.kind==='JournalEntryAdd') body=`<JournalEntryAdd>${t('TxnDate',p.posted_on)}${t('RefNumber',row.id.replaceAll('-','').slice(0,11))}<JournalDebitLine>${r('AccountRef',await mapped(db,'account:'+p.debit_account))}${t('Amount',decimal(p.amount_minor))}${t('Memo',p.memo)}</JournalDebitLine><JournalCreditLine>${r('AccountRef',await mapped(db,'account:'+p.credit_account))}${t('Amount',decimal(p.amount_minor))}${t('Memo',p.memo)}</JournalCreditLine></JournalEntryAdd>`;
  else requireThat(false,'Unknown Desktop posting kind',409);
  return `<${rq} requestID="${row.id}">${body}</${rq}>`;
}
