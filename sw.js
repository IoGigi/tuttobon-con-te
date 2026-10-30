/* TUTTOBON CON TE — Service Worker V3.97
   Cache PWA + sincronizzazione sicura della coda cassa offline in background. */
'use strict';

const SHELL_CACHE = 'tb-con-te-shell-v3-97';
const OFFLINE_DB = 'tuttobon-con-te-offline-v2';
const DB_VERSION = 2;
const SYNC_TAG = 'tb-checkout-sync';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];
const EXTERNAL_SCRIPTS = [
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js',
  'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    for (const file of SHELL_FILES) {
      try { await cache.add(new Request(file, { cache: 'reload' })); }
      catch (error) { /* l'installazione non deve fallire per una risorsa assente */ }
    }
    for (const file of EXTERNAL_SCRIPTS) {
      try {
        const request = new Request(file, { mode: 'no-cors', cache: 'reload' });
        const response = await fetch(request);
        if (response) await cache.put(request, response);
      } catch (error) { /* se il CDN non risponde, conserva l'eventuale cache precedente */ }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('tb-con-te-shell-') && key !== SHELL_CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET') return;
  if (EXTERNAL_SCRIPTS.includes(request.url)) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response) { try { await cache.put(request, response.clone()); } catch (error) {} }
      return response;
    })());
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: 'no-cache' });
        if (response && response.ok) {
          const cache = await caches.open(SHELL_CACHE);
          await cache.put('./index.html', response.clone());
        }
        return response;
      } catch (error) {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match(request)) || (await cache.match('./index.html')) || new Response('TUTTOBON con te non è disponibile offline. Apri prima l’app con Internet.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }
  if (url.pathname.endsWith('/manifest.webmanifest') || /\/icons\/icon-(192|512)\.png$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const response = await fetch(request);
        if (response && response.ok) { await cache.put(request, response.clone()); return response; }
      } catch (error) { /* fallback cache */ }
      return (await cache.match(request)) || new Response('', { status: 503 });
    })());
  }
});

function openOfflineDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots');
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('auth')) db.createObjectStore('auth');
      if (!db.objectStoreNames.contains('locks')) db.createObjectStore('locks');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Database offline occupato da una vecchia pagina aperta.'));
  });
}

async function readStore(name, key) {
  const db = await openOfflineDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(name, 'readonly');
      const request = key === undefined ? tx.objectStore(name).getAll() : tx.objectStore(name).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

async function writeStore(name, value, key) {
  const db = await openOfflineDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(name, 'readwrite');
      if (key === undefined) tx.objectStore(name).put(value);
      else tx.objectStore(name).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Scrittura IndexedDB interrotta'));
    });
  } finally { db.close(); }
}

async function deleteQueueEntry(id) {
  const db = await openOfflineDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('queue', 'readwrite');
      tx.objectStore('queue').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Eliminazione coda interrotta'));
    });
  } finally { db.close(); }
}

async function acquireLock(owner) {
  const db = await openOfflineDb();
  try {
    return await new Promise((resolve, reject) => {
      let acquired = false;
      const tx = db.transaction('locks', 'readwrite');
      const store = tx.objectStore('locks');
      const request = store.get('checkout-sync');
      request.onsuccess = () => {
        const current = request.result;
        if (!current || Number(current.expiresAt) < Date.now() || current.owner === owner) {
          store.put({ owner, expiresAt: Date.now() + 120000 }, 'checkout-sync');
          acquired = true;
        }
      };
      tx.oncomplete = () => resolve(acquired);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Blocco sincronizzazione interrotto'));
    });
  } finally { db.close(); }
}

async function releaseLock(owner) {
  const db = await openOfflineDb();
  try {
    await new Promise(resolve => {
      const tx = db.transaction('locks', 'readwrite');
      const store = tx.objectStore('locks');
      const request = store.get('checkout-sync');
      request.onsuccess = () => { if (request.result && request.result.owner === owner) store.delete('checkout-sync'); };
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
    });
  } finally { db.close(); }
}

async function refreshFirebaseToken(auth) {
  if (!auth || !auth.apiKey || !auth.refreshToken) throw new Error('Credenziali background non disponibili.');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: auth.refreshToken });
  const response = await fetch('https://securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(auth.apiKey), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id_token) throw new Error(data.error?.message || 'Rinnovo autenticazione Firebase non riuscito.');
  const updated = { ...auth, uid: data.user_id || auth.uid, refreshToken: data.refresh_token || auth.refreshToken, updatedAt: Date.now() };
  await writeStore('auth', updated, 'current');
  return { auth: updated, idToken: data.id_token };
}

async function syncOfflineCheckouts() {
  const owner = 'sw-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  if (!(await acquireLock(owner))) return;
  let shouldRetry = false;
  try {
    let auth = await readStore('auth', 'current');
    if (!auth || !auth.uid || !auth.apiUrl) return;
    const queue = (await readStore('queue')).filter(item => item && item.uid === auth.uid && item.status === 'pending').sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
    if (!queue.length) return;

    let tokenData = await refreshFirebaseToken(auth);
    auth = tokenData.auth;
    let completed = 0;
    let blocked = false;

    for (const entry of queue) {
      let response;
      try {
        response = await fetch(auth.apiUrl + entry.path, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + tokenData.idToken, 'Content-Type': 'application/json' },
          body: JSON.stringify(entry.body),
          cache: 'no-store'
        });
      } catch (error) {
        shouldRetry = true;
        throw error;
      }

      const result = await response.json().catch(() => ({}));
      if (response.ok && result.success !== false) {
        await deleteQueueEntry(entry.id);
        completed++;
        continue;
      }

      if (response.status === 401) {
        // Il token potrebbe essere stato revocato nel frattempo: un solo rinnovo e un solo retry.
        tokenData = await refreshFirebaseToken(auth);
        auth = tokenData.auth;
        try {
          response = await fetch(auth.apiUrl + entry.path, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + tokenData.idToken, 'Content-Type': 'application/json' },
            body: JSON.stringify(entry.body), cache: 'no-store'
          });
        } catch (error) { shouldRetry = true; throw error; }
        const retryResult = await response.json().catch(() => ({}));
        if (response.ok && retryResult.success !== false) {
          await deleteQueueEntry(entry.id);
          completed++;
          continue;
        }
        if (response.status >= 500 || response.status === 429) { shouldRetry = true; throw new Error('Server temporaneamente non disponibile: HTTP ' + response.status); }
        await writeStore('queue', { ...entry, status: 'conflict', lastError: retryResult.error || ('HTTP ' + response.status), conflictAt: Date.now() });
        blocked = true;
        break;
      }

      if (response.status >= 500 || response.status === 429) {
        shouldRetry = true;
        throw new Error('Server temporaneamente non disponibile: HTTP ' + response.status);
      }
      await writeStore('queue', { ...entry, status: 'conflict', lastError: result.error || ('HTTP ' + response.status), conflictAt: Date.now() });
      blocked = true;
      break;
    }

    if (completed > 0 || blocked) {
      const response = await fetch(auth.apiUrl + '/api/data', { headers: { Authorization: 'Bearer ' + tokenData.idToken }, cache: 'no-store' });
      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        if (data && data.state) await writeStore('snapshots', { state: data.state, savedAt: Date.now() }, auth.uid);
      } else if (response.status >= 500 || response.status === 429) {
        shouldRetry = true;
        throw new Error('Aggiornamento dati dopo la cassa non riuscito: HTTP ' + response.status);
      }
    }

    // Se restano altre operazioni pending, richiediamo una nuova esecuzione background.
    const remaining = (await readStore('queue')).some(item => item && item.uid === auth.uid && item.status === 'pending');
    if (remaining && !blocked) {
      try { await self.registration.sync.register(SYNC_TAG); } catch (error) { /* il prossimo evento online o avvio app riproverà */ }
    }
  } catch (error) {
    shouldRetry = true;
    throw error;
  } finally {
    await releaseLock(owner);
  }
}

self.addEventListener('sync', event => {
  if (event.tag === SYNC_TAG) event.waitUntil(syncOfflineCheckouts());
});

self.addEventListener('message', event => {
  const message = event.data || {};
  if (message.type === 'SKIP_WAITING') { self.skipWaiting(); return; }
  if (message.type === 'TB_SYNC_NOW') event.waitUntil(syncOfflineCheckouts());
});
