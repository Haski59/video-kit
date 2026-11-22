/**
 * engine/qc/technical.js — is the FILE right? Measured on the render, not assumed from the
 * plan or from ffmpeg's exit code.
 *
 * Each check returns { id, status: pass|fail|warn|skipped, detail, repair? }. `skipped` NEVER counts
 * as a pass (a skipped caption check once let a caption-less video through — scripts/edit lesson).
 * `repair` names a deterministic fix repair.js knows how to apply.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { probeEnv } from "../env.js";

const pass = (id, detail) => ({ id, status: "pass", detail });
const fail = (id, detail, repair = null) => ({ id, status: "fail", detail, ...(repair ? { repair } : {}) });
const warn = (id, detail) => ({ id, status: "warn", detail });
const skip = (id, detail) => ({ id, status: "skipped", detail });

function ffErr(args) {
  const { ffmpeg } = probeEnv();
  return spawnSync(ffmpeg, ["-hide_banner", "-nostats", ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

export function probeRender(file) {
  const { ffprobe } = probeEnv();
  const r = spawnSync(ffprobe, ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  return JSON.parse(r.stdout);
}

/** moov before mdat = faststart. Reads top-level atom headers only. */
export function isFaststart(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const hdr = Buffer.alloc(16);
    let pos = 0;
    while (pos + 8 <= size) {
      fs.readSync(fd, hdr, 0, 16, pos);
      let len = hdr.readUInt32BE(0);
      const type = hdr.toString("latin1", 4, 8);
      if (type === "moov") return true;
      if (type === "mdat") return false;
      if (len === 1) len = Number(hdr.readBigUInt64BE(8));
      if (len < 8) return false;
      pos += len;
    }
    return false;
  } finally { fs.closeSync(fd); }
}

export function parseEbur128(stderr) {
  const s = String(stderr);
  const sum = s.slice(s.lastIndexOf("Summary:"));
  const num = (re) => { const m = sum.match(re); return m ? Number.parseFloat(m[1]) : null; };
  return { integratedLufs: num(/I:\s*(-?[\d.]+) LUFS/), truePeakDb: num(/Peak:\s*(-?[\d.]+|-inf) dBFS/), lra: num(/LRA:\s*(-?[\d.]+) LU/) };
}

export function technicalChecks({ file, plan, profile, expectedFrames, sourceBefore = null, sourceAfter = null }) {
  const checks = [];
  if (!fs.existsSync(file)) return [fail("output_exists", "render file missing")];
  const size = fs.statSync(file).size;
  checks.push(size > 0 ? pass("output_exists", `${(size / 1e6).toFixed(1)} MB`) : fail("output_exists", "zero-byte file"));
  const pr = probeRender(file);
  if (!pr) return [...checks, fail("probe", "ffprobe cannot read the render")];
  const v = pr.streams.find((s) => s.codec_type === "video");
  const a = pr.streams.find((s) => s.codec_type === "audio");
  const fps = plan.format.fps;
  checks.push(v && a ? pass("streams", `${v.codec_name}/${a.codec_name}`) : fail("streams", `video:${Boolean(v)} audio:${Boolean(a)}`));
  if (!v || !a) return checks;

  const W = plan.format.width, H = plan.format.height;
  checks.push(v.width === W && v.height === H ? pass("dimensions", `${v.width}x${v.height}`) : fail("dimensions", `${v.width}x${v.height} ≠ ${W}x${H}`));
  const sar = v.sample_aspect_ratio ?? "1:1";
  checks.push(sar === "1:1" || sar === "0:1" ? pass("sar", sar) : fail("sar", `SAR ${sar}`));
  const [rn, rd] = String(v.avg_frame_rate).split("/").map(Number);
  const vfps = rd ? rn / rd : 0;
  checks.push(Math.abs(vfps - fps) < 0.01 && v.r_frame_rate === v.avg_frame_rate ? pass("framerate", `${vfps} CFR`) : fail("framerate", `avg ${v.avg_frame_rate} r ${v.r_frame_rate}, expected ${fps} CFR`));
  checks.push(v.codec_name === "h264" && v.pix_fmt === "yuv420p" && /high/i.test(v.profile ?? "") ? pass("video_codec", `${v.codec_name} ${v.profile} ${v.pix_fmt}`) : fail("video_codec", `${v.codec_name} ${v.profile} ${v.pix_fmt}`));
  checks.push(v.color_primaries === "bt709" && v.color_transfer === "bt709" && v.color_space === "bt709" ? pass("colour_tags", "bt709") : fail("colour_tags", `${v.color_primaries}/${v.color_transfer}/${v.color_space}`));
  checks.push(a.codec_name === "aac" && Number(a.sample_rate) === profile.output.audioRate && a.channels === profile.output.audioChannels ? pass("audio_codec", `aac ${a.sample_rate} ${a.channels}ch`) : fail("audio_codec", `${a.codec_name} ${a.sample_rate} ${a.channels}ch`));

  // Duration by FRAMES (container duration includes AAC priming/padding).
  const frames = Number(v.nb_read_frames ?? v.nb_frames);
  const tol = profile.qc.durationToleranceFrames;
  checks.push(Math.abs(frames - expectedFrames) <= tol ? pass("duration", `${frames} frames = ${(frames / fps).toFixed(3)}s (plan ${expectedFrames})`) : fail("duration", `${frames} frames, plan says ${expectedFrames}`));
  const vDur = frames / fps, aDur = Number(a.duration);
  checks.push(Math.abs(vDur - aDur) <= profile.qc.avDeltaMaxSec ? pass("av_sync", `Δ${(aDur - vDur).toFixed(3)}s`) : fail("av_sync", `audio ${aDur.toFixed(3)}s vs video ${vDur.toFixed(3)}s`));

  // Decode every frame: corrupt packets show up here and nowhere else.
  const dec = ffErr(["-v", "error", "-xerror", "-i", file, "-f", "null", "-"]);
  checks.push(dec.status === 0 && !String(dec.stderr).trim() ? pass("decode", "clean full decode") : fail("decode", String(dec.stderr).trim().split("\n").slice(-3).join(" | ") || `exit ${dec.status}`));

  // Black head/tail (an accidental black ending is the classic trim bug).
  const bd = ffErr(["-i", file, "-vf", "blackdetect=d=0.1:pix_th=0.10", "-an", "-f", "null", "-"]);
  const blacks = [...String(bd.stderr).matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)].map((m) => ({ start: Number(m[1]), end: Number(m[2]) }));
  const tail = blacks.find((b) => b.end >= vDur - 2 / fps);
  const head = blacks.find((b) => b.start <= 1 / fps);
  if (tail) checks.push(fail("black_tail", `black from ${tail.start.toFixed(2)}s to the end`, "trim_black_tail"));
  else checks.push(pass("black_tail", "no black ending"));
  checks.push(head ? fail("black_head", `opens on black until ${head.end.toFixed(2)}s`) : pass("black_head", "no black opening"));

  // Loudness / peaks on the DECODED output (AAC can overshoot what the limiter allowed).
  const eb = parseEbur128(ffErr(["-i", file, "-af", "ebur128=peak=true", "-vn", "-f", "null", "-"]).stderr);
  const A = profile.audio;
  if (eb.integratedLufs === null) checks.push(skip("loudness", "ebur128 gave no reading"));
  else checks.push(Math.abs(eb.integratedLufs - A.targetLufs) <= A.lufsTolerance ? pass("loudness", `${eb.integratedLufs} LUFS`) : fail("loudness", `${eb.integratedLufs} LUFS, target ${A.targetLufs}±${A.lufsTolerance}`, "audio_retarget"));
  if (eb.truePeakDb === null) checks.push(skip("true_peak", "no true-peak reading"));
  else checks.push(eb.truePeakDb <= A.maxTruePeakDb ? pass("true_peak", `${eb.truePeakDb} dBTP`) : fail("true_peak", `${eb.truePeakDb} dBTP > ${A.maxTruePeakDb}`, "audio_stricter_limiter"));
  const st = ffErr(["-i", file, "-af", "astats=measure_perchannel=none:measure_overall=Peak_level+Number_of_samples", "-vn", "-f", "null", "-"]);
  const peak = String(st.stderr).match(/Peak level dB:\s*(-?[\d.]+)/);
  checks.push(peak && Number(peak[1]) < -0.1 ? pass("no_clipping", `sample peak ${peak[1]} dBFS`) : peak ? fail("no_clipping", `sample peak ${peak[1]} dBFS`, "audio_stricter_limiter") : skip("no_clipping", "astats gave no peak"));

  checks.push(isFaststart(file) ? pass("faststart", "moov before mdat") : fail("faststart", "moov after mdat"));

  if (sourceBefore && sourceAfter) {
    const same = sourceBefore.sha256 === sourceAfter.sha256 && sourceBefore.size === sourceAfter.size && sourceBefore.mtimeMs === sourceAfter.mtimeMs;
    checks.push(same ? pass("source_untouched", `sha256 ${sourceAfter.sha256.slice(0, 12)}… unchanged`) : fail("source_untouched", "SOURCE CHANGED during the job"));
  }
  return checks;
}
