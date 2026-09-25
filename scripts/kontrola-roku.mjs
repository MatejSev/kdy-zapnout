// ───────────────────────────────────────────────────────────────
// kontrola-roku.mjs — připomínka aktualizace cen po Novém roce
//
// Ceny distribuce se mění k 1. lednu. Když je v src/tarify.js starý
// rok, tahle kontrola selže a GitHub ti pošle e-mail. Sběr cen a web
// přitom dál fungují, jen s loňskými cenami distribuce.
// ───────────────────────────────────────────────────────────────
import { PRICES_YEAR } from '../src/tarify.js';
import { prahaDatum } from './zdroje.mjs';

const rok = Number(prahaDatum(0).slice(0, 4));
if (rok !== PRICES_YEAR) {
  console.error(`Ceny distribuce v src/tarify.js jsou pro rok ${PRICES_YEAR}, ale je ${rok}.`);
  console.error('Zkontroluj nové ceníky distributorů a cenové rozhodnutí ERÚ,');
  console.error('uprav src/tarify.js a zvedni PRICES_YEAR.');
  process.exit(1);
}
console.log(`Ceny distribuce jsou pro letošní rok ${rok}, v pořádku.`);
