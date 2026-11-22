/**
 * engine/reference/analyse.js — measure HOW a reference video is made, so a member's video can be
 * edited (or generated) the same way.
 *
 * What is kept: numbers and a written style brief — cut rate, shot length, punch-in rate, caption
 * position/size/case/words-per-line/colours, on-screen text rate, B-roll share, speech pace and pause
 * lengths, hook timing, music bed, loudness, and the script's structure. What is NOT kept: the
 * reference's footage, frames, audio, music, logos or words. The downloaded file is deleted when the
 * analysis ends.
 *
 * The pure functions (shotStats, captionStats, pauseStats, zoomStats, musicGuess, slugify) are unit
 * tested; analyseReference() orchestrates ffmpeg, whisper, Apple Vision and yt-dlp.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { probeEnv } from "../env.js";
import { probeSource } from "../ingest/source.js";
import { extractWav, loadLexicon, transcribe } from "../transcription/whisper.js";
import { detectAudible } from "../analysis/audio.js";
import { detectFaces } from "../analysis/visual.js";
import { readWav, envelopeDb, speechThreshold, snapWordsToAudio } from "../rough-cut/speech-edges.js";
import { pathsFor, writeJsonAtomic } from "../storage/files.js";
import { runClaude, parseJson, MODEL } from "../llm/claude.js";
import { sentences } from "../clips/find.js";

const OCR_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "ocr.swift");
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const r2 = (n) => (n === null || n === undefined || !Number.isFinite(n) ? null : Number(n.toFixed(2)));
const norm = (w) => String(w).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export const slugify = (s) => String(s || "reference").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32) || "REFERENCE";

// ── pure metrics ─────────────────────────────────────────────────────────────

/** Scene-cut times → cuts per minute and shot lengths. */
export function shotStats(cutTimes, durationSec) {
  const t = [0, ...cutTimes.filter((x) => x > 0.05 && x < durationSec - 0.05).sort((a, b) => a - b), durationSec];
  const shots = t.slice(1).map((x, i) => x - t[i]).filter((d) => d > 0.04);
  return { cuts: t.length - 2, cutsPerMin: r2(((t.length - 2) / durationSec) * 60), medianShotSec: r2(median(shots)), p10ShotSec: r2(pct(shots, 0.1)), p90ShotSec: r2(pct(shots, 0.9)) };
}

/** Pauses between spoken words. */
export function pauseStats(words) {
  const gaps = [];
  for (let i = 1; i < words.length; i++) gaps.push(words[i].start - words[i - 1].end);
  const pauses = gaps.filter((g) => g >= 0.15);
  const spokenSec = words.length ? words[words.length - 1].end - words[0].start : 0;
  return {
    wordsPerMin: r2(spokenSec ? (words.length / spokenSec) * 60 : 0),
    medianPauseSec: r2(median(pauses) ?? 0), p90PauseSec: r2(pct(pauses, 0.9) ?? 0),
    longPausesPerMin: r2(spokenSec ? (gaps.filter((g) => g > 0.7).length / spokenSec) * 60 : 0),
    firstWordSec: r2(words[0]?.start ?? 0),
  };
}

/**
 * OCR lines per sampled frame → captions vs other on-screen text.
 * A line is a CAPTION when most of its words were spoken within ±1.5 s of that frame.
 * samples: [{t, lines:[{text,x,y,w,h,c}], colours?:[{line, fg:[r,g,b], accent:[r,g,b]|null}]}]
 */
export function captionStats(samples, words, { frameH = 1080 } = {}) {
  const near = (t) => new Set(words.filter((w) => w.end >= t - 1.5 && w.start <= t + 1.5).map((w) => norm(w.text)));
  const caps = [], overlays = [];
  for (const s of samples) {
    const spoken = near(s.t);
    for (const l of s.lines ?? []) {
      if (l.c < 0.4) continue;
      const toks = l.text.split(/\s+/).map(norm).filter(Boolean);
      if (!toks.length) continue;
      const hit = toks.filter((w) => spoken.has(w)).length / toks.length;
      const rec = { ...l, t: s.t, words: toks.length, upper: l.text === l.text.toUpperCase() && /[A-Z]/.test(l.text) };
      if (hit >= 0.6) caps.push(rec);
      // An edit overlay is crisp, deliberate text: read with high confidence and at least two letters.
      else if (l.c >= 0.8 && (l.text.match(/\p{L}/gu) ?? []).length >= 2) overlays.push(rec);
    }
  }
  // Text found in the same place across many frames (a logo on a cap or shirt, a sign, a watermark) is
  // scenery, not an edit overlay. Matched by POSITION: OCR reads the same logo differently frame to frame.
  const nearby = (a, b) => Math.abs((a.x + a.w / 2) - (b.x + b.w / 2)) < 0.12 && Math.abs((a.y + a.h / 2) - (b.y + b.h / 2)) < 0.08;
  // …and by recurring letters: a logo is read as many fragments ("TION.COM", "ISITION") that shift as the
  // speaker moves; any 4-letter chunk seen in a fifth of the frames marks its text as scenery.
  const grams = (t) => { const x = t.toUpperCase().replace(/[^A-Z]/g, ""); const g = new Set(); for (let i = 0; i + 4 <= x.length; i++) g.add(x.slice(i, i + 4)); return g; };
  const gramFrames = new Map();
  for (const o of overlays) for (const g of grams(o.text)) gramFrames.set(g, (gramFrames.get(g) ?? new Set()).add(o.t));
  const minFrames = Math.max(3, samples.length * 0.2);
  const recurring = (o) => [...grams(o.text)].some((g) => gramFrames.get(g).size >= minFrames);
  const isStatic = (o) => recurring(o) || new Set(overlays.filter((p) => nearby(o, p)).map((p) => p.t)).size >= minFrames;
  const moving = overlays.filter((o) => !isStatic(o));
  // Captions the reader misread ("pof any kind") still sit in the caption band: count them as captions.
  const bandY = median(caps.map((c) => c.y + c.h / 2));
  const bandH = median(caps.map((c) => c.h)) ?? 0.03;
  const inBand = (o) => bandY !== null && Math.abs((o.y + o.h / 2) - bandY) < Math.max(0.04, bandH * 1.5);
  overlays.splice(0, overlays.length, ...moving.filter((o) => !inBand(o)));
  const capFrames = new Set(caps.map((c) => c.t));
  const ovFrames = new Set(overlays.filter((o) => o.words >= 1 && o.h > 0.02).map((o) => o.t));
  const dur = samples.length ? Math.max(...samples.map((s) => s.t)) - Math.min(...samples.map((s) => s.t)) + 1e-9 : 1;
  // Count distinct overlay appearances (a run of consecutive sampled frames counts once).
  const ovTimes = [...ovFrames].sort((a, b) => a - b);
  let ovEvents = 0;
  ovTimes.forEach((t, i) => { if (i === 0 || t - ovTimes[i - 1] > 1.5) ovEvents++; });
  return {
    present: samples.length ? capFrames.size / samples.length >= 0.3 : false,
    frameShare: r2(samples.length ? capFrames.size / samples.length : 0),
    wordsPerLine: median(caps.map((c) => c.words)),
    centreYFrac: r2(median(caps.map((c) => c.y + c.h / 2))),
    heightFrac: r2(median(caps.map((c) => c.h))),
    uppercaseShare: r2(caps.length ? caps.filter((c) => c.upper).length / caps.length : 0),
    // Font size as a fraction of frame height (cap height ≈ 0.74 of the font size); frame-size independent.
    fontFrac: r2(((median(caps.map((c) => c.h)) ?? 0.03) / 0.74) * 1000) / 1000,
    overlayTextPerMin: r2((ovEvents / dur) * 60),
    sampleCaption: caps.slice(0, 3).map((c) => c.text),
  };
}

/** Face height across scene cuts → punch-in cuts per minute (face jumps ≥ 6 % between shots of one speaker). */
export function zoomStats(faceSamples, cutTimes, durationSec) {
  // The last face strictly before the cut vs the first strictly after it (never the same side).
  const before = (c) => faceSamples.filter((x) => x.face && x.t < c - 0.02 && x.t >= c - 1.2).sort((a, b) => b.t - a.t)[0]?.face ?? null;
  const after = (c) => faceSamples.filter((x) => x.face && x.t > c + 0.02 && x.t <= c + 1.2).sort((a, b) => a.t - b.t)[0]?.face ?? null;
  let zoomCuts = 0;
  for (const c of cutTimes) {
    const a = before(c), b = after(c);
    if (!a || !b) continue;
    const ratio = b.h / a.h, dx = Math.abs((b.x + b.w / 2) - (a.x + a.w / 2));
    if (dx < 0.15 && (ratio > 1.06 || ratio < 1 / 1.06)) zoomCuts++;
  }
  const withFace = faceSamples.filter((s) => s.face).length;
  return { zoomCutsPerMin: r2((zoomCuts / durationSec) * 60), faceShare: r2(faceSamples.length ? withFace / faceSamples.length : 0) };
}

/** Is there a music bed? Measured in the gaps between sentences: real silence is ~floor; music isn't. */
export function musicGuess(env, words, { offset = 0 } = {}) {
  if (!env?.length) return { likely: false, bedDb: null };
  const { floor } = speechThreshold(env);
  const gapLevels = [];
  for (let i = 1; i < words.length; i++) {
    const a = words[i - 1].end + 0.08 - offset, b = words[i].start - 0.08 - offset;
    if (b - a < 0.15) continue;
    for (let k = Math.ceil(a * 100); k < Math.floor(b * 100); k++) if (env[k] !== undefined) gapLevels.push(env[k]);
  }
  const bed = median(gapLevels);
  // Absolute, not relative to the floor: with music under the whole video the "floor" IS the music.
  // A clean voice recording's gaps sit well under −50 dB; a bed keeps them up.
  return { likely: bed !== null && bed > -48, bedDb: r2(bed), floorDb: r2(floor) };
}

// ── orchestration ────────────────────────────────────────────────────────────

function ocrBinary() {
  const env = probeEnv();
  if (!env.swiftc) return null;
  const src = fs.readFileSync(OCR_SRC);
  const bin = path.join(os.homedir(), ".cache", "video-kit", "bin", `ocr-${createHash("sha256").update(src).digest("hex").slice(0, 10)}`);
  if (fs.existsSync(bin)) return bin;
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const r = spawnSync(env.swiftc, ["-O", OCR_SRC, "-o", `${bin}.tmp`], { encoding: "utf8" });
  if (r.status !== 0) return null;
  fs.renameSync(`${bin}.tmp`, bin);
  return bin;
}

function ocrFrames(frames) {
  const bin = ocrBinary();
  if (!bin) return null;
  const byFile = new Map(frames.map((f) => [f.file, f.t])), out = [];
  for (let i = 0; i < frames.length; i += 100) {
    const r = spawnSync(bin, frames.slice(i, i + 100).map((f) => f.file), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`text reading failed: ${String(r.stderr).slice(-200)}`);
    for (const line of r.stdout.split("\n").filter(Boolean)) {
      const j = JSON.parse(line);
      if (!j.error) out.push({ t: byFile.get(j.file), file: j.file, lines: j.lines });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Text colour inside a caption box: the brightest cluster = fill, the most saturated = highlight. */
function captionColours(file, box, { W = 640 } = {}) {
  const { ffmpeg } = probeEnv();
  const r = spawnSync(ffmpeg, ["-v", "error", "-i", file, "-vf", `scale=${W}:-2`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) return null;
  const H = Math.round(r.stdout.length / 3 / W);
  const x0 = Math.max(0, Math.floor(box.x * W)), x1 = Math.min(W, Math.ceil((box.x + box.w) * W));
  const y0 = Math.max(0, Math.floor(box.y * H)), y1 = Math.min(H, Math.ceil((box.y + box.h) * H));
  let best = null, satN = 0, total = 0;
  const satSum = [0, 0, 0];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = 3 * (y * W + x), p = [r.stdout[i], r.stdout[i + 1], r.stdout[i + 2]];
    const mx = Math.max(...p), mn = Math.min(...p), L = (mx + mn) / 2, S = mx ? (mx - mn) / mx : 0;
    total++;
    // A highlight is a real cluster of bright, strongly coloured pixels — not skin or a stray edge.
    if (S > 0.6 && mx > 170) { satN++; for (let k = 0; k < 3; k++) satSum[k] += p[k]; }
    if (!best || L > best.L) best = { p, L };
  }
  const sat = satN >= Math.max(12, total * 0.03) ? { p: satSum.map((v) => Math.round(v / satN)) } : null;
  const hex = (p) => `#${p.map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
  return { fill: best ? hex(best.p) : null, highlight: sat ? hex(sat.p) : null };
}

function download(url, dir, log) {
  const ytdlp = [process.env.KIT_YTDLP, "/opt/homebrew/bin/yt-dlp", path.join(os.homedir(), ".local/bin/yt-dlp")].filter(Boolean).find((p) => fs.existsSync(p))
    || (() => { try { return execFileSync("/bin/sh", ["-c", "command -v yt-dlp"], { encoding: "utf8" }).trim(); } catch { return ""; } })();
  if (!ytdlp) throw new Error("yt-dlp is not installed — run ./setup.sh (it installs it), or save the video as a file and give the file instead");
  log(`downloading the reference once for analysis (it is deleted afterwards)`);
  const r = spawnSync(ytdlp, ["--no-playlist", "--no-warnings", "-f", "bv*[height<=720]+ba/b[height<=720]/b", "--merge-output-format", "mp4",
    "--print-json", "-o", path.join(dir, "ref.%(ext)s"), url], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60 * 1000 });
  if (r.status !== 0) throw new Error(`could not download the reference: ${String(r.stderr).trim().split("\n").slice(-2).join(" ")}`);
  const info = JSON.parse(r.stdout.trim().split("\n").pop());
  const file = fs.readdirSync(dir).filter((f) => f.startsWith("ref.")).map((f) => path.join(dir, f))[0];
  return { file, meta: { title: info.title, channel: info.channel ?? info.uploader, url: info.webpage_url ?? url, durationSec: info.duration } };
}

export const STRUCTURE_SYSTEM = `You analyse the STRUCTURE and DELIVERY of a talking video so a different creator can make their own video the same way.
Describe how it is built, never what it says word for word. Do not quote more than 8 words from it.
Reply with ONE JSON object and nothing else:
{"hook":{"type":string,"seconds":number,"how":string},"sections":[{"role":string,"approx_seconds":number,"how":string}],
 "cta":{"placement":string,"how":string},"tone":string,"pacing":string,"techniques":[string],"recipe":string}`;

export async function analyseReference({ input, root, name = null, planner = "auto", keepFile = false, breakdown = false, reviewShots = false, log = () => {}, runner = runClaude }) {
  const P = pathsFor(root);
  const isUrl = /^https?:\/\//i.test(input);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "video-kit-ref-"));
  try {
    let file = input, meta = { title: path.basename(input).replace(/\.[^.]+$/, ""), channel: null, url: null };
    if (isUrl) ({ file, meta } = download(input, work, log));
    else if (!fs.existsSync(file)) throw new Error(`not found: ${file}`);
    const info = probeSource(file);
    const dur = info.durationSec;
    const vertical = info.height > info.width;
    log(`reference: "${meta.title}" — ${(dur / 60).toFixed(1)} min, ${info.width}×${info.height}`);

    // Cuts.
    const { ffmpeg } = probeEnv();
    const sc = spawnSync(ffmpeg, ["-hide_banner", "-nostats", "-i", file, "-vf", "select='gt(scene,0.15)',showinfo", "-an", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    const cuts = [...String(sc.stderr).matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
    const shots = shotStats(cuts, dur);

    // Words.
    const wav = extractWav(file, path.join(work, "speech16k.wav"), { audioIndex: info.audio.audioIndex });
    const env = envelopeDb(readWav(wav));
    const audible = detectAudible(wav, dur, {});
    let words = transcribe({ wav, offset: 0, localDur: dur, lexicon: loadLexicon(P.lexicon), tempDir: work, audibleSpans: audible.spans, log }).words;
    words = snapWordsToAudio(words, env).words;
    const speech = pauseStats(words);
    const music = musicGuess(env, words);

    // Frames: faces and on-screen text (≤ 400 samples).
    const fps = Math.min(2, 400 / dur);
    const fdir = path.join(work, "frames");
    fs.mkdirSync(fdir);
    spawnSync(ffmpeg, ["-v", "error", "-i", file, "-vf", `fps=${fps},scale=960:-2`, "-q:v", "3", path.join(fdir, "f%05d.jpg")]);
    const frames = fs.readdirSync(fdir).sort().map((f) => ({ t: Number(((Number(f.slice(1, 6)) - 1) / fps).toFixed(3)), file: path.join(fdir, f) }));
    const faceDet = detectFaces(frames) ?? [];
    const faceSamples = faceDet.map((d) => ({ t: d.t, face: (d.faces ?? []).filter((f) => f.c >= 0.5).sort((a, b) => b.w * b.h - a.w * a.h)[0] ?? null }));
    const zoom = zoomStats(faceSamples, cuts, dur);
    const ocr = ocrFrames(frames) ?? [];
    const caps = captionStats(ocr, words, { frameH: info.height });
    // Caption colours from a few caption frames.
    const colourSamples = [];
    for (const s of ocr) {
      if (colourSamples.length >= 6) break;
      const spoken = new Set(words.filter((w) => Math.abs(w.start - s.t) < 1.5).map((w) => norm(w.text)));
      const l = (s.lines ?? []).find((x) => x.text.split(/\s+/).map(norm).filter((w) => spoken.has(w)).length >= 1);
      if (l) { const c = captionColours(s.file, l); if (c) colourSamples.push(c); }
    }
    const mode = (xs) => { const m = new Map(); xs.filter(Boolean).forEach((x) => m.set(x, (m.get(x) ?? 0) + 1)); return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null; };
    const captionColoursOut = { fill: mode(colourSamples.map((c) => c.fill)), highlight: mode(colourSamples.map((c) => c.highlight)) };

    // Loudness.
    const lr = spawnSync(ffmpeg, ["-hide_banner", "-nostats", "-i", file, "-map", `0:a:${info.audio.audioIndex}`, "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const lufs = Number([...String(lr.stderr).matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop()?.[1] ?? NaN);

    // Structure (Claude, optional).
    let structure = null, notes = [];
    if (planner !== "heuristic") {
      try {
        const sents = sentences(words).map((s) => `[${s.start.toFixed(0)}s] ${s.text}`).join("\n");
        const out = runner({ system: STRUCTURE_SYSTEM, prompt: `VIDEO: ${dur.toFixed(0)} s, ${vertical ? "vertical" : "landscape"}.\nTRANSCRIPT (by sentence):\n${sents}`, timeoutMs: 180000 });
        structure = parseJson(out.text);
        structure.model = MODEL;
      } catch (e) { notes.push(`structure not analysed: ${e.message.split("\n")[0]}`); }
    }

    const style = {
      reference: { ...meta, durationSec: r2(dur), width: info.width, height: info.height, fps: info.fps, format: vertical ? "vertical" : "landscape" },
      analysed_at: new Date().toISOString(),
      editing: { ...shots, ...zoom, brollShare: r2(1 - zoom.faceShare) },
      speech, music, loudnessLufs: r2(lufs),
      captions: { present: caps.present, frameShare: caps.frameShare, wordsPerLine: caps.wordsPerLine, centreYFrac: caps.centreYFrac, heightFrac: caps.heightFrac,
        fontFrac: caps.fontFrac, uppercaseShare: caps.uppercaseShare, colours: captionColoursOut },
      onScreenText: { perMin: caps.overlayTextPerMin },
      structure, notes,
      kept: "measurements only — the reference's footage, frames, audio and words are not stored",
    };
    const slug = slugify(name ?? meta.title);
    const dir = path.join(P.dataDir, "references", slug);
    fs.mkdirSync(dir, { recursive: true });
    // --keep-file: a private copy for side-by-side checks while building a faceless video (never published).
    if (keepFile) { fs.copyFileSync(file, path.join(dir, "reference.mp4")); style.kept = "measurements + a private copy (reference.mp4) for comparison — never publish or reuse its footage"; }
    // Optional: the full shot-by-shot breakdown (rea-video) from the same download, then Claude's visual check.
    if (breakdown) {
      const { decompose, review } = await import("./breakdown.js");
      try {
        const b = decompose({ file, outDir: path.join(dir, "breakdown"), log });
        style.breakdown = { report: path.relative(dir, b.report), verdict: b.summary?.verdict ?? null, confidence: b.summary?.confidence ?? null, reviewed: false };
        if (reviewShots) {
          const rv = review({ outDir: path.join(dir, "breakdown"), log });
          style.breakdown.reviewed = rv.ok;
        }
      } catch (e) {
        style.notes.push(`breakdown not made: ${e.message.split("\n")[0]}`);
        log(style.notes[style.notes.length - 1]);
      }
    }
    writeJsonAtomic(path.join(dir, "style.json"), style);
    return { slug, dir, style, words: words.length };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
