import assert from 'node:assert/strict';
import { sessions } from './state.mjs';
export default async function ({ request, origin, mail, label }) {
  const message = mail.read().at(-1);
  assert.ok(message, 'Native invitation was delivered');
  const link = message.text.match(/https?:\/\/[^\s]+\/auth\/confirm\?token=[^\s]+/)?.[0];
  assert.ok(link, 'Native invitation contains a confirmation');
  const response = await request(new URL('/auth/confirm', origin).href, { method: 'POST', redirect: 'manual', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URL(link).searchParams.get('token') }) });
  await response.arrayBuffer();
  // Preserve only the native redirect and its native session headers; no tee keeps a socket alive.
  const redirect = () => new Response(null, { status: response.status, headers: response.headers });
  sessions.set(label, redirect());
  return redirect();
}
