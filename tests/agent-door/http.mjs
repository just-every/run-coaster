import assert from 'node:assert/strict';
export function api(request, origin, cookie) {
  return async (path, body, expected = 200) => {
    const response = await request(new URL(path, origin).href, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, expected, `Native door ${path} returned ${response.status}`);
    return response;
  };
}
