# Captions & Graphics SOP

**Made For**
Members who want to understand, adjust or switch off the captions and on-screen graphics the kit adds to their videos.

**SOP Intention**
Keep on-screen text helpful and trustworthy. Every caption and callout matches what you actually said, is readable on a phone, never covers your face, and stays in your brand colours and font.

**Process Summary**
Captions are generated from the transcript, 2–7 words at a time, with one emphasised word in your accent colour. Graphics are limited to a few clean components:
- **big statement:** your hook line;
- **number callout:** "$10K/MO", "3 STEPS";
- **label:** a short tag.

Each one is used only where you said those words, at most one or two per 30 seconds, and never over your face. The kit also writes an `.srt` so platforms can show their own captions.

## The Steps Broken Down

### Step 1: Know Where Your Style Lives
- **Colours and font:** `member/brand.json`. Say "change my accent colour to #00C2FF" and Claude updates it.
- **Spellings:** `member/lexicon.json`. Say "captions should spell it ClickFunnels".
- **Pacing, caption size and density:** the editing profiles in `config/profiles/`. Ask Claude before changing these.

### Step 2: Fix A Misspelling
Tell Claude the wrong and right spelling. It adds the word to your vocabulary and re-runs the job from the transcript stage, which is fast.

### Step 3: Turn Burned-In Captions Off (Long-Form)
Some creators prefer YouTube's own captions:
> "Make me a long-form style without burned-in captions."

Claude creates a profile with captions switched off. The `.srt` is still written.

### Step 4: Ask For Fewer Or More Graphics
> "Fewer graphics" or "no graphics on this one."

Claude re-plans with tighter limits. Graphics can only show words you said, so it won't invent "10X YOUR INCOME" if you never said it.

### Step 5: Custom Animated Pieces (Advanced)
For an intro card, a lower-third with your name or an animated diagram, ask Claude to make it with **HyperFrames** (bundled plugin): "make a 4-second animated intro card with my name and brand colours". For still explainer diagrams for long-form, use **diagram-design**: "make a diagram of my 3-step client process". These come out as separate files that you add in your editor or ask Claude to overlay.

### Practical Example
You said "ten grand a month". The callout shows **$10K/MO** and the caption highlights "ten grand". If you'd only said "a lot of money", no number callout appears.

## Pre-Launch Checklist
- Names and brand words are spelled right.
- Every callout is something you actually said.
- No text covers your face (QA checks this, but glance anyway).
- Your colours and font are used.
- Captions are readable at phone size.
