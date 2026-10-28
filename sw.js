/* TUTTOBON CON TE PWA V3.74 — shell aggiornata offline; non servire più la vecchia pagina base. */
const CACHE_PREFIX = 'tuttobon-con-te-shell-';
const CACHE_NAME = CACHE_PREFIX + 'v3.74';
const APP_PATH = './index.html';
const MANIFEST_PATH = './manifest.webmanifest';
const OPTIONAL_SHELL = [MANIFEST_PATH, './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // La pagina canonica deve essere salvata: senza questa copia non si dichiara pronto l'aggiornamento.
    const appUrl = new URL(APP_PATH, self.registration.scope).href;
    const response = await fetch(appUrl, {cache: 'no-store'});
    if (!response.ok) throw new Error('Impossibile precaricare index.html');
    await cache.put(appUrl, response.clone());
    // Le risorse opzionali non devono impedire l'installazione della shell.
    await Promise.allSettled(OPTIONAL_SHELL.map(async path => {
      const url = new URL(path, self.registration.scope).href;
      const r = await fetch(url, {cache: 'no-store'});
      if (r.ok) await cache.put(url, r.clone());
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

async function fetchWithTimeout(request, ms = 2600) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fetch(request, {signal: controller.signal, cache: 'no-store'}); }
  finally { clearTimeout(timer); }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Mai intercettare API, login, token, dati personali o file privati.
  if (url.pathname.includes('/api/') || /identitytoolkit|securetoken|firestore|firebaseio|workers\.dev|googleapis\.com\/identity/i.test(url.href)) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const appUrl = new URL(APP_PATH, self.registration.scope).href;
      try {
        // Tutte le vecchie URL di avvio (anche quelle della versione base) vengono indirizzate alla shell corrente.
        const response = await fetchWithTimeout(new Request(appUrl, {method:'GET', credentials:'same-origin'}), 2600);
        if (response && response.ok) { await cache.put(appUrl, response.clone()); return response; }
      } catch (_) {}
      const latest = await cache.match(appUrl);
      if (latest) return latest;
      return new Response('<!doctype html><html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TUTTOBON CON TE</title><body style="font-family:system-ui;padding:24px"><h2>TUTTOBON CON TE</h2><p>La versione aggiornata non è ancora stata salvata su questo telefono. Collegati una volta a Internet, apri l’app e attendi l’aggiornamento; poi potrai riaprirla offline.</p></body></html>', {status:503,headers:{'Content-Type':'text/html; charset=utf-8'}});
    })());
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  const scriptAsset = req.destination === 'script';
  if (!sameOrigin && !scriptAsset) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    // Script: tenta rete con timeout, poi usa la copia precedente per permettere l'avvio offline.
    if (scriptAsset) {
      try { const r = await fetchWithTimeout(req, 2600); if (r && (r.ok || r.type === 'opaque')) { try { await cache.put(req, r.clone()); } catch (_) {} return r; } } catch (_) {}
      if (cached) return cached;
      return fetch(req);
    }
    // Altre risorse locali: rete prima, cache come ripiego.
    try { const r = await fetchWithTimeout(req, 2600); if (r && r.ok) { try { await cache.put(req, r.clone()); } catch (_) {} return r; } } catch (_) {}
    if (cached) return cached;
    return new Response('Risorsa non disponibile offline.', {status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
  })());
});
