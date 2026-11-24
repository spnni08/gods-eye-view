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
 * Cache: Cloudflare Cache API (caches.default) prevents repeated upstream
 * calls for the same key. Positive answers (aircraft/route found) are kept
 * for 24 h, matching the dev-server disk-cache TTL. 404 misses are cached
 * for 1 h so a hex that is unknown today is not re-queried on every reload;
 * other errors are not cached so a transient outage does not poison the cache.
 *
 * Note: adsbdb's route data "is the work of David Taylor, Edinburgh and
 * Jim Mason, Glasgow, and may not be copied, published, or incorporated
 * into other databases without the explicit permission of David J Taylor".
 * This proxy only serves it at request time, never stores it persistently.
 */

const ADSBDB_BASE = 'https://api.adsbdb.com/v0';
const CACHE_TTL_HIT_S = 24 * 3600;  // 24 h — matches dev-server TTL_MS in server/providers/aircraft/enrichment.js
const CACHE_TTL_MISS_S = 3600;       // 1 h for 404 (aircraft may become known later)

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

  // Check the Cloudflare edge cache before hitting the upstream.
  const cache = caches.default;
  const cacheKey = new Request(upstreamUrl, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

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

  let cacheTtl = 0;
  if (upstream.ok) {
    cacheTtl = CACHE_TTL_HIT_S;
  } else if (upstream.status === 404) {
    cacheTtl = CACHE_TTL_MISS_S;
  }

  const response = new Response(body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cacheTtl > 0 ? `public, max-age=${cacheTtl}` : 'no-store',
    },
  });

  if (cacheTtl > 0) {
    context.waitUntil(cache.put(cacheKey, response.clone()));
  }

  return response;
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
