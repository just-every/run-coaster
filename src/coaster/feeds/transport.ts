import { connect } from '@workeryard/undershell/workers';
import { Fault, requireThat } from '../types';
import { STATEMENT_LIMIT } from '../cards/statement';

export type SftpCredentials = { host: string; port: number; username: string; privateKey: string; hostKeyFingerprint: string; directory: string };
export type Delivery = { name: string; content: string; size: number };

/** Real SSH public-key authentication and host-key verification over the Worker's outbound TCP socket. */
export async function pullDeliveries(credentials: SftpCredentials, authorized: () => Promise<void>, receive: (file: Delivery) => Promise<void>, knownNames: ReadonlySet<string> = new Set()) {
  await authorized();
  const client = await connect({ host: credentials.host, port: credentials.port, username: credentials.username, auth: { kind: 'privateKey', privateKey: credentials.privateKey }, hostKeyFingerprint: credentials.hostKeyFingerprint, timeoutMs: 15_000 });
  const deadline = setTimeout(() => { void client.close().catch(() => {}); }, 45_000);
  try {
    await authorized();
    const sftp = await client.sftp();
    const entries=[];
    for await (const entry of sftp.readdir(credentials.directory)) {
      requireThat(entries.length < 1000, 'The SFTP delivery directory has too many entries; use a dedicated drop', 409);
      entries.push(entry);
    }
    // New names are read first, so rereading a retained old file never starves a later delivery.
    entries.sort((a,b)=>Number(knownNames.has(a.name))-Number(knownNames.has(b.name))||a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.directory || !entry.name.endsWith('.csv')) continue;
      requireThat(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}\.csv$/.test(entry.name) && !/\d(?:[-_ ]?\d){12,18}/.test(entry.name), 'An SFTP delivery has an unsafe filename', 409);
      requireThat(entry.size === null || entry.size <= STATEMENT_LIMIT, 'An SFTP delivery exceeds the supported file size', 409);
      await authorized();
      const reader = sftp.createReadStream(`${credentials.directory.replace(/\/$/, '')}/${entry.name}`, { concurrency: 1, chunkSize: 16_384 }).getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          await authorized();
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          requireThat(size <= STATEMENT_LIMIT, 'An SFTP delivery exceeds the supported file size', 409);
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const data = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); }
      catch { throw new Fault(409, 'An SFTP delivery is not UTF-8 CSV'); }
      await authorized();
      await receive({ name: entry.name, content, size });
    }
  } finally { clearTimeout(deadline); await client.close().catch(() => {}); }
}
