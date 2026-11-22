/**
 * engine/captions/srt.js — caption cues → SubRip (.srt) for uploading to YouTube/TikTok/LinkedIn.
 * Uses the same cues as the burned captions, so the file always matches the edit. Pure.
 */
const ts = (t) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};

export function buildSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.words.map((w) => w.text).join(" ")}\n`).join("\n");
}
