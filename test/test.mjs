// ───────────────────────────────────────────────────────────────
// test.mjs — spouští je GitHub před každým nasazením
//
// Když cokoli selže, nová verze se na web nedostane a zůstane tam
// poslední funkční. Spuštění ručně: npm test
// ───────────────────────────────────────────────────────────────

import assert from 'node:assert';
import { DISTRIBUTORS, SYSTEM_FEES, PRICES_YEAR, DEFAULT_NT_HOURS } from '../src/tarify.js';
import {
  toFinalPrices, optimize, backtest, actionFor, odpocet, cheapestWindow, oknoPopis,
  buildIcs, hoursLabel, dni, dayCharacter, tier, PROFILY, VYCHOZI_PROFIL,
} from '../src/logika.js';
import { naHodiny, prahaDatum, vyberDen, zpracujEntsoe, prazskaPulnocUtc, dalsiDen, stahniCeny } from '../scripts/zdroje.mjs';
import { buildFeedIcs, mesicniPrehled, csvHodiny, csvDny, SABLONY, novySpotrebic, doplnSpotrebice, prepniKonflikt, odeberSpotrebic } from '../src/logika.js';
import { PREMIUM_REZIM, PLATBA_URL, DODAVATELE } from '../src/nastaveni.js';
import { FUNKCE, jePremium } from '../src/premium.js';

let ok = 0, chyby = 0;
const cekajici = [];
const pass = (n) => { console.log(`  ✓ ${n}`); ok++; };
const fail = (n, e) => { console.log(`  ✗ ${n}\n      ${e.message}`); chyby++; };
// Podporuje i asynchronní testy: jinak by jejich selhání prošlo bez povšimnutí.
const t = (nazev, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') { cekajici.push(r.then(() => pass(nazev), (e) => fail(nazev, e))); return; }
    pass(nazev);
  } catch (e) { fail(nazev, e); }
};
const den = (arr) => arr;
const cfg = { distributor: 'CEZ', rate: 'D02d', margin: 0, marginPct: 0, systemFees: SYSTEM_FEES,
  kwp: 0, feedIn: 0, baseLoadPerHour: 0, eurCzk: 25 };

console.log('\nceny a tarify:');
t('kontrolní příklad z ceníku: ČEZ D02d, 100 EUR/MWh, kurz 25 = 5,92 Kč', () => {
  const p = toFinalPrices([100], cfg)[0];
  assert.strictEqual(Math.round(p.price * 100) / 100, 5.92);
});
t('systémové složky 0,2270 Kč (ČEPS + daň, POZE od 2026 nula)', () =>
  assert.strictEqual(Math.round(SYSTEM_FEES * 10000) / 10000, 0.227));
t('všichni distributoři mají vyplněné sazby', () => {
  for (const [k, d] of Object.entries(DISTRIBUTORS))
    for (const [rk, r] of Object.entries(d.rates)) {
      assert.ok(r.vt > 0, `${k}/${rk} VT`);
      if (r.nt != null) assert.ok(r.nt > 0, `${k}/${rk} NT`);
    }
});
t('rok cen je číslo', () => assert.ok(Number.isInteger(PRICES_YEAR) && PRICES_YEAR >= 2026));
t('dvoutarif: NT levnější než VT', () => {
  const p = toFinalPrices(new Array(24).fill(100), { ...cfg, rate: 'D25d' });
  const nt = DEFAULT_NT_HOURS[8][0];
  const vt = [...Array(24).keys()].find((h) => !DEFAULT_NT_HOURS[8].includes(h));
  assert.ok(p[nt].price < p[vt].price);
});
t('záporný spot cenu sníží', () => {
  const [z, n] = toFinalPrices([-50, 0], cfg);
  assert.ok(z.price < n.price);
});

console.log('\nplánování:');
const eur = [40,35,32,30,31,38,70,95,88,70,55,40,25,20,22,35,60,105,120,110,85,65,55,45];
const ceny = toFinalPrices(eur, cfg);
const nula = new Array(24).fill(0);
t('dělitelná zátěž dostane nejlevnější hodiny', () => {
  const r = optimize({ prices: ceny, pv: nula, baseLoad: nula, feedIn: 0,
    appliances: [{ id: 'b', name: 'B', kwh: 6, hours: 3, contiguous: false, priority: 1, enabled: true }] });
  assert.deepStrictEqual(r.plan[0].hours, [12, 13, 14]);
});
t('pračka dostane souvislý blok', () => {
  const r = optimize({ prices: ceny, pv: nula, baseLoad: nula, feedIn: 0,
    appliances: [{ id: 'w', name: 'W', kwh: 1.2, hours: 2, contiguous: true, priority: 1, enabled: true }] });
  const h = r.plan[0].hours;
  assert.strictEqual(h[1] - h[0], 1);
});
t('respektuje "hotovo do"', () => {
  const r = optimize({ prices: ceny, pv: nula, baseLoad: nula, feedIn: 0,
    appliances: [{ id: 'a', name: 'A', kwh: 8, hours: 4, contiguous: false, latest: 7, priority: 1, enabled: true }] });
  assert.ok(Math.max(...r.plan[0].hours) < 7);
});
t('přebytek z panelů se nezapočítá dvakrát', () => {
  const pv = [...nula]; pv[12] = 3;
  const r = optimize({ prices: ceny, pv, baseLoad: nula, feedIn: 0, appliances: [
    { id: 'a', name: 'A', kwh: 3, hours: 1, contiguous: false, priority: 1, enabled: true },
    { id: 'b', name: 'B', kwh: 3, hours: 1, contiguous: false, priority: 2, enabled: true }] });
  const zdarma = r.plan.filter((p) => p.cost === 0).length;
  assert.strictEqual(zdarma, 1);
});

console.log('\núspory ze skutečných cen:');
const historie = Array.from({ length: 20 }, (_, d) => ({
  date: `2026-09-${String(d + 1).padStart(2, '0')}`, eurCzk: 24.5,
  eur: eur.map((e) => e * (1 + Math.sin(d) * 0.2)), pv: nula,
}));
const apps = PROFILY.bojler.appliances;
t('backtest spočítá všechny dny', () => assert.strictEqual(backtest(historie, cfg, apps).dayCount, 20));
t('úspora je kladná a konečná', () => {
  const b = backtest(historie, cfg, apps);
  assert.ok(b.perMonth > 0 && Number.isFinite(b.perMonth));
});
t('měsíc = denní průměr × 30', () => {
  const b = backtest(historie, cfg, apps);
  assert.ok(Math.abs(b.perMonth - b.perDay * 30) < 1e-9);
});
t('prázdná historie nespadne a nedá NaN', () => {
  const b = backtest([], cfg, apps);
  assert.strictEqual(b.dayCount, 0);
  assert.ok(Number.isFinite(b.perMonth) && Number.isFinite(b.projectedYear));
});
t('neúplný den se přeskočí', () =>
  assert.strictEqual(backtest([{ date: 'x', eurCzk: 25, eur: [1, 2, 3] }], cfg, apps).dayCount, 0));
t('všechny předvolby mají spotřebiče a spočítají se', () => {
  assert.ok(PROFILY[VYCHOZI_PROFIL]);
  for (const [k, p] of Object.entries(PROFILY)) {
    assert.ok(p.appliances.length > 0, k);
    assert.ok(backtest(historie, cfg, p.appliances).perMonth >= 0, k);
  }
});

console.log('\nco zapnout teď:');
const bojler = { id: 'b', name: 'Bojler', hours: [12, 13, 14] };
t('ve 13:20 zapni teď, levně do 15:00', () => {
  const a = actionFor(bojler, 13, 20, true);
  assert.strictEqual(a.kind, 'now'); assert.strictEqual(a.until, 15);
});
t('v 9:30 odpočet za 2 h 30 min', () =>
  assert.strictEqual(odpocet(actionFor(bojler, 9, 30, true).mins), 'za 2 h 30 min'));
t('večer už hotovo', () => assert.strictEqual(actionFor(bojler, 20, 0, true).kind, 'done'));

console.log('\nnejlevnější okno a kalendář:');
const d0 = toFinalPrices(Array.from({ length: 24 }, (_, h) => (h === 23 ? 1 : 150)), cfg);
const d1 = toFinalPrices(Array.from({ length: 24 }, (_, h) => (h < 2 ? 1 : 150)), cfg);
t('okno přes půlnoc', () => assert.strictEqual(oknoPopis(cheapestWindow(d0, d1, 20, 3)), 'dnes 23:00 až zítra 02:00'));
t('bez zítřka pozdě večer nic nevymýšlí', () => assert.strictEqual(cheapestWindow(d0, null, 23, 3), null));
t('kalendář: blok do půlnoci nekončí neplatným 24:00', () => {
  const ics = buildIcs([{ id: 'x', name: 'X', hours: [22, 23] }], '2026-09-25');
  assert.ok(ics.includes('T235900') && !ics.includes('T240000'));
});
t('časy se sloučí do bloků', () => assert.strictEqual(hoursLabel([0, 1, 22, 23]), '00:00–02:00, 22:00–24:00'));

console.log('\nsběr dat:');
t('96 čtvrthodin → 24 hodin, průměr', () => {
  const h = naHodiny(Array.from({ length: 96 }, (_, i) => ({ eurMwh: 100 + (i % 4) * 10 })));
  assert.strictEqual(h.length, 24); assert.strictEqual(h[0].eurMwh, 115);
});
t('změna času: 92 → 23 a 100 → 25 hodin', () => {
  assert.strictEqual(naHodiny(Array.from({ length: 92 }, () => ({ eurMwh: 1 }))).length, 23);
  assert.strictEqual(naHodiny(Array.from({ length: 100 }, () => ({ eurMwh: 1 }))).length, 25);
});
t('hodinová data zůstanou beze změny', () => assert.strictEqual(naHodiny(Array.from({ length: 24 }, () => ({ eurMwh: 1 }))).length, 24));
t('český čas po půlnoci UTC (léto)', () => assert.strictEqual(prahaDatum(0, new Date('2026-09-25T22:30:00Z')), '2026-09-26'));
t('český čas v zimě', () => assert.strictEqual(prahaDatum(0, new Date('2026-01-15T22:30:00Z')), '2026-01-15'));
t('předpověď slunce se bere pro správný den, ne prvních 24 hodin', () => {
  const casy = ['2026-09-24T23:00', '2026-09-25T00:00', '2026-09-25T01:00', '2026-09-26T00:00'];
  assert.deepStrictEqual(vyberDen(casy, [9, 1, 2, 7], '2026-09-25'), [1, 2]);
});

console.log('\nrůzné:');
t('české skloňování dnů', () => { assert.strictEqual(dni(1), '1 den'); assert.strictEqual(dni(3), '3 dny'); assert.strictEqual(dni(7), '7 dní'); });
t('barevné stupně bez dělení nulou', () => assert.strictEqual(tier(3, 3, 3), 2));
t('výjimečný den se pozná jen s dost historií', () => {
  const h = Array.from({ length: 20 }, () => ({ spread: 3 }));
  assert.strictEqual(dayCharacter([{ price: 1 }, { price: 10 }], h).kind, 'big');
  assert.strictEqual(dayCharacter([{ price: 1 }, { price: 10 }], h.slice(0, 3)).kind, 'unknown');
});


console.log('\nzáložní zdroj ENTSO-E:');
const od = prazskaPulnocUtc('2026-09-25'), doC = prazskaPulnocUtc('2026-09-26');
t('česká půlnoc v UTC v létě i v zimě', () => {
  assert.strictEqual(new Date(od).toISOString(), '2026-09-24T22:00:00.000Z');
  assert.strictEqual(new Date(prazskaPulnocUtc('2026-01-15')).toISOString(), '2026-01-14T23:00:00.000Z');
});
t('den změny času má 23 a 25 hodin', () => {
  assert.strictEqual((prazskaPulnocUtc(dalsiDen('2026-03-29')) - prazskaPulnocUtc('2026-03-29')) / 36e5, 23);
  assert.strictEqual((prazskaPulnocUtc(dalsiDen('2026-10-25')) - prazskaPulnocUtc('2026-10-25')) / 36e5, 25);
});
const entsoeXml = (() => {
  let p = '';
  for (let i = 1; i <= 96; i++) if (i % 4 === 1) p += `<Point><position>${i}</position><price.amount>${100 + Math.floor((i - 1) / 4)}</price.amount></Point>`;
  return `<Publication_MarketDocument><TimeSeries><curveType>A03</curveType><Period><timeInterval><start>2026-09-24T22:00Z</start><end>2026-09-25T22:00Z</end></timeInterval><resolution>PT15M</resolution>${p}</Period></TimeSeries></Publication_MarketDocument>`;
})();
t('vynechané body doplní předchozí cenou (křivka A03)', () => {
  const h = zpracujEntsoe(entsoeXml, od, doC);
  assert.strictEqual(h.length, 24);
  assert.ok(h.every((x, i) => x.eurMwh === 100 + i));
});
t('prázdná odpověď ENTSO-E je chyba, ne nuly', () =>
  assert.throws(() => zpracujEntsoe('<Acknowledgement_MarketDocument><text>No matching data found</text></Acknowledgement_MarketDocument>', od, doC), /No matching/));
t('když OTE jede, záloha se nevolá', async () => {
  const r = await stahniCeny('2026-09-25', { token: 'x', ote: async () => [{ hour: 0, eurMwh: 1 }], entsoe: async () => { throw new Error('nevolat'); } });
  assert.strictEqual(r.zdroj, 'OTE');
});

console.log('\nkalendář k odběru:');
const dnyFeed = [
  { date: '2026-09-25', prices: toFinalPrices(eur, cfg) },
  { date: '2026-09-26', prices: toFinalPrices(eur.map((e) => e * 1.1), cfg) },
];
const feed = buildFeedIcs({ nazev: 'Dům s bojlerem', dny: dnyFeed, appliances: PROFILY.bojler.appliances, cfg });
t('platný kalendář s řádky CRLF', () => {
  assert.ok(feed.startsWith('BEGIN:VCALENDAR\r\n') && feed.trimEnd().endsWith('END:VCALENDAR'));
  assert.ok(!/[^\r]\n/.test(feed), 'řádek bez CR');
});
t('žádný řádek nemá přes 75 bajtů', () => {
  const enc = new TextEncoder();
  for (const r of feed.split('\r\n')) assert.ok(enc.encode(r).length <= 75, `dlouhý řádek: ${r}`);
});
t('obsahuje oba dny a stálé identifikátory událostí', () => {
  assert.ok(feed.includes('UID:bojler-20260925-0@kdy-zapnout'));
  assert.ok(feed.includes('UID:bojler-20260926-0@kdy-zapnout'));
});
t('čárky v textu jsou ošetřené', () => assert.ok(/DESCRIPTION:[^\r]*\\,/.test(feed)));
t('výjimečný den přidá celodenní upozornění', () => {
  const klid = Array.from({ length: 20 }, () => ({ spread: 1.2 }));
  const f = buildFeedIcs({ nazev: 'X', dny: dnyFeed.slice(0, 1), appliances: PROFILY.bojler.appliances, historie: klid, cfg });
  assert.ok(f.includes('DTSTART;VALUE=DATE:20260925'));
});
t('bez historie žádné upozornění nevymýšlí', () => assert.ok(!feed.includes('VALUE=DATE')));

console.log('\npřehledy a export:');
t('měsíční přehled seskupí dny podle měsíců', () => {
  const m = mesicniPrehled([
    { date: '2026-08-30', savedVsAverage: 10 }, { date: '2026-08-31', savedVsAverage: 5 },
    { date: '2026-09-01', savedVsAverage: 7 }], { '2026-08-30': 4, '2026-08-31': 6, '2026-09-01': 5 });
  assert.strictEqual(m.length, 2);
  assert.strictEqual(m[0].usetreno, 15); assert.strictEqual(m[0].prumerCen, 5);
});
t('CSV pro český Excel: BOM, středník, desetinná čárka', () => {
  const c = csvHodiny([{ date: '2026-09-25', prices: toFinalPrices([100], cfg) }]);
  assert.ok(c.startsWith('\uFEFF'));
  assert.ok(c.includes(';') && /5,92/.test(c));
});
t('CSV úspor má hlavičku a řádek za každý den', () =>
  assert.strictEqual(csvDny(backtest(historie, cfg, apps).days).split('\r\n').length, 21));

console.log('\npremium a nastavení:');
t('režim premium je platná hodnota', () => assert.ok(['zdarma', 'placene'].includes(PREMIUM_REZIM)));
t('placený režim nesmí jít ven bez odkazu na platbu', () => {
  if (PREMIUM_REZIM === 'placene') assert.ok(PLATBA_URL.startsWith('https://'), 'chybí PLATBA_URL, funkce by nešly odemknout');
});
t('v režimu zdarma je premium odemčené', () => { if (PREMIUM_REZIM === 'zdarma') assert.strictEqual(jePremium(), true); });
t('seznam funkcí má bezplatné i premium', () => {
  assert.ok(FUNKCE.some((f) => f.premium) && FUNKCE.some((f) => !f.premium));
  assert.strictEqual(new Set(FUNKCE.map((f) => f.id)).size, FUNKCE.length);
});
t('dodavatelé mají platnou přirážku a zdroj', () => {
  for (const d of DODAVATELE) {
    assert.ok(d.id && d.nazev, 'chybí id nebo název');
    assert.ok(Number.isFinite(d.marze) && d.marze >= 0 && d.marze < 5, `${d.nazev}: podezřelá přirážka ${d.marze}`);
    assert.ok(d.zdroj, `${d.nazev}: chybí zdroj, odkud je cena`);
  }
});

console.log('\nsouběh a limit příkonu:');
const pr = { ...SABLONY.pracka, id: 'pracka', conflicts: ['mycka'], enabled: true, earliest: 0, latest: 24 };
const my = { ...SABLONY.mycka, id: 'mycka', conflicts: ['pracka'], enabled: true };
const prekryv = (a, b) => a.hours.some((h) => b.hours.includes(h));
t('bez zákazu pračka a myčka klidně poběží naráz (stejné levné hodiny)', () => {
  const r = optimize({ prices: ceny, pv: nula, baseLoad: nula, feedIn: 0,
    appliances: [{ ...pr, conflicts: [] }, { ...my, conflicts: [] }] });
  assert.ok(prekryv(r.plan[0], r.plan[1]));
});
t('se zákazem souběhu se nepřekryjí', () => {
  const r = optimize({ prices: ceny, pv: nula, baseLoad: nula, feedIn: 0, appliances: [pr, my] });
  assert.ok(!prekryv(r.plan[0], r.plan[1]), `${r.plan[0].hours} × ${r.plan[1].hours}`);
});
t('zákaz platí, i když ho má zapsaný jen jeden z nich', () => {
  const r = optimize({ prices: ceny, pv: nula, baseLoad: nula, feedIn: 0, appliances: [pr, { ...my, conflicts: [] }] });
  assert.ok(!prekryv(r.plan[0], r.plan[1]));
});
t('posunutý spotřebič ví proč a kolik to stojí navíc', () => {
  const r = optimize({ prices: ceny, pv: nula, baseLoad: nula, feedIn: 0, appliances: [pr, my] });
  const pos = r.plan.find((p) => p.posunuto);
  assert.ok(pos, 'nikdo nebyl posunut');
  assert.ok(pos.posunuto.soubeh.length === 1 && pos.priplatek > 0);
});
t('limit příkonu: dva spotřebiče po 2 kW se při limitu 3,5 kW nepotkají', () => {
  const r = optimize({ prices: ceny, pv: nula, baseLoad: new Array(24).fill(0.3), feedIn: 0, maxKw: 3.5,
    appliances: [{ ...pr, conflicts: [] }, { ...my, conflicts: [] }] });
  assert.ok(!prekryv(r.plan[0], r.plan[1]));
  assert.ok(r.spicka <= 3.5 + 1e-9, `špička ${r.spicka}`);
});
t('posun kvůli limitu se označí jako limit', () => {
  const r = optimize({ prices: ceny, pv: nula, baseLoad: nula, feedIn: 0, maxKw: 3,
    appliances: [{ ...pr, conflicts: [] }, { ...my, conflicts: [] }] });
  assert.ok(r.plan.some((p) => p.posunuto?.limit));
});
t('spotřebič silnější než limit je nesplnitelný s důvodem', () => {
  const r = optimize({ prices: ceny, pv: nula, baseLoad: nula, feedIn: 0, maxKw: 3,
    appliances: [{ ...SABLONY.auto, id: 'auto', conflicts: [], enabled: true }] });
  assert.strictEqual(r.plan[0].infeasible, true); assert.strictEqual(r.plan[0].duvod, 'prikon');
});
t('když se kvůli souběhu nevejde do okna, řekne to', () => {
  const r = optimize({ prices: ceny, pv: nula, baseLoad: nula, feedIn: 0, appliances: [
    { ...pr, earliest: 10, latest: 12, priority: 1 }, { ...my, earliest: 10, latest: 12, priority: 2 }] });
  const x = r.plan.find((p) => p.infeasible);
  assert.ok(x && x.duvod === 'omezeni' && x.omezeni.soubeh.length === 1);
});
t('bez omezení se plán nezměnil proti dřívějšku', () => {
  const r = optimize({ prices: ceny, pv: nula, baseLoad: nula, feedIn: 0,
    appliances: [{ id: 'b', name: 'B', kwh: 6, hours: 3, contiguous: false, priority: 1, enabled: true }] });
  assert.deepStrictEqual(r.plan[0].hours, [12, 13, 14]);
  assert.strictEqual(r.plan[0].posunuto, null);
});
t('den se 23 hodinami (změna času) nedá NaN', () => {
  const c23 = toFinalPrices(eur.slice(0, 23), cfg);
  const r = optimize({ prices: c23, pv: nula, baseLoad: nula, feedIn: 0,
    appliances: [{ ...SABLONY.bojler, id: 'b', enabled: true, latest: 24 }] });
  assert.ok(Number.isFinite(r.plan[0].cost) && r.plan[0].hours.every((h) => h < 23));
});
t('příkon menší než spotřeba za hodinu se opraví', () => {
  const r = optimize({ prices: ceny, pv: nula, baseLoad: nula, feedIn: 0,
    appliances: [{ id: 'x', name: 'X', kwh: 6, hours: 2, kw: 1, contiguous: false, priority: 1, enabled: true }] });
  assert.strictEqual(r.plan[0].kw, 3);
});
t('úspora s limitem není větší než bez něj', () => {
  const a = [{ ...pr, conflicts: [] }, { ...my, conflicts: [] }, { ...SABLONY.bojler, id: 'b', conflicts: [], enabled: true }];
  const bez = backtest(historie, cfg, a).perMonth;
  const s = backtest(historie, { ...cfg, maxKw: 3.5 }, a).perMonth;
  assert.ok(s <= bez + 1e-9, `${s} > ${bez}`);
});

t('rozpis výroby z panelů po hodinách sedí s celkovým součtem', () => {
  const pv = [...nula]; pv[12] = 1.5; pv[13] = 0.2;
  const r = optimize({ prices: ceny, pv, baseLoad: nula, feedIn: 0,
    appliances: [{ ...SABLONY.bojler, id: 'b', conflicts: [], enabled: true }] });
  const p = r.plan[0];
  const soucet = Object.values(p.pvPoHodinach).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(soucet - p.pvUsed) < 1e-9);
  assert.ok(p.pvPoHodinach[12] >= p.naHodinu * 0.5 && p.pvPoHodinach[13] < p.naHodinu * 0.5);
});

console.log('\núpravy seznamu spotřebičů:');
t('zákaz souběhu se nastaví i zruší na obou stranách', () => {
  let l = [{ id: 'a', conflicts: [] }, { id: 'b', conflicts: [] }];
  l = prepniKonflikt(l, 'a', 'b');
  assert.deepStrictEqual([l[0].conflicts, l[1].conflicts], [['b'], ['a']]);
  l = prepniKonflikt(l, 'b', 'a');
  assert.deepStrictEqual([l[0].conflicts, l[1].conflicts], [[], []]);
});
t('odebraný spotřebič zmizí i ze zákazů ostatních', () => {
  const l = odeberSpotrebic([{ id: 'a', conflicts: ['b'] }, { id: 'b', conflicts: ['a'] }], 'b');
  assert.deepStrictEqual(l, [{ id: 'a', conflicts: [] }]);
});
t('nový spotřebič ze šablony má jedinečné id', () => {
  const s1 = novySpotrebic('susicka', []);
  const s2 = novySpotrebic('susicka', [s1]);
  assert.strictEqual(s1.id, 'susicka'); assert.strictEqual(s2.id, 'susicka2'); assert.strictEqual(s2.kw, 2.5);
});
t('staré uložené spotřebiče dostanou příkon podle šablony', () => {
  const [x] = doplnSpotrebice([{ id: 'bojler', name: 'Bojler', kwh: 6, hours: 3 }]);
  assert.strictEqual(x.kw, 2); assert.deepStrictEqual(x.conflicts, []);
});
t('neplatné odkazy v zákazech se při načtení vyčistí', () => {
  const [x] = doplnSpotrebice([{ id: 'a', kwh: 1, hours: 1, conflicts: ['neexistuje'] }]);
  assert.deepStrictEqual(x.conflicts, []);
});
t('všechny šablony jsou fyzikálně možné (příkon ≥ spotřeba za hodinu)', () => {
  for (const [k, v] of Object.entries(SABLONY)) assert.ok(v.kw >= v.kwh / v.hours - 1e-9, k);
});

await Promise.all(cekajici);
console.log(`\n${ok} testů prošlo${chyby ? `, ${chyby} SELHALO` : ''}\n`);
if (chyby) process.exit(1);
