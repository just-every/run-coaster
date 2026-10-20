import { useEffect, useRef, useState } from 'react';
import { acting, apiHref, call, type D } from './api';
import { Badge, Details, Empty, Section } from './parts';

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
    {receipts.length ? <ul className="receipt-inbox-list">{receipts.map(receipt => <li key={receipt.id}>
      <div className="section-head"><a href={apiHref(`receipt-inbox/${receipt.id}`)}>{receipt.name}</a><Badge status={receipt.state} words="Needs attention" tone="wait" /></div>
      <p className="muted">{receipt.attentionReason}</p>
      <Details label="File provenance"><dl><dt>Size and format</dt><dd>{bytes(receipt.size)} · {receipt.mediaType}</dd><dt>Uploaded by</dt><dd>{receipt.uploadedBy}</dd><dt>Received</dt><dd>{receipt.uploadedAt}</dd><dt>Source</dt><dd>{receipt.source}</dd><dt>SHA-256</dt><dd className="receipt-fingerprint">{receipt.sha256}</dd></dl><ol>{receipt.history.map((event: D) => <li key={event.sequence} value={event.sequence}>{event.state.replaceAll('-', ' ')} · {event.at} · {event.actorEmail}{event.onBehalfOf ? ` for ${event.onBehalfOf}` : ''} · {event.channel}{event.reason ? ` · ${event.reason}` : ''}</li>)}</ol></Details>
    </li>)}</ul> : <Empty title="Your inbox is empty">Upload or photograph a receipt to keep its original here.</Empty>}
  </Section>;
}
