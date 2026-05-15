BINARY = turboweb-mcp-by-ikari
VERSION = 1.2.0

.PHONY: build install release clean test test-go test-extension extension extension-watch extension-zip extension-xpi watch

build: extension
	go build -ldflags="-s -w" -o bin/$(BINARY) .

install: build
	cp bin/$(BINARY) /usr/local/bin/

# `make release` produces every artifact a GitHub release should ship:
#   - cross-compiled binaries for darwin/linux/windows
#   - extension/dist/{chrome,firefox} zipped so users can install without a
#     local Node toolchain. The zips live in bin/ so a release uploader (e.g.
#     `gh release create … bin/*`) picks them up automatically.
#   - bin/turboweb-mcp-by-ikari-extension-firefox.xpi (AMO-signed) when
#     WEB_EXT_API_KEY / WEB_EXT_API_SECRET are set; skipped otherwise so a
#     local `make release` without credentials still succeeds.
release: extension extension-zip extension-xpi
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

# Produce an AMO-signed .xpi from extension/dist/firefox/ via web-ext sign.
# Requires WEB_EXT_API_KEY and WEB_EXT_API_SECRET from
# https://addons.mozilla.org/en-US/developers/addon/api/key/ — without them
# this target prints a skip notice and exits 0 so local builds still work.
# Channel defaults to 'unlisted' (self-distributed signing). Set
# WEB_EXT_CHANNEL=listed to submit to AMO review.
extension-xpi: extension
	@if [ -z "$$WEB_EXT_API_KEY" ] || [ -z "$$WEB_EXT_API_SECRET" ]; then \
		echo "extension-xpi: skipping (WEB_EXT_API_KEY / WEB_EXT_API_SECRET not set)"; \
	else \
		mkdir -p bin && \
		cd extension && npx --no-install web-ext sign \
			--source-dir=dist/firefox \
			--artifacts-dir=../bin \
			--channel="$${WEB_EXT_CHANNEL:-unlisted}" \
			--api-key="$$WEB_EXT_API_KEY" \
			--api-secret="$$WEB_EXT_API_SECRET"; \
	fi

test: test-go test-extension

test-go:
	go test ./...

test-extension:
	cd extension && npm test

clean:
	rm -rf bin/$(BINARY)* extension/coverage extension/dist
