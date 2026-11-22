// A synthetic but complete job: words, a rough cut, face samples → a real plan via assemblePlan.
import { loadProfile } from "../../engine/profiles/load.js";
import { REPO_ROOT } from "../../engine/storage/files.js";
import { planRoughCut, rebaseWords, joinPoints } from "../../engine/rough-cut/cuts.js";
import { faceTrack, planReframes } from "../../engine/analysis/visual.js";
import { findCandidates } from "../../engine/planner/candidates.js";
import { selectHeuristic } from "../../engine/planner/heuristic.js";
import { assemblePlan } from "../../engine/planner/plan.js";

/** Words from "text" at a steady pace, with optional pauses: [["word", gapAfter], …] */
export function wordsFrom(spec, { start = 0.3, dur = 0.28, gap = 0.08 } = {}) {
  let t = start;
  return spec.map(([text, pause = 0]) => {
    const w = { text, start: Number(t.toFixed(3)), end: Number((t + dur).toFixed(3)), score: 0.9, prob: 0.9 };
    t += dur + gap + pause;
    return w;
  });
}

export const SCRIPT = [
  ["If"], ["you"], ["want"], ["to"], ["make"], ["money"], ["online,"], ["just"], ["start"], ["stacking"], ["skills.", 2.5],
  ["First,"], ["you"], ["need"], ["to"], ["get"], ["good"], ["at"], ["sales."], ["Then"], ["learn"], ["Meta"], ["ads."],
  ["Now"], ["you've"], ["got"], ["three"], ["skills."], ["That"], ["took"], ["me"], ["ten"], ["grand"], ["a"], ["month"], ["to"], ["learn."],
  ["You"], ["see,"], ["the"], ["more"], ["valuable"], ["you"], ["become,"], ["the"], ["easier"], ["it"], ["gets."],
];

export function buildFixture({ fps = 30, srcW = 3840, srcH = 2160, faceCx = 0.5 } = {}) {
  const { profile, ref } = loadProfile("SHORT_TALKING_HEAD", { root: REPO_ROOT });
  const words = wordsFrom(SCRIPT);
  const durationSec = words[words.length - 1].end + 0.6;
  const audible = words.map((w) => ({ start: w.start - 0.02, end: w.end + 0.02 }));
  const roughCut = planRoughCut({ words, durationSec, fps, audibleSpans: audible, pacing: profile.pacing, retakes: profile.retakes });
  const samples = Array.from({ length: Math.ceil(durationSec * 3) }, (_, i) => ({ t: i / 3, faces: [{ x: faceCx - 0.085, y: 0.22, w: 0.17, h: 0.3, c: 0.95 }], text: [] }));
  const { reframes } = planReframes({ segments: roughCut.segments, track: faceTrack(samples), srcW, srcH, format: { width: 1080, height: 1920 }, reframe: profile.reframe });
  const rebased = rebaseWords(words, roughCut.segments);
  const candidates = findCandidates(rebased, { joins: joinPoints(roughCut.segments), hookWindowSec: profile.hook.windowSec });
  const selection = selectHeuristic({ candidates, profile });
  const source = { sha256: "a".repeat(64), filename: "fixture.mov", durationSec, width: srcW, height: srcH, fps, outFps: fps, rotation: 0, audio: { audioIndex: 0 }, hdr: false, startOffsetSec: 0, channelFix: null };
  const plan = assemblePlan(selection, { id: "S001", version: 1, type: "reel", profile, profileRef: ref, source, roughCut, reframes, words: rebased, candidates, now: new Date("2026-10-02T00:00:00Z") });
  return { profile, ref, words, rebased, roughCut, reframes, candidates, selection, plan, durationSec, audible };
}
