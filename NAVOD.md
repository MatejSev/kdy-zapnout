# Kdy zapnout — návod

Všechno se dělá v prohlížeči na GitHubu, zdarma, bez serveru.

**Co běží samo:** každý den odpoledne se stáhnou ceny z OTE (a když OTE nejede, ze záložního zdroje), kurz z ČNB a předpověď slunce. Otestuje se kód, přestaví web a vygenerují se kalendáře k odběru. Když něco selže, přijde ti e-mail a web běží dál s posledními daty.

**Co sám udělat musíš:** jednou ročně v lednu aktualizovat ceny distribuce (část E). Na to tě upozorní e-mail.

---

# A. Aktualizace tvého běžícího webu
**10 minut**

Tahle verze přináší nový vzhled. Automatizace (`.github/workflows/web.yml`) se **neměnila**, nesahej na ni.

### A.0 Zachraň si svoje nastavení

`src/nastaveni.js` se změnil (přibyl přepínač zkušební verze). Když jsi v něm něco vyplnil — měření, formulář, Telegram, dodavatele — otevři ho na GitHubu a hodnoty si zkopíruj stranou.

### A.1 Nahraj nové soubory

Rozbal `kdy-zapnout.zip`. V repozitáři **Add file** → **Upload files** a přetáhni:

- složky **`src`**, **`scripts`** a **`test`**
- soubory **`package.json`** a **`package-lock.json`** — tentokrát nutně, přibyla knihovna na QR kód a bez nich se web nesestaví

Pak **Commit changes**. Nahráním se nic nemaže, tvoje data v `public/data` zůstanou.

### A.2 Vrať svoje nastavení

Otevři `src/nastaveni.js` → tužka → doplň hodnoty z A.0 → **Commit changes**.

### A.3 Zkontroluj

Za 1–2 minuty má mít běh v záložce **Actions** zelenou fajfku. Otevři web a dej **Ctrl+F5**. Nahoře uvidíš oblohu v barvě denní doby se sloupci cen.

Tvoje uložené nastavení v prohlížeči zůstane.

---

# A2. Čistší adresa zdarma
**20 minut**

Adresa `tvojejmeno.github.io/kdy-zapnout` prozrazuje tvoje jméno a působí jako pokus. Bez placení domény jsou dvě dobré cesty.

### Doporučeno: Cloudflare Pages → `kdyzapnout.pages.dev`

Zdarma, bez tvého jména, a na rozdíl od GitHub Pages **povoluje i placenou službu** — až budeš spouštět premium, nebudeš se muset znovu stěhovat. Sběr cen zůstane na GitHubu; Cloudflare si web přestaví pokaždé, když GitHub uloží nová data.

1. Založ si zdarma účet na [cloudflare.com](https://cloudflare.com).
2. V administraci otevři **Workers & Pages** → **Create** → záložka **Pages** → **Connect to Git**.
3. Povol Cloudflare přístup ke GitHubu a vyber repozitář `kdy-zapnout`.
4. **Project name:** `kdyzapnout` — z toho bude adresa `kdyzapnout.pages.dev`. Když je obsazená, zvol jiný název.
5. Nastavení sestavení:
   - **Framework preset:** None
   - **Build command:** `npm test && npm run build`
   - **Build output directory:** `dist`
6. **Environment variables** — přidej dvě:
   - `NODE_VERSION` = `24`
   - `SITE_URL` = `https://kdyzapnout.pages.dev/` (podle názvu z kroku 4)
7. **Save and Deploy**. Za pár minut web poběží na nové adrese.
8. Na GitHubu nastav stejnou adresu i pro automatizaci, aby na ni odkazovaly zprávy do Telegramu: **Settings** → **Secrets and variables** → **Actions** → záložka **Variables** → **New repository variable** → Name `SITE_URL`, Value `https://kdyzapnout.pages.dev/`.

**Když Cloudflare založí projekt jako „Worker"** (v nastavení je pak i *Deploy command* `npx wrangler deploy`), postará se o nasazení soubor `wrangler.jsonc` v repozitáři — stačí, aby tam byl. Adresa pak bude `kdyzapnout.NĚCO.workers.dev`, kde „NĚCO" je subdoména tvého účtu. Když obsahuje tvoje jméno, změň ji v nastavení účtu u Workers & Pages na něco neutrálního. Do `SITE_URL` (v Cloudflaru i na GitHubu) pak napiš tuhle adresu.

`npm test` v kroku 5 je pojistka: když testy neprojdou, Cloudflare novou verzi nenasadí a nechá běžet poslední funkční.

GitHub Pages můžeš nechat běžet jako zálohu. Lidem ale posílej jen novou adresu.

Rozhraní Cloudflaru se občas mění. Kdyby některé tlačítko neodpovídalo, hledej stejný význam — připojení repozitáře z GitHubu, příkaz pro sestavení a výstupní složku.

### Jednodušší: GitHub organizace → `kdyzapnout.github.io`

Všechno zůstane na GitHubu, ale adresa obsahuje „github" a GitHub Pages nepovoluje placenou službu.

1. Na GitHubu **+** → **New organization** → bezplatný plán → název `kdyzapnout`.
2. V repozitáři **Settings** → **General** → úplně dole **Transfer ownership** → převeď ho do organizace.
3. Přejmenuj repozitář na `kdyzapnout.github.io` (Settings → General → Repository name).
4. Zkontroluj v novém umístění **Pages** (Source: GitHub Actions), **oprávnění** (Read and write) a **tajemství** (Telegram, ENTSO-E). Když tam tajemství nejsou, přidej je znovu.

Web pak poběží přímo na `https://kdyzapnout.github.io/`. Kód je na tuhle adresu připravený.

### Starý počítač

Lepší adresu zdarma nedá a závisí na proudu a internetu doma. Nech ho jen jako zálohu.

---

# B. Nastavení od nuly
**30–45 minut** — jen kdybys zakládal nový web

1. **Účet:** [github.com](https://github.com) → Sign up. Na tenhle e-mail budou chodit upozornění.
2. **Repozitář:** vpravo nahoře **+** → **New repository** → název `kdy-zapnout` → **Public** → zaškrtni **Add a README file** → **Create repository**
3. **Soubory:** **Add file** → **Upload files** → přetáhni obsah rozbalené složky (bez `.github`, ta bývá skrytá) → **Commit changes**. Zkontroluj, že vidíš i **`package-lock.json`** — bez něj automatizace spadne.
4. **Automatizace:** **Add file** → **Create new file** → název přesně `.github/workflows/web.yml` → vlož obsah z přílohy → **Commit changes**
5. **Pages:** **Settings** → **Pages** → Source: **GitHub Actions**
6. **Oprávnění:** **Settings** → **Actions** → **General** → dole **Read and write permissions** → **Save**
7. **Spuštění:** **Actions** → **Ceny a web** → **Run workflow**. Po zelené fajfce najdeš u kroku `nasazeni` adresu webu, `https://TVOJE_JMENO.github.io/kdy-zapnout/`.

Úspory se ukážou po třech dnech sběru. Do té doby stránka poctivě napíše, že sbírá data.

---

# C. Nepovinná vylepšení
**5–10 minut každé, všechno v prohlížeči**

Všechno kromě C.1 se nastavuje v souboru **`src/nastaveni.js`**: otevři ho na GitHubu, klikni na tužku, přepiš hodnotu, **Commit changes**. Web se sám přestaví a testy před nasazením zkontrolují, že je hodnota v pořádku.

### C.1 Záložní zdroj cen (ENTSO-E)

Když OTE vypadne nebo změní formát, web si ceny vezme z ENTSO-E — evropské platformy, která publikuje stejné české ceny a má oficiální rozhraní. Bez tohohle se při výpadku OTE den nestáhne a přijde e-mail.

1. Zaregistruj se na [transparency.entsoe.eu](https://transparency.entsoe.eu) (vpravo nahoře Login → Register)
2. Pošli e-mail na **transparency@entsoe.eu** s předmětem **Restful API access** a do textu napiš e-mail, pod kterým ses registroval. Schválení trvá obvykle pár dní. (Takhle postup funguje v době psaní návodu, ENTSO-E ho může změnit.)
3. Po schválení v nastavení účtu vygeneruj **Web API Security Token** a zkopíruj ho
4. Na GitHubu: **Settings** → **Secrets and variables** → **Actions** → **New repository secret**
5. Name: `ENTSOE_TOKEN`, Secret: vlož token → **Add secret**

Token je tajný a nikde na webu se neobjeví. Když na stránce někdy uvidíš „Ceny z ENTSO-E (záloha)", znamená to, že OTE ten den nejelo a záloha zafungovala.

### C.2 Kolik lidí stránku navštěvuje

GitHub návštěvnost stránky neukazuje, a přitom to je hlavní věc, kterou teď potřebuješ zjistit. Doporučuju GoatCounter — nepoužívá cookies ani neukládá osobní údaje, takže nepotřebuješ lištu se souhlasem, a pro menší nekomerční weby je zdarma.

1. Zaregistruj se na [goatcounter.com](https://www.goatcounter.com) a zvol si kód, třeba `kdyzapnout`
2. V `src/nastaveni.js` nastav:
   ```
   export const GOATCOUNTER_KOD = "kdyzapnout";
   ```
3. Návštěvnost pak uvidíš na `https://kdyzapnout.goatcounter.com`

Sleduj hlavně, jestli se lidé **vracejí** — to je jediný signál, který opravdu něco říká.

### C.3 Formulář pro zpětnou vazbu

Do patičky přibude odkaz „Napiš nám, co ti chybí".

1. Vytvoř si formulář v [Google Formulářích](https://forms.google.com) nebo na [tally.so](https://tally.so)
2. Zkopíruj jeho odkaz a v `src/nastaveni.js` nastav:
   ```
   export const FORMULAR_URL = "https://forms.gle/...";
   ```

Když ve formuláři chceš e-mail, připiš k němu větu, k čemu ho použiješ a že ho na požádání smažeš. To po tobě chce GDPR.

### C.4 Přirážky dodavatelů

Spotová cena je u všech dodavatelů stejná, liší se jen přirážka. Ta se mění a není nikde ve strojově čitelné podobě, proto ji aplikace nemá předvyplněnou. Nech si ji dohledat stejně jako ceny distribuce — zadej Gemini s **zapnutým vyhledáváním** tenhle prompt:

```
Potřebuji aktuální ceníky spotových (dynamických) tarifů elektřiny pro
domácnosti v ČR. Vyhledej je na webu dodavatelů, nevymýšlej je.

Pro každého dodavatele, který spotový tarif nabízí, uveď:
- přirážku ke spotové ceně v Kč za MWh BEZ DPH
- pevný měsíční poplatek v Kč BEZ DPH
- přímý odkaz na ceník
- od kdy ceník platí

Když něco nenajdeš, napiš to a nech to prázdné. Nepřesné číslo je
horší než chybějící.

Výsledek napiš přesně v tomhle tvaru (přirážku převeď na Kč za kWh,
tedy vyděl tisícem):

{ id: "zkratka", nazev: "Název dodavatele", marze: 0.35, mesicne: 150,
  zdroj: "https://odkaz-na-cenik", platnost: "2026-01-01" },
```

Záznamy, které dostaneš, zkontroluj proti odkazům a vlož je do `src/nastaveni.js` mezi hranaté závorky `DODAVATELE = [ ... ]`. Testy před nasazením ověří, že každý má zdroj a rozumnou výši přirážky.

### C.5 Denní plán do Telegramu

Každé odpoledne, jakmile jsou známé ceny na zítřek, pošle automatizace do telegramového kanálu krátkou zprávu: kdy bude nejlevněji, kdy nejdráž a jestli je den výjimečný. Lidé nemusí nic instalovat ani otevírat stránku, a ty s nimi máš každodenní kontakt.

1. V Telegramu napiš **@BotFather**, pošli `/newbot` a projdi otázky. Na konci dostaneš **token** — dlouhý řetězec s dvojtečkou.
2. Založ **veřejný kanál** (Nový kanál → Veřejný) a zvol mu adresu, třeba `kdyzapnout`.
3. V nastavení kanálu přidej svého bota mezi **administrátory** s právem posílat zprávy.
4. Na GitHubu: **Settings** → **Secrets and variables** → **Actions** → **New repository secret**, dvakrát:
   - Name `TELEGRAM_TOKEN`, Secret: token od BotFathera
   - Name `TELEGRAM_CHAT`, Secret: `@kdyzapnout` (adresa kanálu se zavináčem)
5. V `src/nastaveni.js` nastav odkaz, aby se na stránce objevilo tlačítko:
   ```
   export const TELEGRAM_URL = "https://t.me/kdyzapnout";
   ```

První zpráva přijde při nejbližším odpoledním běhu. Když se něco nepovede, sběr ani web se nezastaví — u běhu se jen objeví žluté varování s důvodem.

### C.6 Vlastní doména

Až si koupíš doménu a nasměruješ ji na GitHub Pages, nastav ji i pro náhled při sdílení: **Settings** → **Secrets and variables** → **Actions** → záložka **Variables** → **New repository variable**, Name `SITE_URL`, Value třeba `https://kdyzapnout.cz/`. Bez toho se adresa odvodí sama z názvu repozitáře.

---

# D. Když přijde e-mail

GitHub posílá e-mail, když automatizace selže. V záložce **Actions** klikni na běh s červeným křížkem a pak na krok, který selhal:

| Krok | Co to znamená | Co udělat |
|---|---|---|
| **nasazeni** s hláškou *not acquired by Runner* nebo *Internal server error* | Výpadek na straně GitHubu, ne chyba v kódu | Nic. Web běží dál s posledními daty a další plánovaný běh to nasadí. Kdo nechce čekat, klikne u běhu **Re-run jobs**. |
| **Testy** | V kódu je chyba | Nic se nerozbilo, na webu zůstala poslední funkční verze. Pošli mi text chyby. |
| **Sběr cen z OTE** | OTE neodpovídá nebo ceny ještě nejsou zveřejněné | Jednorázově nevadí, druhý pokus je večer. Když to trvá déle než den, pošli mi text. Záložní zdroj (C.1) tomu předejde. |
| **Uložení nasbíraných dat** | Chybí oprávnění | Zkontroluj krok 6 v části B |
| **Jsou ceny distribuce pro letošní rok?** | Je nový rok | Část E |

---

# E. Jednou ročně: ceny distribuce
**15 minut, v lednu**

1. Zjisti nové ceny: ceníky distribuce ČEZ, EG.D a PRE a cenové rozhodnutí ERÚ. Použij stejný prompt jako minule.
2. Otevři `src/tarify.js` → tužka
3. Přepiš čísla a nahoře změň `PRICES_YEAR` na nový rok
4. **Commit changes**

Web se sám přestaví, testy ověří, že je všechno vyplněné.

---

# F. Premium za peníze
**Až to bude mít smysl — ne dřív**

Aplikace je na to připravená: v `src/nastaveni.js` stačí změnit `PREMIUM_REZIM` z `"zdarma"` na `"placene"` a vyplnit `PLATBA_URL`. Premium sekce se pak zamknou a ukáže se tlačítko na zaplacení. Kdybys zapomněl odkaz na platbu, testy selžou a web se nenasadí — jinak by šly funkce zamknout bez možnosti je odemknout.

**Ale na GitHub Pages to nepřepínej, ze dvou důvodů:**

1. **Podmínky GitHub Pages placenou službu nepovolují.** Zdarma a nekomerčně je všechno v pořádku.
2. **Na statické stránce nejde udělat skutečný zámek.** Kdo zmáčkne F12, zámek obejde. A hlavně: kalendáře k odběru jsou obyčejné soubory, které si může stáhnout kdokoli, kdo zná adresu.

Až budeš chtít brát peníze, bude potřeba:

- **přesun na Cloudflare Pages** — zdarma, komerční použití povolené, stejné soubory
- **malý kousek serveru** (Cloudflare Workers, taky zdarma), který ověří, že člověk zaplatil, a teprve pak mu pustí premium data
- **platební brána**, nejjednodušeji Stripe Payment Link

Tuhle část ti napíšu, až na ni dojde. Nemá smysl ji stavět dřív, než víš, že o službu někdo stojí — to ti řeknou čísla z části C.2.

Ve stejné chvíli budeš řešit i věci mimo kód: obchodní podmínky, poučení o osobních údajích podle GDPR, a jak budeš příjmy danit — na to se poraď s účetní. A v reklamě se drž toho, co stránka píše teď: „ušetříš" s viditelnou metodikou, ne „vyděláš".

---

# P. Než začneš stránku propagovat
**Jedno odpoledne**

Pořadí je důležité: bez měření a zpětné vazby by ses z testování nic nedozvěděl.

1. **Nahraj novou verzi** (část A) a **přesuň web na čistší adresu** (část A2).
2. **Zapni měření** (C.2). Stránka teď měří i to, které funkce lidé používají: kalendář, zítřek, přenos nastavení, export, odpovědi na „Pomohl ti dnešní plán?". Uvidíš to v GoatCounteru jako události. Jedno omezení: měření bez cookies nepozná, jestli se stejný člověk vrací.
3. **Zapni formulář** (C.3) — odkaz se objeví ve štítku „Zkušební verze" a u odpovědi „Ne".
4. **Založ telegramový kanál** (C.5). Počet odběratelů je nejlepší měřítko, jestli o stránku lidé stojí i druhý týden.
5. **Zkontroluj náhled odkazu** ve Facebook Sharing Debuggeru: vlož novou adresu a ověř, že se ukáže obrázek a popis.
6. **Vyzkoušej to na svém telefonu**: přidání na plochu, přenos nastavení QR kódem z počítače, tmavý režim, kalendář k odběru.
7. **Pět až deset lidí osobně.** Kdokoli s panely, elektromobilem nebo spotovým tarifem. Dívej se jim přes rameno, jak stránku poprvé používají, a nic nevysvětluj. Kde se zaseknou, tam je chyba.
8. **Komunity**: facebookové skupiny o spotových tarifech, fotovoltaice, tepelných čerpadlech a elektromobilech, fórum TZB-info, česká komunita Home Assistantu. Přečti si pravidla a radši se předem zeptej správce. Piš odpoledne, kdy už jsou známé zítřejší ceny, ideálně v den, kdy stránka hlásí výjimečně rozkolísané ceny.
9. **Po dvou týdnech vyhodnoť**: odběratelé na Telegramu, poměr odpovědí Ano a Ne, vyplněné formuláře, které funkce se používají. Předem si urči, co bude úspěch — třeba 30 odběratelů a 10 formulářů.

Návrh příspěvku:

> Ahoj, udělal jsem bezplatný nástroj pro lidi se spotovou elektřinou: ukáže, kdy dnes a zítra zapnout bojler, pračku nebo nabít auto, aby to vyšlo nejlevněji. Ceny bere z OTE a počítá s distribucí podle vašeho distributora a sazby. Umí hlídat, aby nepadaly pojistky, a plán pošle do kalendáře v telefonu.
>
> Je to zkušební verze a hledám pár lidí, kteří to zkusí a řeknou mi, co jim chybí nebo co nefunguje. Nic neprodávám, žádná registrace.
>
> [odkaz]
>
> Úspory, které stránka ukazuje, jsou spočítané ze skutečných cen, ale z typické spotřeby — skutečné se můžou lišit.

---

# Co stránka umí a na čem stojí

Podrobný přehled najdeš přímo na webu v záložce **Co všechno umí**. Ve zkratce:

**Zdarma:** plán na dnešek a zítřek, co zapnout teď s odpočtem, nejlevnější okno v příštích 24 hodinách, barevná mapa cen po hodinách, úspora podle typu domácnosti, jednorázové stažení plánu do kalendáře, vlastní tarif, dodavatel a spotřebiče.

**Omezení, aby nepadaly pojistky:** u každého spotřebiče jde nastavit, se kterými nesmí běžet současně (třeba myčka a sušička na jednom okruhu), a pro celý dům limit příkonu. Plán spotřebiče rozloží tak, aby se nesešly, a u každého posunutého napíše proč a kolik to stojí navíc. Co se do limitu nevejde, stránka neukáže potichu jinak, ale řekne to a poradí, co změnit.

**Vzhled:** nahoře obloha v barvě skutečné denní doby a na ní 24 sloupců cen se sluncem v aktuální hodině; klepnutím na sloupec se ukáže cena. Plán jako přehledný seznam, na mobilu spodní lišta jako v aplikaci, světlý i tmavý režim podle telefonu nebo ručně. Animace jen při načtení a jako odpověď na akci; kdo má v telefonu omezené animace, uvidí vše bez pohybu.

**Bez registrace:** nastavení se pamatuje v prohlížeči a do jiného zařízení se přenese QR kódem nebo odkazem. Odkaz se před načtením zeptá a jeho obsah se ověří.

**Pro testování:** štítek „Zkušební verze", otázka „Pomohl ti dnešní plán?" a měření používaných funkcí (když je zapnuté).

**Pro pohodlí:** stránka jde přidat na plochu telefonu jako aplikace a bez signálu ukáže poslední stažené ceny. Při sdílení odkazu na Facebooku nebo v Messengeru se zobrazí obrázek s popisem. Dole jsou časté otázky. Volitelně denní zpráva do Telegramu.

**Vyplatí se mi spot?** Když v záložce Můj tarif zadáš svůj současný fixní tarif, ukáže se nahoře u úspor, o kolik by spotřebiče v plánu vyšly na spotu levněji nebo dráž.

**Premium, teď zdarma:** kalendář, který se sám aktualizuje a posílá připomínky, upozornění na výjimečně rozkolísaný den, historie s měsíčním přehledem, export do tabulky.

**Předpoklady, které jsou v číslech:** spotřeba spotřebičů je typický odhad, počítá se s dodržením plánu, úspora je proti spouštění kdykoli (ne proti fixnímu tarifu), předpověď slunce je pro střed republiky, kalendáře k odběru počítají s obecným tarifem D02d.

**Jak plánuje s omezeními:** postupně podle přednosti — spotřebič s vyšší předností si vybere nejlevnější hodiny jako první a ostatní se přizpůsobí. Je to rychlé a dobře vysvětlitelné, ale ne vždy matematicky nejlevnější možné rozložení. U pár spotřebičů za den bývá rozdíl zanedbatelný; když ti na některém záleží víc, dej mu vyšší přednost.

**Limit příkonu počítá s celým domem dohromady**, ne po jednotlivých fázích nebo okruzích. Jestli ti padá jeden konkrétní okruh, nastav zákaz souběhu mezi spotřebiči na něm — to je přesnější než celkový limit.

**Co neumí:** sama spotřebiče nezapne. Na to by bylo potřeba napojení na chytré zásuvky.

---

# Příloha: obsah souboru `.github/workflows/web.yml`

```yaml
# ─────────────────────────────────────────────────────────────────
# Ceny a web — celá automatizace na jednom místě
#
# Každý den:  stáhne ceny z OTE → otestuje kód → přestaví web → zveřejní
# Při změně:  totéž, když nahraješ nový kód
# Při chybě:  GitHub ti pošle e-mail, web běží dál s posledními daty
#
# Když selže krok "nasazeni" s hláškou "not acquired by Runner" nebo
# "Internal server error", je to výpadek na straně GitHubu, ne chyba
# v kódu. Další plánovaný běh to nasadí sám, nebo klikni Re-run jobs.
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
    # bez limitu by zaseknutý běh čekal až 6 hodin a blokoval další
    timeout-minutes: 15
    outputs:
      sber: ${{ steps.sber.outcome }}
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          node-version: 24
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
        env:
          # nepovinné: záložní zdroj ENTSO-E, když OTE selže (viz NAVOD.md)
          ENTSOE_TOKEN: ${{ secrets.ENTSOE_TOKEN }}
          # nepovinné: denní plán do telegramového kanálu (viz NAVOD.md)
          TELEGRAM_TOKEN: ${{ secrets.TELEGRAM_TOKEN }}
          TELEGRAM_CHAT: ${{ secrets.TELEGRAM_CHAT }}
          SITE_URL: ${{ vars.SITE_URL }}
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
        env:
          # vlastní doména pro náhled při sdílení; prázdné = odvodí se z GitHubu
          SITE_URL: ${{ vars.SITE_URL }}
        run: npm run build

      - uses: actions/upload-pages-artifact@v5
        with:
          path: dist

  nasazeni:
    needs: sestaveni
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment:
      name: github-pages
      url: ${{ steps.nasazeni.outputs.page_url }}
    steps:
      - id: nasazeni
        uses: actions/deploy-pages@v5

      - name: Hlášení, že sběr selhal
        if: needs.sestaveni.outputs.sber != 'success'
        run: |
          echo "::error::Sběr cen z OTE selhal. Web běží dál se staršími daty. Detail je v kroku Sběr cen z OTE."
          exit 1

  # Po Novém roce připomene, že je potřeba aktualizovat ceny distribuce.
  kontrola-cen:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - name: Jsou ceny distribuce pro letošní rok?
        run: npm run kontrola
```
