# Kdy zapnout — spuštění zdarma, jen v prohlížeči

Žádný server, žádný terminál, žádné poplatky. Stránku vystaví a každý den aktualizuje GitHub, zdarma.

**Čas: 30–45 minut.** Všechno se dělá klikáním v prohlížeči.

---

## Co to bude umět samo

- Každý den odpoledne stáhne ceny z OTE, kurz z ČNB a předpověď slunce
- Otestuje kód a teprve pak přestaví web
- Když něco selže, **pošle ti e-mail** a web běží dál s posledními daty
- Po Novém roce ti e-mailem připomene aktualizaci cen distribuce

## Co automatizovat nejde (a proč)

Buď si vědom dvou věcí, ať tě nic nepřekvapí:

**Jednou ročně ceny distribuce.** Mění se k 1. lednu a nikde nejsou ve strojově čitelné podobě. Po Novém roce přijde e-mail a úprava zabere 15 minut (část 8).

**Změna u OTE.** Adresa, ze které se berou ceny, není oficiální rozhraní a OTE ji může změnit — jako když přešlo na čtvrthodiny. Pak přijde e-mail, že sběr selhal. Pošli mi text chyby a opravíme to.

---

# 1. Založ si účet na GitHubu
**5 minut**

Jdi na [github.com](https://github.com) a klikni na **Sign up**. Stačí e-mail a heslo, účet je zdarma.

Na tenhle e-mail ti budou chodit upozornění, když se něco pokazí, tak použij ten, který čteš.

---

# 2. Vytvoř repozitář
**2 minuty**

Repozitář je složka na GitHubu, kde bude celá aplikace.

1. Vpravo nahoře klikni na **+** a pak **New repository**
2. **Repository name:** `kdy-zapnout`
3. Zvol **Public** (u soukromého by GitHub Pages zdarma nešly)
4. Zaškrtni **Add a README file**
5. Klikni **Create repository**

---

# 3. Nahraj soubory
**10 minut**

Rozbal si `kdy-zapnout.zip` na počítači.

1. V repozitáři klikni na **Add file** a pak **Upload files**
2. Otevři rozbalenou složku `kdy-zapnout` a **přetáhni do okna prohlížeče všechno, co v ní je** — soubory i složky `src`, `scripts`, `test`, `public`
3. Počkej, až se všechno nahraje
4. Dole klikni na zelené **Commit changes**

⚠️ **Složku `.github` takhle nahrát nejde** — tečka na začátku ji na Macu i ve Windows často skryje. Uděláš ji v dalším kroku ručně.

Pro kontrolu: v repozitáři teď musíš vidět `package.json`, **`package-lock.json`**, `index.html`, `vite.config.js` a složky `src`, `scripts`, `test`. Bez `package-lock.json` automatizace spadne hned na začátku.

---

# 4. Vytvoř soubor s automatizací
**5 minut**

Tohle je ten soubor, který GitHubu říká, co má každý den dělat.

1. Klikni na **Add file** a pak **Create new file**
2. Do políčka s názvem napiš **přesně**:
   ```
   .github/workflows/web.yml
   ```
   Jakmile napíšeš lomítko, GitHub z toho sám udělá složku — to je správně.
3. Do velkého pole vlož celý obsah z přílohy na konci tohoto návodu (začíná `# ───` a končí `run: npm run kontrola`)
4. Klikni na **Commit changes** a ještě jednou **Commit changes**

---

# 5. Zapni GitHub Pages a oprávnění
**3 minuty**

**Pages** — aby se web zveřejnil:

1. V repozitáři nahoře klikni na **Settings**
2. Vlevo **Pages**
3. U **Source** vyber **GitHub Actions**

**Oprávnění** — aby mohl sběr ukládat data:

1. Pořád v **Settings**, vlevo **Actions** a pak **General**
2. Úplně dole u **Workflow permissions** zvol **Read and write permissions**
3. Klikni **Save**

---

# 6. Spusť to poprvé
**5 minut, většinu čeká GitHub**

1. Nahoře klikni na záložku **Actions**
2. Vlevo klikni na **Ceny a web**
3. Vpravo klikni na **Run workflow** a znovu **Run workflow**
4. Počkej 1–2 minuty, až se u běhu objeví zelená fajfka

Klikni na dokončený běh a u kroku **nasazeni** uvidíš adresu tvého webu. Bude vypadat takhle:

```
https://TVOJE_JMENO.github.io/kdy-zapnout/
```

Otevři ji. Stránka by měla ukázat dnešní ceny, tabuli „co teď" a hodinovou mapu.

**Úspory v horní části se ukážou až po třech dnech sběru.** Do té doby tam stránka poctivě napíše, že sbírá data. Chceš je hned? Viz část 7.

### Když je u běhu červený křížek

Klikni na něj a pak na krok, který selhal:

| Krok | Co to znamená |
|---|---|
| **Testy** | V kódu je chyba. Na webu zůstala poslední funkční verze. Pošli mi text. |
| **Sběr cen z OTE** | OTE neodpovídá nebo ceny ještě nejsou zveřejněné. Když to trvá déle než den, pošli mi text. |
| **Uložení nasbíraných dat** | Chybí oprávnění, zkontroluj část 5. |
| **nasazeni** | Nejsou zapnuté Pages, zkontroluj část 5. |

---

# 7. Přenes si data ze starého serveru (nepovinné)
**10 minut**

Na starém počítači máš nasbíraná data za několik týdnů. Když je nahraješ, úspory se ukážou hned místo za tři dny. Formát souborů je stejný, nic se nepřevádí.

Tady potřebuješ naposledy terminál. Na serveru:

```
sudo tar czf /tmp/ceny.tar.gz -C /opt/spot-optimizer/data prices
```

```
sudo chmod 644 /tmp/ceny.tar.gz
```

Na svém počítači (přepiš jméno a IP):

```
scp jakub@IP:/tmp/ceny.tar.gz .
```

Rozbal `ceny.tar.gz` (na Windows třeba přes 7-Zip). Dostaneš složku se soubory typu `2026-09-12.json`.

Na GitHubu:

1. Otevři v repozitáři složku `public`, pak `data`, pak `prices`
2. **Add file** a pak **Upload files**
3. Přetáhni tam všechny soubory `.json`
4. **Commit changes**

Nahrání samo spustí přestavění webu. Za dvě minuty uvidíš úspory ze svých skutečných dat.

Potom můžeš starý počítač vypnout.

---

# 8. Jednou ročně: nové ceny distribuce
**15 minut, v lednu**

Po Novém roce ti přijde e-mail, že selhala **Kontrola cen**. Web mezitím dál funguje, jen počítá s loňskou distribucí.

1. Zjisti nové ceny: ceník distribuce ČEZ, EG.D a PRE, a cenové rozhodnutí ERÚ. Můžeš na to použít stejný prompt jako letos.
2. V repozitáři otevři `src`, pak `tarify.js`
3. Klikni na **tužku** vpravo nahoře (Edit)
4. Přepiš čísla a nahoře změň `PRICES_YEAR = 2026` na nový rok
5. **Commit changes**

Web se sám přestaví. Testy před nasazením ověří, že je všechno vyplněné.

---

# 9. Než začneš brát peníze

GitHub Pages je zdarma pro osobní a neziskové stránky. **Na placenou službu je jejich podmínky nepovolují.** Dokud je web zdarma a zjišťuješ, jestli o něj někdo stojí, je všechno v pořádku.

Až budeš chtít spustit předplatné, přesuň web na **Cloudflare Pages** — je taky zdarma a komerční použití povoluje. Soubory jsou stejné, jen je propojíš s tímhle repozitářem. Až na to dojde, napiš a projdeme to.

Ve stejné chvíli budeš řešit i tohle:

- **Doména.** Adresa `github.io` je na zjišťování zájmu v pořádku, na placenou službu působí méně důvěryhodně.
- **GDPR.** Dokud nemáš uživatelské účty, žádná osobní data nezpracováváš. S předplatným už ano.
- **Tvrzení o úsporách.** Stránka píše „ušetříš" s viditelnou metodikou, ne „vyděláš". V reklamě se toho drž, jinak riskuješ problém s ČOI.

---

# Dvě drobnosti, které se hodí vědět

**GitHub může naplánované běhy opozdit** o pár minut až desítky minut, když má moc práce. Na ceny, které platí celý den, to nemá vliv.

**Když se v repozitáři 60 dní nic nestane, GitHub automatické běhy vypne.** Každodenní ukládání dat se jako aktivita počítá, takže by se to stát nemělo. Kdyby ano, přijde e-mail a v záložce Actions je znovu zapneš jedním tlačítkem.

---

# Příloha: obsah souboru `.github/workflows/web.yml`

Zkopíruj celý blok níž do kroku 4:

```yaml
# ─────────────────────────────────────────────────────────────────
# Ceny a web — celá automatizace na jednom místě
#
# Každý den:  stáhne ceny z OTE → otestuje kód → přestaví web → zveřejní
# Při změně:  totéž, když nahraješ nový kód
# Při chybě:  GitHub ti pošle e-mail, web běží dál s posledními daty
#
# Časy jsou v UTC (GitHub jinak neumí):
#   12:40 UTC = 14:40 letní čas / 13:40 zimní čas
#   16:10 UTC = 18:10 letní čas / 17:10 zimní čas (druhý pokus)
# ─────────────────────────────────────────────────────────────────
name: Ceny a web

on:
  schedule:
    - cron: '40 12 * * *'
    - cron: '10 16 * * *'
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: write   # uložit nasbíraná data zpět do repozitáře
  pages: write      # zveřejnit web
  id-token: write

concurrency:
  group: web
  cancel-in-progress: false

jobs:
  sestaveni:
    runs-on: ubuntu-latest
    outputs:
      sber: ${{ steps.sber.outcome }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci

      # Když testy neprojdou, dál se nepokračuje a na webu zůstane
      # poslední funkční verze.
      - name: Testy
        run: npm test

      # Sběr může selhat (OTE neodpovídá, ceny ještě nejsou). Web se
      # i tak přestaví se staršími daty a na konci přijde e-mail.
      - name: Sběr cen z OTE
        id: sber
        continue-on-error: true
        run: npm run sber

      - name: Uložení nasbíraných dat
        run: |
          git config user.name "sber-cen"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add public/data
          if git diff --cached --quiet; then
            echo "Žádná nová data."
          else
            git commit -m "Ceny $(TZ=Europe/Prague date +%F)"
            git pull --rebase origin main
            git push
          fi

      - name: Sestavení webu
        run: npm run build

      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist

  nasazeni:
    needs: sestaveni
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.nasazeni.outputs.page_url }}
    steps:
      - id: nasazeni
        uses: actions/deploy-pages@v4

      - name: Hlášení, že sběr selhal
        if: needs.sestaveni.outputs.sber != 'success'
        run: |
          echo "::error::Sběr cen z OTE selhal. Web běží dál se staršími daty. Detail je v kroku Sběr cen z OTE."
          exit 1

  # Po Novém roce připomene, že je potřeba aktualizovat ceny distribuce.
  kontrola-cen:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Jsou ceny distribuce pro letošní rok?
        run: npm run kontrola
```
