/**
 * Cloudflare Pages Function: live-flights proxy.
 *
 * Proxies GET /api/flights → OpenSky Network REST API (anonymous, worldwide
 * state-vector snapshot). The browser cannot call opensky-network.org directly
 * because that origin does not send CORS headers for non-credentialled
 * anonymous requests from arbitrary origins.
 *
 * Cache: 10 s — shorter than OpenSky's ~15 s data age so a stale Cloudflare
 * edge cache does not compound the upstream staleness.
 *
 * OpenSky anonymous limits (as of 2025):
 *   - 100 API credits/day for unregistered clients
 *   - 400 API credits/day for registered (OAuth) clients
 *   - 10 s minimum poll interval
 *   - Cloud/datacenter IPs are sometimes blocked outright (HTTP 403/429)
 *   - License: non-commercial research/education only
 *
 * When OpenSky blocks the edge IP the response will be 403/429; the client
 * layer already shows "Fehlerhafte Antwort von OpenSky" for those codes.
 */

const UPSTREAM = 'https://opensky-network.org/api/states/all?extended=1';
const CACHE_SECONDS = 10;

export async function onRequestGet(context) {
  const upstream = await fetch(UPSTREAM, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });

  const body = await upstream.arrayBuffer();

  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  headers.set('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
  headers.set('X-Feed-Source', 'OpenSky Network');
  if (upstream.headers.has('x-opensky-auth-mode-used'))
    headers.set(
      'X-OpenSky-Auth-Mode-Used',
      upstream.headers.get('x-opensky-auth-mode-used'),
    );
  if (upstream.headers.has('x-opensky-auth-reason'))
    headers.set(
      'X-OpenSky-Auth-Reason',
      upstream.headers.get('x-opensky-auth-reason'),
    );

  return new Response(body, {
    status: upstream.status,
    headers,
  });
}

// Reject non-GET methods.
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
