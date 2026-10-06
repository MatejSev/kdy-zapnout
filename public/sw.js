// ───────────────────────────────────────────────────────────────
// sw.js — aby stránka fungovala jako aplikace v telefonu
//
// Vždy se nejdřív zkouší internet, takže uživatel vidí čerstvé ceny.
// Jen když spojení není, ukáže se poslední uložená verze. Díky tomu
// se nikdy "nezasekne" na starých datech po nasazení nové verze.
// ───────────────────────────────────────────────────────────────
const CACHE = 'kdy-zapnout-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    try {
      const odpoved = await fetch(req);
      if (odpoved.ok) {
        const c = await caches.open(CACHE);
        // data mají v adrese čas proti cache prohlížeče, ukládáme je pod čistou adresou
        const klic = req.url.includes('latest.json') ? req.url.split('?')[0] : req;
        c.put(klic, odpoved.clone());
      }
      return odpoved;
    } catch {
      const c = await caches.open(CACHE);
      const ulozeno = await c.match(req.url.includes('latest.json') ? req.url.split('?')[0] : req);
      if (ulozeno) return ulozeno;
      if (req.mode === 'navigate') return (await c.match(self.registration.scope)) || Response.error();
      return Response.error();
    }
  })());
});
