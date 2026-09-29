// Offline cache for the app shell and face models (map tiles still need internet).
const CACHE = 'saferoute-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icon.svg',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/face-api.js',
  'models/tiny_face_detector_model-weights_manifest.json', 'models/tiny_face_detector_model.bin',
  'models/face_landmark_68_tiny_model-weights_manifest.json', 'models/face_landmark_68_tiny_model.bin',
  'models/face_recognition_model-weights_manifest.json', 'models/face_recognition_model.bin'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
