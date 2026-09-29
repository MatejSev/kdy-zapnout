import React, { useState, useEffect, useMemo } from "react";
import {
  DISTRIBUTORS, DEFAULT_NT_HOURS, OTE_MONTHLY, SYSTEM_FEES,
} from "./tarify.js";
import {
  toFinalPrices, optimize, actionFor, odpocet, dayCharacter, buildIcs, isoDay,
  cheapestWindow, oknoPopis, tier, hoursLabel, pad, dni, czDate, backtest,
  PROFILY, VYCHOZI_PROFIL, mesicniPrehled, csvHodiny, csvDny,
  SABLONY, novySpotrebic, doplnSpotrebice, prepniKonflikt, odeberSpotrebic,
} from "./logika.js";
import {
  PREMIUM_CENA, PLATBA_URL, FORMULAR_URL, GOATCOUNTER_KOD, DODAVATELE,
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


// ═══════════════════════════════════════════════════════════════
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
  const now = useNow(30000);
  const refreshKey = Math.floor(now.getTime() / 1800000) + ":" + isoDay(0);

  // uložené nastavení
  useEffect(() => {
    const raw = store.get(KLIC);
    if (!raw) return;
    try {
      const v = JSON.parse(raw);
      if (v.cfg) setCfg((c) => ({ ...c, ...v.cfg }));
      if (v.profil) setProfil(v.profil);
      if (v.appliances?.length) setAppliances(doplnSpotrebice(v.appliances));
    } catch { /* poškozené, jedeme na výchozím */ }
  }, []);
  const uloz = (p, c, a) => store.set(KLIC, JSON.stringify({ profil: p, cfg: c, appliances: a }));

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

  const update = (patch) => { const c = { ...cfg, ...patch }; setCfg(c); uloz(profil, c, appliances); };
  const setApps = (a) => { setAppliances(a); setProfil("vlastni"); uloz("vlastni", cfg, a); };
  const vyberProfil = (k) => {
    const a = PROFILY[k].appliances;
    setProfil(k); setAppliances(a); uloz(k, cfg, a);
  };
  const toggle = (id) => setApps(appliances.map((a) => a.id === id ? { ...a, enabled: !a.enabled } : a));
  const patchApp = (id, p) => setApps(appliances.map((a) => a.id === id ? { ...a, ...p } : a));
  const addApp = (sablona = "vlastni") => {
    const novy = novySpotrebic(sablona, appliances);
    setApps([...appliances, novy]);
    setEditing(novy.id);
  };
  const toggleConflict = (a, b) => setApps(prepniKonflikt(appliances, a, b));

  // Dokud nejsou data, žádná čísla.
  if (!data) {
    return (
      <div className="app">
        <style>{CSS}</style>
        <Hlavicka mode={mode} data={data} dnes={dnesD} now={now} />
        <section className="board shell">
          {mode === "error" ? (
            <>
              <h2 className="boardHead">Ceny se teď nepodařilo načíst</h2>
              <p className="boardSub">Zkusím to znovu za minutu, stránku nemusíš obnovovat.</p>
            </>
          ) : (
            <>
              <h2 className="boardHead">Načítám ceny</h2>
              <p className="boardSub">Ceny z OTE, kurz z ČNB a předpověď slunce.</p>
              <div className="skel" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <span key={i} />)}</div>
            </>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="app">
      <style>{CSS}</style>
      <Hlavicka mode={mode} data={data} dnes={dnesD} now={now} />

      <UsporyHero bt={bt} btProfily={btProfily} profil={profil} vyberProfil={vyberProfil}
        showMethod={showMethod} setShowMethod={setShowMethod} cfg={cfg} />

      {prices && opt ? (
        <>
          <ActionBoard plan={opt.plan} prices={prices} avg={opt.avg} now={now} isToday={isToday}
            day={day} setDay={setDay} hasTomorrow={Boolean(tomorrowPrices)}
            tomorrowMsg={tomorrowPrices ? null : "Zítřejší ceny zveřejňuje OTE odpoledne, stránka je načte sama."}
            character={dayCharacter(prices, bt.days)} onIcs={() => stahnoutIcs(opt.plan, shownDate)}
            window={cheapestWindow(todayPrices, tomorrowPrices, now.getHours(), 3)} />

          <section className="hero">
            <div className="heroHead">
              <h2 className="secHead">{isToday ? "Ceny dnes po hodinách" : "Ceny zítra po hodinách"}</h2>
              <p className="lede">
                Nejlevněji je {isToday ? "dnes" : "zítra"} ve {opt.minH}:00 za {fmt(prices[opt.minH].price)} Kč,
                nejdráž v {opt.maxH}:00 za {fmt(prices[opt.maxH].price)} Kč za kWh včetně distribuce a DPH.
              </p>
            </div>
            <HourMap prices={prices} plan={active} showNow={isToday} />
            <DayBand prices={prices} pv={pv} plan={active} avg={opt.avg} showNow={isToday}
              spicka={opt.spicka} limit={opt.limit} />
          </section>
        </>
      ) : (
        <section className="board">
          <h2 className="boardHead">Ceny na dnešek zatím nejsou</h2>
          <p className="boardSub">
            Automatický sběr je dnes ještě nestáhl. Zkusí to znovu odpoledne, stránka se
            aktualizuje sama. Historie úspor výš je ze skutečných dat z minulých dnů.
          </p>
        </section>
      )}

      <PremiumBlok id="odber">
        <KalendarOdber profil={profil} />
      </PremiumBlok>

      <PremiumBlok id="historie">
        <Historie bt={bt} historie={historie} cfgEff={cfgEff}
          todayPrices={todayPrices} tomorrowPrices={tomorrowPrices} />
      </PremiumBlok>

      <div className="custHead">
        <h2 className="secHead">Přizpůsobit podle sebe</h2>
        <p>
          Nic vyplňovat nemusíš. Stránka počítá s obecným tarifem D02d, který má většina
          domácností, a se spotřebiči podle zvolené domácnosti. Pro přesnější čísla si tady
          nastav vlastní.
        </p>
      </div>
      <nav className="tabs">
        {[["spotrebice", "Spotřebiče"], ["cena", "Můj tarif"], ["premium", "Co všechno umí"]].map(([k, l]) => (
          <button key={k} className={tab === k ? "tab tabOn" : "tab"} onClick={() => setTab(k)}>{l}</button>
        ))}
      </nav>
      <main className="panel">
        {tab === "spotrebice" && opt && (
          <Appliances appliances={appliances} plan={opt.plan} editing={editing}
            setEditing={setEditing} toggle={toggle} patchApp={patchApp}
            remove={(id) => setApps(odeberSpotrebic(appliances, id))} add={addApp}
            toggleConflict={toggleConflict} cfg={cfg} update={update} />
        )}
        {tab === "cena" && prices && <PriceTab cfg={cfg} update={update} prices={prices} eurCzk={dnesD?.eurCzk} />}
        {tab === "premium" && <Premium bt={bt} />}
      </main>

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
    </div>
  );
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
  if (p.duvod === "prikon") return `Potřebuje ${fmt(p.kw, 1)} kW a spolu se základní spotřebou domu se nevejde do limitu ${fmt(p.limit, 1)} kW. Zvyš limit, nebo prodluž cyklus, aby stačil menší příkon.`;
  const d = p.omezeni ?? { soubeh: [], limit: false };
  const casti = [];
  if (d.soubeh.length) casti.push(kvuliSpotrebici(d.soubeh));
  if (d.limit) casti.push("limitu příkonu");
  return casti.length
    ? `V povoleném čase se nevejde kvůli ${vycet(casti)}. Zkus mu rozšířit časové okno.`
    : "V povoleném čase se nevejde. Zkus mu rozšířit časové okno.";
}

// ═══ Hlavička se stavem dat ════════════════════════════════════
function Hlavicka({ mode, data, dnes, now }) {
  const zdroj = dnes?.src === "ENTSO-E" ? "ENTSO-E (záloha)" : "OTE";
  let stav;
  if (mode === "loading") stav = <span className="live liveLoad"><i className="dot" />Načítám ceny</span>;
  else if (!data) stav = <span className="live liveDemo"><i className="dot" />Ceny nedostupné</span>;
  else if (!dnes) stav = <span className="live liveDemo"><i className="dot" />Dnešní ceny zatím chybí</span>;
  else if (!data.updatedAt) stav = <span className="live liveOn"><i className="dot" />Ceny z {zdroj}</span>;
  else {
    const t = new Date(data.updatedAt);
    const min = Math.round((now - t) / 60000);
    const kdy = min < 60 ? `před ${Math.max(1, min)} min` : min < 60 * 24
      ? `dnes ve ${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}`
      : `${t.getDate()}. ${t.getMonth() + 1}.`;
    stav = <span className="live liveOn" title="Ceny se stahují automaticky každý den"><i className="dot" />Ceny z {zdroj}, staženo {kdy}</span>;
  }
  return (
    <header className="top">
      <div className="brand"><Bolt /><span className="brandName">Kdy zapnout</span></div>
      {stav}
    </header>
  );
}

// ═══ Úspory: hlavní sdělení stránky ════════════════════════════
function UsporyHero({ bt, btProfily, profil, vyberProfil, showMethod, setShowMethod, cfg }) {
  const MIN = 3;
  const dostatek = bt.dayCount >= MIN;
  return (
    <section className="proof uspory">
      <h1 className="usporyHead">Kolik ušetříš, když budeš spotřebiče pouštět v levných hodinách</h1>

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
              <p className="bigMoney">{fmtCzk(bt.perMonth)}<span className="bigUnit"> měsíčně</span></p>
              <p className="bigMoneyLbl">
                Tolik by tahle domácnost ušetřila proti tomu, kdyby spotřebiče pouštěla
                kdykoli během dne. Za rok zhruba {fmtCzk(bt.projectedYear)}.
              </p>
            </div>
            <ProofBars days={bt.days} />
          </div>
          <p className="projection">
            Za {dni(bt.dayCount)} od {czDate(bt.from)} do {czDate(bt.to)}: {fmt(bt.totalAtAverage, 0)} Kč
            při spouštění kdykoli, {fmt(bt.totalOptimized, 0)} Kč podle plánu.
            {!bt.reliable && " Vzorek je zatím malý, číslo se ještě usadí."}
            {" "}
            <button className="linkBtn" onClick={() => setShowMethod(!showMethod)}>
              {showMethod ? "skrýt, jak se to počítá" : "jak se to počítá"}
            </button>
          </p>
          {showMethod && (
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
          )}
        </>
      ) : (
        <p className="usporyEmpty">
          Automatický sběr skutečných cen z OTE běží každý den
          {bt.dayCount > 0 ? `, zatím má ${dni(bt.dayCount)}` : ""}. Od tří dnů se tu ukáže,
          kolik by plán ušetřil. Vymyšlená čísla tu schválně nejsou.
        </p>
      )}
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
              title={`${p.hour}:00 až ${p.hour + 1}:00, ${fmt(p.price)} Kč za kWh${planned.has(p.hour) ? ", naplánováno" : ""}`}>
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

// ═══ Tabule: co zapnout teď ════════════════════════════════════
function ActionBoard({ plan, prices, avg, now, isToday, day, setDay, hasTomorrow, tomorrowMsg, character, onIcs, window: okno }) {
  const nowH = now.getHours(), nowM = now.getMinutes();
  const cur = prices[nowH];
  const levne = cur && cur.price <= avg * 0.9;
  const drahe = cur && cur.price >= avg * 1.1;

  const polozky = plan
    .filter((p) => !p.infeasible && p.hours?.length)
    .map((p) => ({ p, a: actionFor(p, nowH, nowM, isToday) }))
    // teď nahoru, pak podle toho, co přijde nejdřív, hotové dolů
    .sort((x, y) => {
      const rank = { now: 0, later: 1, tomorrow: 1, done: 2, none: 3 };
      return rank[x.a.kind] - rank[y.a.kind] || (x.a.mins ?? x.a.at ?? 0) - (y.a.mins ?? y.a.at ?? 0);
    });

  const teded = polozky.filter((x) => x.a.kind === "now");
  const nejdou = plan.filter((p) => p.infeasible);

  return (
    <section className="board">
      <div className="boardTop">
        <div className="dayToggle" role="tablist" aria-label="Den">
          <button role="tab" aria-selected={day === "today"} className={day === "today" ? "dt dtOn" : "dt"}
            onClick={() => setDay("today")}>Dnes</button>
          <button role="tab" aria-selected={day === "tomorrow"} disabled={!hasTomorrow}
            className={day === "tomorrow" && hasTomorrow ? "dt dtOn" : "dt"}
            onClick={() => setDay("tomorrow")}
            title={hasTomorrow ? "" : tomorrowMsg ?? "Zítřejší ceny zatím nejsou"}>Zítra</button>
        </div>
        {!hasTomorrow && tomorrowMsg && day === "today" && <p className="boardHint">{tomorrowMsg}</p>}
      </div>

      {isToday ? (
        <h2 className="boardHead">
          {teded.length > 0
            ? teded.length === 1
              ? <>Teď zapni <em>{teded[0].p.name.toLowerCase()}</em></>
              : <>Teď zapni {teded.length} spotřebiče</>
            : levne ? "Teď je levná hodina"
            : drahe ? "Teď je drahá hodina, počkej"
            : "Teď je průměrná cena"}
        </h2>
      ) : (
        <h2 className="boardHead">Plán na zítřek</h2>
      )}

      {isToday && cur && (
        <p className="boardSub">
          Právě teď {fmt(cur.price)} Kč za kWh, dnešní průměr je {fmt(avg)} Kč.
        </p>
      )}

      {isToday && okno && (
        <p className="winLine">
          <span className="winLbl">Nejlevnější tři hodiny v příštích 24 h</span>
          <span className="winVal">{oknoPopis(okno)}</span>
          <span className="winAvg">průměr {fmt(okno.avg)} Kč</span>
        </p>
      )}

      {character.kind === "big" && (
        <p className="dayFlag dayFlagBig">
          {isToday ? "Dnes" : "Zítra"} je rozdíl mezi levnou a drahou hodinou {fmt(character.today, 1)}×,
          obvykle bývá {fmt(character.median, 1)}×. Plán dodržet se vyplatí víc než jindy.
        </p>
      )}
      {character.kind === "flat" && (
        <p className="dayFlag dayFlagFlat">
          {isToday ? "Dnes" : "Zítra"} jsou ceny vyrovnané, rozdíl jen {fmt(character.today, 1)}×.
          Na přesunutí spotřebičů tolik nezáleží.
        </p>
      )}

      {polozky.length === 0 ? (
        <p className="boardEmpty">Zapni aspoň jeden spotřebič dole v záložce Spotřebiče.</p>
      ) : (
        <ul className="cards">
          {polozky.map(({ p, a }) => (
            <li key={p.id} className={`card card-${a.kind}`}>
              <p className="cardName">{p.name}</p>
              <p className="cardTime">{hoursLabel(p.hours)}</p>
              <p className="cardStatus">
                {a.kind === "now" && `Zapni teď, levně do ${a.until}:00`}
                {a.kind === "later" && `Zapni ${odpocet(a.mins)}`}
                {a.kind === "tomorrow" && `Zítra od ${a.at}:00`}
                {a.kind === "done" && "Levné hodiny dnes už byly"}
              </p>
              <p className="cardCost">
                {fmtCzk(p.cost)}{p.pvUsed > 0.05 && `, z toho ${fmt(p.pvUsed, 1)} kWh z panelů`}
              </p>
              {p.posunuto && <p className="cardNote">{popisPosunu(p)}</p>}
            </li>
          ))}
        </ul>
      )}

      {nejdou.length > 0 && (
        <div className="boardWarn" role="note">
          {nejdou.map((p) => <p key={p.id}><strong>{p.name}</strong> se nepodařilo naplánovat. {popisNelze(p)}</p>)}
        </div>
      )}

      {polozky.length > 0 && (
        <div className="boardFoot">
          <button className="btn btnSolid" onClick={onIcs}>Přidat do kalendáře</button>
          <p className="boardFootNote">
            Telefon ti pět minut předem připomene, co zapnout.
          </p>
        </div>
      )}
    </section>
  );
}

// ═══ Průběh dne: graf ceny a rozvrh spotřebičů ════════════════
/**
 * Graf je obrázek bez jediného textu. Všechny popisky (časová osa,
 * značka "teď", názvy spotřebičů) jsou běžné HTML v mřížce, takže se
 * nezmenšují na nečitelnou velikost a nemohou se navzájem překrýt:
 * každý druh popisku má vlastní řádek nebo sloupec.
 */
function DayBand({ prices, pv, plan, avg, showNow = true, spicka, limit }) {
  const N = prices.length;                    // 23, 24 nebo 25 hodin
  const W = 1000, V = 220;                     // souřadnice obrázku, roztahuje se do šířky
  const vals = prices.map((p) => p.price);
  const lo = Math.min(0, ...vals), hi = Math.max(...vals) * 1.1;
  const x = (h) => (h / N) * W;
  const y = (v) => V - 8 - ((v - lo) / (hi - lo || 1)) * (V - 24);

  let krivka = `M ${x(0)} ${y(vals[0])}`;
  for (let h = 0; h < N; h++) krivka += ` L ${x(h)} ${y(vals[h])} L ${x(h + 1)} ${y(vals[h])}`;

  const maxPv = Math.max(0.01, ...pv);
  const ted = new Date();
  const tedH = ted.getHours() + ted.getMinutes() / 60;
  const tedPct = (tedH / N) * 100;
  const tedText = `${ted.getHours()}:${String(ted.getMinutes()).padStart(2, "0")}`;
  const naplanovano = new Set(plan.flatMap((p) => p.hours));
  const osa = Array.from({ length: Math.floor(N / 3) + 1 }, (_, i) => i * 3).filter((h) => h <= N);
  if (osa[osa.length - 1] !== N) osa.push(N);

  return (
    <div className="db">
      {showNow && (
        <div className="dbRow">
          <span className="dbG" />
          <div className="dbNowRow">
            <span className="dbNow" style={{ left: `clamp(34px, ${tedPct}%, calc(100% - 34px))` }}>teď {tedText}</span>
          </div>
        </div>
      )}

      <div className="dbRow">
        <span className="dbG" />
        <div className="dbPlot">
          <svg viewBox={`0 0 ${W} ${V}`} preserveAspectRatio="none" className="dbSvg"
            role="img" aria-label="Průběh ceny elektřiny během dne">
            <defs>
              <linearGradient id="sky" x1="0" x2="1">
                <stop offset="0%" stopColor="#121A2E" /><stop offset="20%" stopColor="#1B2647" />
                <stop offset="33%" stopColor="#3C4A78" /><stop offset="50%" stopColor="#6E7FB0" />
                <stop offset="62%" stopColor="#8FA0C9" /><stop offset="75%" stopColor="#4F5C8E" />
                <stop offset="88%" stopColor="#1E2949" /><stop offset="100%" stopColor="#121A2E" />
              </linearGradient>
              <linearGradient id="sunGlow" x1="0" y1="1" x2="0" y2="0">
                <stop offset="0%" stopColor="#F0B429" stopOpacity="0.55" />
                <stop offset="100%" stopColor="#F0B429" stopOpacity="0" />
              </linearGradient>
            </defs>
            <rect x="0" y="0" width={W} height={V} fill="url(#sky)" />
            {pv.map((v, h) => v > 0.02 && h < N && (
              <rect key={`pv${h}`} x={x(h)} y={V * 0.45} width={W / N} height={V * 0.55}
                fill="url(#sunGlow)" opacity={v / maxPv} />
            ))}
            {[...naplanovano].map((h) => (
              <rect key={`s${h}`} x={x(h)} y="0" width={W / N} height={V} fill="#fff" opacity="0.11" />
            ))}
            <line x1="0" x2={W} y1={y(avg)} y2={y(avg)} stroke="#fff" strokeOpacity="0.3"
              strokeWidth="1" strokeDasharray="4 6" vectorEffect="non-scaling-stroke" />
            <path d={krivka} fill="none" stroke="#fff" strokeWidth="2.4" strokeLinejoin="round"
              vectorEffect="non-scaling-stroke" className="curve" />
            {showNow && <line x1={x(tedH)} x2={x(tedH)} y1="0" y2={V} stroke="#F0B429"
              strokeWidth="2" vectorEffect="non-scaling-stroke" />}
          </svg>
        </div>
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

      {plan.length > 0 && (
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
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="bandLegend">
        <span><i className="sw swSave" />plán ze sítě</span>
        {plan.some((p) => p.hours.some((h) => (p.pvPoHodinach?.[h] ?? 0) >= (p.naHodinu ?? 1) * 0.5)) &&
          <span><i className="sw swSun" />většinou z panelů</span>}
        <span><i className="sw swAvg" />průměrná cena dne</span>
        {limit != null && (
          <span>nejvyšší souběžný příkon {fmt(spicka, 1)} kW z limitu {fmt(limit, 1)} kW</span>
        )}
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
        {` ${fmt(cfg.baseLoadPerHour, 1)} kW`}. Jeden okruh s jističem 16 A unese asi 3,5 kW.
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
                    {fmt(a.kwh, 1)} kWh za {a.hours} h, příkon {fmt(Math.max(a.kw ?? 0, a.kwh / a.hours), 1)} kW
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
                      Při příkonu {fmt(a.kw, 1)} kW nejde za {a.hours} h odebrat {fmt(a.kwh, 1)} kWh, na to je potřeba
                      aspoň {fmt(a.kwh / a.hours, 1)} kW. Počítám proto s {fmt(a.kwh / a.hours, 1)} kW. Když má
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
              <option key={d.id} value={d.id}>{d.nazev}, {fmt(d.marze)} Kč za kWh</option>
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
        {eurCzk && <p className="fieldNote">Kurz eura dnes {fmt(eurCzk, 3)} Kč podle ČNB, bere se automaticky.</p>}
        <Field label="Systémové poplatky v Kč za kWh"><input type="number" step="0.01" value={cfg.systemFees}
          onChange={(e) => update({ systemFees: +e.target.value })} /></Field>
        <Field label="Tvůj fixní tarif v Kč za kWh s DPH, nepovinné">
          <input type="number" step="0.01" min="0" placeholder="z vyúčtování, když chceš srovnání"
            value={cfg.flatPrice ?? ""}
            onChange={(e) => update({ flatPrice: e.target.value === "" ? null : +e.target.value })} />
        </Field>
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
          <p className="splitTitle">Cena v {now.hour}:00 je {fmt(now.price)} Kč za kWh</p>
          <Seg label="Silová elektřina" v={now.parts.energy} pct={pct(now.parts.energy)} cls="segA" />
          <Seg label="Distribuce" v={now.parts.distribution} pct={pct(now.parts.distribution)} cls="segB" />
          <Seg label="Systémové poplatky" v={now.parts.system} pct={pct(now.parts.system)} cls="segC" />
          <p className="splitNote">
            Spot je jen část účtu. Distribuce z něj dělá {pct(now.parts.distribution)} procent,
            a proto nestačí koukat jen na burzovní cenu.
          </p>
          <p className="splitNote">
            K tomu platíš měsíčně {fmt(OTE_MONTHLY)} Kč za činnost operátora trhu a platbu
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
        <a className="btn btnSolid" href={google} target="_blank" rel="noopener">Přidat do Google kalendáře</a>
        <a className="btn" href={webcal}>Přidat na iPhone nebo Mac</a>
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
    const dny = [{ date: isoDay(0), prices: todayPrices }];
    if (tomorrowPrices) dny.push({ date: isoDay(1), prices: tomorrowPrices });
    stahnoutSoubor(csvHodiny(dny.filter((d) => d.prices)), `ceny-${isoDay(0)}.csv`, "text/csv;charset=utf-8");
  };
  const exportDnu = () => stahnoutSoubor(csvDny(bt.days), `uspory-${isoDay(0)}.csv`, "text/csv;charset=utf-8");

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
        Průměrná cena za kWh po dnech, od {czDate(bt.from)} do {czDate(bt.to)}.
        Nejlevnější den {fmt(min)} Kč, nejdražší {fmt(max)} Kč.
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="spark" role="img" aria-label="Vývoj průměrné ceny po dnech">
        <path d={cesta} fill="none" stroke="var(--save)" strokeWidth="2.2" strokeLinejoin="round" />
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
                <td className="num">{fmt(m.prumerCen)} Kč</td>
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

:root{
  --night:#121A2E;
  --paper:#F3F6F9;
  --card:#FFFFFF;
  --ink:#18202F;
  --dim:#5D6980;
  --line:#DFE5EC;
  --save:#0E7C5A;
  --peak:#C4531C;
  --sun:#F0B429;
  --display:'Bricolage Grotesque',system-ui,sans-serif;
  --body:'Manrope',system-ui,sans-serif;
}
*{box-sizing:border-box}
body{margin:0}
.app{background:var(--paper);color:var(--ink);font-family:var(--body);min-height:100vh;padding-bottom:56px}
h1,h2,h3{font-family:var(--display);font-weight:700;letter-spacing:-0.02em;margin:0;line-height:1.2}
h1{font-size:clamp(26px,3.4vw,38px);line-height:1.2}
h2{font-size:clamp(20px,2.4vw,26px)}
h3{font-size:17px;margin-bottom:14px}
p{margin:0}
button{font-family:var(--body)}
:focus-visible{outline:2px solid var(--save);outline-offset:2px;border-radius:4px}

.top{display:flex;justify-content:space-between;align-items:center;gap:14px;
  flex-wrap:wrap;padding:16px clamp(16px,4vw,40px)}
.brand{display:flex;align-items:center;gap:9px}
.brandName{font-family:var(--display);font-weight:700;font-size:19px;letter-spacing:-0.02em}
.topRight{display:flex;align-items:center;gap:10px}
.src{font-size:12.5px;color:var(--dim);background:var(--card);border:1px solid var(--line);
  padding:5px 11px;border-radius:999px}
.srcLive{color:var(--save);border-color:#B6DCCB;background:#EAF6F1}

.btn{border-radius:999px;padding:9px 18px;font-size:14px;cursor:pointer;border:1px solid var(--line);
  background:var(--card);color:var(--ink);transition:background .15s}
.btn:hover{background:#EEF2F6}
.btnSolid{background:var(--ink);color:#fff;border-color:var(--ink)}
.btnSolid:hover{background:#2A354A}
.btnQuiet{background:transparent}
.btnDanger{border-color:#E7C3B2;color:var(--peak);background:transparent;justify-self:start}
.linkBtn{background:none;border:none;color:var(--save);font-size:13.5px;cursor:pointer;
  text-decoration:underline;text-underline-offset:3px;padding:4px}

.note,.warn{margin:0 clamp(16px,4vw,40px) 12px;padding:11px 15px;border-radius:12px;font-size:13.5px;
  display:flex;justify-content:space-between;gap:12px;align-items:center}
.note{background:#E9EFF7;color:#2B3B57}
.warn{background:#FBEDE4;color:#8A3D14}
.warn code{background:#F5DCCB;padding:1px 5px;border-radius:4px;font-size:12.5px}
.noteX{background:none;border:none;cursor:pointer;color:inherit;font-size:14px}

.live{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;
  padding:6px 13px 6px 11px;border-radius:999px;background:var(--card);border:1px solid var(--line)}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex-shrink:0}
.liveOn{color:#0B5C43;border-color:#B6DCCB;background:#EAF6F1}
.liveOn .dot{background:var(--save);box-shadow:0 0 0 0 rgba(14,124,90,.5);animation:puls 2.4s infinite}
.liveDemo{color:#8A5A0B;border-color:#EBD3A4;background:#FBF3E2}
.liveDemo .dot{background:var(--sun)}
.liveLoad{color:var(--dim)}
.liveLoad .dot{background:#B6C0CE}
@keyframes puls{0%{box-shadow:0 0 0 0 rgba(14,124,90,.45)}70%{box-shadow:0 0 0 7px rgba(14,124,90,0)}100%{box-shadow:0 0 0 0 rgba(14,124,90,0)}}
@media (prefers-reduced-motion:reduce){.liveOn .dot{animation:none}}

.winLine{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-top:16px;
  padding:12px 15px;background:#F3F6F9;border-radius:12px;max-width:fit-content}
.winLbl{font-size:13px;color:var(--dim)}
.winVal{font-family:var(--display);font-weight:700;font-size:17px;letter-spacing:-0.01em}
.winAvg{font-size:13px;color:var(--save);font-weight:600}

.hmWrap{margin-top:20px}
.hm{display:grid;grid-template-columns:repeat(12,1fr);gap:5px}
.hmC{position:relative;border-radius:10px;padding:8px 4px 9px;text-align:center;
  display:flex;flex-direction:column;gap:2px;transition:transform .12s}
.hmC:hover{transform:translateY(-2px)}
.hmH{font-size:11px;opacity:.75}
.hmP{font-family:var(--display);font-weight:700;font-size:15px;letter-spacing:-0.01em}
.t0{background:#0E7C5A;color:#fff}
.t1{background:#BFE4D3;color:#0B4A37}
.t2{background:#EDF1F5;color:var(--ink)}
.t3{background:#F5D6C3;color:#6E2C0C}
.t4{background:#C4531C;color:#fff}
.hmNow{outline:2.5px solid var(--sun);outline-offset:2px}
.hmPast{opacity:.38}
.hmDot{position:absolute;top:5px;right:5px;width:6px;height:6px;border-radius:50%;
  background:currentColor;opacity:.85}
.hmDotStatic{position:static;display:inline-block;background:var(--ink);margin-right:4px;vertical-align:1px}
.hmScale{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px;
  font-size:12px;color:var(--dim)}
.hmBar{width:120px;height:8px;border-radius:999px;
  background:linear-gradient(90deg,#0E7C5A,#BFE4D3,#EDF1F5,#F5D6C3,#C4531C)}
.hmKey{margin-left:auto}

.custHead{margin:34px clamp(16px,4vw,40px) 0;max-width:68ch}
.custHead p{color:var(--dim);font-size:14.5px;line-height:1.55;margin-top:8px}

.board{margin:6px clamp(16px,4vw,40px) 0;background:var(--card);border-radius:22px;
  padding:clamp(20px,3vw,30px);box-shadow:0 1px 2px rgba(20,30,50,.05)}
.boardTop{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:18px}
.dayToggle{display:inline-flex;background:#EDF1F5;border-radius:999px;padding:3px}
.dt{border:none;background:transparent;padding:7px 18px;border-radius:999px;font-size:14px;
  font-weight:600;color:var(--dim);cursor:pointer}
.dt:disabled{opacity:.45;cursor:not-allowed}
.dtOn{background:var(--card);color:var(--ink);box-shadow:0 1px 3px rgba(20,30,50,.12)}
.boardHint{font-size:12.5px;color:var(--dim)}
.boardHead{font-size:clamp(28px,4.2vw,44px);line-height:1.18;letter-spacing:-0.03em}
.boardHead em{font-style:normal;color:var(--save)}
.boardSub{color:var(--dim);font-size:15px;margin-top:8px}
.dayFlag{margin-top:16px;padding:12px 15px;border-radius:12px;font-size:13.5px;line-height:1.5;max-width:64ch}
.dayFlagBig{background:#EAF6F1;color:#0B5C43}
.dayFlagFlat{background:#F2F4F7;color:var(--dim)}
.boardEmpty{margin-top:18px;color:var(--dim);font-size:14px}
.cards{list-style:none;padding:0;margin:22px 0 0;display:grid;
  grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}
.card{border-radius:16px;padding:16px 17px;border:1px solid var(--line);background:var(--card)}
.cardName{font-weight:600;font-size:14px;color:var(--dim)}
.cardTime{font-family:var(--display);font-size:24px;font-weight:700;letter-spacing:-0.02em;
  margin-top:6px;line-height:1.25}
.cardStatus{font-size:14px;font-weight:600;margin-top:10px}
.cardCost{font-size:12.5px;color:var(--dim);margin-top:4px}
.card-now{background:var(--save);border-color:var(--save);color:#fff}
.card-now .cardName,.card-now .cardCost{color:rgba(255,255,255,.82)}
.card-later .cardStatus{color:var(--save)}
.card-tomorrow .cardStatus{color:var(--ink)}
.card-done{opacity:.55}
.card-done .cardStatus{color:var(--dim);font-weight:500}
.boardFoot{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:20px;
  padding-top:18px;border-top:1px solid var(--line)}
.boardFootNote{font-size:12.5px;color:var(--dim)}

.hero{margin:18px clamp(16px,4vw,40px) 0;background:var(--card);border-radius:22px;
  padding:clamp(20px,3vw,30px);box-shadow:0 1px 2px rgba(20,30,50,.05)}
.heroHead{max-width:62ch}
.lede{color:var(--dim);font-size:15.5px;line-height:1.55;margin-top:10px}


.curve{stroke-dasharray:2600;stroke-dashoffset:2600;animation:draw 1.3s cubic-bezier(.4,0,.2,1) forwards}
@keyframes draw{to{stroke-dashoffset:0}}
@media (prefers-reduced-motion:reduce){.curve{animation:none;stroke-dasharray:none;stroke-dashoffset:0}}



.bandLegend{display:flex;gap:18px;flex-wrap:wrap;font-size:12.5px;color:var(--dim);margin-top:10px}
.bandLegend .sw{width:11px;height:11px;border-radius:3px;display:inline-block;margin-right:6px;
  vertical-align:-1px}
.swSave{background:var(--save)} .swSun{background:var(--sun)}

.heroFoot{margin-top:20px;padding-top:18px;border-top:1px solid var(--line)}
.saving{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
.savingNum{font-family:var(--display);font-size:clamp(30px,4.4vw,44px);font-weight:700;
  color:var(--save);letter-spacing:-0.03em;line-height:1.15}
.savingLbl{color:var(--dim);font-size:14px;max-width:34ch;line-height:1.45}

.proof{margin:18px clamp(16px,4vw,40px) 0;background:var(--night);color:#E8EDF6;
  border-radius:22px;padding:clamp(20px,3vw,30px)}
.proof h2{color:#fff}
.proofHead{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap}
.proof .linkBtn{color:#9FE3C6}
.method{background:rgba(255,255,255,.07);border-radius:14px;padding:16px 18px;margin-top:14px;
  display:grid;gap:9px;font-size:13.5px;line-height:1.6;color:#C6D0E2;max-width:68ch}
.proofGrid{display:grid;grid-template-columns:minmax(200px,auto) 1fr;gap:clamp(20px,4vw,44px);
  align-items:end;margin-top:22px}
.proofEmpty h2{color:#fff}
.proofEmpty p{color:#B9C4D8;font-size:14.5px;line-height:1.6;margin-top:10px;max-width:62ch}
.savingAlt{color:var(--dim);font-size:13.5px;margin-top:8px}
.shell{margin-top:18px}
.skel{display:grid;grid-template-columns:repeat(12,1fr);gap:5px;margin-top:24px}
.skel span{height:52px;border-radius:10px;background:linear-gradient(90deg,#EDF1F5,#F6F8FA,#EDF1F5);
  background-size:200% 100%;animation:skel 1.4s ease-in-out infinite}
@keyframes skel{0%{background-position:200% 0}100%{background-position:-200% 0}}
@media (prefers-reduced-motion:reduce){.skel span{animation:none}}
.tagReal,.tagDemo{font-size:11.5px;padding:4px 10px;border-radius:999px;
  display:inline-block;margin-bottom:10px}
.tagReal{background:rgba(110,231,183,.16);color:#6EE7B7}
.tagDemo{background:rgba(240,180,41,.18);color:#F0B429}
.bigMoney{font-family:var(--display);font-size:clamp(38px,6vw,60px);font-weight:700;
  letter-spacing:-0.035em;line-height:1.15;color:#6EE7B7}
.bigMoneyLbl{color:#A8B4CA;font-size:13.5px;margin-top:10px;max-width:30ch;line-height:1.5}
.bars{display:flex;align-items:flex-end;gap:3px;height:110px}
.barCol{flex:1;height:100%;display:flex;align-items:flex-end}
.bar{width:100%;background:linear-gradient(#6EE7B7,#2F9E75);border-radius:3px 3px 0 0;display:block}
.projection{margin-top:22px;padding-top:18px;border-top:1px solid rgba(255,255,255,.13);
  color:#B9C4D8;font-size:14px;line-height:1.6;max-width:70ch}
.projection strong{color:#fff}

.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:26px clamp(16px,4vw,40px) 0}
.tab{background:transparent;border:none;padding:10px 16px;border-radius:999px;font-size:14.5px;
  color:var(--dim);cursor:pointer}
.tab:hover{background:#E7EDF3}
.tabOn{background:var(--ink);color:#fff}
.panel{margin:12px clamp(16px,4vw,40px) 0;background:var(--card);border-radius:22px;
  padding:clamp(20px,3vw,28px);box-shadow:0 1px 2px rgba(20,30,50,.05)}

.applList{list-style:none;padding:0;margin:0 0 18px;display:grid;gap:10px}
.appl{border:1px solid var(--line);border-radius:16px;padding:14px 16px}
.applOff{opacity:.5}
.applRow{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.sw3{width:44px;height:26px;border-radius:999px;border:none;background:#D8DFE8;cursor:pointer;
  padding:3px;flex-shrink:0}
.knob{width:20px;height:20px;border-radius:50%;background:#fff;display:block;
  transition:transform .18s;box-shadow:0 1px 2px rgba(0,0,0,.2)}
.knobOn{transform:translateX(18px)}
.sw3:has(.knobOn){background:var(--save)}
.applInfo{flex:1;min-width:150px}
.applName{font-weight:600;font-size:15px}
.applMeta{color:var(--dim);font-size:12.5px;margin-top:3px}
.applWhen{text-align:right;min-width:120px}
.whenTime{font-weight:700;font-size:14.5px}
.whenCost{color:var(--dim);font-size:12.5px;margin-top:2px}
.whenBad{color:var(--peak);font-size:12.5px}
.edit{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:13px;
  margin-top:15px;padding-top:15px;border-top:1px solid var(--line)}
.check{display:flex;align-items:center;gap:9px;font-size:13.5px;grid-column:1/-1}

.field{display:block;margin-bottom:13px}
.field>span{display:block;font-size:12.5px;color:var(--dim);margin-bottom:5px}
input,select{width:100%;font-family:var(--body);font-size:14px;padding:10px 12px;
  border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink)}
input[type=checkbox]{width:auto}
input:focus,select:focus{border-color:var(--save)}

.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:clamp(20px,4vw,40px)}
.split{margin-top:22px;padding-top:18px;border-top:1px solid var(--line)}
.splitTitle{font-weight:600;font-size:14.5px;margin-bottom:13px}
.seg{display:grid;grid-template-columns:1fr 110px 54px;align-items:center;gap:10px;
  margin-top:9px;font-size:13px}
.segLbl{color:var(--dim)}
.segTrack{height:9px;background:#EDF1F5;border-radius:999px;display:block;overflow:hidden}
.segFill{height:9px;display:block;border-radius:999px}
.segA{background:var(--ink)} .segB{background:var(--peak)} .segC{background:#95A3B8}
.segVal{text-align:right;font-weight:600}
.splitNote{color:var(--dim);font-size:12.5px;line-height:1.55;margin-top:14px;max-width:46ch}

.ntBox{margin-top:22px;padding-top:18px;border-top:1px solid var(--line)}
.ntTitle{font-weight:600;font-size:14.5px;margin-bottom:6px}
.ntNote{color:var(--dim);font-size:12.5px;line-height:1.55;max-width:52ch;margin-bottom:12px}
.ntGrid{display:grid;grid-template-columns:repeat(12,1fr);gap:4px;max-width:420px}
.ntH{aspect-ratio:1;border:1px solid var(--line);background:var(--card);border-radius:7px;
  font-size:11px;color:var(--dim);cursor:pointer;padding:0;transition:background .12s}
.ntH:hover{background:#EEF2F6}
.ntHOn{background:var(--save);border-color:var(--save);color:#fff;font-weight:600}
.ntFoot{font-size:12px;color:var(--dim);margin-top:10px}
.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px}
.plan{border:1px solid var(--line);border-radius:16px;padding:18px}
.planOn{border-color:var(--save);background:#F2FAF6}
.planName{font-family:var(--display);font-weight:700;font-size:16px;margin-bottom:12px}
.plan ul{margin:0 0 16px;padding-left:18px;display:grid;gap:7px;font-size:13.5px;
  color:var(--dim);line-height:1.5}
.honest{margin-top:20px;background:#F5F8FA;border-radius:16px;padding:18px;
  display:grid;gap:10px;font-size:13.5px;line-height:1.6;color:var(--dim);max-width:68ch}
.honestTitle{font-weight:700;color:var(--ink);font-size:14.5px}
.honest strong{color:var(--ink)}

.foot{margin:26px clamp(16px,4vw,40px) 0;color:var(--dim);font-size:12.5px;
  line-height:1.6;max-width:70ch}

@media (max-width:680px){
  .hm{grid-template-columns:repeat(6,1fr)}
  .hmKey{margin-left:0}
  .proofGrid{grid-template-columns:1fr;align-items:start}
  .bars{height:78px}
  .applWhen{text-align:left;min-width:0;width:100%}
  .seg{grid-template-columns:1fr 70px 50px}
}

.uspory{margin-top:6px}
.usporyHead{color:#fff;font-size:clamp(24px,3.4vw,36px);line-height:1.2;letter-spacing:-0.025em;max-width:24ch}
.profily{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px;margin-top:22px}
.prof{text-align:left;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);
  color:#E8EDF6;border-radius:14px;padding:12px 14px;cursor:pointer;display:flex;flex-direction:column;gap:3px;
  font-family:var(--body);transition:background .15s,border-color .15s}
.prof:hover{background:rgba(255,255,255,.1)}
.profOn{background:#fff;color:var(--ink);border-color:#fff}
.profName{font-weight:700;font-size:14.5px}
.profSub{font-size:12px;opacity:.7}
.profVal{font-size:13px;font-weight:700;margin-top:4px;color:#6EE7B7}
.profOn .profVal{color:var(--save)}
.profCustom{cursor:default}
.bigUnit{font-size:.42em;font-weight:600;letter-spacing:0;margin-left:4px;color:#A8E9CE}
.usporyEmpty{color:#B9C4D8;font-size:15px;line-height:1.6;margin-top:18px;max-width:62ch}
.secHead{font-size:clamp(20px,2.4vw,26px)}
.planNote{font-size:12.5px;color:var(--save);margin-top:10px}
.board{margin-top:18px}

.premWrap{position:relative}
.premTag{display:inline-block;font-size:11.5px;font-weight:700;letter-spacing:.01em;
  color:#7A4E00;background:#FDF0CF;border:1px solid #F1D794;padding:3px 10px;border-radius:999px;
  margin:22px clamp(16px,4vw,40px) -8px}
.sec{margin:14px clamp(16px,4vw,40px) 0;background:var(--card);border-radius:22px;
  padding:clamp(20px,3vw,28px);box-shadow:0 1px 2px rgba(20,30,50,.05)}
.lock .premTag{margin:0 0 10px}
.secSub{color:var(--dim);font-size:14.5px;line-height:1.55;margin-top:8px;max-width:66ch}
.kalProf{display:flex;flex-wrap:wrap;gap:6px;margin-top:16px}
.kp{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:7px 14px;
  font-size:13.5px;cursor:pointer;color:var(--ink)}
.kpOn{background:var(--ink);color:#fff;border-color:var(--ink)}
.kalBtns{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}
.kalBtns .btn{text-decoration:none;display:inline-flex;align-items:center}
.fieldNote{font-size:12.5px;color:var(--dim);line-height:1.55;margin:4px 0 12px;max-width:62ch}
.sec .fieldNote{margin-top:14px}
.spark{width:100%;height:90px;margin-top:14px;display:block}
.tblWrap{overflow-x:auto;margin-top:14px}
.tbl{width:100%;border-collapse:collapse;font-size:14px}
.tbl th{text-align:left;font-weight:600;color:var(--dim);font-size:12.5px;padding:8px 10px;border-bottom:1px solid var(--line)}
.tbl td{padding:10px;border-bottom:1px solid var(--line)}
.tbl .num{font-variant-numeric:tabular-nums;text-align:right}
.tbl th:nth-child(n+3){text-align:right}
.footLink{color:var(--save);font-weight:600}

.db{margin-top:22px;--gw:clamp(7.5rem,20%,11.5rem)}
.dbRow{display:grid;grid-template-columns:var(--gw) minmax(0,1fr);column-gap:12px}
.dbNowRow{position:relative;height:26px}
.dbNow{position:absolute;bottom:4px;transform:translateX(-50%);white-space:nowrap;
  font-size:12px;font-weight:700;color:#7A4E00;background:#FDF0CF;border:1px solid #F1D794;
  padding:2px 8px;border-radius:999px}
.dbPlot{border-radius:14px;overflow:hidden;line-height:0}
.dbSvg{width:100%;height:190px;display:block}
.dbAxis{position:relative;height:22px;margin-top:4px}
.ax{position:absolute;top:2px;transform:translateX(-50%);font-size:12px;color:var(--dim);
  font-variant-numeric:tabular-nums;line-height:1}
.axFirst{transform:none}
.axLast{transform:translateX(-100%)}
.gantt{display:grid;gap:7px;margin-top:10px}
.gRow{display:grid;grid-template-columns:var(--gw) minmax(0,1fr);column-gap:12px;align-items:center}
.gName{font-size:13px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.gTrack{display:grid;gap:2px}
.gCell{height:14px;border-radius:3px;background:#EDF1F5}
.gCell.on{background:var(--save)}
.gCell.sun{background:var(--sun)}
.swAvg{background:transparent !important;border-top:2px dashed #9AA6BD;height:0 !important;width:14px !important;vertical-align:3px !important}
@media (max-width:560px){
  .dbRow,.gRow{grid-template-columns:minmax(0,1fr)}
  .dbG{display:none}
  .gRow{row-gap:4px}
  .dbSvg{height:150px}
}

.limitBox{border:1px solid var(--line);border-radius:16px;padding:16px 18px;margin-bottom:16px}
.limitTitle{font-weight:700;font-size:15px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
.chip{border:1px solid var(--line);background:var(--card);border-radius:12px;padding:8px 13px;
  font-size:13.5px;cursor:pointer;color:var(--ink);display:inline-flex;flex-direction:column;
  align-items:flex-start;gap:1px;font-family:var(--body);line-height:1.25}
.chipOn{border-color:var(--save);background:#EAF6F1;color:#0B5C43;font-weight:600}
.chipSub{font-size:11.5px;color:var(--dim);font-weight:400}
.chipInput{flex-direction:row;align-items:center;gap:8px;cursor:default}
.chipInput input{width:80px;padding:5px 8px}
.conf{grid-column:1/-1;border:1px solid var(--line);border-radius:12px;padding:10px 14px 12px;margin:0;min-width:0}
.conf legend{font-size:13px;font-weight:600;padding:0 6px}
.confList{display:flex;flex-wrap:wrap;gap:6px 18px}
.confList .check{grid-column:auto}
.editNote{grid-column:1/-1;margin:0}
.whenNote{color:#8A5A0B;font-size:12px;margin-top:3px;line-height:1.4}
.cardNote{font-size:12px;margin-top:6px;line-height:1.4;color:#8A5A0B}
.card-now .cardNote{color:#FDF0CF}
.boardWarn{margin-top:14px;background:#FBEDE4;color:#6E2C0C;border-radius:12px;padding:10px 14px;
  font-size:13.5px;line-height:1.5;display:grid;gap:4px}
.addRow{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.addRow select{width:auto;min-width:0;flex:0 1 220px}
.addLbl{font-size:14px;font-weight:600}
.applInfo,.applWhen{min-width:0}
.applName,.applMeta,.whenTime,.whenCost,.whenNote,.whenBad{overflow-wrap:anywhere}

@media (max-width:420px){
  .colDni{display:none}
  .tbl th,.tbl td{padding:8px 6px}
  .tbl{font-size:13px}
}

.warnNote{color:#8A3D14;background:#FBEDE4;border-radius:10px;padding:8px 12px}
`;