/**
 * engine/planner/llm.js — Claude's editorial judgement, inside a fence.
 *
 * Claude does NOT edit the video and does NOT invent a style. It receives the transcript, the
 * deterministic candidate moments (candidates.js) and the profile's menu of approved behaviours,
 * and returns a SELECTION: which candidates get which preset / component, plus callout wording
 * taken from what the speaker said, each with a reason. plan.js turns that into times and pixels by
 * rule; validate.js then rejects anything not derived from speech. A selection that fails any check
 * is discarded and the heuristic is used — it is never "fixed up". Answers are cached by input hash.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { hashObject, readJson, writeJsonAtomic } from "../storage/files.js";
import { runClaude, parseJson, MODEL } from "../llm/claude.js";
import { COMPONENTS } from "../graphics/registry.js";

export const PLANNER_MODEL = MODEL;

export const SYSTEM_PROMPT = `You are the editorial judgement step of a talking-head video editor.
You never edit video. You choose, from a fixed menu, which spoken moments of a talking-head video get emphasis.

House style: professional, simple, controlled — not "AI-edited TikTok".
- The hook (first 3–5 s) may be treated more strongly: a push-in and/or one bold text card of its key phrase.
- After the hook, emphasis only where the content earns it: a number, a list step, a contrast, the payoff line.
- Never add emphasis just because time has passed. Fewer, better moments beat many.
- Graphics only when they clarify or land a point. Callout text must be words the speaker actually said at that moment
  (numbers may be written as digits/symbols, e.g. "ten grand a month" → "$10K/MO"); max 5 words, uppercase.
- Labels may use "STEP n" only when the speaker says first/second/third or "step n".
- You cannot remove, reorder or rewrite speech.

Reply with ONE JSON object and nothing else:
{"hook":{"punch_preset":string|null,"graphic":{"component":string,"props":object}|null,"reason":string},
 "punch_ins":[{"candidate":string,"preset":string,"reason":string}],
 "graphics":[{"candidate":string,"component":string,"props":object,"reason":string}],
 "emphasis":[{"word":number,"reason":string}]}`;

export function buildPrompt({ words, candidates, profile, analysis }) {
  const P = profile;
  const menu = {
    punch_presets: Object.fromEntries(Object.entries(P.punchIns.presets).map(([k, v]) => [k, `${v.kind} ${v.scale}x`])),
    punch_limits: { min_spacing_sec: P.punchIns.minSpacingSec, max_per_30s: P.punchIns.maxPer30s },
    components: Object.fromEntries(P.graphics.allowed.map((c) => [c, COMPONENTS[c].purpose])),
    graphic_limits: { max_per_30s: P.graphics.maxPer30s, min_spacing_sec: P.graphics.minSpacingSec, hook_max: P.hook.maxGraphics },
    props: { BigStatement: { text: "1–5 words" }, NumberCallout: { value: "e.g. $10K/MO, 3, 30%", label: "0–3 words" }, Label: { text: "1–4 words" } },
  };
  const transcript = words.map((w, i) => `${i}:${w.text}@${w.start.toFixed(2)}`).join(" ");
  const cands = candidates.map((c) => ({ id: c.id, type: c.type, at: `${c.out_start.toFixed(2)}–${c.out_end.toFixed(2)}s`, text: c.text, ...(c.key ? { key_phrase: c.key.text } : {}), ...(c.suggestion ? { suggestion: c.suggestion } : {}) }));
  return [
    `VIDEO: ${words.length ? words[words.length - 1].end.toFixed(1) : 0}s ${profile.output.width > profile.output.height ? "16:9 video" : "vertical short"}, one speaker, face visible in ${Math.round((analysis?.visual?.summary?.faceCoverage ?? 1) * 100)}% of frames.`,
    `MENU (the only behaviours you may use): ${JSON.stringify(menu)}`,
    `CANDIDATES (the only moments you may emphasise): ${JSON.stringify(cands)}`,
    `TRANSCRIPT (index:word@seconds): ${transcript}`,
    "Choose. Return the JSON object only.",
  ].join("\n\n");
}

export const parseJsonObject = parseJson;

/** Strict structural check of a model selection against the menu. Returns errors[]. */
export function checkSelection(sel, { candidates, profile, words }) {
  const errs = [];
  const ids = new Set(candidates.map((c) => c.id));
  const presets = profile.punchIns.presets;
  const allowed = new Set(profile.graphics.allowed);
  const comp = (g, where) => {
    if (!g) return;
    if (!allowed.has(g.component)) errs.push(`${where}: component ${g.component} not allowed`);
    else { const bad = COMPONENTS[g.component].check(g.props ?? {}); if (bad) errs.push(`${where}: ${bad}`); }
  };
  if (!sel || typeof sel !== "object") return ["selection is not an object"];
  for (const k of Object.keys(sel)) if (!["hook", "punch_ins", "graphics", "emphasis"].includes(k)) errs.push(`unknown key ${k}`);
  if (sel.hook) {
    if (sel.hook.punch_preset && !presets[sel.hook.punch_preset]) errs.push(`hook: unknown preset ${sel.hook.punch_preset}`);
    comp(sel.hook.graphic, "hook graphic");
    if (!String(sel.hook.reason ?? "").trim()) errs.push("hook: reason required");
  }
  for (const [i, p] of (sel.punch_ins ?? []).entries()) {
    if (!ids.has(p.candidate)) errs.push(`punch_ins[${i}]: unknown candidate ${p.candidate}`);
    if (!presets[p.preset]) errs.push(`punch_ins[${i}]: unknown preset ${p.preset}`);
    if (!String(p.reason ?? "").trim()) errs.push(`punch_ins[${i}]: reason required`);
  }
  for (const [i, g] of (sel.graphics ?? []).entries()) {
    if (!ids.has(g.candidate)) errs.push(`graphics[${i}]: unknown candidate ${g.candidate}`);
    comp(g, `graphics[${i}]`);
    if (!String(g.reason ?? "").trim()) errs.push(`graphics[${i}]: reason required`);
  }
  for (const [i, e] of (sel.emphasis ?? []).entries()) {
    if (!Number.isInteger(e.word) || e.word < 0 || e.word >= words.length) errs.push(`emphasis[${i}]: bad word index`);
  }
  if ((sel.punch_ins ?? []).length > 12 || (sel.graphics ?? []).length > 8 || (sel.emphasis ?? []).length > 20) errs.push("selection is implausibly dense");
  return errs;
}

/** Model selection → the planner's selection shape (same as heuristic.js). */
export function toSelection(sel, candidates) {
  const hook = candidates.find((c) => c.type === "hook");
  return {
    planner: `llm:${PLANNER_MODEL}`,
    hook: hook && sel.hook ? {
      candidate: hook.id,
      punch: sel.hook.punch_preset ? { preset: sel.hook.punch_preset, reason: sel.hook.reason } : null,
      graphic: sel.hook.graphic ? { component: sel.hook.graphic.component, props: sel.hook.graphic.props, reason: sel.hook.reason } : null,
    } : null,
    punch_ins: (sel.punch_ins ?? []).map((p) => ({ candidate: p.candidate, preset: p.preset, reason: `claude: ${p.reason}` })),
    graphics: (sel.graphics ?? []).map((g) => ({ candidate: g.candidate, component: g.component, props: g.props, reason: `claude: ${g.reason}` })),
    emphasis: (sel.emphasis ?? []).map((e) => ({ word: e.word })),
    notes: [],
  };
}

export const claudeRunner = runClaude;

export async function selectWithLlm({ words, candidates, profile, analysis, jobDir, log = () => {}, runner = claudeRunner }) {
  const prompt = buildPrompt({ words, candidates, profile, analysis });
  const key = hashObject({ prompt, system: SYSTEM_PROMPT, model: PLANNER_MODEL }).slice(0, 20);
  const cacheFile = jobDir ? path.join(jobDir, "llm-cache", `${key}.json`) : null;
  let raw = cacheFile ? readJson(cacheFile, null) : null;
  if (raw) log(`planner: cached Claude selection ${key}`);
  else {
    const t0 = Date.now();
    const out = await runner({ system: SYSTEM_PROMPT, prompt });
    raw = { text: out.text, costUsd: out.costUsd ?? null, model: PLANNER_MODEL, at: new Date().toISOString() };
    log(`planner: Claude (${PLANNER_MODEL}) answered in ${((Date.now() - t0) / 1000).toFixed(1)}s${out.costUsd ? `, $${out.costUsd.toFixed(3)}` : ""}`);
  }
  const sel = parseJsonObject(raw.text);
  const errs = checkSelection(sel, { candidates, profile, words });
  if (errs.length) throw new Error(`Claude selection rejected: ${errs.slice(0, 4).join("; ")}`);
  if (cacheFile && !fs.existsSync(cacheFile)) writeJsonAtomic(cacheFile, raw);
  return toSelection(sel, candidates);
}
