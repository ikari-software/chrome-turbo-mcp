# turboweb-mcp-by-ikari

A single-binary MCP server that drives a Chrome / Arc / Brave / Edge / Firefox
tab through a companion browser extension and (optionally) WebDriver BiDi.

The MCP server speaks stdio to your editor (Claude Code, Cursor, Claude
Desktop, etc.) and a WebSocket to the extension on `127.0.0.1:18321`. When
WebDriver BiDi is available the same tools work cross-browser without an
extension at all.

Includes an on-page agent overlay (animated cursor, click ripple, intent
toast) so a human user can watch what the agent is doing in real time
without reading every tool-call dump.

## Build

```bash
make build         # → bin/turboweb-mcp-by-ikari
make release       # cross-compile all four targets, see below, + extension zips
make test          # go tests + extension vitest suite
make watch         # rebuild extension/dist on every source change
```

Release matrix:

| Target           | File                                              |
| ---------------- | ------------------------------------------------- |
| macOS arm64      | `bin/turboweb-mcp-by-ikari-darwin-arm64`          |
| Linux x86-64     | `bin/turboweb-mcp-by-ikari-linux-amd64`           |
| Windows x86-64   | `bin/turboweb-mcp-by-ikari-windows-amd64.exe`     |
| Windows arm64    | `bin/turboweb-mcp-by-ikari-windows-arm64.exe`     |
| Chrome extension | `bin/turboweb-mcp-by-ikari-extension-chrome.zip`  |
| Firefox add-on   | `bin/turboweb-mcp-by-ikari-extension-firefox.zip` |

## Install

```bash
./setup.sh
```

`setup.sh` runs `make build`, then generates per-browser launcher scripts
(`bin/launch-{chrome,arc,brave,edge}.sh`) that open the browser with the
extension preloaded. For a persistent install, load `extension/dist/chrome`
via `chrome://extensions` → Developer mode → Load unpacked (or grab the
release zip — same contents).

Wire it into your MCP host (e.g. `~/.claude.json`):

```json
{
  "mcpServers": {
    "turboweb": {
      "command": "/path/to/bin/turboweb-mcp-by-ikari"
    }
  }
}
```

Upgrading from `chrome-turbo-mcp`? A `bin/chrome-turbo-mcp` shim is
shipped alongside the renamed binary — old configs pointing at that path
keep working without edits. Custom-tool DB is migrated forward
automatically on first run (non-destructive).

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
turboweb-mcp-by-ikari/
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
