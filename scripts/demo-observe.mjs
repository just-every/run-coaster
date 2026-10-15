// Observe the test host through run-demo's account-scoped credential before a
// fresh-start cohort. Keep admission metadata only, never headers or cookies.
import { readFile, writeFile } from 'node:fs/promises';
import WebSocket from 'ws';

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (account !== 'b20c0ca9cab0c2b70e13d7cf724b89bd' || process.env.DEMO_ENVIRONMENT !== 'demo-test') throw Error('Test host only');
const { name, vars } = JSON.parse(await readFile('.rer/demo-host/wrangler.json', 'utf8'));
if (!vars.DEMO_ORIGIN.startsWith('https://demo.test.')) throw Error('Test origin only');
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${name}/tails`;
const headers = { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' };
const response = await fetch(endpoint, { method: 'POST', headers, body: '{}' });
const value = await response.json();
if (!response.ok || !value.success) throw Error(`Tail refused (${response.status})`);
const tail = value.result, started = Date.now(), admissions = [];
let socket, closed = false, observedAt, ping, heartbeat, closeCode, closedAt, events = 0, reads = 0;
try {
  socket = new WebSocket(tail.url, 'trace-v1');
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', message => {
    events++;
    const event = JSON.parse(typeof message.data === 'string' ? message.data : new TextDecoder().decode(message.data));
    for (const log of event.logs ?? []) for (const part of log.message ?? []) {
      let row; try { row = JSON.parse(part); } catch { continue; }
      if (row.event !== 'demo_admitted') continue;
      const admission = { at: row.at, correlation: row.correlation, agent: row.agent, network: row.network };
      admissions.push(admission);
      console.log(JSON.stringify(admission));
    }
  });
  socket.addEventListener('close', event => { closed = true; closeCode = event.code; closedAt = new Date().toISOString(); });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(Error('Tail connection failed')), { once: true });
  });
  // Match Wrangler's trace-v1 handshake and ping/pong keepalive. A dropped
  // connection invalidates the observation instead of silently leaving a gap.
  socket.send(JSON.stringify({ debug: false }), { binary: false, compress: false, mask: false, fin: true });
  observedAt = Date.now();
  console.log('Observing test host admissions for 15 minutes');
  await new Promise((resolve, reject) => {
    let waitingForPong = false;
    const timer = setTimeout(resolve, 15 * 60_000);
    socket.on('pong', () => { waitingForPong = false; });
    socket.once('close', () => { clearTimeout(timer); reject(Error('Tail disconnected during observation')); });
    ping = setInterval(() => {
      if (waitingForPong) { socket.terminate(); return; }
      waitingForPong = true;
      socket.ping('Coaster demo observation');
    }, 10_000);
    // Keep the log stream active while the host has no visitors. A plain GET
    // does not run the page's Turnstile script or acquire a demo place/cookie.
    const read = async () => {
      try {
        const response = await fetch(vars.DEMO_ORIGIN, { signal: AbortSignal.timeout(10_000) });
        await response.body?.cancel();
        if (response.status !== 200 || response.headers.has('set-cookie')) throw Error('Unexpected start page response');
        reads++;
      } catch {
        clearTimeout(timer);
        reject(Error('Test host observation read failed'));
      }
    };
    heartbeat = setInterval(read, 20_000);
    void read();
  });
  if (closed) throw Error('Tail closed before the observation finished');
} finally {
  const continuous = !closed && Boolean(observedAt), ended = new Date().toISOString();
  clearInterval(ping);
  clearInterval(heartbeat);
  socket?.close();
  const removed = await fetch(`${endpoint}/${tail.id}`, { method: 'DELETE', headers });
  const result = { started: new Date(started).toISOString(), observedAt: observedAt && new Date(observedAt).toISOString(), ended, continuous, closeCode, closedAt, events, reads, admissions, tailRemoved: removed.ok };
  await writeFile('demo-admissions.json', JSON.stringify(result, null, 2) + '\n');
  if (!removed.ok) throw Error('Tail removal failed');
}
if (admissions.length) throw Error('Other visitors started during the observation; do not start the cohort yet');
