#!/usr/bin/env node
/**
 * engine/cli.js — the `kit` command. Members normally never type this: Claude runs it for them from
 * the skills in .claude/skills/. Every command leaves the input file untouched.
 *
 *   npm run kit -- check                                  is everything installed?
 *   npm run kit -- long  <video>                          edit a long-form 16:9 video (L### job)
 *   npm run kit -- short <video> [--range 12.5-98]        edit a vertical short (S### job)
 *   npm run kit -- clips <video> [--count 3]              find the best 60–120 s clips in a long recording and cut each as a short
 *   npm run kit -- thumbnail <ID|video> --text "2-4 WORDS"  1280×720 thumbnail (an ID uses that job's original recording)
 *   npm run kit -- reference <link|file> [--name NAME]    measure how a video you like is edited → style brief + profiles
 *   npm run kit -- qa <video> [--script file]             QA a finished video the kit did not edit (faceless renders)
 *   npm run kit -- status [ID]                            list jobs, or one job
 *   npm run kit -- where <ID> <time>                      map a time in the edit back to the original (+ cuts nearby)
 *
 * Options for long/short/clips:
 *   --style NAME   edit in a learned reference style      --profile ID   a profile in config/ or member/profiles     --planner auto|heuristic|llm (auto = Claude, heuristic if unavailable)
 *   --from analyse|roughcut|plan  reuse earlier stages    --keep-temp   keep the working folder    --json   machine output
 *   --keep a-b[,c-d]  never cut inside these spans   --cut a-b[,c-d]  remove these spans   (seconds in the ORIGINAL recording)
 * Exit codes: 0 done, 3 done but needs a human look, 1 failed, 2 usage.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeEnv, probeEnv } from "./env.js";
import { pathsFor, readJson, writeJsonAtomic, REPO_ROOT, sha256File } from "./storage/files.js";
import { runShort, formatReport } from "./run.js";

const USAGE = `usage:
  npm run kit -- check
  npm run kit -- long  <video>
  npm run kit -- short <video> [--range start-end]
  npm run kit -- clips <video> [--count 3] [--min 60] [--max 120]
  npm run kit -- thumbnail <ID|video> --text "2-4 WORDS" [--out folder]
  npm run kit -- reference <link|file> [--name NAME]   learn the editing style of a video you like
  npm run kit -- breakdown <link|file> [--name NAME] [--review]   style + full shot-by-shot breakdown report (rea-video)
  npm run kit -- voice <script.txt> --out voice.wav [--voice am_michael] [--speed 1.0]   local AI voice-over
  npm run kit -- finish <render.mp4> --out final.mp4   set platform loudness, picture untouched
  npm run kit -- qa <video> [--script script.txt]      check any finished video (e.g. a faceless render)
  npm run kit -- status [ID]
  npm run kit -- where <ID> <time>      what the original had around a time in the edit
options: --style NAME  edit in a learned reference style   --keep a-b[,c-d]  never cut these spans   --cut a-b[,c-d]  remove these spans   (seconds of the ORIGINAL recording)`;

export function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { o._.push(a); continue; }
    const key = a.slice(2);
    if (["keep-temp", "json", "keep-file", "review"].includes(key)) o[key] = true;
    else o[key] = argv[++i];
  }
  return o;
}

const rel = (p) => path.relative(process.cwd(), p) || p;
const log = (m) => process.stderr.write(`  · ${m}\n`);

/** One-paragraph creator context for Claude, from what /setup wrote. */
function memberAbout(root) {
  try { return fs.readFileSync(path.join(pathsFor(root).memberDir, "voice-and-offer.md"), "utf8").replace(/\s+/g, " ").slice(0, 900); } catch { return ""; }
}

/** "120-125.5,300-302" (source seconds) → [{start,end}] */
export function parseSpans(v) {
  if (!v) return [];
  return String(v).split(",").map((x) => {
    const m = x.trim().match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
    if (!m || Number(m[2]) <= Number(m[1])) throw new Error(`"${x}" is not start-end in seconds of the original recording`);
    return { start: Number(m[1]), end: Number(m[2]) };
  });
}

/** "2:03" / "123.4" → seconds */
export function parseTime(v) {
  const p = String(v).trim().split(":").map(Number);
  if (p.some((n) => !Number.isFinite(n))) throw new Error(`"${v}" is not a time like 2:03`);
  return p.reduce((a, n) => a * 60 + n, 0);
}

/** What the original recording had around an output time: the source time and nearby removals. */
function where(root, id, t) {
  const job = pathsFor(root).jobDir(id);
  const meta = readJson(path.join(job, "metadata.json"), null);
  if (!meta) throw new Error(`${id} not found`);
  const v = meta.current_version;
  const plan = readJson(path.join(job, `edit-plan.v${v}.json`));
  const segs = plan.rough_cut.segments, out = parseTime(t);
  const seg = segs.find((s) => out >= s.out_start && out < s.out_end) ?? segs[segs.length - 1];
  const src = seg.src_start + (out - seg.out_start);
  const near = plan.rough_cut.removals.filter((r) => r.end >= src - 3 && r.start <= src + 3)
    .map((r) => ({ start: r.start, end: r.end, kind: r.kind, applied: r.applied, reason: r.reason }));
  return { id, version: v, output_time: out, source_time: Number(src.toFixed(3)), removals_nearby: near };
}

/** --style NAME → that reference's generated profile for this kind of edit. */
function styleProfile(args, type) {
  if (!args.style) return args.profile ?? null;
  const base = String(args.style).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^REF_/, "");
  return `REF_${base}_${type === "long" ? "LONG" : "SHORT"}`;
}

async function reference(root, input, args, cmd = "reference") {
  const { analyseReference } = await import("./reference/analyse.js");
  const { styleToProfile, styleBrief } = await import("./reference/profile.js");
  const full = cmd === "breakdown";
  const { slug, dir, style } = await analyseReference({ input, root, name: args.name ?? null, planner: args.planner ?? "auto", keepFile: Boolean(args["keep-file"]),
    breakdown: full, reviewShots: full && Boolean(args.review), log });
  const P = pathsFor(root);
  const profDir = path.join(P.memberDir, "profiles");
  fs.mkdirSync(profDir, { recursive: true });
  const vertical = style.reference.format === "vertical";
  const ids = {};
  for (const [kind, baseId] of [["LONG", "LONG_TALKING_HEAD"], ["SHORT", "SHORT_TALKING_HEAD"]]) {
    const base = readJson(path.join(P.profilesDir, `${baseId}.json`));
    const id = `REF_${slug}_${kind}`;
    const prof = styleToProfile(style, base, id, { sameAspect: (kind === "SHORT") === vertical });
    writeJsonAtomic(path.join(profDir, `${id}.json`), prof);
    ids[kind] = id;
  }
  const brief = path.join(dir, "STYLE.md");
  fs.writeFileSync(brief, styleBrief(style, slug));
  if (style.breakdown) console.log(`\nShot-by-shot breakdown: ${rel(path.join(dir, style.breakdown.report))}${style.breakdown.reviewed ? " (checked by eye by Claude)" : " (pixel analysis only — add --review to have Claude check each shot)"}`);
  console.log(`\nReference analysed — ${style.reference.title}\n  style brief: ${rel(brief)}\n  measurements: ${rel(path.join(dir, "style.json"))}\n  use it: npm run kit -- long|short|clips <your video> --style ${slug}\n  profiles: ${ids.LONG}, ${ids.SHORT}${style.notes.length ? `\n  note: ${style.notes.join("; ")}` : ""}`);
  return { status: "COMPLETE", slug };
}

async function edit(root, input, type, args) {
  const r = await runShort({
    keep: parseSpans(args.keep), cut: parseSpans(args.cut),
    input, root, type, profileId: styleProfile(args, type), range: args.range ?? null, forceId: args.id ?? null,
    from: args.from ?? "analyse", planner: args.planner ?? "auto", keepTemp: Boolean(args["keep-temp"]), log,
  });
  console.log(args.json ? JSON.stringify(r, null, 2) : `\n${formatReport({ ...r, render: rel(r.render), captions: rel(r.captions), jobDir: rel(r.jobDir) })}`);
  return r;
}

async function clips(root, input, args) {
  const { probeSource } = await import("./ingest/source.js");
  const { extractWav, loadLexicon, transcribe } = await import("./transcription/whisper.js");
  const { detectAudible } = await import("./analysis/audio.js");
  const { findClips } = await import("./clips/find.js");
  const count = Number(args.count ?? 3), minSec = Number(args.min ?? 60), maxSec = Number(args.max ?? 120);
  const src = path.resolve(input);
  if (!fs.existsSync(src)) throw new Error(`not found: ${src}`);
  probeEnv();
  const info = probeSource(src);
  const sha = await sha256File(src);
  const P = pathsFor(root);
  const cacheFile = path.join(P.dataDir, "clips", `${path.basename(src).replace(/\.[^.]+$/, "")}-${sha.slice(0, 8)}.json`);
  let words = readJson(cacheFile, null)?.words ?? null;
  if (!words) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "video-kit-clips-"));
    try {
      log(`transcribing ${path.basename(src)} (${(info.durationSec / 60).toFixed(1)} min) to find clips`);
      const wav = extractWav(src, path.join(tmp, "speech16k.wav"), { audioIndex: info.audio.audioIndex });
      const audio = detectAudible(wav, info.durationSec, {});
      words = transcribe({ wav, offset: 0, localDur: info.durationSec, lexicon: loadLexicon(P.lexicon), tempDir: tmp, audibleSpans: audio.spans, log }).words;
      const { readWav, envelopeDb, snapWordsToAudio } = await import("./rough-cut/speech-edges.js");
      words = snapWordsToAudio(words, envelopeDb(readWav(wav))).words;
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  const found = findClips(words, { count, minSec, maxSec, about: memberAbout(root), planner: args.planner ?? "auto", log });
  writeJsonAtomic(cacheFile, { source: src, sha256: sha, words, clips: found.clips, notes: found.notes, at: new Date().toISOString() });
  for (const n of found.notes) log(n);
  if (!found.clips.length) { console.log(`No clips found. ${found.notes.join(" ")}`); return { status: "NEEDS_REVIEW", results: [] }; }
  log(`${found.clips.length} clip(s): ${found.clips.map((c) => `${c.start.toFixed(0)}–${c.end.toFixed(0)}s "${c.title}"`).join(" | ")}`);
  const results = [];
  for (const c of found.clips) {
    const r = await edit(root, src, "reel", { ...args, range: `${c.start.toFixed(3)}-${c.end.toFixed(3)}`, json: args.json });
    results.push({ ...c, id: r.id, status: r.status, render: r.render });
  }
  writeJsonAtomic(cacheFile, { ...readJson(cacheFile), results });
  console.log(`\nClips: ${results.map((r) => `${r.id} ${r.status} "${r.title}"`).join("\n       ")}\nList: ${rel(cacheFile)}`);
  return { status: results.every((r) => r.status === "COMPLETE") ? "COMPLETE" : "NEEDS_REVIEW", results };
}

async function thumbnail(root, input, args) {
  const { makeThumbnail } = await import("./thumbnail/make.js");
  if (!args.text) throw new Error('give the thumbnail text: --text "2-4 WORDS"');
  // A job ID means: frames from that job's ORIGINAL recording (the edit has burned-in captions), output beside the job.
  let src = path.resolve(input), outDir = args.out ? path.resolve(args.out) : null;
  if (/^[SL]\d{3,}$/.test(input)) {
    const job = readJson(pathsFor(root).registry, { shorts: {} }).shorts[input];
    if (!job) throw new Error(`${input} not found — run \`npm run kit -- status\` to list jobs`);
    src = job.source.last_seen_path ?? job.source.original_path;
    if (!fs.existsSync(src)) throw new Error(`${input}'s recording is no longer at ${src}`);
    outDir = outDir ?? path.join(pathsFor(root).jobDir(input), "thumbnail");
  }
  outDir = outDir ?? path.join(path.dirname(src), "thumbnail");
  const r = await makeThumbnail({ video: src, text: args.text, outDir, root, log });
  console.log(args.json ? JSON.stringify(r, null, 2) : `\nThumbnail — ${r.status}\n  ${rel(r.files.thumbnail)}\n  phone view: ${rel(r.files.phone)}\n${r.checks.map((c) => `  ${c.status.toUpperCase().padEnd(7)} ${c.id}: ${c.detail}`).join("\n")}`);
  return r;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, input] = args._;
  const root = process.env.KIT_ROOT ? path.resolve(process.env.KIT_ROOT) : REPO_ROOT;
  try {
    if (cmd === "check") { console.log(describeEnv()); return 0; }
    if (cmd === "status") {
      const reg = readJson(pathsFor(root).registry, { shorts: {} });
      const rows = Object.values(reg.shorts).filter((s) => !input || s.id === input);
      if (!rows.length) { console.log(input ? `${input} not found` : "no jobs yet"); return input ? 1 : 0; }
      for (const s of rows) console.log(`${s.id}  ${s.type.padEnd(5)} ${s.status.padEnd(12)} v${s.current_version}  ${s.source.filename}${s.range ? ` [${s.range}]` : ""}`);
      return 0;
    }
    if (cmd === "where") {
      if (!input || !args._[2]) { console.error("usage: npm run kit -- where <ID> <time in the edit, e.g. 2:03>"); return 2; }
      console.log(JSON.stringify(where(root, input, args._[2]), null, 2));
      return 0;
    }
    if (cmd === "voice") {
      if (!input || !args.out) { console.error("usage: npm run kit -- voice <script.txt> --out voice.wav [--voice am_michael] [--speed 1.0]"); return 2; }
      const { voice } = await import("./faceless/tools.js");
      const r = voice({ script: path.resolve(input), out: args.out, voiceId: args.voice ?? "am_michael", speed: Number(args.speed ?? 1), log });
      console.log(`Voice-over: ${rel(r.out)} (${r.durationSec}s)`);
      return 0;
    }
    if (cmd === "finish") {
      if (!input || !args.out) { console.error("usage: npm run kit -- finish <render.mp4> --out final.mp4"); return 2; }
      const { finish } = await import("./faceless/tools.js");
      const r = finish({ input: path.resolve(input), out: path.resolve(args.out) });
      console.log(`Finished: ${rel(r.out)} (loudness ${r.before} → ${r.target} LUFS, picture untouched)`);
      return 0;
    }
    if (cmd === "qa") {
      if (!input) { console.error("usage: npm run kit -- qa <video> [--script script.txt] [--format 9:16|16:9]"); return 2; }
      const { checkVideo } = await import("./qa/check-video.js");
      const r = checkVideo({ video: path.resolve(input), format: args.format ?? null, script: args.script ? path.resolve(args.script) : null, root, log });
      console.log(args.json ? JSON.stringify(r, null, 2) : `\nQA — ${r.status} (${r.durationSec}s)\n${r.checks.map((c) => `  ${c.status.toUpperCase().padEnd(5)} ${c.id}: ${c.detail}`).join("\n")}`);
      return r.status === "COMPLETE" ? 0 : 3;
    }
    if (!["long", "short", "clips", "thumbnail", "reference", "breakdown"].includes(cmd) || !input) { console.error(USAGE); return 2; }
    const r = cmd === "reference" || cmd === "breakdown" ? await reference(root, input, args, cmd)
      : cmd === "long" ? await edit(root, input, "long", args)
      : cmd === "short" ? await edit(root, input, args.type ?? "reel", args)
        : cmd === "clips" ? await clips(root, input, args)
          : await thumbnail(root, input, args);
    return r.status === "COMPLETE" ? 0 : 3;
  } catch (e) {
    console.error(`\nFAILED${e.stage ? ` at ${e.stage}` : ""}: ${e.cause?.message ?? e.message}`);
    return 1;
  }
}

// Run only when started as a program (not when imported by tests). Compare real paths, not URLs: the
// install folder is "~/Video Kit", and a URL spells that space as %20, which never matched argv.
const startedAsProgram = (() => {
  try { return fs.realpathSync(process.argv[1] ?? "") === fs.realpathSync(new URL(import.meta.url)); } catch { return false; }
})();
if (startedAsProgram || process.argv[1]?.endsWith("/kit")) main().then((code) => process.exit(code));
