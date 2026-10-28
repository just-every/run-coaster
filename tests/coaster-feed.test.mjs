import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { harness } from './harness.mjs'
import { issuerServer } from './fixtures/feed/server.mjs'

const n = value => `synthetic-coaster-${value}`
const endpoint = 'feeds/program'
const csv = (sequence, rows) => 'Date,Merchant,Amount,Card,Transaction,MCC,Sequence\n' + rows.map(([merchant,transaction,mcc,amount='23.17']) => ['2031-06-10',merchant,amount,'1111',transaction,mcc,sequence].join(',')).join('\n')

test('CODE-002 actual scheduled SFTP public-key delivery creates coded card expenses once; active choices, human edits and disconnected consent remain guarded; SEC-001 requires recent native connection authority', async () => {
  let pauseConnection
  const issuer=await issuerServer(),h=await harness({bindings:origin=>({RER_DEV_ORIGIN:origin}),d1Barrier:async request=>{
    if(request.url.endsWith('/before-provider-connection')&&pauseConnection)await pauseConnection()
    return new Response('open')
  }})
  try {
    await h.post('settings/business',{name:n(910),currency:'USD',timezone:'UTC',receiptThreshold:'10000'})
    const managerAddress=`${n(911)}@example.test`,manager=await h.person(managerAddress,{employee:true,manager:true})
    const employeeAddress=`${n(912)}@example.test`,employee=await h.person(employeeAddress,{employee:true},managerAddress)
    const financeAddress=`${n(913)}@example.test`
    let finance=await h.person(financeAddress,{employee:true,finance:true},managerAddress)
    const bookkeeper=await h.person(`${n(914)}@example.test`,{bookkeeper:true})
    const initial=await h.post('settings/categories',{name:n(915),accountCode:n(916),taxCode:n(917)})
    const coded=await h.post('settings/categories',{name:n(918),accountCode:n(919),taxCode:n(917)})
    let catalog=await h.get('coding');const dimensions={},choices={}
    for(const [i,kind]of ['class','project'].entries()){
      catalog=await h.post('coding/dimensions',{version:catalog.version,name:n(920+i),kind});dimensions[kind]=catalog.saved
      catalog=await h.post('coding/values',{version:catalog.version,dimension:catalog.saved,name:n(922+i)});choices[kind]=catalog.saved
    }
    const fields={category:coded.id,dimensions:{[dimensions.class]:choices.class,[dimensions.project]:choices.project}}
    const rule=await h.post('coding/automatic/rules',{version:(await h.get('coding/automatic/rules',finance)).version,scope:'finance',merchant:n(930),coding:fields,active:true},finance)
    await h.post('coding/automatic/mcc',{version:rule.version,mcc:'5812',category:coded.id,active:true},finance)
    await h.post('statements/cards',{issuer:n(924),last4:'1111',employee:`${n(912)}@example.test`})
    const config={...issuer.credentials,issuer:n(924),category:initial.id,intervalMinutes:60,consent:true,mapping:{dateFormat:'YYYY-MM-DD',sign:'purchases-positive',postedDate:'Date',description:'Merchant',amount:'Amount',card:'Card',transactionId:'Transaction',mcc:'MCC',sequence:'Sequence'}}
    const custody=()=>h.db.prepare("SELECT (SELECT COUNT(*) FROM c_program_feeds) AS feeds,(SELECT COUNT(*) FROM c_program_feeds WHERE credentials_sealed IS NOT NULL) AS credentials,(SELECT COUNT(*) FROM c_events WHERE action='program-feed-connected') AS history").first()
    const setFinanceAge=async age=>{
      const session=await h.send('/auth/session',undefined,finance)
      assert.equal(session.status,200,'an aged native session remains valid for ordinary access')
      await h.db.prepare('UPDATE oa_sessions SET created_at=? WHERE id=?').bind(Date.now()-age,session.value.id).run()
      return session.value.id
    }
    const signInAgain=async()=>{
      const requested=await h.send('/auth/magic-link',{email:financeAddress},finance)
      assert.equal(requested.status,202)
      finance=await h.confirmMail(financeAddress)
    }
    const noCustody=await custody()
    await h.post(endpoint,config,employee,403);await h.post(endpoint,config,manager,403);await h.post(endpoint,config,bookkeeper,403)
    for(const roles of [{cardAdmin:true},{auditor:true}]){
      await h.post('settings/members',{email:employeeAddress,name:n(912),...roles,approver:managerAddress})
      await h.post(endpoint,config,employee,403)
    }
    await h.post('settings/members',{email:employeeAddress,name:n(912),employee:true,approver:managerAddress})
    for(const level of ['submit','full']){
      const grant=await h.post('delegates',{delegate:employeeAddress,level},finance)
      assert.equal((await h.send(`/api/coaster/${endpoint}`,config,employee,{'x-coaster-acting-for':financeAddress})).status,403)
      await h.post(`delegates/${grant.id}/revoke`,{},finance)
    }
    const key=await h.post('agent-keys',{label:n(943)},finance)
    assert.equal((await h.send(`/api/coaster/${endpoint}`,config,'',{authorization:`Bearer ${key.token}`})).status,401)
    await h.post(endpoint,{...config,consent:false},finance,400)
    await h.post(endpoint,{...config,host:'10.0.0.1'},finance,400)
    assert.equal((await h.send(`/api/coaster/${endpoint}`,config,finance,{origin:'https://unrelated.example'})).status,403)
    await setFinanceAge(11*60_000)
    const stale=await h.post(endpoint,config,finance,401)
    assert.match(stale.error,/sign in again/i)
    assert.equal(issuer.requests.length,0,'stale sign-in never opens a provider connection')
    assert.deepEqual(await custody(),noCustody,'refused connections leave no feed, sealed credential or connection history')
    await signInAgain()
    const connected=await h.post(endpoint,config,finance)
    assert.equal(issuer.requests.length,0,'configuration never opens SFTP before the scheduled run')
    const sealed=(await h.db.prepare('SELECT credentials_sealed FROM c_program_feeds WHERE id=?').bind(connected.id).first()).credentials_sealed
    assert.ok(sealed,'fresh native confirmation permits sealed custody')
    for(const secret of [config.privateKey,config.username,config.hostKeyFingerprint])assert.ok(!sealed.includes(secret),'provider credentials are sealed in D1')
    const pan='9'.repeat(12)+'1111',firstFile=csv(n(926),[[n(930),n(927),'5812'],[n(931),n(928),'5812']]).replaceAll(',1111,',`,${pan},`)
    issuer.files.set(`${n(925)}.csv`,firstFile)
    const worker=await h.mf.getWorker(),tick=iso=>worker.scheduled({scheduledTime:new Date(iso),cron:'17 * * * *'})
    await tick('2031-06-10T10:17:00Z')
    let state=await h.get(endpoint,finance)
    assert.equal(state.feeds[0].error,null);assert.ok(state.feeds[0].lastSuccessAt)
    assert.equal(state.deliveries.length,1);assert.equal(state.deliveries[0].charges,2)
    let claims=(await h.get('state',employee)).claims
    assert.equal(claims.length,1)
    let detail=await h.get(`claims/${claims[0].id}`,employee)
    assert.equal(detail.items.length,2)
    const first=detail.items.find(i=>i.merchant===n(930)),second=detail.items.find(i=>i.merchant===n(931))
    assert.equal(first.allocations[0].category_id,coded.id);assert.deepEqual(first.coding,fields.dimensions)
    assert.ok(first.codingSuggestions.some(s=>s.evidence.some(e=>e.source==='merchant-rule')))
    assert.equal(second.allocations[0].category_id,coded.id)
    assert.ok(second.codingSuggestions.some(s=>s.evidence.some(e=>e.source==='merchant-category'&&e.reason.includes('5812'))))
    const edited=await h.post(`claims/${detail.claim.id}/items`,{version:detail.claim.version,item:first.id,kind:'receipt',date:first.spent_on,merchant:first.merchant,amount:'23.17',category:initial.id,description:n(935),coding:fields.dimensions},employee)
    const frozen=(await h.get(`claims/${edited.id}`,employee)).items.find(i=>i.id===first.id)
    issuer.files.set(`${n(929)}.csv`,firstFile)
    await tick('2031-06-10T11:17:00Z')
    state=await h.get(endpoint,finance);assert.equal(state.deliveries.length,1,'renamed delivery with identical issuer sequence/hash imports once')
    detail=await h.get(`claims/${edited.id}`,employee);assert.equal(detail.items.length,2);assert.deepEqual(detail.items.find(i=>i.id===first.id),frozen,'replay never changes the employee coding')
    catalog=await h.get('coding');await h.post('coding/values',{version:catalog.version,id:choices.class,active:false})
    issuer.files.set(`${n(936)}.csv`,csv(n(937),[[n(930),n(938),'5812','24.17']]))
    await tick('2031-06-10T12:17:00Z')
    detail=await h.get(`claims/${edited.id}`,employee)
    const fresh=detail.items.find(i=>i.id!==first.id&&i.id!==second.id)
    assert.ok(fresh);assert.ok(!Object.values(fresh.coding).includes(choices.class),'archived classes are never auto-filled')
    assert.deepEqual(detail.items.find(i=>i.id===first.id),frozen,'new deliveries preserve earlier employee fields')
    assert.ok((await h.get('coding/automatic/rules',finance)).flags.some(f=>f.rule_id===rule.saved))
    const retained=await h.get(`statements/${state.deliveries[0].file_id}/file`,finance)
    assert.match(retained,/Merchant/)
    assert.ok(!retained.includes(pan),'only the masked original is retained');assert.match(retained,/\*{12}1111/)
    const history=await h.get('history',finance)
    assert.match(JSON.stringify(history),/program-feed-delivery-received/)
    const shown=JSON.stringify([state,history])
    for(const secret of [issuer.credentials.privateKey,issuer.credentials.username,issuer.credentials.hostKeyFingerprint])assert.ok(!shown.includes(secret),'credentials and host-key pins stay out of public state and history')
    const before=issuer.requests.length
    await h.post(`${endpoint}/${connected.id}/disconnect`,{version:connected.version,consent:true},employee,403)
    await setFinanceAge(11*60_000)
    await h.post(`${endpoint}/${connected.id}/disconnect`,{version:connected.version,consent:true},finance)
    assert.deepEqual(await h.db.prepare('SELECT enabled,credentials_sealed FROM c_program_feeds WHERE id=?').bind(connected.id).first(),{enabled:0,credentials_sealed:null},'an aged session can disconnect immediately and remove credential custody')
    issuer.files.set(`${n(939)}.csv`,csv(n(940),[[n(930),n(941),'5812','25.17']]))
    await tick('2031-06-10T13:17:00Z');assert.equal(issuer.requests.length,before,'disconnect stops future TCP connections')
    await signInAgain()
    const reconnected=await h.post(endpoint,config,finance)
    let signal,release;const started=new Promise(resolve=>{signal=resolve}),resume=new Promise(resolve=>{release=resolve})
    issuer.control.beforeRead=async()=>{signal();await resume}
    const running=tick('2031-06-10T14:17:00Z');await started
    await h.post(`${endpoint}/${reconnected.id}/disconnect`,{version:reconnected.version,consent:true},finance);release();await running
    assert.equal((await h.get(`claims/${edited.id}`,employee)).items.length,3,'revoked in-flight delivery cannot commit a charge')
    assert.ok(issuer.requests.filter(r=>r.operation==='open').every(r=>r.flags===1))
    assert.ok(!issuer.requests.some(r=>['WRITE','REMOVE','RENAME','MKDIR','RMDIR','SETSTAT','FSETSTAT'].includes(r.operation)),'the application never changes issuer files')
    // A wrong host-key pin is refused before a credential signature is sent.
    issuer.control.beforeRead=null
    await h.post(endpoint,{...config,hostKeyFingerprint:'SHA256:'+createHash('sha256').update(n(942)).digest('base64').replace(/=+$/,'')},finance)
    const auths=issuer.requests.filter(r=>r.operation==='authenticate').length
    await tick('2031-06-10T15:17:00Z')
    assert.equal(issuer.requests.filter(r=>r.operation==='authenticate').length,auths)
    assert.match((await h.get(endpoint,finance)).feeds.find(f=>f.enabled).error,/verified host key/)

    const beforeGuardedConnections=issuer.requests.length
    for(const change of ['age','authority']){
      const saved=await custody(),requests=issuer.requests.length
      let arrived,resume
      const paused=new Promise(resolve=>{arrived=resolve}),released=new Promise(resolve=>{resume=resolve})
      pauseConnection=async()=>{pauseConnection=undefined;arrived();await released}
      const pending=h.send(`/api/coaster/${endpoint}`,config,finance)
      try{
        await Promise.race([paused,pending.then(response=>{throw new Error(`connection completed before its database pause: ${response.status}`)})])
        if(change==='age')await setFinanceAge(11*60_000)
        else await h.post('settings/members',{email:financeAddress,name:n(913),employee:true,approver:managerAddress})
      }finally{pauseConnection=undefined;resume()}
      assert.equal((await pending).status,409,`${change} is checked again before persisting credentials`)
      assert.deepEqual(await custody(),saved,'a paused connection with lost authority writes no custody or connection history')
      assert.equal(issuer.requests.length,requests)
      if(change==='age')await signInAgain()
      else await h.post('settings/members',{email:financeAddress,name:n(913),employee:true,finance:true,approver:managerAddress})
    }

    const saved=await custody(),sessionId=await setFinanceAge(0)
    const session=await h.db.prepare('SELECT created_at FROM oa_sessions WHERE id=?').bind(sessionId).first()
    await h.db.prepare('CREATE TRIGGER "synthetic-coaster-944" AFTER INSERT ON c_program_feeds BEGIN UPDATE oa_sessions SET created_at=0 WHERE operator_id=(SELECT id FROM oa_operators WHERE lower(email)=NEW.connected_by); END').run()
    try{
      await h.post(endpoint,config,finance,409)
      assert.deepEqual(await custody(),saved,'freshness lost inside the transaction rolls back the feed, sealed credential and history')
      assert.deepEqual(await h.db.prepare('SELECT created_at FROM oa_sessions WHERE id=?').bind(sessionId).first(),session,'the trailing authority guard rolls back every write in the batch')
    }finally{await h.db.prepare('DROP TRIGGER "synthetic-coaster-944"').run()}

    await h.post('settings/members',{email:managerAddress,name:n(911),employee:true,manager:true,admin:true})
    assert.equal((await h.send('/auth/magic-link',{email:managerAddress})).status,202)
    const admin=await h.confirmMail(managerAddress)
    for(const native of [h.owner,admin]){
      const permitted=await h.post(endpoint,config,native)
      await h.post(`${endpoint}/${permitted.id}/disconnect`,{version:permitted.version,consent:true},native)
    }
    await h.post('settings/members',{email:managerAddress,name:n(911),employee:true,manager:true})
    assert.equal(issuer.requests.length,beforeGuardedConnections,'connection guards and permitted configuration never open SFTP')
  } finally {await h.close();await issuer.close()}
})
