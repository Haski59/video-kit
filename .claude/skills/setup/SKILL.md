---
name: setup
description: Onboard a new member to the video kit — a short interview that writes their brand, vocabulary and voice/offer profile so every edit, caption, thumbnail and description sounds like them. Use on first run, when member/voice-and-offer.md is missing, or when they say "set me up", "onboard me", "change my brand colours / offer / call to action".
---

# /setup — member onboarding (≈10 minutes, once)

Goal: four files that make every later output theirs. Nothing is published; it all stays on this Mac.

## 0. Check the machine first
Run `npm run -s kit -- check`. If it fails, stop and send them to SOP 00 (`./setup.sh`).

## 1. Interview — ask in this order, a few questions per message, plain language
1. Your name as viewers know you, and your channel / brand name.
2. Who you help, in one sentence (who they are + what they want).
3. What you sell and the ONE call to action every video should end with (e.g. "book a call", "join the free community", "download the guide") — and the link, if they have one.
4. Three words for how you talk on camera (e.g. "direct, funny, no fluff"). Any words or phrases you never want in your copy?
5. Names, brands, tools or jargon you say a lot that a transcriber might misspell (e.g. "GoHighLevel", "Calendly", your own name).
6. Your brand colours: one accent colour (hex like #FFD400, or describe it and propose a hex). Default if none: #FACC15.
7. Font: default is "Avenir Next Heavy" (on every Mac). If they want another, check it is installed: `fc-list : family | grep -i "<name>"`. Only accept an installed, upright (not italic) family.
8. Currency they talk in ($, £, €).
9. Proof they are allowed to mention (real results, client numbers, years of experience). Write down only what they state; never embellish.
10. Where they post: YouTube long-form, YouTube Shorts, TikTok, Instagram Reels, LinkedIn.

If they don't know an answer, use the default and say so. Don't invent facts about them.

## 2. Write the files (create `member/` if needed)
- `member/brand.json` — copy `config/brand.default.json` and set: `name`, `accent`, `captionFont`, `fontFamily` (the same family without the weight, e.g. "Avenir Next"), `cssFont`, `currency`. Keep every other key.
- `member/lexicon.json` — same shape as `config/lexicon.default.json`:
  - `prompt`: one sentence: "A talking-head video by <name> about <topic>, <topic>, <topic>."
  - `replacements`/`phrases`: their misspellable words (lowercase on the left, correct form on the right; phrases must have the same number of words on both sides).
  - `allowlist`: their names, brands and tools.
- `member/voice-and-offer.md` — headings: Creator, Audience, Offer, Call to action (exact wording + link), Tone, Never say, Proof I can mention, Platforms.
- `.agents/product-marketing.md` — the same facts in the format the marketing skills read (product, audience, positioning, voice, proof, CTA). Create `.agents/` if needed.

## 3. Prove it
- Run `npm run -s kit -- check` again.
- Read `member/voice-and-offer.md` back to them in 5 bullet points and ask "anything wrong?". Fix what they say.
- Tell them the next step: "Record your first video (SOP 02), then drag the file in here and say 'edit this'."
