package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// newMockAnthropicServer creates a test HTTP server that mimics the Anthropic Messages API.
func newMockAnthropicServer(t *testing.T, responseText string, statusCode int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify headers
		if r.Header.Get("x-api-key") == "" {
			t.Error("missing x-api-key header")
		}
		if r.Header.Get("anthropic-version") != "2023-06-01" {
			t.Errorf("unexpected anthropic-version: %s", r.Header.Get("anthropic-version"))
		}
		if r.Header.Get("content-type") != "application/json" {
			t.Errorf("unexpected content-type: %s", r.Header.Get("content-type"))
		}

		// Verify body is valid JSON
		body, _ := io.ReadAll(r.Body)
		var req anthropicRequest
		if err := json.Unmarshal(body, &req); err != nil {
			t.Errorf("invalid request body: %v", err)
		}
		if req.Model == "" {
			t.Error("model should be set")
		}
		if req.MaxTokens != 1024 {
			t.Errorf("max_tokens = %d, want 1024", req.MaxTokens)
		}

		w.WriteHeader(statusCode)
		json.NewEncoder(w).Encode(anthropicResponse{
			Content: []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			}{
				{Type: "text", Text: responseText},
			},
		})
	}))
}

func newTestHaikuClient(serverURL string) *HaikuClient {
	return &HaikuClient{
		apiKey:     "test-key",
		httpClient: &http.Client{Timeout: 5 * time.Second},
		model:      haikuModel,
	}
}

func TestHaikuAsk_Success(t *testing.T) {
	srv := newMockAnthropicServer(t, "The page shows a login form", 200)
	defer srv.Close()

	h := newTestHaikuClient(srv.URL)
	// Override the API URL by making the client hit our mock server
	// We need to patch the request construction — simplest: use a custom RoundTripper
	h.httpClient.Transport = &redirectTransport{url: srv.URL}

	answer, err := h.ask("what is on the page?", `{"title":"Login"}`, "", "")
	if err != nil {
		t.Fatalf("ask() error: %v", err)
	}
	if answer != "The page shows a login form" {
		t.Errorf("ask() = %q, want %q", answer, "The page shows a login form")
	}
}

func TestHaikuAsk_WithImage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req anthropicRequest
		json.Unmarshal(body, &req)

		// Verify image block is present
		if len(req.Messages) == 0 || len(req.Messages[0].Content) < 3 {
			t.Errorf("expected at least 3 content blocks (image + context + question), got %d", len(req.Messages[0].Content))
		}
		if req.Messages[0].Content[0].Type != "image" {
			t.Errorf("first block type = %q, want image", req.Messages[0].Content[0].Type)
		}
		if req.Messages[0].Content[0].Source == nil {
			t.Error("image block should have source")
		}

		w.WriteHeader(200)
		json.NewEncoder(w).Encode(anthropicResponse{
			Content: []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			}{{Type: "text", Text: "analyzed"}},
		})
	}))
	defer srv.Close()

	h := newTestHaikuClient(srv.URL)
	h.httpClient.Transport = &redirectTransport{url: srv.URL}

	answer, err := h.ask("what's this?", "context", "base64imagedata", "")
	if err != nil {
		t.Fatalf("ask() with image error: %v", err)
	}
	if answer != "analyzed" {
		t.Errorf("answer = %q, want %q", answer, "analyzed")
	}
}

func TestHaikuAsk_CustomSystemPrompt(t *testing.T) {
	customPrompt := "You are a PDF field mapper."
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req anthropicRequest
		json.Unmarshal(body, &req)
		if req.System != customPrompt {
			t.Errorf("system = %q, want %q", req.System, customPrompt)
		}
		w.WriteHeader(200)
		json.NewEncoder(w).Encode(anthropicResponse{
			Content: []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			}{{Type: "text", Text: "custom response"}},
		})
	}))
	defer srv.Close()

	h := newTestHaikuClient(srv.URL)
	h.httpClient.Transport = &redirectTransport{url: srv.URL}

	answer, err := h.ask("analyze", "data", "", customPrompt)
	if err != nil {
		t.Fatalf("ask() error: %v", err)
	}
	if answer != "custom response" {
		t.Errorf("answer = %q, want %q", answer, "custom response")
	}
}

func TestHaikuAsk_APIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(429)
		w.Write([]byte(`{"error":{"message":"rate limited"}}`))
	}))
	defer srv.Close()

	h := newTestHaikuClient(srv.URL)
	h.httpClient.Transport = &redirectTransport{url: srv.URL}

	_, err := h.ask("question", "context", "", "")
	if err == nil {
		t.Fatal("expected error for 429 response")
	}
	if !strings.Contains(err.Error(), "429") {
		t.Errorf("error should contain status code 429: %v", err)
	}
}

func TestHaikuAsk_ContextTruncation(t *testing.T) {
	var receivedLen int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req anthropicRequest
		json.Unmarshal(body, &req)
		// Find the context block
		for _, block := range req.Messages[0].Content {
			if strings.HasPrefix(block.Text, "Context data:") {
				receivedLen = len(block.Text)
			}
		}
		w.WriteHeader(200)
		json.NewEncoder(w).Encode(anthropicResponse{
			Content: []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			}{{Type: "text", Text: "ok"}},
		})
	}))
	defer srv.Close()

	h := newTestHaikuClient(srv.URL)
	h.httpClient.Transport = &redirectTransport{url: srv.URL}

	longContext := strings.Repeat("x", 100000)
	_, err := h.ask("q", longContext, "", "")
	if err != nil {
		t.Fatalf("ask() error: %v", err)
	}
	// "Context data:\n" prefix is 15 chars + 80000 truncated = 80015
	if receivedLen > 80020 {
		t.Errorf("context should be truncated to ~80k, got %d", receivedLen)
	}
}

func TestMaybeAsk_NoQuestion(t *testing.T) {
	raw := json.RawMessage(`{"data":"test"}`)
	result, err := maybeAsk(raw, "", "")
	if err != nil {
		t.Fatalf("maybeAsk error: %v", err)
	}
	text := extractText(t, result)
	if text != `{"data":"test"}` {
		t.Errorf("maybeAsk with no question should return raw data, got %q", text)
	}
}

func TestMaybeAsk_NoHaiku(t *testing.T) {
	origHaiku := haiku
	haiku = nil
	defer func() { haiku = origHaiku }()

	raw := json.RawMessage(`{"data":"test"}`)
	result, err := maybeAsk(raw, "what is this?", "")
	if err != nil {
		t.Fatalf("maybeAsk error: %v", err)
	}
	text := extractText(t, result)
	if !strings.Contains(text, "Haiku unavailable") {
		t.Errorf("expected Haiku unavailable message, got %q", text)
	}
	if !strings.Contains(text, `{"data":"test"}`) {
		t.Errorf("should include raw data, got %q", text)
	}
}

func TestMaybeAskWithSystem_NoHaiku(t *testing.T) {
	origHaiku := haiku
	haiku = nil
	defer func() { haiku = origHaiku }()

	raw := json.RawMessage(`"result"`)
	result, err := maybeAskWithSystem(raw, "analyze", "custom prompt", "")
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	text := extractText(t, result)
	if !strings.Contains(text, "Haiku unavailable") {
		t.Errorf("expected Haiku unavailable, got %q", text)
	}
}

func TestMaybeAsk_WithHaiku(t *testing.T) {
	srv := newMockAnthropicServer(t, "haiku says hello", 200)
	defer srv.Close()

	origHaiku := haiku
	haiku = newTestHaikuClient(srv.URL)
	haiku.httpClient.Transport = &redirectTransport{url: srv.URL}
	defer func() { haiku = origHaiku }()

	raw := json.RawMessage(`{"page":"test"}`)
	result, err := maybeAsk(raw, "what is this?", "")
	if err != nil {
		t.Fatalf("maybeAsk error: %v", err)
	}
	text := extractText(t, result)
	if text != "haiku says hello" {
		t.Errorf("maybeAsk = %q, want %q", text, "haiku says hello")
	}
}

func TestInitHaiku_WithKey(t *testing.T) {
	origHaiku := haiku
	defer func() { haiku = origHaiku }()

	haiku = nil
	t.Setenv("ANTHROPIC_API_KEY", "test-key-123")
	t.Setenv("CLAUDE_API_KEY", "")
	initHaiku()
	if haiku == nil {
		t.Fatal("haiku should be initialized with ANTHROPIC_API_KEY")
	}
	if haiku.apiKey != "test-key-123" {
		t.Errorf("apiKey = %q, want test-key-123", haiku.apiKey)
	}
}

func TestInitHaiku_WithClaudeKey(t *testing.T) {
	origHaiku := haiku
	defer func() { haiku = origHaiku }()

	haiku = nil
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("CLAUDE_API_KEY", "claude-key-456")
	initHaiku()
	if haiku == nil {
		t.Fatal("haiku should be initialized with CLAUDE_API_KEY")
	}
	if haiku.apiKey != "claude-key-456" {
		t.Errorf("apiKey = %q, want claude-key-456", haiku.apiKey)
	}
}

func TestInitHaiku_NoKey(t *testing.T) {
	origHaiku := haiku
	defer func() { haiku = origHaiku }()

	haiku = nil
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("CLAUDE_API_KEY", "")
	initHaiku()
	if haiku != nil {
		t.Error("haiku should be nil when no API key set")
	}
}

// redirectTransport redirects all requests to the given test server URL.
type redirectTransport struct {
	url string
}

func (rt *redirectTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	newReq := req.Clone(req.Context())
	newReq.URL, _ = req.URL.Parse(rt.url)
	return http.DefaultTransport.RoundTrip(newReq)
}
