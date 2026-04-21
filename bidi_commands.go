package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"runtime"
	"sync"
)

// =============================================================================
// Browsing Context commands
// =============================================================================

type BiDiContextInfo struct {
	Context  string            `json:"context"`
	URL      string            `json:"url"`
	Children []BiDiContextInfo `json:"children,omitempty"`
}

func bidiGetTree(ctx context.Context) ([]BiDiContextInfo, error) {
	c, err := requireBiDi()
	if err != nil {
		return nil, err
	}
	raw, err := c.Send(ctx, "browsingContext.getTree", map[string]any{})
	if err != nil {
		return nil, err
	}
	var result struct {
		Contexts []BiDiContextInfo `json:"contexts"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("parse browsingContext.getTree: %w", err)
	}
	return result.Contexts, nil
}

func bidiNavigate(ctx context.Context, contextID string, url string) error {
	c, err := requireBiDi()
	if err != nil {
		return err
	}
	_, err = c.Send(ctx, "browsingContext.navigate", map[string]any{
		"context": contextID,
		"url":     url,
		"wait":    "interactive",
	})
	return err
}

func bidiReload(ctx context.Context, contextID string, ignoreCache bool) error {
	c, err := requireBiDi()
	if err != nil {
		return err
	}
	params := map[string]any{
		"context": contextID,
		"wait":    "interactive",
	}
	if ignoreCache {
		params["ignoreCache"] = true
	}
	_, err = c.Send(ctx, "browsingContext.reload", params)
	return err
}

// bidiScreenshot captures a screenshot via BiDi and returns raw JPEG bytes (base64-decoded).
func bidiScreenshot(ctx context.Context, contextID string, quality int) ([]byte, error) {
	c, err := requireBiDi()
	if err != nil {
		return nil, err
	}
	raw, err := c.Send(ctx, "browsingContext.captureScreenshot", map[string]any{
		"context": contextID,
		"format": map[string]any{
			"type":    "image/jpeg",
			"quality": float64(quality) / 100.0,
		},
	})
	if err != nil {
		return nil, err
	}
	var result struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("parse screenshot: %w", err)
	}
	return base64.StdEncoding.DecodeString(result.Data)
}

func bidiPrint(ctx context.Context, contextID string, landscape bool, scale float64) ([]byte, error) {
	c, err := requireBiDi()
	if err != nil {
		return nil, err
	}
	raw, err := c.Send(ctx, "browsingContext.print", map[string]any{
		"context":    contextID,
		"landscape":  landscape,
		"scale":      scale,
		"background": true,
	})
	if err != nil {
		return nil, err
	}
	var result struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("parse print: %w", err)
	}
	return base64.StdEncoding.DecodeString(result.Data)
}

// =============================================================================
// Input commands
// =============================================================================

func bidiClick(ctx context.Context, contextID string, x, y float64, button string) error {
	c, err := requireBiDi()
	if err != nil {
		return err
	}
	if button == "" {
		button = "left"
	}
	// BiDi input.performActions with pointer source
	_, err = c.Send(ctx, "input.performActions", map[string]any{
		"context": contextID,
		"actions": []map[string]any{
			{
				"type": "pointer",
				"id":   "mouse",
				"parameters": map[string]any{
					"pointerType": "mouse",
				},
				"actions": []map[string]any{
					{"type": "pointerMove", "x": int(x), "y": int(y)},
					{"type": "pointerDown", "button": pointerButton(button)},
					{"type": "pointerUp", "button": pointerButton(button)},
				},
			},
		},
	})
	return err
}

func bidiType(ctx context.Context, contextID string, text string) error {
	c, err := requireBiDi()
	if err != nil {
		return err
	}
	// Build key actions: for each character, keyDown + keyUp
	actions := make([]map[string]any, 0, len(text)*2)
	for _, ch := range text {
		s := string(ch)
		actions = append(actions,
			map[string]any{"type": "keyDown", "value": s},
			map[string]any{"type": "keyUp", "value": s},
		)
	}
	_, err = c.Send(ctx, "input.performActions", map[string]any{
		"context": contextID,
		"actions": []map[string]any{
			{
				"type":    "key",
				"id":      "keyboard",
				"actions": actions,
			},
		},
	})
	return err
}

// bidiKey presses a special key (Enter, Escape, ArrowDown, etc.)
func bidiKey(ctx context.Context, contextID string, key string) error {
	c, err := requireBiDi()
	if err != nil {
		return err
	}
	value := keyToUnicode(key)
	_, err = c.Send(ctx, "input.performActions", map[string]any{
		"context": contextID,
		"actions": []map[string]any{
			{
				"type": "key",
				"id":   "keyboard",
				"actions": []map[string]any{
					{"type": "keyDown", "value": value},
					{"type": "keyUp", "value": value},
				},
			},
		},
	})
	return err
}

// bidiKeyboardRawActions sends a custom key action sequence (modifier chords, etc.).
func bidiKeyboardRawActions(ctx context.Context, contextID string, actions []map[string]any) error {
	c, err := requireBiDi()
	if err != nil {
		return err
	}
	_, err = c.Send(ctx, "input.performActions", map[string]any{
		"context": contextID,
		"actions": []map[string]any{
			{
				"type":    "key",
				"id":      "keyboard",
				"actions": actions,
			},
		},
	})
	return err
}

// bidiSelectAllClear selects all text in the focused field and deletes it (Ctrl/Cmd+A, Backspace).
func bidiSelectAllClear(ctx context.Context, contextID string) error {
	mod := "Control"
	if runtime.GOOS == "darwin" {
		mod = "Meta"
	}
	modVal := keyToUnicode(mod)
	aVal := "a"
	bk := keyToUnicode("Backspace")
	actions := []map[string]any{
		{"type": "keyDown", "value": modVal},
		{"type": "keyDown", "value": aVal},
		{"type": "keyUp", "value": aVal},
		{"type": "keyUp", "value": modVal},
		{"type": "keyDown", "value": bk},
		{"type": "keyUp", "value": bk},
	}
	return bidiKeyboardRawActions(ctx, contextID, actions)
}

func bidiScroll(ctx context.Context, contextID string, x, y, deltaX, deltaY float64) error {
	c, err := requireBiDi()
	if err != nil {
		return err
	}
	_, err = c.Send(ctx, "input.performActions", map[string]any{
		"context": contextID,
		"actions": []map[string]any{
			{
				"type": "wheel",
				"id":   "wheel",
				"actions": []map[string]any{
					{
						"type":   "scroll",
						"x":      int(x),
						"y":      int(y),
						"deltaX": int(deltaX),
						"deltaY": int(deltaY),
					},
				},
			},
		},
	})
	return err
}

// =============================================================================
// Script commands
// =============================================================================

func bidiEvaluate(ctx context.Context, contextID string, expression string) (json.RawMessage, error) {
	c, err := requireBiDi()
	if err != nil {
		return nil, err
	}
	raw, err := c.Send(ctx, "script.evaluate", map[string]any{
		"expression":      expression,
		"target":          map[string]any{"context": contextID},
		"awaitPromise":    true,
		"resultOwnership": "none",
	})
	if err != nil {
		return nil, err
	}
	return raw, nil
}

func bidiAddPreloadScript(ctx context.Context, script string) (string, error) {
	c, err := requireBiDi()
	if err != nil {
		return "", err
	}
	raw, err := c.Send(ctx, "script.addPreloadScript", map[string]any{
		"functionDeclaration": fmt.Sprintf("() => { %s }", script),
	})
	if err != nil {
		return "", err
	}
	var result struct {
		Script string `json:"script"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return "", err
	}
	return result.Script, nil
}

// =============================================================================
// Storage (cookies) commands
// =============================================================================

func bidiGetCookies(ctx context.Context) (json.RawMessage, error) {
	c, err := requireBiDi()
	if err != nil {
		return nil, err
	}
	return c.Send(ctx, "storage.getCookies", map[string]any{})
}

func bidiSetCookie(ctx context.Context, name, value, domain, path string, secure, httpOnly bool, sameSite string, expires float64) error {
	c, err := requireBiDi()
	if err != nil {
		return err
	}
	cookie := map[string]any{
		"name":   name,
		"value":  map[string]any{"type": "string", "value": value},
		"domain": domain,
		"path":   path,
	}
	if secure {
		cookie["secure"] = true
	}
	if httpOnly {
		cookie["httpOnly"] = true
	}
	if sameSite != "" {
		cookie["sameSite"] = sameSite
	}
	if expires > 0 {
		cookie["expiry"] = int64(expires)
	}
	_, err = c.Send(ctx, "storage.setCookie", map[string]any{
		"cookie": cookie,
	})
	return err
}

func bidiDeleteCookies(ctx context.Context, name, domain string) error {
	c, err := requireBiDi()
	if err != nil {
		return err
	}
	filter := map[string]any{}
	if name != "" {
		filter["name"] = name
	}
	if domain != "" {
		filter["domain"] = domain
	}
	_, err = c.Send(ctx, "storage.deleteCookies", map[string]any{
		"filter": filter,
	})
	return err
}

// =============================================================================
// Network commands
// =============================================================================

var (
	bidiSubscribeMu             sync.Mutex
	bidiNetworkSubscribedClient *BiDiClient
	bidiConsoleSubscribedClient *BiDiClient
)

func bidiNetworkEnable(ctx context.Context) (string, error) {
	c, err := requireBiDi()
	if err != nil {
		return "", err
	}
	bidiSubscribeMu.Lock()
	defer bidiSubscribeMu.Unlock()
	if bidiNetworkSubscribedClient != c {
		err = c.Subscribe(ctx, []string{
			"network.beforeRequestSent",
			"network.responseStarted",
			"network.responseCompleted",
			"network.fetchError",
		})
		if err != nil {
			return "", err
		}
		bidiNetworkSubscribedClient = c
	}
	return "bidi-network", nil
}

// =============================================================================
// Emulation commands
// =============================================================================

func bidiSetViewport(ctx context.Context, contextID string, width, height int) error {
	c, err := requireBiDi()
	if err != nil {
		return err
	}
	_, err = c.Send(ctx, "browsingContext.setViewport", map[string]any{
		"context": contextID,
		"viewport": map[string]any{
			"width":  width,
			"height": height,
		},
	})
	return err
}

func bidiSetUserAgent(ctx context.Context, userAgent string) error {
	c, err := requireBiDi()
	if err != nil {
		return err
	}
	_, err = c.Send(ctx, "emulation.setUserAgentOverride", map[string]any{
		"userAgent": userAgent,
	})
	return err
}

func bidiSetGeolocation(ctx context.Context, lat, lng, accuracy float64) error {
	c, err := requireBiDi()
	if err != nil {
		return err
	}
	_, err = c.Send(ctx, "emulation.setGeolocationOverride", map[string]any{
		"coordinates": map[string]any{
			"latitude":  lat,
			"longitude": lng,
			"accuracy":  accuracy,
		},
	})
	return err
}

// =============================================================================
// Log commands
// =============================================================================

// BiDiLogEntry represents a console log entry from the browser.
type BiDiLogEntry struct {
	Level     string `json:"level"`
	Text      string `json:"text"`
	Timestamp int64  `json:"timestamp"`
	Method    string `json:"method,omitempty"`
	Source    string `json:"source,omitempty"`
}

// bidiConsoleSubscribeOnce subscribes to log events once per BiDi client (idempotent).
func bidiConsoleSubscribeOnce(ctx context.Context) error {
	c, err := requireBiDi()
	if err != nil {
		return err
	}
	bidiSubscribeMu.Lock()
	defer bidiSubscribeMu.Unlock()
	if bidiConsoleSubscribedClient != c {
		if err := c.Subscribe(ctx, []string{"log.entryAdded"}); err != nil {
			return err
		}
		bidiConsoleSubscribedClient = c
	}
	return nil
}

// =============================================================================
// Helpers
// =============================================================================

// pointerButton maps button names to BiDi button indices.
func pointerButton(name string) int {
	switch name {
	case "left":
		return 0
	case "middle":
		return 1
	case "right":
		return 2
	default:
		return 0
	}
}

// keyToUnicode maps key names to WebDriver BiDi key values (Unicode PUA).
func keyToUnicode(key string) string {
	m := map[string]string{
		"Enter":      "\uE006",
		"Tab":        "\uE004",
		"Escape":     "\uE00C",
		"Backspace":  "\uE003",
		"Delete":     "\uE017",
		"ArrowUp":    "\uE013",
		"ArrowDown":  "\uE015",
		"ArrowLeft":  "\uE012",
		"ArrowRight": "\uE014",
		"Home":       "\uE011",
		"End":        "\uE010",
		"PageUp":     "\uE00E",
		"PageDown":   "\uE00F",
		"Insert":     "\uE016",
		"F1":         "\uE031",
		"F2":         "\uE032",
		"F3":         "\uE033",
		"F4":         "\uE034",
		"F5":         "\uE035",
		"F6":         "\uE036",
		"F7":         "\uE037",
		"F8":         "\uE038",
		"F9":         "\uE039",
		"F10":        "\uE03A",
		"F11":        "\uE03B",
		"F12":        "\uE03C",
		"Shift":      "\uE008",
		"Control":    "\uE009",
		"Alt":        "\uE00A",
		"Meta":       "\uE03D",
		" ":          "\uE00D",
	}
	if v, ok := m[key]; ok {
		return v
	}
	// Single character: return as-is
	if len(key) == 1 {
		return key
	}
	return key
}
