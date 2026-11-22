/**
 * engine/transcription/whisper.js — audio → words the rest of the editor can trust.
 *
 *   1. extract 16 kHz mono PCM (the explicit audio track, optional range)
 *   2. whisper.cpp large-v3-turbo, one word per segment, primed with the brand lexicon
 *   3. whisperX forced alignment — VERIFIED before it is accepted, never silently trusted
 *   4. brand-lexicon correction of TEXT only
 *   5. drop hallucinations: low confidence AND no sound where the word is (both, never one)
 *
 * Same engine and model as the live content-sync transcription and the scripts/edit pipeline, so
 * there is one transcription stack on this machine. All decisions live in words.js.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeEnv } from "../env.js";
import { applyLexicon, checkAlignment, lexiconPrompt, mergeAlignment, sanitiseWords, validateLexicon, wordsFromWhisperJson } from "./words.js";
import { audibleFraction } from "../rough-cut/cuts.js";

const ALIGN_PY = path.join(path.dirname(fileURLToPath(import.meta.url)), "py", "align_words.py");

function run(bin, args, label) {
  const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (r.error) throw new Error(`${label}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status}): ${String(r.stderr).trim().split("\n").slice(-4).join(" | ")}`);
  return r;
}

/** 16 kHz mono PCM from the chosen audio track. range = {start,end} in source seconds, optional. */
export function extractWav(src, dest, { audioIndex = 0, range = null } = {}) {
  const { ffmpeg } = probeEnv();
  const args = ["-y", "-v", "error"];
  if (range) args.push("-ss", range.start.toFixed(3), "-to", range.end.toFixed(3));
  args.push("-i", src, "-map", `0:a:${audioIndex}`, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", dest);
  run(ffmpeg, args, "extract audio");
  return dest;
}

export function loadLexicon(file) {
  if (!fs.existsSync(file)) return { replacements: {}, phrases: {}, prompt: "" };
  const lex = JSON.parse(fs.readFileSync(file, "utf8"));
  const errors = validateLexicon(lex);
  if (errors.length) throw new Error(`${file} is invalid:\n  - ${errors.join("\n  - ")}`);
  return lex;
}

export function runWhisper(wav, { outPrefix, prompt = "" }) {
  const env = probeEnv();
  const args = ["-m", env.model, "-f", wav, "-ml", "1", "-sow", "-oj", "-ojf", "-of", outPrefix, "-np", "-l", "en", "-et", "2.8"];
  if (prompt) args.push("--prompt", prompt);
  run(env.whisper, args, "whisper-cli");
  return wordsFromWhisperJson(JSON.parse(fs.readFileSync(`${outPrefix}.json`, "utf8")));
}

/** Forced alignment. Never silent: `used` and `verdict` say exactly what happened. */
export function alignWords(wav, words, durationSec, { workDir }) {
  const env = probeEnv();
  if (!env.alignPython) return { words, used: "whisper.cpp (whisperX unavailable)", verdict: { ok: false, reasons: ["no python with whisperx"] } };
  const inPath = path.join(workDir, "align.in.json"), outPath = path.join(workDir, "align.out.json");
  fs.writeFileSync(inPath, JSON.stringify(words.map(({ text, start, end }) => ({ text, start, end }))));
  const r = spawnSync(env.alignPython, [ALIGN_PY, wav, inPath, outPath, String(durationSec)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 });
  if (r.status !== 0 || !fs.existsSync(outPath)) {
    return { words, used: "whisper.cpp (forced alignment FAILED)", verdict: { ok: false, reasons: [`whisperX: ${String(r.stderr || r.error?.message).trim().slice(-300)}`] } };
  }
  const aligned = JSON.parse(fs.readFileSync(outPath, "utf8"));
  const verdict = checkAlignment({ raw: words, aligned, durationSec });
  if (!verdict.ok) return { words, used: "whisper.cpp (forced alignment REJECTED)", verdict };
  return { words: mergeAlignment(words, aligned), used: "whisperX forced alignment", verdict };
}

/**
 * Whole transcription stage on an already-extracted 16 kHz wav (extractWav). If the wav covers a
 * range, `offset` is its source start; word times are returned on the SOURCE timeline either way.
 * `audibleSpans` (source timeline) enables hallucination removal.
 */
export function transcribe({ wav, offset = 0, localDur, range = null, lexicon, tempDir, audibleSpans = null, log = () => {} }) {
  const raw = runWhisper(wav, { outPrefix: path.join(tempDir, "whisper"), prompt: lexiconPrompt(lexicon) });
  const { words: clean, report } = sanitiseWords(raw, localDur);
  log(`whisper: ${report.input} → ${report.output} words`);
  if (!clean.length) throw new Error("transcript is empty after sanitising — check the audio track");
  const { words: timed, used, verdict } = alignWords(wav, clean, localDur, { workDir: tempDir });
  log(`align: ${used}${verdict.ok ? ` (median correction ${verdict.stats.medianDriftSec}s)` : ` — ${verdict.reasons.join("; ")}`}`);
  const { words: rescored, report: report2 } = sanitiseWords(timed, localDur);
  const corrected = applyLexicon(rescored, lexicon);
  const shifted = corrected.map((w) => ({ ...w, start: Number((w.start + offset).toFixed(3)), end: Number((w.end + offset).toFixed(3)) }));

  // A hallucination is a weak word with NO SOUND where it supposedly is. Score alone flags ordinary
  // short words ("to", "a") — measured: 59 false alarms on one real episode.
  const suspects = [];
  const words = Array.isArray(audibleSpans) ? shifted.filter((w) => {
    const c = Number.isFinite(w.score) ? w.score : w.prob;
    if (Number.isFinite(c) && c <= 0.25 && audibleFraction(w, audibleSpans) <= 0.5) { suspects.push(w); return false; }
    return true;
  }) : shifted;
  if (suspects.length) log(`dropped ${suspects.length} probable hallucination(s): ${suspects.map((w) => w.text).join(" ")}`);

  return {
    words,
    meta: {
      engine: "whisper.cpp", model: path.basename(probeEnv().model), alignment: used, alignmentOk: verdict.ok,
      alignmentReasons: verdict.reasons ?? [], alignmentStats: verdict.stats ?? null,
      sanitise: report, lowScoreWords: report2.suspect.length,
      lexiconCorrections: corrected.filter((w, i) => w.text !== rescored[i].text).length,
      droppedHallucinations: suspects.map(({ text, start, end }) => ({ text, start, end })),
      range,
    },
  };
}
