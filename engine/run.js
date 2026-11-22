/**
 * engine/run.js — one edit job (long-form L### or short-form S###), end to end.
 *
 *   preflight → identify (S###) → analyse (audio, transcript, faces) → rough cut → plan (vN)
 *   → validate → render → QC → [one repair → render → QC] → report
 *
 * Durable, small artefacts go to output/<ID>/ ; everything bulky lives in a temp dir that is
 * removed on success, failure and signals. The source is never written, moved or copied.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { probeEnv } from "./env.js";
import { pathsFor, readJson, writeJsonAtomic, fingerprint, freeBytes, hashObject } from "./storage/files.js";
import { acquireLock } from "./storage/lock.js";
import { createRunTemp, sweepStale } from "./storage/temp.js";
import { registerShort, allocateVersion, updateShort, normaliseRange } from "./ingest/identity.js";
import { probeSource, sourceWarnings, chooseOutputFps, assertOutputOutsideSource } from "./ingest/source.js";
import { loadProfile } from "./profiles/load.js";
import { extractWav, loadLexicon, transcribe } from "./transcription/whisper.js";
import { detectAudible, channelBalance } from "./analysis/audio.js";
import { sampleFrames, detectFaces, faceTrack, summariseTrack, planReframes } from "./analysis/visual.js";
import { planRoughCut, rebaseWords, joinPoints } from "./rough-cut/cuts.js";
import { readWav, envelopeDb, refineEdges, auditEdges, snapWordsToAudio } from "./rough-cut/speech-edges.js";
import { findCandidates } from "./planner/candidates.js";
import { selectHeuristic } from "./planner/heuristic.js";
import { assemblePlan } from "./planner/plan.js";
import { validatePlan } from "./planner/validate.js";
import { renderPlan } from "./renderer/render.js";
import { technicalChecks } from "./qc/technical.js";
import { wordSurvival, unreviewedRetakes, duplicatePhrases, captionTiming, punchInReasons, roundTrip, captionsVisible, faceVsText } from "./qc/editorial.js";
import { decideOutcome, repairPlan } from "./qc/repair.js";
import { buildSrt } from "./captions/srt.js";

export const STAGES = ["analyse", "roughcut", "plan"];

class JobError extends Error {
  constructor(stage, cause) { super(`${stage}: ${cause.message}`); this.stage = stage; this.cause = cause; this.code = cause.code; }
}

const fmtTime = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.round(s % 60)).padStart(2, "0")}`;

function parseRange(r) {
  const n = normaliseRange(r);
  if (!n) return null;
  const [a, b] = n.split("-").map(Number);
  return { start: a, end: b };
}

/** Contact sheet of the render — the quickest human check of framing, captions and graphics. */
function contactSheet(video, out, durationSec) {
  const { ffmpeg } = probeEnv();
  const n = 8, times = Array.from({ length: n }, (_, i) => (durationSec * (i + 0.5)) / n);
  const inputs = times.flatMap((t) => ["-ss", t.toFixed(2), "-i", video]);
  const graph = `${times.map((_, i) => `[${i}:v]scale=270:-2[p${i}]`).join(";")};${times.map((_, i) => `[p${i}]`).join("")}hstack=inputs=${n}[o]`;
  const r = spawnSync(ffmpeg, ["-y", "-v", "error", ...inputs, "-filter_complex", graph, "-map", "[o]", "-frames:v", "1", "-q:v", "4", out], { encoding: "utf8" });
  return r.status === 0 ? out : null;
}

export async function runShort(opts) {
  const {
    input, root, type = "reel", profileId = null, range: rangeArg = null, forceId = null,
    planner = "auto", keepTemp = false, from = "analyse", keep = [], cut = [], tmpBase = process.env.KIT_TMP || os.tmpdir(), log: userLog = () => {},
  } = opts;
  if (!STAGES.includes(from)) throw new Error(`--from must be one of ${STAGES.join("|")}`);
  const P = pathsFor(root);
  const started = Date.now();
  const sourcePath = path.resolve(input);
  if (!fs.existsSync(sourcePath)) throw new Error(`source not found: ${sourcePath}`);

  // ── preflight ──
  probeEnv();
  sweepStale({ base: tmpBase });
  const { profile, ref: profileRef } = loadProfile(profileId ?? (type === "long" ? "LONG_TALKING_HEAD" : "SHORT_TALKING_HEAD"), { root, type });
  const srcSize = fs.statSync(sourcePath).size;
  const needBytes = Math.max(3e9, 4 * srcSize);
  for (const dir of [tmpBase, root]) {
    const free = freeBytes(dir);
    if (free < needBytes) throw new Error(`preflight: ${(free / 1e9).toFixed(1)} GB free at ${dir}, need ${(needBytes / 1e9).toFixed(1)} GB — free space first`);
  }
  assertOutputOutsideSource(P.dataDir, sourcePath);
  const range = parseRange(rangeArg);
  const info = probeSource(sourcePath);
  if (range && range.end > info.durationSec + 0.01) throw new Error(`range ends at ${range.end}s but the source is ${info.durationSec.toFixed(2)}s`);
  const before = await fingerprint(sourcePath);

  // ── identity ──
  const sourceRecord = { filename: path.basename(sourcePath), original_path: sourcePath, size: before.size, sha256: before.sha256, duration: info.durationSec, width: info.width, height: info.height, fps: info.fps };
  const { id, reused } = registerShort({ registryFile: P.registry, source: sourceRecord, type, range, profile: profileRef, forceId });
  const jobDir = P.jobDir(id);
  fs.mkdirSync(path.join(jobDir, "renders"), { recursive: true });
  fs.mkdirSync(path.join(jobDir, "logs"), { recursive: true });
  const releaseJob = acquireLock(path.join(jobDir, ".job.lock"), { input: sourcePath });
  if (!releaseJob) throw new Error(`${id} is already being processed by another run`);

  const temp = createRunTemp(id, { base: tmpBase, keep: keepTemp });
  const logLines = [];
  const log = (m) => { const line = `${new Date().toISOString()} ${m}`; logLines.push(line); userLog(m); };
  const setStatus = (status, extra = {}) => updateShort(P.registry, id, (s) => { s.status = status; Object.assign(s, extra); });
  const meta = readJson(path.join(jobDir, "metadata.json"), null) ?? { id, type, created_at: new Date().toISOString(), versions: [] };
  let stage = "analyse";
  let result;

  try {
    log(`${id} ${reused ? "(existing — new version)" : "(new)"} ← ${sourceRecord.filename}`);
    const warnings = sourceWarnings(info);
    info.outFps = chooseOutputFps(info.fps, profile.output.fpsAllowed, profile.output.fpsFallback);

    // ── analyse ──
    let transcript, analysis;
    const tPath = path.join(jobDir, "transcript.json"), aPath = path.join(jobDir, "analysis.json");
    if (from !== "analyse" && fs.existsSync(tPath) && fs.existsSync(aPath) && readJson(tPath).source_sha256 === before.sha256 && JSON.stringify(readJson(tPath).range) === JSON.stringify(range)) {
      transcript = readJson(tPath); analysis = readJson(aPath);
      log("analyse: reusing transcript + analysis");
    } else {
      setStatus("analysing");
      const offset = range ? range.start : 0;
      const localDur = range ? range.end - range.start : info.durationSec;
      const wav = extractWav(sourcePath, temp.file("speech16k.wav"), { audioIndex: info.audio.audioIndex, range });
      const audio = detectAudible(wav, localDur, { ...profile.silence, offset });
      const balance = channelBalance(sourcePath, { audioIndex: info.audio.audioIndex, channels: info.audio.channels });
      const lexicon = loadLexicon(P.lexicon);
      const tr = transcribe({ wav, offset, localDur, range, lexicon, tempDir: temp.dir, audibleSpans: audio.spans, log });
      const frames = sampleFrames(sourcePath, temp.sub("frames"), { fps: profile.reframe.sampleFps, range });
      const faces = detectFaces(frames);
      if (!faces) warnings.push("Apple Vision unavailable — centre crop, no face checks");
      transcript = { source_sha256: before.sha256, range, words: tr.words, meta: tr.meta };
      analysis = {
        source_sha256: before.sha256, range, source: info,
        audio: { envelope: envelopeDb(readWav(wav)), envelopeOffset: offset, audible: audio.spans, thresholdDb: audio.thresholdDb, meanDb: audio.meanDb, audibleFrac: audio.audibleFrac, warnings: audio.warnings, channelBalance: balance },
        visual: { samples: faces ?? [], summary: summariseTrack(faceTrack(faces ?? [])) },
      };
      writeJsonAtomic(tPath, transcript);
      writeJsonAtomic(aPath, analysis);
      setStatus("analysing", { transcript_path: path.relative(root, tPath) });
      log(`analyse: ${transcript.words.length} words; face in ${(analysis.visual.summary.faceCoverage * 100).toFixed(0)}% of ${analysis.visual.summary.samples} samples`);
    }
    // Word edges that whisper smeared across a silence are moved to the silence's edge (the waveform is the truth).
    const snapped = snapWordsToAudio(transcript.words, analysis.audio.envelope, { offset: analysis.audio.envelopeOffset ?? 0 });
    if (snapped.moved) { transcript = { ...transcript, words: snapped.words }; log(`timing: ${snapped.moved} word edge(s) snapped to measured silence`); }
    if (!transcript.meta.alignmentOk) warnings.push(`word timing not force-aligned (${transcript.meta.alignment}) — cuts and captions are less precise`);
    warnings.push(...(analysis.audio.warnings ?? []));
    info.channelFix = analysis.audio.channelBalance?.fix ?? null;
    if (info.channelFix) warnings.push(`microphone is on the ${info.channelFix} channel only (${analysis.audio.channelBalance.levels.map((l) => l.toFixed(1)).join(" / ")} dB) — duplicated to both channels`);

    // ── rough cut ──
    stage = "roughcut";
    const roughCut = planRoughCut({ words: transcript.words, durationSec: info.durationSec, fps: info.outFps, audibleSpans: analysis.audio.audible, range, pacing: profile.pacing, retakes: profile.retakes, protect: keep, force: cut });
    if (keep.length || cut.length) log(`member overrides: keep ${keep.map((k) => `${k.start}-${k.end}`).join(", ") || "none"}; cut ${cut.map((k) => `${k.start}-${k.end}`).join(", ") || "none"}`);
    // Move every join into a measured pause so no word is clipped (see rough-cut/speech-edges.js).
    const refined = refineEdges({ segments: roughCut.segments, env: analysis.audio.envelope, fps: info.outFps, offset: analysis.audio.envelopeOffset ?? 0 });
    roughCut.segments = refined.segments;
    // A join that moved into its pause must not leave a removal record overlapping the kept audio.
    for (const r of roughCut.removals.filter((x) => x.applied)) {
      for (const sg of roughCut.segments) {
        if (r.start < sg.src_end && r.end > sg.src_end && r.start >= sg.src_start) r.start = sg.src_end;
        if (r.end > sg.src_start && r.start < sg.src_start && r.end <= sg.src_end) r.end = sg.src_start;
      }
      if (r.end - r.start < 1e-6) { r.applied = false; r.why = [...(r.why ?? []), "absorbed: the cut moved into the measured pause"]; }
    }
    roughCut.speech_edges = { threshold: refined.threshold ?? null, edges: refined.edges };
    roughCut.stats.outputFrames = roughCut.segments.reduce((a, s) => a + Math.round((s.src_end - s.src_start) * info.outFps), 0);
    roughCut.stats.outputSec = Number((roughCut.stats.outputFrames / info.outFps).toFixed(3));
    const unsafe = refined.edges.filter((e) => e.out === "unsafe" || e.in === "unsafe");
    if (unsafe.length) warnings.push(`${unsafe.length} cut(s) had no clean pause to sit in (joins ${unsafe.map((e) => e.join).join(", ")}) — listen to them`);
    writeJsonAtomic(path.join(jobDir, "rough-cut.json"), { source_sha256: before.sha256, ...roughCut });
    log(`rough cut: ${fmtTime(roughCut.stats.sourceSec)} → ${fmtTime(roughCut.stats.outputSec)}, ${roughCut.stats.appliedRemovals} removals applied, ${roughCut.stats.proposedRemovals} proposed`);

    // ── plan ──
    stage = "plan";
    const track = faceTrack(analysis.visual.samples);
    const { reframes, warnings: rfWarn } = planReframes({ segments: roughCut.segments, track, srcW: info.width, srcH: info.height, format: { width: profile.output.width, height: profile.output.height }, reframe: profile.reframe });
    warnings.push(...rfWarn);
    const words = rebaseWords(transcript.words, roughCut.segments);
    const candidates = findCandidates(words, { joins: joinPoints(roughCut.segments), hookWindowSec: profile.hook.windowSec });
    const assets = readJson(P.assetsManifest, { assets: [] }).assets;

    let selection = null;
    const notes = [];
    if (planner === "llm" || planner === "auto") {
      try {
        const { selectWithLlm } = await import("./planner/llm.js");
        selection = await selectWithLlm({ words, candidates, profile, analysis, jobDir, log });
      } catch (e) {
        notes.push(`LLM planner unavailable, heuristic used: ${e.message.split("\n")[0]}`);
        if (planner === "llm") warnings.push(notes[notes.length - 1]);
      }
    }
    if (!selection) selection = selectHeuristic({ candidates, profile });

    const version = allocateVersion(P.registry, id);
    const ctxBase = { id, type, profile, profileRef, source: { ...info, sha256: before.sha256, filename: sourceRecord.filename }, roughCut, reframes, words, candidates,
      tools: { ffmpeg: probeEnv().ffmpegVersion, whisper_model: transcript.meta.model, alignment: transcript.meta.alignment },
      inputs: { transcript: hashObject(transcript.words).slice(0, 16), analysis: hashObject(analysis.visual.samples).slice(0, 16), rough_cut: hashObject(roughCut.segments).slice(0, 16) } };
    let plan = assemblePlan(selection, { ...ctxBase, version, notes });
    let check = validatePlan(plan, { profile, assets });
    if (!check.ok && selection.planner !== "heuristic") {
      // A model's selection that cannot be made valid is discarded, never "fixed up".
      warnings.push(`LLM selection produced an invalid plan (${check.errors[0]}) — heuristic used`);
      selection = selectHeuristic({ candidates, profile });
      plan = assemblePlan(selection, { ...ctxBase, version, notes });
      check = validatePlan(plan, { profile, assets });
    }
    const planPath = path.join(jobDir, `edit-plan.v${version}.json`);
    writeJsonAtomic(planPath, plan);
    if (!check.ok) { const e = new Error(`plan invalid: ${check.errors.slice(0, 5).join("; ")}`); e.code = "PLAN_INVALID"; throw e; }
    setStatus("planned", { current_version: version, profile: profileRef });
    log(`plan v${version} (${selection.planner}): ${plan.punch_ins.length} punch-in(s), ${plan.graphics.length} graphic(s), ${plan.captions.cues.length} caption cues`);

    // ── render → QC → (one repair) ──
    const attempt = async (pl) => {
      stage = "render";
      setStatus("rendering");
      const v = pl.version;
      const outPath = path.join(jobDir, "renders", `v${v}.mp4`);
      const { renderGraphics, graphicsBoxCheck } = await import("./graphics/render.js");
      const graphicsInputs = pl.graphics.length ? await renderGraphics({ plan: pl, tempDir: temp.sub(`graphics-v${v}`), root, log }) : [];
      const r = renderPlan({ plan: pl, profile, assets, sourcePath, outPath, temp, graphicsInputs, log });
      log(`render v${v}: ${r.seconds}s → ${path.relative(root, outPath)}`);
      fs.writeFileSync(outPath.replace(/\.mp4$/, ".srt"), buildSrt(pl.captions.cues));
      // Captions not burned in: QC must not look for them in the picture.
      const burned = profile.captions.burn !== false;
      const picturePlan = burned ? pl : { ...pl, captions: { ...pl.captions, cues: [] } };
      stage = "qc";
      setStatus("qc");
      const after = await fingerprint(sourcePath);
      const expectedFrames = pl.rough_cut.segments.reduce((a, s) => a + Math.round((s.src_end - s.src_start) * pl.format.fps), 0);
      const dur = expectedFrames / pl.format.fps;
      const qcTemp = temp.sub(`qc-v${v}`);
      const checks = [
        ...technicalChecks({ file: outPath, plan: pl, profile, expectedFrames, sourceBefore: before, sourceAfter: after }),
        wordSurvival({ sourceWords: transcript.words.filter((w) => !range || (w.start >= range.start && w.end <= range.end)), plan: pl }),
        unreviewedRetakes(pl), duplicatePhrases(pl), captionTiming(pl, profile), punchInReasons(pl, candidates),
        roundTrip({ video: outPath, cues: pl.captions.cues, durationSec: dur, tempDir: qcTemp, minSimilarity: profile.qc.minRoundTrip }),
        captionsVisible({ video: outPath, plan: picturePlan }),
        faceVsText({ video: outPath, plan: picturePlan, tempDir: qcTemp, expectFace: (analysis.visual.summary.faceCoverage ?? 0) >= 0.5 }),
        graphicsBoxCheck({ plan: pl, profile, rendered: graphicsInputs }),
        speechEdgesCheck(pl),
      ];
      // TEST HOOK (integration tests only): KIT_TEST_INJECT_QC='{"check":{…},"mode":"once"|"always"}'
      // appends a synthetic failing check so the one-repair-pass limit can be proven end to end.
      if (process.env.KIT_TEST_INJECT_QC) {
        const inj = JSON.parse(process.env.KIT_TEST_INJECT_QC);
        if (inj.mode === "always" || !pl.provenance.repair_of) checks.push({ ...inj.check, injected: true });
      }
      if (pl.provenance.notes.some((n) => n.startsWith("LLM planner unavailable"))) checks.push({ id: "planner", status: "warn", detail: pl.provenance.notes.find((n) => n.startsWith("LLM planner unavailable")) });
      const outcome = decideOutcome(checks, { alreadyRepaired: Boolean(pl.provenance.repair_of) });
      const qc = { id, version: v, plan_file: path.basename(path.join(jobDir, `edit-plan.v${v}.json`)), plan_sha256: hashObject(pl), render: path.relative(root, outPath), status: outcome.status, checks, created_at: new Date().toISOString() };
      writeJsonAtomic(path.join(jobDir, `qc.v${v}.json`), qc);
      const preview = contactSheet(outPath, path.join(jobDir, `preview.v${v}.jpg`), dur);
      updateShort(P.registry, id, (s) => {
        const ver = s.versions.find((x) => x.v === v);
        Object.assign(ver, { plan: path.relative(root, path.join(jobDir, `edit-plan.v${v}.json`)), render: path.relative(root, outPath), qc_status: outcome.status });
        s.current_version = v;
      });
      return { v, outPath, outcome, qc, durationSec: dur, preview };
    };

    // Every cut measured against the ORIGINAL recording: speech energy at the edge decides the verdict.
    function speechEdgesCheck(pl) {
      const a = auditEdges({ segments: pl.rough_cut.segments, env: analysis.audio.envelope, offset: analysis.audio.envelopeOffset ?? 0, fps: pl.format.fps });
      const bad = a.joins.filter((j) => j.verdict !== "PASS");
      const detail = a.status === "skip" ? a.detail : bad.length
        ? `listen to: ${bad.slice(0, 6).map((j) => `${j.verdict} at ${j.at.toFixed(2)}s (${Math.max(j.outDb, j.inDb).toFixed(0)} dB vs ${j.thresholdDb} dB speech)`).join(", ")}`
        : `${a.joins.length} cut(s), all in silence (≤ ${a.joins[0]?.thresholdDb ?? "-"} dB)`;
      return { id: "speech_edges", status: a.status === "skip" ? "skipped" : a.status, detail, joins: a.joins };
    }

    const attempted = [];
    let res = await attempt(plan);
    attempted.push({ v: res.v, status: res.outcome.status, repairOf: null });
    let repairNote = null;
    if (res.outcome.status === "REPAIRABLE") {
      const v2 = allocateVersion(P.registry, id);
      const { plan: repaired, applied } = repairPlan(plan, res.outcome.failures, { profile, words, version: v2 });
      repairNote = applied;
      log(`repair v${plan.version} → v${v2}: ${applied.join("; ") || "nothing applicable"}`);
      const chk = validatePlan(repaired, { profile, assets });
      writeJsonAtomic(path.join(jobDir, `edit-plan.v${v2}.json`), repaired);
      if (!chk.ok) {
        res = { ...res, outcome: { ...res.outcome, status: "NEEDS_REVIEW", reason: `repaired plan failed validation: ${chk.errors[0]}` } };
      } else {
        plan = repaired;
        res = await attempt(repaired);
        attempted.push({ v: res.v, status: res.outcome.status, repairOf: repaired.provenance.repair_of });
        if (res.outcome.status === "REPAIRABLE") res.outcome = { ...res.outcome, status: "NEEDS_REVIEW", reason: "defects remain after the one allowed repair" };
      }
    }

    const final = res.outcome.status === "PASS" || res.outcome.status === "PASS_WITH_WARNINGS" ? "COMPLETE" : "NEEDS_REVIEW";
    setStatus(final, { current_version: res.v });
    // Planner bookkeeping ("dropped …" candidates) stays in the plan file; the report shows what a person should act on.
    const dropped = plan.provenance.notes.filter((n) => n.startsWith("dropped ")).length;
    const allWarnings = [...new Set([...warnings,
      ...plan.provenance.notes.filter((n) => !n.startsWith("repair:") && !n.startsWith("dropped ") && !n.startsWith("LLM planner unavailable")),
      ...res.outcome.warnings.map((w) => `${w.id}: ${w.detail}`)])];
    if (dropped) log(`planner: ${dropped} candidate moment(s) not used (spacing/limits) — see edit-plan.v${res.v}.json`);
    result = {
      id, status: final, qcStatus: res.outcome.status, version: res.v, profile: profileRef, source: sourcePath,
      durationIn: range ? range.end - range.start : info.durationSec, durationOut: res.durationSec,
      removedSec: Number(((range ? range.end - range.start : info.durationSec) - res.durationSec).toFixed(1)),
      removals: plan.rough_cut.removals.filter((r) => r.applied && r.kind !== "range").length,
      render: res.outPath, captions: res.outPath.replace(/\.mp4$/, ".srt"), preview: res.preview, planner: plan.provenance.planner,
      failures: res.outcome.failures.map((f) => `${f.id}: ${f.detail}`), reason: res.outcome.reason ?? null,
      warnings: allWarnings, repair: repairNote, seconds: Number(((Date.now() - started) / 1000).toFixed(1)), jobDir,
    };
    for (const v of attempted) {
      if (!meta.versions.some((x) => x.v === v.v)) meta.versions.push({ v: v.v, plan: `edit-plan.v${v.v}.json`, qc: `qc.v${v.v}.json`, render: `renders/v${v.v}.mp4`, qc_status: v.status, repair_of: v.repairOf });
    }
    // undefined drops a previous run's failure fields from the JSON, so metadata never shows a stale error.
    Object.assign(meta, { source: sourceRecord, range, profile: profileRef, status: final, current_version: res.v, updated_at: new Date().toISOString(),
      failed_stage: undefined, error: undefined, last_result: { ...result, render: path.relative(root, res.outPath), jobDir: path.relative(root, jobDir) } });
    writeJsonAtomic(path.join(jobDir, "metadata.json"), meta);
    return result;
  } catch (err) {
    const e = err instanceof JobError ? err : new JobError(stage, err);
    log(`FAILED at ${e.stage}: ${err.message}`);
    try { setStatus("FAILED"); } catch { /* registry error already surfaced */ }
    Object.assign(meta, { status: "FAILED", failed_stage: e.stage, error: err.message, updated_at: new Date().toISOString() });
    writeJsonAtomic(path.join(jobDir, "metadata.json"), meta);
    throw e;
  } finally {
    const v = readJson(P.registry).shorts[id]?.current_version ?? 0;
    fs.appendFileSync(path.join(jobDir, "logs", `run-${v || "x"}-${started}.log`), `${logLines.join("\n")}\n`);
    temp.cleanup();
    releaseJob();
  }
}

/** The concise operator report. */
export function formatReport(r) {
  const lines = [
    `${r.id} — ${r.status}`,
    `Profile:   ${r.profile.id} (${r.profile.version})`,
    `Source:    ${r.source}`,
    `Duration:  ${fmtTime(r.durationIn)} → ${fmtTime(r.durationOut)}`,
    `Removed:   ${r.removedSec.toFixed(1)} sec (${r.removals} cut${r.removals === 1 ? "" : "s"})`,
    `Render:    ${r.render}  (v${r.version}${r.repair ? `, after 1 repair: ${r.repair.join("; ")}` : ""})`,
    `Captions:  ${r.captions}`,
    `QC:        ${r.qcStatus === "PASS" || r.qcStatus === "PASS_WITH_WARNINGS" ? "PASS" : r.qcStatus}`,
  ];
  if (r.status === "NEEDS_REVIEW") lines.push(`Review:    ${r.reason ?? ""}`, ...r.failures.map((f) => `           - ${f}`));
  lines.push(`Warnings:  ${r.warnings.length ? r.warnings[0] : "none"}`, ...r.warnings.slice(1).map((w) => `           ${w}`));
  lines.push(`Planner:   ${r.planner} · ${r.seconds}s · job folder ${r.jobDir}`);
  return lines.join("\n");
}
