/**
 * engine/renderer/graph.js — EDIT PLAN → ffmpeg filtergraph text. Pure, snapshot-tested.
 *
 * Deterministic execution of a validated plan; no decisions are made here. Geometry comes from
 * geometry/transform.js so the picture and the collision maths agree by construction.
 *
 * Video chain:
 *   [0:v] → (HLG/PQ tonemap) → fps=<cfr> → yuv420p → split=N
 *   per segment: trim → setpts → crop (face window) → [cut punch-in: sub-crop + scale back] → setsar
 *   concat → [eased punch-ins: perspective, eval=frame, t = frame index / fps] → scale to output
 *   → graphics overlays (PNG sequences placed with setpts offsets) → ass captions
 *
 * WHY trim/concat: ported decision from scripts/edit/render.js — the concat demuxer seeks and on
 * sparse-keyframe sources keeps the WRONG footage (5.376s for a 2.0s request); select= ran out of
 * memory at 200 segments. trim/concat is frame-exact.
 * WHY one shared normalisation before split: the perspective expression uses frame index ÷ fps,
 * which is only time on a constant-rate stream.
 */
import { zoomSubCrop } from "../geometry/transform.js";

const f6 = (n) => Number(n).toFixed(6);
const ss = (p) => `(3*pow(clip(${p},0,1),2)-2*pow(clip(${p},0,1),3))`;

/** Escape a path for use inside a filtergraph option value. */
export function escapeFilterPath(p) {
  return String(p).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/,/g, "\\,").replace(/\[/g, "\\[").replace(/\]/g, "\\]").replace(/;/g, "\\;");
}

/** Zoom expression Z(t) and anchors for eased punch-ins (non-overlapping, validated). */
export function easeExpressions(punchIns, fps) {
  const T = `(in/${fps})`;
  const eases = punchIns.filter((p) => p.kind === "ease");
  if (!eases.length) return null;
  const ind = (p) => `gte(${T},${f6(p.out_start)})*lt(${T},${f6(p.out_end)})`;
  const shape = (p) => {
    const up = ss(`(${T}-${f6(p.out_start)})/${f6(p.ramp_sec)}`);
    if (p.release === "cut") return up;
    const down = ss(`(${f6(p.out_end)}-${T})/${f6(p.ramp_sec)}`);
    return `min(${up},${down})`;
  };
  const Z = `(1${eases.map((p) => `+${f6(p.scale - 1)}*${ind(p)}*${shape(p)}`).join("")})`;
  const pick = (k, dflt) => eases.reduceRight((acc, p) => `if(${ind(p)},${f6(p.anchor[k])},${acc})`, String(dflt));
  return { Z, AX: `(${pick("x", 0.5)})`, AY: `(${pick("y", 0.42)})` };
}

export function perspectiveFilter({ Z, AX, AY }) {
  const L = `(${AX}*W*(1-1/${Z}))`, Tp = `(${AY}*H*(1-1/${Z}))`;
  const R = `(${L}+W/${Z})`, B = `(${Tp}+H/${Z})`;
  return `perspective=x0='${L}':y0='${Tp}':x1='${R}':y1='${Tp}':x2='${L}':y2='${B}':x3='${R}':y3='${B}':interpolation=cubic:sense=source:eval=frame`;
}

const TONEMAP = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv";

/**
 * @param plan       validated edit plan
 * @param assPath    captions file (null → no captions)
 * @param graphics   [{inputIndex, out_start, box:{x,y}}] — PNG sequence inputs, in plan order
 * @returns { filter, videoLabel }
 */
export function buildVideoGraph(plan, { assPath = null, graphics = [] } = {}) {
  const { width: OW, height: OH, fps } = plan.format;
  const segs = plan.rough_cut.segments;
  const n = segs.length;
  const lines = [];
  const pre = [plan.source.hdr ? TONEMAP : null, `fps=${fps}`, "format=yuv420p"].filter(Boolean).join(",");
  lines.push(`[0:v]${pre}${n > 1 ? `,split=${n}${segs.map((_, i) => `[v${i}]`).join("")}` : "[v0]"}`);

  // All crops must share one size so concat accepts them.
  const sizes = new Set(plan.reframes.map((r) => `${r.crop.w}x${r.crop.h}`));
  if (sizes.size !== 1) throw new Error(`buildVideoGraph: crop sizes differ across segments (${[...sizes].join(", ")})`);
  const { w: CW, h: CH } = plan.reframes[0].crop;

  segs.forEach((s, i) => {
    const rf = plan.reframes.find((r) => r.segment === s.id);
    const chain = [`trim=start=${f6(s.src_start)}:end=${f6(s.src_end)}`, "setpts=PTS-STARTPTS", `crop=${rf.crop.w}:${rf.crop.h}:${rf.crop.x}:${rf.crop.y}`];
    const cut = plan.punch_ins.find((p) => p.kind === "cut" && Math.abs(p.out_start - s.out_start) < 1e-4);
    if (cut) {
      const sub = zoomSubCrop({ cropW: CW, cropH: CH, z: cut.scale, anchor: cut.anchor });
      chain.push(`crop=${sub.w}:${sub.h}:${sub.x}:${sub.y}`, `scale=${CW}:${CH}:flags=lanczos`);
    }
    chain.push("setsar=1");
    lines.push(`[v${i}]${chain.join(",")}[s${i}]`);
  });
  lines.push(`${segs.map((_, i) => `[s${i}]`).join("")}concat=n=${n}:v=1:a=0[vc]`);

  const ease = easeExpressions(plan.punch_ins, fps);
  // setparams: an untagged source (no colour metadata) otherwise ships with unset primaries/transfer
  // even with -color_primaries on the encoder — found on a synthetic clip, 2026-10-02.
  lines.push(`[vc]${ease ? `${perspectiveFilter(ease)},` : ""}scale=${OW}:${OH}:flags=lanczos,setsar=1,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709[vb0]`);

  let cur = "vb0";
  graphics.forEach((g, k) => {
    lines.push(`[${g.inputIndex}:v]setpts=PTS-STARTPTS+${f6(g.out_start)}/TB,scale=out_color_matrix=bt709:out_range=tv,format=yuva420p[gi${k}]`);
    lines.push(`[${cur}][gi${k}]overlay=x=${Math.round(g.box.x)}:y=${Math.round(g.box.y)}:eof_action=pass:format=auto[vb${k + 1}]`);
    cur = `vb${k + 1}`;
  });
  if (assPath) {
    lines.push(`[${cur}]ass=filename='${escapeFilterPath(assPath)}'[vout]`);
    cur = "vout";
  }
  return { filter: lines.join(";\n"), videoLabel: cur };
}

/** Audio pre-pass: chosen track → (mono fix) → 48k → per-segment trim with edge fades → concat. */
export function buildAudioCutGraph(plan) {
  const segs = plan.rough_cut.segments;
  const fade = plan.audio.join_fade_ms / 1000;
  const fix = plan.audio.channel_fix === "left" ? "pan=stereo|c0=c0|c1=c0," : plan.audio.channel_fix === "right" ? "pan=stereo|c0=c1|c1=c1," : "";
  // async+first_pts=0 fills a late audio start with silence; apad extends audio that stops before the
  // picture — so every segment's atrim gets exactly its span and A/V stay locked.
  const lines = [`[0:a:${plan.source.audio_index}]${fix}aformat=channel_layouts=stereo,aresample=48000:async=1:first_pts=0,apad${segs.length > 1 ? `,asplit=${segs.length}${segs.map((_, i) => `[a${i}]`).join("")}` : "[a0]"}`];
  segs.forEach((s, i) => {
    const len = s.src_end - s.src_start;
    const fades = fade > 0 && len > 4 * fade ? `,afade=t=in:d=${f6(fade)},afade=t=out:st=${f6(len - fade)}:d=${f6(fade)}` : "";
    lines.push(`[a${i}]atrim=start=${f6(s.src_start)}:end=${f6(s.src_end)},asetpts=PTS-STARTPTS${fades}[t${i}]`);
  });
  lines.push(`${segs.map((_, i) => `[t${i}]`).join("")}concat=n=${segs.length}:v=0:a=1[acut]`);
  return lines.join(";\n");
}

/** Final audio chain on the cut wav, using first-pass loudnorm measurements. */
export function buildAudioFinal(plan, measured, { inputIndex = 1 } = {}) {
  const a = plan.audio;
  const m = measured
    ? `:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`
    : "";
  return `[${inputIndex}:a]loudnorm=I=${a.target_lufs}:TP=${a.true_peak_db}:LRA=${a.lra}${m},aresample=48000,alimiter=level=0:limit=${a.limiter}:attack=5:release=50,aformat=sample_rates=48000:channel_layouts=stereo[aout]`;
}

/** x264/AAC social defaults (H.264 High, CFR, bt709 tags, faststart). */
export function encodeArgs(plan, profile) {
  const o = profile.output;
  const fps = plan.format.fps;
  return [
    "-c:v", o.videoCodec, "-profile:v", o.x264Profile, "-level:v", fps > 30 ? "4.2" : "4.1",
    "-preset", o.preset, "-crf", String(o.crf), "-maxrate", o.maxrate, "-bufsize", o.bufsize,
    "-pix_fmt", o.pixFmt, "-g", String(Math.round(fps * 2)), "-fps_mode", "cfr", "-r", String(fps),
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
    "-c:a", o.audioCodec, "-b:a", o.audioBitrate, "-ar", String(o.audioRate), "-ac", String(o.audioChannels),
    "-movflags", "+faststart",
  ];
}
