import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agency, harness } from './harness.mjs';
import { address, preferences, tick, notifications, expense, decision } from './notification-kit.mjs';

const clock = Date.parse('2027-03-12T01:17:00.000Z');

test('Personal email choices separate immediate events from one exact daily digest and retain attempt identities on replay', async () => {
  const h = await harness({ clock });
  try {
    const team = await agency(h);
    await h.post('settings/notifications', preferences(), team.priya);
    await h.post('settings/notifications', preferences({quietFrom:0,quietUntil:0}), team.sam);
    const one = await expense(h,team,'Private workshop title');
    const two = await expense(h,team,'Second private title');
    const four = await expense(h,team,'Another pending private title');
    await h.post('settings/notifications', preferences({submission:'immediate'}), team.priya);
    const three = await expense(h,team,'Immediate private title');
    assert.equal(notifications(h).length,1);
    assert.ok(notifications(h)[0].text.includes(three.id));
    await decision(h,team,three);
    await decision(h,team,one,'returned');
    assert.equal(notifications(h).length,2,'decision is immediate while return remains in its digest');
    await tick(h,'2027-03-12T16:17:00Z');
    assert.equal(notifications(h).length,2,'no digest or queued email before personal 09:00');
    await tick(h,'2027-03-12T17:17:00Z');
    const digests = notifications(h).filter(m=>m.subject.includes('digest'));
    assert.equal(digests.length,2,'one digest for each person with due events');
    const manager = digests.find(m=>m.to.includes(address('priya'))), employee = digests.find(m=>m.to.includes(address('sam')));
    assert.deepEqual([...manager.text.matchAll(/claims\/(.*)/g)].map(m=>m[1]).sort(),[two.id,four.id].sort(),'exactly both authorized digest submissions appear, excluding returned and immediate events');
    assert.ok(employee.text.includes(one.id) && !employee.text.includes(two.id) && !employee.text.includes(three.id),'return is separate from immediate decision and private drafts');
    for (const mail of notifications(h)) for (const privateValue of ['Private workshop title','Private merchant','Private client purpose','Private decision reason','Original receipt lost']) assert.ok(!JSON.stringify(mail).includes(privateValue),'mail excludes private expense, receipt and decision content');
    const attempts = await h.db.prepare('SELECT * FROM c_notification_deliveries ORDER BY id').all();
    assert.ok(attempts.results.every(d=>d.status==='accepted' && d.provider_status==='accepted'));
    await tick(h,'2027-03-12T18:17:00Z');
    await tick(h,'2027-03-13T17:17:00Z');
    assert.equal(notifications(h).length,4,'replayed hourly ticks never create another message');
    assert.deepEqual((await h.db.prepare('SELECT * FROM c_notification_deliveries ORDER BY id').all()).results,attempts.results);
    assert.equal((await h.get('settings/notifications',team.sam)).deliveries.length,2);
    assert.equal((await h.get('settings/notifications',team.alex)).deliveries.length,0,'personal delivery history is isolated');
  } finally { await h.close(); }

  const overnight = await harness({ clock });
  try {
    const team = await agency(overnight);
    await overnight.post('settings/notifications',preferences({timezone:'UTC',quietFrom:9,quietUntil:0}),team.priya);
    const claim = await expense(overnight,team,'Digest deferred past midnight');
    await tick(overnight,'2027-03-12T08:17:00Z');
    await tick(overnight,'2027-03-12T09:17:00Z');
    await tick(overnight,'2027-03-12T23:17:00Z');
    assert.equal(notifications(overnight).length,0,'the due digest waits through quiet hours');
    await tick(overnight,'2027-03-13T00:17:00Z');
    const digest = notifications(overnight);
    assert.equal(digest.length,1,'the previous day digest releases when quiet hours end at midnight');
    assert.deepEqual([...digest[0].text.matchAll(/claims\/(.*)/g)].map(m=>m[1]),[claim.id]);
    const attempts = (await overnight.get('settings/notifications',team.priya)).deliveries;
    assert.equal(attempts[0].eventCount,1);
    assert.equal(attempts[0].status,'accepted');
    await tick(overnight,'2027-03-13T00:17:00Z');
    await tick(overnight,'2027-03-13T08:17:00Z');
    assert.equal(notifications(overnight).length,1,'replay and later awake hours do not duplicate the deferred digest');
    assert.deepEqual((await overnight.get('settings/notifications',team.priya)).deliveries,attempts);
  } finally { await overnight.close(); }
});

test('Finance reminder steps release at personal 09:00 across daylight saving, stop on completion, and preserve escalation cadence', async () => {
  const h = await harness({ clock });
  try {
    const team = await agency(h);
    await h.post('settings/business',{name:'Harbour and Finch Studio',currency:'AUD',timezone:'America/New_York',receiptThreshold:''});
    await h.post('settings/reminders',{days:'1,2,3',quietFrom:20,quietUntil:8,serviceLevel:3,escalateAfter:2});
    await h.post('settings/notifications',preferences({submission:'immediate'}),team.sam);
    const draft = await expense(h,team,'Unsubmitted workshop',false);
    await tick(h,'2027-03-12T01:17:00Z');
    await tick(h,'2027-03-12T16:17:00Z');
    assert.equal(notifications(h).length,0,'business is awake but personal 08:17 remains quiet');
    await tick(h,'2027-03-12T17:17:00Z');
    const first = notifications(h).length;
    assert.equal(first,2,'receipt and unsubmitted claim each get the first configured step');
    await tick(h,'2027-03-12T17:17:00Z');
    assert.equal(notifications(h).length,first);
    await h.post('settings/notifications',preferences({submission:'immediate',reminder:'digest'}),team.sam);
    await tick(h,'2027-03-15T15:17:00Z');
    assert.equal(notifications(h).length,first,'after DST personal 08:17 is still quiet');
    await tick(h,'2027-03-15T16:17:00Z');
    assert.equal(notifications(h).length,3,'after DST personal 09:17 releases both second-step reminders in one digest one UTC hour earlier');
    const digest = notifications(h).find(m=>m.subject.includes('digest'));
    assert.equal(digest.text.split(draft.id).length-1,2,'the due digest contains exactly the receipt and submission tasks');
    await tick(h,'2027-03-16T15:17:00Z');
    const submitted = await h.post(`claims/${draft.id}/submit`,{version:draft.version},team.sam);
    await tick(h,'2027-03-16T16:17:00Z');
    assert.equal(notifications(h).length,3,'completion cancels queued receipt and submission reminders');
    await decision(h,team,submitted);
    assert.equal(notifications(h).length,4,'a decision still uses its independent immediate preference');
    const reminders = (await h.db.prepare('SELECT * FROM c_reminders ORDER BY key,step').all()).results;
    assert.deepEqual([...new Set(reminders.map(r=>r.step))],[1,2,3],'finance steps are consumed once even when the task finishes during quiet hours');
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM c_events WHERE action='reminder-sent'").first()).n,6);
  } finally { await h.close(); }

  const weekend = await harness({ clock: Date.parse('2027-03-09T17:17:00Z') });
  try {
    const team = await agency(weekend);
    await weekend.post('settings/business',{name:'Harbour and Finch Studio',currency:'AUD',timezone:'America/Los_Angeles',receiptThreshold:''});
    await weekend.post('settings/reminders',{days:'1',quietFrom:20,quietUntil:8,serviceLevel:3,escalateAfter:2});
    await weekend.post('settings/notifications',preferences({timezone:'Pacific/Auckland',quietFrom:0,quietUntil:0}),team.sam);
    let claim = await weekend.post('claims',{title:'Unsubmitted cross-zone workshop'},team.sam);
    claim = await weekend.post(`claims/${claim.id}/items`,{version:claim.version,kind:'receipt',date:'2027-03-09',merchant:'Workshop supplies',amount:'10.00',explanation:'Original receipt lost',allocations:[{category:team.c.office}]},team.sam);
    await tick(weekend,'2027-03-09T17:17:00Z');
    await tick(weekend,'2027-03-12T20:17:00Z');
    const escalations = weekend.messages.filter(m=>m.subject.startsWith('Escalated:'));
    assert.equal(notifications(weekend).length,0,'personal Saturday still suppresses personal reminders');
    assert.equal(escalations.length,2,'Los Angeles Friday escalates both exhausted tasks despite the owing person’s Saturday');
    assert.ok(escalations.every(m=>m.to.length===1 && m.to[0]===address('priya') && m.text.includes(claim.id)));
    const history = (await weekend.db.prepare('SELECT * FROM c_escalations ORDER BY key').all()).results;
    assert.equal(history.length,2);
    assert.ok(history.every(row=>row.level===1 && row.sent_at==='2027-03-12T20:17:00.000Z'));
    await tick(weekend,'2027-03-12T20:17:00Z');
    assert.equal(weekend.messages.filter(m=>m.subject.startsWith('Escalated:')).length,2);
    assert.deepEqual((await weekend.db.prepare('SELECT * FROM c_escalations ORDER BY key').all()).results,history);
  } finally { await weekend.close(); }
});

test('Preference and dispatch doors refuse other people, revoked roles, erased identities and retracted private work', async () => {
  const h = await harness({ clock });
  try {
    const team = await agency(h);
    await h.post('settings/notifications',preferences(),team.priya);
    await h.post('settings/notifications',preferences(),team.sam);
    const before = await h.get('settings/notifications',team.priya);
    await h.post('settings/notifications',{...preferences(),email:address('priya')},team.sam,403);
    await h.post('settings/notifications',{...preferences(),recipient:address('priya')},h.owner,403);
    const grant = await h.post('delegates',{delegate:address('alex'),level:'full'},team.priya);
    assert.equal((await h.send('/api/coaster/settings/notifications',preferences(),team.alex,{'x-coaster-acting-for':address('priya')})).status,403);
    assert.deepEqual(await h.get('settings/notifications',team.priya),before);
    const revoked = await expense(h,team,'Role revoked before digest');
    const hidden = await expense(h,team,'Retracted before digest');
    await h.post(`claims/${hidden.id}/retract`,{version:hidden.version},team.sam);
    await h.post('settings/members',{email:address('priya'),name:'Priya',employee:true,manager:false});
    await tick(h,'2027-03-12T17:17:00Z');
    assert.equal(notifications(h).length,0,'removed reviewer role and a draft cannot receive queued submission mail');
    assert.ok((await h.db.prepare('SELECT cancelled_at FROM c_notification_events WHERE claim_id=?').bind(revoked.id).first()).cancelled_at);
    await h.post(`delegates/${grant.id}/revoke`,{},team.priya);
    // A departed person with a rejected financial record can be erased; their pending return and preferences disappear.
    await h.post('settings/members',{email:address('priya'),name:'Priya',employee:true,manager:true});
    await decision(h,team,revoked,'rejected');
    await h.post('settings/notifications',preferences({decision:'digest'}),team.sam);
    let final = await expense(h,team,'Departing person');
    await decision(h,team,final,'rejected');
    // The retracted draft must also be settled before ordinary erasure is permitted.
    const detail = await h.get(`claims/${hidden.id}`,team.sam);
    final = await h.post(`claims/${hidden.id}/submit`,{version:detail.claim.version},team.sam);
    await decision(h,team,final,'rejected');
    await h.post('settings/members',{email:address('sam'),name:'Sam',employee:true,active:false});
    await h.post('settings/members/erase',{email:address('sam')});
    const count = notifications(h).length;
    await tick(h,'2027-03-15T16:17:00Z');
    assert.equal(notifications(h).length,count,'erasure cannot resurrect queued mail');
    for (const table of ['c_notification_preferences','c_notification_events','c_notification_deliveries']) assert.equal((await h.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE recipient=?`).bind(address('sam')).first()).n,0);
    await h.get('settings/notifications',team.sam,401);
  } finally { await h.close(); }

  const owner = await harness({ clock });
  try {
    const team = await agency(owner);
    assert.equal((await owner.db.prepare('SELECT COUNT(*) AS n FROM c_members WHERE email=?').bind(address('owner')).first()).n,0);
    await owner.post('settings/reminders',{days:'1',quietFrom:20,quietUntil:8,serviceLevel:3,escalateAfter:2});
    await owner.post('settings/notifications',preferences({timezone:'UTC',quietFrom:0,quietUntil:0}));
    let claim = await owner.post('claims',{title:'Owner workshop'});
    claim = await owner.post(`claims/${claim.id}/items`,{version:claim.version,kind:'receipt',date:'2027-03-11',merchant:'Workshop supplies',amount:'10.00',explanation:'Original receipt lost',allocations:[{category:team.c.office}]});
    await tick(owner,'2027-03-12T01:17:00Z');
    await tick(owner,'2027-03-15T09:17:00Z');
    const mail = notifications(owner);
    assert.equal(mail.length,2,'the native owner receives personal receipt and submission reminders without a separate member row');
    assert.ok(mail.every(m=>m.to.length===1 && m.to[0]===address('owner') && m.text.includes(claim.id)));
    const deliveries = (await owner.get('settings/notifications')).deliveries;
    assert.equal(deliveries.length,2);
    assert.ok(deliveries.every(d=>d.status==='accepted' && d.eventCount===1));
    await tick(owner,'2027-03-15T09:17:00Z');
    assert.equal(notifications(owner).length,2);
    assert.deepEqual((await owner.get('settings/notifications')).deliveries,deliveries);
  } finally { await owner.close(); }
});
