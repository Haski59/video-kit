/** QC decisions, the single repair pass, profiles, temp space and parsers. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideOutcome, repairPlan } from "../engine/qc/repair.js";
import { wordSurvival, unreviewedRetakes, duplicatePhrases, captionTiming, punchInReasons, textSimilarity } from "../engine/qc/editorial.js";
import { parseEbur128 } from "../engine/qc/technical.js";
import { parseLoudnormJson } from "../engine/renderer/render.js";
import { audibleFromSilenceLog } from "../engine/analysis/audio.js";
import { loadProfile } from "../engine/profiles/load.js";
import { createRunTemp, sweepStale } from "../engine/storage/temp.js";
import { validatePlan } from "../engine/planner/validate.js";
import { REPO_ROOT } from "../engine/storage/files.js";
import { buildFixture } from "./fixtures/plan-fixture.mjs";

const fx = buildFixture();
const clone = (o) => JSON.parse(JSON.stringify(o));
const P = (id, status, repair) => ({ id, status, detail: id, ...(repair ? { repair } : {}) });

test("outcome: all pass → PASS; skipped is never a pass", () => {
  assert.equal(decideOutcome([P("a", "pass")]).status, "PASS");
  const s = decideOutcome([P("a", "pass"), P("b", "skipped")]);
  assert.equal(s.status, "PASS_WITH_WARNINGS");
  assert.match(s.warnings[0].detail, /not verified/);
});

test("outcome: only deterministic failures are repairable; judgement goes to a human", () => {
  assert.equal(decideOutcome([P("black_tail", "fail", "trim_black_tail")]).status, "REPAIRABLE");
  assert.equal(decideOutcome([P("black_tail", "fail", "trim_black_tail"), P("round_trip", "fail")]).status, "NEEDS_REVIEW");
  assert.equal(decideOutcome([P("x", "fail", "invent_new_style")]).status, "NEEDS_REVIEW");
});

test("ONE repair pass: a repaired plan is never repaired again, and a still-failing repair is NEEDS_REVIEW", () => {
  const first = repairPlan(fx.plan, [P("caption_density", "fail", "regroup_captions")], { profile: fx.profile, words: fx.rebased, version: 2 });
  assert.equal(first.plan.provenance.repair_of, 1);
  assert.equal(first.plan.version, 2);
  assert.throws(() => repairPlan(first.plan, [P("caption_density", "fail", "regroup_captions")], { profile: fx.profile, words: fx.rebased, version: 3 }), (e) => e.code === "REPAIR_LIMIT");
  const after = decideOutcome([P("caption_density", "fail", "regroup_captions")], { alreadyRepaired: true });
  assert.equal(after.status, "NEEDS_REVIEW");
  assert.match(after.reason, /one allowed repair/);
});

test("repairs are deterministic and the repaired plan still validates", () => {
  const { plan, applied } = repairPlan(fx.plan, [
    { id: "black_tail", status: "fail", detail: `black from ${(fx.plan.rough_cut.segments.at(-1).out_end - 0.4).toFixed(2)}s to the end`, repair: "trim_black_tail" },
    { id: "caption_density", status: "fail", detail: "dense", repair: "regroup_captions" },
    { id: "true_peak", status: "fail", detail: "-0.5", repair: "audio_stricter_limiter" },
  ], { profile: fx.profile, words: fx.rebased, version: 2 });
  assert.equal(applied.length, 3);
  assert.ok(plan.rough_cut.segments.at(-1).out_end < fx.plan.rough_cut.segments.at(-1).out_end);
  assert.ok(plan.captions.cues.every((c) => c.words.length <= fx.profile.captions.maxWords - 1));
  assert.ok(plan.audio.limiter <= 0.708);
  assert.deepEqual(validatePlan(plan, { profile: fx.profile }).errors, []);
  const again = repairPlan(fx.plan, [{ id: "caption_density", status: "fail", detail: "dense", repair: "regroup_captions" }], { profile: fx.profile, words: fx.rebased, version: 2 });
  assert.deepEqual(again.plan.captions, repairPlan(fx.plan, [{ id: "caption_density", status: "fail", detail: "dense", repair: "regroup_captions" }], { profile: fx.profile, words: fx.rebased, version: 2 }).plan.captions);
});

test("editorial: word survival catches a word lost without a reasoned removal", () => {
  assert.equal(wordSurvival({ sourceWords: fx.words, plan: fx.plan }).status, "pass");
  const p = clone(fx.plan);
  p.rough_cut.removals = p.rough_cut.removals.filter((r) => r.kind !== "deadAir");
  p.rough_cut.segments[0].src_end -= 0.5; // pretend the render lost the end of the first segment
  const lostWords = fx.words.filter((w) => w.start >= p.rough_cut.segments[0].src_end && w.start < fx.plan.rough_cut.segments[0].src_end);
  if (lostWords.length) assert.equal(wordSurvival({ sourceWords: fx.words, plan: p }).status, "fail");
});

test("editorial: unresolved retakes need review; disputed dead air does not", () => {
  const p = clone(fx.plan);
  p.rough_cut.removals.push({ start: 1, end: 2, kind: "disputed", reason: "x", confidence: "low", applied: false });
  assert.equal(unreviewedRetakes(p).status, "pass");
  p.rough_cut.removals.push({ start: 3, end: 4, kind: "retake", reason: "repeat", confidence: "low", applied: false, why: ["low confidence"] });
  assert.equal(unreviewedRetakes(p).status, "fail");
});

test("editorial: duplicate phrases, caption timing and unjustified punch-ins are caught", () => {
  assert.equal(duplicatePhrases(fx.plan).status, "pass");
  const p = clone(fx.plan);
  const ws = p.captions.cues[0].words;
  const dup = ws.slice(0, 4).map((w, i) => ({ ...w, start: ws.at(-1).end + 0.1 + i * 0.2, end: ws.at(-1).end + 0.25 + i * 0.2 }));
  p.captions.cues[0].words = [...ws, ...dup];
  if (ws.length >= 4) assert.equal(duplicatePhrases(p).status, "fail");
  assert.equal(captionTiming(fx.plan, fx.profile).status, "pass");
  const q = clone(fx.plan);
  q.captions.cues[0].start += 0.4;
  assert.equal(captionTiming(q, fx.profile).status, "fail");
  const r = clone(fx.plan);
  r.punch_ins[0].candidate = "c999";
  const c = punchInReasons(r, fx.candidates);
  assert.equal(c.status, "fail");
  assert.equal(c.repair, "drop_unjustified_punch_ins");
});

test("parsers: ebur128 summary, loudnorm JSON, silencedetect log, text similarity", () => {
  const eb = parseEbur128("...\n[Parsed_ebur128_0] Summary:\n\n  Integrated loudness:\n    I:         -14.3 LUFS\n  Loudness range:\n    LRA:         5.1 LU\n  True peak:\n    Peak:       -1.6 dBFS\n");
  assert.deepEqual([eb.integratedLufs, eb.truePeakDb, eb.lra], [-14.3, -1.6, 5.1]);
  const ln = parseLoudnormJson('noise\n{\n\t"input_i" : "-22.10",\n\t"input_tp" : "-4.0",\n\t"input_lra" : "6.0",\n\t"input_thresh" : "-32.4",\n\t"target_offset" : "0.3"\n}\n');
  assert.equal(ln.input_i, "-22.10");
  assert.equal(parseLoudnormJson("no json here"), null);
  assert.deepEqual(audibleFromSilenceLog("silence_start: 1.0\nsilence_end: 2.5 | silence_duration: 1.5\nsilence_start: 4.0", 5), [{ start: 0, end: 1 }, { start: 2.5, end: 4 }]);
  assert.equal(textSimilarity("you can sell", "You can sell."), 1);
  assert.ok(textSimilarity("totally different", "you can sell") < 0.2);
});

test("profiles: active loads with a stable hash; placeholders and wrong types are refused", () => {
  const a = loadProfile("SHORT_TALKING_HEAD", { root: REPO_ROOT, type: "reel" });
  assert.equal(a.ref.hash, loadProfile("SHORT_TALKING_HEAD", { root: REPO_ROOT }).ref.hash);
  const long = loadProfile("LONG_TALKING_HEAD", { root: REPO_ROOT, type: "long" });
  assert.equal(long.profile.output.width, 1920);
  assert.equal(long.profile.output.height, 1080);
  assert.throws(() => loadProfile("SHORT_TALKING_HEAD", { root: REPO_ROOT, type: "long" }), /does not support type/);
  assert.throws(() => loadProfile("LONG_TALKING_HEAD", { root: REPO_ROOT, type: "reel" }), /does not support type/);
  assert.throws(() => loadProfile("../../etc/passwd", { root: REPO_ROOT }), /not a valid profile name/);
});

test("temp: cleaned on cleanup, kept with keep, sweep removes only old abandoned dirs", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "shorts-temp-"));
  const t = createRunTemp("S001", { base });
  fs.writeFileSync(t.file("big.wav"), "x");
  t.cleanup();
  assert.equal(fs.existsSync(t.dir), false);
  const k = createRunTemp("S001", { base, keep: true });
  k.cleanup();
  assert.equal(fs.existsSync(k.dir), true);
  const old = path.join(base, "video-kit", "S009-old");
  fs.mkdirSync(old, { recursive: true });
  const past = new Date(Date.now() - 3 * 86400e3);
  fs.utimesSync(old, past, past);
  const live = createRunTemp("S010", { base });
  fs.utimesSync(live.dir, past, past); // old but locked by this live process
  const removed = sweepStale({ base });
  assert.ok(removed.includes(old));
  assert.ok(fs.existsSync(live.dir), "a live run's temp is never swept");
  live.cleanup();
});
