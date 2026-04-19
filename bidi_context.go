package main

import (
	"context"
	"fmt"
	"sync"
)

// contextMap maps integer tab IDs to BiDi browsing context IDs.
// The MCP tool API uses integer tabIds; BiDi uses opaque string context IDs.
// This bridge lets tools keep their existing tabId-based interface.
var (
	tabToContext   = make(map[int]string) // tabId → contextID
	contextToTab   = make(map[string]int) // contextID → tabId
	contextURLs    = make(map[string]string) // contextID → URL
	contextMapMu   sync.RWMutex
	nextSyntheticTab int = 100000 // synthetic tab IDs for contexts without a real tab ID
)

// resolveContext translates a tabId (from MCP tool params) to a BiDi browsing context ID.
// If tabId is 0 or nil, returns the first (most recently active) context.
func resolveContext(tabId any) (string, error) {
	if err := requireBiDiErr(); err != nil {
		return "", err
	}

	id := toInt(tabId)

	// Refresh context map
	if err := refreshContextMap(); err != nil {
		return "", fmt.Errorf("context refresh: %w", err)
	}

	contextMapMu.RLock()
	defer contextMapMu.RUnlock()

	if id > 0 {
		if ctx, ok := tabToContext[id]; ok {
			return ctx, nil
		}
		return "", fmt.Errorf("no BiDi context for tab %d", id)
	}

	// No tabId specified — return first top-level context
	for ctxID := range contextURLs {
		return ctxID, nil
	}
	return "", fmt.Errorf("no browsing contexts available")
}

// resolveContextDirect returns the first available context without requiring a tabId.
func resolveContextDirect() (string, error) {
	return resolveContext(nil)
}

// refreshContextMap queries browsingContext.getTree and rebuilds the mapping.
func refreshContextMap() error {
	contexts, err := bidiGetTree(context.Background())
	if err != nil {
		return err
	}

	contextMapMu.Lock()
	defer contextMapMu.Unlock()

	// Clear and rebuild
	for k := range contextURLs {
		delete(contextURLs, k)
	}

	for _, ctx := range contexts {
		contextURLs[ctx.Context] = ctx.URL

		// If we don't already have a tab mapping for this context, create a synthetic one
		if _, exists := contextToTab[ctx.Context]; !exists {
			nextSyntheticTab++
			synth := nextSyntheticTab
			tabToContext[synth] = ctx.Context
			contextToTab[ctx.Context] = synth
		}

		// Recurse into children (iframes, etc.)
		for _, child := range ctx.Children {
			contextURLs[child.Context] = child.URL
		}
	}
	return nil
}

// registerTabContext associates a real extension tab ID with a BiDi context ID.
// Called when we can cross-reference extension list_tabs with BiDi getTree by URL.
func registerTabContext(tabID int, contextID string) {
	contextMapMu.Lock()
	defer contextMapMu.Unlock()

	// Remove any previous synthetic mapping for this context
	if oldTab, exists := contextToTab[contextID]; exists && oldTab != tabID {
		delete(tabToContext, oldTab)
	}

	tabToContext[tabID] = contextID
	contextToTab[contextID] = tabID
}

// getContextList returns all known contexts with their URLs and tab IDs.
func getContextList() []map[string]any {
	contextMapMu.RLock()
	defer contextMapMu.RUnlock()

	var out []map[string]any
	for ctxID, url := range contextURLs {
		entry := map[string]any{
			"context": ctxID,
			"url":     url,
		}
		if tabID, ok := contextToTab[ctxID]; ok {
			entry["tabId"] = tabID
		}
		out = append(out, entry)
	}
	return out
}

func requireBiDiErr() error {
	_, err := requireBiDi()
	return err
}
