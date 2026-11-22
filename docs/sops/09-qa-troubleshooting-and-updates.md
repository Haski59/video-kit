# QA, Troubleshooting & Updates SOP

**Made For**
Members using the kit week to week who hit a flag, an error or a slow Mac, or want the latest version and optional add-ons.

**SOP Intention**
Know what every QA result means, fix the common problems in minutes, keep the kit up to date, and add optional tools safely.

**Process Summary**
Every edit gets a QA report:
- **PASS:** publish after one watch.
- **NEEDS REVIEW:** a person must look at or listen to the listed times.
- **FAILED:** nothing was produced, and the reason is given.

Most problems are setup problems, and `/doctor` finds them. Updates are one command, and your profile and outputs are never touched by an update.

## The Steps Broken Down

### Step 1: Read QA Results The Right Way
| You see | It means | Do this |
|---|---|---|
| `speech_edges` REVIEW/FAIL at a time | a cut may touch a word | listen there; ask Claude to keep the original if it clips |
| `unreviewed_retake` | the kit found a possible double take but wasn't sure | listen; say "remove the first take at <time>" if so |
| `face_vs_text` | text near your face | look at that time |
| `round_trip` | the audio didn't match the captions well | check the captions there for wrong words |
| "LLM planner unavailable" | Claude was busy or at its limit; the rule-based planner was used | nothing; the edit is valid |
| "word timing not force-aligned" | normal on a standard install; cuts still sit in measured pauses | nothing |

### Step 2: Something Fails? Run The Doctor
> "Something's broken."

Or run `/doctor`. Claude checks every tool and fixes what's missing (with your OK), then runs a test edit.

### Step 3: Common Fixes
- **"free space first":** clear disk space; renders need about 10 GB of headroom.
- **"font is not installed":** pick an installed font with `/setup`.
- **Very slow:** close other heavy apps, keep the Mac plugged in, and use `--small-model` for English-only content.
- **Wrong audio, or silence:** check the file plays with sound; some cameras record a second, silent track.

### Step 4: Update The Kit
Nothing to do. Every time you open **Video Kit** it fetches the latest version first and installs anything new. Without internet, it simply runs the version you have.

Updates never touch your `member/`, `projects/` or `output/` folders.

**Installed from an old ZIP?** Paste the install line from SOP 00 once. It moves your old folder aside (nothing is deleted), carries over your `member`, `projects` and `output` folders, and from then on updates are automatic.

### Step 5: Optional Add-Ons (Your Choice, Your Accounts)
- **Licensed music:** Epidemic Sound MCP (your own subscription).
- **Voice cloning and dubbing:** VoiceStudio. Its default voice model is non-commercial, so check the licence before using it on paid content.
- **AI B-roll and images:** OpenMontage (needs paid API keys).
- **Sound effects:** earshot.
- **Shorter Claude replies:** i-have-adhd.

Details and licences are in `THIRD_PARTY.md`. Ask Claude to set one up and it explains the cost and licence first.

### Practical Example
> **Claude:** ⚠️ L004 needs review: listen at 6:12 (a cut may clip the start of "pricing").
>
> **You:** listened, it clips.
>
> **Claude:** Re-edited with that pause kept (v2). QA PASS.

## Pre-Launch Checklist
- Every NEEDS REVIEW item listened to or looked at and resolved.
- `/doctor` is clean after any error.
- You open Video Kit from the Applications app (so it updates itself).
- Add-ons used only with your own licences and accounts.
