// ============================================================
// BiyaHERO offline routing database
// ============================================================
// Loads the bundled Laguna-area road graph (laguna_routing.db —
// nodes + edges; see AStarRouter.js for how it's used) for on-device A*
// pathfinding when there's no signal for OSRM.
//
// --- Why this file changed ---
// @capacitor-community/sqlite is a NATIVE plugin: it only exists inside a
// real Capacitor app shell (Android/iOS), never in a plain browser tab or
// a desktop preview of index.html. This file used to `import … from
// '@capacitor-community/sqlite'` as a static, top-of-file import. That's a
// bare npm specifier — browsers can't resolve it without a bundler, and
// this project ships its other two dependencies (Leaflet, supabase-js) as
// plain CDN <script> tags rather than a bundled build. A static import
// like that throws "Failed to resolve module specifier" the instant this
// file loads — and since BiyaHERO.js does `import './RoutingDatabase.js'`
// at its own top, that failure took the ENTIRE app down (map, routing,
// everything) on every platform, not just the ones where the plugin is
// genuinely unavailable.
//
// Fix: import the plugin dynamically, and only after confirming we're
// actually running inside a native Capacitor shell (`window.Capacitor` is
// injected automatically by the native bridge before page scripts run —
// nothing else to wire up). This is Capacitor's own documented pattern for
// a native-only plugin that also needs to run on the web. Everywhere else
// (browser tab, desktop testing, a plain PWA install) initDb() now simply
// no-ops and getDb() stays null. That was already the exact condition
// BiyaHERO.js's routing code treats as "offline routing falls back to the
// approximate curved route" (see fetchRoadRoute() in BiyaHERO.js) — so
// behavior for every existing feature is unchanged, this just stops a
// missing native plugin from crashing the app to get there.
//
// (If the Android build for this project doesn't already run through a
// bundler such as esbuild/vite/webpack before `npx cap sync`, add one —
// @capacitor-community/sqlite needs it to actually resolve at runtime on
// native too. Either way, this change is what stops that dependency from
// silently breaking every other feature in the meantime.)

let db = null;

function isNativePlatform() {
  return !!(
    window.Capacitor &&
    typeof window.Capacitor.isNativePlatform === 'function' &&
    window.Capacitor.isNativePlatform()
  );
}

async function initDb() {
    if (!isNativePlatform()) {
        console.info(
            '[BiyaHERO] Not running inside the native app shell — skipping the ' +
            'on-device routing database. Offline routing will use the approximate ' +
            'fallback route instead of on-device A*.'
        );
        return null;
    }

    try {
        const { CapacitorSQLite, SQLiteConnection } = await import('@capacitor-community/sqlite');
        const sqlite = new SQLiteConnection(CapacitorSQLite);

        await sqlite.copyFromAssets();

        db = await sqlite.createConnection(
            'laguna_routing',
            false,
            'no-encryption',
            1,
            false
        );

        await db.open();

        const result = await db.query(
            'SELECT COUNT(*) as count FROM edges'
        );

        console.log('[BiyaHERO] Routing database loaded:', result.values);

        return db;
    } catch (error) {
        console.error('[BiyaHERO] Failed to initialize routing database:', error);
        db = null;
        return null;
    }
}

window.RoutingDatabase = {
    initDb,
    getDb: () => db
};
