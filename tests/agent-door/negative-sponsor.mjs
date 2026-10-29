import assert from 'node:assert/strict';
import { sessions, sponsors } from './state.mjs';
export default async function ({ label, sub, email }) {
  const response = sessions.get(label);
  assert.ok(response, 'The native invitation lifecycle must have completed');
  sessions.delete(label);
  sponsors[label] = { sub, email };
  return response;
}
