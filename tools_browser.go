package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func registerBrowserTools(s *server.MCPServer) {
	// --- launch_browser ---
	s.AddTool(
		mcp.NewTool("launch_browser",
			mcp.WithDescription("Launch a new Chrome instance with stealth flags (--silent-debugger-extension-api to hide the debugging infobar). Auto-loads the extension. Uses a dedicated profile so it won't affect your main browser."),
			mcp.WithBoolean("headless", mcp.Description("Launch in headless mode (default false)")),
		),
		handleLaunchBrowser,
	)

	// --- connection_status ---
	s.AddTool(
		mcp.NewTool("connection_status",
			mcp.WithDescription("Check if the Chrome extension is connected to the MCP server"),
		),
		handleConnectionStatus,
	)

	// --- list_tabs ---
	s.AddTool(
		mcp.NewTool("list_tabs",
			mcp.WithDescription("List all open Chrome tabs with their IDs, titles, and URLs"),
		),
		handleListTabs,
	)

	// --- navigate ---
	s.AddTool(
		mcp.NewTool("navigate",
			mcp.WithDescription("Navigate a tab to a URL. Omit tabId to use the active tab."),
			mcp.WithString("url", mcp.Required(), mcp.Description("URL to navigate to")),
			mcp.WithNumber("tabId", mcp.Description("Tab ID (omit for active tab)")),
		),
		handleNavigate,
	)

	// --- screenshot ---
	s.AddTool(
		mcp.NewTool("screenshot",
			mcp.WithDescription("Take a screenshot of a tab. Returns a JPEG image scaled to maxWidth (default 1280px, NOT retina 3000px). Fast and compact."),
			mcp.WithNumber("tabId", mcp.Description("Tab ID (omit for active tab)")),
			mcp.WithNumber("maxWidth", mcp.Description("Max width in pixels (default 1280)")),
			mcp.WithNumber("quality", mcp.Description("JPEG quality 1-100 (default 70)")),
		),
		handleScreenshot,
	)

	// --- turbo_snapshot ---
	s.AddTool(
		mcp.NewTool("turbo_snapshot",
			mcp.WithDescription("TURBO: Screenshot + interactive element map in ONE call. Returns a scaled JPEG image AND a JSON spatial map of all interactive elements. The fastest way to understand a page."),
			mcp.WithNumber("tabId", mcp.Description("Tab ID (omit for active tab)")),
			mcp.WithNumber("maxWidth", mcp.Description("Screenshot max width (default 1280)")),
			mcp.WithNumber("quality", mcp.Description("JPEG quality 1-100 (default 70)")),
		),
		handleTurboSnapshot,
	)
}

func handleLaunchBrowser(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	headless := getBool(args, "headless", false)
	pid, err := launchBrowser(headless)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return textResult(map[string]any{
		"launched": true,
		"pid":      pid,
		"headless": headless,
		"stealth":  true,
		"message":  "Chrome launched with --silent-debugger-extension-api (no debugging infobar)",
	})
}

func handleConnectionStatus(_ context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	open := getOpenBrowsers()
	names := make([]string, len(open))
	for i, b := range open {
		b.mu.Lock()
		names[i] = b.name
		b.mu.Unlock()
	}
	return textResult(map[string]any{
		"connected":       len(open) > 0 || getBiDi() != nil,
		"extension":       len(open) > 0,
		"bidi":            getBiDi() != nil,
		"browsers":        names,
		"extensionCount":  len(open),
		"wsPort":          wsPort,
	})
}

func handleListTabs(_ context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	raw, err := send("list_tabs", nil)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return mcp.NewToolResultText(string(raw)), nil
}

func handleNavigate(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	raw, err := send("navigate", rawArgs(args))
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return mcp.NewToolResultText(string(raw)), nil
}

func handleScreenshot(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	quality := intOr(args["quality"], 70)

	// Try BiDi first (works in both Chrome and Firefox, no focus needed)
	if getBiDi() != nil {
		ctxID, err := resolveContext(args["tabId"])
		if err == nil {
			data, err := bidiScreenshot(ctx, ctxID, quality)
			if err == nil {
				encoded := base64Encode(data)
				return &mcp.CallToolResult{
					Content: []mcp.Content{
						mcp.NewImageContent(encoded, "image/jpeg"),
						mcp.NewTextContent("screenshot via BiDi"),
					},
				}, nil
			}
			logger.Printf("BiDi screenshot failed, falling back to extension: %v", err)
		}
	}

	// Fallback: extension path
	raw, err := send("screenshot", rawArgs(args))
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}

	var result struct {
		Base64   string `json:"base64"`
		MimeType string `json:"mimeType"`
		Width    int    `json:"width"`
		Height   int    `json:"height"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("failed to parse screenshot: %v", err)), nil
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{
			mcp.NewImageContent(result.Base64, result.MimeType),
			mcp.NewTextContent(fmt.Sprintf("%dx%d jpeg", result.Width, result.Height)),
		},
	}, nil
}

func handleTurboSnapshot(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	raw, err := send("turbo_snapshot", rawArgs(args))
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}

	var result struct {
		Screenshot struct {
			Base64   string `json:"base64"`
			MimeType string `json:"mimeType"`
			Width    int    `json:"width"`
			Height   int    `json:"height"`
		} `json:"screenshot"`
		InteractiveMap json.RawMessage `json:"interactiveMap"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("failed to parse turbo_snapshot: %v", err)), nil
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{
			mcp.NewImageContent(result.Screenshot.Base64, result.Screenshot.MimeType),
			mcp.NewTextContent(string(result.InteractiveMap)),
		},
	}, nil
}
