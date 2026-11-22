/**
 * engine/planner/validate.js — a malformed edit plan fails HERE, before any pixel renders.
 *
 * Plain JS on purpose (not a JSON-Schema subset interpreter): an interpreter that silently ignores
 * keywords it doesn't implement silently passes bad plans. This validator rejects unknown keys on
 * every executable object, then checks meaning — times, frames, geometry, presets, safe zones, and
 * that every callout is DERIVED from words actually spoken in its window.
 *
 * validatePlan(plan, { profile, assets }) → { ok, errors[] }. assertValidPlan throws PLAN_INVALID.
 */
import { boxInside, boxesOverlap, safeRect } from "../geometry/transform.js";
import { COMPONENTS } from "../graphics/registry.js";
import { factsSupported, extractFacts } from "./numbers.js";
import { normalizeWord } from "../transcription/words.js";

export const SCHEMA_VERSION = "1.0";
const EPS = 1e-6;

// ── tiny shape DSL ──────────────────────────────────────────────────────────
const num = (o = {}) => ({ t: "num", ...o });
const int = (o = {}) => ({ t: "num", int: true, ...o });
const str = (o = {}) => ({ t: "str", ...o });
const bool = () => ({ t: "bool" });
const nul = (x) => ({ t: "nullable", x });
const arr = (item) => ({ t: "arr", item });
const obj = (shape, { strict = true, optional = [] } = {}) => ({ t: "obj", shape, strict, optional });
const any = () => ({ t: "any" });

function check(v, s, p, errs) {
  switch (s.t) {
    case "any": return;
    case "nullable": if (v === null) return; return check(v, s.x, p, errs);
    case "num":
      if (typeof v !== "number" || !Number.isFinite(v)) return errs.push(`${p}: expected number`);
      if (s.int && !Number.isInteger(v)) errs.push(`${p}: expected integer`);
      if (s.min !== undefined && v < s.min) errs.push(`${p}: ${v} < ${s.min}`);
      if (s.max !== undefined && v > s.max) errs.push(`${p}: ${v} > ${s.max}`);
      return;
    case "str":
      if (typeof v !== "string") return errs.push(`${p}: expected string`);
      if (s.enum && !s.enum.includes(v)) errs.push(`${p}: "${v}" not one of ${s.enum.join("|")}`);
      if (s.nonEmpty && !v.trim()) errs.push(`${p}: must not be empty`);
      if (s.re && !s.re.test(v)) errs.push(`${p}: "${v}" has the wrong format`);
      return;
    case "bool": if (typeof v !== "boolean") errs.push(`${p}: expected boolean`); return;
    case "arr":
      if (!Array.isArray(v)) return errs.push(`${p}: expected array`);
      v.forEach((x, i) => check(x, s.item, `${p}[${i}]`, errs));
      return;
    case "obj": {
      if (!v || typeof v !== "object" || Array.isArray(v)) return errs.push(`${p}: expected object`);
      for (const k of Object.keys(s.shape)) {
        if (!(k in v)) { if (!s.optional.includes(k)) errs.push(`${p}.${k}: missing`); continue; }
        check(v[k], s.shape[k], `${p}.${k}`, errs);
      }
      if (s.strict) for (const k of Object.keys(v)) if (!(k in s.shape)) errs.push(`${p}.${k}: unknown key`);
      return;
    }
    default: errs.push(`${p}: bad schema`);
  }
}

const BOX = obj({ x: num(), y: num(), w: num({ min: 0 }), h: num({ min: 0 }) });
const PT = obj({ x: num({ min: 0, max: 1 }), y: num({ min: 0, max: 1 }) });
const WORD = obj({ text: str(), start: num({ min: 0 }), end: num({ min: 0 }), emphasis: bool() });

export const PLAN_SHAPE = obj({
  schema_version: str({ enum: [SCHEMA_VERSION] }),
  id: str({ re: /^[SL]\d{3,}$/ }),
  version: int({ min: 1 }),
  type: str({ enum: ["reel", "ad", "long"] }),
  profile: obj({ id: str({ nonEmpty: true }), version: str(), hash: str({ nonEmpty: true }) }),
  source: obj({
    sha256: str({ re: /^[0-9a-f]{64}$/ }), filename: str(), duration: num({ min: 0 }), width: int({ min: 2 }), height: int({ min: 2 }),
    fps: num({ min: 1 }), rotation: int(), audio_index: int({ min: 0 }), channel_fix: nul(str({ enum: ["left", "right"] })), hdr: bool(), start_offset: num(),
  }),
  format: obj({ aspect: str({ enum: ["9:16", "16:9"] }), width: int({ min: 2 }), height: int({ min: 2 }), fps: num({ min: 1 }) }),
  rough_cut: obj({
    segments: arr(obj({ id: str({ re: /^seg\d+$/ }), src_start: num({ min: 0 }), src_end: num({ min: 0 }), out_start: num({ min: 0 }), out_end: num({ min: 0 }) })),
    removals: arr(obj({ start: num({ min: 0 }), end: num({ min: 0 }), kind: str(), reason: str(), confidence: str({ enum: ["high", "low"] }), applied: bool(), detector: str(), why: arr(str()) }, { optional: ["detector", "why"] })),
    stats: obj({}, { strict: false }),
  }),
  reframes: arr(obj({ segment: str(), mode: str({ enum: ["face_crop", "letterbox", "none"] }), crop: BOX, anchor: PT, face: nul(obj({}, { strict: false })) })),
  punch_ins: arr(obj({
    id: str({ nonEmpty: true }), kind: str({ enum: ["ease", "cut"] }), preset: str({ nonEmpty: true }), scale: num({ min: 1 }), ramp_sec: num({ min: 0 }),
    out_start: num({ min: 0 }), out_end: num({ min: 0 }), release: str({ enum: ["ease", "cut"] }), anchor: PT, candidate: str({ nonEmpty: true }), reason: str({ nonEmpty: true }),
  })),
  captions: obj({
    style: str({ enum: ["KIT_CAPTION_V1"] }), position: obj({ x: num(), y: num() }), box: BOX,
    cues: arr(obj({ start: num({ min: 0 }), end: num({ min: 0 }), words: arr(WORD), lines: arr(arr(int({ min: 0 }))) })),
  }),
  graphics: arr(obj({
    id: str({ nonEmpty: true }), component: str({ nonEmpty: true }), out_start: num({ min: 0 }), out_end: num({ min: 0 }), props: obj({}, { strict: false }),
    region: str({ enum: ["upper", "lower"] }), box: BOX, candidate: str({ nonEmpty: true }), reason: str({ nonEmpty: true }),
  })),
  overlays: arr(any()),
  broll: arr(obj({ asset: str({ nonEmpty: true }), out_start: num({ min: 0 }), out_end: num({ min: 0 }), reason: str({ nonEmpty: true }) })),
  sfx: arr(obj({ asset: str({ nonEmpty: true }), at: num({ min: 0 }), reason: str({ nonEmpty: true }) })),
  audio: obj({ target_lufs: num({ min: -30, max: -8 }), true_peak_db: num({ max: 0 }), lra: num({ min: 1 }), limiter: num({ min: 0.1, max: 1 }), join_fade_ms: num({ min: 0, max: 50 }), channel_fix: nul(str({ enum: ["left", "right"] })), music: nul(obj({}, { strict: false })) }),
  hook: obj({ out_start: num({ min: 0 }), out_end: num({ min: 0 }), text: str(), treatments: arr(str()), reason: str({ nonEmpty: true }) }),
  layout: obj({}, { strict: false }),
  provenance: obj({ planner: str({ nonEmpty: true }), created_at: str(), tools: obj({}, { strict: false }), inputs: obj({}, { strict: false }), repair_of: nul(int({ min: 1 })), notes: arr(str()) }),
});

// ── semantic checks ─────────────────────────────────────────────────────────

const loose = (w) => normalizeWord(w).replace(/'s$/, "").replace(/s$/, "");

/** Every word and number in `shownTexts` must be supported by `spokenWords` (or be a template word). */
export function calloutDerived(shownTexts, spokenWords, template = []) {
  const shownTokens = shownTexts.join(" ").split(/\s+/).filter(Boolean);
  const facts = factsSupported(shownTokens, spokenWords);
  const spoken = new Set(spokenWords.map(loose));
  const tmpl = new Set(template.map(loose));
  const factTokens = new Set(shownTokens.filter((t) => extractFacts([t]).length).map(loose));
  const missing = shownTokens.filter((t) => {
    const l = loose(t.replace(/[^\p{L}\p{N}'£$€%]/gu, ""));
    if (!l || factTokens.has(loose(t)) || /^[£$€%/]+$/.test(t) || /^\/?mo$/i.test(t)) return false;
    if (/^\d/.test(l)) return false; // numeric tokens are judged by factsSupported
    return !spoken.has(l) && !tmpl.has(l);
  });
  return { ok: facts.ok && missing.length === 0, unsupportedFacts: facts.unsupported, missingWords: missing };
}

export function validatePlan(plan, { profile, assets = [] } = {}) {
  const errors = [];
  check(plan, PLAN_SHAPE, "plan", errors);
  if (errors.length) return { ok: false, errors }; // meaning checks assume the shape
  const e = (m) => errors.push(m);
  const P = profile;
  const fps = plan.format.fps, frame = 1 / fps;
  if (P) {
    if (plan.profile.id !== P.id) e(`profile id ${plan.profile.id} ≠ loaded ${P.id}`);
    if (plan.format.width !== P.output.width || plan.format.height !== P.output.height) e(`format ${plan.format.width}x${plan.format.height} ≠ profile output`);
  }

  // Segments: contiguous on the output, increasing on the source, whole frames, inside the source.
  const segs = plan.rough_cut.segments;
  if (!segs.length) e("rough_cut.segments: empty — nothing would render");
  segs.forEach((s, i) => {
    if (s.src_end <= s.src_start) e(`${s.id}: empty source span`);
    if (s.src_end > plan.source.duration + frame) e(`${s.id}: ends past the source`);
    if (Math.abs((s.out_end - s.out_start) - (s.src_end - s.src_start)) > 1e-4) e(`${s.id}: output length ≠ source length`);
    const frames = (s.src_end - s.src_start) * fps;
    if (Math.abs(frames - Math.round(frames)) > 1e-3) e(`${s.id}: not a whole number of frames (${frames.toFixed(4)})`);
    if (i === 0 && Math.abs(s.out_start) > EPS) e(`${s.id}: output must start at 0`);
    if (i > 0) {
      if (Math.abs(s.out_start - segs[i - 1].out_end) > 1e-4) e(`${s.id}: output gap/overlap after ${segs[i - 1].id}`);
      if (s.src_start < segs[i - 1].src_end - EPS) e(`${s.id}: overlaps the previous segment in the source`);
    }
  });
  const duration = segs.length ? segs[segs.length - 1].out_end : 0;
  const joins = segs.slice(1).map((s) => s.out_start);
  const segAt = (t) => segs.find((s) => t >= s.out_start - EPS && t < s.out_end - EPS);
  for (const r of plan.rough_cut.removals.filter((x) => x.applied)) {
    for (const s of segs) if (Math.min(r.end, s.src_end) - Math.max(r.start, s.src_start) > frame + 1e-4) e(`applied removal ${r.start}-${r.end} (${r.kind}) is still inside ${s.id}`);
  }

  // Reframes.
  for (const s of segs) if (plan.reframes.filter((r) => r.segment === s.id).length !== 1) e(`${s.id}: needs exactly one reframe`);
  for (const r of plan.reframes) {
    const c = r.crop;
    if (c.x < 0 || c.y < 0 || c.x + c.w > plan.source.width + EPS || c.y + c.h > plan.source.height + EPS) e(`reframe ${r.segment}: crop outside the source`);
    if (r.mode === "face_crop" && Math.abs(c.w / c.h - plan.format.width / plan.format.height) > 0.01) e(`reframe ${r.segment}: crop aspect ${(c.w / c.h).toFixed(4)} ≠ output`);
  }

  // Punch-ins.
  const presets = P?.punchIns?.presets ?? {};
  const pis = [...plan.punch_ins].sort((a, b) => a.out_start - b.out_start);
  pis.forEach((pi, i) => {
    const pr = presets[pi.preset];
    if (P && !pr) e(`${pi.id}: unknown preset ${pi.preset}`);
    if (pr && pr.kind !== pi.kind) e(`${pi.id}: kind ${pi.kind} ≠ preset ${pr.kind}`);
    if (pr && Math.abs(pr.scale - pi.scale) > 1e-6) e(`${pi.id}: scale ${pi.scale} ≠ preset ${pr.scale}`);
    if (P && pi.scale > P.punchIns.maxScale + EPS) e(`${pi.id}: scale ${pi.scale} > max ${P.punchIns.maxScale}`);
    if (pi.out_end <= pi.out_start || pi.out_end > duration + EPS) e(`${pi.id}: bad time range`);
    const len = pi.out_end - pi.out_start;
    if (P && len < P.punchIns.minHoldSec - EPS) e(`${pi.id}: ${len.toFixed(2)}s shorter than minHoldSec`);
    if (P && pi.kind === "ease" && len > P.punchIns.maxHoldSec + EPS) e(`${pi.id}: ${len.toFixed(2)}s longer than maxHoldSec`);
    if (pi.kind === "ease") {
      if (pi.ramp_sec <= 0) e(`${pi.id}: ease needs ramp_sec > 0`);
      if ((pi.release === "ease" ? 2 : 1) * pi.ramp_sec > len + EPS) e(`${pi.id}: ramps longer than the punch-in`);
      const s0 = segAt(pi.out_start);
      const crosses = joins.some((j) => j > pi.out_start + EPS && j < pi.out_end - EPS);
      if (crosses) e(`${pi.id}: crosses a cut join`);
      if (pi.release === "cut" && !(joins.some((j) => Math.abs(j - pi.out_end) < frame / 2) || Math.abs(pi.out_end - duration) < frame / 2)) e(`${pi.id}: release "cut" must end on a join`);
      if (!s0) e(`${pi.id}: starts outside the video`);
    } else {
      const s = segs.find((x) => Math.abs(x.out_start - pi.out_start) < 1e-4 && Math.abs(x.out_end - pi.out_end) < 1e-4);
      if (!s) e(`${pi.id}: a cut punch-in must cover exactly one segment`);
    }
    if (i > 0 && pi.out_start < pis[i - 1].out_end - EPS) e(`${pi.id}: overlaps ${pis[i - 1].id}`);
    if (P && i > 0 && pi.out_start - pis[i - 1].out_start < P.punchIns.minSpacingSec - EPS) e(`${pi.id}: only ${(pi.out_start - pis[i - 1].out_start).toFixed(1)}s after ${pis[i - 1].id} (min ${P.punchIns.minSpacingSec}s)`);
    if (P) {
      const inWindow = pis.filter((x) => x.out_start >= pi.out_start - EPS && x.out_start < pi.out_start + 30);
      if (inWindow.length > P.punchIns.maxPer30s) e(`${pi.id}: more than ${P.punchIns.maxPer30s} punch-ins within 30s`);
    }
  });

  // Captions.
  const safe = P ? safeRect(plan.format, P.safeZones) : { x: 0, y: 0, w: plan.format.width, h: plan.format.height };
  const cues = plan.captions.cues;
  const C = P?.captions;
  cues.forEach((c, i) => {
    if (c.end <= c.start) e(`cue ${i}: empty`);
    if (c.end > duration + 1e-3) e(`cue ${i}: ends past the video (${c.end} > ${duration.toFixed(3)})`);
    if (i > 0 && c.start < cues[i - 1].end - 1e-3) e(`cue ${i}: overlaps cue ${i - 1}`);
    if (!c.words.length) e(`cue ${i}: no words`);
    if (C && c.words.length > C.maxWords) e(`cue ${i}: ${c.words.length} words > ${C.maxWords}`);
    if (C && c.lines.length > C.maxLines) e(`cue ${i}: ${c.lines.length} lines > ${C.maxLines}`);
    const flat = c.lines.flat();
    if (flat.length !== c.words.length || flat.some((k, j) => k !== j)) e(`cue ${i}: lines must cover every word once, in order`);
    let groups = 0;
    c.words.forEach((w, k) => { if (w.emphasis && !(k > 0 && c.words[k - 1].emphasis)) groups++; });
    if (C && groups > C.maxEmphasisPerCue) e(`cue ${i}: ${groups} emphasis groups > ${C.maxEmphasisPerCue}`);
  });
  const cb = plan.captions.box;
  if (cues.length && !boxInside(cb, safe)) e(`captions.box outside the platform safe zone`);
  const L = plan.layout;
  if (cues.length && Number.isFinite(L.faceBottomMax) && cb.y < L.faceBottomMax - 1 && cb.y + cb.h > L.faceTopMin + 1) e(`captions.box (${cb.y.toFixed(0)}–${(cb.y + cb.h).toFixed(0)}) overlaps the face (${L.faceTopMin}–${L.faceBottomMax})`);

  // Graphics.
  const spokenIn = (a, b) => cues.flatMap((c) => c.words).filter((w) => w.end > a && w.start < b).map((w) => w.text);
  const gs = [...plan.graphics].sort((a, b) => a.out_start - b.out_start);
  gs.forEach((g, i) => {
    const def = COMPONENTS[g.component];
    if (!def) return e(`${g.id}: unknown component ${g.component}`);
    if (def.status !== "implemented") e(`${g.id}: component ${g.component} is not implemented yet`);
    if (P && !P.graphics.allowed.includes(g.component)) e(`${g.id}: ${g.component} not allowed by profile`);
    const bad = def.check?.(g.props);
    if (bad) e(`${g.id}: ${bad}`);
    const len = g.out_end - g.out_start;
    if (P && (len < P.graphics.minSec - EPS || len > P.graphics.maxSec + EPS)) e(`${g.id}: ${len.toFixed(2)}s outside ${P.graphics.minSec}–${P.graphics.maxSec}s`);
    if (g.out_end > duration + EPS) e(`${g.id}: ends past the video`);
    if (!boxInside(g.box, safe)) e(`${g.id}: box outside the platform safe zone`);
    if (Number.isFinite(L.faceTopMin) && boxesOverlap(g.box, { x: 0, y: L.faceTopMin, w: plan.format.width, h: L.faceBottomMax - L.faceTopMin })) e(`${g.id}: box overlaps the face band`);
    if (cues.some((c) => c.end > g.out_start && c.start < g.out_end) && boxesOverlap(g.box, cb)) e(`${g.id}: box overlaps the captions`);
    if (def.minHeight && g.box.h < def.minHeight - 1) e(`${g.id}: box ${g.box.h.toFixed(0)}px tall < component minimum ${def.minHeight}`);
    if (i > 0 && g.out_start < gs[i - 1].out_end - EPS) e(`${g.id}: overlaps ${gs[i - 1].id}`);
    if (def.textOf) {
      const d = calloutDerived(def.textOf(g.props), spokenIn(g.out_start - 2, g.out_end + 2), def.template);
      if (!d.ok) e(`${g.id}: callout not derived from speech (missing: ${[...d.missingWords, ...d.unsupportedFacts.map((f) => JSON.stringify(f))].join(", ")})`);
    }
  });

  // Lanes that must be empty or asset-backed.
  if (plan.overlays.length) e("overlays: not supported in Phase 1");
  const ids = new Set(assets.map((a) => a.id));
  for (const b of plan.broll) {
    if (P && !P.broll.enabled) e(`broll ${b.asset}: B-roll disabled by profile`);
    if (!ids.has(b.asset)) e(`broll ${b.asset}: not in member/assets.json`);
  }
  for (const s of plan.sfx) {
    if (P && P.sfx.policy === "off") e(`sfx ${s.asset}: SFX off in profile`);
    if (!ids.has(s.asset)) e(`sfx ${s.asset}: not in the approved assets manifest`);
  }
  if (P && plan.audio.music && P.music.policy === "off") e("audio.music set but profile music policy is off");

  // Hook.
  if (P) {
    if (plan.hook.out_start > 0.5) e("hook must start at the beginning");
    if (plan.hook.out_end > P.hook.windowSec[1] + 2.5) e(`hook ends at ${plan.hook.out_end.toFixed(1)}s — beyond the ${P.hook.windowSec[1]}s window`);
    for (const t of plan.hook.treatments) if (!P.hook.treatments.includes(t)) e(`hook treatment "${t}" not allowed by profile`);
  }
  return { ok: errors.length === 0, errors };
}

export function assertValidPlan(plan, ctx) {
  const r = validatePlan(plan, ctx);
  if (!r.ok) {
    const err = new Error(`edit plan failed validation (${r.errors.length}):\n  - ${r.errors.slice(0, 25).join("\n  - ")}`);
    err.code = "PLAN_INVALID";
    err.errors = r.errors;
    throw err;
  }
  return r;
}
