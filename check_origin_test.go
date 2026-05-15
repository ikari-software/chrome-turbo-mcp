package main

import (
	"net/http"
	"testing"
)

func TestCheckOrigin(t *testing.T) {
	cases := []struct {
		origin string
		ok     bool
	}{
		{"", true},
		{"http://127.0.0.1:3000", true},
		{"http://localhost:8080", true},
		{"https://localhost", true},
		{"chrome-extension://abcdefg", true},
		{"moz-extension://5abe3c16-4ee6-44d8-910c-deadbeef", true},
		{"http://evil.example", false},
		{"safari-web-extension://x", false},
	}
	for _, c := range cases {
		req, _ := http.NewRequest("GET", "/", nil)
		if c.origin != "" {
			req.Header.Set("Origin", c.origin)
		}
		got := upgrader.CheckOrigin(req)
		if got != c.ok {
			t.Errorf("origin %q: got %v, want %v", c.origin, got, c.ok)
		}
	}
}
