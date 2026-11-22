/**
 * engine/planner/plan.js — turn a SELECTION into an executable EDIT DECISION PLAN. Pure.
 *
 * Judgement (heuristic.js / llm.js) says WHICH candidate gets WHICH approved behaviour. This file
 * says exactly WHEN and WHERE, by rule: timings come from the words, geometry from the face-aware
 * layout, limits from the profile. Anything a selection asks for that breaks a rule is dropped with
 * a note — the plan that comes out is always one the renderer can execute and the validator accepts.
 */
import { groupCaptions } from "../captions/group.js";
import { cueBox } from "../captions/ass.js";
import { COMPONENTS } from "../graphics/registry.js";
import { joinPoints } from "../rough-cut/cuts.js";
import { layoutRegions } from "../analysis/visual.js";
import { SCHEMA_VERSION } from "./validate.js";

// 6 dp: plan times must stay on the frame grid (3 dp rounding pushed a cut punch-in 0.3 ms past
// the video's last frame and the validator, rightly, refused the plan).
const r6 = (n) => Number(n.toFixed(6));

function captionLayout({ profile, layout, format }) {
  const C = profile.captions;
  const capH = C.maxLines * C.fontSize * 1.2 + C.outline * 2;
  const lo = layout.belowFace.y0 + capH / 2, hi = layout.belowFace.y1 - capH / 2;
  const notes = [];
  let y = Math.min(Math.max(format.height * C.preferredCentreYFrac, lo), hi);
  if (lo > hi) {
    // No room under the chin (a big face in the frame): put captions above the head if they fit there.
    const ulo = layout.upper.y0 + capH / 2, uhi = layout.upper.y1 - capH / 2;
    if (ulo <= uhi) { y = uhi; notes.push(`no room below the face — captions placed above the head`); }
    else { y = hi; notes.push(`only ${(layout.belowFace.y1 - layout.belowFace.y0).toFixed(0)}px between the face and the platform UI — captions may touch the chin`); }
  }
  // Centred on the frame (where the face is), inset symmetrically by the larger side margin.
  const side = Math.max(profile.safeZones.leftPx, profile.safeZones.rightPx);
  return { position: { x: Math.round(format.width / 2), y: Math.round(y) }, box: { x: side, y: Math.round(y - capH / 2), w: format.width - 2 * side, h: Math.round(capH) }, notes };
}

/** Pick a region box for a component, or null if no face-free band is tall enough. */
function graphicBox({ component, profile, layout, captionBox, format }) {
  const def = COMPONENTS[component];
  const side = Math.max(profile.safeZones.leftPx, profile.safeZones.rightPx);
  // Captions normally sit below the face; when they had to go above the head, graphics take what is left.
  const capsAbove = captionBox.y + captionBox.h <= layout.faceTopMin;
  const regions = capsAbove ? {
    lower: { y0: layout.belowFace.y0, y1: layout.belowFace.y1 },
    upper: { y0: layout.upper.y0, y1: captionBox.y - 16 },
  } : {
    lower: { y0: layout.belowFace.y0, y1: captionBox.y - 16 },
    upper: layout.upper,
  };
  for (const name of profile.graphics.regionPriority.map((n) => (n === "middle" ? "lower" : n))) {
    const g = regions[name];
    if (!g) continue;
    const avail = g.y1 - g.y0;
    if (avail < def.minHeight) continue;
    const h = Math.min(def.maxHeight, avail);
    return { region: name, box: { x: side, y: Math.round(g.y0 + (avail - h) / 2), w: format.width - 2 * side, h: Math.round(h) } };
  }
  return null;
}

export function assemblePlan(selection, ctx) {
  const { id, version, type, profile, profileRef, source, roughCut, reframes, words, candidates, tools = {}, inputs = {}, repairOf = null, now = new Date() } = ctx;
  const notes = [...(selection.notes ?? []), ...(ctx.notes ?? [])];
  const P = profile;
  const format = { aspect: P.output.width > P.output.height ? "16:9" : "9:16", width: P.output.width, height: P.output.height, fps: source.outFps };
  const segs = roughCut.segments;
  const duration = segs[segs.length - 1].out_end;
  const joins = joinPoints(segs);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const segAt = (t) => segs.find((s) => t >= s.out_start - 1e-9 && t < s.out_end - 1e-9) ?? segs[segs.length - 1];
  const reframeOf = (segId) => reframes.find((r) => r.segment === segId);

  const base = { format, rough_cut: { segments: segs }, reframes, punch_ins: [] };
  const layout = layoutRegions({ plan: base, srcW: source.width, srcH: source.height, safeZones: P.safeZones, maxScale: P.punchIns.maxScale, gapBelowFacePx: P.captions.gapBelowFacePx });
  const cap = captionLayout({ profile: P, layout, format });
  notes.push(...cap.notes);

  // ── punch-ins ──
  const punch = [];
  const fitsPunch = (s, e) => !punch.some((p) => s < p.out_end && e > p.out_start)
    && punch.every((p) => Math.abs(s - p.out_start) >= P.punchIns.minSpacingSec)
    && punch.filter((p) => Math.abs(p.out_start - s) < 30).length < P.punchIns.maxPer30s;
  const cutPresetFor = (scale) => Object.entries(P.punchIns.presets).find(([, x]) => x.kind === "cut" && Math.abs(x.scale - scale) < 1e-6)?.[0] ?? P.punchIns.cutPreset;
  const addPunch = (candId, presetName, reason, { start, end }) => {
    let pr = P.punchIns.presets[presetName];
    if (!pr) { notes.push(`dropped punch-in on ${candId}: unknown preset ${presetName}`); return; }
    const seg = segAt(start);
    // Emphasis that lands right after a cut is punched ON the cut (instant reframe, hidden by the
    // edit) — the classic talking-head move — instead of easing in a beat late.
    const segLen = seg.out_end - seg.out_start;
    if (pr.kind === "ease" && seg.out_start > 0 && start - seg.out_start <= (P.punchIns.cutAfterJoinSec ?? 0.35) && segLen <= (P.punchIns.maxCutHoldSec ?? P.punchIns.maxHoldSec)) {
      const cutName = cutPresetFor(pr.scale);
      if (P.punchIns.presets[cutName]) { presetName = cutName; pr = P.punchIns.presets[cutName]; reason = `${reason} (on the cut)`; }
    }
    // A cut punch-in holds for its whole segment; on a long segment the same emphasis is the eased
    // preset of the same scale (closest approved behaviour) rather than no emphasis at all.
    if (pr.kind === "cut" && segLen > (P.punchIns.maxCutHoldSec ?? P.punchIns.maxHoldSec)) {
      const easeName = Object.entries(P.punchIns.presets).find(([, x]) => x.kind === "ease" && Math.abs(x.scale - pr.scale) < 1e-6)?.[0];
      if (easeName) { presetName = easeName; pr = P.punchIns.presets[easeName]; reason = `${reason} (eased: segment too long to hold a cut punch-in)`; }
    }
    if (pr.kind === "cut") {
      if (!fitsPunch(seg.out_start, seg.out_end) || segLen > (P.punchIns.maxCutHoldSec ?? P.punchIns.maxHoldSec)) { notes.push(`dropped cut punch-in on ${candId}: spacing/segment length`); return; }
      punch.push({ id: `pi${punch.length + 1}`, kind: "cut", preset: presetName, scale: pr.scale, ramp_sec: 0, out_start: r6(seg.out_start), out_end: r6(seg.out_end), release: "cut", anchor: reframeOf(seg.id).anchor, candidate: candId, reason });
      return;
    }
    let s = Math.max(seg.out_start, start), e = Math.min(seg.out_end, end, s + P.punchIns.maxHoldSec);
    const atJoin = Math.abs(e - seg.out_end) < 1e-6;
    // Ramp in, HOLD (a zoom that immediately eases back out reads as a twitch), ramp out.
    const need = (atJoin ? 1 : 2) * pr.rampSec + (P.punchIns.easeHoldSec ?? 0.2);
    if (e - s < Math.max(need, P.punchIns.minHoldSec)) e = Math.min(seg.out_end, s + Math.max(need, P.punchIns.minHoldSec));
    const release = Math.abs(e - seg.out_end) < 1e-6 ? "cut" : "ease";
    if (e - s < Math.max((release === "cut" ? 1 : 2) * pr.rampSec + 0.2, P.punchIns.minHoldSec)) { notes.push(`dropped punch-in on ${candId}: too close to a cut to ease in and out`); return; }
    if (!fitsPunch(s, e)) { notes.push(`dropped punch-in on ${candId}: spacing (${P.punchIns.minSpacingSec}s / ${P.punchIns.maxPer30s} per 30s)`); return; }
    punch.push({ id: `pi${punch.length + 1}`, kind: "ease", preset: presetName, scale: pr.scale, ramp_sec: pr.rampSec, out_start: r6(s), out_end: r6(e), release, anchor: reframeOf(seg.id).anchor, candidate: candId, reason });
  };

  // ── graphics ──
  const graphics = [];
  const G = P.graphics;
  const fitsGraphic = (s, e) => !graphics.some((g) => s < g.out_end && e > g.out_start)
    && graphics.every((g) => Math.abs(s - g.out_start) >= G.minSpacingSec)
    && graphics.filter((g) => Math.abs(g.out_start - s) < 30).length < G.maxPer30s;
  const addGraphic = (candId, component, props, reason, { start, end }) => {
    if (!COMPONENTS[component] || COMPONENTS[component].status !== "implemented" || !G.allowed.includes(component)) { notes.push(`dropped ${component} on ${candId}: not an allowed implemented component`); return; }
    const bad = COMPONENTS[component].check(props);
    if (bad) { notes.push(`dropped ${component} on ${candId}: ${bad}`); return; }
    const s = Math.max(0, start), e = Math.min(duration, Math.max(end, s + G.minSec), s + G.maxSec);
    if (e - s < G.minSec - 1e-6) { notes.push(`dropped ${component} on ${candId}: too close to the end`); return; }
    if (!fitsGraphic(s, e)) { notes.push(`dropped ${component} on ${candId}: graphic spacing/frequency`); return; }
    // The same callout twice in one video reads as a glitch, not emphasis.
    const sig = JSON.stringify(props);
    if (graphics.some((g) => JSON.stringify(g.props) === sig)) { notes.push(`dropped ${component} on ${candId}: repeats an earlier graphic`); return; }
    const placed = graphicBox({ component, profile: P, layout, captionBox: cap.box, format });
    if (!placed) { notes.push(`dropped ${component} on ${candId}: no face-free band tall enough (needs ${COMPONENTS[component].minHeight}px)`); return; }
    graphics.push({ id: `g${graphics.length + 1}`, component, out_start: r6(s), out_end: r6(e), props, region: placed.region, box: placed.box, candidate: candId, reason });
  };

  // Hook first: it is allowed to be stronger than the body.
  let hook = { out_start: 0, out_end: 0, text: "", treatments: [], reason: "no opening sentence found" };
  const hc = selection.hook && byId.get(selection.hook.candidate);
  if (hc) {
    const hookEnd = Math.min(hc.out_end, P.hook.windowSec[1] + 2);
    hook = { out_start: 0, out_end: r6(hookEnd), text: hc.text, treatments: [], reason: "opening line — first 3–5s decide whether the viewer stays" };
    if (selection.hook.punch && P.hook.treatments.includes("punch_in")) {
      const k = hc.key ?? hc;
      const n = punch.length;
      addPunch(hc.id, selection.hook.punch.preset, selection.hook.punch.reason, { start: Math.max(0, k.out_start - 0.2), end: hookEnd + 0.4 });
      if (punch.length > n) hook.treatments.push("punch_in");
    }
    if (selection.hook.graphic && P.hook.treatments.includes("bold_text") && P.hook.maxGraphics > 0) {
      const k = hc.key ?? hc;
      const n = graphics.length;
      addGraphic(hc.id, selection.hook.graphic.component, selection.hook.graphic.props, selection.hook.graphic.reason, { start: k.out_start, end: k.out_end + 0.6 });
      if (graphics.length > n) hook.treatments.push("bold_text");
    }
  }
  for (const p of selection.punch_ins ?? []) {
    const c = byId.get(p.candidate);
    if (!c) { notes.push(`ignored punch-in on unknown candidate ${p.candidate}`); continue; }
    addPunch(c.id, p.preset, p.reason, { start: c.out_start - 0.12, end: Math.max(c.out_end + 0.4, (c.sentence_end ?? c.out_end) + 0.3) });
  }
  for (const g of selection.graphics ?? []) {
    const c = byId.get(g.candidate);
    if (!c) { notes.push(`ignored graphic on unknown candidate ${g.candidate}`); continue; }
    addGraphic(c.id, g.component, g.props, g.reason, { start: c.out_start, end: c.out_end + 0.5 });
  }

  // ── captions ──
  const emphasis = new Set((selection.emphasis ?? []).map((x) => words[x.word]).filter(Boolean).map((w) => w.start.toFixed(3)));
  const cues = groupCaptions(words, { style: P.captions, joins, emphasis, durationSec: duration });
  // Keep the predicted box honest: widen nothing, but record the widest real cue for QC.
  const widest = cues.reduce((m, c) => Math.max(m, cueBox(c, P.captions, { x: cap.position.x, y: cap.position.y, maxWidth: cap.box.w }).w), 0);

  punch.sort((a, b) => a.out_start - b.out_start).forEach((p, i) => { p.id = `pi${i + 1}`; });
  graphics.sort((a, b) => a.out_start - b.out_start).forEach((g, i) => { g.id = `g${i + 1}`; });

  return {
    schema_version: SCHEMA_VERSION,
    id, version, type,
    profile: profileRef,
    source: {
      sha256: source.sha256, filename: source.filename, duration: source.durationSec, width: source.width, height: source.height,
      fps: source.fps, rotation: source.rotation, audio_index: source.audio.audioIndex, channel_fix: source.channelFix ?? null,
      hdr: source.hdr, start_offset: source.startOffsetSec,
    },
    format,
    rough_cut: { segments: segs, removals: roughCut.removals, stats: roughCut.stats },
    reframes,
    punch_ins: punch,
    captions: { style: P.captions.style, position: cap.position, box: cap.box, cues },
    graphics,
    overlays: [], broll: [], sfx: [],
    audio: { target_lufs: P.audio.targetLufs, true_peak_db: P.audio.truePeakDb, lra: P.audio.lra, limiter: P.audio.limiter, join_fade_ms: P.audio.joinFadeMs, channel_fix: source.channelFix ?? null, music: null },
    hook,
    layout: { ...layout, widestCaptionPx: Math.round(widest) },
    provenance: { planner: selection.planner, created_at: now.toISOString(), tools, inputs, repair_of: repairOf, notes },
  };
}
