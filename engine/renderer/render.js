/**
 * engine/renderer/render.js — execute a validated plan. No judgement here.
 *
 *   1. refuse an invalid plan (validate.js) and any output path inside the source folder
 *   2. audio pre-pass: chosen track → mono fix → 48k → segment trims with 6 ms edge fades → cut.wav
 *   3. loudnorm MEASURE pass on cut.wav (two-pass: the measure must be of the audio that ships)
 *   4. captions.ass (font verified first — libass substitutes silently)
 *   5. ONE encode: video graph + graphics overlays + captions + measured loudnorm + limiter
 *      → renders/vN.partial.mp4, renamed to vN.mp4 only on success
 *
 * A failed or killed render never leaves a file that looks finished.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { probeEnv, assertFont } from "../env.js";
import { assertValidPlan } from "../planner/validate.js";
import { assertOutputOutsideSource } from "../ingest/source.js";
import { buildAss } from "../captions/ass.js";
import { buildAudioCutGraph, buildAudioFinal, buildVideoGraph, encodeArgs } from "./graph.js";

export class RenderError extends Error {
  constructor(stage, message) { super(`${stage}: ${message}`); this.name = "RenderError"; this.code = "RENDER_FAILED"; this.stage = stage; }
}

function ff(args, stage, { timeoutMs = 60 * 60 * 1000 } = {}) {
  const { ffmpeg } = probeEnv();
  const r = spawnSync(process.env.KIT_FFMPEG_OVERRIDE || ffmpeg, ["-hide_banner", "-nostats", ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs });
  if (r.error) throw new RenderError(stage, r.error.message);
  if (r.status !== 0) throw new RenderError(stage, `ffmpeg exit ${r.status}: ${String(r.stderr).trim().split("\n").slice(-8).join(" | ")}`);
  return String(r.stderr ?? "");
}

/** Parse the JSON block loudnorm prints on stderr. */
export function parseLoudnormJson(stderr) {
  const m = String(stderr).match(/\{\s*"input_i"[\s\S]*?\}/);
  if (!m) return null;
  const j = JSON.parse(m[0]);
  for (const k of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]) {
    if (!Number.isFinite(Number(j[k]))) return null;
  }
  return j;
}

const _fontProof = new Map();

/**
 * Prove libass draws the caption face UPRIGHT. fontconfig can resolve the right face while libass
 * picks another from the same .ttc: "Avenir Next" + Bold rendered Bold ITALIC on the first real
 * E2E (2026-10-02) with every check green. Draw "IIIIII" and measure the strokes' lean.
 */
export function proveUprightFont(style, temp) {
  const key = `${style.font}|${style.bold}`;
  if (_fontProof.has(key)) return _fontProof.get(key);
  const ass = temp.file("font-proof.ass");
  fs.writeFileSync(ass, buildAss({ cues: [{ start: 0, end: 1, words: [{ text: "IIIIII", emphasis: false }], lines: [[0]] }], style: { ...style, fontSize: 200, outline: 0, shadow: 0, fadeInMs: 0, primaryColour: "#FFFFFF" }, width: 1080, height: 400, position: { x: 540, y: 200 } }));
  const { ffmpeg } = probeEnv();
  const r = spawnSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=1080x400:d=1", "-vf", `ass=filename='${ass}',format=gray`, "-frames:v", "1", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new RenderError("font proof", String(r.stderr).slice(-300));
  const b = r.stdout, W = 1080, H = 400;
  const rows = [];
  for (let y = 0; y < H; y++) { let sx = 0, n = 0; for (let x = 0; x < W; x++) if (b[y * W + x] > 128) { sx += x; n++; } if (n) rows.push({ y, mx: sx / n }); }
  if (rows.length < 20) throw new RenderError("font proof", `caption font "${style.font}" drew no glyphs`);
  const q = Math.floor(rows.length / 4);
  const top = rows.slice(0, q), bot = rows.slice(-q);
  const avg = (xs, k) => xs.reduce((a, r) => a + r[k], 0) / xs.length;
  const slant = (avg(top, "mx") - avg(bot, "mx")) / (avg(bot, "y") - avg(top, "y"));
  const result = { font: style.font, slant: Number(slant.toFixed(3)), upright: Math.abs(slant) < 0.06 };
  _fontProof.set(key, result);
  if (!result.upright) throw new RenderError("font proof", `caption font "${style.font}" renders slanted (lean ${result.slant}) — libass picked an italic face; use an upright named family`);
  return result;
}

export function renderPlan({ plan, profile, assets = [], sourcePath, outPath, temp, graphicsInputs = [], log = () => {} }) {
  assertValidPlan(plan, { profile, assets });
  assertOutputOutsideSource(outPath, sourcePath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const t0 = Date.now();

  // 2. Audio pre-pass.
  const audioGraph = temp.file("audio-cut.graph.txt");
  fs.writeFileSync(audioGraph, buildAudioCutGraph(plan));
  const cutWav = temp.file("cut.wav");
  ff(["-y", "-v", "error", "-i", sourcePath, "-/filter_complex", audioGraph, "-map", "[acut]", "-c:a", "pcm_s16le", cutWav], "audio cut");

  // 3. Loudness measure.
  const a = plan.audio;
  const measureLog = ff(["-i", cutWav, "-af", `loudnorm=I=${a.target_lufs}:TP=${a.true_peak_db}:LRA=${a.lra}:print_format=json`, "-f", "null", "-"], "loudness measure");
  const measured = parseLoudnormJson(measureLog);
  if (!measured) log("loudnorm measure gave no usable numbers — single-pass normalisation used");

  // 4. Captions.
  let assPath = null;
  if (plan.captions.cues.length && profile.captions.burn !== false) {
    assertFont(profile.captions.font);
    proveUprightFont(profile.captions, temp);
    assPath = temp.file("captions.ass");
    fs.writeFileSync(assPath, buildAss({ cues: plan.captions.cues, style: profile.captions, width: plan.format.width, height: plan.format.height, position: plan.captions.position }));
  }

  // 5. One encode.
  const { filter, videoLabel } = buildVideoGraph(plan, { assPath, graphics: graphicsInputs.map((g, k) => ({ ...g, inputIndex: 2 + k })) });
  const graphFile = temp.file("video.graph.txt");
  fs.writeFileSync(graphFile, `${filter};\n${buildAudioFinal(plan, measured, { inputIndex: 1 })}`);
  const partial = outPath.replace(/\.mp4$/, ".partial.mp4");
  const inputs = ["-i", sourcePath, "-i", cutWav];
  for (const g of graphicsInputs) inputs.push("-framerate", String(plan.format.fps), "-i", path.join(g.dir, "%05d.png"));
  try {
    ff(["-y", "-v", "error", ...inputs, "-/filter_complex", graphFile, "-map", `[${videoLabel}]`, "-map", "[aout]", ...encodeArgs(plan, profile), partial], "encode");
    if (!fs.existsSync(partial) || fs.statSync(partial).size === 0) throw new RenderError("encode", "ffmpeg reported success but wrote no output");
    fs.renameSync(partial, outPath);
  } catch (e) {
    fs.rmSync(partial, { force: true });
    throw e instanceof RenderError ? e : new RenderError("encode", e.message);
  }
  return { outPath, measured, seconds: Number(((Date.now() - t0) / 1000).toFixed(1)), graphFile, assPath };
}
