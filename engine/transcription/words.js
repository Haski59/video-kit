/**
 * engine/transcription/words.js — pure transforms on word lists. No I/O.
 *
 * Ported from scripts/edit/pure.js, where every
 * rule below came from a failure observed on real footage. Kept behaviour-identical except where
 * noted ("CHANGED").
 *
 * word = { text, start, end, prob?, score? } — seconds on the SOURCE timeline, text trimmed.
 */

const round = (n, dp = 3) => Number(n.toFixed(dp));

/** Lower-case, strip surrounding punctuation. Used for matching only, never for display. */
export function normalizeWord(text) {
  return String(text ?? "").toLowerCase().replace(/^[^\p{L}\p{N}'£$€%]+|[^\p{L}\p{N}'%]+$/gu, "");
}

/**
 * whisper.cpp `-ml 1 -sow -ojf` JSON → raw words. One segment per word; the word's probability is
 * the mean of its non-special tokens (whisper's own confidence, kept for candidate scoring and the
 * hallucination test).
 */
export function wordsFromWhisperJson(json) {
  return (json?.transcription ?? []).map((s) => {
    const toks = (s.tokens ?? []).filter((t) => !/^\[_/.test(String(t.text ?? "")) && Number.isFinite(t.p));
    const prob = toks.length ? toks.reduce((a, t) => a + t.p, 0) / toks.length : null;
    const w = { text: String(s.text ?? "").trim(), start: (s.offsets?.from ?? 0) / 1000, end: (s.offsets?.to ?? 0) / 1000 };
    if (prob !== null) w.prob = round(prob);
    return w;
  });
}

// ── lexicon ─────────────────────────────────────────────────────────────────

/** Brand-vocabulary corrections to TEXT only. Timings are never touched. */
export function applyLexicon(words, lexicon = {}) {
  const replacements = new Map(Object.entries(lexicon.replacements ?? {}).map(([k, v]) => [normalizeWord(k), v]));
  const phrases = Object.entries(lexicon.phrases ?? {})
    .map(([k, v]) => ({ from: k.split(/\s+/).map(normalizeWord), to: v.split(/\s+/) }))
    .sort((a, b) => b.from.length - a.from.length);
  const out = words.map((w) => ({ ...w }));
  const norm = out.map((w) => normalizeWord(w.text));
  const claimed = new Array(out.length).fill(false);
  for (const { from, to } of phrases) {
    for (let i = 0; i + from.length <= out.length; i++) {
      if (claimed.slice(i, i + from.length).some(Boolean)) continue;
      let hit = true;
      for (let j = 0; j < from.length; j++) if (norm[i + j] !== from[j]) { hit = false; break; }
      if (!hit) continue;
      for (let j = 0; j < from.length; j++) { out[i + j].text = preservePunctuation(out[i + j].text, to[j]); claimed[i + j] = true; }
    }
  }
  for (let i = 0; i < out.length; i++) {
    if (claimed[i]) continue;
    const hit = replacements.get(norm[i]);
    if (hit !== undefined) out[i].text = preservePunctuation(out[i].text, hit);
  }
  return out;
}

function preservePunctuation(original, replacement) {
  const m = String(original).match(/^(\s*)([^\p{L}\p{N}']*)(.*?)([^\p{L}\p{N}']*)(\s*)$/su);
  if (!m) return replacement;
  const [, lead, pre, , post, trail] = m;
  return `${lead}${pre}${replacement}${post}${trail}`;
}

/** Reject a lexicon that would corrupt timings (phrase word counts must match). */
export function validateLexicon(lexicon = {}) {
  const errors = [];
  for (const [from, to] of Object.entries(lexicon.phrases ?? {})) {
    const a = from.trim().split(/\s+/).length, b = to.trim().split(/\s+/).length;
    if (a !== b) errors.push(`phrase "${from}" → "${to}" changes word count ${a}→${b}`);
  }
  for (const [from, to] of Object.entries(lexicon.replacements ?? {})) {
    if (/\s/.test(to.trim())) errors.push(`replacement "${from}" → "${to}" contains a space; use "phrases"`);
  }
  return errors;
}

export function lexiconPrompt(lex) {
  const terms = [...Object.values(lex.phrases ?? {}), ...Object.values(lex.replacements ?? {})];
  return [...(lex.prompt ? [lex.prompt] : []), ...new Set(terms)].join(", ").slice(0, 800);
}

// ── sanitising ──────────────────────────────────────────────────────────────

/**
 * Clean raw whisper words: drop empties and words starting past the end (hallucinations on
 * trailing silence), CLAMP ends past the media (one bogus end time once smeared an entire
 * alignment by 11.7s), widen zero-length words (real words whisper.cpp gives start === end after
 * a pause), sort.
 */
export function sanitiseWords(rawWords, durationSec, { minWordSec = 0.05, lowScoreThreshold = 0.35 } = {}) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("sanitiseWords: durationSec must be > 0");
  const report = { input: rawWords.length, dropped: { empty: 0, pastEnd: 0, unusable: 0 }, repaired: { clampedEnd: 0, widened: 0 }, suspect: [] };
  const out = [];
  for (const raw of rawWords) {
    const text = String(raw.text ?? "").trim();
    if (!text) { report.dropped.empty++; continue; }
    let { start, end } = raw;
    if (!Number.isFinite(start) || !Number.isFinite(end)) { report.dropped.unusable++; continue; }
    if (start >= durationSec - 1e-3) { report.dropped.pastEnd++; continue; }
    start = Math.max(0, start);
    if (end > durationSec) { end = durationSec; report.repaired.clampedEnd++; }
    if (end - start < minWordSec) { end = Math.min(start + minWordSec, durationSec); report.repaired.widened++; }
    if (end <= start) { report.dropped.unusable++; continue; }
    const word = { ...raw, text, start: round(start), end: round(end) };
    if (Number.isFinite(raw.score) && raw.score < lowScoreThreshold) report.suspect.push({ text, start: word.start, score: raw.score });
    out.push(word);
  }
  out.sort((a, b) => a.start - b.start);
  report.output = out.length;
  return { words: out, report };
}

/**
 * Decide whether a forced alignment may be trusted. A bad alignment is worse than none and fails
 * silently, so this returns an explicit verdict the caller must act on.
 *
 * CHANGED from the port: `aligned` is now index-for-index with `raw` (null where the aligner could
 * give no timing — whisperX documents that tokens like "£13.60" cannot be aligned). Coverage counts
 * timed entries, and drift compares the SAME word, not the word that happens to share an index
 * after a drop.
 */
export function checkAlignment({ raw, aligned, durationSec, minCoverage = 0.9, maxMedianDriftSec = 2.0 }) {
  const reasons = [];
  if (aligned.length !== raw.length) reasons.push(`aligner returned ${aligned.length} entries for ${raw.length} words — refusing an index-unsafe merge`);
  const timed = aligned.map((a, i) => (a && Number.isFinite(a.start) && Number.isFinite(a.end) ? { a, r: raw[i] } : null)).filter(Boolean);
  const coverage = raw.length ? timed.length / raw.length : 0;
  if (coverage < minCoverage) reasons.push(`only ${timed.length} of ${raw.length} words timed (${(coverage * 100).toFixed(0)}%, need ${minCoverage * 100}%)`);
  const past = timed.filter(({ a }) => a.end > durationSec + 0.05);
  if (past.length) reasons.push(`${past.length} word(s) end past the media — the alignment window was wrong`);
  for (let i = 1; i < timed.length; i++) {
    if (timed[i].a.start < timed[i - 1].a.start - 1e-6) { reasons.push(`non-monotonic at timed word ${i}`); break; }
  }
  const drifts = timed.filter(({ r }) => r).map(({ a, r }) => Math.abs(a.start - r.start)).sort((x, y) => x - y);
  const medianDrift = drifts.length ? drifts[Math.floor(drifts.length / 2)] : 0;
  if (medianDrift > maxMedianDriftSec) reasons.push(`median drift ${medianDrift.toFixed(2)}s exceeds ${maxMedianDriftSec}s — smeared, not corrected`);
  return {
    ok: reasons.length === 0,
    reasons,
    stats: { coverage: round(coverage, 3), medianDriftSec: round(medianDrift), maxDriftSec: round(drifts[drifts.length - 1] ?? 0), wordsPastEnd: past.length },
  };
}

/**
 * Merge an index-aligned alignment onto the decoder's words. Text always comes from the decoder
 * (punctuation + lexicon casing). An untimed word keeps its decoder timing, clamped between its
 * timed neighbours so order stays monotonic.
 */
export function mergeAlignment(raw, aligned) {
  const out = raw.map((r, i) => {
    const a = aligned[i];
    if (a && Number.isFinite(a.start) && Number.isFinite(a.end) && a.end > a.start) {
      return { ...r, start: round(a.start), end: round(a.end), score: Number.isFinite(a.score) ? a.score : undefined, timing: "aligned" };
    }
    return { ...r, timing: "decoder" };
  });
  for (let i = 0; i < out.length; i++) {
    if (out[i].timing !== "decoder") continue;
    const prevEnd = i > 0 ? out[i - 1].end : 0;
    const next = out.slice(i + 1).find((w) => w.timing === "aligned");
    const nextStart = next ? next.start : Infinity;
    let { start, end } = out[i];
    start = Math.max(start, prevEnd);
    end = Math.min(Math.max(end, start + 0.05), nextStart);
    if (end <= start) end = start + 0.01;
    out[i] = { ...out[i], start: round(start), end: round(end) };
  }
  for (const w of out) if (w.score === undefined) delete w.score;
  return out;
}

/** Restrict words to a [start, end] source range (for --range jobs). */
export function wordsInRange(words, range) {
  if (!range) return words;
  return words.filter((w) => w.start >= range.start - 1e-6 && w.end <= range.end + 1e-6);
}
