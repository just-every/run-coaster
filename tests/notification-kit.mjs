export const address = name => [name,'harbourfinch.example'].join('@');
export const preferences = extra => ({ timezone: 'America/Los_Angeles', quietFrom: 20, quietUntil: 9, submission: 'digest', decision: 'immediate', return: 'digest', reminder: 'immediate', ...extra });
export const tick = async (h, at) => (await h.mf.getWorker()).scheduled({ scheduledTime: new Date(at), cron: '17 * * * *' });
export const notifications = h => h.messages.filter(m => ['Coaster notification','Your Coaster daily digest'].includes(m.subject));
export async function expense(h, team, title, submit = true) {
  let claim = await h.post('claims', { title }, team.sam);
  claim = await h.post(`claims/${claim.id}/items`, { version: claim.version, kind: 'receipt', date: '2027-03-11', merchant: 'Private merchant for ' + title, amount: '10.00', purpose: 'Private client purpose', explanation: 'Original receipt lost', allocations: [{ category: team.c.office }] }, team.sam);
  return submit ? h.post(`claims/${claim.id}/submit`, { version: claim.version }, team.sam) : claim;
}
export const decision = (h, team, claim, value = 'approved') => h.post(`claims/${claim.id}/decision`, { version: claim.version, revision: claim.revision, decision: value, acknowledge: true, reason: 'Private decision reason' }, team.priya);
