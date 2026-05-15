# turboweb-mcp-by-ikari

A single-binary MCP server that drives a Chrome / Arc / Brave / Edge / Firefox
tab through a companion browser extension and (optionally) WebDriver BiDi —
with a live on-page agent overlay so a human user can watch what the agent is
doing in real time.

The MCP server speaks stdio to your editor (Claude Code, Cursor, Claude
Desktop, etc.) and a WebSocket to the extension on `127.0.0.1:18321`. When
WebDriver BiDi is available the same tools work cross-browser without an
extension at all.

## What you get

- **On-page agent overlay** — Shadow-DOM-isolated badge + animated cursor
  (quadratic Bezier arc, ~470ms sin-eased) with a robot icon pinned to the
  pointer. Per-action ripple colours (orange click, blue type, green scroll,
  purple navigate, red error). Bounding-box highlight on the target. Real
  DOM action is gated on cursor arrival so the click happens *at* the
  cursor, not while it's still flying.
- **Visualised read-only tools** — `find_text` and `extract_text` sweep a
  glowing loupe across matches; `get_interactive_map` fires a scan-flash
  outline over every interactive element on the page.
- **Failure feedback** — on tool error the cursor turns red, shakes, fires
  a red ripple, and a toast with the error message.
- **Idle fade** — cursor + badge fade out after 45s of inactivity.
- **Extension popup** with a Connected-agents section (every editor
  driving the browser is listed by session label, with a robot icon and
  client-type chip), expandable activity rows with intent, params, result
  summary, and a filter input. A ⤢ Pop out button spawns a resizable
  `chrome.windows.create` window with the same UI.
- **`intent` argument** required on every tool — the model writes a
  one-sentence narration before each call, surfaced as a toast on the
  page and as the leading text of every activity row.
- **Pluggable AI backend** for question-grounding on tool results: prefers
  Anthropic Haiku when configured, falls back to Chrome's built-in
  Gemini Nano (zero-cost, on-device) when not. See `TURBOWEB_AI_BACKEND`.

## Build

```bash
make build            # → bin/turboweb-mcp-by-ikari
make release          # cross-compile + extension zips (+ signed .xpi if creds set)
make test             # go tests + extension vitest suite
make watch            # rebuild extension/dist on every source change
```

Layout: `bin/` holds the local dev binary; `dist/` holds release archives
(everything you'd upload with `gh release create vX.Y.Z dist/*`).

Release matrix:

| Target              | File                                               |
| ------------------- | -------------------------------------------------- |
| macOS arm64         | `dist/turboweb-mcp-by-ikari-darwin-arm64`          |
| Linux x86-64        | `dist/turboweb-mcp-by-ikari-linux-amd64`           |
| Windows x86-64      | `dist/turboweb-mcp-by-ikari-windows-amd64.exe`     |
| Windows arm64       | `dist/turboweb-mcp-by-ikari-windows-arm64.exe`     |
| Chrome extension    | `dist/turboweb-mcp-by-ikari-extension-chrome.zip`  |
| Firefox add-on      | `dist/turboweb-mcp-by-ikari-extension-firefox.zip` |
| Firefox signed XPI  | `dist/turboweb-mcp-by-ikari-extension-firefox-VERSION.xpi` (only when AMO creds are set — see below) |
| Firefox update feed | `dist/firefox-updates.json` (paired with the signed XPI — see auto-update below) |

### Firefox XPI signing

`make release` produces an AMO-signed `.xpi` (installable on stock
Firefox) when both env vars are set:

```bash
export WEB_EXT_API_KEY=user:xxxx:yy
export WEB_EXT_API_SECRET=<hex>
make release                            # → dist/*.xpi (channel=unlisted)
WEB_EXT_CHANNEL=listed make release     # submit to AMO public listing
```

Credentials are issued at
<https://addons.mozilla.org/en-US/developers/addon/api/key/>. Without
them, `make extension-xpi` (and therefore `make release`) prints a skip
notice and exits 0 — local builds still succeed, the unsigned firefox
`.zip` is always produced.

### Firefox auto-update

The signed manifest carries `browser_specific_settings.gecko.update_url`
pointing at
<https://github.com/ikari-software/turboweb-mcp/releases/latest/download/firefox-updates.json>.
Firefox polls this JSON daily; when its `version` is newer than the
installed XPI, Firefox downloads the linked `.xpi` and replaces the
extension in place.

The release workflow:

```bash
make release                            # builds + signs + emits firefox-updates.json
git tag v$(make -s print-VERSION)       # or `git tag v1.3.0` manually
git push --tags
gh release create v1.3.0 dist/*         # uploads xpi + updates.json + binaries
```

Once the GitHub release is published, the `releases/latest/download/`
URL resolves to the newly uploaded `firefox-updates.json`, and every
installed extension picks up the new version within ~24h. To force a
check sooner: `about:addons` → gear → **Check for updates**.

Note: `update_url` is part of the *signed* manifest, so a one-time
manual reinstall is required to migrate users from any pre-1.3.0 XPI
(which has no `update_url`) onto the auto-update channel.

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

## Environment variables

| Variable                | Default | Effect |
| ----------------------- | ------- | ------ |
| `ANTHROPIC_API_KEY` / `CLAUDE_API_KEY` | unset | Enable Haiku for question-grounding on `find_text`, `extract_text`, `inspect`, `describe`, `run_tool` |
| `TURBOWEB_AI_BACKEND`   | `auto`  | `auto` (Haiku if key set, else Gemini Nano) · `haiku` · `local` · `none` |
| `MCP_CLIENT_LABEL`      | derived | Override the session label shown in the extension popup |

## AI backends

Tools that accept a `question` argument can hand the raw result to a
language model for a concise answer:

- **Haiku** (`claude-haiku-4-5-20251001`) when `ANTHROPIC_API_KEY` is set.
  Multimodal (handles `describe`'s screenshot), 80k-char context, fast.
- **Chrome's built-in Gemini Nano** (`self.LanguageModel`) when Haiku
  isn't configured *or* when `TURBOWEB_AI_BACKEND=local`. Runs on-device,
  free, offline. Requires Chrome 138+ with the Prompt API flag enabled
  and the Optimization Guide On Device Model downloaded (check
  `chrome://components`). Text-only — screenshots are skipped when
  falling back to local. ~12k-char context window.

When neither backend is available, tools return raw structured data
prefixed with `[AI unavailable — raw data follows]`. Nothing breaks.

## Tool surface

Every tool also accepts a required **`intent`** argument — one short
sentence describing what the agent is about to do.

Browser & page: `connection_status`, `list_tabs`, `navigate`,
`launch_browser`, `screenshot`, `turbo_snapshot`, `page_yaml`,
`page_reload`, `print_to_pdf`.

DOM: `extract_text`, `find_text`, `inspect`, `query_elements`, `get_html`,
`get_interactive_map`, `describe`, `dom_snapshot`, `get_accessibility_tree`.

Interaction: `click`, `type_text`, `scroll`, `cdp_click`, `cdp_type`,
`cdp_key`, `cdp_scroll`, `set_input_files`, `intercept_file_chooser`.

`click` vs `cdp_click`:

- **`click`** — synthetic DOM events from the content script. Fast, works
  on most pages. The synthetic click is *untrusted* (`event.isTrusted ===
  false`) and the activation may not run handlers that gate on trust;
  when a likely-untrusted case is detected (e.g. `<a href="javascript:..."`)
  the response carries a `hint` pointing at `cdp_click`.
- **`cdp_click` / `cdp_type` / `cdp_scroll`** — real browser input
  dispatched via BiDi/CDP. Trusted events, works through MUI portals,
  popovers, and `isTrusted` guards. Each accepts either a `selector`
  (resolved on the page side) or an explicit position; `selector` wins
  when both are given.
  - `cdp_click(selector | x,y)` — clicks the element's centre.
  - `cdp_type(text, [selector])` — types into whatever is focused, or
    focuses `selector` first (verifies `activeElement` actually moved).
  - `cdp_scroll(deltaX, deltaY, selector | x,y)` — wheel events
    dispatched AT a point, bubbling up to the nearest scrollable
    ancestor — that's how you scroll inner dropdowns / virtualised
    lists that `window.scrollBy` can't reach.

File uploads come in two flavours:

- **`set_input_files`** — when you can target the `<input type=file>` (or
  its wrapping label) with a selector. Works on hidden / styled inputs;
  attaches via CDP `DOM.setFileInputFiles` and fires the `change` event
  as if a human picked. Paths are resolved on the MCP server host: `~`
  is expanded, relative paths are rejected, symlinks are realpath'd.
- **`intercept_file_chooser`** — when the input is dispatched-via-button,
  cross-frame, or lazy-mounted and you can't grab it directly. Arm with
  `enable=true` + `files`, click the visible upload control, the next
  native file picker is auto-fulfilled and the queue is then dropped
  (one-shot). Re-arm before each additional upload, or disarm with
  `enable=false`.

JS execution: `execute_js`, `adapt_script`, `add_preload_script`.

Debug: console (`console_enable/get/clear/disable`), network
(`network_enable/get/get_body/throttle/disable`), cookies/storage
(`get_cookies`, `set_cookie`, `delete_cookies`, `get_storage`),
performance (`get_performance`, `css_coverage_start/stop`),
device emulation (`emulate_device`), `cdp_detach`.

Custom tools (SQLite-backed, persistent): `create_tool`, `list_custom_tools`,
`run_tool`, `delete_tool`. Custom tools wrap an `execute_js` body and an
optional system prompt for the AI post-processor.

## Layout

```
turboweb-mcp-by-ikari/
├── main.go, ws.go             # MCP stdio + extension WebSocket
├── session.go                  # per-process session label + initialize hook
├── bidi*.go, browser.go       # WebDriver BiDi cross-browser path
├── tools_*.go                 # MCP tool registrations (addTool injects `intent`)
├── haiku.go, local_ai.go      # Anthropic Haiku + Chrome Gemini Nano backends
├── resize.go                  # in-process JPEG resize for screenshots
├── daemon{,_unix,_windows}.go # daemon-relay mode for shared extensions
└── extension/                 # Chrome MV3 extension (vitest suite under __tests__/)
    ├── background.js          # WS bridge, overlay/AI dispatch, telemetry
    ├── content.js             # DOM tools + Shadow-DOM overlay (cursor, ripple, loupe, toast)
    ├── popup.{html,js}        # Connected-agents list, expandable activity log, pop-out window
    └── build.js               # Source → dist/{chrome,firefox} (supports --watch)
```

The Go binary runs in two modes:

- **MCP stdio** (default) — what your editor talks to.
- **`--ws-server`** — long-lived daemon that owns port 18321; subsequent
  MCP processes connect to it via `/relay`. Useful if you run multiple
  editors against a single browser. The daemon attaches each connected
  agent's label to outgoing commands so the extension popup can attribute
  every action.

## Security notes

The WebSocket binds to localhost only and rejects non-localhost origins.
That's the only auth boundary: any process that can open a localhost TCP
socket on this user's machine can connect as a relay client and drive the
browser. Don't run untrusted local code under the same user account
while turboweb is running.

The agent's `intent` text is self-reported, surfaced verbatim in the
popup and toast. It's clamped to 200 chars server-side, but treat it as
the model's claim about what it's doing — verify destructive actions in
the activity-row params, not just by reading the intent.

**Full threat model in [`SECURITY.md`](SECURITY.md).** Release assets are
signed via Sigstore — verify with `cosign verify-blob` before running an
unfamiliar binary; instructions in `SECURITY.md`.

## Licence &amp; trademark

Source is **Apache 2.0** ([`LICENSE`](LICENSE)) — fork it, embed it, ship
it, re-host it.

The name **TurboWeb MCP**, the **by ikari** attribution, the icon set,
and the on-page robot-cursor mark are reserved. If you ship a modified
build, rename it. Full policy in [`TRADEMARK.md`](TRADEMARK.md).

## Architecture notes

This repo previously had a parallel TypeScript MCP server in `src/` plus
a small Go subprocess in `native/` that the TS server spawned just for
JPEG resize. Both were retired in favour of the single Go binary, which
already had cross-browser BiDi support, the same tool surface, and a
proper daemon-relay mode. See the `Consolidate on Go` commit for the
rationale.

The project was renamed from `chrome-turbo-mcp` to `turboweb-mcp-by-ikari`
once the BiDi path made it genuinely cross-browser.
