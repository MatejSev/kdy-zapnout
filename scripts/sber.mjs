// ───────────────────────────────────────────────────────────────
// sber.mjs — denní sběr cen, spouští ho GitHub Actions
//
// 1) stáhne ceny na dnešek a zítřek (pokud ještě nejsou uložené)
// 2) uloží je do public/data/prices/DATUM.json
// 3) přegeneruje public/data/latest.json, ze kterého čte stránka
//
// Skončí chybou, když se nepodaří získat ceny na dnešek. Díky tomu
// GitHub označí běh jako neúspěšný a pošle ti e-mail.
// ───────────────────────────────────────────────────────────────

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prahaDatum, stahniOte, stahniKurz, stahniSlunce } from './zdroje.mjs';

const KOREN = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || join(KOREN, 'public', 'data');
const CENY = join(DATA, 'prices');
const HISTORIE_DNU = 120; // kolik dní historie dostane stránka

const log = (...a) => console.log(...a);

async function nactiJson(cesta) {
  try { return JSON.parse(await readFile(cesta, 'utf8')); } catch { return null; }
}

const uplny = (rec) => Array.isArray(rec?.hours) && rec.hours.length >= 23 && rec.hours.length <= 25 && rec.eurCzk;

export async function sberDne(datum, zavislosti = {}) {
  const { ote = stahniOte, kurz = stahniKurz, slunce = stahniSlunce } = zavislosti;
  const soubor = join(CENY, `${datum}.json`);
  const stary = await nactiJson(soubor);
  if (uplny(stary)) {
    log(`  ${datum}: už uloženo, přeskakuji`);
    return { datum, preskoceno: true };
  }

  const [ceny, eurCzk, vykon] = await Promise.allSettled([ote(datum), kurz(), slunce(datum)]);
  if (ceny.status !== 'fulfilled') throw new Error(`${datum}: ${ceny.reason.message}`);
  if (eurCzk.status !== 'fulfilled') throw new Error(`${datum}: ${eurCzk.reason.message}`);

  const pv = vykon.status === 'fulfilled' ? vykon.value : [];
  if (vykon.status !== 'fulfilled') log(`  ${datum}: předpověď slunce nedostupná (${vykon.reason.message}), pokračuji bez ní`);

  const zaznam = {
    date: datum,
    collectedAt: new Date().toISOString(),
    eurCzk: Math.round(eurCzk.value * 1000) / 1000,
    hours: ceny.value.map((h) => ({ hour: h.hour, eurMwh: h.eurMwh, radiation: pv[h.hour] ?? null })),
  };
  if (!uplny(zaznam)) throw new Error(`${datum}: nečekaný počet hodin (${zaznam.hours.length})`);

  await mkdir(CENY, { recursive: true });
  await writeFile(soubor, JSON.stringify(zaznam, null, 1), 'utf8');
  log(`  ${datum}: uloženo ${zaznam.hours.length} hodin, kurz ${zaznam.eurCzk}`);
  return zaznam;
}

/** Jeden soubor pro stránku: posledních N dní plus zítřek. */
export async function sestavLatest() {
  let soubory = [];
  try { soubory = (await readdir(CENY)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch { /* prázdné */ }
  const dny = {};
  let posledniStazeni = null;
  for (const f of soubory.slice(-(HISTORIE_DNU + 2))) {
    const rec = await nactiJson(join(CENY, f));
    if (!uplny(rec)) continue;
    if (rec.collectedAt && (!posledniStazeni || rec.collectedAt > posledniStazeni)) posledniStazeni = rec.collectedAt;
    const s = [...rec.hours].sort((a, b) => a.hour - b.hour);
    dny[rec.date] = {
      eurCzk: rec.eurCzk,
      eur: s.map((h) => Math.round(h.eurMwh * 100) / 100),
      pv: s.map((h) => (h.radiation == null ? 0 : Math.round(h.radiation * 100) / 100)),
    };
  }
  // Čas skutečně posledního stažení, ne čas běhu. Když sběr selže,
  // soubor se nezmění, stránka nebude tvrdit čerstvá data a nevznikne
  // zbytečný commit.
  const latest = { updatedAt: posledniStazeni, days: dny };
  await mkdir(DATA, { recursive: true });
  await writeFile(join(DATA, 'latest.json'), JSON.stringify(latest), 'utf8');
  return latest;
}

// ── spuštění z příkazové řádky ───────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dnes = prahaDatum(0);
  const zitra = prahaDatum(1);
  log(`Sběr cen, český čas: dnes ${dnes}, zítra ${zitra}`);

  let dnesOk = false;
  try { await sberDne(dnes); dnesOk = true; }
  catch (e) { log(`  CHYBA ${e.message}`); }

  try { await sberDne(zitra); }
  catch (e) { log(`  zítřek zatím není: ${e.message}`); }

  const latest = await sestavLatest();
  log(`latest.json: ${Object.keys(latest.days).length} dní`);

  if (!dnesOk && !latest.days[dnes]) {
    console.error(`\nNepodařilo se získat ceny na dnešek (${dnes}). Stránka ukazuje starší data.`);
    process.exit(1);
  }
}
