/**
 * Cloudflare Pages Function: military aircraft proxy.
 *
 * Proxies GET /api/military → https://api.adsb.lol/v2/mil (keyless).
 *
 * adsb.lol /v2/mil returns all aircraft whose ICAO hex is in the shared
 * military registry.  The endpoint is keyless and answers with
 * Access-Control-Allow-Origin: * on the adsb.lol side, but browser fetch()
 * is blocked by the app's Content-Security-Policy (connect-src 'self' …)
 * which restricts connections to same-origin, so this server-side proxy is
 * still required.
 *
 * Cache: 12 s — matches the Node server's CACHE_MS so edge-cached and
 * server-served deploys age at the same rate.
 *
 * License: ODbL 1.0 (adsb.lol contributors).
 * Rate limits: not formally published; 429 is returned when exceeded.
 */

const UPSTREAM = 'https://api.adsb.lol/v2/mil';
const CACHE_SECONDS = 12;
const UPSTREAM_TIMEOUT_MS = 12000;

export async function onRequestGet(context) {
  let upstream;
  try {
    upstream = await fetch(UPSTREAM, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'adsb.lol upstream unreachable' }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'X-Feed-Source': 'adsb.lol' },
      },
    );
  }

  const body = await upstream.arrayBuffer();

  return new Response(body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control':
        upstream.ok ? `public, max-age=${CACHE_SECONDS}` : 'no-store',
      'X-Feed-Source': 'adsb.lol',
      'X-Feed-Cache': 'MISS',
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
