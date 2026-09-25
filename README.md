# Kdy zapnout

Plánovač spotřeby podle spotové ceny elektřiny. Ukazuje, kdy zapnout bojler, pračku nebo nabít auto, aby to vyšlo co nejlevněji, a kolik to ušetří.

**Jak to spustit: [NAVOD.md](NAVOD.md).**

## Jak to funguje

Stránka nemá vlastní server. GitHub Actions každý den stáhne ceny z OTE, kurz z ČNB a předpověď slunce z Open-Meteo, uloží je do `public/data/` a přestaví web na GitHub Pages.

| Soubor | Co dělá |
|---|---|
| `src/tarify.js` | Ceny distribuce a poplatků **← jednou ročně aktualizovat** |
| `src/logika.js` | Výpočty: cena za kWh, plánování, úspory |
| `src/app.jsx` | Stránka |
| `scripts/sber.mjs` | Denní sběr cen |
| `scripts/zdroje.mjs` | Napojení na OTE, ČNB, Open-Meteo |
| `scripts/kontrola-roku.mjs` | Připomínka aktualizace cen po Novém roce |
| `test/test.mjs` | Testy, běží před každým nasazením |
| `.github/workflows/web.yml` | Celá automatizace |

## Lokálně

```bash
npm install
npm test
npm run dev
```
