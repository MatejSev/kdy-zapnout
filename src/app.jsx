import React, { useState, useEffect, useMemo, useRef } from "react";
import QRCode from "qrcode";
import {
  DISTRIBUTORS, DEFAULT_NT_HOURS, OTE_MONTHLY, SYSTEM_FEES,
} from "./tarify.js";
import {
  toFinalPrices, optimize, actionFor, odpocet, dayCharacter, buildIcs, isoDay,
  cheapestWindow, oknoPopis, tier, hoursLabel, dni, czDate, backtest,
  PROFILY, VYCHOZI_PROFIL, mesicniPrehled, csvHodiny, csvDny, srovnaniSFixem,
  SABLONY, novySpotrebic, doplnSpotrebice, prepniKonflikt, odeberSpotrebic,
  zakodujNastaveni, dekodujNastaveni, vHodin, pocetSpotrebicu,
} from "./logika.js";
import {
  PREMIUM_CENA, PLATBA_URL, FORMULAR_URL, GOATCOUNTER_KOD, DODAVATELE, TELEGRAM_URL, ZKUSEBNI_VERZE,
} from "./nastaveni.js";
import { FUNKCE, jePremium, jeZdarmaRezim } from "./premium.js";

// ═══════════════════════════════════════════════════════════════
// Kdy zapnout — plánovač spotřeby podle spotové ceny
//
// Stránka nemá vlastní server. Data jí každý den připraví GitHub
// Actions do souboru data/latest.json a stránka si ho jen přečte.
//
// Všechna čísla jsou ze skutečných zdrojů: spotové ceny z OTE, kurz
// z ČNB, předpověď slunce z Open-Meteo, distribuce z ceníků 2026.
// Úspory jsou modelové: skutečné ceny, modelované chování. Nikde se
// netvrdí "ušetřili jste" ani "vyděláte".
// ═══════════════════════════════════════════════════════════════

const DATA_URL = "data/latest.json";
const KLIC = "kdyzapnout:v1";
const KLIC_MOTIV = "kdyzapnout:motiv";

/**
 * Měření, které funkce lidé používají (události GoatCounteru).
 * Když měření není v nastaveni.js zapnuté, nedělá nic.
 */
function zaznam(udalost) {
  try { window.goatcounter?.count?.({ path: `udalost/${udalost}`, title: udalost, event: true }); } catch { /* nevadí */ }
}

const malyPohyb = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Číslo, které se při změně plynule dopočítá (třeba úspora po přepnutí
 * domácnosti). Při prvním vykreslení se neanimuje — pohyb jen jako
 * odpověď na akci uživatele.
 */
function useTween(cil, ms = 650) {
  const [v, setV] = useState(cil);
  const od = useRef(cil);
  useEffect(() => {
    const zacatek = od.current;
    if (!Number.isFinite(cil) || !Number.isFinite(zacatek) || zacatek === cil || malyPohyb()) {
      od.current = cil; setV(cil); return undefined;
    }
    let raf;
    const t0 = performance.now();
    const krok = (t) => {
      const p = Math.min(1, (t - t0) / ms);
      const x = zacatek + (cil - zacatek) * (1 - Math.pow(1 - p, 3));
      od.current = x; setV(x);
      if (p < 1) raf = requestAnimationFrame(krok);
    };
    raf = requestAnimationFrame(krok);
    return () => cancelAnimationFrame(raf);
  }, [cil, ms]);
  return v;
}

/**
 * Barva oblohy podle denní doby. Všechny odstíny jsou dost tmavé,
 * aby na nich bílý text měl kontrast aspoň 4,5 : 1.
 */
const OBLOHA = [
  [0, "#0E1529", "#1A2442"], [5, "#1C2450", "#33356A"], [6.5, "#363A76", "#A65A62"],
  [8, "#26508A", "#4F78B0"], [13, "#214A84", "#4672AD"], [17.5, "#2A4683", "#6A5E98"],
  [19.5, "#38306E", "#985252"], [21, "#1A2246", "#2A2F5E"], [24, "#0E1529", "#1A2442"],
];
function obloha(h) {
  const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const mix = (a, b, t) => "#" + hex(a).map((x, i) => Math.round(x + (hex(b)[i] - x) * t).toString(16).padStart(2, "0")).join("");
  for (let i = 0; i < OBLOHA.length - 1; i++) {
    const [h0, a0, b0] = OBLOHA[i], [h1, a1, b1] = OBLOHA[i + 1];
    if (h >= h0 && h <= h1) { const t = (h - h0) / (h1 - h0 || 1); return [mix(a0, a1, t), mix(b0, b1, t)]; }
  }
  return [OBLOHA[0][1], OBLOHA[0][2]];
}

function posunNa(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: malyPohyb() ? "auto" : "smooth", block: "start" });
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* nevadí */ } },
};

// Obecné výchozí: nejrozšířenější jednotarif D02d, bez marže dodavatele,
// bez panelů. Funguje hned pro každého a nic se nevyplňuje.
const DEFAULT_CFG = {
  distributor: "CEZ", rate: "D02d", margin: 0, marginPct: 0,
  systemFees: SYSTEM_FEES, kwp: 0, feedIn: 0.6, flatPrice: null,
  baseLoadPerHour: 0.3, ntHours: null,
  maxKw: null, // limit souběžného příkonu v kW, null = bez limitu
  dodavatel: "spot", // "spot" = bez přirážky, "vlastni" = zadaná ručně, jinak id z DODAVATELE
};

/** Přirážka dodavatele, která se opravdu použije ve výpočtu. */
function efektivniMarze(cfg) {
  if (cfg.dodavatel === "vlastni") return Number(cfg.margin) || 0;
  const d = DODAVATELE.find((x) => x.id === cfg.dodavatel);
  return d ? d.marze : 0;
}

function stahnoutSoubor(obsah, nazev, typ) {
  const blob = new Blob([obsah], { type: typ });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nazev;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stahnoutIcs(plan, dateIso) {
  const blob = new Blob([buildIcs(plan, dateIso)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `kdy-zapnout-${dateIso}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Hodiny, které se samy posouvají — kvůli odpočtu. */
function useNow(ms = 30000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}


// ═══════════════════════════════════════════════════════════════// ═══════════════════════════════════════════════════════════════
export default function App() {
  const [profil, setProfil] = useState(VYCHOZI_PROFIL);
  const [cfg, setCfg] = useState(DEFAULT_CFG);
  const [appliances, setAppliances] = useState(PROFILY[VYCHOZI_PROFIL].appliances);
  const [data, setData] = useState(null);
  const [mode, setMode] = useState("loading"); // loading | ok | error
  const [retry, setRetry] = useState(0);
  const [day, setDay] = useState("today");
  const [tab, setTab] = useState("spotrebice");
  const [editing, setEditing] = useState(null);
  const [showMethod, setShowMethod] = useState(false);
  const [motiv, setMotiv] = useState(() => store.get(KLIC_MOTIV)); // null = podle systému
  const [importOdkaz, setImportOdkaz] = useState(null);             // nastavení z odkazu, čeká na potvrzení
  const now = useNow(30000);
  const refreshKey = Math.floor(now.getTime() / 1800000) + ":" + isoDay(0);

  // uložené nastavení
  useEffect(() => {
    const raw = store.get(KLIC);
    if (raw) {
      try {
        const v = JSON.parse(raw);
        if (v.cfg) setCfg((c) => ({ ...c, ...v.cfg }));
        if (v.profil) setProfil(v.profil);
        if (v.appliances?.length) setAppliances(doplnSpotrebice(v.appliances));
      } catch { /* poškozené, jedeme na výchozím */ }
    }
  }, []);

  // Nastavení poslané odkazem z jiného zařízení: nic se nepřepíše bez potvrzení.
  // Hlídá se i změna adresy, kdyby někdo odkaz otevřel v už otevřené záložce.
  useEffect(() => {
    const prectiOdkaz = () => {
      const m = location.hash.match(/^#nastaveni=(.+)$/);
      if (!m) return;
      try { setImportOdkaz({ ok: dekodujNastaveni(m[1]) }); }
      catch (e) { setImportOdkaz({ chyba: e.message }); }
    };
    prectiOdkaz();
    window.addEventListener("hashchange", prectiOdkaz);
    return () => window.removeEventListener("hashchange", prectiOdkaz);
  }, []);
  const uloz = (p, c, a) => store.set(KLIC, JSON.stringify({ profil: p, cfg: c, appliances: a }));
  const zavriImport = () => {
    setImportOdkaz(null);
    history.replaceState(null, "", location.pathname + location.search);
  };
  const prijmiImport = () => {
    const { profil: p, cfg: c, appliances: a } = importOdkaz.ok;
    const nc = { ...DEFAULT_CFG, ...c };
    setProfil(p); setCfg(nc); setAppliances(a); uloz(p, nc, a);
    zaznam("nastaveni-prijato");
    zavriImport();
  };

  const prepniMotiv = () => {
    const tmavy = motiv ? motiv === "dark" : window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    const novy = tmavy ? "light" : "dark";
    setMotiv(novy); store.set(KLIC_MOTIV, novy); zaznam(`motiv-${novy}`);
  };

  // Nabídka "přidat na plochu" (Android a Chrome). iPhone ji neumí,
  // tam postup vysvětlují Časté otázky.
  const [instalace, setInstalace] = useState(null);
  useEffect(() => {
    const h = (e) => { e.preventDefault(); setInstalace(e); };
    window.addEventListener("beforeinstallprompt", h);
    return () => window.removeEventListener("beforeinstallprompt", h);
  }, []);
  const nainstaluj = async () => {
    if (!instalace) return;
    zaznam("instalace");
    instalace.prompt();
    try { await instalace.userChoice; } catch { /* nevadí */ }
    setInstalace(null);
  };

  // Měření návštěvnosti, jen když je v nastaveni.js vyplněný kód.
  useEffect(() => {
    if (!GOATCOUNTER_KOD || document.querySelector("script[data-goatcounter]")) return;
    const sc = document.createElement("script");
    sc.async = true;
    sc.src = "https://gc.zgo.at/count.js";
    sc.dataset.goatcounter = `https://${GOATCOUNTER_KOD}.goatcounter.com/count`;
    document.head.appendChild(sc);
  }, []);

  // Data se načtou samy a pak každých 30 minut. Při chybě za minutu znovu.
  useEffect(() => {
    let zruseno = false;
    (async () => {
      try {
        const r = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        if (zruseno) return;
        if (!j?.days || !Object.keys(j.days).length) throw new Error("prázdná data");
        setData(j);
        setMode("ok");
      } catch {
        if (zruseno) return;
        setMode((m) => (m === "ok" ? "ok" : "error"));
        setTimeout(() => !zruseno && setRetry((x) => x + 1), 60000);
      }
    })();
    return () => { zruseno = true; };
  }, [refreshKey, retry]);

  const dnesD = data?.days?.[isoDay(0)] ?? null;
  const zitraD = data?.days?.[isoDay(1)] ?? null;
  const historie = useMemo(() => data
    ? Object.entries(data.days).filter(([d]) => d < isoDay(0)).sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, ...v }))
    : [], [data]);

  const cfgEff = useMemo(() => ({ ...cfg, margin: efektivniMarze(cfg) }), [cfg]);
  const todayPrices = useMemo(() => dnesD ? toFinalPrices(dnesD.eur, { ...cfgEff, eurCzk: dnesD.eurCzk }) : null, [dnesD, cfgEff]);
  const tomorrowPrices = useMemo(() => zitraD ? toFinalPrices(zitraD.eur, { ...cfgEff, eurCzk: zitraD.eurCzk }) : null, [zitraD, cfgEff]);
  const isToday = day === "today" || !tomorrowPrices;
  const prices = isToday ? todayPrices : tomorrowPrices;
  const pvDne = (isToday ? dnesD : zitraD)?.pv ?? [];
  const pv = useMemo(() => pvDne.map((v) => Math.round((v ?? 0) * cfg.kwp * 100) / 100), [pvDne, cfg.kwp]);
  const baseLoad = useMemo(() => new Array(24).fill(cfg.baseLoadPerHour), [cfg.baseLoadPerHour]);
  const opt = useMemo(() => prices
    ? optimize({ prices, pv, baseLoad, feedIn: cfg.feedIn, appliances, maxKw: cfg.maxKw })
    : null, [prices, pv, baseLoad, cfg.feedIn, cfg.maxKw, appliances]);

  // úspory ze skutečné historie: pro zvolené nastavení i pro každou předvolbu
  const bt = useMemo(() => backtest(historie, cfgEff, appliances), [historie, cfgEff, appliances]);
  const btProfily = useMemo(() => Object.fromEntries(
    Object.entries(PROFILY).map(([k, p]) => [k, backtest(historie, cfgEff, p.appliances)])), [historie, cfgEff]);

  const active = opt ? opt.plan.filter((p) => !p.infeasible) : [];
  const shownDate = isToday ? isoDay(0) : isoDay(1);

  const update = (patch) => {
    const c = { ...cfg, ...patch }; setCfg(c); uloz(profil, c, appliances);
    if ("maxKw" in patch) zaznam("limit-prikonu");
  };
  const setApps = (a) => { setAppliances(a); setProfil("vlastni"); uloz("vlastni", cfg, a); };
  const vyberProfil = (k) => {
    const a = PROFILY[k].appliances;
    setProfil(k); setAppliances(a); uloz(k, cfg, a); zaznam(`domacnost-${k}`);
  };
  const toggle = (id) => setApps(appliances.map((a) => a.id === id ? { ...a, enabled: !a.enabled } : a));
  const patchApp = (id, p) => setApps(appliances.map((a) => a.id === id ? { ...a, ...p } : a));
  const addApp = (sablona = "vlastni") => {
    const novy = novySpotrebic(sablona, appliances);
    setApps([...appliances, novy]);
    setEditing(novy.id);
    zaznam(`pridan-${sablona}`);
  };
  const toggleConflict = (a, b) => { setApps(prepniKonflikt(appliances, a, b)); zaznam("zakaz-soubehu"); };
  const nastavDen = (d) => { setDay(d); if (d === "tomorrow") zaznam("zitra"); };

  const aktivni = useScrollspy(["dnes", "ceny", "uspory", "pripominky", "nastaveni"], Boolean(data));

  const obal = (obsah) => (
    <div className="app" data-theme={motiv ?? undefined}>
      <style>{CSS}</style>
      <TopBar mode={mode} data={data} dnes={dnesD} now={now} aktivni={aktivni} onMotiv={prepniMotiv} />
      {importOdkaz && <ImportBanner stav={importOdkaz} onPrijmi={prijmiImport} onZavri={zavriImport} />}
      {obsah}
      {data && <BottomNav aktivni={aktivni} />}
    </div>
  );

  // Dokud nejsou data, žádná čísla.
  if (!data) {
    return obal(
      <section className="sky sky-empty" style={skyStyle(now.getHours() + now.getMinutes() / 60)}>
        <div className="wrap skyIn">
          {mode === "error" ? (
            <h1 className="skyH"><span className="skyState">Ceny se teď nepodařilo načíst.</span>
              <span className="skyAct">Zkusím to znovu za minutu, stránku nemusíš obnovovat.</span></h1>
          ) : (
            <>
              <h1 className="skyH"><span className="skyState">Načítám ceny</span>
                <span className="skyAct">Ceny z OTE, kurz z ČNB a předpověď slunce.</span></h1>
              <div className="hzSkel" aria-hidden="true">{Array.from({ length: 24 }, (_, i) => <span key={i} style={{ "--i": i }} />)}</div>
            </>
          )}
        </div>
      </section>,
    );
  }

  return obal(
    <>
      {prices && opt ? (
        <SkyHero prices={prices} avg={opt.avg} plan={opt.plan} now={now} isToday={isToday}
          day={day} setDay={nastavDen} hasTomorrow={Boolean(tomorrowPrices)}
          character={dayCharacter(prices, bt.days)} bt={bt} profil={profil} minH={opt.minH}
          zitraOkno={tomorrowPrices ? cheapestWindow(tomorrowPrices, null, 0, 3) : null} />
      ) : (
        <section className="sky" id="dnes" style={skyStyle(now.getHours())}>
          <div className="wrap skyIn">
            <h1 className="skyH"><span className="skyState">Ceny na dnešek zatím nejsou.</span>
              <span className="skyAct">Automatický sběr je stáhne odpoledne, stránka se aktualizuje sama.</span></h1>
          </div>
        </section>
      )}

      <main className="wrap">
        {prices && opt && (
          <div className="today">
            <PlanList plan={opt.plan} now={now} isToday={isToday}
              okno={cheapestWindow(todayPrices, tomorrowPrices, now.getHours(), 3)}
              onIcs={() => { stahnoutIcs(opt.plan, shownDate); zaznam("kalendar-stazeni"); }}
              onInstall={instalace ? nainstaluj : null} />

            <section className="blok ceny" id="ceny" aria-labelledby="cenyH">
              <h2 className="secH" id="cenyH">{isToday ? "Ceny dnes po hodinách" : "Ceny zítra po hodinách"}</h2>
              <p className="lede">
                Nejlevněji {vHodin(opt.minH)}{"\u00A0"}{opt.minH}:00 za {fmt(prices[opt.minH].price)} Kč, nejdráž {vHodin(opt.maxH)}{"\u00A0"}{opt.maxH}:00
                za {fmt(prices[opt.maxH].price)} Kč. Ceny jsou za kWh včetně distribuce a DPH.
              </p>
              <HourMap prices={prices} plan={active} showNow={isToday} />
              <h3 className="subH">Kdy co poběží</h3>
              <Rozvrh prices={prices} plan={active} showNow={isToday} now={now} spicka={opt.spicka} limit={opt.limit} />
            </section>
          </div>
        )}

        <section className="sekce" id="uspory" aria-label="Úspory">
          <UsporyHero bt={bt} btProfily={btProfily} profil={profil} vyberProfil={vyberProfil}
            showMethod={showMethod} setShowMethod={setShowMethod} cfg={cfg} />
          <PremiumBlok id="historie">
            <Historie bt={bt} historie={historie} cfgEff={cfgEff}
              todayPrices={todayPrices} tomorrowPrices={tomorrowPrices} />
          </PremiumBlok>
        </section>

        <section className="sekce" id="pripominky" aria-label="Připomínky">
          <PremiumBlok id="odber">
            <KalendarOdber profil={profil} />
          </PremiumBlok>
          <Prenos profil={profil} cfg={cfg} appliances={appliances} />
        </section>

        <section className="sekce" id="nastaveni" aria-labelledby="nastH">
          <div className="custHead">
            <h2 className="secH" id="nastH">Přizpůsobit podle sebe</h2>
            <p>
              Nic vyplňovat nemusíš. Stránka počítá s obecným tarifem D02d, který má většina
              domácností, a se spotřebiči podle zvolené domácnosti. Pro přesnější čísla si tady
              nastav vlastní.
            </p>
          </div>
          <div className="panel">
            <nav className="tabs" role="tablist" aria-label="Nastavení">
              {[["spotrebice", "Spotřebiče"], ["cena", "Můj tarif"], ["premium", "Co všechno umí"]].map(([k, l]) => (
                <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "tab tabOn" : "tab"}
                  onClick={() => setTab(k)}>{l}</button>
              ))}
            </nav>
            <div className="tabBody" key={tab}>
              {tab === "spotrebice" && opt && (
                <Appliances appliances={appliances} plan={opt.plan} editing={editing}
                  setEditing={setEditing} toggle={toggle} patchApp={patchApp}
                  remove={(id) => setApps(odeberSpotrebic(appliances, id))} add={addApp}
                  toggleConflict={toggleConflict} cfg={cfg} update={update} />
              )}
              {tab === "cena" && prices && <PriceTab cfg={cfg} update={update} prices={prices} eurCzk={dnesD?.eurCzk} />}
              {tab === "premium" && <Premium bt={bt} />}
            </div>
          </div>
        </section>

        <Otazky />

        <footer className="foot">
          <p>
            Úspory jsou modelové, ne zaručené: počítají se ze skutečných cen, ale z typické
            spotřeby spotřebičů. Záleží na tvé skutečné spotřebě, sazbě a smlouvě s dodavatelem.
          </p>
          <p>
            Spotová cena je pro všechny dodavatele stejná, vzniká na denním trhu OTE. Dodavatelé
            se liší jen přirážkou, kterou si můžeš nastavit v Můj tarif.
          </p>
          <p>Zdroje: spotové ceny OTE (záložně ENTSO-E), kurz ČNB, předpověď slunce Open-Meteo, ceníky distribuce 2026.</p>
          {FORMULAR_URL && (
            <p><a className="footLink" href={FORMULAR_URL} target="_blank" rel="noopener">Napiš nám, co ti chybí nebo co nefunguje</a></p>
          )}
        </footer>
      </main>
    </>,
  );
}

const skyStyle = (h) => { const [a, b] = obloha(h); return { "--sky-a": a, "--sky-b": b }; };

/** Která sekce je právě na obrazovce, pro zvýraznění v navigaci. */
function useScrollspy(ids, pripraveno) {
  const [aktivni, setAktivni] = useState(ids[0]);
  useEffect(() => {
    if (!pripraveno || typeof IntersectionObserver === "undefined") return undefined;
    const viditelne = new Map();
    const io = new IntersectionObserver((zaznamy) => {
      for (const z of zaznamy) viditelne.set(z.target.id, z.isIntersecting);
      const prvni = ids.find((id) => viditelne.get(id));
      if (prvni) setAktivni(prvni);
    }, { rootMargin: "-40% 0px -55% 0px" });
    for (const id of ids) { const el = document.getElementById(id); if (el) io.observe(el); }
    return () => io.disconnect();
  }, [pripraveno]); // eslint-disable-line react-hooks/exhaustive-deps
  return aktivni;
}

// ═══ Vysvětlení omezení ════════════════════════════════════════
// Názvy spotřebičů si píše uživatel, takže je nejde skloňovat. Proto
// "kvůli spotřebiči Myčka": název zůstává v prvním pádě a věta sedí vždy.
const vycet = (j) => j.length <= 1 ? (j[0] ?? "") : `${j.slice(0, -1).join(", ")} a ${j[j.length - 1]}`;
const kvuliSpotrebici = (j) => `${j.length === 1 ? "spotřebiči" : "spotřebičům"} ${vycet(j)}`;

function popisPosunu(p) {
  const d = p.posunuto;
  const casti = [];
  if (d.soubeh.length) casti.push(kvuliSpotrebici(d.soubeh));
  if (d.limit) casti.push("limitu příkonu");
  const pripl = p.priplatek >= 0.5 ? `, o ${fmtCzk(p.priplatek)} dráž` : "";
  return `Posunuto kvůli ${vycet(casti)}${pripl}.`;
}

function popisNelze(p) {
  if (p.duvod === "okno") return "Časové okno je kratší než jeho cyklus.";
  if (p.duvod === "prikon") return `Potřebuje ${fmt(p.kw, 1)} kW a spolu se základní spotřebou domu se nevejde do limitu ${fmt(p.limit, 1)} kW. Zvyš limit, nebo prodluž cyklus, aby stačil menší příkon.`;
  const d = p.omezeni ?? { soubeh: [], limit: false };
  const casti = [];
  if (d.soubeh.length) casti.push(kvuliSpotrebici(d.soubeh));
  if (d.limit) casti.push("limitu příkonu");
  return casti.length
    ? `V povoleném čase se nevejde kvůli ${vycet(casti)}. Zkus mu rozšířit časové okno.`
    : "V povoleném čase se nevejde. Zkus mu rozšířit časové okno.";
}
// ═══ Horní lišta ═══════════════════════════════════════════════
const NAV = [
  ["dnes", "Dnes", "M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"],
  ["ceny", "Ceny", "M5 20V11M10 20V6M15 20v-9M20 20V8"],
  ["uspory", "Úspory", "M12 3v18M16.5 7.5c0-1.7-2-3-4.5-3s-4.5 1.3-4.5 3 2 2.6 4.5 3 4.5 1.4 4.5 3.2-2 3-4.5 3-4.5-1.3-4.5-3"],
  ["pripominky", "Připomínky", "M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2zM10 20a2 2 0 0 0 4 0"],
  ["nastaveni", "Nastavení", "M4 7h10M18 7h2M4 17h4M12 17h8M14 4v6M8 14v6"],
];
const Ikona = ({ d }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

function TopBar({ mode, data, dnes, now, aktivni, onMotiv }) {
  const zdroj = dnes?.src === "ENTSO-E" ? "ENTSO-E (záloha)" : "OTE";
  let stav;
  if (mode === "loading") stav = <span className="live liveLoad" title="Načítám ceny" aria-label="Načítám ceny"><i className="dot" />Načítám ceny</span>;
  else if (!data) stav = <span className="live liveDemo" title="Ceny nedostupné" aria-label="Ceny nedostupné"><i className="dot" />Ceny nedostupné</span>;
  else if (!dnes) stav = <span className="live liveDemo" title="Dnešní ceny zatím chybí" aria-label="Dnešní ceny zatím chybí"><i className="dot" />Dnešní ceny zatím chybí</span>;
  else if (!data.updatedAt) stav = <span className="live liveOn" title={`Ceny z ${zdroj}`} aria-label={`Ceny z ${zdroj}`}><i className="dot" />{zdroj}</span>;
  else {
    const t = new Date(data.updatedAt);
    const min = Math.round((now - t) / 60000);
    const kdy = min < 60 ? `před ${Math.max(1, min)} min` : min < 60 * 24
      ? `dnes ${vHodin(t.getHours())} ${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}`
      : `${t.getDate()}. ${t.getMonth() + 1}.`;
    // krátký text do lišty, celá věta v popisku pro najetí myší a čtečky
    stav = (
      <span className="live liveOn" title={`Ceny z ${zdroj}, staženo ${kdy}. Stahují se automaticky každý den.`}
        aria-label={`Ceny z ${zdroj}, staženo ${kdy}`}>
        <i className="dot" />{zdroj}, {kdy}
      </span>
    );
  }
  return (
    <header className="top">
      <div className="wrap topIn">
        <a className="brand" href="#dnes" onClick={(e) => { e.preventDefault(); posunNa("dnes"); }}>
          <Bolt /><span className="brandName">Kdy zapnout</span>
        </a>
        {ZKUSEBNI_VERZE && (
          <a className="beta" href={FORMULAR_URL || "#otazky"} target={FORMULAR_URL ? "_blank" : undefined}
            rel="noopener" title="Napiš nám, co ti chybí nebo co nefunguje">Zkušební verze</a>
        )}
        <nav className="topNav" aria-label="Části stránky">
          {NAV.map(([id, l]) => (
            <a key={id} href={`#${id}`} className={aktivni === id ? "tn tnOn" : "tn"}
              aria-current={aktivni === id ? "true" : undefined}
              onClick={(e) => { e.preventDefault(); posunNa(id); }}>{l}</a>
          ))}
        </nav>
        <div className="topEnd">
          {stav}
          <button className="motiv" onClick={onMotiv} aria-label="Přepnout světlý nebo tmavý vzhled" title="Světlý nebo tmavý vzhled">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}

// ═══ Spodní lišta na mobilu ════════════════════════════════════
function BottomNav({ aktivni }) {
  return (
    <nav className="botNav" aria-label="Části stránky">
      {NAV.map(([id, l, d]) => (
        <a key={id} href={`#${id}`} className={aktivni === id ? "bn bnOn" : "bn"}
          aria-current={aktivni === id ? "true" : undefined}
          onClick={(e) => { e.preventDefault(); posunNa(id); }}>
          <Ikona d={d} /><span>{l}</span>
        </a>
      ))}
    </nav>
  );
}

// ═══ Nastavení z odkazu ════════════════════════════════════════
function ImportBanner({ stav, onPrijmi, onZavri }) {
  return (
    <div className="importBar" role="dialog" aria-label="Nastavení z odkazu">
      <div className="wrap importIn">
        {stav.ok ? (
          <>
            <p>
              Odkaz obsahuje nastavení z jiného zařízení: {pocetSpotrebicu(stav.ok.appliances.length)},
              distributor {DISTRIBUTORS[stav.ok.cfg.distributor].name}, sazba {stav.ok.cfg.rate}.
              Načtením se přepíše nastavení v tomhle prohlížeči.
            </p>
            <div className="importBtns">
              <button className="btn btnSolid" onClick={onPrijmi}>Načíst nastavení</button>
              <button className="btn" onClick={onZavri}>Nechat současné</button>
            </div>
          </>
        ) : (
          <>
            <p>{stav.chyba} Nech si poslat nový odkaz.</p>
            <div className="importBtns"><button className="btn" onClick={onZavri}>Zavřít</button></div>
          </>
        )}
      </div>
    </div>
  );
}

// ═══ Obloha: co je teď a jak vypadá den ════════════════════════
const DNY_TYDNE = ["neděle", "pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota"];

function SkyHero({ prices, avg, plan, now, isToday, day, setDay, hasTomorrow, character, bt, profil, minH, zitraOkno }) {
  const [vybrana, setVybrana] = useState(null);
  useEffect(() => setVybrana(null), [isToday]);
  const nowH = now.getHours(), nowM = now.getMinutes();
  const cur = prices[nowH];
  const polozky = plan.filter((p) => !p.infeasible && p.hours?.length)
    .map((p) => ({ p, a: actionFor(p, nowH, nowM, isToday) }));
  const tedJe = polozky.filter((x) => x.a.kind === "now").map((x) => x.p.name);
  const dalsi = polozky.filter((x) => x.a.kind === "later").sort((x, y) => x.a.mins - y.a.mins)[0];

  let stav, akce;
  if (isToday) {
    stav = !cur ? "Dnes" : cur.price <= avg * 0.9 ? "Teď je levná hodina." : cur.price >= avg * 1.1 ? "Teď je drahá hodina." : "Teď je běžná cena.";
    if (!polozky.length) akce = "Zapni si dole aspoň jeden spotřebič.";
    else if (tedJe.length === 1) akce = `${tedJe[0]} má teď levné hodiny.`;
    else if (tedJe.length > 1 && tedJe.length <= 3) akce = `${vycet(tedJe)} mají teď levné hodiny.`;
    else if (tedJe.length > 3) akce = `${pocetSpotrebicu(tedJe.length)} má teď levné hodiny.`;
    else if (dalsi) akce = `Další na řadě: ${dalsi.p.name} ${vHodin(dalsi.a.at)}\u00A0${dalsi.a.at}:00.`;
    else if (zitraOkno) akce = `Dnes je hotovo. Zítra nejlevněji ${zitraOkno.start.h}:00–${(zitraOkno.end.h + 1) % 24 || 24}:00.`;
    else akce = "Na dnešek je všechno naplánované a hotové.";
  } else {
    const d = new Date(Date.now() + 864e5);
    stav = `Zítra, ${DNY_TYDNE[d.getDay()]} ${d.getDate()}. ${d.getMonth() + 1}.`;
    const ok = cheapestWindow(prices, null, 0, 3);
    akce = ok ? `Nejlevněji ${ok.start.h}:00–${(ok.end.h + 1) % 24 || 24}:00.` : `Nejlevněji ${vHodin(minH)}\u00A0${minH}:00.`;
  }

  const sky = isToday ? skyStyle(nowH + nowM / 60) : { "--sky-a": "#1F3B6E", "--sky-b": "#3A5E96" };
  const vyber = vybrana != null ? prices[vybrana] : null;
  const nazevDomacnosti = PROFILY[profil]?.nazev ?? "Tvoje domácnost";

  return (
    <section className="sky" id="dnes" style={sky} aria-labelledby="skyH">
      <div className="wrap skyIn">
        <div className="skyTop">
          <div className="dayToggle" role="tablist" aria-label="Den">
            <button role="tab" aria-selected={day === "today"} className={day === "today" ? "dt dtOn" : "dt"}
              onClick={() => setDay("today")}>Dnes</button>
            <button role="tab" aria-selected={day === "tomorrow"} disabled={!hasTomorrow}
              className={day === "tomorrow" && hasTomorrow ? "dt dtOn" : "dt"}
              onClick={() => setDay("tomorrow")}
              title={hasTomorrow ? "" : "Zítřejší ceny zveřejňuje OTE odpoledne, stránka je načte sama."}>Zítra</button>
          </div>
          {!hasTomorrow && day === "today" && <p className="skyHint">Zítřek bude k dispozici odpoledne.</p>}
        </div>

        <h1 className="skyH" id="skyH" key={`${isToday}`}>
          <span className="skyState">{stav}</span>
          <span className="skyAct">{akce}</span>
        </h1>

        {isToday && cur && (
          <p className="skySub">
            Právě teď {fmt(cur.price)} Kč za kWh, průměr dne {fmt(avg)} Kč.
          </p>
        )}

        {character.kind === "big" && (
          <p className="skyFlag">
            Výjimečně rozkolísaný den: rozdíl mezi nejlevnější a nejdražší hodinou je {fmt(character.today, 1)}×,
            obvykle bývá {fmt(character.median, 1)}×. Plán se dnes vyplatí dodržet víc než jindy.
          </p>
        )}
        {character.kind === "flat" && (
          <p className="skyFlag skyFlagFlat">
            Ceny jsou {isToday ? "dnes" : "zítra"} vyrovnané, rozdíl jen {fmt(character.today, 1)}×. Na přesunu spotřebičů tolik nezáleží.
          </p>
        )}

        <Horizon prices={prices} plan={plan} isToday={isToday} now={now} vybrana={vybrana} setVybrana={setVybrana} />

        <p className="skyPick" aria-live="polite">
          {vyber
            ? <>Od {vyber.hour}:00 do {vyber.hour + 1}:00 stojí kWh <strong>{fmt(vyber.price)} Kč</strong>{vyber.tariff === "NT" ? ", nízký tarif" : ""}.</>
            : "Klepni na sloupec a uvidíš cenu v dané hodině."}
        </p>

        {bt.dayCount >= 3 && (
          <button className="skyTeaser" onClick={() => { posunNa("uspory"); zaznam("uspory-z-oblohy"); }}>
            {nazevDomacnosti} tím ušetří asi <strong>{fmtCzk(bt.perMonth)} měsíčně</strong>. Jak se to počítá
          </button>
        )}
      </div>
    </section>
  );
}

// ═══ Panorama cen: 24 sloupců na obzoru ════════════════════════
function Horizon({ prices, plan, isToday, now, vybrana, setVybrana }) {
  const N = prices.length;
  const vals = prices.map((p) => p.price);
  const min = Math.min(...vals), max = Math.max(...vals);
  const naplanovano = new Set(plan.filter((p) => !p.infeasible).flatMap((p) => p.hours));
  const tedH = now.getHours() + now.getMinutes() / 60;
  const osa = [0, 6, 12, 18].filter((h) => h < N).concat([N]);
  return (
    <div className="hz">
      <div className="hzBars" role="group" aria-label="Ceny po hodinách, klepnutím zobrazíš cenu">
        {prices.map((p, h) => {
          const vyska = 10 + ((p.price - min) / (max - min || 1)) * 78; // nahoře místo pro slunce
          const minula = isToday && h < now.getHours();
          return (
            <button key={h} type="button"
              className={`hzBar t${tier(p.price, min, max)}${minula ? " past" : ""}${vybrana === h ? " sel" : ""}`}
              style={{ "--h": `${vyska}%`, "--i": h }}
              aria-pressed={vybrana === h}
              aria-label={`${h}:00 až ${h + 1}:00, ${fmt(p.price)} Kč za kWh${naplanovano.has(h) ? ", naplánovaný spotřebič" : ""}`}
              onClick={() => setVybrana(vybrana === h ? null : h)}>
              {naplanovano.has(h) && <i className="hzDot" />}
            </button>
          );
        })}
        {isToday && (
          <span className="hzSun" style={{ "--x": `${(tedH / N) * 100}%` }} aria-hidden="true">
            <i />
          </span>
        )}
      </div>
      <div className="hzAxis" aria-hidden="true">
        {osa.map((h) => (
          <span key={h} className={h === 0 ? "ax axFirst" : h === N ? "ax axLast" : "ax"} style={{ left: `${(h / N) * 100}%` }}>{h}</span>
        ))}
      </div>
    </div>
  );
}

// ═══ Plán jako jízdní řád ══════════════════════════════════════
function PlanList({ plan, now, isToday, okno, onIcs, onInstall }) {
  const nowH = now.getHours(), nowM = now.getMinutes();
  const polozky = plan.filter((p) => !p.infeasible && p.hours?.length)
    .map((p) => ({ p, a: actionFor(p, nowH, nowM, isToday) }))
    .sort((x, y) => {
      const rank = { now: 0, later: 1, tomorrow: 1, done: 2, none: 3 };
      return rank[x.a.kind] - rank[y.a.kind] || (x.p.hours[0] ?? 0) - (y.p.hours[0] ?? 0);
    });
  const nejdou = plan.filter((p) => p.infeasible);

  return (
    <section className="blok planBlok" id="plan" aria-labelledby="planH">
      <h2 className="secH" id="planH">{isToday ? "Plán na dnes" : "Plán na zítřek"}</h2>
      {isToday && okno && (
        <p className="winLine">
          Nejlevnější tři hodiny v příštích 24 hodinách: <span className="winVal">{oknoPopis(okno)}</span>,
          v průměru {fmt(okno.avg)} Kč.
        </p>
      )}

      {polozky.length === 0 ? (
        <p className="prazdno">Zapni si v nastavení aspoň jeden spotřebič a ukáže se tu, kdy ho pustit.</p>
      ) : (
        <ol className="rows">
          {polozky.map(({ p, a }) => (
            <li key={p.id} className={`row row-${a.kind}`}>
              <span className="rowTime">{hoursLabel(p.hours)}</span>
              <span className="rowMain">
                <span className="rowName">{p.name}</span>
                <span className="rowMeta">
                  {fmtCzk(p.cost)}{p.pvUsed > 0.05 && `, z toho ${fmt(p.pvUsed, 1)} kWh z panelů`}
                </span>
                {p.posunuto && <span className="rowNote">{popisPosunu(p)}</span>}
              </span>
              <span className="rowPill">
                {a.kind === "now" && <><i className="pulse" aria-hidden="true" />Teď, do {a.until}:00</>}
                {a.kind === "later" && odpocet(a.mins)}
                {a.kind === "tomorrow" && `Zítra ${vHodin(a.at)} ${a.at}:00`}
                {a.kind === "done" && "Proběhlo"}
              </span>
            </li>
          ))}
        </ol>
      )}

      {nejdou.length > 0 && (
        <div className="boardWarn" role="note">
          {nejdou.map((p) => <p key={p.id}><strong>{p.name}</strong> se nepodařilo naplánovat. {popisNelze(p)}</p>)}
        </div>
      )}

      {polozky.length > 0 && (
        <div className="planActions">
          <button className="btn btnSolid" onClick={onIcs}>Přidat do kalendáře</button>
          {onInstall && <button className="btn" onClick={onInstall}>Přidat na plochu telefonu</button>}
          {TELEGRAM_URL && <a className="btn" href={TELEGRAM_URL} target="_blank" rel="noopener"
            onClick={() => zaznam("telegram")}>Denní plán na Telegramu</a>}
        </div>
      )}
      {polozky.length > 0 && <p className="planNote">Kalendář ti pět minut předem připomene, co zapnout.</p>}

      {isToday && polozky.length > 0 && <Zpetna />}
    </section>
  );
}

// ═══ Pomohlo to? ═══════════════════════════════════════════════
function Zpetna() {
  const klic = `kdyzapnout:zpetna:${isoDay(0)}`;
  const [stav, setStav] = useState(() => store.get(klic));
  const odpovez = (v) => { store.set(klic, v); setStav(v); zaznam(`pomohlo-${v}`); };
  if (stav) {
    return (
      <p className="fb fbDone" role="status">
        Díky za odpověď.
        {stav === "ne" && FORMULAR_URL && <> <a href={FORMULAR_URL} target="_blank" rel="noopener">Napiš nám, co chybělo</a>.</>}
      </p>
    );
  }
  return (
    <div className="fb">
      <span>Pomohl ti dnešní plán?</span>
      <button className="fbBtn" onClick={() => odpovez("ano")}>Ano</button>
      <button className="fbBtn" onClick={() => odpovez("ne")}>Ne</button>
    </div>
  );
}

// ═══ Rozvrh spotřebičů ═════════════════════════════════════════
/**
 * Řádek za každý spotřebič na společné časové ose. Názvy mají vlastní
 * sloupec a osa vlastní řádek, takže se popisky nemůžou překrýt.
 */
function Rozvrh({ prices, plan, showNow = true, now, spicka, limit }) {
  const N = prices.length;
  const tedPct = ((now.getHours() + now.getMinutes() / 60) / N) * 100;
  const osa = Array.from({ length: Math.floor(N / 3) + 1 }, (_, i) => i * 3).filter((h) => h <= N);
  if (osa[osa.length - 1] !== N) osa.push(N);
  if (!plan.length) return <p className="prazdno">Žádný spotřebič zatím nemá naplánované hodiny.</p>;
  return (
    <div className="db">
      <div className="gantt" role="list" aria-label="Rozvrh spotřebičů">
        {plan.map((p) => (
          <div key={p.id} className="gRow" role="listitem">
            <span className="gName" title={p.name}>{p.name}</span>
            <div className="gTrack" style={{ gridTemplateColumns: `repeat(${N}, 1fr)` }}
              title={`${p.name}: ${hoursLabel(p.hours)}`}>
              {Array.from({ length: N }, (_, h) => {
                if (!p.hours.includes(h)) return <span key={h} className="gCell" />;
                // žlutě jen hodiny, kdy panely pokryjí aspoň polovinu spotřeby
                const zPanelu = (p.pvPoHodinach?.[h] ?? 0) >= (p.naHodinu ?? 1) * 0.5;
                return <span key={h} className={zPanelu ? "gCell on sun" : "gCell on"} />;
              })}
              {showNow && <i className="gNow" style={{ left: `${tedPct}%` }} aria-hidden="true" />}
            </div>
          </div>
        ))}
      </div>
      <div className="dbRow">
        <span className="dbG" />
        <div className="dbAxis" aria-hidden="true">
          {osa.map((h) => (
            <span key={h} className={h === 0 ? "ax axFirst" : h === N ? "ax axLast" : "ax"}
              style={{ left: `${(h / N) * 100}%` }}>{h}</span>
          ))}
        </div>
      </div>
      <div className="bandLegend">
        <span><i className="sw swSave" />ze sítě</span>
        {plan.some((p) => p.hours.some((h) => (p.pvPoHodinach?.[h] ?? 0) >= (p.naHodinu ?? 1) * 0.5)) &&
          <span><i className="sw swSun" />většinou z panelů</span>}
        {showNow && <span><i className="sw swNow" />teď</span>}
        {limit != null && <span>nejvyšší souběžný příkon {fmt(spicka, 1)} kW z limitu {fmt(limit, 1)} kW</span>}
      </div>
    </div>
  );
}

// ═══ Úspory ════════════════════════════════════════════════════
function UsporyHero({ bt, btProfily, profil, vyberProfil, showMethod, setShowMethod, cfg }) {
  const MIN = 3;
  const dostatek = bt.dayCount >= MIN;
  const mesicne = useTween(bt.perMonth);
  const rocne = useTween(bt.projectedYear);
  return (
    <div className="proof uspory">
      <h2 className="usporyHead">Kolik ušetříš, když budeš spotřebiče pouštět v levných hodinách</h2>

      <div className="profily" role="radiogroup" aria-label="Typ domácnosti">
        {Object.entries(PROFILY).map(([k, p]) => {
          const b = btProfily[k];
          return (
            <button key={k} role="radio" aria-checked={profil === k}
              className={profil === k ? "prof profOn" : "prof"} onClick={() => vyberProfil(k)}>
              <span className="profName">{p.nazev}</span>
              <span className="profSub">{p.popis}</span>
              {b.dayCount >= MIN && <span className="profVal">{fmtCzk(b.perMonth)} měsíčně</span>}
            </button>
          );
        })}
        {profil === "vlastni" && (
          <span className="prof profOn profCustom" role="radio" aria-checked="true">
            <span className="profName">Vlastní</span>
            <span className="profSub">upravené spotřebiče</span>
          </span>
        )}
      </div>

      {dostatek ? (
        <>
          <div className="proofGrid">
            <div className="proofMain">
              <p className="tagReal">skutečné ceny z OTE, {dni(bt.dayCount)}</p>
              <p className="bigMoney">{fmtCzk(mesicne)}<span className="bigUnit"> měsíčně</span></p>
              <p className="bigMoneyLbl">
                Tolik by tahle domácnost ušetřila proti tomu, kdyby spotřebiče pouštěla
                kdykoli během dne. Za rok zhruba {fmtCzk(rocne)}.
              </p>
            </div>
            <ProofBars days={bt.days} />
          </div>
          {(() => {
            const sr = srovnaniSFixem(bt, cfg.flatPrice);
            if (!sr) return null;
            return (
              <p className={sr.rozdil >= 0 ? "fixCmp" : "fixCmp fixHorsi"}>
                Proti tvému fixnímu tarifu {fmt(cfg.flatPrice)} Kč za kWh by spotřebiče v plánu
                na spotu stály <strong>o {fmtCzk(Math.abs(sr.rozdil))} měsíčně {sr.rozdil >= 0 ? "méně" : "víc"}</strong>
                {" "}({fmtCzk(sr.spotMesicne)} místo {fmtCzk(sr.fixMesicne)} za {fmt(sr.kwh, 0)} kWh).
                {" "}Zbytek spotřeby domu v tom není.
              </p>
            );
          })()}
          <p className="projection">
            Za {dni(bt.dayCount)} od {czDate(bt.from)} do {czDate(bt.to)}: {fmt(bt.totalAtAverage, 0)} Kč
            při spouštění kdykoli, {fmt(bt.totalOptimized, 0)} Kč podle plánu.
            {!bt.reliable && " Vzorek je zatím malý, číslo se ještě usadí."}
            {" "}
            <button className="linkBtn" aria-expanded={showMethod} onClick={() => setShowMethod(!showMethod)}>
              {showMethod ? "skrýt, jak se to počítá" : "jak se to počítá"}
            </button>
          </p>
          <div className={showMethod ? "rozbal otevreno" : "rozbal"}>
            <div className="method">
              <p>
                Pro každý uplynulý den vezmu skutečné ceny z OTE, přičtu distribuci podle
                tarifu {DISTRIBUTORS[cfg.distributor].rates[cfg.rate].label} a DPH, a spočítám dvě
                částky: kolik by spotřebiče stály v nejlevnějších hodinách a kolik za průměrnou
                cenu toho dne. Rozdíl sečtu a přepočítám na měsíc.
              </p>
              <p>
                Ceny jsou skutečné, chování je modelované. Spotřeba spotřebičů je typický odhad,
                ne údaj dodavatele. Skutečná úspora záleží na tom, jestli plán opravdu dodržíš,
                a na tvých spotřebičích.
              </p>
              <p>
                Jde o úsporu díky plánování. Kolik by ušetřil samotný přechod z fixního tarifu
                na spot, záleží na tvé smlouvě; srovnání si můžeš zapnout v Můj tarif.
              </p>
            </div>
          </div>
        </>
      ) : (
        <p className="usporyEmpty">
          Automatický sběr skutečných cen z OTE běží každý den
          {bt.dayCount > 0 ? `, zatím má ${dni(bt.dayCount)}` : ""}. Od tří dnů se tu ukáže,
          kolik by plán ušetřil. Vymyšlená čísla tu schválně nejsou.
        </p>
      )}
    </div>
  );
}

// ═══ Přenos nastavení do telefonu (místo registrace) ═══════════
function Prenos({ profil, cfg, appliances }) {
  const [otevreno, setOtevreno] = useState(false);
  const [svg, setSvg] = useState("");
  const [kopie, setKopie] = useState(false);
  const odkaz = useMemo(() => `${location.origin}${location.pathname}#nastaveni=${zakodujNastaveni({ profil, cfg, appliances })}`,
    [profil, cfg, appliances]);
  useEffect(() => {
    if (!otevreno) return;
    let zruseno = false;
    QRCode.toString(odkaz, { type: "svg", margin: 1, errorCorrectionLevel: "L", color: { dark: "#121A2E", light: "#FFFFFF" } })
      .then((s) => { if (!zruseno) setSvg(s); }).catch(() => { if (!zruseno) setSvg(""); });
    return () => { zruseno = true; };
  }, [otevreno, odkaz]);
  const kopiruj = async () => {
    zaznam("prenos-kopie");
    try { await navigator.clipboard.writeText(odkaz); setKopie(true); setTimeout(() => setKopie(false), 2000); }
    catch { window.prompt("Zkopíruj odkaz s nastavením:", odkaz); }
  };
  return (
    <div className="sec prenos">
      <h2 className="secHead">Stejné nastavení i v telefonu</h2>
      <p className="secSub">
        Účet ani registraci nepotřebuješ. Nastavení se pamatuje v prohlížeči, a když ho chceš
        mít i v jiném zařízení, načti si tenhle QR kód telefonem nebo si pošli odkaz.
      </p>
      <div className="kalBtns">
        <button className="btn btnSolid" aria-expanded={otevreno}
          onClick={() => { setOtevreno(!otevreno); if (!otevreno) zaznam("prenos-qr"); }}>
          {otevreno ? "Skrýt QR kód" : "Ukázat QR kód"}
        </button>
        <button className="btn" onClick={kopiruj}>{kopie ? "Odkaz zkopírován" : "Zkopírovat odkaz"}</button>
      </div>
      <div className={otevreno ? "rozbal otevreno" : "rozbal"}>
        <div className="qrBox">
          {svg ? <div className="qr" role="img" aria-label="QR kód s odkazem na nastavení" dangerouslySetInnerHTML={{ __html: svg }} />
            : <div className="qr qrLoad" aria-hidden="true" />}
          <p className="fieldNote">
            V odkazu je jen nastavení tarifu a spotřebičů, žádné osobní údaje. Na druhém
            zařízení se před načtením ještě zeptá.
          </p>
        </div>
      </div>
    </div>
  );
}

// ═══ Časté otázky ══════════════════════════════════════════════
function Otazka({ q, children }) {
  const [otevreno, setOtevreno] = useState(false);
  const id = useMemo(() => `qa-${Math.random().toString(36).slice(2, 8)}`, []);
  return (
    <div className={otevreno ? "qa qaOpen" : "qa"}>
      <h3 className="qaH">
        <button className="qaQ" aria-expanded={otevreno} aria-controls={id} onClick={() => setOtevreno(!otevreno)}>
          {q}<i className="qaIco" aria-hidden="true" />
        </button>
      </h3>
      <div className={otevreno ? "rozbal otevreno" : "rozbal"} id={id} role="region">
        <div className="qaA">{children}</div>
      </div>
    </div>
  );
}

function Otazky() {
  const Q = Otazka;
  return (
    <section className="sekce faq" id="otazky" aria-labelledby="faqH">
      <h2 className="secH" id="faqH">Časté otázky</h2>
      <Q q="Co je spotový tarif a komu se vyplatí?">
        <p>
          U spotového tarifu platíš za elektřinu cenu, která se mění každou hodinu podle
          denního trhu. V noci a přes poledne bývá levná, ráno a večer drahá. Vyplatí se hlavně
          tomu, kdo může velkou spotřebu přesouvat: bojler, nabíjení auta, tepelné čerpadlo.
          Kdo spotřebu přesouvat nemůže, nese riziko drahých hodin.
        </p>
      </Q>
      <Q q="Odkud jsou ceny a dají se jim věřit?">
        <p>
          Spotové ceny jsou z denního trhu OTE, kurz eura z ČNB a distribuce z ceníků
          distributorů pro rok 2026. K tomu se přičítají systémové poplatky a DPH. Spotová cena
          je u všech dodavatelů stejná; liší se jen jejich přirážka, kterou si nastavíš v Můj tarif.
        </p>
      </Q>
      <Q q="Proč se plán každý den mění?">
        <p>
          Protože se mění ceny. Ceny na zítřek zveřejňuje OTE kolem druhé odpoledne a stránka si
          je stáhne sama. Většinou bývá nejlevněji kolem poledne, ale některé dny jsou výrazně
          jiné, a na ty tě stránka upozorní.
        </p>
      </Q>
      <Q q="Je úspora zaručená?">
        <p>
          Není. Čísla počítají se skutečnými cenami, ale s typickou spotřebou spotřebičů a
          s tím, že plán dodržíš. Skutečná úspora záleží na tvých spotřebičích, tarifu a smlouvě.
        </p>
      </Q>
      <Q q="Musím se registrovat nebo něco nastavovat?">
        <p>
          Ne. Stránka počítá s nejrozšířenějším tarifem D02d a spotřebiči podle typu domácnosti,
          kterou vybereš. Pro přesnější čísla si nastav distributora, sazbu, dodavatele a své
          spotřebiče. Nastavení se pamatuje v prohlížeči a do telefonu si ho přeneseš QR kódem.
        </p>
      </Q>
      <Q q="Padají mi pojistky, když běží víc spotřebičů najednou. Co s tím?">
        <p>
          V nastavení spotřebičů zadej limit příkonu domu, nebo u konkrétních spotřebičů zakaž,
          aby běžely současně. Plán je pak rozloží tak, aby se nesešly, a napíše, kolik to stojí navíc.
        </p>
      </Q>
      <Q q="Jak dostanu připomínky do telefonu?">
        <p>
          Nejpohodlnější je kalendář k odběru: přidáš si ho jednou a plán se v něm každý den
          objeví sám. Na jeden den stačí tlačítko Přidat do kalendáře.
          {TELEGRAM_URL && <> Denní plán posíláme i do <a href={TELEGRAM_URL} target="_blank" rel="noopener">kanálu na Telegramu</a>.</>}
        </p>
        <p>
          Stránku si můžeš dát na plochu jako aplikaci. Na Androidu v Chromu přes nabídku
          Přidat na plochu, na iPhonu v Safari přes tlačítko Sdílet a Přidat na plochu.
        </p>
      </Q>
      <Q q="Co se děje s mými údaji?">
        <p>
          Nic se nikam neodesílá. Nastavení zůstává jen v tvém prohlížeči a nemáš tu žádný účet.
          {GOATCOUNTER_KOD && " Měříme jen anonymní návštěvnost a kliknutí, bez cookies a bez osobních údajů."}
        </p>
      </Q>
    </section>
  );
}

// ═══ Hodinová mapa: kdy je levno, na první pohled ══════════════
function HourMap({ prices, plan, showNow }) {
  const vals = prices.map((p) => p.price);
  const min = Math.min(...vals), max = Math.max(...vals);
  const nowH = new Date().getHours();
  const planned = new Set(plan.flatMap((p) => p.hours));
  return (
    <div className="hmWrap">
      <div className="hm" role="list" aria-label="Cena elektřiny po hodinách">
        {prices.map((p) => {
          const t = tier(p.price, min, max);
          const past = showNow && p.hour < nowH;
          const cls = ["hmC", `t${t}`, showNow && p.hour === nowH ? "hmNow" : "", past ? "hmPast" : ""].join(" ");
          return (
            <div key={p.hour} role="listitem" className={cls}
              title={`${p.hour}:00 až ${p.hour + 1}:00, ${fmt(p.price)} Kč za kWh${planned.has(p.hour) ? ", naplánováno" : ""}`}>
              <span className="hmH">{p.hour}</span>
              <span className="hmP">{fmt(p.price, 1)}</span>
              {planned.has(p.hour) && <span className="hmDot" aria-hidden="true" />}
            </div>
          );
        })}
      </div>
      <div className="hmScale">
        <span>nejlevnější</span>
        <span className="hmBar" aria-hidden="true" />
        <span>nejdražší</span>
        <span className="hmKey"><span className="hmDot hmDotStatic" /> naplánovaný spotřebič</span>
      </div>
    </div>
  );
}
// ═══ Denní sloupce úspor ═══════════════════════════════════════
function ProofBars({ days }) {
  if (!days.length) return null;
  const max = Math.max(...days.map((d) => d.savedVsAverage), 0.01);
  return (
    <div className="bars" role="img" aria-label="Denní úspory za sledované období">
      {days.map((d) => (
        <span key={d.date} className="barCol" title={`${d.date}: ${fmtCzk(d.savedVsAverage)}`}>
          <span className="bar" style={{ height: `${Math.max(2, (d.savedVsAverage / max) * 100)}%` }} />
        </span>
      ))}
    </div>
  );
}

// ═══ Limit příkonu domu ════════════════════════════════════════
const LIMITY = [
  { kw: null, text: "Bez limitu" },
  { kw: 3.5, text: "3,5 kW", popis: "jeden okruh 16 A" },
  { kw: 5.5, text: "5,5 kW", popis: "jistič 25 A na fázi" },
  { kw: 7.5, text: "7,5 kW" },
];

function LimitBox({ cfg, update }) {
  const vlastni = cfg.maxKw != null && !LIMITY.some((l) => l.kw === cfg.maxKw);
  return (
    <div className="limitBox">
      <p className="limitTitle">Kolik smí běžet najednou</p>
      <p className="fieldNote">
        Když ti při zapnutí víc spotřebičů najednou padají pojistky, nastav limit a plán
        spotřebiče rozloží tak, aby se nesešly. Počítá se i se základní spotřebou domu
        {` ${fmt(cfg.baseLoadPerHour, 1)} kW`}. Jeden okruh s jističem 16 A unese asi 3,5 kW.
      </p>
      <div className="chips" role="radiogroup" aria-label="Limit příkonu">
        {LIMITY.map((l) => (
          <button key={l.text} role="radio" aria-checked={cfg.maxKw === l.kw}
            className={cfg.maxKw === l.kw ? "chip chipOn" : "chip"} onClick={() => update({ maxKw: l.kw })}>
            {l.text}{l.popis && <span className="chipSub">{l.popis}</span>}
          </button>
        ))}
        <label className={vlastni ? "chip chipOn chipInput" : "chip chipInput"}>
          <span>Vlastní</span>
          <input type="number" min="0.5" step="0.1" inputMode="decimal" aria-label="Vlastní limit v kW"
            value={vlastni ? cfg.maxKw : ""} placeholder="kW"
            onChange={(e) => update({ maxKw: e.target.value === "" ? null : Math.max(0.5, +e.target.value) })} />
        </label>
      </div>
    </div>
  );
}

// ═══ Spotřebiče ════════════════════════════════════════════════
function Appliances({ appliances, plan, editing, setEditing, toggle, patchApp, remove, add, toggleConflict, cfg, update }) {
  const [sablona, setSablona] = useState("susicka");
  const jmeno = (id) => appliances.find((x) => x.id === id)?.name ?? id;
  return (
    <div>
      <LimitBox cfg={cfg} update={update} />

      <ul className="applList">
        {appliances.map((a) => {
          const p = plan.find((x) => x.id === a.id);
          const open = editing === a.id;
          const ostatni = appliances.filter((x) => x.id !== a.id);
          const zakazy = (a.conflicts ?? []).filter((c) => appliances.some((x) => x.id === c));
          return (
            <li key={a.id} className={a.enabled ? "appl" : "appl applOff"}>
              <div className="applRow">
                <button className="sw3" onClick={() => toggle(a.id)} aria-pressed={a.enabled}
                  aria-label={`${a.enabled ? "Vypnout" : "Zapnout"} ${a.name}`}>
                  <span className={a.enabled ? "knob knobOn" : "knob"} />
                </button>
                <div className="applInfo">
                  <p className="applName">{a.name}</p>
                  <p className="applMeta">
                    {fmt(a.kwh, 1)} kWh za {a.hours} h, příkon {fmt(Math.max(a.kw ?? 0, a.kwh / a.hours), 1)} kW
                    {a.contiguous ? ", nepřerušitelný cyklus" : ", lze rozdělit"}
                  </p>
                  {zakazy.length > 0 && (
                    <p className="applMeta">Nesmí běžet zároveň s: {vycet(zakazy.map(jmeno))}</p>
                  )}
                </div>
                <div className="applWhen">
                  {a.enabled && p && !p.infeasible && (
                    <>
                      <p className="whenTime">{hoursLabel(p.hours)}</p>
                      <p className="whenCost">{fmtCzk(p.cost)}</p>
                      {p.posunuto && <p className="whenNote">{popisPosunu(p)}</p>}
                    </>
                  )}
                  {p?.infeasible && <p className="whenBad">{popisNelze(p)}</p>}
                </div>
                <button className="linkBtn" onClick={() => setEditing(open ? null : a.id)}
                  aria-expanded={open}>
                  {open ? "hotovo" : "upravit"}
                </button>
              </div>

              {open && (
                <div className="edit">
                  <Field label="Název"><input value={a.name}
                    onChange={(e) => patchApp(a.id, { name: e.target.value })} /></Field>
                  <Field label="Spotřeba na cyklus v kWh"><input type="number" min="0.1" step="0.1"
                    value={a.kwh} onChange={(e) => patchApp(a.id, { kwh: Math.max(0.1, +e.target.value) })} /></Field>
                  <Field label="Délka cyklu v hodinách"><input type="number" min="1" max="24"
                    value={a.hours} onChange={(e) => patchApp(a.id, { hours: clamp(+e.target.value, 1, 24) })} /></Field>
                  <Field label="Příkon při běhu v kW, najdeš na štítku">
                    <input type="number" min="0.1" step="0.1"
                      value={a.kw ?? ""} onChange={(e) => patchApp(a.id, { kw: Math.max(0.1, +e.target.value || 0) })} />
                  </Field>
                  {(a.kw ?? 0) < a.kwh / a.hours - 1e-9 && (
                    <p className="fieldNote editNote warnNote">
                      Při příkonu {fmt(a.kw, 1)} kW nejde za {a.hours} h odebrat {fmt(a.kwh, 1)} kWh, na to je potřeba
                      aspoň {fmt(a.kwh / a.hours, 1)} kW. Počítám proto s {fmt(a.kwh / a.hours, 1)} kW. Když má
                      spotřebič opravdu menší příkon, prodluž délku cyklu na {Math.ceil(a.kwh / a.kw)} h.
                    </p>
                  )}
                  <Field label="Ne dřív než (hodina)"><input type="number" min="0" max="23"
                    value={a.earliest} onChange={(e) => patchApp(a.id, { earliest: clamp(+e.target.value, 0, 23) })} /></Field>
                  <Field label="Hotovo do (hodina)"><input type="number" min="1" max="24"
                    value={a.latest} onChange={(e) => patchApp(a.id, { latest: clamp(+e.target.value, 1, 24) })} /></Field>
                  <Field label="Přednost při plánování, 1 je nejvyšší"><input type="number" min="1" max="99"
                    value={a.priority} onChange={(e) => patchApp(a.id, { priority: clamp(+e.target.value, 1, 99) })} /></Field>
                  <label className="check">
                    <input type="checkbox" checked={a.contiguous}
                      onChange={(e) => patchApp(a.id, { contiguous: e.target.checked })} />
                    Cyklus nejde přerušit, třeba pračka nebo myčka
                  </label>

                  {ostatni.length > 0 && (
                    <fieldset className="conf">
                      <legend>Nesmí běžet zároveň s</legend>
                      <p className="fieldNote">
                        Třeba myčka a sušička na jednom okruhu. Plán je pak nikdy nepustí ve stejnou hodinu.
                      </p>
                      <div className="confList">
                        {ostatni.map((o) => (
                          <label key={o.id} className="check">
                            <input type="checkbox"
                              checked={(a.conflicts ?? []).includes(o.id) || (o.conflicts ?? []).includes(a.id)}
                              onChange={() => toggleConflict(a.id, o.id)} />
                            {o.name}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  )}

                  <p className="fieldNote editNote">
                    Kdo má vyšší přednost, dostane nejlevnější hodiny a přebytek z panelů jako první.
                  </p>
                  <button className="btn btnDanger" onClick={() => { setEditing(null); remove(a.id); }}>
                    Odebrat spotřebič
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="addRow">
        <label className="addLbl" htmlFor="sablona">Přidat spotřebič</label>
        <select id="sablona" value={sablona} onChange={(e) => setSablona(e.target.value)}>
          {Object.entries(SABLONY).map(([k, v]) => <option key={k} value={k}>{v.name}</option>)}
        </select>
        <button className="btn btnSolid" onClick={() => add(sablona)}>Přidat</button>
      </div>
    </div>
  );
}

// ═══ Složení ceny ══════════════════════════════════════════════
function PriceTab({ cfg, update, prices, eurCzk }) {
  const now = prices[new Date().getHours()] ?? prices[0];
  const pct = (v) => Math.round((v / now.price) * 100);
  return (
    <div className="two">
      <div>
        <h3>Tvoje odběrné místo</h3>
        <Field label="Distributor">
          <select value={cfg.distributor} onChange={(e) => update({ distributor: e.target.value })}>
            {Object.entries(DISTRIBUTORS).map(([k, v]) => <option key={k} value={k}>{v.name}</option>)}
          </select>
        </Field>
        <Field label="Distribuční sazba">
          <select value={cfg.rate} onChange={(e) => update({ rate: e.target.value })}>
            {Object.entries(DISTRIBUTORS[cfg.distributor].rates).map(([k, v]) =>
              <option key={k} value={k}>{v.label}</option>)}
          </select>
        </Field>
        <Field label="Dodavatel a jeho přirážka ke spotu">
          <select value={cfg.dodavatel ?? "spot"} onChange={(e) => update({ dodavatel: e.target.value })}>
            <option value="spot">Čistý spot, bez přirážky</option>
            {DODAVATELE.map((d) => (
              <option key={d.id} value={d.id}>{d.nazev}, {fmt(d.marze)} Kč za kWh</option>
            ))}
            <option value="vlastni">Zadám přirážku sám</option>
          </select>
        </Field>
        {cfg.dodavatel === "vlastni" && (
          <Field label="Přirážka dodavatele v Kč za kWh bez DPH, najdeš ji ve smlouvě">
            <input type="number" step="0.01" min="0" value={cfg.margin}
              onChange={(e) => update({ margin: Math.max(0, +e.target.value) })} />
          </Field>
        )}
        {DODAVATELE.length === 0 && (
          <p className="fieldNote">
            Spotová cena je u všech dodavatelů stejná, liší se jen přirážka. Když ji znáš
            ze smlouvy, vyber Zadám přirážku sám.
          </p>
        )}
        {eurCzk && <p className="fieldNote">Kurz eura dnes {fmt(eurCzk, 3)} Kč podle ČNB, bere se automaticky.</p>}
        <Field label="Systémové poplatky v Kč za kWh"><input type="number" step="0.01" value={cfg.systemFees}
          onChange={(e) => update({ systemFees: +e.target.value })} /></Field>
        <Field label="Tvůj současný fixní tarif v Kč za kWh, nepovinné">
          <input type="number" step="0.01" min="0" placeholder="z vyúčtování, když chceš srovnání"
            value={cfg.flatPrice ?? ""}
            onChange={(e) => update({ flatPrice: e.target.value === "" ? null : +e.target.value })} />
        </Field>
        <p className="fieldNote">
          Najdeš ho na vyúčtování jako cenu za kWh včetně distribuce a DPH. Nahoře u úspor
          se pak ukáže, jestli by ti spot vyšel levněji.
        </p>
      </div>

      <div>
        <h3>Panely a spotřeba</h3>
        <Field label="Výkon fotovoltaiky v kWp, nula když nemáš"><input type="number" min="0" step="0.5"
          value={cfg.kwp} onChange={(e) => update({ kwp: Math.max(0, +e.target.value) })} /></Field>
        <Field label="Výkupní cena přebytku"><input type="number" step="0.05" value={cfg.feedIn}
          onChange={(e) => update({ feedIn: +e.target.value })} /></Field>
        <Field label="Základní spotřeba domu v kWh za hodinu"><input type="number" step="0.05"
          value={cfg.baseLoadPerHour}
          onChange={(e) => update({ baseLoadPerHour: Math.max(0, +e.target.value) })} /></Field>

        <NtEditor cfg={cfg} update={update} />

        <div className="split">
          <p className="splitTitle">Cena v {now.hour}:00 je {fmt(now.price)} Kč za kWh</p>
          <Seg label="Silová elektřina" v={now.parts.energy} pct={pct(now.parts.energy)} cls="segA" />
          <Seg label="Distribuce" v={now.parts.distribution} pct={pct(now.parts.distribution)} cls="segB" />
          <Seg label="Systémové poplatky" v={now.parts.system} pct={pct(now.parts.system)} cls="segC" />
          <p className="splitNote">
            Spot je jen část účtu. Distribuce z něj dělá {pct(now.parts.distribution)} procent,
            a proto nestačí koukat jen na burzovní cenu.
          </p>
          <p className="splitNote">
            K tomu platíš měsíčně {fmt(OTE_MONTHLY)} Kč za činnost operátora trhu a platbu
            za jistič. Ty se do plánu nezapočítávají, protože je zaplatíš stejně,
            ať spotřebiče pustíš kdykoli.
          </p>
        </div>
      </div>
    </div>
  );
}

// ═══ Časy nízkého tarifu ═══════════════════════════════════════
function NtEditor({ cfg, update }) {
  const rate = DISTRIBUTORS[cfg.distributor].rates[cfg.rate];
  if (rate.nt == null) {
    return (
      <div className="ntBox">
        <p className="ntTitle">Nízký tarif</p>
        <p className="ntNote">Sazba {rate.label} je jednotarifní, cena distribuce je celý den stejná.</p>
      </div>
    );
  }

  const vychozi = DEFAULT_NT_HOURS[rate.ntCount] ?? [];
  const vlastni = cfg.ntHours != null;
  const hodiny = cfg.ntHours ?? vychozi;

  const prepni = (h) => {
    const set = new Set(hodiny);
    set.has(h) ? set.delete(h) : set.add(h);
    update({ ntHours: [...set].sort((a, b) => a - b) });
  };

  return (
    <div className="ntBox">
      <p className="ntTitle">Kdy ti platí nízký tarif</p>
      <p className="ntNote">
        Časy určuje povelový kód HDO tvého odběrného místa a distributor je během roku mění.
        Nedají se uhodnout, takže je zadej podle svého rozpisu nebo elektroměru.
        Sazba {cfg.rate} má {rate.ntCount} hodin denně, máš vybráno {hodiny.length}.
      </p>
      <div className="ntGrid">
        {Array.from({ length: 24 }, (_, h) => (
          <button key={h} type="button" onClick={() => prepni(h)}
            className={hodiny.includes(h) ? "ntH ntHOn" : "ntH"}
            aria-pressed={hodiny.includes(h)}
            aria-label={`${h}:00 ${hodiny.includes(h) ? "nízký" : "vysoký"} tarif`}>
            {h}
          </button>
        ))}
      </div>
      <p className="ntFoot">
        {vlastni
          ? <>Používají se tvoje časy. <button className="linkBtn" onClick={() => update({ ntHours: null })}>Vrátit orientační</button></>
          : "Zatím jsou nastavené orientační časy, ne tvoje skutečné."}
      </p>
    </div>
  );
}

// ═══ Premium: obal kolem placených funkcí ══════════════════════
/**
 * V režimu "zdarma" ukáže funkci s označením, že je teď zdarma.
 * V režimu "placene" místo ní ukáže zámek s odkazem na platbu.
 */
function PremiumBlok({ id, children }) {
  const f = FUNKCE.find((x) => x.id === id);
  if (jePremium()) {
    return (
      <div className="premWrap">
        {jeZdarmaRezim() && <span className="premTag">Premium, teď zdarma</span>}
        {children}
      </div>
    );
  }
  return (
    <section className="sec lock">
      <span className="premTag">Premium</span>
      <h2 className="secHead">{f?.nazev}</h2>
      <p className="secSub">{f?.popis}</p>
      {PLATBA_URL
        ? <a className="btn btnSolid" href={PLATBA_URL} target="_blank" rel="noopener">Odemknout za {PREMIUM_CENA} Kč měsíčně</a>
        : <p className="secSub">Předplatné se připravuje.</p>}
    </section>
  );
}

// ═══ Kalendář k odběru (premium) ═══════════════════════════════
function KalendarOdber({ profil }) {
  const [vyber, setVyber] = useState(PROFILY[profil] ? profil : VYCHOZI_PROFIL);
  const [kopie, setKopie] = useState(false);
  useEffect(() => { if (PROFILY[profil]) setVyber(profil); }, [profil]);

  const url = new URL(`data/kalendar/${vyber}.ics`, window.location.href).href;
  const webcal = url.replace(/^https?:/, "webcal:");
  const google = `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`;
  const kopiruj = async () => {
    zaznam("odber-kopie");
    try { await navigator.clipboard.writeText(url); setKopie(true); setTimeout(() => setKopie(false), 2000); }
    catch { window.prompt("Zkopíruj adresu kalendáře:", url); }
  };

  return (
    <section className="sec">
      <h2 className="secHead">Připomínky samy v telefonu</h2>
      <p className="secSub">
        Přidej si kalendář jednou a každý den se v něm sám objeví plán, kdy co zapnout,
        s připomínkou pět minut předem. Když bude den výjimečně rozkolísaný, přijde i celodenní
        upozornění. Stránku už pak otevírat nemusíš.
      </p>

      <div className="kalProf" role="radiogroup" aria-label="Kalendář pro domácnost">
        {Object.entries(PROFILY).map(([k, p]) => (
          <button key={k} role="radio" aria-checked={vyber === k}
            className={vyber === k ? "kp kpOn" : "kp"} onClick={() => setVyber(k)}>{p.nazev}</button>
        ))}
      </div>

      <div className="kalBtns">
        <a className="btn btnSolid" href={google} target="_blank" rel="noopener" onClick={() => zaznam("odber-google")}>Přidat do Google kalendáře</a>
        <a className="btn" href={webcal} onClick={() => zaznam("odber-apple")}>Přidat na iPhone nebo Mac</a>
        <button className="btn" onClick={kopiruj}>{kopie ? "Zkopírováno" : "Zkopírovat adresu"}</button>
      </div>

      <p className="fieldNote">
        Kalendář počítá s obecným tarifem D02d a spotřebiči zvolené domácnosti, ne s tvým
        vlastním nastavením na této stránce. Google si odebírané kalendáře obnovuje sám,
        obvykle jednou za několik hodin, takže zítřejší plán se objeví během odpoledne nebo večera.
      </p>
    </section>
  );
}

// ═══ Historie a export (premium) ═══════════════════════════════
function Historie({ bt, historie, cfgEff, todayPrices, tomorrowPrices }) {
  const cenyDnu = useMemo(() => Object.fromEntries(historie.map((d) => {
    const p = toFinalPrices(d.eur, { ...cfgEff, eurCzk: d.eurCzk });
    return [d.date, p.reduce((a, x) => a + x.price, 0) / p.length];
  })), [historie, cfgEff]);
  const mesice = useMemo(() => mesicniPrehled(bt.days, cenyDnu), [bt.days, cenyDnu]);
  const nazevMesice = (m) => new Intl.DateTimeFormat("cs-CZ", { month: "long", year: "numeric" })
    .format(new Date(`${m}-15T12:00:00`));

  const exportHodin = () => {
    zaznam("export-hodin");
    const dny = [{ date: isoDay(0), prices: todayPrices }];
    if (tomorrowPrices) dny.push({ date: isoDay(1), prices: tomorrowPrices });
    stahnoutSoubor(csvHodiny(dny.filter((d) => d.prices)), `ceny-${isoDay(0)}.csv`, "text/csv;charset=utf-8");
  };
  const exportDnu = () => zaznam("export-dnu") || stahnoutSoubor(csvDny(bt.days), `uspory-${isoDay(0)}.csv`, "text/csv;charset=utf-8");

  if (bt.dayCount < 3) {
    return (
      <section className="sec">
        <h2 className="secHead">Historie a měsíční přehled</h2>
        <p className="secSub">Objeví se, až budou nasbírané aspoň tři dny skutečných cen.</p>
      </section>
    );
  }

  const body = bt.days.map((d) => cenyDnu[d.date]).filter(Number.isFinite);
  const min = Math.min(...body), max = Math.max(...body);
  const W = 600, H = 90;
  const x = (i) => (i / Math.max(1, body.length - 1)) * W;
  const y = (v) => H - 8 - ((v - min) / Math.max(0.01, max - min)) * (H - 16);
  const cesta = body.map((v, i) => `${i ? "L" : "M"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");

  return (
    <section className="sec">
      <h2 className="secHead">Historie a měsíční přehled</h2>
      <p className="secSub">
        Průměrná cena za kWh po jednotlivých dnech. Od {czDate(bt.from)} do {czDate(bt.to)} vyšel
        nejlevnější den na {fmt(min)} Kč a nejdražší na {fmt(max)} Kč.
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="spark" role="img" aria-label="Vývoj průměrné ceny po dnech">
        <path d={cesta} fill="none" stroke="var(--save)" strokeWidth="2.2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>

      <div className="tblWrap">
        <table className="tbl">
          <thead><tr><th>Měsíc</th><th className="colDni">Dní</th><th>Ušetřeno</th><th>Cena za kWh</th></tr></thead>
          <tbody>
            {mesice.map((m) => (
              <tr key={m.mesic}>
                <td>{nazevMesice(m.mesic)}</td>
                <td className="colDni">{m.dnu}</td>
                <td className="num">{fmtCzk(m.usetreno)}</td>
                <td className="num">{fmt(m.prumerCen)} Kč</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="kalBtns">
        <button className="btn" onClick={exportHodin}>Stáhnout ceny po hodinách</button>
        <button className="btn" onClick={exportDnu}>Stáhnout denní přehled úspor</button>
      </div>
      <p className="fieldNote">Tabulka se otevře v Excelu nebo Google Tabulkách, oddělovač je středník.</p>
    </section>
  );
}

// ═══ Co všechno umí ════════════════════════════════════════════
function Premium({ bt }) {
  const zdarma = FUNKCE.filter((f) => !f.premium);
  const prem = FUNKCE.filter((f) => f.premium);
  return (
    <div>
      <h3>Co všechno stránka umí</h3>
      <div className="plans">
        <div className="plan">
          <p className="planName">Zdarma</p>
          <ul>{zdarma.map((f) => <li key={f.id}><strong>{f.nazev}.</strong> {f.popis}.</li>)}</ul>
        </div>
        <div className="plan planOn">
          <p className="planName">
            Premium {jeZdarmaRezim() ? "— teď zdarma pro všechny" : `za ${PREMIUM_CENA} Kč měsíčně`}
          </p>
          <ul>{prem.map((f) => <li key={f.id}><strong>{f.nazev}.</strong> {f.popis}.</li>)}</ul>
          {!jeZdarmaRezim() && PLATBA_URL && (
            <a className="btn btnSolid" href={PLATBA_URL} target="_blank" rel="noopener">Odemknout premium</a>
          )}
        </div>
      </div>
      <div className="honest">
        <p className="honestTitle">Co stránka zatím neumí</p>
        <p>
          Sama spotřebiče nezapne. K tomu by byly potřeba chytré zásuvky a napojení na ně,
          což je v plánu. Do té doby slouží připomínky v kalendáři.
        </p>
        {bt.dayCount >= 3 && (
          <p>
            Podle skutečných cen za {dni(bt.dayCount)} ušetří plánování tvé domácnosti zhruba
            <strong> {fmtCzk(bt.perMonth)} měsíčně</strong>. Tu úsporu dostaneš zdarma, když plán
            dodržíš; premium ti jen ušetří starost.
          </p>
        )}
      </div>
    </div>
  );
}
// ═══ Drobné ════════════════════════════════════════════════════
const Field = ({ label, children }) => (
  <label className="field"><span>{label}</span>{children}</label>
);

const Seg = ({ label, v, pct, cls }) => (
  <div className="seg">
    <span className="segLbl">{label}</span>
    <span className="segTrack"><span className={`segFill ${cls}`} style={{ width: `${pct}%` }} /></span>
    <span className="segVal">{fmt(v)}</span>
  </div>
);

const Bolt = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" fill="var(--sun)" />
  </svg>
);

const fmt = (n, d = 2) =>
  new Intl.NumberFormat("cs-CZ", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
const fmtCzk = (n) =>
  new Intl.NumberFormat("cs-CZ", { style: "currency", currency: "CZK",
    maximumFractionDigits: Math.abs(n) >= 100 ? 0 : 2 }).format(n);
const clamp = (n, a, b) => Math.min(b, Math.max(a, Number.isFinite(n) ? n : a));
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=Manrope:wght@400;500;600;700&display=swap');

/* ── barvy: světlý a tmavý vzhled ─────────────────────────── */
.app{
  --page:#F2F5F9; --panel:#FFFFFF; --panel2:#F3F6FA; --ink:#141B2B; --dim:#56627A; --line:#DDE4ED;
  --save:#0E7C5A; --saveSoft:#E3F4EC; --peak:#C4531C; --sun:#F0B429;
  --warnBg:#FBEDE4; --warnInk:#7A3412; --barBg:#E9EEF4;
  --t0:#0E7C5A; --t0i:#fff; --t1:#C3E8D6; --t1i:#0B4A37; --t2:#EAEFF5; --t2i:#141B2B; --t3:#F6D8C5; --t3i:#6E2C0C; --t4:#C4531C; --t4i:#fff;
  --display:'Bricolage Grotesque',system-ui,sans-serif; --body:'Manrope',system-ui,sans-serif;
  color-scheme:light;
}
.app[data-theme="dark"]{
  --page:#0B111E; --panel:#131B2C; --panel2:#1A2438; --ink:#E8EDF6; --dim:#9DA9BF; --line:#24304A;
  --save:#34C38F; --saveSoft:rgba(52,195,143,.14); --peak:#F08A5D;
  --warnBg:rgba(240,138,93,.12); --warnInk:#F6C4A8; --barBg:#1E2940;
  --t0:#1F9E70; --t0i:#fff; --t1:rgba(52,195,143,.24); --t1i:#B6F0D8; --t2:#1C2740; --t2i:#E8EDF6; --t3:rgba(240,138,93,.24); --t3i:#FAD0BA; --t4:#D9663A; --t4i:#fff;
  color-scheme:dark;
}
@media (prefers-color-scheme:dark){
  .app:not([data-theme="light"]){
    --page:#0B111E; --panel:#131B2C; --panel2:#1A2438; --ink:#E8EDF6; --dim:#9DA9BF; --line:#24304A;
    --save:#34C38F; --saveSoft:rgba(52,195,143,.14); --peak:#F08A5D;
    --warnBg:rgba(240,138,93,.12); --warnInk:#F6C4A8; --barBg:#1E2940;
    --t0:#1F9E70; --t0i:#fff; --t1:rgba(52,195,143,.24); --t1i:#B6F0D8; --t2:#1C2740; --t2i:#E8EDF6; --t3:rgba(240,138,93,.24); --t3i:#FAD0BA; --t4:#D9663A; --t4i:#fff;
    color-scheme:dark;
  }
  :root:has(.app:not([data-theme="light"])),:root:has(.app:not([data-theme="light"])) body{background:#0B111E}
}
:root:has(.app[data-theme="dark"]),:root:has(.app[data-theme="dark"]) body{background:#0B111E}
:root:has(.app[data-theme="light"]),:root:has(.app[data-theme="light"]) body{background:#F2F5F9}

*{box-sizing:border-box}
body{margin:0;background:#F2F5F9}
.app{background:var(--page);color:var(--ink);font-family:var(--body);font-size:15.5px;line-height:1.55;min-height:100vh;
  -webkit-font-smoothing:antialiased;padding-bottom:40px}
h1,h2,h3{font-family:var(--display);font-weight:700;letter-spacing:-0.02em;margin:0;line-height:1.2}
p{margin:0}
button{font-family:var(--body);font-size:inherit;color:inherit}
a{color:inherit}
:focus-visible{outline:2px solid var(--save);outline-offset:2px;border-radius:6px}
.wrap{max-width:1120px;margin:0 auto;padding:0 clamp(16px,4vw,32px)}
.secH,.secHead{font-size:clamp(22px,2.6vw,28px)}
.subH{font-size:17px;margin-top:28px}
.lede,.secSub{color:var(--dim);margin-top:8px;max-width:64ch}
.prazdno{color:var(--dim);margin-top:14px}

/* ── tlačítka a pole ──────────────────────────────────────── */
.btn{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:10px 18px;font-size:14.5px;font-weight:600;
  cursor:pointer;border:1px solid var(--line);background:var(--panel);color:var(--ink);text-decoration:none;
  transition:background .15s,transform .1s,border-color .15s}
.btn:hover{background:var(--panel2)}
.btn:active{transform:scale(.97)}
.btnSolid{background:var(--ink);color:var(--page);border-color:var(--ink)}
.btnSolid:hover{background:var(--ink);opacity:.9}
.btnDanger{border-color:var(--peak);color:var(--peak);background:transparent;justify-self:start}
.linkBtn{background:none;border:none;color:var(--save);font-size:14px;font-weight:600;cursor:pointer;
  text-decoration:underline;text-underline-offset:3px;padding:4px}
.field{display:block;margin-bottom:14px}
.field>span{display:block;font-size:13px;color:var(--dim);margin-bottom:6px}
input,select{width:100%;font-family:var(--body);font-size:15px;padding:11px 13px;border:1px solid var(--line);
  border-radius:12px;background:var(--panel);color:var(--ink);transition:border-color .15s}
input[type=checkbox]{width:18px;height:18px;accent-color:var(--save)}
input:focus,select:focus{border-color:var(--save);outline:none}
.fieldNote{font-size:13px;color:var(--dim);line-height:1.55;margin:4px 0 12px;max-width:62ch}
.check{display:flex;align-items:center;gap:10px;font-size:14px;cursor:pointer}

/* ── horní lišta ──────────────────────────────────────────── */
.top{position:sticky;top:0;z-index:40;background:color-mix(in srgb,var(--page) 86%,transparent);
  backdrop-filter:saturate(1.4) blur(14px);-webkit-backdrop-filter:saturate(1.4) blur(14px);border-bottom:1px solid var(--line)}
.topIn{display:flex;align-items:center;gap:12px;min-height:58px}
.brand{display:flex;align-items:center;gap:8px;text-decoration:none;color:var(--ink);flex-shrink:0}
.brandName{font-family:var(--display);font-weight:700;font-size:19px;letter-spacing:-0.02em}
.beta{font-size:12px;font-weight:600;color:#7A4E00;background:#FDF0CF;border:1px solid #F1D794;border-radius:999px;
  padding:3px 9px;text-decoration:none;white-space:nowrap}
.topNav{display:flex;gap:2px;margin-left:12px}
.tn{padding:7px 12px;border-radius:999px;font-size:14.5px;font-weight:600;color:var(--dim);text-decoration:none;transition:background .15s,color .15s}
.tn:hover{color:var(--ink);background:var(--panel2)}
.tnOn{color:var(--ink);background:var(--panel2)}
.topEnd{margin-left:auto;display:flex;align-items:center;gap:8px;min-width:0}
.live{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;padding:6px 12px 6px 10px;
  border-radius:999px;border:1px solid var(--line);background:var(--panel);white-space:nowrap;min-width:0;overflow:hidden;text-overflow:ellipsis}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex-shrink:0}
.liveOn{color:var(--save)} .liveOn .dot{background:var(--save);animation:puls 2.4s infinite}
.liveDemo{color:#8A5A0B} .liveDemo .dot{background:var(--sun)}
.liveLoad{color:var(--dim)} .liveLoad .dot{background:var(--line)}
.motiv{width:38px;height:38px;border-radius:50%;border:1px solid var(--line);background:var(--panel);
  display:grid;place-items:center;cursor:pointer;flex-shrink:0}
@keyframes puls{0%{box-shadow:0 0 0 0 rgba(14,124,90,.45)}70%{box-shadow:0 0 0 7px rgba(14,124,90,0)}100%{box-shadow:0 0 0 0 rgba(14,124,90,0)}}

/* ── obloha ───────────────────────────────────────────────── */
.sky{background:linear-gradient(180deg,var(--sky-a),var(--sky-b));color:#fff;border-radius:0 0 34px 34px;
  padding:26px 0 46px;scroll-margin-top:58px}
.sky-empty{padding-bottom:40px}
.skyTop{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.dayToggle{display:inline-flex;background:rgba(255,255,255,.14);border-radius:999px;padding:3px}
.dt{border:none;background:transparent;padding:7px 18px;border-radius:999px;font-size:14px;font-weight:700;
  color:rgba(255,255,255,.82);cursor:pointer;transition:background .2s,color .2s}
.dt:disabled{opacity:.5;cursor:not-allowed}
.dtOn{background:#fff;color:#141B2B}
.skyHint{font-size:13px;color:rgba(255,255,255,.75)}
.skyH{display:grid;gap:6px;margin-top:20px;animation:zjev .55s cubic-bezier(.2,.8,.2,1) both}
.skyState{font-family:var(--body);font-size:clamp(17px,2.1vw,20px);font-weight:600;color:rgba(255,255,255,.86);letter-spacing:0}
.skyAct{font-size:clamp(30px,5.2vw,52px);line-height:1.16;letter-spacing:-0.03em;max-width:20ch}
.skySub{margin-top:12px;color:rgba(255,255,255,.84);font-size:15px}
.skyFlag{margin-top:16px;background:rgba(110,231,183,.16);border:1px solid rgba(110,231,183,.38);border-radius:14px;
  padding:11px 15px;font-size:14px;max-width:64ch}
.skyFlagFlat{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.2)}
@keyframes zjev{from{opacity:0;transform:translateY(8px)}}

.hz{margin-top:30px}
.hzBars{position:relative;display:flex;gap:3px;height:clamp(130px,20vw,190px);padding-top:20px}
.hzBar{flex:1;min-width:0;position:relative;background:transparent;border:0;padding:0;cursor:pointer;border-radius:6px}
.hzBar::before{content:"";position:absolute;left:0;right:0;bottom:0;height:var(--h);border-radius:5px 5px 2px 2px;
  background:var(--c,rgba(255,255,255,.5));transform-origin:bottom;
  transition:height .55s cubic-bezier(.2,.8,.2,1),background-color .3s,opacity .3s;
  animation:rust .8s cubic-bezier(.2,.8,.2,1) both;animation-delay:calc(var(--i) * 28ms)}
@keyframes rust{from{transform:scaleY(0)}}
.hzBar.t0{--c:#6EE7B7} .hzBar.t1{--c:#B9F0D6} .hzBar.t2{--c:rgba(255,255,255,.5)} .hzBar.t3{--c:#FDBE9A} .hzBar.t4{--c:#FF8F5E}
.hzBar.past::before{opacity:.35}
.hzBar:hover::before{filter:brightness(1.12)}
.hzBar.sel::after{content:"";position:absolute;left:0;right:0;bottom:-6px;height:3px;background:#fff;border-radius:2px}
.hzBar:focus-visible{outline:2px solid #fff;outline-offset:2px}
.hzDot{position:absolute;left:50%;bottom:calc(var(--h) + 5px);width:6px;height:6px;margin-left:-3px;border-radius:50%;background:#fff;
  animation:zjev .4s both;animation-delay:calc(var(--i) * 28ms + .5s)}
.hzSun{position:absolute;top:0;bottom:0;left:clamp(8px,var(--x),calc(100% - 8px));width:0;pointer-events:none;
  animation:slunce 1.2s cubic-bezier(.2,.8,.2,1) both .3s}
.hzSun::before{content:"";position:absolute;top:14px;bottom:0;left:-1px;width:2px;background:linear-gradient(#F0B429,rgba(240,180,41,.1))}
.hzSun i{position:absolute;top:0;left:-8px;width:16px;height:16px;border-radius:50%;background:#F0B429;
  box-shadow:0 0 0 5px rgba(240,180,41,.25),0 0 22px rgba(240,180,41,.65)}
@keyframes slunce{from{left:8px;opacity:0}}
.hzAxis{position:relative;height:20px;margin-top:10px}
.hzSkel{display:flex;gap:3px;height:150px;align-items:flex-end;margin-top:30px}
.hzSkel span{flex:1;height:40%;border-radius:5px;background:rgba(255,255,255,.14);animation:skel 1.4s ease-in-out infinite;
  animation-delay:calc(var(--i) * 40ms)}
@keyframes skel{50%{opacity:.4}}
.skyPick{margin-top:10px;min-height:1.6em;font-size:14px;color:rgba(255,255,255,.8)}
.skyPick strong{color:#fff}
.skyTeaser{margin-top:18px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.24);color:#fff;
  border-radius:999px;padding:10px 18px;text-align:left;font-size:14.5px;cursor:pointer;transition:background .15s;line-height:1.45}
.skyTeaser:hover{background:rgba(255,255,255,.2)}
.skyTeaser strong{color:#B9F0D6}
.ax{position:absolute;top:0;transform:translateX(-50%);font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums;line-height:1.2}
.sky .ax{color:rgba(255,255,255,.7)}
.axFirst{transform:none} .axLast{transform:translateX(-100%)}

/* ── dnešek: plán a ceny na jednom listu ──────────────────── */
.today{position:relative;margin-top:-22px;background:var(--panel);border:1px solid var(--line);border-radius:28px;
  display:grid;grid-template-columns:minmax(0,1fr);box-shadow:0 18px 40px -28px rgba(18,26,46,.35)}
.blok{padding:clamp(20px,3vw,30px);min-width:0;scroll-margin-top:72px}
.blok+.blok{border-top:1px solid var(--line)}
@media (min-width:1000px){
  .today{grid-template-columns:minmax(0,5fr) minmax(0,7fr)}
  .blok+.blok{border-top:none;border-left:1px solid var(--line)}
}
.winLine{color:var(--dim);font-size:14px;margin-top:8px}
.winVal{color:var(--ink);font-weight:700}
.rows{list-style:none;margin:16px 0 0;padding:0;border-top:1px solid var(--line)}
.planBlok{container-type:inline-size}
.row{display:grid;grid-template-columns:minmax(6.2rem,9.5rem) minmax(0,1fr) auto;gap:4px 14px;align-items:center;
  padding:14px 8px;border-bottom:1px solid var(--line);border-radius:12px;transition:background .3s}
.rowTime{font-family:var(--display);font-weight:700;font-size:17px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;line-height:1.3}
.rowMain{display:grid;gap:2px;min-width:0}
.rowName{font-weight:700;overflow-wrap:anywhere}
.rowMeta{color:var(--dim);font-size:13px}
.rowNote{color:#8A5A0B;font-size:12.5px;line-height:1.45}
.app[data-theme="dark"] .rowNote{color:#F1C77A}
.rowPill{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:700;padding:5px 11px;border-radius:999px;
  background:var(--panel2);color:var(--dim);white-space:nowrap;justify-self:end}
.row-now{background:linear-gradient(90deg,var(--saveSoft),transparent 75%)}
.row-now .rowPill{background:var(--save);color:#fff}
.row-later .rowPill{background:var(--saveSoft);color:var(--save)}
.row-done{opacity:.55}
.pulse{width:7px;height:7px;border-radius:50%;background:#fff;animation:pulsB 1.8s infinite}
@keyframes pulsB{0%{box-shadow:0 0 0 0 rgba(255,255,255,.7)}70%{box-shadow:0 0 0 6px rgba(255,255,255,0)}100%{box-shadow:0 0 0 0 rgba(255,255,255,0)}}
@container (max-width:520px){
  .row{grid-template-columns:minmax(0,1fr) auto}
  .rowTime{grid-column:1/-1}
}
.boardWarn{margin-top:14px;background:var(--warnBg);color:var(--warnInk);border-radius:14px;padding:11px 15px;
  font-size:14px;line-height:1.5;display:grid;gap:4px}
.planActions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
.planNote{font-size:13px;color:var(--dim);margin-top:10px}
.fb{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:18px;padding-top:16px;border-top:1px dashed var(--line);font-size:14px}
.fb span{margin-right:4px;font-weight:600}
.fbBtn{border:1px solid var(--line);background:var(--panel);border-radius:999px;padding:6px 16px;font-weight:600;cursor:pointer;transition:background .15s}
.fbBtn:hover{background:var(--saveSoft);border-color:var(--save)}
.fbDone{color:var(--dim);animation:zjev .35s both}
.fbDone a{color:var(--save)}

/* ── ceny po hodinách ─────────────────────────────────────── */
.hmWrap{margin-top:18px}
.hm{display:grid;grid-template-columns:repeat(12,1fr);gap:4px}
.hmC{position:relative;border-radius:10px;padding:7px 2px 8px;text-align:center;display:flex;flex-direction:column;gap:1px}
.hmH{font-size:11px;opacity:.75}
.hmP{font-family:var(--display);font-weight:700;font-size:15px;letter-spacing:-0.01em}
.hmC.t0{background:var(--t0);color:var(--t0i)} .hmC.t1{background:var(--t1);color:var(--t1i)} .hmC.t2{background:var(--t2);color:var(--t2i)}
.hmC.t3{background:var(--t3);color:var(--t3i)} .hmC.t4{background:var(--t4);color:var(--t4i)}
.hmNow{outline:2.5px solid var(--sun);outline-offset:2px}
.hmPast{opacity:.4}
.hmDot{position:absolute;top:5px;right:5px;width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.85}
.hmDotStatic{position:static;display:inline-block;background:var(--ink);margin-right:5px;vertical-align:1px}
.hmScale{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px;font-size:12.5px;color:var(--dim)}
.hmBar{width:110px;height:8px;border-radius:999px;background:linear-gradient(90deg,var(--t0),var(--t1),var(--t2),var(--t3),var(--t4))}
.hmKey{margin-left:auto}

/* ── rozvrh spotřebičů ────────────────────────────────────── */
.db{margin-top:12px;--gw:clamp(6.5rem,26%,10rem)}
.dbRow{display:grid;grid-template-columns:var(--gw) minmax(0,1fr);column-gap:12px}
.dbAxis{position:relative;height:20px;margin-top:6px}
.gantt{display:grid;gap:8px}
.gRow{display:grid;grid-template-columns:var(--gw) minmax(0,1fr);column-gap:12px;align-items:center}
.gName{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.gTrack{position:relative;display:grid;gap:2px}
.gCell{height:13px;border-radius:3px;background:var(--barBg)}
.gCell.on{background:var(--save)}
.gCell.sun{background:var(--sun)}
.gNow{position:absolute;top:-4px;bottom:-4px;width:2px;margin-left:-1px;background:var(--sun);border-radius:1px}
.bandLegend{display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;color:var(--dim);margin-top:12px}
.sw{width:11px;height:11px;border-radius:3px;display:inline-block;margin-right:6px;vertical-align:-1px}
.swSave{background:var(--save)} .swSun{background:var(--sun)} .swNow{background:var(--sun);width:3px;border-radius:1px}
@media (max-width:560px){
  .dbRow,.gRow{grid-template-columns:minmax(0,1fr)}
  .dbG{display:none}
  .gRow{row-gap:4px}
  .hm{grid-template-columns:repeat(6,1fr)}
  .hmKey{margin-left:0}
}

/* ── sekce ────────────────────────────────────────────────── */
.sekce{margin-top:64px;scroll-margin-top:72px}
.sec{margin-top:40px}
.premWrap{margin-top:40px}
.premTag{display:inline-block;font-size:12px;font-weight:700;color:#7A4E00;background:#FDF0CF;border:1px solid #F1D794;
  padding:3px 10px;border-radius:999px;margin-bottom:10px}
.premWrap>.sec{margin-top:0}
.lock{border:1px dashed var(--line);border-radius:20px;padding:22px}

/* úspory: noční panel, jediné tmavé místo pod oblohou */
.proof.uspory{background:linear-gradient(160deg,#121A2E,#1B2647);color:#E8EDF6;border-radius:28px;padding:clamp(22px,3.4vw,36px);
  border:1px solid rgba(255,255,255,.06)}
.usporyHead{color:#fff;font-size:clamp(24px,3.2vw,34px);line-height:1.2;letter-spacing:-0.025em;max-width:24ch}
.profily{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px;margin-top:22px}
.prof{text-align:left;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);color:#E8EDF6;border-radius:16px;
  padding:13px 15px;cursor:pointer;display:flex;flex-direction:column;gap:3px;transition:background .2s,border-color .2s,transform .1s}
.prof:hover{background:rgba(255,255,255,.1)}
.prof:active{transform:scale(.98)}
.profOn{background:#fff;color:#141B2B;border-color:#fff}
.profName{font-weight:700;font-size:15px}
.profSub{font-size:12.5px;opacity:.72}
.profVal{font-size:13.5px;font-weight:700;margin-top:4px;color:#6EE7B7}
.profOn .profVal{color:#0E7C5A}
.profCustom{cursor:default}
.proofGrid{display:grid;grid-template-columns:minmax(220px,auto) 1fr;gap:clamp(20px,4vw,44px);align-items:end;margin-top:26px}
.tagReal{font-size:12px;padding:4px 10px;border-radius:999px;display:inline-block;margin-bottom:10px;
  background:rgba(110,231,183,.16);color:#6EE7B7}
.bigMoney{font-family:var(--display);font-size:clamp(40px,6.2vw,64px);font-weight:700;letter-spacing:-0.035em;line-height:1.15;
  color:#6EE7B7;font-variant-numeric:tabular-nums}
.bigUnit{font-size:.4em;font-weight:600;letter-spacing:0;margin-left:4px;color:#B9F0D6}
.bigMoneyLbl{color:#A8B4CA;font-size:14px;margin-top:10px;max-width:34ch}
.bars{display:flex;align-items:flex-end;gap:3px;height:110px}
.barCol{flex:1;height:100%;display:flex;align-items:flex-end}
.bar{width:100%;background:linear-gradient(#6EE7B7,#2F9E75);border-radius:3px 3px 0 0;display:block;transition:height .5s cubic-bezier(.2,.8,.2,1)}
.fixCmp{margin-top:18px;background:rgba(110,231,183,.12);border:1px solid rgba(110,231,183,.3);color:#D9F5E8;border-radius:14px;
  padding:12px 15px;font-size:14px;max-width:68ch}
.fixCmp strong{color:#fff}
.fixHorsi{background:rgba(240,180,41,.12);border-color:rgba(240,180,41,.35);color:#FBEBC3}
.projection{margin-top:20px;padding-top:16px;border-top:1px solid rgba(255,255,255,.13);color:#B9C4D8;font-size:14px;max-width:72ch}
.proof .linkBtn{color:#9FE3C6}
.method{background:rgba(255,255,255,.07);border-radius:14px;padding:16px 18px;margin-top:12px;display:grid;gap:9px;
  font-size:14px;color:#C6D0E2;max-width:70ch}
.usporyEmpty{color:#B9C4D8;margin-top:18px;max-width:62ch}
@media (max-width:680px){.proofGrid{grid-template-columns:1fr;align-items:start}.bars{height:80px}}

/* plynulé rozbalení (metodika, QR kód, otázky) */
.rozbal{display:grid;grid-template-rows:0fr;transition:grid-template-rows .35s cubic-bezier(.2,.8,.2,1)}
.rozbal>*{overflow:hidden;min-height:0;visibility:hidden;transition:visibility 0s .35s}
.rozbal.otevreno{grid-template-rows:1fr}
.rozbal.otevreno>*{visibility:visible;transition-delay:0s}

/* historie */
.spark{width:100%;height:90px;margin-top:14px;display:block}
.tblWrap{overflow-x:auto;margin-top:14px}
.tbl{width:100%;border-collapse:collapse;font-size:14.5px}
.tbl th{text-align:left;font-weight:600;color:var(--dim);font-size:13px;padding:8px 10px;border-bottom:1px solid var(--line)}
.tbl td{padding:11px 10px;border-bottom:1px solid var(--line)}
.tbl .num{font-variant-numeric:tabular-nums;text-align:right}
.tbl th:nth-child(n+3){text-align:right}
@media (max-width:420px){.colDni{display:none}.tbl th,.tbl td{padding:8px 6px}.tbl{font-size:13px}}

/* připomínky */
.kalProf{display:flex;flex-wrap:wrap;gap:6px;margin-top:16px}
.kp{border:1px solid var(--line);background:var(--panel);border-radius:999px;padding:7px 14px;font-size:14px;cursor:pointer;transition:background .15s}
.kpOn{background:var(--ink);color:var(--page);border-color:var(--ink)}
.kalBtns{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}
.sec .fieldNote{margin-top:14px}
.qrBox{display:flex;flex-wrap:wrap;gap:18px;align-items:center;padding-top:16px}
.qr{width:190px;height:190px;background:#fff;border-radius:16px;padding:10px;border:1px solid var(--line);flex-shrink:0}
.qr svg{width:100%;height:100%;display:block}
.qrLoad{animation:skel 1.4s infinite}
.qrBox .fieldNote{flex:1;min-width:200px;margin:0}

/* nastavení */
.custHead p{color:var(--dim);margin-top:8px;max-width:68ch}
.panel{margin-top:18px;background:var(--panel);border:1px solid var(--line);border-radius:24px;overflow:hidden}
.tabs{display:flex;gap:4px;padding:8px 8px 0;border-bottom:1px solid var(--line);overflow-x:auto}
.tab{position:relative;background:transparent;border:none;padding:12px 16px 14px;font-size:15px;font-weight:600;color:var(--dim);cursor:pointer;white-space:nowrap}
.tab::after{content:"";position:absolute;left:14px;right:14px;bottom:-1px;height:3px;border-radius:3px 3px 0 0;background:var(--save);
  transform:scaleX(0);transition:transform .25s cubic-bezier(.2,.8,.2,1)}
.tabOn{color:var(--ink)}
.tabOn::after{transform:scaleX(1)}
.tabBody{padding:clamp(18px,3vw,28px);animation:zjev .3s both}
h3{font-size:18px;margin-bottom:14px}
.limitBox{border:1px solid var(--line);border-radius:18px;padding:16px 18px;margin-bottom:16px;background:var(--panel2)}
.limitTitle{font-weight:700;font-size:15.5px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
.chip{border:1px solid var(--line);background:var(--panel);border-radius:12px;padding:8px 13px;font-size:14px;cursor:pointer;color:var(--ink);
  display:inline-flex;flex-direction:column;align-items:flex-start;gap:1px;line-height:1.25;transition:border-color .15s,background .15s}
.chipOn{border-color:var(--save);background:var(--saveSoft);color:var(--save);font-weight:700}
.chipSub{font-size:12px;color:var(--dim);font-weight:400}
.chipInput{flex-direction:row;align-items:center;gap:8px;cursor:default}
.chipInput input{width:84px;padding:6px 9px}
.applList{list-style:none;padding:0;margin:0 0 18px;display:grid;gap:10px}
.appl{border:1px solid var(--line);border-radius:18px;padding:14px 16px;transition:opacity .2s}
.applOff{opacity:.55}
.applRow{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.sw3{width:46px;height:28px;border-radius:999px;border:none;background:var(--line);cursor:pointer;padding:3px;flex-shrink:0;transition:background .2s}
.knob{width:22px;height:22px;border-radius:50%;background:#fff;display:block;transition:transform .2s cubic-bezier(.2,.8,.2,1);box-shadow:0 1px 2px rgba(0,0,0,.25)}
.knobOn{transform:translateX(18px)}
.sw3:has(.knobOn){background:var(--save)}
.applInfo{flex:1;min-width:150px}
.applName{font-weight:700;font-size:15.5px;overflow-wrap:anywhere}
.applMeta{color:var(--dim);font-size:13px;margin-top:3px;overflow-wrap:anywhere}
.applWhen{text-align:right;min-width:120px}
.whenTime{font-weight:700;font-size:15px}
.whenCost{color:var(--dim);font-size:13px;margin-top:2px}
.whenNote{color:#8A5A0B;font-size:12.5px;margin-top:3px;line-height:1.4;overflow-wrap:anywhere}
.whenBad{color:var(--peak);font-size:13px;overflow-wrap:anywhere}
.edit{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-top:16px;padding-top:16px;
  border-top:1px solid var(--line);animation:zjev .3s both}
.edit .check{grid-column:1/-1}
.conf{grid-column:1/-1;border:1px solid var(--line);border-radius:14px;padding:10px 14px 12px;margin:0;min-width:0}
.conf legend{font-size:13.5px;font-weight:700;padding:0 6px}
.confList{display:flex;flex-wrap:wrap;gap:8px 18px}
.confList .check{grid-column:auto}
.editNote{grid-column:1/-1;margin:0}
.warnNote{color:var(--warnInk);background:var(--warnBg);border-radius:10px;padding:8px 12px}
.addRow{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.addRow select{width:auto;min-width:0;flex:0 1 230px}
.addLbl{font-size:14.5px;font-weight:700}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:clamp(20px,4vw,40px)}
.split{margin-top:22px;padding-top:18px;border-top:1px solid var(--line)}
.splitTitle{font-weight:700;font-size:15px;margin-bottom:13px}
.seg{display:grid;grid-template-columns:1fr 110px 56px;align-items:center;gap:10px;margin-top:9px;font-size:13.5px}
.segLbl{color:var(--dim)}
.segTrack{height:9px;background:var(--panel2);border-radius:999px;display:block;overflow:hidden}
.segFill{height:9px;display:block;border-radius:999px;transition:width .4s}
.segA{background:var(--ink)} .segB{background:var(--peak)} .segC{background:#95A3B8}
.segVal{text-align:right;font-weight:700}
.splitNote{color:var(--dim);font-size:13px;margin-top:14px;max-width:46ch}
.ntBox{margin-top:22px;padding-top:18px;border-top:1px solid var(--line)}
.ntTitle{font-weight:700;font-size:15px;margin-bottom:6px}
.ntNote{color:var(--dim);font-size:13px;max-width:52ch;margin-bottom:12px}
.ntGrid{display:grid;grid-template-columns:repeat(12,1fr);gap:4px;max-width:440px}
.ntH{aspect-ratio:1;border:1px solid var(--line);background:var(--panel);border-radius:8px;font-size:11.5px;color:var(--dim);cursor:pointer;padding:0;transition:background .12s}
.ntHOn{background:var(--save);border-color:var(--save);color:#fff;font-weight:700}
.ntFoot{font-size:12.5px;color:var(--dim);margin-top:10px}
.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px}
.plan{border:1px solid var(--line);border-radius:18px;padding:18px}
.planOn{border-color:var(--save);background:var(--saveSoft)}
.planName{font-family:var(--display);font-weight:700;font-size:17px;margin-bottom:12px}
.plan ul{margin:0 0 16px;padding-left:18px;display:grid;gap:7px;font-size:14px;color:var(--dim)}
.honest{margin-top:20px;background:var(--panel2);border-radius:16px;padding:18px;display:grid;gap:10px;font-size:14px;color:var(--dim);max-width:70ch}
.honestTitle{font-weight:700;color:var(--ink);font-size:15px}
.honest strong{color:var(--ink)}
.planNote2{font-size:13px;color:var(--save);margin-top:10px}

/* otázky */
.faq .qa{border-top:1px solid var(--line)}
.faq .qa:last-of-type{border-bottom:1px solid var(--line)}
.faq .secH{margin-bottom:14px}
.qaH{font-family:var(--body);letter-spacing:0;margin:0;font-size:inherit}
.qaQ{width:100%;display:flex;justify-content:space-between;align-items:center;gap:16px;background:none;border:none;
  padding:17px 2px;font-size:16px;font-weight:700;text-align:left;cursor:pointer;line-height:1.4}
.qaIco{position:relative;width:14px;height:14px;flex-shrink:0}
.qaIco::before,.qaIco::after{content:"";position:absolute;left:0;right:0;top:6px;height:2px;border-radius:2px;background:var(--dim);
  transition:transform .3s cubic-bezier(.2,.8,.2,1)}
.qaIco::after{transform:rotate(90deg)}
.qaOpen .qaIco::after{transform:rotate(0)}
.qaA{color:var(--dim);font-size:15px;max-width:70ch;display:grid;gap:8px;padding-bottom:18px}
.qaA a{color:var(--save)}

/* nastavení z odkazu */
.importBar{background:var(--saveSoft);border-bottom:1px solid var(--line)}
.importIn{display:flex;flex-wrap:wrap;align-items:center;gap:12px 18px;padding-top:14px;padding-bottom:14px;font-size:14.5px}
.importIn p{flex:1;min-width:240px}
.importBtns{display:flex;gap:8px;flex-wrap:wrap}

.foot{margin-top:56px;padding-top:22px;border-top:1px solid var(--line);color:var(--dim);font-size:13px;display:grid;gap:8px;max-width:72ch}
.footLink{color:var(--save);font-weight:700}

/* spodní lišta na mobilu */
.botNav{display:none}
@media (max-width:899px){
  .topNav{display:none}
  .app{padding-bottom:calc(84px + env(safe-area-inset-bottom))}
  .botNav{display:grid;grid-template-columns:repeat(5,1fr);position:fixed;left:0;right:0;bottom:0;z-index:45;
    background:color-mix(in srgb,var(--panel) 90%,transparent);backdrop-filter:saturate(1.4) blur(14px);-webkit-backdrop-filter:saturate(1.4) blur(14px);
    border-top:1px solid var(--line);padding:6px 4px calc(6px + env(safe-area-inset-bottom))}
  .bn{display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 2px;border-radius:12px;color:var(--dim);
    text-decoration:none;font-size:11px;font-weight:600;transition:color .15s,background .15s;min-width:0}
  .bn span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
  .bnOn{color:var(--save);background:var(--saveSoft)}
}
@media (max-width:1199px){
  .topEnd .live{font-size:0;gap:0;padding:8px}
}
@media (max-width:640px){
  .beta{font-size:11px;padding:2px 8px}
  .brandName{font-size:17px}
  .row{grid-template-columns:minmax(0,1fr) auto;padding:13px 6px}
  .rowTime{grid-column:1/-1}
  .applWhen{text-align:left;min-width:0;width:100%}
  .seg{grid-template-columns:1fr 70px 52px}
}

@media (max-width:420px){
  .topIn{gap:8px}
  .topEnd{gap:6px}
  .motiv{width:34px;height:34px}
  .brand{gap:6px}
  .brandName{font-size:16px}
  .beta{padding:2px 7px}
}
@media (max-width:350px){.beta{display:none}}

@media (prefers-reduced-motion:reduce){
  .app *,.app *::before,.app *::after{animation:none!important;transition:none!important}
}
`;
