// BiyaHERO offline storage manager — saves reports, GPS data, and map state.
// Note: user accounts themselves are no longer stored here — they live in
// Supabase (see supabase-config.js / supabase-setup.sql). This object only
// covers device-local, offline-first app data.
const BiyaStorage = {

    keys: {
        hazards: "biyahero_hazards",
        pendingReports: "biyahero_pending_reports",
        mapDownloaded: "biyahero_map_downloaded",
        mapBytes: "biyahero_map_bytes",
        gpsData: "biyahero_last_gps",
        poisCache: "biyahero_pois_cache"
    },

    save(key, data) {
        localStorage.setItem(key, JSON.stringify(data));
    },

    load(key, defaultValue = null) {
        try {
            const data = localStorage.getItem(key);
            return data ? JSON.parse(data) : defaultValue;
        } catch (error) {
            console.error("Error loading local data:", error);
            return defaultValue;
        }
    },

    remove(key) {
        localStorage.removeItem(key);
    },

    clearAll() {
        Object.values(this.keys).forEach(key => {
            localStorage.removeItem(key);
        });
    }
};

// Service worker registration and offline tile caching
/* Offline tile caching (and app shell caching) needs a service worker, and
   service workers only run in a secure context — meaning the app is served
   over http(s), not opened by double-clicking BiyaHERO.html as a file. If
   opened that way, navigator.serviceWorker won't exist at all, so we just
   skip registration and let the user know with a toast once the UI is up. */

let swRegistrationFailed = false;
if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker
            .register("sw.js")
            .catch((err) => {
                console.error("Service worker registration failed:", err);
                swRegistrationFailed = true;
            });
    });

    /* The service worker sends a TILE_CACHED message every time it caches a
       new tile while browsing (mostly zoom 15-17 — see sw.js).
       updateSessionTileCount is defined further down with the rest of the
       offline map settings UI, but this listener can still be set up here,
       since messages won't arrive until the service worker is active. */
    navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data && event.data.type === "TILE_CACHED") {
            // updateSessionTileCount lives inside the main IIFE below, so it's
            // exposed here the same way showToast is, through window.biyaShowToast
            if (window.biyaUpdateSessionTileCount) {
                window.biyaUpdateSessionTileCount(event.data.sessionTotal);
            }
        }
    });
} else {
    swRegistrationFailed = true;
}

// Dynamic viewport height (fits any phone's real screen)
/* Mobile browsers resize the visible viewport as the URL bar or nav bar
   shows and hides, which makes plain 100vh jump around. We measure the
   real visible height ourselves (using the visualViewport API when
   available) and expose it as --app-vh for BiyaHERO.css to use — see
   the mobile media query there. */

function setAppViewportHeight() {
    const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty("--app-vh", `${h * 0.01}px`);
}
setAppViewportHeight();
window.addEventListener("resize", setAppViewportHeight);
window.addEventListener("orientationchange", setAppViewportHeight);
if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", setAppViewportHeight);
}

// GPS manager — tracks the device's actual location and speed
const GPSManager = {

    watchId: null,

    currentPosition: {
        latitude: null,
        longitude: null,
        accuracy: null,
        speedKmh: 0,
        timestamp: null
    },

    previousPosition: null,

    /* Listeners get the fresh currentPosition every time a new GPS fix comes
       in. This lets the routing and map-centering code (defined later,
       inside the main IIFE) react to real location updates without
       GPSManager needing to know anything about routing or Leaflet. */
    listeners: [],

    onUpdate(fn) {
        this.listeners.push(fn);
    },

    notifyListeners() {
        this.listeners.forEach(fn => {
            try { fn(this.currentPosition); } catch (err) { console.error('GPS listener error:', err); }
        });
    },

    start() {

        if (!navigator.geolocation) {
            console.error("Geolocation is not supported by this device.");
            window.biyaShowToast(
    "GPS is not supported on this device."
);
            return;
        }

        if (this.watchId !== null) {
            return;
        }

        this.watchId = navigator.geolocation.watchPosition(

            position => {

                const coords = position.coords;

                let speedKmh = 0;

                // Some devices report GPS speed directly, in meters per second
                if (
                    coords.speed !== null &&
                    coords.speed >= 0
                ) {

                    speedKmh = coords.speed * 3.6;

                } else {

                    // Otherwise, estimate speed from the last two GPS positions
                    speedKmh = this.calculateSpeed(
                        coords.latitude,
                        coords.longitude,
                        position.timestamp
                    );
                }

                this.currentPosition = {
                    latitude: coords.latitude,
                    longitude: coords.longitude,
                    accuracy: coords.accuracy,
                    speedKmh: Math.round(speedKmh),
                    timestamp: position.timestamp
                };

                this.previousPosition = {
                    latitude: coords.latitude,
                    longitude: coords.longitude,
                    timestamp: position.timestamp
                };

                // Save the latest GPS data for offline use
                BiyaStorage.save(
                    BiyaStorage.keys.gpsData,
                    this.currentPosition
                );

                this.updateInterface();
                this.notifyListeners();

                console.log(
                    "GPS Updated:",
                    this.currentPosition
                );
            },

            error => {

                console.error(
                    "GPS Error:",
                    error.message
                );

                switch (error.code) {

                    case error.PERMISSION_DENIED:
                        window.biyaShowToast(
                            "Location permission was denied."
                        );
                        break;

                    case error.POSITION_UNAVAILABLE:
                        window.biyaShowToast(
                            "Location information is unavailable."
                        );
                        break;

                    case error.TIMEOUT:
                        window.biyaShowToast(
                            "GPS request timed out."
                        );
                        break;

                    default:
                        window.biyaShowToast(
                            "Unable to get GPS location."
                        );
                }
            },

            {
                enableHighAccuracy: true,
                maximumAge: 3000,
                timeout: 15000
            }
        );
        
    },

    stop() {

        if (this.watchId !== null) {

            navigator.geolocation.clearWatch(
                this.watchId
            );

            this.watchId = null;
        }
    },

    calculateSpeed(
        latitude,
        longitude,
        timestamp
    ) {

        if (!this.previousPosition) {
            return 0;
        }

        const previous = this.previousPosition;

        const distance = this.calculateDistance(
            previous.latitude,
            previous.longitude,
            latitude,
            longitude
        );

        const timeDifference =
            (timestamp - previous.timestamp) / 1000;

        if (timeDifference <= 0) {
            return 0;
        }

        // Meters per second
        const speedMs =
            distance / timeDifference;

        // Convert m/s to km/h
         
        return speedMs * 3.6;
    },

    calculateDistance(
        lat1,
        lon1,
        lat2,
        lon2
    ) {

        const earthRadius = 6371000;

        const toRadians = value =>
            value * Math.PI / 180;

        const deltaLat =
            toRadians(lat2 - lat1);

        const deltaLon =
            toRadians(lon2 - lon1);

        const a =
            Math.sin(deltaLat / 2) *
            Math.sin(deltaLat / 2) +

            Math.cos(toRadians(lat1)) *
            Math.cos(toRadians(lat2)) *

            Math.sin(deltaLon / 2) *
            Math.sin(deltaLon / 2);

        const c =
            2 * Math.atan2(
                Math.sqrt(a),
                Math.sqrt(1 - a)
            );

        return earthRadius * c;
    },

    getTrafficStatus(speed) {

        if (speed <= 10) {
            return {
                label: "Heavy Traffic",
                expected: "Very slow movement"
            };
        }

        if (speed <= 25) {
            return {
                label: "Moderate Traffic",
                expected: "Slow movement"
            };
        }

        if (speed <= 40) {
            return {
                label: "Light Traffic",
                expected: "Normal movement"
            };
        }

        return {
            label: "Free Flow",
            expected: "Road is moving freely"
        };
    },

    updateInterface() {

        const speed =
            this.currentPosition.speedKmh;

        const traffic =
            this.getTrafficStatus(speed);

        // Update the speedometer UI elements

        const speedElement =
            document.getElementById("speedoValue");

        const labelElement =
            document.getElementById("speedoLabel");

        const subElement =
            document.getElementById("speedoSub");

        const ringElement =
            document.getElementById("speedoRing");

        if (speedElement) {
            speedElement.textContent = speed;
        }

        if (labelElement) {
            labelElement.textContent =
                traffic.label;
        }

        if (subElement) {
            subElement.textContent =
                traffic.expected;
        }

        if (ringElement) {

            const percentage =
                Math.min(
                    100,
                    Math.round(
                        (speed / 60) * 100
                    )
                );

            ringElement.style.background =
                `conic-gradient(
                    var(--brand)
                    0 ${percentage}%,
                    rgba(255,255,255,.14)
                    ${percentage}% 100%
                )`;
        }

        this.updateGPSLocationDisplay();
    },

    updateGPSLocationDisplay() {

        const gpsChip =
            document.querySelector(".gps-chip");

        if (
            !gpsChip ||
            this.currentPosition.latitude === null
        ) {
            return;
        }

        const latitude =
            this.currentPosition.latitude
                .toFixed(6);

        const longitude =
            this.currentPosition.longitude
                .toFixed(6);

        const accuracy =
            Math.round(
                this.currentPosition.accuracy
            );

        const locationText =
            `${latitude}°, ${longitude}° · ±${accuracy}m`;

        // Keep the GPS icon, just replace the old hardcoded coordinates
        const svg =
            gpsChip.querySelector("svg");

        gpsChip.innerHTML = "";

        if (svg) {
            gpsChip.appendChild(svg);
        }

        gpsChip.appendChild(
            document.createTextNode(
                " " + locationText
            )
        );
    },

    getCurrentLocation() {
        return this.currentPosition;
    },

    /* Used for the "Center My Location" feature - works even if
       watchPosition (which only starts once the user reaches the main app)
       hasn't produced a reading yet, or the cached position is stale. */
    getFreshPosition() {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) {
                reject(new Error('Geolocation is not supported on this device.'));
                return;
            }
            navigator.geolocation.getCurrentPosition(
                position => resolve(position.coords),
                error => reject(error),
                { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
            );
        });
    }
};


(function(){
  "use strict";

  // The actual OSM map (Leaflet) — Laguna province, Philippines (rough bounding box covering the whole province)

  const LAGUNA_BOUNDS = L.latLngBounds([13.90, 120.95], [14.50, 121.65]);
  const LAGUNA_CENTER = [14.1710, 121.2500];

  /* Note before launch: tile.openstreetmap.org is OSM's shared demo endpoint,
     and its usage policy forbids bulk/automated downloading like the
     "Download Offline Map" flow below does (about 1,300 tiles per download)
     - see https://operations.osmfoundation.org/policies/tiles/. This is fine
     for a prototype, but before a real launch it should switch to a
     provider meant for offline caching (MapTiler, Mapbox, Stadia Maps, or a
     self-hosted tile server). This constant is the single source of truth
     for the tile URL, so swapping providers is a one-line change — it feeds
     both the live tile layer below and buildOfflineTileList()'s download
     URLs. Remember to also update sw.js's isTileRequest() hostname check
     if this changes. */

  const TILE_URL_TEMPLATE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  if (TILE_URL_TEMPLATE.includes('tile.openstreetmap.org')) {
    console.warn(
      '[BiyaHERO] Using OpenStreetMap\'s shared tile server for bulk offline ' +
      'downloads — against their usage policy at production scale. Swap ' +
      'TILE_URL_TEMPLATE before launch.'
    );
  }

  const map = L.map('leafletMap', {
    zoomControl: false,
    attributionControl: true,
    center: LAGUNA_CENTER,
    zoom: 11,
    minZoom: 10,
    // Was capped at 17 while the tile layer itself allowed 19 — that
    // mismatch meant the map could never reach the sharpest tiles OSM
    // actually serves for close-in, building-level navigation. Raised to
    // match (18, one below the tile layer's own ceiling of 19, since OSM's
    // z19 tiles are only reliably available in dense urban cores and
    // Laguna's isn't one — 18 is the honest max here).
    maxZoom: 18,
    // Fractional zoom: pinch-to-zoom and scroll-zoom glide continuously
    // instead of snapping to whole levels, which is what "zoom feels
    // laggy/stepped" usually comes down to. Buttons (zoomInBtn/zoomOutBtn
    // below) still move by a full level at a time via zoomDelta, so the
    // explicit controls stay predictable while gestures stay smooth.
    zoomSnap: 0.5,
    zoomDelta: 1,
    wheelPxPerZoomLevel: 90,
    maxBounds: LAGUNA_BOUNDS.pad(0.15),
    maxBoundsViscosity: 0.7
  });

  L.tileLayer(TILE_URL_TEMPLATE, {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
    // Cross-fades in the next zoom level's tiles instead of a hard swap —
    // makes zooming look smooth/continuous rather than blurry-then-snap,
    // without needing a different tile provider.
    updateWhenZooming: false,
    keepBuffer: 3
  }).addTo(map);

  /* Explicit zoom +/- buttons (Leaflet's own zoomControl is disabled above
     so these can match the app's own UI chrome — see .zoom-ctrl in
     BiyaHERO.css). Pinch/scroll zoom keeps working on top of this; these
     are just an always-visible alternative for mouse/trackpad users and
     for accessibility. */
  const zoomInBtn = document.getElementById('zoomInBtn');
  const zoomOutBtn = document.getElementById('zoomOutBtn');
  function refreshZoomButtons(){
    if (zoomInBtn) zoomInBtn.disabled = map.getZoom() >= map.getMaxZoom();
    if (zoomOutBtn) zoomOutBtn.disabled = map.getZoom() <= map.getMinZoom();
  }
  if (zoomInBtn) zoomInBtn.addEventListener('click', () => map.zoomIn());
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => map.zoomOut());
  map.on('zoomend', refreshZoomButtons);
  refreshZoomButtons();

  /* Extra safety for the map-init bug: even with the CSS fix (#stage-app is
     never display:none, see BiyaHERO.css), any future resize of the map's
     container - phone rotation, mobile browser bar showing or hiding, a
     future layout change - needs Leaflet to re-measure, or it keeps
     rendering at its last known size. */
  const mapWrapEl = document.querySelector('.map-wrap');

  if ('ResizeObserver' in window && mapWrapEl) {
    new ResizeObserver(() => map.invalidateSize()).observe(mapWrapEl);
  } else {
    window.addEventListener('resize', () => map.invalidateSize());
  }

  // Offline tile caching (service worker + Cache API)
  /* "Download Offline Map" fetches every tile covering the Laguna bounding
     box for a set zoom range and stores them in the browser's Cache
     Storage. The service worker (sw.js) then intercepts Leaflet's tile
     requests and serves them from that cache first, so the map keeps
     rendering with the phone in airplane mode - not just the hazard pins,
     which were already saved to localStorage.

     Zoom range is 10-14 only, which is enough for real turn-by-turn
     navigation across the whole province (about 1,300 tiles, roughly
     20-30MB) without downloading every zoom level OSM offers. Zoom 15-17
     (building-level detail) is cached opportunistically instead - the
     service worker caches any tile the map actually loads while online,
     so areas you've zoomed into before stay available offline too,
     without pre-fetching the whole province at max detail.

     Note for a real deployment: OpenStreetMap's tile servers disallow
     bulk/automated downloading like this at scale (see their tile usage
     policy). This is fine for a prototype, but a shipped app should use a
     provider meant for offline caching (MapTiler, Mapbox, Stadia Maps, or
     a self-hosted tile server).

     TILE_CACHE_NAME must match TILE_CACHE in sw.js exactly - that file
     explains why it's kept independent of SW_VERSION, and both should
     only be bumped together, deliberately, if the tile format changes. */

  const TILE_CACHE_NAME = 'biyahero-tiles-v1';
  const OFFLINE_ZOOM_MIN = 10;
  const OFFLINE_ZOOM_MAX = 14;
  const AVG_TILE_BYTES = 15000; // 15KB per tile, used only to show an approximate size in the UI

  function lon2tileX(lon, z) {
    return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
  }
  function lat2tileY(lat, z) {
    const rad = (lat * Math.PI) / 180;
    return Math.floor(
      ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z)
    );
  }

  function buildOfflineTileList(bounds, zMin, zMax) {
    const urls = [];
    for (let z = zMin; z <= zMax; z++) {
      const x1 = lon2tileX(bounds.getWest(), z);
      const x2 = lon2tileX(bounds.getEast(), z);
      const y1 = lat2tileY(bounds.getNorth(), z);
      const y2 = lat2tileY(bounds.getSouth(), z);
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
          urls.push(TILE_URL_TEMPLATE.replace('{z}', z).replace('{x}', x).replace('{y}', y));
        }
      }
    }
    return urls;
  }

  // Limits how many tiles download at once — gentler on the tile server, and friendlier to a weak mobile connection
  async function downloadTilesWithProgress(urls, onProgress) {
    if (!('caches' in window)) {
      throw new Error('Cache Storage API is not available (needs http(s), not file://).');
    }
    const cache = await caches.open(TILE_CACHE_NAME);
    const total = urls.length;
    let done = 0;
    let cachedAlready = 0;
    let failed = 0;
    let idx = 0;
    const CONCURRENCY = 6;

    async function worker() {
      while (idx < urls.length) {
        const url = urls[idx++];
        try {
          const existing = await cache.match(url);
          if (existing) {
            cachedAlready++;
          } else {
            /* OSM tile responses don't carry CORS headers, so a cross-origin
               fetch must be explicitly set to no-cors. The resulting
               "opaque" response can't be inspected, but it can still be
               stored and served later from Cache Storage. */

            const resp = await fetch(url, { mode: 'no-cors', cache: 'no-store' });
            if (resp && (resp.ok || resp.type === 'opaque')) {
              await cache.put(url, resp);
            } else {
              failed++;
            }
          }
        } catch (err) {
          failed++;
        }
        done++;
        onProgress({ done, total, failed, cachedAlready });
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker);
    await Promise.all(workers);
    return { done, total, failed, cachedAlready };
  }

  async function clearTileCache() {
    if ('caches' in window) {
      await caches.delete(TILE_CACHE_NAME);
    }
  }

  /* "You are here" marker - always reflects the device's real GPS fix
     (see GPSManager + the onUpdate wiring further down). It is never
     animated toward a destination: when navigation is active the app
     tracks wherever the phone's GPS actually reports, recalculating the
     route if that diverges from the drawn path, the way a real turn-by-
     turn navigator behaves. Before a first GPS fix arrives (or on a
     device/browser with no geolocation) it falls back to a fixed point
     inside Laguna so the map still has something reasonable to show. */

  const youIcon = L.divIcon({
    className: 'you-marker',
    html: '<div class="you-marker-ring"></div><div class="you-marker-dot"></div><div class="you-marker-arrow" id="youMarkerArrow"></div>',
    iconSize: [26, 26],
    iconAnchor: [13, 13]
  });
  const youMarker = L.marker(LAGUNA_CENTER, { icon: youIcon, zIndexOffset: 1000, interactive: false }).addTo(map);
  const youMarkerArrowEl = document.getElementById('youMarkerArrow');

  // A handful of static demo hazard pins, plotted at real Laguna locations
  const staticDemoHazards = [
    { label: 'Pothole · Reported 12m ago', latlng: [14.1180, 121.3010], emoji: '🕳️' },
    { label: 'Flooded street · Reported 40m ago', latlng: [14.2350, 121.1450], emoji: '🌊' },
    { label: 'Road construction ahead', latlng: [14.3050, 121.1080], emoji: '🚧' }
  ];
  staticDemoHazards.forEach(h => {
    const icon = L.divIcon({
      className: 'hazard-pin-icon demo',
      html: `<div class="hp-pulse"></div><div class="hp-emoji">${h.emoji}</div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    });
    L.marker(h.latlng, { icon }).addTo(map).on('click', () => showToast(h.label));
  });

  /*  On Boarder: Auth → Download → App  */
  const stages = document.querySelectorAll('.stage');
  function showStage(id){
    stages.forEach(s => s.classList.toggle('active', s.id === id));
  }

  let currentUser = null;

  // ---------- ROLE-BASED ACCESS CONTROL (admin) ----------
  // currentUser.role is always fetched fresh from the profiles table
  // after login/session-restore — never trusted from anything cached
  // client-side — and isAdmin() is the single place the rest of the UI
  // asks "should this account see admin stuff". This only ever controls
  // whether the Admin Dashboard button/row is *shown*; it is never the
  // thing that actually protects admin-only data. The real protection is
  // the is_admin()-gated Row Level Security policies in
  // supabase-setup.sql, which apply no matter what this function
  // returns or whether someone reveals the button via devtools.
  function isAdmin(){
    return !!(currentUser && currentUser.role === 'admin');
  }

  // Fails safe: any error (network hiccup, RLS unexpectedly denying the
  // read, profiles row missing) leaves the account as a plain 'user'
  // rather than accidentally admin. Also pulls `status` so a disabled
  // account can be caught right after login (see attemptLogin) — never
  // just role.
  async function refreshCurrentUserRole(){
    if (!supabaseClient || !currentUser || !currentUser.id) return;
    try {
      const { data, error } = await supabaseClient
        .from('profiles')
        .select('role, status')
        .eq('id', currentUser.id)
        .single();
      currentUser.role = (!error && data && data.role === 'admin') ? 'admin' : 'user';
      currentUser.status = (!error && data && data.status) ? data.status : 'active';
    } catch (err) {
      currentUser.role = 'user';
      currentUser.status = 'active';
    }
    updateAdminUI();
  }

  function updateAdminUI(){
    const row = document.getElementById('adminRow');
    if (row) row.style.display = isAdmin() ? '' : 'none';
  }

  /* ============================================================
     Auth navigation — Login and Sign Up are two SEPARATE stages
     (#stage-auth and #stage-signup), not tabs on one screen. There is
     no registration form anywhere on the login screen; the only way to
     reach Sign Up is the "Don't have an account?" link below, and the
     only way back is the "Already have an account?" link on the Sign
     Up screen itself. This is a UX/navigation separation only — see
     supabase-setup.sql for the actual security boundary (a signup can
     never write role='admin' no matter which screen it's reached from).
     ============================================================ */
  const authSwitchLink = document.getElementById('authSwitchLink');
  const signupSwitchLink = document.getElementById('signupSwitchLink');

  function clearAuthErrors(){
    document.getElementById('loginError').classList.remove('show');
    document.getElementById('signupError').classList.remove('show');
  }

  function goToSignup(){
    clearAuthErrors();
    showStage('stage-signup');
  }
  function goToLogin(){
    clearAuthErrors();
    showStage('stage-auth');
  }
  authSwitchLink.addEventListener('click', goToSignup);
  signupSwitchLink.addEventListener('click', goToLogin);

  function enterDownloadStage(name, email){
    currentUser = { name: name || 'Juan Dela Cruz', email };
    document.getElementById('dlGreeting').textContent = `Welcome, ${currentUser.name.split(' ')[0]}!`;
    document.getElementById('acctName').textContent = currentUser.name;
    document.getElementById('acctEmail').textContent = currentUser.email;
    // Reset download UI to its just-installed state
    document.getElementById('dlProgressWrap').style.display = 'none';
    document.getElementById('dlFill').style.width = '0%';
    document.getElementById('dlStatusText').textContent = 'Downloading Laguna map tiles… 0%';
    document.getElementById('dlStartBtn').style.display = 'block';
    document.getElementById('dlStartBtn').disabled = false;
    document.getElementById('dlStartBtn').textContent = 'Download Offline Map (~25 MB)';
    document.getElementById('dlContinueBtn').style.display = 'none';
    showStage('stage-download');
  }

  /* ============================================================
     Frontend validation helpers
     - Email must end with @gmail.com
     - Password must be 8+ chars with upper, lower, number, and symbol
     These mirror checks the backend also makes (never trust the
     frontend alone): the create-admin Edge Function re-runs the exact
     same password rule server-side before it will create an Admin
     account, and supabase-setup.sql documents the optional server-side
     Gmail hook. A frontend rule existing here is a UX convenience, not
     the security boundary.
     ============================================================ */
  const GMAIL_ONLY_REGEX = /^[^\s@]+@gmail\.com$/i;
  const UPPER_REGEX = /[A-Z]/;
  const LOWER_REGEX = /[a-z]/;
  const NUMBER_REGEX = /[0-9]/;
  const SYMBOL_REGEX = /[!@#$%^&*(),.?":{}|<>_\-\[\]\\/;'`~+=]/;
  const MIN_PASSWORD_LENGTH = 8;

  function isGmailAddress(email){
    return GMAIL_ONLY_REGEX.test(email);
  }

  // Individual pass/fail per rule — drives both final validation and the
  // real-time requirement checklist (✓ Uppercase / ✓ Lowercase / etc).
  function getPasswordChecks(pass){
    pass = pass || '';
    return {
      length: pass.length >= MIN_PASSWORD_LENGTH,
      upper: UPPER_REGEX.test(pass),
      lower: LOWER_REGEX.test(pass),
      number: NUMBER_REGEX.test(pass),
      symbol: SYMBOL_REGEX.test(pass)
    };
  }

  // 0-5 based on how many rules pass, weighted slightly by raw length so
  // e.g. "Aa1!aaaa" (meets every rule, just barely) doesn't read
  // identically to a much longer strong password.
  function getPasswordScore(pass){
    const checks = getPasswordChecks(pass);
    let score = Object.values(checks).filter(Boolean).length; // 0-5
    if (score === 5 && pass.length >= 12) score = 6; // "Very Strong" ceiling
    return score;
  }

  function passwordStrengthMeta(score){
    if (score <= 1) return { label: 'Very Weak', cls: 's-weak', pct: 15 };
    if (score === 2) return { label: 'Weak', cls: 's-weak', pct: 32 };
    if (score === 3) return { label: 'Medium', cls: 's-medium', pct: 55 };
    if (score === 4) return { label: 'Strong', cls: 's-strong', pct: 78 };
    if (score === 5) return { label: 'Strong', cls: 's-strong', pct: 90 };
    return { label: 'Very Strong', cls: 's-very-strong', pct: 100 };
  }

  // The one real gate — every path that creates or changes a password
  // (Sign Up, and Admin Management's "Create Admin Account") calls this
  // before submitting, and the equivalent check runs again server-side.
  function passwordIssue(pass){
    const c = getPasswordChecks(pass || '');
    if(!c.length) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    if(!c.upper) return 'Password must contain at least one uppercase letter.';
    if(!c.lower) return 'Password must contain at least one lowercase letter.';
    if(!c.number) return 'Password must contain at least one number.';
    if(!c.symbol) return 'Password must contain at least one symbol (e.g. ! @ # $ %).';
    return null;
  }

  // Wires one password field (+ optional confirm field) to a live
  // strength meter, requirement checklist, and match indicator. Reused
  // for both the Sign Up form and the Admin Management "Create Admin
  // Account" form so the two never drift out of sync with each other.
  function wirePasswordStrengthMeter(cfg){
    const pwInput = document.getElementById(cfg.pwId);
    const confirmInput = cfg.confirmId ? document.getElementById(cfg.confirmId) : null;
    const fillEl = document.getElementById(cfg.fillId);
    const labelEl = document.getElementById(cfg.labelId);
    const reqListEl = document.getElementById(cfg.reqListId);
    const matchEl = cfg.matchId ? document.getElementById(cfg.matchId) : null;
    if (!pwInput || !fillEl || !labelEl) return;

    function renderStrength(){
      const pass = pwInput.value;
      const checks = getPasswordChecks(pass);
      const score = getPasswordScore(pass);
      const meta = passwordStrengthMeta(score);
      fillEl.style.width = pass ? meta.pct + '%' : '0%';
      fillEl.className = 'pw-strength-fill' + (pass ? ' ' + meta.cls : '');
      labelEl.textContent = pass ? meta.label : 'Very Weak';
      labelEl.className = 'pw-strength-label' + (pass ? ' ' + meta.cls : '');
      if (reqListEl){
        reqListEl.querySelectorAll('[data-req]').forEach(li => {
          li.classList.toggle('met', !!checks[li.dataset.req]);
        });
      }
    }
    function renderMatch(){
      if (!matchEl || !confirmInput) return;
      const confirmVal = confirmInput.value;
      if (!confirmVal){
        matchEl.classList.remove('show', 'match', 'mismatch');
        return;
      }
      const isMatch = confirmVal === pwInput.value;
      matchEl.textContent = isMatch ? 'Passwords match.' : 'Passwords do not match.';
      matchEl.className = 'pw-match show ' + (isMatch ? 'match' : 'mismatch');
    }

    pwInput.addEventListener('input', () => { renderStrength(); renderMatch(); });
    if (confirmInput) confirmInput.addEventListener('input', renderMatch);
    renderStrength();
    renderMatch();
  }

  wirePasswordStrengthMeter({
    pwId: 'signupPassword',
    confirmId: 'signupConfirmPassword',
    fillId: 'signupPwStrengthFill',
    labelId: 'signupPwStrengthLabel',
    reqListId: 'signupPwRequirements',
    matchId: 'signupPwMatch'
  });
  wirePasswordStrengthMeter({
    pwId: 'adminCreatePassword',
    confirmId: 'adminCreateConfirmPassword',
    fillId: 'adminCreatePwStrengthFill',
    labelId: 'adminCreatePwStrengthLabel',
    reqListId: 'adminCreatePwRequirements',
    matchId: 'adminCreatePwMatch'
  });

  /* Accounts now live in a real database (Supabase: Postgres + Auth)
     instead of localStorage, and passwords are hashed server-side by
     Supabase Auth - this file never sees or stores a raw password.
     See supabase-config.js for one-time setup. */
  function requireSupabase(errEl){
    if(!supabaseClient){
      errEl.textContent = 'App is not connected to a database yet. See supabase-config.js.';
      errEl.classList.add('show');
      return false;
    }
    return true;
  }

  async function attemptLogin(){
    const email = document.getElementById('loginEmail').value.trim();
    const pass = document.getElementById('loginPassword').value;
    const err = document.getElementById('loginError');
    const btn = document.getElementById('loginSubmitBtn');

    if(!email || !pass){
      err.textContent = 'Please fill in both fields.';
      err.classList.add('show');
      return;
    }
    if(!requireSupabase(err)) return;
    // Logging in is the one auth action that genuinely cannot work
    // without a server round-trip (there's no local credential store to
    // check against, by design). Fail fast and clearly here rather than
    // letting the fetch below hang or reject unhandled — a returning
    // user with an already-downloaded map and a still-valid session
    // doesn't hit this at all (see the getSession() restore at the
    // bottom of this file), so this only affects a fresh/expired login.
    if (!navigator.onLine) {
      err.textContent = "You're offline — logging in needs an internet connection. If you've logged in on this device before, reopening the app should sign you back in automatically once it's back online.";
      err.classList.add('show');
      return;
    }

    err.classList.remove('show');
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = 'Logging in…';

    let data, error;
    try {
      ({ data, error } = await supabaseClient.auth.signInWithPassword({
        email,
        password: pass
      }));
    } catch (networkErr) {
      // A fetch-level failure (lost connection mid-request, DNS failure,
      // etc.) throws here instead of resolving with an {error} object —
      // without this catch, the button below would stay stuck on
      // "Logging in…" forever and the rejection would go unhandled.
      btn.disabled = false;
      btn.textContent = originalLabel;
      err.textContent = 'Could not reach the server. Check your connection and try again.';
      err.classList.add('show');
      return;
    }

    btn.disabled = false;
    btn.textContent = originalLabel;

    if(error){
      if(/email not confirmed/i.test(error.message)){
        err.textContent = 'Please confirm your email first — check your inbox for a confirmation link.';
      } else if(/invalid login credentials/i.test(error.message)){
        err.textContent = 'Incorrect email or password. Please try again.';
      } else {
        err.textContent = error.message;
      }
      err.classList.add('show');
      return;
    }

    const user = data.user;
    const name = (user.user_metadata && user.user_metadata.name) || user.email.split('@')[0];
    currentUser = { id: user.id, name, email: user.email };
    await refreshCurrentUserRole();

    // Account status is enforced server-side too (RLS reads/writes for a
    // disabled account are restricted — see is_active() in
    // supabase-setup.sql), but checking it here means a disabled account
    // never even gets as far as seeing app content: we sign it right back
    // out and explain why, rather than letting it in and having every
    // subsequent action silently fail.
    if (currentUser.status === 'disabled') {
      await supabaseClient.auth.signOut();
      currentUser = null;
      err.textContent = 'This account has been disabled. Contact an administrator.';
      err.classList.add('show');
      return;
    }

    loadLivePois();

    if (BiyaStorage.load(BiyaStorage.keys.mapDownloaded, false)) {
      document.getElementById('acctName').textContent = currentUser.name;
      document.getElementById('acctEmail').textContent = currentUser.email;
      navItems.forEach(n => n.classList.toggle('active', n.dataset.view === 'view-map'));
      views.forEach(v => v.classList.toggle('active', v.id === 'view-map'));
      showStage('stage-app');
      resetOriginState();
      GPSManager.start();
      restoreDynamicHazards();
      renderSyncQueue();
      showToast(`Welcome back, ${currentUser.name.split(' ')[0]}!`);
      applyLaunchParams();
    } else {
      enterDownloadStage(currentUser.name, currentUser.email);
    }
  }

  async function attemptSignup(){
    const name = document.getElementById('signupName').value.trim();
    const email = document.getElementById('signupEmail').value.trim();
    const pass = document.getElementById('signupPassword').value;
    const confirmPass = document.getElementById('signupConfirmPassword').value;
    const err = document.getElementById('signupError');
    const btn = document.getElementById('signupSubmitBtn');

    if(!name || !email || !pass || !confirmPass){
      err.textContent = 'Please complete all fields.';
      err.classList.add('show');
      return;
    }
    if(!isGmailAddress(email)){
      err.textContent = 'Please use a valid email address ending in @gmail.com.';
      err.classList.add('show');
      return;
    }
    const pwIssue = passwordIssue(pass);
    if(pwIssue){
      err.textContent = pwIssue;
      err.classList.add('show');
      return;
    }
    if(pass !== confirmPass){
      err.textContent = 'Passwords do not match.';
      err.classList.add('show');
      return;
    }
    if(!requireSupabase(err)) return;
    // Account creation genuinely requires a server (there's nothing to
    // create an account against locally) — same reasoning as the login
    // check above.
    if (!navigator.onLine) {
      err.textContent = "You're offline — creating an account needs an internet connection. Please reconnect and try again.";
      err.classList.add('show');
      return;
    }

    err.classList.remove('show');
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = 'Creating account…';

    let data, error;
    try {
      ({ data, error } = await supabaseClient.auth.signUp({
        email,
        password: pass,
        options: { data: { name } }
      }));
    } catch (networkErr) {
      btn.disabled = false;
      btn.textContent = originalLabel;
      err.textContent = 'Could not reach the server. Check your connection and try again.';
      err.classList.add('show');
      return;
    }

    btn.disabled = false;
    btn.textContent = originalLabel;

    if(error){
      if(/already registered/i.test(error.message) || /already exists/i.test(error.message)){
        err.textContent = 'An account with that email already exists. Try logging in instead.';
      } else {
        err.textContent = error.message;
      }
      err.classList.add('show');
      return;
    }

    // Supabase does NOT reliably throw an error for a duplicate email —
    // when the project has "Confirm email" turned on, signUp() for an
    // email that's already registered and confirmed returns a
    // success-shaped response with an obfuscated/fake user object
    // instead (by design, to avoid letting signup responses be used to
    // probe which emails have accounts). The one reliable tell is an
    // EMPTY identities array on the returned user — a genuinely new
    // signup always has at least one identity. Without this check, a
    // duplicate signup here would wrongly show "Account created! Check
    // your email…" for an account that was never created.
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      err.textContent = 'An account with that email already exists. Try logging in instead.';
      err.classList.add('show');
      return;
    }

    // Depends on your Supabase project's Auth setting for "Confirm email":
    // ON  -> data.session is null; user must click the emailed link first.
    // OFF -> a session comes back immediately, same as the old demo flow.
    if(!data.session){
      showToast(`Account created! Check ${email} to confirm, then log in.`);
      goToLogin();
      document.getElementById('loginEmail').value = email;
      return;
    }

    currentUser = { id: data.user.id, name, email };
    enterDownloadStage(name, email);
  }

  document.getElementById('loginSubmitBtn').addEventListener('click', attemptLogin);
  document.getElementById('signupSubmitBtn').addEventListener('click', attemptSignup);

  ['loginEmail','loginPassword'].forEach(id=>{
    document.getElementById(id).addEventListener('keydown', e=>{ if(e.key === 'Enter') attemptLogin(); });
  });
  ['signupName','signupEmail','signupPassword','signupConfirmPassword'].forEach(id=>{
    document.getElementById(id).addEventListener('keydown', e=>{ if(e.key === 'Enter') attemptSignup(); });
  });

  /*  Password Visibility Toggle (eye icon) — applies to Login  */
  /*  password, Sign Up password, and Sign Up confirm password  */
  document.querySelectorAll('.pw-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      if(!input) return;
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.querySelector('.eye-show').style.display = showing ? '' : 'none';
      btn.querySelector('.eye-hide').style.display = showing ? 'none' : '';
      btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    });
  });

  // Download progress — a real tile download into Cache Storage, not a
  // fake progress bar. See downloadTilesWithProgress() above.
  document.getElementById('dlStartBtn').addEventListener('click', async () => {
    const startBtn = document.getElementById('dlStartBtn');
    const wrap = document.getElementById('dlProgressWrap');
    const fill = document.getElementById('dlFill');
    const statusText = document.getElementById('dlStatusText');
    const continueBtn = document.getElementById('dlContinueBtn');

    if (swRegistrationFailed) {
      statusText.textContent =
        'Offline caching needs this app served over http(s) — open it via a local server, not by double-clicking the file.';
      wrap.style.display = 'block';
      fill.style.width = '0%';
      return;
    }

    startBtn.disabled = true;
    startBtn.textContent = 'Downloading…';
    wrap.style.display = 'block';
    fill.style.width = '0%';
    statusText.textContent = 'Downloading Laguna map tiles… 0%';

    const urls = buildOfflineTileList(LAGUNA_BOUNDS, OFFLINE_ZOOM_MIN, OFFLINE_ZOOM_MAX);

    try {
      const result = await downloadTilesWithProgress(urls, ({ done, total, failed }) => {
        const pct = Math.round((done / total) * 100);
        fill.style.width = pct + '%';
        statusText.textContent = `Downloading Laguna map tiles… ${pct}% (${done}/${total} tiles)`;
      });

      const approxBytes = result.total * AVG_TILE_BYTES;
      const approxMB = (approxBytes / 1024 / 1024).toFixed(1);
      BiyaStorage.save(BiyaStorage.keys.mapDownloaded, true);
      BiyaStorage.save(BiyaStorage.keys.mapBytes, approxBytes);

      statusText.textContent = result.failed
        ? `Map cached with ${result.failed} tile(s) skipped — ~${approxMB} MB stored on device`
        : `Laguna map cached — ~${approxMB} MB stored on device, works offline`;

      startBtn.style.display = 'none';
      continueBtn.style.display = 'block';
      refreshActualStorageEstimate();
    } catch (err) {
      console.error(err);
      statusText.textContent =
        'Could not cache the map — check your connection, or that the app is served over http(s).';
      startBtn.disabled = false;
      startBtn.textContent = 'Retry Download';
    }
  });

  

  document.getElementById('dlContinueBtn').addEventListener('click', () => {

    mapStorageFill.style.width = '100%';
    mapStorageSize.textContent = mapStorageLabel();

    BiyaStorage.save(
        BiyaStorage.keys.mapDownloaded,
        true
    );

    applyNetworkState();
    renderFeed();

    navItems.forEach(n =>
        n.classList.toggle(
            'active',
            n.dataset.view === 'view-map'
        )
    );

    views.forEach(v =>
        v.classList.toggle(
            'active',
            v.id === 'view-map'
        )
    );

    showStage('stage-app');

    resetOriginState();

    // Start actual GPS tracking
    GPSManager.start();

    // Render reports restored from local storage
    restoreDynamicHazards();

    renderSyncQueue();

    showToast(
        `Welcome to BiyaHERO, ${currentUser.name.split(' ')[0]}!`
    );

    applyLaunchParams();
});

  /* ============================================================
     Voice Confirmation Helper
     Shared by the generic Confirm Dialog (Logout / Delete Map /
     Delete Report / etc.) and the hands-free Voice Command hazard
     report flow below. Listens for a short, unambiguous "yes" or
     "no" style reply and calls back accordingly.

     To avoid accidentally confirming a destructive action from
     unrelated background speech: only a FINAL speech result is
     considered (not interim guesses), the whole utterance must be
     short (4 words or fewer), and it must contain a clear
     affirmative/negative word as a whole word. A stray "yes" deep
     inside an unrelated sentence, or someone just talking nearby,
     will not match and simply falls through to the on-screen
     buttons instead.
     ============================================================ */
  const AFFIRM_WORDS = /\b(yes|yeah|yep|yup|confirm|confirmed|sure|okay|ok)\b/i;
  const NEGATE_WORDS  = /\b(no|nope|cancel|stop|nevermind)\b/i;

  function classifyYesNo(rawText){
    const text = rawText.trim().toLowerCase().replace(/[.!?]+$/, '');
    if(!text) return null;
    const wordCount = text.split(/\s+/).length;
    if(wordCount > 4) return null; // too long to be a simple yes/no reply
    if(AFFIRM_WORDS.test(text)) return 'yes';
    if(NEGATE_WORDS.test(text)) return 'no';
    return null;
  }

  let activeYesNoRecognition = null;

  function listenForYesNo({ onYes, onNo }){
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if(!SpeechRecognitionCtor) return null; // caller falls back to on-screen buttons only

    stopYesNoListening(); // only one yes/no listener at a time

    const rec = new SpeechRecognitionCtor();
    rec.lang = 'en-PH';
    rec.continuous = false;
    rec.interimResults = false;
    let settled = false;

    rec.onresult = (event) => {
      let transcript = '';
      for(let i = event.resultIndex; i < event.results.length; i++){
        if(event.results[i].isFinal) transcript += event.results[i][0].transcript;
      }
      const verdict = classifyYesNo(transcript);
      if(settled) return;
      if(verdict === 'yes'){ settled = true; onYes(); }
      else if(verdict === 'no'){ settled = true; onNo(); }
      // Anything else is ignored entirely - never guess.
    };
    rec.onerror = () => { /* silently fall back to on-screen buttons */ };
    rec.onend = () => {
      if(activeYesNoRecognition === rec) activeYesNoRecognition = null;
    };

    try {
      rec.start();
      activeYesNoRecognition = rec;
      return rec;
    } catch(e){
      return null;
    }
  }

  function stopYesNoListening(){
    if(activeYesNoRecognition){
      try { activeYesNoRecognition.stop(); } catch(e){ /* already stopped */ }
      activeYesNoRecognition = null;
    }
  }

  /* ============================================================
     Generic Confirm Dialog
     Reused for Logout, Delete Map, Delete Report, and any future
     destructive/important action. Resolves true (confirmed) or
     false (cancelled) via button tap, backdrop tap, Escape key, or
     a spoken "yes"/"no" when voice recognition is available.
     ============================================================ */
  const confirmDialogBackdrop = document.getElementById('confirmDialogBackdrop');
  const confirmDialogEl = document.getElementById('confirmDialog');
  const confirmDialogTitleEl = document.getElementById('confirmDialogTitle');
  const confirmDialogMessageEl = document.getElementById('confirmDialogMessage');
  const confirmDialogVoiceHintEl = document.getElementById('confirmDialogVoiceHint');
  const confirmDialogCancelBtn = document.getElementById('confirmDialogCancelBtn');
  const confirmDialogConfirmBtn = document.getElementById('confirmDialogConfirmBtn');

  function showConfirmDialog({ title = 'Are you sure?', message = 'This action cannot be undone.', confirmLabel = 'Confirm', cancelLabel = 'Cancel' } = {}){
    return new Promise((resolve) => {
      confirmDialogTitleEl.textContent = title;
      confirmDialogMessageEl.textContent = message;
      confirmDialogConfirmBtn.textContent = confirmLabel;
      confirmDialogCancelBtn.textContent = cancelLabel;

      const voiceAvailable = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
      confirmDialogVoiceHintEl.style.display = voiceAvailable ? 'block' : 'none';

      confirmDialogBackdrop.classList.add('open');
      confirmDialogEl.classList.add('open');

      function cleanup(){
        confirmDialogBackdrop.classList.remove('open');
        confirmDialogEl.classList.remove('open');
        confirmDialogConfirmBtn.removeEventListener('click', onConfirm);
        confirmDialogCancelBtn.removeEventListener('click', onCancel);
        confirmDialogBackdrop.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKeydown);
        stopYesNoListening();
      }
      function onConfirm(){ cleanup(); resolve(true); }
      function onCancel(){ cleanup(); resolve(false); }
      function onKeydown(e){ if(e.key === 'Escape') onCancel(); }

      confirmDialogConfirmBtn.addEventListener('click', onConfirm);
      confirmDialogCancelBtn.addEventListener('click', onCancel);
      confirmDialogBackdrop.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKeydown);

      if(voiceAvailable){
        listenForYesNo({ onYes: onConfirm, onNo: onCancel });
      }
    });
  }

  // Logout — revert everything to a freshly installed state
  document.getElementById('logoutRow').addEventListener('click', async ()=>{
    const confirmed = await showConfirmDialog({
      title: 'Log out?',
      message: 'You will need to log in again to access your account.',
      confirmLabel: 'Log Out'
    });
    if(!confirmed) return;

    closeSheet();
    if(supabaseClient){
      await supabaseClient.auth.signOut();
    }
    currentUser = null;
    closeAdminDashboard();
    updateAdminUI();
    [
      'loginEmail','loginPassword','signupName','signupEmail','signupPassword','signupConfirmPassword',
      'adminCreateName','adminCreateEmail','adminCreatePassword','adminCreateConfirmPassword'
    ].forEach(id=>{
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    clearAuthErrors();
    goToLogin();
    // Reset the sequential origin state — only logging out resets back to Place 1
    resetOriginState();
    showToast('Logged out');
  });

  /*  Theme — controlled only from Settings (darkModeSwitch) now; the old
      homepage icon button has been removed, so this no longer looks up
      or binds themeToggleBtn at all. setTheme() itself is untouched. */
  const root = document.documentElement;
  const darkModeSwitch = document.getElementById('darkModeSwitch');

  function setTheme(theme){
    root.setAttribute('data-theme', theme);
    darkModeSwitch.checked = theme === 'dark';
  }
  darkModeSwitch.addEventListener('change', ()=>{
    setTheme(darkModeSwitch.checked ? 'dark' : 'light');
  });

  /*  Toast  */
  const toast = document.getElementById('toast');
  const toastText = document.getElementById('toastText');
  const legendStripEl = document.getElementById('legendStrip');
  const legendToggleBtnEl = document.getElementById('legendToggleBtn');
  let toastTimer;
  function showToast(msg){
    toastText.textContent = msg;
    const onMap = document.getElementById('view-map').classList.contains('active');
    toast.classList.remove('pos-top', 'pos-bottom');
    if(onMap){
      const legendVisible = !legendStripEl.classList.contains('collapsed');
      const refRect = (legendVisible ? legendStripEl : legendToggleBtnEl).getBoundingClientRect();
      const parentRect = toast.offsetParent.getBoundingClientRect();
      toast.style.top = (refRect.bottom - parentRect.top + 10) + 'px';
      toast.classList.add('pos-top');
    } else {
      toast.style.top = '';
      toast.classList.add('pos-bottom');
    }
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=> toast.classList.remove('show'), 2400);
  }
  window.biyaShowToast = showToast;

  /*  Nav / View Switching  */
  const navItems = document.querySelectorAll('.nav-item');
  const views = document.querySelectorAll('.view');
  const searchBarEl = document.getElementById('searchBar');
  navItems.forEach(item=>{
    item.addEventListener('click', ()=>{
      navItems.forEach(n=>n.classList.remove('active'));
      item.classList.add('active');
      views.forEach(v=>v.classList.toggle('active', v.id === item.dataset.view));
      const hideSearch = item.dataset.view === 'view-settings';
      searchBarEl.style.display = hideSearch ? 'none' : 'flex';
      if(hideSearch) closeSearchDual();
      if(item.dataset.view === 'view-settings') refreshActualStorageEstimate();
    });
  });

  /* Handle manifest "shortcuts" and "share_target" launches (added for
     installed-app / PWA support). Reads query params the very first time
     this load reaches stage-app, then strips them from the URL so a
     later refresh doesn't repeat the same action. No-op if none of
     these params are present, so it never affects a normal launch. */
  function applyLaunchParams(){
    const params = new URLSearchParams(window.location.search);
    if(![...params.keys()].length) return;

    function goToView(viewId){
      navItems.forEach(n => n.classList.toggle('active', n.dataset.view === viewId));
      views.forEach(v => v.classList.toggle('active', v.id === viewId));
      const hideSearch = viewId === 'view-settings';
      searchBarEl.style.display = hideSearch ? 'none' : 'flex';
      if(hideSearch) closeSearchDual();
    }

    // manifest "shortcuts" entries (Report / Community / Settings)
    const shortcut = params.get('shortcut');
    if(shortcut === 'community'){
      goToView('view-community');
    } else if(shortcut === 'settings'){
      goToView('view-settings');
      refreshActualStorageEstimate();
    } else if(shortcut === 'report'){
      goToView('view-map');
      openSheet();
    }

    // manifest "share_target": user shared a link/photo caption/location
    // into BiyaHERO from another app - drop it straight into a new report.
    const sharedTitle = params.get('share-title');
    const sharedText = params.get('share-text');
    const sharedUrl = params.get('share-url');
    if(sharedTitle || sharedText || sharedUrl){
      goToView('view-map');
      openSheet();
      const noteInput = document.getElementById('noteInput');
      if(noteInput){
        noteInput.value = [sharedTitle, sharedText, sharedUrl].filter(Boolean).join(' — ');
      }
      showToast('Shared content added to your report note');
    }

    // Avoid re-triggering the same shortcut/share action on a later
    // refresh of the installed app.
    window.history.replaceState({}, '', window.location.pathname);
  }

  /*  Network State  */
  const offlineBadge = document.getElementById('offlineBadge');
  const offlineBadgeText = document.getElementById('offlineBadgeText');
  const networkSwitch = document.getElementById('networkSwitch');
  const networkSub = document.getElementById('networkSub');
  // Real connectivity, not a fixed default — this is what actually
  // decides whether reports queue locally or sync automatically.
  let isOnline = navigator.onLine;

  function applyNetworkState(){
    networkSwitch.checked = isOnline;
    if(isOnline){
      offlineBadge.classList.remove('offline'); offlineBadge.classList.add('online');
      offlineBadgeText.textContent = 'Online — syncing live traffic';
      networkSub.textContent = 'Online — receiving live updates';
    } else {
      offlineBadge.classList.remove('online'); offlineBadge.classList.add('offline');
      offlineBadgeText.textContent = 'Offline Mode: Luzon Map Active';
      networkSub.textContent = 'Offline — using local Luzon map';
    }
    renderSyncQueue();
  }

  function goOnline(){
    isOnline = true;
    applyNetworkState();
    if(pendingReports.length){
      showToast('Back online — auto-syncing reports…');
      setTimeout(syncNow, 700);
    }
  }
  function goOffline(){
    isOnline = false;
    applyNetworkState();
  }

  // Real automatic detection — this is what makes sync "automatic"
  // instead of requiring the person to flip the Settings switch.
  window.addEventListener('online', goOnline);
  window.addEventListener('offline', goOffline);

  // The Settings switch stays available as a manual override, mainly
  // useful for demoing the offline flow on a machine that's actually
  // online (e.g. presenting the project without airplane mode).
  networkSwitch.addEventListener('change', ()=>{
    if(networkSwitch.checked) goOnline(); else goOffline();
  });

  /*  Pending Sync Queue  */
  const DEFAULT_PENDING_REPORTS = [
    { label: 'Pothole', time: '2h ago' },
    { label: 'Flooded Street', time: '5h ago' }
];

let pendingReports = BiyaStorage.load(
    BiyaStorage.keys.pendingReports,
    DEFAULT_PENDING_REPORTS
);
function savePendingReports() {
    BiyaStorage.save(
        BiyaStorage.keys.pendingReports,
        pendingReports
    );
}

function saveDynamicHazards() {
    BiyaStorage.save(
        BiyaStorage.keys.hazards,
        dynamicHazards
    );
}
  const syncQueueCard = document.getElementById('syncQueueCard');

  function renderSyncQueue(){
    if(!pendingReports.length){
      syncQueueCard.innerHTML = '<div class="sync-empty">No pending reports. Everything is synced.</div>';
      return;
    }
    let html = pendingReports.map((r,i)=>`
      <div class="sync-item">
        <div class="sync-item-left">
          <span class="sync-dot"></span>
          <div>
            <div class="sync-item-title">${r.label}</div>
            <div class="sync-item-sub">Saved locally · ${r.time}</div>
          </div>
        </div>
        <button class="btn-mini danger" data-i="${i}" style="flex:none; padding:6px 12px;">Delete</button>
      </div>
    `).join('');
    html += `<button class="sync-cta" id="syncNowBtn" ${isOnline ? '' : 'style="opacity:.5;pointer-events:none;"'}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.85-4.36L23 10M1 14l4.65 5.36A9 9 0 0 0 20.5 15"/></svg>
      Sync Now (${pendingReports.length})
    </button>`;
    syncQueueCard.innerHTML = html;
    const btn = document.getElementById('syncNowBtn');
    if(btn) btn.addEventListener('click', syncNow);
    syncQueueCard.querySelectorAll('.btn-mini.danger[data-i]').forEach(delBtn=>{
      delBtn.addEventListener('click', ()=>{
        const i = +delBtn.dataset.i;
     const removed =
    pendingReports.splice(i, 1)[0];

if (removed && removed.id) {

    dynamicHazards =
        dynamicHazards.filter(
            h => h.id !== removed.id
        );

    const pinMarker =
        dynamicHazardMarkers[removed.id];

    if (pinMarker) {
        dynamicHazardGroup.removeLayer(pinMarker);
        delete dynamicHazardMarkers[removed.id];
    }
}

// Save after all modifications
savePendingReports();

saveDynamicHazards();

renderSyncQueue();

showToast(
    removed
        ? `Removed "${removed.label}" report`
        : 'Report removed'
);
      }); // close: delBtn.addEventListener('click', ...)
    }); // close: syncQueueCard.querySelectorAll(...).forEach(...)
  } // close: function renderSyncQueue()

  async function syncNow() {

    if (!isOnline || !pendingReports.length) {
        return;
    }
    if (!supabaseClient) {
        showToast('Cannot sync — app is not connected to a database yet.');
        return;
    }

    // Real sync: each queued report is inserted into the shared
    // public.hazard_reports table (see supabase-setup.sql) so it's
    // visible to other commuters and to the Admin Dashboard — this
    // replaces the old placeholder that just marked reports "uploaded"
    // locally without sending them anywhere. A report with no GPS fix
    // (location came back null — e.g. reported the moment permission was
    // granted) has nothing to insert against hazard_reports' required
    // lat/lng columns, so it's left in the queue rather than silently
    // dropped or faked with a 0,0 location.
    const syncable = pendingReports.filter(r => r.location && r.location.latitude != null);
    const unsyncable = pendingReports.length - syncable.length;
    if (!syncable.length) {
        showToast('Nothing to sync yet — queued report(s) have no GPS location recorded.');
        return;
    }

    const rows = syncable.map(r => ({
        reporter_id: currentUser && currentUser.id ? currentUser.id : null,
        label: r.label,
        category: r.label,
        lat: r.location.latitude,
        lng: r.location.longitude,
        note: r.note || null
    }));

    const { error } = await supabaseClient.from('hazard_reports').insert(rows);

    if (error) {
        console.warn('Hazard report sync failed:', error.message || error);
        showToast('Sync failed — will retry next time you\'re online.');
        return;
    }

    const syncedIds = new Set(syncable.map(r => r.id));
    const count = syncable.length;

    // Only the ones that actually made it to the server come out of the
    // local queue — unsyncable (no-location) reports stay queued.
    pendingReports = pendingReports.filter(r => !syncedIds.has(r.id));

    savePendingReports();

    dynamicHazards = dynamicHazards.map(
        hazard => syncedIds.has(hazard.id)
            ? { ...hazard, syncStatus: 'synced' }
            : hazard
    );

    saveDynamicHazards();

    renderSyncQueue();

    showToast(
        unsyncable > 0
            ? `${count} report${count > 1 ? 's' : ''} synced · ${unsyncable} waiting for GPS`
            : `${count} report${count > 1 ? 's' : ''} synced successfully`
    );
}

  // ---------- ADMIN DASHBOARD ----------
  // Moderates the shared public.hazard_reports table (all commuters'
  // synced reports, not just this device's local queue — see
  // pendingReports/syncNow above for the local-queue side of things).
  // Every action here (resolve/dismiss/delete) is a plain Supabase call
  // that is only actually permitted by the is_admin()-gated RLS policies
  // in supabase-setup.sql — this code doesn't and can't do its own
  // authorization check client-side that would mean anything.
  const adminBackdropEl = document.getElementById('adminBackdrop');
  const adminDashboardEl = document.getElementById('adminDashboard');
  const adminReportsListEl = document.getElementById('adminReportsList');

  function timeAgo(iso){
    const ms = Date.now() - new Date(iso).getTime();
    const mins = Math.round(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  }

  async function loadAdminReports(){
    if (!supabaseClient) {
      adminReportsListEl.innerHTML = '<div class="sync-empty">App is not connected to a database yet.</div>';
      return;
    }
    adminReportsListEl.innerHTML = '<div class="sync-empty">Loading…</div>';
    const { data, error } = await supabaseClient
      .from('hazard_reports')
      .select('id, label, category, lat, lng, note, status, created_at')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      // A non-admin account somehow reaching this dashboard (e.g. an
      // admin logged out and a regular user logged in on the same
      // device without the page reloading) gets exactly this: RLS
      // silently returns nothing/errors rather than the data, and the
      // dashboard says so plainly instead of showing stale or fake rows.
      adminReportsListEl.innerHTML = `<div class="sync-empty">Could not load reports — ${
        /permission|policy|rls/i.test(error.message || '') ? 'not authorized for this account.' : 'please try again.'
      }</div>`;
      return;
    }

    if (!data || !data.length) {
      adminReportsListEl.innerHTML = '<div class="sync-empty">No hazard reports yet.</div>';
      return;
    }

    adminReportsListEl.innerHTML = data.map(r => `
      <div class="admin-report-row" data-id="${r.id}">
        <div class="admin-report-top">
          <div class="admin-report-title">${r.label || r.category || 'Hazard'}</div>
          <div class="admin-report-status ${r.status}">${r.status}</div>
        </div>
        <div class="admin-report-sub">${r.lat.toFixed(5)}, ${r.lng.toFixed(5)} · ${timeAgo(r.created_at)}</div>
        ${r.note ? `<div class="admin-report-note">${r.note}</div>` : ''}
        <div class="admin-report-actions">
          <div class="btn-mini primary admin-resolve-btn" ${r.status === 'resolved' ? 'style="opacity:.5;pointer-events:none;"' : ''}>Resolve</div>
          <div class="btn-mini admin-dismiss-btn" ${r.status === 'dismissed' ? 'style="opacity:.5;pointer-events:none;"' : ''}>Dismiss</div>
          <div class="btn-mini danger admin-delete-btn">Delete</div>
        </div>
      </div>
    `).join('');
  }

  async function setReportStatus(id, status){
    const { error } = await supabaseClient
      .from('hazard_reports')
      .update({ status, moderated_at: new Date().toISOString(), moderated_by: currentUser ? currentUser.id : null })
      .eq('id', id);
    if (error) {
      showToast('Action not allowed for this account.');
      return;
    }
    loadAdminReports();
  }

  async function deleteReport(id){
    const confirmed = await showConfirmDialog({
      title: 'Delete this report?',
      message: 'This removes it from the shared hazard feed for every commuter.',
      confirmLabel: 'Delete'
    });
    if (!confirmed) return;
    const { error } = await supabaseClient.from('hazard_reports').delete().eq('id', id);
    if (error) {
      showToast('Action not allowed for this account.');
      return;
    }
    loadAdminReports();
  }

  adminReportsListEl.addEventListener('click', (e) => {
    const row = e.target.closest('.admin-report-row');
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.closest('.admin-resolve-btn')) setReportStatus(id, 'resolved');
    else if (e.target.closest('.admin-dismiss-btn')) setReportStatus(id, 'dismissed');
    else if (e.target.closest('.admin-delete-btn')) deleteReport(id);
  });

  // ---------- ADMIN DASHBOARD: MAP POIs ----------
  // Manages the same public.pois table loadLivePois() (above) reads from
  // — an add/edit/delete here shows up on every commuter's map on their
  // next sync, the same way a resolved hazard report does. Categories in
  // the dropdown are pulled straight from POI_ICON_SVG (plus the two
  // routing-only categories, Road/Highway) so an admin can never create a
  // POI in a category the map has no icon for.
  const adminPoisListEl = document.getElementById('adminPoisList');
  const poiFormCategoryEl = document.getElementById('poiFormCategory');
  const poiFormErrorEl = document.getElementById('poiFormError');
  // Populated lazily (on first dashboard open) rather than right here —
  // POI_ICON_SVG itself isn't declared until further down this same
  // top-level script, so reading it this early (before that line has run)
  // would throw. Calling this from openAdminDashboard() guarantees the
  // whole script has already finished its synchronous top-level pass.
  let poiCategoryOptionsPopulated = false;
  function populatePoiCategoryOptions(){
    if (poiCategoryOptionsPopulated) return;
    const categories = [...Object.keys(POI_ICON_SVG), 'Road', 'Highway'].sort();
    poiFormCategoryEl.innerHTML = categories.map(c => `<option value="${c}">${c}</option>`).join('');
    poiCategoryOptionsPopulated = true;
  }

  async function loadAdminPois(){
    if (!supabaseClient) {
      adminPoisListEl.innerHTML = '<div class="sync-empty">App is not connected to a database yet.</div>';
      return;
    }
    adminPoisListEl.innerHTML = '<div class="sync-empty">Loading…</div>';
    const { data, error } = await supabaseClient
      .from('pois')
      .select('id, name, sub, category, lat, lng')
      .order('name');

    if (error) {
      adminPoisListEl.innerHTML = `<div class="sync-empty">Could not load POIs — ${
        /permission|policy|rls/i.test(error.message || '') ? 'not authorized for this account.' : 'please try again.'
      }</div>`;
      return;
    }
    if (!data || !data.length) {
      adminPoisListEl.innerHTML = '<div class="sync-empty">No POIs yet.</div>';
      return;
    }
    adminPoisListEl.innerHTML = data.map(p => `
      <div class="admin-poi-row" data-id="${p.id}">
        <div class="admin-poi-info">
          <div class="admin-poi-name">${p.name}</div>
          <div class="admin-poi-sub">${p.category} · ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}</div>
        </div>
        <div class="admin-poi-actions">
          <div class="btn-mini danger admin-poi-delete-btn">Delete</div>
        </div>
      </div>
    `).join('');
  }

  async function deletePoi(id, name){
    const confirmed = await showConfirmDialog({
      title: 'Delete this POI?',
      message: `"${name}" will disappear from every commuter's map on their next sync.`,
      confirmLabel: 'Delete'
    });
    if (!confirmed) return;
    const { error } = await supabaseClient.from('pois').delete().eq('id', id);
    if (error) {
      showToast('Action not allowed for this account.');
      return;
    }
    loadAdminPois();
    loadLivePois();
    showToast(`Deleted "${name}"`);
  }

  adminPoisListEl.addEventListener('click', (e) => {
    const row = e.target.closest('.admin-poi-row');
    if (!row) return;
    if (e.target.closest('.admin-poi-delete-btn')) {
      const nameEl = row.querySelector('.admin-poi-name');
      deletePoi(row.dataset.id, nameEl ? nameEl.textContent : 'this POI');
    }
  });

  document.getElementById('poiFormSubmitBtn').addEventListener('click', async () => {
    const name = document.getElementById('poiFormName').value.trim();
    const sub = document.getElementById('poiFormSub').value.trim();
    const category = poiFormCategoryEl.value;
    const lat = parseFloat(document.getElementById('poiFormLat').value);
    const lng = parseFloat(document.getElementById('poiFormLng').value);

    poiFormErrorEl.classList.remove('show');
    if (!name) {
      poiFormErrorEl.textContent = 'Please enter a name.';
      poiFormErrorEl.classList.add('show');
      return;
    }
    if (!Number.isFinite(lat) || lat < 12.5 || lat > 15.5 || !Number.isFinite(lng) || lng < 120 || lng > 122.5) {
      // Loose bounding box around Laguna/CALABARZON — catches the common
      // mistakes (blank field, swapped lat/lng, a stray extra digit)
      // without hard-coding an exact provincial boundary.
      poiFormErrorEl.textContent = 'Please enter valid latitude/longitude within the Laguna area.';
      poiFormErrorEl.classList.add('show');
      return;
    }
    if (!supabaseClient) {
      poiFormErrorEl.textContent = 'App is not connected to a database yet.';
      poiFormErrorEl.classList.add('show');
      return;
    }

    const { error } = await supabaseClient.from('pois').insert({
      name, sub: sub || null, category, lat, lng,
      created_by: currentUser ? currentUser.id : null
    });

    if (error) {
      poiFormErrorEl.textContent = /permission|policy|rls/i.test(error.message || '')
        ? 'Not authorized for this account.'
        : (error.message || 'Could not save this POI.');
      poiFormErrorEl.classList.add('show');
      return;
    }

    ['poiFormName','poiFormSub','poiFormLat','poiFormLng'].forEach(id => {
      document.getElementById(id).value = '';
    });
    loadAdminPois();
    loadLivePois();
    showToast(`Added "${name}"`);
  });

  // ---------- ADMIN DASHBOARD: ADMIN MANAGEMENT ----------
  // This is the ONLY create-admin surface in the whole app, and it only
  // renders inside a sheet that already requires isAdmin(). But the real
  // gate is server-side: creating an Admin account needs Supabase's
  // service-role privileges (auth.admin.createUser) to mint a new auth
  // user without hijacking the calling admin's own session, which a
  // public anon-key client can never safely hold — so this calls a
  // Supabase Edge Function (see supabase/functions/create-admin/index.ts)
  // instead of writing to any table directly. That function independently
  // re-verifies the caller is an admin (from the profiles table, via
  // service role — never from anything the browser sends it) before it
  // will create anything, re-runs the same password-strength rule
  // server-side, and forces the new account's role to 'admin' itself.
  // Even a hand-crafted request straight to the function's URL with a
  // stolen/forged body still gets rejected unless the caller's own
  // Supabase session belongs to an existing admin.
  const adminAccountsListEl = document.getElementById('adminAccountsList');
  const adminCreateErrorEl = document.getElementById('adminCreateError');
  const adminCreateSubmitBtn = document.getElementById('adminCreateSubmitBtn');

  async function loadAdminAccounts(){
    if (!supabaseClient) {
      adminAccountsListEl.innerHTML = '<div class="sync-empty">App is not connected to a database yet.</div>';
      return;
    }
    adminAccountsListEl.innerHTML = '<div class="sync-empty">Loading…</div>';
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('id, name, email, role, status, created_at')
      .eq('role', 'admin')
      .order('created_at', { ascending: true });

    if (error) {
      adminAccountsListEl.innerHTML = `<div class="sync-empty">Could not load admin accounts — ${
        /permission|policy|rls/i.test(error.message || '') ? 'not authorized for this account.' : 'please try again.'
      }</div>`;
      return;
    }
    if (!data || !data.length) {
      adminAccountsListEl.innerHTML = '<div class="sync-empty">No admin accounts yet.</div>';
      return;
    }

    adminAccountsListEl.innerHTML = data.map(a => {
      const isSelf = currentUser && a.id === currentUser.id;
      const disabled = a.status === 'disabled';
      return `
      <div class="admin-account-row" data-id="${a.id}" data-status="${a.status || 'active'}">
        <div class="admin-account-info">
          <div class="admin-account-name">
            ${a.name || a.email}
            <span class="admin-account-badge ${isSelf ? 'you' : ''}">${isSelf ? 'You' : 'Admin'}</span>
          </div>
          <div class="admin-account-sub ${disabled ? 'admin-account-status-disabled' : ''}">${a.email} · ${disabled ? 'Disabled' : 'Active'}</div>
        </div>
        <div class="admin-account-actions">
          ${isSelf
            ? ''
            : `<div class="btn-mini ${disabled ? '' : 'danger'} admin-account-toggle-btn">${disabled ? 'Reactivate' : 'Disable'}</div>`
          }
        </div>
      </div>
    `;
    }).join('');
  }

  async function toggleAdminAccountStatus(id, currentStatus, name){
    const disabling = currentStatus !== 'disabled';
    const confirmed = await showConfirmDialog({
      title: disabling ? 'Disable this admin account?' : 'Reactivate this admin account?',
      message: disabling
        ? `"${name}" will immediately lose access and be signed out of any active session.`
        : `"${name}" will be able to log in again.`,
      confirmLabel: disabling ? 'Disable' : 'Reactivate'
    });
    if (!confirmed) return;

    const { error } = await supabaseClient
      .from('profiles')
      .update({ status: disabling ? 'disabled' : 'active' })
      .eq('id', id);

    if (error) {
      showToast('Action not allowed for this account.');
      return;
    }
    loadAdminAccounts();
    showToast(disabling ? `Disabled "${name}"` : `Reactivated "${name}"`);
  }

  adminAccountsListEl.addEventListener('click', (e) => {
    const row = e.target.closest('.admin-account-row');
    if (!row) return;
    if (e.target.closest('.admin-account-toggle-btn')) {
      const nameEl = row.querySelector('.admin-account-name');
      toggleAdminAccountStatus(row.dataset.id, row.dataset.status, nameEl ? nameEl.textContent.replace('Admin','').trim() : 'this account');
    }
  });

  document.getElementById('adminCreateSubmitBtn').addEventListener('click', async () => {
    const name = document.getElementById('adminCreateName').value.trim();
    const email = document.getElementById('adminCreateEmail').value.trim();
    const pass = document.getElementById('adminCreatePassword').value;
    const confirmPass = document.getElementById('adminCreateConfirmPassword').value;

    adminCreateErrorEl.classList.remove('show');

    if (!name || !email || !pass || !confirmPass) {
      adminCreateErrorEl.textContent = 'Please complete all fields.';
      adminCreateErrorEl.classList.add('show');
      return;
    }
    if (!isGmailAddress(email)) {
      adminCreateErrorEl.textContent = 'Please use a valid email address ending in @gmail.com.';
      adminCreateErrorEl.classList.add('show');
      return;
    }
    const pwIssue = passwordIssue(pass);
    if (pwIssue) {
      adminCreateErrorEl.textContent = pwIssue;
      adminCreateErrorEl.classList.add('show');
      return;
    }
    if (pass !== confirmPass) {
      adminCreateErrorEl.textContent = 'Passwords do not match.';
      adminCreateErrorEl.classList.add('show');
      return;
    }
    if (!supabaseClient) {
      adminCreateErrorEl.textContent = 'App is not connected to a database yet.';
      adminCreateErrorEl.classList.add('show');
      return;
    }

    adminCreateSubmitBtn.disabled = true;
    const originalLabel = adminCreateSubmitBtn.textContent;
    adminCreateSubmitBtn.textContent = 'Creating admin…';

    // functions.invoke() automatically attaches the current session's
    // access token as the Authorization header — that token (belonging
    // to whichever account is signed in right now) is what the Edge
    // Function actually checks server-side. Unlike auth.signUp(), this
    // never touches or replaces the calling admin's own session.
    const { data, error } = await supabaseClient.functions.invoke('create-admin', {
      body: { name, email, password: pass }
    });

    adminCreateSubmitBtn.disabled = false;
    adminCreateSubmitBtn.textContent = originalLabel;

    if (error || (data && data.error)) {
      adminCreateErrorEl.textContent = (data && data.error) || error.message || 'Could not create admin account.';
      adminCreateErrorEl.classList.add('show');
      return;
    }

    ['adminCreateName','adminCreateEmail','adminCreatePassword','adminCreateConfirmPassword'].forEach(id => {
      document.getElementById(id).value = '';
    });
    document.getElementById('adminCreatePassword').dispatchEvent(new Event('input'));
    loadAdminAccounts();
    showToast(`Admin account created for "${name}"`);
  });

  // Reports/POIs/Admin Management tab switch, scoped to the admin
  // dashboard specifically (its own data-admintab attribute, separate
  // from the report sheet's own .sheet-tab usage elsewhere in this file).
  const adminTabButtons = document.querySelectorAll('[data-admintab]');
  const adminTabPanels = {
    reports: document.getElementById('admintabpanel-reports'),
    pois: document.getElementById('admintabpanel-pois'),
    admins: document.getElementById('admintabpanel-admins')
  };
  adminTabButtons.forEach(tab => {
    tab.addEventListener('click', () => {
      adminTabButtons.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.admintab;
      Object.entries(adminTabPanels).forEach(([key, panel]) => {
        panel.style.display = key === target ? 'block' : 'none';
      });
      if (target === 'pois') loadAdminPois();
      if (target === 'admins') loadAdminAccounts();
    });
  });

  function openAdminDashboard(){
    // Belt-and-suspenders: even though the row that triggers this is
    // itself hidden for non-admins (updateAdminUI), re-check here so a
    // stale isAdmin() state (e.g. right after an account switch) can't
    // pop the dashboard open for a second before the reports query
    // predictably fails its RLS check anyway.
    if (!isAdmin()) return;
    adminBackdropEl.classList.add('open');
    adminDashboardEl.classList.add('open');
    populatePoiCategoryOptions();
    // Always reopen on the Reports tab, regardless of which tab was
    // active last time this was closed.
    document.querySelectorAll('[data-admintab]').forEach(t => t.classList.toggle('active', t.dataset.admintab === 'reports'));
    document.getElementById('admintabpanel-reports').style.display = 'block';
    document.getElementById('admintabpanel-pois').style.display = 'none';
    document.getElementById('admintabpanel-admins').style.display = 'none';
    loadAdminReports();
  }

  function closeAdminDashboard(){
    adminBackdropEl.classList.remove('open');
    adminDashboardEl.classList.remove('open');
  }

  document.getElementById('openAdminDashboardRow').addEventListener('click', openAdminDashboard);
  document.getElementById('closeAdminDashboardBtn').addEventListener('click', closeAdminDashboard);
  adminBackdropEl.addEventListener('click', closeAdminDashboard);


  /*  Offiline Map Manger  */
  const mapStorageSize = document.getElementById('mapStorageSize');
  const mapStorageFill = document.getElementById('mapStorageFill');

  // Single source of truth for the "150 MB · Downloaded"-style label,
  // built from the real (approximate) byte count we saved after the
  // last actual tile download — not a hardcoded number.
  function mapStorageLabel(){
    const bytes = BiyaStorage.load(BiyaStorage.keys.mapBytes, 0);
    if(!bytes) return '0 MB · Not downloaded';
    return `~${(bytes/1024/1024).toFixed(1)} MB · Downloaded`;
  }

  // "X tiles cached this session" — driven by TILE_CACHED messages the
  // Service Worker broadcasts whenever it opportunistically caches a tile
  // outside the bulk 10-14 download (see sw.js). Session-scoped and
  // in-memory only by design: it's runtime feedback for "yes, this is
  // actually being cached as you browse," not a persisted stat, so it
  // resets on reload same as the SW's own counter does.
  const sessionTileCountLine = document.getElementById('sessionTileCountLine');
  const sessionTileCountText = document.getElementById('sessionTileCountText');
  function updateSessionTileCount(total){
    if (!sessionTileCountText) return;
    sessionTileCountLine.style.display = 'block';
    sessionTileCountText.textContent =
      `${total} tile${total === 1 ? '' : 's'} cached this session (zoom 15-17, as you browse)`;
  }
  window.biyaUpdateSessionTileCount = updateSessionTileCount;

  // Real device usage via the Storage Estimate API, as a check against the
  // AVG_TILE_BYTES approximation used for the immediate post-download
  // readout. navigator.storage.estimate() reports usage for the whole
  // origin (localStorage + all Cache Storage, shell + tiles combined) —
  // not just TILE_CACHE — so this is labeled accordingly rather than
  // implied to be tile-only.
  const actualStorageText = document.getElementById('actualStorageText');
  async function refreshActualStorageEstimate(){
    if (!actualStorageText) return;
    if (!('storage' in navigator) || !('estimate' in navigator.storage)) {
      actualStorageText.textContent = 'Actual device storage: not supported in this browser';
      return;
    }
    try {
      const { usage } = await navigator.storage.estimate();
      const usageMB = ((usage || 0) / 1024 / 1024).toFixed(1);
      actualStorageText.textContent = `Actual device storage used: ~${usageMB} MB (all app data, via StorageManager)`;
    } catch (err) {
      actualStorageText.textContent = 'Actual device storage: unavailable';
    }
  }

  document.getElementById('updateMapBtn').addEventListener('click', async ()=>{
    if(swRegistrationFailed){
      showToast('Offline caching needs this app served over http(s)');
      return;
    }
    mapStorageFill.style.width = '0%';
    mapStorageSize.textContent = 'Updating…';

    const urls = buildOfflineTileList(LAGUNA_BOUNDS, OFFLINE_ZOOM_MIN, OFFLINE_ZOOM_MAX);
    try {
      // Re-fetching re-downloads every tile fresh (cache.put overwrites
      // any existing entry for that URL), so this also refreshes tiles
      // that changed on OSM since the original download.
      await clearTileCache();
      const result = await downloadTilesWithProgress(urls, ({done, total})=>{
        mapStorageFill.style.width = Math.round((done/total)*100) + '%';
      });
      const approxBytes = result.total * AVG_TILE_BYTES;
      BiyaStorage.save(BiyaStorage.keys.mapDownloaded, true);
      BiyaStorage.save(BiyaStorage.keys.mapBytes, approxBytes);
      mapStorageSize.textContent = mapStorageLabel();
      refreshActualStorageEstimate();
      showToast('Laguna map updated');
    } catch(err){
      console.error(err);
      mapStorageSize.textContent = mapStorageLabel();
      showToast('Could not update the map — check your connection');
    }
  });

  document.getElementById('deleteMapBtn').addEventListener('click', async () => {
    const confirmed = await showConfirmDialog({
      title: 'Delete offline map?',
      message: 'You will need to re-download the Laguna map to use BiyaHERO offline again.',
      confirmLabel: 'Delete Map'
    });
    if(!confirmed) return;

    mapStorageFill.style.width = '0%';
    mapStorageSize.textContent = '0 MB · Not downloaded';

    BiyaStorage.remove(BiyaStorage.keys.mapDownloaded);
    BiyaStorage.remove(BiyaStorage.keys.mapBytes);
    await clearTileCache();
    refreshActualStorageEstimate();

    showToast('Offline map deleted');
  });

  /*  Hazard Report Sheet  */
  const sheetBackdrop = document.getElementById('sheetBackdrop');
  const reportSheet = document.getElementById('reportSheet');
  const fabReport = document.getElementById('fabReport');
  const closeSheetBtn = document.getElementById('closeSheetBtn');

  function openSheet(){
    sheetBackdrop.classList.add('open');
    reportSheet.classList.add('open');
  }
  function closeSheet(){
    sheetBackdrop.classList.remove('open');
    reportSheet.classList.remove('open');
    resetVoiceTab();
  }
  fabReport.addEventListener('click', openSheet);
  closeSheetBtn.addEventListener('click', closeSheet);
  sheetBackdrop.addEventListener('click', closeSheet);

  // Sheet tabs
  const sheetTabs = document.querySelectorAll('.sheet-tab');
  const panelManual = document.getElementById('tabpanel-manual');
  const panelVoice = document.getElementById('tabpanel-voice');
  sheetTabs.forEach(tab=>{
    tab.addEventListener('click', ()=>{
      sheetTabs.forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      const isManual = tab.dataset.tab === 'manual';
      panelManual.style.display = isManual ? 'block' : 'none';
      panelVoice.style.display = isManual ? 'none' : 'block';
    });
  });

  // Category pills
  let selectedCat = null;
  const submitBtn = document.getElementById('submitManualBtn');
  document.querySelectorAll('.cat-pill').forEach(pill=>{
    pill.addEventListener('click', ()=>{
      document.querySelectorAll('.cat-pill').forEach(p=>p.classList.remove('selected'));
      pill.classList.add('selected');
      selectedCat = pill.dataset.cat;
      submitBtn.disabled = false;
      submitBtn.textContent = `Save "${selectedCat}" Report`;
    });
  });

  submitBtn.addEventListener('click', () => {

    if (!selectedCat) return;

    const noteInput =
        document.getElementById('noteInput');

    const noteVal =
        noteInput
            ? noteInput.value.trim()
            : '';

    const reportId =
        'hz_' + Date.now();

    const gpsLocation =
        GPSManager.getCurrentLocation();

    const report = {
      confirmations: 0,

disputes: 0,

initialConfidence: 0,

confidence: 0,

confidenceStatus: 'Low Reliability',

        id: reportId,

        label: selectedCat,

        time: 'just now',

        note:
            noteVal ||
            'No additional notes provided.',

        location:
            gpsLocation.latitude !== null
                ? {
                    latitude: gpsLocation.latitude,
                    longitude: gpsLocation.longitude,
                    accuracy: gpsLocation.accuracy
                }
                : null,

        speedAtReport:
            gpsLocation.speedKmh || 0,

        timestamp:
            new Date().toISOString(),

        syncStatus: 'pending'
    };
    
report.initialConfidence =
    calculateInitialConfidence(report);

updateHazardConfidence(report);
   pendingReports.unshift(report);

savePendingReports();

addDynamicHazardPin(report);

addHazardToCommunityFeed(report);

renderSyncQueue();

    showToast(
        report.location
            ? 'Report saved locally with GPS location'
            : 'Report saved locally — GPS unavailable'
    );

    closeSheet();

    document
        .querySelectorAll('.cat-pill')
        .forEach(p =>
            p.classList.remove('selected')
        );

    if (noteInput) {
        noteInput.value = '';
    }

    selectedCat = null;

    submitBtn.disabled = true;

    submitBtn.textContent =
        'Select a hazard type to continue';
});

  /*  Voice Hazard Reporting  */

const micOrb = document.getElementById('micOrb');

const voiceStatus =
    document.getElementById('voiceStatus');

const voiceTranscript =
    document.getElementById('voiceTranscript');

const voiceActions =
    document.getElementById('voiceActions');

const voiceCancelBtn =
    document.getElementById('voiceCancelBtn');

const voiceConfirmBtn =
    document.getElementById('voiceConfirmBtn');


let recognition = null;

let recognizedTranscript = '';

let recognizedHazard = null;


/*  Detect Hazard From Spoken Words  */

function detectVoiceHazard(text) {

    const speech =
        text.toLowerCase();

    // Pothole
    if (
        speech.includes('pothole') ||
        speech.includes('pot hole')
    ) {
        return 'Pothole';
    }


    // Flood
    if (
        speech.includes('flood') ||
        speech.includes('flooded') ||
        speech.includes('flooding')
    ) {
        return 'Flooded Street';
    }


    // Road construction
    if (
        speech.includes('construction') ||
        speech.includes('road work') ||
        speech.includes('roadwork') ||
        speech.includes('repair')
    ) {
        return 'Road Construction';
    }


    // Accident
    if (
        speech.includes('accident') ||
        speech.includes('crash') ||
        speech.includes('collision')
    ) {
        return 'Accident';
    }


    // Road bump
    if (
        speech.includes('bump') ||
        speech.includes('uneven road') ||
        speech.includes('rough road')
    ) {
        return 'Road Bump';
    }


    // Road closure
    if (
        speech.includes('road closed') ||
        speech.includes('road closure') ||
        speech.includes('closed road') ||
        speech.includes('blocked road')
    ) {
        return 'Temporary Closure';
    }


    return null;
}


/*  Reset Voice UI  */

function resetVoiceTab() {

    if (recognition) {

        try {
            recognition.stop();
        } catch (error) {
            // Recognition may already be stopped.
        }
    }

    // Also stop a spoken-confirmation listener, if one was started
    // while a recognized hazard was awaiting Yes/No.
    stopYesNoListening();

    micOrb.classList.remove('listening');

    voiceStatus.textContent =
        'Tap the mic to report hands-free';
// Explanation made by Yours Truly: LIA ❤️ (Tignan natin kung nagbabasa ka Josh)

    voiceTranscript.textContent = '';

    voiceTranscript.classList.remove('show');

    voiceActions.classList.remove('show');


    recognizedTranscript = '';

    recognizedHazard = null;
}


/*  Start Voice Recognition  */

function startVoiceRecognition() {

    const SpeechRecognition =
        window.SpeechRecognition ||
        window.webkitSpeechRecognition;


    // Check browser support
    if (!SpeechRecognition) {

        showToast(
            'Voice recognition is not supported in this browser.'
        );

        voiceStatus.textContent =
            'Voice recognition is unavailable.';

        return;
    }


    // Prevent starting another session while already listening
    if (micOrb.classList.contains('listening')) {
        return;
    }


    recognizedTranscript = '';

    recognizedHazard = null;


    voiceTranscript.textContent = '';

    voiceTranscript.classList.remove('show');

    voiceActions.classList.remove('show');


    recognition =
        new SpeechRecognition();


    // Recognition settings
    recognition.lang = 'en-PH';

    recognition.continuous = false;

    recognition.interimResults = true;


    recognition.onstart = function () {

        micOrb.classList.add('listening');

        voiceStatus.textContent =
            'Listening…';
    };


    recognition.onresult = function (event) {

        let transcript = '';


        for (
            let i = event.resultIndex;
            i < event.results.length;
            i++
        ) {

            transcript +=
                event.results[i][0].transcript;
        }


        recognizedTranscript =
            transcript.trim();


        // Show live recognized speech
        voiceTranscript.textContent =
            recognizedTranscript;

        voiceTranscript.classList.add('show');


        recognizedHazard =
            detectVoiceHazard(
                recognizedTranscript
            );


        if (recognizedHazard) {

            voiceStatus.textContent =
                `Detected: ${recognizedHazard}`;

        } else {

            voiceStatus.textContent =
                'Hazard type not recognized';
        }
    };


    recognition.onerror = function (event) {

        micOrb.classList.remove('listening');


        let message =
            'Voice recognition failed.';


        if (event.error === 'not-allowed') {

            message =
                'Microphone permission was denied.';

        } else if (
            event.error === 'no-speech'
        ) {

            message =
                'No speech was detected.';

        } else if (
            event.error === 'network'
        ) {

            message =
                'Voice recognition requires network support in this browser.';
        }


        voiceStatus.textContent =
            message;

        showToast(message);
    };


    recognition.onend = function () {

        micOrb.classList.remove('listening');


        // Only show confirmation if a valid hazard was recognized
        if (
            recognizedTranscript &&
            recognizedHazard
        ) {

            voiceStatus.textContent =
                `Recognized: ${recognizedHazard} — say "Yes" to save or "Cancel" to discard`;

            voiceTranscript.classList.add(
                'show'
            );

            voiceActions.classList.add(
                'show'
            );

            // Hands-free confirmation: let the user say "Yes"/"Confirm" or
            // "No"/"Cancel" instead of tapping a button. Falls back to the
            // on-screen buttons untouched if voice recognition isn't
            // available - see listenForYesNo().
            listenForYesNo({
                onYes: () => voiceConfirmBtn.click(),
                onNo: () => voiceCancelBtn.click()
            });

        } else if (
            recognizedTranscript
        ) {

            voiceStatus.textContent =
                'Could not identify a supported hazard.';

            voiceActions.classList.remove(
                'show'
            );
        }
    };

    try {

        recognition.start();

    } catch (error) {

        micOrb.classList.remove('listening');

        voiceStatus.textContent =
            'Unable to start voice recognition.';

        showToast(
            'Unable to start voice recognition.'
        );
    }
}


/*  Microphone Button  */

micOrb.addEventListener(
    'click',
    startVoiceRecognition
);


/*  Cancel Voice Report  */

voiceCancelBtn.addEventListener(
    'click',
    resetVoiceTab
);


/*  Confirm Voice Report  */

voiceConfirmBtn.addEventListener(
    'click',
    function () {

        // Safety check
        if (!recognizedHazard) {

            showToast(
                'No valid hazard was recognized.'
            );

            return;
        }


        const reportId =
            'hz_' + Date.now();


        const gpsLocation =
            GPSManager.getCurrentLocation();


        // Create the report using the same structure as manual reports
        const report = {

            id:
                reportId,

            label:
                recognizedHazard,

            time:
                'just now',

            note:
                `Voice report: ${
                    recognizedTranscript
                }`,

            location:
                gpsLocation.latitude !== null
                    ? {
                        latitude:
                            gpsLocation.latitude,

                        longitude:
                            gpsLocation.longitude,

                        accuracy:
                            gpsLocation.accuracy
                    }
                    : null,

            speedAtReport:
                gpsLocation.speedKmh || 0,

            timestamp:
                new Date().toISOString(),

            syncStatus:
                'pending',

            confirmations:
                0,

            disputes:
                0,

            initialConfidence:
                0,

            confidence:
                0,

            confidenceStatus:
                'Low Reliability'
        };


        // Calculate initial confidence
        report.initialConfidence =
            calculateInitialConfidence(
                report
            );


        updateHazardConfidence(
            report
        );


        // Save using the same offline storage flow as manual reports
        pendingReports.unshift(
            report
        );

        savePendingReports();


        // Add map hazard
        addDynamicHazardPin(
            report
        );


        // Add to community feed
        addHazardToCommunityFeed(
            report
        );


        renderSyncQueue();


        showToast(
            report.location
                ? `Voice report saved: ${recognizedHazard}`
                : `Voice report saved without GPS: ${recognizedHazard}`
        );


        resetVoiceTab();

        closeSheet();
    }
);

  /*  Map Hazard Pin Tooltips (static demo pins)  */
  document.querySelectorAll('.hazard-pin').forEach(pin=>{
    pin.addEventListener('click', ()=> showToast(pin.dataset.label));
  });

  /*  Dynamic On-Map Hazard Pins  */
  const dynamicHazardGroup = L.layerGroup().addTo(map);
  const dynamicHazardMarkers = {}; // hazard id -> Leaflet marker
  const hazardChatBackdrop = document.getElementById('hazardChatBackdrop');
  const hazardChatCard = document.getElementById('hazardChatCard');
  const hazardChatTitle = document.getElementById('hazardChatTitle');
  const hazardChatMeta = document.getElementById('hazardChatMeta');
  const hazardChatNote = document.getElementById('hazardChatNote');
  const hazardChatAvatar = document.getElementById('hazardChatAvatar');
  const hazardChatTrash = document.getElementById('hazardChatTrash');
  let dynamicHazards = BiyaStorage.load(
    BiyaStorage.keys.hazards,
    []
);
  let activeChatHazardId = null;

  function nearestReportLocation(){
    // Place the new pin exactly where the user currently is (their live
    // position while navigating, or their current origin point when idle),
    // with a small jitter so overlapping reports remain distinguishable
    const base = navActive ? liveUserPosition : currentOriginCoords;
    const jitterLat = (Math.random() - 0.5) * 0.006; // roughly +/-300m
    const jitterLng = (Math.random() - 0.5) * 0.006;
    return {
      lat: Math.min(14.45, Math.max(13.95, base.lat + jitterLat)),
      lng: Math.min(121.60, Math.max(121.00, base.lng + jitterLng))
    };
  }

/*  Add Dynamic Hazard  */

function addDynamicHazardPin(data) {

    const fallback = nearestReportLocation();

    const confidence =
        data.confidence ??
        data.initialConfidence ??
        40;

    const status =
        getConfidenceStatus(confidence);

    const hazard = {

        id: data.id,

        label: data.label,

        note:
            data.note || '',

        lat:
            data.lat ?? fallback.lat,

        lng:
            data.lng ?? fallback.lng,

        time:
            data.time || 'Just now',

        locationNote:
            data.locationNote ||
            currentOriginLocation,

        location:
            data.location || null,

        speedAtReport:
            data.speedAtReport || 0,

        timestamp:
            data.timestamp ||
            new Date().toISOString(),

        syncStatus:
            data.syncStatus || 'pending',


        /*  Confidence Data  */

        confirmations:
            data.confirmations ?? 0,

        disputes:
            data.disputes ?? 0,

        initialConfidence:
            data.initialConfidence ?? 40,

        confidence:
            confidence,

        confidenceStatus:
            data.confidenceStatus ??
            status.label,

        badge:
            data.badge ??
            status.badge,

        badgeText:
            data.badgeText ??
            status.badgeText
    };


    const existing =
        dynamicHazards.find(
            h => h.id === hazard.id
        );


    if (!existing) {

        dynamicHazards.push(hazard);

        saveDynamicHazards();
    }


    renderDynamicHazardPin(hazard);
}


/*  Add Hazard to Community Feed  */

function addHazardToCommunityFeed(hazard) {

    const exists =
        feedData.some(
            item => item.id === hazard.id
        );


    if (exists) return;


    const confidence =
        hazard.confidence ??
        hazard.initialConfidence ??
        40;


    const status =
        getConfidenceStatus(confidence);


    const feedItem = {

        id: hazard.id,

        icon:
            hazardEmojiFor(hazard.label),

        title:
            hazard.label,

        meta:
            `${hazard.locationNote || 'Current location'} · ${
                hazard.time || 'Just now'
            }`,

        note:
            hazard.note ||
            'No additional notes provided.',

        confidence:
            confidence,

        initialConfidence:
            hazard.initialConfidence ??
            confidence,

        confirmations:
            hazard.confirmations ?? 0,

        disputes:
            hazard.disputes ?? 0,

        badge:
            hazard.badge ??
            status.badge,

        badgeText:
            hazard.badgeText ??
            status.badgeText,

        isDynamic:
            true
    };


    feedData.unshift(feedItem);

    renderFeed();
}


/*  Restore Saved Hazards  */

function restoreDynamicHazards() {

    dynamicHazardGroup.clearLayers();
    Object.keys(dynamicHazardMarkers).forEach(k => delete dynamicHazardMarkers[k]);


    dynamicHazards.forEach(hazard => {

        renderDynamicHazardPin(hazard);

        addHazardToCommunityFeed(hazard);

    });
}

const hazardEmojiMap = {
    'Pothole': '🕳️',
    'Flooded Street': '🌊',
    'Road Construction': '🚧',
    'Accident': '🚨',
    'Road Bump': '⚠️',
    'Temporary Closure': '⛔'
};

function hazardEmojiFor(label) {
    return hazardEmojiMap[label] || '⚠️';
}

  function renderDynamicHazardPin(hazard){
    const icon = L.divIcon({
      className: 'hazard-pin-icon hazard-pin-dynamic',
      html: `
        <div class="hp-halo"></div>
        <div class="hp-pulse"></div>
        <div class="hp-emoji">${hazardEmojiFor(hazard.label)}</div>
        <div class="hp-exclaim">!</div>
      `,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });
    const marker = L.marker([hazard.lat, hazard.lng], { icon }).addTo(dynamicHazardGroup);
    marker.on('click', ()=> openHazardChatCard(hazard.id));
    dynamicHazardMarkers[hazard.id] = marker;
  }

  function openHazardChatCard(id){
    const hazard = dynamicHazards.find(h => h.id === id);
    if(!hazard) return;
    activeChatHazardId = id;
    hazardChatTitle.textContent = hazard.label;
    hazardChatAvatar.textContent = hazardEmojiFor(hazard.label);
    let locationText =
    `near ${hazard.locationNote}`;

if (hazard.location) {

    const lat =
        hazard.location.latitude
            .toFixed(6);

    const lng =
        hazard.location.longitude
            .toFixed(6);

    locationText =
        `${lat}, ${lng}`;
}

hazardChatMeta.textContent =
    `${hazard.time} · ${locationText}`;
    hazardChatNote.textContent = hazard.note;
    hazardChatBackdrop.classList.add('open');
    hazardChatCard.classList.add('open');
  }
  function closeHazardChatCard(){
    hazardChatBackdrop.classList.remove('open');
    hazardChatCard.classList.remove('open');
    activeChatHazardId = null;
  }
  hazardChatBackdrop.addEventListener('click', closeHazardChatCard);
  hazardChatTrash.addEventListener('click', async ()=>{
    if(!activeChatHazardId) return;
    const confirmed = await showConfirmDialog({
      title: 'Delete this report?',
      message: 'This hazard report will be permanently removed from the map and community feed.',
      confirmLabel: 'Delete Report'
    });
    if(!confirmed) return;
    deleteDynamicHazard(activeChatHazardId);
    closeHazardChatCard();
  });

  function deleteDynamicHazard(id) {

    dynamicHazards =
        dynamicHazards.filter(
            h => h.id !== id
        );

    pendingReports =
        pendingReports.filter(
            r => r.id !== id
        );

    const marker = dynamicHazardMarkers[id];

    if (marker) {
        dynamicHazardGroup.removeLayer(marker);
        delete dynamicHazardMarkers[id];
    }

    saveDynamicHazards();

    savePendingReports();

    renderSyncQueue();

    showToast('Report deleted');
}

  /*  Community Feed  */
  const hazardFeed = document.getElementById('hazardFeed');
  const feedData = [
    { icon:'🕳️', title:'Pothole', meta:'Zone 4 · EDSA-Guadalupe · 12m ago', note:'Deep pothole near the right lane, hard to see at night.', confidence:20, badge:'regular', badgeText:'Regular User (+20%)' },
    { icon:'🌊', title:'Flooded Street', meta:'España Blvd · 38m ago', note:'Knee-deep flooding after the underpass, cars stalling.', confidence:45, badge:'trusted', badgeText:'Trusted Contributor (+50%)' },
    { icon:'🚧', title:'Road Construction', meta:'Commonwealth Ave · 1h ago', note:'One lane closed for drainage work, expect delays.', confidence:70, badge:'trusted', badgeText:'Trusted Contributor (+50%)' },
    { icon:'🚨', title:'Road Accident', meta:'C5 Northbound · 2h ago', note:'Minor collision cleared to the shoulder, traffic recovering.', confidence:90, badge:'verified', badgeText:'Verified LGU / Official (+80%)' },
  ];

  const feedDataOriginal = feedData.map(h => ({ ...h }));

  function confidenceColor(pct){
    if(pct >= 70) return 'var(--brand)';
    if(pct >= 40) return 'var(--status-yellow)';
    return 'var(--status-red)';
  }
  /*  Confidence Scoring System  */

function calculateInitialConfidence(report) {

    let score = 40;

    // GPS location successfully attached
    if (
        report.location &&
        report.location.latitude !== null &&
        report.location.longitude !== null
    ) {
        score += 15;
    }

    // Good GPS accuracy
    if (
        report.location &&
        report.location.accuracy !== null &&
        report.location.accuracy <= 20
    ) {
        score += 10;
    }

    // Detailed user description
    if (
        report.note &&
        report.note.trim().length >= 10 &&
        report.note !== 'No additional notes provided.'
    ) {
        score += 5;
    }

    return Math.max(
        0,
        Math.min(100, score)
    );
}


function getConfidenceStatus(score) {

    if (score >= 70) {
        return {
            label: 'High Reliability',
            badge: 'verified',
            badgeText: 'Verified by Community'
        };
    }

    if (score >= 40) {
        return {
            label: 'Medium Reliability',
            badge: 'trusted',
            badgeText: 'Community Report'
        };
    }

    return {
        label: 'Low Reliability',
        badge: 'regular',
        badgeText: 'Needs Validation'
    };
}


function updateHazardConfidence(hazard) {

    let score =
        hazard.initialConfidence ?? 40;

    const confirmations =
        hazard.confirmations ?? 0;

    const disputes =
        hazard.disputes ?? 0;

    score += confirmations * 8;

    score -= disputes * 12;

    score = Math.max(
        0,
        Math.min(100, score)
    );

    hazard.confidence = score;

    const status =
        getConfidenceStatus(score);

    hazard.confidenceStatus =
        status.label;

    hazard.badge =
        status.badge;

    hazard.badgeText =
        status.badgeText;

    return hazard;
}

  function renderFeed(){
    hazardFeed.innerHTML = feedData.map((h,i)=>`
      <div class="hazard-card" data-i="${i}">
        <div class="hc-top">
          <div class="hc-type">
            <div class="hc-icon">${h.icon}</div>
            <div>
              <div class="hc-title">${h.title}</div>
              <div class="hc-meta">${h.meta}</div>
            </div>
          </div>
          <span class="route-board rb-${h.badge}">${h.badgeText}</span>
        </div>
        <div class="hc-note">${h.note}</div>
        <div class="confidence-row">
          <div class="confidence-labels">
            <span>Confidence Score</span>
            <span class="conf-val">${h.confidence}%${h.confidence>=70 ? ' · <span class=\"verified-tag\">Verified</span>':''}</span>
          </div>
          <div class="confidence-track"><div class="confidence-fill" style="width:${h.confidence}%; background:${confidenceColor(h.confidence)}"></div></div>
        </div>
        <div class="confidence-labels">
    <span>
        👍 ${h.confirmations ?? 0} Confirmations
    </span>

    <span>
        👎 ${h.disputes ?? 0} Disputes
    </span>
</div>

<div class="hc-actions">
          <div class="vote-btn confirm" data-i="${i}" data-dir="1">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
            Confirm
          </div>
          <div class="vote-btn dispute" data-i="${i}" data-dir="-1">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg>
            Dispute
          </div>
        </div>
      </div>
    `).join('');  

   document
.querySelectorAll('.vote-btn')
.forEach(btn => {

    btn.addEventListener('click', () => {

        const i =
            +btn.dataset.i;

        const dir =
            +btn.dataset.dir;

        const report =
            feedData[i];

        // Prevent voting fields from being undefined
        report.confirmations =
            report.confirmations ?? 0;

        report.disputes =
            report.disputes ?? 0;

        // Existing sample reports may not have an initial confidence
        report.initialConfidence =
            report.initialConfidence ??
            report.confidence;

        if (dir > 0) {

            report.confirmations++;

        } else {

            report.disputes++;
        }

        // Recalculate confidence
        updateHazardConfidence(report);

        // If this is a real dynamically created hazard, update its stored version too
        if (report.id) {

            const hazardIndex =
                dynamicHazards.findIndex(
                    hazard =>
                        hazard.id === report.id
                );

            if (hazardIndex !== -1) {

                dynamicHazards[hazardIndex] = {
                    ...dynamicHazards[hazardIndex],

                    confirmations:
                        report.confirmations,

                    disputes:
                        report.disputes,

                    initialConfidence:
                        report.initialConfidence,

                    confidence:
                        report.confidence,

                    confidenceStatus:
                        report.confidenceStatus,

                    badge:
                        report.badge,

                    badgeText:
                        report.badgeText
                };

                saveDynamicHazards();
            }
        }

        renderFeed();

        showToast(
            dir > 0
                ? `Report confirmed · ${report.confidence}% confidence`
                : `Report disputed · ${report.confidence}% confidence`
        );
    });
});
  } // close: function renderFeed()

  renderFeed();

  /*  Legend / Traffic Strip Toggle  */
  document.getElementById('legendToggleBtn').addEventListener('click', ()=>{
    legendStripEl.classList.toggle('collapsed');
  });

  /*  Map-focus toggle: folds the status badge / route summary / search
      bar away so the map gets full screen, and takes the road-legend
      traffic strip with it (re-opening restores whichever legend state
      it was already in — collapsed or not — rather than forcing it
      open). Purely a display toggle; doesn't touch navigation state. */
  const appHeaderEl = document.querySelector('.app-header');
  const mapFocusToggleBtn = document.getElementById('mapFocusToggle');
  mapFocusToggleBtn.addEventListener('click', () => {
    const collapsing = !appHeaderEl.classList.contains('controls-collapsed');
    appHeaderEl.classList.toggle('controls-collapsed', collapsing);
    if (collapsing) {
      legendStripEl.dataset.wasOpenBeforeFocus = legendStripEl.classList.contains('collapsed') ? '0' : '1';
      legendStripEl.classList.add('collapsed');
    } else if (legendStripEl.dataset.wasOpenBeforeFocus === '1') {
      legendStripEl.classList.remove('collapsed');
    }
    mapFocusToggleBtn.setAttribute('aria-label', collapsing ? 'Show search controls' : 'Hide search controls');
  });

  /*  Search: DUAL INPUT + REAL LAGUNA ROUTING  */
  const searchDual = document.getElementById('searchDual');
  const destInput = document.getElementById('destInput');
  const originInput = document.getElementById('originInput');
  const searchSuggestions = document.getElementById('searchSuggestions');

  // A curated set of real, well-known places across Laguna province —
  // city/town centers, landmarks, and points of interest. Coordinates are
  // sourced from public geographic references (town halls are approximate
  // centers; named landmarks use their actual published coordinates) —
  // not full free-text geocoding, but real locations rather than
  // arbitrary points on a fake map, so search results and routing here
  // mean something. "sub" is a location line only — distance is computed
  // live against the real current origin at render time (see
  // distanceLabel below), since origin now moves with real GPS.
  const lagunaDestinations = [
    // ---- Cities & town centers ----
    { name: 'Santa Cruz Public Market', sub: 'Santa Cruz, Laguna (provincial capital) — 26 barangays', category: 'Municipality',
      latlng: { lat: 14.2814, lng: 121.4157 }, hazards: [] },
    { name: 'SM City Santa Rosa', sub: 'Santa Rosa City, Laguna', category: 'Mall',
      latlng: { lat: 14.3123, lng: 121.0947 },
      hazards: [ { t:0.55, label:'Pothole · reported 12m ago', color:'var(--status-red)' } ] },
    { name: 'Calamba City Hall', sub: 'Calamba City, Laguna — 54 barangays', category: 'City',
      latlng: { lat: 14.2117, lng: 121.1653 },
      hazards: [ { t:0.65, label:'Flooded street · knee-deep', color:'var(--gold)' }, { t:0.85, label:'Road construction ahead', color:'var(--status-yellow)' } ] },
    { name: 'San Pablo City Plaza', sub: 'San Pablo City, Laguna — 80 barangays', category: 'City',
      latlng: { lat: 14.0703, lng: 121.3256 },
      hazards: [ { t:0.5, label:'Road bump · uneven pavement', color:'var(--status-yellow)' } ] },
    { name: 'Biñan City Hall', sub: 'Biñan City, Laguna — 24 barangays', category: 'City',
      latlng: { lat: 14.3426, lng: 121.0839 }, hazards: [] },
    { name: 'Cabuyao City Hall', sub: 'Cabuyao City, Laguna — 18 barangays', category: 'City',
      latlng: { lat: 14.2776, lng: 121.1250 }, hazards: [] },
    { name: 'Los Baños Municipal Hall', sub: 'Los Baños, Laguna — 14 barangays', category: 'Municipality',
      latlng: { lat: 14.1700, lng: 121.2237 }, hazards: [] },
    { name: 'Sta. Rosa Tagaytay Road', sub: 'Santa Rosa City, Laguna', category: 'Road',
      latlng: { lat: 14.2870, lng: 121.0890 }, hazards: [] },
    // Laguna's 6 component cities are Biñan, Cabuyao, Calamba, San Pablo,
    // San Pedro, and Santa Rosa — the other 5 already had a City Center
    // entry above (or, for San Pablo, below under Government); Santa
    // Rosa didn't, so it's added here to complete the set. Barangay
    // counts were also added to every city's "sub" field above/below
    // (2020 Census / PSA figures, same source as this file's other
    // population-adjacent facts) — Laguna has 681 barangays total across
    // its 6 cities and 24 municipalities.
    { name: 'Santa Rosa City Hall', sub: 'Rizal Blvd, Santa Rosa City, Laguna — 18 barangays', category: 'City',
      latlng: { lat: 14.3119, lng: 121.1055 }, hazards: [] },

    // ---- Landmarks & points of interest ----
    { name: 'Enchanted Kingdom', sub: 'San Lorenzo, Santa Rosa City, Laguna', category: 'Theme Park',
      latlng: { lat: 14.2819473, lng: 121.0953936 }, hazards: [] },
    { name: 'University of the Philippines Los Baños (UPLB)', sub: 'Los Baños, Laguna', category: 'University',
      latlng: { lat: 14.1651, lng: 121.2415 }, hazards: [] },
    { name: 'Pagsanjan Falls', sub: 'Pagsanjan, Laguna', category: 'Landmark',
      latlng: { lat: 14.2697, lng: 121.4527 },
      hazards: [ { t:0.4, label:'Accident · lane blocked', color:'var(--status-red)' }, { t:0.75, label:'Heavy congestion', color:'var(--status-gray)' } ] },
    { name: 'Rizal Shrine, Calamba', sub: 'Calamba City, Laguna', category: 'Landmark',
      latlng: { lat: 14.2138, lng: 121.1652 }, hazards: [] },
    { name: 'Nagcarlan Underground Cemetery', sub: 'Brgy. Bambang, Nagcarlan, Laguna', category: 'Landmark',
      latlng: { lat: 14.13135, lng: 121.41482 }, hazards: [] },
    { name: 'Paete Church', sub: 'Paete, Laguna', category: 'Landmark',
      latlng: { lat: 14.3667, lng: 121.4800 }, hazards: [] },
    { name: 'Lake Caliraya', sub: 'Lumban / Cavinti / Kalayaan, Laguna', category: 'Landmark',
      latlng: { lat: 14.29583, lng: 121.53194 }, hazards: [] },
    { name: 'Mount Makiling', sub: 'Los Baños / Bay, Laguna', category: 'Landmark',
      latlng: { lat: 14.1367, lng: 121.2050 }, hazards: [] },
    { name: 'Seven Lakes, San Pablo', sub: 'San Pablo City, Laguna', category: 'Landmark',
      latlng: { lat: 14.0781, lng: 121.3272 }, hazards: [] },
    { name: 'Pila Heritage Town Plaza', sub: 'Pila, Laguna', category: 'Landmark',
      latlng: { lat: 14.2333, lng: 121.3667 }, hazards: [] },
    { name: 'Majayjay Church (Taytay Falls area)', sub: 'Majayjay, Laguna', category: 'Landmark',
      latlng: { lat: 14.1444, lng: 121.4736 }, hazards: [] },

    // ---- San Pablo City points of interest ----
    // Added for the icon/POI pass (hospital, church, school, government,
    // mall, terminal, etc. coverage) with a focus on San Pablo City per
    // request. Coordinates below are sourced from published references
    // (Wikipedia infobox coordinates for the school/church/mall entries;
    // OpenStreetMap Wiki + Wikipedia for the city-hall/plaza point) —
    // real, checkable locations, not invented ones. The one exception is
    // San Pablo District Hospital, marked (approx.) below: no precise
    // published coordinate was found for the hospital building itself, so
    // it's placed at the eastern shore of Sampaloc Lake, which multiple
    // sources describe as the hospital's location ("overlooking Sampaloc
    // Lake", itself at 14.079°N 121.33°E) — same approach the file already
    // uses for approximate town-hall centers above.
    { name: 'San Pablo Cathedral', sub: 'Cathedral-Parish of St. Paul the First Hermit, San Pablo City', category: 'Church',
      latlng: { lat: 14.069725, lng: 121.326575 }, hazards: [] },
    { name: 'San Pablo City Hall', sub: 'San Pablo City, Laguna — 80 barangays', category: 'Government',
      latlng: { lat: 14.070007, lng: 121.325681 }, hazards: [] },
    { name: 'SM City San Pablo', sub: 'Maharlika Highway, Brgy. San Rafael, San Pablo City', category: 'Mall',
      latlng: { lat: 14.07145, lng: 121.30177 }, hazards: [] },
    { name: 'San Pablo City Science Integrated High School', sub: 'San Pablo City, Laguna', category: 'School',
      latlng: { lat: 14.06452, lng: 121.34254 }, hazards: [] },
    { name: 'San Pablo City National High School', sub: 'Brgy. VI-D, San Pablo City, Laguna', category: 'School',
      latlng: { lat: 14.07673, lng: 121.32092 }, hazards: [] },
    { name: 'San Pablo District Hospital', sub: 'San Pablo City, Laguna (approx. — near Sampaloc Lake)', category: 'Hospital',
      latlng: { lat: 14.0775, lng: 121.3260 }, hazards: [] },

    // ---- Additional municipalities (verified against Wikipedia/OSM
    // published coordinates for the specific church/city-hall building,
    // not invented) — broadens coverage beyond the cities/landmarks
    // above into more of Laguna's smaller towns. ----
    { name: 'San Pedro City Hall', sub: 'San Pedro City, Laguna — 27 barangays', category: 'City',
      latlng: { lat: 14.3583, lng: 121.0583 }, hazards: [] },
    { name: 'Saint Peter of Alcantara Parish Church (Pakil)', sub: 'Pakil, Laguna — Diocesan Shrine of Our Lady of Turumba', category: 'Church',
      latlng: { lat: 14.380826, lng: 121.478914 }, hazards: [] },
    { name: 'Siniloan Church (Sts. Peter and Paul Parish)', sub: 'Siniloan, Laguna', category: 'Church',
      latlng: { lat: 14.421999, lng: 121.446129 }, hazards: [] },
    { name: 'San Agustin Parish Church, Bay', sub: 'Bay, Laguna — the old Laguna provincial capital', category: 'Church',
      latlng: { lat: 14.180369, lng: 121.284315 }, hazards: [] },
    { name: 'Saint John the Baptist Parish Church (Liliw)', sub: 'Liliw, Laguna — the "Flip-flops Capital of the Philippines"', category: 'Church',
      latlng: { lat: 14.12982, lng: 121.43581 }, hazards: [] },

    // ---- POI expansion pass: everyday-errand categories (pharmacy,
    // bank/ATM, supermarket, restaurant, fast food, bakery, wet market,
    // water station, parking) that weren't represented before, plus more
    // hospitals/malls/terminals/police/fire coverage outside Santa
    // Rosa/San Pablo. Real, named, currently-operating establishments —
    // coordinates individually looked up (not estimated from an address
    // string or a nearby landmark) via Google Places, then cross-checked
    // against each place's listed address for the right barangay/road.
    // NOTE for anyone taking this further: Google Places' terms restrict
    // how far place data can be cached/redistributed outside a live Maps
    // integration — fine for this scoped, human-reviewed dev-time lookup,
    // but if this list grows much further, an OSM Overpass export (same
    // approach the rest of this file already uses) is the safer long-term
    // source for a redistributable POI dataset. ----
    { name: 'Mercury Drug – Sta. Rosa Poblacion', sub: 'Gomez St / Tatlong Hari St, Market Area, Santa Rosa City', category: 'Pharmacy',
      latlng: { lat: 14.313827, lng: 121.112702 }, hazards: [] },
    { name: 'Petron – Bypass Road', sub: 'Barangay Bucal, Calamba City', category: 'Gas Station',
      latlng: { lat: 14.181185, lng: 121.159130 }, hazards: [] },
    { name: 'Shell – San Rafael', sub: 'Brgy. San Rafael, San Pablo City', category: 'Gas Station',
      latlng: { lat: 14.071190, lng: 121.304877 }, hazards: [] },
    { name: 'Caltex – Balibago / RSBS Blvd', sub: 'Balibago, Santa Rosa City', category: 'Gas Station',
      latlng: { lat: 14.288834, lng: 121.094695 }, hazards: [] },
    { name: 'Security Bank – Biñan', sub: 'National Highway, Biñan City', category: 'Bank',
      latlng: { lat: 14.333108, lng: 121.081520 }, hazards: [] },
    { name: 'BDO – Biñan Central Mall', sub: 'Malvar St. cor. Old National Hwy, Biñan City', category: 'Bank',
      latlng: { lat: 14.332739, lng: 121.082215 }, hazards: [] },
    { name: 'BPI ATM – Waltermart Cabuyao', sub: 'KM 47 National Hwy, Brgy. Banlic, Cabuyao City', category: 'Bank',
      latlng: { lat: 14.232896, lng: 121.134128 }, hazards: [] },
    { name: 'SM Supermarket – SM City San Pablo', sub: 'National Highway, San Pablo City', category: 'Supermarket',
      latlng: { lat: 14.071201, lng: 121.302592 }, hazards: [] },
    { name: 'South Supermarket', sub: 'National Highway, Los Baños', category: 'Supermarket',
      latlng: { lat: 14.176812, lng: 121.262219 }, hazards: [] },
    { name: 'Los Baños Public Market', sub: '149 Villegas St., Los Baños', category: 'Wet Market',
      latlng: { lat: 14.181555, lng: 121.224374 }, hazards: [] },
    { name: 'Pamilihang Bayan ng Batong Malake', sub: 'National Highway, Los Baños', category: 'Wet Market',
      latlng: { lat: 14.179636, lng: 121.240540 }, hazards: [] },
    { name: 'Cabuyao City Police Station', sub: 'Manila South Rd, Cabuyao City', category: 'Police',
      latlng: { lat: 14.271199, lng: 121.124208 }, hazards: [] },
    { name: 'Santa Cruz Municipal Police Station', sub: 'A. Mabini St., Santa Cruz', category: 'Police',
      latlng: { lat: 14.282458, lng: 121.416004 }, hazards: [] },
    { name: 'Santa Rosa City Fire Station', sub: 'Rizal Ave, Santa Rosa City', category: 'Fire Station',
      latlng: { lat: 14.315750, lng: 121.110555 }, hazards: [] },
    { name: 'Laguna Technopark Fire Station', sub: 'Science Ave, Don Jose, Santa Rosa City', category: 'Fire Station',
      latlng: { lat: 14.261360, lng: 121.057583 }, hazards: [] },
    { name: 'San Pedro Doctors Hospital', sub: 'National Highway, San Pedro City', category: 'Hospital',
      latlng: { lat: 14.348863, lng: 121.064919 }, hazards: [] },
    { name: 'LPH – San Pedro District Hospital', sub: 'Puerto Azul St., San Pedro City', category: 'Hospital',
      latlng: { lat: 14.362976, lng: 121.042297 }, hazards: [] },
    { name: 'Calamba Medical Center', sub: 'Crossing, Asian Hwy, Calamba City', category: 'Hospital',
      latlng: { lat: 14.206167, lng: 121.152387 }, hazards: [] },
    { name: 'Calamba Doctors Hospital', sub: 'KM 49, San Cristobal Bridge, Calamba City', category: 'Hospital',
      latlng: { lat: 14.217319, lng: 121.141912 }, hazards: [] },
    { name: 'Dr. Jose P. Rizal Memorial Provincial Hospital', sub: 'Manila South Rd, Calamba City', category: 'Hospital',
      latlng: { lat: 14.191669, lng: 121.167549 }, hazards: [] },
    { name: 'Robinsons Place Santa Rosa', sub: 'Manila South Rd, Santa Rosa City', category: 'Mall',
      latlng: { lat: 14.319167, lng: 121.096667 }, hazards: [] },
    { name: 'Central Mall Biñan', sub: 'Manila South Rd, Biñan City', category: 'Mall',
      latlng: { lat: 14.332788, lng: 121.082296 }, hazards: [] },
    { name: 'SM City Calamba', sub: 'National Road, Brgy. Real, Calamba City', category: 'Mall',
      latlng: { lat: 14.204185, lng: 121.154586 }, hazards: [] },
    { name: 'Jollibee Pacita', sub: 'Pacita Complex, National Hwy, San Pedro City', category: 'Fast Food',
      latlng: { lat: 14.346811, lng: 121.065650 }, hazards: [] },
    { name: "Bertie's Artisan Bakeshop", sub: 'Bucal Bypass Rd, Calamba City', category: 'Bakery',
      latlng: { lat: 14.178850, lng: 121.155876 }, hazards: [] },
    { name: "Pidol's Bakeshop – Calamba", sub: 'San Jose Rd, Calamba City', category: 'Bakery',
      latlng: { lat: 14.213768, lng: 121.169877 }, hazards: [] },
    { name: 'Calle Arco Restaurant', sub: 'Pagsanjan (riverside dining)', category: 'Restaurant',
      latlng: { lat: 14.273165, lng: 121.453248 }, hazards: [] },
    { name: 'SM Calamba Parking Area', sub: 'Real Rd, Brgy. Real, Calamba City', category: 'Parking',
      latlng: { lat: 14.202951, lng: 121.154139 }, hazards: [] },
    { name: "Bacay's Water Refilling Station", sub: 'Marcos Paulino St., San Pablo City', category: 'Water Station',
      latlng: { lat: 14.064392, lng: 121.325789 }, hazards: [] },
    { name: 'LLi Bus Terminal', sub: 'Pagsanjan', category: 'Terminal',
      latlng: { lat: 14.264924, lng: 121.430832 }, hazards: [] },

    // ---- Roads / highway waypoints ----
    { name: 'SLEX Santa Rosa Exit', sub: 'South Luzon Expressway, Santa Rosa City', category: 'Highway',
      latlng: { lat: 14.3010, lng: 121.0850 }, hazards: [] },
    { name: 'SLEX Calamba Exit', sub: 'South Luzon Expressway, Calamba City', category: 'Highway',
      latlng: { lat: 14.2250, lng: 121.1400 }, hazards: [] },
    { name: 'Manila South Road, San Pablo', sub: 'National Highway, San Pablo City', category: 'Highway',
      latlng: { lat: 14.0850, lng: 121.3100 }, hazards: [] },

    // ---- Tripadvisor "Laguna Province Sights & Landmarks" pass ----
    // Every entry pulled from https://www.tripadvisor.com.ph/Attractions-
    // g3602863-Activities-c47-Laguna_Province_Calabarzon_Region_Luzon.html
    // (all 35 ranked results, both result pages). A handful of that list
    // were already in lagunaDestinations above (Rizal Shrine, Liliw
    // Church, Nagcarlan Underground Cemetery, Pakil Church, San Pablo
    // Cathedral) so aren't repeated here, and a few appeared twice on
    // Tripadvisor itself under two listing IDs for the same real place
    // (Ylaya At Santa Elena, Forest Wood Garden/Farm, Tatlong Krus/Three
    // Crosses of Paete) — those are added once. Coordinates below are
    // the church/landmark's own published coordinate where Wikipedia or
    // GCatholic.org gives one; where only the host town's coordinate was
    // available (mostly the smaller agri-tourism farms), that's used
    // instead and is marked (approx.) in "sub", same convention as the
    // hospital/terminal approximations earlier in this file. Two of the
    // 35 results (Lukong Valley Farm, National Shrine of Our Lady of
    // Sorrows) are actually in Dolores, Quezon just across the San Pablo
    // border — Tripadvisor's own region page files them under "Laguna
    // Province", and they're kept here for the same reason: real,
    // commuter-relevant places just outside the province line, the same
    // as this file already does for a few highway/city entries. ----
    { name: 'Fun Farm at Sta. Elena', sub: 'Brgy. Malitlit, Santa Rosa City, Laguna (approx.)', category: 'Farm',
      latlng: { lat: 14.2583, lng: 121.0969 }, hazards: [] },
    { name: 'Forest Wood Garden', sub: 'San Pablo City, Laguna (approx.)', category: 'Farm',
      latlng: { lat: 14.0650, lng: 121.3100 }, hazards: [] },
    { name: 'Costales Nature Farms', sub: 'Majayjay, Laguna — foot of Mt. Banahaw (approx.)', category: 'Farm',
      latlng: { lat: 14.1463, lng: 121.4729 }, hazards: [] },
    { name: 'Sta. Maria Magdalena Church', sub: 'Magdalena, Laguna', category: 'Church',
      latlng: { lat: 14.198907, lng: 121.429145 }, hazards: [] },
    { name: 'Ylaya At Santa Elena', sub: 'San Pablo City, Laguna (approx.)', category: 'Farm',
      latlng: { lat: 14.0600, lng: 121.3050 }, hazards: [] },
    { name: 'Shrine of Our Lady of Guadalupe', sub: 'Pagsanjan, Laguna — Diocesan Shrine and Parish', category: 'Church',
      latlng: { lat: 14.272819, lng: 121.456174 }, hazards: [] },
    { name: 'Lukong Valley Farm', sub: 'Dolores, Quezon — just across the San Pablo border (approx.)', category: 'Farm',
      latlng: { lat: 14.0157, lng: 121.4011 }, hazards: [] },
    { name: 'San Gregorio Magno Church', sub: 'Majayjay, Laguna — Minor Basilica, National Cultural Treasure', category: 'Church',
      latlng: { lat: 14.14621, lng: 121.47141 }, hazards: [] },
    { name: 'Alcasid Aviary and Farm', sub: 'Calamba City, Laguna (approx.)', category: 'Farm',
      latlng: { lat: 14.2050, lng: 121.1550 }, hazards: [] },
    { name: 'Saint James the Apostle Church', sub: 'Paete, Laguna — National Historical Landmark', category: 'Church',
      latlng: { lat: 14.364557, lng: 121.481638 }, hazards: [] },
    { name: 'Joni and Susan Agroshop and Integrated Farms', sub: 'San Pablo City, Laguna (approx.)', category: 'Farm',
      latlng: { lat: 14.0650, lng: 121.3100 }, hazards: [] },
    { name: 'National Shrine of San Antonio De Padua', sub: 'Pila, Laguna — Pila Church, National Shrine', category: 'Church',
      latlng: { lat: 14.233958, lng: 121.364398 }, hazards: [] },
    { name: 'San Juan Bautista Church', sub: 'Brgy. Longos, Kalayaan, Laguna', category: 'Church',
      latlng: { lat: 14.340450, lng: 121.481431 }, hazards: [] },
    { name: 'San Bartolome Apostol Parish Church', sub: 'Nagcarlan, Laguna — Nagcarlan Church', category: 'Church',
      latlng: { lat: 14.13629, lng: 121.41740 }, hazards: [] },
    { name: 'Graco Farms & Leisure', sub: 'Pila, Laguna (approx.)', category: 'Farm',
      latlng: { lat: 14.2333, lng: 121.3667 }, hazards: [] },
    { name: 'National Shrine of Our Lady of Sorrows', sub: 'Dolores, Quezon — just across the San Pablo border (approx.)', category: 'Church',
      latlng: { lat: 14.0157, lng: 121.4011 }, hazards: [] },
    { name: 'UPLB Fertility Tree', sub: 'Freedom Park, UPLB, Los Baños, Laguna (approx.)', category: 'Landmark',
      latlng: { lat: 14.1663, lng: 121.2423 }, hazards: [] },
    { name: 'Saint John the Baptist Parish Church, Calamba', sub: 'Calamba City, Laguna — christening site of José Rizal', category: 'Church',
      latlng: { lat: 14.213477, lng: 121.167528 }, hazards: [] },
    { name: 'Tatlong Krus', sub: 'Paete, Laguna — hillside "Three Crosses" viewpoint (approx.)', category: 'Landmark',
      latlng: { lat: 14.3667, lng: 121.4800 }, hazards: [] },
    { name: 'Holy Carabao', sub: 'Santa Rosa City, Laguna (approx.)', category: 'Landmark',
      latlng: { lat: 14.2819, lng: 121.0954 }, hazards: [] },
    { name: 'Fule-Malvar Mansion', sub: 'Jose Rizal Ave, San Pablo City, Laguna — heritage house', category: 'Landmark',
      latlng: { lat: 14.0716, lng: 121.3225 }, hazards: [] },
    { name: 'Farmshare Agri Tourism Park', sub: 'Cavinti, Laguna (approx.)', category: 'Farm',
      latlng: { lat: 14.2451, lng: 121.5074 }, hazards: [] },
    { name: 'Museo ng San Pablo', sub: 'Capitol Compound, San Pablo City, Laguna — city museum', category: 'Landmark',
      latlng: { lat: 14.070007, lng: 121.325681 }, hazards: [] },
    { name: 'Roman Catholic Parish of San Antonio de Padua', sub: 'Lopez Ave, Batong Malake, Los Baños, Laguna (approx.)', category: 'Church',
      latlng: { lat: 14.1660, lng: 121.2410 }, hazards: [] },
    { name: 'Shrine of St. Therese of the Child Jesus', sub: 'UPLB campus, Los Baños, Laguna — Diocesan Shrine / "UPLB Chapel"', category: 'Church',
      latlng: { lat: 14.16472, lng: 121.24500 }, hazards: [] },
    { name: "Rodrigo's Greenhouse Cafe", sub: 'Cabuyao City, Laguna (approx.)', category: 'Restaurant',
      latlng: { lat: 14.2776, lng: 121.1250 }, hazards: [] },
    { name: 'Immaculate Conception Parish Church', sub: 'Poblacion, Los Baños, Laguna — oldest church in the town', category: 'Church',
      latlng: { lat: 14.178733, lng: 121.221912 }, hazards: [] },

    // ---- Every remaining Laguna municipality not already represented
    // above by a City/Municipal Hall entry — completing coverage of all
    // 24 municipalities (the 6 component cities were completed earlier;
    // Los Baños and Santa Cruz already had an entry above and just got
    // their barangay counts added to "sub"). Coordinates are each town's
    // own published Wikipedia/PhilAtlas infobox coordinate (the
    // poblacion/town-proper location) — same "approximate town center"
    // convention this file already uses for the city halls, not a
    // precise municipal-hall street address, but a real, checkable
    // location for the town itself. Where this file already had a
    // church/landmark entry for that same town (e.g. Magdalena, Paete,
    // Nagcarlan), this reuses that same real coordinate rather than
    // inventing a second nearby point — several towns' civic and
    // religious centers sit on the same plaza anyway.
    //
    // Barangay counts are 2020 PSA-Census-era figures (PhilAtlas /
    // Wikipedia), same source already used for the 6 cities. All 30
    // Laguna LGUs' barangay counts now sum to the province's official
    // total of 681 (221 across the 6 cities + 460 across these 24
    // municipalities) — a useful internal check that these weren't
    // typo'd or double-counted. ----
    { name: 'Alaminos Municipal Hall', sub: 'Alaminos, Laguna — 15 barangays', category: 'Municipality',
      latlng: { lat: 14.063469, lng: 121.245128 }, hazards: [] },
    { name: 'Bay Municipal Hall', sub: 'Bay, Laguna — old Laguna provincial capital — 15 barangays', category: 'Municipality',
      latlng: { lat: 14.18, lng: 121.28 }, hazards: [] },
    { name: 'Calauan Municipal Hall', sub: 'Calauan, Laguna — 17 barangays', category: 'Municipality',
      latlng: { lat: 14.15, lng: 121.32 }, hazards: [] },
    { name: 'Cavinti Municipal Hall', sub: 'Cavinti, Laguna — 19 barangays', category: 'Municipality',
      latlng: { lat: 14.245128, lng: 121.507419 }, hazards: [] },
    { name: 'Famy Municipal Hall', sub: 'Famy, Laguna — 20 barangays', category: 'Municipality',
      latlng: { lat: 14.43, lng: 121.45 }, hazards: [] },
    { name: 'Kalayaan Municipal Hall', sub: 'Kalayaan, Laguna — 3 barangays', category: 'Municipality',
      latlng: { lat: 14.328, lng: 121.48 }, hazards: [] },
    { name: 'Liliw Municipal Hall', sub: 'Liliw, Laguna — "Flip-flops Capital of the Philippines" — 33 barangays', category: 'Municipality',
      latlng: { lat: 14.13, lng: 121.436 }, hazards: [] },
    { name: 'Luisiana Municipal Hall', sub: 'Luisiana, Laguna — "Little Baguio of Laguna" — 23 barangays', category: 'Municipality',
      latlng: { lat: 14.185, lng: 121.5109 }, hazards: [] },
    { name: 'Lumban Municipal Hall', sub: 'Lumban, Laguna — Embroidery Capital of the Philippines — 16 barangays', category: 'Municipality',
      latlng: { lat: 14.297, lng: 121.459 }, hazards: [] },
    { name: 'Mabitac Municipal Hall', sub: 'Mabitac, Laguna — 15 barangays', category: 'Municipality',
      latlng: { lat: 14.43, lng: 121.42 }, hazards: [] },
    { name: 'Magdalena Municipal Hall', sub: 'Magdalena, Laguna — Bamboo Capital of Laguna — 24 barangays', category: 'Municipality',
      latlng: { lat: 14.198907, lng: 121.429145 }, hazards: [] },
    { name: 'Majayjay Municipal Hall', sub: 'Majayjay, Laguna — foot of Mt. Banahaw — 40 barangays', category: 'Municipality',
      latlng: { lat: 14.1463, lng: 121.4729 }, hazards: [] },
    { name: 'Nagcarlan Municipal Hall', sub: 'Nagcarlan, Laguna — 52 barangays (most of any Laguna town)', category: 'Municipality',
      latlng: { lat: 14.1364, lng: 121.4165 }, hazards: [] },
    { name: 'Paete Municipal Hall', sub: 'Paete, Laguna — 9 barangays', category: 'Municipality',
      latlng: { lat: 14.364557, lng: 121.481638 }, hazards: [] },
    { name: 'Pagsanjan Municipal Hall', sub: 'Pagsanjan, Laguna — "Tourist Capital of Laguna" — 16 barangays', category: 'Municipality',
      latlng: { lat: 14.273283, lng: 121.449060 }, hazards: [] },
    { name: 'Pakil Municipal Hall', sub: 'Pakil, Laguna — Pilgrimage Capital of Laguna — 13 barangays', category: 'Municipality',
      latlng: { lat: 14.380826, lng: 121.478914 }, hazards: [] },
    { name: 'Pangil Municipal Hall', sub: 'Pangil, Laguna — 8 barangays', category: 'Municipality',
      latlng: { lat: 14.4, lng: 121.47 }, hazards: [] },
    { name: 'Pila Municipal Hall', sub: 'Pila, Laguna — heritage town — 17 barangays', category: 'Municipality',
      latlng: { lat: 14.233958, lng: 121.364398 }, hazards: [] },
    { name: 'Rizal Municipal Hall', sub: 'Rizal, Laguna — 11 barangays', category: 'Municipality',
      latlng: { lat: 14.1083, lng: 121.3917 }, hazards: [] },
    { name: 'Santa Maria Municipal Hall', sub: 'Santa Maria, Laguna — 25 barangays', category: 'Municipality',
      latlng: { lat: 14.475, lng: 121.425 }, hazards: [] },
    { name: 'Siniloan Municipal Hall', sub: 'Siniloan, Laguna — "A Waterfall Sanctuary" — 20 barangays', category: 'Municipality',
      latlng: { lat: 14.421999, lng: 121.446129 }, hazards: [] },
    { name: 'Victoria Municipal Hall', sub: 'Victoria, Laguna — Duck Raising Capital of the Philippines — 9 barangays', category: 'Municipality',
      latlng: { lat: 14.225, lng: 121.325 }, hazards: [] }
,
    // ---- Every province in the Philippines (82 total, verified against
    // PSA/PSGC via the 'psgc' community dataset, is_pseudo provinces like
    // independent cities and NCR excluded) — added so BiyaHERO's search can
    // resolve a province name (e.g. searching 'Laguna' or 'Batangas') even
    // though only Laguna gets full city/municipality/barangay detail below.
    // category: 'Province' is intentionally left out of POI_ICON_SVG — these
    // are single representative points for a huge area, so they're fully
    // searchable/navigable but don't clutter the on-map POI browsing layer
    // the way a church or gas station icon would. ----
    { name: 'Abra', sub: 'Province, Cordillera Administrative Region (CAR)', category: 'Province',
      latlng: { lat: 17.578121, lng: 120.803199 }, hazards: [] },
    { name: 'Agusan del Norte', sub: 'Province, Region XIII (Caraga)', category: 'Province',
      latlng: { lat: 9.072133, lng: 125.522395 }, hazards: [] },
    { name: 'Agusan del Sur', sub: 'Province, Region XIII (Caraga)', category: 'Province',
      latlng: { lat: 8.421401, lng: 125.729015 }, hazards: [] },
    { name: 'Aklan', sub: 'Province, Region VI (Western Visayas)', category: 'Province',
      latlng: { lat: 11.609532, lng: 122.248059 }, hazards: [] },
    { name: 'Albay', sub: 'Province, Region V (Bicol Region)', category: 'Province',
      latlng: { lat: 13.209668, lng: 123.615739 }, hazards: [] },
    { name: 'Antique', sub: 'Province, Region VI (Western Visayas)', category: 'Province',
      latlng: { lat: 11.126288, lng: 122.068083 }, hazards: [] },
    { name: 'Apayao', sub: 'Province, Cordillera Administrative Region (CAR)', category: 'Province',
      latlng: { lat: 18.105488, lng: 121.187563 }, hazards: [] },
    { name: 'Aurora', sub: 'Province, Region III (Central Luzon)', category: 'Province',
      latlng: { lat: 15.922707, lng: 121.699847 }, hazards: [] },
    { name: 'Basilan', sub: 'Province, Bangsamoro Autonomous Region In Muslim Mindanao (BARMM)', category: 'Province',
      latlng: { lat: 6.565435, lng: 122.029096 }, hazards: [] },
    { name: 'Bataan', sub: 'Province, Region III (Central Luzon)', category: 'Province',
      latlng: { lat: 14.66041, lng: 120.454415 }, hazards: [] },
    { name: 'Batanes', sub: 'Province, Region II (Cagayan Valley)', category: 'Province',
      latlng: { lat: 20.552162, lng: 121.888002 }, hazards: [] },
    { name: 'Batangas', sub: 'Province, Region IV-A (CALABARZON)', category: 'Province',
      latlng: { lat: 13.891818, lng: 121.031451 }, hazards: [] },
    { name: 'Benguet', sub: 'Province, Cordillera Administrative Region (CAR)', category: 'Province',
      latlng: { lat: 16.545486, lng: 120.701055 }, hazards: [] },
    { name: 'Biliran', sub: 'Province, Region VIII (Eastern Visayas)', category: 'Province',
      latlng: { lat: 11.596696, lng: 124.473256 }, hazards: [] },
    { name: 'Bohol', sub: 'Province, Region VII (Central Visayas)', category: 'Province',
      latlng: { lat: 9.853804, lng: 124.197553 }, hazards: [] },
    { name: 'Bukidnon', sub: 'Province, Region X (Northern Mindanao)', category: 'Province',
      latlng: { lat: 8.01854, lng: 125.006949 }, hazards: [] },
    { name: 'Bulacan', sub: 'Province, Region III (Central Luzon)', category: 'Province',
      latlng: { lat: 14.978688, lng: 121.057836 }, hazards: [] },
    { name: 'Cagayan', sub: 'Province, Region II (Cagayan Valley)', category: 'Province',
      latlng: { lat: 18.093278, lng: 121.76074 }, hazards: [] },
    { name: 'Camarines Norte', sub: 'Province, Region V (Bicol Region)', category: 'Province',
      latlng: { lat: 14.143134, lng: 122.727661 }, hazards: [] },
    { name: 'Camarines Sur', sub: 'Province, Region V (Bicol Region)', category: 'Province',
      latlng: { lat: 13.705255, lng: 123.262336 }, hazards: [] },
    { name: 'Camiguin', sub: 'Province, Region X (Northern Mindanao)', category: 'Province',
      latlng: { lat: 9.171987, lng: 124.717747 }, hazards: [] },
    { name: 'Capiz', sub: 'Province, Region VI (Western Visayas)', category: 'Province',
      latlng: { lat: 11.369865, lng: 122.632904 }, hazards: [] },
    { name: 'Catanduanes', sub: 'Province, Region V (Bicol Region)', category: 'Province',
      latlng: { lat: 13.783156, lng: 124.236448 }, hazards: [] },
    { name: 'Cavite', sub: 'Province, Region IV-A (CALABARZON)', category: 'Province',
      latlng: { lat: 14.254732, lng: 120.86847 }, hazards: [] },
    { name: 'Cebu', sub: 'Province, Region VII (Central Visayas)', category: 'Province',
      latlng: { lat: 10.353874, lng: 123.742713 }, hazards: [] },
    { name: 'Cotabato', sub: 'Province, Region XII (SOCCSKSARGEN)', category: 'Province',
      latlng: { lat: 7.209991, lng: 124.867332 }, hazards: [] },
    { name: 'Davao Occidental', sub: 'Province, Region XI (Davao Region)', category: 'Province',
      latlng: { lat: 6.097965, lng: 125.54057 }, hazards: [] },
    { name: 'Davao Oriental', sub: 'Province, Region XI (Davao Region)', category: 'Province',
      latlng: { lat: 7.251011, lng: 126.298164 }, hazards: [] },
    { name: 'Davao de Oro', sub: 'Province, Region XI (Davao Region)', category: 'Province',
      latlng: { lat: 7.573118, lng: 126.022949 }, hazards: [] },
    { name: 'Davao del Norte', sub: 'Province, Region XI (Davao Region)', category: 'Province',
      latlng: { lat: 7.585181, lng: 125.642247 }, hazards: [] },
    { name: 'Davao del Sur', sub: 'Province, Region XI (Davao Region)', category: 'Province',
      latlng: { lat: 6.713291, lng: 125.255652 }, hazards: [] },
    { name: 'Dinagat Islands', sub: 'Province, Region XIII (Caraga)', category: 'Province',
      latlng: { lat: 10.170899, lng: 125.602437 }, hazards: [] },
    { name: 'Eastern Samar', sub: 'Province, Region VIII (Eastern Visayas)', category: 'Province',
      latlng: { lat: 11.646915, lng: 125.381263 }, hazards: [] },
    { name: 'Guimaras', sub: 'Province, Region VI (Western Visayas)', category: 'Province',
      latlng: { lat: 10.568766, lng: 122.61408 }, hazards: [] },
    { name: 'Ifugao', sub: 'Province, Cordillera Administrative Region (CAR)', category: 'Province',
      latlng: { lat: 16.848396, lng: 121.207174 }, hazards: [] },
    { name: 'Ilocos Norte', sub: 'Province, Region I (Ilocos Region)', category: 'Province',
      latlng: { lat: 18.204654, lng: 120.730253 }, hazards: [] },
    { name: 'Ilocos Sur', sub: 'Province, Region I (Ilocos Region)', category: 'Province',
      latlng: { lat: 17.24703, lng: 120.547087 }, hazards: [] },
    { name: 'Iloilo', sub: 'Province, Region VI (Western Visayas)', category: 'Province',
      latlng: { lat: 11.012157, lng: 122.606616 }, hazards: [] },
    { name: 'Isabela', sub: 'Province, Region II (Cagayan Valley)', category: 'Province',
      latlng: { lat: 16.986911, lng: 121.961202 }, hazards: [] },
    { name: 'Kalinga', sub: 'Province, Cordillera Administrative Region (CAR)', category: 'Province',
      latlng: { lat: 17.430898, lng: 121.279474 }, hazards: [] },
    { name: 'La Union', sub: 'Province, Region I (Ilocos Region)', category: 'Province',
      latlng: { lat: 16.580352, lng: 120.424518 }, hazards: [] },
    { name: 'Laguna', sub: 'Province, Region IV-A (CALABARZON)', category: 'Province',
      latlng: { lat: 14.23767, lng: 121.360491 }, hazards: [] },
    { name: 'Lanao del Norte', sub: 'Province, Region X (Northern Mindanao)', category: 'Province',
      latlng: { lat: 7.974764, lng: 123.95288 }, hazards: [] },
    { name: 'Lanao del Sur', sub: 'Province, Bangsamoro Autonomous Region In Muslim Mindanao (BARMM)', category: 'Province',
      latlng: { lat: 7.789228, lng: 124.34456 }, hazards: [] },
    { name: 'Leyte', sub: 'Province, Region VIII (Eastern Visayas)', category: 'Province',
      latlng: { lat: 10.968554, lng: 124.752083 }, hazards: [] },
    { name: 'Maguindanao del Norte', sub: 'Province, Bangsamoro Autonomous Region In Muslim Mindanao (BARMM)', category: 'Province',
      latlng: { lat: 7.178263, lng: 124.237571 }, hazards: [] },
    { name: 'Maguindanao del Sur', sub: 'Province, Bangsamoro Autonomous Region In Muslim Mindanao (BARMM)', category: 'Province',
      latlng: { lat: 6.88872, lng: 124.57461 }, hazards: [] },
    { name: 'Marinduque', sub: 'Province, MIMAROPA Region', category: 'Province',
      latlng: { lat: 13.391267, lng: 121.971921 }, hazards: [] },
    { name: 'Masbate', sub: 'Province, Region V (Bicol Region)', category: 'Province',
      latlng: { lat: 12.29426, lng: 123.552538 }, hazards: [] },
    { name: 'Misamis Occidental', sub: 'Province, Region X (Northern Mindanao)', category: 'Province',
      latlng: { lat: 8.32726, lng: 123.690967 }, hazards: [] },
    { name: 'Misamis Oriental', sub: 'Province, Region X (Northern Mindanao)', category: 'Province',
      latlng: { lat: 8.678292, lng: 124.82484 }, hazards: [] },
    { name: 'Mountain Province', sub: 'Province, Cordillera Administrative Region (CAR)', category: 'Province',
      latlng: { lat: 17.10125, lng: 121.129204 }, hazards: [] },
    { name: 'Negros Occidental', sub: 'Province, Negros Island Region (NIR)', category: 'Province',
      latlng: { lat: 10.30318, lng: 122.986685 }, hazards: [] },
    { name: 'Negros Oriental', sub: 'Province, Negros Island Region (NIR)', category: 'Province',
      latlng: { lat: 9.606563, lng: 123.033454 }, hazards: [] },
    { name: 'Northern Samar', sub: 'Province, Region VIII (Eastern Visayas)', category: 'Province',
      latlng: { lat: 12.41107, lng: 124.791738 }, hazards: [] },
    { name: 'Nueva Ecija', sub: 'Province, Region III (Central Luzon)', category: 'Province',
      latlng: { lat: 15.617572, lng: 121.02059 }, hazards: [] },
    { name: 'Nueva Vizcaya', sub: 'Province, Region II (Cagayan Valley)', category: 'Province',
      latlng: { lat: 16.3052, lng: 121.171813 }, hazards: [] },
    { name: 'Occidental Mindoro', sub: 'Province, MIMAROPA Region', category: 'Province',
      latlng: { lat: 12.971404, lng: 120.892966 }, hazards: [] },
    { name: 'Oriental Mindoro', sub: 'Province, MIMAROPA Region', category: 'Province',
      latlng: { lat: 12.923174, lng: 121.299296 }, hazards: [] },
    { name: 'Palawan', sub: 'Province, MIMAROPA Region', category: 'Province',
      latlng: { lat: 9.98578, lng: 118.73455 }, hazards: [] },
    { name: 'Pampanga', sub: 'Province, Region III (Central Luzon)', category: 'Province',
      latlng: { lat: 15.051978, lng: 120.653156 }, hazards: [] },
    { name: 'Pangasinan', sub: 'Province, Region I (Ilocos Region)', category: 'Province',
      latlng: { lat: 15.999397, lng: 120.31266 }, hazards: [] },
    { name: 'Quezon', sub: 'Province, Region IV-A (CALABARZON)', category: 'Province',
      latlng: { lat: 14.167753, lng: 121.966136 }, hazards: [] },
    { name: 'Quirino', sub: 'Province, Region II (Cagayan Valley)', category: 'Province',
      latlng: { lat: 16.294404, lng: 121.5955 }, hazards: [] },
    { name: 'Rizal', sub: 'Province, Region IV-A (CALABARZON)', category: 'Province',
      latlng: { lat: 14.617328, lng: 121.262537 }, hazards: [] },
    { name: 'Romblon', sub: 'Province, MIMAROPA Region', category: 'Province',
      latlng: { lat: 12.435564, lng: 122.234537 }, hazards: [] },
    { name: 'Samar', sub: 'Province, Region VIII (Eastern Visayas)', category: 'Province',
      latlng: { lat: 11.846163, lng: 124.940475 }, hazards: [] },
    { name: 'Sarangani', sub: 'Province, Region XII (SOCCSKSARGEN)', category: 'Province',
      latlng: { lat: 6.059589, lng: 125.158327 }, hazards: [] },
    { name: 'Siquijor', sub: 'Province, Negros Island Region (NIR)', category: 'Province',
      latlng: { lat: 9.185199, lng: 123.588667 }, hazards: [] },
    { name: 'Sorsogon', sub: 'Province, Region V (Bicol Region)', category: 'Province',
      latlng: { lat: 12.85425, lng: 123.928586 }, hazards: [] },
    { name: 'South Cotabato', sub: 'Province, Region XII (SOCCSKSARGEN)', category: 'Province',
      latlng: { lat: 6.306775, lng: 124.813002 }, hazards: [] },
    { name: 'Southern Leyte', sub: 'Province, Region VIII (Eastern Visayas)', category: 'Province',
      latlng: { lat: 10.291159, lng: 125.051949 }, hazards: [] },
    { name: 'Sultan Kudarat', sub: 'Province, Region XII (SOCCSKSARGEN)', category: 'Province',
      latlng: { lat: 6.534934, lng: 124.431255 }, hazards: [] },
    { name: 'Sulu', sub: 'Province, Region IX (Zamboanga Peninsula)', category: 'Province',
      latlng: { lat: 5.954663, lng: 121.056167 }, hazards: [] },
    { name: 'Surigao del Norte', sub: 'Province, Region XIII (Caraga)', category: 'Province',
      latlng: { lat: 9.670654, lng: 125.737504 }, hazards: [] },
    { name: 'Surigao del Sur', sub: 'Province, Region XIII (Caraga)', category: 'Province',
      latlng: { lat: 8.7759, lng: 126.113138 }, hazards: [] },
    { name: 'Tarlac', sub: 'Province, Region III (Central Luzon)', category: 'Province',
      latlng: { lat: 15.478243, lng: 120.476199 }, hazards: [] },
    { name: 'Tawi-Tawi', sub: 'Province, Bangsamoro Autonomous Region In Muslim Mindanao (BARMM)', category: 'Province',
      latlng: { lat: 5.238896, lng: 119.900726 }, hazards: [] },
    { name: 'Zambales', sub: 'Province, Region III (Central Luzon)', category: 'Province',
      latlng: { lat: 15.304493, lng: 120.137358 }, hazards: [] },
    { name: 'Zamboanga Sibugay', sub: 'Province, Region IX (Zamboanga Peninsula)', category: 'Province',
      latlng: { lat: 7.69468, lng: 122.725437 }, hazards: [] },
    { name: 'Zamboanga del Norte', sub: 'Province, Region IX (Zamboanga Peninsula)', category: 'Province',
      latlng: { lat: 8.048888, lng: 122.806957 }, hazards: [] },
    { name: 'Zamboanga del Sur', sub: 'Province, Region IX (Zamboanga Peninsula)', category: 'Province',
      latlng: { lat: 7.881254, lng: 123.322396 }, hazards: [] },
    // ---- Every barangay in Laguna province (681 total across all 30
    // cities/municipalities) — real coordinates from the community-
    // maintained 'psgc' dataset (PyPI), which derives them from PSA PSGC
    // codes matched to Nov-2023 OCHA HDX / NAMRIA administrative-boundary
    // polygons (coordinate_source: hdx_exact_2023 for all 681 — no
    // low-confidence fallback points needed). Verified zero duplicate
    // (barangay, city) pairs in the source data before generating this.
    // category: 'Barangay' — see the matching icon/color below, added
    // as a fine-grained (not 'major') category so 681 pins don't overwhelm
    // the map except when already zoomed in close. ----
    { name: 'Del Carmen', sub: 'Barangay, Alaminos, Laguna', category: 'Barangay',
      latlng: { lat: 14.079527, lng: 121.265654 }, hazards: [] },
    { name: 'Palma', sub: 'Barangay, Alaminos, Laguna', category: 'Barangay',
      latlng: { lat: 14.025383, lng: 121.231826 }, hazards: [] },
    { name: 'Barangay I', sub: 'Barangay, Alaminos, Laguna', category: 'Barangay',
      latlng: { lat: 14.061689, lng: 121.250574 }, hazards: [] },
    { name: 'Barangay II', sub: 'Barangay, Alaminos, Laguna', category: 'Barangay',
      latlng: { lat: 14.06666, lng: 121.23896 }, hazards: [] },
    { name: 'Barangay III', sub: 'Barangay, Alaminos, Laguna', category: 'Barangay',
      latlng: { lat: 14.069351, lng: 121.248467 }, hazards: [] },
    { name: 'Barangay IV', sub: 'Barangay, Alaminos, Laguna', category: 'Barangay',
      latlng: { lat: 14.060995, lng: 121.244406 }, hazards: [] },
    { name: 'San Agustin', sub: 'Barangay, Alaminos, Laguna', category: 'Barangay',
      latlng: { lat: 14.05943, lng: 121.264452 }, hazards: [] },
    { name: 'San Andres', sub: 'Barangay, Alaminos, Laguna', category: 'Barangay',
      latlng: { lat: 14.07, lng: 121.219237 }, hazards: [] },
    { name: 'San Benito', sub: 'Barangay, Alaminos, Laguna', category: 'Barangay',
      latlng: { lat: 14.057026, lng: 121.279929 }, hazards: [] },
    { name: 'San Gregorio', sub: 'Barangay, Alaminos, Laguna', category: 'Barangay',
      latlng: { lat: 14.019298, lng: 121.255905 }, hazards: [] },
    { name: 'San Ildefonso', sub: 'Barangay, Alaminos, Laguna', category: 'Barangay',
      latlng: { lat: 14.044385, lng: 121.220001 }, hazards: [] },
    { name: 'San Juan', sub: 'Barangay, Alaminos, Laguna', category: 'Barangay',
      latlng: { lat: 14.06039, lng: 121.231909 }, hazards: [] },
    { name: 'San Miguel', sub: 'Barangay, Alaminos, Laguna', category: 'Barangay',
      latlng: { lat: 14.049058, lng: 121.25607 }, hazards: [] },
    { name: 'San Roque', sub: 'Barangay, Alaminos, Laguna', category: 'Barangay',
      latlng: { lat: 14.043475, lng: 121.271562 }, hazards: [] },
    { name: 'Santa Rosa', sub: 'Barangay, Alaminos, Laguna', category: 'Barangay',
      latlng: { lat: 14.041835, lng: 121.242391 }, hazards: [] },
    { name: 'Bitin', sub: 'Barangay, Bay, Laguna', category: 'Barangay',
      latlng: { lat: 14.100876, lng: 121.2193 }, hazards: [] },
    { name: 'Calo', sub: 'Barangay, Bay, Laguna', category: 'Barangay',
      latlng: { lat: 14.18358, lng: 121.280488 }, hazards: [] },
    { name: 'Dila', sub: 'Barangay, Bay, Laguna', category: 'Barangay',
      latlng: { lat: 14.176535, lng: 121.292889 }, hazards: [] },
    { name: 'Maitim', sub: 'Barangay, Bay, Laguna', category: 'Barangay',
      latlng: { lat: 14.185556, lng: 121.273794 }, hazards: [] },
    { name: 'Masaya', sub: 'Barangay, Bay, Laguna', category: 'Barangay',
      latlng: { lat: 14.144823, lng: 121.277186 }, hazards: [] },
    { name: 'Paciano Rizal', sub: 'Barangay, Bay, Laguna', category: 'Barangay',
      latlng: { lat: 14.150678, lng: 121.266856 }, hazards: [] },
    { name: 'Puypuy', sub: 'Barangay, Bay, Laguna', category: 'Barangay',
      latlng: { lat: 14.162397, lng: 121.282924 }, hazards: [] },
    { name: 'San Antonio', sub: 'Barangay, Bay, Laguna', category: 'Barangay',
      latlng: { lat: 14.191574, lng: 121.281879 }, hazards: [] },
    { name: 'San Isidro', sub: 'Barangay, Bay, Laguna', category: 'Barangay',
      latlng: { lat: 14.187914, lng: 121.28595 }, hazards: [] },
    { name: 'Santa Cruz', sub: 'Barangay, Bay, Laguna', category: 'Barangay',
      latlng: { lat: 14.121155, lng: 121.245911 }, hazards: [] },
    { name: 'Santo Domingo', sub: 'Barangay, Bay, Laguna', category: 'Barangay',
      latlng: { lat: 14.176936, lng: 121.267725 }, hazards: [] },
    { name: 'Tagumpay', sub: 'Barangay, Bay, Laguna', category: 'Barangay',
      latlng: { lat: 14.19387, lng: 121.290499 }, hazards: [] },
    { name: 'Tranca', sub: 'Barangay, Bay, Laguna', category: 'Barangay',
      latlng: { lat: 14.132901, lng: 121.261523 }, hazards: [] },
    { name: 'San Agustin', sub: 'Barangay, Bay, Laguna', category: 'Barangay',
      latlng: { lat: 14.180566, lng: 121.283608 }, hazards: [] },
    { name: 'San Nicolas', sub: 'Barangay, Bay, Laguna', category: 'Barangay',
      latlng: { lat: 14.182563, lng: 121.284149 }, hazards: [] },
    { name: 'Biñan', sub: 'Barangay, Biñan City, Laguna', category: 'Barangay',
      latlng: { lat: 14.264777, lng: 121.049983 }, hazards: [] },
    { name: 'Bungahan', sub: 'Barangay, Biñan City, Laguna', category: 'Barangay',
      latlng: { lat: 14.302339, lng: 121.075179 }, hazards: [] },
    { name: 'Santo Tomas', sub: 'Barangay, Biñan City, Laguna', category: 'Barangay',
      latlng: { lat: 14.313643, lng: 121.072186 }, hazards: [] },
    { name: 'Canlalay', sub: 'Barangay, Biñan City, Laguna', category: 'Barangay',
      latlng: { lat: 14.341781, lng: 121.074062 }, hazards: [] },
    { name: 'Casile', sub: 'Barangay, Biñan City, Laguna', category: 'Barangay',
      latlng: { lat: 14.343767, lng: 121.08845 }, hazards: [] },
    { name: 'De La Paz', sub: 'Barangay, Biñan City, Laguna', category: 'Barangay',
      latlng: { lat: 14.352475, lng: 121.081871 }, hazards: [] },
    { name: 'Ganado', sub: 'Barangay, Biñan City, Laguna', category: 'Barangay',
      latlng: { lat: 14.286363, lng: 121.08311 }, hazards: [] },
    { name: 'San Francisco', sub: 'Barangay, Biñan City, Laguna', category: 'Barangay',
      latlng: { lat: 14.333305, lng: 121.054902 }, hazards: [] },
    { name: 'Langkiwa', sub: 'Barangay, Biñan City, Laguna', category: 'Barangay',
      latlng: { lat: 14.296001, lng: 121.059193 }, hazards: [] },
    { name: 'Loma', sub: 'Barangay, Biñan City, Laguna', category: 'Barangay',
      latlng: { lat: 14.284607, lng: 121.069082 }, hazards: [] },
    { name: 'Malaban', sub: 'Barangay, Biñan City, Laguna', category: 'Barangay',
      latlng: { lat: 14.346418, lng: 121.091204 }, hazards: [] },
    { name: 'Malamig', sub: 'Barangay, Biñan City, Laguna', category: 'Barangay',
      latlng: { lat: 14.275609, lng: 121.048062 }, hazards: [] },
    { name: 'Mampalasan', sub: 'Barangay, Biñan City, Laguna', category: 'Barangay',
      latlng: { lat: 14.295678, lng: 121.08112 }, hazards: [] },
    { name: 'Platero', sub: 'Barangay, Biñan City, Laguna', category: 'Barangay',
      latlng: { lat: 14.32244, lng: 121.09167 }, hazards: [] },
    { name: 'Poblacion', sub: 'Barangay, Biñan City, Laguna', category: 'Barangay',
      latlng: { lat: 14.338126, lng: 121.084286 }, hazards: [] },
    { name: 'Santo Niño', sub: 'Barangay, Biñan City, Laguna', category: 'Barangay',
      latlng: { lat: 14.327366, lng: 121.084382 }, hazards: [] },
    { name: 'San Antonio', sub: 'Barangay, Biñan City, Laguna', category: 'Barangay',
      latlng: { lat: 14.333886, lng: 121.090655 }, hazards: [] },
    { name: 'San Jose', sub: 'Barangay, Biñan City, Laguna', category: 'Barangay',
      latlng: { lat: 14.342448, lng: 121.082163 }, hazards: [] },
    { name: 'San Vicente', sub: 'Barangay, Biñan City, Laguna', category: 'Barangay',
      latlng: { lat: 14.33232, lng: 121.080236 }, hazards: [] },
    { name: 'Soro-soro', sub: 'Barangay, Biñan City, Laguna', category: 'Barangay',
      latlng: { lat: 14.327116, lng: 121.060316 }, hazards: [] },
    { name: 'Santo Domingo', sub: 'Barangay, Biñan City, Laguna', category: 'Barangay',
      latlng: { lat: 14.337983, lng: 121.081406 }, hazards: [] },
    { name: 'Timbao', sub: 'Barangay, Biñan City, Laguna', category: 'Barangay',
      latlng: { lat: 14.283506, lng: 121.054392 }, hazards: [] },
    { name: 'Tubigan', sub: 'Barangay, Biñan City, Laguna', category: 'Barangay',
      latlng: { lat: 14.331018, lng: 121.070829 }, hazards: [] },
    { name: 'Zapote', sub: 'Barangay, Biñan City, Laguna', category: 'Barangay',
      latlng: { lat: 14.314199, lng: 121.084122 }, hazards: [] },
    { name: 'Baclaran', sub: 'Barangay, Cabuyao City, Laguna', category: 'Barangay',
      latlng: { lat: 14.24579, lng: 121.163384 }, hazards: [] },
    { name: 'Banaybanay', sub: 'Barangay, Cabuyao City, Laguna', category: 'Barangay',
      latlng: { lat: 14.254149, lng: 121.13148 }, hazards: [] },
    { name: 'Banlic', sub: 'Barangay, Cabuyao City, Laguna', category: 'Barangay',
      latlng: { lat: 14.23249, lng: 121.138744 }, hazards: [] },
    { name: 'Butong', sub: 'Barangay, Cabuyao City, Laguna', category: 'Barangay',
      latlng: { lat: 14.286226, lng: 121.137568 }, hazards: [] },
    { name: 'Bigaa', sub: 'Barangay, Cabuyao City, Laguna', category: 'Barangay',
      latlng: { lat: 14.284896, lng: 121.130525 }, hazards: [] },
    { name: 'Casile', sub: 'Barangay, Cabuyao City, Laguna', category: 'Barangay',
      latlng: { lat: 14.185821, lng: 121.03248 }, hazards: [] },
    { name: 'Gulod', sub: 'Barangay, Cabuyao City, Laguna', category: 'Barangay',
      latlng: { lat: 14.257096, lng: 121.160113 }, hazards: [] },
    { name: 'Mamatid', sub: 'Barangay, Cabuyao City, Laguna', category: 'Barangay',
      latlng: { lat: 14.238286, lng: 121.156838 }, hazards: [] },
    { name: 'Marinig', sub: 'Barangay, Cabuyao City, Laguna', category: 'Barangay',
      latlng: { lat: 14.272306, lng: 121.149787 }, hazards: [] },
    { name: 'Niugan', sub: 'Barangay, Cabuyao City, Laguna', category: 'Barangay',
      latlng: { lat: 14.262077, lng: 121.130654 }, hazards: [] },
    { name: 'Pittland', sub: 'Barangay, Cabuyao City, Laguna', category: 'Barangay',
      latlng: { lat: 14.219227, lng: 121.067628 }, hazards: [] },
    { name: 'Pulo', sub: 'Barangay, Cabuyao City, Laguna', category: 'Barangay',
      latlng: { lat: 14.245273, lng: 121.129711 }, hazards: [] },
    { name: 'Sala', sub: 'Barangay, Cabuyao City, Laguna', category: 'Barangay',
      latlng: { lat: 14.268562, lng: 121.124428 }, hazards: [] },
    { name: 'San Isidro', sub: 'Barangay, Cabuyao City, Laguna', category: 'Barangay',
      latlng: { lat: 14.243292, lng: 121.140406 }, hazards: [] },
    { name: 'Diezmo', sub: 'Barangay, Cabuyao City, Laguna', category: 'Barangay',
      latlng: { lat: 14.23399, lng: 121.101138 }, hazards: [] },
    { name: 'Barangay Uno', sub: 'Barangay, Cabuyao City, Laguna', category: 'Barangay',
      latlng: { lat: 14.279925, lng: 121.123878 }, hazards: [] },
    { name: 'Barangay Dos', sub: 'Barangay, Cabuyao City, Laguna', category: 'Barangay',
      latlng: { lat: 14.277041, lng: 121.125021 }, hazards: [] },
    { name: 'Barangay Tres', sub: 'Barangay, Cabuyao City, Laguna', category: 'Barangay',
      latlng: { lat: 14.27537, lng: 121.122847 }, hazards: [] },
    { name: 'Bagong Kalsada', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.170713, lng: 121.194811 }, hazards: [] },
    { name: 'Banadero', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.219661, lng: 121.163288 }, hazards: [] },
    { name: 'Banlic', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.227816, lng: 121.158329 }, hazards: [] },
    { name: 'Barandal', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.193213, lng: 121.127659 }, hazards: [] },
    { name: 'Bubuyan', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.172781, lng: 121.106304 }, hazards: [] },
    { name: 'Bucal', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.18561, lng: 121.172527 }, hazards: [] },
    { name: 'Bunggo', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.158956, lng: 121.068477 }, hazards: [] },
    { name: 'Burol', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.164036, lng: 121.094329 }, hazards: [] },
    { name: 'Camaligan', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.158151, lng: 121.150747 }, hazards: [] },
    { name: 'Canlubang', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.198273, lng: 121.077121 }, hazards: [] },
    { name: 'Halang', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.195769, lng: 121.169008 }, hazards: [] },
    { name: 'Hornalan', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.167287, lng: 121.064781 }, hazards: [] },
    { name: 'Kay-Anlog', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.162435, lng: 121.115133 }, hazards: [] },
    { name: 'Laguerta', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.173751, lng: 121.087746 }, hazards: [] },
    { name: 'La Mesa', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.18446, lng: 121.151815 }, hazards: [] },
    { name: 'Lawa', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.205608, lng: 121.14493 }, hazards: [] },
    { name: 'Lecheria', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.202025, lng: 121.171094 }, hazards: [] },
    { name: 'Lingga', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.209658, lng: 121.180906 }, hazards: [] },
    { name: 'Looc', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.227241, lng: 121.178263 }, hazards: [] },
    { name: 'Mabato', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.161241, lng: 121.034787 }, hazards: [] },
    { name: 'Makiling', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.1529, lng: 121.138787 }, hazards: [] },
    { name: 'Mapagong', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.225997, lng: 121.128501 }, hazards: [] },
    { name: 'Masili', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.181689, lng: 121.202373 }, hazards: [] },
    { name: 'Maunong', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.169361, lng: 121.161019 }, hazards: [] },
    { name: 'Mayapa', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.211259, lng: 121.123053 }, hazards: [] },
    { name: 'Paciano Rizal', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.214568, lng: 121.134913 }, hazards: [] },
    { name: 'Palingon', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.215608, lng: 121.189135 }, hazards: [] },
    { name: 'Palo-Alto', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.189151, lng: 121.111233 }, hazards: [] },
    { name: 'Pansol', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.177183, lng: 121.185453 }, hazards: [] },
    { name: 'Parian', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.213836, lng: 121.148447 }, hazards: [] },
    { name: 'Barangay 1', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.205103, lng: 121.157305 }, hazards: [] },
    { name: 'Barangay 2', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.21274, lng: 121.160117 }, hazards: [] },
    { name: 'Barangay 3', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.208154, lng: 121.161536 }, hazards: [] },
    { name: 'Barangay 4', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.21501, lng: 121.166126 }, hazards: [] },
    { name: 'Barangay 5', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.209253, lng: 121.166674 }, hazards: [] },
    { name: 'Barangay 6', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.213361, lng: 121.164891 }, hazards: [] },
    { name: 'Barangay 7', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.20996, lng: 121.171093 }, hazards: [] },
    { name: 'Prinza', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.197775, lng: 121.139 }, hazards: [] },
    { name: 'Punta', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.178167, lng: 121.12025 }, hazards: [] },
    { name: 'Puting Lupa', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.152536, lng: 121.169065 }, hazards: [] },
    { name: 'Real', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.197706, lng: 121.151114 }, hazards: [] },
    { name: 'Sucol', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.179719, lng: 121.197453 }, hazards: [] },
    { name: 'Saimsim', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.163313, lng: 121.147575 }, hazards: [] },
    { name: 'Sampiruhan', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.219893, lng: 121.183898 }, hazards: [] },
    { name: 'San Cristobal', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.223576, lng: 121.143428 }, hazards: [] },
    { name: 'San Jose', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.212838, lng: 121.175083 }, hazards: [] },
    { name: 'San Juan', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.216506, lng: 121.173753 }, hazards: [] },
    { name: 'Sirang Lupa', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.201253, lng: 121.104238 }, hazards: [] },
    { name: 'Milagrosa', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.17389, lng: 121.134908 }, hazards: [] },
    { name: 'Turbina', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.188508, lng: 121.138278 }, hazards: [] },
    { name: 'Ulango', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.154479, lng: 121.123086 }, hazards: [] },
    { name: 'Uwisan', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.234425, lng: 121.173641 }, hazards: [] },
    { name: 'Batino', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.20218, lng: 121.13286 }, hazards: [] },
    { name: 'Majada Labas', sub: 'Barangay, Calamba City, Laguna', category: 'Barangay',
      latlng: { lat: 14.195632, lng: 121.105326 }, hazards: [] },
    { name: 'Balayhangin', sub: 'Barangay, Calauan, Laguna', category: 'Barangay',
      latlng: { lat: 14.130179, lng: 121.312296 }, hazards: [] },
    { name: 'Bangyas', sub: 'Barangay, Calauan, Laguna', category: 'Barangay',
      latlng: { lat: 14.178791, lng: 121.315467 }, hazards: [] },
    { name: 'Dayap', sub: 'Barangay, Calauan, Laguna', category: 'Barangay',
      latlng: { lat: 14.176995, lng: 121.338504 }, hazards: [] },
    { name: 'Hanggan', sub: 'Barangay, Calauan, Laguna', category: 'Barangay',
      latlng: { lat: 14.187858, lng: 121.301409 }, hazards: [] },
    { name: 'Imok', sub: 'Barangay, Calauan, Laguna', category: 'Barangay',
      latlng: { lat: 14.108703, lng: 121.292535 }, hazards: [] },
    { name: 'Lamot 1', sub: 'Barangay, Calauan, Laguna', category: 'Barangay',
      latlng: { lat: 14.140028, lng: 121.326827 }, hazards: [] },
    { name: 'Lamot 2', sub: 'Barangay, Calauan, Laguna', category: 'Barangay',
      latlng: { lat: 14.15324, lng: 121.333298 }, hazards: [] },
    { name: 'Limao', sub: 'Barangay, Calauan, Laguna', category: 'Barangay',
      latlng: { lat: 14.090285, lng: 121.244062 }, hazards: [] },
    { name: 'Mabacan', sub: 'Barangay, Calauan, Laguna', category: 'Barangay',
      latlng: { lat: 14.135753, lng: 121.288634 }, hazards: [] },
    { name: 'Masiit', sub: 'Barangay, Calauan, Laguna', category: 'Barangay',
      latlng: { lat: 14.157967, lng: 121.304293 }, hazards: [] },
    { name: 'Paliparan', sub: 'Barangay, Calauan, Laguna', category: 'Barangay',
      latlng: { lat: 14.122298, lng: 121.286739 }, hazards: [] },
    { name: 'Perez', sub: 'Barangay, Calauan, Laguna', category: 'Barangay',
      latlng: { lat: 14.111965, lng: 121.268031 }, hazards: [] },
    { name: 'Kanluran', sub: 'Barangay, Calauan, Laguna', category: 'Barangay',
      latlng: { lat: 14.145149, lng: 121.312606 }, hazards: [] },
    { name: 'Silangan', sub: 'Barangay, Calauan, Laguna', category: 'Barangay',
      latlng: { lat: 14.147412, lng: 121.315544 }, hazards: [] },
    { name: 'Prinza', sub: 'Barangay, Calauan, Laguna', category: 'Barangay',
      latlng: { lat: 14.134702, lng: 121.322919 }, hazards: [] },
    { name: 'San Isidro', sub: 'Barangay, Calauan, Laguna', category: 'Barangay',
      latlng: { lat: 14.161753, lng: 121.317021 }, hazards: [] },
    { name: 'Santo Tomas', sub: 'Barangay, Calauan, Laguna', category: 'Barangay',
      latlng: { lat: 14.158744, lng: 121.349019 }, hazards: [] },
    { name: 'Anglas', sub: 'Barangay, Cavinti, Laguna', category: 'Barangay',
      latlng: { lat: 14.258699, lng: 121.484803 }, hazards: [] },
    { name: 'Bangco', sub: 'Barangay, Cavinti, Laguna', category: 'Barangay',
      latlng: { lat: 14.241429, lng: 121.480282 }, hazards: [] },
    { name: 'Bukal', sub: 'Barangay, Cavinti, Laguna', category: 'Barangay',
      latlng: { lat: 14.233526, lng: 121.549627 }, hazards: [] },
    { name: 'Bulajo', sub: 'Barangay, Cavinti, Laguna', category: 'Barangay',
      latlng: { lat: 14.225025, lng: 121.491443 }, hazards: [] },
    { name: 'Cansuso', sub: 'Barangay, Cavinti, Laguna', category: 'Barangay',
      latlng: { lat: 14.253342, lng: 121.60079 }, hazards: [] },
    { name: 'Duhat', sub: 'Barangay, Cavinti, Laguna', category: 'Barangay',
      latlng: { lat: 14.246527, lng: 121.496039 }, hazards: [] },
    { name: 'Inao-Awan', sub: 'Barangay, Cavinti, Laguna', category: 'Barangay',
      latlng: { lat: 14.2569, lng: 121.532068 }, hazards: [] },
    { name: 'Kanluran Talaongan', sub: 'Barangay, Cavinti, Laguna', category: 'Barangay',
      latlng: { lat: 14.276797, lng: 121.514114 }, hazards: [] },
    { name: 'Labayo', sub: 'Barangay, Cavinti, Laguna', category: 'Barangay',
      latlng: { lat: 14.227659, lng: 121.508061 }, hazards: [] },
    { name: 'Layasin', sub: 'Barangay, Cavinti, Laguna', category: 'Barangay',
      latlng: { lat: 14.233621, lng: 121.489685 }, hazards: [] },
    { name: 'Layug', sub: 'Barangay, Cavinti, Laguna', category: 'Barangay',
      latlng: { lat: 14.229121, lng: 121.538565 }, hazards: [] },
    { name: 'Mahipon', sub: 'Barangay, Cavinti, Laguna', category: 'Barangay',
      latlng: { lat: 14.26848, lng: 121.551546 }, hazards: [] },
    { name: 'Paowin', sub: 'Barangay, Cavinti, Laguna', category: 'Barangay',
      latlng: { lat: 14.257845, lng: 121.569372 }, hazards: [] },
    { name: 'Poblacion', sub: 'Barangay, Cavinti, Laguna', category: 'Barangay',
      latlng: { lat: 14.245669, lng: 121.510347 }, hazards: [] },
    { name: 'Sisilmin', sub: 'Barangay, Cavinti, Laguna', category: 'Barangay',
      latlng: { lat: 14.244454, lng: 121.529081 }, hazards: [] },
    { name: 'Silangan Talaongan', sub: 'Barangay, Cavinti, Laguna', category: 'Barangay',
      latlng: { lat: 14.277944, lng: 121.536513 }, hazards: [] },
    { name: 'Sumucab', sub: 'Barangay, Cavinti, Laguna', category: 'Barangay',
      latlng: { lat: 14.215136, lng: 121.576321 }, hazards: [] },
    { name: 'Tibatib', sub: 'Barangay, Cavinti, Laguna', category: 'Barangay',
      latlng: { lat: 14.257233, lng: 121.512687 }, hazards: [] },
    { name: 'Udia', sub: 'Barangay, Cavinti, Laguna', category: 'Barangay',
      latlng: { lat: 14.223006, lng: 121.531351 }, hazards: [] },
    { name: 'Asana', sub: 'Barangay, Famy, Laguna', category: 'Barangay',
      latlng: { lat: 14.438517, lng: 121.448947 }, hazards: [] },
    { name: 'Bacong-Sigsigan', sub: 'Barangay, Famy, Laguna', category: 'Barangay',
      latlng: { lat: 14.510281, lng: 121.481069 }, hazards: [] },
    { name: 'Bagong Pag-Asa', sub: 'Barangay, Famy, Laguna', category: 'Barangay',
      latlng: { lat: 14.436856, lng: 121.448753 }, hazards: [] },
    { name: 'Balitoc', sub: 'Barangay, Famy, Laguna', category: 'Barangay',
      latlng: { lat: 14.447315, lng: 121.438511 }, hazards: [] },
    { name: 'Banaba', sub: 'Barangay, Famy, Laguna', category: 'Barangay',
      latlng: { lat: 14.437847, lng: 121.44955 }, hazards: [] },
    { name: 'Batuhan', sub: 'Barangay, Famy, Laguna', category: 'Barangay',
      latlng: { lat: 14.433926, lng: 121.442257 }, hazards: [] },
    { name: 'Bulihan', sub: 'Barangay, Famy, Laguna', category: 'Barangay',
      latlng: { lat: 14.447713, lng: 121.447863 }, hazards: [] },
    { name: 'Caballero', sub: 'Barangay, Famy, Laguna', category: 'Barangay',
      latlng: { lat: 14.440198, lng: 121.448867 }, hazards: [] },
    { name: 'Calumpang', sub: 'Barangay, Famy, Laguna', category: 'Barangay',
      latlng: { lat: 14.43681, lng: 121.447703 }, hazards: [] },
    { name: 'Kapatalan', sub: 'Barangay, Famy, Laguna', category: 'Barangay',
      latlng: { lat: 14.48248, lng: 121.501473 }, hazards: [] },
    { name: 'Cuebang Bato', sub: 'Barangay, Famy, Laguna', category: 'Barangay',
      latlng: { lat: 14.496721, lng: 121.467502 }, hazards: [] },
    { name: 'Damayan', sub: 'Barangay, Famy, Laguna', category: 'Barangay',
      latlng: { lat: 14.440397, lng: 121.45035 }, hazards: [] },
    { name: 'Kataypuanan', sub: 'Barangay, Famy, Laguna', category: 'Barangay',
      latlng: { lat: 14.491245, lng: 121.482504 }, hazards: [] },
    { name: 'Liyang', sub: 'Barangay, Famy, Laguna', category: 'Barangay',
      latlng: { lat: 14.483634, lng: 121.471104 }, hazards: [] },
    { name: 'Maate', sub: 'Barangay, Famy, Laguna', category: 'Barangay',
      latlng: { lat: 14.476326, lng: 121.463607 }, hazards: [] },
    { name: 'Magdalo', sub: 'Barangay, Famy, Laguna', category: 'Barangay',
      latlng: { lat: 14.438458, lng: 121.447946 }, hazards: [] },
    { name: 'Mayatba', sub: 'Barangay, Famy, Laguna', category: 'Barangay',
      latlng: { lat: 14.474827, lng: 121.473468 }, hazards: [] },
    { name: 'Minayutan', sub: 'Barangay, Famy, Laguna', category: 'Barangay',
      latlng: { lat: 14.4819, lng: 121.482616 }, hazards: [] },
    { name: 'Salangbato', sub: 'Barangay, Famy, Laguna', category: 'Barangay',
      latlng: { lat: 14.462842, lng: 121.457132 }, hazards: [] },
    { name: 'Tunhac', sub: 'Barangay, Famy, Laguna', category: 'Barangay',
      latlng: { lat: 14.443376, lng: 121.452602 }, hazards: [] },
    { name: 'Longos', sub: 'Barangay, Kalayaan, Laguna', category: 'Barangay',
      latlng: { lat: 14.340756, lng: 121.489364 }, hazards: [] },
    { name: 'San Antonio', sub: 'Barangay, Kalayaan, Laguna', category: 'Barangay',
      latlng: { lat: 14.334226, lng: 121.548987 }, hazards: [] },
    { name: 'San Juan', sub: 'Barangay, Kalayaan, Laguna', category: 'Barangay',
      latlng: { lat: 14.324071, lng: 121.501115 }, hazards: [] },
    { name: 'Bagong Anyo', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.131348, lng: 121.436458 }, hazards: [] },
    { name: 'Bayate', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.180005, lng: 121.418035 }, hazards: [] },
    { name: 'Bubukal', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.155078, lng: 121.433976 }, hazards: [] },
    { name: 'Bongkol', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.14713, lng: 121.440125 }, hazards: [] },
    { name: 'Cabuyew', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.167554, lng: 121.423316 }, hazards: [] },
    { name: 'Calumpang', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.197525, lng: 121.403984 }, hazards: [] },
    { name: 'Culoy', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.155536, lng: 121.428426 }, hazards: [] },
    { name: 'Dagatan', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.189604, lng: 121.374489 }, hazards: [] },
    { name: 'Daniw', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.193835, lng: 121.382392 }, hazards: [] },
    { name: 'Dita', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.20398, lng: 121.388723 }, hazards: [] },
    { name: 'Ibabang Palina', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.152133, lng: 121.422209 }, hazards: [] },
    { name: 'Ibabang San Roque', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.131591, lng: 121.447872 }, hazards: [] },
    { name: 'Ibabang Sungi', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.117363, lng: 121.439684 }, hazards: [] },
    { name: 'Ibabang Taykin', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.14036, lng: 121.442218 }, hazards: [] },
    { name: 'Ilayang Palina', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.139833, lng: 121.427534 }, hazards: [] },
    { name: 'Ilayang San Roque', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.122637, lng: 121.45399 }, hazards: [] },
    { name: 'Ilayang Sungi', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.092262, lng: 121.461471 }, hazards: [] },
    { name: 'Ilayang Taykin', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.136493, lng: 121.445656 }, hazards: [] },
    { name: 'Kanlurang Bukal', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.123676, lng: 121.443755 }, hazards: [] },
    { name: 'Laguan', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.129948, lng: 121.430816 }, hazards: [] },
    { name: 'Rizal', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.131477, lng: 121.435862 }, hazards: [] },
    { name: 'Luquin', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.089501, lng: 121.477001 }, hazards: [] },
    { name: 'Malabo-Kalantukan', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.20478, lng: 121.406815 }, hazards: [] },
    { name: 'Masikap', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.130622, lng: 121.434361 }, hazards: [] },
    { name: 'Maslun', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.131591, lng: 121.437049 }, hazards: [] },
    { name: 'Mojon', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.212973, lng: 121.397921 }, hazards: [] },
    { name: 'Novaliches', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.110515, lng: 121.458643 }, hazards: [] },
    { name: 'Oples', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.123181, lng: 121.436574 }, hazards: [] },
    { name: 'Pag-Asa', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.131182, lng: 121.435293 }, hazards: [] },
    { name: 'Palayan', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.142655, lng: 121.432613 }, hazards: [] },
    { name: 'San Isidro', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.196078, lng: 121.39232 }, hazards: [] },
    { name: 'Silangang Bukal', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.128208, lng: 121.452239 }, hazards: [] },
    { name: 'Tuy-Baanan', sub: 'Barangay, Liliw, Laguna', category: 'Barangay',
      latlng: { lat: 14.157784, lng: 121.439009 }, hazards: [] },
    { name: 'Anos', sub: 'Barangay, Los Baños, Laguna', category: 'Barangay',
      latlng: { lat: 14.173639, lng: 121.231819 }, hazards: [] },
    { name: 'Bagong Silang', sub: 'Barangay, Los Baños, Laguna', category: 'Barangay',
      latlng: { lat: 14.125093, lng: 121.227536 }, hazards: [] },
    { name: 'Bambang', sub: 'Barangay, Los Baños, Laguna', category: 'Barangay',
      latlng: { lat: 14.15286, lng: 121.205641 }, hazards: [] },
    { name: 'Batong Malake', sub: 'Barangay, Los Baños, Laguna', category: 'Barangay',
      latlng: { lat: 14.147736, lng: 121.22781 }, hazards: [] },
    { name: 'Baybayin', sub: 'Barangay, Los Baños, Laguna', category: 'Barangay',
      latlng: { lat: 14.181377, lng: 121.223778 }, hazards: [] },
    { name: 'Bayog', sub: 'Barangay, Los Baños, Laguna', category: 'Barangay',
      latlng: { lat: 14.188231, lng: 121.249354 }, hazards: [] },
    { name: 'Lalakay', sub: 'Barangay, Los Baños, Laguna', category: 'Barangay',
      latlng: { lat: 14.155834, lng: 121.194475 }, hazards: [] },
    { name: 'Maahas', sub: 'Barangay, Los Baños, Laguna', category: 'Barangay',
      latlng: { lat: 14.173082, lng: 121.25902 }, hazards: [] },
    { name: 'Mayondon', sub: 'Barangay, Los Baños, Laguna', category: 'Barangay',
      latlng: { lat: 14.188445, lng: 121.238479 }, hazards: [] },
    { name: 'Putho Tuntungin', sub: 'Barangay, Los Baños, Laguna', category: 'Barangay',
      latlng: { lat: 14.152299, lng: 121.252944 }, hazards: [] },
    { name: 'San Antonio', sub: 'Barangay, Los Baños, Laguna', category: 'Barangay',
      latlng: { lat: 14.172036, lng: 121.248706 }, hazards: [] },
    { name: 'Tadlak', sub: 'Barangay, Los Baños, Laguna', category: 'Barangay',
      latlng: { lat: 14.179756, lng: 121.2071 }, hazards: [] },
    { name: 'Timugan', sub: 'Barangay, Los Baños, Laguna', category: 'Barangay',
      latlng: { lat: 14.149451, lng: 121.212748 }, hazards: [] },
    { name: 'Malinta', sub: 'Barangay, Los Baños, Laguna', category: 'Barangay',
      latlng: { lat: 14.184127, lng: 121.231592 }, hazards: [] },
    { name: 'De La Paz', sub: 'Barangay, Luisiana, Laguna', category: 'Barangay',
      latlng: { lat: 14.185642, lng: 121.540245 }, hazards: [] },
    { name: 'Barangay Zone I', sub: 'Barangay, Luisiana, Laguna', category: 'Barangay',
      latlng: { lat: 14.184764, lng: 121.508919 }, hazards: [] },
    { name: 'Barangay Zone II', sub: 'Barangay, Luisiana, Laguna', category: 'Barangay',
      latlng: { lat: 14.184051, lng: 121.51036 }, hazards: [] },
    { name: 'Barangay Zone III', sub: 'Barangay, Luisiana, Laguna', category: 'Barangay',
      latlng: { lat: 14.184033, lng: 121.511261 }, hazards: [] },
    { name: 'Barangay Zone IV', sub: 'Barangay, Luisiana, Laguna', category: 'Barangay',
      latlng: { lat: 14.184187, lng: 121.513808 }, hazards: [] },
    { name: 'Barangay Zone V', sub: 'Barangay, Luisiana, Laguna', category: 'Barangay',
      latlng: { lat: 14.185581, lng: 121.513636 }, hazards: [] },
    { name: 'Barangay Zone VI', sub: 'Barangay, Luisiana, Laguna', category: 'Barangay',
      latlng: { lat: 14.185511, lng: 121.512108 }, hazards: [] },
    { name: 'Barangay Zone VII', sub: 'Barangay, Luisiana, Laguna', category: 'Barangay',
      latlng: { lat: 14.185452, lng: 121.511182 }, hazards: [] },
    { name: 'Barangay Zone VIII', sub: 'Barangay, Luisiana, Laguna', category: 'Barangay',
      latlng: { lat: 14.185318, lng: 121.510061 }, hazards: [] },
    { name: 'San Antonio', sub: 'Barangay, Luisiana, Laguna', category: 'Barangay',
      latlng: { lat: 14.19886, lng: 121.497704 }, hazards: [] },
    { name: 'San Buenaventura', sub: 'Barangay, Luisiana, Laguna', category: 'Barangay',
      latlng: { lat: 14.182159, lng: 121.573338 }, hazards: [] },
    { name: 'San Diego', sub: 'Barangay, Luisiana, Laguna', category: 'Barangay',
      latlng: { lat: 14.186896, lng: 121.486559 }, hazards: [] },
    { name: 'San Isidro', sub: 'Barangay, Luisiana, Laguna', category: 'Barangay',
      latlng: { lat: 14.178607, lng: 121.514748 }, hazards: [] },
    { name: 'San Jose', sub: 'Barangay, Luisiana, Laguna', category: 'Barangay',
      latlng: { lat: 14.203847, lng: 121.51015 }, hazards: [] },
    { name: 'San Juan', sub: 'Barangay, Luisiana, Laguna', category: 'Barangay',
      latlng: { lat: 14.203721, lng: 121.521086 }, hazards: [] },
    { name: 'San Luis', sub: 'Barangay, Luisiana, Laguna', category: 'Barangay',
      latlng: { lat: 14.170753, lng: 121.501749 }, hazards: [] },
    { name: 'San Pablo', sub: 'Barangay, Luisiana, Laguna', category: 'Barangay',
      latlng: { lat: 14.200415, lng: 121.53005 }, hazards: [] },
    { name: 'San Pedro', sub: 'Barangay, Luisiana, Laguna', category: 'Barangay',
      latlng: { lat: 14.172991, lng: 121.5301 }, hazards: [] },
    { name: 'San Rafael', sub: 'Barangay, Luisiana, Laguna', category: 'Barangay',
      latlng: { lat: 14.158196, lng: 121.520416 }, hazards: [] },
    { name: 'San Roque', sub: 'Barangay, Luisiana, Laguna', category: 'Barangay',
      latlng: { lat: 14.159744, lng: 121.507592 }, hazards: [] },
    { name: 'San Salvador', sub: 'Barangay, Luisiana, Laguna', category: 'Barangay',
      latlng: { lat: 14.211599, lng: 121.477459 }, hazards: [] },
    { name: 'Santo Domingo', sub: 'Barangay, Luisiana, Laguna', category: 'Barangay',
      latlng: { lat: 14.201844, lng: 121.542968 }, hazards: [] },
    { name: 'Santo Tomas', sub: 'Barangay, Luisiana, Laguna', category: 'Barangay',
      latlng: { lat: 14.187536, lng: 121.516985 }, hazards: [] },
    { name: 'Bagong Silang', sub: 'Barangay, Lumban, Laguna', category: 'Barangay',
      latlng: { lat: 14.296051, lng: 121.466143 }, hazards: [] },
    { name: 'Balimbingan', sub: 'Barangay, Lumban, Laguna', category: 'Barangay',
      latlng: { lat: 14.300092, lng: 121.460812 }, hazards: [] },
    { name: 'Balubad', sub: 'Barangay, Lumban, Laguna', category: 'Barangay',
      latlng: { lat: 14.277577, lng: 121.480827 }, hazards: [] },
    { name: 'Caliraya', sub: 'Barangay, Lumban, Laguna', category: 'Barangay',
      latlng: { lat: 14.294834, lng: 121.578341 }, hazards: [] },
    { name: 'Concepcion', sub: 'Barangay, Lumban, Laguna', category: 'Barangay',
      latlng: { lat: 14.299534, lng: 121.452356 }, hazards: [] },
    { name: 'Lewin', sub: 'Barangay, Lumban, Laguna', category: 'Barangay',
      latlng: { lat: 14.30495, lng: 121.496776 }, hazards: [] },
    { name: 'Maracta', sub: 'Barangay, Lumban, Laguna', category: 'Barangay',
      latlng: { lat: 14.298709, lng: 121.459419 }, hazards: [] },
    { name: 'Maytalang I', sub: 'Barangay, Lumban, Laguna', category: 'Barangay',
      latlng: { lat: 14.287812, lng: 121.45656 }, hazards: [] },
    { name: 'Maytalang II', sub: 'Barangay, Lumban, Laguna', category: 'Barangay',
      latlng: { lat: 14.290178, lng: 121.438122 }, hazards: [] },
    { name: 'Primera Parang', sub: 'Barangay, Lumban, Laguna', category: 'Barangay',
      latlng: { lat: 14.292511, lng: 121.460847 }, hazards: [] },
    { name: 'Primera Pulo', sub: 'Barangay, Lumban, Laguna', category: 'Barangay',
      latlng: { lat: 14.301438, lng: 121.461306 }, hazards: [] },
    { name: 'Salac', sub: 'Barangay, Lumban, Laguna', category: 'Barangay',
      latlng: { lat: 14.295358, lng: 121.460576 }, hazards: [] },
    { name: 'Segunda Parang', sub: 'Barangay, Lumban, Laguna', category: 'Barangay',
      latlng: { lat: 14.294115, lng: 121.460343 }, hazards: [] },
    { name: 'Segunda Pulo', sub: 'Barangay, Lumban, Laguna', category: 'Barangay',
      latlng: { lat: 14.303485, lng: 121.462167 }, hazards: [] },
    { name: 'Santo Niño', sub: 'Barangay, Lumban, Laguna', category: 'Barangay',
      latlng: { lat: 14.296985, lng: 121.459659 }, hazards: [] },
    { name: 'Wawa', sub: 'Barangay, Lumban, Laguna', category: 'Barangay',
      latlng: { lat: 14.321828, lng: 121.44773 }, hazards: [] },
    { name: 'Amuyong', sub: 'Barangay, Mabitac, Laguna', category: 'Barangay',
      latlng: { lat: 14.42934, lng: 121.377527 }, hazards: [] },
    { name: 'Lambac', sub: 'Barangay, Mabitac, Laguna', category: 'Barangay',
      latlng: { lat: 14.410488, lng: 121.43125 }, hazards: [] },
    { name: 'Lucong', sub: 'Barangay, Mabitac, Laguna', category: 'Barangay',
      latlng: { lat: 14.423968, lng: 121.43281 }, hazards: [] },
    { name: 'Matalatala', sub: 'Barangay, Mabitac, Laguna', category: 'Barangay',
      latlng: { lat: 14.413409, lng: 121.415714 }, hazards: [] },
    { name: 'Nanguma', sub: 'Barangay, Mabitac, Laguna', category: 'Barangay',
      latlng: { lat: 14.440777, lng: 121.42332 }, hazards: [] },
    { name: 'Numero', sub: 'Barangay, Mabitac, Laguna', category: 'Barangay',
      latlng: { lat: 14.415822, lng: 121.391697 }, hazards: [] },
    { name: 'Paagahan', sub: 'Barangay, Mabitac, Laguna', category: 'Barangay',
      latlng: { lat: 14.444274, lng: 121.4004 }, hazards: [] },
    { name: 'Bayanihan', sub: 'Barangay, Mabitac, Laguna', category: 'Barangay',
      latlng: { lat: 14.424813, lng: 121.428061 }, hazards: [] },
    { name: 'Libis ng Nayon', sub: 'Barangay, Mabitac, Laguna', category: 'Barangay',
      latlng: { lat: 14.43257, lng: 121.432641 }, hazards: [] },
    { name: 'Maligaya', sub: 'Barangay, Mabitac, Laguna', category: 'Barangay',
      latlng: { lat: 14.427013, lng: 121.432706 }, hazards: [] },
    { name: 'Masikap', sub: 'Barangay, Mabitac, Laguna', category: 'Barangay',
      latlng: { lat: 14.423144, lng: 121.430278 }, hazards: [] },
    { name: 'Pag-Asa', sub: 'Barangay, Mabitac, Laguna', category: 'Barangay',
      latlng: { lat: 14.42361, lng: 121.428352 }, hazards: [] },
    { name: 'Sinagtala', sub: 'Barangay, Mabitac, Laguna', category: 'Barangay',
      latlng: { lat: 14.431297, lng: 121.423934 }, hazards: [] },
    { name: 'San Antonio', sub: 'Barangay, Mabitac, Laguna', category: 'Barangay',
      latlng: { lat: 14.451088, lng: 121.420089 }, hazards: [] },
    { name: 'San Miguel', sub: 'Barangay, Mabitac, Laguna', category: 'Barangay',
      latlng: { lat: 14.450851, lng: 121.376437 }, hazards: [] },
    { name: 'Alipit', sub: 'Barangay, Magdalena, Laguna', category: 'Barangay',
      latlng: { lat: 14.221624, lng: 121.412879 }, hazards: [] },
    { name: 'Malaking Ambling', sub: 'Barangay, Magdalena, Laguna', category: 'Barangay',
      latlng: { lat: 14.191745, lng: 121.433016 }, hazards: [] },
    { name: 'Munting Ambling', sub: 'Barangay, Magdalena, Laguna', category: 'Barangay',
      latlng: { lat: 14.200438, lng: 121.436888 }, hazards: [] },
    { name: 'Baanan', sub: 'Barangay, Magdalena, Laguna', category: 'Barangay',
      latlng: { lat: 14.169282, lng: 121.433926 }, hazards: [] },
    { name: 'Balanac', sub: 'Barangay, Magdalena, Laguna', category: 'Barangay',
      latlng: { lat: 14.218376, lng: 121.454115 }, hazards: [] },
    { name: 'Bucal', sub: 'Barangay, Magdalena, Laguna', category: 'Barangay',
      latlng: { lat: 14.208328, lng: 121.439886 }, hazards: [] },
    { name: 'Buenavista', sub: 'Barangay, Magdalena, Laguna', category: 'Barangay',
      latlng: { lat: 14.222683, lng: 121.424501 }, hazards: [] },
    { name: 'Bungkol', sub: 'Barangay, Magdalena, Laguna', category: 'Barangay',
      latlng: { lat: 14.177486, lng: 121.430602 }, hazards: [] },
    { name: 'Buo', sub: 'Barangay, Magdalena, Laguna', category: 'Barangay',
      latlng: { lat: 14.203826, lng: 121.457424 }, hazards: [] },
    { name: 'Burlungan', sub: 'Barangay, Magdalena, Laguna', category: 'Barangay',
      latlng: { lat: 14.181909, lng: 121.435875 }, hazards: [] },
    { name: 'Cigaras', sub: 'Barangay, Magdalena, Laguna', category: 'Barangay',
      latlng: { lat: 14.225676, lng: 121.435025 }, hazards: [] },
    { name: 'Ibabang Atingay', sub: 'Barangay, Magdalena, Laguna', category: 'Barangay',
      latlng: { lat: 14.204983, lng: 121.446403 }, hazards: [] },
    { name: 'Ibabang Butnong', sub: 'Barangay, Magdalena, Laguna', category: 'Barangay',
      latlng: { lat: 14.208635, lng: 121.424418 }, hazards: [] },
    { name: 'Ilayang Atingay', sub: 'Barangay, Magdalena, Laguna', category: 'Barangay',
      latlng: { lat: 14.192176, lng: 121.444415 }, hazards: [] },
    { name: 'Ilayang Butnong', sub: 'Barangay, Magdalena, Laguna', category: 'Barangay',
      latlng: { lat: 14.200674, lng: 121.423441 }, hazards: [] },
    { name: 'Ilog', sub: 'Barangay, Magdalena, Laguna', category: 'Barangay',
      latlng: { lat: 14.217946, lng: 121.442196 }, hazards: [] },
    { name: 'Malinao', sub: 'Barangay, Magdalena, Laguna', category: 'Barangay',
      latlng: { lat: 14.203448, lng: 121.413877 }, hazards: [] },
    { name: 'Maravilla', sub: 'Barangay, Magdalena, Laguna', category: 'Barangay',
      latlng: { lat: 14.211205, lng: 121.414608 }, hazards: [] },
    { name: 'Poblacion', sub: 'Barangay, Magdalena, Laguna', category: 'Barangay',
      latlng: { lat: 14.200066, lng: 121.429136 }, hazards: [] },
    { name: 'Sabang', sub: 'Barangay, Magdalena, Laguna', category: 'Barangay',
      latlng: { lat: 14.230959, lng: 121.451004 }, hazards: [] },
    { name: 'Salasad', sub: 'Barangay, Magdalena, Laguna', category: 'Barangay',
      latlng: { lat: 14.211652, lng: 121.432525 }, hazards: [] },
    { name: 'Tanawan', sub: 'Barangay, Magdalena, Laguna', category: 'Barangay',
      latlng: { lat: 14.194358, lng: 121.456611 }, hazards: [] },
    { name: 'Tipunan', sub: 'Barangay, Magdalena, Laguna', category: 'Barangay',
      latlng: { lat: 14.193214, lng: 121.427338 }, hazards: [] },
    { name: 'Halayhayin', sub: 'Barangay, Magdalena, Laguna', category: 'Barangay',
      latlng: { lat: 14.191846, lng: 121.418074 }, hazards: [] },
    { name: 'Amonoy', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.104667, lng: 121.496258 }, hazards: [] },
    { name: 'Bakia', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.157723, lng: 121.489195 }, hazards: [] },
    { name: 'Bukal', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.113426, lng: 121.472997 }, hazards: [] },
    { name: 'Balanac', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.177063, lng: 121.456049 }, hazards: [] },
    { name: 'Balayong', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.12904, lng: 121.485772 }, hazards: [] },
    { name: 'Banilad', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.188619, lng: 121.464965 }, hazards: [] },
    { name: 'Banti', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.180473, lng: 121.464533 }, hazards: [] },
    { name: 'Bitaoy', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.137686, lng: 121.511878 }, hazards: [] },
    { name: 'Botocan', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.15365, lng: 121.50008 }, hazards: [] },
    { name: 'Burgos', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.126925, lng: 121.499956 }, hazards: [] },
    { name: 'Burol', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.169561, lng: 121.478699 }, hazards: [] },
    { name: 'Coralao', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.141041, lng: 121.461893 }, hazards: [] },
    { name: 'Gagalot', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.120005, lng: 121.509619 }, hazards: [] },
    { name: 'Ibabang Banga', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.152937, lng: 121.477426 }, hazards: [] },
    { name: 'Ibabang Bayucain', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.166461, lng: 121.443126 }, hazards: [] },
    { name: 'Ilayang Banga', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.145448, lng: 121.484416 }, hazards: [] },
    { name: 'Ilayang Bayucain', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.156609, lng: 121.446237 }, hazards: [] },
    { name: 'Isabang', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.146828, lng: 121.508771 }, hazards: [] },
    { name: 'Malinao', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.105074, lng: 121.48448 }, hazards: [] },
    { name: 'May-It', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.139033, lng: 121.487611 }, hazards: [] },
    { name: 'Munting Kawayan', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.158296, lng: 121.465192 }, hazards: [] },
    { name: 'Oobi', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.121558, lng: 121.484272 }, hazards: [] },
    { name: 'Olla', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.160154, lng: 121.454984 }, hazards: [] },
    { name: 'Origuel', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.14305, lng: 121.473282 }, hazards: [] },
    { name: 'Panalaban', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.124963, lng: 121.494006 }, hazards: [] },
    { name: 'Panglan', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.142071, lng: 121.452861 }, hazards: [] },
    { name: 'Pangil', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.133035, lng: 121.465527 }, hazards: [] },
    { name: 'Piit', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.142023, lng: 121.499914 }, hazards: [] },
    { name: 'Pook', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.171314, lng: 121.465056 }, hazards: [] },
    { name: 'Rizal', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.127069, lng: 121.514322 }, hazards: [] },
    { name: 'San Francisco', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.146393, lng: 121.47346 }, hazards: [] },
    { name: 'San Isidro', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.176288, lng: 121.441851 }, hazards: [] },
    { name: 'San Miguel', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.144018, lng: 121.469855 }, hazards: [] },
    { name: 'San Roque', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.125732, lng: 121.460965 }, hazards: [] },
    { name: 'Santa Catalina', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.150331, lng: 121.468432 }, hazards: [] },
    { name: 'Suba', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.170929, lng: 121.451796 }, hazards: [] },
    { name: 'Tanawan', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.184334, lng: 121.453958 }, hazards: [] },
    { name: 'Taytay', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.102293, lng: 121.503841 }, hazards: [] },
    { name: 'Talortor', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.149673, lng: 121.458709 }, hazards: [] },
    { name: 'Villa Nogales', sub: 'Barangay, Majayjay, Laguna', category: 'Barangay',
      latlng: { lat: 14.140652, lng: 121.470272 }, hazards: [] },
    { name: 'Abo', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.098868, lng: 121.435404 }, hazards: [] },
    { name: 'Alibungbungan', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.147232, lng: 121.416399 }, hazards: [] },
    { name: 'Alumbrado', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.1371, lng: 121.387538 }, hazards: [] },
    { name: 'Balayong', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.151685, lng: 121.388962 }, hazards: [] },
    { name: 'Balimbing', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.117412, lng: 121.432074 }, hazards: [] },
    { name: 'Balinacon', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.125195, lng: 121.42323 }, hazards: [] },
    { name: 'Bambang', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.128318, lng: 121.411412 }, hazards: [] },
    { name: 'Banago', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.113394, lng: 121.418009 }, hazards: [] },
    { name: 'Banca-banca', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.185206, lng: 121.3837 }, hazards: [] },
    { name: 'Bangcuro', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.172658, lng: 121.407884 }, hazards: [] },
    { name: 'Banilad', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.123479, lng: 121.403123 }, hazards: [] },
    { name: 'Bayaquitos', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.159723, lng: 121.392137 }, hazards: [] },
    { name: 'Buboy', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.120411, lng: 121.413856 }, hazards: [] },
    { name: 'Buenavista', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.170159, lng: 121.381679 }, hazards: [] },
    { name: 'Buhanginan', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.191008, lng: 121.393924 }, hazards: [] },
    { name: 'Bukal', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.075467, lng: 121.447655 }, hazards: [] },
    { name: 'Bunga', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.147957, lng: 121.399886 }, hazards: [] },
    { name: 'Cabuyew', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.163254, lng: 121.407044 }, hazards: [] },
    { name: 'Calumpang', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.195975, lng: 121.400248 }, hazards: [] },
    { name: 'Kanluran Kabubuhayan', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.185563, lng: 121.396995 }, hazards: [] },
    { name: 'Silangan Kabubuhayan', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.189812, lng: 121.403701 }, hazards: [] },
    { name: 'Labangan', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.169762, lng: 121.396633 }, hazards: [] },
    { name: 'Lawaguin', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.158806, lng: 121.371113 }, hazards: [] },
    { name: 'Kanluran Lazaan', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.079627, lng: 121.459148 }, hazards: [] },
    { name: 'Silangan Lazaan', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.09898, lng: 121.446498 }, hazards: [] },
    { name: 'Lagulo', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.177688, lng: 121.395916 }, hazards: [] },
    { name: 'Maiit', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.131761, lng: 121.393068 }, hazards: [] },
    { name: 'Malaya', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.111885, lng: 121.409173 }, hazards: [] },
    { name: 'Malinao', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.109238, lng: 121.438168 }, hazards: [] },
    { name: 'Manaol', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.18444, lng: 121.365804 }, hazards: [] },
    { name: 'Maravilla', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.177816, lng: 121.374627 }, hazards: [] },
    { name: 'Nagcalbang', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.180241, lng: 121.403728 }, hazards: [] },
    { name: 'Poblacion I', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.138253, lng: 121.41732 }, hazards: [] },
    { name: 'Poblacion II', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.135782, lng: 121.414724 }, hazards: [] },
    { name: 'Poblacion III', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.134874, lng: 121.418271 }, hazards: [] },
    { name: 'Oples', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.126324, lng: 121.427387 }, hazards: [] },
    { name: 'Palayan', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.13706, lng: 121.402105 }, hazards: [] },
    { name: 'Palina', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.14025, lng: 121.420786 }, hazards: [] },
    { name: 'Sabang', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.145943, lng: 121.388253 }, hazards: [] },
    { name: 'San Francisco', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.08581, lng: 121.432215 }, hazards: [] },
    { name: 'Sibulan', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.178188, lng: 121.386069 }, hazards: [] },
    { name: 'Silangan Napapatid', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.112268, lng: 121.426533 }, hazards: [] },
    { name: 'Silangan Ilaya', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.125847, lng: 121.419271 }, hazards: [] },
    { name: 'Sinipian', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.11687, lng: 121.428122 }, hazards: [] },
    { name: 'Santa Lucia', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.178023, lng: 121.410706 }, hazards: [] },
    { name: 'Sulsuguin', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.125875, lng: 121.373152 }, hazards: [] },
    { name: 'Talahib', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.137568, lng: 121.365795 }, hazards: [] },
    { name: 'Talangan', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.153406, lng: 121.413286 }, hazards: [] },
    { name: 'Taytay', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.108999, lng: 121.414759 }, hazards: [] },
    { name: 'Tipacan', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.153926, lng: 121.405701 }, hazards: [] },
    { name: 'Wakat', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.175653, lng: 121.358401 }, hazards: [] },
    { name: 'Yukos', sub: 'Barangay, Nagcarlan, Laguna', category: 'Barangay',
      latlng: { lat: 14.140013, lng: 121.409864 }, hazards: [] },
    { name: 'Bagumbayan', sub: 'Barangay, Paete, Laguna', category: 'Barangay',
      latlng: { lat: 14.36868, lng: 121.479289 }, hazards: [] },
    { name: 'Bangkusay', sub: 'Barangay, Paete, Laguna', category: 'Barangay',
      latlng: { lat: 14.364837, lng: 121.482785 }, hazards: [] },
    { name: 'Ermita', sub: 'Barangay, Paete, Laguna', category: 'Barangay',
      latlng: { lat: 14.363372, lng: 121.483499 }, hazards: [] },
    { name: 'Ibaba del Norte', sub: 'Barangay, Paete, Laguna', category: 'Barangay',
      latlng: { lat: 14.364705, lng: 121.477606 }, hazards: [] },
    { name: 'Ibaba del Sur', sub: 'Barangay, Paete, Laguna', category: 'Barangay',
      latlng: { lat: 14.362204, lng: 121.478192 }, hazards: [] },
    { name: 'Ilaya del Norte', sub: 'Barangay, Paete, Laguna', category: 'Barangay',
      latlng: { lat: 14.364916, lng: 121.484886 }, hazards: [] },
    { name: 'Ilaya del Sur', sub: 'Barangay, Paete, Laguna', category: 'Barangay',
      latlng: { lat: 14.363595, lng: 121.484778 }, hazards: [] },
    { name: 'Maytoong', sub: 'Barangay, Paete, Laguna', category: 'Barangay',
      latlng: { lat: 14.363071, lng: 121.482495 }, hazards: [] },
    { name: 'Quinale', sub: 'Barangay, Paete, Laguna', category: 'Barangay',
      latlng: { lat: 14.356664, lng: 121.482136 }, hazards: [] },
    { name: 'Anibong', sub: 'Barangay, Pagsanjan, Laguna', category: 'Barangay',
      latlng: { lat: 14.230887, lng: 121.46825 }, hazards: [] },
    { name: 'Biñan', sub: 'Barangay, Pagsanjan, Laguna', category: 'Barangay',
      latlng: { lat: 14.266885, lng: 121.434169 }, hazards: [] },
    { name: 'Buboy', sub: 'Barangay, Pagsanjan, Laguna', category: 'Barangay',
      latlng: { lat: 14.233631, lng: 121.4241 }, hazards: [] },
    { name: 'Cabanbanan', sub: 'Barangay, Pagsanjan, Laguna', category: 'Barangay',
      latlng: { lat: 14.243592, lng: 121.429066 }, hazards: [] },
    { name: 'Calusiche', sub: 'Barangay, Pagsanjan, Laguna', category: 'Barangay',
      latlng: { lat: 14.255564, lng: 121.445907 }, hazards: [] },
    { name: 'Dingin', sub: 'Barangay, Pagsanjan, Laguna', category: 'Barangay',
      latlng: { lat: 14.244081, lng: 121.449992 }, hazards: [] },
    { name: 'Lambac', sub: 'Barangay, Pagsanjan, Laguna', category: 'Barangay',
      latlng: { lat: 14.250512, lng: 121.463788 }, hazards: [] },
    { name: 'Layugan', sub: 'Barangay, Pagsanjan, Laguna', category: 'Barangay',
      latlng: { lat: 14.239686, lng: 121.439983 }, hazards: [] },
    { name: 'Magdapio', sub: 'Barangay, Pagsanjan, Laguna', category: 'Barangay',
      latlng: { lat: 14.271333, lng: 121.464132 }, hazards: [] },
    { name: 'Maulawin', sub: 'Barangay, Pagsanjan, Laguna', category: 'Barangay',
      latlng: { lat: 14.266041, lng: 121.451124 }, hazards: [] },
    { name: 'Pinagsanjan', sub: 'Barangay, Pagsanjan, Laguna', category: 'Barangay',
      latlng: { lat: 14.263445, lng: 121.462467 }, hazards: [] },
    { name: 'Barangay I', sub: 'Barangay, Pagsanjan, Laguna', category: 'Barangay',
      latlng: { lat: 14.274332, lng: 121.455936 }, hazards: [] },
    { name: 'Barangay II', sub: 'Barangay, Pagsanjan, Laguna', category: 'Barangay',
      latlng: { lat: 14.275181, lng: 121.450874 }, hazards: [] },
    { name: 'Sabang', sub: 'Barangay, Pagsanjan, Laguna', category: 'Barangay',
      latlng: { lat: 14.253891, lng: 121.433558 }, hazards: [] },
    { name: 'Sampaloc', sub: 'Barangay, Pagsanjan, Laguna', category: 'Barangay',
      latlng: { lat: 14.270559, lng: 121.444326 }, hazards: [] },
    { name: 'San Isidro', sub: 'Barangay, Pagsanjan, Laguna', category: 'Barangay',
      latlng: { lat: 14.279777, lng: 121.455201 }, hazards: [] },
    { name: 'Baño', sub: 'Barangay, Pakil, Laguna', category: 'Barangay',
      latlng: { lat: 14.378857, lng: 121.484584 }, hazards: [] },
    { name: 'Banilan', sub: 'Barangay, Pakil, Laguna', category: 'Barangay',
      latlng: { lat: 14.382104, lng: 121.396923 }, hazards: [] },
    { name: 'Burgos', sub: 'Barangay, Pakil, Laguna', category: 'Barangay',
      latlng: { lat: 14.375892, lng: 121.474831 }, hazards: [] },
    { name: 'Casa Real', sub: 'Barangay, Pakil, Laguna', category: 'Barangay',
      latlng: { lat: 14.366528, lng: 121.386634 }, hazards: [] },
    { name: 'Casinsin', sub: 'Barangay, Pakil, Laguna', category: 'Barangay',
      latlng: { lat: 14.352365, lng: 121.375729 }, hazards: [] },
    { name: 'Dorado', sub: 'Barangay, Pakil, Laguna', category: 'Barangay',
      latlng: { lat: 14.395312, lng: 121.37788 }, hazards: [] },
    { name: 'Gonzales', sub: 'Barangay, Pakil, Laguna', category: 'Barangay',
      latlng: { lat: 14.381697, lng: 121.472335 }, hazards: [] },
    { name: 'Kabulusan', sub: 'Barangay, Pakil, Laguna', category: 'Barangay',
      latlng: { lat: 14.373369, lng: 121.39499 }, hazards: [] },
    { name: 'Matikiw', sub: 'Barangay, Pakil, Laguna', category: 'Barangay',
      latlng: { lat: 14.359655, lng: 121.379931 }, hazards: [] },
    { name: 'Rizal', sub: 'Barangay, Pakil, Laguna', category: 'Barangay',
      latlng: { lat: 14.389035, lng: 121.496191 }, hazards: [] },
    { name: 'Saray', sub: 'Barangay, Pakil, Laguna', category: 'Barangay',
      latlng: { lat: 14.409383, lng: 121.525229 }, hazards: [] },
    { name: 'Taft', sub: 'Barangay, Pakil, Laguna', category: 'Barangay',
      latlng: { lat: 14.37618, lng: 121.481914 }, hazards: [] },
    { name: 'Tavera', sub: 'Barangay, Pakil, Laguna', category: 'Barangay',
      latlng: { lat: 14.386834, lng: 121.472548 }, hazards: [] },
    { name: 'Balian', sub: 'Barangay, Pangil, Laguna', category: 'Barangay',
      latlng: { lat: 14.402273, lng: 121.483495 }, hazards: [] },
    { name: 'Dambo', sub: 'Barangay, Pangil, Laguna', category: 'Barangay',
      latlng: { lat: 14.400627, lng: 121.402231 }, hazards: [] },
    { name: 'Galalan', sub: 'Barangay, Pangil, Laguna', category: 'Barangay',
      latlng: { lat: 14.438379, lng: 121.516357 }, hazards: [] },
    { name: 'Isla', sub: 'Barangay, Pangil, Laguna', category: 'Barangay',
      latlng: { lat: 14.396483, lng: 121.465225 }, hazards: [] },
    { name: 'Mabato-Azufre', sub: 'Barangay, Pangil, Laguna', category: 'Barangay',
      latlng: { lat: 14.387749, lng: 121.399208 }, hazards: [] },
    { name: 'Natividad', sub: 'Barangay, Pangil, Laguna', category: 'Barangay',
      latlng: { lat: 14.410229, lng: 121.475694 }, hazards: [] },
    { name: 'San Jose', sub: 'Barangay, Pangil, Laguna', category: 'Barangay',
      latlng: { lat: 14.3973, lng: 121.460002 }, hazards: [] },
    { name: 'Sulib', sub: 'Barangay, Pangil, Laguna', category: 'Barangay',
      latlng: { lat: 14.418789, lng: 121.471663 }, hazards: [] },
    { name: 'Aplaya', sub: 'Barangay, Pila, Laguna', category: 'Barangay',
      latlng: { lat: 14.257964, lng: 121.353891 }, hazards: [] },
    { name: 'Bagong Pook', sub: 'Barangay, Pila, Laguna', category: 'Barangay',
      latlng: { lat: 14.257745, lng: 121.366652 }, hazards: [] },
    { name: 'Bukal', sub: 'Barangay, Pila, Laguna', category: 'Barangay',
      latlng: { lat: 14.209109, lng: 121.365735 }, hazards: [] },
    { name: 'Bulilan Norte', sub: 'Barangay, Pila, Laguna', category: 'Barangay',
      latlng: { lat: 14.238464, lng: 121.365899 }, hazards: [] },
    { name: 'Bulilan Sur', sub: 'Barangay, Pila, Laguna', category: 'Barangay',
      latlng: { lat: 14.229986, lng: 121.368493 }, hazards: [] },
    { name: 'Concepcion', sub: 'Barangay, Pila, Laguna', category: 'Barangay',
      latlng: { lat: 14.232615, lng: 121.379107 }, hazards: [] },
    { name: 'Labuin', sub: 'Barangay, Pila, Laguna', category: 'Barangay',
      latlng: { lat: 14.244345, lng: 121.368501 }, hazards: [] },
    { name: 'Linga', sub: 'Barangay, Pila, Laguna', category: 'Barangay',
      latlng: { lat: 14.25551, lng: 121.360665 }, hazards: [] },
    { name: 'Masico', sub: 'Barangay, Pila, Laguna', category: 'Barangay',
      latlng: { lat: 14.206581, lng: 121.380326 }, hazards: [] },
    { name: 'Mojon', sub: 'Barangay, Pila, Laguna', category: 'Barangay',
      latlng: { lat: 14.219569, lng: 121.381983 }, hazards: [] },
    { name: 'Pansol', sub: 'Barangay, Pila, Laguna', category: 'Barangay',
      latlng: { lat: 14.217478, lng: 121.372682 }, hazards: [] },
    { name: 'Pinagbayanan', sub: 'Barangay, Pila, Laguna', category: 'Barangay',
      latlng: { lat: 14.249337, lng: 121.353073 }, hazards: [] },
    { name: 'San Antonio', sub: 'Barangay, Pila, Laguna', category: 'Barangay',
      latlng: { lat: 14.218019, lng: 121.358097 }, hazards: [] },
    { name: 'San Miguel', sub: 'Barangay, Pila, Laguna', category: 'Barangay',
      latlng: { lat: 14.200848, lng: 121.373616 }, hazards: [] },
    { name: 'Santa Clara Norte', sub: 'Barangay, Pila, Laguna', category: 'Barangay',
      latlng: { lat: 14.23424, lng: 121.35796 }, hazards: [] },
    { name: 'Santa Clara Sur', sub: 'Barangay, Pila, Laguna', category: 'Barangay',
      latlng: { lat: 14.228021, lng: 121.360241 }, hazards: [] },
    { name: 'Tubuan', sub: 'Barangay, Pila, Laguna', category: 'Barangay',
      latlng: { lat: 14.235606, lng: 121.34839 }, hazards: [] },
    { name: 'Antipolo', sub: 'Barangay, Rizal, Laguna', category: 'Barangay',
      latlng: { lat: 14.1153, lng: 121.378047 }, hazards: [] },
    { name: 'Entablado', sub: 'Barangay, Rizal, Laguna', category: 'Barangay',
      latlng: { lat: 14.122035, lng: 121.386401 }, hazards: [] },
    { name: 'Laguan', sub: 'Barangay, Rizal, Laguna', category: 'Barangay',
      latlng: { lat: 14.118045, lng: 121.399126 }, hazards: [] },
    { name: 'Paule 1', sub: 'Barangay, Rizal, Laguna', category: 'Barangay',
      latlng: { lat: 14.109442, lng: 121.397652 }, hazards: [] },
    { name: 'Paule 2', sub: 'Barangay, Rizal, Laguna', category: 'Barangay',
      latlng: { lat: 14.114295, lng: 121.392526 }, hazards: [] },
    { name: 'East Poblacion', sub: 'Barangay, Rizal, Laguna', category: 'Barangay',
      latlng: { lat: 14.109778, lng: 121.395079 }, hazards: [] },
    { name: 'West Poblacion', sub: 'Barangay, Rizal, Laguna', category: 'Barangay',
      latlng: { lat: 14.110359, lng: 121.392888 }, hazards: [] },
    { name: 'Pook', sub: 'Barangay, Rizal, Laguna', category: 'Barangay',
      latlng: { lat: 14.103824, lng: 121.411283 }, hazards: [] },
    { name: 'Tala', sub: 'Barangay, Rizal, Laguna', category: 'Barangay',
      latlng: { lat: 14.085094, lng: 121.409012 }, hazards: [] },
    { name: 'Talaga', sub: 'Barangay, Rizal, Laguna', category: 'Barangay',
      latlng: { lat: 14.111479, lng: 121.387728 }, hazards: [] },
    { name: 'Tuy', sub: 'Barangay, Rizal, Laguna', category: 'Barangay',
      latlng: { lat: 14.106278, lng: 121.401878 }, hazards: [] },
    { name: 'Bagong Bayan II-A', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.066616, lng: 121.317562 }, hazards: [] },
    { name: 'Bagong Pook VI-C', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.074885, lng: 121.320606 }, hazards: [] },
    { name: 'Barangay I-A', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.073107, lng: 121.316647 }, hazards: [] },
    { name: 'Barangay I-B', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.069381, lng: 121.31589 }, hazards: [] },
    { name: 'Barangay II-A', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.063099, lng: 121.319434 }, hazards: [] },
    { name: 'Barangay II-B', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.06333, lng: 121.321532 }, hazards: [] },
    { name: 'Barangay II-C', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.065908, lng: 121.322625 }, hazards: [] },
    { name: 'Barangay II-D', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.067432, lng: 121.323201 }, hazards: [] },
    { name: 'Barangay II-E', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.06509, lng: 121.325206 }, hazards: [] },
    { name: 'Barangay II-F', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.061182, lng: 121.322875 }, hazards: [] },
    { name: 'Barangay III-A', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.067084, lng: 121.326748 }, hazards: [] },
    { name: 'Barangay III-B', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.069554, lng: 121.327653 }, hazards: [] },
    { name: 'Barangay III-C', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.06745, lng: 121.329599 }, hazards: [] },
    { name: 'Barangay III-D', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.070384, lng: 121.330853 }, hazards: [] },
    { name: 'Barangay III-E', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.071016, lng: 121.333504 }, hazards: [] },
    { name: 'Barangay III-F', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.068383, lng: 121.328403 }, hazards: [] },
    { name: 'Barangay IV-A', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.072544, lng: 121.330992 }, hazards: [] },
    { name: 'Barangay IV-B', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.071962, lng: 121.327496 }, hazards: [] },
    { name: 'Barangay IV-C', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.072111, lng: 121.326363 }, hazards: [] },
    { name: 'Barangay V-A', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.076753, lng: 121.324647 }, hazards: [] },
    { name: 'Barangay V-B', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.072694, lng: 121.324519 }, hazards: [] },
    { name: 'Barangay V-C', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.072429, lng: 121.325067 }, hazards: [] },
    { name: 'Barangay V-D', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.072301, lng: 121.325575 }, hazards: [] },
    { name: 'Barangay VI-A', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.073295, lng: 121.322929 }, hazards: [] },
    { name: 'Barangay VI-B', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.07772, lng: 121.323135 }, hazards: [] },
    { name: 'Barangay VI-D', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.077845, lng: 121.320668 }, hazards: [] },
    { name: 'Barangay VI-E', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.074785, lng: 121.317906 }, hazards: [] },
    { name: 'Barangay VII-A', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.070356, lng: 121.321849 }, hazards: [] },
    { name: 'Barangay VII-B', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.069584, lng: 121.32368 }, hazards: [] },
    { name: 'Barangay VII-C', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.06925, lng: 121.325041 }, hazards: [] },
    { name: 'Barangay VII-D', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.068772, lng: 121.325643 }, hazards: [] },
    { name: 'Barangay VII-E', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.068044, lng: 121.324068 }, hazards: [] },
    { name: 'Bautista', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 13.988888, lng: 121.271493 }, hazards: [] },
    { name: 'Concepcion', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.080894, lng: 121.341765 }, hazards: [] },
    { name: 'Del Remedio', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.083482, lng: 121.311658 }, hazards: [] },
    { name: 'Dolores', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.10446, lng: 121.336591 }, hazards: [] },
    { name: 'San Antonio 1', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.008621, lng: 121.338289 }, hazards: [] },
    { name: 'San Antonio 2', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 13.996083, lng: 121.328985 }, hazards: [] },
    { name: 'San Bartolome', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.024542, lng: 121.289051 }, hazards: [] },
    { name: 'San Buenaventura', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.116271, lng: 121.329571 }, hazards: [] },
    { name: 'San Crispin', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.077876, lng: 121.283295 }, hazards: [] },
    { name: 'San Cristobal', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.045313, lng: 121.399091 }, hazards: [] },
    { name: 'San Diego', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.087876, lng: 121.373562 }, hazards: [] },
    { name: 'San Francisco', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.056005, lng: 121.33069 }, hazards: [] },
    { name: 'San Gabriel', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.055422, lng: 121.313236 }, hazards: [] },
    { name: 'San Gregorio', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.044423, lng: 121.327619 }, hazards: [] },
    { name: 'San Ignacio', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.049679, lng: 121.345792 }, hazards: [] },
    { name: 'San Isidro', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 13.982391, lng: 121.305953 }, hazards: [] },
    { name: 'San Joaquin', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.028332, lng: 121.328001 }, hazards: [] },
    { name: 'San Jose', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.067408, lng: 121.367452 }, hazards: [] },
    { name: 'San Juan', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.094947, lng: 121.296079 }, hazards: [] },
    { name: 'San Lorenzo', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.113344, lng: 121.353231 }, hazards: [] },
    { name: 'San Lucas 1', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.083284, lng: 121.326526 }, hazards: [] },
    { name: 'San Lucas 2', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.089432, lng: 121.325883 }, hazards: [] },
    { name: 'San Marcos', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.103198, lng: 121.304368 }, hazards: [] },
    { name: 'San Mateo', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.109384, lng: 121.30445 }, hazards: [] },
    { name: 'San Miguel', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.0345, lng: 121.301493 }, hazards: [] },
    { name: 'San Nicolas', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.065436, lng: 121.291058 }, hazards: [] },
    { name: 'San Pedro', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.095518, lng: 121.331456 }, hazards: [] },
    { name: 'San Rafael', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.072471, lng: 121.301474 }, hazards: [] },
    { name: 'San Roque', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.069531, lng: 121.311674 }, hazards: [] },
    { name: 'San Vicente', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.0245, lng: 121.340164 }, hazards: [] },
    { name: 'Santa Ana', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.013987, lng: 121.326132 }, hazards: [] },
    { name: 'Santa Catalina', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.126449, lng: 121.347433 }, hazards: [] },
    { name: 'Santa Cruz', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.023959, lng: 121.352575 }, hazards: [] },
    { name: 'Santa Felomina', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.089468, lng: 121.285087 }, hazards: [] },
    { name: 'Santa Isabel', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.081957, lng: 121.366702 }, hazards: [] },
    { name: 'Santa Maria Magdalena', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.096726, lng: 121.31228 }, hazards: [] },
    { name: 'Santa Veronica', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.043959, lng: 121.287522 }, hazards: [] },
    { name: 'Santiago I', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.019498, lng: 121.282057 }, hazards: [] },
    { name: 'Santiago II', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.00188, lng: 121.265282 }, hazards: [] },
    { name: 'Santisimo Rosario', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 13.998517, lng: 121.305846 }, hazards: [] },
    { name: 'Santo Angel', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.10284, lng: 121.36756 }, hazards: [] },
    { name: 'Santo Cristo', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.064504, lng: 121.330512 }, hazards: [] },
    { name: 'Santo Niño', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.048832, lng: 121.362339 }, hazards: [] },
    { name: 'Soledad', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.040466, lng: 121.316821 }, hazards: [] },
    { name: 'Atisan', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 13.977747, lng: 121.277804 }, hazards: [] },
    { name: 'Santa Elena', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.044759, lng: 121.375578 }, hazards: [] },
    { name: 'Santa Maria', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.022704, lng: 121.311854 }, hazards: [] },
    { name: 'Santa Monica', sub: 'Barangay, San Pablo City, Laguna', category: 'Barangay',
      latlng: { lat: 14.055275, lng: 121.300331 }, hazards: [] },
    { name: 'Bagong Silang', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.335365, lng: 121.025275 }, hazards: [] },
    { name: 'Cuyab', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.37254, lng: 121.058576 }, hazards: [] },
    { name: 'Estrella', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.33464, lng: 121.019791 }, hazards: [] },
    { name: 'G.S.I.S.', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.350257, lng: 121.038761 }, hazards: [] },
    { name: 'Landayan', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.355449, lng: 121.06858 }, hazards: [] },
    { name: 'Langgam', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.326886, lng: 121.014598 }, hazards: [] },
    { name: 'Laram', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.329344, lng: 121.022947 }, hazards: [] },
    { name: 'Magsaysay', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.337802, lng: 121.033541 }, hazards: [] },
    { name: 'Nueva', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.355093, lng: 121.060216 }, hazards: [] },
    { name: 'Poblacion', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.363738, lng: 121.059286 }, hazards: [] },
    { name: 'Riverside', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.332836, lng: 121.027591 }, hazards: [] },
    { name: 'San Antonio', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.353449, lng: 121.030685 }, hazards: [] },
    { name: 'San Roque', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.365445, lng: 121.063662 }, hazards: [] },
    { name: 'San Vicente', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.345876, lng: 121.033988 }, hazards: [] },
    { name: 'Santo Niño', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.367249, lng: 121.057909 }, hazards: [] },
    { name: 'United Bayanihan', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.335388, lng: 121.029813 }, hazards: [] },
    { name: 'United Better Living', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.337992, lng: 121.022547 }, hazards: [] },
    { name: 'Sampaguita Village', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.344424, lng: 121.034516 }, hazards: [] },
    { name: 'Calendola', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.341214, lng: 121.034037 }, hazards: [] },
    { name: 'Narra', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.330941, lng: 121.025588 }, hazards: [] },
    { name: 'Chrysanthemum', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.341115, lng: 121.045094 }, hazards: [] },
    { name: 'Fatima', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.355443, lng: 121.05514 }, hazards: [] },
    { name: 'Maharlika', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.347898, lng: 121.044949 }, hazards: [] },
    { name: 'Pacita 1', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.34363, lng: 121.056908 }, hazards: [] },
    { name: 'Pacita 2', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.349544, lng: 121.053219 }, hazards: [] },
    { name: 'Rosario', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.336149, lng: 121.043597 }, hazards: [] },
    { name: 'San Lorenzo Ruiz', sub: 'Barangay, San Pedro City, Laguna', category: 'Barangay',
      latlng: { lat: 14.352156, lng: 121.052025 }, hazards: [] },
    { name: 'Alipit', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.230782, lng: 121.41051 }, hazards: [] },
    { name: 'Bagumbayan', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.272561, lng: 121.39379 }, hazards: [] },
    { name: 'Bubukal', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.260549, lng: 121.403548 }, hazards: [] },
    { name: 'Calios', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.279072, lng: 121.404089 }, hazards: [] },
    { name: 'Duhat', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.256203, lng: 121.376395 }, hazards: [] },
    { name: 'Gatid', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.265019, lng: 121.383541 }, hazards: [] },
    { name: 'Jasaan', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.223624, lng: 121.392128 }, hazards: [] },
    { name: 'Labuin', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.246117, lng: 121.394137 }, hazards: [] },
    { name: 'Malinao', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.233323, lng: 121.393471 }, hazards: [] },
    { name: 'Oogong', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.225698, lng: 121.401624 }, hazards: [] },
    { name: 'Pagsawitan', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.271367, lng: 121.424332 }, hazards: [] },
    { name: 'Palasan', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.251838, lng: 121.418912 }, hazards: [] },
    { name: 'Patimbao', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.267358, lng: 121.414891 }, hazards: [] },
    { name: 'Barangay I', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.276956, lng: 121.417885 }, hazards: [] },
    { name: 'Barangay II', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.279804, lng: 121.416192 }, hazards: [] },
    { name: 'Barangay III', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.282097, lng: 121.415277 }, hazards: [] },
    { name: 'Barangay IV', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.283826, lng: 121.414554 }, hazards: [] },
    { name: 'Barangay V', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.28546, lng: 121.412829 }, hazards: [] },
    { name: 'San Jose', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.237885, lng: 121.408836 }, hazards: [] },
    { name: 'San Juan', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.248622, lng: 121.408574 }, hazards: [] },
    { name: 'San Pablo Norte', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.288951, lng: 121.41902 }, hazards: [] },
    { name: 'San Pablo Sur', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.283394, lng: 121.424615 }, hazards: [] },
    { name: 'Santisima Cruz', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.295465, lng: 121.410367 }, hazards: [] },
    { name: 'Santo Angel Central', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.285175, lng: 121.407534 }, hazards: [] },
    { name: 'Santo Angel Norte', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.293403, lng: 121.403404 }, hazards: [] },
    { name: 'Santo Angel Sur', sub: 'Barangay, Santa Cruz, Laguna', category: 'Barangay',
      latlng: { lat: 14.28041, lng: 121.412187 }, hazards: [] },
    { name: 'Adia', sub: 'Barangay, Santa Maria, Laguna', category: 'Barangay',
      latlng: { lat: 14.484325, lng: 121.434795 }, hazards: [] },
    { name: 'Bagong Pook', sub: 'Barangay, Santa Maria, Laguna', category: 'Barangay',
      latlng: { lat: 14.472251, lng: 121.429085 }, hazards: [] },
    { name: 'Bagumbayan', sub: 'Barangay, Santa Maria, Laguna', category: 'Barangay',
      latlng: { lat: 14.511023, lng: 121.434948 }, hazards: [] },
    { name: 'Bubukal', sub: 'Barangay, Santa Maria, Laguna', category: 'Barangay',
      latlng: { lat: 14.47925, lng: 121.411494 }, hazards: [] },
    { name: 'Cabooan', sub: 'Barangay, Santa Maria, Laguna', category: 'Barangay',
      latlng: { lat: 14.459952, lng: 121.434087 }, hazards: [] },
    { name: 'Calangay', sub: 'Barangay, Santa Maria, Laguna', category: 'Barangay',
      latlng: { lat: 14.508, lng: 121.394585 }, hazards: [] },
    { name: 'Cambuja', sub: 'Barangay, Santa Maria, Laguna', category: 'Barangay',
      latlng: { lat: 14.472575, lng: 121.391408 }, hazards: [] },
    { name: 'Coralan', sub: 'Barangay, Santa Maria, Laguna', category: 'Barangay',
      latlng: { lat: 14.494744, lng: 121.422494 }, hazards: [] },
    { name: 'Cueva', sub: 'Barangay, Santa Maria, Laguna', category: 'Barangay',
      latlng: { lat: 14.517983, lng: 121.459901 }, hazards: [] },
    { name: 'Inayapan', sub: 'Barangay, Santa Maria, Laguna', category: 'Barangay',
      latlng: { lat: 14.491851, lng: 121.414603 }, hazards: [] },
    { name: 'Jose Laurel, Sr.', sub: 'Barangay, Santa Maria, Laguna', category: 'Barangay',
      latlng: { lat: 14.541334, lng: 121.459955 }, hazards: [] },
    { name: 'Kayhakat', sub: 'Barangay, Santa Maria, Laguna', category: 'Barangay',
      latlng: { lat: 14.463769, lng: 121.417016 }, hazards: [] },
    { name: 'Macasipac', sub: 'Barangay, Santa Maria, Laguna', category: 'Barangay',
      latlng: { lat: 14.499649, lng: 121.439076 }, hazards: [] },
    { name: 'Masinao', sub: 'Barangay, Santa Maria, Laguna', category: 'Barangay',
      latlng: { lat: 14.494194, lng: 121.430727 }, hazards: [] },
    { name: 'Mataling-Ting', sub: 'Barangay, Santa Maria, Laguna', category: 'Barangay',
      latlng: { lat: 14.531968, lng: 121.396172 }, hazards: [] },
    { name: 'Pao-o', sub: 'Barangay, Santa Maria, Laguna', category: 'Barangay',
      latlng: { lat: 14.529933, lng: 121.417425 }, hazards: [] },
    { name: 'Parang Ng Buho', sub: 'Barangay, Santa Maria, Laguna', category: 'Barangay',
      latlng: { lat: 14.530729, lng: 121.434853 }, hazards: [] },
    { name: 'Barangay I', sub: 'Barangay, Santa Maria, Laguna', category: 'Barangay',
      latlng: { lat: 14.470054, lng: 121.421999 }, hazards: [] },
    { name: 'Barangay II', sub: 'Barangay, Santa Maria, Laguna', category: 'Barangay',
      latlng: { lat: 14.469408, lng: 121.423287 }, hazards: [] },
    { name: 'Barangay III', sub: 'Barangay, Santa Maria, Laguna', category: 'Barangay',
      latlng: { lat: 14.471382, lng: 121.425689 }, hazards: [] },
    { name: 'Barangay IV', sub: 'Barangay, Santa Maria, Laguna', category: 'Barangay',
      latlng: { lat: 14.469411, lng: 121.425717 }, hazards: [] },
    { name: 'Jose Rizal', sub: 'Barangay, Santa Maria, Laguna', category: 'Barangay',
      latlng: { lat: 14.463584, lng: 121.423258 }, hazards: [] },
    { name: 'Santiago', sub: 'Barangay, Santa Maria, Laguna', category: 'Barangay',
      latlng: { lat: 14.568506, lng: 121.456884 }, hazards: [] },
    { name: 'Talangka', sub: 'Barangay, Santa Maria, Laguna', category: 'Barangay',
      latlng: { lat: 14.478484, lng: 121.446925 }, hazards: [] },
    { name: 'Tungkod', sub: 'Barangay, Santa Maria, Laguna', category: 'Barangay',
      latlng: { lat: 14.488576, lng: 121.383884 }, hazards: [] },
    { name: 'Aplaya', sub: 'Barangay, Santa Rosa City, Laguna', category: 'Barangay',
      latlng: { lat: 14.316863, lng: 121.121578 }, hazards: [] },
    { name: 'Balibago', sub: 'Barangay, Santa Rosa City, Laguna', category: 'Barangay',
      latlng: { lat: 14.28792, lng: 121.09907 }, hazards: [] },
    { name: 'Caingin', sub: 'Barangay, Santa Rosa City, Laguna', category: 'Barangay',
      latlng: { lat: 14.302154, lng: 121.125144 }, hazards: [] },
    { name: 'Dila', sub: 'Barangay, Santa Rosa City, Laguna', category: 'Barangay',
      latlng: { lat: 14.291245, lng: 121.114761 }, hazards: [] },
    { name: 'Dita', sub: 'Barangay, Santa Rosa City, Laguna', category: 'Barangay',
      latlng: { lat: 14.280187, lng: 121.11038 }, hazards: [] },
    { name: 'Don Jose', sub: 'Barangay, Santa Rosa City, Laguna', category: 'Barangay',
      latlng: { lat: 14.250889, lng: 121.079116 }, hazards: [] },
    { name: 'Ibaba', sub: 'Barangay, Santa Rosa City, Laguna', category: 'Barangay',
      latlng: { lat: 14.313516, lng: 121.118206 }, hazards: [] },
    { name: 'Labas', sub: 'Barangay, Santa Rosa City, Laguna', category: 'Barangay',
      latlng: { lat: 14.307163, lng: 121.109701 }, hazards: [] },
    { name: 'Macabling', sub: 'Barangay, Santa Rosa City, Laguna', category: 'Barangay',
      latlng: { lat: 14.299619, lng: 121.096047 }, hazards: [] },
    { name: 'Malitlit', sub: 'Barangay, Santa Rosa City, Laguna', category: 'Barangay',
      latlng: { lat: 14.261892, lng: 121.104998 }, hazards: [] },
    { name: 'Malusak', sub: 'Barangay, Santa Rosa City, Laguna', category: 'Barangay',
      latlng: { lat: 14.310901, lng: 121.11647 }, hazards: [] },
    { name: 'Market Area', sub: 'Barangay, Santa Rosa City, Laguna', category: 'Barangay',
      latlng: { lat: 14.319706, lng: 121.114407 }, hazards: [] },
    { name: 'Kanluran', sub: 'Barangay, Santa Rosa City, Laguna', category: 'Barangay',
      latlng: { lat: 14.312208, lng: 121.110065 }, hazards: [] },
    { name: 'Pooc', sub: 'Barangay, Santa Rosa City, Laguna', category: 'Barangay',
      latlng: { lat: 14.301511, lng: 121.115623 }, hazards: [] },
    { name: 'Pulong Santa Cruz', sub: 'Barangay, Santa Rosa City, Laguna', category: 'Barangay',
      latlng: { lat: 14.274131, lng: 121.084169 }, hazards: [] },
    { name: 'Santo Domingo', sub: 'Barangay, Santa Rosa City, Laguna', category: 'Barangay',
      latlng: { lat: 14.229528, lng: 121.062907 }, hazards: [] },
    { name: 'Sinalhan', sub: 'Barangay, Santa Rosa City, Laguna', category: 'Barangay',
      latlng: { lat: 14.330088, lng: 121.105755 }, hazards: [] },
    { name: 'Tagapo', sub: 'Barangay, Santa Rosa City, Laguna', category: 'Barangay',
      latlng: { lat: 14.316894, lng: 121.099829 }, hazards: [] },
    { name: 'Acevida', sub: 'Barangay, Siniloan, Laguna', category: 'Barangay',
      latlng: { lat: 14.414444, lng: 121.450518 }, hazards: [] },
    { name: 'Bagong Pag-Asa', sub: 'Barangay, Siniloan, Laguna', category: 'Barangay',
      latlng: { lat: 14.418909, lng: 121.445517 }, hazards: [] },
    { name: 'Bagumbarangay', sub: 'Barangay, Siniloan, Laguna', category: 'Barangay',
      latlng: { lat: 14.421636, lng: 121.446127 }, hazards: [] },
    { name: 'Buhay', sub: 'Barangay, Siniloan, Laguna', category: 'Barangay',
      latlng: { lat: 14.43019, lng: 121.44903 }, hazards: [] },
    { name: 'Gen. Luna', sub: 'Barangay, Siniloan, Laguna', category: 'Barangay',
      latlng: { lat: 14.418903, lng: 121.445039 }, hazards: [] },
    { name: 'Halayhayin', sub: 'Barangay, Siniloan, Laguna', category: 'Barangay',
      latlng: { lat: 14.419675, lng: 121.45321 }, hazards: [] },
    { name: 'Mendiola', sub: 'Barangay, Siniloan, Laguna', category: 'Barangay',
      latlng: { lat: 14.425771, lng: 121.456859 }, hazards: [] },
    { name: 'Kapatalan', sub: 'Barangay, Siniloan, Laguna', category: 'Barangay',
      latlng: { lat: 14.469484, lng: 121.510362 }, hazards: [] },
    { name: 'Laguio', sub: 'Barangay, Siniloan, Laguna', category: 'Barangay',
      latlng: { lat: 14.461141, lng: 121.483615 }, hazards: [] },
    { name: 'Liyang', sub: 'Barangay, Siniloan, Laguna', category: 'Barangay',
      latlng: { lat: 14.463684, lng: 121.493368 }, hazards: [] },
    { name: 'Llavac', sub: 'Barangay, Siniloan, Laguna', category: 'Barangay',
      latlng: { lat: 14.511599, lng: 121.525887 }, hazards: [] },
    { name: 'Pandeno', sub: 'Barangay, Siniloan, Laguna', category: 'Barangay',
      latlng: { lat: 14.420587, lng: 121.440694 }, hazards: [] },
    { name: 'Magsaysay', sub: 'Barangay, Siniloan, Laguna', category: 'Barangay',
      latlng: { lat: 14.505885, lng: 121.507882 }, hazards: [] },
    { name: 'Macatad', sub: 'Barangay, Siniloan, Laguna', category: 'Barangay',
      latlng: { lat: 14.439967, lng: 121.463682 }, hazards: [] },
    { name: 'Mayatba', sub: 'Barangay, Siniloan, Laguna', category: 'Barangay',
      latlng: { lat: 14.450428, lng: 121.476333 }, hazards: [] },
    { name: 'P. Burgos', sub: 'Barangay, Siniloan, Laguna', category: 'Barangay',
      latlng: { lat: 14.426415, lng: 121.442589 }, hazards: [] },
    { name: 'G. Redor', sub: 'Barangay, Siniloan, Laguna', category: 'Barangay',
      latlng: { lat: 14.423101, lng: 121.444556 }, hazards: [] },
    { name: 'Salubungan', sub: 'Barangay, Siniloan, Laguna', category: 'Barangay',
      latlng: { lat: 14.421776, lng: 121.447562 }, hazards: [] },
    { name: 'Wawa', sub: 'Barangay, Siniloan, Laguna', category: 'Barangay',
      latlng: { lat: 14.406398, lng: 121.444765 }, hazards: [] },
    { name: 'J. Rizal', sub: 'Barangay, Siniloan, Laguna', category: 'Barangay',
      latlng: { lat: 14.419084, lng: 121.445959 }, hazards: [] },
    { name: 'Banca-banca', sub: 'Barangay, Victoria, Laguna', category: 'Barangay',
      latlng: { lat: 14.205348, lng: 121.347218 }, hazards: [] },
    { name: 'Daniw', sub: 'Barangay, Victoria, Laguna', category: 'Barangay',
      latlng: { lat: 14.198311, lng: 121.360222 }, hazards: [] },
    { name: 'Masapang', sub: 'Barangay, Victoria, Laguna', category: 'Barangay',
      latlng: { lat: 14.191154, lng: 121.343898 }, hazards: [] },
    { name: 'Nanhaya', sub: 'Barangay, Victoria, Laguna', category: 'Barangay',
      latlng: { lat: 14.227353, lng: 121.332236 }, hazards: [] },
    { name: 'Pagalangan', sub: 'Barangay, Victoria, Laguna', category: 'Barangay',
      latlng: { lat: 14.230058, lng: 121.338481 }, hazards: [] },
    { name: 'San Benito', sub: 'Barangay, Victoria, Laguna', category: 'Barangay',
      latlng: { lat: 14.194133, lng: 121.316635 }, hazards: [] },
    { name: 'San Felix', sub: 'Barangay, Victoria, Laguna', category: 'Barangay',
      latlng: { lat: 14.209208, lng: 121.322776 }, hazards: [] },
    { name: 'San Francisco', sub: 'Barangay, Victoria, Laguna', category: 'Barangay',
      latlng: { lat: 14.213915, lng: 121.342042 }, hazards: [] },
    { name: 'San Roque', sub: 'Barangay, Victoria, Laguna', category: 'Barangay',
      latlng: { lat: 14.22284, lng: 121.326195 }, hazards: [] }
  ];

  // lagunaDestinations above is the offline-shipped fallback — always
  // available with zero network, but frozen at whatever was last built
  // into the app. livePois is what the rest of the app actually reads
  // (search, map markers, routing lookups): it starts out as a copy of
  // the fallback, then loadLivePois() below replaces it with the real,
  // admin-managed public.pois table once that's reachable, and caches
  // the result so a later offline session still shows the last-synced
  // (possibly admin-edited) set rather than reverting to the fallback.
  let livePois = lagunaDestinations;

  // Merges an externally-sourced POI list (Supabase table rows, or a
  // previously-cached copy of same) with the bundled baseline
  // (lagunaDestinations — provinces, cities, municipalities, all 681
  // Laguna barangays, and every landmark/amenity entry) instead of
  // replacing it outright. Before this fix, loadLivePois() below fully
  // REPLACED livePois with whatever was in the admin-managed public.pois
  // Supabase table — meaning the entire province/city/municipality/
  // barangay dataset would silently vanish the instant the app went
  // online with Supabase configured, since that table only ever holds
  // whatever an admin manually added there, not this bundled set. Admin
  // rows win on a (name, category) collision (an admin edit should be
  // able to override a bundled entry); everything else from both lists
  // is kept.
  function mergeWithBaseline(externalPois){
    const seenKey = new Set(externalPois.map(d => `${d.name}|${d.category}`));
    return [...externalPois, ...lagunaDestinations.filter(d => !seenKey.has(`${d.name}|${d.category}`))];
  }

  async function loadLivePois(){
    const cached = BiyaStorage.load(BiyaStorage.keys.poisCache, null);
    if (cached && cached.length) {
      livePois = mergeWithBaseline(cached);
      recomputePoiEntries();
    }
    if (!supabaseClient || !navigator.onLine) return;

    const { data, error } = await supabaseClient
      .from('pois')
      .select('id, name, sub, category, lat, lng')
      .order('name');

    if (error || !data) {
      // Not fatal — whatever's already in livePois (cache, or the
      // bundled fallback if there was no cache yet) keeps working.
      console.warn('Could not load live POIs, using cached/bundled set:', error && error.message);
      return;
    }

    const adminPois = data.map(row => ({
      id: row.id,
      name: row.name,
      sub: row.sub || '',
      category: row.category,
      latlng: { lat: row.lat, lng: row.lng },
      hazards: []
    }));
    livePois = mergeWithBaseline(adminPois);
    // Cache only the admin-sourced rows, not the merged result — caching
    // the merge would balloon BiyaStorage with 876 duplicated bundled
    // entries every sync, and mergeWithBaseline() already re-applies the
    // bundled set on top of whatever's cached, on every load.
    BiyaStorage.save(BiyaStorage.keys.poisCache, adminPois);
    recomputePoiEntries();
  }

  // ---------- LANDMARK / POI ICON MARKERS ----------
  // Plots lagunaDestinations on the map itself (previously they only
  // powered search + routing) as small, clean, category-specific icon
  // badges — hospital, church, school, police, fire station, gas station,
  // government office, terminal, mall, plus the general city/landmark
  // categories already in the list above. "Road"/"Highway" entries are
  // deliberately excluded here: those are routing waypoints, not places
  // someone would look for on the map, and plotting them would just add
  // clutter.
  const POI_ICON_SVG = {
    Hospital: '<rect x="10" y="4" width="4" height="16" rx="1"/><rect x="4" y="10" width="16" height="4" rx="1"/>',
    Church: '<path d="M12 2v9M9 6h6"/><path d="M7 22V13l5-3 5 3v9z"/><path d="M9.5 22v-5a2.5 2.5 0 0 1 5 0v5"/>',
    School: '<path d="M2 9 12 4l10 5-10 5-10-5z"/><path d="M6 11.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-4.5"/><path d="M20 9v6"/>',
    University: '<path d="M2 9 12 4l10 5-10 5-10-5z"/><path d="M6 11.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-4.5"/><path d="M20 9v6"/>',
    Police: '<path d="M12 2 4 5v6c0 5 3.5 9.4 8 11 4.5-1.6 8-6 8-11V5l-8-3z"/><path d="m9 12 2 2 4-4"/>',
    'Fire Station': '<path d="M12 2c-1.2 3.4-4.6 4.6-4.6 9a4.6 4.6 0 0 0 9.2 0c0-1.7-.8-2.7-1.7-3.5.1 1.7-.9 2.6-1.7 1.8.9-2.6-.8-4.5-1.2-7.3z"/>',
    'Gas Station': '<path d="M4 22V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M4 12h9"/><path d="M14 9.5 17 7"/><path d="M17 7v4a1.6 1.6 0 0 0 1.6 1.6A1.4 1.4 0 0 0 20 11.2V9a2 2 0 0 0-.6-1.4L17 5.4"/><path d="M2 22h14"/>',
    Government: '<path d="M4 21h16M5 21V10l7-5 7 5v11M9 21v-6h6v6"/>',
    Terminal: '<rect x="4" y="5" width="16" height="12" rx="2"/><path d="M4 11h16"/><circle cx="8" cy="17.5" r="1.4"/><circle cx="16" cy="17.5" r="1.4"/>',
    Mall: '<path d="M6.5 8h11l-1 13h-9l-1-13z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    'Theme Park': '<circle cx="12" cy="12" r="8"/><path d="M12 4v16M4 12h16M6.34 6.34l11.32 11.32M17.66 6.34 6.34 17.66"/><circle cx="12" cy="12" r="1.6"/>',
    Landmark: '<path d="m12 2 2.7 6.4 6.9.6-5.2 4.6 1.6 6.7L12 16.9l-5.9 3.4 1.6-6.7-5.2-4.6 6.9-.6z"/>',
    'City Center': '<path d="M5 3v18"/><path d="M5 4h11l-2.2 3.5L16 11H5"/>',
    // ---- Split for the province/city/municipality/barangay hierarchy
    // pass. 'City Center' above is kept as-is for backward compat (no
    // entries reference it anymore, but removing the key outright buys
    // nothing); City/Municipality/Barangay are the categories entries
    // actually use now. 'Province' has no icon on purpose — see the
    // POI_MAJOR_CATEGORIES comment below. ----
    City: '<path d="M5 3v18"/><path d="M5 4h11l-2.2 3.5L16 11H5"/>',
    Municipality: '<path d="M4 21h16"/><path d="M6 21V9l6-5 6 5v12"/><path d="M10 21v-6h4v6"/>',
    Barangay: '<circle cx="12" cy="12" r="3"/><path d="M12 4v3M12 17v3M4 12h3M17 12h3M6.3 6.3l2.1 2.1M15.6 15.6l2.1 2.1M6.3 17.7l2.1-2.1M15.6 8.4l2.1-2.1"/>',
    // ---- Added for the POI expansion pass (pharmacy, bank/ATM,
    // supermarket, restaurant, fast food, bakery, wet market, water
    // station, parking) — everyday-errand categories the icon set didn't
    // cover before. "Bank" also covers standalone ATM entries: a lone cash
    // machine doesn't need a visually distinct icon from its host bank,
    // and giving it one would just add map clutter for the same errand
    // ("get cash nearby") the bank icon already communicates. ----
    Pharmacy: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v9M7.5 12h9"/>',
    Bank: '<path d="M3 21h18"/><path d="M4 21V10l8-5 8 5v11"/><path d="M4 10h16"/><path d="M8 21v-8M12 21v-8M16 21v-8"/>',
    Supermarket: '<path d="M3 4h2l2.2 11.2a2 2 0 0 0 2 1.8h8a2 2 0 0 0 2-1.6L21 8H6.2"/><circle cx="9.5" cy="20" r="1.4"/><circle cx="17.5" cy="20" r="1.4"/>',
    Restaurant: '<path d="M7 2v7a2 2 0 0 0 4 0V2M9 9v13"/><path d="M16 2c-1.8 1.6-2.5 3.6-2.5 6s.7 4.4 2.5 6v7"/>',
    'Fast Food': '<path d="M4 10a8 5 0 0 1 16 0"/><path d="M3.5 10h17"/><path d="M4 14h16"/><path d="M3 18h18"/>',
    Bakery: '<path d="M4 12.5a8 5.5 0 0 1 16 0V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M9 8.2a3 3 0 0 1 6 0"/>',
    'Wet Market': '<path d="M6 12c3.2-5 12.8-5 16 0-3.2 5-12.8 5-16 0z"/><circle cx="17.3" cy="12" r="1"/><path d="M2 8.5c1.3 1 2 2.3 2 3.5s-.7 2.5-2 3.5"/>',
    'Water Station': '<path d="M12 2.5S5.5 11 5.5 15.5a6.5 6.5 0 0 0 13 0C18.5 11 12 2.5 12 2.5z"/>',
    Parking: '<circle cx="12" cy="12" r="9"/><path d="M9.5 16V8h3.2a2.7 2.7 0 0 1 0 5.4H9.5"/>',
    // ---- Added for the Laguna Tripadvisor "Sights & Landmarks" pass
    // (https://www.tripadvisor.com.ph/Attractions-g3602863-Activities-c47-Laguna_Province_Calabarzon_Region_Luzon.html)
    // — several of the added entries are agri-tourism farms/leisure
    // parks that didn't have a category of their own before. ----
    Farm: '<path d="M4 21V9l6-4 6 4v12"/><path d="M4 21h16"/><path d="M9 21v-6h4v6"/><path d="M17 13V7l3 2v4"/>'
  };
  const POI_COLOR_VAR = {
    Hospital: '--poi-hospital', Church: '--poi-church', School: '--poi-school',
    University: '--poi-school', Police: '--poi-police', 'Fire Station': '--poi-fire',
    'Gas Station': '--poi-fuel', Government: '--poi-gov', Terminal: '--poi-terminal',
    Mall: '--poi-mall', 'Theme Park': '--poi-mall', Landmark: '--poi-landmark',
    'City Center': '--poi-city',
    City: '--poi-city', Municipality: '--poi-municipality', Barangay: '--poi-barangay',
    Pharmacy: '--poi-pharmacy', Bank: '--poi-bank', Supermarket: '--poi-supermarket',
    Restaurant: '--poi-restaurant', 'Fast Food': '--poi-fastfood', Bakery: '--poi-bakery',
    'Wet Market': '--poi-market', 'Water Station': '--poi-water', Parking: '--poi-parking',
    Farm: '--poi-farm'
  };
  // Below zoom 13 nothing shows (province-wide view is for the route line
  // and hazards, not landmark browsing); 13-14 shows only the "find your
  // way around town" majors; 15+ adds the finer-grained everyday POIs;
  // 17+ also reveals name labels. This is what keeps a dense area like
  // San Pablo City from turning into a wall of overlapping icons when
  // zoomed out.
  const POI_ZOOM_MIN = 13;
  const POI_MAJOR_CATEGORIES = ['City', 'Municipality', 'Mall', 'Government', 'Hospital', 'University', 'Theme Park', 'Terminal', 'Landmark'];
  // 'Province' is excluded from POI_ICON_SVG entirely (no ambient map
  // pin) and 'Barangay' is excluded from the "major" list above (so all
  // 681 of them stay in the finer-grained zoom-15+ tier alongside
  // churches/banks/etc. instead of cluttering the province-wide/city-wide
  // view) — both categories remain fully searchable/navigable via
  // destInput regardless of this, since search filters livePois directly
  // and never consults POI_ICON_SVG or this list.
  const poiLayerGroup = L.layerGroup().addTo(map);
  let poiEntries = livePois.filter(d => POI_ICON_SVG[d.category]);
  function recomputePoiEntries(){
    poiEntries = livePois.filter(d => POI_ICON_SVG[d.category]);
    poiMarkersBuiltAtZoom = null; // force renderPoiMarkers() to rebuild at the current zoom
    renderPoiMarkers();
  }

  function poiIconFor(category, zoom){
    const size = zoom >= 17 ? 32 : (zoom >= 15 ? 27 : 22);
    const showLabel = zoom >= 17;
    const colorVar = POI_COLOR_VAR[category] || '--poi-landmark';
    const svgPath = POI_ICON_SVG[category] || POI_ICON_SVG.Landmark;
    return { size, showLabel, colorVar, svgPath };
  }

  function buildPoiDivIcon(dest, zoom){
    const { size, showLabel, colorVar, svgPath } = poiIconFor(dest.category, zoom);
    const labelHtml = showLabel ? `<div class="poi-label">${dest.name}</div>` : '';
    return L.divIcon({
      className: `poi-marker-wrap${showLabel ? ' show-label' : ''}`,
      html: `<div class="poi-marker" style="background:var(${colorVar});width:${size}px;height:${size}px;">
               <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${svgPath}</svg>
             </div>${labelHtml}`,
      iconSize: [size, size + (showLabel ? 16 : 0)],
      iconAnchor: [size / 2, size / 2]
    });
  }

  let poiMarkersBuiltAtZoom = null;
  function renderPoiMarkers(){
    const zoom = map.getZoom();
    // Rebuild only when crossing one of the size/label/visibility bands
    // above, not on every fractional zoomend — cheap either way with
    // ~20 markers, but this keeps it from re-rendering on every
    // in-between pinch frame.
    const band = zoom < POI_ZOOM_MIN ? 'hidden' : (zoom >= 17 ? 'label' : (zoom >= 15 ? 'full' : 'major'));
    if (band === poiMarkersBuiltAtZoom) return;
    poiMarkersBuiltAtZoom = band;

    poiLayerGroup.clearLayers();
    if (band === 'hidden') return;

    const visible = band === 'major'
      ? poiEntries.filter(d => POI_MAJOR_CATEGORIES.includes(d.category))
      : poiEntries;

    visible.forEach(dest => {
      const marker = L.marker([dest.latlng.lat, dest.latlng.lng], {
        icon: buildPoiDivIcon(dest, zoom)
      });
      marker.on('click', () => {
        showToast(`${dest.name} · tap search to route here`);
      });
      marker.addTo(poiLayerGroup);
    });
  }
  map.on('zoomend', renderPoiMarkers);
  renderPoiMarkers();

  // Live "X km away" for the search list, computed against whatever the
  // real current origin is right now (GPS when available) rather than a
  // number baked in when the destination list was written — since origin
  // moves as the device moves, a static distance would just go stale.
  function distanceLabel(destLatLng){
    const meters = map.distance(
      [currentOriginCoords.lat, currentOriginCoords.lng],
      [destLatLng.lat, destLatLng.lng]
    );
    return meters < 1000 ? `${Math.round(meters)} m` : `${(meters/1000).toFixed(1)} km`;
  }

  // Builds a gently curved line (cubic bezier, sampled) from the user's
  // actual current origin to the destination, in real lat/lng space, so
  // the visible road always matches the real Place N -> Place N+1 leg.
  function buildRouteLatLngs(origin, dest, steps){
    steps = steps || 80;
    const dLat = dest.lat - origin.lat, dLng = dest.lng - origin.lng;
    const c1 = { lat: origin.lat + dLat * 0.32, lng: origin.lng + dLng * 0.12 };
    const c2 = { lat: origin.lat + dLat * 0.68, lng: origin.lng + dLng * 0.88 };
    const pts = [];
    for (let i = 0; i <= steps; i++){
      const t = i / steps, mt = 1 - t;
      const lat = mt*mt*mt*origin.lat + 3*mt*mt*t*c1.lat + 3*mt*t*t*c2.lat + t*t*t*dest.lat;
      const lng = mt*mt*mt*origin.lng + 3*mt*mt*t*c1.lng + 3*mt*t*t*c2.lng + t*t*t*dest.lng;
      pts.push({ lat, lng });
    }
    return pts;
  }

  // Cumulative real-world distance (meters) along the sampled points,
  // using Leaflet's own haversine distance — this is what makes route
  // progress/duration and hazard placement reflect real geography.
  function routeLengthTable(pts){
    const cum = [0];
    for (let i = 1; i < pts.length; i++){
      cum.push(cum[i-1] + map.distance([pts[i-1].lat, pts[i-1].lng], [pts[i].lat, pts[i].lng]));
    }
    return cum;
  }

  function pointAtDistance(pts, cum, dist){
    const total = cum[cum.length - 1];
    dist = Math.max(0, Math.min(total, dist));
    let i = 1;
    while (i < cum.length && cum[i] < dist) i++;
    const segStart = cum[i-1], segEnd = cum[i] ?? segStart;
    const segLen = segEnd - segStart || 1;
    const t = (dist - segStart) / segLen;
    const a = pts[i-1], b = pts[i] ?? a;
    return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
  }

  // Cheap local (equirectangular) meters-per-degree conversion — accurate
  // enough over the few-kilometer spans involved in projecting a GPS fix
  // onto a route or measuring how far off it the device has drifted.
  function metersPerDegree(lat){
    const latRad = lat * Math.PI / 180;
    return { latM: 111320, lngM: 111320 * Math.cos(latRad) };
  }

  // Projects `pos` onto the route polyline `pts`/`cum`, returning how far
  // along the route that projection sits (meters, for progress/ETA) and
  // how far off the line `pos` itself is (meters, for off-route detection).
  function closestPointOnRoute(pos, pts, cum){
    const { latM, lngM } = metersPerDegree(pos.lat);
    let best = { dist: Infinity, along: 0 };
    for (let i = 1; i < pts.length; i++){
      const a = pts[i-1], b = pts[i];
      const bx = (b.lng - a.lng) * lngM, by = (b.lat - a.lat) * latM;
      const px = (pos.lng - a.lng) * lngM, py = (pos.lat - a.lat) * latM;
      const segLen2 = bx*bx + by*by || 1e-9;
      let t = (px*bx + py*by) / segLen2;
      t = Math.max(0, Math.min(1, t));
      const cx = bx*t, cy = by*t;
      const dx = px-cx, dy = py-cy;
      const dist = Math.sqrt(dx*dx + dy*dy);
      if (dist < best.dist){
        const segLenMeters = Math.sqrt(bx*bx + by*by);
        best = { dist, along: cum[i-1] + segLenMeters * t };
      }
    }
    return best;
  }

  function openSearchDual(){
    // If the map-focus toggle had folded the controls away, searching
    // for a destination should bring them back rather than opening a
    // search panel underneath a hidden search bar.
    if (appHeaderEl.classList.contains('controls-collapsed')) {
      mapFocusToggleBtn.click();
    }
    searchBarEl.classList.add('expanded');
    searchDual.classList.add('open');
    originInput.value = currentOriginLocation;
    // livePois is now ~875 entries (682 of them Laguna barangays + 82
    // provinces added for the admin-hierarchy pass) — dumping the whole
    // list into the DOM on open the way this used to work would be
    // a real jank/perf regression, not just untidy. Default to nearest-
    // first, capped, same as a blank query below.
    renderSuggestions(rankForEmptyQuery());
    destInput.focus();
  }
  function closeSearchDual(){
    searchBarEl.classList.remove('expanded');
    searchDual.classList.remove('open');
  }
  searchBarEl.addEventListener('click', openSearchDual);
  document.getElementById('searchCancelBtn').addEventListener('click', closeSearchDual);

  let selectedDestination = null;

  // Categories that represent an administrative area rather than a single
  // amenity — surfaced with a clear label in the suggestion list per the
  // province/city/municipality/barangay search requirements, and given
  // search-ranking priority (see scoreMatch) so e.g. "Calamba" surfaces
  // the city itself above the dozens of individual Calamba POIs/barangays
  // that also match.
  const ADMIN_CATEGORIES = ['Province', 'City', 'Municipality', 'Barangay'];
  const ADMIN_RANK = { Province: 0, City: 1, Municipality: 1, Barangay: 3 };
  const SEARCH_RESULT_CAP = 40;

  function rankForEmptyQuery(){
    return livePois
      .slice()
      .sort((a,b) => map.distance([currentOriginCoords.lat, currentOriginCoords.lng], [a.latlng.lat, a.latlng.lng])
                   - map.distance([currentOriginCoords.lat, currentOriginCoords.lng], [b.latlng.lat, b.latlng.lng]))
      .slice(0, SEARCH_RESULT_CAP);
  }

  // Token-based AND matching (order-independent) so multi-word queries
  // like "Barangay San Antonio" or "San Pablo City" work — every word in
  // the query must appear *somewhere* across the category/name/sub text,
  // not necessarily contiguous or in that order. Returns a tier (lower =
  // better match) or -1 for no match at all.
  function scoreMatch(dest, tokens, fullQuery){
    const name = dest.name.toLowerCase();
    const sub = (dest.sub || '').toLowerCase();
    const cat = (dest.category || '').toLowerCase();
    if (name === fullQuery) return 0;
    if (name.startsWith(fullQuery)) return 1;
    const haystackName = name;
    const haystackAll = `${cat} ${name} ${sub}`;
    if (tokens.every(t => haystackName.includes(t))) return 2;
    if (tokens.every(t => haystackAll.includes(t))) return 3;
    return -1;
  }

  function searchDestinations(query){
    const q = query.trim().toLowerCase();
    if (!q) return rankForEmptyQuery();
    const tokens = q.split(/\s+/).filter(Boolean);
    const scored = [];
    for (const dest of livePois) {
      const tier = scoreMatch(dest, tokens, q);
      if (tier === -1) continue;
      scored.push({ dest, tier, adminRank: ADMIN_RANK[dest.category] ?? 2 });
    }
    scored.sort((a, b) =>
      a.tier - b.tier ||
      a.adminRank - b.adminRank ||
      a.dest.name.localeCompare(b.dest.name)
    );
    // De-dupe exact repeats (same name+sub+category+coordinates) without
    // touching legitimately distinct places that just share a name —
    // e.g. the many barangays across Laguna named "San Isidro" or
    // "Poblacion" are different real places (different sub/coordinates)
    // and must all still appear.
    const seen = new Set();
    const deduped = [];
    for (const { dest } of scored) {
      const key = `${dest.name}|${dest.sub}|${dest.category}|${dest.latlng.lat}|${dest.latlng.lng}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(dest);
      if (deduped.length >= SEARCH_RESULT_CAP) break;
    }
    return deduped;
  }

  function renderSuggestions(list){
    searchSuggestions.innerHTML = list.map((d,i)=>{
      const badge = ADMIN_CATEGORIES.includes(d.category) ? `${d.category} · ` : '';
      return `
      <div class="search-suggest-item" data-i="${i}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>
        <div><div class="search-suggest-title">${d.name}</div><div class="search-suggest-sub">${badge}${d.sub} · ${distanceLabel(d.latlng)} away</div></div>
      </div>
    `;
    }).join('');
    searchSuggestions.querySelectorAll('.search-suggest-item').forEach(item=>{
      item.addEventListener('click', ()=>{
        const dest = list[+item.dataset.i];
        selectedDestination = dest;
        destInput.value = dest.name;
        startNavigation(dest);
      });
    });
  }

  destInput.addEventListener('input', ()=>{
    // Typing invalidates whatever was previously selected from the list —
    // the Go button shouldn't silently route somewhere the text no longer
    // names (see searchGoBtn handler below).
    selectedDestination = null;
    renderSuggestions(searchDestinations(destInput.value));
  });

  let activeRouteHazards = [];
  let routeLine = null; // L.polyline OR L.layerGroup (traffic-colored segments)
  let routeHazardMarkers = [];
  let navDestMarker = null; // red pin at the active nav destination (see showNavDestMarker/hideNavDestMarker)

  // Red teardrop pin at the active navigation destination — added when
  // navigation starts, removed when it ends/is cancelled. Kept separate
  // from the general POI icon markers (which stay category-colored and
  // are about browsing places, not "this is where you're headed now").
  function showNavDestMarker(latlng){
    if (navDestMarker) { map.removeLayer(navDestMarker); navDestMarker = null; }
    const icon = L.divIcon({
      className: 'nav-dest-pin',
      html: `<svg viewBox="0 0 30 38" xmlns="http://www.w3.org/2000/svg">
        <path d="M15 37C15 37 28 22.5 28 14A13 13 0 0 0 2 14C2 22.5 15 37 15 37Z" fill="#E5484D" stroke="#fff" stroke-width="2"/>
        <circle cx="15" cy="14" r="5" fill="#fff"/>
      </svg>`,
      iconSize: [30, 38],
      iconAnchor: [15, 37]
    });
    navDestMarker = L.marker([latlng.lat, latlng.lng], { icon, zIndexOffset: 900, interactive: false }).addTo(map);
  }
  function hideNavDestMarker(){
    if (navDestMarker) { map.removeLayer(navDestMarker); navDestMarker = null; }
  }
  let warnedHazardIds = new Set();

  /*  Real, GPS-Tracked Navigation (map/marker follow the actual device
      position — nothing here is animated toward the destination)  */
  const speedoCardEl = document.getElementById('speedoCard');
  const speedoValueEl = document.getElementById('speedoValue');
  const speedoLabelEl = document.getElementById('speedoLabel');
  const speedoSubEl = document.getElementById('speedoSub');
  const speedoRingEl = document.getElementById('speedoRing');
  const navBannerEl = document.getElementById('navBanner');
  const navBannerIconEl = document.getElementById('navBannerIcon');
  const navBannerInstructionEl = document.getElementById('navBannerInstruction');
  const navBannerSubEl = document.getElementById('navBannerSub');
  const navBannerStopBtn = document.getElementById('navBannerStopBtn');
  const recenterBtn = document.getElementById('recenterBtn');
  const trafficLegendEl = document.getElementById('trafficLegend');
  const legendStripElForNav = document.getElementById('legendStrip');

  let navActive = false;
  let navDestination = null;
  let navRoutePts = [];      // {lat,lng} geometry of the current route
  let navRouteCum = [];      // cumulative meters along navRoutePts
  let navRouteTotal = 0;     // meters
  let navSteps = [];         // humanized turn-by-turn steps
  let navStepStarts = [];    // cumulative meters at which each step begins
  let navFollowMode = true;  // whether the map camera tracks the user
  let navLastRecalcAt = 0;
  let navRecalcInFlight = false;
  let navTransportMode = 'car';        // locked in when navigation starts, so mid-route recalculation stays on the same profile
  let navBaseDurationSec = null;       // routing engine's free-flow duration for the active route
  let navLastTrafficRatioAvg = null;   // last traffic ratio sampled for the active route (reused each GPS tick, not re-fetched every frame)
  let navHasZoomedIn = false;          // whether the initial route-overview zoom has been replaced by a close, Waze-style follow zoom yet
  const NAV_FOLLOW_ZOOM = 17;          // close enough to clearly read street names and upcoming turns
  const OFF_ROUTE_METERS = 45;      // how far off the drawn line counts as "off route"
  const OFF_ROUTE_RECALC_COOLDOWN_MS = 8000;
  const ARRIVAL_METERS = 25;
  const HAZARD_WARN_METERS = 250;

  /*  Sequential Origin State  */
  const routeBoxOriginEl = document.getElementById('routeBoxOrigin');
  const routeBoxDestRowEl = document.getElementById('routeBoxDestRow');
  const routeBoxDestEl = document.getElementById('routeBoxDest');
  const routeBoxConnectorEl = document.getElementById('routeBoxConnector');
  const routeBoxTagEl = document.getElementById('routeBoxTag');
  let currentOriginLocation = 'Santa Cruz, Laguna';
  let currentOriginCoords = { lat: 14.2814, lng: 121.4157 }; // provincial capital — matches initial youMarker position
  let liveUserPosition = { lat: 14.2814, lng: 121.4157 }; // continuously updated while navigating, for accurate hazard placement

  youMarker.setLatLng([currentOriginCoords.lat, currentOriginCoords.lng]);
  map.setView([currentOriginCoords.lat, currentOriginCoords.lng], 12);

  function updateRouteBox(destText){
    routeBoxOriginEl.textContent = currentOriginLocation;
    if(destText){
      routeBoxDestRowEl.style.display = 'flex';
      routeBoxConnectorEl.style.display = 'block';
      routeBoxDestEl.textContent = destText;
      routeBoxDestEl.classList.remove('placeholder');
      routeBoxTagEl.style.display = 'none';
    } else {
      routeBoxDestRowEl.style.display = 'none';
      routeBoxConnectorEl.style.display = 'none';
      routeBoxTagEl.style.display = '';
    }
  }

  function resetOriginState(){
    currentOriginLocation = 'Santa Cruz, Laguna';
    currentOriginCoords = { lat: 14.2814, lng: 121.4157 };
    liveUserPosition = { lat: 14.2814, lng: 121.4157 };
    youMarker.setLatLng([currentOriginCoords.lat, currentOriginCoords.lng]);
    hasCenteredOnGPS = false;
    updateRouteBox(null);
  }

  /*  REAL GPS AS ROUTING ORIGIN + "CENTER MY LOCATION"  */
  /*   Ties GPSManager's real device location into the routing/map system:
     whenever a fresh GPS fix comes in and the user isn't mid-route, that
     fix becomes the actual routing origin (not the fixed provincial-
     capital fallback above, which only matters until a real fix arrives
     or on devices/browsers with no geolocation at all). The map also
     auto-centers on the very first fix, the way a real nav app opens
     centered on you — but not on every subsequent update, or the map
     would keep yanking itself away from someone who's panned to look
     around. */
  let hasCenteredOnGPS = false;

  GPSManager.onUpdate((pos) => {
    if (pos.latitude === null || pos.longitude === null) return;
    if (!navActive) {
      currentOriginCoords = { lat: pos.latitude, lng: pos.longitude };
      currentOriginLocation = 'Current Location';
      youMarker.setLatLng([pos.latitude, pos.longitude]);
      routeBoxOriginEl.textContent = currentOriginLocation;
    } else {
      // Real navigation: every fresh GPS fix — not a timer or animation —
      // drives the marker, the route progress, and turn-by-turn state.
      updateNavigationProgress({ lat: pos.latitude, lng: pos.longitude });
    }
    if (!hasCenteredOnGPS) {
      hasCenteredOnGPS = true;
      map.flyTo([pos.latitude, pos.longitude], 15, { duration: 1 });
    }
  });

  const locateBtn = document.getElementById('locateBtn');
  locateBtn.addEventListener('click', async () => {
    if (locateBtn.classList.contains('locating')) return;
    locateBtn.classList.add('locating');
    try {
      const known = GPSManager.getCurrentLocation();
      const coords = known.latitude !== null ? known : await GPSManager.getFreshPosition();

      map.flyTo([coords.latitude, coords.longitude], 16, { duration: 0.8 });
      hasCenteredOnGPS = true;

      if (!navActive) {
        currentOriginCoords = { lat: coords.latitude, lng: coords.longitude };
        currentOriginLocation = 'Current Location';
        youMarker.setLatLng([coords.latitude, coords.longitude]);
        routeBoxOriginEl.textContent = currentOriginLocation;
      }
      locateBtn.classList.add('active');
      showToast('Centered on your location');
    } catch (err) {
      console.error('Locate error:', err);
      let msg = 'Could not get your location.';
      if (err && err.code === 1) msg = 'Location permission was denied.';
      else if (err && err.code === 2) msg = 'Location information is unavailable.';
      else if (err && err.code === 3) msg = 'Location request timed out.';
      showToast(msg);
    } finally {
      locateBtn.classList.remove('locating');
    }
  });

  function endNavigation(dest){
    navActive = false;
    navDestination = null;
    navRoutePts = [];
    navRouteCum = [];
    navRouteTotal = 0;
    navSteps = [];
    navStepStarts = [];
    navFollowMode = true;
    navRecalcInFlight = false;
    warnedHazardIds.clear();
    navHasZoomedIn = false;

    if(youMarkerArrowEl) youMarkerArrowEl.style.opacity = 0;
    speedoCardEl.classList.remove('navigating');
    speedoRingEl.style.background = '';

    navBannerEl.classList.remove('show');
    recenterBtn.style.display = 'none';
    trafficLegendEl.style.display = 'none';
    if (legendStripElForNav) legendStripElForNav.style.display = '';
    hideRouteInfoCard();
    hideNavDestMarker();
    navBaseDurationSec = null;
    navLastTrafficRatioAvg = null;

    map.flyTo([currentOriginCoords.lat, currentOriginCoords.lng], 13, { duration: 0.65 });
    const gps = GPSManager.getCurrentLocation();
    if (gps && gps.latitude !== null) {
      GPSManager.updateInterface();
    } else {
      speedoValueEl.textContent = '0';
      speedoLabelEl.textContent = 'GPS Unavailable';
      speedoSubEl.textContent = 'Waiting for location';
    }
    updateRouteBox(null);
  }

  // ---------- REAL ROAD ROUTING (OSRM) WITH OFFLINE FALLBACK ----------
  // Requests an actual road-following route between two points from
  // OSRM's public routing API — the route traces real streets instead of
  // a smooth curve, the way a real navigation app's route does, and also
  // asks for turn-by-turn steps and (when available) alternative routes.
  // This needs a live connection, which cuts against BiyaHERO's offline-
  // first design, so it's used opportunistically: try for a real route
  // with a short timeout, and if that fails for any reason (no signal,
  // the demo server being slow/rate-limited, a timeout), fall straight
  // back to the existing curved-line approximation so navigation still
  // works offline.
  //
  // ⚠️ PRE-LAUNCH NOTE: router.project-osrm.org is OSRM's free public demo
  // server — meant for light testing, not production traffic (see
  // https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server). A
  // shipped app should run its own OSRM instance or use a commercial
  // routing provider, same caveat as the tile server above.
  //
  // routing.openstreetmap.de/routed-foot is a *separate* free public OSRM
  // demo (run by the OpenStreetMap.de project) that hosts the "foot"
  // profile — router.project-osrm.org itself only ever serves "driving".
  // Same caveats apply: fine for a hobby/demo build, not for production
  // load. There is no public demo server anywhere that hosts a dedicated
  // "motorcycle" profile, and a motorcycle uses the same road network as
  // a car (not bike lanes/paths), so motorcycle routing reuses the
  // driving profile's road geometry — only the time estimate differs,
  // via trafficMultiplier below, to reflect that a motorcycle can filter
  // through stopped car traffic in a way a car can't. That's a stated
  // assumption for ETA purposes, not a measured figure.
  const TRANSPORT_MODES = {
    walking: {
      label: 'Walking', icon: '🚶',
      osrmProfileBase: 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/',
      fallbackSpeedKmh: 4.8,   // typical walking pace, used only if this profile is unreachable
      trafficMultiplier: 0     // road traffic doesn't slow a pedestrian down
    },
    // ⚠️ SCOPE NOTE, read before assuming this is full transit routing:
    // there is no public GTFS feed or OpenTripPlanner instance for
    // Laguna's jeepney/bus network that this app integrates with, so
    // "Transit" does NOT do schedule-aware, route-specific public-
    // transport routing (which jeepney line to board, fares, stop
    // timetables). What it DOES do honestly: route along the same real
    // road network buses/jeepneys actually use (OSRM's driving profile),
    // with a slower fallback speed that accounts for boarding/alighting
    // stops along the way, rather than car free-flow speed. Wiring in
    // true GTFS-based transit routing later would mean sourcing a real
    // Laguna PUJ/bus GTFS feed (if/when one is published) and pointing
    // it at an OpenTripPlanner (or similar) instance — a separate,
    // larger integration, not something to fake here.
    transit: {
      label: 'Transit', icon: '🚌',
      osrmProfileBase: 'https://router.project-osrm.org/route/v1/driving/',
      fallbackSpeedKmh: 18,
      trafficMultiplier: 1
    },
    motorcycle: {
      label: 'Motorcycle', icon: '🏍️',
      osrmProfileBase: 'https://router.project-osrm.org/route/v1/driving/',
      fallbackSpeedKmh: 38,
      trafficMultiplier: 0.55  // absorbs only part of the congestion penalty a car would face (lane-filtering)
    },
    car: {
      label: 'Car', icon: '🚗',
      osrmProfileBase: 'https://router.project-osrm.org/route/v1/driving/',
      fallbackSpeedKmh: 32,
      trafficMultiplier: 1     // full congestion penalty
    }
  };
  function getTransportMode(mode){
    return TRANSPORT_MODES[mode] || TRANSPORT_MODES.car;
  }
  const OSRM_TIMEOUT_MS = 6000;

  /* Transport mode selector (Walking / Motorcycle / Car). Only affects
     the *next* route requested — see navTransportMode below for how an
     already-active navigation stays consistent instead of switching
     profiles mid-route. */
  const transportModeBtns = document.querySelectorAll('.transport-mode-btn');
  let selectedTransportMode = 'car';
  transportModeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      transportModeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedTransportMode = btn.dataset.mode;
    });
  });

  const routeInfoCardEl = document.getElementById('routeInfoCard');
  const ricModeEl = document.getElementById('ricMode');
  const ricDistanceEl = document.getElementById('ricDistance');
  const ricTimeEl = document.getElementById('ricTime');
  const ricTrafficEl = document.getElementById('ricTraffic');
  const ricEtaEl = document.getElementById('ricEta');

  function hideRouteInfoCard(){
    routeInfoCardEl.style.display = 'none';
  }

  // distanceM/durationSec describe the (remaining) route; trafficRatioAvg
  // is whatever paintRouteTraffic() last sampled for it (null when no
  // live traffic data was available/configured). Never invents a traffic
  // reading — falls back to "Traffic data unavailable" for car/
  // motorcycle, or a plain "not traffic-affected" label for walking.
  function showRouteInfoCard({ mode, distanceM, durationSec, trafficRatioAvg }){
    const modeCfg = getTransportMode(mode);
    ricModeEl.textContent = modeCfg.icon;

    const distKm = distanceM / 1000;
    ricDistanceEl.textContent = distKm < 1 ? `${Math.round(distanceM)} m` : `${distKm.toFixed(1)} km`;

    let adjustedSec = durationSec || 0;
    let trafficCls = null;
    if (modeCfg.trafficMultiplier > 0 && trafficRatioAvg !== null && trafficRatioAvg !== undefined) {
      trafficCls = classifyTrafficRatio(trafficRatioAvg);
      // How much longer than free-flow this ratio implies, scaled by how
      // much of that penalty this mode actually absorbs.
      const slowdownFactor = (1 / Math.max(trafficRatioAvg, 0.15)) - 1;
      adjustedSec = adjustedSec * (1 + slowdownFactor * modeCfg.trafficMultiplier);
    }

    const mins = adjustedSec > 0 ? Math.max(1, Math.round(adjustedSec / 60)) : null;
    ricTimeEl.textContent = mins !== null ? `${mins} min` : '—';

    if (modeCfg.trafficMultiplier === 0) {
      ricTrafficEl.textContent = 'Not traffic-affected';
    } else {
      ricTrafficEl.textContent = trafficCls ? trafficCls.label : 'Traffic data unavailable';
    }

    if (adjustedSec > 0) {
      const eta = new Date(Date.now() + adjustedSec * 1000);
      ricEtaEl.textContent = `ETA ${eta.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    } else {
      ricEtaEl.textContent = '';
    }

    routeInfoCardEl.style.display = 'flex';
  }

  function humanizeManeuver(step){
    const m = step.maneuver || {};
    const type = m.type;
    const mod = m.modifier;
    const streetPart = step.name ? ` onto ${step.name}` : '';
    const modWord = {
      left: 'left', right: 'right', 'slight left': 'slight left', 'slight right': 'slight right',
      'sharp left': 'sharp left', 'sharp right': 'sharp right', straight: 'straight', uturn: 'a U-turn'
    }[mod] || mod || '';
    switch(type){
      case 'depart': return `Head out${streetPart}`;
      case 'arrive': return 'Arrive at your destination';
      case 'turn': return `Turn ${modWord}${streetPart}`;
      case 'new name': return `Continue${streetPart}`;
      case 'merge': return `Merge${streetPart}`;
      case 'roundabout':
      case 'rotary': return `Enter the roundabout${streetPart}`;
      case 'fork': return `Keep ${modWord}${streetPart}`;
      case 'end of road': return `Turn ${modWord} at the end of the road${streetPart}`;
      case 'continue': return `Continue ${modWord}${streetPart}`;
      default: return `Continue${streetPart}`;
    }
  }

  // Builds the humanized step list + the cumulative distance (meters) at
  // which each step begins, so progress along `pts`/`cum` can be matched
  // back to "which instruction is this" during navigation.
  function buildStepList(legSteps){
    const steps = [];
    const starts = [];
    let acc = 0;
    (legSteps || []).forEach(s => {
      starts.push(acc);
      steps.push({ instruction: humanizeManeuver(s), distance: s.distance || 0 });
      acc += s.distance || 0;
    });
    return { steps, starts };
  }

  // Straight-line/curved fallback, but with a mode-appropriate duration
  // estimate attached (walking pace vs. motorcycle vs. car free-flow
  // speed) so the route info card still shows a plausible time even when
  // no routing server is reachable — never a fabricated "real" duration,
  // just distance ÷ that mode's typical speed.
  function buildFallbackRoute(origin, dest, modeCfg){
    const pts = buildRouteLatLngs(origin, dest);
    const cum = routeLengthTable(pts);
    const totalM = cum[cum.length - 1] || 0;
    const speedMs = (modeCfg.fallbackSpeedKmh * 1000) / 3600;
    const baseDurationSec = speedMs > 0 ? totalM / speedMs : null;
    return { pts, isReal: false, steps: [], stepStarts: [], baseDurationSec };
  }

  async function fetchRoadRoute(origin, dest, mode){
    const modeCfg = getTransportMode(mode);
    if (!navigator.onLine) {
      return buildFallbackRoute(origin, dest, modeCfg);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OSRM_TIMEOUT_MS);
    try {
      const url = `${modeCfg.osrmProfileBase}${origin.lng},${origin.lat};${dest.lng},${dest.lat}` +
        `?overview=full&geometries=geojson&steps=true&alternatives=true`;
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) throw new Error(`Routing server responded ${resp.status}`);
      const data = await resp.json();
      if (!data || data.code !== 'Ok' || !data.routes || !data.routes.length) {
        throw new Error('Routing server returned no usable route');
      }
      // When multiple candidate routes come back, pick the one to use.
      // With no live traffic feed there's nothing meaningful to compare
      // them on beyond the routing engine's own ranking, so the first
      // (fastest) route is used — see chooseBestRoute() below for the
      // traffic-aware path.
      const chosen = await chooseBestRoute(data.routes, modeCfg.trafficMultiplier > 0);
      const coords = chosen.geometry && chosen.geometry.coordinates;
      if (!coords || coords.length < 2) throw new Error('Routing server returned no usable geometry');
      // GeoJSON coordinates are [lng, lat] — flip to the {lat,lng} shape
      // the rest of this file (routeLengthTable, pointAtDistance, etc.)
      // already works with, regardless of where the points came from.
      const pts = coords.map(([lng, lat]) => ({ lat, lng }));
      const leg = chosen.legs && chosen.legs[0];
      const { steps, starts } = buildStepList(leg && leg.steps);
      // chosen.duration is the routing engine's own free-flow travel time
      // estimate (seconds) for this profile — real, not invented — which
      // showRouteInfoCard() then adjusts using the traffic multiplier.
      return { pts, isReal: true, steps, stepStarts: starts, baseDurationSec: chosen.duration || null };
    } catch (err) {
      console.warn('Road routing unavailable, using approximate route:', err.message || err);
      return buildFallbackRoute(origin, dest, modeCfg);
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- LIVE TRAFFIC (optional, via TomTom Traffic Flow API) ----------
  // See traffic-config.js for setup. Without a key configured, BiyaHERO
  // never invents a traffic color — the route just renders in one
  // neutral color and this whole section is skipped.
  const TOMTOM_FLOW_BASE = 'https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json';
  const TOMTOM_TIMEOUT_MS = 4000;

  // Four tiers instead of three: TomTom's currentSpeed/freeFlowSpeed ratio
  // is continuous, and a 4-way split (green/yellow/orange/red) reads
  // closer to what real nav apps show than a flat light/moderate/heavy —
  // in particular it separates "heavy but moving" from "essentially
  // stopped" instead of lumping both into one worst-case color.
  function classifyTrafficRatio(ratio){
    if (ratio === null) return null;
    if (ratio >= 0.75) return { color: '#2FB35B', label: 'Low Traffic' };
    if (ratio >= 0.5) return { color: '#F2B705', label: 'Moderate Traffic' };
    if (ratio >= 0.25) return { color: '#F2870A', label: 'Heavy Traffic' };
    return { color: '#E5484D', label: 'Severe Congestion' };
  }

  async function fetchTomTomFlowRatio(lat, lng){
    if (!(typeof TrafficConfig !== 'undefined' && TrafficConfig.enabled) || !navigator.onLine) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOMTOM_TIMEOUT_MS);
    try {
      const url = `${TOMTOM_FLOW_BASE}?point=${lat},${lng}&key=${encodeURIComponent(TrafficConfig.apiKey)}`;
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) return null;
      const data = await resp.json();
      const seg = data && data.flowSegmentData;
      if (!seg || !seg.freeFlowSpeed) return null;
      return Math.max(0, Math.min(1, seg.currentSpeed / seg.freeFlowSpeed));
    } catch (err) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // Compares a small number of candidate routes by sampling real traffic
  // ratios along each and picking the one with the best average — only
  // runs when a traffic key is configured and there's more than one
  // candidate; otherwise just returns OSRM's own top pick untouched.
  async function chooseBestRoute(routes, trafficApplies){
    // trafficApplies is false for modes where car/motorcycle-road
    // congestion is irrelevant to picking the best route (walking) — car
    // traffic at a sample point along a footpath says nothing about how
    // good that footpath is, so OSRM's own top pick is used untouched
    // rather than re-ranking foot routes by nearby road congestion.
    if (routes.length === 1 || !trafficApplies || !(typeof TrafficConfig !== 'undefined' && TrafficConfig.enabled) || !navigator.onLine) {
      return routes[0];
    }
    const candidates = routes.slice(0, 3);
    const scored = await Promise.all(candidates.map(async r => {
      const coords = r.geometry && r.geometry.coordinates;
      if (!coords || coords.length < 2) return { route: r, score: -1 };
      const sampleCount = 4;
      const samples = Array.from({ length: sampleCount }, (_, i) => {
        const idx = Math.round((i / (sampleCount - 1)) * (coords.length - 1));
        const [lng, lat] = coords[idx];
        return { lat, lng };
      });
      const ratios = await Promise.all(samples.map(p => fetchTomTomFlowRatio(p.lat, p.lng)));
      const valid = ratios.filter(r2 => r2 !== null);
      const avg = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : -1;
      return { route: r, score: avg };
    }));
    scored.sort((a, b) => b.score - a.score);
    return (scored[0] && scored[0].score > -1) ? scored[0].route : routes[0];
  }

  // Paints the route polyline in the Waze-style look requested: a solid
  // purple/indigo line is always the base of the route (so it reads as
  // "this is your route" at a glance, the same way Waze's line does,
  // regardless of whether live traffic data is available). When a
  // traffic key IS configured and reachable, real TomTom-sourced
  // congestion color is overlaid as a thinner stripe on TOP of the
  // purple casing only where traffic is actually moderate/heavy/severe —
  // free-flowing stretches are left as plain purple, so the congestion
  // color reads as "something's happening here" rather than recoloring
  // the whole route and losing the "this is my route" identity. Never a
  // fake/simulated traffic pattern — with no key configured, or offline,
  // it's simply the purple line with no overlay.
  // Returns the average sampled traffic ratio (0-1, higher = freer-
  // flowing) for the route, or null when no traffic data was available/
  // used — the route info card uses this to label congestion and adjust
  // its ETA.
  const ROUTE_PURPLE = '#5B4FE8';
  // trafficApplies is false for walking (TRANSPORT_MODES.walking.trafficMultiplier
  // is 0) — car-road congestion at a sample point near a footpath isn't
  // meaningful for a pedestrian, so a walking route always renders as the
  // plain purple line with no congestion overlay or legend, same as if no
  // traffic key were configured at all.
  async function paintRouteTraffic(pts, cum, trafficApplies){
    if (routeLine) { map.removeLayer(routeLine); routeLine = null; }

    const group = L.layerGroup();
    const latlngs = pts.map(p => [p.lat, p.lng]);

    // Casing: the purple line itself, drawn first so any traffic overlay
    // (added below) sits visually on top of it. A slightly darker, wider
    // "outline" underneath plus the main purple line gives the same
    // soft-edged look as the reference screenshot instead of a single
    // flat stroke.
    L.polyline(latlngs, {
      color: '#332584', weight: 10, opacity: 0.55, lineCap: 'round', lineJoin: 'round'
    }).addTo(group);
    L.polyline(latlngs, {
      color: ROUTE_PURPLE, weight: 7, opacity: 0.98, lineCap: 'round', lineJoin: 'round'
    }).addTo(group);

    if (!trafficApplies || !(typeof TrafficConfig !== 'undefined' && TrafficConfig.enabled) || !navigator.onLine) {
      group.addTo(map);
      routeLine = group;
      trafficLegendEl.style.display = 'none';
      return null;
    }

    const total = cum[cum.length - 1];
    const SAMPLE_EVERY_M = 600;
    const sampleCount = Math.max(2, Math.min(16, Math.round(total / SAMPLE_EVERY_M) + 1));
    const sampleDists = Array.from({ length: sampleCount }, (_, i) => (i / (sampleCount - 1)) * total);
    const samplePts = sampleDists.map(d => pointAtDistance(pts, cum, d));
    const ratios = await Promise.all(samplePts.map(p => fetchTomTomFlowRatio(p.lat, p.lng)));

    // Draw one thinner colored overlay per sample interval, but only for
    // intervals that are actually congested — a "Low Traffic" reading
    // means that stretch stays plain purple, matching how Waze doesn't
    // repaint free-flowing road green, it just leaves it alone.
    for (let i = 0; i < sampleDists.length - 1; i++){
      const cls = classifyTrafficRatio(ratios[i]);
      if (!cls || cls.label === 'Low Traffic') continue;
      const from = sampleDists[i], to = sampleDists[i + 1];
      const segPts = [];
      const STEP = Math.max(20, (to - from) / 10);
      for (let d = from; d <= to; d += STEP) segPts.push(pointAtDistance(pts, cum, d));
      segPts.push(pointAtDistance(pts, cum, to));
      L.polyline(segPts.map(p => [p.lat, p.lng]), {
        color: cls.color, weight: 4, opacity: 0.95, lineCap: 'round', lineJoin: 'round'
      }).addTo(group);
    }
    group.addTo(map);
    routeLine = group;
    trafficLegendEl.style.display = 'flex';

    const validRatios = ratios.filter(r => r !== null);
    return validRatios.length ? validRatios.reduce((a, b) => a + b, 0) / validRatios.length : null;
  }

  // ---------- REAL, GPS-TRACKED NAVIGATION ----------
  // The user's actual device position (from GPSManager) drives everything
  // below — the marker, progress along the route, the turn-by-turn
  // banner, and off-route recalculation. Nothing here moves the marker
  // toward the destination on its own.

  function updateNavBanner(instructionText, subText){
    navBannerInstructionEl.textContent = instructionText;
    navBannerSubEl.textContent = subText;
    navBannerEl.classList.add('show');
  }

  function checkHazardProximity(pos){
    activeRouteHazards.forEach(h => {
      if (!h.id) h.id = `${h.lat},${h.lng}`;
      if (warnedHazardIds.has(h.id)) return;
      const meters = map.distance([pos.lat, pos.lng], [h.lat, h.lng]);
      if (meters <= HAZARD_WARN_METERS) {
        warnedHazardIds.add(h.id);
        showHazardAlert(h.label, meters);
      }
    });
  }

  async function recalculateRoute(pos){
    if (navRecalcInFlight || !navDestination) return;
    navRecalcInFlight = true;
    navLastRecalcAt = Date.now();
    showToast('Off route — recalculating…');
    try {
      const { pts, isReal, steps, stepStarts, baseDurationSec } = await fetchRoadRoute(pos, navDestination.latlng, navTransportMode);
      if (!navActive) return;
      navRoutePts = pts;
      navRouteCum = routeLengthTable(pts);
      navRouteTotal = navRouteCum[navRouteCum.length - 1];
      navSteps = steps;
      navStepStarts = stepStarts;
      navBaseDurationSec = baseDurationSec;
      navLastTrafficRatioAvg = await paintRouteTraffic(navRoutePts, navRouteCum, getTransportMode(navTransportMode).trafficMultiplier > 0);
      drawRouteHazards(navDestination, navRoutePts, navRouteCum, navRouteTotal);
      showRouteInfoCard({ mode: navTransportMode, distanceM: navRouteTotal, durationSec: navBaseDurationSec, trafficRatioAvg: navLastTrafficRatioAvg });
      showToast(isReal ? 'Route recalculated' : 'Route recalculated (approximate — offline)');
    } finally {
      navRecalcInFlight = false;
    }
  }

  function updateNavigationProgress(pos){
    if (!navActive || !navRoutePts.length) return;

    const { dist: offsetMeters, along: progressDist } = closestPointOnRoute(pos, navRoutePts, navRouteCum);

    // Heading: derived from the last two real positions, not simulated.
    if (updateNavigationProgress._lastPos) {
      const prev = updateNavigationProgress._lastPos;
      if (map.distance([prev.lat, prev.lng], [pos.lat, pos.lng]) > 2) {
        const heading = Math.atan2(pos.lng - prev.lng, pos.lat - prev.lat) * 180 / Math.PI;
        if (youMarkerArrowEl) youMarkerArrowEl.style.transform = `rotate(${heading}deg)`;
      }
    }
    updateNavigationProgress._lastPos = pos;

    youMarker.setLatLng([pos.lat, pos.lng]);
    liveUserPosition = { lat: pos.lat, lng: pos.lng };

    if (navFollowMode) {
      // The very first live position after the initial route-overview
      // fitBounds() switches to a close, Waze-style follow zoom so turns
      // and street names are actually readable — after that, just pan
      // (don't fight a zoom level the user deliberately changed).
      if (!navHasZoomedIn) {
        navHasZoomedIn = true;
        map.flyTo([pos.lat, pos.lng], NAV_FOLLOW_ZOOM, { animate: true, duration: 0.6 });
      } else {
        map.panTo([pos.lat, pos.lng], { animate: true, duration: 0.4 });
      }
    }

    checkHazardProximity(pos);

    // Off-route: the device has drifted meaningfully from the drawn path
    // (took a different road, missed a turn) — recalculate from here.
    if (offsetMeters > OFF_ROUTE_METERS) {
      const cooledDown = Date.now() - navLastRecalcAt > OFF_ROUTE_RECALC_COOLDOWN_MS;
      if (cooledDown && !navRecalcInFlight) {
        recalculateRoute(pos);
      }
      return;
    }

    const remaining = Math.max(0, navRouteTotal - progressDist);

    // Keep the route info card's distance/time/ETA current as the user
    // actually moves — scaled off the remaining fraction of the route's
    // real routing-engine duration, not re-estimated from scratch, and
    // reusing the last sampled traffic ratio rather than re-querying
    // TomTom on every GPS fix.
    const remainingDurationSec = (navBaseDurationSec && navRouteTotal > 0)
      ? navBaseDurationSec * (remaining / navRouteTotal)
      : null;
    showRouteInfoCard({
      mode: navTransportMode,
      distanceM: remaining,
      durationSec: remainingDurationSec,
      trafficRatioAvg: navLastTrafficRatioAvg
    });

    if (remaining <= ARRIVAL_METERS) {
      const dest = navDestination;
      speedoLabelEl.textContent = 'Arrived';
      speedoSubEl.textContent = dest ? dest.name : '';
      updateNavBanner('You have arrived', dest ? dest.name : '');
      showToast(`Arrived at ${dest ? dest.name : 'your destination'}`);
      currentOriginLocation = dest ? dest.name : currentOriginLocation;
      currentOriginCoords = { lat: pos.lat, lng: pos.lng };
      setTimeout(() => endNavigation(dest), 1400);
      return;
    }

    // Find which step we're currently on and how far to its end.
    let stepIdx = 0;
    for (let i = 0; i < navStepStarts.length; i++){
      if (navStepStarts[i] <= progressDist) stepIdx = i; else break;
    }
    const nextStepIdx = stepIdx + 1;
    const distToNextManeuver = nextStepIdx < navStepStarts.length
      ? Math.max(0, navStepStarts[nextStepIdx] - progressDist)
      : remaining;
    const upcoming = navSteps[nextStepIdx] || navSteps[stepIdx] || { instruction: 'Continue' };
    const distLabel = distToNextManeuver < 1000 ? `${Math.round(distToNextManeuver)} m` : `${(distToNextManeuver / 1000).toFixed(1)} km`;
    const remainLabel = remaining < 1000 ? `${Math.round(remaining)} m` : `${(remaining / 1000).toFixed(1)} km`;
    updateNavBanner(upcoming.instruction, `in ${distLabel} · ${remainLabel} to go`);

    speedoLabelEl.textContent = navDestination ? 'En Route' : speedoLabelEl.textContent;
    speedoSubEl.textContent = navDestination ? navDestination.name : speedoSubEl.textContent;

    const gps = GPSManager.getCurrentLocation();
    if (gps && gps.latitude !== null) {
      speedoLabelEl.textContent = GPSManager.getTrafficStatus(gps.speedKmh).label;
    }
  }

  function drawRouteHazards(dest, pts, cum, total){
    routeHazardMarkers.forEach(m => map.removeLayer(m));
    routeHazardMarkers = [];
    warnedHazardIds.clear();

    const resolvedHazards = dest.hazards.map(h => {
      const pt = pointAtDistance(pts, cum, h.t * total);
      return { ...h, lat: pt.lat, lng: pt.lng };
    });
    resolvedHazards.forEach(h => {
      const icon = L.divIcon({
        className: 'route-hazard-pin',
        html: `<span style="background:${h.color}"></span>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7]
      });
      const marker = L.marker([h.lat, h.lng], { icon }).addTo(map);
      marker.on('click', () => showToast(h.label));
      routeHazardMarkers.push(marker);
    });
    activeRouteHazards = resolvedHazards;
  }

  async function startNavigation(dest){
    navActive = true;
    navDestination = dest;
    navFollowMode = true;
    navHasZoomedIn = false;
    // Lock in whatever mode is selected on the transport-mode buttons at
    // the moment navigation starts. If the user taps a different mode
    // while already navigating, that only affects the *next* route they
    // start — it never silently swaps profiles under an in-progress one,
    // so off-route recalculation stays on the same mode throughout.
    navTransportMode = selectedTransportMode;
    updateNavigationProgress._lastPos = null;
    updateRouteBox(dest.name);
    closeSearchDual();
    showToast(`Finding route to ${dest.name}…`);
    if (legendStripElForNav) legendStripElForNav.style.display = 'none';
    recenterBtn.style.display = 'none';

    // Waze/Google Maps always route from your *actual* current GPS fix,
    // not a stale/default one. If a live fix has already come in via
    // GPSManager's background watch, currentOriginCoords already reflects
    // it (see the GPSManager.onUpdate wiring above) and this is instant.
    // Otherwise — first launch, permission just granted, etc. — request
    // one fresh fix right now instead of silently routing from the
    // provincial-capital fallback.
    if (currentOriginLocation !== 'Current Location') {
      try {
        const coords = await GPSManager.getFreshPosition();
        currentOriginCoords = { lat: coords.latitude, lng: coords.longitude };
        currentOriginLocation = 'Current Location';
        youMarker.setLatLng([coords.latitude, coords.longitude]);
        routeBoxOriginEl.textContent = currentOriginLocation;
      } catch (err) {
        showToast('Could not get your GPS location — routing from the default map center instead.');
      }
    }

    const routeOrigin = { lat: currentOriginCoords.lat, lng: currentOriginCoords.lng };
    const { pts, isReal, steps, stepStarts, baseDurationSec } = await fetchRoadRoute(routeOrigin, dest.latlng, navTransportMode);

    // If the user cancelled navigation (or started routing somewhere else)
    // while this was in flight, don't stomp on whatever's happening now.
    if (!navActive || navDestination !== dest) return;

    navRoutePts = pts;
    navRouteCum = routeLengthTable(pts);
    navRouteTotal = navRouteCum[navRouteCum.length - 1];
    navSteps = steps;
    navStepStarts = stepStarts;
    navBaseDurationSec = baseDurationSec;

    navLastTrafficRatioAvg = await paintRouteTraffic(navRoutePts, navRouteCum, getTransportMode(navTransportMode).trafficMultiplier > 0);
    drawRouteHazards(dest, navRoutePts, navRouteCum, navRouteTotal);
    showNavDestMarker(dest.latlng);
    showRouteInfoCard({ mode: navTransportMode, distanceM: navRouteTotal, durationSec: navBaseDurationSec, trafficRatioAvg: navLastTrafficRatioAvg });

    const hazardNote = activeRouteHazards.length ? ` — ${activeRouteHazards.length} hazard${activeRouteHazards.length>1?'s':''} ahead` : '';
    showToast(
      isReal
        ? `Navigating to ${dest.name} (${(navRouteTotal/1000).toFixed(1)} km via roads)${hazardNote}`
        : `Navigating to ${dest.name} — approximate route (offline)${hazardNote}`
    );

    map.fitBounds(L.latLngBounds(pts.map(p => [p.lat, p.lng])), { padding: [40, 40] });

    speedoCardEl.classList.add('navigating');
    if (youMarkerArrowEl) youMarkerArrowEl.style.opacity = 1;
    speedoLabelEl.textContent = 'En Route';
    speedoSubEl.textContent = dest.name;
    updateNavBanner(navSteps[0] ? navSteps[0].instruction : `Head toward ${dest.name}`, 'Fetching your location…');

    // Render initial progress immediately from whatever position we have
    // (real GPS if already available, otherwise the fallback origin) so
    // the banner/marker aren't blank until the next GPS fix arrives.
    const gps = GPSManager.getCurrentLocation();
    if (gps && gps.latitude !== null) {
      updateNavigationProgress({ lat: gps.latitude, lng: gps.longitude });
    } else {
      showToast('Waiting for GPS to track your position along this route');
      updateNavBanner(navSteps[0] ? navSteps[0].instruction : `Head toward ${dest.name}`, 'Waiting for GPS…');
    }
  }

  // If the user drags the map away from their position while navigating,
  // stop auto-following (so their pan sticks) and offer a way back.
  map.on('dragstart', () => {
    if (navActive) {
      navFollowMode = false;
      recenterBtn.style.display = 'flex';
    }
  });
  recenterBtn.addEventListener('click', () => {
    navFollowMode = true;
    recenterBtn.style.display = 'none';
    map.panTo([liveUserPosition.lat, liveUserPosition.lng], { animate: true });
  });

  speedoCardEl.addEventListener('click', ()=>{
    if(navActive){
      showToast('Navigation cancelled');
      endNavigation();
    }
  });
  navBannerStopBtn.addEventListener('click', () => {
    if (navActive) {
      showToast('Navigation cancelled');
      endNavigation();
    }
  });

  document.getElementById('searchGoBtn').addEventListener('click', ()=>{
    // Previously this fell back to lagunaDestinations[0] whenever nothing
    // matched — so tapping "Show Route" with an empty or unrecognized
    // destination silently routed you to a random place instead of doing
    // nothing or telling you why. Prefer the destination the user actually
    // tapped from the list; only fall back to an exact-text match if
    // they've typed a full name without clicking a suggestion, and refuse
    // (with an explanation) rather than guess if neither is available.
    let dest = selectedDestination;
    const typed = destInput.value.trim().toLowerCase();
    if (!dest || dest.name.toLowerCase() !== typed) {
      dest = livePois.find(d => d.name.toLowerCase() === typed);
    }
    if (!dest) {
      showToast(typed ? 'No matching destination — pick one from the list' : 'Enter or select a destination first');
      return;
    }
    startNavigation(dest);
  });

  /*  Active Hazard Warning Banner — triggered by real proximity between
      the live GPS position and a hazard pin on the active route, from
      checkHazardProximity() above (not a fixed timer). */
  const hazardAlert = document.getElementById('hazardAlert');
  const hazardAlertTitle = document.getElementById('hazardAlertTitle');
  const hazardAlertSub = document.getElementById('hazardAlertSub');
  let hazardHideTimer;

  function showHazardAlert(label, meters){
    const distText = typeof meters === 'number'
      ? (meters < 1000 ? `${Math.round(meters)}m` : `${(meters/1000).toFixed(1)}km`)
      : 'approx. 200m';
    hazardAlertTitle.textContent = 'Hazard ahead';
    hazardAlertSub.textContent = `${label} · ${distText}`;
    hazardAlert.classList.add('show');
    clearTimeout(hazardHideTimer);
    hazardHideTimer = setTimeout(()=> hazardAlert.classList.remove('show'), 5000);
  }
  document.getElementById('hazardAlertClose').addEventListener('click', ()=>{
    hazardAlert.classList.remove('show');
    clearTimeout(hazardHideTimer);
  });

  /*  Map Panning / Zooming  */
  /*   Leaflet handles drag-to-pan, pinch/scroll-to-zoom, and inertia
     natively — no custom drag-handling code needed here anymore. */

/*  INIT  */

const savedMapDownloaded =
    BiyaStorage.load(
        BiyaStorage.keys.mapDownloaded,
        false
    );

if (savedMapDownloaded) {

    mapStorageFill.style.width = '100%';

    mapStorageSize.textContent = mapStorageLabel();

} else {

    mapStorageFill.style.width = '0%';

    mapStorageSize.textContent =
        '0 MB · Not downloaded';
}

applyNetworkState();

renderSyncQueue();

updateRouteBox(null);

// Restore saved hazard pins
restoreDynamicHazards();

// Restore the latest GPS data while waiting for a fresh reading
const savedGPS =
    BiyaStorage.load(
        BiyaStorage.keys.gpsData,
        null
    );

if (savedGPS) {

    GPSManager.currentPosition =
        savedGPS;

    GPSManager.updateInterface();
}

/* Restore a persisted login session, if any. Supabase's client keeps its
   own session token in localStorage and rehydrates it for us here — this
   app no longer tracks "is someone logged in" itself, it just asks
   Supabase. Skip the auth screen entirely for a returning user who has
   already downloaded the offline map; otherwise still send them to the
   download stage (first login on a new or cleared device). Runs
   asynchronously so it never blocks the rest of this synchronous init.

   getSession() is normally local-only (reads the cached token straight
   from localStorage, no network needed) EXCEPT when that token has
   actually expired, in which case it tries a network call to refresh it
   first. If the device is offline at exactly that moment, this fails —
   a real, unavoidable limitation of expiring-JWT auth (there's no way to
   safely verify an expired token without a server, offline or not,
   without weakening the security model). The 5s timeout below just makes
   sure that failure is fast and visible (falls back to the login screen,
   same as a first-time launch) instead of leaving the app hung on
   whatever it was showing while a doomed fetch tries to resolve. */
if (supabaseClient) {
    const sessionRestoreTimeout = new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 5000));
    Promise.race([supabaseClient.auth.getSession(), sessionRestoreTimeout])
      .then(async (result) => {
        if (result.timedOut) {
            console.warn('Session restore timed out (offline with an expired token?) — showing the login screen.');
            return;
        }
        const { data, error } = result;
        if (error || !data.session) return;

        const user = data.session.user;
        const name = (user.user_metadata && user.user_metadata.name) || user.email.split('@')[0];
        currentUser = { id: user.id, name, email: user.email };
        document.getElementById('acctName').textContent = currentUser.name;
        document.getElementById('acctEmail').textContent = currentUser.email;

        await refreshCurrentUserRole();

        // Same disabled-account check as attemptLogin(): a session
        // restored from a previous login (e.g. reopening the installed
        // app) must not skip this just because it never went through the
        // login form this time around.
        if (currentUser && currentUser.status === 'disabled') {
            await supabaseClient.auth.signOut();
            currentUser = null;
            showStage('stage-auth');
            document.getElementById('loginError').textContent = 'This account has been disabled. Contact an administrator.';
            document.getElementById('loginError').classList.add('show');
            return;
        }

        loadLivePois();

        if (savedMapDownloaded) {
            showStage('stage-app');
            resetOriginState();
            GPSManager.start();
            showToast(`Welcome back, ${currentUser.name.split(' ')[0]}!`);
            applyLaunchParams();
        } else {
            enterDownloadStage(currentUser.name, currentUser.email);
        }
      })
      .catch((err) => {
        // Belt-and-suspenders: if getSession() itself rejects outright
        // (rather than resolving with an {error} field) — some network
        // stacks do throw on a hard connection failure mid-refresh —
        // the user is simply left on the login screen (the default
        // visible stage in the raw HTML) rather than an unhandled
        // rejection silently doing nothing.
        console.warn('Session restore failed:', err && err.message);
      });
}

})();