/**
 * engine/rough-cut/cuts.js — the first edit pass: clean the footage, keep the meaning.
 *
 * Pure. Ported from scripts/edit/pure.js — span
 * maths, filler/dead-air planning with the two-signal audio veto, retake detection, frame
 * snapping and time rebasing are behaviour-identical. NEW here:
 *
 *   - Retakes are evaluated by a GUARD instead of always waiting for a human, because this editor
 *     runs unattended. Only removals that pass every guard are applied; everything else is kept
 *     in the plan as `applied: false` and sends the job to NEEDS_REVIEW. Whisper can loop and
 *     invent a repeat that was said once, so "both copies are audible" is mandatory.
 *   - Short false starts ("So the first— So the first thing you need…") are detected separately.
 *   - Provenance: every kept segment carries {src_start, src_end, out_start, out_end}, and
 *     srcToOut / outToSrc map any instant between the two timelines.
 *
 * Nothing in this file decides content is "weak". It only removes silence, fillers and a speaker's
 * own abandoned attempts.
 */
import { normalizeWord } from "../transcription/words.js";

const round = (n, dp = 3) => Number(n.toFixed(dp));

// ── span maths (ported) ─────────────────────────────────────────────────────

export function mergeSpans(spans, tolerance = 0) {
  const sorted = [...spans].filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start - last.end <= tolerance) {
      last.end = Math.max(last.end, s.end);
      if (s.reason && last.reason && !last.reason.includes(s.reason)) last.reason += ` + ${s.reason}`;
      if (s.kind && last.kind && last.kind !== s.kind && !String(last.kind).includes(s.kind)) last.kind = `${last.kind}+${s.kind}`;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

export const spanTotal = (spans) => spans.reduce((a, s) => a + (s.end - s.start), 0);

/** Fraction of `span` covered by `audibleSpans`, 0..1 (fraction, not any-overlap — see port notes). */
export function audibleFraction(span, audibleSpans) {
  const len = span.end - span.start;
  if (len <= 0) return 0;
  let covered = 0;
  for (const a of audibleSpans) covered += Math.max(0, Math.min(a.end, span.end) - Math.max(a.start, span.start));
  return Math.min(1, covered / len);
}

export function invertSpans(spans, duration) {
  const merged = mergeSpans(spans);
  const keep = [];
  let cursor = 0;
  for (const s of merged) {
    const start = Math.max(0, s.start);
    if (start - cursor > 1e-6) keep.push({ start: round(cursor), end: round(start) });
    cursor = Math.max(cursor, Math.min(duration, s.end));
  }
  if (duration - cursor > 1e-6) keep.push({ start: round(cursor), end: round(duration) });
  return keep;
}

/** Snap spans to whole frames: start down, end up — snapping only ever keeps MORE footage. */
export function snapToFrames(spans, fps) {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("snapToFrames: fps must be > 0");
  const out = [];
  for (const s of spans) {
    const start = Math.floor(s.start * fps + 1e-6) / fps;
    const end = Math.ceil(s.end * fps - 1e-6) / fps;
    if (end - start < 1 / fps - 1e-9) continue;
    out.push({ ...s, start, end });
  }
  return mergeSpans(out, 1e-6);
}

// ── retakes ─────────────────────────────────────────────────────────────────

export const DEFAULT_RESTART_MARKERS = [
  "let me say that again", "let me start again", "let me try that again", "start again",
  "take two", "scratch that", "one more time", "sorry",
];

const meanOf = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const conf = (w) => (Number.isFinite(w.score) ? w.score : Number.isFinite(w.prob) ? w.prob : null);
const endsSentence = (w) => /[.!?]["')\]]?$/.test(String(w.text).trim());

/**
 * Candidate retakes, each with the word indices of both takes so the guard can inspect them.
 * Three detectors: long repeats (>= minRun words, the ported rule), short false starts (a 2+ word
 * opening restarted after a pause), and explicit restart markers followed by a real restart.
 */
export function findRetakeCandidates(words, opts = {}) {
  const {
    minRun = 4, lookaheadSec = 12, markers = DEFAULT_RESTART_MARKERS,
    maxLookbackWords = 15, maxLookbackSec = 10, maxLookbackGapSec = 1.5,
    falseStartMaxWords = 6, falseStartMinPauseSec = 0.35,
  } = opts;
  const norm = words.map((w) => normalizeWord(w.text));
  const found = [];

  // 1. Long repeats (ported). First instance is the false start; the second is the good take.
  for (let i = 0; i < words.length; i++) {
    for (let j = i + minRun; j < words.length; j++) {
      if (words[j].start - words[i].start > lookaheadSec) break;
      let run = 0;
      while (i + run < j && j + run < words.length && norm[i + run] && norm[i + run] === norm[j + run]) run++;
      if (run >= minRun) {
        found.push({ kind: "retake", detector: "repeat", start: words[i].start, end: words[j].start, first: [i, i + run - 1], second: [j, j + run - 1], removed: [i, j - 1],
          reason: `repeated ${run} words — "${words.slice(i, i + run).map((w) => w.text).join(" ")}"` });
        i = j + run - 1;
        break;
      }
    }
  }

  // 2. Short false starts: words i..j-1 abandoned (no sentence end, no comma), a pause, then the
  //    same first two words again at j.
  for (let i = 0; i + 3 < words.length; i++) {
    if (found.some((f) => i >= f.removed[0] && i <= f.removed[1])) continue;
    for (let j = i + 2; j <= Math.min(words.length - 2, i + falseStartMaxWords); j++) {
      if (norm[j] !== norm[i] || norm[j + 1] !== norm[i + 1] || !norm[i]) continue;
      const frag = words.slice(i, j);
      if (frag.some((w) => endsSentence(w) || /[,;:]$/.test(String(w.text).trim()))) continue;
      const pause = words[j].start - words[j - 1].end;
      if (pause < falseStartMinPauseSec) continue;
      found.push({ kind: "falseStart", detector: "false-start", start: words[i].start, end: words[j].start, first: [i, j - 1], second: [j, Math.min(words.length - 1, j + (j - i) - 1)], removed: [i, j - 1],
        reason: `false start — "${frag.map((w) => w.text).join(" ")}" restarted after ${pause.toFixed(2)}s` });
      i = j - 1;
      break;
    }
  }

  // 3. Explicit restart markers, walked back to the start of the interrupted sentence (bounded —
  //    whisper often omits full stops, and an unbounded walk-back once proposed deleting a whole video).
  const markerNorms = markers.map((m) => m.split(/\s+/).map(normalizeWord));
  for (let i = 0; i < words.length; i++) {
    for (const mk of markerNorms) {
      let hit = true;
      for (let k = 0; k < mk.length; k++) if (norm[i + k] !== mk[k]) { hit = false; break; }
      if (!hit) continue;
      let s = i;
      while (s > 0 && !endsSentence(words[s - 1]) && i - s < maxLookbackWords &&
        words[i].end - words[s - 1].start < maxLookbackSec && words[s].start - words[s - 1].end < maxLookbackGapSec) s--;
      const after = i + mk.length;
      // A real restart repeats the opening of what was abandoned. Without that, "sorry" is just a word.
      const restarts = s < i && after + 1 < words.length && norm[after] === norm[s] && norm[after + 1] === norm[s + 1];
      found.push({ kind: "retake", detector: "marker", start: words[s].start, end: words[Math.min(words.length - 1, after)]?.start ?? words[i + mk.length - 1].end,
        first: [s, i - 1], second: [after, Math.min(words.length - 1, after + (i - s) - 1)], removed: [s, after - 1], markerRestart: restarts,
        reason: `restart marker "${mk.join(" ")}"${restarts ? " followed by a restart" : " with no clear restart"}` });
      i += mk.length - 1;
      break;
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/**
 * Should this retake be removed without a human? Returns { applied, confidence, why[] }.
 * Every guard must pass. Missing evidence (no audio map, no scores) means NOT applied.
 */
export function guardRetake(c, words, { audibleSpans = null, guard = {} } = {}) {
  const g = { minScore: 0.4, minAudibleFraction: 0.6, durationRatio: [0.6, 1.6], maxGapBetweenTakesSec: 4, maxRemovedWords: 15, maxRemovedSec: 8, ...guard };
  const why = [];
  const span = (a, b) => ({ start: words[a].start, end: words[b].end });
  const removedWords = c.removed[1] - c.removed[0] + 1;
  if (removedWords > g.maxRemovedWords) why.push(`would remove ${removedWords} words (max ${g.maxRemovedWords})`);
  if (c.end - c.start > g.maxRemovedSec) why.push(`would remove ${(c.end - c.start).toFixed(1)}s (max ${g.maxRemovedSec}s)`);
  if (c.second[0] >= words.length || c.second[1] < c.second[0]) why.push("no second take found");
  if (c.detector === "marker" && !c.markerRestart) why.push("marker is not followed by a restart");
  if (!why.length) {
    const a = span(c.first[0], c.first[1]);
    const b = span(c.second[0], Math.min(c.second[1], words.length - 1));
    if (a.end > b.start + 1e-3) why.push("takes overlap in time");
    if (b.start - a.end > g.maxGapBetweenTakesSec) why.push(`takes ${(b.start - a.end).toFixed(1)}s apart (max ${g.maxGapBetweenTakesSec}s)`);
    if (!Array.isArray(audibleSpans)) why.push("no audio map to prove both takes were spoken");
    else {
      const fa = audibleFraction(a, audibleSpans), fb = audibleFraction(b, audibleSpans);
      if (fa < g.minAudibleFraction || fb < g.minAudibleFraction) why.push(`a take is not clearly audible (${(fa * 100).toFixed(0)}% / ${(fb * 100).toFixed(0)}%) — possible whisper loop`);
    }
    const sa = meanOf(words.slice(c.first[0], c.first[1] + 1).map(conf).filter((x) => x !== null));
    const sb = meanOf(words.slice(c.second[0], c.second[1] + 1).map(conf).filter((x) => x !== null));
    if (sa === null || sb === null) why.push("no word confidence available");
    else if (sa < g.minScore || sb < g.minScore) why.push(`low word confidence (${sa.toFixed(2)} / ${sb.toFixed(2)})`);
    if (c.detector === "repeat") {
      const ratio = (a.end - a.start) / Math.max(1e-3, b.end - b.start);
      if (ratio < g.durationRatio[0] || ratio > g.durationRatio[1]) why.push(`take durations differ too much (ratio ${ratio.toFixed(2)})`);
    }
  }
  return { applied: why.length === 0, confidence: why.length === 0 ? "high" : "low", why };
}

// ── rough cut ───────────────────────────────────────────────────────────────

export const DEFAULT_PACING = {
  maxGapSec: 0.6, keepGapSec: 0.25, padSec: 0.06, edgeGapSec: 0.2,
  fillers: ["um", "uh", "erm", "uhh", "umm", "ah", "er", "hmm", "mm"],
  audibleVetoFraction: 0.35, maxRemovedFraction: 0.6,
};

/**
 * Build the rough cut. Returns { removals, segments, stats }.
 *   removals — every identified removal: {start,end,kind,reason,confidence,applied,why?} (source time)
 *   segments — frame-snapped kept spans: {id, src_start, src_end, out_start, out_end}
 * Applied removals = automatic cuts ∪ retakes that passed the guard. Proposals stay listed.
 */
/**
 * protect: source spans the member asked to keep — no automatic removal may touch them.
 * force:   source spans the member asked to remove (e.g. a retake the guard wasn't sure about).
 */
export function planRoughCut({ words, durationSec, fps, audibleSpans = null, range = null, pacing = {}, retakes = {}, protect = [], force = [] }) {
  const o = { ...DEFAULT_PACING, ...pacing };
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("planRoughCut: durationSec must be > 0");
  const lo = range ? range.start : 0, hi = range ? Math.min(range.end, durationSec) : durationSec;
  const ws = [...words].filter((w) => Number.isFinite(w.start) && w.end > w.start && w.start >= lo - 1e-6 && w.end <= hi + 1e-6).sort((a, b) => a.start - b.start);
  if (!ws.length) throw new Error("planRoughCut: no usable words — refusing to cut a file we cannot read");
  const fillers = new Set(o.fillers.map(normalizeWord));
  const auto = [];

  if (range) {
    if (lo > 0) auto.push({ start: 0, end: lo, kind: "range", reason: "outside requested range" });
    if (hi < durationSec) auto.push({ start: hi, end: durationSec, kind: "range", reason: "outside requested range" });
  }
  const isFiller = ws.map((w) => fillers.has(normalizeWord(w.text)));
  for (let i = 0; i < ws.length; i++) {
    if (!isFiller[i]) continue;
    const prevEnd = i > 0 ? ws[i - 1].end : lo;
    const nextStart = i < ws.length - 1 ? ws[i + 1].start : hi;
    auto.push({ start: Math.max(prevEnd + o.padSec, ws[i].start - o.padSec), end: Math.min(nextStart - o.padSec, ws[i].end + o.padSec), kind: "filler", reason: `filler "${ws[i].text}"` });
  }
  for (let i = 0; i < ws.length - 1; i++) {
    if (isFiller[i] || isFiller[i + 1]) continue;
    const gap = ws[i + 1].start - ws[i].end;
    if (gap <= o.maxGapSec) continue;
    const half = o.keepGapSec / 2;
    auto.push({ start: ws[i].end + half, end: ws[i + 1].start - half, kind: "deadAir", reason: `${gap.toFixed(2)}s pause → ${o.keepGapSec}s` });
  }
  if (ws[0].start - lo > o.edgeGapSec + o.padSec) auto.push({ start: lo, end: ws[0].start - o.edgeGapSec, kind: "deadAir", reason: "lead-in silence" });
  const last = ws[ws.length - 1].end;
  if (hi - last > o.edgeGapSec + o.padSec) auto.push({ start: last + o.edgeGapSec, end: hi, kind: "deadAir", reason: "tail silence" });

  // Two signals must agree before dead air goes: a dead-air cut that reads as audible is refused.
  const audible = Array.isArray(audibleSpans) ? mergeSpans(audibleSpans) : null;
  const disputed = [];
  const clamp = (s) => ({ ...s, start: Math.max(0, Math.min(durationSec, s.start)), end: Math.max(0, Math.min(durationSec, s.end)) });
  let autoCuts = auto.map(clamp).filter((s) => s.end - s.start > 1e-3).filter((c) => {
    if (c.kind !== "deadAir" || !audible) return true;
    const frac = audibleFraction(c, audible);
    if (frac <= o.audibleVetoFraction) return true;
    disputed.push({ ...c, kind: "disputed", reason: `${c.reason} — refused: ${(frac * 100).toFixed(0)}% audible` });
    return false;
  });

  const touchesProtected = (c) => protect.some((p) => c.start < p.end && c.end > p.start);
  autoCuts = autoCuts.filter((c) => {
    if (!touchesProtected(c)) return true;
    disputed.push({ ...c, kind: "kept", reason: `${c.reason} — kept: member asked to keep ${c.start.toFixed(2)}s` });
    return false;
  });
  for (const f of force) autoCuts.push({ start: Math.max(lo, f.start), end: Math.min(hi, f.end), kind: "manual", reason: `removed at the member's request (${f.start.toFixed(2)}–${f.end.toFixed(2)}s)` });

  const retakeRemovals = findRetakeCandidates(ws, retakes).filter((c) => !touchesProtected(c)).map((c) => {
    const verdict = retakes.autoApply === "off" ? { applied: false, confidence: "low", why: ["retake auto-apply disabled by profile"] }
      : guardRetake(c, ws, { audibleSpans: audible, guard: retakes.guard });
    return { start: c.start, end: c.end, kind: c.kind, detector: c.detector, reason: c.reason, confidence: verdict.confidence, applied: verdict.applied, why: verdict.why };
  });

  // Applied and proposed are merged SEPARATELY (port lesson: one wide proposal once swallowed 11.5s
  // of dead-air cuts). The union is taken only over what is actually applied.
  const applied = mergeSpans([...autoCuts, ...retakeRemovals.filter((r) => r.applied)].map((c) => ({ start: c.start, end: c.end, kind: c.kind, reason: c.reason })));
  const removedSec = spanTotal(applied);
  const usable = hi - lo;
  if (removedSec - (durationSec - usable) > o.maxRemovedFraction * usable) {
    throw new Error(`planRoughCut: would remove ${((removedSec - (durationSec - usable)) / usable * 100).toFixed(1)}% of the material — over the ${o.maxRemovedFraction * 100}% ceiling; the transcript is probably wrong.`);
  }
  // Snapping rounds ends UP; never past the source's last whole frame (a phantom frame made the
  // render one frame shorter than the plan on the first real E2E).
  const lastFrameEnd = Math.floor(durationSec * fps + 1e-6) / fps;
  const keep = snapToFrames(invertSpans(applied, durationSec), fps)
    .map((k) => ({ ...k, end: Math.min(k.end, lastFrameEnd) })).filter((k) => k.end - k.start >= 1 / fps - 1e-9);
  let acc = 0;
  const segments = keep.map((k, i) => {
    const seg = { id: `seg${i + 1}`, src_start: k.start, src_end: k.end, out_start: acc, out_end: acc + (k.end - k.start) };
    acc = seg.out_end;
    return seg;
  });
  // Frame-exact output length: whole frames per segment.
  const outFrames = segments.reduce((a, s) => a + Math.round((s.src_end - s.src_start) * fps), 0);

  const removals = [
    ...autoCuts.map((c) => ({ ...c, confidence: "high", applied: true })),
    ...disputed.map((c) => ({ ...c, confidence: "low", applied: false })),
    ...retakeRemovals,
  ].map((r) => ({ ...r, start: round(r.start), end: round(r.end) })).sort((a, b) => a.start - b.start);

  return {
    removals,
    segments,
    stats: {
      sourceSec: round(durationSec), outputSec: round(outFrames / fps), outputFrames: outFrames,
      removedSec: round(durationSec - outFrames / fps), segments: segments.length,
      appliedRemovals: removals.filter((r) => r.applied).length, proposedRemovals: removals.filter((r) => !r.applied).length,
      speechCoveragePct: round(spanTotal(mergeSpans(ws.map((w) => ({ start: w.start, end: w.end })))) / usable * 100, 1),
    },
  };
}

// ── provenance ──────────────────────────────────────────────────────────────

/** Source instant → output instant, or null if that instant was removed. */
export function srcToOut(t, segments) {
  for (const s of segments) if (t >= s.src_start - 1e-6 && t < s.src_end - 1e-9) return round(s.out_start + (t - s.src_start), 6);
  const lastSeg = segments[segments.length - 1];
  if (lastSeg && Math.abs(t - lastSeg.src_end) < 1e-6) return round(lastSeg.out_end, 6);
  return null;
}

/** Output instant → { src, segment } (always defined inside the output duration). */
export function outToSrc(t, segments) {
  for (const s of segments) if (t >= s.out_start - 1e-6 && t < s.out_end - 1e-9) return { src: round(s.src_start + (t - s.out_start), 6), segment: s.id };
  const lastSeg = segments[segments.length - 1];
  if (lastSeg && Math.abs(t - lastSeg.out_end) < 1e-6) return { src: round(lastSeg.src_end, 6), segment: lastSeg.id };
  return null;
}

/** Output-timeline instants where kept segments join (a cut happened). */
export const joinPoints = (segments) => segments.slice(1).map((s) => round(s.out_start, 6));

/**
 * Map source words onto the output timeline. A word whose start lies in a removed span is DROPPED
 * (emitting it at a clamped time is how captions show sentences no longer in the video). A word
 * whose tail was cut is clipped at the join.
 */
export function rebaseWords(words, segments) {
  const out = [];
  for (const w of words) {
    const s = segments.find((k) => w.start >= k.src_start - 1e-6 && w.start < k.src_end - 1e-6);
    if (!s) continue;
    const start = s.out_start + (w.start - s.src_start);
    const end = s.out_start + Math.min(s.src_end - s.src_start, w.end - s.src_start);
    if (end - start <= 1e-4) continue;
    out.push({ ...w, src_start: w.start, src_end: w.end, start: round(start), end: round(end), segment: s.id });
  }
  for (let i = 1; i < out.length; i++) {
    if (out[i].start < out[i - 1].start - 1e-6) throw new Error(`rebaseWords: non-monotonic output times at word ${i}`);
  }
  return out;
}
