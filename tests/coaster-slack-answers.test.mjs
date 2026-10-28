import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, agency } from './harness.mjs';
import { pendingEmailQuestionClaim } from './fixtures/email-question-claim.mjs';
import { connectSlack, deliverSlack, linkSlack, slackFixture } from './fixtures/slack.mjs';

const address=name=>[name,'harbourfinch.example'].join('@');
const snapshot=async h=>{
  const tables=['c_comments','c_events','c_slack_connection','c_slack_links','c_slack_challenges','c_slack_threads','c_slack_answers','c_claims','c_revisions','c_decisions'];
  return Promise.all(tables.map(async table=>(await h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results));
};

test('Slack named-person answers close the ordinary question once without changing the submitted revision, with current authority and no unsafe writes',async()=>{
  const edge=slackFixture(),h=await harness({slackEdge:r=>edge.fetch(r)});
  try {
    const t=await agency(h);
    const roles={admin:{admin:true},finance:{finance:true},card:{cardAdmin:true},approver:{manager:true},auditor:{auditor:true},bookkeeper:{bookkeeper:true}};
    const people={}; for(const [name,flags] of Object.entries(roles)) people[name]=await h.person(address('synthetic-coaster-'+name),flags);
    for(const name of ['card','approver','auditor','bookkeeper']) {
      const before=await snapshot(h), calls=edge.calls.length;
      await h.post('chat/slack/connect',{botToken:edge.token,signingSecret:edge.secret,consent:true},people[name],403);
      assert.deepEqual(await snapshot(h),before); assert.equal(edge.calls.length,calls);
    }
    await h.post('chat/slack/connect',{botToken:edge.token,signingSecret:edge.secret},h.owner,400);
    for(const cookie of [people.admin,people.finance,h.owner]) {
      assert.equal((await connectSlack(h,edge,cookie)).connected,true);
      await h.post('chat/slack/disconnect',{consent:true},cookie);
    }
    await connectSlack(h,edge,people.admin);
    await h.post('chat/slack/link/start',{user:edge.user},t.sam,400);
    await h.post('chat/slack/link/confirm',{code:'synthetic-coaster-wrong'},t.sam,403);
    await h.post('chat/slack/link/start',{user:edge.user,consent:true},t.sam);
    const code=edge.messages.at(-1).text.match(/code: ([a-f0-9]+)/)[1];
    await h.post('chat/slack/link/confirm',{code},t.alex,403);
    await h.post('chat/slack/link/confirm',{code},t.sam);
    await h.post('chat/slack/link/confirm',{code},t.sam,403);
    const claim=await pendingEmailQuestionClaim(h,t,'Client launch workshop');
    const original=await h.get(`claims/${claim.id}`,t.sam);
    const item=original.items[0].id;
    const question=await h.post(`claims/${claim.id}/comments`,{body:'Which client was this for?',item,asks:address('sam')},t.priya);
    assert.equal(question.slack,'sent');
    const pending=await h.get(`claims/${claim.id}`,t.priya);
    assert.equal(pending.comments.find(c=>c.id===question.comment).open,true);
    const refuse=async(event,options,status=403)=>{
      const before=await snapshot(h); assert.equal((await deliverSlack(h,edge,event,options)).status,status); assert.deepEqual(await snapshot(h),before,'refused Slack events write nothing');
    };
    await refuse(edge.reply(),{secret:'synthetic-coaster-invalid'});
    await refuse(edge.reply(),{timestamp:Math.floor(Date.now()/1000)-600});
    await refuse(edge.reply({team_id:'TFOREIGN'}));
    await refuse(edge.reply({api_app_id:'AFOREIGN'}));
    await refuse(edge.reply({event:{user:'UWRONG'}}));
    await refuse(edge.reply({event:{channel:'DFOREIGN'}}));
    await refuse(edge.reply({event:{thread_ts:'1800000000.999999'}}));
    edge.inactive.add(edge.user); await refuse(edge.reply()); edge.inactive.delete(edge.user);
    await h.post('chat/slack/unlink',{},t.sam); await refuse(edge.reply());
    await linkSlack(h,edge,t.sam);
    // Unlinking deletes old delivery authority; re-link does not revive an old thread.
    await refuse(edge.reply());
    await h.post(`claims/${claim.id}/comments`,{body:'Which client was this for?',item,asks:address('sam')},t.priya);
    const beforeRace=await h.get(`claims/${claim.id}`,t.priya);
    edge.beforeMember=async()=>{edge.beforeMember=undefined;await h.post('chat/slack/unlink',{},t.sam);};
    assert.equal((await deliverSlack(h,edge)).status,409,'revocation after sender lookup is fenced by the atomic answer commit');
    assert.deepEqual((await h.get(`claims/${claim.id}`,t.priya)).comments,beforeRace.comments);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_slack_answers').first()).n,0);
    await linkSlack(h,edge,t.sam);
    const next=await h.post(`claims/${claim.id}/comments`,{body:'Which client was this for?',item,asks:address('sam')},t.priya);
    await h.post('settings/members',{email:address('sam'),name:'sam',employee:true,active:false,approver:address('priya')});
    await refuse(edge.reply());
    await h.post('settings/members',{email:address('sam'),name:'sam',employee:true,active:true,approver:address('priya')});
    await h.db.prepare("UPDATE oa_operators SET status='inactive' WHERE lower(email)=?").bind(address('sam')).run();
    await refuse(edge.reply());
    await h.db.prepare("UPDATE oa_operators SET status='active' WHERE lower(email)=?").bind(address('sam')).run();
    const accepted=await deliverSlack(h,edge); assert.equal(accepted.status,200); assert.deepEqual(accepted.value,{accepted:true,replayed:false});
    const answered=await h.get(`claims/${claim.id}`,t.priya);
    const answer=answered.comments.find(c=>c.parent_id===next.comment);
    assert.equal(answer.body,'Harbour Bank, the pitch team'); assert.equal(answer.author_email,address('sam')); assert.equal(answer.item_id,item);
    assert.equal(answered.comments.find(c=>c.id===next.comment).open,false);
    await h.post(`comments/${next.comment}/edit`,{body:'A different question after the answer'},t.priya,409);
    assert.deepEqual(answered.revisions,original.revisions); assert.deepEqual(answered.claim,original.claim);
    assert.equal(answered.events.find(e=>e.action==='question-answered').detail.channel,'slack');
    const after=await snapshot(h);
    assert.deepEqual((await deliverSlack(h,edge,edge.reply({event_id:'synthetic-coaster-retry'}))).value,{accepted:true,replayed:true});
    assert.deepEqual(await snapshot(h),after);
    await refuse(edge.reply({event:{ts:'1800000002.000001',text:'Second answer'}}),undefined,409);
    const approved=await h.post(`claims/${claim.id}/decision`,{revision:claim.revision,version:claim.version,decision:'approved',acknowledge:true},t.priya);
    assert.equal(approved.status,'approved');
    const final=await h.get(`claims/${claim.id}`,t.priya); assert.deepEqual(final.revisions,original.revisions); assert.equal(final.decisions.at(-1).revision,claim.revision);
    assert.equal(final.comments.find(c=>c.id===answer.id).body,answer.body);
    await h.post('claims',{title:'Old session remains revoked'},t.sam,401);
    assert.equal((await h.send('/auth/magic-link',{email:address('sam')})).status,202);
    t.sam=await h.confirmMail(address('sam'));
    let later=await h.post('claims',{title:'Revised client visit'},t.sam);
    later=await h.post(`claims/${later.id}/items`,{version:later.version,kind:'receipt',date:'2026-05-22',merchant:'Client office',amount:'31.00',explanation:'Receipt unavailable',allocations:[{category:t.c.meals}]},t.sam);
    later=await h.post(`claims/${later.id}/submit`,{version:later.version},t.sam);
    await h.post(`claims/${later.id}/comments`,{body:'Which client was this for?',asks:address('sam')},t.priya);
    const oldEvent=edge.reply();
    later=await h.post(`claims/${later.id}/decision`,{revision:later.revision,version:later.version,decision:'returned',reason:'Correct the expense',acknowledge:true},t.priya);
    later=await h.post(`claims/${later.id}/submit`,{version:later.version},t.sam);
    assert.equal(later.revision,2);
    await refuse(oldEvent,undefined,409);
    for(const name of ['card','approver','auditor','bookkeeper']) {const before=await snapshot(h);await h.post('chat/slack/disconnect',{consent:true},people[name],403);assert.deepEqual(await snapshot(h),before);}
    await h.post('chat/slack/disconnect',{consent:true},people.finance); await refuse(edge.reply());
    const encoded=JSON.stringify((await h.db.prepare('SELECT detail FROM c_events').all()).results);
    assert.ok(!encoded.includes(edge.secret)&&!encoded.includes(edge.token)&&!encoded.includes(code),'numbered history excludes execution credentials and link codes');
  } finally {await h.close();}
});

test('Erasure removes Slack identity and answers in the same native erasure and refuses subsequent and replayed messages',async()=>{
  const edge=slackFixture(),h=await harness({slackEdge:r=>edge.fetch(r)});
  try {
    const t=await agency(h); await connectSlack(h,edge); await linkSlack(h,edge,t.sam);
    const c=await pendingEmailQuestionClaim(h,t,'Departed employee client question');
    await h.post(`claims/${c.id}/comments`,{body:'Which client was this for?',asks:address('sam')},t.priya);
    const event=edge.reply(); assert.equal((await deliverSlack(h,edge,event)).status,200);
    await h.post(`claims/${c.id}/decision`,{revision:c.revision,version:c.version,decision:'rejected',reason:'Cancelled trip',acknowledge:true},t.priya);
    await h.post('settings/members',{email:address('sam'),name:'sam',employee:true,active:false});
    await h.post('settings/members/erase',{email:address('sam')});
    for(const table of ['c_slack_links','c_slack_challenges','c_slack_threads']) assert.equal((await h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n,0);
    const before=await snapshot(h); assert.equal((await deliverSlack(h,edge,event)).status,403);assert.deepEqual(await snapshot(h),before);
    const comments=(await h.db.prepare('SELECT * FROM c_comments').all()).results;assert.ok(!comments.some(c=>c.body==='Harbour Bank, the pitch team'));
    assert.ok((await h.db.prepare('SELECT * FROM c_slack_answers').all()).results.every(r=>r.comment_id===null),'only opaque replay identity survives erasure');
  } finally {await h.close();}
});
