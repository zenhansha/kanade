// Service Worker：アプリ本体をキャッシュして、オフラインでも起動できるようにする
// 方針：ネットにつながっていれば最新を取りに行き（更新がすぐ反映される）、つながらなければキャッシュを使う。
// 高音質音源（CDN の大きなファイル）は一度取ったらキャッシュ優先。
const APP = 'kanade-app-v1';
const SOUNDS = 'kanade-sounds-v1';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css', 'fonts/Bravura.woff2', 'icons/icon.svg', 'icons/icon-192.png',
  'js/main.js', 'js/app.js', 'js/smufl.js', 'js/midi.js',
  'js/core/music.js', 'js/core/score.js', 'js/core/edit.js', 'js/core/history.js',
  'js/engrave/layout.js', 'js/ui/view.js', 'js/ui/palette.js', 'js/ui/piano.js', 'js/ui/dialogs.js', 'js/ui/keys.js',
  'js/audio/synth.js', 'js/audio/player.js', 'js/io/storage.js', 'js/io/musicxml.js', 'js/io/xml.js', 'js/io/mxl.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== APP && k !== SOUNDS).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.open(SOUNDS).then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(APP).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
