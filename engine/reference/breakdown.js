/**
 * engine/reference/breakdown.js — a full shot-by-shot breakdown of a reference with rea-video
 * (github.com/JuneYaooo/rea-video, Apache-2.0), installed by setup.sh into ~/.cache/video-kit/rea-venv.
 *
 * rea-video tells, shot by shot, whether a video was filmed, AI-generated or built in code, and writes
 * framing, camera, lighting, edit rhythm, captions (SRT/ASS), music and a remake plan to report.html
 * plus VIDEO.md (an agent-readable package). It runs offline and free.
 *
 * On platform downloads (YouTube/TikTok re-compress away the sensor-noise evidence) its pixel-only
 * verdict is unreliable — on a filmed Short it said "AI 100 %". review() fixes that: the member's own
 * Claude looks at each shot's frames through rea-video's review/apply-review loop (tested: the same
 * Short became "live action", confidence 0.44 → 0.75).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findClaude } from "../llm/claude.js";

export const REA_VENV = path.join(os.homedir(), ".cache", "video-kit", "rea-venv");
export const REA_BIN = path.join(REA_VENV, "bin", "rea-video");

export function reaAvailable() { return fs.existsSync(REA_BIN); }

export function decompose({ file, outDir, lang = "en", log = () => {} }) {
  if (!reaAvailable()) throw new Error("the breakdown tool isn't installed — run ./setup.sh");
  fs.mkdirSync(outDir, { recursive: true });
  log("breakdown: splitting into shots, separating voice / music / effects, reading captions (about 2 s per second of video)");
  const r = spawnSync(REA_BIN, ["decompose", file, "-o", outDir, "--lang", lang], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60 * 60 * 1000 });
  if (r.status !== 0 || !fs.existsSync(path.join(outDir, "report.html"))) {
    throw new Error(`breakdown failed: ${String(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`);
  }
  const m = String(r.stdout).match(/\{[\s\S]*\}\s*$/);
  let summary = null;
  try { summary = m ? JSON.parse(m[0]) : null; } catch { /* not JSON */ }
  log(`breakdown: ${summary?.shots ?? "?"} shot(s), first verdict "${String(summary?.verdict ?? "").split(";")[0]}" (confidence ${summary?.confidence ?? "?"})`);
  return { outDir, report: path.join(outDir, "report.html"), summary };
}

export const REVIEW_PROMPT = (dir) => `A video breakdown is in ${dir} (made by the rea-video CLI, which is on PATH). Do its visual review:
1) run \`rea-video review ${dir}\`;
2) open ${dir}/review_tasks.json and look at every image it lists with the Read tool;
3) fill ${dir}/review_answers.json exactly in the template's format, judging from what you SEE (filmed / AI / code / screen recording…);
4) run \`rea-video apply-review ${dir} --by claude --lang en\`;
5) print the first 3 lines of \`rea-video summary ${dir}/breakdown.json\`.
Don't ask questions. Never describe a real person beyond what's needed to tell shots apart.`;

/** Claude looks at every shot and the verdict is merged. Returns { ok, out }. */
export function review({ outDir, log = () => {}, timeoutMs = 20 * 60 * 1000 }) {
  const bin = findClaude();
  if (!bin) throw new Error("Claude Code isn't installed, so the shots can't be checked by eye");
  log("breakdown: Claude is checking each shot by eye");
  const env = { ...process.env, PATH: `${path.join(REA_VENV, "bin")}:${process.env.PATH}` };
  const r = spawnSync(bin, ["-p", REVIEW_PROMPT(outDir), "--allowedTools", "Bash,Read,Write,Edit,Glob,Grep", "--output-format", "text"],
    { encoding: "utf8", env, cwd: outDir, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  // Proof it merged: rea-video's own summary says how many shots were reviewed by eye.
  const sum = spawnSync(REA_BIN, ["summary", path.join(outDir, "breakdown.json")], { encoding: "utf8" });
  const ok = r.status === 0 && /reviewed \d+\/\d+ shots by eye/i.test(String(sum.stdout));
  log(ok ? "breakdown: visual review merged" : `breakdown: visual review did not finish (${String(r.stderr || "").trim().slice(-160)})`);
  return { ok, out: r.stdout };
}
