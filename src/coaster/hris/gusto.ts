import type { Bindings } from '../../auth.server';
import { seal, unseal } from '../public-api/crypto';
import { gustoJson } from '../payroll/network';
import { providerId } from '../payroll/model';
import { needRow, rowAuthority } from '../permissions';
import { all, commit, sha256Hex, type Sql } from '../session';
import { event } from '../events';
import { handOver, openWork } from '../handoff';
import { email, now, requireThat, text, type Actor, type Data } from '../types';

type Connection = { company_uuid: string; company_name: string; token_sealed: string; connected_at: string };
const connection = (env: Bindings) => env.DB.prepare('SELECT * FROM c_hris_connection WHERE id=1').first<Connection>();
const state = (c: Connection): Sql => ({ sql: 'EXISTS(SELECT 1 FROM c_hris_connection WHERE id=1 AND company_uuid=? AND token_sealed=?)', params: [c.company_uuid, c.token_sealed] });
function access(actor: Actor) {
  needRow(actor, 'connections');
  requireThat(actor.kind === 'person' && !actor.publicCredential, 'Use a native session for HRIS', 403);
  return rowAuthority(actor, 'connections');
}
function syncAccess(actor: Actor) {
  access(actor);
  needRow(actor, 'people');
  return rowAuthority(actor, 'people');
}
async function current(env: Bindings, actor: Actor, c?: Connection, writing = false) {
  const auth = all(writing ? syncAccess(actor) : access(actor), ...(c ? [state(c)] : []));
  requireThat(await env.DB.prepare(`SELECT (${auth.sql}) AS ok`).bind(...auth.params).first<{ok:number}>().then(r=>r?.ok), 'HRIS access or connection changed; reload', 409);
}
export async function hrisStatus(env: Bindings, actor: Actor) {
  access(actor);
  const c = await connection(env);
  return { connection: c ? { company_uuid: c.company_uuid, company_name: c.company_name, connected_at: c.connected_at } : null };
}
export async function connectHris(env: Bindings, actor: Actor, b: Data) {
  const auth = access(actor);
  requireThat(b.consent === true, 'Explicit consent to read this Gusto sandbox roster is required');
  requireThat(!await connection(env), 'Disconnect the current HRIS company first', 409);
  const company = providerId(b.company), token = text(b.token, 'Gusto sandbox token', 4000);
  await current(env, actor);
  const data = await gustoJson(token, `/v1/companies/${company}`);
  requireThat((data.uuid ?? data.company_uuid) === company, 'The token belongs to another Gusto company', 409);
  await commit(env.DB, all(auth, {sql:'NOT EXISTS(SELECT 1 FROM c_hris_connection)',params:[]}), [
    env.DB.prepare('INSERT INTO c_hris_connection VALUES(1,?,?,?,?,?)').bind(company,text(data.name ?? data.trade_name,'Company name',200),await seal(env.SESSION_SECRET,'hris:'+company,token),actor.email,now()),
    event(env.DB,actor,'hris-connected',{}, {company, consent:true, provider:'Gusto sandbox'}),
  ]);
  return hrisStatus(env,actor);
}
export async function disconnectHris(env: Bindings, actor: Actor) {
  const auth = access(actor), c = await connection(env);
  requireThat(c, 'HRIS is not connected', 409);
  await commit(env.DB,all(auth,state(c)),[env.DB.prepare('DELETE FROM c_hris_connection'),env.DB.prepare('DELETE FROM c_hris_mappings'),event(env.DB,actor,'hris-disconnected',{}, {company:c.company_uuid})]);
  return {connection:null};
}
async function roster(env: Bindings, actor: Actor, c: Connection, writing: boolean) {
  const rows: Data[] = [];
  for(let page=1;page<=20;page++) {
    await current(env,actor,c,writing);
    const data = await gustoJson(await unseal(env.SESSION_SECRET,'hris:'+c.company_uuid,c.token_sealed),`/v1/companies/${c.company_uuid}/employees?page=${page}&per=100`);
    requireThat(Array.isArray(data),'Invalid Gusto roster',502);
    for(const p of data) {
      requireThat(typeof p.terminated === 'boolean','Gusto must report explicit employee status',502);
      rows.push({employee:providerId(p.uuid),name:text([p.first_name,p.last_name].filter(Boolean).join(' '),'Employee name',120),email:p.email ? email(p.email) : null,manager:p.manager_uuid ? providerId(p.manager_uuid) : p.manager?.uuid ? providerId(p.manager.uuid) : null,terminated:p.terminated});
    }
    if(data.length<100) {
      requireThat(new Set(rows.map(r=>r.employee)).size===rows.length,'Duplicate employee in Gusto roster',502);
      return rows;
    }
  }
  requireThat(false,'Gusto roster exceeds the supported limit',409);
  return rows;
}
const memberColumns = 'email,name,is_employee,is_manager,is_finance,is_auditor,is_admin,is_card_admin,is_bookkeeper,department_id,approver_email,active,may_release,is_contractor,updated_at'.split(',');
const snapshotQuery = (table: string, columns: string[], order: string) => `SELECT COALESCE(json_group_array(json(row)), '[]') AS value FROM (SELECT json_object(${columns.flatMap(c=>["'"+c+"'",c]).join(',')}) AS row FROM ${table} ORDER BY ${order})`;
const memberQuery = snapshotQuery('c_members',memberColumns,'email');
const mappingQuery = snapshotQuery('c_hris_mappings',['employee_uuid','email','company_uuid'],'employee_uuid');
async function review(env: Bindings, actor: Actor, writing = false) {
  access(actor); const c = await connection(env);
  requireThat(c,'Connect HRIS first',409);
  const employees = await roster(env,actor,c,writing);
  const memberSnapshot = (await env.DB.prepare(memberQuery).first<{value:string}>())!.value;
  const mappingSnapshot = (await env.DB.prepare(mappingQuery).first<{value:string}>())!.value;
  const members: Data[] = JSON.parse(memberSnapshot), mappings: Data[] = JSON.parse(mappingSnapshot);
  await current(env,actor,c,writing);
  return {c,employees,members,mappings,memberSnapshot,mappingSnapshot,fingerprint:await sha256Hex(JSON.stringify([c.company_uuid,employees,members,mappings]))};
}
export async function previewHris(env: Bindings, actor: Actor) {
  const {employees,members,mappings,fingerprint} = await review(env,actor);
  return {employees,members:members.map(m=>({email:m.email,name:m.name,active:m.active,is_manager:m.is_manager})),mappings,fingerprint};
}
export async function syncHris(env: Bindings, actor: Actor, b: Data) {
  const auth = syncAccess(actor);
  requireThat(b.consent===true,'Confirm the exact roster change first');
  const r = await review(env,actor,true), {c,members,mappings} = r;
  requireThat(b.fingerprint===r.fingerprint,'The roster changed; review it again',409);
  const p = r.employees.find(p=>p.employee===b.employee);
  requireThat(p,'Choose a reviewed Gusto employee',400);
  const address = email(b.email), mapping = mappings.find(m=>m.employee_uuid===p.employee);
  requireThat(!mapping || mapping.email===address,'A mapped employee cannot be reassigned to another identity',409);
  requireThat(!mappings.some(m=>m.email===address && m.employee_uuid!==p.employee),'This person already maps to another employee',409);
  const before = members.find(m=>m.email===address);
  requireThat(!await env.DB.prepare("SELECT 1 FROM oa_operators WHERE lower(email)=? AND role='owner'").bind(address).first(),'HRIS cannot change the owner',403);
  requireThat(address!==actor.email && address!==actor.delegate?.email,'HRIS cannot change its current operator',403);
  requireThat(before || !p.terminated,'An unknown terminated employee is not imported',409);
  requireThat(!before || before.active || p.terminated,'Reactivate a person explicitly in People before syncing',409);
  let manager: string | null = null;
  if(p.manager) {
    manager = mappings.find(m=>m.employee_uuid===p.manager)?.email ?? null;
    requireThat(!r.employees.find(e=>e.employee===p.manager)?.terminated && manager && manager!==address && members.some(m=>m.email===manager && m.active && m.is_manager),'Map the manager to an active native approver first',409);
    let next: string | null = manager; const seen = new Set([address]);
    while(next) { requireThat(!seen.has(next),'The manager hierarchy would contain a cycle',409); seen.add(next); next=members.find(m=>m.email===next)?.approver_email ?? null; }
  }
  const guards: Sql[] = [
    {sql:`(${memberQuery})=?`,params:[r.memberSnapshot]},
    {sql:`(${mappingQuery})=?`,params:[r.mappingSnapshot]},
  ];
  const statements: D1PreparedStatement[]=[];
  if(before?.active && p.terminated) {
    const work = await openWork(env.DB,address), successor = b.successor ? email(b.successor,'Successor') : manager ?? before.approver_email;
    const relationships = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM c_members WHERE approver_email=?) AS reports,(SELECT COUNT(*) FROM c_departments WHERE head_email=?) AS heads').bind(address,address).first<{reports:number;heads:number}>();
    if(work.manager || work.finance || work.cards || relationships!.reports || relationships!.heads) {
      const to = members.find(m=>m.email===successor && m.active);
      requireThat(to && to.email!==address && !r.employees.some(e=>e.terminated && mappings.some(m=>m.employee_uuid===e.employee && m.email===to.email)),'Choose an active successor before termination',409);
      requireThat((!(work.manager || relationships!.heads) || to.is_manager) && (!work.finance || to.is_finance) && (!work.cards || to.is_employee),'The successor must hold every role needed by open work',409);
      const handoff = await handOver(env.DB,actor,address,to.email);
      statements.push(...handoff.statements); guards.push(...handoff.guards);
    }
  }
  if(before) statements.push(env.DB.prepare('UPDATE c_members SET name=?,approver_email=?,active=?,updated_at=? WHERE email=?').bind(p.name,manager,p.terminated?0:1,now(),address));
  else statements.push(env.DB.prepare('INSERT INTO c_members(email,name,is_employee,is_manager,is_finance,active,approver_email,updated_at) VALUES(?,?,1,0,0,1,?,?)').bind(address,p.name,manager,now()));
  statements.push(env.DB.prepare('INSERT INTO c_hris_mappings VALUES(?,?,?) ON CONFLICT(employee_uuid) DO NOTHING').bind(p.employee,address,c.company_uuid),event(env.DB,actor,'hris-synced',{}, {company:c.company_uuid,email:address,before:before ? {name:before.name,manager:before.approver_email,active:!!before.active}:null,after:{name:p.name,manager,active:!p.terminated},cardFreeze:'not available; issuing program required'}));
  await commit(env.DB,all(auth,state(c),...guards),statements);
  return {synced:true,cardFreeze:'unavailable'};
}
