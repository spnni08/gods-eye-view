# God's Eye View – Cloudflare Pages Setup

Step-by-step guide to hosting a static build of this app on Cloudflare Pages
so NOVA can embed it via iframe (`?embed=1`) and postMessage.

---

## 1. What works without the Node server

The static build contains only the browser bundle. All server-side functionality
(OpenAI HUD summary, Overpass layer, weather effects, voice control, Mapillary
photos, TomTom traffic, AIS ships, MCP tool integration) is unavailable at
runtime. These are API calls the browser would make to `localhost` or a configured
server; without a server they silently fail and do not crash the app.

The following data layers work directly from the browser using public APIs:

| Layer | Source |
|---|---|
| Flights (ADS-B) | adsb-lol / OpenSky direct |
| Earthquakes | USGS direct |
| Satellites | Celestrak TLE direct |
| Basemap | Esri |
| 3D terrain / imagery | Cesium ion (token required) |

Conclusion: the app starts cleanly. Only individual data layers that need a
local server are missing; the globe, camera, follow and layer-toggle features
all work.

---

## 2. Create the Cloudflare Pages project

1. Go to <https://dash.cloudflare.com/> → **Workers & Pages** → **Create**.
2. Select **Pages** → **Connect to Git** → choose the fork (`spnni08/gods-eye-view`).
3. Use these build settings:

| Setting | Value |
|---|---|
| **Framework preset** | None |
| **Build command** | `npx vite build --config vite.pages.config.js` |
| **Build output directory** | `dist` |

---

## 3. Environment variables

Set these in **Settings → Environment variables** for the **Production** environment
(and optionally for Preview).

### Required

| Variable | Description |
|---|---|
| `NODE_VERSION` | `24` — selects Node.js 24.x (requires ≥ 24.14.0, see `package.json`) |
| `CESIUM_ION_TOKEN` | Your Cesium ion access token (non-commercial account). Get it at <https://cesium.com/ion/tokens> after creating a free account. |

### Optional

| Variable | Description |
|---|---|
| `GOOGLE_MAPS_API_KEY` | Enables Google Street View layer |
| `MAPILLARY_CLIENT_TOKEN` | Enables Mapillary street-level photos |
| `PHOTON_URL` | Custom Photon geocoder endpoint (must be `https://`). Leave unset to use the default. |

**Never commit tokens to the repository.** Set them only in the Cloudflare
dashboard or via the Wrangler CLI (`wrangler pages secret put CESIUM_ION_TOKEN`).

---

## 4. Set the allowed embedding origin

After deploying, open `public/_headers` and replace `NOVA_ORIGIN_HIER_EINTRAGEN`
with the Cloudflare Pages URL of your NOVA instance, for example:

```
frame-ancestors https://nova.pages.dev
```

If you have a preview deployment or a custom domain, add all origins
space-separated:

```
frame-ancestors https://nova.pages.dev https://nova-preview.pages.dev
```

Commit and push the change; Cloudflare Pages will redeploy automatically.

---

## 5. Tell NOVA the GEV URL

After the first successful Cloudflare Pages deploy, copy the deployment URL
(e.g. `https://gods-eye-view.pages.dev`) and store it as the `GLOBUS_URL`
secret in the NOVA Cloudflare Worker:

```bash
wrangler secret put GLOBUS_URL
# paste: https://gods-eye-view.pages.dev
```

NOVA's GlobusPanel uses this URL to embed the app via
`https://gods-eye-view.pages.dev?embed=1`.

---

## 6. How the postMessage security works

`src/app/embed.js` only accepts `gev:view` messages whose `event.source` is
exactly `window.parent` — the direct framing page. Any other window is ignored.

There is no additional origin allowlist in the JavaScript code. The security
boundary is the CSP `frame-ancestors` directive in `public/_headers`: the
browser refuses to load the page inside any iframe whose parent does not match
the allowed origin. So once you have set the correct origin in `_headers`, only
NOVA can send commands to the embedded globe.

---

## 7. License note

| Component | License |
|---|---|
| Application code | MIT |
| Cesium ion service | Non-commercial use only (Cesium ion Terms of Service) |
| OpenStreetMap data | ODbL |
| TeleGeography submarine cable data | CC BY-NC-SA |
| NASA ISS 3D model | NASA Open Source / Public Domain |

**Personal use only.** Before publishing this fork or deploying it for any
commercial purpose, review and comply with Cesium ion's terms and remove or
replace any non-commercial data. See the upstream repository's README and
`SECURITY.md` for further details.
