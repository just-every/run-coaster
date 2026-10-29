// Preserved native HTTP assertion phases; callers own test registration.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { agency, harness } from '../harness.mjs'
const SAM = 'sam@harbourfinch.example', ALEX = 'alex@harbourfinch.example', ISSUER = 'Synthetic Card'
async function withAgency(run) { const h = await harness(); try { await run(h, await agency(h)) } finally { await h.close() } }
const NOTICE = "When this receipt matches one of your card charges, Coaster attaches it automatically. Approvers and finance can see the receipt, its file name and the total, currency and date you entered once that expense is submitted — by you, your delegate or the owner's scheduled submission."
const inbox = async(h,t,id) => (await h.get('receipt-inbox',t.sam)).receipts.find(r=>r.id===id)
async function original(h,cookie,name='private-card.png',headers={},bytes) {
  const form=new FormData();form.append('file',new Blob([bytes??await readFile('tests/fixtures/receipts/bistro.png')]),name);form.append('source','upload')
  const req=new Request(h.origin+'/api/coaster/receipt-inbox',{method:'POST',headers:{origin:h.origin,cookie,...headers},body:form})
  const r=await h.mf.dispatchFetch(req.url,{method:'POST',headers:Object.fromEntries(req.headers),body:await req.arrayBuffer()})
  assert.equal(r.status,200);return (await r.json()).receipt
}
async function choose(h,t,r,over={}) {return h.post(`receipt-inbox/${r.id}/card-match`,{expectedSequence:r.lifecycleSequence,enabled:true,merchant:'Different typed private merchant',date:'2026-10-02',total:'48.20',currency:'AUD',notice:NOTICE,...over},t.sam)}
const tick = async (h,scheduledTime=Date.now()) => (await h.mf.getWorker()).scheduled({scheduledTime,cron:'17 * * * *'})
async function statement(h,t,rows,{last4='1111',employee=SAM,name='matching.csv'}={}) {
  await h.post('statements/cards',{issuer:ISSUER,last4,employee})
  const base={format:'csv',name,issuer:ISSUER,category:t.c.office,content:'Posted,Transaction,Merchant,Amount,Id,Status\n'+rows.map((r,i)=>`${r.date??'2026-10-03'},${r.transaction??'2026-10-02'},${r.merchant??'Harbour View Bistro'},${r.amount??'48.20'},${r.id??name+'-'+i},${r.status??'posted'}`).join('\n'),mapping:{dateFormat:'YYYY-MM-DD',sign:'purchases-positive',postedDate:'Posted',transactionDate:'Transaction',description:'Merchant',amount:'Amount',transactionId:'Id',status:'Status',wholeFileLast4:last4}}
  const preview=await h.post('statements/preview',base,t.morgan)
  assert.deepEqual(preview.errors,[])
  return preview.importable ? h.post('statements/commit',{...base,fingerprint:preview.fingerprint},t.morgan) : preview
}

// Original assertion phase: ADMIN-001 deactivating an approver or a cardholder hands approvals, reports and unsubmitted card charges to a named successor; an attached private original is detached and stays with the departed person
export const successorHandoff = () => withAgency(async (h, t) => {
  const PRIYA = 'priya@harbourfinch.example', JORDAN = 'jordan@harbourfinch.example', MORGAN = 'morgan@harbourfinch.example'
  const png = text => ({ name: `${text}.png`, source: 'upload', base64: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(text)]).toString('base64') })
  const filed = async (cookie, title) => {
    const c = await h.post('claims', { title }, cookie), up = await h.post(`claims/${c.id}/receipts`, { version: c.version, ...png(title) }, cookie)
    const item = await h.post(`claims/${c.id}/items`, { version: up.claim.version, kind: 'receipt', date: '2026-06-10', merchant: title, amount: '20.00', receipt: up.receipt, allocations: [{ category: t.c.office }], explanation: 'Client work' }, cookie)
    return h.post(`claims/${c.id}/submit`, { version: item.version }, cookie)
  }
  const member = (email, over = {}) => h.post('settings/members', { email, name: email.split('@')[0], employee: true, ...over })
  // Approver: Alex's claim waits on Priya. Deactivation needs a named successor who can take the work.
  const waiting = await filed(t.alex, 'Waiting on Priya')
  assert.equal(waiting.approver_email, PRIYA)
  const priya = { manager: true }
  await member(PRIYA, { ...priya, active: false }, ) .then(() => assert.fail('no successor'), e => assert.match(e.message, /successor[\s\S]*409/))
  await member(PRIYA, { ...priya, active: false, successor: MORGAN }).then(() => assert.fail('finance only'), e => assert.match(e.message, /approver[\s\S]*409/))
  assert.equal((await h.get(`claims/${waiting.id}`, t.priya)).claim.approver_email, PRIYA, 'refused deactivation moved nothing')
  await member(PRIYA, { ...priya, active: false, successor: JORDAN })
  await h.get('state', t.priya, 403)
  const moved = await h.get(`claims/${waiting.id}`, t.jordan)
  assert.equal(moved.claim.approver_email, JORDAN); assert.ok(moved.events.some(e => e.action === 'workflow-review-reassigned' || e.action === 'claim-reassigned'))
  assert.equal((await h.get('state')).members.find(m => m.email === ALEX).approver_email, JORDAN, 'her reports follow the successor')
  await h.post(`claims/${waiting.id}/decision`, { revision: waiting.revision, version: moved.claim.version, decision: 'approved', acknowledge: true }, t.jordan)
  // Cardholder: Sam's posted charge carries an opted-in original attached automatically.
  const r = await original(h, t.sam)
  await choose(h, t, r)
  const job = await statement(h, t, [{}])
  await tick(h)
  assert.ok((await inbox(h, t, r.id)).attachment, 'attached automatically')
  const charge = (await h.get('statements')).charges[0]
  await member(SAM, { approver: undefined, active: false }).then(() => assert.fail('no successor'), e => assert.match(e.message, /successor[\s\S]*409/))
  assert.equal((await h.get(`claims/${job.claims[0]}`, t.sam)).claim.employee_email, SAM)
  await member(SAM, { approver: undefined, active: false, successor: ALEX })
  await h.get('state', t.sam, 403)
  // The charge reached Alex's own statement report without the receipt; the original is still the departed person's, detached on their lifecycle.
  const handed = (await h.get('statements')).charges.find(c => c.id === charge.id)
  assert.equal(handed.employee_email, ALEX); assert.notEqual(handed.claim_id, job.claims[0])
  const alexReport = await h.get(`claims/${handed.claim_id}`, t.alex)
  assert.equal(alexReport.claim.employee_email, ALEX); assert.equal(alexReport.items.length, 1); assert.equal(alexReport.items[0].receipt_id, null); assert.equal(alexReport.items[0].card_charge_id, charge.id)
  assert.equal((await h.get('receipt-inbox', t.alex)).receipts.some(x => x.id === r.id), false, 'the successor never sees the original')
  const lines = (await h.db.prepare('SELECT kind,actor_email,channel FROM c_capture_lifecycle WHERE receipt_id=? ORDER BY sequence').bind(r.id).all()).results
  assert.deepEqual(lines.slice(-2).map(l => l.kind), ['detached', 'match-withdrawn']); assert.equal((await h.db.prepare('SELECT owner_email FROM c_capture_receipts WHERE id=?').bind(r.id).first()).owner_email, SAM)
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_card_handoffs').first()).n, 1)
  const history = JSON.stringify((await h.get('history?q=card-charge-handed-off')).lines)
  assert.ok(history.includes('card-charge-handed-off') && !history.includes(r.id) && !history.includes(r.name) && !history.includes(r.sha256), 'the history line names no original')
  await assert.rejects(h.db.prepare('UPDATE c_card_charges SET amount_minor=1').run(), /immutable/)
  await assert.rejects(h.db.prepare("UPDATE c_card_charges SET employee_email='x@y.example'").run(), /immutable/)
})

export async function preserveSuccessorHandoff() {
  await successorHandoff()
}
