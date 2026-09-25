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
import { naHodiny, prahaDatum, vyberDen } from '../scripts/zdroje.mjs';

let ok = 0, chyby = 0;
const t = (nazev, fn) => {
  try { fn(); console.log(`  ✓ ${nazev}`); ok++; }
  catch (e) { console.log(`  ✗ ${nazev}\n      ${e.message}`); chyby++; }
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

console.log(`\n${ok} testů prošlo${chyby ? `, ${chyby} SELHALO` : ''}\n`);
if (chyby) process.exit(1);
