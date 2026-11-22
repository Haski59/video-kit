---
name: faceless
description: Make a complete video with no filming — script, local AI voice-over, motion graphics and captions — in the member's brand and, if they have one, in a learned reference style. Uses the bundled HyperFrames plugin (free, renders on this Mac). Use when the member says "make a video without me on camera", "faceless video", "turn this idea/script into a video", "I don't want to record".
---

# /faceless — idea in, finished video out, nobody on camera

Read `member/voice-and-offer.md` and `member/brand.json` first. If a reference style is named, read `output/references/<NAME>/STYLE.md`. If they give a link instead, run `/reference` with `--keep-file` first.

## 1. Agree the brief (one message)
- Topic, and the one question it answers.
- Format: vertical short (9:16, 45–90 s) or landscape (16:9, 2–6 min). Default: vertical.
- Reference style (optional).
- Voice: Kokoro voice id. Default `am_michael`; `bm_george` for a British male; `af_heart` / `bf_emma` for female. Speed comes from the reference's words/min (≈ 160 wpm = 1.0×; clamp 0.9–1.25).

## 2. Script → `projects/<slug>/script.txt`
- Spoken prose (not bullets), in their voice.
- Structure: the reference's "How it is structured" if given; otherwise hook (≤ 20 words, first 3 s) → why → proof → payoff → their CTA.
- Only claims, numbers and stories from their profile or what they told you. Run the `humanizer` skill over it.
- Show the script and wait for "OK". Changing the script after rendering costs the whole render.

## 3. Voice-over (local, free)
```
npm run -s kit -- voice projects/<slug>/script.txt --out projects/<slug>/voice.wav --voice <voice> --speed <speed>
```
It uses the kit's own voice environment (made by `./setup.sh`). If it says the environment is missing, run `./setup.sh`. Don't install Python packages yourself.

## 4. Build the video with HyperFrames
Use the `hyperframes` skill (bundled plugin) to make a composition in `projects/<slug>/film/`:
- **Audio:** `voice.wav`; the film's length is the voice's length.
- **Captions:** from the voice's transcript (`npx hyperframes transcribe voice.wav`), styled from the reference brief (words per line, case, position, size) in the member's font and accent colour.
- **Look:** follow `../hyperframes/references/look.md` → "From a reference": take the reference's grammar (shot length = its median shot, its cut rate, how text enters, palette roles, type scale) and never its content. Palette and fonts from `member/brand.json`. If `reference.mp4` was kept, use `snapshot --against` to compare grammar, not to copy frames.
- **Visuals:** typography, shapes, diagrams (`diagram-design` for still explainers), icons. No stock people pretending to be the member, no other creators' footage or logos.
- **Safe margin:** every element (text, boxes, bars, pills) stays at least 64 px inside the frame. A bar that "fills" grows to the margin, not the edge. Run `npx hyperframes check` in `film/` and fix what it reports before rendering.
- Render 1080×1920 (vertical) or 1920×1080 at 30 fps to `projects/<slug>/film/render.mp4` with the HyperFrames CLI. Keep the render in the foreground with a 10-minute timeout; for longer, run it in the background and wait.
- Set platform loudness (picture untouched):
  ```
  npm run -s kit -- finish projects/<slug>/film/render.mp4 --out projects/<slug>/<slug>.mp4
  ```

## 5. QA, then report
```
npm run -s kit -- qa projects/<slug>/<slug>.mp4 --script projects/<slug>/script.txt
```
Must be COMPLETE: format, decode, sync, loudness, no black ends, no text at the frame edges, and ≥ 90 % of the script heard in order. Look at 4–5 frames yourself (ffmpeg grabs) for text overflow, unreadable contrast and awkward empty screens. Report: path, length, what you checked, and anything to look at.

Then offer `/thumbnail` (pass the video path) and `/publish-pack`.

## Notes
- Everything above is free and local. HyperFrames Pro (paid) adds `style-sampling` (5 fixed series templates) and `reverse-any-video` (frame-by-frame rebuilds, presenter re-shoots via HeyGen credits). Mention these only if the member asks for those exact things; never start a paid step without their explicit OK.
- Voice cloning of the member's own voice is optional (VoiceStudio, see THIRD_PARTY.md; its default model is non-commercial). Never clone anyone else's voice.
