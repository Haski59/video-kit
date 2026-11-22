# Client Capital Video Kit

Turn your talking-head recordings into finished YouTube videos, vertical shorts, thumbnails and post
copy. Drop a video in, press one button. Everything runs on your Mac; your footage never leaves it.

**What you get from one recording**
- A cleaned-up 16:9 YouTube edit: dead air, ums and retakes cut inside real pauses (no clipped words), light punch-ins, number callouts, captions, loudness set for YouTube.
- 2–5 vertical shorts (9:16) that each carry a whole point, face-tracked, with captions.
- A thumbnail made from your best frame, checked for phone readability.
- Titles, description with chapters, tags, pinned comment and a caption for every short — in your voice.
- Your videos edited **in the style of a video you admire**: give it a link, and it copies the pacing, caption look and structure (never the content).
- **Faceless videos** from an idea: script, local AI voice-over, motion graphics, captions.
- A QA report for every video. If something needs your eyes or ears, it tells you the exact second.

## Start here (one line, about 15 minutes the first time)

You need a Mac with an Apple chip (M1 or newer), about 10 GB free, and Claude Code signed in.

Paste this into **Claude Code** (or the Terminal app) and press Return:

```bash
curl -fsSL https://raw.githubusercontent.com/Haski59/video-kit/main/install.sh | bash
```

A Terminal window installs everything. It asks for your Mac password once, only if your Mac needs
Homebrew. When it's done, **Video Kit opens in your browser**: fill in **My profile**, drop a recording
and click **Make my videos**.

Your finished videos appear below the frame, with a player, **Show in Finder**, **Make thumbnail**,
**Write post copy** and **Ask for a change**. If something needs a look, the card tells you the exact time.

From then on, open **Video Kit** from your Applications folder, Launchpad or Spotlight. It updates itself
each time it opens. Keep its small window open while you work; closing it stops the kit. Your profile and
videos live in `~/Video Kit` (`member/`, `projects/`, `output/`), and updates never touch them.

### Also in the app
- **Styles:** paste a link to a video you like. The kit learns how it's edited and makes yours the same way, without copying its content. Tick **full breakdown** for a shot-by-shot report (powered by [rea-video](https://github.com/JuneYaooo/rea-video)): how each shot was filmed, lighting, camera, captions and music.
- **Make without filming:** type an idea. Claude writes the script, you edit it, and the kit makes a voiced, animated video.

### Prefer talking to Claude?
Open the `Video Kit` folder (in your home folder) in Claude Code and say what you want. The same features are available as
skills (`/setup`, `/longform`, `/shorts`, `/reference`, `/faceless`, `/thumbnail`, `/publish-pack`).

## Things you can say to Claude
| Say | What happens |
|---|---|
| "Plan a video about getting your first client" | Hook, talking points, CTA, titles, thumbnail text (`/plan-video`) |
| "Edit this" + a recording | Long-form edit with QA (`/longform`) |
| "Make 3 shorts from it" | Finds the best 60–120 s moments and cuts them vertical (`/shorts`) |
| "Make my videos like this: <link>" | Learns how that video is edited and applies it to yours (`/reference`) |
| "Make a faceless short about cheap clients" | Script → AI voice → motion graphics → captions, no filming (`/faceless`) |
| "Make a thumbnail that says STOP CHASING CLIENTS" | Thumbnail + phone preview (`/thumbnail`) |
| "Write the publish pack" | Titles, description, chapters, tags, captions per platform (`/publish-pack`) |
| "Something's broken" | Checks and fixes your setup (`/doctor`) |

## Step-by-step SOPs
Start with [SOP 00 – Install and onboarding](docs/sops/00-install-and-onboarding.md). The full list is in [docs/sops](docs/sops/README.md).

## Where your files go
- Your recordings: dropping one into the app copies it into `projects/<video-name>/`; **Choose from my Mac** uses it where it is. The kit never changes your original.
- Everything it makes: `output/` — `L001`, `L002`… for long-form, `S001`, `S002`… for shorts.

## Under the hood
A local engine (`engine/`) does the editing with ffmpeg, whisper.cpp (speech-to-text on your Mac),
Apple Vision (face tracking) and Chrome (graphics). Claude decides what to emphasise and writes the
copy, inside strict rules: words on screen must be words you said. Bundled Claude Code plugins:
HyperFrames, marketing-skills, humanizer, diagram-design — see [THIRD_PARTY.md](THIRD_PARTY.md).

Tests: `npm test` (unit, ~1 s) and `npm run test:integration` (real tools on generated clips, ~3 min).
