---
name: shorts
description: Make vertical shorts (YouTube Shorts, TikTok, Reels) — either find the best stand-alone 60–120 s clips inside a long recording and cut each one 9:16 with captions, or edit a vertical clip they recorded as a short. Use when the member says "make shorts / clips / reels from this", "cut this into shorts", "edit this short".
---

# /shorts — vertical clips that carry a whole point

A good short is a complete thought: hook → why → proof → payoff, usually 60–120 s. Never cut a 20-second fragment that stops before the point lands.

## Which mode
- **From a long recording** (landscape, several minutes): find clips.
  ```
  npm run -s kit -- clips "<path>" --count 3
  ```
  Options: `--min 45 --max 90` to change length. The transcript is cached, so re-running is quick.
  Claude picks the clips if available (else a rule-based picker); each clip becomes its own S### job, face-tracked into 9:16 with captions.
- **A vertical clip they recorded as a short**:
  ```
  npm run -s kit -- short "<path>"
  ```
- **A specific moment they name** ("the bit at 3:20 to 4:45"): `npm run -s kit -- short "<path>" --range 200-285`.

Long recordings take a while — run in the background if over ~8 minutes.

## Check before reporting
For each clip: read the report, open `output/<S###>/preview.v<N>.jpg`, and check the clip starts on a strong line and ends after the point lands (read the first and last captions in `renders/v<N>.srt`). If a clip opens mid-thought ("and so…"), say so and offer a `--range` re-cut a sentence earlier.

## Report
A short list: S### · status · length · first line (the hook) · path. Things to check by hand with times. Then offer captions for posting (`/publish-pack`) — one caption per platform they use.
