/** The Claude planner fence — fake runners only, no network. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { selectWithLlm, checkSelection, parseJsonObject, buildPrompt, SYSTEM_PROMPT } from "../engine/planner/llm.js";
import { assemblePlan } from "../engine/planner/plan.js";
import { validatePlan } from "../engine/planner/validate.js";
import { buildFixture } from "./fixtures/plan-fixture.mjs";

const fx = buildFixture();
const num = fx.candidates.find((c) => c.type === "number" && c.suggestion);
const good = {
  hook: { punch_preset: "PUNCH_EASE_108", graphic: { component: "BigStatement", props: { text: "START STACKING SKILLS" } }, reason: "the hook's promise" },
  punch_ins: [{ candidate: num.id, preset: "PUNCH_EASE_106", reason: "the number lands the point" }],
  graphics: [{ candidate: num.id, component: "NumberCallout", props: num.suggestion.props, reason: "make the count visible" }],
  emphasis: [{ word: num.i0, reason: "the number" }],
};
const runnerOf = (text) => async () => ({ text, costUsd: 0.02 });
const base = () => ({ words: fx.rebased, candidates: fx.candidates, profile: fx.profile, analysis: null });

test("a sensible model answer becomes a selection the planner can execute and the validator accepts", async () => {
  const sel = await selectWithLlm({ ...base(), runner: runnerOf(`Sure!\n${JSON.stringify(good)}\nThanks`) });
  assert.match(sel.planner, /^llm:/);
  const plan = assemblePlan(sel, { id: "S001", version: 1, type: "reel", profile: fx.profile, profileRef: fx.ref, source: { sha256: "a".repeat(64), filename: "f.mov", durationSec: fx.durationSec, width: 3840, height: 2160, fps: 30, outFps: 30, rotation: 0, audio: { audioIndex: 0 }, hdr: false, startOffsetSec: 0 }, roughCut: fx.roughCut, reframes: fx.reframes, words: fx.rebased, candidates: fx.candidates });
  assert.deepEqual(validatePlan(plan, { profile: fx.profile }).errors, []);
  assert.ok(plan.punch_ins.some((p) => p.reason.startsWith("claude:") || p.candidate === num.id));
});

test("garbage, truncated JSON, timeouts and auth failures all throw (the caller falls back to the heuristic)", async () => {
  await assert.rejects(selectWithLlm({ ...base(), runner: runnerOf("I think you should zoom a lot!") }), /no JSON/);
  await assert.rejects(selectWithLlm({ ...base(), runner: runnerOf('{"hook": {"punch_preset": "PUNCH') }), /truncated/);
  await assert.rejects(selectWithLlm({ ...base(), runner: async () => { throw new Error("claude timed out after 90s"); } }), /timed out/);
  await assert.rejects(selectWithLlm({ ...base(), runner: async () => { throw new Error("claude exit 1: Invalid authentication credentials"); } }), /authentication/);
});

test("a selection outside the menu is rejected, never fixed up", async () => {
  const bad = (mut) => { const s = JSON.parse(JSON.stringify(good)); mut(s); return s; };
  const errs = (s) => checkSelection(s, { candidates: fx.candidates, profile: fx.profile, words: fx.rebased });
  assert.match(errs(bad((s) => { s.punch_ins[0].candidate = "c999"; })).join(), /unknown candidate/);
  assert.match(errs(bad((s) => { s.punch_ins[0].preset = "PUNCH_SPIN_360"; })).join(), /unknown preset/);
  assert.match(errs(bad((s) => { s.graphics[0].component = "Checklist"; })).join(), /not allowed/);
  assert.match(errs(bad((s) => { s.graphics[0].props = { value: "lots" }; })).join(), /must contain a number/);
  assert.match(errs(bad((s) => { s.punch_ins[0].reason = ""; })).join(), /reason required/);
  assert.match(errs(bad((s) => { s.colour = "teal"; })).join(), /unknown key/);
  await assert.rejects(selectWithLlm({ ...base(), runner: runnerOf(JSON.stringify(bad((s) => { s.punch_ins[0].candidate = "c999"; }))) }), /rejected/);
});

test("answers are cached by input hash — a re-plan never re-asks", async () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-cache-"));
  let calls = 0;
  const runner = async () => { calls++; return { text: JSON.stringify(good), costUsd: 0.02 }; };
  await selectWithLlm({ ...base(), jobDir, runner });
  await selectWithLlm({ ...base(), jobDir, runner });
  assert.equal(calls, 1);
  assert.equal(fs.readdirSync(path.join(jobDir, "llm-cache")).length, 1);
});

test("the prompt carries only the menu, candidates and transcript; the system prompt states the rules", () => {
  const p = buildPrompt({ words: fx.rebased, candidates: fx.candidates, profile: fx.profile, analysis: { visual: { summary: { faceCoverage: 1 } } } });
  assert.match(p, /MENU/);
  assert.match(p, /PUNCH_EASE_106/);
  assert.match(p, /CANDIDATES/);
  assert.match(SYSTEM_PROMPT, /never edit video/i);
  assert.match(SYSTEM_PROMPT, /cannot remove, reorder or rewrite speech/);
  assert.deepEqual(parseJsonObject('x {"a":{"b":"}"}} y'), { a: { b: "}" } });
});

test("claude auth status: signed in, signed out, and unreadable output", async () => {
  const { parseAuthStatus } = await import("../engine/llm/claude.js");
  assert.equal(parseAuthStatus('{"loggedIn": true, "authMethod": "claude.ai"}'), true);
  assert.equal(parseAuthStatus('{\n  "loggedIn": false,\n  "authMethod": "none"\n}\n'), false);
  assert.equal(parseAuthStatus("error: unknown command 'auth'"), null);
  assert.equal(parseAuthStatus(""), null);
});
