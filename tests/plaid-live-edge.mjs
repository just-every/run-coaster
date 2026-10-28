/** Forward actual provider requests across Node and workerd without carrying hop-by-hop framing or double decompression. */
export async function plaidLiveResponse(request) {
  const headers = new Headers(request.headers);
  for (const name of ['content-length','host','connection','transfer-encoding']) headers.delete(name);
  const response = await fetch(request.url, { method: request.method, headers, body: await request.text(), redirect: 'manual', signal: AbortSignal.timeout(25_000) });
  const returned = new Headers(response.headers);
  returned.delete('content-encoding'); returned.delete('content-length');
  return new Response(await response.arrayBuffer(), { status: response.status, headers: returned });
}
