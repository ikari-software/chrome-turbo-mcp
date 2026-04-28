package main

import (
	"encoding/json"
	"testing"
)

func TestToJSON_String(t *testing.T) {
	got := toJSON("hello")
	if got != "hello" {
		t.Errorf("toJSON(string) = %q, want %q", got, "hello")
	}
}

func TestToJSON_RawMessage(t *testing.T) {
	raw := json.RawMessage(`{"key":"value"}`)
	got := toJSON(raw)
	if got != `{"key":"value"}` {
		t.Errorf("toJSON(RawMessage) = %q, want %q", got, `{"key":"value"}`)
	}
}

func TestToJSON_Bytes(t *testing.T) {
	got := toJSON([]byte("bytes"))
	if got != "bytes" {
		t.Errorf("toJSON([]byte) = %q, want %q", got, "bytes")
	}
}

func TestToJSON_Map(t *testing.T) {
	m := map[string]any{"a": 1, "b": "two"}
	got := toJSON(m)
	var parsed map[string]any
	if err := json.Unmarshal([]byte(got), &parsed); err != nil {
		t.Fatalf("toJSON(map) produced invalid JSON: %v", err)
	}
	if parsed["b"] != "two" {
		t.Errorf("expected b=two, got %v", parsed["b"])
	}
}

func TestToJSON_UnmarshalableReturnsEmpty(t *testing.T) {
	// channels can't be marshaled
	ch := make(chan int)
	got := toJSON(ch)
	if got != "{}" {
		t.Errorf("toJSON(chan) = %q, want %q", got, "{}")
	}
}

func TestContains(t *testing.T) {
	tests := []struct {
		s, sub string
		want   bool
	}{
		{"hello world", "world", true},
		{"hello world", "mars", false},
		{"", "", true},
		{"abc", "", true},
		{"", "x", false},
	}
	for _, tt := range tests {
		if got := contains(tt.s, tt.sub); got != tt.want {
			t.Errorf("contains(%q, %q) = %v, want %v", tt.s, tt.sub, got, tt.want)
		}
	}
}

func TestToInt(t *testing.T) {
	tests := []struct {
		name string
		v    any
		want int
	}{
		{"float64", float64(42.7), 42},
		{"int", int(10), 10},
		{"int64", int64(99), 99},
		{"json.Number", json.Number("123"), 123},
		{"string", "nope", 0},
		{"nil", nil, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := toInt(tt.v); got != tt.want {
				t.Errorf("toInt(%v) = %d, want %d", tt.v, got, tt.want)
			}
		})
	}
}

func TestToFloat(t *testing.T) {
	tests := []struct {
		name string
		v    any
		want float64
	}{
		{"float64", float64(3.14), 3.14},
		{"int", int(5), 5.0},
		{"int64", int64(100), 100.0},
		{"json.Number", json.Number("2.5"), 2.5},
		{"string", "nope", 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := toFloat(tt.v); got != tt.want {
				t.Errorf("toFloat(%v) = %f, want %f", tt.v, got, tt.want)
			}
		})
	}
}

func TestGetString(t *testing.T) {
	args := map[string]any{"name": "alice", "count": 42}
	if got := getString(args, "name", "default"); got != "alice" {
		t.Errorf("getString existing = %q, want alice", got)
	}
	if got := getString(args, "missing", "default"); got != "default" {
		t.Errorf("getString missing = %q, want default", got)
	}
	if got := getString(args, "count", "default"); got != "default" {
		t.Errorf("getString wrong type = %q, want default", got)
	}
}

func TestGetInt(t *testing.T) {
	args := map[string]any{"n": float64(7), "s": "not a number"}
	if got := getInt(args, "n", 0); got != 7 {
		t.Errorf("getInt existing = %d, want 7", got)
	}
	if got := getInt(args, "missing", 99); got != 99 {
		t.Errorf("getInt missing = %d, want 99", got)
	}
	if got := getInt(args, "s", 99); got != 0 {
		t.Errorf("getInt string = %d, want 0 (toInt returns 0 for string)", got)
	}
}

func TestGetBool(t *testing.T) {
	args := map[string]any{"flag": true, "other": "yes"}
	if got := getBool(args, "flag", false); got != true {
		t.Errorf("getBool existing = %v, want true", got)
	}
	if got := getBool(args, "missing", true); got != true {
		t.Errorf("getBool missing = %v, want true", got)
	}
	if got := getBool(args, "other", false); got != false {
		t.Errorf("getBool wrong type = %v, want false", got)
	}
}

func TestRawArgs(t *testing.T) {
	if got := rawArgs(nil); got == nil || len(got) != 0 {
		t.Errorf("rawArgs(nil) should return empty map, got %v", got)
	}
	m := map[string]any{"a": 1}
	if got := rawArgs(m); got["a"] != 1 {
		t.Errorf("rawArgs should pass through, got %v", got)
	}
}

func TestBuildParams(t *testing.T) {
	m := buildParams("a", 1, "b", nil, "c", "hello")
	if m["a"] != 1 {
		t.Errorf("expected a=1, got %v", m["a"])
	}
	if _, ok := m["b"]; ok {
		t.Error("nil value should be filtered out")
	}
	if m["c"] != "hello" {
		t.Errorf("expected c=hello, got %v", m["c"])
	}
}

func TestBuildParams_OddPairs(t *testing.T) {
	// Odd number of args — last one is ignored
	m := buildParams("a", 1, "b")
	if m["a"] != 1 {
		t.Errorf("expected a=1, got %v", m["a"])
	}
	if _, ok := m["b"]; ok {
		t.Error("odd trailing key should be ignored")
	}
}
