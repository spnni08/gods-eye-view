/**
 * Cloudflare Pages Function: flight track proxy.
 *
 * Proxies GET /api/flights/track?icao24=<hex6>
 *       → OpenSky Network GET /api/tracks/all?icao24=<hex6>&time=0
 *
 * Returns the last known track for one aircraft.  OpenSky marks this endpoint
 * "experimental" and it only works for registered (OAuth) users on some
 * deployments; anonymous requests frequently get 401/403.  The client layer
 * uses the track only as a visual trail enrichment and handles missing data
 * gracefully (falls back to the accumulated in-memory trail).
 *
 * Cache: 15 s — a track changes at most once per ADS-B update interval.
 */

const UPSTREAM_BASE = 'https://opensky-network.org/api/tracks/all';
const CACHE_SECONDS = 15;

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const icao24 = url.searchParams.get('icao24') || '';

  if (!/^[0-9a-f]{6}$/i.test(icao24)) {
    return new Response(JSON.stringify({ error: 'invalid icao24' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const upstream = await fetch(
    `${UPSTREAM_BASE}?icao24=${encodeURIComponent(icao24.toLowerCase())}&time=0`,
    {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    },
  );

  const body = await upstream.arrayBuffer();

  return new Response(body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
      'X-Feed-Source': 'OpenSky Network',
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
