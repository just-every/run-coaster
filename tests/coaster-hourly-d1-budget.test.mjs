import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agency, harness } from './harness.mjs'

// The hourly Cron Trigger must cost the same rows on the thousandth claim as on the hundredth: Workers Free allows five
// million D1 rows read a day for the whole account. Every claim is a paid one in a batch of twelve with a card expense that
// has its receipt; only three drafts are open.
const NOW = '2026-11-25T01:17:00Z' // Wednesday 12:17 in Sydney: business day, outside quiet hours
const CEILING = 3000

async function history(db, from, to) {
  const run = (sql, ...values) => db.prepare(sql).bind(...values).run()
  if (from === 1) {
    await run("INSERT INTO c_cards(id,issuer,last4,employee_email,assigned_by,assigned_at) VALUES('card1','Visa','1111','sam@harbourfinch.example','x','2026-01-01')")
    await run("INSERT INTO c_statement_files(id,name,format,issuer,fingerprint,sha256,size,bytes,mapping,excluded_cards,included_rows,charges,total_minor,imported_by,imported_at) VALUES('f1','s.csv','csv','Visa','fp','s',1,x'','{\"coding\":{}}','[]','[]',1,1,'x','2026-01-01')")
    await run("INSERT INTO c_budgets(id,version,name,scope,per_member,period,amount_minor,owner_email,thresholds,policy_rule,set_by,set_at) VALUES('bud1',1,'Everything','entity',0,'monthly',100000000,'priya@harbourfinch.example','[80,100]',0,'x','2026-01-01')")
  }
  const rows = (n, columns, source) => `WITH RECURSIVE n(i) AS (SELECT ${from} UNION ALL SELECT i+1 FROM n WHERE i<${to}) INSERT INTO ${n}(${columns}) SELECT ${source} FROM n`
  const day = "date('2026-11-25','-'||(i*1000/" + to + ")||' days')"
  await run(rows('c_batches', 'id,number,status,currency,created_by,created_at', "'b'||i,i,'reimbursed','AUD','morgan@harbourfinch.example',"+day))
  await run(rows('c_claims', 'id,number,employee_email,title,status,currency,batch_id,created_at,updated_at,approver_email', `'c'||i,i,'sam@harbourfinch.example','Claim '||i,'reimbursed','AUD','b'||(1+i/12),${day}||'T00:00:00Z',${day}||'T00:00:00Z','priya@harbourfinch.example'`))
  await run(rows('c_receipts', 'id,claim_id,owner_email,name,media_type,size,sha256,bytes,source,uploaded_by,uploaded_at', `'rc'||i,'c'||i,'sam@harbourfinch.example','r.png','image/png',10,printf('%064d',i),zeroblob(10),'upload','sam@harbourfinch.example',${day}`))
  await run(rows('c_card_charges', 'id,file_id,card_id,employee_email,transaction_key,posted_on,descriptor,amount_minor,currency,item_id,category_id,created_at,claim_id', `'ch'||i,'f1','card1','sam@harbourfinch.example','tk'||i,${day},'Cafe',1500,'AUD','it'||i||'-c',(SELECT id FROM c_categories LIMIT 1),${day},'c'||i`))
  await run(rows('c_items', 'id,claim_id,position,kind,spent_on,merchant,description,amount_minor,card_charge_id,receipt_id', `'it'||i||'-c','c'||i,2,'receipt',${day},'Cafe','Lunch',1500,'ch'||i,'rc'||i`))
  for (const p of [0, 1]) await run(rows('c_items', 'id,claim_id,position,kind,spent_on,merchant,description,amount_minor', `'it'||i||'-${p}','c'||i,${p},'receipt',${day},'Cafe','Lunch',1500`))
}

test('the hourly run reads a flat number of D1 rows however many paid claims the business keeps', async () => {
  const h = await harness()
  try {
    await agency(h)
    const worker = await h.mf.getWorker()
    const tick = async () => {
      await worker.scheduled({ scheduledTime: new Date(NOW).getTime(), cron: '17 * * * *' })
      const reads = await (await h.mf.dispatchFetch(`${h.origin}/__test/d1-meter`)).json()
      assert.equal(reads.unmetered, 0, 'every statement reports its rows read')
      return reads.rows
    }
    await history(h.db, 1, 100)
    await tick() // the first run notes what is open
    const small = await tick()
    await history(h.db, 101, 800)
    const large = await tick()
    assert.ok(small < CEILING && large < CEILING, `an hourly run read ${small} rows with 100 claims and ${large} with 800`)
    assert.ok(large < small + 500, `eight times the history added ${large - small} rows to the hourly run`)
  } finally { await h.close() }
})
