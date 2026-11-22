/**
 * engine/captions/group.js — KIT_CAPTION_V1 grouping. Pure.
 *
 * Short-form captions are read in a glance: 2–5 words, one line where possible, broken on meaning
 * (sentence end → pause → cut join → length), never across a jump cut, never between a number and
 * its unit. Emphasis is modest: at most one word per cue, numbers/money first, then a word the
 * planner marked. No per-word bounce, no rainbow.
 *
 * Input words are on the OUTPUT timeline (rebaseWords). Output cues:
 *   { start, end, words:[{text,start,end,emphasis}], lines:[[wordIndex,...], ...] }
 */
import { bindsToNext, isNumberish } from "../planner/numbers.js";

const round = (n, dp = 3) => Number(n.toFixed(dp));
const endsSentence = (t) => /[.!?]["')\]]?$/.test(String(t).trim());
const endsClause = (t) => /[,;:—–-]["')\]]?$/.test(String(t).trim());
const display = (words, upper) => words.map((w) => (upper ? w.text.toUpperCase() : w.text)).join(" ");

export const DEFAULT_CAPTION_STYLE = {
  minWords: 2, maxWords: 5, maxCharsPerLine: 22, maxLines: 2,
  breakOnGapSec: 0.35, maxCueSec: 2.6, minCueSec: 0.4, tailHoldSec: 0.15, maxEmphasisPerCue: 1, uppercase: false,
};

/**
 * @param words      rebased words (output timeline)
 * @param joins      output instants where cuts happened (a cue never spans one)
 * @param emphasis   Set of word keys `${start}` (output time, 3dp) the planner wants emphasised
 * @param durationSec output duration — the last cue is clamped to it
 */
/**
 * The transcriber sometimes stamps several words with the SAME start ("And when you" all at 115.57 s).
 * A cue made of such words would end where the next one starts — zero length — and be dropped, so a
 * spoken word would vanish from the captions. Spread each such run evenly across its real span.
 * Keeps `key` = the original start, which emphasis lookups use. Pure.
 */
export function spreadStackedWords(words) {
  const out = words.map((w) => ({ ...w, key: w.key ?? w.start }));
  for (let i = 0; i < out.length; ) {
    let j = i;
    while (j + 1 < out.length && Math.abs(out[j + 1].start - out[i].start) < 0.005) j++;
    if (j > i) {
      const s = out[i].start;
      const e = Math.max(out[j].end, ...out.slice(i, j + 1).map((w) => w.end), j + 1 < out.length ? Math.min(out[j + 1].start, s + 0.25 * (j - i + 1)) : s);
      const step = Math.max(0.02, (e - s) / (j - i + 1));
      for (let k = i; k <= j; k++) { out[k].start = round(s + (k - i) * step); out[k].end = round(Math.max(out[k].start + 0.02, k < j ? s + (k - i + 1) * step : out[k].end)); }
    }
    i = j + 1;
  }
  return out;
}

export function groupCaptions(rawWords, { style = {}, joins = [], emphasis = new Set(), durationSec = Infinity } = {}) {
  const o = { ...DEFAULT_CAPTION_STYLE, ...style };
  const words = spreadStackedWords(rawWords);
  const maxChars = o.maxCharsPerLine * o.maxLines;
  const crossesJoin = (a, b) => joins.some((t) => t > a.end - 1e-6 && t < b.start + 1e-6);
  const groups = [];
  let buf = [];
  const flush = () => { if (buf.length) groups.push(buf); buf = []; };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    buf.push(w);
    const next = words[i + 1];
    if (!next) { flush(); break; }
    // A cut join always breaks the cue; otherwise never split £ 10K / 10 percent / ten grand.
    if (!crossesJoin(w, next) && bindsToNext(w.text, next.text)) {
      if (buf.length < o.maxWords) continue;               // room for the bound partner
      if (buf.length > 1) { buf.pop(); flush(); buf.push(w); } // full: carry the pair into the next cue together
      continue;
    }
    const hardBreak = endsSentence(w.text) || crossesJoin(w, next) || next.start - w.end >= o.breakOnGapSec;
    const full = buf.length >= o.maxWords || display(buf.concat(next), o.uppercase).length > maxChars || next.end - buf[0].start > o.maxCueSec;
    const softBreak = endsClause(w.text) && buf.length >= o.minWords;
    if (hardBreak || full || softBreak) flush();
  }

  // Merge orphan single words into a neighbour when that stays within limits and crosses no join.
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].length >= o.minWords) continue;
    const fits = (g) => g.length <= o.maxWords && display(g, o.uppercase).length <= maxChars;
    const prev = groups[i - 1], next = groups[i + 1];
    const g = groups[i];
    if (prev && !endsSentence(prev[prev.length - 1].text) && !crossesJoin(prev[prev.length - 1], g[0]) && g[0].start - prev[prev.length - 1].end < o.breakOnGapSec && fits(prev.concat(g))) {
      groups.splice(i - 1, 2, prev.concat(g)); i -= 2; continue;
    }
    if (next && !endsSentence(g[g.length - 1].text) && !crossesJoin(g[g.length - 1], next[0]) && next[0].start - g[g.length - 1].end < o.breakOnGapSec && fits(g.concat(next))) {
      groups.splice(i, 2, g.concat(next)); i -= 1; continue;
    }
    // Neighbour is full: borrow one word instead ("a way to make more | money." → "a way to make | more money.").
    if (prev && prev.length > o.minWords && !endsSentence(prev[prev.length - 1].text) && !crossesJoin(prev[prev.length - 1], g[0])
      && !bindsToNext(prev[prev.length - 2].text, prev[prev.length - 1].text) && fits([prev[prev.length - 1], ...g])) {
      g.unshift(prev.pop()); continue;
    }
    if (next && next.length > o.minWords && !endsSentence(g[g.length - 1].text) && !crossesJoin(g[g.length - 1], next[0])
      && !bindsToNext(next[0].text, next[1].text) && fits([...g, next[0]])) {
      g.push(next.shift());
    }
  }

  const cues = groups.map((g) => {
    const cueWords = g.map((w) => ({ text: w.text, start: w.start, end: w.end, emphasis: false, key: w.key }));
    // Emphasis: numbers/money first, then planner picks. At most maxEmphasisPerCue.
    const ranked = [
      ...cueWords.map((w, k) => (isNumberish(w.text) ? k : -1)).filter((k) => k >= 0),
      ...cueWords.map((w, k) => (emphasis.has(w.key.toFixed(3)) ? k : -1)).filter((k) => k >= 0),
    ];
    for (const k of [...new Set(ranked)].slice(0, o.maxEmphasisPerCue)) cueWords[k].emphasis = true;
    // A number and its unit/currency emphasise together.
    for (let k = 0; k < cueWords.length - 1; k++) {
      if (cueWords[k].emphasis && bindsToNext(cueWords[k].text, cueWords[k + 1].text)) cueWords[k + 1].emphasis = true;
    }
    for (const w of cueWords) delete w.key;
    return { start: g[0].start, end: g[g.length - 1].end, words: cueWords, lines: wrapLines(cueWords, o) };
  });

  for (let i = 0; i < cues.length; i++) {
    const c = cues[i], next = cues[i + 1];
    c.end = Math.max(c.end + o.tailHoldSec, c.start + o.minCueSec);
    if (next && c.end > next.start) c.end = next.start;
    if (c.end > durationSec) c.end = durationSec;
    c.start = round(c.start);
    c.end = round(c.end);
  }
  return cues.filter((c) => c.end > c.start + 1e-3);
}

/** Balance into ≤ maxLines lines of word indices; never break between bound tokens. */
export function wrapLines(cueWords, o) {
  const text = display(cueWords, o.uppercase);
  if (text.length <= o.maxCharsPerLine || o.maxLines < 2 || cueWords.length < 2) return [cueWords.map((_, k) => k)];
  let best = null;
  for (let k = 1; k < cueWords.length; k++) {
    if (bindsToNext(cueWords[k - 1].text, cueWords[k].text)) continue;
    const a = display(cueWords.slice(0, k), o.uppercase).length, b = display(cueWords.slice(k), o.uppercase).length;
    const cost = Math.max(a, b) + (a < b ? 1 : 0); // prefer the longer line on top
    if (!best || cost < best.cost) best = { k, cost };
  }
  if (!best) return [cueWords.map((_, k) => k)];
  return [cueWords.slice(0, best.k).map((_, k) => k), cueWords.slice(best.k).map((_, k) => k + best.k)];
}

/** Plain text of a cue (for round-trip comparison and reports). */
export const cueText = (cue) => cue.words.map((w) => w.text).join(" ");
