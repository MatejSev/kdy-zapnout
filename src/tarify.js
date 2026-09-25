// ───────────────────────────────────────────────────────────────
// tarify.js — ceny distribuce a regulovaných složek
//
// Platné od 1. 1. 2026 (ceníky distributorů, cenové výměry ERÚ).
// Mění se k 1. lednu. Po aktualizaci zvedni PRICES_YEAR — dokud to
// neuděláš, automatická kontrola ti po Novém roce pošle e-mail.
// ───────────────────────────────────────────────────────────────

export const PRICES_YEAR = 2026;
export const VAT = 0.21;

export const DISTRIBUTORS = {
  CEZ: { name: "ČEZ Distribuce", rates: {
    D01d: { label: "D01d, nízká spotřeba", vt: 2.7465 },
    D02d: { label: "D02d, běžná spotřeba", vt: 2.1663 },
    D25d: { label: "D25d, bojler", vt: 2.1663, nt: 0.2420, ntCount: 8 },
    D27d: { label: "D27d, elektromobil", vt: 2.1663, nt: 0.2420, ntCount: 8 },
    D57d: { label: "D57d, tepelné čerpadlo", vt: 0.4329, nt: 0.2420, ntCount: 20 },
  }},
  EGD: { name: "EG.D", rates: {
    D01d: { label: "D01d, nízká spotřeba", vt: 2.9043 },
    D02d: { label: "D02d, běžná spotřeba", vt: 2.3474 },
    D25d: { label: "D25d, bojler", vt: 2.3474, nt: 0.2237, ntCount: 8 },
    D27d: { label: "D27d, elektromobil", vt: 2.3474, nt: 0.2237, ntCount: 8 },
    D57d: { label: "D57d, tepelné čerpadlo", vt: 0.4297, nt: 0.2237, ntCount: 20 },
  }},
  PRE: { name: "PRE distribuce", rates: {
    D01d: { label: "D01d, nízká spotřeba", vt: 2.3044 },
    D02d: { label: "D02d, běžná spotřeba", vt: 1.8426 },
    D25d: { label: "D25d, bojler", vt: 1.8426, nt: 0.1839, ntCount: 8 },
    D27d: { label: "D27d, elektromobil", vt: 1.8426, nt: 0.1839, ntCount: 8 },
    D57d: { label: "D57d, tepelné čerpadlo", vt: 0.4297, nt: 0.1839, ntCount: 20 },
  }},
};

// Proměnné regulované složky v Kč/kWh bez DPH: systémové služby ČEPS
// a daň z elektřiny. POZE je od roku 2026 nula, hradí ho stát.
export const SYSTEM_FEES = 0.1987 + 0.0283;

// Fixní měsíční platba za činnost OTE. Do výběru hodiny nevstupuje,
// zaplatí se stejně, ať spotřebič poběží kdykoli.
export const OTE_MONTHLY = 4.96;

// Orientační časy nízkého tarifu. Skutečné určuje povelový kód HDO
// konkrétního odběrného místa, proto si je uživatel může nastavit.
export const DEFAULT_NT_HOURS = {
  8: [0, 1, 2, 3, 4, 5, 13, 14],
  20: [0, 1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14, 15, 16, 19, 20, 21, 22, 23],
};
