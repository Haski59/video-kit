# Long-Form Editing SOP

**Made For**
Members with a finished landscape recording who want a publish-ready YouTube edit without opening an editing app.

**SOP Intention**
Turn the raw recording into a clean, well-paced 16:9 video that sounds natural, with captions and correct loudness, and check it the right way before it goes live.

**Process Summary**
Claude runs the kit's long-form edit. It:
1. transcribes on your Mac;
2. measures the real pauses in your audio and cuts dead air, filler words and safe retakes inside them;
3. adds a few gentle punch-ins and number callouts on what you actually said;
4. burns in captions and writes an .srt file;
5. sets YouTube loudness (−14 LUFS);
6. renders at 1920×1080;
7. runs about 30 automatic QA checks against your original recording.

Then you watch it once and check anything it flags.

## The Steps Broken Down

### Step 1: Start The Edit
In the app: on **Edit a recording**, drop the file on the frame, choose **Long video only** (or **Long video + shorts**) and click **Make my videos**. Or in Claude Code, drag the recording in and say:
> "Edit this."

A 10-minute recording takes about 6–8 minutes for the long video alone, and about 15–20 minutes with shorts, on an M-series Mac. The card (or Claude) tells you when it's done.

### Step 2: Read The Result
Claude reports:
- **Status:** PASS, or NEEDS REVIEW with exact times.
- **Length:** before → after, and what was removed.
- **Files:**
  - `output/L001/renders/v1.mp4` is the video;
  - `v1.srt` is the captions file for YouTube;
  - `preview.v1.jpg` is a contact sheet.

### Step 3: Handle Flags
Every flag comes with a time. The common ones:
- **"Listen at 2:03 — a cut may clip a word":** play 5 seconds around that time. If it sounds fine, ignore it. If a word is clipped, tell Claude "keep the original at 2:03" and it re-edits.
- **"Possible retake left in at 4:10":** the kit wasn't sure the two takes said the same thing. If you hear yourself repeat, say "remove the first take at 4:10".
- **"Captions placed above the head":** you were framed close, so there was no room under your chin. That's fine to publish.

### Step 4: Watch It Once, End To End
On your phone or at normal speed, check:
- the first 30 seconds are tight;
- no sentence is cut short;
- the captions spell your names right;
- the CTA is there.

### Step 5: Fix Spelling Once, Forever
If captions misspell a name, say "my captions spell GoHighLevel wrong". Claude adds it to your vocabulary and re-runs. Every future video gets it right.

### Practical Example
> **Claude:** ✅ L003 passed QA. 12:41 → 10:52 (1:49 of pauses, ums and two retakes removed). Video: output/L003/renders/v1.mp4. Upload v1.srt as YouTube captions. Nothing to check by hand. Want shorts, a thumbnail and the publish pack?

## Pre-Launch Checklist
- Status is PASS, or every flagged time has been listened to and resolved.
- You watched the full edit once.
- Names and brand words are spelled right in the captions.
- The CTA is present and correct.
- The `.srt` is uploaded to YouTube as subtitles (YouTube Studio → Subtitles → Upload file).
- The original recording is kept (the kit never deletes it; you decide what to archive).
