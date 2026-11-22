/**
 * engine/qc/repair.js — ONE automatic repair pass, for deterministic defects only.
 *
 * Rules (mandatory, tested):
 *   - A plan that already has `provenance.repair_of` is never repaired again → no retry loops.
 *   - If ANY failing check has no deterministic fix (round-trip mismatch, duplicate phrase, an
 *     unreviewed retake, a source change…) there is no repair render at all: the job goes straight
 *     to NEEDS_REVIEW with the reasons. Re-rendering cannot fix judgement.
 *   - The repaired plan is re-validated; if it fails validation it is NOT rendered.
 *
 * decideOutcome(checks) → { status: PASS|PASS_WITH_WARNINGS|REPAIRABLE|NEEDS_REVIEW, failures, warnings }
 * repairPlan(plan, checks, ctx) → { plan, applied[] }
 */
import { groupCaptions } from "../captions/group.js";
import { joinPoints } from "../rough-cut/cuts.js";

export const REPAIRS = ["trim_black_tail", "audio_stricter_limiter", "regroup_captions", "move_captions_down", "drop_colliding_graphics", "drop_unjustified_punch_ins"];

export function decideOutcome(checks, { alreadyRepaired = false } = {}) {
  const failures = checks.filter((c) => c.status === "fail");
  const skipped = checks.filter((c) => c.status === "skipped");
  const warnings = checks.filter((c) => c.status === "warn");
  // A skipped gate is not evidence of quality; it is reported as a warning, never a pass.
  const allWarnings = [...warnings, ...skipped.map((s) => ({ ...s, detail: `not verified: ${s.detail}` }))];
  if (!failures.length) return { status: allWarnings.length ? "PASS_WITH_WARNINGS" : "PASS", failures, warnings: allWarnings };
  const fixable = failures.every((f) => f.repair && REPAIRS.includes(f.repair));
  if (fixable && !alreadyRepaired) return { status: "REPAIRABLE", failures, warnings: allWarnings };
  return { status: "NEEDS_REVIEW", failures, warnings: allWarnings, reason: alreadyRepaired ? "defects remain after the one allowed repair" : "defects need human judgement" };
}

const clone = (o) => JSON.parse(JSON.stringify(o));

export function repairPlan(plan, checks, { profile, words, version }) {
  if (plan.provenance.repair_of) {
    const e = new Error(`${plan.id} v${plan.version} is already a repair of v${plan.provenance.repair_of} — refusing a second repair`);
    e.code = "REPAIR_LIMIT";
    throw e;
  }
  const p = clone(plan);
  const applied = [];
  const fps = p.format.fps;
  let rebuildCaptions = false;
  const capStyle = { ...profile.captions };

  for (const c of checks.filter((x) => x.status === "fail")) {
    switch (c.repair) {
      case "trim_black_tail": {
        const m = String(c.detail).match(/black from ([\d.]+)s/);
        const blackAt = m ? Number(m[1]) : null;
        const segs = p.rough_cut.segments;
        const last = segs[segs.length - 1];
        if (blackAt !== null && blackAt > last.out_start + 1 / fps) {
          const cutFrames = Math.ceil((last.out_end - blackAt) * fps - 1e-6);
          last.src_end = Number((last.src_end - cutFrames / fps).toFixed(6));
          last.out_end = Number((last.out_end - cutFrames / fps).toFixed(6));
          p.rough_cut.stats = { ...p.rough_cut.stats, outputFrames: (p.rough_cut.stats.outputFrames ?? 0) - cutFrames, outputSec: Number(last.out_end.toFixed(3)) };
          p.punch_ins = p.punch_ins.filter((x) => x.out_start < last.out_end - 0.5).map((x) => ({ ...x, out_end: Math.min(x.out_end, last.out_end) }));
          p.graphics = p.graphics.filter((g) => g.out_end <= last.out_end + 1e-6);
          rebuildCaptions = true;
          applied.push(`trimmed ${cutFrames} black frame(s) from the end`);
        }
        break;
      }
      case "audio_stricter_limiter":
        p.audio.limiter = Math.min(p.audio.limiter, 0.708);
        p.audio.true_peak_db = Math.min(p.audio.true_peak_db, -2);
        applied.push("stricter limiter (−3 dBFS) and −2 dBTP target");
        break;
      case "regroup_captions":
        capStyle.maxWords = Math.max(3, profile.captions.maxWords - 1);
        capStyle.maxCueSec = Math.max(1.6, profile.captions.maxCueSec - 0.6);
        rebuildCaptions = true;
        applied.push(`captions regrouped (≤${capStyle.maxWords} words, ≤${capStyle.maxCueSec}s)`);
        break;
      case "move_captions_down": {
        const safeBottom = p.format.height - profile.safeZones.bottomPx;
        const room = safeBottom - (p.captions.box.y + p.captions.box.h);
        const shift = Math.max(0, Math.min(room, 80));
        if (shift > 0) {
          p.captions.box.y += shift;
          p.captions.position.y += shift;
          applied.push(`captions moved down ${shift}px away from the face`);
        }
        break;
      }
      case "drop_colliding_graphics": {
        const hit = new Set((c.collisions ?? []).map((x) => x.what));
        const before = p.graphics.length;
        p.graphics = p.graphics.filter((g) => !hit.has(g.id));
        p.hook.treatments = p.hook.treatments.filter((t) => t !== "bold_text" || p.graphics.some((g) => g.out_start < p.hook.out_end));
        applied.push(`dropped ${before - p.graphics.length} graphic(s) that covered the face`);
        break;
      }
      case "drop_unjustified_punch_ins": {
        const drop = new Set(c.punchIns ?? []);
        p.punch_ins = p.punch_ins.filter((x) => !drop.has(x.id));
        applied.push(`dropped punch-in(s) ${[...drop].join(", ")}`);
        break;
      }
      default: break;
    }
  }
  if (rebuildCaptions) {
    const dur = p.rough_cut.segments[p.rough_cut.segments.length - 1].out_end;
    const emph = new Set(p.captions.cues.flatMap((cue) => cue.words).filter((w) => w.emphasis).map((w) => w.start.toFixed(3)));
    p.captions.cues = groupCaptions(words.filter((w) => w.start < dur - 1e-6), { style: capStyle, joins: joinPoints(p.rough_cut.segments), emphasis: emph, durationSec: dur });
  }
  p.version = version;
  p.provenance = { ...p.provenance, repair_of: plan.version, created_at: new Date().toISOString(), notes: [...p.provenance.notes, ...applied.map((a) => `repair: ${a}`)] };
  return { plan: p, applied };
}
