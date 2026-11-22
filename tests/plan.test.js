/** Edit plan: assembly from a selection, strict validation, and the renderer refusing bad plans. */
import test from "node:test";
import assert from "node:assert/strict";
import { validatePlan, assertValidPlan, calloutDerived } from "../engine/planner/validate.js";
import { renderPlan } from "../engine/renderer/render.js";
import { buildFixture } from "./fixtures/plan-fixture.mjs";

const fx = buildFixture();
const clone = (o) => JSON.parse(JSON.stringify(o));
const errorsOf = (mut) => {
  const p = clone(fx.plan);
  mut(p);
  return validatePlan(p, { profile: fx.profile }).errors.join("\n");
};

test("an assembled heuristic plan validates and uses only approved behaviours", () => {
  const r = validatePlan(fx.plan, { profile: fx.profile });
  assert.deepEqual(r.errors, []);
  assert.equal(fx.plan.schema_version, "1.0");
  assert.ok(fx.plan.punch_ins.length >= 1, "at least one punch-in on a candidate");
  assert.ok(fx.plan.punch_ins.every((p) => fx.profile.punchIns.presets[p.preset]), "every punch-in is a profile preset");
  assert.ok(fx.plan.graphics.every((g) => fx.profile.graphics.allowed.includes(g.component)));
  assert.ok(fx.plan.hook.treatments.length >= 1, "the hook is treated more strongly than the body");
  assert.equal(fx.plan.profile.id, "SHORT_TALKING_HEAD");
  assert.match(fx.plan.profile.hash, /^[0-9a-f]{16}$/);
});

test("unknown keys are rejected (strict shape)", () => {
  assert.match(errorsOf((p) => { p.colour_grade = "teal"; }), /plan\.colour_grade: unknown key/);
  assert.match(errorsOf((p) => { p.punch_ins[0].wobble = true; }), /unknown key/);
});

test("missing fields and wrong types are rejected", () => {
  assert.match(errorsOf((p) => { delete p.captions; }), /plan\.captions: missing/);
  assert.match(errorsOf((p) => { p.format.width = "1080"; }), /expected number/);
});

test("punch-ins: unknown preset, scale over max, overlap and crossing a cut are rejected", () => {
  assert.match(errorsOf((p) => { p.punch_ins[0].preset = "PUNCH_WILD"; }), /unknown preset/);
  assert.match(errorsOf((p) => { p.punch_ins[0].scale = 1.25; }), /> max|≠ preset/);
  assert.match(errorsOf((p) => { const a = p.punch_ins[0]; p.punch_ins.push({ ...a, id: "dup" }); }), /overlaps/);
  const segs = fx.plan.rough_cut.segments;
  if (segs.length > 1) {
    assert.match(errorsOf((p) => {
      const j = p.rough_cut.segments[1].out_start;
      p.punch_ins = [{ id: "x", kind: "ease", preset: "PUNCH_EASE_106", scale: 1.06, ramp_sec: 0.5, out_start: j - 1, out_end: j + 1, release: "ease", anchor: { x: 0.5, y: 0.4 }, candidate: "c1", reason: "test" }];
    }), /crosses a cut join/);
  }
  assert.match(errorsOf((p) => { p.punch_ins[0].reason = ""; }), /must not be empty/);
});

test("graphics: unknown, unbuilt, off-safe-zone, over-the-face and unspoken callouts are rejected", () => {
  const g = { id: "gx", component: "NumberCallout", out_start: 20, out_end: 21.5, props: { value: "£99K", label: "" }, region: "upper", box: { x: 120, y: 220, w: 840, h: 130 }, candidate: "c1", reason: "test" };
  assert.match(errorsOf((p) => { p.graphics = [{ ...g, component: "Spinner3D" }]; }), /unknown component/);
  assert.match(errorsOf((p) => { p.graphics = [{ ...g, component: "Checklist" }]; }), /not implemented/);
  assert.match(errorsOf((p) => { p.graphics = [{ ...g, box: { x: 0, y: 0, w: 1080, h: 130 } }]; }), /outside the platform safe zone/);
  assert.match(errorsOf((p) => { p.graphics = [{ ...g, box: { ...g.box, y: p.layout.faceTopMin + 20 } }]; }), /overlaps the face/);
  assert.match(errorsOf((p) => { p.graphics = [g]; }), /not derived from speech/);
});

test("captions: past the end, overlapping cues and boxes on the face are rejected", () => {
  assert.match(errorsOf((p) => { p.captions.cues.at(-1).end = 999; }), /ends past the video/);
  assert.match(errorsOf((p) => { p.captions.cues[1].start = p.captions.cues[0].start; }), /overlaps cue/);
  assert.match(errorsOf((p) => { p.captions.box.y = p.layout.faceBottomMax - 100; }), /overlaps the face/);
});

test("lanes: overlays unsupported, B-roll/SFX must be approved assets", () => {
  assert.match(errorsOf((p) => { p.overlays = [{}]; }), /overlays: not supported/);
  assert.match(errorsOf((p) => { p.broll = [{ asset: "stock-1", out_start: 1, out_end: 2, reason: "x" }]; }), /not in member\/assets/);
});

test("rough cut segments must be contiguous whole frames", () => {
  assert.match(errorsOf((p) => { p.rough_cut.segments[0].src_end += 0.01; p.rough_cut.segments[0].out_end += 0.01; }), /not a whole number of frames|gap\/overlap/);
});

test("callout derivation tolerates plurals and number forms, rejects new words", () => {
  assert.ok(calloutDerived(["3 SKILLS"], ["you've", "got", "three", "skills."]).ok);
  assert.ok(calloutDerived(["STEP 1"], ["First,", "get", "good"], ["step"]).ok);
  assert.equal(calloutDerived(["GUARANTEED RESULTS"], ["you", "can", "sell"]).ok, false);
});

test("the renderer refuses an invalid plan BEFORE touching ffmpeg or any file", () => {
  const bad = clone(fx.plan);
  bad.punch_ins[0].scale = 1.5;
  assert.throws(() => renderPlan({ plan: bad, profile: fx.profile, sourcePath: "/nonexistent/src.mov", outPath: "/nonexistent/out/v1.mp4", temp: null }), (e) => e.code === "PLAN_INVALID");
  assert.throws(() => assertValidPlan(bad, { profile: fx.profile }), /failed validation/);
});
