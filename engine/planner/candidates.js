/**
 * engine/planner/candidates.js — the moments that MAY get emphasis. Pure, deterministic.
 *
 * Judgement (heuristic or LLM) only ever chooses among these. A punch-in or graphic that cannot
 * point at a candidate is not allowed — that is what stops "zoom every few seconds" editing.
 * Nothing here is timer-driven; every candidate is something the speaker actually said.
 *
 * Input: rebased words (output timeline). Output: [{id, type, out_start, out_end, i0, i1, text,
 * strength, keyword?, suggestion?}] — i0..i1 are word indices.
 */
import { normalizeWord } from "../transcription/words.js";
import { extractFacts, formatFact, isNumberish, bindsToNext } from "./numbers.js";

const endsSentence = (t) => /[.!?]["')\]]?$/.test(String(t).trim());
const ORDINAL_STEPS = { first: 1, firstly: 1, second: 2, secondly: 2, third: 3, thirdly: 3, fourth: 4, fifth: 5 };
const CONTRAST = [["but"], ["the", "truth", "is"], ["the", "real", "problem"], ["the", "problem", "is"], ["here's", "the", "thing"], ["the", "secret"], ["the", "key", "is"], ["most", "people"], ["stop"]];
const SOFTENERS = new Set(["just", "so", "and", "but", "then", "now", "really", "actually", "basically", "literally", "you", "know"]);
const STOP = new Set(["a", "an", "the", "to", "of", "and", "or", "in", "on", "at", "for", "is", "are", "it", "that", "this", "you", "your", "i", "we", "can", "be", "with", "as", "do", "get", "got", "so", "if"]);

/** Sentences as word-index ranges (punctuation, or a cut join between two words). */
export function sentences(words, joins = []) {
  const out = [];
  let s = 0;
  for (let i = 0; i < words.length; i++) {
    const next = words[i + 1];
    const atJoin = next && joins.some((t) => t > words[i].end - 1e-6 && t < next.start + 1e-6);
    if (!next || endsSentence(words[i].text) || atJoin) { out.push([s, i]); s = i + 1; }
  }
  return out;
}

const phrase = (words, i0, i1) => words.slice(i0, i1 + 1).map((w) => w.text).join(" ");
const strip = (t) => String(t).replace(/[.,!?;:"]+$/g, "").replace(/^["]+/, "");

/** The noun right after a number ("three SKILLS", "4 CLIENTS") — up to 2 content words, spoken. */
const VERBISH = new Set(["is", "are", "was", "were", "be", "get", "got", "make", "made", "do", "did", "go", "went", "want", "need", "have", "had", "can", "will", "would", "should", "could", "just", "really", "very", "so", "then", "now", "like"]);

function nounAfter(words, k, limit) {
  const out = [];
  for (let j = k + 1; j <= limit && out.length < 2; j++) {
    const n = normalizeWord(words[j].text);
    // A label must name what is counted ("3 SKILLS"), not a verb or adverb ("100% GOING", "10K CONSISTENTLY").
    if (!n || STOP.has(n) || isNumberish(words[j].text) || /(ing|ly|ed)$/.test(n) || VERBISH.has(n)) break;
    out.push(strip(words[j].text).toUpperCase());
    if (/[.,!?;:]$/.test(words[j].text.trim())) break;
  }
  return out.join(" ");
}

export function findCandidates(words, { joins = [], hookWindowSec = [3, 5] } = {}) {
  const sents = sentences(words, joins);
  const cands = [];
  const add = (c) => cands.push({ id: `c${cands.length + 1}`, ...c });
  const norm = words.map((w) => normalizeWord(w.text));

  // Hook: the opening sentence (or the part of it inside the hook window).
  if (sents.length) {
    let [h0, h1] = sents[0];
    while (h1 > h0 && words[h1].end > hookWindowSec[1] + 2) h1--;
    const clauses = [];
    let c0 = h0;
    for (let i = h0; i <= h1; i++) if (/[,;:—–-]$/.test(words[i].text.trim()) || i === h1) { clauses.push([c0, i]); c0 = i + 1; }
    const [k0raw, k1] = clauses[clauses.length - 1];
    let k0 = k0raw;
    while (k0 < k1 && SOFTENERS.has(norm[k0])) k0++;
    const keyText = words.slice(k0, k1 + 1).map((w) => strip(w.text).toUpperCase()).join(" ");
    add({ type: "hook", out_start: words[h0].start, out_end: words[h1].end, i0: h0, i1: h1, text: phrase(words, h0, h1), strength: 1,
      key: { i0: k0, i1: k1, out_start: words[k0].start, out_end: words[k1].end, text: keyText, words: k1 - k0 + 1 } });
  }

  for (const [s0, s1] of sents) {
    // Numbers / money / percentages (with the noun they count).
    for (let k = s0; k <= s1; k++) {
      if (!isNumberish(words[k].text)) continue;
      if (k > s0 && isNumberish(words[k - 1].text)) continue; // "twenty five" — start of the run only
      let e = k;
      while (e < s1 && bindsToNext(words[e].text, words[e + 1].text)) e++;
      // Per-month tails: "a month", "per month".
      if (e + 2 <= s1 && ["a", "per"].includes(norm[e + 1]) && ["month", "mo"].includes(norm[e + 2])) e += 2;
      const facts = extractFacts(words.slice(k, e + 1).map((w) => w.text));
      if (!facts.length || facts[0].ordinal) continue;
      const noun = nounAfter(words, e, s1);
      add({ type: "number", out_start: words[k].start, out_end: words[Math.min(s1, e + (noun ? noun.split(" ").length : 0))].end, i0: k, i1: e,
        text: phrase(words, k, e), strength: 0.9, keyword: k,
        suggestion: { component: "NumberCallout", props: { value: formatFact(facts[0]), label: noun } } });
      k = e;
    }
    // List markers at the start of a sentence: "First, …", "Step one …".
    const first = norm[s0];
    if (first in ORDINAL_STEPS) {
      const noun = nounAfter(words, s0, Math.min(s1, s0 + 8));
      add({ type: "list", out_start: words[s0].start, out_end: words[Math.min(s1, s0 + 3)].end, i0: s0, i1: Math.min(s1, s0 + 3),
        text: phrase(words, s0, Math.min(s1, s0 + 3)), strength: 0.8, keyword: s0,
        suggestion: { component: "Label", props: { text: `STEP ${ORDINAL_STEPS[first]}` } }, nounHint: noun });
    } else if (norm[s0] === "step" && isNumberish(words[s0 + 1]?.text ?? "")) {
      const f = extractFacts([words[s0 + 1].text])[0];
      if (f) add({ type: "list", out_start: words[s0].start, out_end: words[s0 + 1].end, i0: s0, i1: s0 + 1, text: phrase(words, s0, s0 + 1), strength: 0.8,
        keyword: s0 + 1, suggestion: { component: "Label", props: { text: `STEP ${f.value}` } } });
    }
    // Contrast / reveal phrases.
    for (const pat of CONTRAST) {
      for (let k = s0; k + pat.length - 1 <= s1 && k <= s0 + 1; k++) {
        if (pat.every((p, j) => norm[k + j] === p)) {
          const e = Math.min(s1, k + pat.length + 3);
          add({ type: "contrast", out_start: words[k].start, out_end: words[e].end, i0: k, i1: e, text: phrase(words, k, e), strength: 0.65, keyword: Math.min(s1, k + pat.length) });
        }
      }
    }
  }
  // Payoff: the closing sentence (the line the viewer leaves with).
  if (sents.length > 1) {
    const [p0, p1] = sents[sents.length - 1];
    add({ type: "payoff", out_start: words[p0].start, out_end: words[p1].end, i0: p0, i1: p1, text: phrase(words, p0, p1), strength: 0.85 });
  }
  // Every candidate knows where its sentence ends, so a punch-in can hold until the thought lands.
  for (const c of cands) {
    const s = sents.find(([a, b]) => c.i0 >= a && c.i0 <= b);
    c.sentence_end = s ? words[s[1]].end : c.out_end;
  }
  return cands;
}
