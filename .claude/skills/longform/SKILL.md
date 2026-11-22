---
name: longform
description: Edit a long-form landscape (16:9) talking-head recording into a finished YouTube video — dead air and fillers cut in real pauses, retakes handled, light punch-ins and graphics, captions burned in plus an .srt, loudness set, then full QA against the original recording. Use when the member gives a recording and says "edit this", "edit my video", "here's my YouTube video".
---

# /longform — recording in, finished YouTube video out

## 1. Get the file
Ask them to drag the recording into this chat (that pastes its path) or give the path. Check it exists.
If it is vertical (taller than wide), use `/shorts` instead. Their file is never changed.

## 2. Run the edit
```
npm run -s kit -- long "<path>"
```
- Videos over ~8 minutes: run it in the background and tell them roughly how long (≈ 0.6 × the video length on an M-series Mac).
- It transcribes on this Mac, cuts dead air and fillers inside measured pauses, handles retakes, adds a few emphasis punch-ins and number callouts, burns captions, sets loudness to −14 LUFS, renders 1920×1080, then runs QA.

## 3. Check it yourself before you report
- Read the report printed at the end (status, duration before → after, what was removed).
- Open `output/<ID>/preview.v<N>.jpg` with the Read tool and look: is the face framed, are captions readable and off the face, do graphics make sense?
- If status is **NEEDS_REVIEW**, open `output/<ID>/qc.v<N>.json` and translate each failed check into one plain sentence with the time, e.g. "Listen at 2:03 — a cut may clip a word." or "At 4:10 a sentence may be said twice (a retake I didn't remove)."

## 4. Report (short)
- ✅/⚠️ status, final length, file path (`output/<ID>/renders/v<N>.mp4`), captions file (`.srt` — upload it to YouTube as subtitles).
- What to check by hand, with times (only if any).
- Offer next steps: "Want shorts cut from this (`/shorts`), a thumbnail (`/thumbnail`) and the title/description (`/publish-pack`)?"

## Fixing things
- Wrong word spelled in captions → add it to `member/lexicon.json` (replacements) and re-run with `--from analyse`.
- **"Keep the original at 2:03" / "remove the first take at 4:10"** — times are in the EDIT; the engine needs ORIGINAL-recording seconds:
  1. `npm run -s kit -- where L003 2:03` → prints the original time and the cuts/retakes nearby (start, end, kind).
  2. Keep a cut out of the edit: re-run with `--keep <start>-<end>` of that removal. Remove something: `--cut <start>-<end>` (for a retake, the span of the FIRST take).
  3. `npm run -s kit -- long "<path>" --from roughcut --keep 122.68-127.2` (several: comma-separated). Re-pass every earlier `--keep`/`--cut` too — each run starts from the original.
  4. Check the new version's QA and tell them what changed.
- Don't want burned captions → copy `config/profiles/LONG_TALKING_HEAD.json` to a new profile id, set `captions.burn` to false, and run with `--profile <ID>`.
