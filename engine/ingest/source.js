/**
 * engine/ingest/source.js — what IS this file? Probe once, decide everything from facts.
 *
 * parseProbe() is pure (tested against canned ffprobe JSON for rotation, HLG, VFR, multiple audio
 * tracks and start offsets) because those are the cases that silently produce a wrong edit:
 *   - rotation metadata: phone footage stored landscape with a 90° matrix → crop maths must use the
 *     DISPLAY size or the crop lands on the wrong axis;
 *   - HLG/PQ: passed straight into 8-bit bt709 H.264 it looks washed out and no check notices;
 *   - VFR: the punch-in expression uses frame index ÷ fps, which is only time if the rate is constant;
 *   - several audio tracks: newer iPhones add a spatial track; the wrong one is silent or doubled;
 *   - non-zero start_time: video and audio offsets that differ shift A/V sync after trimming.
 *
 * The source is only ever READ. assertOutputOutsideSource() refuses any output path inside the
 * source's folder so nothing is ever written next to a master.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { probeEnv } from "../env.js";

const HDR_TRANSFERS = new Set(["arib-std-b67", "smpte2084"]);

function rational(s) {
  const [n, d] = String(s ?? "0/1").split("/").map(Number);
  return d ? n / d : n || 0;
}

function rotationOf(stream) {
  const sd = (stream.side_data_list ?? []).find((d) => d.rotation !== undefined);
  if (sd) return ((Math.round(Number(sd.rotation)) % 360) + 360) % 360;
  if (stream.tags?.rotate !== undefined) return ((Math.round(Number(stream.tags.rotate)) % 360) + 360) % 360;
  return 0;
}

/** Nearest allowed output rate; anything not within 2% of an allowed rate falls back. */
export function chooseOutputFps(srcFps, allowed = [24, 25, 30, 50, 60], fallback = 30) {
  let best = null;
  for (const a of allowed) if (Math.abs(srcFps - a) / a <= 0.02 && (!best || Math.abs(srcFps - a) < Math.abs(srcFps - best))) best = a;
  return best ?? fallback;
}

export function parseProbe(json) {
  const streams = json.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video" && !(s.disposition?.attached_pic));
  const audios = streams.filter((s) => s.codec_type === "audio");
  // The edit can't run past the last picture frame. When the audio runs longer than the video (common in
  // downloads and some phone files), the container duration is the audio's, and the render's tail would
  // carry sound with no picture (an av_sync failure). Use the video stream's own length when it has one.
  const formatSec = Number.parseFloat(json.format?.duration ?? "NaN");
  const videoSec = Number.parseFloat(v?.duration ?? "NaN");
  const durationSec = Number.isFinite(videoSec) && videoSec > 0
    ? (Number.isFinite(formatSec) && formatSec > 0 ? Math.min(formatSec, videoSec) : videoSec)
    : formatSec;
  const problems = [];
  if (!Number.isFinite(durationSec) || durationSec <= 0) problems.push("no usable duration — file is corrupt or not media");
  if (!v) problems.push("no video stream");
  if (!audios.length) problems.push("no audio stream — nothing to transcribe or cut on");
  if (problems.length) {
    const e = new Error(`source rejected: ${problems.join("; ")}`);
    e.code = "SOURCE_REJECTED";
    throw e;
  }
  // Audio: the default-disposition track, else the one with most channels, else the first.
  const audio = audios.find((a) => a.disposition?.default === 1) ?? [...audios].sort((a, b) => (b.channels ?? 0) - (a.channels ?? 0))[0];
  const rotation = rotationOf(v);
  const swap = rotation === 90 || rotation === 270;
  const rFps = rational(v.r_frame_rate), aFps = rational(v.avg_frame_rate) || rFps;
  const vfr = rFps > 0 && aFps > 0 && Math.abs(rFps - aFps) / rFps > 0.01;
  const transfer = v.color_transfer ?? "unknown";
  const vStart = Number.parseFloat(v.start_time ?? "0") || 0;
  const aStart = Number.parseFloat(audio.start_time ?? "0") || 0;
  return {
    durationSec,
    codedWidth: v.width, codedHeight: v.height,
    width: swap ? v.height : v.width,
    height: swap ? v.width : v.height,
    rotation,
    fps: aFps, fpsRational: v.avg_frame_rate ?? v.r_frame_rate, vfr,
    videoCodec: v.codec_name, pixFmt: v.pix_fmt,
    bitDepth: /10le|10be|p010|12le/.test(String(v.pix_fmt)) ? 10 : 8,
    colour: { transfer, primaries: v.color_primaries ?? "unknown", space: v.color_space ?? "unknown", range: v.color_range ?? "unknown" },
    hdr: HDR_TRANSFERS.has(transfer),
    audio: { streamIndex: audio.index, audioIndex: audios.indexOf(audio), codec: audio.codec_name, sampleRate: Number(audio.sample_rate), channels: audio.channels },
    audioStreams: audios.length,
    startOffsetSec: Number((aStart - vStart).toFixed(4)),
    aspect: (swap ? v.height : v.width) / (swap ? v.width : v.height),
  };
}

export function probeSource(file) {
  const { ffprobe } = probeEnv();
  const r = spawnSync(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) {
    const e = new Error(`ffprobe could not read ${file}: ${String(r.stderr).trim().split("\n").slice(-3).join(" ")}`);
    e.code = "SOURCE_REJECTED";
    throw e;
  }
  return parseProbe(JSON.parse(r.stdout));
}

/** Warnings worth showing the operator (not fatal). */
export function sourceWarnings(info) {
  const w = [];
  if (info.vfr) w.push(`variable frame rate (${info.fps.toFixed(3)} avg) — normalised to CFR before cutting`);
  if (info.hdr) w.push(`HDR source (${info.colour.transfer}) — tone-mapped to bt709; check colour on review`);
  if (info.rotation) w.push(`rotation metadata ${info.rotation}° — display size ${info.width}x${info.height}`);
  if (info.audioStreams > 1) w.push(`${info.audioStreams} audio tracks — using track ${info.audio.audioIndex}`);
  if (Math.abs(info.startOffsetSec) > 0.02) w.push(`audio starts ${info.startOffsetSec}s relative to video — compensated`);
  return w;
}

/** Refuse to write anywhere inside the source's own folder. */
export function assertOutputOutsideSource(outPath, sourcePath) {
  const srcDir = path.resolve(path.dirname(sourcePath)) + path.sep;
  const out = path.resolve(outPath);
  if ((out + path.sep).startsWith(srcDir)) {
    const e = new Error(`refusing to write ${out} inside the source folder ${srcDir} — originals are read-only`);
    e.code = "OUTPUT_IN_SOURCE_DIR";
    throw e;
  }
}
