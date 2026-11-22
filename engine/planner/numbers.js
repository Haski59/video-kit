/**
 * engine/planner/numbers.js — numbers, money and units, spoken and written. Pure.
 *
 * Used three ways:
 *   1. captions never split a number from its unit ("£10K", "30 percent", "ten grand");
 *   2. number/money/percent words are the first choice for caption emphasis;
 *   3. the validator checks that a callout is DERIVED from what was said: "£10K/MO" must match
 *      "ten grand a month", "4 CLIENTS" must match "four clients", "STEP 1" must match "first".
 *      Without normalisation every honest callout would fail that check.
 */

const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES = { hundred: 100, thousand: 1e3, grand: 1e3, k: 1e3, million: 1e6, mil: 1e6, m: 1e6, billion: 1e9, bn: 1e9 };
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
export const CURRENCY_WORDS = { pound: "£", pounds: "£", quid: "£", dollar: "$", dollars: "$", bucks: "$", euro: "€", euros: "€" };
const PER_MONTH = [["a", "month"], ["per", "month"], ["a", "mo"], ["per", "mo"], ["monthly"], ["every", "month"]];
const PERCENT = ["percent", "per cent", "%"];

const clean = (w) => String(w ?? "").toLowerCase().replace(/[^\p{L}\p{N}£$€%.,'/-]/gu, "").replace(/[.,]+$/, "");

/** Does this single displayed token carry a number (digits or a number word)? */
export function isNumberish(text) {
  const t = clean(text);
  if (!t) return false;
  if (/\d/.test(t)) return true;
  return t in UNITS || t in TENS || t === "hundred" || t === "thousand" || t === "million" || t === "billion" || t === "grand";
}

/** Should a caption line break be forbidden between `a` and `b`? (number|currency → unit). */
export function bindsToNext(a, b) {
  const x = clean(a), y = clean(b);
  if (!x || !y) return false;
  if (/^[£$€]$/.test(x)) return true;
  if (isNumberish(x) && (y in SCALES || y in CURRENCY_WORDS || PERCENT.includes(y) || y === "per" || /^(k|%|x)$/.test(y))) return true;
  // Compound numbers only: "twenty five", "two hundred", "ten thousand" — never "two three".
  if (x in TENS && y in UNITS) return true;
  if ((x in UNITS || x in TENS) && (y in SCALES || y === "hundred")) return true;
  return false;
}

/**
 * Parse tokens into canonical facts: numbers (with currency, scale, per-month, percent) and
 * ordinals. "ten grand a month" → [{value:10000, currency:null, perMonth:true}].
 * "£10,000/mo" → [{value:10000, currency:"£", perMonth:true}].
 */
export function extractFacts(tokens) {
  const ts = tokens.flatMap((t) => String(t).split(/\s+|(?<=\d)(?=[a-z%])|\//i)).map(clean).filter(Boolean);
  const facts = [];
  for (let i = 0; i < ts.length; i++) {
    let t = ts[i];
    if (t in ORDINALS) { facts.push({ ordinal: ORDINALS[t] }); continue; }
    let currency = null;
    const cm = t.match(/^([£$€])(.*)$/);
    if (cm) { currency = cm[1]; t = cm[2]; if (!t && i + 1 < ts.length) t = ts[++i]; }
    let value = null, j = i;
    const num = t.replace(/,/g, "").match(/^(\d+(?:\.\d+)?)(k|m|bn)?$/);
    if (num) {
      value = Number(num[1]) * (num[2] ? SCALES[num[2]] : 1);
    } else if (t in UNITS || t in TENS) {
      value = UNITS[t] ?? TENS[t];
      if (t in TENS && ts[j + 1] in UNITS) { value += UNITS[ts[j + 1]]; j++; }
    } else continue;
    while (ts[j + 1] in SCALES) { value *= SCALES[ts[j + 1]]; j++; }
    if (ts[j + 1] in CURRENCY_WORDS) { currency = currency ?? CURRENCY_WORDS[ts[j + 1]]; j++; }
    let percent = false, perMonth = false;
    if (ts[j + 1] === "%" || ts[j + 1] === "percent") { percent = true; j++; }
    else if (ts[j + 1] === "per" && ts[j + 2] === "cent") { percent = true; j += 2; }
    for (const pm of PER_MONTH) {
      if (pm.every((w, k) => ts[j + 1 + k] === w)) { perMonth = true; j += pm.length; break; }
    }
    if (ts[j + 1] === "mo" || ts[j + 1] === "month") { perMonth = true; j++; }
    facts.push({ value, currency, percent, perMonth });
    i = j;
  }
  return facts;
}

const sameFact = (a, b) => {
  if (a.ordinal || b.ordinal) {
    const av = a.ordinal ?? a.value, bv = b.ordinal ?? b.value;
    return av === bv;
  }
  if (a.value !== b.value) return false;
  if (a.currency && b.currency && a.currency !== b.currency) return false;
  if (a.percent !== b.percent) return false;
  // Display may drop "/MO" but must not ADD a per-month claim that was never said.
  if (b.perMonth && !a.perMonth) return false;
  return true;
};

/** Every fact in the callout must be supported by a fact in the spoken window. */
export function factsSupported(calloutTokens, spokenTokens) {
  const shown = extractFacts(calloutTokens);
  const said = extractFacts(spokenTokens);
  const unsupported = shown.filter((f) => !said.some((s) => sameFact(s, f)));
  return { ok: unsupported.length === 0, shown, said, unsupported };
}

/** Compact display for a fact: £10K/MO, 30%, 4. */
export function formatFact(f) {
  if (f.ordinal) return String(f.ordinal);
  let v = f.value;
  let s;
  if (v >= 1e6 && v % 1e5 === 0) s = `${v / 1e6}M`;
  else if (v >= 1e3 && v % 100 === 0) s = `${v / 1e3}K`;
  else s = String(v);
  return `${f.currency ?? ""}${s}${f.percent ? "%" : ""}${f.perMonth ? "/MO" : ""}`;
}
