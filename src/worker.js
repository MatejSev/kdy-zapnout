// ───────────────────────────────────────────────────────────────
// worker.js — malý kousek serveru na Cloudflaru
//
// Proč: plánované běhy GitHub Actions chodí s velkým zpožděním
// (místo 13:40 často až ve 21–23 h), takže zítřejší ceny se na web
// dostávaly až večer. Tenhle Worker obsluhuje jen data/latest.json:
// když v něm zítřek (nebo dnešek) chybí a OTE už ceny zveřejnilo,
// stáhne je rovnou z OTE a do odpovědi je přidá. Všechno ostatní
// (stránka, obrázky, kalendáře) jde dál přímo ze složky dist.
//
// Výsledek se ukládá do mezipaměti Cloudflaru, takže OTE dostane
// nanejvýš pár dotazů denně, ne jeden za každou návštěvu.
// Když cokoli selže, vrátí se prostě původní latest.json.
// ───────────────────────────────────────────────────────────────

import { prahaDatum, stahniOte, stahniKurz, stahniSlunce } from '../scripts/zdroje.mjs';

const CESTA = '/data/latest.json';
const OK_TTL = 6 * 3600;  // stažené ceny se už nemění
const CHYBA_TTL = 10 * 60; // ceny ještě nejsou → zkusit znovu za 10 min
const OTE_OD_HODINY = 13; // OTE zveřejňuje zítřek kolem 13:00 českého času

/** Hodina v českém čase (0–23). */
export function prahaHodina(ted = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hour: '2-digit', hourCycle: 'h23' }).format(ted));
}

/** Stáhne jeden den ve stejném tvaru, jaký má latest.json. */
export async function stahniDen(datum, z = {}) {
  const { ote = stahniOte, kurz = stahniKurz, slunce = stahniSlunce } = z;
  const [hodiny, eurCzk, pv] = await Promise.all([ote(datum), kurz(), slunce(datum).catch(() => [])]);
  if (hodiny.length < 23 || hodiny.length > 25) throw new Error(`nečekaný počet hodin (${hodiny.length})`);
  return {
    eurCzk: Math.round(eurCzk * 1000) / 1000,
    eur: hodiny.map((h) => Math.round(h.eurMwh * 100) / 100),
    pv: hodiny.map((h) => Math.round((pv[h.hour] ?? 0) * 100) / 100),
    src: 'OTE',
  };
}

/** Den z mezipaměti, nebo čerstvě z OTE. Vrací null, když ceny ještě nejsou. */
async function denSMezipameti(datum, ctx, z) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const klic = new Request(`https://kdyzapnout.cache/den/${datum}`);
  const ulozeno = cache && await cache.match(klic);
  if (ulozeno) return ulozeno.json();

  let den = null;
  try { den = { ...(await stahniDen(datum, z)), collectedAt: new Date().toISOString() }; } catch { /* zatím nic */ }
  if (cache) {
    const odp = new Response(JSON.stringify(den), {
      headers: { 'content-type': 'application/json', 'cache-control': `max-age=${den ? OK_TTL : CHYBA_TTL}` },
    });
    const zapis = cache.put(klic, odp);
    ctx?.waitUntil ? ctx.waitUntil(zapis) : await zapis;
  }
  return den;
}

/**
 * Doplní do latest.json chybějící dnešek a (odpoledne) zítřek.
 * Čistá funkce kvůli testům: stahování se dá podstrčit.
 */
export async function doplnLatest(latest, { ted = new Date(), ziskej } = {}) {
  const dnes = prahaDatum(0, ted);
  const zitra = prahaDatum(1, ted);
  const chybi = [];
  if (!latest.days?.[dnes]) chybi.push(dnes);
  if (!latest.days?.[zitra] && prahaHodina(ted) >= OTE_OD_HODINY) chybi.push(zitra);
  if (!chybi.length) return latest;

  const vysledky = await Promise.all(chybi.map((d) => ziskej(d).catch(() => null)));
  const days = { ...latest.days };
  let updatedAt = latest.updatedAt;
  chybi.forEach((d, i) => {
    const v = vysledky[i];
    if (!v) return;
    const { collectedAt, ...den } = v;
    days[d] = den;
    if (collectedAt && (!updatedAt || collectedAt > updatedAt)) updatedAt = collectedAt;
  });
  return { ...latest, updatedAt, days };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const statika = await env.ASSETS.fetch(request);
    if (url.pathname !== CESTA || request.method !== 'GET' || !statika.ok) return statika;

    try {
      const latest = await statika.clone().json();
      const doplneno = await doplnLatest(latest, { ziskej: (d) => denSMezipameti(d, ctx) });
      if (doplneno === latest) return statika;
      return new Response(JSON.stringify(doplneno), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    } catch {
      return statika; // radši starší data než žádná
    }
  },
};
