// Chrome Turbo MCP — Background Service Worker
// WebSocket client → MCP server. Routes commands to content scripts or handles locally.

const WS_URL = 'ws://127.0.0.1:18321';
let ws = null;
let reconnectDelay = 500;

// --- Constants ---
const MAX_ACTIVITY_LOG = 100;
const SCREENSHOT_FOCUS_DELAY_MS = 150;
const CONTENT_SCRIPT_INIT_DELAY_MS = 50;
const NATIVE_HEALTH_TIMEOUT_MS = 200;
const NATIVE_RESIZE_TIMEOUT_MS = 5000;
const NATIVE_RECHECK_INTERVAL_MS = 30000;

// --- Telemetry & popup communication ---
const stats = { commands: 0, errors: 0, totalMs: 0, startedAt: Date.now() };
const activityLog = []; // last MAX_ACTIVITY_LOG entries
const popupPorts = new Set();

// Active MCP clients (Claudes / Cursors / etc.) talking to the daemon. The
// server sends an unsolicited `mcp_clients` push whenever this list changes,
// and we replay it to the popup so the user sees who is driving the browser.
let mcpClients = [];

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  popupPorts.add(port);
  port.onDisconnect.addListener(() => popupPorts.delete(port));
  port.onMessage.addListener((msg) => {
    if (msg.type === 'getState') {
      port.postMessage({ type: 'status', connected: ws?.readyState === WebSocket.OPEN, browsers: 'active' });
      port.postMessage({ type: 'stats', ...getStats() });
      port.postMessage({ type: 'mcp_clients', clients: mcpClients });
      port.postMessage({ type: 'log-batch', entries: activityLog.slice(-50) });
    }
    if (msg.type === 'getStats') {
      port.postMessage({ type: 'stats', ...getStats() });
    }
  });
});

function getStats() {
  return {
    commands: stats.commands,
    errors: stats.errors,
    avgMs: stats.commands > 0 ? Math.round(stats.totalMs / stats.commands) : 0,
    uptimeMs: Date.now() - stats.startedAt,
  };
}

function broadcast(msg) {
  for (const port of popupPorts) {
    try { port.postMessage(msg); } catch { popupPorts.delete(port); }
  }
}

function logActivity(entry) {
  // Activity log keeps one canonical entry per cmdId — start/done/error
  // updates merge into the same row instead of duplicating.
  if (entry.id) {
    const existing = activityLog.findIndex(e => e.id === entry.id);
    if (existing >= 0) {
      activityLog[existing] = { ...activityLog[existing], ...entry };
    } else {
      activityLog.push(entry);
    }
  } else {
    activityLog.push(entry);
  }
  while (activityLog.length > MAX_ACTIVITY_LOG) activityLog.shift();
  broadcast({ type: 'activity', ...entry });
}

// summariseParams produces a compact, human-readable preview of the params
// for the popup. We don't want to dump full screenshot/HTML payloads.
function summariseParams(action, params) {
  if (!params) return '';
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string') {
      out[k] = v.length > 80 ? v.slice(0, 77) + '…' : v;
    } else if (typeof v === 'object' && v !== null) {
      try {
        const j = JSON.stringify(v);
        out[k] = j.length > 80 ? j.slice(0, 77) + '…' : j;
      } catch { out[k] = '[object]'; }
    } else {
      out[k] = v;
    }
  }
  return out;
}

// summariseResult extracts a tiny summary string for the activity log so the
// user can glance and see the outcome without expanding details.
function summariseResult(action, result) {
  if (!result) return '';
  try {
    if (action === 'screenshot') return `${result.width}x${result.height}`;
    if (action === 'list_tabs' && Array.isArray(result)) return `${result.length} tabs`;
    if (action === 'find_text') return `${result.found ?? result.results?.length ?? 0} matches`;
    if (action === 'get_interactive_map') return `${result.elements?.length ?? 0} elements`;
    if (action === 'extract_text') return `${result.count ?? 0} blocks`;
    if (action === 'click') return result.clicked || 'clicked';
    if (action === 'type_text') return `typed ${result.typed ?? 0} chars`;
    if (action === 'scroll') return `scroll ${result.scrollX ?? 0},${result.scrollY ?? 0}`;
    if (action === 'navigate') return result.url || '';
  } catch {}
  return '';
}

// --- Badge updates ---
function updateBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: connected ? '#3fb950' : '#f85149' });
}

// --- MV3 keepalive: prevent service worker from dying ---
// Service workers get killed after ~30s of inactivity in MV3.
// chrome.alarms fires every 25s to keep it alive while WS is connected.
const KEEPALIVE_ALARM = 'turbo-keepalive';
const RECONNECT_ALARM = 'turbo-reconnect';

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // Just being called keeps the SW alive. Also ping WS if connected.
    if (ws && ws.readyState === WebSocket.OPEN) {
      // WS is healthy, keep the alarm going
    } else {
      // WS is dead, reconnect
      connect();
    }
  }
  if (alarm.name === RECONNECT_ALARM) {
    connect();
  }
});

function startKeepalive() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 }); // ~25s
}

function stopKeepalive() {
  chrome.alarms.clear(KEEPALIVE_ALARM);
}

// --- WebSocket connection with auto-reconnect ---
function connect() {
  // Don't double-connect
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[turbo] Connected to MCP server');
    reconnectDelay = 500;
    startKeepalive();
    updateBadge(true);
    broadcast({ type: 'status', connected: true, browsers: 'active' });
  };

  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) {
      console.warn('[turbo] Malformed WS message:', e.message, event.data?.substring?.(0, 200));
      return;
    }

    // Server-initiated push messages (no `id`, has `type`).
    if (msg.type === 'mcp_clients') {
      mcpClients = Array.isArray(msg.clients) ? msg.clients : [];
      broadcast({ type: 'mcp_clients', clients: mcpClients });
      return;
    }

    const cmdId = msg.id;
    const params = msg.params || {};
    // Strip MCP-side metadata so handlers don't see fields they don't expect.
    const intent = typeof params._intent === 'string' ? params._intent : '';
    const clientLabel = typeof params._clientLabel === 'string' ? params._clientLabel : '';
    const clientType = typeof params._clientType === 'string' ? params._clientType : '';
    delete params._intent;
    delete params._clientLabel;
    delete params._clientType;

    const start = performance.now();
    stats.commands++;
    const baseEntry = {
      id: cmdId,
      action: msg.action,
      intent,
      clientLabel,
      clientType,
      params: summariseParams(msg.action, params),
    };
    logActivity({ ...baseEntry, status: 'start', timestamp: Date.now() });

    const overlayPromise = notifyOverlay(params.tabId, {
      kind: 'start',
      id: cmdId,
      action: msg.action,
      intent,
      clientLabel,
      clientType,
      params,
    });

    // For visible page actions, hold the real DOM event until the cursor
    // has actually animated to the target. Other actions don't gate.
    if (PAGE_ACTIONS_THAT_GATE_ON_CURSOR.has(msg.action)) {
      try { await overlayPromise; } catch {}
    }

    try {
      const result = await dispatch(msg.action, params);
      const duration = Math.round(performance.now() - start);
      stats.totalMs += duration;
      logActivity({
        ...baseEntry,
        status: 'done',
        duration,
        timestamp: Date.now(),
        resultSummary: summariseResult(msg.action, result),
      });
      broadcast({ type: 'stats', ...getStats() });
      // Pipe the result back to the on-page overlay so it can visualise
      // read-only tools (find_text → loupe, get_interactive_map → scan
      // flash, etc.). Fire-and-forget; the overlay swallows errors and
      // visualisation is non-critical.
      notifyOverlay(params.tabId, { kind: 'result', action: msg.action, result });
      ws.send(JSON.stringify({ id: msg.id, result }));
    } catch (e) {
      const duration = Math.round(performance.now() - start);
      stats.totalMs += duration;
      stats.errors++;
      // Tell the overlay so the cursor can shake + flash red.
      notifyOverlay(params.tabId, { kind: 'error', action: msg.action, error: e.message });
      logActivity({
        ...baseEntry,
        status: 'error',
        duration,
        error: e.message,
        timestamp: Date.now(),
      });
      broadcast({ type: 'stats', ...getStats() });
      ws.send(JSON.stringify({ id: msg.id, error: e.message }));
    }
  };

  ws.onclose = () => {
    console.log('[turbo] Disconnected');
    ws = null;
    updateBadge(false);
    broadcast({ type: 'status', connected: false });
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws?.close();
  };
}

function scheduleReconnect() {
  stopKeepalive();
  // Use alarm instead of setTimeout — survives SW suspension
  chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: reconnectDelay / 60000 });
  reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
}

// Also reconnect on any browser event that wakes the SW
chrome.tabs.onActivated.addListener(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) connect();
});


// --- Resolve tab ID (use active tab if not specified) ---
async function resolveTab(tabId) {
  if (tabId) return tabId;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('No active tab found');
  return tab.id;
}

// --- Ensure content script is injected ---
async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    await new Promise(r => setTimeout(r, CONTENT_SCRIPT_INIT_DELAY_MS));
  }
}

// --- Send command to content script ---
async function toContent(tabId, action, params = {}) {
  const tid = await resolveTab(tabId);
  await ensureContentScript(tid);
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tid, { action, params }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.error) {
        reject(new Error(response.error));
      } else {
        resolve(response);
      }
    });
  });
}

// notifyOverlay sends an out-of-band message to the page's overlay UI so it
// can show the agent cursor, flash, and intent toast for the action that's
// about to happen. Returns a Promise that resolves once the content-script
// overlay has finished animating to the target — so the caller can `await`
// it before performing a click, ensuring the real DOM click coincides with
// the cursor's arrival rather than firing while it's still in flight.
// Silently no-ops on chrome:// pages or when the content script can't be
// reached; overlay is non-critical UI.
async function notifyOverlay(tabId, payload) {
  try {
    const tid = await resolveTab(tabId);
    await ensureContentScript(tid);
    return await new Promise((resolve) => {
      chrome.tabs.sendMessage(tid, { action: '__turbo_overlay', payload }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
  } catch {
    // Non-fatal.
  }
}

// Actions that visibly touch the page: we wait for the cursor to arrive
// before dispatching. Read-only DOM probes don't have a target and the
// overlay returns immediately for them, so awaiting is harmless but we
// still fire-and-forget to keep them snappy.
const PAGE_ACTIONS_THAT_GATE_ON_CURSOR = new Set([
  'click', 'cdp_click', 'type_text', 'cdp_type', 'inspect',
]);

// --- Legacy CDP real-input fallback helpers (used by tests and extension fallback mode) ---
const CDP_MOD_SHIFT = 8;
const attachedTabs = new Set();

async function ensureDebugger(tabId) {
  const tid = await resolveTab(tabId);
  if (attachedTabs.has(tid)) return tid;
  try {
    await chrome.debugger.attach({ tabId: tid }, '1.3');
    attachedTabs.add(tid);
  } catch (e) {
    const msg = String(e?.message || '');
    if (!/already attached/i.test(msg)) throw e;
    attachedTabs.add(tid);
  }
  return tid;
}

async function cdpSend(tabId, method, params = {}) {
  const tid = await ensureDebugger(tabId);
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId: tid }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result || {});
      }
    });
  });
}

async function cdpClick(tabId, x, y, shift = false) {
  const modifiers = shift ? CDP_MOD_SHIFT : 0;
  await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers });
  await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers });
  return { clicked: true, x, y, shift: !!shift };
}

async function cdpType(tabId, text = '') {
  for (const ch of String(text)) {
    await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', text: ch });
    await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', text: ch });
  }
  return { typed: text.length };
}

async function cdpKey(tabId, key) {
  const keyMap = {
    Enter: 'Enter',
    Escape: 'Escape',
    Tab: 'Tab',
    Backspace: 'Backspace',
    ArrowDown: 'ArrowDown',
    ArrowUp: 'ArrowUp',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight',
  };
  const k = keyMap[key] || key;
  await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k });
  await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: k });
  return { pressed: k };
}

async function cdpScroll(tabId, x = 600, y = 400, deltaX = 0, deltaY = 600) {
  await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
  return { scrolled: true };
}

// --- Screenshot with resize ---
// Tries native Go resizer first (http://127.0.0.1:18322), falls back to OffscreenCanvas
const NATIVE_URL = 'http://127.0.0.1:18322';
let nativeAvailable = null; // null = unknown, true/false = cached

async function checkNative() {
  if (nativeAvailable !== null) return nativeAvailable;
  try {
    const r = await fetch(NATIVE_URL + '/health', { signal: AbortSignal.timeout(NATIVE_HEALTH_TIMEOUT_MS) });
    nativeAvailable = r.ok;
  } catch {
    nativeAvailable = false;
  }
  setTimeout(() => { nativeAvailable = null; }, NATIVE_RECHECK_INTERVAL_MS);
  return nativeAvailable;
}

async function resizeNative(base64, maxWidth, quality) {
  const resp = await fetch(NATIVE_URL + '/resize-b64', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: base64, maxWidth, quality }),
    signal: AbortSignal.timeout(NATIVE_RESIZE_TIMEOUT_MS),
  });
  return await resp.json(); // { data, width, height }
}

async function resizeLocal(dataUrl, maxWidth, quality) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  let w = bitmap.width;
  let h = bitmap.height;
  if (w > maxWidth) {
    h = Math.round(h * maxWidth / w);
    w = maxWidth;
  }

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const resizedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality / 100 });
  const buffer = await resizedBlob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return { data: btoa(binary), width: w, height: h };
}

/**
 * Capture a screenshot via captureVisibleTab (extension fallback when BiDi is unavailable).
 * Requires focusing the tab. BiDi screenshots (from Go server) are preferred.
 * @param {number} [tabId] - Tab to capture (defaults to active tab)
 * @param {number} [maxWidth=1280] - Maximum width in pixels for the resized image
 * @param {number} [quality=70] - JPEG quality (0-100)
 * @returns {{ base64: string, width: number, height: number, mimeType: string }}
 */
async function screenshot(tabId, maxWidth = 1280, quality = 70) {
  const tid = await resolveTab(tabId);

  const tab = await chrome.tabs.get(tid);
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tid, { active: true });
  await new Promise(r => setTimeout(r, SCREENSHOT_FOCUS_DELAY_MS));

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: 'jpeg',
    quality: Math.min(quality + 10, 100),
  });

  let result;
  if (await checkNative()) {
    const raw = dataUrl.split(',')[1];
    try {
      result = await resizeNative(raw, maxWidth, quality);
    } catch {
      nativeAvailable = false;
      result = await resizeLocal(dataUrl, maxWidth, quality);
    }
  } else {
    result = await resizeLocal(dataUrl, maxWidth, quality);
  }

  return { base64: result.data, width: result.width, height: result.height, mimeType: 'image/jpeg' };
}

// --- Execute JS in page's MAIN world ---
// Auto-wraps in a function so bare `return` statements work.
async function executeJsMain(tabId, code) {
  const tid = await resolveTab(tabId);
  // If code has bare `return` (not already in a function), wrap in an IIFE.
  // Skip if code already starts with ( — it's an expression/IIFE.
  const needsWrap = code.includes('return ') && !code.trimStart().startsWith('(');
  const wrapped = needsWrap ? `(function(){${code}})()` : code;
  const results = await chrome.scripting.executeScript({
    target: { tabId: tid },
    func: async (c) => {
      try {
        let r = eval(c);
        // If eval returns a Promise (async IIFE), await it
        if (r && typeof r.then === 'function') r = await r;
        return { result: JSON.parse(JSON.stringify(r ?? null)) };
      } catch (e) {
        return { error: e.message, stack: e.stack };
      }
    },
    args: [wrapped],
    world: 'MAIN',
  });
  return results[0]?.result || { error: 'No result' };
}

// --- Inject a custom script into the page and run it ---
async function adaptScript(tabId, code, persist = false) {
  const tid = await resolveTab(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId: tid },
    func: (scriptCode, shouldPersist) => {
      try {
        // Run in page context via script tag
        const script = document.createElement('script');
        if (shouldPersist) {
          // Keep the script in the page
          script.textContent = scriptCode;
          (document.head || document.documentElement).appendChild(script);
          return { injected: true, persistent: true };
        } else {
          // Run and capture result, then remove
          const id = '__turbo_adapt_' + Date.now();
          const wrapped = `
            try {
              window['${id}'] = (function() { ${scriptCode} })();
            } catch(e) {
              window['${id}'] = { __error: e.message };
            }
          `;
          script.textContent = wrapped;
          (document.head || document.documentElement).appendChild(script);
          const result = window[id];
          delete window[id];
          script.remove();
          if (result?.__error) return { error: result.__error };
          return { result: JSON.parse(JSON.stringify(result ?? null)) };
        }
      } catch (e) {
        return { error: e.message };
      }
    },
    args: [code, persist],
    world: 'MAIN',
  });
  return results[0]?.result || { error: 'No result' };
}

/**
 * Main command dispatcher. Routes incoming WS actions to the appropriate handler:
 * - Background-handled: list_tabs, navigate, screenshot, execute_js, adapt_script, turbo_snapshot
 * - Content-script bridge: extract_text, click, type_text, scroll, get_html, etc.
 * - CDP real-input: cdp_click, cdp_type, cdp_key, cdp_scroll
 * - CDP monitoring: network_*, console_*, cookies, performance, accessibility
 * @param {string} action - The command name
 * @param {Object} params - Command parameters
 * @returns {any} Command result
 */
async function dispatch(action, params) {
  switch (action) {
    // --- Background-handled commands ---
    case 'list_tabs': {
      const tabs = await chrome.tabs.query({});
      return tabs.map(t => ({
        id: t.id, title: t.title, url: t.url,
        active: t.active, windowId: t.windowId,
        status: t.status, favIconUrl: t.favIconUrl,
      }));
    }

    case 'navigate': {
      const tid = await resolveTab(params.tabId);
      await chrome.tabs.update(tid, { url: params.url });
      return { tabId: tid, url: params.url };
    }

    case 'screenshot': {
      return await screenshot(params.tabId, params.maxWidth, params.quality);
    }

    case 'execute_js': {
      return await executeJsMain(params.tabId, params.code);
    }

    case 'adapt_script': {
      return await adaptScript(params.tabId, params.code, params.persist);
    }

    case 'turbo_snapshot': {
      // Parallel: screenshot + interactive map
      const tid = await resolveTab(params.tabId);
      const [shot, map] = await Promise.all([
        screenshot(tid, params.maxWidth || 1280, params.quality || 70),
        toContent(tid, 'get_interactive_map'),
      ]);
      return { screenshot: shot, interactiveMap: map };
    }

    // --- CDP real-input commands (extension fallback path) ---
    case 'cdp_click':
      return await cdpClick(params.tabId, params.x, params.y, params.shift);
    case 'cdp_type':
      return await cdpType(params.tabId, params.text);
    case 'cdp_key':
      return await cdpKey(params.tabId, params.key);
    case 'cdp_scroll':
      return await cdpScroll(params.tabId, params.x, params.y, params.deltaX, params.deltaY);

    // --- Content-script commands ---
    case 'extract_text':
      return await toContent(params.tabId, 'extract_text', {
        selector: params.selector, region: params.region, max: params.max,
      });

    case 'find_text':
      return await toContent(params.tabId, 'find_text', {
        query: params.query, max: params.max, caseSensitive: params.caseSensitive,
      });

    case 'inspect':
      return await toContent(params.tabId, 'inspect', {
        selector: params.selector, x: params.x, y: params.y,
        text: params.text, depth: params.depth,
      });

    case 'get_interactive_map':
      return await toContent(params.tabId, 'get_interactive_map');

    case 'query_elements':
      return await toContent(params.tabId, 'query_elements', { selector: params.selector, limit: params.limit });

    case 'click':
      return await toContent(params.tabId, 'click', { selector: params.selector, x: params.x, y: params.y });

    case 'type_text':
      return await toContent(params.tabId, 'type_text', {
        selector: params.selector, text: params.text,
        clear: params.clear, pressEnter: params.pressEnter,
      });

    case 'scroll':
      return await toContent(params.tabId, 'scroll', {
        x: params.x, y: params.y, selector: params.selector,
        direction: params.direction, amount: params.amount,
      });

    case 'get_html':
      return await toContent(params.tabId, 'get_html', {
        selector: params.selector, outer: params.outer,
        maxDepth: params.maxDepth, maxLength: params.maxLength,
      });

    case 'get_page_structure':
      return await toContent(params.tabId, 'get_page_structure', {
        selector: params.selector, maxDepth: params.maxDepth, visibleOnly: params.visibleOnly,
      });

    case 'inject_script':
      return await toContent(params.tabId, 'inject_script', { code: params.code });

    default:
      throw new Error('Unknown action: ' + action);
  }
}

// --- Start ---
connect();
console.log('[turbo] Chrome Turbo MCP background started');
