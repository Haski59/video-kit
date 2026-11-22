/**
 * engine/graphics/render.js — plan.graphics → transparent PNG sequences for ffmpeg overlay.
 *
 * HTML/CSS components (components/components.html) rendered in headless Chrome via the puppeteer
 * dependency the repo already has, using the system Chrome (same approach as scripts/lib/social-render.js).
 * No Remotion: its licence requires a paid Automators plan for a 4+ person team rendering from code,
 * and the component contract here (component, props, box, t) is all a future backend would need.
 *
 * Determinism: deviceScaleFactor 1, sRGB colour profile, brand font verified inside Chrome (fontconfig
 * says nothing about Chrome), every animated property a pure function of t, two animation frames
 * awaited after each seek. Only the graphic's own box is rendered, only for its own frames.
 *
 * graphicsBoxCheck() measures the ALPHA bounding box of what was actually rendered (not the planned
 * box) and verifies it against the safe zone, the face band and the captions.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { probeEnv } from "../env.js";
import { pathsFor, readJson } from "../storage/files.js";
import { boxInside, boxesOverlap, safeRect } from "../geometry/transform.js";

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "components", "components.html");

export async function renderGraphics({ plan, tempDir, root, log = () => {} }) {
  if (!plan.graphics.length) return [];
  const env = probeEnv();
  if (!env.chrome) throw new Error("graphics: no Chrome found — cannot render components");
  const brand = readJson(pathsFor(root).brand);
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath: env.chrome, headless: true,
    args: ["--force-color-profile=srgb", "--disable-gpu", "--font-render-hinting=none", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check"],
  });
  const out = [];
  try {
    const page = await browser.newPage();
    await page.goto(`file://${PAGE}`, { waitUntil: "load" });
    if (!(await page.evaluate((f) => window.__fontAvailable(f), brand.fontFamily))) {
      throw new Error(`graphics: brand font "${brand.fontFamily}" is not available to Chrome — refusing to render in a fallback face`);
    }
    for (const g of plan.graphics) {
      const w = Math.round(g.box.w), h = Math.round(g.box.h);
      await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
      await page.evaluate((spec) => window.__mount(spec), { component: g.component, props: g.props, box: { w, h }, brand });
      const dir = path.join(tempDir, g.id);
      fs.mkdirSync(dir, { recursive: true });
      const fps = plan.format.fps;
      const n = Math.round((g.out_end - g.out_start) * fps);
      const dur = n / fps;
      for (let i = 0; i < n; i++) {
        await page.evaluate((t, d) => window.__frame(t, d), i / fps, dur);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        await page.screenshot({ path: path.join(dir, `${String(i + 1).padStart(5, "0")}.png`), omitBackground: true, type: "png", clip: { x: 0, y: 0, width: w, height: h } });
      }
      out.push({ id: g.id, dir, frames: n, out_start: g.out_start, box: { x: Math.round(g.box.x), y: Math.round(g.box.y), w, h } });
      log(`graphic ${g.id} ${g.component}: ${n} frames ${w}x${h}`);
    }
  } finally {
    await browser.close();
  }
  return out;
}

/** Union alpha bounding box of a PNG sequence (local px), via ffmpeg alphaextract+bbox. */
export function measureAlphaBox(dir) {
  const { ffmpeg } = probeEnv();
  const r = spawnSync(ffmpeg, ["-hide_banner", "-nostats", "-i", path.join(dir, "%05d.png"), "-vf", "alphaextract,bbox=min_val=8", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const boxes = [...String(r.stderr).matchAll(/x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+)/g)].map((m) => m.slice(1, 5).map(Number));
  if (!boxes.length) return null;
  const x1 = Math.min(...boxes.map((b) => b[0])), x2 = Math.max(...boxes.map((b) => b[1]));
  const y1 = Math.min(...boxes.map((b) => b[2])), y2 = Math.max(...boxes.map((b) => b[3]));
  return { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 };
}

/** QC: measured graphic pixels inside the safe zone, off the face band, clear of visible captions. */
export function graphicsBoxCheck({ plan, profile, rendered }) {
  if (!plan.graphics.length) return { id: "graphics_bbox", status: "pass", detail: "no graphics" };
  const safe = safeRect(plan.format, profile.safeZones);
  const L = plan.layout;
  const issues = [], measured = [];
  for (const g of plan.graphics) {
    const r = rendered.find((x) => x.id === g.id);
    if (!r) { issues.push(`${g.id} was not rendered`); continue; }
    const local = measureAlphaBox(r.dir);
    if (!local) { issues.push(`${g.id} rendered fully transparent`); continue; }
    const box = { x: r.box.x + local.x, y: r.box.y + local.y, w: local.w, h: local.h };
    measured.push({ id: g.id, box });
    if (!boxInside(box, safe)) issues.push(`${g.id} pixels leave the safe zone (${JSON.stringify(box)})`);
    if (boxesOverlap(box, { x: 0, y: L.faceTopMin, w: plan.format.width, h: L.faceBottomMax - L.faceTopMin })) issues.push(`${g.id} pixels overlap the face band`);
    const capShowing = plan.captions.cues.some((c) => c.end > g.out_start && c.start < g.out_end);
    if (capShowing && boxesOverlap(box, plan.captions.box)) issues.push(`${g.id} pixels overlap the captions`);
  }
  return issues.length
    ? { id: "graphics_bbox", status: "fail", detail: issues.join("; "), repair: "drop_colliding_graphics", collisions: issues.map((t) => ({ what: t.split(" ")[0] })), measured }
    : { id: "graphics_bbox", status: "pass", detail: `${measured.length} graphic(s) measured inside the safe zone, off the face and captions`, measured };
}
