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
        gpsData: "biyahero_last_gps"
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

  // Auth tab switching
  const authTabs = document.querySelectorAll('.auth-tab');
  const loginForm = document.getElementById('loginForm');
  const signupForm = document.getElementById('signupForm');
  const authSwitchLine = document.getElementById('authSwitchLine');
  const authSwitchLink = document.getElementById('authSwitchLink');

  function setAuthMode(mode){
    authTabs.forEach(t => t.classList.toggle('active', t.dataset.authtab === mode));
    loginForm.style.display = mode === 'login' ? 'block' : 'none';
    signupForm.style.display = mode === 'signup' ? 'block' : 'none';
    authSwitchLine.innerHTML = mode === 'login'
      ? `Don't have an account? <b id="authSwitchLink">Sign up</b>`
      : `Already have an account? <b id="authSwitchLink">Log in</b>`;
    document.getElementById('authSwitchLink').addEventListener('click', ()=>{
      setAuthMode(mode === 'login' ? 'signup' : 'login');
    });
  }
  authTabs.forEach(tab => tab.addEventListener('click', () => setAuthMode(tab.dataset.authtab)));
  authSwitchLink.addEventListener('click', () => setAuthMode('signup'));

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
     - Password must be 6+ chars and include a special character
     These mirror the checks a well-built backend should also make;
     see supabase-setup.sql for the optional server-side Gmail hook.
     ============================================================ */
  const GMAIL_ONLY_REGEX = /^[^\s@]+@gmail\.com$/i;
  const SPECIAL_CHAR_REGEX = /[!@#$%^&*(),.?":{}|<>_\-\[\]\\/;'`~+=]/;

  function isGmailAddress(email){
    return GMAIL_ONLY_REGEX.test(email);
  }

  function passwordIssue(pass){
    if(pass.length < 6) return 'Password must be at least 6 characters.';
    if(!SPECIAL_CHAR_REGEX.test(pass)) return 'Password must contain at least one special character (e.g. ! @ # $ %).';
    return null;
  }

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

    err.classList.remove('show');
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = 'Logging in…';

    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email,
      password: pass
    });

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

    err.classList.remove('show');
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = 'Creating account…';

    const { data, error } = await supabaseClient.auth.signUp({
      email,
      password: pass,
      options: { data: { name } }
    });

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

    // Depends on your Supabase project's Auth setting for "Confirm email":
    // ON  -> data.session is null; user must click the emailed link first.
    // OFF -> a session comes back immediately, same as the old demo flow.
    if(!data.session){
      showToast(`Account created! Check ${email} to confirm, then log in.`);
      setAuthMode('login');
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
    ['loginEmail','loginPassword','signupName','signupEmail','signupPassword','signupConfirmPassword'].forEach(id=>{
      document.getElementById(id).value = '';
    });
    document.getElementById('loginError').classList.remove('show');
    document.getElementById('signupError').classList.remove('show');
    setAuthMode('login');
    showStage('stage-auth');
    // Reset the sequential origin state — only logging out resets back to Place 1
    resetOriginState();
    showToast('Logged out');
  });

  /*  Theme  */
  const root = document.documentElement;
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  const darkModeSwitch = document.getElementById('darkModeSwitch');

  function setTheme(theme){
    root.setAttribute('data-theme', theme);
    darkModeSwitch.checked = theme === 'dark';
  }
  themeToggleBtn.addEventListener('click', ()=>{
    setTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });
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

  function syncNow() {

    if (!isOnline || !pendingReports.length) {
        return;
    }

    const count =
        pendingReports.length;

    // Prototype sync — reports are just marked as uploaded here; a real
    // version would send them to an API or server
    pendingReports = [];

    savePendingReports();

    dynamicHazards = dynamicHazards.map(
        hazard => ({
            ...hazard,
            syncStatus: 'synced'
        })
    );

    saveDynamicHazards();

    renderSyncQueue();

    showToast(
        `${count} report${count > 1 ? 's' : ''} synced successfully`
    );
}

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
    { name: 'Santa Cruz Public Market', sub: 'Santa Cruz, Laguna (provincial capital)', category: 'City Center',
      latlng: { lat: 14.2814, lng: 121.4157 }, hazards: [] },
    { name: 'SM City Santa Rosa', sub: 'Santa Rosa City, Laguna', category: 'Mall',
      latlng: { lat: 14.3123, lng: 121.0947 },
      hazards: [ { t:0.55, label:'Pothole · reported 12m ago', color:'var(--status-red)' } ] },
    { name: 'Calamba City Hall', sub: 'Calamba City, Laguna', category: 'City Center',
      latlng: { lat: 14.2117, lng: 121.1653 },
      hazards: [ { t:0.65, label:'Flooded street · knee-deep', color:'var(--gold)' }, { t:0.85, label:'Road construction ahead', color:'var(--status-yellow)' } ] },
    { name: 'San Pablo City Plaza', sub: 'San Pablo City, Laguna', category: 'City Center',
      latlng: { lat: 14.0703, lng: 121.3256 },
      hazards: [ { t:0.5, label:'Road bump · uneven pavement', color:'var(--status-yellow)' } ] },
    { name: 'Biñan City Hall', sub: 'Biñan City, Laguna', category: 'City Center',
      latlng: { lat: 14.3426, lng: 121.0839 }, hazards: [] },
    { name: 'Cabuyao City Hall', sub: 'Cabuyao City, Laguna', category: 'City Center',
      latlng: { lat: 14.2776, lng: 121.1250 }, hazards: [] },
    { name: 'Los Baños Municipal Hall', sub: 'Los Baños, Laguna', category: 'City Center',
      latlng: { lat: 14.1700, lng: 121.2237 }, hazards: [] },
    { name: 'Sta. Rosa Tagaytay Road', sub: 'Santa Rosa City, Laguna', category: 'Road',
      latlng: { lat: 14.2870, lng: 121.0890 }, hazards: [] },

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
    { name: 'San Pablo City Hall', sub: 'San Pablo City, Laguna', category: 'Government',
      latlng: { lat: 14.070007, lng: 121.325681 }, hazards: [] },
    { name: 'SM City San Pablo', sub: 'Maharlika Highway, Brgy. San Rafael, San Pablo City', category: 'Mall',
      latlng: { lat: 14.07145, lng: 121.30177 }, hazards: [] },
    { name: 'San Pablo City Science Integrated High School', sub: 'San Pablo City, Laguna', category: 'School',
      latlng: { lat: 14.06452, lng: 121.34254 }, hazards: [] },
    { name: 'San Pablo City National High School', sub: 'Brgy. VI-D, San Pablo City, Laguna', category: 'School',
      latlng: { lat: 14.07673, lng: 121.32092 }, hazards: [] },
    { name: 'San Pablo District Hospital', sub: 'San Pablo City, Laguna (approx. — near Sampaloc Lake)', category: 'Hospital',
      latlng: { lat: 14.0775, lng: 121.3260 }, hazards: [] },

    // ---- Roads / highway waypoints ----
    { name: 'SLEX Santa Rosa Exit', sub: 'South Luzon Expressway, Santa Rosa City', category: 'Highway',
      latlng: { lat: 14.3010, lng: 121.0850 }, hazards: [] },
    { name: 'SLEX Calamba Exit', sub: 'South Luzon Expressway, Calamba City', category: 'Highway',
      latlng: { lat: 14.2250, lng: 121.1400 }, hazards: [] },
    { name: 'Manila South Road, San Pablo', sub: 'National Highway, San Pablo City', category: 'Highway',
      latlng: { lat: 14.0850, lng: 121.3100 }, hazards: [] }
  ];

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
    'City Center': '<path d="M5 3v18"/><path d="M5 4h11l-2.2 3.5L16 11H5"/>'
  };
  const POI_COLOR_VAR = {
    Hospital: '--poi-hospital', Church: '--poi-church', School: '--poi-school',
    University: '--poi-school', Police: '--poi-police', 'Fire Station': '--poi-fire',
    'Gas Station': '--poi-fuel', Government: '--poi-gov', Terminal: '--poi-terminal',
    Mall: '--poi-mall', 'Theme Park': '--poi-mall', Landmark: '--poi-landmark',
    'City Center': '--poi-city'
  };
  // Below zoom 13 nothing shows (province-wide view is for the route line
  // and hazards, not landmark browsing); 13-14 shows only the "find your
  // way around town" majors; 15+ adds the finer-grained everyday POIs;
  // 17+ also reveals name labels. This is what keeps a dense area like
  // San Pablo City from turning into a wall of overlapping icons when
  // zoomed out.
  const POI_ZOOM_MIN = 13;
  const POI_MAJOR_CATEGORIES = ['City Center', 'Mall', 'Government', 'Hospital', 'University', 'Theme Park', 'Terminal', 'Landmark'];
  const poiLayerGroup = L.layerGroup().addTo(map);
  const poiEntries = lagunaDestinations.filter(d => POI_ICON_SVG[d.category]);

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
    searchBarEl.classList.add('expanded');
    searchDual.classList.add('open');
    originInput.value = currentOriginLocation;
    renderSuggestions(lagunaDestinations);
    destInput.focus();
  }
  function closeSearchDual(){
    searchBarEl.classList.remove('expanded');
    searchDual.classList.remove('open');
  }
  searchBarEl.addEventListener('click', openSearchDual);
  document.getElementById('searchCancelBtn').addEventListener('click', closeSearchDual);

  let selectedDestination = null;

  function renderSuggestions(list){
    searchSuggestions.innerHTML = list.map((d,i)=>`
      <div class="search-suggest-item" data-i="${i}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>
        <div><div class="search-suggest-title">${d.name}</div><div class="search-suggest-sub">${d.sub} · ${distanceLabel(d.latlng)} away</div></div>
      </div>
    `).join('');
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
    const q = destInput.value.trim().toLowerCase();
    renderSuggestions(q ? lagunaDestinations.filter(d => d.name.toLowerCase().includes(q)) : lagunaDestinations);
  });

  let activeRouteHazards = [];
  let routeLine = null; // L.polyline OR L.layerGroup (traffic-colored segments)
  let routeHazardMarkers = [];
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

    if(youMarkerArrowEl) youMarkerArrowEl.style.opacity = 0;
    speedoCardEl.classList.remove('navigating');
    speedoRingEl.style.background = '';

    navBannerEl.classList.remove('show');
    recenterBtn.style.display = 'none';
    trafficLegendEl.style.display = 'none';
    if (legendStripElForNav) legendStripElForNav.style.display = '';

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
  const OSRM_ROUTE_BASE = 'https://router.project-osrm.org/route/v1/driving/';
  const OSRM_TIMEOUT_MS = 6000;

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

  async function fetchRoadRoute(origin, dest){
    if (!navigator.onLine) {
      return { pts: buildRouteLatLngs(origin, dest), isReal: false, steps: [], stepStarts: [] };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OSRM_TIMEOUT_MS);
    try {
      const url = `${OSRM_ROUTE_BASE}${origin.lng},${origin.lat};${dest.lng},${dest.lat}` +
        `?overview=full&geometries=geojson&steps=true&alternatives=true`;
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) throw new Error(`OSRM responded ${resp.status}`);
      const data = await resp.json();
      if (!data || data.code !== 'Ok' || !data.routes || !data.routes.length) {
        throw new Error('OSRM returned no usable route');
      }
      // When multiple candidate routes come back, pick the one to use.
      // With no live traffic feed there's nothing meaningful to compare
      // them on beyond OSRM's own ranking, so the first (fastest) route
      // is used — see chooseBestRoute() below for the traffic-aware path.
      const chosen = await chooseBestRoute(data.routes);
      const coords = chosen.geometry && chosen.geometry.coordinates;
      if (!coords || coords.length < 2) throw new Error('OSRM returned no usable geometry');
      // GeoJSON coordinates are [lng, lat] — flip to the {lat,lng} shape
      // the rest of this file (routeLengthTable, pointAtDistance, etc.)
      // already works with, regardless of where the points came from.
      const pts = coords.map(([lng, lat]) => ({ lat, lng }));
      const leg = chosen.legs && chosen.legs[0];
      const { steps, starts } = buildStepList(leg && leg.steps);
      return { pts, isReal: true, steps, stepStarts: starts };
    } catch (err) {
      console.warn('Road routing unavailable, using approximate route:', err.message || err);
      return { pts: buildRouteLatLngs(origin, dest), isReal: false, steps: [], stepStarts: [] };
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
  async function chooseBestRoute(routes){
    if (routes.length === 1 || !(typeof TrafficConfig !== 'undefined' && TrafficConfig.enabled) || !navigator.onLine) {
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

  // Paints the route polyline. With a traffic key configured (and online),
  // it's split into colored segments sampled from real TomTom flow data;
  // otherwise it's a single neutral-colored line — never a fake pattern.
  async function paintRouteTraffic(pts, cum){
    if (routeLine) { map.removeLayer(routeLine); routeLine = null; }

    if (!(typeof TrafficConfig !== 'undefined' && TrafficConfig.enabled) || !navigator.onLine) {
      routeLine = L.polyline(pts.map(p => [p.lat, p.lng]), {
        color: '#17B893', weight: 5, opacity: 0.9
      }).addTo(map);
      trafficLegendEl.style.display = 'none';
      return;
    }

    const total = cum[cum.length - 1];
    const SAMPLE_EVERY_M = 600;
    const sampleCount = Math.max(2, Math.min(16, Math.round(total / SAMPLE_EVERY_M) + 1));
    const sampleDists = Array.from({ length: sampleCount }, (_, i) => (i / (sampleCount - 1)) * total);
    const samplePts = sampleDists.map(d => pointAtDistance(pts, cum, d));
    const ratios = await Promise.all(samplePts.map(p => fetchTomTomFlowRatio(p.lat, p.lng)));

    const group = L.layerGroup();
    // Draw one polyline per sample interval, colored by that interval's ratio.
    for (let i = 0; i < sampleDists.length - 1; i++){
      const from = sampleDists[i], to = sampleDists[i + 1];
      const segPts = [];
      const STEP = Math.max(20, (to - from) / 10);
      for (let d = from; d <= to; d += STEP) segPts.push(pointAtDistance(pts, cum, d));
      segPts.push(pointAtDistance(pts, cum, to));
      const cls = classifyTrafficRatio(ratios[i]);
      const color = cls ? cls.color : '#3E7BFA';
      L.polyline(segPts.map(p => [p.lat, p.lng]), { color, weight: 5, opacity: 0.9 }).addTo(group);
    }
    group.addTo(map);
    routeLine = group;
    trafficLegendEl.style.display = 'flex';
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
      const { pts, isReal, steps, stepStarts } = await fetchRoadRoute(pos, navDestination.latlng);
      if (!navActive) return;
      navRoutePts = pts;
      navRouteCum = routeLengthTable(pts);
      navRouteTotal = navRouteCum[navRouteCum.length - 1];
      navSteps = steps;
      navStepStarts = stepStarts;
      await paintRouteTraffic(navRoutePts, navRouteCum);
      drawRouteHazards(navDestination, navRoutePts, navRouteCum, navRouteTotal);
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
      map.panTo([pos.lat, pos.lng], { animate: true, duration: 0.4 });
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
    updateNavigationProgress._lastPos = null;
    updateRouteBox(dest.name);
    closeSearchDual();
    showToast(`Finding route to ${dest.name}…`);
    if (legendStripElForNav) legendStripElForNav.style.display = 'none';
    recenterBtn.style.display = 'none';

    const routeOrigin = { lat: currentOriginCoords.lat, lng: currentOriginCoords.lng };
    const { pts, isReal, steps, stepStarts } = await fetchRoadRoute(routeOrigin, dest.latlng);

    // If the user cancelled navigation (or started routing somewhere else)
    // while this was in flight, don't stomp on whatever's happening now.
    if (!navActive || navDestination !== dest) return;

    navRoutePts = pts;
    navRouteCum = routeLengthTable(pts);
    navRouteTotal = navRouteCum[navRouteCum.length - 1];
    navSteps = steps;
    navStepStarts = stepStarts;

    await paintRouteTraffic(navRoutePts, navRouteCum);
    drawRouteHazards(dest, navRoutePts, navRouteCum, navRouteTotal);

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
      dest = lagunaDestinations.find(d => d.name.toLowerCase() === typed);
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
   asynchronously so it never blocks the rest of this synchronous init. */
if (supabaseClient) {
    supabaseClient.auth.getSession().then(({ data, error }) => {
        if (error || !data.session) return;

        const user = data.session.user;
        const name = (user.user_metadata && user.user_metadata.name) || user.email.split('@')[0];
        currentUser = { id: user.id, name, email: user.email };
        document.getElementById('acctName').textContent = currentUser.name;
        document.getElementById('acctEmail').textContent = currentUser.email;

        if (savedMapDownloaded) {
            showStage('stage-app');
            resetOriginState();
            GPSManager.start();
            showToast(`Welcome back, ${currentUser.name.split(' ')[0]}!`);
            applyLaunchParams();
        } else {
            enterDownloadStage(currentUser.name, currentUser.email);
        }
    });
}

})();