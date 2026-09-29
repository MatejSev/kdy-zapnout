// ───────────────────────────────────────────────────────────────
// premium.js — které funkce jsou premium a kdo k nim má přístup
//
// Celá aplikace se ptá jen přes jePremium(). Až přejdeš na placenou
// verzi, změníš logiku tady na jednom místě (ověření licence proti
// serveru) a zbytek aplikace zůstane, jak je.
// ───────────────────────────────────────────────────────────────

import { PREMIUM_REZIM } from "./nastaveni.js";

export const FUNKCE = [
  // zdarma
  { id: "plan", nazev: "Plán na dnešek a zítřek", popis: "Kdy co zapnout, odpočet, nejlevnější okno", premium: false },
  { id: "mapa", nazev: "Ceny po hodinách", popis: "Barevná mapa a průběh dne", premium: false },
  { id: "uspory", nazev: "Kolik ušetříš", popis: "Úspora podle typu domácnosti ze skutečných cen", premium: false },
  { id: "ics", nazev: "Plán do kalendáře", popis: "Jednorázové stažení dnešního plánu", premium: false },
  { id: "tarif", nazev: "Vlastní tarif a spotřebiče", popis: "Distributor, sazba, dodavatel, panely", premium: false },
  // premium
  { id: "odber", nazev: "Připomínky samy v telefonu", popis: "Kalendář, který se každý den sám aktualizuje", premium: true },
  { id: "vyjimka", nazev: "Upozornění na výjimečný den", popis: "Když je rozdíl cen nezvykle velký, přijde celodenní upozornění", premium: true },
  { id: "historie", nazev: "Historie a měsíční přehled", popis: "Úspory po měsících a vývoj cen", premium: true },
  { id: "export", nazev: "Export dat", popis: "Ceny po hodinách a denní přehled jako tabulka", premium: true },
];

/** Hlavní otázka celé aplikace: smí uživatel použít premium funkci? */
export function jePremium() {
  if (PREMIUM_REZIM === "zdarma") return true;
  // Režim "placene": sem později přijde ověření licence proti serveru.
  // Na statickém webu bez serveru to bezpečně udělat nejde, proto
  // se tu zatím nic neodemyká.
  return false;
}

export const jeZdarmaRezim = () => PREMIUM_REZIM === "zdarma";

export const premiumFunkce = () => FUNKCE.filter((f) => f.premium);
export const zdarmaFunkce = () => FUNKCE.filter((f) => !f.premium);
