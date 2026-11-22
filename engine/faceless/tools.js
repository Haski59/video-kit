/**
 * engine/faceless/tools.js — the two deterministic steps around a faceless render.
 *
 *   voice()   script text → voice.wav with the local Kokoro model through HyperFrames' `tts`, using the
 *             kit's own Python environment (~/.cache/video-kit/voice-venv, made by setup.sh). The venv
 *             lives at a SHORT path on purpose: espeak-ng truncates long data paths and then fails
 *             with "Error processing file …/phontab".
 *   finish()  a rendered video → platform loudness (two-pass loudnorm to −14 LUFS, true peak −1.5 dBTP)
 *             with the picture stream copied untouched.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { probeEnv } from "../env.js";

export const HYPERFRAMES = "hyperframes@0.9.78";
export const VOICE_VENV = path.join(os.homedir(), ".cache", "video-kit", "voice-venv");
export const VOICES = ["af_heart", "af_nova", "af_sky", "am_adam", "am_michael", "bf_emma", "bf_isabella", "bm_george"];

export function voicePython() {
  const py = path.join(VOICE_VENV, "bin", "python");
  if (!fs.existsSync(py)) throw new Error("the voice environment is missing — run ./setup.sh (it creates it)");
  const r = spawnSync(py, ["-c", "import kokoro_onnx, soundfile"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("the voice environment is broken — run ./setup.sh again");
  return py;
}

export function voice({ script, out, voiceId = "am_michael", speed = 1.0, log = () => {} }) {
  if (!VOICES.includes(voiceId)) throw new Error(`voice "${voiceId}" is not one of: ${VOICES.join(", ")}`);
  if (!(speed >= 0.7 && speed <= 1.5)) throw new Error("speed must be between 0.7 and 1.5");
  const text = fs.existsSync(script) ? fs.readFileSync(script, "utf8").trim() : String(script).trim();
  if (!text) throw new Error("the script is empty");
  const py = voicePython();
  log(`voice: ${voiceId} at ${speed}× (local, free)`);
  const r = spawnSync("npx", ["-y", HYPERFRAMES, "tts", text, "-v", voiceId, "-s", String(speed), "-o", path.resolve(out)],
    { encoding: "utf8", env: { ...process.env, HYPERFRAMES_PYTHON: py }, maxBuffer: 16 * 1024 * 1024, timeout: 15 * 60 * 1000 });
  if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`voice-over failed: ${String(r.stderr || r.stdout).trim().split("\n").filter((l) => !/skills/.test(l)).slice(-2).join(" ")}`);
  const pr = spawnSync(probeEnv().ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out], { encoding: "utf8" });
  return { out: path.resolve(out), durationSec: Number(Number(pr.stdout.trim()).toFixed(2)) };
}

export function finish({ input, out, targetLufs = -14, truePeak = -1.5 }) {
  const { ffmpeg } = probeEnv();
  const measure = spawnSync(ffmpeg, ["-hide_banner", "-nostats", "-i", input, "-af", `loudnorm=I=${targetLufs}:TP=${truePeak}:LRA=11:print_format=json`, "-f", "null", "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const m = String(measure.stderr).match(/\{\s*"input_i"[\s\S]*?\}/);
  if (!m) throw new Error("could not measure loudness (does the video have sound?)");
  const j = JSON.parse(m[0]);
  const af = `loudnorm=I=${targetLufs}:TP=${truePeak}:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true,aresample=48000`;
  if (path.resolve(out) === path.resolve(input)) throw new Error("write the finished file to a new name");
  const r = spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-i", input, "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-af", af, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`finishing failed: ${String(r.stderr).trim().slice(-200)}`);
  return { out: path.resolve(out), before: Number(j.input_i), target: targetLufs };
}
