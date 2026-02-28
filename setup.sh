#!/usr/bin/env bash
# Chrome Turbo MCP — Auto-setup for Chrome and Arc
# Installs the extension and builds the native binary.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$DIR/extension"

echo "=== Chrome Turbo MCP Setup ==="
echo ""

# --- Build native binary if Go is available ---
if command -v go &>/dev/null; then
  echo "[1/3] Building native image processor..."
  mkdir -p "$DIR/bin"
  # Detect GOROOT from asdf if misconfigured
  GOROOT_OVERRIDE=""
  if go env GOROOT 2>/dev/null | grep -qv '/go$'; then
    ASDF_GO="$(asdf where golang 2>/dev/null)/go" 2>/dev/null || true
    if [ -d "$ASDF_GO/src" ]; then
      GOROOT_OVERRIDE="$ASDF_GO"
    fi
  fi
  (cd "$DIR/native" && \
    GOROOT="${GOROOT_OVERRIDE:-$(go env GOROOT)}" \
    GOPATH="${GOPATH:-$HOME/go}" \
    GOMODCACHE="${GOMODCACHE:-$HOME/go/pkg/mod}" \
    GOPROXY="${GOPROXY:-https://proxy.golang.org,direct}" \
    GONOSUMCHECK='*' \
    go build -o "$DIR/bin/turbo-native" .) 2>/dev/null && \
    echo "      Built bin/turbo-native" || \
    echo "      WARN: Go build failed, will use JS fallback (still works)"
else
  echo "[1/3] Go not found — skipping native binary (JS fallback will be used)"
fi

# --- Install npm deps if needed ---
if [ ! -d "$DIR/node_modules" ]; then
  echo "[2/3] Installing npm dependencies..."
  (cd "$DIR" && npm install --silent)
else
  echo "[2/3] npm deps already installed"
fi

# --- Detect browsers and install extension ---
echo "[3/3] Installing Chrome extension..."
echo ""

CHROME_APP="/Applications/Google Chrome.app"
ARC_APP="/Applications/Arc.app"

installed=0

install_for_browser() {
  local name="$1"
  local app="$2"
  local user_data="$3"

  if [ ! -d "$app" ]; then
    return
  fi

  echo "  Found: $name"

  # Method 1: Try --load-extension via command line (works if browser restarts)
  # Method 2: Create an External Extensions JSON (preferred — persists across restarts)

  # For Chrome, we can use the External Extensions directory
  # This makes Chrome auto-detect the extension on next launch
  if [ "$name" = "Chrome" ]; then
    local ext_json_dir="$user_data/Default/External Extensions"
    # We need a stable extension ID. For unpacked extensions loaded by path,
    # Chrome uses a hash of the path. Instead, let's use the preferences approach.

    # Best approach: modify Preferences to add the extension
    # But this is fragile. Instead, let's just open the extensions page.
    :
  fi

  # For both Chrome and Arc, the most reliable dev method is --load-extension
  # We'll create a launcher script that adds our extension
  local launcher="$DIR/bin/launch-${name,,}.sh"
  mkdir -p "$DIR/bin"
  cat > "$launcher" << SCRIPT
#!/usr/bin/env bash
# Launch $name with Chrome Turbo MCP extension loaded
open -a "$app" --args --load-extension="$EXT_DIR"
SCRIPT
  chmod +x "$launcher"
  echo "    Created launcher: bin/launch-${name,,}.sh"
  installed=$((installed + 1))
}

install_for_browser "Chrome" "$CHROME_APP" "$HOME/Library/Application Support/Google/Chrome"
install_for_browser "Arc" "$ARC_APP" "$HOME/Library/Application Support/Arc"

# Also try to load extension into already-running browsers via AppleScript
load_in_running_browser() {
  local name="$1"
  local app="$2"

  if ! pgrep -f "$app" &>/dev/null; then
    return
  fi

  echo ""
  echo "  $name is running. Opening extensions page..."

  if [ "$name" = "Chrome" ]; then
    osascript -e '
      tell application "Google Chrome"
        activate
        open location "chrome://extensions"
      end tell
    ' 2>/dev/null || true
  elif [ "$name" = "Arc" ]; then
    osascript -e '
      tell application "Arc"
        activate
        open location "chrome://extensions"
      end tell
    ' 2>/dev/null || true
  fi
}

echo ""
echo "=== Extension Installation ==="
echo ""
echo "  Option A (Quick — for current session):"
echo "    Close and relaunch your browser with our launcher:"
echo "      ./bin/launch-chrome.sh   or   ./bin/launch-arc.sh"
echo ""
echo "  Option B (Manual — persists across restarts):"
echo "    1. Open chrome://extensions in your browser"
echo "    2. Enable 'Developer mode' (top right toggle)"
echo "    3. Click 'Load unpacked'"
echo "    4. Select: $EXT_DIR"
echo ""

# Ask if user wants to open extensions page now
if [ -t 0 ]; then
  read -rp "  Open chrome://extensions now? [Y/n] " answer
  if [[ "$answer" != "n" && "$answer" != "N" ]]; then
    load_in_running_browser "Chrome" "Google Chrome"
    load_in_running_browser "Arc" "Arc"
    echo ""
    echo "  Extension directory to load:"
    echo "    $EXT_DIR"
  fi
fi

echo ""
echo "=== Done ==="
echo ""
echo "  MCP server is already registered in ~/.claude.json"
echo "  Restart Claude Code to pick up the new MCP server."
echo ""
echo "  To test: run 'npm start' and check that the extension connects."
