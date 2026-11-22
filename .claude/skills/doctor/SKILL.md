---
name: doctor
description: Diagnose and fix the video kit when something doesn't work — checks every tool, the speech model, Chrome, disk space and the Claude Code plugins, then runs a 10-second test edit. Use when the member says "it's broken", "it doesn't work", "check my setup", "error", or a kit command fails.
---

# /doctor — find what's wrong, fix it, prove it

1. Run `./setup.sh --check` and read every ✗ line.
2. Explain each ✗ in one plain sentence and fix it:
   - Missing Homebrew, Chrome or Claude Code → they must install these themselves (links are in the ✗ line); wait, then re-check.
   - Missing formulas, Node, speech model, engine packages or plugins → ask "OK to install?" then run `./setup.sh` (it only installs what is missing).
   - Low disk → tell them how much is free and that renders need ~10 GB; never delete their files.
3. When `--check` is clean, run `./setup.sh --doctor` (a 10-second generated test edit). It must say "test edit rendered and passed QA".
4. If a specific job failed, run `npm run -s kit -- status <ID>` and read `output/<ID>/logs/` (newest file) and `output/<ID>/metadata.json` (`failed_stage`, `error`). Common fixes:
   - "font … is not installed" → set an installed family in `member/brand.json` (`fc-list : family`).
   - "free space first" → clear space.
   - "LLM planner unavailable" → not an error: Claude was busy or over its limit, and the rule-based planner was used. The edit is still valid.
   - "no usable words" → the recording has no clear speech (wrong audio track, or silent). Check the file plays with sound.
5. Report what was wrong, what you changed, and the proof (the passing check).
