package main

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func getConfigDir() string {
	if dir, err := os.UserConfigDir(); err == nil && dir != "" {
		return filepath.Join(dir, "chrome-turbo-mcp")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "chrome-turbo-mcp")
}

func setSysProcAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func ensureDaemon() error {
	addr := net.JoinHostPort("127.0.0.1", "18321")
	if conn, err := net.DialTimeout("tcp", addr, 300*time.Millisecond); err == nil {
		_ = conn.Close()
		return nil
	}

	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "--ws-server")
	cmd.Stdout = nil
	cmd.Stderr = nil
	setSysProcAttr(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()

	for i := 0; i < 20; i++ {
		time.Sleep(100 * time.Millisecond)
		conn, err := net.DialTimeout("tcp", addr, 300*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return nil
		}
	}
	return nil
}

func toJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(b)
}

func rawArgs(args map[string]any) map[string]any { return args }

func getBool(args map[string]any, key string, def bool) bool {
	if args == nil {
		return def
	}
	v, ok := args[key]
	if !ok || v == nil {
		return def
	}
	b, ok := v.(bool)
	if !ok {
		return def
	}
	return b
}

func toFloat(v any) float64 {
	if f, ok := v.(float64); ok {
		return f
	}
	return 0
}

func toInt(v any) int {
	if f, ok := v.(float64); ok {
		return int(f)
	}
	if i, ok := v.(int); ok {
		return i
	}
	return 0
}

func contains(s, sub string) bool {
	return strings.Contains(strings.ToLower(s), strings.ToLower(sub))
}

func initHaiku() {}

func initDB() error { return nil }

func registerCustomTools(s *server.MCPServer) {
	s.AddTool(
		mcp.NewTool("connection_test",
			mcp.WithDescription("Simple health check tool."),
		),
		func(_ context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			return mcp.NewToolResultText(`{"ok": true}`), nil
		},
	)
}

func registerDomTools(s *server.MCPServer) {
	add := func(name, desc string) {
		s.AddTool(
			mcp.NewTool(name, mcp.WithDescription(desc)),
			passThrough(name),
		)
	}
	add("extract_text", "Extract visible text blocks from the page.")
	add("find_text", "Find elements by visible text.")
	add("inspect", "Inspect an element by selector, coords, or text.")
	add("get_interactive_map", "Get interactive elements with coordinates.")
	add("query_elements", "Query page elements by CSS selector.")
	add("get_html", "Get page HTML.")
	add("get_page_structure", "Get structural page summary.")
}

func registerJsTools(s *server.MCPServer) {
	add := func(name, desc string) {
		s.AddTool(
			mcp.NewTool(name, mcp.WithDescription(desc)),
			passThrough(name),
		)
	}
	add("execute_js", "Execute JavaScript in page context.")
	add("execute_js_isolated", "Execute JavaScript in isolated world.")
	add("inject_script", "Inject script into page main world.")
	add("adapt_script", "Run persistent adaptation script.")
}
