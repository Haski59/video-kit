#!/usr/bin/env bash
# Client Capital Video Kit — one-command setup for macOS (Apple Silicon).
#
#   ./setup.sh             install everything that is missing (safe to run again at any time)
#   ./setup.sh --check     only report what is installed and what is missing; changes nothing
#   ./setup.sh --doctor    --check, then a 10-second test edit to prove the whole chain works
#   ./setup.sh --small-model   use the small English-only speech model (150 MB instead of 1.6 GB)
#   ./setup.sh --no-plugins    skip installing the Claude Code plugins
#
# It never deletes anything, never needs your password (except Homebrew's own installer, which you
# run yourself), and installs the Claude Code plugins into THIS folder only (project scope), so your
# other Claude Code projects are not changed.
set -uo pipefail
cd "$(dirname "$0")"
KIT="$(pwd)"

MODE=install; SMALL=0; PLUGINS=1
for a in "$@"; do
  case "$a" in
    --check) MODE=check ;;
    --doctor) MODE=doctor ;;
    --small-model) SMALL=1 ;;
    --no-plugins) PLUGINS=0 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $a (try --help)"; exit 2 ;;
  esac
done

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
miss() { printf "  \033[31m✗\033[0m %s\n" "$1"; MISSING=$((MISSING+1)); }
note() { printf "  \033[33m!\033[0m %s\n" "$1"; }
step() { printf "\n\033[1m%s\033[0m\n" "$1"; }
MISSING=0

MODEL_DIR="$HOME/.cache/whisper-models"
if [ "$SMALL" = 1 ]; then MODEL=ggml-base.en.bin; MODEL_MB=140; else MODEL=ggml-large-v3-turbo.bin; MODEL_MB=1500; fi
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL"
# Pinned plugin sources (see THIRD_PARTY.md for licences and what each is for).
PLUGIN_SOURCES=(
  "heygen-com/hyperframes|hyperframes@hyperframes"
  "coreyhaines31/marketingskills|marketing-skills@marketingskills"
  "blader/humanizer|humanizer@humanizer"
  "cathrynlavery/diagram-design|diagram-design@diagram-design"
  "JuneYaooo/rea-video|rea-video@rea-video"
)

step "1. This Mac"
if [ "$(uname -s)" != "Darwin" ]; then echo "  This kit supports macOS only (v1)."; exit 1; fi
if [ "$(uname -m)" = "arm64" ]; then ok "Apple Silicon Mac ($(sw_vers -productVersion))"; else note "Intel Mac — works, but transcription and renders are slower"; fi
FREE_GB=$(df -g "$KIT" | awk 'NR==2 {print $4}')
if [ "${FREE_GB:-0}" -ge 10 ]; then ok "${FREE_GB} GB free disk"; else miss "only ${FREE_GB} GB free — the kit needs about 10 GB (renders, speech model)"; fi

step "2. Homebrew (installs the video tools)"
if command -v brew >/dev/null 2>&1; then ok "Homebrew $(brew --version | head -1 | awk '{print $2}')"
else
  miss "Homebrew is not installed"
  echo '     Install it yourself (it asks for your Mac password), then run ./setup.sh again:'
  echo '     /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  [ "$MODE" = install ] && exit 1
fi

brew_has() { brew list --formula "$1" >/dev/null 2>&1; }
need_formula() { # name, why
  if brew_has "$1"; then ok "$1 — $2"
  elif [ "$MODE" = install ]; then echo "  … installing $1"; brew install "$1" >/dev/null && ok "$1 installed — $2" || miss "$1 failed to install (run: brew install $1)"
  else miss "$1 — $2 (run ./setup.sh to install)"; fi
}

step "3. Video and speech tools"
if command -v brew >/dev/null 2>&1; then
  need_formula ffmpeg-full "cutting, captions and rendering (the full build: the plain one cannot draw captions)"
  need_formula whisper-cpp "speech-to-text, runs on this Mac (nothing is uploaded)"
  need_formula fontconfig "checks caption fonts before rendering"
  need_formula yt-dlp "downloads a reference video once for style analysis"
  NODE_MAJOR=$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/')
  if [ "${NODE_MAJOR:-0}" -ge 22 ]; then ok "Node.js $(node -v)"
  elif [ "$MODE" = install ]; then echo "  … installing Node.js 22"; brew install node@22 >/dev/null && brew link --overwrite --force node@22 >/dev/null && ok "Node.js $(node -v)" || miss "Node.js 22 failed to install (run: brew install node@22)"
  else miss "Node.js 22 or newer (you have ${NODE_MAJOR:-none})"; fi
fi
if xcrun --find swiftc >/dev/null 2>&1; then ok "Apple Vision (face tracking) via Xcode command-line tools"
else note "Xcode command-line tools missing — face tracking off (centre crop). Install: xcode-select --install"; fi
if [ -d "/Applications/Google Chrome.app" ]; then ok "Google Chrome (draws graphics and thumbnails)"
else miss "Google Chrome — needed for graphics and thumbnails. Install it from https://www.google.com/chrome/ then run ./setup.sh again"; fi

step "4. Speech model"
if [ -f "$MODEL_DIR/ggml-large-v3-turbo.bin" ] || { [ "$SMALL" = 1 ] && [ -f "$MODEL_DIR/ggml-base.en.bin" ]; }; then
  ok "speech model in $MODEL_DIR"
elif [ "$MODE" = install ]; then
  echo "  … downloading $MODEL (~${MODEL_MB} MB, one time)"
  mkdir -p "$MODEL_DIR"
  if curl -fL --progress-bar -o "$MODEL_DIR/$MODEL.part" "$MODEL_URL" && [ "$(stat -f%z "$MODEL_DIR/$MODEL.part")" -gt $((MODEL_MB * 600000)) ]; then
    mv "$MODEL_DIR/$MODEL.part" "$MODEL_DIR/$MODEL"; ok "speech model downloaded"
  else rm -f "$MODEL_DIR/$MODEL.part"; miss "speech model download failed — check your internet and run ./setup.sh again"; fi
else miss "speech model (run ./setup.sh to download, or ./setup.sh --small-model for the 150 MB one)"; fi

step "4b. Local AI voice (faceless videos)"
VENV="$HOME/.cache/video-kit/voice-venv"
if [ -x "$VENV/bin/python" ] && "$VENV/bin/python" -c "import kokoro_onnx, soundfile" >/dev/null 2>&1; then ok "voice environment ready"
elif [ "$MODE" = install ] && command -v brew >/dev/null 2>&1; then
  PY=""
  for v in 3.12 3.13 3.14 3.11 3.10; do [ -x "$(brew --prefix)/opt/python@$v/bin/python$v" ] && PY="$(brew --prefix)/opt/python@$v/bin/python$v" && break; done
  if [ -z "$PY" ]; then echo "  … installing Python 3.12"; brew install python@3.12 >/dev/null && PY="$(brew --prefix)/opt/python@3.12/bin/python3.12"; fi
  echo "  … creating the voice environment (~220 MB, one time)"
  rm -rf "$VENV"; "$PY" -m venv "$VENV" && "$VENV/bin/pip" install -q --disable-pip-version-check "kokoro-onnx==0.4.7" "soundfile==0.14.0" >/dev/null 2>&1
  "$VENV/bin/python" -c "import kokoro_onnx, soundfile" >/dev/null 2>&1 && ok "voice environment ready" || miss "voice environment failed — run ./setup.sh again"
else note "voice environment not set up (only needed for faceless videos; ./setup.sh creates it)"; fi

step "4c. Shot-by-shot breakdowns (rea-video)"
REA="$HOME/.cache/video-kit/rea-venv"
REA_PIN="86486c6e104b917fb4b6a2d6501134686c05b219"   # JuneYaooo/rea-video main, tested 2026-11-21
if [ -x "$REA/bin/rea-video" ] && "$REA/bin/rea-video" --help >/dev/null 2>&1; then ok "rea-video ready"
elif [ "$MODE" = install ] && command -v brew >/dev/null 2>&1; then
  PY=""
  for v in 3.12 3.13 3.14 3.11 3.10; do [ -x "$(brew --prefix)/opt/python@$v/bin/python$v" ] && PY="$(brew --prefix)/opt/python@$v/bin/python$v" && break; done
  if [ -z "$PY" ]; then brew install python@3.12 >/dev/null && PY="$(brew --prefix)/opt/python@3.12/bin/python3.12"; fi
  echo "  … installing rea-video (~330 MB, one time)"
  rm -rf "$REA"; "$PY" -m venv "$REA" && "$REA/bin/pip" install -q --disable-pip-version-check "rea-video[ocr] @ git+https://github.com/JuneYaooo/rea-video@$REA_PIN" >/dev/null 2>&1
  # On Python <= 3.12 the OCR extra pulls in GUI opencv over the headless one (rea-video's own install script does this swap).
  if "$REA/bin/python" -c "import sys; sys.exit(0 if sys.version_info < (3, 13) else 1)"; then
    "$REA/bin/pip" uninstall -q -y opencv-python >/dev/null 2>&1; "$REA/bin/pip" install -q --force-reinstall --no-deps "opencv-python-headless>=4.8,<5" >/dev/null 2>&1
  fi
  "$REA/bin/rea-video" --help >/dev/null 2>&1 && ok "rea-video ready" || miss "rea-video failed to install — run ./setup.sh again"
else note "rea-video not set up (only needed for full breakdowns; ./setup.sh installs it)"; fi

step "5. Claude Code"
if command -v claude >/dev/null 2>&1; then ok "Claude Code $(claude --version 2>/dev/null | awk '{print $1}')"
else miss "Claude Code is not installed — see https://claude.com/claude-code (the kit runs inside it)"; fi

step "6. Kit engine"
if [ -d node_modules/puppeteer-core ]; then ok "engine packages installed"
elif [ "$MODE" = install ] && command -v npm >/dev/null 2>&1; then
  echo "  … installing engine packages"; npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null 2>&1
  [ -d node_modules/puppeteer-core ] && ok "engine packages installed" || miss "npm install failed — run: npm install"
else miss "engine packages (run ./setup.sh)"; fi
mkdir -p member projects output 2>/dev/null

step "7. Claude Code plugins (installed for this folder only)"
if [ "$PLUGINS" = 0 ]; then note "skipped (--no-plugins)"
elif ! command -v claude >/dev/null 2>&1; then note "skipped until Claude Code is installed"
else
  for p in "${PLUGIN_SOURCES[@]}"; do
    src="${p%%|*}"; id="${p##*|}"
    if grep -q "\"$id\"" .claude/settings.json 2>/dev/null && claude plugin list 2>/dev/null | grep -q "${id%%@*}"; then ok "$id"; continue; fi
    if [ "$MODE" = install ]; then
      claude plugin marketplace add "$src" --scope project >/dev/null 2>&1
      if claude plugin install "$id" --scope project >/dev/null 2>&1; then ok "$id installed"; else miss "$id failed — inside Claude Code run: /plugin marketplace add $src  then  /plugin install $id"; fi
    else miss "$id (run ./setup.sh)"; fi
  done
fi

step "8. Engine check"
if [ -d node_modules/puppeteer-core ] && command -v node >/dev/null 2>&1; then
  if node engine/cli.js check >/tmp/kit-check.$$ 2>&1; then ok "engine check passed"; sed 's/^/     /' /tmp/kit-check.$$
  else miss "engine check failed:"; sed 's/^/     /' /tmp/kit-check.$$; fi
  rm -f /tmp/kit-check.$$
fi

if [ "$MODE" = doctor ] && [ "$MISSING" = 0 ]; then
  step "9. Test edit (10 seconds of generated speech)"
  T=$(mktemp -d /tmp/kit-doctor.XXXXXX)
  mkdir -p "$T/src" "$T/root"
  say -o "$T/src/v.aiff" "This is a short test of the video kit. If you can read this caption, everything works." 2>/dev/null
  "$(brew --prefix)/opt/ffmpeg-full/bin/ffmpeg" -v error -y -f lavfi -i "color=c=0x223344:s=1920x1080:r=30" -i "$T/src/v.aiff" \
    -filter_complex "[1:a]apad=pad_dur=0.6,aformat=channel_layouts=stereo[a]" -map 0:v -map "[a]" -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac "$T/src/test.mp4"
  cp -R config "$T/root/"
  if KIT_ROOT="$T/root" node engine/cli.js long "$T/src/test.mp4" --planner heuristic >"$T/log" 2>&1; then ok "test edit rendered and passed QA"
  else miss "test edit did not pass — details:"; tail -15 "$T/log" | sed 's/^/     /'; fi
  rm -rf "$T"
fi

echo
if [ "$MISSING" = 0 ]; then
  printf "\033[32mReady.\033[0m Open \"Video Kit\" (Applications, Launchpad or Spotlight) to start the app (or open this folder in Claude Code and type /setup).\n"
  exit 0
else
  printf "\033[31m%s item(s) need attention\033[0m (see ✗ above). Fix them, then run ./setup.sh again.\n" "$MISSING"
  exit 1
fi
