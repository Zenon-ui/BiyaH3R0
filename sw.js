/* 
   BIYAHERO SERVICE WORKER
   - Caches map tiles so the map genuinely renders with no signal
     (not just the hazard/report data, which was already stored in
     localStorage before this change).
   - Caches the app shell (HTML/CSS/JS/Leaflet/fonts) so the app itself
     still loads with no signal, not just a blank tab.
   Bump SW_VERSION any time you change this file or the shell asset
   list — that's what triggers old caches to be cleaned up.
    */

const SW_VERSION   = "v5";
const SHELL_CACHE  = `biyahero-shell-${SW_VERSION}`;
// NOT derived from SW_VERSION, on purpose. BiyaHERO.js's bulk "Download
// Offline Map" flow writes tiles into a cache it opens itself
// (TILE_CACHE_NAME, currently 'biyahero-tiles-v1') independently of this
// file. If TILE_CACHE here were `biyahero-tiles-${SW_VERSION}`, bumping
// SW_VERSION for an ordinary shell/CSS deploy would silently point this
// file at a cache the user's already-downloaded tiles were never written
// to — they'd look "gone" until re-cached tile-by-tile while browsing.
// Shell assets are cheap to refetch, so those should roll over on every
// version bump; a user's multi-hundred-tile offline download should not.
// If the tile *format* itself ever needs a breaking change, bump this
// constant and BiyaHERO.js's TILE_CACHE_NAME together, deliberately.
const TILE_CACHE    = "biyahero-tiles-v1";

// Runtime cache counter for the "X tiles cached this session" readout in
// Settings. This only counts tiles newly written to TILE_CACHE while
// browsing (mostly zoom 15-17 — 10-14 is already pre-cached by the bulk
// "Download Offline Map" flow, so those come back as cache hits and don't
// increment this). It lives in SW memory, so it resets whenever the SW
// itself restarts (browser reclaims idle workers after ~30s of no
// activity) — an approximation of "this session," not a persisted total.
let sessionTilesCached = 0;

async function broadcastTileCount() {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach((client) =>
    client.postMessage({ type: "TILE_CACHED", sessionTotal: sessionTilesCached })
  );
}

// Everything needed to render the app itself with zero network.
// Relative paths resolve against this file's own location.
const SHELL_ASSETS = [
  "./BiyaHERO.html",
  "./BiyaHERO.css",
  "./BiyaHERO.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./supabase-config.js",
  "./traffic-config.js",
  "https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.js",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
];

// Must match the tile URL template used by L.tileLayer(...) in BiyaHERO.js.
function isTileRequest(url) {
  return url.hostname === "tile.openstreetmap.org";
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // Cache each shell asset independently so one flaky CDN request
      // (e.g. Google Fonts on a slow connection) can't fail the whole
      // install and leave the app with nothing cached at all.
      Promise.all(
        SHELL_ASSETS.map((url) =>
          fetch(url, { mode: "cors" })
            .then((resp) => resp.ok && cache.put(url, resp))
            .catch(() => {
              /* best-effort; app still works without this one asset cached */
            })
        )
      )
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== TILE_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // ---- Map tiles: cache-first, then network, then cache the result ----
  if (isTileRequest(url)) {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const resp = await fetch(req);
          // Standard OSM tiles don't send CORS headers, so cross-origin
          // <img> tile requests come back "opaque" (status/body hidden
          // from JS) — that's normal, and opaque responses are cacheable.
          if (resp && (resp.ok || resp.type === "opaque")) {
            cache.put(req, resp.clone());
            sessionTilesCached++;
            broadcastTileCount();
          }
          return resp;
        } catch (err) {
          // Truly offline and this tile was never cached/downloaded —
          // nothing we can serve. Leaflet will just show a blank tile.
          return Response.error();
        }
      })
    );
    return;
  }

  //  App shell: cache-first, refresh cache in the background 
  if (
    req.mode === "navigate" ||
    SHELL_ASSETS.some((a) => req.url === a || req.url.endsWith(a.replace("./", "")))
  ) {
    // Navigations can arrive with a query string we've never seen before -
    // manifest "shortcuts" (?shortcut=report) and "share_target" shares
    // (?share-title=...) both land on BiyaHERO.html this way. ignoreSearch
    // lets those still hit the single cached document instead of missing
    // the cache purely because of the query string.
    const matchOpts = req.mode === "navigate" ? { ignoreSearch: true } : undefined;
    event.respondWith(
      caches.match(req, matchOpts).then((cached) => {
        const network = fetch(req)
          .then((resp) => {
            if (resp && resp.ok) {
              caches.open(SHELL_CACHE).then((cache) => cache.put(req, resp.clone()));
            }
            return resp;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});
