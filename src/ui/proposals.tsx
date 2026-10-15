import { call, claimNumber, money, moment, type D } from './api';
import { go } from './app';
import { useState } from 'react';

/** Work an agent prepared for this person; nothing happens until they accept it. */
export function Proposals({ proposals, reload, claims = [] }: { proposals: D[]; reload: () => Promise<D>; claims?: D[] }) {
  const [error, setError] = useState('');
  async function decide(p: D, accept: boolean) {
    setError('');
    try {
      const result = await call(`proposals/${p.id}/${accept ? 'accept' : 'decline'}`, {});
      await reload();
      if (accept) p.kind === 'batch' ? go('batches', result.batch.id) : go('claims', result.claim.id);
    } catch (e) { setError((e as Error).message); }
  }
  return <div className="proposals">
    <h2>Prepared for you</h2>
    <ul className="ruled-list">{proposals.map(p => {
      const total = p.kind === 'claim' ? p.payload.items.reduce((n: number, i: D) => n + i.amountMinor, 0) : claims.filter(c => p.payload.claims.includes(c.id)).reduce((n, c) => n + c.total_minor, 0);
      return <li key={p.id} className="proposal">
        <p className="proposal-head"><strong>{p.kind === 'claim' ? p.payload.title : `Batch of ${p.payload.claims.length} approved claims`}</strong><span className="amount">{money(total)}</span></p>
        <p className="muted">Prepared by {p.agent_label} on {moment(p.created_at)}{p.kind === 'claim' ? ` · ${p.payload.items.length} expense${p.payload.items.length === 1 ? '' : 's'}` : ` · ${claims.filter(c => p.payload.claims.includes(c.id)).map(c => claimNumber(c.number)).join(', ')}`}</p>
        {p.payload.note && <p className="muted">“{p.payload.note}”</p>}
        <div className="actions"><button className="button dark" onClick={() => decide(p, true)}>{p.kind === 'claim' ? 'Accept as draft' : 'Accept as draft batch'}</button><button className="button" onClick={() => decide(p, false)}>Decline</button></div>
      </li>;
    })}</ul>
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}
