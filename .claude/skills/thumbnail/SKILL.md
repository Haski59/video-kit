---
name: thumbnail
description: Make a 1280×720 YouTube thumbnail from the member's own footage — best face frame, 2–4 words in their brand colours, checked for readability at phone size and that text stays off the face. Use when the member says "thumbnail", "make me a thumbnail", "cover image".
---

# /thumbnail — readable in one second

## 1. Words
The thumbnail must say what the video is about in one glance: **2–4 words**, not a repeat of the title, no analogies the viewer has to decode, no claims the video doesn't make. If there's a `projects/<slug>/plan.md`, start from its thumbnail options; otherwise propose 3 options from the transcript and let them pick.

## 2. Make it
Use the job ID so frames come from the ORIGINAL recording (the edited video has captions burned in):
```
npm run -s kit -- thumbnail L001 --text "STOP CHASING CLIENTS"
```
Writes `output/<ID>/thumbnail/thumbnail.png`, `thumbnail-phone.png` (what the feed shows) and `thumbnail-qa.json`.

## 3. Look before reporting
Open both PNGs with the Read tool. Check: face clear and expressive, text fully inside the frame, readable on the phone version, accent word makes sense. The QA checks: 1-second rule (≤ 4 words), text inside frame, face visible, text clear of face, text detectable at phone size (a warning there means: look closely).

## 4. Report
Show the path, say what you checked, and offer 2 alternative word options to A/B test (make them with `--out output/<ID>/thumbnail-b`).

Real brand logos or other people's images: only if the member confirms they may use them.
