// ───────────────────────────────────────────────────────────────
// telegram.mjs — denní plán do telegramového kanálu (nepovinné)
//
// Zapne se jen tehdy, když jsou na GitHubu nastavená tajemství
// TELEGRAM_TOKEN a TELEGRAM_CHAT (viz NAVOD.md, část C.5).
// Posílá se jednou denně, když se poprvé stáhnou zítřejší ceny.
// ───────────────────────────────────────────────────────────────

const DNY = ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'];
const kc = (n) => n.toFixed(2).replace('.', ',');

/** Nejlevnější souvislé okno daného počtu hodin v rámci jednoho dne. */
export function nejlevnejsiOkno(prices, delka = 3) {
  let best = null;
  for (let s = 0; s + delka <= prices.length; s++) {
    const prum = prices.slice(s, s + delka).reduce((a, p) => a + p.price, 0) / delka;
    if (!best || prum < best.prum) best = { od: s, do: s + delka, prum };
  }
  return best;
}

const cas = (h) => `${h}:00`;

/**
 * @param {string} datum            YYYY-MM-DD
 * @param {Array<{price}>} prices   finální ceny dne
 * @param {{kind, today, median}} charakter  z dayCharacter
 * @param {string} odkaz            adresa webu
 */
export function zpravaNaDen(datum, prices, charakter, odkaz) {
  const [y, m, d] = datum.split('-').map(Number);
  const den = DNY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const okno = nejlevnejsiOkno(prices, 3);
  const ceny = prices.map((p) => p.price);
  const maxH = ceny.indexOf(Math.max(...ceny));
  const radky = [
    `⚡ Zítra, ${den} ${d}. ${m}.`,
    '',
    `Nejlevněji ${cas(okno.od)}–${cas(okno.do)}, v průměru ${kc(okno.prum)} Kč/kWh.`,
    `Nejdráž v ${cas(maxH)}, ${kc(ceny[maxH])} Kč/kWh.`,
  ];
  if (charakter?.kind === 'big') {
    radky.push('', `Výjimečně rozkolísaný den: rozdíl ${charakter.today.toFixed(1).replace('.', ',')}×, obvykle ${charakter.median.toFixed(1).replace('.', ',')}×. Plán se vyplatí dodržet víc než jindy.`);
  } else if (charakter?.kind === 'flat') {
    radky.push('', 'Ceny jsou vyrovnané, na přesunu spotřebičů tolik nezáleží.');
  }
  radky.push('', 'Ceny včetně distribuce ČEZ (sazba D02d) a DPH.');
  if (odkaz) radky.push(`Plán pro tvoje spotřebiče: ${odkaz}`);
  return radky.join('\n');
}

export async function posliZpravu(text, { token, chat, fetchFn = fetch } = {}) {
  if (!token || !chat) return { odeslano: false, duvod: 'není nastaveno' };
  const r = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: false }),
  });
  let j = {};
  try { j = await r.json(); } catch { /* nevadí */ }
  if (!r.ok || j.ok === false) throw new Error(`Telegram odmítl zprávu: ${j.description ?? r.status}`);
  return { odeslano: true };
}
