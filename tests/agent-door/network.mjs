// Test-only public-rate network edge. Native pricing and persistence run in Coaster.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.href !== 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml' || request.headers.has('authorization') || (await request.arrayBuffer()).byteLength) return new Response('Invalid public-rate request', { status: 400 });
    return new Response(`<gesmes:Envelope><Cube><Cube time='2026-10-28'><Cube currency='USD' rate='1.25'/><Cube currency='GBP' rate='0.85'/></Cube></Cube></gesmes:Envelope>`, { headers: { 'Content-Type': 'application/xml' } });
  },
};
