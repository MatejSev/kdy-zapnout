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

export function optimize({ prices, pv, baseLoad, feedIn, appliances }) {
  const price = prices.map((p) => p.price);
  const H = price.length;
  const surplus = Array.from({ length: H }, (_, h) => Math.max(0, (pv[h] ?? 0) - (baseLoad[h] ?? 0)));
  const remaining = [...surplus];
  const avg = price.reduce((a, b) => a + b, 0) / H;
  const queue = appliances.filter((a) => a.enabled).sort((a, b) => a.priority - b.priority);
  const plan = [];

  for (const app of queue) {
    const perHour = app.kwh / app.hours;
    const from = app.earliest ?? 0;
    const to = app.latest ?? H;
    if (to - from < app.hours) {
      plan.push({ ...app, infeasible: true, hours: [], cost: 0, pvUsed: 0, savingVsAvg: 0 });
      continue;
    }
    let chosen;
    if (app.contiguous) {
      let best = null;
      for (let s = from; s + app.hours <= to; s++) {
        const tmp = [...remaining];
        let cost = 0;
        for (let k = 0; k < app.hours; k++) {
          const h = s + k;
          const fromPv = Math.min(tmp[h], perHour);
          cost += fromPv * feedIn + (perHour - fromPv) * price[h];
          tmp[h] -= fromPv;
        }
        if (!best || cost < best.cost) best = { cost, hours: Array.from({ length: app.hours }, (_, i) => s + i) };
      }
      chosen = best;
    } else {
      const cand = [];
      for (let h = from; h < to; h++) {
        const fromPv = Math.min(remaining[h], perHour);
        cand.push({ h, c: fromPv * feedIn + (perHour - fromPv) * price[h] });
      }
      cand.sort((a, b) => a.c - b.c || a.h - b.h);
      const picked = cand.slice(0, app.hours);
      chosen = { cost: picked.reduce((s, p) => s + p.c, 0), hours: picked.map((p) => p.h).sort((a, b) => a - b) };
    }
    let pvUsed = 0;
    for (const h of chosen.hours) {
      const fromPv = Math.min(remaining[h], perHour);
      remaining[h] -= fromPv;
      pvUsed += fromPv;
    }
    plan.push({ ...app, hours: chosen.hours, cost: chosen.cost, pvUsed,
      savingVsAvg: Math.max(0, avg * app.kwh - chosen.cost) });
  }
  return { plan, avg, minH: price.indexOf(Math.min(...price)), maxH: price.indexOf(Math.max(...price)),
    surplus, unusedPv: remaining.reduce((a, b) => a + b, 0) };
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
      feedIn: cfg.feedIn ?? 0, appliances,
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
// Spotřeba je typický odhad, ne údaj dodavatele — ten nic takového
// neposkytuje, liší se podle konkrétního spotřebiče. V UI se dá upravit.
const S = {
  pracka: { id: "pracka", name: "Pračka", kwh: 1.2, hours: 2, contiguous: true, earliest: 6, latest: 22, priority: 30, enabled: true },
  mycka: { id: "mycka", name: "Myčka", kwh: 1.0, hours: 2, contiguous: true, earliest: 0, latest: 24, priority: 40, enabled: true },
  bojler: { id: "bojler", name: "Bojler", kwh: 6, hours: 3, contiguous: false, earliest: 0, latest: 24, priority: 10, enabled: true },
  auto: { id: "auto", name: "Nabíjení auta", kwh: 11, hours: 4, contiguous: false, earliest: 0, latest: 24, priority: 20, enabled: true },
  tc: { id: "tc", name: "Tepelné čerpadlo", kwh: 9, hours: 6, contiguous: false, earliest: 0, latest: 24, priority: 5, enabled: true },
};

export const PROFILY = {
  byt: { nazev: "Byt", popis: "pračka a myčka", appliances: [S.pracka, S.mycka] },
  bojler: { nazev: "Dům s bojlerem", popis: "bojler, pračka, myčka", appliances: [S.bojler, S.pracka, S.mycka] },
  auto: { nazev: "S elektromobilem", popis: "auto, bojler, pračka", appliances: [S.auto, S.bojler, S.pracka] },
  tc: { nazev: "Tepelné čerpadlo", popis: "čerpadlo, pračka, myčka", appliances: [S.tc, S.pracka, S.mycka] },
};
export const VYCHOZI_PROFIL = "bojler";
