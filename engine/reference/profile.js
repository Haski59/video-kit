/**
 * engine/reference/profile.js — reference measurements → an editing profile + a written style brief.
 *
 * The profile is a normal profile (same schema as config/profiles/*) saved to member/profiles/, so
 * `kit long|short|clips --style <ID>` edits the member's footage with the reference's pacing,
 * caption layout, punch-in and on-screen-text rates. Every value is clamped to a range the engine
 * and its QA can deliver; anything the engine cannot reproduce (B-roll, music) is written into the
 * brief as a to-do instead of being silently ignored. Brand colours and fonts stay the member's own.
 * Pure.
 */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r2 = (n) => Number(n.toFixed(2));

export function styleToProfile(style, base, id, { sameAspect = true } = {}) {
  const p = JSON.parse(JSON.stringify(base));
  const s = style, out = p.output;
  p.id = id;
  p.version = "1.0.0";
  p.status = "active";
  p._doc = [`Generated from the reference "${s.reference.title}" on ${s.analysed_at.slice(0, 10)} by \`kit reference\`.`,
    "Pacing, caption layout and emphasis rates follow the reference; colours and fonts stay the member's (member/brand.json).",
    "Re-run `kit reference` to regenerate; edit by hand at your own risk (bump version)."];

  // Pacing: keep pauses about as long as the reference's, cut anything noticeably longer.
  const keep = clamp(s.speech.medianPauseSec || 0.25, 0.12, 0.5);
  p.pacing.keepGapSec = r2(keep);
  p.pacing.maxGapSec = r2(clamp(Math.max(keep + 0.2, s.speech.p90PauseSec || 0.6), keep + 0.15, 1.0));

  // Captions.
  const c = p.captions, sc = s.captions;
  c.burn = Boolean(sc.present);
  if (sc.present) {
    const wpl = clamp(Math.round(sc.wordsPerLine ?? c.maxWords), 1, 8);
    c.maxWords = wpl;
    c.minWords = Math.min(c.minWords, wpl);
    c.maxLines = wpl <= 3 ? 1 : 2;
    c.maxCharsPerLine = clamp(Math.round(wpl * 6.5), 8, 40);
    c.uppercase = (sc.uppercaseShare ?? 0) >= 0.6;
    // Size and position only transfer between the same shape of frame (vertical ↔ vertical).
    if (sameAspect) {
      const fontPx = (sc.fontFrac ?? 0.035) * out.height;
      c.fontSize = Math.round(clamp(fontPx, out.height > out.width ? 48 : 36, out.height > out.width ? 120 : 90));
      if (sc.centreYFrac) c.preferredCentreYFrac = r2(clamp(sc.centreYFrac, 0.15, 0.9));
    }
    c.maxCueSec = r2(clamp(wpl * 0.55, 0.6, 3.2));
    // Short punchy captions on a fast talker flash by faster than paragraph captions: allow the
    // reference's own pace (its speech rate × 1.6 headroom), never below the house limit or above 9/s.
    // 1–3-word captions are read at a glance, so a words-per-second limit does not apply to them.
    if (wpl <= 3) c.maxWordsPerSec = 9;
    else if (s.speech.wordsPerMin) c.maxWordsPerSec = r2(clamp((s.speech.wordsPerMin / 60) * 1.6, c.maxWordsPerSec, 9));
    c.minCueSec = r2(Math.min(c.minCueSec, 0.3));
  }

  // Punch-ins: about the reference's rate, within the engine's safe limits.
  const zpm = s.editing.zoomCutsPerMin ?? 0;
  const per30 = clamp(Math.round(zpm / 2), 0, 6);
  p.punchIns.maxPer30s = per30;
  p.punchIns.minSpacingSec = r2(per30 ? clamp(30 / per30 * 0.7, 2, 20) : 30);

  // On-screen text (graphics): reference's non-caption text rate.
  const tpm = s.onScreenText.perMin ?? 0;
  const g30 = clamp(Math.round(tpm / 2), 0, 4);
  p.graphics.maxPer30s = g30;
  p.graphics.minSpacingSec = r2(g30 ? clamp(30 / g30 * 0.7, 3, 20) : 30);

  // Hook: the reference's first sentence length bounds the hook window.
  const hookEnd = s.structure?.hook?.seconds;
  if (Number.isFinite(hookEnd) && hookEnd > 0) p.hook.windowSec = [r2(clamp(hookEnd * 0.6, 2, 8)), r2(clamp(hookEnd, 3, 12))];

  // Loudness: match the reference within the platforms' sensible range.
  if (Number.isFinite(s.loudnessLufs)) p.audio.targetLufs = r2(clamp(s.loudnessLufs, -14, -9));

  p.reference = { title: s.reference.title, channel: s.reference.channel, url: s.reference.url, analysed_at: s.analysed_at };
  return p;
}

const fmt = (n, unit = "") => (n === null || n === undefined ? "—" : `${n}${unit}`);

export function styleBrief(style, profileId) {
  const s = style, st = s.structure;
  const L = [
    `# Style brief: ${s.reference.title}`,
    "",
    `Reference: ${s.reference.channel ? `${s.reference.channel} · ` : ""}${s.reference.format}, ${Math.round(s.reference.durationSec / 60 * 10) / 10} min${s.reference.url ? ` · ${s.reference.url}` : ""}`,
    `Style name: \`${profileId}\` — use it with \`npm run kit -- long|short|clips <your video> --style ${profileId}\`.`,
    "",
    "Only measurements are stored. Copy the *way* it is made, never its footage, music, logos, script or claims.",
    "",
    "## How it is edited",
    `- **Cuts:** ${fmt(s.editing.cutsPerMin)} per minute; median shot ${fmt(s.editing.medianShotSec, " s")} (10–90 %: ${fmt(s.editing.p10ShotSec)}–${fmt(s.editing.p90ShotSec, " s")}).`,
    `- **Punch-in zooms at cuts:** ${fmt(s.editing.zoomCutsPerMin)} per minute.`,
    `- **Face on screen:** ${Math.round((s.editing.faceShare ?? 0) * 100)} % of the time; B-roll / screens / graphics: ${Math.round((s.editing.brollShare ?? 0) * 100)} %.`,
    `- **Speech pace:** ${fmt(s.speech.wordsPerMin)} words/min; pauses median ${fmt(s.speech.medianPauseSec, " s")}, long pauses ${fmt(s.speech.longPausesPerMin)}/min; first word at ${fmt(s.speech.firstWordSec, " s")}.`,
    `- **Captions:** ${s.captions.present ? `yes — ${fmt(s.captions.wordsPerLine)} word(s) per line, ${s.captions.uppercaseShare >= 0.6 ? "UPPERCASE" : "sentence case"}, centred at ${Math.round((s.captions.centreYFrac ?? 0) * 100)} % of the height, font ≈ ${((s.captions.fontFrac ?? 0) * 100).toFixed(1)} % of the frame height; colours fill ${s.captions.colours?.fill ?? "—"}, highlight ${s.captions.colours?.highlight ?? "none"}` : "none burned in"}.`,
    `- **Other on-screen text:** ${fmt(s.onScreenText.perMin)} appearances per minute.`,
    `- **Music bed:** ${s.music.likely ? `likely — the gaps between sentences sit at ≈ ${s.music.bedDb} dB (music, or a noisy room)` : "no / not detectable"}. **Loudness:** ${fmt(s.loudnessLufs, " LUFS")}.`,
    "",
  ];
  if (st) {
    L.push("## How it is structured", `- **Hook (${fmt(st.hook?.seconds, " s")}):** ${st.hook?.type ?? ""} — ${st.hook?.how ?? ""}`);
    for (const x of st.sections ?? []) L.push(`- **${x.role}** (~${x.approx_seconds} s): ${x.how}`);
    L.push(`- **CTA:** ${st.cta?.placement ?? ""} — ${st.cta?.how ?? ""}`, `- **Tone:** ${st.tone ?? ""}. **Pacing:** ${st.pacing ?? ""}`);
    if (st.techniques?.length) L.push(`- **Techniques:** ${st.techniques.join("; ")}`);
    if (st.recipe) L.push("", `**Recipe:** ${st.recipe}`);
    L.push("");
  }
  L.push("## What the kit does with this",
    "- Your edit follows: pause length, caption layout/case/size/words-per-line, punch-in rate, on-screen text rate, hook window and loudness.",
    "- Stays yours: colours and fonts (member/brand.json), your words, your claims, your call to action.",
    "- Not automatic (do it yourself or ask Claude):");
  if ((s.editing.brollShare ?? 0) > 0.15) L.push(`  - **B-roll ${Math.round(s.editing.brollShare * 100)} % of the time** — film or collect your own B-roll; the kit never reuses the reference's.`);
  if (s.music.likely) L.push("  - **Music bed** — add your own licensed track (e.g. Epidemic Sound, SOP 09).");
  if ((s.editing.cutsPerMin ?? 0) > 20) L.push(`  - **Very fast cutting (${s.editing.cutsPerMin}/min)** — partly from multiple camera angles or B-roll; tighter pauses get you part of the way.`);
  L.push("", "_Planning a video in this style: ask Claude \"plan a video about … in the style of " + profileId + "\" — it uses the structure above with your own content._");
  return `${L.join("\n")}\n`;
}
