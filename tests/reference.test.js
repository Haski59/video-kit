// Reference-style analysis: the pure measurements and the measurements → profile translation.
import test from "node:test";
import assert from "node:assert/strict";
import { shotStats, pauseStats, captionStats, zoomStats, musicGuess, slugify } from "../engine/reference/analyse.js";
import { styleToProfile, styleBrief } from "../engine/reference/profile.js";
import { loadProfile } from "../engine/profiles/load.js";
import { REPO_ROOT, readJson } from "../engine/storage/files.js";
import path from "node:path";

const W = (text, start, dur = 0.25) => ({ text, start, end: start + dur });

test("shots: cut rate and shot lengths", () => {
  const s = shotStats([10, 20, 30, 59.99], 60);
  assert.equal(s.cuts, 3);
  assert.equal(s.cutsPerMin, 3);
  assert.equal(s.medianShotSec, 10);
});

test("speech: words per minute and pause lengths", () => {
  const words = Array.from({ length: 121 }, (_, i) => W(`w${i}`, i * 0.5));
  const s = pauseStats(words);
  assert.equal(s.wordsPerMin, Math.round((121 / (120 * 0.5 + 0.25)) * 60 * 100) / 100);
  assert.equal(s.medianPauseSec, 0.25);
});

test("captions: spoken lines are captions; logos (static, misread) and caption misreads are not overlays", () => {
  const words = [W("work", 1), W("hard", 1.3), W("at", 2), W("something", 2.2)];
  const samples = [];
  for (let t = 0; t < 20; t += 0.5) {
    const lines = [{ text: t % 2 ? "ACQUISITION.COM" : "AGQUISITION.GOM", x: 0.38 + (t % 3) * 0.02, y: 0.15, w: 0.2, h: 0.04, c: 1 }];
    if (t === 1) lines.push({ text: "work hard", x: 0.4, y: 0.58, w: 0.2, h: 0.035, c: 0.9 });
    if (t === 2) lines.push({ text: "at something", x: 0.4, y: 0.58, w: 0.2, h: 0.035, c: 0.9 });
    if (t === 3) lines.push({ text: "pof any kind", x: 0.4, y: 0.585, w: 0.2, h: 0.035, c: 0.9 }); // misread caption
    if (t === 8) lines.push({ text: "3 STEPS", x: 0.3, y: 0.3, w: 0.4, h: 0.06, c: 0.95 });      // a real overlay
    samples.push({ t, lines });
  }
  const c = captionStats(samples, words);
  assert.equal(c.wordsPerLine, 2);
  assert.equal(c.centreYFrac, 0.6);
  assert.equal(c.uppercaseShare, 0);
  assert.ok(Math.abs(c.fontFrac - 0.035 / 0.74) < 0.002);
  assert.equal(c.overlayTextPerMin, Math.round((1 / 19.5) * 60 * 100) / 100, "only '3 STEPS' counts");
});

test("zoom: a face jump across a cut counts; the same size does not; samples on the same side are never compared", () => {
  const f = (t, h) => ({ t, face: { x: 0.4, y: 0.2, w: h * 0.8, h } });
  const samples = [f(4.0, 0.2), f(4.5, 0.24), f(9.5, 0.24), f(10.5, 0.24)];
  const z = zoomStats(samples, [4.3, 10.0], 60);
  assert.equal(z.zoomCutsPerMin, 1);
  assert.equal(z.faceShare, 1);
});

test("music: quiet gaps → no bed; loud gaps → bed", () => {
  const env = new Array(1000).fill(-80);
  const words = [W("a", 1, 2), W("b", 4, 2), W("c", 7, 2)];
  for (const w of words) for (let k = w.start * 100; k < w.end * 100; k++) env[k] = -20;
  assert.equal(musicGuess(env, words).likely, false);
  const bed = env.map((v) => (v === -80 ? -35 : v));
  for (let k = 0; k < 100; k++) bed[k] = -80;
  assert.equal(musicGuess(bed, words).likely, true);
});

test("profile: measurements become a valid, clamped profile; brand stays the member's", () => {
  const style = {
    reference: { title: "Some Short", channel: "X", url: null, format: "vertical", durationSec: 40 },
    analysed_at: "2026-11-21T00:00:00Z",
    editing: { cutsPerMin: 3, zoomCutsPerMin: 40, faceShare: 1, brollShare: 0 },
    speech: { wordsPerMin: 200, medianPauseSec: 0.31, p90PauseSec: 0.6 },
    music: { likely: false }, loudnessLufs: -25,
    captions: { present: true, wordsPerLine: 2, centreYFrac: 0.6, fontFrac: 0.05, uppercaseShare: 0, colours: {} },
    onScreenText: { perMin: 1.5 }, structure: null,
  };
  const base = readJson(path.join(REPO_ROOT, "config/profiles/SHORT_TALKING_HEAD.json"));
  const p = styleToProfile(style, base, "REF_SOME_SHORT_SHORT");
  assert.equal(p.captions.maxWords, 2);
  assert.equal(p.captions.maxLines, 1);
  assert.equal(p.captions.fontSize, 96);
  assert.equal(p.captions.preferredCentreYFrac, 0.6);
  assert.equal(p.punchIns.maxPer30s, 6, "40/min is clamped to the engine's safe maximum");
  assert.equal(p.audio.targetLufs, -14, "a quiet reference is clamped to a platform-safe loudness");
  assert.equal(p.captions.primaryColour, base.captions.primaryColour, "colours are not copied from the reference");
  const longBase = readJson(path.join(REPO_ROOT, "config/profiles/LONG_TALKING_HEAD.json"));
  const pl = styleToProfile(style, longBase, "REF_SOME_SHORT_LONG", { sameAspect: false });
  assert.equal(pl.captions.fontSize, longBase.captions.fontSize, "vertical caption size is not forced onto 16:9");
  assert.equal(pl.captions.maxWords, 2);
  assert.match(styleBrief(style, "REF_SOME_SHORT"), /Copy the \*way\* it is made/);
});

test("profile: a generated profile passes the loader's structural checks", async () => {
  const fs = await import("node:fs"); const os = await import("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kit-ref-"));
  fs.cpSync(path.join(REPO_ROOT, "config"), path.join(root, "config"), { recursive: true });
  fs.mkdirSync(path.join(root, "member", "profiles"), { recursive: true });
  const base = readJson(path.join(REPO_ROOT, "config/profiles/SHORT_TALKING_HEAD.json"));
  const style = { reference: { title: "t", format: "vertical" }, analysed_at: "2026-11-21", editing: { zoomCutsPerMin: 0 }, speech: {}, music: {}, loudnessLufs: null,
    captions: { present: false }, onScreenText: { perMin: 0 } };
  fs.writeFileSync(path.join(root, "member/profiles/REF_T_SHORT.json"), JSON.stringify(styleToProfile(style, base, "REF_T_SHORT")));
  const { profile } = loadProfile("REF_T_SHORT", { root, type: "reel" });
  assert.equal(profile.captions.burn, false);
  assert.equal(profile.punchIns.maxPer30s, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("slug", () => assert.equal(slugify("Because I did it — that time!"), "BECAUSE_I_DID_IT_THAT_TIME"));

test("qa: script coverage counts the script's words heard in order", async () => {
  const { scriptCoverage } = await import("../engine/qa/check-video.js");
  assert.equal(scriptCoverage("Stop chasing clients. Start attracting them.", ["stop", "chasing", "clients", "start", "attracting", "them"]).coverage, 1);
  assert.equal(scriptCoverage("one two three four", ["one", "two"]).coverage, 0.5);
  assert.equal(scriptCoverage("one two three four", ["four", "three", "two", "one"]).coverage, 0.25, "order matters");
});
