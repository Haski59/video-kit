# Third-party tools

The kit does **not** copy any third-party code into this repo. `setup.sh` installs each tool from its
official source; each keeps its own licence. Checked on 2026-11-21 against each project's GitHub
README and LICENSE.

## Installed by setup.sh

| Tool | What the kit uses it for | Licence | Installed from |
|---|---|---|---|
| FFmpeg (ffmpeg-full) | cutting, captions (libass), loudness, rendering | LGPL/GPL (Homebrew build) | `brew install ffmpeg-full` |
| whisper.cpp + large-v3-turbo model | speech-to-text on the Mac | MIT (code), MIT (OpenAI Whisper weights) | `brew install whisper-cpp`; model from huggingface.co/ggerganov/whisper.cpp |
| Node.js 22 | runs the engine | MIT | `brew install node@22` |
| puppeteer-core 24.40.0 | drives the member's own Chrome to draw graphics and thumbnails | Apache-2.0 | npm (pinned in package.json) |
| yt-dlp | downloads a reference video once for style analysis (deleted afterwards) | Unlicense | `brew install yt-dlp` |
| Kokoro-82M (via HyperFrames `tts`) | local AI voice-over for faceless videos | Apache-2.0 | downloaded by HyperFrames on first use |
| Apple Vision / Xcode CLT | face and text detection for framing and QA | Apple SDK | already on the Mac / `xcode-select --install` |
| **HyperFrames** (heygen-com/hyperframes) | builds faceless videos (motion graphics, captions, layout from a reference's style grammar) and custom animated pieces | Apache-2.0 | Claude Code plugin `hyperframes@hyperframes` (project scope) |
| **marketing-skills** (coreyhaines31/marketingskills) | hooks, titles, descriptions, CTAs; reads `.agents/product-marketing.md` written by `/setup` | MIT | plugin `marketing-skills@marketingskills` |
| **humanizer** (blader/humanizer) | removes AI-sounding patterns from all copy | MIT | plugin `humanizer@humanizer` |
| **rea-video** (JuneYaooo/rea-video) | full shot-by-shot breakdown of a reference: filmed / AI / code per shot, framing, camera, lighting, captions (SRT/ASS), voice/music/effects, remake plan; VIDEO.md for Claude. Pinned commit 86486c6 | Apache-2.0 (its sound-effects model BandIt v2 weights are CC BY-SA 4.0, downloaded on first use) | own Python environment `~/.cache/video-kit/rea-venv` + Claude Code plugin `rea-video@rea-video` |
| **diagram-design** (cathrynlavery/diagram-design) | clean explainer diagrams for long-form B-roll stills | MIT | plugin `diagram-design@diagram-design` |

Plugins track their marketplace's latest release; they are installed into this folder only
(`--scope project`), so a member's other Claude Code projects are untouched.

## Optional add-ons (documented in SOP 09, not installed by default)

| Tool | Why optional | Licence / cost |
|---|---|---|
| video-use (browser-use/video-use) | alternative agent editor; needs a paid ElevenLabs key for transcription — the kit already transcribes locally for free | MIT + ElevenLabs subscription |
| VoiceStudio (debpalash/voicestudio) | voice cloning / dubbing GUI | AGPL-3.0 app; **its default voice model is non-commercial (CC-BY-NC)** — check the model licence before using it on monetised content |
| Epidemic Sound MCP | licensed music & SFX inside Claude | paid subscription per member (Creator covers 1 channel per platform; Pro for more) |
| OpenMontage (OpenMontageInc/OpenMontage) | AI-generated B-roll and images | AGPL-3.0; image/video generation needs paid API keys |
| earshot (Leonxlnx/earshot) | code-generated sound effects | MIT; Python install |
| i-have-adhd (ayghri/i-have-adhd) | makes Claude's replies shorter and step-by-step | MIT; changes Claude's reply style, so it's the member's choice |
| OBS MCP (royshil/obs-mcp) | control OBS recording from Claude | GPL-2.0; last updated Aug 2025 |
| HyperFrames Pro (`style-sampling`, `reverse-any-video`) | series templates and frame-by-frame rebuilds of a video the member has rights to | paid HyperFrames plan; presenter re-shoots use HeyGen credits |

## Reviewed and left out

| Tool | Reason |
|---|---|
| Autom8AI/Open-Higgsfield-AI | the repository does not exist (404); the closest substitute has no licence |
| resemble-ai/chatterbox | the README says it is kept only as an archive, with no support or updates |
| lemomo-ai/lemo-opuscar | its style prompts are CC-BY-NC-4.0 (non-commercial), which doesn't fit a paid programme |
