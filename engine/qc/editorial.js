/**
 * engine/qc/editorial.js — is the EDIT right? Evidence from transcript + plan + the render.
 *
 *   word_survival     every source word is either in the video or inside a reasoned removal (pure)
 *   unreviewed_retake a retake the guard would not auto-apply is still in the video     → NEEDS_REVIEW
 *   duplicate_phrase  a 4+ word phrase repeats within 3s in the final words            → NEEDS_REVIEW
 *   round_trip        re-transcribe the render; compare with the captions at that time  (ported)
 *   caption_timing    cues sit on their words; nothing past the end; density readable
 *   captions_visible  text is actually burned in (edge energy in the caption band)      (ported)
 *   face_vs_text      Vision on RENDERED frames: face present, uncut, and clear of captions/graphics
 *   punch_in_reason   every punch-in points at a candidate spoken inside it
 *
 * Checks return { id, status, detail, repair? }; `skipped` never counts as a pass.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { probeEnv } from "../env.js";
import { normalizeWord } from "../transcription/words.js";
import { cueText } from "../captions/group.js";
import { boxesOverlap } from "../geometry/transform.js";
import { detectFaces } from "../analysis/visual.js";

const pass = (id, detail, extra = {}) => ({ id, status: "pass", detail, ...extra });
const fail = (id, detail, repair = null, extra = {}) => ({ id, status: "fail", detail, ...(repair ? { repair } : {}), ...extra });
const warn = (id, detail, extra = {}) => ({ id, status: "warn", detail, ...extra });
const skip = (id, detail) => ({ id, status: "skipped", detail });

// ── pure ────────────────────────────────────────────────────────────────────

export function wordSurvival({ sourceWords, plan }) {
  const segs = plan.rough_cut.segments;
  const applied = plan.rough_cut.removals.filter((r) => r.applied);
  const lost = sourceWords.filter((w) => {
    if (segs.some((s) => w.start >= s.src_start - 1e-6 && w.start < s.src_end - 1e-6)) return false;
    const len = w.end - w.start;
    const covered = applied.reduce((a, r) => a + Math.max(0, Math.min(r.end, w.end) - Math.max(r.start, w.start)), 0);
    return covered < 0.5 * len;
  });
  const capWords = plan.captions.cues.reduce((a, c) => a + c.words.length, 0);
  const keptWords = sourceWords.filter((w) => segs.some((s) => w.start >= s.src_start - 1e-6 && w.start < s.src_end - 1e-6)).length;
  if (lost.length) return fail("word_survival", `${lost.length} word(s) vanished without a reasoned removal: "${lost.slice(0, 8).map((w) => w.text).join(" ")}"`);
  if (capWords !== keptWords) return fail("word_survival", `captions carry ${capWords} words but ${keptWords} survive the cut`, "regroup_captions");
  return pass("word_survival", `${keptWords} kept words all captioned; every removal reasoned`);
}

export function unreviewedRetakes(plan) {
  // Only unapplied RETAKES need a human. A "disputed" dead-air cut was refused because the waveform
  // says there is sound there — keeping it is the safe default, so it is not a review item.
  const open = plan.rough_cut.removals.filter((r) => !r.applied && ["retake", "falseStart"].includes(r.kind));
  if (!open.length) return pass("unreviewed_retake", "no unresolved retakes");
  return fail("unreviewed_retake", `${open.length} possible retake(s) left in for a human: ${open.slice(0, 3).map((r) => `${r.start.toFixed(1)}s ${r.reason} (${(r.why ?? []).join("; ")})`).join(" · ")}`);
}

export function duplicatePhrases(plan, { n = 4, windowSec = 3 } = {}) {
  const words = plan.captions.cues.flatMap((c) => c.words);
  const norm = words.map((w) => normalizeWord(w.text));
  const hits = [];
  for (let i = 0; i + n <= words.length; i++) {
    const g = norm.slice(i, i + n).join(" ");
    if (norm.slice(i, i + n).some((x) => !x)) continue;
    for (let j = i + n; j + n <= words.length && words[j].start - words[i + n - 1].end <= windowSec; j++) {
      if (norm.slice(j, j + n).join(" ") === g) { hits.push({ at: words[j].start, phrase: words.slice(j, j + n).map((w) => w.text).join(" ") }); break; }
    }
  }
  return hits.length ? fail("duplicate_phrase", `repeated phrase(s): ${hits.slice(0, 3).map((h) => `"${h.phrase}" at ${h.at.toFixed(1)}s`).join(", ")}`)
    : pass("duplicate_phrase", "no immediate repeats");
}

export function captionTiming(plan, profile) {
  const cues = plan.captions.cues;
  const dur = plan.rough_cut.segments[plan.rough_cut.segments.length - 1].out_end;
  const issues = [];
  let dense = 0;
  cues.forEach((c, i) => {
    if (Math.abs(c.start - c.words[0].start) > 0.05) issues.push(`cue ${i} starts ${(c.start - c.words[0].start).toFixed(2)}s off its first word`);
    if (c.end < c.words[c.words.length - 1].end - 0.05) issues.push(`cue ${i} ends before its last word`);
    if (c.end > dur + 1e-3) issues.push(`cue ${i} runs past the end`);
    const wps = c.words.length / Math.max(0.01, c.end - c.start);
    if (wps > profile.captions.maxWordsPerSec) dense++;
  });
  if (issues.length) return fail("caption_timing", issues.slice(0, 4).join("; "), "regroup_captions");
  if (dense > Math.max(1, cues.length * 0.15)) return fail("caption_density", `${dense} of ${cues.length} cues exceed ${profile.captions.maxWordsPerSec} words/s`, "regroup_captions");
  return pass("caption_timing", `${cues.length} cues on their words; ${dense} dense`);
}

export function punchInReasons(plan, candidates) {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const bad = plan.punch_ins.filter((p) => {
    const c = byId.get(p.candidate);
    return !c || !(c.out_end > p.out_start - 0.5 && c.out_start < p.out_end + 0.5);
  });
  return bad.length ? fail("punch_in_reason", `${bad.map((p) => p.id).join(", ")} not tied to a spoken candidate`, "drop_unjustified_punch_ins", { punchIns: bad.map((p) => p.id) })
    : pass("punch_in_reason", `${plan.punch_ins.length} punch-in(s), each on a spoken candidate`);
}

export function textSimilarity(a, b) {
  const t = (s) => String(s).split(/\s+/).map(normalizeWord).filter(Boolean);
  const A = t(a), B = t(b);
  if (!A.length && !B.length) return 1;
  if (!A.length || !B.length) return 0;
  const pool = [...B];
  let hit = 0;
  for (const w of A) { const i = pool.indexOf(w); if (i !== -1) { hit++; pool.splice(i, 1); } }
  return (2 * hit) / (A.length + B.length);
}

// ── measured on the render ──────────────────────────────────────────────────

function ff(args) {
  const { ffmpeg } = probeEnv();
  const r = spawnSync(ffmpeg, ["-hide_banner", "-nostats", ...args], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg: ${String(r.stderr).trim().split("\n").slice(-3).join(" | ")}`);
  return r;
}

/** Cue-anchored windows (ported): heard and shown are the same span by construction. */
export function roundTrip({ video, cues, durationSec, tempDir, samples = 4, windowSec = 12, minSimilarity = 0.6, padSec = 0.35 }) {
  if (!cues.length) return skip("round_trip", "no captions to compare");
  const env = probeEnv();
  const windows = [];
  for (let i = 0; i < cues.length;) {
    let j = i;
    while (j + 1 < cues.length && cues[j + 1].end - cues[i].start <= windowSec) j++;
    windows.push({ from: i, to: j, start: cues[i].start, end: cues[j].end });
    i = j + 1;
  }
  const step = Math.max(1, Math.floor(windows.length / samples));
  const chosen = [];
  for (let k = 0; k < windows.length && chosen.length < samples; k += step) chosen.push(windows[k]);
  const results = [];
  chosen.forEach((w, i) => {
    const from = Math.max(0, w.start - padSec), to = Math.min(durationSec, w.end + padSec);
    if (to - from < 0.5) return;
    const wav = path.join(tempDir, `rt${i}.wav`);
    ff(["-y", "-v", "error", "-ss", from.toFixed(3), "-t", (to - from).toFixed(3), "-i", video, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
    const prefix = path.join(tempDir, `rt${i}`);
    const r = spawnSync(env.whisper, ["-m", env.model, "-f", wav, "-oj", "-of", prefix, "-np", "-l", "en"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`round trip: whisper failed on window ${i}`);
    const heard = (JSON.parse(fs.readFileSync(`${prefix}.json`, "utf8")).transcription ?? []).map((s) => s.text).join(" ");
    const shown = cues.slice(w.from, w.to + 1).map(cueText).join(" ");
    results.push({ atSec: Number(w.start.toFixed(2)), similarity: Number(textSimilarity(heard, shown).toFixed(3)), heard: heard.trim().slice(0, 140), shown: shown.slice(0, 140) });
  });
  if (!results.length) return skip("round_trip", "no usable window");
  const worst = Math.min(...results.map((r) => r.similarity));
  const mean = results.reduce((a, r) => a + r.similarity, 0) / results.length;
  const detail = `worst ${worst.toFixed(3)} / mean ${mean.toFixed(3)} over ${results.length} windows`;
  return worst >= minSimilarity ? pass("round_trip", detail, { results }) : fail("round_trip", `${detail} — heard ≠ shown (bad cut, missing sentence or desync)`, null, { results });
}

/** Grey frame at t → Buffer (width*height bytes). */
function greyFrame(video, t, w, h) {
  return ff(["-v", "error", "-ss", t.toFixed(3), "-i", video, "-frames:v", "1", "-vf", "format=gray", "-f", "rawvideo", "-"]).stdout.subarray(0, w * h);
}

/** Ported edge-energy ink check, on each cue's real caption band vs a control strip above it. */
export function captionsVisible({ video, plan, minRatio = 1.6, samples = 5 }) {
  const cues = plan.captions.cues;
  if (!cues.length) return skip("captions_visible", "no captions planned");
  const { width: W, height: H } = plan.format;
  const band = { y: Math.max(0, Math.round(plan.captions.box.y)), h: Math.round(plan.captions.box.h) };
  const ctrlY = Math.max(0, band.y - band.h - 8);
  const step = Math.max(1, Math.floor(cues.length / samples));
  const ratios = [];
  for (let i = 0; i < cues.length && ratios.length < samples; i += step) {
    const c = cues[i];
    const b = greyFrame(video, (c.start + c.end) / 2, W, H);
    const x0 = Math.max(1, Math.round(plan.captions.box.x)), x1 = Math.min(W, Math.round(plan.captions.box.x + plan.captions.box.w));
    const energy = (y0, h) => {
      let s = 0, n = 0;
      for (let y = y0; y < Math.min(H, y0 + h); y += 2) for (let x = x0; x < x1; x += 2) { s += Math.abs(b[y * W + x] - b[y * W + x - 1]); n++; }
      return n ? s / n : 0;
    };
    const cap = energy(band.y, band.h), ctl = energy(ctrlY, band.h);
    // Floor the control: over a flat background the control strip is ~0 and any ratio explodes or
    // collapses; 0.25 is far below real footage (3–10) and far above an empty flat band (~0).
    ratios.push(cap / Math.max(ctl, 0.25));
  }
  const best = Math.max(...ratios), median = [...ratios].sort((a, b) => a - b)[Math.floor(ratios.length / 2)];
  return median >= minRatio ? pass("captions_visible", `caption band edge energy ${median.toFixed(2)}× control (best ${best.toFixed(2)})`)
    : fail("captions_visible", `caption band only ${median.toFixed(2)}× control — captions may not be burned in`);
}

/**
 * Vision on rendered frames at caption and graphic midpoints. Fails when a face overlaps a visible
 * caption or graphic, when no face is found (broken crop / empty composition), or the face is cut
 * by the frame edge.
 */
export function faceVsText({ video, plan, tempDir, maxSamples = 14, expectFace = true }) {
  const { width: W, height: H } = plan.format;
  const times = [];
  for (const c of plan.captions.cues) times.push({ t: (c.start + c.end) / 2, cue: c });
  for (const g of plan.graphics) times.push({ t: (g.out_start + g.out_end) / 2, graphic: g });
  if (!times.length) return skip("face_vs_text", "no text to check");
  const step = Math.max(1, Math.ceil(times.length / maxSamples));
  const picked = times.filter((_, i) => i % step === 0 || times[i].graphic);
  const dir = path.join(tempDir, "qc-frames");
  fs.mkdirSync(dir, { recursive: true });
  const frames = picked.map((p, i) => {
    const file = path.join(dir, `q${String(i).padStart(4, "0")}.jpg`);
    ff(["-y", "-v", "error", "-ss", p.t.toFixed(3), "-i", video, "-frames:v", "1", "-q:v", "3", file]);
    return { t: p.t, file };
  });
  const det = detectFaces(frames);
  if (!det) return skip("face_vs_text", "Vision unavailable");
  const problems = [], collisions = [];
  let noFace = 0;
  det.forEach((d, i) => {
    const p = picked[i];
    const face = (d.faces ?? []).filter((f) => f.c >= 0.5).sort((a, b) => b.w * b.h - a.w * a.h)[0];
    if (!face) { noFace++; return; }
    const fb = { x: face.x * W, y: face.y * H, w: face.w * W, h: face.h * H };
    if (face.x < 0.01 || face.x + face.w > 0.99 || face.y < 0.005) problems.push(`face cut by the frame edge at ${p.t.toFixed(1)}s`);
    const showing = plan.captions.cues.some((c) => p.t >= c.start && p.t < c.end);
    if (showing && boxesOverlap(fb, plan.captions.box, -2)) collisions.push({ t: p.t, what: "captions" });
    for (const g of plan.graphics) if (p.t >= g.out_start && p.t < g.out_end && boxesOverlap(fb, g.box, -2)) collisions.push({ t: p.t, what: g.id });
  });
  const missing = noFace / det.length;
  // A source with no face (screen recording, B-roll) has nothing to collide with: not verified, not failed.
  if (!expectFace && noFace === det.length) return skip("face_vs_text", "source has no face to protect — text placement not face-checked");
  if (missing > 0.2) problems.push(`no face found in ${(missing * 100).toFixed(0)}% of rendered samples — crop may be wrong`);
  if (collisions.length) {
    const captionHit = collisions.some((c) => c.what === "captions");
    return fail("face_vs_text", `text over the face at ${collisions.slice(0, 4).map((c) => `${c.t.toFixed(1)}s (${c.what})`).join(", ")}`, captionHit ? "move_captions_down" : "drop_colliding_graphics",
      { collisions });
  }
  if (problems.length) return fail("face_vs_text", problems.join("; "));
  return pass("face_vs_text", `face clear of text in ${det.length - noFace}/${det.length} rendered samples`);
}
