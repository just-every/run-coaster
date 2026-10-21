import { useEffect, useRef, useState } from 'react';
import { acting, apiHref, call, type D } from './api';
import { Badge, Details, Empty, Field, Form, Section } from './parts';

const formats = 'image/jpeg,image/png,image/webp,image/heic,application/pdf';
const bytes = (size: number) => `${size.toLocaleString()} bytes`;

/** Independent per-file uploads keep successful receipts when another file is refused. */
export function ReceiptInbox() {
  const [receipts, setReceipts] = useState<D[]>([]), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(''), [failures, setFailures] = useState<string[]>([]);
  const working = useRef(false), [over, setOver] = useState(false);
  const reload = async () => { const data = await call('receipt-inbox'); setReceipts(data.receipts); };
  useEffect(() => { reload().catch(e => setError(e.message)); }, []);
  async function upload(files: File[], source = 'upload') {
    if (working.current || !files.length) return;
    working.current = true; setBusy(true); setError(''); setFailures([]);
    const refused: string[] = []; let saved = 0;
    try {
      for (const [index, file] of files.entries()) {
        setProgress(`Uploading ${index + 1} of ${files.length}: ${file.name}`);
        try {
          const body = new FormData(); body.set('file', file); body.set('source', source);
          const response = await fetch('/api/coaster/receipt-inbox', { method: 'POST', headers: acting() ? { 'x-coaster-acting-for': acting() } : {}, body });
          const value: D = await response.json();
          if (!response.ok) throw new Error(value.error || 'Upload refused; try again');
          setReceipts(previous => [value.receipt, ...previous]); saved++;
        } catch (e) { refused.push(`${file.name}: ${(e as Error).message}`); setFailures([...refused]); }
      }
      setProgress(`${saved} of ${files.length} receipts saved${refused.length ? `; ${refused.length} refused` : ''}.`);
    } finally { working.current = false; setBusy(false); }
  }
  const cards = (rows: D[]) => <ul className="receipt-inbox-list">{rows.map(receipt => <li key={receipt.id}>
      <div className="section-head"><a href={apiHref(`receipt-inbox/${receipt.id}`)}>{receipt.name}</a><Badge status={receipt.state} words="Needs attention" tone="wait" /></div>
      <p className="muted">{receipt.attentionReason}</p>
      <Details label="File provenance"><dl><dt>Size and format</dt><dd>{bytes(receipt.size)} · {receipt.mediaType}</dd><dt>Uploaded by</dt><dd>{receipt.uploadedBy}</dd><dt>Received</dt><dd>{receipt.uploadedAt}</dd><dt>Source</dt><dd>{receipt.source}</dd><dt>SHA-256</dt><dd className="receipt-fingerprint">{receipt.sha256}</dd></dl><ol>{receipt.history.map((event: D) => <li key={event.sequence} value={event.sequence}>{event.state.replaceAll('-', ' ')} · {event.at} · {event.actorEmail}{event.onBehalfOf ? ` for ${event.onBehalfOf}` : ''} · {event.channel}{event.reason ? ` · ${event.reason}` : ''}</li>)}</ol></Details>
      {receipt.disposition === 'active' ? <>
        <Details label={`Discard ${receipt.name}`}><p>The original and your reason stay in your private history. This cannot be undone.</p><Form label="Discard receipt" onSubmit={async values => { await call(`receipt-inbox/${receipt.id}/discard`, { reason: values.reason, expectedSequence: receipt.lifecycleSequence }); await reload(); }}><Field label="Reason" name="reason" type="textarea" maxLength={1000} /></Form></Details>
        {receipts.some(other => other.id !== receipt.id && other.disposition === 'active') && <Details label={`Merge ${receipt.name} into another receipt`}><p>This receipt is retired as a duplicate and stays in your private history; the receipt you keep is not changed. A reason is needed unless both files are identical. This cannot be undone.</p><Form label="Merge receipt" onSubmit={async values => { await call(`receipt-inbox/${receipt.id}/merge`, { survivorId: values.survivorId, reason: values.reason, expectedSequence: receipt.lifecycleSequence }); await reload(); }}><Field label="Receipt to keep" name="survivorId" options={receipts.filter(other => other.id !== receipt.id && other.disposition === 'active').map(other => ({ value: other.id, label: `${other.name} · ${other.uploadedAt}${other.sha256 === receipt.sha256 ? ' · identical file' : ''}` }))} /><Field label="Reason" name="reason" type="textarea" required={false} maxLength={1000} /></Form></Details>}
      </> : <section aria-label={`Disposition of ${receipt.name}`}><h4>{receipt.disposition === 'merged' ? 'Merged' : 'Discarded'}</h4><ol>{receipt.lifecycle.map((event: D) => <li key={event.sequence} value={event.sequence}>{event.kind}{event.survivorId ? ` into ${receipts.find(other => other.id === event.survivorId)?.name ?? 'another receipt'}` : ''} · {event.at} · {event.actorEmail}{event.onBehalfOf ? ` for ${event.onBehalfOf}` : ''} · {event.channel}{event.reason ? <p>{event.reason}</p> : <p>Identical file</p>}</li>)}</ol></section>}
    </li>)}</ul>;
  const active = receipts.filter(receipt => receipt.disposition === 'active'), discarded = receipts.filter(receipt => receipt.disposition === 'discarded'), merged = receipts.filter(receipt => receipt.disposition === 'merged');
  return <Section title="Receipt inbox" className="receipt-inbox" label="Receipt inbox">
    <p className="muted">Keep receipts here before you enter their expenses. JPEG, PNG, WebP, HEIC and multi-page PDF, up to 10 MB each. Reading is unavailable; enter expense details by hand.</p>
    <div className={`receipt-drop${over ? ' receipt-drop-over' : ''}`} role="group" aria-label="Drop receipt files" aria-busy={busy}
      onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); upload([...e.dataTransfer.files]); }}>
      <p>Drop receipt files here, or choose files below.</p>
      <label className="field"><span className="field-label">Upload receipts</span><input type="file" multiple accept={formats} disabled={busy} onChange={e => { upload([...(e.target.files ?? [])]); e.target.value = ''; }} /></label>
      <label className="field"><span className="field-label">Photograph a receipt</span><input type="file" accept="image/*" capture="environment" disabled={busy} onChange={e => { upload([...(e.target.files ?? [])], 'camera'); e.target.value = ''; }} /></label>
    </div>
    <p role="status" aria-live="polite">{progress}</p>
    {error && <p role="alert" className="form-error">{error} <button className="button small" onClick={() => reload().then(() => setError('')).catch(e => setError(e.message))}>Reload inbox</button></p>}
    {failures.length > 0 && <div role="alert"><ul>{failures.map((failure, i) => <li key={i}>{failure}</li>)}</ul><p>Saved receipts remain in your inbox. Choose a smaller file to retry a refused upload.</p></div>}
    <section aria-label="Active receipts">{active.length ? cards(active) : <Empty title="Your inbox is empty">Upload or photograph a receipt to keep its original here.</Empty>}</section>
    {discarded.length > 0 && <section aria-label="Discarded receipts"><h3>Discarded receipts</h3><p className="muted">Originals remain downloadable. Discarded receipts stay here as history and cannot return to the active inbox.</p>{cards(discarded)}</section>}
    {merged.length > 0 && <section aria-label="Merged receipts"><h3>Merged receipts</h3><p className="muted">Originals remain downloadable. A merged duplicate stays here as history and cannot return to the active inbox.</p>{cards(merged)}</section>}
  </Section>;
}
