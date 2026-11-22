---
name: reference
description: Learn the editing style of a video the member likes (a YouTube/TikTok/Instagram link or a saved file) and make their videos the same way — cut rate, caption look, zooms, on-screen text, pacing, hook timing and structure — using their own footage, words and brand. Use when the member says "make it like this video", "copy this style", "edit it like <creator>", "here's a reference", or pastes a link to someone else's video.
---

# /reference — copy HOW a video is made, never WHAT is in it

The kit measures a reference and turns it into an editing style the member's videos follow. What carries over: pacing, pause length, caption size, position, case and words per line, punch-in rate, on-screen text rate, hook timing, loudness and the script's structure. What never carries over: the reference's footage, faces, voice, music, logos, script lines or claims. Brand colours and fonts stay the member's own.

## 1. Learn the style
```
npm run -s kit -- reference "<link or file>" --name <short-name>
```
- A link is downloaded once (720p max), analysed on this Mac, then deleted. Only measurements are kept.
- `--keep-file` keeps a private copy, needed only for `/faceless` side-by-side checks.
- If the link fails to download (private, login-only or region-locked), ask the member to save the video and give the file.
- Output: `output/references/<NAME>/STYLE.md` (the brief) and two editing profiles: one for long-form, one for shorts.
- **Full breakdown:** `npm run -s kit -- breakdown "<link or file>" --name <short-name> --review`. It adds rea-video's shot-by-shot report at `output/references/<NAME>/breakdown/report.html`, plus `VIDEO.md` for you to read (layered: read `VIDEO.md` first, open shot files only when needed). `--review` has Claude check each shot by eye. Always use it for platform downloads; without it, the per-shot verdict is pixel-only and unreliable.

## 2. Read the brief to them, briefly
Describe the REFERENCE only from what `STYLE.md` measured. Don't add things you didn't measure, and don't present the member's own colours as the reference's (the kit uses the member's colours on purpose). Use the brief's own wording for uncertain items. For example, "music, or a noisy room" stays exactly that. Open `STYLE.md` and tell them in 4–5 bullets what makes that video work. Examples: "2-word captions, lowercase, just above the middle", "a cut every 6 s", "talks fast, 200 words/min, tiny pauses", "hook lands in 3 s". Name anything the kit can't do automatically (listed at the bottom: B-roll share, music bed, multi-camera cutting) and how they could add it themselves.

## 3. Use it
- On their recording: `npm run -s kit -- long "<their video>" --style <NAME>`. For shorts: `short`, or `clips … --style <NAME>`.
- Planning a script in that structure: run `/plan-video` and use the brief's "How it is structured" section as the outline. Keep their topic, their stories, their proof.
- No footage, just an idea: `/faceless` with this style.

## 4. Check before reporting
Run the usual QA. Then compare by eye: open the new `preview.v<N>.jpg` and describe the match ("captions match: 2 words, lowercase; I kept them off your face, so they sit higher than in the reference").

## Rules
- Their own videos, or videos they have the right to learn from. Never reproduce another creator's content, branding or persona; the brief states this too.
- A one-off recreation of the reference itself is not this kit's default. HyperFrames' `reverse-any-video` (HyperFrames Pro, paid) does frame-by-frame rebuilds, but only for videos the member has the rights to. Mention it only if they ask for an exact copy.
