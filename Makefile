BINARY = chrome-turbo-mcp
VERSION = 1.0.0

.PHONY: build install release clean test test-go test-extension extension

build:
	go build -ldflags="-s -w" -o bin/$(BINARY) .

install: build
	cp bin/$(BINARY) /usr/local/bin/

release:
	GOOS=darwin  GOARCH=arm64 go build -ldflags="-s -w" -o bin/$(BINARY)-darwin-arm64 .
	GOOS=linux   GOARCH=amd64 go build -ldflags="-s -w" -o bin/$(BINARY)-linux-amd64 .
	GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o bin/$(BINARY)-windows-amd64.exe .
	GOOS=windows GOARCH=arm64 go build -ldflags="-s -w" -o bin/$(BINARY)-windows-arm64.exe .

extension:
	cd extension && node build.js

test: test-go test-extension

test-go:
	go test ./...

test-extension:
	cd extension && npm test

clean:
	rm -rf bin/$(BINARY)* extension/coverage extension/dist
