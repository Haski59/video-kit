/**
 * engine/analysis/visual.js — look at the actual picture, not just the transcript.
 *
 * Light by design: sample frames at a few fps, ask Apple Vision for faces, and derive only what the
 * edit needs to avoid the classic mistakes — text over the speaker's face, a punch-in into empty space, a
 * crop that cuts the speaker, reframing something already vertical. No CV platform.
 *
 * I/O: sampleFrames(), detectFaces(). Everything after that is pure and tested.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { probeEnv } from "../env.js";
import { cropWindow, srcBoxToOut, safeRect } from "../geometry/transform.js";

const SWIFT_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "face-detect.swift");
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };

/** Frames at `fps`, `width` px wide, into dir. Returns [{t, file}] on the source timeline. */
export function sampleFrames(src, dir, { fps = 3, width = 640, range = null } = {}) {
  const { ffmpeg } = probeEnv();
  fs.mkdirSync(dir, { recursive: true });
  const args = ["-y", "-v", "error"];
  if (range) args.push("-ss", range.start.toFixed(3), "-to", range.end.toFixed(3));
  args.push("-i", src, "-vf", `fps=${fps},scale=${width}:-2`, "-q:v", "4", path.join(dir, "f%05d.jpg"));
  const r = spawnSync(ffmpeg, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`frame sampling failed: ${String(r.stderr).trim().slice(-300)}`);
  const offset = range ? range.start : 0;
  return fs.readdirSync(dir).filter((f) => /^f\d{5}\.jpg$/.test(f)).sort()
    .map((f) => ({ t: Number((offset + (Number(f.slice(1, 6)) - 1) / fps).toFixed(3)), file: path.join(dir, f) }));
}

/** Compile the Swift helper once per source hash (~2s), cache in ~/.cache/video-kit/bin. */
function visionBinary() {
  const env = probeEnv();
  const src = fs.readFileSync(SWIFT_SRC);
  const bin = path.join(os.homedir(), ".cache", "video-kit", "bin", `face-detect-${createHash("sha256").update(src).digest("hex").slice(0, 10)}`);
  if (fs.existsSync(bin)) return { cmd: bin, pre: [] };
  if (env.swiftc) {
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    const r = spawnSync(env.swiftc, ["-O", SWIFT_SRC, "-o", `${bin}.tmp`], { encoding: "utf8" });
    if (r.status === 0) { fs.renameSync(`${bin}.tmp`, bin); return { cmd: bin, pre: [] }; }
  }
  if (env.swift) return { cmd: env.swift, pre: [SWIFT_SRC] };
  return null;
}

/** Vision over sampled frames → [{t, faces:[{x,y,w,h,c}], text:[…]}]; null if Vision is unavailable. */
export function detectFaces(frames) {
  const v = visionBinary();
  if (!v || !frames.length) return null;
  const byFile = new Map(frames.map((f) => [f.file, f.t]));
  const out = [];
  for (let i = 0; i < frames.length; i += 200) {
    const batch = frames.slice(i, i + 200);
    const r = spawnSync(v.cmd, [...v.pre, ...batch.map((f) => f.file)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`face detection failed: ${String(r.stderr).trim().slice(-300)}`);
    for (const line of r.stdout.split("\n").filter(Boolean)) {
      const j = JSON.parse(line);
      if (j.error) continue;
      out.push({ t: byFile.get(j.file), faces: j.faces, text: j.text });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// ── pure ────────────────────────────────────────────────────────────────────

/** Main face per sample (largest), plus whether a second sizeable face is present. */
export function faceTrack(samples, { minConfidence = 0.5 } = {}) {
  return samples.map((s) => {
    const faces = (s.faces ?? []).filter((f) => f.c >= minConfidence).sort((a, b) => b.w * b.h - a.w * a.h);
    const main = faces[0] ?? null;
    const second = faces[1] && faces[1].w * faces[1].h > 0.25 * main.w * main.h ? faces[1] : null;
    return { t: s.t, main, multi: Boolean(second), textBoxes: (s.text ?? []).length };
  });
}

/** Summary used by the report and the planner. */
export function summariseTrack(track) {
  const withFace = track.filter((s) => s.main);
  const cxs = withFace.map((s) => s.main.x + s.main.w / 2);
  return {
    samples: track.length,
    faceCoverage: track.length ? Number((withFace.length / track.length).toFixed(3)) : 0,
    multiFaceFraction: track.length ? Number((track.filter((s) => s.multi).length / track.length).toFixed(3)) : 0,
    medianFaceCx: median(cxs), medianFaceCy: median(withFace.map((s) => s.main.y + s.main.h / 2)),
    medianFaceH: median(withFace.map((s) => s.main.h)),
    horizontalSpread: cxs.length ? Number((pct(cxs, 0.9) - pct(cxs, 0.1)).toFixed(3)) : null,
    onScreenTextFraction: track.length ? Number((track.filter((s) => s.textBoxes > 0).length / track.length).toFixed(3)) : 0,
  };
}

/**
 * One static crop per kept segment, centred on that segment's median face. The crop only moves at
 * cuts (a hard cut hides the move) and only if the move is worth it (minShiftFrac) — otherwise the
 * previous framing is kept so a reel doesn't jitter a few pixels at every join.
 * Returns { reframes, warnings }. reframes: [{segment, mode, crop, anchor, face}]
 */
export function planReframes({ segments, track, srcW, srcH, format, reframe }) {
  const aspect = format.width / format.height;
  const warnings = [];
  const already = srcW / srcH <= reframe.alreadyVerticalAspect + 1e-6;
  const mode = already ? "none" : reframe.mode;
  if (already && reframe.mode === "face_crop") warnings.push("source is already vertical — no reframe applied");
  const global = summariseTrack(track);
  if (mode === "face_crop" && global.faceCoverage < 0.5) warnings.push(`a face was found in only ${(global.faceCoverage * 100).toFixed(0)}% of samples — centre crop used where missing`);
  if (global.multiFaceFraction > 0.2) warnings.push(`two faces in ${(global.multiFaceFraction * 100).toFixed(0)}% of samples — face crop follows the largest; review framing`);

  let prevCx = null;
  const reframes = segments.map((seg) => {
    const inSeg = track.filter((s) => s.main && s.t >= seg.src_start - 1e-6 && s.t <= seg.src_end + 1e-6);
    const pool = inSeg.length ? inSeg : track.filter((s) => s.main);
    const cx = median(pool.map((s) => s.main.x + s.main.w / 2)) ?? 0.5;
    const cy = median(pool.map((s) => s.main.y + s.main.h / 2)) ?? 0.42;
    const face = pool.length ? {
      x: median(pool.map((s) => s.main.x)), y: median(pool.map((s) => s.main.y)),
      w: median(pool.map((s) => s.main.w)), h: median(pool.map((s) => s.main.h)),
      // Union over the segment: what the face can occupy, not just where it usually is.
      union: {
        x: Math.min(...pool.map((s) => s.main.x)), y: Math.min(...pool.map((s) => s.main.y)),
        r: Math.max(...pool.map((s) => s.main.x + s.main.w)), b: Math.max(...pool.map((s) => s.main.y + s.main.h)),
      },
    } : null;
    if (inSeg.length) {
      const spread = pct(inSeg.map((s) => s.main.x + s.main.w / 2), 0.9) - pct(inSeg.map((s) => s.main.x + s.main.w / 2), 0.1);
      if (spread > reframe.unstableSpreadFrac) warnings.push(`${seg.id}: speaker moves ${(spread * 100).toFixed(0)}% of frame width — static crop may clip`);
    } else if (mode === "face_crop") warnings.push(`${seg.id}: no face sampled — using the clip-wide position`);

    let useCx = cx;
    if (prevCx !== null && Math.abs(cx - prevCx) < reframe.minShiftFrac) useCx = prevCx;
    prevCx = useCx;

    let crop;
    if (mode === "face_crop") crop = cropWindow({ srcW, srcH, aspect, faceCx: useCx, faceCy: cy, anchorYFrac: reframe.faceAnchorYFrac ?? 0.42 });
    else crop = { x: 0, y: 0, w: srcW, h: srcH };
    // Anchor for zooms: the face centre inside the crop (normalised), so a punch-in never pushes the face.
    const anchor = face && mode !== "letterbox"
      ? { x: Number(((useCx * srcW - crop.x) / crop.w).toFixed(4)), y: Number(((cy * srcH - crop.y) / crop.h).toFixed(4)) }
      : { x: 0.5, y: 0.42 };
    anchor.x = Math.min(0.95, Math.max(0.05, anchor.x));
    anchor.y = Math.min(0.95, Math.max(0.05, anchor.y));
    return { segment: seg.id, mode, crop, anchor, face };
  });
  return { reframes, warnings };
}

/**
 * Where text may go, in output px: the face-free area inside the platform safe zone.
 * Uses the face's union box at the LARGEST zoom the profile allows, so no punch-in can push the
 * face into a caption. Returns { safe, faceBottomMax, faceTopMin, caption:{y0,y1}, regions:{upper,middle} }.
 */
export function layoutRegions({ plan, srcW, srcH, safeZones, maxScale, gapBelowFacePx = 48 }) {
  const safe = safeRect(plan.format, safeZones);
  let faceBottom = -Infinity, faceTop = Infinity;
  for (const rf of plan.reframes) {
    if (!rf.face) continue;
    const seg = plan.rough_cut.segments.find((s) => s.id === rf.segment);
    const u = rf.face.union;
    const box = { x: u.x, y: u.y, w: u.r - u.x, h: u.b - u.y };
    // Evaluate at the segment midpoint with a synthetic max zoom about the anchor.
    const probe = { ...plan, punch_ins: [{ kind: "cut", scale: maxScale, out_start: seg.out_start, out_end: seg.out_end, anchor: rf.anchor }] };
    const ob = srcBoxToOut(box, (seg.out_start + seg.out_end) / 2, probe, srcW, srcH);
    faceBottom = Math.max(faceBottom, ob.y + ob.h);
    faceTop = Math.min(faceTop, ob.y);
  }
  if (!Number.isFinite(faceBottom)) { faceBottom = plan.format.height * 0.45; faceTop = plan.format.height * 0.2; }
  const belowFace = Math.max(safe.y, faceBottom + gapBelowFacePx);
  return {
    safe,
    faceTopMin: Math.round(faceTop), faceBottomMax: Math.round(faceBottom),
    // Everything below the chin (at max zoom) down to the platform UI: captions + lower graphics.
    belowFace: { y0: Math.round(belowFace), y1: Math.round(safe.y + safe.h) },
    // Above the head: may cover hair, never the face box.
    upper: { y0: safe.y, y1: Math.round(Math.max(safe.y, faceTop - 8)) },
  };
}
