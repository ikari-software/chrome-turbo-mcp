package main

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/mark3labs/mcp-go/mcp"
)

// extractText gets the text content from a CallToolResult.
func extractText(t *testing.T, result *mcp.CallToolResult) string {
	t.Helper()
	if result == nil || len(result.Content) == 0 {
		t.Fatal("result has no content")
	}
	b, _ := json.Marshal(result.Content[0])
	var block struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	json.Unmarshal(b, &block)
	return block.Text
}

// mockAnthropicHandler returns an http.Handler that always responds with the given text.
func mockAnthropicHandler(responseText string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		json.NewEncoder(w).Encode(anthropicResponse{
			Content: []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			}{{Type: "text", Text: responseText}},
		})
	}
}
