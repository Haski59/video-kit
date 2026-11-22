/**
 * engine/thumbnail/make.js — a YouTube thumbnail from the video itself.
 *
 *   1. sample frames across the video and let Apple Vision find the one with the biggest clear face
 *   2. lay out 1280×720: the frame fills the canvas, a dark gradient on the side away from the face,
 *      2–4 words of text in the member's font, one word in the accent colour
 *   3. QA on the rendered PNG, with the same Vision pass the editor uses:
 *        - the face is still detected (not covered, not cropped away)
 *        - the text is detected as text at phone size (320×180) — i.e. readable in the feed
 *        - text and face boxes do not overlap
 *      plus the "1-second rule": at most 4 words, so the topic reads at a glance
 *
 * Writes <outDir>/thumbnail.png, thumbnail-phone.png (what the feed shows) and thumbnail-qa.json.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { probeEnv } from "../env.js";
import { readJson, pathsFor, writeJsonAtomic } from "../storage/files.js";
import { detectFaces } from "../analysis/visual.js";
import { boxesOverlap } from "../geometry/transform.js";

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "thumbnail.html");
export const W = 1280, H = 720;
export const MAX_WORDS = 4;

/** Pick the frame with the largest confident face; ties → nearer the middle of the video. */
export function bestFrame(detections, durationSec) {
  let best = null;
  for (const d of detections) {
    const f = (d.faces ?? []).filter((x) => x.c >= 0.6).sort((a, b) => b.w * b.h - a.w * a.h)[0];
    if (!f) continue;
    // Faces touching the frame edge make bad thumbnails.
    if (f.x < 0.02 || f.x + f.w > 0.98 || f.y < 0.01) continue;
    const score = f.w * f.h - Math.abs(d.t - durationSec / 2) / (durationSec * 50);
    if (!best || score > best.score) best = { ...d, face: f, score };
  }
  return best;
}

/** Split headline words into lines of ≤ 2 words and pick the accent word (longest, or the number). */
export function layoutText(text) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const accent = words.findIndex((w) => /\d/.test(w)) >= 0 ? words.findIndex((w) => /\d/.test(w))
    : words.reduce((bi, w, i, a) => (w.length > a[bi].length ? i : bi), 0);
  const lines = [];
  for (let i = 0; i < words.length; i += 2) lines.push(words.slice(i, i + 2));
  return { words, lines, accent };
}

function ff(args) {
  const r = spawnSync(probeEnv().ffmpeg, ["-hide_banner", "-v", "error", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg: ${String(r.stderr).trim().slice(-300)}`);
}

function duration(video) {
  const r = spawnSync(probeEnv().ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video], { encoding: "utf8" });
  return Number(r.stdout.trim()) || 0;
}

export async function makeThumbnail({ video, text, outDir, root, samples = 16, log = () => {} }) {
  const env = probeEnv();
  if (!env.chrome) throw new Error("thumbnail: Google Chrome is needed to lay out the thumbnail");
  const { words } = layoutText(text);
  if (!words.length) throw new Error("thumbnail: give 2–4 words of text");
  fs.mkdirSync(outDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(outDir, ".thumb-"));
  try {
    const dur = duration(video);
    const frames = [];
    for (let i = 0; i < samples; i++) {
      const t = dur * (i + 0.5) / samples, file = path.join(work, `f${String(i).padStart(2, "0")}.jpg`);
      ff(["-y", "-ss", t.toFixed(2), "-i", video, "-frames:v", "1", "-q:v", "2", file]);
      if (fs.existsSync(file)) frames.push({ t, file });
    }
    const det = detectFaces(frames);
    const pick = det ? bestFrame(det.map((d, i) => ({ ...d, t: frames[i].t, file: frames[i].file })), dur) : null;
    const chosen = pick ?? { ...frames[Math.floor(frames.length / 2)], face: null };
    log(`thumbnail: frame at ${chosen.t.toFixed(1)}s${pick ? "" : " (no clear face found — middle frame used)"}`);

    const brand = readJson(pathsFor(root).brand);
    const { default: puppeteer } = await import("puppeteer-core");
    const browser = await puppeteer.launch({ executablePath: env.chrome, headless: true, args: ["--force-color-profile=srgb", "--hide-scrollbars", "--no-first-run"] });
    const out = path.join(outDir, "thumbnail.png");
    let textBox;
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
      await page.goto(pathToFileURL(PAGE).href, { waitUntil: "load" });
      textBox = await page.evaluate((spec) => window.__mount(spec), {
        image: pathToFileURL(chosen.file).href, face: chosen.face, layout: layoutText(text), brand,
      });
      await page.screenshot({ path: out, type: "png" });
    } finally {
      await browser.close();
    }
    const phone = path.join(outDir, "thumbnail-phone.png");
    ff(["-y", "-i", out, "-vf", "scale=320:180:flags=area", phone]);

    // QA on the rendered pixels.
    const checks = [];
    checks.push(words.length <= MAX_WORDS
      ? { id: "one_second_rule", status: "pass", detail: `${words.length} word(s)` }
      : { id: "one_second_rule", status: "fail", detail: `${words.length} words — keep it to ${MAX_WORDS} or fewer so it reads in one second` });
    const inside = textBox.x >= 16 && textBox.y >= 16 && textBox.x + textBox.w <= W - 16 && textBox.y + textBox.h <= H - 16;
    checks.push(inside ? { id: "text_inside_frame", status: "pass", detail: `text ${Math.round(textBox.w)}×${Math.round(textBox.h)} px at ${textBox.fontSize}px type` }
      : { id: "text_inside_frame", status: "fail", detail: `text runs off the frame (${Math.round(textBox.x)}–${Math.round(textBox.x + textBox.w)} px of ${W}) — use fewer or shorter words` });
    const qa = detectFaces([{ t: 0, file: out }, { t: 0, file: phone }]);
    if (!qa) checks.push({ id: "vision", status: "skipped", detail: "Apple Vision unavailable — face and text not verified" });
    else {
      const [full, small] = qa;
      const face = (full.faces ?? []).filter((f) => f.c >= 0.5).sort((a, b) => b.w * b.h - a.w * a.h)[0];
      if (chosen.face) checks.push(face ? { id: "face_visible", status: "pass", detail: `face ${(face.w * 100).toFixed(0)}% of width` } : { id: "face_visible", status: "fail", detail: "no face detected in the finished thumbnail" });
      const tb = { x: textBox.x / W, y: textBox.y / H, w: textBox.w / W, h: textBox.h / H };
      const readable = (small.text ?? []).some((t) => boxesOverlap(t, tb, 0));
      checks.push(readable ? { id: "text_readable_on_phone", status: "pass", detail: "text detected at 320×180" } : { id: "text_readable_on_phone", status: "warn", detail: "text not detected at phone size — look at thumbnail-phone.png" });
      if (face) checks.push(boxesOverlap(face, tb, 0) ? { id: "text_clear_of_face", status: "fail", detail: "text overlaps the face" } : { id: "text_clear_of_face", status: "pass", detail: "text and face do not overlap" });
    }
    const status = checks.some((c) => c.status === "fail") ? "NEEDS_REVIEW" : "COMPLETE";
    const report = { video, text, frame_t: chosen.t, status, checks, files: { thumbnail: out, phone } };
    writeJsonAtomic(path.join(outDir, "thumbnail-qa.json"), report);
    return report;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
