import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness } from './harness.mjs'
import { issuerServer } from './fixtures/feed/server.mjs'

const n=value=>`synthetic-coaster-${value}`
const address=value=>n(value)+'@'+'example.test'
const feeds=['feeds','program'].join('/'),repairs=['feeds','repairs'].join('/'),tasksPath=['feeds','repair-tasks'].join('/')
const mapped={dateFormat:'YYYY-MM-DD',sign:'purchases-positive',postedDate:'Date',description:'Merchant',amount:'Amount',card:'Card',transactionId:'Transaction',sequence:'Sequence',periodStart:'Period start',periodEnd:'Period end'}
const file=(seq,date,ref,{posted='2031-06-29',end=date}={})=>'Date,Merchant,Amount,Card,Transaction,Sequence,Period start,Period end\n'+[posted,n(3000),String(Number(ref.match(/\d+$/)[0])%100+1)+'.17','1111',ref,seq,date,end].join(',')+'\n'
const clock=Date.parse('2031-06-30T23:59:00Z'),financeAddress=address(3004)

/** Provider custody, schedule, deliveries, health, charges, payments, ledger and membership: repair doors change none of them. */
const records=h=>h.db.prepare(`SELECT json_array(
 (SELECT json_group_array(json_array(id,issuer,credentials_sealed,mapping,interval_minutes,enabled,version,next_run_at,last_success_at,last_error,disconnected_at,lease_id,lease_until)) FROM (SELECT * FROM c_program_feeds ORDER BY id)),
 (SELECT json_group_array(json_array(id,feed_id,name,issuer_sequence,sha256,file_id,charges,coverage_date)) FROM (SELECT * FROM c_program_deliveries ORDER BY id)),
 (SELECT json_group_array(json_array(seq,feed_id,delivery_date,kind,delivery_id)) FROM c_program_health),
 (SELECT json_group_array(json_array(email,active,is_finance,is_admin)) FROM (SELECT * FROM c_members ORDER BY email)),
 (SELECT COUNT(*) FROM c_card_charges),(SELECT COUNT(*) FROM c_statement_files),(SELECT COUNT(*) FROM c_claims),(SELECT COUNT(*) FROM c_items),
 (SELECT COUNT(*) FROM c_batches),(SELECT COUNT(*) FROM c_card_ledger),(SELECT COUNT(*) FROM c_reimbursement_keys)) AS v`).first().then(r=>r.v)
const repairRows=h=>h.db.prepare(`SELECT json_array((SELECT json_group_array(json_array(id,status,decided_by)) FROM (SELECT * FROM c_feed_repair_proposals ORDER BY id)),
 (SELECT json_group_array(json_array(seq,id,delivery_date,assignee)) FROM c_feed_repair_tasks),(SELECT json_group_array(json_array(seq,task_id,delivery_id)) FROM c_feed_repair_resolutions),
 (SELECT COUNT(*) FROM c_events WHERE action LIKE 'feed-repair-%')) AS v`).first().then(r=>r.v)

async function installation(h,issuer) {
  await h.post('settings/business',{name:n(3001),currency:'USD',timezone:'UTC',receiptThreshold:'10000'})
  const category=await h.post('settings/categories',{name:n(3002),accountCode:n(3003),taxCode:n(3003)})
  const people={finance:await h.person(financeAddress,{finance:true}),employee:await h.person(address(3005),{employee:true}),admin:await h.person(address(3006),{admin:true}),auditor:await h.person(address(3007),{auditor:true}),bookkeeper:await h.person(address(3008),{bookkeeper:true}),cardAdmin:await h.person(address(3009),{cardAdmin:true})}
  await h.post('statements/cards',{issuer:n(3010),last4:'1111',employee:address(3005)})
  const config={...issuer.credentials,issuer:n(3010),category:category.id,intervalMinutes:60,consent:true,mapping:mapped,deliveryTime:'09:00',deliveryTimezone:'America/New_York',graceMinutes:60,expectedFrom:'2031-06-29'}
  const connected=await h.post(feeds,config,people.finance),worker=await h.mf.getWorker()
  const tick=iso=>worker.scheduled({scheduledTime:new Date(iso),cron:'17 * * * *'})
  /** Run a repair door and prove it touched no provider connection, schedule, charge, payment or ledger record. */
  const inert=async action=>{const before=[await records(h),issuer.requests.length];const result=await action();assert.deepEqual([await records(h),issuer.requests.length],before,'repair doors change no provider, schedule or financial record and open no transport');return result}
  return {...people,category,config,feed:connected,tick,inert,
    prepare:(who=people.finance,status=200)=>h.post(`${feeds}/${connected.id}/repairs`,{},who,status),
    confirm:(id,who=people.finance,status=200,body={consent:true})=>h.post(`${repairs}/${id}/confirm`,body,who,status),
    resolve:(id,who=people.finance,status=200)=>h.post(`${tasksPath}/${id}/resolve`,{},who,status)}
}

test('Missed mapped SFTP deliveries become cited repair proposals and person-confirmed tasks once, resolving only on validated coverage of the exact date',async()=>{
  const issuer=await issuerServer();let h
  try {
    h=await harness({clock,bindings:origin=>({RER_DEV_ORIGIN:origin})})
    const s=await installation(h,issuer),feed=s.feed.id
    const history=async()=>(await h.get('history',s.finance)).lines.filter(l=>l.action.startsWith('feed-repair-'))
    await s.tick('2031-06-29T13:17:00Z')
    let result=await s.inert(()=>s.prepare())
    assert.equal(result.proposal,null,'no task is proposed before the scheduled health check records a miss')
    assert.deepEqual(result.analysis.findings,[]);assert.deepEqual(result.analysis.awaiting.map(d=>d.date),['2031-06-29','2031-06-30'])
    assert.equal(result.analysis.spend,'unknown','uncovered dates are never zero spend')

    issuer.control.rejectAuthentication=true
    await s.tick('2031-06-29T14:17:00Z')
    issuer.control.rejectAuthentication=false
    const failure=(await h.get('history',s.finance)).lines.findLast(l=>l.action==='program-feed-sync-failed')
    const recorded=(await s.inert(()=>s.prepare())).proposal
    assert.equal(recorded.evidence.cause,'recorded-failure','a recorded connection failure is reported as recorded, with its numbered history line')
    assert.deepEqual(recorded.evidence.failure,{seq:failure.seq,at:failure.at,reason:failure.detail.reason})
    assert.equal(recorded.evidence.error,failure.detail.reason)
    assert.deepEqual(recorded.evidence.action,{label:'Review connection settings',href:'/app#/settings',automatic:false},'connection settings stay a human action')
    await s.tick('2031-06-29T15:17:00Z')
    await s.confirm(recorded.id,s.finance,409)
    assert.equal((await h.get(repairs,s.finance)).tasks.length,0,'a proposal whose connection evidence changed opens nothing')

    const miss=await h.db.prepare("SELECT seq,at FROM c_program_health WHERE kind='missed' AND delivery_date='2031-06-29'").first()
    const proposal=(await s.inert(()=>s.prepare())).proposal
    assert.equal((await h.get(repairs,s.finance)).proposals.find(p=>p.id===recorded.id).status,'superseded')
    assert.equal(proposal.evidence.cause,'missing-delivery','a successful poll with no file is a missing delivery, not a failed sign-in')
    assert.equal(proposal.evidence.error,null);assert.equal(proposal.evidence.lastPollAt,'2031-06-29T15:17:00.000Z')
    assert.deepEqual(proposal.evidence.findings,[{date:'2031-06-29',deadline:'2031-06-29T14:00:00.000Z',health:{seq:miss.seq,at:miss.at},report:'/api/coaster/reports/feed-coverage?from=2031-06-29&to=2031-06-29'}])
    assert.deepEqual(proposal.evidence.awaiting.map(d=>d.date),['2031-06-30'])
    assert.deepEqual([proposal.agent,proposal.forEmail,proposal.status],['Feed repair agent',financeAddress,'proposed'])
    const report=await h.get(proposal.evidence.findings[0].report.replace('/api/coaster/',''),s.finance)
    assert.deepEqual(report.rows.filter(r=>r[1]===feed).map(r=>[r[2],r[3],r[5]]),[['2031-06-29','uncovered','2031-06-29T14:00:00.000Z']],'the cited coverage report shows the same uncovered date and deadline')
    const lines=await history()
    assert.equal((await s.prepare()).proposal.id,proposal.id,'repeated analysis returns the same pending proposal')
    assert.deepEqual(await history(),lines,'repeated analysis writes no history')

    for(const who of [s.employee,s.auditor,s.bookkeeper,s.cardAdmin]) {
      await s.prepare(who,403);await h.get(repairs,who,403);await s.confirm(proposal.id,who,403);await h.post(`${repairs}/${proposal.id}/decline`,{},who,403)
    }
    const adminProposal=(await s.prepare(s.admin)).proposal
    assert.notEqual(adminProposal.id,proposal.id)
    await s.confirm(proposal.id,s.admin,403)
    await s.confirm(proposal.id,s.finance,400,{})
    const opened=await s.inert(()=>s.confirm(proposal.id))
    const [task]=opened.tasks
    assert.equal(opened.proposal.status,'accepted');assert.equal(opened.tasks.length,1)
    assert.deepEqual({date:task.date,deadline:task.deadline,health:task.health,cause:task.cause,assignee:task.assignee,agent:task.agent,proposal:task.proposal,status:task.status},
      {date:'2031-06-29',deadline:'2031-06-29T14:00:00.000Z',health:miss.seq,cause:'missing-delivery',assignee:financeAddress,agent:'Feed repair agent',proposal:proposal.id,status:'open'})
    await s.confirm(proposal.id,s.finance,409)
    await s.confirm(adminProposal.id,s.admin,409)
    assert.equal((await h.post(`${repairs}/${adminProposal.id}/decline`,{},s.admin)).proposal.status,'declined')
    for(const who of [s.finance,s.admin]) {
      result=await s.prepare(who)
      assert.equal(result.proposal,null);assert.deepEqual(result.analysis.tracked,[{date:'2031-06-29',task:task.id,seq:task.seq}],'a tracked date is never proposed again')
    }
    assert.equal((await h.get(repairs,s.admin)).tasks.length,1,'one task per feed and date')

    await s.resolve(task.id,s.finance,409)
    await s.tick('2031-06-30T14:17:00Z')
    await s.resolve(task.id,s.finance,409)
    const late=(await s.prepare()).proposal
    assert.deepEqual(late.evidence.findings.map(x=>x.date),['2031-06-30'])
    issuer.files.set(n(3020)+'.csv',file(n(3021),'2031-06-30',n(3022)))
    await s.tick('2031-06-30T15:17:00Z')
    await s.confirm(late.id,s.finance,409)
    assert.equal((await h.get(repairs,s.finance)).tasks.length,1,'a late delivery invalidates the stale proposal')
    await s.resolve(task.id,s.finance,409)
    result=await s.prepare()
    assert.equal(result.proposal,null);assert.equal((await h.get(repairs,s.finance)).proposals.find(p=>p.id===late.id).status,'superseded')
    issuer.files.set(n(3023)+'.csv',file(n(3024),'2031-06-29',n(3025),{end:'2031-06-30'}))
    issuer.files.set(n(3026)+'.csv',file('2031-06-29','',n(3027)))
    await s.tick('2031-06-30T16:17:00Z')
    await s.resolve(task.id,s.finance,409)
    const upload={name:n(3028)+'.csv',format:'csv',issuer:n(3010),category:s.category.id,mapping:mapped,content:file(n(3029),'2031-06-29',n(3030))}
    await h.post('statements/commit',{...upload,fingerprint:(await h.post('statements/preview',upload)).fingerprint})
    await s.resolve(task.id,s.finance,409)
    assert.equal((await h.get(repairs,s.finance)).tasks[0].status,'open','another date, a transaction date, an ambiguous period, a sequence, an empty poll and an upload resolve nothing')

    issuer.files.set(n(3031)+'.csv',file(n(3032),'2031-06-29',n(3033)))
    await s.tick('2031-06-30T17:17:00Z')
    await s.resolve(task.id,s.admin,403)
    const covered=await h.db.prepare("SELECT h.seq,h.delivery_id FROM c_program_health h WHERE h.kind='covered' AND h.delivery_date='2031-06-29'").first()
    const resolved=(await s.inert(()=>s.resolve(task.id))).task
    assert.equal(resolved.status,'resolved')
    assert.deepEqual({health:resolved.resolution.health,delivery:resolved.resolution.delivery,file:resolved.resolution.file,sequence:resolved.resolution.sequence,by:resolved.resolution.by},
      {health:covered.seq,delivery:covered.delivery_id,file:n(3031)+'.csv',sequence:n(3032),by:financeAddress})
    await s.resolve(task.id,s.finance,409)

    const actions=await history()
    assert.deepEqual(actions.map(l=>[l.action,l.actor_email]),[
      ['feed-repair-proposed',financeAddress],['feed-repair-proposed',financeAddress],['feed-repair-proposed',address(3006)],['feed-repair-task-opened',financeAddress],
      ['feed-repair-proposal-declined',address(3006)],['feed-repair-proposed',financeAddress],['feed-repair-proposal-superseded',financeAddress],['feed-repair-task-resolved',financeAddress]])
    assert.deepEqual(actions.map(l=>l.channel),['agent','agent','agent','app','app','agent','agent','app'],'the agent prepares; people confirm, decline and resolve')
    assert.ok(actions.every((l,i)=>(l.channel==='agent'?l.detail.agent:l.detail.preparedBy)==='Feed repair agent'&&(!i||l.seq>actions[i-1].seq)),'numbered, attributed history names the agent')
    assert.deepEqual([actions[3].detail.task,actions[3].detail.health,actions[7].detail.delivery],[task.id,miss.seq,covered.delivery_id])
    for(const [table,column] of [['c_feed_repair_tasks','assignee'],['c_feed_repair_resolutions','resolved_by'],['c_feed_repair_proposals','evidence']]) {
      await assert.rejects(h.db.prepare(`UPDATE ${table} SET ${column}='{}'`).run(),/permanent/)
      await assert.rejects(h.db.prepare(`DELETE FROM ${table}`).run(),/permanent/)
    }
    await assert.rejects(h.db.prepare("UPDATE c_feed_repair_proposals SET status='proposed' WHERE id=?").bind(proposal.id).run(),/permanent/)
    for(const method of ['PUT','DELETE']) assert.equal((await h.mf.dispatchFetch(`${h.origin}/api/coaster/${tasksPath}/${task.id}`,{method,headers:{origin:h.origin,cookie:s.finance}})).status,404,'no public route edits or deletes a repair task')

    issuer.files.clear()
    const {deliveryTime,deliveryTimezone,graceMinutes,expectedFrom,...legacyConfig}=s.config
    const legacy=await h.post(feeds,legacyConfig,s.finance)
    await s.tick('2031-06-30T18:17:00Z')
    result=await s.inert(()=>h.post(`${feeds}/${legacy.id}/repairs`,{},s.finance))
    assert.deepEqual([result.analysis.coverage,result.analysis.spend,result.proposal],['unverified','unknown',null],'unknown coverage stays unverified and proposes nothing')
    await h.post(`${feeds}/${legacy.id}/disconnect`,{version:legacy.version,consent:true},s.finance)
    await h.post(`${feeds}/${legacy.id}/repairs`,{},s.finance,409)
    console.log('PROBE AGENT-004 identification: real SFTP miss after grace -> proposal cites date, deadline, numbered health line and coverage report; before the miss -> nothing proposed')
    console.log('PROBE AGENT-004 cause: rejected SFTP authentication -> recorded failure with history line and human settings action; successful empty poll -> missing delivery')
    console.log('PROBE AGENT-004 tasks: explicit confirmation -> one assigned numbered task; replay, second person, repeated analysis and late delivery -> no duplicate')
    console.log('PROBE AGENT-004 resolution: other date, ambiguous period, sequence, empty poll and upload -> 409 open; validated exact-date delivery -> resolved once')
  } finally {await h?.close();await issuer.close()}
})

test('Feed repair confirmation and resolution fence role, membership, feed version and source evidence at both guards; delegates, agent keys and public credentials gain nothing',async()=>{
  const issuer=await issuerServer();let h,pause
  try {
    h=await harness({clock,bindings:origin=>({RER_DEV_ORIGIN:origin}),d1Barrier:async request=>{
      if(request.url.endsWith('/before-feed-repair')&&pause){const action=pause;pause=null;await action()}
      return new Response('open')
    }})
    const s=await installation(h,issuer),feed=s.feed.id
    const snapshot=async()=>[await records(h),await repairRows(h)]
    const role=finance=>h.db.prepare('UPDATE c_members SET is_finance=? WHERE email=?').bind(finance?1:0,financeAddress).run()
    await s.tick('2031-06-29T14:17:00Z')
    const proposal=(await s.prepare()).proposal
    await h.post('delegates',{delegate:address(3005),level:'full'},s.finance)
    const key=await h.post('agent-keys',{label:n(3040)},s.finance)
    await h.post('settings/members',{email:'owner'+'@'+'harbourfinch.example',name:n(3041),employee:true,finance:true})
    const credential=await h.post('public-api/keys',{label:n(3042),scopes:['claims:read']})
    let before=await snapshot()
    for(const [path,body] of [[`${feeds}/${feed}/repairs`,{}],[`${repairs}/${proposal.id}/confirm`,{consent:true}],[`${repairs}/${proposal.id}/decline`,{}],[repairs,undefined]]) {
      assert.equal((await h.send('/api/coaster/'+path,body,s.employee,{'x-coaster-acting-for':financeAddress})).status,403,'a Full delegate gains no repair authority')
      for(const token of [key.token,credential.token]) assert.equal((await h.send('/api/coaster/'+path,body,'',{authorization:`Bearer ${token}`})).status,401,'agent keys and public credentials reach no repair door')
    }
    await h.post('settings/members',{email:financeAddress,name:n(3004),employee:true})
    await s.confirm(proposal.id,s.finance,403);await s.prepare(s.finance,403)
    await h.post('settings/members',{email:financeAddress,name:n(3004),finance:true})
    assert.deepEqual(await snapshot(),before,'refused people and credentials write nothing')

    pause=()=>role(false)
    await s.confirm(proposal.id,s.finance,409)
    await role(true)
    assert.deepEqual(await snapshot(),before,'authority withdrawn after the checks fails the first guard')
    for(const [name,change] of [
      ['membership',`UPDATE c_members SET active=0 WHERE email='${financeAddress}'`],
      ['evidence',`INSERT INTO c_program_deliveries(id,feed_id,name,issuer_sequence,sha256,file_id,charges,received_at,coverage_date) VALUES('${n(3043)}','${feed}','${n(3043)}.csv','${n(3043)}','${'0'.repeat(64)}',NULL,0,'2031-06-30T00:00:00.000Z','2031-06-29')`],
    ]) {
      await h.db.prepare(`CREATE TRIGGER synthetic_repair_change AFTER INSERT ON c_feed_repair_tasks BEGIN ${change}; END`).run()
      await s.confirm(proposal.id,s.finance,409)
      await h.db.prepare('DROP TRIGGER synthetic_repair_change').run()
      assert.deepEqual(await snapshot(),before,`the second guard rolls back the ${name} change, the task, the decision and its history`)
    }
    const decisions=await Promise.all([1,2].map(()=>h.send(`/api/coaster/${repairs}/${proposal.id}/confirm`,{consent:true},s.finance)))
    assert.deepEqual(decisions.map(r=>r.status).sort(),[200,409],'simultaneous confirmations open one task')
    let [task]=(await h.get(repairs,s.finance)).tasks
    assert.equal((await h.get(repairs,s.finance)).tasks.length,1)

    await s.tick('2031-06-30T14:17:00Z')
    const prepared=await Promise.all([1,2].map(()=>h.send(`/api/coaster/${feeds}/${feed}/repairs`,{},s.finance))),ok=prepared.filter(r=>r.status===200)
    assert.ok(ok.length&&prepared.every(r=>[200,409].includes(r.status)));assert.equal(new Set(ok.map(r=>r.value.proposal.id)).size,1,'simultaneous analysis keeps one pending proposal')
    const second=ok[0].value.proposal
    assert.equal((await h.get(repairs,s.finance)).proposals.filter(p=>p.status==='proposed').length,1)
    const [secondTask]=(await s.confirm(second.id)).tasks

    issuer.files.set(n(3044)+'.csv',file(n(3045),'2031-06-29',n(3046)))
    issuer.files.set(n(3047)+'.csv',file(n(3048),'2031-06-30',n(3049)))
    await s.tick('2031-06-30T15:17:00Z')
    before=await snapshot()
    pause=()=>role(false)
    await s.resolve(task.id,s.finance,409)
    await role(true)
    await h.db.prepare(`CREATE TRIGGER synthetic_repair_change AFTER INSERT ON c_feed_repair_resolutions BEGIN UPDATE oa_sessions SET revoked_at='2031-01-01T00:00:00Z' WHERE operator_id IN (SELECT id FROM oa_operators WHERE lower(email)='${financeAddress}'); END`).run()
    await s.resolve(task.id,s.finance,409)
    await h.db.prepare('DROP TRIGGER synthetic_repair_change').run()
    assert.deepEqual(await snapshot(),before,'resolution authority is fenced before and after its write')
    task=(await s.resolve(task.id)).task
    assert.equal(task.status,'resolved')

    const connected=(await h.get(feeds,s.finance)).feeds.find(f=>f.id===feed)
    pause=()=>h.post(`${feeds}/${feed}/disconnect`,{version:connected.version,consent:true},s.finance)
    await s.resolve(secondTask.id,s.finance,409)
    await s.resolve(secondTask.id,s.finance,409)
    assert.equal((await h.get(repairs,s.finance)).tasks.find(t=>t.id===secondTask.id).status,'open','a changed feed version cannot resolve its task')
    await s.prepare(s.finance,409)
    console.log('PROBE AGENT-004 authority: delegate 403, agent key and public credential 401, withdrawn role 403, in-flight role, membership and evidence changes 409 with full rollback')
    console.log('PROBE AGENT-004 concurrency: two confirmations -> one task; two analyses -> one pending proposal; feed disconnected during resolution -> 409 and task stays open')
  } finally {await h?.close();await issuer.close()}
})
