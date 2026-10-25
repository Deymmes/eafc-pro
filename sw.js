/* Service Worker - EA FC Pro
   Estratégia: stale-while-revalidate para arquivos do próprio site.
   Aumente VERSAO a cada publicação para forçar atualização do cache. */
const VERSAO = 'eafc-pro-v6';
const SHELL = ['./', 'index.html', 'style.css', 'config.js', 'logic.js', 'app.js', 'manifest.json', 'icon.png', 'telainicial.jpg'];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(VERSAO).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => { })))));
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSAO).map(k => caches.delete(k)))));
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;   // Firebase/CDN passam direto
    e.respondWith(
        caches.open(VERSAO).then(async (cache) => {
            const emCache = await cache.match(req);
            const rede = fetch(req).then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => emCache);
            return emCache || rede;
        })
    );
});
