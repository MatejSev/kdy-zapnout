// ───────────────────────────────────────────────────────────────
// logika.js — všechny výpočty, bez rozhraní
//
// Oddělené od app.jsx, aby šly automaticky otestovat před každým
// nasazením. Když test selže, nová verze se na web nedostane.
// ───────────────────────────────────────────────────────────────

import { DISTRIBUTORS, VAT, DEFAULT_NT_HOURS } from "./tarify.js";

export function toFinalPrices(eurArr, cfg) {
  const rate = DISTRIBUTORS[cfg.distributor].rates[cfg.rate];
  const ntHours = cfg.ntHours ?? (rate.ntCount ? DEFAULT_NT_HOURS[rate.ntCount] ?? [] : []);
  return eurArr.map((eurMwh, hour) => {
    const energy = (eurMwh * cfg.eurCzk) / 1000;
    const withMargin = energy * (1 + cfg.marginPct / 100) + cfg.margin;
    const isNt = rate.nt != null && ntHours.includes(hour);
    const distribution = isNt ? rate.nt : rate.vt;
    const noVat = withMargin + distribution + cfg.systemFees;
    return {
      hour, eurMwh, tariff: isNt ? "NT" : "VT",
      price: Math.round(noVat * (1 + VAT) * 1000) / 1000,
      parts: {
        energy: withMargin * (1 + VAT),
        distribution: distribution * (1 + VAT),
        system: cfg.systemFees * (1 + VAT),
      },
    };
  });
}

/**
 * Naplánuje spotřebiče do nejlevnějších hodin s ohledem na omezení:
 *
 *  - časové okno spotřebiče (ne dřív než, hotovo do)
 *  - nepřerušitelný cyklus (pračka, myčka)
 *  - spotřebiče, které nesmí běžet současně (conflicts)
 *  - limit souběžného příkonu celého domu (maxKw), aby nepadaly pojistky
 *
 * Plánuje se postupně podle priority: kdo má nižší číslo, vybírá první.
 * Je to rychlá a vysvětlitelná heuristika, ne matematicky dokonalé
 * řešení — u pár spotřebičů za den je rozdíl zanedbatelný.
 *
 * U každého spotřebiče si pamatuje, jestli a proč se musel posunout
 * z ideálních hodin, aby to šlo uživateli říct.
 */
export function optimize({ prices, pv, baseLoad, feedIn, appliances, maxKw = null }) {
  const price = prices.map((p) => p.price);
  const H = price.length;
  const zaklad = Array.from({ length: H }, (_, h) => baseLoad[h] ?? 0);
  const surplus = Array.from({ length: H }, (_, h) => Math.max(0, (pv[h] ?? 0) - zaklad[h]));
  const remaining = [...surplus];
  const avg = price.reduce((a, b) => a + b, 0) / H;
  const limit = Number.isFinite(maxKw) && maxKw > 0 ? maxKw : Infinity;

  const zapnute = appliances.filter((a) => a.enabled);
  const podleId = new Map(zapnute.map((a) => [a.id, a]));
  const fronta = [...zapnute].sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
  const zatizeni = [...zaklad];                               // kW v každé hodině
  const bezi = Array.from({ length: H }, () => new Set());    // kdo v hodině běží
  const vKonfliktu = (a, b) => (a.conflicts ?? []).includes(b.id) || (b.conflicts ?? []).includes(a.id);
  const plan = [];

  for (const app of fronta) {
    const naHodinu = app.kwh / app.hours;
    // příkon nemůže být menší než energie za hodinu, to by fyzicky nešlo
    const kw = Math.max(naHodinu, Number.isFinite(app.kw) && app.kw > 0 ? app.kw : naHodinu);
    // omezení na délku dne: ve dnech změny času má den 23 nebo 25 hodin
    const from = Math.max(0, Math.min(H, app.earliest ?? 0));
    const to = Math.max(0, Math.min(H, app.latest ?? H));
    const nelze = (duvod, extra = {}) => plan.push({ ...app, kw, infeasible: true, duvod, ...extra,
      hours: [], cost: 0, pvUsed: 0, savingVsAvg: 0 });

    if (to - from < app.hours) { nelze("okno"); continue; }
    if (kw + Math.min(...zaklad) > limit + 1e-9) { nelze("prikon", { limit }); continue; }

    // proč hodina nejde použít (null = jde)
    const prekazka = (h) => {
      for (const id of bezi[h]) {
        const o = podleId.get(id);
        if (o && vKonfliktu(app, o)) return { soubeh: o.name };
      }
      if (zatizeni[h] + kw > limit + 1e-9) return { limit: true };
      return null;
    };
    const cenaHodiny = (h, pvZbyva) => {
      const zPv = Math.min(pvZbyva[h], naHodinu);
      return zPv * feedIn + (naHodinu - zPv) * price[h];
    };

    const vyber = (sOmezenim) => {
      if (app.contiguous) {
        let best = null;
        for (let s = from; s + app.hours <= to; s++) {
          const hodiny = Array.from({ length: app.hours }, (_, i) => s + i);
          if (sOmezenim && hodiny.some((h) => prekazka(h))) continue;
          const tmp = [...remaining];
          let cost = 0;
          for (const h of hodiny) { cost += cenaHodiny(h, tmp); tmp[h] -= Math.min(tmp[h], naHodinu); }
          if (!best || cost < best.cost - 1e-12) best = { cost, hours: hodiny };
        }
        return best;
      }
      const kand = [];
      for (let h = from; h < to; h++) {
        if (sOmezenim && prekazka(h)) continue;
        kand.push({ h, c: cenaHodiny(h, remaining) });
      }
      if (kand.length < app.hours) return null;
      kand.sort((a, b) => a.c - b.c || a.h - b.h);
      const vybrane = kand.slice(0, app.hours);
      return { cost: vybrane.reduce((s, x) => s + x.c, 0), hours: vybrane.map((x) => x.h).sort((a, b) => a - b) };
    };

    const idealni = vyber(false);
    const chosen = vyber(true);

    // co brání ideálnímu plánu
    const duvody = () => {
      const soubeh = new Set();
      let lim = false;
      for (const h of idealni?.hours ?? []) {
        const pr = prekazka(h);
        if (pr?.soubeh) soubeh.add(pr.soubeh);
        if (pr?.limit) lim = true;
      }
      return { soubeh: [...soubeh], limit: lim };
    };

    if (!chosen) { nelze("omezeni", { omezeni: duvody() }); continue; }

    const posunuto = chosen.cost > (idealni?.cost ?? chosen.cost) + 0.005 ? duvody() : null;

    let pvUsed = 0;
    const pvPoHodinach = {};
    for (const h of chosen.hours) {
      const zPv = Math.min(remaining[h], naHodinu);
      remaining[h] -= zPv;
      pvUsed += zPv;
      pvPoHodinach[h] = zPv;
      zatizeni[h] += kw;
      bezi[h].add(app.id);
    }
    plan.push({ ...app, kw, naHodinu, hours: chosen.hours, cost: chosen.cost, pvUsed, pvPoHodinach,
      savingVsAvg: Math.max(0, avg * app.kwh - chosen.cost),
      posunuto, priplatek: posunuto ? chosen.cost - idealni.cost : 0 });
  }

  return { plan, avg, minH: price.indexOf(Math.min(...price)), maxH: price.indexOf(Math.max(...price)),
    surplus, unusedPv: remaining.reduce((a, b) => a + b, 0),
    zatizeni, spicka: Math.max(...zatizeni), limit: Number.isFinite(limit) ? limit : null };
}


// ═══ Co má uživatel udělat teď ═════════════════════════════════
/** Pro jeden spotřebič zjistí, jestli ho zapnout teď, později, nebo už ne. */
export function actionFor(p, nowH, nowM, isToday) {
  if (p.infeasible || !p.hours?.length) return { kind: "none" };
  if (!isToday) return { kind: "tomorrow", at: p.hours[0] };
  if (p.hours.includes(nowH)) {
    let end = nowH;
    while (p.hours.includes(end + 1)) end++;
    return { kind: "now", until: end + 1 };
  }
  const next = p.hours.find((h) => h > nowH);
  if (next != null) return { kind: "later", at: next, mins: (next - nowH) * 60 - nowM };
  return { kind: "done" };
}

export const odpocet = (min) => {
  if (min < 60) return `za ${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `za ${h} h ${m} min` : `za ${h} h`;
};

/** Porovná dnešní rozptyl cen s obvyklým. Tady je skutečná hodnota aplikace. */
export function dayCharacter(prices, historyDays) {
  const p = prices.map((x) => x.price);
  const today = Math.max(...p) / Math.max(0.01, Math.min(...p));
  const spreads = historyDays.map((d) => d.spread).filter(Number.isFinite).sort((a, b) => a - b);
  if (spreads.length < 5) return { kind: "unknown", today };
  const median = spreads[Math.floor(spreads.length / 2)];
  if (today > median * 1.4) return { kind: "big", today, median };
  if (today < median * 0.65) return { kind: "flat", today, median };
  return { kind: "normal", today, median };
}

/** Kalendář s připomínkou 5 minut předem. Plovoucí čas = místní čas telefonu. */
export function buildIcs(plan, dateIso) {
  const d = dateIso.replaceAll("-", "");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const ev = [];
  for (const p of plan) {
    if (p.infeasible || !p.hours?.length) continue;
    let start = p.hours[0], prev = p.hours[0];
    const bloky = [];
    for (let i = 1; i <= p.hours.length; i++) {
      if (p.hours[i] === prev + 1) { prev = p.hours[i]; continue; }
      bloky.push([start, prev + 1]);
      start = p.hours[i]; prev = p.hours[i];
    }
    bloky.forEach(([a, b], i) => {
      const t = (h) => `${d}T${String(Math.min(h, 23)).padStart(2, "0")}${h === 24 ? "5900" : "0000"}`;
      ev.push([
        "BEGIN:VEVENT",
        `UID:${p.id}-${d}-${i}@kdy-zapnout`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${t(a)}`,
        `DTEND:${t(b)}`,
        `SUMMARY:Zapnout: ${p.name}`,
        "BEGIN:VALARM", "TRIGGER:-PT5M", "ACTION:DISPLAY",
        `DESCRIPTION:Zapnout: ${p.name}`, "END:VALARM",
        "END:VEVENT",
      ].join("\r\n"));
    });
  }
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Kdy zapnout//CS", ...ev, "END:VCALENDAR"].join("\r\n");
}


export const isoDay = (offset = 0) => {
  const d = new Date(Date.now() + offset * 864e5);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};


/**
 * Nejlevnější souvislé okno v příštích 24 hodinách, klidně přes půlnoc.
 * Hodí se hlavně na nabíjení auta: řekne, jestli počkat na zítřek.
 */
export function cheapestWindow(today, tomorrow, nowH, len = 3) {
  const seq = [];
  for (let h = nowH; h < 24; h++) seq.push({ day: 0, h, price: today[h]?.price });
  if (tomorrow) for (let h = 0; h < 24 && seq.length < 24; h++) seq.push({ day: 1, h, price: tomorrow[h]?.price });
  const ok = seq.filter((x) => Number.isFinite(x.price));
  if (ok.length < len) return null;
  let best = null;
  for (let i = 0; i + len <= ok.length; i++) {
    const w = ok.slice(i, i + len);
    // okno musí být opravdu souvislé v čase
    const souvisle = w.every((x, k) => k === 0 || (x.day * 24 + x.h) === (w[k - 1].day * 24 + w[k - 1].h + 1));
    if (!souvisle) continue;
    const avg = w.reduce((a, x) => a + x.price, 0) / len;
    if (!best || avg < best.avg) best = { start: w[0], end: w[len - 1], avg };
  }
  return best;
}

export const denSlovo = (d) => (d === 0 ? "dnes" : "zítra");
export function oknoPopis(w) {
  const od = `${denSlovo(w.start.day)} ${pad(w.start.h)}`;
  const doH = (w.end.h + 1) % 24;
  const doDen = w.end.h === 23 ? w.end.day + 1 : w.end.day;
  const stejnyDen = doDen === w.start.day;
  return stejnyDen ? `${od}–${pad(doH)}` : `${od} až ${denSlovo(Math.min(doDen, 1))} ${pad(doH)}`;
}

/** Barevný stupeň ceny v rámci dne: 0 = nejlevnější, 4 = nejdražší. */
export function tier(v, min, max) {
  if (max - min < 0.01) return 2;
  const t = (v - min) / (max - min);
  return t < 0.2 ? 0 : t < 0.4 ? 1 : t < 0.6 ? 2 : t < 0.8 ? 3 : 4;
}


export function hoursLabel(hours) {
  if (!hours?.length) return "";
  const out = [];
  let start = hours[0], prev = hours[0];
  for (let i = 1; i <= hours.length; i++) {
    if (hours[i] === prev + 1) { prev = hours[i]; continue; }
    out.push(`${pad(start)}–${pad(prev + 1)}`);
    start = hours[i]; prev = hours[i];
  }
  return out.join(", ");
}
export const pad = (h) => `${String(h).padStart(2, "0")}:00`;
export const dni = (n) => `${n} ${n === 1 ? "den" : n >= 2 && n <= 4 ? "dny" : "dní"}`;
export const czDate = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${Number(d)}. ${Number(m)}.`;
};


// ═══ Úspora ze skutečných cen ══════════════════════════════════
/**
 * Pro každý uplynulý den spočítá, kolik by spotřebiče stály:
 *   (a) spuštěné v nejlevnějších hodinách podle plánu
 *   (b) spuštěné kdykoli, tedy za průměrnou cenu toho dne
 * Rozdíl je úspora, kterou přináší plánování. Ceny jsou skutečné
 * z OTE, chování je modelované — to musí UI říkat nahlas.
 *
 * @param {Array<{date, eurCzk, eur:number[], pv?:number[]}>} days
 */
export function backtest(days, cfg, appliances) {
  const vysledky = [];
  for (const d of days) {
    if (!Array.isArray(d.eur) || d.eur.length < 23 || !d.eurCzk) continue;
    const prices = toFinalPrices(d.eur, { ...cfg, eurCzk: d.eurCzk });
    const pv = (d.pv ?? []).map((v) => (v ?? 0) * (cfg.kwp ?? 0));
    const res = optimize({
      prices, pv, baseLoad: new Array(prices.length).fill(cfg.baseLoadPerHour ?? 0.3),
      feedIn: cfg.feedIn ?? 0, appliances, maxKw: cfg.maxKw ?? null,
    });
    const active = res.plan.filter((p) => !p.infeasible);
    const optimized = active.reduce((s, p) => s + p.cost, 0);
    const kwh = active.reduce((s, p) => s + p.kwh, 0);
    const vals = prices.map((p) => p.price);
    vysledky.push({
      date: d.date,
      kwh,
      optimized,
      atAverage: res.avg * kwh,
      savedVsAverage: Math.max(0, res.avg * kwh - optimized),
      spread: Math.max(...vals) / Math.max(0.01, Math.min(...vals)),
    });
  }
  const sum = (k) => vysledky.reduce((s, x) => s + x[k], 0);
  const n = vysledky.length;
  return {
    days: vysledky,
    dayCount: n,
    from: vysledky[0]?.date ?? null,
    to: vysledky[n - 1]?.date ?? null,
    savedVsAverage: sum("savedVsAverage"),
    totalOptimized: sum("optimized"),
    totalAtAverage: sum("atAverage"),
    perDay: n ? sum("savedVsAverage") / n : 0,
    perMonth: n ? (sum("savedVsAverage") / n) * 30 : 0,
    projectedYear: n ? (sum("savedVsAverage") / n) * 365 : 0,
    reliable: n >= 14,
  };
}

// ═══ Předvolby domácností ══════════════════════════════════════
// Spotřeba a příkon jsou typické odhady, ne údaj dodavatele — ten nic
// takového neposkytuje, liší se podle konkrétního spotřebiče. Příkon
// (kw) je to, co spotřebič odebírá, když topí nebo nabíjí; podle něj
// se hlídá limit, aby nepadaly pojistky. V UI se dá všechno upravit.
export const SABLONY = {
  bojler: { name: "Bojler", kwh: 6, hours: 3, kw: 2.0, contiguous: false, earliest: 0, latest: 24, priority: 10 },
  auto: { name: "Nabíjení auta", kwh: 11, hours: 3, kw: 3.7, contiguous: false, earliest: 0, latest: 24, priority: 20 },
  pracka: { name: "Pračka", kwh: 1.2, hours: 2, kw: 2.0, contiguous: true, earliest: 6, latest: 22, priority: 30 },
  mycka: { name: "Myčka", kwh: 1.0, hours: 2, kw: 2.0, contiguous: true, earliest: 0, latest: 24, priority: 40 },
  susicka: { name: "Sušička prádla", kwh: 2.5, hours: 2, kw: 2.5, contiguous: true, earliest: 6, latest: 22, priority: 35 },
  tc: { name: "Tepelné čerpadlo", kwh: 9, hours: 6, kw: 2.5, contiguous: false, earliest: 0, latest: 24, priority: 5 },
  bazen: { name: "Filtrace bazénu", kwh: 3, hours: 4, kw: 0.8, contiguous: false, earliest: 0, latest: 24, priority: 60 },
  vlastni: { name: "Nový spotřebič", kwh: 2, hours: 2, kw: 2.0, contiguous: false, earliest: 0, latest: 24, priority: 50 },
};

const ze = (id) => ({ id, ...SABLONY[id], conflicts: [], enabled: true });

export const PROFILY = {
  byt: { nazev: "Byt", popis: "pračka a myčka", appliances: [ze("pracka"), ze("mycka")] },
  bojler: { nazev: "Dům s bojlerem", popis: "bojler, pračka, myčka", appliances: [ze("bojler"), ze("pracka"), ze("mycka")] },
  auto: { nazev: "S elektromobilem", popis: "auto, bojler, pračka", appliances: [ze("auto"), ze("bojler"), ze("pracka")] },
  tc: { nazev: "Tepelné čerpadlo", popis: "čerpadlo, pračka, myčka", appliances: [ze("tc"), ze("pracka"), ze("mycka")] },
};

/** Nový spotřebič ze šablony, s jedinečným id. */
export function novySpotrebic(sablona, existujici = []) {
  const zaklad = SABLONY[sablona] ?? SABLONY.vlastni;
  let id = sablona, i = 2;
  while (existujici.some((a) => a.id === id)) id = `${sablona}${i++}`;
  return { id, ...zaklad, conflicts: [], enabled: true };
}

/**
 * Doplní příkon a seznam konfliktů u spotřebičů uložených ve starší
 * verzi stránky, aby limit příkonu nepočítal s nesmyslnou hodnotou.
 */
export function doplnSpotrebice(seznam) {
  const zakladniId = (id) => Object.keys(SABLONY).find((k) => id === k || id.startsWith(k));
  return seznam.map((a) => ({
    ...a,
    kw: Number.isFinite(a.kw) && a.kw > 0 ? a.kw : (SABLONY[zakladniId(a.id)]?.kw ?? a.kwh / a.hours),
    conflicts: Array.isArray(a.conflicts) ? a.conflicts.filter((c) => seznam.some((x) => x.id === c)) : [],
  }));
}

/** Nastaví nebo zruší zákaz souběhu, vždy na obou stranách. */
export function prepniKonflikt(seznam, idA, idB) {
  const maji = seznam.find((a) => a.id === idA)?.conflicts?.includes(idB)
    || seznam.find((a) => a.id === idB)?.conflicts?.includes(idA);
  return seznam.map((a) => {
    const c = new Set(a.conflicts ?? []);
    if (a.id === idA) maji ? c.delete(idB) : c.add(idB);
    if (a.id === idB) maji ? c.delete(idA) : c.add(idA);
    return { ...a, conflicts: [...c] };
  });
}

/** Odebere spotřebič a vyčistí po něm odkazy v konfliktech ostatních. */
export function odeberSpotrebic(seznam, id) {
  return seznam.filter((a) => a.id !== id).map((a) => ({ ...a, conflicts: (a.conflicts ?? []).filter((c) => c !== id) }));
}

export const VYCHOZI_PROFIL = "bojler";

// ═══ Kalendář k odběru (premium) ═══════════════════════════════
// Soubor, který si uživatel jednou přidá do kalendáře v telefonu.
// GitHub ho každý den přegeneruje a kalendář si ho sám stáhne.

const icsEsc = (s) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

/** Řádky ICS nesmí mít víc než 75 bajtů, delší se zalamují. */
function icsFold(radek) {
  const enc = new TextEncoder();
  if (enc.encode(radek).length <= 75) return radek;
  const out = [];
  let kus = "", limit = 75;
  for (const ch of radek) {
    if (enc.encode(kus + ch).length > limit) { out.push(kus); kus = ""; limit = 74; }
    kus += ch;
  }
  if (kus) out.push(kus);
  return out.join("\r\n ");
}

function bloky(hodiny) {
  if (!hodiny?.length) return [];
  const out = [];
  let a = hodiny[0], p = hodiny[0];
  for (let i = 1; i <= hodiny.length; i++) {
    if (hodiny[i] === p + 1) { p = hodiny[i]; continue; }
    out.push([a, p + 1]);
    a = hodiny[i]; p = hodiny[i];
  }
  return out;
}

/**
 * @param {object} o
 * @param {string} o.nazev          název kalendáře
 * @param {Array<{date, prices}>} o.dny   dny k zahrnutí (dnes, zítra)
 * @param {Array} o.appliances
 * @param {Array<{spread}>} o.historie    pro rozpoznání výjimečného dne
 * @param {object} o.cfg
 */
export function buildFeedIcs({ nazev, dny, appliances, historie = [], cfg, ted = new Date() }) {
  const stamp = ted.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const radky = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Kdy zapnout//CS", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEsc(`Kdy zapnout: ${nazev}`)}`,
    "X-WR-TIMEZONE:Europe/Prague",
    "X-WR-CALDESC:Kdy zapnout spotřebiče podle spotové ceny elektřiny. Aktualizuje se samo.",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H",
  ];

  for (const { date, prices } of dny) {
    if (!prices?.length) continue;
    const d = date.replaceAll("-", "");
    const res = optimize({
      prices, pv: new Array(prices.length).fill(0),
      baseLoad: new Array(prices.length).fill(cfg.baseLoadPerHour ?? 0.3),
      feedIn: cfg.feedIn ?? 0, appliances,
    });
    const t = (h) => `${d}T${String(Math.min(h, 23)).padStart(2, "0")}${h >= 24 ? "5900" : "0000"}`;

    for (const p of res.plan) {
      if (p.infeasible) continue;
      bloky(p.hours).forEach(([a, b], i) => {
        const cena = prices.slice(a, b).reduce((s, x) => s + x.price, 0) / (b - a);
        radky.push(
          "BEGIN:VEVENT",
          // stálé UID: kalendář při aktualizaci událost přepíše, nezdvojí
          `UID:${p.id}-${d}-${i}@kdy-zapnout`,
          `DTSTAMP:${stamp}`,
          `DTSTART:${t(a)}`,
          `DTEND:${t(b)}`,
          `SUMMARY:${icsEsc(`Zapnout: ${p.name}`)}`,
          `DESCRIPTION:${icsEsc(`Levné hodiny, průměrně ${cena.toFixed(2).replace(".", ",")} Kč za kWh.`)}`,
          "TRANSP:TRANSPARENT",
          "BEGIN:VALARM", "TRIGGER:-PT5M", "ACTION:DISPLAY",
          `DESCRIPTION:${icsEsc(`Zapnout: ${p.name}`)}`, "END:VALARM",
          "END:VEVENT",
        );
      });
    }

    const charakter = dayCharacter(prices, historie);
    if (charakter.kind === "big") {
      radky.push(
        "BEGIN:VEVENT",
        `UID:vyjimka-${d}@kdy-zapnout`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${d}`,
        `SUMMARY:${icsEsc(`Výjimečně rozkolísaná cena elektřiny, rozdíl ${charakter.today.toFixed(1).replace(".", ",")}×`)}`,
        `DESCRIPTION:${icsEsc(`Obvykle bývá rozdíl ${charakter.median.toFixed(1).replace(".", ",")}×. Dnes se vyplatí plán dodržet víc než jindy.`)}`,
        "TRANSP:TRANSPARENT",
        "END:VEVENT",
      );
    }
  }
  radky.push("END:VCALENDAR");
  return radky.map(icsFold).join("\r\n") + "\r\n";
}

// ═══ Historie a měsíční přehled (premium) ══════════════════════
/** Seskupí dny z backtestu po měsících. */
export function mesicniPrehled(btDny, cenyDnu) {
  const mesice = new Map();
  for (const d of btDny) {
    const m = d.date.slice(0, 7);
    if (!mesice.has(m)) mesice.set(m, { mesic: m, dnu: 0, usetreno: 0, prumerCen: 0, _soucet: 0 });
    const x = mesice.get(m);
    x.dnu++;
    x.usetreno += d.savedVsAverage;
    const cena = cenyDnu?.[d.date];
    if (Number.isFinite(cena)) { x._soucet += cena; x.prumerCen = x._soucet / x.dnu; }
  }
  return [...mesice.values()].map(({ _soucet, ...x }) => x).sort((a, b) => a.mesic.localeCompare(b.mesic));
}

// ═══ Export (premium) ══════════════════════════════════════════
const csvEsc = (v) => {
  const s = String(v ?? "");
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const cz = (n, d = 4) => (Number.isFinite(n) ? n.toFixed(d).replace(".", ",") : "");

/** CSV se středníkem a desetinnou čárkou, aby ho český Excel otevřel správně. */
export function csvHodiny(dny) {
  const radky = [["datum", "hodina", "spot EUR/MWh", "cena Kč/kWh vč. DPH", "tarif"]];
  for (const { date, prices } of dny) {
    for (const p of prices) radky.push([date, `${String(p.hour).padStart(2, "0")}:00`, cz(p.eurMwh, 2), cz(p.price), p.tariff]);
  }
  return "\uFEFF" + radky.map((r) => r.map(csvEsc).join(";")).join("\r\n");
}

export function csvDny(btDny) {
  const radky = [["datum", "kWh", "podle plánu Kč", "kdykoli Kč", "ušetřeno Kč", "rozdíl cen ×"]];
  for (const d of btDny) radky.push([d.date, cz(d.kwh, 1), cz(d.optimized, 2), cz(d.atAverage, 2), cz(d.savedVsAverage, 2), cz(d.spread, 2)]);
  return "\uFEFF" + radky.map((r) => r.map(csvEsc).join(";")).join("\r\n");
}
