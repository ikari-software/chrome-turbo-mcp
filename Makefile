BINARY = turboweb-mcp-by-ikari
LEGACY_BINARY = chrome-turbo-mcp
VERSION = 1.1.1

.PHONY: build install release clean test test-go test-extension extension extension-watch extension-zip watch shim

build: extension shim
	go build -ldflags="-s -w" -o bin/$(BINARY) .

# Back-compat shim: drop a bin/chrome-turbo-mcp script that just execs
# the renamed binary. Existing MCP-host configs (e.g. ~/.claude.json)
# pointing at the old path keep working until the user updates them.
shim:
	@mkdir -p bin
	@printf '#!/bin/sh\nexec "$$(dirname "$$0")/$(BINARY)" "$$@"\n' > bin/$(LEGACY_BINARY)
	@chmod +x bin/$(LEGACY_BINARY)

install: build
	cp bin/$(BINARY) /usr/local/bin/
	cp bin/$(LEGACY_BINARY) /usr/local/bin/

# `make release` produces every artifact a GitHub release should ship:
#   - cross-compiled binaries for darwin/linux/windows
#   - extension/dist/{chrome,firefox} zipped so users can install without a
#     local Node toolchain. The zips live in bin/ so a release uploader (e.g.
#     `gh release create … bin/*`) picks them up automatically.
release: extension extension-zip
	GOOS=darwin  GOARCH=arm64 go build -ldflags="-s -w" -o bin/$(BINARY)-darwin-arm64 .
	GOOS=linux   GOARCH=amd64 go build -ldflags="-s -w" -o bin/$(BINARY)-linux-amd64 .
	GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o bin/$(BINARY)-windows-amd64.exe .
	GOOS=windows GOARCH=arm64 go build -ldflags="-s -w" -o bin/$(BINARY)-windows-arm64.exe .

# One-shot rebuild of the loadable extension into extension/dist/{chrome,firefox}/.
extension:
	cd extension && node build.js

# Watch the extension source files and rebuild dist/ on every change. Load
# extension/dist/chrome/ in chrome://extensions and click "Reload" on the
# extension card after each change to pick up new code in the browser.
extension-watch watch:
	cd extension && node build.js --watch

# Zip the loadable extension folders so a release artifact is self-contained.
# A user can download turboweb-mcp-by-ikari-extension-chrome.zip, unzip it,
# and load the unpacked folder via chrome://extensions — no Node, no Make.
extension-zip: extension
	mkdir -p bin
	cd extension/dist && rm -f ../../bin/$(BINARY)-extension-chrome.zip ../../bin/$(BINARY)-extension-firefox.zip
	cd extension/dist && zip -qr ../../bin/$(BINARY)-extension-chrome.zip chrome
	cd extension/dist && zip -qr ../../bin/$(BINARY)-extension-firefox.zip firefox

test: test-go test-extension

test-go:
	go test ./...

test-extension:
	cd extension && npm test

clean:
	rm -rf bin/$(BINARY)* bin/$(LEGACY_BINARY) extension/coverage extension/dist
