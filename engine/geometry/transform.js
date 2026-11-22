/**
 * engine/geometry/transform.js — the ONE place that knows how a source pixel becomes an
 * output pixel. Pure.
 *
 * The filtergraph builder, the planner's text/face collision maths and QC all call this, so they
 * can never disagree about where the speaker's face is. (A plan that thinks the face is at y=540 while the
 * renderer puts it at y=600 is exactly how text ends up over a face with every check green.)
 *
 * Chain per output frame:
 *   source (display px) → crop window (per segment, source px) → zoom about an anchor
 *   (cut punch-in per segment, or eased punch-in on the output timeline) → scale to output px.
 *
 * Zoom about anchor (ax, ay) in crop-normalised coords: u' = ax + (u − ax)·z. With z ≥ 1 every
 * output pixel samples inside the crop, so zooming can never reveal pixels outside the frame.
 */

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const evenPos = (n) => Math.max(0, Math.round(n / 2) * 2);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Crop window (source px) for a 9:16 (or any `aspect` = outW/outH) output.
 * Wider sources crop full height around faceCx; narrower sources crop full width around faceCy.
 */
export function cropWindow({ srcW, srcH, aspect, faceCx = 0.5, faceCy = 0.42, anchorYFrac = 0.42 }) {
  if (srcW / srcH > aspect + 1e-3) {
    const h = srcH - (srcH % 2);
    const w = Math.min(srcW, even(h * aspect));
    const x = Math.min(srcW - w, evenPos(clamp(faceCx * srcW - w / 2, 0, srcW - w)));
    return { x, y: 0, w, h };
  }
  const w = srcW - (srcW % 2);
  const h = Math.min(srcH, even(w / aspect));
  // Put the face at anchorYFrac of the window height rather than dead centre (headroom).
  const y = Math.min(srcH - h, evenPos(clamp(faceCy * srcH - h * anchorYFrac, 0, srcH - h)));
  return { x: 0, y, w, h };
}

/** Smoothstep 0→1 on [0,1]. Matches the expression emitted into ffmpeg. */
export const smoothstep = (p) => (p <= 0 ? 0 : p >= 1 ? 1 : 3 * p * p - 2 * p * p * p);

/** Zoom factor of one eased punch-in at output time t. 1 outside [out_start, out_end]. */
export function easeZoomAt(t, pi) {
  if (t < pi.out_start || t >= pi.out_end) return 1;
  const d = pi.scale - 1;
  const up = smoothstep((t - pi.out_start) / pi.ramp_sec);
  if (pi.release === "cut") return 1 + d * up;
  const down = smoothstep((pi.out_end - t) / pi.ramp_sec);
  return 1 + d * Math.min(up, down);
}

/**
 * Full transform state at output time t: which segment, its crop window, total zoom and anchor.
 * `plan` needs: rough_cut.segments, reframes[{segment, crop:{x,y,w,h}, anchor:{x,y}}], punch_ins[].
 */
export function stateAt(t, plan) {
  const segs = plan.rough_cut.segments;
  let seg = segs.find((s) => t >= s.out_start - 1e-9 && t < s.out_end - 1e-9) ?? segs[segs.length - 1];
  const rf = plan.reframes.find((r) => r.segment === seg.id);
  if (!rf) throw new Error(`stateAt: no reframe for ${seg.id}`);
  let z = 1, anchor = rf.anchor;
  for (const pi of plan.punch_ins) {
    if (t < pi.out_start || t >= pi.out_end) continue;
    if (pi.kind === "cut") z *= pi.scale;
    else z *= easeZoomAt(t, pi);
    anchor = pi.anchor ?? anchor;
  }
  return { segment: seg, crop: rf.crop, z, anchor };
}

/** Source px → output px at output time t. */
export function srcPointToOut(sx, sy, t, plan) {
  const { crop, z, anchor } = stateAt(t, plan);
  const { width: OW, height: OH } = plan.format;
  const u = (sx - crop.x) / crop.w, v = (sy - crop.y) / crop.h;
  return { x: (anchor.x + (u - anchor.x) * z) * OW, y: (anchor.y + (v - anchor.y) * z) * OH };
}

/** Source-normalised box {x,y,w,h} (0..1, top-left origin) → output px box at time t. */
export function srcBoxToOut(box, t, plan, srcW, srcH) {
  const a = srcPointToOut(box.x * srcW, box.y * srcH, t, plan);
  const b = srcPointToOut((box.x + box.w) * srcW, (box.y + box.h) * srcH, t, plan);
  return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
}

/** Sub-crop (crop-local px) that realises a static zoom z about anchor — used for cut punch-ins. */
export function zoomSubCrop({ cropW, cropH, z, anchor }) {
  const w = even(cropW / z), h = even(cropH / z);
  const x = evenPos(clamp(anchor.x * cropW * (1 - 1 / z), 0, cropW - w));
  const y = evenPos(clamp(anchor.y * cropH * (1 - 1 / z), 0, cropH - h));
  return { x, y, w, h };
}

export const boxesOverlap = (a, b, pad = 0) =>
  a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

export const boxInside = (inner, outer) =>
  inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 && inner.x + inner.w <= outer.x + outer.w + 0.5 && inner.y + inner.h <= outer.y + outer.h + 0.5;

/** The rectangle the platform UI leaves clear, in output px. */
export function safeRect(format, safeZones) {
  return {
    x: safeZones.leftPx, y: safeZones.topPx,
    w: format.width - safeZones.leftPx - safeZones.rightPx,
    h: format.height - safeZones.topPx - safeZones.bottomPx,
  };
}
