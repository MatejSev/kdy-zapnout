// ───────────────────────────────────────────────────────────────
// nastaveni.js — všechno, co budeš kdy chtít změnit, je tady
//
// Upravuje se přímo na GitHubu: otevři soubor, klikni na tužku,
// přepiš hodnotu, dej Commit changes. Web se sám přestaví.
// ───────────────────────────────────────────────────────────────

/**
 * Režim premium funkcí.
 *
 *   "zdarma"   všechno odemčené pro všechny, s označením "Premium, teď zdarma"
 *   "placene"  premium funkce se zamknou a ukáže se tlačítko na zaplacení
 *
 * POZOR: na GitHub Pages skutečný paywall udělat nejde. Stránka je
 * statická, takže zámek v prohlížeči jde obejít, a podmínky GitHub
 * Pages navíc placenou službu nepovolují. Než přepneš na "placene",
 * přesuň web na Cloudflare Pages (viz NAVOD.md, část Premium za peníze).
 */
export const PREMIUM_REZIM = "zdarma";

/** Cena předplatného, jen pro zobrazení. */
export const PREMIUM_CENA = 149;

/**
 * Odkaz na platbu, použije se jen v režimu "placene".
 * Typicky Stripe Payment Link: https://buy.stripe.com/...
 */
export const PLATBA_URL = "";

/**
 * Odkaz na formulář pro zpětnou vazbu nebo zájem o novinky.
 * Stačí Google Formulář nebo tally.so. Prázdné = tlačítko se neukáže.
 * Když sbíráš e-maily, potřebuješ k tomu podle GDPR krátké poučení.
 */
export const FORMULAR_URL = "";

/**
 * Měření návštěvnosti přes GoatCounter (bez cookies, bez osobních údajů).
 * Založ si účet na goatcounter.com a sem napiš jen název svého kódu,
 * třeba "kdyzapnout" z adresy kdyzapnout.goatcounter.com.
 * Prázdné = nic se neměří.
 */
export const GOATCOUNTER_KOD = "";

/**
 * Veřejný odkaz na telegramový kanál s denním plánem, třeba
 * "https://t.me/kdyzapnout". Prázdné = odkaz se na stránce neukáže.
 * Jak kanál založit a propojit, je v NAVOD.md (část C.5).
 */
export const TELEGRAM_URL = "";

/**
 * Dodavatelé se spotovým tarifem a jejich přirážka ke spotu.
 *
 * Spotová cena je pro všechny stejná (z OTE). Dodavatelé se liší jen
 * tím, kolik si k ní přirazí. Hodnoty se mění a nejsou nikde ve
 * strojově čitelné podobě, proto tu NEJSOU vymyšlené — doplň je
 * z ceníků dodavatelů (prompt na dohledání je v NAVOD.md).
 *
 * marze: Kč za kWh BEZ DPH, přičítá se ke každé kWh
 * mesicne: Kč za měsíc BEZ DPH, jen pro informaci (do plánu nevstupuje)
 *
 * Příklad záznamu:
 *   { id: "priklad", nazev: "Název dodavatele", marze: 0.35, mesicne: 150,
 *     zdroj: "odkaz na ceník", platnost: "2026-01-01" },
 */
export const DODAVATELE = [];
