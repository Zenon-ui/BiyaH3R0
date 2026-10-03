// copy-vendor.mjs
// ---------------------------------------------------------------------------
// Copies Leaflet + Supabase into ./vendor so the app can start with NO internet.
// (index.html used to load them from unpkg.com; with no connection those
// <script> tags fail, `L` / `supabase` stay undefined, and the whole app dies.)
//
// Run from your project root (the folder that contains index.html):
//
//     npm install leaflet@1.9.4 @supabase/supabase-js@2
//     node copy-vendor.mjs
//
// It writes to BOTH:
//   ./vendor/         -> used when you serve the folder directly (plain web)
//   ./public/vendor/  -> copied as-is into dist/ by Vite (your Capacitor build).
//                        Vite never copies classic <script src> files on its own,
//                        which is why they must live in public/.
// Re-run after upgrading either package.
// ---------------------------------------------------------------------------
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ITEMS = [
  { from: 'node_modules/leaflet/dist/leaflet.js',                    to: 'leaflet/leaflet.js' },
  { from: 'node_modules/leaflet/dist/leaflet.css',                   to: 'leaflet/leaflet.css' },
  { from: 'node_modules/leaflet/dist/images',                        to: 'leaflet/images' },
  { from: 'node_modules/@supabase/supabase-js/dist/umd/supabase.js', to: 'supabase/supabase.js' }
];
const DESTS = ['vendor', join('public', 'vendor')];

const missing = ITEMS.filter(i => !existsSync(i.from));
if (missing.length) {
  console.error('Missing files:\n  ' + missing.map(m => m.from).join('\n  '));
  console.error('\nInstall the packages first:\n  npm install leaflet@1.9.4 @supabase/supabase-js@2');
  process.exit(1);
}

for (const dest of DESTS) {
  for (const item of ITEMS) {
    const target = join(dest, item.to);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(item.from, target, { recursive: true });
  }
  console.log('copied ->', dest);
}
console.log('\nDone. Rebuild with:  npm run build && npx cap sync android');
