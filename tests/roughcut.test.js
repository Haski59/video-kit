/** Rough cut: dead air, fillers, audio veto, retake guard, frame snapping, provenance. */
import test from "node:test";
import assert from "node:assert/strict";
import { planRoughCut, mergeSpans, invertSpans, snapToFrames, srcToOut, outToSrc, rebaseWords, findRetakeCandidates, guardRetake, joinPoints } from "../engine/rough-cut/cuts.js";
import { wordsFrom } from "./fixtures/plan-fixture.mjs";

const audibleOf = (ws) => ws.map((w) => ({ start: w.start - 0.02, end: w.end + 0.02 }));

test("span maths: merge, invert", () => {
  assert.deepEqual(mergeSpans([{ start: 2, end: 3 }, { start: 0, end: 1 }, { start: 0.5, end: 1.5 }]).map((s) => [s.start, s.end]), [[0, 1.5], [2, 3]]);
  assert.deepEqual(invertSpans([{ start: 1, end: 2 }], 5), [{ start: 0, end: 1 }, { start: 2, end: 5 }]);
});

test("a long pause is SHORTENED to keepGapSec, not closed; normal breaths are untouched", () => {
  const ws = wordsFrom([["one"], ["two", 2.0], ["three"], ["four", 0.4], ["five"]]);
  const rc = planRoughCut({ words: ws, durationSec: ws.at(-1).end + 0.3, fps: 30, audibleSpans: audibleOf(ws), pacing: { maxGapSec: 0.6, keepGapSec: 0.25 } });
  const dead = rc.removals.filter((r) => r.kind === "deadAir" && r.applied && /pause/.test(r.reason));
  assert.equal(dead.length, 1, "only the 2s pause is cut, not the 0.4s breath");
  const gapBefore = ws[2].start - ws[1].end;
  assert.ok(Math.abs((gapBefore - (dead[0].end - dead[0].start)) - 0.25) < 0.01, "0.25s of the pause remains");
});

test("fillers are removed; dead air that reads as audible is refused (two signals must agree)", () => {
  const ws = wordsFrom([["so"], ["um"], ["the"], ["point", 1.5], ["is"]]);
  const dur = ws.at(-1).end + 0.3;
  const noisy = [{ start: 0, end: dur }]; // waveform says sound everywhere
  const rc = planRoughCut({ words: ws, durationSec: dur, fps: 30, audibleSpans: noisy });
  assert.ok(rc.removals.some((r) => r.kind === "filler" && r.applied));
  const disputed = rc.removals.find((r) => r.kind === "disputed");
  assert.ok(disputed && !disputed.applied, "audible 'dead air' is kept and reported as disputed");
});

test("segments are whole frames, contiguous on the output, and never pass the source's last frame", () => {
  const ws = wordsFrom([["a"], ["b", 1.3], ["c"], ["d"]]);
  const dur = 3.3333; // not on the 30fps grid
  const rc = planRoughCut({ words: ws, durationSec: dur, fps: 30, audibleSpans: audibleOf(ws) });
  for (const s of rc.segments) {
    const f = (s.src_end - s.src_start) * 30;
    assert.ok(Math.abs(f - Math.round(f)) < 1e-6, "whole frames");
  }
  rc.segments.slice(1).forEach((s, i) => assert.ok(Math.abs(s.out_start - rc.segments[i].out_end) < 1e-9));
  assert.ok(rc.segments.at(-1).src_end <= Math.floor(dur * 30) / 30 + 1e-9, "no phantom frame past the source");
  assert.equal(rc.stats.outputFrames, rc.segments.reduce((a, s) => a + Math.round((s.src_end - s.src_start) * 30), 0));
});

test("snapToFrames rounds start down and end up (only ever keeps more)", () => {
  const [s] = snapToFrames([{ start: 1.01, end: 1.99 }], 30);
  assert.ok(s.start <= 1.01 && s.end >= 1.99);
});

test("provenance: src→out→src round trip, and removed instants map to null", () => {
  const ws = wordsFrom([["a"], ["b", 2.0], ["c"]]);
  const rc = planRoughCut({ words: ws, durationSec: ws.at(-1).end + 0.3, fps: 30, audibleSpans: audibleOf(ws) });
  for (const t of [ws[0].start, ws[2].start + 0.1]) {
    const o = srcToOut(t, rc.segments);
    assert.ok(o !== null);
    assert.ok(Math.abs(outToSrc(o, rc.segments).src - t) < 1e-6);
  }
  const removed = rc.removals.find((r) => r.applied && r.kind === "deadAir" && r.start > ws[0].end);
  assert.equal(srcToOut((removed.start + removed.end) / 2, rc.segments), null);
});

test("rebaseWords drops words inside a cut and keeps output order", () => {
  const segs = [{ id: "seg1", src_start: 0, src_end: 1, out_start: 0, out_end: 1 }, { id: "seg2", src_start: 2, src_end: 3, out_start: 1, out_end: 2 }];
  const out = rebaseWords([{ text: "a", start: 0.2, end: 0.4 }, { text: "cut", start: 1.5, end: 1.7 }, { text: "b", start: 2.1, end: 2.3 }], segs);
  assert.deepEqual(out.map((w) => [w.text, w.start]), [["a", 0.2], ["b", 1.1]]);
  assert.deepEqual(joinPoints(segs), [1]);
});

test("retake guard applies a clean repeat but NOT a whisper loop (second copy silent)", () => {
  const ws = wordsFrom([["So"], ["the"], ["first"], ["thing", 0.6], ["So"], ["the"], ["first"], ["thing"], ["is"], ["sales."]]);
  const [c] = findRetakeCandidates(ws, { minRun: 4 });
  assert.equal(c.detector, "repeat");
  assert.equal(guardRetake(c, ws, { audibleSpans: audibleOf(ws) }).applied, true);
  const onlyFirstAudible = audibleOf(ws.slice(0, 4));
  const v = guardRetake(c, ws, { audibleSpans: onlyFirstAudible });
  assert.equal(v.applied, false);
  assert.match(v.why.join(" "), /not clearly audible|whisper loop/);
  assert.equal(guardRetake(c, ws, { audibleSpans: null }).applied, false, "no audio map → never auto-applied");
});

test("short false start after a pause is detected; 'sorry' without a restart is not auto-cut", () => {
  const fs1 = wordsFrom([["You"], ["need", 0.5], ["You"], ["need"], ["to"], ["sell."]]);
  const c = findRetakeCandidates(fs1).find((x) => x.detector === "false-start");
  assert.ok(c, "false start found");
  const sorry = wordsFrom([["I'm"], ["sorry"], ["it"], ["took"], ["so"], ["long."]]);
  const m = findRetakeCandidates(sorry).find((x) => x.detector === "marker");
  assert.ok(m);
  assert.equal(guardRetake(m, sorry, { audibleSpans: audibleOf(sorry) }).applied, false);
});

test("unapplied retakes stay in the plan as proposals; nothing is silently lost", () => {
  const ws = wordsFrom([["So"], ["the"], ["first"], ["thing", 0.6], ["So"], ["the"], ["first"], ["thing"], ["is"], ["sales."]]);
  const rc = planRoughCut({ words: ws, durationSec: ws.at(-1).end + 0.3, fps: 30, audibleSpans: null, retakes: {} });
  const r = rc.removals.find((x) => x.kind === "retake");
  assert.equal(r.applied, false);
  assert.ok(r.why.length > 0);
});

test("refuses a plan that would delete most of the material (transcript is probably wrong)", () => {
  const ws = wordsFrom([["a", 20], ["b"]]);
  assert.throws(() => planRoughCut({ words: ws, durationSec: 25, fps: 30, audibleSpans: [] }), /ceiling/);
});

test("--range: everything outside the range is a 'range' removal", () => {
  const ws = wordsFrom([["a"], ["b"], ["c"], ["d"], ["e"], ["f"]]);
  const rc = planRoughCut({ words: ws, durationSec: 3, fps: 30, audibleSpans: audibleOf(ws), range: { start: ws[2].start - 0.1, end: ws[4].end + 0.1 } });
  assert.ok(rc.removals.some((r) => r.kind === "range" && r.start === 0));
  assert.ok(rc.segments[0].src_start >= ws[2].start - 0.2);
});
