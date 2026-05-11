BINARY = chrome-turbo-mcp
VERSION = 1.0.0

.PHONY: build install release clean test test-go test-extension extension extension-watch extension-zip watch

build: extension
	go build -ldflags="-s -w" -o bin/$(BINARY) .

install: build
	cp bin/$(BINARY) /usr/local/bin/

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

# Zip the loadable extension folders so a release artifact is self-contained.
# A user can download chrome-turbo-extension-chrome.zip, unzip it, and
# load the unpacked folder via chrome://extensions — no Node, no Make.
extension-zip: extension
	cd extension/dist && rm -f ../../bin/$(BINARY)-extension-chrome.zip ../../bin/$(BINARY)-extension-firefox.zip
	cd extension/dist && zip -qr ../../bin/$(BINARY)-extension-chrome.zip chrome
	cd extension/dist && zip -qr ../../bin/$(BINARY)-extension-firefox.zip firefox

# One-shot rebuild of the loadable extension into extension/dist/{chrome,firefox}/.
extension:
	cd extension && node build.js

# Watch the extension source files and rebuild dist/ on every change. Load
# extension/dist/chrome/ in chrome://extensions and click "Reload" on the
# extension card after each change to pick up new code in the browser.
extension-watch watch:
	cd extension && node build.js --watch

test: test-go test-extension

test-go:
	go test ./...

test-extension:
	cd extension && npm test

clean:
	rm -rf bin/$(BINARY)* extension/coverage extension/dist
