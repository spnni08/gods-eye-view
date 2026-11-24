/**
 * Vite config for Cloudflare Pages static build.
 *
 * Uses only the browser bundle (createBrowserViteConfig) with no server-side
 * plugins, so the build succeeds in a CI environment that does not have the
 * Node server or its dependencies available.
 *
 * Build command:  npx vite build --config vite.pages.config.js
 * Output dir:     dist/
 *
 * Required env var: CESIUM_ION_TOKEN
 * Optional env vars: GOOGLE_MAPS_API_KEY, MAPILLARY_CLIENT_TOKEN, PHOTON_URL
 */
import { defineConfig } from 'vite';
import { createBrowserViteConfig } from './build/vite.js';

export default defineConfig(({ command }) =>
  createBrowserViteConfig({
    cesiumToken: process.env.CESIUM_ION_TOKEN,
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY,
    photonUrl: process.env.PHOTON_URL,
    mapillaryToken: process.env.MAPILLARY_CLIENT_TOKEN,
    command,
  }),
);
