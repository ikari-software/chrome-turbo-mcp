package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
)

// Session metadata for the current MCP-server process. Surfaced to the
// extension popup so a human can see which agent (Claude Code in some folder,
// Cursor, etc.) is driving the browser at any given moment.
var (
	sessionMu        sync.RWMutex
	sessionLabel     string // human-friendly id, e.g. "claude-code/turboweb-mcp-by-ikari#42891"
	sessionType      string // "claude-code", "cursor", "claude-desktop", or ""
	sessionStartedAt = time.Now()
)

// initSession derives a best-effort session label without waiting for the
// initialize handshake. Refined later via AddAfterInitialize.
func initSession() {
	sessionMu.Lock()
	defer sessionMu.Unlock()

	if v := os.Getenv("MCP_CLIENT_LABEL"); v != "" {
		sessionLabel = v
		sessionType = strings.SplitN(v, "/", 2)[0]
		return
	}

	cwd, _ := os.Getwd()
	base := filepath.Base(cwd)
	if base == "." || base == "/" || base == "" {
		base = "mcp"
	}

	parent := parentProcessName(os.Getppid())
	guess := guessClientType(parent)

	if parent != "" {
		sessionLabel = fmt.Sprintf("%s/%s#%d", guess, base, os.Getppid())
	} else {
		sessionLabel = fmt.Sprintf("%s#%d", base, os.Getppid())
	}
	sessionType = guess
}

// refineSessionFromInitialize updates session metadata once the MCP client
// has sent its name (and optionally version) via initialize. The version
// is ignored — we only need a session type and a label for the popup.
func refineSessionFromInitialize(name, _ string) {
	if name == "" {
		return
	}
	sessionMu.Lock()
	defer sessionMu.Unlock()

	// Re-derive type from the client name — more authoritative than parent process.
	t := normaliseClientType(name)
	if t != "" {
		sessionType = t
	}

	// Rebuild label: <type>/<cwd-base>#<ppid> — keeps it short but identifying.
	cwd, _ := os.Getwd()
	base := filepath.Base(cwd)
	if base == "." || base == "/" || base == "" {
		base = "mcp"
	}
	display := sessionType
	if display == "" {
		display = name
	}
	if envLabel := os.Getenv("MCP_CLIENT_LABEL"); envLabel != "" {
		sessionLabel = envLabel
	} else {
		sessionLabel = fmt.Sprintf("%s/%s#%d", display, base, os.Getppid())
	}
}

// snapshotSession returns a copy of the current session info.
func snapshotSession() map[string]any {
	sessionMu.RLock()
	defer sessionMu.RUnlock()
	return map[string]any{
		"label":       sessionLabel,
		"sessionType": sessionType,
		"connectedAt": sessionStartedAt.UnixMilli(),
		"pid":         os.Getpid(),
		"ppid":        os.Getppid(),
	}
}

// getSessionLabel returns the current session label safely.
func getSessionLabel() string {
	sessionMu.RLock()
	defer sessionMu.RUnlock()
	return sessionLabel
}

// initializeHook returns an AddAfterInitialize hook that refines session info
// from the MCP initialize handshake.
func initializeHook() func(ctx context.Context, id any, req *mcp.InitializeRequest, res *mcp.InitializeResult) {
	return func(_ context.Context, _ any, req *mcp.InitializeRequest, _ *mcp.InitializeResult) {
		if req == nil {
			return
		}
		refineSessionFromInitialize(req.Params.ClientInfo.Name, req.Params.ClientInfo.Version)
		// Re-broadcast to any connected browsers so popups update.
		broadcastClientsToBrowsers()
	}
}

// parentProcessName returns a short name for the parent process, or "" if it
// can't be determined.
func parentProcessName(ppid int) string {
	if ppid <= 0 {
		return ""
	}
	switch runtime.GOOS {
	case "darwin", "linux":
		out, err := exec.Command("ps", "-o", "comm=", "-p", fmt.Sprintf("%d", ppid)).Output()
		if err != nil {
			return ""
		}
		name := strings.TrimSpace(string(out))
		// Strip path prefix; keep just the executable name.
		if idx := strings.LastIndex(name, "/"); idx >= 0 {
			name = name[idx+1:]
		}
		return name
	}
	return ""
}

// guessClientType maps a parent process name to a known MCP host.
func guessClientType(parent string) string {
	p := strings.ToLower(parent)
	switch {
	case strings.Contains(p, "claude") && strings.Contains(p, "code"):
		return "claude-code"
	case strings.Contains(p, "claude"):
		return "claude-desktop"
	case strings.Contains(p, "cursor"):
		return "cursor"
	case strings.Contains(p, "code") || strings.Contains(p, "vscode"):
		return "vscode"
	case strings.Contains(p, "node"):
		return "node"
	}
	if p == "" {
		return "mcp"
	}
	return p
}

// normaliseClientType maps a client name from initialize to one of our known types.
func normaliseClientType(name string) string {
	n := strings.ToLower(name)
	switch {
	case strings.Contains(n, "claude-code") || strings.Contains(n, "claude code"):
		return "claude-code"
	case strings.Contains(n, "claude") && strings.Contains(n, "desktop"):
		return "claude-desktop"
	case strings.Contains(n, "claude-ai") || n == "claude":
		return "claude"
	case strings.Contains(n, "cursor"):
		return "cursor"
	case strings.Contains(n, "vscode") || strings.Contains(n, "vs code"):
		return "vscode"
	}
	return ""
}
