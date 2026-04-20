package main

import (
	"fmt"
	"log"
	"os"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

var logger = log.New(os.Stderr, "[chrome-turbo] ", 0)

func main() {
	// --ws-server: run as a standalone WebSocket daemon (no MCP stdio).
	if len(os.Args) > 1 && os.Args[1] == "--ws-server" {
		logger.Println("Starting as WebSocket daemon")
		if err := RunDaemon(); err != nil {
			fmt.Fprintf(os.Stderr, "Daemon error: %v\n", err)
			os.Exit(1)
		}
		return
	}

	initHaiku()
	loadBrowserConfig()
	if err := initDB(); err != nil {
		logger.Printf("Warning: custom tools DB failed to init: %v", err)
	}

	go startWebSocket()

	s := server.NewMCPServer(
		"chrome-turbo",
		"1.0.0",
		server.WithToolCapabilities(false),
	)

	registerAllTools(s)

	logger.Println("MCP server running (stdio)")
	if err := server.ServeStdio(s); err != nil {
		fmt.Fprintf(os.Stderr, "Server error: %v\n", err)
		os.Exit(1)
	}
}

func registerAllTools(s *server.MCPServer) {
	registerBrowserTools(s)
	registerDomTools(s)
	registerInteractionTools(s)
	registerJsTools(s)
	registerDebugTools(s)
	registerCustomTools(s)
}

// textResult converts any value to a JSON text tool result.
func textResult(data any) (*mcp.CallToolResult, error) {
	return mcp.NewToolResultText(toJSON(data)), nil
}
