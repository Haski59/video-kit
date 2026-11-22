#!/usr/bin/env bash
# Video Kit installer — paste this one line into Terminal or Claude Code:
#
#   curl -fsSL https://raw.githubusercontent.com/Haski59/video-kit/main/install.sh | bash
#
# What it does (safe to run again at any time; it never deletes anything):
#   1. checks this Mac (Apple chip, macOS, free space)
#   2. installs Homebrew if it's missing (Homebrew's own installer asks for your Mac password once)
#   3. downloads Video Kit into ~/Video Kit (or updates it if it's already there)
#   4. installs the free video tools (./setup.sh, about 15 minutes the first time)
#   5. adds a "Video Kit" app to your Applications folder, then opens Video Kit in your browser
set -uo pipefail

REPO="${VIDEO_KIT_REPO:-https://github.com/Haski59/video-kit.git}"
RAW="https://raw.githubusercontent.com/Haski59/video-kit/main/install.sh"
KIT="${VIDEO_KIT_DIR:-$HOME/Video Kit}"
APP="${VIDEO_KIT_APP:-$HOME/Applications/Video Kit.app}"

say()  { printf "\n\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
stop() { printf "\n  \033[31m✗\033[0m %s\n\n" "$1"; exit 1; }

# Claude Code (and other tools) run commands without a real terminal, so nothing could ask for your
# password or show progress. In that case, hand over to a Terminal window and finish there.
if ! { : </dev/tty; } 2>/dev/null; then
  if [ "${VIDEO_KIT_NO_HANDOFF:-0}" = 1 ]; then
    echo "No terminal attached; continuing without one (VIDEO_KIT_NO_HANDOFF=1)."
  else
    # A .command file opened with `open` needs no "allow this app to control Terminal" permission.
    CACHE="$HOME/Library/Caches/video-kit"; mkdir -p "$CACHE"
    {
      echo '#!/bin/bash'
      for v in $(compgen -e | grep '^VIDEO_KIT_' | grep -v '^VIDEO_KIT_NO_HANDOFF$'); do printf 'export %s=%q\n' "$v" "${!v}"; done
      if [ -f "${BASH_SOURCE[0]:-}" ]; then
        printf 'exec /bin/bash %q\n' "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
      else
        # Download the whole installer first, then run it (never a half-downloaded script).
        printf 'curl -fsSL %q -o %q && exec /bin/bash %q\n' "$RAW" "$CACHE/install.sh" "$CACHE/install.sh"
        echo 'echo "Couldn'"'"'t download Video Kit. Check your internet, then paste the line again."'
      fi
    } >"$CACHE/install.command"
    chmod +x "$CACHE/install.command"
    open -a Terminal "$CACHE/install.command" || stop "Couldn't open Terminal. Open the Terminal app, paste the line there and press Return."
    echo "Video Kit is installing in a Terminal window that just opened."
    echo "Follow it there: it may ask for your Mac password once. Video Kit opens in your browser when it's done (about 15 minutes)."
    exit 0
  fi
  TTY=/dev/null
else
  TTY=/dev/tty
fi

say "Video Kit installer"

# 1. This Mac
[ "$(uname -s)" = Darwin ] || stop "Video Kit runs on a Mac only."
[ "$(uname -m)" = arm64 ] || stop "Video Kit needs a Mac with an Apple chip (M1 or newer). Apple menu → About This Mac shows which chip you have."
FREE_GB=$(df -g "$HOME" | awk 'NR==2 {print $4}')
[ "${FREE_GB:-0}" -ge "${VIDEO_KIT_MIN_GB:-10}" ] || stop "Only ${FREE_GB} GB free. Video Kit needs about 10 GB. Free up some space, then paste the line again."
ok "Mac with an Apple chip, ${FREE_GB} GB free"

# 2. Homebrew (also brings Apple's command line tools, including git)
[ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
if ! command -v brew >/dev/null 2>&1; then
  say "Installing Homebrew (free). Type your Mac password when asked; the letters don't show while you type."
  [ "$TTY" = /dev/tty ] || stop "Homebrew needs your Mac password. Paste the install line into the Terminal app instead."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/tty \
    || stop "Homebrew didn't finish installing. Paste the line again to retry."
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi
ok "Homebrew ready"
command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1 || brew install git >/dev/null || stop "Couldn't install git. Paste the line again to retry."

# Claude Code (writes your scripts and post copy). Anthropic's own installer; no password needed.
export PATH="$HOME/.local/bin:$PATH"
if ! command -v claude >/dev/null 2>&1; then
  say "Installing Claude Code (free to install; you sign in with your Claude account later)"
  CINST="$(mktemp)"
  if curl -fsSL "${VIDEO_KIT_CLAUDE_INSTALLER:-https://claude.ai/install.sh}" -o "$CINST" && /bin/bash "$CINST" </dev/null >/dev/null 2>&1 \
     && command -v claude >/dev/null 2>&1; then ok "Claude Code installed"
  else echo "  ! Claude Code didn't install just now. Video Kit still works; the writing buttons will show you how to add it."; fi
  rm -f "$CINST"
else ok "Claude Code ready"; fi

# 3. Download or update Video Kit
if [ -d "$KIT/.git" ]; then
  say "Updating Video Kit in $KIT"
  git -C "$KIT" pull --ff-only --quiet && ok "up to date" || echo "  ! couldn't update just now (no internet?). Using the version you have."
else
  if [ -e "$KIT" ]; then
    OLD="$KIT (old $(date +%Y%m%d-%H%M%S))"; mv "$KIT" "$OLD"
    echo "  ! a folder called \"$(basename "$KIT")\" was already there; it was renamed to \"$(basename "$OLD")\" (nothing deleted)."
    # Bring over a profile and videos from an older ZIP copy, so the member keeps their work.
    for d in member projects output; do [ -d "$OLD/$d" ] && mkdir -p "$KIT.tmp-keep" && cp -R "$OLD/$d" "$KIT.tmp-keep/"; done
  fi
  say "Downloading Video Kit into $KIT"
  git clone --depth 1 --quiet "$REPO" "$KIT" || stop "Couldn't download Video Kit. Check your internet, then paste the line again."
  if [ -d "$KIT.tmp-keep" ]; then cp -R "$KIT.tmp-keep/"* "$KIT/" && rm -rf "$KIT.tmp-keep"; ok "kept your profile and videos from the old folder"; fi
  ok "downloaded"
fi
cd "$KIT" || stop "Couldn't open $KIT."

# 4. The video tools
say "Installing the video tools (about 15 minutes the first time; later runs take seconds)"
./setup.sh <"$TTY"
command -v node >/dev/null 2>&1 && [ -d node_modules/puppeteer-core ] \
  || stop "Setup isn't finished. Paste the install line again; it carries on where it stopped."

# 5. The Video Kit app (built on this Mac, so macOS doesn't block it)
mkdir -p "$(dirname "$APP")"
BUILD="$(mktemp -d)"; NEWAPP="$BUILD/Video Kit.app"   # osacompile makes an app bundle only for a .app path
# `open -a Terminal` (not "tell Terminal") so macOS never asks to let the app control Terminal.
KIT_AS="${KIT//\\/\\\\}"; KIT_AS="${KIT_AS//\"/\\\"}"
osacompile -o "$NEWAPP" -e "do shell script \"open -a Terminal \" & quoted form of \"$KIT_AS/Video Kit.command\"" >/dev/null 2>&1 \
  && [ -d "$NEWAPP/Contents" ] || stop "Couldn't create the Video Kit app."
[ -f config/app-icon.icns ] && cp config/app-icon.icns "$NEWAPP/Contents/Resources/applet.icns" \
  && codesign --force --sign - "$NEWAPP" >/dev/null 2>&1   # re-seal after swapping the icon
rm -rf "$APP" && mv "$NEWAPP" "$APP" && touch "$APP"; rmdir "$BUILD" 2>/dev/null
ok "Video Kit app added to your Applications folder (also in Launchpad and Spotlight)"

say "Done. Opening Video Kit…"
echo "  Next time: open Video Kit from your Applications folder, Launchpad or Spotlight."
echo "  Keep this window open while you use it. Closing it stops Video Kit."
exec "./Video Kit.command" --no-clear
