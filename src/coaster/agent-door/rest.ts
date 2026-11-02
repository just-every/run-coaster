import { runtimeBindings, type Bindings } from '../../auth.server';
import { coasterAgentDoor } from './index';
import { agent } from '../session';
import { requireThat, type Data } from '../types';

type PersonalTool = 'coaster.workspace.get' | 'coaster.proposals.get' | 'coaster.claims.propose' | 'coaster.batches.propose';

async function boundedBody(request: Request, limit: number): Promise<Data> {
  requireThat(Number(request.headers.get('content-length') ?? 0) <= limit, 'The request is too large', 413);
  const reader = request.body?.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > limit) { await reader.cancel(); requireThat(false, 'The request is too large', 413); }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { requireThat(false, 'The request body must be valid UTF-8 JSON'); }
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'The request body must be a JSON object');
  return value;
}

const instructions: Record<string, string> = {
  approval_required: 'Open the approval URL. After the named person approves, retry with the same inputs and key, or requestState for a read.',
  policy_unset: 'Ask the company policy administrator to complete setup at setup_url, then retry.',
  policy_blocked: 'Company policy blocks this action. Ask the policy administrator to review the cited rule.',
  agents_paused: 'Company agents are paused. Ask the administrator to resume them before retrying.',
  idempotency_key_required: 'Supply a stable Idempotency-Key header or idempotency_key field for this preparation.',
  idempotency_conflict: 'This key belongs to different inputs. Retry the original inputs or use a new key for a new preparation.',
  approval_rejected: 'The named person rejected this request. A new request requires a new key or a fresh read.',
  approval_expired: 'This approval expired. Start a new request with a new key or a fresh read.',
};
function refusalStatus(code: string): number {
  if (code === 'unauthenticated') return 401;
  if (code === 'resource_unavailable') return 404;
  if (['policy_blocked', 'insufficient_scope', 'native_authority_required'].includes(code)) return 403;
  if (code === 'rate_limited') return 429;
  if (['invalid_arguments', 'idempotency_key_required'].includes(code)) return 400;
  if (['execution_failed', 'output_invalid'].includes(code)) return 500;
  return 409;
}

/** Fixed personal-key routes translate to the exported door; there is no native fallback. */
export async function personalAgentRest(request: Request, original: Bindings, name: PersonalTool, id?: string): Promise<Response> {
  const env = runtimeBindings(original), url = new URL(request.url);
  // Keep the REST credential family narrow, even when MCP also accepts Business tokens.
  await agent(request, env);
  requireThat(!request.headers.has('origin') || request.headers.get('origin') === env.AUTH_ORIGIN, 'Origin refused', 403);
  requireThat(!url.searchParams.has('access_token'), 'Use the Authorization header', 401);
  const mutation = name.endsWith('.propose');
  const args = mutation ? await boundedBody(request, name === 'coaster.claims.propose' ? 8_000_000 : 3_000_000) : id === undefined ? {} : { id };
  const key = request.headers.get('idempotency-key');
  requireThat(!key || args.idempotency_key === undefined || args.idempotency_key === key, 'Idempotency keys must match');
  if (mutation && key) args.idempotency_key = key;
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json');
  headers.set('mcp-protocol-version', '2026-07-28');
  headers.set('mcp-method', 'tools/call');
  headers.set('mcp-name', name);
  const response = await (await coasterAgentDoor(env)).handle(new Request(new URL('/mcp', url), {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name, arguments: args, ...(url.searchParams.has('requestState') ? { requestState: url.searchParams.get('requestState') } : {}),
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
    } }),
  }));
  requireThat(response, 'The agent door is unavailable', 503);
  const wire = await response.json() as Data;
  const result = wire.result, meta = result?._meta ?? {}, decision = meta['com.runeditrun/decision'] ?? null;
  const outgoing = new Headers({ 'cache-control': 'no-store' });
  if (decision) outgoing.set('x-coaster-agent-decision', JSON.stringify(decision));
  if (meta['com.runeditrun/review']) outgoing.set('x-coaster-agent-review', JSON.stringify(meta['com.runeditrun/review']));
  for (const header of ['www-authenticate', 'retry-after']) if (response.headers.has(header)) outgoing.set(header, response.headers.get(header)!);
  if (result?.resultType === 'input_required') return Response.json({
    code: 'approval_required', error: instructions.approval_required, approval: meta['com.runeditrun/approval'], requestState: result.requestState, decision,
  }, { status: 202, headers: outgoing });
  if (response.ok && result?.isError === false) return Response.json(result.structuredContent, { headers: outgoing });
  const failure = meta['com.runeditrun/error'] ?? wire.error?.data ?? {};
  const code = failure.code ?? 'invalid_arguments';
  return Response.json({ ...failure, code, error: instructions[code] ?? 'The agent door refused this request. Check the code and current authority before retrying.', decision }, {
    status: response.ok ? refusalStatus(code) : response.status, headers: outgoing,
  });
}
