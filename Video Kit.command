#!/bin/bash
# Double-click this file to open Video Kit. Keep the window that opens; close it to stop the kit.
cd "$(dirname "$0")" || exit 1
[ "${1:-}" = "--no-clear" ] || clear
echo "Video Kit"
echo "---------"
[ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
export PATH="$HOME/.local/bin:$PATH"   # where Claude Code's installer puts `claude`

# Installed with the one-line installer (a git copy): fetch the latest version first. Best effort:
# offline or slow internet just means today's run uses the version already here.
if [ -d .git ] && command -v git >/dev/null 2>&1; then
  BEFORE=$(git rev-parse HEAD 2>/dev/null)
  if GIT_TERMINAL_PROMPT=0 perl -e 'alarm 20; exec @ARGV' git pull --ff-only --quiet >/dev/null 2>&1; then
    AFTER=$(git rev-parse HEAD 2>/dev/null)
    if [ -n "$BEFORE" ] && [ "$BEFORE" != "$AFTER" ]; then
      echo "Updated Video Kit to the latest version."
      if git diff --name-only "$BEFORE" "$AFTER" | grep -qxE 'setup\.sh|package\.json|package-lock\.json'; then
        echo "Installing what's new (usually under a minute)…"
        ./setup.sh >/dev/null 2>&1 || echo "Some new tools didn't install. Video Kit will tell you if anything is missing."
      fi
    fi
  fi
fi

# Homebrew installs the free video tools. Its official installer asks for your Mac password itself.
if ! command -v brew >/dev/null 2>&1 && [ ! -x /opt/homebrew/bin/brew ]; then
  echo "This Mac needs Homebrew (free) to install the video tools."
  read -r -p "Install Homebrew now? It will ask for your Mac password. (y/n) " yn
  if [ "$yn" = "y" ] || [ "$yn" = "Y" ]; then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  else
    echo "OK. Video Kit can't install its tools without it. Double-click Video Kit again when you're ready."
    read -r -p "Press Return to close this window."
    exit 1
  fi
fi
[ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"

# First run on this Mac: install what's missing (Node.js is needed to run the app at all).
if ! command -v node >/dev/null 2>&1 || [ ! -d node_modules/puppeteer-core ] || [ ! -x "$HOME/.cache/video-kit/voice-venv/bin/python" ]; then
  echo "Setting up this Mac. This takes about 15 minutes, once."
  echo
  ./setup.sh
  if ! command -v node >/dev/null 2>&1; then
    echo
    echo "Setup isn't finished. Follow the ✗ lines above, then double-click Video Kit again."
    read -r -p "Press Return to close this window."
    exit 1
  fi
fi

echo
echo "Opening Video Kit in your browser…"
exec node engine/app/server.js
