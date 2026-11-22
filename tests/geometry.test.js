/** Geometry, source probing and the filtergraph — the pieces that decide where pixels land. */
import test from "node:test";
import assert from "node:assert/strict";
import { cropWindow, easeZoomAt, srcPointToOut, zoomSubCrop, smoothstep } from "../engine/geometry/transform.js";
import { parseProbe, chooseOutputFps, assertOutputOutsideSource, sourceWarnings } from "../engine/ingest/source.js";
import { buildVideoGraph, buildAudioCutGraph, buildAudioFinal, easeExpressions, escapeFilterPath } from "../engine/renderer/graph.js";
import { planReframes, faceTrack } from "../engine/analysis/visual.js";
import { buildFixture } from "./fixtures/plan-fixture.mjs";

const fx = buildFixture();

test("crop window: 16:9 → full-height 9:16 around the face, clamped to the frame", () => {
  const c = cropWindow({ srcW: 3840, srcH: 2160, aspect: 9 / 16, faceCx: 0.5 });
  assert.equal(c.h, 2160);
  assert.ok(Math.abs(c.w / c.h - 9 / 16) < 0.002);
  assert.ok(Math.abs(c.x + c.w / 2 - 1920) <= 2);
  const edge = cropWindow({ srcW: 3840, srcH: 2160, aspect: 9 / 16, faceCx: 0.02 });
  assert.equal(edge.x, 0, "a face at the edge clamps the crop inside the frame");
  const tall = cropWindow({ srcW: 1080, srcH: 2400, aspect: 9 / 16, faceCy: 0.4 });
  assert.equal(tall.w, 1080);
  assert.ok(tall.y >= 0 && tall.y + tall.h <= 2400);
});

test("an already-vertical source is not reframed", () => {
  const r = planReframes({ segments: [{ id: "seg1", src_start: 0, src_end: 1 }], track: [], srcW: 1080, srcH: 1920, format: { width: 1080, height: 1920 }, reframe: fx.profile.reframe });
  assert.equal(r.reframes[0].mode, "none");
  assert.match(r.warnings.join(" "), /already vertical/);
});

test("crop only moves at cuts and only when the move is worth it", () => {
  const segments = [{ id: "seg1", src_start: 0, src_end: 2 }, { id: "seg2", src_start: 3, src_end: 5 }];
  const samples = [0, 1, 3.3, 4].map((t) => ({ t, faces: [{ x: (t < 2.5 ? 0.5 : 0.51) - 0.08, y: 0.2, w: 0.16, h: 0.3, c: 0.9 }] }));
  const { reframes } = planReframes({ segments, track: faceTrack(samples), srcW: 3840, srcH: 2160, format: { width: 1080, height: 1920 }, reframe: fx.profile.reframe });
  assert.equal(reframes[0].crop.x, reframes[1].crop.x, "a 1% drift does not jitter the crop");
});

test("zoom about the anchor keeps the anchor fixed and matches the sub-crop used for cut punch-ins", () => {
  const plan = { ...fx.plan, punch_ins: [{ kind: "cut", scale: 1.1, out_start: 0, out_end: 1e9, anchor: fx.plan.reframes[0].anchor }] };
  const rf = fx.plan.reframes[0];
  const ax = rf.crop.x + rf.anchor.x * rf.crop.w, ay = rf.crop.y + rf.anchor.y * rf.crop.h;
  const p = srcPointToOut(ax, ay, 0.5, plan);
  assert.ok(Math.abs(p.x - rf.anchor.x * 1080) < 1e-6 && Math.abs(p.y - rf.anchor.y * 1920) < 1e-6);
  const sub = zoomSubCrop({ cropW: rf.crop.w, cropH: rf.crop.h, z: 1.1, anchor: rf.anchor });
  // The sub-crop's left edge, mapped through the zoom, lands on output x≈0.
  const left = srcPointToOut(rf.crop.x + sub.x, ay, 0.5, plan);
  assert.ok(Math.abs(left.x) < 3, `left edge maps to ${left.x}`);
});

test("eased zoom: ramps up, holds, ramps down; 'cut' release holds to the end", () => {
  const pi = { out_start: 1, out_end: 3, scale: 1.08, ramp_sec: 0.5, release: "ease" };
  assert.equal(easeZoomAt(0.9, pi), 1);
  assert.ok(Math.abs(easeZoomAt(2, pi) - 1.08) < 1e-9);
  assert.ok(easeZoomAt(1.25, pi) > 1 && easeZoomAt(1.25, pi) < 1.08);
  assert.ok(Math.abs(easeZoomAt(2.99, { ...pi, release: "cut" }) - 1.08) < 1e-9);
  assert.equal(smoothstep(0.5), 0.5);
});

test("the ffmpeg zoom expression computes exactly what transform.js computes", () => {
  const pis = [{ kind: "ease", out_start: 1, out_end: 3, scale: 1.08, ramp_sec: 0.45, release: "ease", anchor: { x: 0.5, y: 0.4 } },
    { kind: "ease", out_start: 6, out_end: 8, scale: 1.06, ramp_sec: 0.5, release: "cut", anchor: { x: 0.45, y: 0.38 } }];
  const { Z } = easeExpressions(pis, 30);
  const js = Z.replace(/\bin\b/g, "IN").replace(/pow\(/g, "Math.pow(");
  const fn = new Function("IN", "clip", "gte", "lt", "min", `return ${js};`);
  for (let frame = 0; frame < 270; frame += 7) {
    const t = frame / 30;
    const want = pis.reduce((z, p) => z * easeZoomAt(t, p), 1);
    const got = fn(frame, (v, a, b) => Math.min(b, Math.max(a, v)), (a, b) => (a >= b ? 1 : 0), (a, b) => (a < b ? 1 : 0), Math.min);
    assert.ok(Math.abs(got - want) < 1e-9, `frame ${frame}: ffmpeg ${got} vs js ${want}`);
  }
});

test("filtergraph: normalise before split, frame-exact trims, crop, perspective only when easing, captions last", () => {
  const { filter } = buildVideoGraph(fx.plan, { assPath: "/tmp/cc shorts/cap's.ass", graphics: [{ inputIndex: 2, out_start: 1.5, box: { x: 120, y: 220 } }] });
  const first = filter.split(";\n")[0];
  assert.match(first, /^\[0:v\]fps=30,format=yuv420p/);
  assert.match(filter, /trim=start=\d+\.\d{6}:end=\d+\.\d{6},setpts=PTS-STARTPTS,crop=\d+:2160:\d+:0/);
  assert.equal(/perspective=/.test(filter), fx.plan.punch_ins.some((p) => p.kind === "ease"));
  assert.match(filter, /eval=frame/);
  assert.match(filter, /setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709\[vb0\]/, "untagged sources still ship bt709-tagged");
  assert.match(filter, /setpts=PTS-STARTPTS\+1\.500000\/TB,scale=out_color_matrix=bt709/);
  assert.match(filter, /overlay=x=120:y=220:eof_action=pass/);
  assert.ok(filter.trim().endsWith("[vout]") && filter.includes(`ass=filename='${escapeFilterPath("/tmp/cc shorts/cap's.ass")}'`));
  const hdr = buildVideoGraph({ ...fx.plan, source: { ...fx.plan.source, hdr: true } }).filter;
  assert.match(hdr, /tonemap=tonemap=hable/);
});

test("audio graph: explicit track, mono fix, 48k, edge fades; final chain measured + limiter without auto-level", () => {
  const g = buildAudioCutGraph({ ...fx.plan, audio: { ...fx.plan.audio, channel_fix: "left" } });
  assert.match(g, /^\[0:a:0\]pan=stereo\|c0=c0\|c1=c0,aformat=channel_layouts=stereo,aresample=48000/);
  assert.match(g, /afade=t=in:d=0\.006000/);
  assert.match(g, /aresample=48000:async=1:first_pts=0,apad/, "audio that starts late or stops early is aligned/padded to the picture");
  const f = buildAudioFinal(fx.plan, { input_i: "-20", input_tp: "-3", input_lra: "5", input_thresh: "-30", target_offset: "0.2" });
  assert.match(f, /measured_I=-20.*linear=true/);
  assert.match(f, /alimiter=level=0:limit=0\.794/);
});

test("probe: rotation, HLG, VFR, multiple audio tracks and start offsets are understood", () => {
  const info = parseProbe({
    format: { duration: "12.5" },
    streams: [
      { index: 0, codec_type: "video", codec_name: "hevc", width: 3840, height: 2160, pix_fmt: "yuv420p10le", r_frame_rate: "30/1", avg_frame_rate: "2997/100", color_transfer: "arib-std-b67", side_data_list: [{ rotation: -90 }], start_time: "0.000" },
      { index: 1, codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2, disposition: { default: 0 }, start_time: "0.050" },
      { index: 2, codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 4, disposition: { default: 1 }, start_time: "0.050" },
    ],
  });
  assert.deepEqual([info.width, info.height, info.rotation], [2160, 3840, 270]);
  assert.equal(info.hdr, true);
  assert.equal(info.vfr, false, "29.97 avg vs 30 r is within 1%");
  assert.equal(info.bitDepth, 10);
  assert.equal(info.audio.audioIndex, 1, "the default-disposition track is used");
  assert.equal(info.startOffsetSec, 0.05);
  assert.ok(sourceWarnings(info).some((w) => /HDR/.test(w)) && sourceWarnings(info).some((w) => /2 audio tracks/.test(w)));
  const vfr = parseProbe({ format: { duration: "5" }, streams: [{ codec_type: "video", width: 1920, height: 1080, r_frame_rate: "60/1", avg_frame_rate: "4500/151" }, { index: 1, codec_type: "audio", channels: 1 }] });
  assert.equal(vfr.vfr, true);
  assert.throws(() => parseProbe({ format: { duration: "5" }, streams: [{ codec_type: "video", width: 10, height: 10 }] }), (e) => e.code === "SOURCE_REJECTED");
});

test("output fps snaps to an allowed rate; nothing is ever written inside the source folder", () => {
  assert.equal(chooseOutputFps(29.97), 30);
  assert.equal(chooseOutputFps(59.94), 60);
  assert.equal(chooseOutputFps(12), 30);
  assert.throws(() => assertOutputOutsideSource("/footage/day1/out/v1.mp4", "/footage/day1/raw.mov"), (e) => e.code === "OUTPUT_IN_SOURCE_DIR");
  assert.doesNotThrow(() => assertOutputOutsideSource("/repo/output/S001/renders/v1.mp4", "/footage/day1/raw.mov"));
});
