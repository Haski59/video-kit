/** KIT_CAPTION_V1 grouping, number binding, timing, emphasis, ASS output, numbers normaliser. */
import test from "node:test";
import assert from "node:assert/strict";
import { groupCaptions, wrapLines } from "../engine/captions/group.js";
import { buildAss, assTime, assColour, escapeAss, assInline } from "../engine/captions/ass.js";
import { extractFacts, factsSupported, formatFact, bindsToNext, isNumberish } from "../engine/planner/numbers.js";
import { wordsFrom } from "./fixtures/plan-fixture.mjs";

const STYLE = { minWords: 2, maxWords: 5, maxCharsPerLine: 22, maxLines: 2, breakOnGapSec: 0.35, maxCueSec: 2.6, minCueSec: 0.4, tailHoldSec: 0.15, maxEmphasisPerCue: 1 };
const BS = String.fromCharCode(92); // backslash, spelled out so no tool mistakes ASS escapes for a path

test("cues are 2–5 words and break at sentence ends", () => {
  const ws = wordsFrom([["If"], ["you"], ["want"], ["to"], ["make"], ["money"], ["online,"], ["start"], ["here."], ["Then"], ["sell."]]);
  const cues = groupCaptions(ws, { style: STYLE, durationSec: 10 });
  for (const c of cues) assert.ok(c.words.length <= 5, `≤5 words: ${c.words.map((w) => w.text).join(" ")}`);
  assert.ok(cues.some((c) => c.words.at(-1).text === "here."), "a cue ends at the sentence end");
  assert.ok(!cues.some((c) => c.words.some((w, i) => w.text === "here." && i < c.words.length - 1)), "no cue runs past a full stop");
});

test("never splits a number from its unit or currency", () => {
  const ws = wordsFrom([["I"], ["made"], ["ten"], ["grand"], ["a"], ["month"], ["with"], ["£10K"], ["clients"], ["at"], ["30"], ["percent"]]);
  const cues = groupCaptions(ws, { style: { ...STYLE, maxWords: 3 }, durationSec: 10 });
  const texts = cues.map((c) => c.words.map((w) => w.text).join(" "));
  assert.ok(texts.some((t) => t.includes("ten grand")), texts.join(" | "));
  assert.ok(texts.some((t) => t.includes("30 percent")), texts.join(" | "));
  assert.ok(bindsToNext("£", "10K") && bindsToNext("ten", "grand") && bindsToNext("30", "%") && !bindsToNext("sales", "money"));
});

test("a cue never spans a cut join", () => {
  const ws = wordsFrom([["one"], ["two"], ["three"], ["four"]]);
  const join = (ws[1].end + ws[2].start) / 2;
  const cues = groupCaptions(ws, { style: STYLE, joins: [join], durationSec: 5 });
  for (const c of cues) assert.ok(!(c.start < join && c.words.at(-1).end > join), "no cue crosses the join");
});

test("timing: each cue starts on its first word, ends after its last, never overlaps, clamped to the media", () => {
  const ws = wordsFrom([["a"], ["b"], ["c."], ["d"], ["e"], ["f."]]);
  const dur = ws.at(-1).end + 0.05;
  const cues = groupCaptions(ws, { style: STYLE, durationSec: dur });
  cues.forEach((c, i) => {
    assert.equal(c.start, c.words[0].start);
    assert.ok(c.end >= c.words.at(-1).end - 1e-9);
    if (i) assert.ok(c.start >= cues[i - 1].end - 1e-9);
  });
  assert.ok(cues.at(-1).end <= dur + 1e-9);
});

test("orphan single words borrow from a full neighbour instead of flashing alone", () => {
  const ws = wordsFrom([["you're"], ["always"], ["going"], ["to"], ["have"], ["a"], ["way"], ["to"], ["make"], ["more"], ["money."]]);
  const cues = groupCaptions(ws, { style: STYLE, durationSec: 10 });
  assert.ok(cues.every((c) => c.words.length >= 2), cues.map((c) => c.words.map((w) => w.text).join(" ")).join(" | "));
});

test("emphasis: numbers first, at most one group per cue", () => {
  const ws = wordsFrom([["you've"], ["got"], ["three"], ["skills."]]);
  const [c] = groupCaptions(ws, { style: STYLE, durationSec: 5 });
  assert.deepEqual(c.words.filter((w) => w.emphasis).map((w) => w.text), ["three"]);
});

test("wrapLines balances two lines and never breaks a bound pair", () => {
  const words = ["you've", "now", "got", "three", "skills."].map((text) => ({ text }));
  const lines = wrapLines(words, STYLE);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.flat(), [0, 1, 2, 3, 4]);
});

test("ASS: time format, colours, escaping, per-word emphasis and explicit position", () => {
  assert.equal(assTime(3725.456), "1:02:05.46");
  assert.equal(assTime(1.999), "0:00:02.00");
  assert.equal(assColour("#1DB954"), "&H0054B91D");
  assert.equal(assInline("#FFFFFF"), "&HFFFFFF&");
  assert.equal(escapeAss(`a {b} ${BS}c`), `a ${BS}{b${BS}} c`);
  const ass = buildAss({ cues: [{ start: 0, end: 1, words: [{ text: "three", emphasis: true }, { text: "skills", emphasis: false }], lines: [[0, 1]] }],
    style: { font: "Avenir Next Heavy", bold: false, fontSize: 62, primaryColour: "#FFFFFF", emphasisColour: "#1DB954", outlineColour: "#000000", outline: 5, shadow: 2, fadeInMs: 60 },
    width: 1080, height: 1920, position: { x: 540, y: 1250 } });
  assert.match(ass, /PlayResX: 1080/);
  assert.ok(ass.includes(`{${BS}an5${BS}pos(540,1250)${BS}fad(60,0)}{${BS}c&H54B91D&}three{${BS}c&HFFFFFF&} skills`), ass.split("\n").pop());
  assert.match(ass, /Style: Cap,Avenir Next Heavy,62,/);
});

test("numbers: spoken and written forms normalise to the same facts", () => {
  assert.equal(formatFact(extractFacts(["ten", "grand", "a", "month"])[0]), "10K/MO");
  assert.equal(formatFact(extractFacts(["£10,000/mo"])[0]), "£10K/MO");
  assert.equal(formatFact(extractFacts(["30%"])[0]), "30%");
  assert.equal(extractFacts(["first"])[0].ordinal, 1);
  assert.ok(isNumberish("£10K") && isNumberish("three") && !isNumberish("skills"));
});

test("callout facts must be supported by what was said", () => {
  assert.ok(factsSupported(["£10K/MO"], ["ten", "grand", "a", "month"]).ok);
  assert.ok(factsSupported(["4", "CLIENTS"], ["four", "clients"]).ok);
  assert.ok(factsSupported(["STEP", "1"], ["First,", "you", "need"]).ok);
  assert.equal(factsSupported(["£20K"], ["ten", "grand"]).ok, false, "a different number is unsupported");
  assert.equal(factsSupported(["£10K/MO"], ["ten", "grand"]).ok, false, "a per-month claim that was never said is unsupported");
});
