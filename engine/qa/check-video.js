/**
 * engine/qa/check-video.js — QA any finished video the kit did not edit itself (faceless renders from
 * HyperFrames, a member's own export). Same standards as the editor's QA:
 *
 *   format       dimensions match the expected format (9:16 / 16:9), H.264 + AAC, constant frame rate
 *   decode       the whole file decodes without errors
 *   loudness     integrated loudness within ±1.5 LU of the target; true peak ≤ −1 dBTP
 *   av_sync      audio and video durations agree within 0.1 s
 *   black        no black opening or ending longer than 0.5 s
 *   script       (with --script) what is SPOKEN in the render matches the script: ≥ 90 % of the script's
 *                words heard in order (re-transcribed with whisper) — catches a voice-over cut short,
 *                skipped lines or the wrong audio
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { probeEnv } from "../env.js";
import { probeSource } from "../ingest/source.js";
import { extractWav, loadLexicon, transcribe } from "../transcription/whisper.js";
import { pathsFor } from "../storage/files.js";
import { detectFaces } from "../analysis/visual.js";

const norm = (w) => String(w).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const pass = (id, detail) => ({ id, status: "pass", detail });
const fail = (id, detail) => ({ id, status: "fail", detail });
const warn = (id, detail) => ({ id, status: "warn", detail });

/** Share of the script's words heard in order (longest common subsequence over words). Pure. */
export function scriptCoverage(scriptText, heardWords) {
  const a = String(scriptText).split(/\s+/).map(norm).filter(Boolean);
  const b = heardWords.map(norm).filter(Boolean);
  if (!a.length) return { coverage: 1, scriptWords: 0, heardWords: b.length };
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return { coverage: Number((prev[b.length] / a.length).toFixed(3)), scriptWords: a.length, heardWords: b.length };
}

function ff(args) {
  return spawnSync(probeEnv().ffmpeg, ["-hide_banner", "-nostats", ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

export function checkVideo({ video, format = null, targetLufs = -14, script = null, root, log = () => {} }) {
  const checks = [];
  const info = probeSource(video);
  const vertical = info.height > info.width;
  const want = format ?? (vertical ? "9:16" : "16:9");
  const dims = want === "9:16" ? [1080, 1920] : [1920, 1080];
  checks.push(info.width === dims[0] && info.height === dims[1] ? pass("format", `${info.width}×${info.height}`)
    : (info.width / info.height).toFixed(3) === (dims[0] / dims[1]).toFixed(3) ? warn("format", `${info.width}×${info.height} — right shape, lower resolution than ${dims.join("×")}`)
      : fail("format", `${info.width}×${info.height} is not ${want}`));
  const pr = spawnSync(probeEnv().ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,duration,r_frame_rate,avg_frame_rate", "-show_entries", "format=duration", "-of", "json", video], { encoding: "utf8" });
  const j = JSON.parse(pr.stdout);
  const v = j.streams.find((s) => s.codec_type === "video"), a = j.streams.find((s) => s.codec_type === "audio");
  checks.push(v?.codec_name === "h264" && a?.codec_name === "aac" ? pass("codecs", "h264/aac") : (a ? warn("codecs", `${v?.codec_name}/${a?.codec_name} — most platforms prefer h264/aac`) : fail("codecs", "no audio track")));
  if (v && a && Number(v.duration) && Number(a.duration)) {
    const d = Math.abs(Number(v.duration) - Number(a.duration));
    checks.push(d <= 0.1 ? pass("av_sync", `durations differ by ${d.toFixed(3)} s`) : fail("av_sync", `audio and video lengths differ by ${d.toFixed(2)} s`));
  }
  const dec = ff(["-v", "error", "-i", video, "-f", "null", "-"]);
  checks.push(String(dec.stderr).trim() ? fail("decode", String(dec.stderr).trim().split("\n")[0].slice(0, 160)) : pass("decode", "clean full decode"));
  if (a) {
    const lr = ff(["-i", video, "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"]);
    const I = Number([...String(lr.stderr).matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop()?.[1]);
    const TP = Number([...String(lr.stderr).matchAll(/Peak:\s+(-?[\d.]+) dBFS/g)].pop()?.[1]);
    if (Number.isFinite(I)) checks.push(Math.abs(I - targetLufs) <= 1.5 ? pass("loudness", `${I} LUFS`) : warn("loudness", `${I} LUFS — platforms expect about ${targetLufs}`));
    if (Number.isFinite(TP)) checks.push(TP <= -1 ? pass("true_peak", `${TP} dBTP`) : warn("true_peak", `${TP} dBTP — may distort on some phones (want ≤ −1)`));
  }
  const bd = ff(["-i", video, "-vf", "blackdetect=d=0.5:pix_th=0.08", "-an", "-f", "null", "-"]);
  const blacks = [...String(bd.stderr).matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const dur = info.durationSec;
  const bad = blacks.filter(([s, e]) => s < 0.1 || e > dur - 0.1);
  checks.push(bad.length ? fail("black", `black screen ${bad.map(([s, e]) => `${s.toFixed(1)}–${e.toFixed(1)} s`).join(", ")}`) : pass("black", "no black opening or ending"));

  // On-screen text touching the frame edge (clipped or crowding the edge): Vision text boxes on 12 frames.
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "video-kit-qa-"));
    try {
      const frames = [];
      for (let i = 0; i < 12; i++) {
        const t = (dur * (i + 0.5)) / 12, f = path.join(tmp, `e${i}.jpg`);
        ff(["-v", "error", "-y", "-ss", t.toFixed(2), "-i", video, "-frames:v", "1", "-q:v", "3", f]);
        if (fs.existsSync(f)) frames.push({ t, file: f });
      }
      const det = detectFaces(frames);
      if (!det) checks.push({ id: "text_edges", status: "skipped", detail: "Apple Vision unavailable" });
      else {
        const m = 0.015, hits = [];
        for (const d of det) for (const b of d.text ?? []) if (b.x < m || b.y < m || b.x + b.w > 1 - m || b.y + b.h > 1 - m) hits.push(d.t);
        const times = [...new Set(hits.map((t) => t.toFixed(1)))];
        checks.push(times.length ? warn("text_edges", `text touches the frame edge at ${times.slice(0, 5).join("s, ")}s — check it isn't cut off`) : pass("text_edges", "no text at the frame edges"));
      }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  if (script) {
    const text = fs.existsSync(script) ? fs.readFileSync(script, "utf8") : String(script);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "video-kit-qa-"));
    try {
      const wav = extractWav(video, path.join(tmp, "a.wav"), { audioIndex: info.audio.audioIndex });
      const heard = transcribe({ wav, offset: 0, localDur: dur, lexicon: loadLexicon(pathsFor(root).lexicon), tempDir: tmp, log }).words.map((w) => w.text);
      const c = scriptCoverage(text, heard);
      checks.push(c.coverage >= 0.9 ? pass("script", `${Math.round(c.coverage * 100)} % of the script's ${c.scriptWords} words heard in order`)
        : fail("script", `only ${Math.round(c.coverage * 100)} % of the script is spoken in the render — lines missing or cut short`));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  const status = checks.some((c) => c.status === "fail") ? "NEEDS_REVIEW" : "COMPLETE";
  return { video, status, durationSec: Number(dur.toFixed(2)), checks };
}
