#!/usr/bin/env bash
# Chrome Turbo MCP — local install helper.
# Builds the Go binary, generates browser launchers that load the extension,
# and prints next steps for the chrome://extensions install.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$DIR/extension"

echo "=== Chrome Turbo MCP Setup ==="
echo ""

# --- Build the Go MCP server binary ---
if ! command -v go >/dev/null 2>&1; then
  echo "ERROR: Go is required. Install from https://go.dev/dl/ then re-run."
  exit 1
fi

echo "[1/2] Building chrome-turbo-mcp..."
( cd "$DIR" && make build >/dev/null )
echo "      Built bin/chrome-turbo-mcp"

# --- Generate browser launchers (load extension on next start) ---
echo "[2/2] Generating browser launchers..."

write_launcher() {
  local name="$1"
  local app="$2"
  [ -d "$app" ] || return
  local launcher="$DIR/bin/launch-${name,,}.sh"
  cat > "$launcher" <<SCRIPT
#!/usr/bin/env bash
open -a "$app" --args --load-extension="$EXT_DIR"
SCRIPT
  chmod +x "$launcher"
  echo "      bin/launch-${name,,}.sh — found $name"
}

write_launcher "Chrome" "/Applications/Google Chrome.app"
write_launcher "Arc"    "/Applications/Arc.app"
write_launcher "Brave"  "/Applications/Brave Browser.app"
write_launcher "Edge"   "/Applications/Microsoft Edge.app"

echo ""
echo "=== Install the extension ==="
echo ""
echo "  Quick (this session):"
echo "    Run one of the launchers in bin/, e.g. ./bin/launch-chrome.sh"
echo ""
echo "  Persistent:"
echo "    1. Open chrome://extensions"
echo "    2. Enable 'Developer mode' (top right)"
echo "    3. Click 'Load unpacked'"
echo "    4. Select: $EXT_DIR"
echo ""
echo "Run the server:"
echo "  $DIR/bin/chrome-turbo-mcp"
echo ""
