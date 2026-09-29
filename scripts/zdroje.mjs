// ───────────────────────────────────────────────────────────────
// zdroje.mjs — stahování dat z veřejných zdrojů
//
// OTE: spotové ceny na den dopředu. Endpoint používá web OTE pro graf,
//      není oficiálně dokumentovaný a může se změnit. Když se to stane,
//      sběr selže a GitHub ti pošle e-mail.
// ČNB: denní kurz EUR/CZK.
// Open-Meteo: předpověď slunečního svitu pro odhad výroby panelů.
// ───────────────────────────────────────────────────────────────

const OTE = 'https://www.ote-cr.cz/cs/kratkodobe-trhy/elektrina/denni-trh/@@chart-data';
const CNB = 'https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt';
const METEO = 'https://api.open-meteo.com/v1/forecast';

const HLAVICKY = { 'User-Agent': 'kdy-zapnout (sber cen pro planovac spotreby)', Accept: 'application/json,text/plain' };

/**
 * Datum v českém čase. GitHub běží v UTC, takže bez tohohle by se
 * kolem půlnoci ukládaly ceny pod špatný den.
 */
export function prahaDatum(posunDnu = 0, ted = new Date()) {
  const d = new Date(ted.getTime() + posunDnu * 864e5);
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/**
 * OTE přešlo na čtvrthodinové intervaly a posílá 96 hodnot místo 24.
 * Aplikace plánuje po hodinách, takže čtyři čtvrthodiny zprůměrujeme.
 * Při změně času má den 92 nebo 100 intervalů, proto se počítá z délky.
 */
export function naHodiny(body) {
  if (!body.length) return [];
  if (body.length <= 26) return body.map((b, i) => ({ hour: i, eurMwh: b.eurMwh }));
  const naHodinu = Math.round(body.length / 24) || 4;
  const hodiny = [];
  for (let i = 0; i < body.length; i += naHodinu) {
    const kus = body.slice(i, i + naHodinu);
    const prumer = kus.reduce((s, b) => s + b.eurMwh, 0) / kus.length;
    hodiny.push({ hour: hodiny.length, eurMwh: Math.round(prumer * 100) / 100 });
  }
  return hodiny;
}

export async function stahniOte(datum) {
  const r = await fetch(`${OTE}?report_date=${datum}`, { headers: HLAVICKY });
  if (!r.ok) throw new Error(`OTE vrátilo ${r.status}`);
  const j = await r.json();
  const rady = j?.data?.dataLine ?? [];
  // hledáme podle názvu, ne podle pořadí, to se může změnit
  const cena = rady.find((l) => /EUR/i.test(l.title ?? '')) ?? rady.find((l) => /cena/i.test(l.title ?? '')) ?? rady[0];
  if (!cena?.point?.length) throw new Error(`OTE pro ${datum} nevrátilo ceny (možná ještě nejsou zveřejněné)`);
  const body = cena.point
    .map((p) => ({ idx: Number(p.x), eurMwh: Number(p.y) }))
    .filter((p) => Number.isFinite(p.idx) && Number.isFinite(p.eurMwh))
    .sort((a, b) => a.idx - b.idx);
  return naHodiny(body);
}

export async function stahniKurz() {
  const r = await fetch(CNB, { headers: HLAVICKY });
  if (!r.ok) throw new Error(`ČNB vrátilo ${r.status}`);
  const radek = (await r.text()).split('\n').find((l) => l.includes('|EUR|'));
  if (!radek) throw new Error('ČNB: nenašel jsem kurz eura');
  const sloupce = radek.split('|');
  return Number(sloupce[4].replace(',', '.')) / Number(sloupce[2].replace(',', '.'));
}

/**
 * Vybere z hodinové předpovědi právě hodiny požadovaného dne.
 * Open-Meteo vrací časy v českém čase jako "2026-09-25T13:00".
 */
export function vyberDen(casy, hodnoty, datum) {
  const out = [];
  for (let i = 0; i < casy.length; i++) {
    if (casy[i].startsWith(datum)) out.push(hodnoty[i] ?? 0);
  }
  return out;
}

/** Výkon z 1 kWp panelů po hodinách (kW), s účinností systému. */
export async function stahniSlunce(datum, lat = 49.8, lon = 15.5, ucinnost = 0.85) {
  const url = `${METEO}?latitude=${lat}&longitude=${lon}&hourly=shortwave_radiation&forecast_days=3&past_days=1&timezone=Europe%2FPrague`;
  const r = await fetch(url, { headers: HLAVICKY });
  if (!r.ok) throw new Error(`Open-Meteo vrátilo ${r.status}`);
  const j = await r.json();
  const wm2 = vyberDen(j?.hourly?.time ?? [], j?.hourly?.shortwave_radiation ?? [], datum);
  return wm2.map((w) => Math.max(0, Math.round(((w ?? 0) / 1000) * ucinnost * 100) / 100));
}

// ═══ Záložní zdroj: ENTSO-E Transparency Platform ═══════════════
// Oficiální evropské rozhraní se stejnými českými cenami jako OTE.
// Potřebuje bezplatný token (registrace na transparency.entsoe.eu).
// Používá se jen tehdy, když OTE selže a token je nastavený.

const ENTSOE = 'https://web-api.tp.entsoe.eu/api';
const CZ_ZONA = '10YCZ-CEPS-----N';

/** O kolik je český čas napřed před UTC v daném okamžiku (ms). */
function posunPrahy(t) {
  const casti = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Prague', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(t));
  const g = (k) => Number(casti.find((p) => p.type === k).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - t;
}

/**
 * Okamžik české půlnoci daného dne v UTC (ms).
 * Změna času je v noci ve 2 nebo 3 hodiny, takže posun v půlnoci
 * se rovná posunu v UTC půlnoci.
 */
export function prazskaPulnocUtc(datum) {
  const [y, m, d] = datum.split('-').map(Number);
  const utcPulnoc = Date.UTC(y, m - 1, d);
  return utcPulnoc - posunPrahy(utcPulnoc);
}

export function dalsiDen(datum) {
  const [y, m, d] = datum.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * Převede odpověď ENTSO-E na hodinové ceny českého dne.
 *
 * Dvě zrady, které se musí ošetřit:
 *  - Časy jsou v UTC, český den začíná ve 22:00 nebo 23:00 UTC.
 *  - Typ křivky A03 vynechává body, kde se cena nemění. Chybějící
 *    pozice proto znamená "stejná cena jako předchozí", ne "bez dat".
 */
export function zpracujEntsoe(xml, zacatekUtc, konecUtc) {
  if (/Acknowledgement_MarketDocument/.test(xml)) {
    const duvod = (xml.match(/<text>([^<]*)<\/text>/) || [])[1] || 'bez dat';
    throw new Error(`ENTSO-E: ${duvod}`);
  }
  const podleRozliseni = new Map(); // minuty → Map(čas → cena)
  for (const perioda of xml.match(/<Period>[\s\S]*?<\/Period>/g) ?? []) {
    const od = Date.parse((perioda.match(/<start>([^<]+)<\/start>/) || [])[1]);
    const d0 = Date.parse((perioda.match(/<end>([^<]+)<\/end>/) || [])[1]);
    const r = (perioda.match(/<resolution>([^<]+)<\/resolution>/) || [])[1];
    const min = { PT15M: 15, PT30M: 30, PT60M: 60 }[r];
    if (!Number.isFinite(od) || !Number.isFinite(d0) || !min) continue;

    const body = new Map();
    for (const m of perioda.matchAll(/<Point>\s*<position>(\d+)<\/position>\s*<price\.amount>(-?[\d.]+)<\/price\.amount>/g)) {
      body.set(Number(m[1]), Number(m[2]));
    }
    const pocet = Math.round((d0 - od) / (min * 60000));
    const mapa = podleRozliseni.get(min) ?? new Map();
    let posledni = null;
    for (let i = 1; i <= pocet; i++) {
      if (body.has(i)) posledni = body.get(i);
      if (posledni == null) continue;
      const t = od + (i - 1) * min * 60000;
      if (!mapa.has(t)) mapa.set(t, posledni);
    }
    podleRozliseni.set(min, mapa);
  }

  const rozliseni = [...podleRozliseni.keys()].sort((a, b) => a - b)[0];
  if (!rozliseni) throw new Error('ENTSO-E: odpověď neobsahuje ceny');
  const mapa = podleRozliseni.get(rozliseni);

  const hodin = Math.round((konecUtc - zacatekUtc) / 3600000);
  const out = [];
  for (let h = 0; h < hodin; h++) {
    const hodnoty = [];
    for (let t = zacatekUtc + h * 3600000; t < zacatekUtc + (h + 1) * 3600000; t += rozliseni * 60000) {
      if (mapa.has(t)) hodnoty.push(mapa.get(t));
    }
    if (!hodnoty.length) throw new Error(`ENTSO-E: chybí cena pro ${h}. hodinu dne`);
    out.push({ hour: h, eurMwh: Math.round((hodnoty.reduce((a, b) => a + b, 0) / hodnoty.length) * 100) / 100 });
  }
  return out;
}

export async function stahniEntsoe(datum, token) {
  if (!token) throw new Error('ENTSO-E: chybí token');
  const od = prazskaPulnocUtc(datum);
  const doCasu = prazskaPulnocUtc(dalsiDen(datum));
  const f = (t) => new Date(t).toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const url = `${ENTSOE}?securityToken=${encodeURIComponent(token)}&documentType=A44` +
    `&in_Domain=${CZ_ZONA}&out_Domain=${CZ_ZONA}&periodStart=${f(od)}&periodEnd=${f(doCasu)}`;
  const r = await fetch(url, { headers: { 'User-Agent': HLAVICKY['User-Agent'] } });
  const text = await r.text();
  if (!r.ok && !/Acknowledgement/.test(text)) throw new Error(`ENTSO-E vrátilo ${r.status}`);
  return zpracujEntsoe(text, od, doCasu);
}

/**
 * Ceny na daný den: nejdřív OTE, při selhání ENTSO-E (když je token).
 * Vrací i zdroj, aby se na stránce dalo poctivě napsat, odkud data jsou.
 */
export async function stahniCeny(datum, { token = process.env.ENTSOE_TOKEN, ote = stahniOte, entsoe = stahniEntsoe } = {}) {
  try {
    return { hodiny: await ote(datum), zdroj: 'OTE' };
  } catch (chybaOte) {
    if (!token) throw chybaOte;
    try {
      return { hodiny: await entsoe(datum, token), zdroj: 'ENTSO-E' };
    } catch (chybaEntsoe) {
      throw new Error(`${chybaOte.message}; záloha: ${chybaEntsoe.message}`);
    }
  }
}
