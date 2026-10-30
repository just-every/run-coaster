import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness } from './harness.mjs'
import { issuerServer } from './fixtures/feed/server.mjs'

const n=value=>`synthetic-coaster-${value}`
const address=value=>n(value)+'@'+'example.test'
const endpoint=['feeds','program'].join('/')
const reportPath=['reports','feed-coverage'].join('/')+'?from=2031-06-29&to=2031-06-30'
const mapped={dateFormat:'YYYY-MM-DD',sign:'purchases-positive',postedDate:'Date',description:'Merchant',amount:'Amount',card:'Card',transactionId:'Transaction',sequence:'Sequence',periodStart:'Period start',periodEnd:'Period end'}
const file=(seq,date,ref,{amount=String(Number(ref.match(/\d+$/)?.[0]??1)%100+1)+'.17',end=date}={})=>'Date,Merchant,Amount,Card,Transaction,Sequence,Period start,Period end\n'+['2031-06-29',n(2000),amount,'1111',ref,seq,date,end].join(',')+'\n'

test('Mapped SFTP delivery health and authorized coverage reports preserve source dates, deadlines, replay and revocation',async()=>{
  const issuer=await issuerServer();let h
  try {
    h=await harness({clock:Date.parse('2031-06-30T23:59:00Z'),bindings:origin=>({RER_DEV_ORIGIN:origin})})
    await h.post('settings/business',{name:n(2001),currency:'USD',timezone:'UTC',receiptThreshold:'10000'})
    const category=await h.post('settings/categories',{name:n(2002),accountCode:n(2003),taxCode:n(2003)})
    const finance=await h.person(address(2004),{finance:true}),employee=await h.person(address(2005),{employee:true})
    const auditor=await h.person(address(2006),{auditor:true}),admin=await h.person(address(2007),{admin:true}),bookkeeper=await h.person(address(2008),{bookkeeper:true})
    await h.post('statements/cards',{issuer:n(2009),last4:'1111',employee:address(2005)})
    const config={...issuer.credentials,issuer:n(2009),category:category.id,intervalMinutes:60,consent:true,mapping:mapped,deliveryTime:'09:00',deliveryTimezone:'America/New_York',graceMinutes:60,expectedFrom:'2031-06-29'}
    const start=await h.get(endpoint)
    for(const bad of [{deliveryTime:'24:00'},{deliveryTimezone:'synthetic-coaster-2010'},{graceMinutes:-1},{mapping:{...mapped,periodStart:'Date'}},{mapping:{...mapped,periodStart:'Sequence'}},{mapping:{...mapped,periodEnd:undefined}}]) await h.post(endpoint,{...config,...bad},finance,400)
    await h.post(endpoint,config,employee,403)
    assert.deepEqual(await h.get(endpoint),start,'refused configuration changes nothing')
    const connected=await h.post(endpoint,config,finance),worker=await h.mf.getWorker()
    const tick=iso=>worker.scheduled({scheduledTime:new Date(iso),cron:'17 * * * *'})
    const health=async id=>(await h.get(endpoint,finance)).feeds.find(f=>f.id===(id??connected.id)).health
    const changes=()=>h.db.prepare('SELECT * FROM c_program_health ORDER BY seq').all().then(r=>r.results)
    const report=()=>h.get(reportPath,finance)
    await tick('2031-06-29T13:17:00Z')
    assert.deepEqual(await changes(),[],'delivery is not missed before its grace deadline')
    let state=await health()
    assert.equal(state.lastPollAt,'2031-06-29T13:17:00.000Z');assert.equal(state.lastFile,null,'empty directory is a poll, never an accepted file')
    await tick('2031-06-29T14:17:00Z')
    assert.deepEqual((await changes()).map(r=>[r.delivery_date,r.kind]),[['2031-06-29','missed']])
    let result=await report()
    assert.deepEqual(result.rows.map(r=>[r[2],r[3]]),[['2031-06-29','uncovered'],['2031-06-30','uncovered']])
    assert.equal(result.totals.covered,0,'successful empty polls never imply coverage or zero spend')
    issuer.files.set(n(2011)+'.csv',file(n(2012),'2031-06-30',n(2013)))
    await tick('2031-06-30T11:17:00Z')
    result=await report();assert.deepEqual(result.rows.map(r=>r[3]),['uncovered','covered'],'a different valid period closes only its own date, even with a transaction dated in the gap')
    issuer.files.set(n(2014)+'.csv',file(n(2015),'2031-06-29',n(2016),{amount:'invalid'}))
    await tick('2031-06-30T12:17:00Z')
    assert.match((await h.get(endpoint)).feeds[0].error,/invalid rows/)
    assert.equal((await health()).lastPollAt,'2031-06-30T12:17:00.000Z','a successful directory poll remains distinct when its file is invalid')
    assert.equal((await report()).rows[0][3],'uncovered','invalid file cannot close the gap')
    issuer.files.delete(n(2014)+'.csv')
    issuer.files.set(n(2017)+'.csv',file(n(2018),'2031-06-29',n(2019),{end:'2031-06-30'}))
    issuer.files.set(n(2040)+'.csv',file(n(2041),'2031-07-01',n(2042)))
    issuer.files.set(n(2043)+'.csv',file(n(2044),'2031-02-30',n(2045)))
    await tick('2031-06-30T13:17:00Z')
    assert.equal((await report()).rows[0][3],'uncovered','ambiguous period evidence stays unverified')
    for(const seq of [n(2018),n(2041),n(2044)]) assert.equal((await h.get(endpoint)).deliveries.find(d=>d.issuer_sequence===seq).coverage_date,null,'ambiguous, future and invalid source dates stay unverified')
    const upload={name:n(2020)+'.csv',format:'csv',issuer:n(2009),category:category.id,mapping:mapped,content:file(n(2021),'2031-06-29',n(2022))}
    const preview=await h.post('statements/preview',upload)
    await h.post('statements/commit',{...upload,fingerprint:preview.fingerprint})
    assert.equal((await report()).rows[0][3],'uncovered','statement uploads cannot assert program coverage')
    issuer.files.set(n(2023)+'.csv',file('2031-06-29','',n(2024)))
    await tick('2031-06-30T14:17:00Z')
    assert.equal((await report()).rows[0][3],'uncovered','a date-shaped issuer sequence is not source-period evidence')
    issuer.files.set(n(2025)+'.csv',file(n(2026),'2031-06-29',n(2027)))
    await tick('2031-06-30T15:17:00Z')
    result=await report();assert.deepEqual(result.rows.map(r=>r[3]),['covered','covered'])
    state=await health();assert.deepEqual(state.missedDates,[]);assert.equal(state.lastFile.name,n(2025)+'.csv')
    assert.deepEqual(state.nextExpected,{date:'2031-07-01',at:'2031-07-01T13:00:00.000Z',deadline:'2031-07-01T14:00:00.000Z'})
    const csv=await h.get(reportPath+'&format=csv',auditor)
    assert.match(csv,/"2031-06-29","covered"/);assert.match(csv,new RegExp(n(2025)));assert.match(csv,/Total/)
    await h.get(reportPath,employee,403)
    for(const who of [admin,bookkeeper]) assert.equal((await h.get(reportPath,who)).totals.covered,2,'existing export permission remains available')
    const schedule={report:'feed-coverage',cadence:'last-business-day',recipients:[address(2004)],includeFigures:true}
    for(const who of [employee,auditor,finance])await h.post('report-schedules',schedule,who,403)
    await h.post('report-schedules',schedule)
    const counts=async()=>h.db.prepare("SELECT (SELECT COUNT(*) FROM c_card_charges) AS charges,(SELECT COUNT(*) FROM c_program_deliveries) AS deliveries,(SELECT COUNT(*) FROM c_program_health) AS health,(SELECT COUNT(*) FROM c_events WHERE action LIKE 'program-feed-%') AS history,(SELECT COUNT(*) FROM c_report_deliveries) AS reports").first()
    await tick('2031-06-30T16:17:00Z')
    const before=await counts(),sent=h.messages.filter(m=>m.subject?.startsWith('Feed coverage:'))
    assert.equal(sent.length,1);assert.equal(sent[0].attachments.length,1)
    assert.match(Buffer.from(sent[0].attachments[0].content,'base64').toString(),/"2031-06-29","covered"/)
    issuer.files.set(n(2028)+'.csv',file(n(2026),'2031-06-29',n(2027)))
    await tick('2031-06-30T17:17:00Z');await tick('2031-06-30T17:17:00Z')
    await Promise.all([tick('2031-06-30T18:17:00Z'),tick('2031-06-30T18:17:00Z')])
    assert.deepEqual(await counts(),before,'concurrent tick, renamed delivery and tick replay duplicate no charges, health, history or report delivery')
    const snapshot=await changes()
    for(const method of ['PUT','DELETE']) {
      const response=await h.mf.dispatchFetch(h.origin+'/api/coaster/'+endpoint+'/'+connected.id+'/health',{method,headers:{origin:h.origin,cookie:finance}})
      assert.equal(response.status,404,'no public route edits or deletes health history')
    }
    assert.deepEqual(await changes(),snapshot)
    for(const table of ['c_program_health','c_events']) {
      await assert.rejects(h.db.prepare(`UPDATE ${table} SET at='2031-01-01'`).run(),/permanent|immutable/)
      await assert.rejects(h.db.prepare(`DELETE FROM ${table}`).run(),/permanent|immutable/)
    }
    const history=(await h.get('history',finance)).lines.filter(l=>l.action.startsWith('program-feed-date-'))
    assert.deepEqual(history.map(l=>l.action),['program-feed-date-missed','program-feed-date-covered','program-feed-date-covered'])
    assert.ok(history.every((l,i)=>l.channel==='schedule' && l.actor_email==='automation: program feed' && (!i||l.seq>history[i-1].seq)))
    await h.post(`${endpoint}/${connected.id}/disconnect`,{version:connected.version,consent:true},finance)
    const requests=issuer.requests.length
    await tick('2031-07-01T17:17:00Z');assert.equal(issuer.requests.length,requests,'disconnected feed opens no transport')
    const newFeed=await h.post(endpoint,{...config,expectedFrom:'2031-06-30'},finance)
    issuer.files.clear();issuer.files.set(n(2029)+'.csv',file(n(2030),'2031-06-30',n(2031)))
    let arrived,resume;const paused=new Promise(r=>{arrived=r}),released=new Promise(r=>{resume=r})
    issuer.control.beforeRead=async()=>{arrived();await released}
    const running=tick('2031-07-01T18:17:00Z');await paused
    const atPause=await counts()
    await h.post(`${endpoint}/${newFeed.id}/disconnect`,{version:newFeed.version,consent:true},finance)
    resume();await running;issuer.control.beforeRead=null
    const after=await counts();assert.equal(after.charges,atPause.charges);assert.equal(after.deliveries,atPause.deliveries);assert.equal(after.health,atPause.health,'in-flight revocation prevents coverage as well as charges')
    for(const [from,time,grace,early,late,expected] of [
      ['2031-03-09','02:30',30,'2031-03-09T07:17:00Z','2031-03-09T08:17:00Z','2031-03-09T08:00:00.000Z'],
      ['2031-11-02','01:30',30,'2031-11-02T06:17:00Z','2031-11-02T07:17:00Z','2031-11-02T07:00:00.000Z'],
    ]) {
      issuer.files.clear()
      const f=await h.post(endpoint,{...config,expectedFrom:from,deliveryTime:time,graceMinutes:grace},finance)
      await tick(early)
      assert.equal((await changes()).filter(r=>r.feed_id===f.id).length,0,'no premature miss across daylight-saving transition')
      await tick(late)
      const row=(await changes()).find(r=>r.feed_id===f.id);assert.equal(row.delivery_date,from)
      const evidence=(await h.get('history',finance)).lines.find(l=>l.action==='program-feed-date-missed'&&l.detail.feed===f.id)
      assert.equal(evidence.detail.deadline,expected,'gap and repeated-hour deadlines use the configured local calendar')
      await h.post(`${endpoint}/${f.id}/disconnect`,{version:f.version,consent:true},finance)
    }
    console.log('PROBE FEED-003 calendar: real scheduled SFTP before grace -> no miss; after grace -> dated immutable miss')
    console.log('PROBE FEED-003 evidence: wrong date, ambiguous period, invalid file, upload and empty poll -> gap retained; late evidenced file -> only its date covered')
    console.log('PROBE FEED-003 reports: authorized JSON, CSV and scheduled attachment -> exact dates; replay -> one delivery')
    console.log('PROBE FEED-003 authority: forbidden roles and in-flight disconnect -> no charge or coverage commit; DST gap and fold -> expected deadlines')
  } finally {await h?.close();await issuer.close()}
})
