# Kdy zapnout

Plánovač spotřeby podle spotové ceny elektřiny. Ukazuje, kdy zapnout bojler, pračku nebo nabít auto, aby to vyšlo co nejlevněji, a kolik to ušetří.

**Jak to spustit a udržovat: [NAVOD.md](NAVOD.md).**

## Jak to funguje

Stránka nemá vlastní server. GitHub Actions každý den stáhne ceny z OTE (záložně z ENTSO-E), kurz z ČNB a předpověď slunce z Open-Meteo, uloží je do `public/data/`, vygeneruje kalendáře k odběru a přestaví web na GitHub Pages.

| Soubor | Co dělá |
|---|---|
| `src/nastaveni.js` | **Všechno, co budeš měnit:** režim premium, odkazy, měření, dodavatelé |
| `src/tarify.js` | Ceny distribuce a poplatků, **jednou ročně aktualizovat** |
| `src/premium.js` | Které funkce jsou premium a kdo k nim má přístup |
| `src/logika.js` | Výpočty: cena za kWh, plánování se souběhem a limitem příkonu, úspory, kalendáře, export |
| `src/app.jsx` | Stránka: obloha s cenami, plán, úspory, připomínky, nastavení, světlý a tmavý vzhled |
| `scripts/sber.mjs` | Denní sběr cen a generování kalendářů |
| `scripts/zdroje.mjs` | Napojení na OTE, ENTSO-E, ČNB, Open-Meteo |
| `scripts/kontrola-roku.mjs` | Připomínka aktualizace cen po Novém roce |
| `scripts/telegram.mjs` | Denní zpráva do telegramového kanálu (nepovinné) |
| `scripts/adresa.mjs` | Plná adresa webu pro náhled při sdílení |
| `public/manifest.webmanifest`, `public/sw.js` | Instalace do telefonu a fungování bez signálu |
| `test/test.mjs` | 93 testů, běží před každým nasazením |
| `.github/workflows/web.yml` | Celá automatizace |

## Lokálně

```bash
npm install
npm test
npm run dev
```
