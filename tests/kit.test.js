// Unit tests for the kit's own additions: speech-safe edges, clip finding, long-form IDs, brand, SRT, thumbnail layout.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { envelopeDb, speechThreshold, findPauses, refineEdges, auditEdges, readWav, snapWordsToAudio, HOP } from "../engine/rough-cut/speech-edges.js";
import { sentences, windows, heuristicPick, checkPicks, findClips, scoreWindow } from "../engine/clips/find.js";
import { registerShort, loadRegistry } from "../engine/ingest/identity.js";
import { applyBrand, loadProfile } from "../engine/profiles/load.js";
import { buildSrt } from "../engine/captions/srt.js";
import { layoutText, bestFrame } from "../engine/thumbnail/make.js";
import { parseArgs } from "../engine/cli.js";
import { REPO_ROOT } from "../engine/storage/files.js";

/** Envelope (dB per 10 ms) from a list of [startSec, endSec, dB] blocks over a −70 dB floor. */
function env(durSec, blocks) {
  const e = new Array(Math.round(durSec / HOP)).fill(-70);
  for (const [a, b, db] of blocks) for (let i = Math.round(a / HOP); i < Math.round(b / HOP); i++) e[i] = db;
  return e;
}
const seg = (id, a, b) => ({ id, src_start: a, src_end: b, out_start: 0, out_end: 0 });

test("speech edges: threshold = floor + 6 dB, pauses ≥ 90 ms only", () => {
  const e = env(3, [[0.5, 1.0, -20], [1.05, 1.5, -20], [1.7, 2.5, -20]]);
  const { floor, thr } = speechThreshold(e);
  assert.equal(floor, -70);
  assert.equal(thr, -64);
  const p = findPauses(e, thr);
  // 1.00–1.05 (50 ms) is too short to be a pause; 1.5–1.7 is one.
  assert.ok(!p.some((x) => x.start === 1.0));
  assert.ok(p.some((x) => Math.abs(x.start - 1.5) < 1e-6 && Math.abs(x.end - 1.7) < 1e-6));
});

test("speech edges: a join placed on top of a word moves into the pause and never cuts speech", () => {
  // speech 0.5–2.0, pause 2.0–2.6, speech 2.6–4.0 (removed), pause 4.0–4.6, speech 4.6–6.0
  const e = env(7, [[0.5, 2.0, -18], [2.6, 4.0, -18], [4.6, 6.0, -18]]);
  // A transcript-based cut that ends 40 ms into the last word's tail and starts 40 ms late into the next word.
  const segments = [seg("seg1", 0.4, 1.96), seg("seg2", 4.64, 6.2)];
  const before = auditEdges({ segments, env: e, fps: 25 });
  assert.equal(before.joins[0].verdict, "FAIL");
  const { segments: s2, edges } = refineEdges({ segments, env: e, fps: 25 });
  assert.equal(edges[0].out, "pause");
  assert.equal(edges[0].in, "pause");
  assert.ok(s2[0].src_end >= 2.0 + 0.08 - 1e-9 && s2[0].src_end <= 2.6 - 0.10 + 1e-9, `out ${s2[0].src_end}`);
  assert.ok(s2[1].src_start >= 4.6 - 0.30 - 1e-9 && s2[1].src_start <= 4.6 - 0.03 + 1e-9, `in ${s2[1].src_start}`);
  // On the 25 fps grid.
  for (const t of [s2[0].src_end, s2[1].src_start]) assert.ok(Math.abs(t * 25 - Math.round(t * 25)) < 1e-6);
  // Output timeline re-derived and contiguous.
  assert.equal(s2[0].out_start, 0);
  assert.ok(Math.abs(s2[1].out_start - s2[0].out_end) < 1e-9);
  const after = auditEdges({ segments: s2, env: e, fps: 25 });
  assert.equal(after.status, "pass");
});

test("speech edges: no pause near the join → left in place and marked unsafe (a person listens)", () => {
  const e = env(6, [[0.2, 3.8, -18]]); // continuous speech, silence only before/after
  const segments = [seg("seg1", 0.2, 1.6), seg("seg2", 2.4, 3.8)];
  const { segments: s2, edges } = refineEdges({ segments, env: e, fps: 25 });
  assert.equal(edges[0].out, "unsafe");
  assert.equal(edges[0].in, "unsafe");
  assert.equal(s2[0].src_end, 1.6);
  assert.equal(auditEdges({ segments: s2, env: e, fps: 25 }).status, "fail");
});

test("speech edges: breath-level noise at a cut is REVIEW, not PASS", () => {
  const e = env(4, [[0.2, 1.5, -18], [1.5, 1.8, -61], [2.5, 3.8, -18]]);
  const a = auditEdges({ segments: [seg("seg1", 0.2, 1.6), seg("seg2", 2.4, 3.8)], env: e, fps: 25 });
  assert.equal(a.joins[0].verdict, "REVIEW");
  assert.equal(a.status, "warn");
});

test("speech edges: range offset keeps cuts on the source frame grid", () => {
  const e = env(5, [[0.5, 2.0, -18], [2.6, 4.0, -18]]); // envelope starts at source 10.013 s
  const off = 10.013;
  const { segments: s2 } = refineEdges({ segments: [seg("seg1", off + 0.4, off + 1.96), seg("seg2", off + 2.64, off + 4.0)], env: e, fps: 25, offset: off });
  for (const t of [s2[0].src_end, s2[1].src_start]) assert.ok(Math.abs(t * 25 - Math.round(t * 25)) < 1e-6, `${t} not on grid`);
});

test("readWav + envelopeDb read a real 16-bit WAV (tone then silence)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-wav-"));
  const rate = 16000, n = rate; // 1 s: 0.5 s tone, 0.5 s silence
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n / 2; i++) buf.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / rate)), 44 + 2 * i);
  const f = path.join(dir, "t.wav");
  fs.writeFileSync(f, buf);
  const e = envelopeDb(readWav(f));
  assert.equal(e.length, 100);
  assert.ok(e[10] > -20 && e[90] < -100);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── clips ──
const W = (text, start, dur = 0.3) => ({ text, start, end: start + dur });
function talk(n, { gapEvery = 10, start = 0 } = {}) {
  // n words, 0.4 s apart; a full stop every `gapEvery` words.
  return Array.from({ length: n }, (_, i) => W(`w${i}${(i + 1) % gapEvery === 0 ? "." : ""}`, start + i * 0.4));
}

test("clips: sentences split on punctuation and long pauses", () => {
  const s = sentences([W("Hello", 0), W("there.", 0.4), W("Next", 0.8), W("bit", 1.2), W("after", 3.0), W("gap.", 3.4)]);
  assert.deepEqual(s.map((x) => x.text), ["Hello there.", "Next bit", "after gap."]);
});

test("clips: windows are whole sentences within the length bounds", () => {
  const s = sentences(talk(600)); // 240 s, sentences of 4 s
  const ws = windows(s, { minSec: 60, maxSec: 120 });
  assert.ok(ws.length > 0);
  for (const w of ws) assert.ok(w.dur >= 60 && w.dur <= 120);
});

test("clips: heuristic picks don't overlap, prefer clean openings", () => {
  const s = sentences(talk(600));
  const picks = heuristicPick(s, { count: 3, minSec: 60, maxSec: 120 });
  assert.equal(picks.length, 2 <= picks.length ? picks.length : 2);
  for (let i = 1; i < picks.length; i++) assert.ok(picks[i].start >= picks[i - 1].end);
  const sents = [{ text: "And so that's it." , start: 0, end: 60 }, { text: "You need this.", start: 0, end: 60 }];
  assert.ok(scoreWindow({ a: 1, b: 1, dur: 90 }, sents) > scoreWindow({ a: 0, b: 0, dur: 90 }, sents));
});

test("clips: model picks are bounds-checked; bad ranges and overlaps are dropped", () => {
  const s = sentences(talk(600));
  const { clips, errors } = checkPicks([
    { first: 0, last: 21, title: "ok" },          // 0–~88 s
    { first: 5, last: 30, title: "overlaps" },
    { first: 40, last: 41, title: "too short" },
    { first: 99, last: 9999, title: "bad" },
  ], s, { count: 3, minSec: 60, maxSec: 120 });
  assert.equal(clips.length, 1);
  assert.equal(errors.length, 3);
});

test("clips: model failure falls back to the heuristic, never throws", () => {
  const r = findClips(talk(600), { count: 2, runner: () => { throw new Error("offline"); } });
  assert.ok(r.clips.length >= 1);
  assert.ok(r.notes.some((n) => /heuristic used/.test(n)));
  assert.ok(r.clips.every((c) => c.picker === "heuristic"));
});

test("clips: a recording shorter than one clip returns no clips and says why", () => {
  const r = findClips(talk(50), { count: 2, runner: () => ({ text: "[]" }) });
  assert.equal(r.clips.length, 0);
  assert.match(r.notes[0], /shorter than one/);
});

// ── identity ──
test("identity: long-form gets L### and its own counter, separate from S###", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-reg-"));
  const file = path.join(dir, "registry.json");
  const src = { sha256: "a".repeat(64), filename: "x.mov" };
  const s1 = registerShort({ registryFile: file, source: src, type: "reel" });
  const l1 = registerShort({ registryFile: file, source: src, type: "long" });
  const s2 = registerShort({ registryFile: file, source: { ...src, sha256: "b".repeat(64) }, type: "reel" });
  assert.deepEqual([s1.id, l1.id, s2.id], ["S001", "L001", "S002"]);
  // Same source as a short and as a long-form edit are two different jobs.
  assert.equal(registerShort({ registryFile: file, source: src, type: "long" }).id, "L001");
  assert.equal(Object.keys(loadRegistry(file).shorts).length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── brand / srt / thumbnail / cli ──
test("brand: member font and accent override the profile's caption style, timings untouched", () => {
  const { profile } = loadProfile("SHORT_TALKING_HEAD", { root: REPO_ROOT });
  const b = applyBrand(profile, { captionFont: "Helvetica Neue", accent: "#ff0000" });
  assert.equal(b.captions.font, "Helvetica Neue");
  assert.equal(b.captions.emphasisColour, "#ff0000");
  assert.equal(b.captions.maxWords, profile.captions.maxWords);
  assert.equal(applyBrand(profile, null), profile);
});

test("srt: cues become numbered SubRip blocks with millisecond times", () => {
  const srt = buildSrt([{ start: 0, end: 1.25, words: [{ text: "Hello" }, { text: "there" }] }, { start: 61.5, end: 3725.004, words: [{ text: "Bye" }] }]);
  assert.equal(srt, "1\n00:00:00,000 --> 00:00:01,250\nHello there\n\n2\n00:01:01,500 --> 01:02:05,004\nBye\n");
});

test("thumbnail: text layout — 2 words a line, accent on the number or longest word", () => {
  assert.deepEqual(layoutText("STOP CHASING CLIENTS").lines, [["STOP", "CHASING"], ["CLIENTS"]]);
  assert.equal(layoutText("STOP CHASING CLIENTS").accent, 1);
  assert.equal(layoutText("MY FIRST $10K").accent, 2);
});

test("thumbnail: best frame = biggest clear face not touching the edge", () => {
  const d = [
    { t: 1, faces: [{ x: 0.4, y: 0.2, w: 0.2, h: 0.3, c: 0.9 }] },
    { t: 2, faces: [{ x: 0.0, y: 0.2, w: 0.4, h: 0.5, c: 0.9 }] }, // touches the edge
    { t: 3, faces: [{ x: 0.5, y: 0.2, w: 0.3, h: 0.4, c: 0.9 }] },
    { t: 4, faces: [{ x: 0.5, y: 0.2, w: 0.35, h: 0.45, c: 0.3 }] }, // low confidence
  ];
  assert.equal(bestFrame(d, 10).t, 3);
  assert.equal(bestFrame([{ t: 1, faces: [] }], 10), null);
});

test("cli: arguments parse with flags and values", () => {
  assert.deepEqual(parseArgs(["clips", "a.mov", "--count", "2", "--json"]), { _: ["clips", "a.mov"], count: "2", json: true });
});

test("word timing: a word smeared across a silence is snapped to the silence's edge; speech words untouched", () => {
  const e = env(6, [[0.5, 2.0, -18], [3.8, 5.0, -18]]); // pause 2.0–3.8
  const words = [
    { text: "before", start: 1.5, end: 2.0 },
    { text: "First,", start: 2.2, end: 4.1 },   // whisper put the start 1.6 s early, inside the pause
    { text: "after", start: 4.2, end: 4.9 },
  ];
  const { words: w, moved } = snapWordsToAudio(words, e);
  assert.equal(moved, 1);
  assert.equal(w[1].start, 3.8);
  assert.equal(w[1].end, 4.1);
  assert.deepEqual(w[0], words[0]);
  assert.deepEqual(w[2], words[2]);
});

test("member overrides: --keep protects a span from every automatic cut; --cut forces a removal", async () => {
  const { planRoughCut } = await import("../engine/rough-cut/cuts.js");
  const words = [W("one", 0.2), W("two", 0.6), W("three", 3.0), W("four", 3.4), W("five", 6.0), W("six", 6.4)];
  const base = planRoughCut({ words, durationSec: 7, fps: 25, pacing: { maxGapSec: 0.6, keepGapSec: 0.25, maxRemovedFraction: 0.95 } });
  assert.ok(base.removals.some((r) => r.applied && r.kind === "deadAir" && r.start < 2 && r.end > 1.5));
  const kept = planRoughCut({ words, durationSec: 7, fps: 25, pacing: { maxGapSec: 0.6, keepGapSec: 0.25, maxRemovedFraction: 0.95 }, protect: [{ start: 1.0, end: 2.5 }] });
  assert.ok(!kept.removals.some((r) => r.applied && r.start < 2.5 && r.end > 1.0), "nothing applied inside the kept span");
  assert.ok(kept.removals.some((r) => r.kind === "kept" && !r.applied));
  const cut = planRoughCut({ words, durationSec: 7, fps: 25, pacing: { maxGapSec: 0.6, keepGapSec: 0.25, maxRemovedFraction: 0.95 }, force: [{ start: 2.9, end: 3.8 }] });
  assert.ok(cut.removals.some((r) => r.kind === "manual" && r.applied));
});

test("cli: spans and times parse; bad input is refused with a reason", async () => {
  const { parseSpans, parseTime } = await import("../engine/cli.js");
  assert.deepEqual(parseSpans("120-125.5, 300-302"), [{ start: 120, end: 125.5 }, { start: 300, end: 302 }]);
  assert.throws(() => parseSpans("5-3"), /start-end/);
  assert.equal(parseTime("2:03"), 123);
  assert.equal(parseTime("1:02:03"), 3723);
  assert.equal(parseTime("45.5"), 45.5);
});

test("captions: words the transcriber stacked on one start time are spread out, never dropped", async () => {
  const { groupCaptions } = await import("../engine/captions/group.js");
  const ws = [["off.", 114.54, 115.15], ["And", 115.57, 115.62], ["when", 115.57, 115.62], ["you", 115.57, 115.7], ["pull", 115.7, 115.85], ["it", 115.85, 115.95], ["off,", 115.95, 116.25], ["people", 116.25, 116.55]]
    .map(([text, start, end]) => ({ text, start, end }));
  const cues = groupCaptions(ws, { style: { maxWords: 2, minWords: 2, maxLines: 1, maxCharsPerLine: 13, maxCueSec: 1.1, minCueSec: 0.3 } });
  const got = cues.flatMap((c) => c.words.map((w) => w.text));
  assert.deepEqual(got, ws.map((w) => w.text));
  for (let i = 1; i < cues.length; i++) assert.ok(cues[i].start >= cues[i - 1].start && cues[i - 1].end > cues[i - 1].start);
});
