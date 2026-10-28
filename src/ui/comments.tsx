import { useState } from 'react';
import { call, moment, type D } from './api';
import { Badge, Field, Form } from './parts';

/** Comments and questions on a claim, with no decision attached: a question names who should answer and stays open
    until they reply. A comment can be corrected until anyone replies. */
export function Comments({ claim, items, comments, state, onDone }: { claim: D; items: D[]; comments: D[]; state: D; onDone: () => Promise<void> }) {
  const [editing, setEditing] = useState<string | null>(null), [replying, setReplying] = useState<string | null>(null);
  const [delivery,setDelivery]=useState('');
  const me = state.actor.delegate?.email ?? state.actor.email, names: Record<string, string> = state.names, name = (email: string) => names[email] ?? email;
  const merchant = (item: string | null) => item ? items.find((i: D) => i.id === item)?.merchant ?? 'a removed expense' : null;
  const top = comments.filter((c: D) => !c.parent_id), replies = (id: string) => comments.filter((c: D) => c.parent_id === id);
  const askable = Object.keys(names).filter(email => email !== state.actor.email && email !== me);
  const line = (c: D) => <>
    <p className="comment-head"><strong>{name(c.author_email)}</strong>{c.on_behalf_of ? ` on behalf of ${name(c.on_behalf_of)}` : ''}{c.asks_email ? ` asked ${name(c.asks_email)}` : ''}{merchant(c.item_id) && !c.parent_id ? ` about ${merchant(c.item_id)}` : ''} · <time dateTime={c.created_at}>{moment(c.created_at)}</time>{c.edited_at ? ' · edited' : ''}</p>
    {editing === c.id
      ? <Form label="Save comment" onSubmit={async v => { await call(`comments/${c.id}/edit`, { body: v.body }); setEditing(null); await onDone(); }} secondary={<button type="button" className="button" onClick={() => setEditing(null)}>Cancel</button>}>
          <Field label="Comment" name="body" type="textarea" defaultValue={c.body} maxLength={2000} />
        </Form>
      : <p className="comment-body">{c.body}</p>}
  </>;
  return <section className="panel-block" aria-label="Comments">
    <h3>Comments and questions</h3>
    {delivery && <p role="status">{delivery}</p>}
    {top.length ? <ul className="ruled-list comments">{top.map((c: D) => <li key={c.id} className="comment">
      {c.asks_email && <Badge status={c.open ? 'submitted' : 'approved'} words={c.open ? 'Open question' : 'Answered'} />}
      {line(c)}
      {replies(c.id).length > 0 && <ul className="comment-replies">{replies(c.id).map((r: D) => <li key={r.id}>{line(r)}</li>)}</ul>}
      <span className="line-actions">
        {c.author_email === me && c.replies === 0 && editing !== c.id && <button className="button small" onClick={() => setEditing(c.id)}>Edit</button>}
        {replying !== c.id && <button className="button small" onClick={() => setReplying(c.id)}>{c.open && c.asks_email === state.actor.email ? 'Answer' : 'Reply'}</button>}
      </span>
      {replying === c.id && <Form label={c.open && c.asks_email === state.actor.email ? 'Send answer' : 'Send reply'} onSubmit={async v => { await call(`claims/${claim.id}/comments`, { parent: c.id, body: v.body }); setReplying(null); await onDone(); }} secondary={<button type="button" className="button" onClick={() => setReplying(null)}>Cancel</button>}>
        <Field label="Reply" name="body" type="textarea" maxLength={2000} />
      </Form>}
    </li>)}</ul> : <p className="muted">No comments yet. Asking a question leaves the claim where it is.</p>}
    <div className="sub-form"><Form label="Add comment" onSubmit={async (v, form) => { const result=await call(`claims/${claim.id}/comments`, { body: v.body, item: v.item || null, asks: v.asks || null }); setDelivery(result.slack==='sent'?'Question sent to Slack.':result.slack==='not delivered'?'Question saved. Slack delivery failed; answer in Coaster.':''); form.reset(); await onDone(); }}>
      <Field label="Comment or question" name="body" type="textarea" maxLength={2000} placeholder="Which client was this for?" />
      {items.length > 0 && <Field label="About" name="item" required={false} options={items.map((i: D) => ({ value: i.id, label: i.merchant }))} hint="Leave empty for the whole claim" />}
      <Field label="Ask" name="asks" required={false} options={askable.map(email => ({ value: email, label: name(email) }))} hint="Name someone to make it a question" />
    </Form></div>
  </section>;
}
