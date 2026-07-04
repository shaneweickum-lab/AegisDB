// This is a static site (deployed to Vercel); the actual AegisDB server
// (flat-file DB, WS telemetry, REST API) runs separately per
// docs/DEPLOYMENT.md. Point this frontend at whichever backend you've
// deployed by editing the default below, or by visiting with
// ?backend=https://your-backend.example.com appended to the URL —
// no build step, no bundler, so this file is the single place that changes.
const DEFAULT_BACKEND_URL = 'http://localhost:8787';

function resolveBackendUrl() {
  const fromQuery = new URLSearchParams(window.location.search).get('backend');
  return fromQuery || DEFAULT_BACKEND_URL;
}

window.AEGIS_BACKEND_URL = resolveBackendUrl();
window.AEGIS_WS_URL = window.AEGIS_BACKEND_URL.replace(/^http/, 'ws') + '/api/telemetry/state';
