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
