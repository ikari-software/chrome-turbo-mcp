package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mark3labs/mcp-go/mcp"
	_ "modernc.org/sqlite"
)

// setupTestDB creates an in-memory SQLite database for testing.
func setupTestDB(t *testing.T) func() {
	t.Helper()
	var err error
	db, err = sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	db.Exec("PRAGMA journal_mode=WAL")
	db.Exec("PRAGMA busy_timeout=3000")
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS custom_tools (
		name        TEXT PRIMARY KEY,
		description TEXT NOT NULL,
		code        TEXT NOT NULL,
		params      TEXT NOT NULL DEFAULT '[]',
		system_prompt TEXT,
		created_at  TEXT NOT NULL DEFAULT (datetime('now'))
	)`)
	if err != nil {
		t.Fatalf("create table: %v", err)
	}
	return func() {
		db.Close()
		db = nil
	}
}

func TestSaveTool(t *testing.T) {
	cleanup := setupTestDB(t)
	defer cleanup()

	tool := CustomTool{
		Name:        "test_tool",
		Description: "A test tool",
		Code:        "return 42",
		Params:      `[{"name":"x","type":"number"}]`,
		CreatedAt:   "2024-01-01T00:00:00Z",
	}
	if err := saveTool(tool); err != nil {
		t.Fatalf("saveTool error: %v", err)
	}

	got, err := getTool("test_tool")
	if err != nil {
		t.Fatalf("getTool error: %v", err)
	}
	if got == nil {
		t.Fatal("getTool returned nil")
	}
	if got.Name != "test_tool" {
		t.Errorf("name = %q, want %q", got.Name, "test_tool")
	}
	if got.Description != "A test tool" {
		t.Errorf("description = %q, want %q", got.Description, "A test tool")
	}
	if got.Code != "return 42" {
		t.Errorf("code = %q, want %q", got.Code, "return 42")
	}
}

func TestSaveTool_Upsert(t *testing.T) {
	cleanup := setupTestDB(t)
	defer cleanup()

	tool := CustomTool{
		Name:        "my_tool",
		Description: "v1",
		Code:        "return 1",
		Params:      "[]",
		CreatedAt:   "2024-01-01T00:00:00Z",
	}
	saveTool(tool)

	// Upsert with updated description
	tool.Description = "v2"
	tool.Code = "return 2"
	if err := saveTool(tool); err != nil {
		t.Fatalf("upsert error: %v", err)
	}

	got, _ := getTool("my_tool")
	if got.Description != "v2" {
		t.Errorf("description = %q, want v2", got.Description)
	}
	if got.Code != "return 2" {
		t.Errorf("code = %q, want return 2", got.Code)
	}
	// Should still be just 1 tool
	if c := toolCount(); c != 1 {
		t.Errorf("toolCount = %d, want 1", c)
	}
}

func TestSaveTool_WithSystemPrompt(t *testing.T) {
	cleanup := setupTestDB(t)
	defer cleanup()

	sp := "You are a field mapper."
	tool := CustomTool{
		Name:         "prompted_tool",
		Description:  "has a system prompt",
		Code:         "return 'hi'",
		Params:       "[]",
		SystemPrompt: &sp,
		CreatedAt:    "2024-01-01T00:00:00Z",
	}
	saveTool(tool)

	got, _ := getTool("prompted_tool")
	if got.SystemPrompt == nil || *got.SystemPrompt != sp {
		t.Errorf("systemPrompt = %v, want %q", got.SystemPrompt, sp)
	}
}

func TestGetTool_NotFound(t *testing.T) {
	cleanup := setupTestDB(t)
	defer cleanup()

	got, err := getTool("nonexistent")
	if err != nil {
		t.Fatalf("getTool error: %v", err)
	}
	if got != nil {
		t.Errorf("expected nil for nonexistent tool, got %v", got)
	}
}

func TestGetAllTools(t *testing.T) {
	cleanup := setupTestDB(t)
	defer cleanup()

	saveTool(CustomTool{Name: "tool_a", Description: "a", Code: "1", Params: "[]", CreatedAt: "2024-01-01T00:00:00Z"})
	saveTool(CustomTool{Name: "tool_b", Description: "b", Code: "2", Params: "[]", CreatedAt: "2024-01-02T00:00:00Z"})
	saveTool(CustomTool{Name: "tool_c", Description: "c", Code: "3", Params: "[]", CreatedAt: "2024-01-03T00:00:00Z"})

	all, err := getAllTools()
	if err != nil {
		t.Fatalf("getAllTools error: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("getAllTools returned %d tools, want 3", len(all))
	}
	// Should be ordered by created_at
	if all[0].Name != "tool_a" || all[1].Name != "tool_b" || all[2].Name != "tool_c" {
		t.Errorf("tools not ordered: %s, %s, %s", all[0].Name, all[1].Name, all[2].Name)
	}
}

func TestDeleteTool(t *testing.T) {
	cleanup := setupTestDB(t)
	defer cleanup()

	saveTool(CustomTool{Name: "doomed", Description: "x", Code: "x", Params: "[]", CreatedAt: "2024-01-01T00:00:00Z"})

	deleted, err := deleteTool("doomed")
	if err != nil {
		t.Fatalf("deleteTool error: %v", err)
	}
	if !deleted {
		t.Error("deleteTool should return true for existing tool")
	}

	deleted, err = deleteTool("doomed")
	if err != nil {
		t.Fatalf("deleteTool error: %v", err)
	}
	if deleted {
		t.Error("deleteTool should return false for already-deleted tool")
	}

	if c := toolCount(); c != 0 {
		t.Errorf("toolCount = %d, want 0", c)
	}
}

func TestDeleteTool_NotFound(t *testing.T) {
	cleanup := setupTestDB(t)
	defer cleanup()

	deleted, err := deleteTool("nonexistent")
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	if deleted {
		t.Error("should return false for nonexistent")
	}
}

func TestToolCount(t *testing.T) {
	cleanup := setupTestDB(t)
	defer cleanup()

	if c := toolCount(); c != 0 {
		t.Errorf("empty db count = %d", c)
	}
	saveTool(CustomTool{Name: "a", Description: "a", Code: "a", Params: "[]", CreatedAt: "2024-01-01T00:00:00Z"})
	saveTool(CustomTool{Name: "b", Description: "b", Code: "b", Params: "[]", CreatedAt: "2024-01-01T00:00:00Z"})
	if c := toolCount(); c != 2 {
		t.Errorf("count after 2 inserts = %d", c)
	}
}

func TestJoin(t *testing.T) {
	tests := []struct {
		parts []string
		sep   string
		want  string
	}{
		{nil, ", ", ""},
		{[]string{}, ", ", ""},
		{[]string{"a"}, ", ", "a"},
		{[]string{"a", "b", "c"}, ", ", "a, b, c"},
		{[]string{"x", "y"}, "-", "x-y"},
	}
	for _, tt := range tests {
		if got := join(tt.parts, tt.sep); got != tt.want {
			t.Errorf("join(%v, %q) = %q, want %q", tt.parts, tt.sep, got, tt.want)
		}
	}
}

func TestGetConfigDir_XDG(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "/tmp/test-xdg")
	got := getConfigDir()
	want := filepath.Join("/tmp/test-xdg", "chrome-turbo-mcp")
	if got != want {
		t.Errorf("getConfigDir() = %q, want %q", got, want)
	}
}

func TestGetConfigDir_Default(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("APPDATA", "")
	got := getConfigDir()
	home, _ := os.UserHomeDir()
	want := filepath.Join(home, ".config", "chrome-turbo-mcp")
	if got != want {
		t.Errorf("getConfigDir() = %q, want %q", got, want)
	}
}

// --- MCP Handler Tests ---

func TestHandleCreateTool(t *testing.T) {
	cleanup := setupTestDB(t)
	defer cleanup()

	req := mcp.CallToolRequest{
		Params: mcp.CallToolParams{
			Name: "create_tool",
			Arguments: map[string]any{
				"name":        "my_tool",
				"description": "does stuff",
				"code":        "return params.x + 1",
			},
		},
	}

	result, err := handleCreateTool(context.Background(), req)
	if err != nil {
		t.Fatalf("handleCreateTool error: %v", err)
	}
	text := extractText(t, result)
	if !strings.Contains(text, "my_tool") {
		t.Errorf("response should mention tool name: %q", text)
	}

	// Verify in DB
	tool, _ := getTool("my_tool")
	if tool == nil {
		t.Fatal("tool not found in DB after create")
	}
	if tool.Code != "return params.x + 1" {
		t.Errorf("code = %q", tool.Code)
	}
}

func TestHandleCreateTool_WithParams(t *testing.T) {
	cleanup := setupTestDB(t)
	defer cleanup()

	req := mcp.CallToolRequest{
		Params: mcp.CallToolParams{
			Name: "create_tool",
			Arguments: map[string]any{
				"name":        "parameterized",
				"description": "has params",
				"code":        "return params.x",
				"params": []any{
					map[string]any{"name": "x", "type": "number", "description": "input"},
				},
			},
		},
	}

	result, err := handleCreateTool(context.Background(), req)
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	text := extractText(t, result)
	if !strings.Contains(text, "x: ...") {
		t.Errorf("response should include param usage hint: %q", text)
	}

	tool, _ := getTool("parameterized")
	var params []map[string]any
	json.Unmarshal([]byte(tool.Params), &params)
	if len(params) != 1 || params[0]["name"] != "x" {
		t.Errorf("params = %s", tool.Params)
	}
}

func TestHandleCreateTool_NoDB(t *testing.T) {
	origDB := db
	db = nil
	defer func() { db = origDB }()

	req := mcp.CallToolRequest{
		Params: mcp.CallToolParams{
			Arguments: map[string]any{"name": "x", "description": "x", "code": "x"},
		},
	}
	result, err := handleCreateTool(context.Background(), req)
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	if !result.IsError {
		t.Error("expected error result when db is nil")
	}
}

func TestHandleListCustomTools(t *testing.T) {
	cleanup := setupTestDB(t)
	defer cleanup()

	saveTool(CustomTool{Name: "tool_x", Description: "x", Code: "x", Params: "[]", CreatedAt: "2024-01-01T00:00:00Z"})
	saveTool(CustomTool{Name: "tool_y", Description: "y", Code: "y", Params: "[]", CreatedAt: "2024-01-02T00:00:00Z"})

	result, err := handleListCustomTools(context.Background(), mcp.CallToolRequest{})
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	text := extractText(t, result)

	var resp struct {
		Count int `json:"count"`
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if err := json.Unmarshal([]byte(text), &resp); err != nil {
		t.Fatalf("failed to parse response: %v\nraw: %s", err, text)
	}
	if resp.Count != 2 {
		t.Errorf("count = %d, want 2", resp.Count)
	}
}

func TestHandleDeleteTool_Handler(t *testing.T) {
	cleanup := setupTestDB(t)
	defer cleanup()

	saveTool(CustomTool{Name: "to_delete", Description: "x", Code: "x", Params: "[]", CreatedAt: "2024-01-01T00:00:00Z"})

	req := mcp.CallToolRequest{
		Params: mcp.CallToolParams{
			Arguments: map[string]any{"name": "to_delete"},
		},
	}
	result, err := handleDeleteTool(context.Background(), req)
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	text := extractText(t, result)
	if !strings.Contains(text, "to_delete") {
		t.Errorf("response should mention deleted tool: %q", text)
	}

	// Verify deleted
	if c := toolCount(); c != 0 {
		t.Errorf("toolCount after delete = %d", c)
	}
}

func TestHandleDeleteTool_NotFound(t *testing.T) {
	cleanup := setupTestDB(t)
	defer cleanup()

	req := mcp.CallToolRequest{
		Params: mcp.CallToolParams{
			Arguments: map[string]any{"name": "ghost"},
		},
	}
	result, err := handleDeleteTool(context.Background(), req)
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	if !result.IsError {
		t.Error("expected error for nonexistent tool")
	}
}

func TestInitDB(t *testing.T) {
	origDB := db
	defer func() { db = origDB }()
	db = nil

	tmpDir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", tmpDir)

	err := initDB()
	if err != nil {
		t.Fatalf("initDB error: %v", err)
	}
	if db == nil {
		t.Fatal("db should be initialized")
	}

	// Verify table exists by inserting
	countBefore := toolCount()
	err = saveTool(CustomTool{Name: "init_db_test_tool", Description: "x", Code: "x", Params: "[]", CreatedAt: "2024-01-01T00:00:00Z"})
	if err != nil {
		t.Fatalf("saveTool after initDB: %v", err)
	}
	if c := toolCount(); c != countBefore+1 {
		t.Errorf("toolCount = %d, want %d", c, countBefore+1)
	}

	db.Close()
}

func TestMigrateLegacyJSON(t *testing.T) {
	cleanup := setupTestDB(t)
	defer cleanup()

	// Write a legacy JSON file
	tmpDir := t.TempDir()
	legacyData := `[{"name":"legacy_tool","description":"from json","code":"return 1","params":[],"systemPrompt":"","createdAt":"2024-01-01T00:00:00Z"}]`
	os.WriteFile(filepath.Join(tmpDir, "custom-tools.json"), []byte(legacyData), 0644)

	// Change to tmpDir so migrateLegacyJSON can find custom-tools.json
	origDir, _ := os.Getwd()
	os.Chdir(tmpDir)
	defer os.Chdir(origDir)

	migrateLegacyJSON()

	got, _ := getTool("legacy_tool")
	if got == nil {
		t.Fatal("legacy tool not migrated")
	}
	if got.Description != "from json" {
		t.Errorf("description = %q, want %q", got.Description, "from json")
	}
}
