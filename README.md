# chrome-turbo-mcp

A single-binary MCP server that drives a Chrome / Arc / Brave / Edge / Firefox tab
through a companion browser extension and (optionally) WebDriver BiDi.

The MCP server speaks stdio to your editor (Claude Code, Cursor, Claude
Desktop, etc.) and a WebSocket to the extension on `127.0.0.1:18321`. When
WebDriver BiDi is available the same tools work cross-browser without an
extension at all.

## Build

```bash
make build         # → bin/chrome-turbo-mcp
make release       # cross-compile all four targets, see below
make test          # go tests + extension vitest suite
```

Release matrix:

| Target           | File                                       |
| ---------------- | ------------------------------------------ |
| macOS arm64      | `bin/chrome-turbo-mcp-darwin-arm64`        |
| Linux x86-64     | `bin/chrome-turbo-mcp-linux-amd64`         |
| Windows x86-64   | `bin/chrome-turbo-mcp-windows-amd64.exe`   |
| Windows arm64    | `bin/chrome-turbo-mcp-windows-arm64.exe`   |

## Install

```bash
./setup.sh
```

`setup.sh` runs `make build`, then generates per-browser launcher scripts
(`bin/launch-{chrome,arc,brave,edge}.sh`) that open the browser with the
extension preloaded. For a persistent install, load `extension/` via
`chrome://extensions` → Developer mode → Load unpacked.

Wire it into your MCP host (e.g. `~/.claude.json`):

```json
{
  "mcpServers": {
    "chrome-turbo": {
      "command": "/path/to/bin/chrome-turbo-mcp"
    }
  }
}
```

Optional: set `ANTHROPIC_API_KEY` (or `CLAUDE_API_KEY`) to enable Haiku
preprocessing — any tool that takes a `question` argument will pipe its
raw result through `claude-haiku-4-5` and return a concise answer.

## Tool surface

Browser & page: `connection_status`, `list_tabs`, `navigate`,
`launch_browser`, `screenshot`, `turbo_snapshot`, `page_yaml`,
`page_reload`, `print_to_pdf`.

DOM: `extract_text`, `find_text`, `inspect`, `query_elements`, `get_html`,
`get_interactive_map`, `describe`, `dom_snapshot`, `get_accessibility_tree`.

Interaction: `click`, `type_text`, `scroll`, `cdp_click`, `cdp_type`,
`cdp_key`, `cdp_scroll`.

JS execution: `execute_js`, `adapt_script`, `add_preload_script`.

Debug: console (`console_enable/get/clear/disable`), network
(`network_enable/get/get_body/throttle/disable`), cookies/storage
(`get_cookies`, `set_cookie`, `delete_cookies`, `get_storage`),
performance (`get_performance`, `css_coverage_start/stop`),
device emulation (`emulate_device`), `cdp_detach`.

Custom tools (SQLite-backed, persistent): `create_tool`, `list_custom_tools`,
`run_tool`, `delete_tool`. Custom tools wrap an `execute_js` body and an
optional system prompt for Haiku post-processing.

## Layout

```
chrome-turbo-mcp/
├── main.go, ws.go             # MCP stdio + extension WebSocket
├── bidi*.go, browser.go       # WebDriver BiDi cross-browser path
├── tools_*.go                 # MCP tool registrations
├── haiku.go                   # Anthropic Haiku preprocessing
├── resize.go                  # in-process JPEG resize for screenshots
├── daemon{,_unix,_windows}.go # daemon-relay mode for shared extensions
└── extension/                 # Chrome MV3 extension (vitest suite under __tests__/)
```

The Go binary runs in two modes:

- **MCP stdio** (default) — what your editor talks to.
- **`--ws-server`** — long-lived daemon that owns port 18321; subsequent
  MCP processes connect to it via `/relay`. Useful if you run multiple
  editors against a single browser.

## Architecture notes

This repo previously had a parallel TypeScript MCP server in `src/` plus
a small Go subprocess in `native/` that the TS server spawned just for
JPEG resize. Both were retired in favour of the single Go binary, which
already had cross-browser BiDi support, the same tool surface, and a
proper daemon-relay mode. See the `Consolidate on Go` commit for the
rationale.
