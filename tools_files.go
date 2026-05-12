package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func registerFileTools(s *server.MCPServer) {
	addTool(s,
		mcp.NewTool("set_input_files",
			mcp.WithDescription(
				"Attach files to an <input type=file> via CDP DOM.setFileInputFiles. "+
					"Works on hidden/styled inputs and triggers the change event as if the user picked. "+
					"Paths must be absolute on the MCP server host; ~ is expanded; symlinks are resolved. "+
					"If the selector matches a wrapper/label, we walk to the nearest descendant input[type=file].",
			),
			mcp.WithString("selector", mcp.Required(), mcp.Description("CSS selector of the file input (or its visible label/wrapper)")),
			mcp.WithArray("files", mcp.Required(),
				mcp.Description("Absolute filesystem paths on the MCP server host. Relative paths are rejected. ~/foo is expanded."),
				mcp.Items(map[string]any{"type": "string"}),
			),
			mcp.WithNumber("tabId", mcp.Description("Tab ID (omit for active tab)")),
		),
		handleSetInputFiles,
	)

	addTool(s,
		mcp.NewTool("intercept_file_chooser",
			mcp.WithDescription(
				"Arm or disarm interception of the native file chooser. While armed, the next file-chooser dialog "+
					"is auto-fulfilled with the supplied paths — useful when the agent must click an Upload button "+
					"whose <input type=file> is hidden, dispatched-via-button, lazy-mounted, or cross-frame. "+
					"Workflow: arm with enable=true + files, click the upload control, then disarm with enable=false.",
			),
			mcp.WithBoolean("enable", mcp.Required(), mcp.Description("Arm (true) or disarm (false) interception for this tab")),
			mcp.WithArray("files",
				mcp.Description("Files to auto-attach when a chooser opens. Required when enable=true."),
				mcp.Items(map[string]any{"type": "string"}),
			),
			mcp.WithNumber("tabId", mcp.Description("Tab ID (omit for active tab)")),
		),
		handleInterceptFileChooser,
	)
}

// resolveHostPaths expands ~, requires absolute paths, resolves symlinks via
// realpath, and verifies each entry is an existing regular file. The
// returned slice contains canonical absolute paths suitable for CDP
// DOM.setFileInputFiles, which follows symlinks but reports broken ones
// with unhelpful messages.
func resolveHostPaths(raw any) ([]string, error) {
	arr, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("files: expected an array of strings")
	}
	if len(arr) == 0 {
		return nil, fmt.Errorf("files: empty array")
	}
	home, _ := os.UserHomeDir()
	out := make([]string, 0, len(arr))
	for i, v := range arr {
		s, ok := v.(string)
		if !ok || s == "" {
			return nil, fmt.Errorf("files[%d]: not a non-empty string", i)
		}
		if s == "~" || strings.HasPrefix(s, "~/") {
			if home == "" {
				return nil, fmt.Errorf("files[%d]: cannot expand ~ (no $HOME)", i)
			}
			s = filepath.Join(home, strings.TrimPrefix(s, "~"))
		}
		if !filepath.IsAbs(s) {
			return nil, fmt.Errorf("files[%d]: must be an absolute path on the MCP server host (got %q)", i, s)
		}
		resolved, err := filepath.EvalSymlinks(s)
		if err != nil {
			return nil, fmt.Errorf("files[%d]: %v", i, err)
		}
		info, err := os.Stat(resolved)
		if err != nil {
			return nil, fmt.Errorf("files[%d]: %v", i, err)
		}
		if info.IsDir() {
			return nil, fmt.Errorf("files[%d]: %s is a directory, not a file", i, resolved)
		}
		out = append(out, resolved)
	}
	return out, nil
}

func handleSetInputFiles(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	selector := toString(args["selector"])
	if selector == "" {
		return mcp.NewToolResultError("selector is required"), nil
	}
	paths, err := resolveHostPaths(args["files"])
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	fwd := rawArgs(args)
	fwd["selector"] = selector
	fwd["files"] = paths
	raw, err := send("set_input_files", fwd)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return mcp.NewToolResultText(string(raw)), nil
}

func handleInterceptFileChooser(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	enable := toBool(args["enable"])
	fwd := rawArgs(args)
	fwd["enable"] = enable
	if enable {
		paths, err := resolveHostPaths(args["files"])
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		fwd["files"] = paths
	} else {
		delete(fwd, "files")
	}
	raw, err := send("intercept_file_chooser", fwd)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return mcp.NewToolResultText(string(raw)), nil
}
