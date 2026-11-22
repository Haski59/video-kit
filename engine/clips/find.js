/**
 * engine/clips/find.js — find the best stand-alone short clips inside a long recording.
 *
 * A clip must carry a whole point on its own: claim → why → proof → resolution, usually 60–120 s.
 * Thirty-second fragments that stop before the point lands are rejected by design.
 *
 *   1. sentences()  — split the transcript into sentences (punctuation or a pause ≥ 0.7 s)
 *   2. windows()    — every run of whole sentences whose length fits [minSec, maxSec]
 *   3. pick         — Claude picks (claudePick) from numbered sentences, inside a fence: it may only
 *                     return sentence ranges, which are re-checked here; otherwise heuristicPick()
 *   4. the result   — non-overlapping {start, end} source ranges that `kit short --range` renders
 *
 * Everything except claudePick is pure and unit-tested.
 */
import { runClaude, parseJson, MODEL } from "../llm/claude.js";

const CONNECTIVES = new Set(["and", "so", "but", "because", "which", "also", "then", "or", "like", "that", "it", "this", "especially", "plus", "well", "now", "anyway", "again", "they", "he", "she", "those", "these"]);
const BACKREF = /\b(as i said|like i said|earlier|as mentioned|going back to|the (first|second|third) one)\b/i;

/** Words → [{i, start, end, text}] sentences. */
export function sentences(words, { pauseSec = 0.7 } = {}) {
  const out = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ i: out.length, start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(" ") });
    cur = [];
  };
  words.forEach((w, k) => {
    cur.push(w);
    const next = words[k + 1];
    if (/[.!?]["')\]]?$/.test(w.text) || (next && next.start - w.end >= pauseSec)) flush();
  });
  flush();
  return out;
}

/** Every contiguous sentence run [a..b] with duration in [minSec, maxSec]. */
export function windows(sents, { minSec = 60, maxSec = 120 } = {}) {
  const out = [];
  for (let a = 0; a < sents.length; a++) {
    for (let b = a; b < sents.length; b++) {
      const d = sents[b].end - sents[a].start;
      if (d > maxSec) break;
      if (d >= minSec) out.push({ a, b, start: sents[a].start, end: sents[b].end, dur: d });
    }
  }
  return out;
}

/** Deterministic score: a clean opening, a concrete detail, an ending that lands. Higher is better. */
export function scoreWindow(w, sents) {
  const first = sents[w.a].text.trim(), last = sents[w.b].text.trim();
  const body = sents.slice(w.a, w.b + 1).map((s) => s.text).join(" ");
  const firstWord = first.toLowerCase().replace(/^[^a-z]+/, "").split(/\s+/)[0] ?? "";
  let s = 0;
  if (CONNECTIVES.has(firstWord)) s -= 3;                     // opens mid-thought
  if (BACKREF.test(body)) s -= 3;                             // leans on something outside the clip
  if (/\?$/.test(first) || /\b(you|your)\b/i.test(first)) s += 1.5; // speaks to the viewer from the first line
  if (/\d|\b(percent|thousand|million|grand|k)\b/i.test(body)) s += 1.5; // a concrete number or proof
  if (/\b(because|that's why|the reason)\b/i.test(body)) s += 1;   // explains why
  if (/[.!]$/.test(last)) s += 1;                              // ends on a full stop, not mid-list
  s -= Math.abs(w.dur - 90) / 60;                              // prefer ~90 s
  return Number(s.toFixed(3));
}

const overlaps = (x, y) => x.start < y.end && y.start < x.end;

/** Top-N non-overlapping windows by score. */
export function heuristicPick(sents, { count = 3, minSec = 60, maxSec = 120 } = {}) {
  const ws = windows(sents, { minSec, maxSec }).map((w) => ({ ...w, score: scoreWindow(w, sents) })).sort((x, y) => y.score - x.score);
  const picked = [];
  for (const w of ws) {
    if (picked.length >= count) break;
    if (picked.some((p) => overlaps(p, w))) continue;
    picked.push({ ...w, title: sents[w.a].text.split(/\s+/).slice(0, 8).join(" "), reason: `heuristic score ${w.score}`, picker: "heuristic" });
  }
  return picked.sort((x, y) => x.start - y.start);
}

export const CLIP_SYSTEM = `You pick stand-alone short-form clips from a long talking-head video transcript.
A good clip carries one complete point on its own: a hook/claim in the first sentence, then why, then proof
(an example, number or story), then a resolution line. It must make sense to someone who never saw the long
video: no "as I said", no dangling "and so". Never pick a fragment that stops before the point lands.
You may only choose contiguous runs of the numbered sentences. Reply with ONE JSON array and nothing else:
[{"first":number,"last":number,"title":string,"hook":string,"reason":string}]`;

/** Check a model answer against the sentence list and bounds. Returns { clips, errors }. */
export function checkPicks(raw, sents, { count, minSec, maxSec }) {
  const errors = [], clips = [];
  if (!Array.isArray(raw)) return { clips, errors: ["answer is not an array"] };
  for (const [k, c] of raw.entries()) {
    const a = c?.first, b = c?.last;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b >= sents.length || b < a) { errors.push(`clip ${k}: bad sentence range`); continue; }
    const w = { a, b, start: sents[a].start, end: sents[b].end, dur: sents[b].end - sents[a].start };
    // 10 % tolerance either side: the model reads times off text and sentence edges are coarse.
    if (w.dur < minSec * 0.9 || w.dur > maxSec * 1.1) { errors.push(`clip ${k}: ${w.dur.toFixed(0)}s is outside ${minSec}–${maxSec}s`); continue; }
    if (clips.some((p) => overlaps(p, w))) { errors.push(`clip ${k}: overlaps another clip`); continue; }
    clips.push({ ...w, title: String(c.title ?? "").slice(0, 80), hook: String(c.hook ?? "").slice(0, 160), reason: String(c.reason ?? "").slice(0, 240), picker: `llm:${MODEL}` });
  }
  return { clips: clips.slice(0, count).sort((x, y) => x.start - y.start), errors };
}

export function clipPrompt(sents, { count, minSec, maxSec, about = "" }) {
  return [
    about ? `CREATOR CONTEXT: ${about}` : "",
    `Pick up to ${count} clips, each ${minSec}–${maxSec} seconds long, not overlapping, best first.`,
    `SENTENCES (index [start–end s] text):\n${sents.map((s) => `${s.i} [${s.start.toFixed(1)}–${s.end.toFixed(1)}] ${s.text}`).join("\n")}`,
    "Return the JSON array only.",
  ].filter(Boolean).join("\n\n");
}

/** Claude first, heuristic fallback. Never throws for a model problem. */
export function findClips(words, { count = 3, minSec = 60, maxSec = 120, about = "", planner = "auto", runner = runClaude, log = () => {} } = {}) {
  const sents = sentences(words);
  const total = words.length ? words[words.length - 1].end - words[0].start : 0;
  if (total < minSec) return { clips: [], sentences: sents, notes: [`recording has only ${total.toFixed(0)}s of speech — shorter than one ${minSec}s clip`] };
  const notes = [];
  if (planner !== "heuristic") {
    try {
      const out = runner({ system: CLIP_SYSTEM, prompt: clipPrompt(sents, { count, minSec, maxSec, about }), timeoutMs: 180000 });
      const { clips, errors } = checkPicks(parseJson(out.text), sents, { count, minSec, maxSec });
      if (errors.length) notes.push(`Claude picks dropped: ${errors.join("; ")}`);
      if (clips.length) return { clips, sentences: sents, notes };
      notes.push("no usable Claude picks — heuristic used");
    } catch (e) {
      notes.push(`Claude unavailable (${e.message.split("\n")[0]}) — heuristic used`);
      log(notes[notes.length - 1]);
    }
  }
  return { clips: heuristicPick(sents, { count, minSec, maxSec }), sentences: sents, notes };
}
