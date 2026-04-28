package main

import (
	"encoding/json"
	"strings"
)

// toJSON marshals any value to a JSON string.
func toJSON(v any) string {
	switch val := v.(type) {
	case string:
		return val
	case json.RawMessage:
		return string(val)
	case []byte:
		return string(val)
	default:
		b, err := json.MarshalIndent(v, "", "  ")
		if err != nil {
			return "{}"
		}
		return string(b)
	}
}

// contains is a simple string contains check.
func contains(s, substr string) bool {
	return strings.Contains(s, substr)
}

// toInt converts various numeric types to int (handles JSON float64).
func toInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	case json.Number:
		i, _ := n.Int64()
		return int(i)
	default:
		return 0
	}
}

// toFloat converts various numeric types to float64.
func toFloat(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case json.Number:
		f, _ := n.Float64()
		return f
	default:
		return 0
	}
}

// getString extracts a string from a map with a default.
func getString(args map[string]any, key, defaultVal string) string {
	if v, ok := args[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return defaultVal
}

// getInt extracts an int from a map with a default.
func getInt(args map[string]any, key string, defaultVal int) int {
	if v, ok := args[key]; ok && v != nil {
		return toInt(v)
	}
	return defaultVal
}

// getBool extracts a bool from a map with a default.
func getBool(args map[string]any, key string, defaultVal bool) bool {
	if v, ok := args[key]; ok {
		if b, ok := v.(bool); ok {
			return b
		}
	}
	return defaultVal
}

// getArgs extracts the arguments map from a CallToolRequest.
// mcp-go stores params in request.Params.Arguments.
func rawArgs(args map[string]any) map[string]any {
	if args == nil {
		return map[string]any{}
	}
	return args
}

// buildParams creates a params map for the WebSocket send, filtering nil values.
func buildParams(pairs ...any) map[string]any {
	m := make(map[string]any)
	for i := 0; i+1 < len(pairs); i += 2 {
		key, ok := pairs[i].(string)
		if !ok {
			continue
		}
		val := pairs[i+1]
		if val != nil {
			m[key] = val
		}
	}
	return m
}
