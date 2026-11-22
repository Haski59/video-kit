/**
 * Integration: the real pipeline (ffmpeg-full, whisper.cpp, whisperX, Apple Vision, Chrome) on
 * synthetic clips generated at test time — macOS `say` speech over a generated background. Nothing
 * large is committed. Slow (~3–5 min): npm run test:integration
 *
 * Covers: a full edit to a 1080x1920 QC-passing render · source untouched · temp cleaned (success,
 * failure, --keep-temp, SIGINT) · injected render failure → FAILED with no file in renders/ ·
 * output inside the source folder refused · a rotated phone clip · the ONE-repair limit end to end.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { runShort } from "../../engine/run.js";
import { probeEnv } from "../../engine/env.js";
import { REPO_ROOT, fingerprint, readJson, hashObject } from "../../engine/storage/files.js";
import { probeSource } from "../../engine/ingest/source.js";

const CLI = path.join(REPO_ROOT, "engine", "cli.js");
const SCRIPT = "If you want to make money online, start stacking skills. [[slnc 1800]] First, you need to get good at sales. Then learn Meta ads. Now you've got three skills, and that changes everything.";

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-int-"));
  const root = path.join(dir, "root"), src = path.join(dir, "src"), tmp = path.join(dir, "tmp");
  for (const d of [root, src, tmp]) fs.mkdirSync(d, { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, "config"), path.join(root, "config"), { recursive: true });
  return { dir, root, src, tmp };
}

function makeClip(out, { rotate = 0, size = "1920x1080" } = {}) {
  const { ffmpeg } = probeEnv();
  const aiff = `${out}.aiff`;
  const say = spawnSync("say", ["-v", "Daniel", "-o", aiff, SCRIPT]);
  if (say.status !== 0) spawnSync("say", ["-o", aiff, SCRIPT]);
  const args = ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=0x2a3138:s=${size}:r=30`, "-i", aiff,
    "-filter_complex", "[1:a]apad=pad_dur=0.6,aformat=channel_layouts=stereo[a]", "-map", "0:v", "-map", "[a]", "-shortest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", out];
  const r = spawnSync(ffmpeg, args, { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  fs.rmSync(aiff, { force: true });
  if (rotate) {
    const rot = out.replace(/\.mp4$/, ".rot.mp4");
    const r2 = spawnSync(ffmpeg, ["-y", "-v", "error", "-display_rotation:v:0", String(rotate), "-i", out, "-c", "copy", rot], { encoding: "utf8" });
    assert.equal(r2.status, 0, r2.stderr);
    fs.renameSync(rot, out);
  }
  return out;
}

const tempLeft = (tmp) => { try { return fs.readdirSync(path.join(tmp, "video-kit")); } catch { return []; } };

const S = sandbox();
const CLIP = makeClip(path.join(S.src, "clip.mp4"));

test("full edit of a synthetic clip: 1080x1920, QC passes, artefacts consistent, source untouched, temp gone", { timeout: 300000 }, async () => {
  const before = await fingerprint(CLIP);
  const r = await runShort({ input: CLIP, root: S.root, planner: "heuristic", tmpBase: S.tmp });
  assert.equal(r.status, "COMPLETE", `${r.status}: ${r.failures.join("; ")}`);
  assert.equal(r.id, "S001");
  const job = path.join(S.root, "output", "S001");
  for (const f of ["metadata.json", "transcript.json", "analysis.json", "rough-cut.json", "edit-plan.v1.json", "qc.v1.json", "renders/v1.mp4"]) assert.ok(fs.existsSync(path.join(job, f)), f);
  const qc = readJson(path.join(job, "qc.v1.json"));
  assert.equal(qc.checks.find((c) => c.id === "dimensions").detail, "1080x1920");
  assert.equal(qc.plan_sha256, hashObject(readJson(path.join(job, "edit-plan.v1.json"))), "QC report belongs to exactly this plan");
  assert.equal(readJson(path.join(job, "metadata.json")).current_version, 1);
  assert.ok(r.durationOut < r.durationIn - 1, "the 1.8s pause was tightened");
  assert.deepEqual(await fingerprint(CLIP), before, "source byte-identical, same mtime");
  assert.deepEqual(tempLeft(S.tmp), [], "temp removed after success");
  assert.equal(readJson(path.join(S.root, "output", "registry.json")).shorts.S001.status, "COMPLETE");
});

test("re-running the same source reuses S001 as v2; --keep-temp keeps the working folder", { timeout: 300000 }, async () => {
  const r = await runShort({ input: CLIP, root: S.root, planner: "heuristic", tmpBase: S.tmp, from: "plan", keepTemp: true });
  assert.equal(r.id, "S001");
  assert.equal(r.version, 2);
  const kept = tempLeft(S.tmp);
  assert.equal(kept.length, 1, "kept for inspection");
  fs.rmSync(path.join(S.tmp, "video-kit", kept[0]), { recursive: true, force: true });
});

test("a failing render ends FAILED: nothing in renders/, temp cleaned, registry says so", { timeout: 300000 }, async () => {
  const job = path.join(S.root, "output", "S001", "renders");
  const beforeFiles = fs.readdirSync(job).sort();
  process.env.KIT_FFMPEG_OVERRIDE = "/usr/bin/false";
  try {
    await assert.rejects(runShort({ input: CLIP, root: S.root, planner: "heuristic", tmpBase: S.tmp, from: "plan" }), (e) => e.stage === "render");
  } finally { delete process.env.KIT_FFMPEG_OVERRIDE; }
  assert.deepEqual(fs.readdirSync(job).sort(), beforeFiles, "no new or partial render");
  assert.deepEqual(tempLeft(S.tmp), []);
  const meta = readJson(path.join(S.root, "output", "S001", "metadata.json"));
  assert.equal(meta.status, "FAILED");
  assert.equal(meta.failed_stage, "render");
});

test("ONE repair pass: a fixable defect is repaired once and passes; a persistent one stops at NEEDS_REVIEW", { timeout: 400000 }, async () => {
  const inject = (mode) => JSON.stringify({ mode, check: { id: "caption_density", status: "fail", detail: "injected by test", repair: "regroup_captions" } });
  process.env.KIT_TEST_INJECT_QC = inject("once");
  let r;
  try { r = await runShort({ input: CLIP, root: S.root, planner: "heuristic", tmpBase: S.tmp, from: "plan" }); } finally { delete process.env.KIT_TEST_INJECT_QC; }
  assert.equal(r.status, "COMPLETE");
  const repaired = readJson(path.join(S.root, "output", "S001", `edit-plan.v${r.version}.json`));
  assert.equal(repaired.provenance.repair_of, r.version - 1);

  process.env.KIT_TEST_INJECT_QC = inject("always");
  try { r = await runShort({ input: CLIP, root: S.root, planner: "heuristic", tmpBase: S.tmp, from: "plan" }); } finally { delete process.env.KIT_TEST_INJECT_QC; }
  assert.equal(r.status, "NEEDS_REVIEW");
  assert.match(r.reason, /one allowed repair/);
  const reg = readJson(path.join(S.root, "output", "registry.json")).shorts.S001;
  const last = reg.versions.at(-1), prev = reg.versions.at(-2);
  assert.equal(last.v, r.version);
  assert.equal(prev.v, r.version - 1, "exactly two renders for this run: original + one repair");
  assert.ok(fs.existsSync(path.join(S.root, "output", "S001", "renders", `v${r.version}.mp4`)));
  assert.equal(fs.existsSync(path.join(S.root, "output", "S001", `edit-plan.v${r.version + 1}.json`)), false, "no third attempt");
});

test("refuses to write anywhere inside the source's own folder", async () => {
  const inside = path.join(S.dir, "inside");
  fs.mkdirSync(path.join(inside, "config"), { recursive: true });
  fs.cpSync(path.join(S.root, "config"), path.join(inside, "config"), { recursive: true });
  const clip = path.join(inside, "clip.mp4");
  fs.copyFileSync(CLIP, clip);
  await assert.rejects(runShort({ input: clip, root: inside, planner: "heuristic", tmpBase: S.tmp }), (e) => e.code === "OUTPUT_IN_SOURCE_DIR");
  assert.equal(fs.existsSync(path.join(inside, "output", "registry.json")), false, "nothing registered");
});

test("a rotated phone clip is measured by its DISPLAY size and edited without a wrong-axis crop", { timeout: 300000 }, async () => {
  const s2 = sandbox();
  const clip = makeClip(path.join(s2.src, "phone.mp4"), { rotate: 90 });
  const info = probeSource(clip);
  assert.deepEqual([info.width, info.height], [1080, 1920]);
  const r = await runShort({ input: clip, root: s2.root, planner: "heuristic", tmpBase: s2.tmp });
  const qc = readJson(path.join(s2.root, "output", r.id, `qc.v${r.version}.json`));
  assert.equal(qc.checks.find((c) => c.id === "dimensions").status, "pass");
  const plan = readJson(path.join(s2.root, "output", r.id, `edit-plan.v${r.version}.json`));
  assert.equal(plan.reframes[0].mode, "none", "already vertical — not reframed");
});

test("SIGINT mid-run removes the temp working folder", { timeout: 300000 }, async () => {
  const s3 = sandbox();
  const clip = makeClip(path.join(s3.src, "c.mp4"));
  const child = spawn(process.execPath, [CLI, "short", clip, "--planner", "heuristic"], { env: { ...process.env, KIT_ROOT: s3.root, KIT_TMP: s3.tmp }, stdio: "ignore" });
  const until = Date.now() + 60000;
  while (!tempLeft(s3.tmp).length && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  assert.ok(tempLeft(s3.tmp).length, "run started and created its temp folder");
  child.kill("SIGINT");
  await new Promise((r) => child.on("exit", r));
  assert.deepEqual(tempLeft(s3.tmp), [], "temp removed on SIGINT");
});

test("long-form: 1920x1080 edit, every cut measured in silence, .srt written, every kept word survives", { timeout: 300000 }, async () => {
  const s4 = sandbox();
  const clip = makeClip(path.join(s4.src, "long.mp4"));
  const before = await fingerprint(clip);
  const r = await runShort({ input: clip, root: s4.root, type: "long", planner: "heuristic", tmpBase: s4.tmp });
  assert.match(r.id, /^L\d{3}$/);
  assert.equal(r.status, "COMPLETE", `${r.status}: ${r.failures.join("; ")}`);
  const job = path.join(s4.root, "output", r.id);
  const qc = readJson(path.join(job, `qc.v${r.version}.json`));
  assert.equal(qc.checks.find((c) => c.id === "dimensions").detail, "1920x1080");
  const edges = qc.checks.find((c) => c.id === "speech_edges");
  assert.equal(edges.status, "pass", edges.detail);
  assert.ok(edges.joins.length >= 1, "the 1.8 s pause produced at least one cut");
  assert.equal(qc.checks.find((c) => c.id === "word_survival").status, "pass");
  const srt = fs.readFileSync(path.join(job, "renders", `v${r.version}.srt`), "utf8");
  assert.match(srt, /^1\n00:00:00,\d{3} --> /);
  assert.ok(readJson(path.join(job, "rough-cut.json")).speech_edges.edges.length >= 1);
  assert.deepEqual(await fingerprint(clip), before);
});
