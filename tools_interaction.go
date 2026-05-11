package main

import (
	"context"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func registerInteractionTools(s *server.MCPServer) {
	// --- click ---
	addTool(s,
		mcp.NewTool("click",
			mcp.WithDescription("Click an element by CSS selector OR x,y coordinates. Dispatches mousedown, mouseup, click events."),
			mcp.WithString("selector", mcp.Description("CSS selector of element to click")),
			mcp.WithNumber("x", mcp.Description("X coordinate to click")),
			mcp.WithNumber("y", mcp.Description("Y coordinate to click")),
			mcp.WithNumber("tabId", mcp.Description("Tab ID (omit for active tab)")),
		),
		passThrough("click"),
	)

	// --- type_text ---
	addTool(s,
		mcp.NewTool("type_text",
			mcp.WithDescription("Type text into an element. Uses insertText command so it works with React, Vue, and other frameworks. Can clear existing text first."),
			mcp.WithString("text", mcp.Required(), mcp.Description("Text to type")),
			mcp.WithString("selector", mcp.Description("CSS selector (omit for focused element)")),
			mcp.WithBoolean("clear", mcp.Description("Clear existing text first (default false)")),
			mcp.WithBoolean("pressEnter", mcp.Description("Press Enter after typing (default false)")),
			mcp.WithNumber("tabId", mcp.Description("Tab ID (omit for active tab)")),
		),
		passThrough("type_text"),
	)

	// --- scroll ---
	addTool(s,
		mcp.NewTool("scroll",
			mcp.WithDescription("Scroll the page or a specific element. Use direction (up/down/left/right) or pixel offsets."),
			mcp.WithString("direction", mcp.Description("Scroll direction")),
			mcp.WithNumber("amount", mcp.Description("Pixels to scroll (default ~80% viewport)")),
			mcp.WithString("selector", mcp.Description("Scroll within this element")),
			mcp.WithNumber("x", mcp.Description("Horizontal pixel offset")),
			mcp.WithNumber("y", mcp.Description("Vertical pixel offset")),
			mcp.WithNumber("tabId", mcp.Description("Tab ID (omit for active tab)")),
		),
		passThrough("scroll"),
	)

	// --- cdp_click (now via BiDi input.performActions) ---
	addTool(s,
		mcp.NewTool("cdp_click",
			mcp.WithDescription("Click at exact viewport coordinates using real browser input. Works on MUI portals, dropdowns, and any element. Use when regular click tool fails on overlay/popup elements."),
			mcp.WithNumber("x", mcp.Required(), mcp.Description("X viewport coordinate")),
			mcp.WithNumber("y", mcp.Required(), mcp.Description("Y viewport coordinate")),
			mcp.WithBoolean("shift", mcp.Description("Hold Shift key during click (for multi-select)")),
			mcp.WithNumber("tabId", mcp.Description("Tab ID (omit for active tab)")),
		),
		bidiOrFallback("cdp_click", handleBiDiClick),
	)

	// --- cdp_type (now via BiDi input.performActions) ---
	addTool(s,
		mcp.NewTool("cdp_type",
			mcp.WithDescription("Type text using real keyboard events. Works with React, MUI, and any framework. Use clear=true to select-all and delete before typing."),
			mcp.WithString("text", mcp.Required(), mcp.Description("Text to type character by character")),
			mcp.WithBoolean("clear", mcp.Description("Select-all + delete before typing (default false)")),
			mcp.WithNumber("tabId", mcp.Description("Tab ID (omit for active tab)")),
		),
		bidiOrFallback("cdp_type", handleBiDiType),
	)

	// --- cdp_key (now via BiDi input.performActions) ---
	addTool(s,
		mcp.NewTool("cdp_key",
			mcp.WithDescription("Press a single key via real browser input. Supports: Enter, Escape, ArrowDown, ArrowUp, Backspace, Tab."),
			mcp.WithString("key", mcp.Required(), mcp.Description("Key name: Enter, Escape, ArrowDown, ArrowUp, Backspace, Tab")),
			mcp.WithNumber("tabId", mcp.Description("Tab ID (omit for active tab)")),
		),
		bidiOrFallback("cdp_key", handleBiDiKey),
	)

	// --- cdp_scroll (now via BiDi input.performActions) ---
	addTool(s,
		mcp.NewTool("cdp_scroll",
			mcp.WithDescription("Scroll at a specific viewport position using real browser wheel events. Provide x,y for position, deltaY for amount (negative=up, positive=down)."),
			mcp.WithNumber("x", mcp.Description("X coordinate for scroll position (default 600)")),
			mcp.WithNumber("y", mcp.Description("Y coordinate for scroll position (default 400)")),
			mcp.WithNumber("deltaX", mcp.Description("Horizontal scroll amount")),
			mcp.WithNumber("deltaY", mcp.Description("Vertical scroll amount (negative=up, positive=down)")),
			mcp.WithNumber("tabId", mcp.Description("Tab ID (omit for active tab)")),
		),
		bidiOrFallback("cdp_scroll", handleBiDiScroll),
	)
}

// passThrough creates a handler that forwards the action and all args to the extension.
func passThrough(action string) server.ToolHandlerFunc {
	return func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		args := req.GetArguments()
		raw, err := send(action, rawArgs(args))
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		return mcp.NewToolResultText(string(raw)), nil
	}
}

// --- BiDi real-input handlers ---

func handleBiDiClick(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	ctxID, err := resolveContext(args["tabId"])
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	x := toFloat(args["x"])
	y := toFloat(args["y"])
	if err := bidiClick(ctx, ctxID, x, y, "left"); err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return textResult(map[string]any{"clicked": true, "x": x, "y": y})
}

func handleBiDiType(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	ctxID, err := resolveContext(args["tabId"])
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	text := toString(args["text"])
	if toBool(args["clear"]) {
		if err := bidiSelectAllClear(ctx, ctxID); err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
	}
	if err := bidiType(ctx, ctxID, text); err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return textResult(map[string]any{"typed": len(text)})
}

func handleBiDiKey(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	ctxID, err := resolveContext(args["tabId"])
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	key := toString(args["key"])
	if err := bidiKey(ctx, ctxID, key); err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return textResult(map[string]any{"pressed": key})
}

func handleBiDiScroll(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	ctxID, err := resolveContext(args["tabId"])
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	x := toFloat(args["x"])
	y := toFloat(args["y"])
	if x == 0 {
		x = 600
	}
	if y == 0 {
		y = 400
	}
	deltaX := toFloat(args["deltaX"])
	deltaY := toFloat(args["deltaY"])
	if err := bidiScroll(ctx, ctxID, x, y, deltaX, deltaY); err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return textResult(map[string]any{"scrolled": true})
}
