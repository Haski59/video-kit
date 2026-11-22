/**
 * engine/rough-cut/speech-edges.js — put every cut inside a real pause, measured from the audio.
 *
 * Word timestamps from any transcriber are off by tens of milliseconds, and a cut placed on them can
 * clip the first consonant of the next word or the tail of the last one. This pass moves each join
 * to the quietest frame of the measured pause around it, using the waveform (not the transcript):
 *
 *   envelope   10 ms RMS in dB; floor = 10th percentile; speech threshold = floor + 6 dB
 *   pause      a run of frames under the threshold lasting ≥ 90 ms
 *   out-cut    quietest frame 0.08–0.30 s into the pause after the last kept word,
 *              and ≥ 0.10 s before the next speech
 *   in-cut     quietest frame in the last 0.30 s before the next kept speech starts,
 *              ≥ 0.08 s into its pause
 *
 * An edge with no such pause is left where it was and reported as unsafe, so QA asks a person to
 * listen instead of passing it silently. auditEdges() is the QA side: it measures the level right at
 * each cut in the final plan.
 */
import fs from "node:fs";

export const HOP = 0.01;
export const SPEECH_DB = 6;
export const MIN_PAUSE = 0.09;
export const OUT_MIN = 0.08, OUT_MAX = 0.30, CLEARANCE = 0.10;
export const IN_WINDOW = 0.30, IN_MIN = 0.08;
const r6 = (n) => Number(n.toFixed(6));

/** 16-bit PCM WAV → Float32 mono samples + rate. Reads the RIFF chunks directly. */
export function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${file} is not a WAV file`);
  let off = 12, fmt = null;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4), size = b.readUInt32LE(off + 4), body = off + 8;
    if (id === "fmt ") fmt = { channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    if (id === "data") {
      if (!fmt || fmt.bits !== 16) throw new Error(`${file}: only 16-bit PCM is supported`);
      const end = Math.min(b.length, body + size), frames = Math.floor((end - body) / (2 * fmt.channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < fmt.channels; c++) s += b.readInt16LE(body + 2 * (i * fmt.channels + c));
        out[i] = s / fmt.channels / 32768;
      }
      return { samples: out, rate: fmt.rate };
    }
    off = body + size + (size % 2);
  }
  throw new Error(`${file}: no data chunk`);
}

/** 10 ms RMS envelope in dB (rounded to 0.1 so it can be stored in analysis.json). */
export function envelopeDb({ samples, rate }) {
  const n = Math.round(rate * HOP), out = [];
  for (let i = 0; i + n <= samples.length; i += n) {
    let s = 0;
    for (let j = i; j < i + n; j++) s += samples[j] * samples[j];
    out.push(Number((10 * Math.log10(s / n + 1e-12)).toFixed(1)));
  }
  return out;
}

export function speechThreshold(env) {
  const sorted = [...env].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? -90;
  return { floor, thr: floor + SPEECH_DB };
}

/** Pauses (runs under the threshold, ≥ MIN_PAUSE) in envelope time: [{start, end}] seconds. */
export function findPauses(env, thr) {
  const out = [];
  let s = null;
  for (let i = 0; i <= env.length; i++) {
    const quiet = i < env.length && env[i] < thr;
    if (quiet && s === null) s = i;
    if (!quiet && s !== null) {
      if ((i - s) * HOP >= MIN_PAUSE - 1e-9) out.push({ start: r6(s * HOP), end: r6(i * HOP) });
      s = null;
    }
  }
  return out;
}

/** Mean level (dB) of the envelope over [a, b] seconds. */
export function levelDb(env, a, b) {
  const i0 = Math.max(0, Math.floor(a / HOP)), i1 = Math.min(env.length, Math.max(i0 + 1, Math.ceil(b / HOP)));
  let s = 0;
  for (let i = i0; i < i1; i++) s += 10 ** (env[i] / 10);
  return 10 * Math.log10(s / Math.max(1, i1 - i0) + 1e-12);
}

/** Source-frame-grid time in [lo, hi] (envelope time) with the quietest 60 ms; ties go closest to `prefer`. */
function quietestFrame(env, lo, hi, fps, prefer, offset) {
  let best = null;
  for (let f = Math.ceil((lo + offset) * fps - 1e-6); f / fps - offset <= hi + 1e-9; f++) {
    const t = f / fps - offset, l = levelDb(env, t - 0.03, t + 0.03);
    if (!best || l < best.l - 0.05 || (Math.abs(l - best.l) <= 0.05 && Math.abs(t - prefer) < Math.abs(best.t - prefer))) best = { t, l };
  }
  return best;
}

/**
 * Move each internal join of `segments` into its pause. `offset` = source time of envelope index 0
 * (a --range job's WAV starts at range.start). Returns { segments, edges } — edges[k] describes join k.
 */
export function refineEdges({ segments, env, fps, offset = 0 }) {
  if (!env?.length || segments.length < 2) return { segments, edges: [] };
  const { thr, floor } = speechThreshold(env);
  const pauses = findPauses(env, thr);
  const loc = (t) => t - offset, src = (t) => r6(t + offset);
  const segs = segments.map((s) => ({ ...s }));
  const edges = [];
  for (let k = 0; k < segs.length - 1; k++) {
    const A = segs[k], B = segs[k + 1];
    const E = loc(A.src_end), S = loc(B.src_start);
    const edge = { join: k + 1, before: { out: A.src_end, in: B.src_start } };
    // OUT: the pause that starts at (or just after) the end of the last kept speech.
    const pOut = pauses.find((p) => p.end > E - 0.10 && p.start < E + OUT_MAX);
    let outT = null;
    if (pOut) {
      const lo = Math.max(pOut.start + OUT_MIN, E - 0.10), hi = Math.min(pOut.start + OUT_MAX, pOut.end - CLEARANCE, S - 2 / fps);
      if (hi >= lo) outT = quietestFrame(env, lo, hi, fps, E, offset);
    }
    // IN: the pause that ends at the next kept speech onset.
    const pIn = [...pauses].reverse().find((p) => p.start < S + 0.10 && p.end > S - IN_WINDOW);
    let inT = null;
    if (pIn) {
      const onset = pIn.end;
      const lo = Math.max(pIn.start + IN_MIN, onset - IN_WINDOW, (outT ? outT.t : E) + 2 / fps), hi = Math.min(onset - 0.03, S + 0.10);
      if (hi >= lo) inT = quietestFrame(env, lo, hi, fps, S, offset);
    }
    if (outT) A.src_end = src(outT.t);
    if (inT) B.src_start = src(inT.t);
    edge.after = { out: A.src_end, in: B.src_start };
    edge.out = outT ? "pause" : "unsafe";
    edge.in = inT ? "pause" : "unsafe";
    edges.push(edge);
  }
  // Re-derive the output timeline.
  let acc = 0;
  for (const s of segs) {
    s.out_start = r6(acc);
    acc += s.src_end - s.src_start;
    s.out_end = r6(acc);
  }
  return { segments: segs, edges, threshold: { floorDb: floor, speechDb: thr } };
}

/**
 * QA: the level right at each cut of the final plan, against the original recording.
 *   PASS    both sides at or under the speech threshold (the cut is in silence)
 *   REVIEW  up to 6 dB over — breath or room tone, possibly a soft word edge: a person should listen
 *   FAIL    more than 6 dB over — speech is being cut
 */
export function auditEdges({ segments, env, offset = 0, fps }) {
  if (!env?.length) return { status: "skip", detail: "no audio envelope", joins: [] };
  const { thr } = speechThreshold(env);
  const joins = [];
  for (let k = 0; k < segments.length - 1; k++) {
    const E = segments[k].src_end - offset, S = segments[k + 1].src_start - offset;
    const outDb = levelDb(env, E - 0.03, E), inDb = levelDb(env, S, S + 0.03);
    const over = Math.max(outDb, inDb) - thr;
    const verdict = over <= 0 ? "PASS" : over <= 6 ? "REVIEW" : "FAIL";
    joins.push({ join: k + 1, at: r6(segments[k].out_end), outDb: Number(outDb.toFixed(1)), inDb: Number(inDb.toFixed(1)), thresholdDb: Number(thr.toFixed(1)), verdict });
  }
  const status = joins.some((j) => j.verdict === "FAIL") ? "fail" : joins.some((j) => j.verdict === "REVIEW") ? "warn" : "pass";
  return { status, joins, fps };
}

/**
 * Word timestamps from whisper often stretch across a silence (a word "starts" 1.5 s early, during
 * the pause before it). The waveform is the truth: a word edge that falls inside a measured pause of
 * at least `minPauseSec` is moved to that pause's edge. Words are never moved INTO speech, never
 * shortened below `minWordSec`, and never reordered. Returns { words, moved }.
 */
export function snapWordsToAudio(words, env, { offset = 0, minPauseSec = 0.25, minWordSec = 0.06 } = {}) {
  if (!env?.length) return { words, moved: 0 };
  const { thr } = speechThreshold(env);
  const pauses = findPauses(env, thr).filter((p) => p.end - p.start >= minPauseSec).map((p) => ({ start: p.start + offset, end: p.end + offset }));
  let moved = 0;
  const out = words.map((w) => {
    let { start, end } = w;
    const ps = pauses.find((p) => start > p.start && start < p.end);
    if (ps && end - ps.end >= minWordSec) start = ps.end;
    const pe = pauses.find((p) => end > p.start && end < p.end);
    if (pe && pe.start - start >= minWordSec) end = pe.start;
    if (start !== w.start || end !== w.end) { moved++; return { ...w, start: r6(start), end: r6(end), timing: "snapped-to-audio" }; }
    return w;
  });
  return { words: out, moved };
}
