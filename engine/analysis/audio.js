/**
 * engine/analysis/audio.js — the waveform's independent opinion.
 *
 * detectAudible() is the second signal the rough cut requires before it removes "dead air": it
 * knows nothing about words, so a cough, a bumped desk or a word whisper missed still vetoes a cut.
 * The threshold is derived from each file's own loudness (a fixed −50 dB sits inside ordinary room
 * tone and vetoes everything). Ported from scripts/edit/transcribe.js.
 *
 * channelBalance() catches a lav recorded on one channel only — left as-is, the reel plays from one
 * ear on headphones.
 */
import { spawnSync } from "node:child_process";
import { probeEnv } from "../env.js";

function ffStderr(args, label) {
  const { ffmpeg } = probeEnv();
  const r = spawnSync(ffmpeg, ["-hide_banner", "-nostats", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`${label}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status}): ${String(r.stderr).trim().split("\n").slice(-4).join(" | ")}`);
  return String(r.stderr ?? "");
}

export function measureLevels(wav) {
  const log = ffStderr(["-i", wav, "-af", "volumedetect", "-f", "null", "-"], "volumedetect");
  const num = (re) => { const m = log.match(re); return m ? Number.parseFloat(m[1]) : null; };
  const meanDb = num(/mean_volume:\s*(-?[\d.]+) dB/), maxDb = num(/max_volume:\s*(-?[\d.]+) dB/);
  if (meanDb === null || maxDb === null) throw new Error(`volumedetect reported no level for ${wav} — the file may have no audio`);
  return { meanDb, maxDb };
}

function wavDuration(wav) {
  const { ffprobe } = probeEnv();
  const r = spawnSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav], { encoding: "utf8" });
  const d = Number.parseFloat(r.stdout);
  return Number.isFinite(d) && d > 0 ? d : null;
}

/** Parse silencedetect stderr into audible spans over [0, durationSec]. Pure. */
export function audibleFromSilenceLog(log, durationSec) {
  const silences = [];
  const re = /silence_start:\s*(-?[\d.]+)|silence_end:\s*(-?[\d.]+)/g;
  let m, pending = null;
  while ((m = re.exec(log))) {
    if (m[1] !== undefined) pending = Number.parseFloat(m[1]);
    else if (pending !== null) { silences.push({ start: Math.max(0, pending), end: Number.parseFloat(m[2]) }); pending = null; }
  }
  if (pending !== null) silences.push({ start: Math.max(0, pending), end: durationSec });
  const spans = [];
  let cursor = 0;
  for (const s of silences.sort((a, b) => a.start - b.start)) {
    if (s.start - cursor > 1e-3) spans.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (durationSec - cursor > 1e-3) spans.push({ start: cursor, end: durationSec });
  return spans;
}

/**
 * Audible spans of `wav` (its own timeline; add `offset` for range jobs).
 * silencedetect reports on STDERR even on exit 0 — reading stdout silently reports "no silence".
 */
export function detectAudible(wav, durationSec, { offsetDb = 25, minDb = -60, maxDb = -30, minSilenceSec = 0.2, offset = 0 } = {}) {
  const { meanDb } = measureLevels(wav);
  const thresholdDb = Math.min(maxDb, Math.max(minDb, Math.round(meanDb - offsetDb)));
  const log = ffStderr(["-i", wav, "-af", `silencedetect=noise=${thresholdDb}dB:d=${minSilenceSec}`, "-f", "null", "-"], "silencedetect");
  // Past the end of the audio track there is NO sound — silencedetect says nothing about it, so the
  // span must end at the wav's real length, not the picture's (camera audio that stops early read as
  // "audible" and vetoed the tail cut).
  const audioDur = Math.min(durationSec, wavDuration(wav) ?? durationSec);
  const spans = audibleFromSilenceLog(log, audioDur).map((s) => ({ start: Number((s.start + offset).toFixed(3)), end: Number((s.end + offset).toFixed(3)) }));
  const frac = spans.reduce((a, s) => a + (s.end - s.start), 0) / durationSec;
  const warnings = [];
  if (frac < 0.1) warnings.push(`only ${(frac * 100).toFixed(1)}% reads as audible at ${thresholdDb} dB — threshold too high or near-silent track`);
  if (frac > 0.995) warnings.push(`${(frac * 100).toFixed(1)}% reads as audible at ${thresholdDb} dB — noise floor above threshold; dead air cannot be verified`);
  return { spans, thresholdDb, meanDb, audibleFrac: Number(frac.toFixed(3)), warnings };
}

/**
 * Per-channel RMS of the chosen track. If one channel is >20 dB quieter, the mic is on the other
 * channel only and the renderer duplicates it (pan) instead of shipping a one-ear reel.
 */
export function channelBalance(src, { audioIndex = 0, channels = 2 } = {}) {
  if (channels < 2) return { channels, fix: null };
  const log = ffStderr(["-i", src, "-map", `0:a:${audioIndex}`, "-af", "astats=measure_overall=none:measure_perchannel=RMS_level", "-f", "null", "-"], "astats");
  const levels = [...log.matchAll(/Channel:\s*(\d+)[\s\S]*?RMS level dB:\s*(-?[\d.]+|-inf)/g)].map((m) => (m[2] === "-inf" ? -120 : Number(m[2])));
  if (levels.length < 2) return { channels, levels, fix: null };
  const [l, r] = levels;
  const fix = l - r > 20 ? "left" : r - l > 20 ? "right" : null;
  return { channels, levels, fix };
}
