package main

import (
	"fmt"
	"log"
	"os"
	"slices"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

var logger = log.New(os.Stderr, "[turboweb] ", 0)

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

	initSession()
	initHaiku()
	loadBrowserConfig()
	if err := initDB(); err != nil {
		logger.Printf("Warning: custom tools DB failed to init: %v", err)
	}

	go startWebSocket()

	hooks := &server.Hooks{}
	hooks.AddAfterInitialize(initializeHook())

	s := server.NewMCPServer(
		"turboweb",
		"1.0.0",
		server.WithToolCapabilities(false),
		server.WithHooks(hooks),
		// Surface a top-level instruction the host can fold into the
		// system prompt. Every tool call should be preceded by an
		// `intent` argument — a one-line natural-language narration of
		// what the agent is about to do. The browser popup and on-page
		// overlay rely on this so the human user can follow along
		// without having to expand each tool-call dump.
		server.WithInstructions(strings.TrimSpace(`
TurboWeb MCP drives a real browser tab on the user's screen. EVERY tool call
MUST include an `+"`intent`"+` argument: one short sentence in natural language
describing what you are about to do (and ideally why). It is shown live in the
extension popup and as a toast on the page itself, so the user can follow your
work without having to expand each tool call. Examples: "Clicking Submit to
send the form.", "Reading the listing details to find the agent's email.",
"Scrolling down to look for the contact link." Never omit the intent — leaving
it blank makes the on-page overlay silent and confuses the user watching.
`)),
	)

	registerAllTools(s)

	logger.Printf("turboweb MCP server running (stdio) — session: %s", getSessionLabel())
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
	registerFileTools(s)
	registerCustomTools(s)
}

// textResult converts any value to a JSON text tool result.
func textResult(data any) (*mcp.CallToolResult, error) {
	return mcp.NewToolResultText(toJSON(data)), nil
}

// intentParamDescription is shown to the agent. We keep it a single sentence
// so it fits in the model's tool-list view without dominating each tool's own
// description. The instruction is uniform across every tool.
const intentParamDescription = "Required: a one-sentence narration of what you're about to do (and ideally why), written for the human watching. Shown live in the browser popup and on the page itself, so the user can follow along without reading every tool call. Example: \"Clicking Submit because the form is filled.\""

// addTool wraps server.AddTool, injecting a uniform `intent` parameter into
// every tool's input schema. The agent fills it in to narrate each call; the
// MCP server pulls it out (see rawArgs) and forwards it as `_intent` to the
// extension and on-page overlay rather than to the tool handler itself.
//
// `intent` is marked Required so MCP hosts that validate input (Claude Code,
// Cursor, etc.) reject calls without one — forcing the agent to write a
// one-line narration before the tool executes. This is what makes the
// "calling turboweb 2 times" transcript line in Claude Code expand to
// readable per-call descriptions.
func addTool(s *server.MCPServer, tool mcp.Tool, handler server.ToolHandlerFunc) {
	if tool.InputSchema.Properties == nil {
		tool.InputSchema.Properties = map[string]any{}
	}
	if _, exists := tool.InputSchema.Properties["intent"]; !exists {
		tool.InputSchema.Properties["intent"] = map[string]any{
			"type":        "string",
			"description": intentParamDescription,
		}
	}
	if !slices.Contains(tool.InputSchema.Required, "intent") {
		tool.InputSchema.Required = append(tool.InputSchema.Required, "intent")
	}
	s.AddTool(tool, handler)
}
