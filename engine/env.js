/**
 * engine/env.js — resolve and verify every external binary the short-form editor uses.
 *
 * The `ffmpeg` on this Mac's PATH is Homebrew's slim build: no libass, no freetype, so the `ass`
 * filter does not exist in it and captions cannot be burned at all. Everything here goes through
 * the keg-only ffmpeg-full by absolute path, and probeEnv() proves the filters exist before a job
 * starts rather than letting a render die at the last stage. (Lesson carried over from the
 * scripts/edit pipeline.)
 *
 * Nothing in engine may call bare `ffmpeg`.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FFMPEG_CANDIDATES = [
  process.env.KIT_FFMPEG,
  "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",
  "/usr/local/opt/ffmpeg-full/bin/ffmpeg",
].filter(Boolean);

const MODEL_CANDIDATES = [
  process.env.WHISPER_MODEL,
  join(homedir(), ".cache/whisper-models/ggml-large-v3-turbo.bin"),
  join(homedir(), ".cache/whisper-models/ggml-base.en.bin"),
].filter(Boolean);

const CHROME_CANDIDATES = [
  process.env.KIT_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean);

/** `ass` burns captions, `perspective` does eased punch-ins, the rest build the cut and QC. */
export const REQUIRED_FILTERS = [
  "ass", "trim", "atrim", "concat", "crop", "scale", "perspective", "overlay",
  "silencedetect", "loudnorm", "alimiter", "blackdetect", "ebur128", "astats",
];

export class EnvError extends Error {
  constructor(message, remedy) {
    super(remedy ? `${message}\n  → ${remedy}` : message);
    this.name = "EnvError";
    this.remedy = remedy;
  }
}

function run(bin, args) {
  return execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function which(name) {
  try { return run("/bin/sh", ["-c", `command -v ${name}`]).trim(); } catch { return ""; }
}

function hasFilter(bin, filter) {
  try { return !run(bin, ["-hide_banner", "-h", `filter=${filter}`]).includes("Unknown filter"); } catch { return false; }
}

/** Python that can `import whisperx` without touching the network. System python first. */
function findAlignPython() {
  for (const py of [process.env.KIT_ALIGN_PYTHON, "/usr/bin/python3"].filter(Boolean)) {
    if (!existsSync(py)) continue;
    try {
      execFileSync(py, ["-c", "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('whisperx') else 1)"], { stdio: "ignore" });
      return py;
    } catch { /* not this one */ }
  }
  return "";
}

let _cache = null;

/** Resolve every binary and prove it works. Throws EnvError with a remedy. Cached per process. */
export function probeEnv({ force = false } = {}) {
  if (_cache && !force) return _cache;
  const ffmpeg = FFMPEG_CANDIDATES.find((p) => existsSync(p));
  if (!ffmpeg) {
    throw new EnvError(`No ffmpeg-full build found (looked in: ${FFMPEG_CANDIDATES.join(", ")}).`,
      "brew install ffmpeg-full — the plain `ffmpeg` formula has no libass and cannot draw captions.");
  }
  const missing = REQUIRED_FILTERS.filter((f) => !hasFilter(ffmpeg, f));
  if (missing.length) {
    throw new EnvError(`${ffmpeg} is missing filter(s): ${missing.join(", ")}.`, "Reinstall with `brew install ffmpeg-full`.");
  }
  const ffprobe = ffmpeg.replace(/ffmpeg$/, "ffprobe");
  if (!existsSync(ffprobe)) throw new EnvError(`ffprobe not found beside ${ffmpeg}.`, "Reinstall ffmpeg-full.");

  const whisper = which("whisper-cli");
  if (!whisper) throw new EnvError("whisper-cli not found on PATH.", "brew install whisper-cpp");
  const model = MODEL_CANDIDATES.find((p) => existsSync(p));
  if (!model) throw new EnvError("No whisper model found.", "Put ggml-large-v3-turbo.bin in ~/.cache/whisper-models or set WHISPER_MODEL.");

  const swift = which("swift");
  const swiftc = which("swiftc");
  const fcMatch = existsSync("/opt/homebrew/opt/fontconfig/bin/fc-match") ? "/opt/homebrew/opt/fontconfig/bin/fc-match" : which("fc-match");
  const chrome = CHROME_CANDIDATES.find((p) => existsSync(p)) || "";
  const alignPython = findAlignPython();
  const ffmpegVersion = run(ffmpeg, ["-hide_banner", "-version"]).split("\n")[0];
  _cache = { ffmpeg, ffprobe, ffmpegVersion, whisper, model, swift, swiftc, fcMatch, chrome, alignPython };
  return _cache;
}

/** Human-readable report for `npm run shorts -- --check`. */
export function describeEnv() {
  const e = probeEnv();
  return [
    `ffmpeg   ${e.ffmpeg}`,
    `         ${e.ffmpegVersion}`,
    `         filters ok: ${REQUIRED_FILTERS.join(", ")}`,
    `whisper  ${e.whisper}`,
    `model    ${e.model}`,
    `align    ${e.alignPython || "UNAVAILABLE — whisper.cpp timings only (less accurate cuts)"}`,
    `vision   ${e.swiftc || e.swift || "UNAVAILABLE — no face tracking, centre crop only"}`,
    `fonts    ${e.fcMatch || "fc-match missing — cannot verify caption font"}`,
    `chrome   ${e.chrome || "UNAVAILABLE — graphics components cannot render"}`,
  ].join("\n");
}

/** Resolve a family through fontconfig — the resolver libass uses. libass substitutes silently. */
export function resolveFont(family) {
  const { fcMatch } = probeEnv();
  let resolved = "";
  try { resolved = run(fcMatch, ["-f", "%{family}", family]).trim(); } catch { resolved = ""; }
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  // fc-match prints every family alias comma-separated ("Avenir Next,Avenir Next Bold"); exact if any matches.
  const exact = resolved.split(",").some((f) => norm(f) === norm(family));
  return { requested: family, resolved, exact };
}

/** Throw unless `family` resolves to itself. Called before any ASS file is written. */
export function assertFont(family) {
  const r = resolveFont(family);
  if (!r.exact) {
    throw new EnvError(`Font "${family}" is not installed — fontconfig resolves it to "${r.resolved || "nothing"}".`,
      "libass would silently render in the wrong typeface. Pick an installed family (fc-list : family).");
  }
  return r;
}
