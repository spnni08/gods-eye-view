/**
 * Cloudflare Pages Function: adsbdb enrichment proxy.
 *
 * Proxies:
 *   GET /api/adsbdb/type/<hex6>      → https://api.adsbdb.com/v0/aircraft/<hex6>
 *   GET /api/adsbdb/route/<callsign> → https://api.adsbdb.com/v0/callsign/<callsign>
 *
 * adsbdb is a free community API with no published quota; requests are
 * enrichment-only (one per tracked aircraft/callsign, fail-silent).
 *
 * Cache: 15 min for positive answers (aircraft/route data rarely changes);
 * no-store for errors so a transient outage doesn't poison the cache.
 *
 * Note: adsbdb's route data "is the work of David Taylor, Edinburgh and
 * Jim Mason, Glasgow, and may not be copied, published, or incorporated
 * into other databases without the explicit permission of David J Taylor".
 * This proxy only serves it at request time, never stores it persistently.
 */

const ADSBDB_BASE = 'https://api.adsbdb.com/v0';
const CACHE_SECONDS = 900; // 15 min

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  // path segments after /api/adsbdb/
  const segments = url.pathname.replace(/^\/api\/adsbdb\/?/, '').split('/');
  const [kind, rawKey] = segments;

  let upstreamUrl;
  if (kind === 'type') {
    const hex = String(rawKey || '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex))
      return new Response(JSON.stringify({ error: 'invalid hex' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    upstreamUrl = `${ADSBDB_BASE}/aircraft/${encodeURIComponent(hex)}`;
  } else if (kind === 'route') {
    const cs = String(rawKey || '').toUpperCase();
    if (!/^[A-Z0-9]{2,8}$/.test(cs))
      return new Response(JSON.stringify({ error: 'invalid callsign' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    upstreamUrl = `${ADSBDB_BASE}/callsign/${encodeURIComponent(cs)}`;
  } else {
    return new Response(JSON.stringify({ error: 'unknown endpoint' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return new Response(JSON.stringify({ error: 'adsbdb upstream unreachable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = await upstream.arrayBuffer();

  return new Response(body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': upstream.ok
        ? `public, max-age=${CACHE_SECONDS}`
        : 'no-store',
    },
  });
}

export const onRequest = [
  async (context) => {
    if (context.request.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', Allow: 'GET' },
      });
    }
    return context.next();
  },
];
