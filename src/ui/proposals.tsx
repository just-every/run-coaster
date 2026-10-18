import { useState, type ReactNode } from 'react';
import { call, claimNumber, money, moment, type D } from './api';
import { go } from './app';

/** The pick's agent strip: the mark, what each agent prepared for this person in one sentence, and the person's two
    choices. Nothing happens until they accept; agents never submit, approve or pay. */
export function AgentStrip({ proposals, reload, claims = [], idle }: { proposals: D[]; reload: () => Promise<D>; claims?: D[]; idle?: ReactNode }) {
  const [error, setError] = useState('');
  async function decide(p: D, accept: boolean) {
    setError('');
    try {
      const result = await call(`proposals/${p.id}/${accept ? 'accept' : 'decline'}`, {});
      await reload();
      if (accept) p.kind === 'batch' ? go('batches', result.batch.id) : go('claims', result.claim.id);
    } catch (e) { setError((e as Error).message); }
  }
  if (!proposals.length && !idle) return null;
  return <section className="agent" aria-label="Prepared for you">
    {proposals.length ? proposals.map(p => {
      const batched = p.kind === 'batch' ? claims.filter(c => p.payload.claims.includes(c.id)) : [];
      const total = p.kind === 'claim' ? p.payload.items.reduce((n: number, i: D) => n + i.amountMinor, 0) : batched.reduce((n, c) => n + c.total_minor, 0);
      const count = p.kind === 'claim' ? p.payload.items.length : p.payload.claims.length;
      return <div className="agent-row" key={p.id}>
        <img className="agent-mark" src="/brand/mark.svg" alt="" />
        <p className="agent-text"><strong>{p.agent_label}:</strong> {p.kind === 'claim'
          ? <>prepared “{p.payload.title}”, {count} expense{count === 1 ? '' : 's'} for {money(total)}, for you to check.</>
          : <>proposed a batch of {count} approved claim{count === 1 ? '' : 's'} ({batched.map(c => claimNumber(c.number)).join(', ')}) for {money(total)}.</>}
          {' '}<span className="muted">{p.payload.note ? `“${p.payload.note}” · ` : ''}{moment(p.created_at)}</span></p>
        <div className="agent-actions"><button className="agent-pill" onClick={() => decide(p, true)}>{p.kind === 'claim' ? 'Accept as draft' : 'Accept as draft batch'}</button><button className="link-button" onClick={() => decide(p, false)}>Decline</button></div>
      </div>;
    }) : <div className="agent-row"><img className="agent-mark" src="/brand/mark.svg" alt="" /><p className="agent-text">{idle}</p></div>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
