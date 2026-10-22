import { useState } from 'react';
import { apiHref, type D } from './api';

const names: Record<string, string> = { merchant: 'Merchant', date: 'Purchase date', total: 'Total', subtotal: 'Subtotal', salesTax: 'Sales tax', tip: 'Tip', currency: 'Currency', last4: 'Card last four', lineItems: 'Line items' };

/** Keep each field's evidence beside the unchanged private original. Coordinates are normalized to its page. */
export function ReadingFields({ fields, receipt }: { fields: D; receipt: D }) {
  const [region, setRegion] = useState<D>();
  const original = apiHref(`receipt-inbox/${receipt.id}?inline=1`);
  return <>
    <dl>{Object.entries(fields).map(([key, value]) => { const field = value as D; return <div key={key}>
      <dt>{names[key] ?? key}</dt><dd>
        {Array.isArray(field.value) ? <ul>{field.value.map((item: D, i: number) => <li key={i}>{item.description} · {item.amount}{item.quantity ? ` · quantity ${item.quantity}` : ''}</li>)}</ul> : field.value ?? 'Not read'}
        {' · '}{field.review ? 'Needs review' : field.source === 'person' ? 'Confirmed by you' : 'Read'}{typeof field.confidence === 'number' && ` · ${Math.round(field.confidence * 100)}%`}
        {field.reasons?.length > 0 && <p>{field.reasons.join('; ')}</p>}
        {field.regions?.map((r: D, i: number) => <p key={i}><button className="button small" type="button" onClick={() => setRegion({ ...r, field: names[key] ?? key })}>Show {names[key]?.toLowerCase() ?? key} on page {r.page}</button></p>)}
      </dd>
    </div>; })}</dl>
    {region && <section aria-label="Receipt field evidence"><h3>{region.field} · original page {region.page}</h3>
      <p>Region {region.x}, {region.y}, {region.width}, {region.height} (fractions of the original page).</p>
      {['image/png', 'image/jpeg', 'image/webp'].includes(receipt.mediaType) ? <div style={{ position: 'relative', maxWidth: '100%' }}>
        <img src={original} alt={`Original receipt showing ${region.field}`} style={{ display: 'block', width: '100%', height: 'auto' }} />
        <span aria-hidden="true" style={{ position: 'absolute', pointerEvents: 'none', left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%`, outline: '3px solid currentColor' }} />
      </div> : <a href={`${original}#page=${region.page}`} target="_blank" rel="noreferrer">Open original page {region.page}</a>}
      <button className="button small" type="button" onClick={() => setRegion(undefined)}>Close field evidence</button>
    </section>}
  </>;
}
