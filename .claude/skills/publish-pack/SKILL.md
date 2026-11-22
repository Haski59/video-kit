---
name: publish-pack
description: Write everything needed to publish an edited video — 3 title options, the YouTube description with their call to action and chapters taken from the real edit, tags, a pinned comment, and a caption per short per platform. Use when the member says "title", "description", "tags", "chapters", "what do I write when I post this", "publish pack".
---

# /publish-pack — the words that go with the video

Read `member/voice-and-offer.md` (CTA, tone, never-say list, proof allowed). Work from what was actually said:
- The edit's captions file `output/<ID>/renders/v<N>.srt` (output timeline — use it for chapter times).
- `projects/<slug>/plan.md` if it exists.

## Write `output/<ID>/publish-pack.md`
1. **Titles** — 3 options, ≤ 60 characters, specific to what is said in the video. Mark a pick.
2. **Description** — line 1: the call to action with their link. Then 2–3 sentences on what the viewer gets. Then **chapters** (`00:00 Intro` first, at least 3, each ≥ 10 s apart, times read from the .srt at the real start of each section).
3. **Tags** — 8–15, mostly specific phrases people search.
4. **Pinned comment** — a question that invites replies + the CTA.
5. **For each short** made from it (`output/S###`): one caption per platform they use (TikTok/Reels: hook line + 3–5 hashtags; Shorts: title ≤ 60 chars; LinkedIn: 2–3 short paragraphs, no hashtags spam).

## Rules
- Only claims, numbers and results that are in the transcript or their profile. Nothing invented.
- Use the marketing-skills `copywriting` skill for titles/hooks if installed, then run the whole file through `humanizer`.
- Their never-say list is absolute.
- Do not post anything. Show the titles and description in the chat and give the file path.
