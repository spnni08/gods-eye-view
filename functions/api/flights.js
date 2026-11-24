/**
 * Cloudflare Pages Function: live-flights proxy.
 *
 * Primary source: adsb.lol /v2/lat/{lat}/lon/{lon}/dist/250
 * (ODbL 1.0 — keyless, no authentication required)
 *
 * Why adsb.lol instead of OpenSky:
 *   OpenSky Network blocks or rate-limits (HTTP 403/429) anonymous requests
 *   from Cloudflare's shared edge IP pool, making the OpenSky endpoint
 *   unreliable in a Pages Function. adsb.lol serves the same ADS-B data
 *   without IP-based restrictions. The Node server already uses this endpoint
 *   as its OpenSky fallback (server/providers/aircraft/opensky.js).
 *
 * Response format:
 *   The response is converted to the OpenSky state-vector shape
 *   ({ time, states, emergencyByIcao?, typeByIcao? }) that the browser client
 *   already consumes via openSkySnapshot() in src/sources/live/standalone.js.
 *   No client-side changes are required.
 *
 * Query parameters (forwarded from the client, src/sources/live/standalone.js):
 *   lat  — camera latitude  (required for adsb.lol point query)
 *   lon  — camera longitude (required for adsb.lol point query)
 *   When absent the function returns an empty valid snapshot (no aircraft).
 *
 * Cache: 10 s — adsb.lol data age is ~1-5 s; 10 s prevents hammering the
 * upstream while staying fresh enough for the 15 s client poll interval.
 *
 * License note:
 *   adsb.lol data is published under the Open Database License (ODbL) 1.0.
 *   Attribution is shown in the app via src/data/dataCredits.js and
 *   DATA_SOURCES.md. The ODbL requires that derivative databases remain open;
 *   this proxy serves the data at request time and stores nothing persistently.
 */

// ---------------------------------------------------------------------------
// Constants (mirror server/providers/aircraft/opensky.js)
// ---------------------------------------------------------------------------
const ADSBLOL_POINT_RADIUS_NM = 250;
const ADSBLOL_BASE = 'https://api.adsb.lol/v2';
const CACHE_SECONDS = 10;
const UPSTREAM_TIMEOUT_MS = 12000;

// ---------------------------------------------------------------------------
// Normalization — inlined from src/data/adsbLolFallback.js and
// src/sources/adsbFields.js (Pages Functions cannot import from src/).
// Keep in sync with those files.
// ---------------------------------------------------------------------------

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** src/sources/adsbFields.js — readAdsbVerticalRateFpm */
function readAdsbVerticalRateFpm(row) {
  const baro = typeof row?.baro_rate === 'number' && Number.isFinite(row.baro_rate) ? row.baro_rate : null;
  if (baro !== null) return baro;
  const geom = typeof row?.geom_rate === 'number' && Number.isFinite(row.geom_rate) ? row.geom_rate : null;
  return geom;
}

/** src/data/adsbLolFallback.js — emitterCategory */
function emitterCategory(value) {
  const cat = String(value || '').trim().toUpperCase();
  const map = { A1:2, A2:3, A3:4, A4:5, A5:6, A6:7, A7:8, B1:9, B2:10, B3:11, B4:12, B6:14, B7:15 };
  return map[cat] || 0;
}

const KNOT_TO_MPS = 0.514444;
const FOOT_TO_M = 0.3048;
const FPM_TO_MPS = 0.00508;

/** src/data/adsbLolFallback.js — normalizeAdsbLolAircraftState */
function normalizeAdsbLolAircraftState(aircraft, nowSeconds) {
  const hex = String(aircraft?.hex || '').trim().toLowerCase();
  const latitude = finiteNumber(aircraft?.lat);
  const longitude = finiteNumber(aircraft?.lon);
  if (!hex || latitude === null || longitude === null ||
      Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;

  const seenPos = Math.max(0, finiteNumber(aircraft?.seen_pos) ?? finiteNumber(aircraft?.seen) ?? NaN);
  const seen = Math.max(0, finiteNumber(aircraft?.seen) ?? seenPos);
  const onGround = aircraft?.alt_baro === 'ground';
  const baroFt = onGround ? null : finiteNumber(aircraft?.alt_baro);
  const geoFt = finiteNumber(aircraft?.alt_geom);
  const speedKts = finiteNumber(aircraft?.gs);
  const rateFpm = readAdsbVerticalRateFpm(aircraft);
  const track = finiteNumber(aircraft?.track) ?? finiteNumber(aircraft?.true_heading);

  return [
    hex,
    String(aircraft?.flight || aircraft?.r || '').trim() || null,
    null,
    Number.isFinite(seenPos) ? Math.max(0, nowSeconds - seenPos) : null,
    Number.isFinite(seen)    ? Math.max(0, nowSeconds - seen)    : null,
    longitude,
    latitude,
    baroFt === null ? null : baroFt * FOOT_TO_M,
    onGround,
    speedKts === null ? null : speedKts * KNOT_TO_MPS,
    track,
    rateFpm === null ? null : rateFpm * FPM_TO_MPS,
    null,
    geoFt === null ? null : geoFt * FOOT_TO_M,
    aircraft?.squawk || null,
    aircraft?.spi === 1,
    0,
    emitterCategory(aircraft?.category),
  ];
}

/** src/data/adsbLolFallback.js — normalizeAdsbLolPointResponse */
function normalizeAdsbLolPointResponse(payload) {
  const responseNow = finiteNumber(payload?.now);
  const nowSeconds = responseNow === null
    ? Math.floor(Date.now() / 1000)
    : Math.floor(responseNow > 10_000_000_000 ? responseNow / 1000 : responseNow);

  const aircraft = Array.isArray(payload?.ac) ? payload.ac : [];
  const states = [];
  const admitted = new Set();
  const statuses = [];
  const types = [];

  for (const row of aircraft) {
    const state = normalizeAdsbLolAircraftState(row, nowSeconds);
    if (!state) continue;
    states.push(state);
    const id = state[0];
    if (admitted.has(id)) continue;
    admitted.add(id);
    if (typeof row.emergency === 'string')
      statuses.push([id, row.emergency.trim().toLowerCase()]);
    const type = typeof row.t === 'string' ? row.t.trim().toUpperCase() : '';
    if (type) types.push([id, type]);
  }

  return {
    time: nowSeconds,
    states,
    ...(statuses.length ? { emergencyByIcao: Object.fromEntries(statuses) } : {}),
    ...(types.length    ? { typeByIcao:      Object.fromEntries(types)    } : {}),
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const lat = parseFloat(url.searchParams.get('lat') ?? '');
  const lon = parseFloat(url.searchParams.get('lon') ?? '');

  // No camera anchor: return a valid empty snapshot rather than an error.
  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    const empty = { time: Math.floor(Date.now() / 1000), states: [] };
    return new Response(JSON.stringify(empty), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Flight-Source': 'adsb.lol',
        'X-Flight-Coverage': 'no anchor',
      },
    });
  }

  // Snap to 0.25° grid — matches the Node server's rounding.
  const roundedLat = Math.round(lat * 4) / 4;
  const roundedLon = Math.round(lon * 4) / 4;
  const upstreamUrl =
    `${ADSBLOL_BASE}/lat/${roundedLat}/lon/${roundedLon}/dist/${ADSBLOL_POINT_RADIUS_NM}`;

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'gods-eye-view-flights/1.0',
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'adsb.lol upstream unreachable' }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'X-Flight-Source': 'adsb.lol' },
      },
    );
  }

  if (!upstream.ok) {
    return new Response(
      JSON.stringify({ error: `adsb.lol upstream HTTP ${upstream.status}` }),
      {
        status: upstream.status === 429 ? 429 : 502,
        headers: {
          'Content-Type': 'application/json',
          'X-Flight-Source': 'adsb.lol',
          ...(upstream.status === 429 && upstream.headers.has('retry-after')
            ? { 'Retry-After': upstream.headers.get('retry-after') }
            : {}),
        },
      },
    );
  }

  let payload;
  try {
    payload = await upstream.json();
  } catch {
    return new Response(JSON.stringify({ error: 'adsb.lol malformed response' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'X-Flight-Source': 'adsb.lol' },
    });
  }

  const normalized = normalizeAdsbLolPointResponse(payload);

  return new Response(JSON.stringify(normalized), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
      'X-Flight-Source': 'adsb.lol',
      'X-Flight-Coverage': `${ADSBLOL_POINT_RADIUS_NM}nm regional snapshot`,
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
