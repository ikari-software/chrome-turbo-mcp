// Chrome Turbo MCP — Background Service Worker
// WebSocket client → MCP server. Routes commands to content scripts or handles locally.

const WS_URL = 'ws://127.0.0.1:18321';
let ws = null;
let reconnectDelay = 500;

// --- Constants ---
const MAX_ACTIVITY_LOG = 100;
const MAX_TEXT_LENGTH = 500;
const SCREENSHOT_FOCUS_DELAY_MS = 150;
const CONTENT_SCRIPT_INIT_DELAY_MS = 50;
const CDP_CLEAR_SETTLE_DELAY_MS = 50;
const NATIVE_HEALTH_TIMEOUT_MS = 200;
const NATIVE_RESIZE_TIMEOUT_MS = 5000;
const NATIVE_RECHECK_INTERVAL_MS = 30000;
// CDP Input modifier flags
const CDP_MOD_ALT = 1;
const CDP_MOD_CTRL = 2;
const CDP_MOD_SHIFT = 4;
const CDP_MOD_META = 8;

// --- Telemetry & popup communication ---
const stats = { commands: 0, errors: 0, totalMs: 0, startedAt: Date.now() };
const activityLog = []; // last MAX_ACTIVITY_LOG entries
const popupPorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  popupPorts.add(port);
  port.onDisconnect.addListener(() => popupPorts.delete(port));
  port.onMessage.addListener((msg) => {
    if (msg.type === 'getState') {
      port.postMessage({ type: 'status', connected: ws?.readyState === WebSocket.OPEN, browsers: 'active' });
      port.postMessage({ type: 'stats', ...getStats() });
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
  activityLog.push(entry);
  if (activityLog.length > MAX_ACTIVITY_LOG) activityLog.shift();
  broadcast({ type: 'activity', ...entry });
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

    const cmdId = msg.id;
    const start = performance.now();
    stats.commands++;
    logActivity({ id: cmdId, action: msg.action, status: 'start', timestamp: Date.now() });

    try {
      const result = await dispatch(msg.action, msg.params || {});
      const duration = Math.round(performance.now() - start);
      stats.totalMs += duration;
      logActivity({ id: cmdId, action: msg.action, status: 'done', duration, timestamp: Date.now() });
      broadcast({ type: 'stats', ...getStats() });
      ws.send(JSON.stringify({ id: msg.id, result }));
    } catch (e) {
      const duration = Math.round(performance.now() - start);
      stats.totalMs += duration;
      stats.errors++;
      logActivity({ id: cmdId, action: msg.action, status: 'error', duration, error: e.message, timestamp: Date.now() });
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

// Clean up per-tab buffers when tabs close to prevent memory leaks
chrome.tabs.onRemoved.addListener((tabId) => {
  networkLogs.delete(tabId);
  consoleLogs.delete(tabId);
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

// --- CDP (Chrome DevTools Protocol) for real input events ---
// Solves the MUI Autocomplete problem: synthetic JS events don't work on portal elements.
// CDP sends real OS-level events that are indistinguishable from user interaction.

const debuggerAttached = new Set(); // tabIds with debugger attached

/**
 * Attach CDP debugger to a tab if not already attached.
 * Patches common bot-detection vectors (webdriver, WebGL fingerprint, permissions API)
 * via Page.addScriptToEvaluateOnNewDocument so patches survive navigations.
 * Registers a tab-close listener to clean up the attachment tracking.
 * @param {number} tabId - Chrome tab ID to attach to
 */
async function ensureDebugger(tabId) {
  if (debuggerAttached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggerAttached.add(tabId);

    // Patch detection vectors BEFORE any page JS runs.
    // This survives navigations — it's injected into every new document.
    await new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, 'Page.addScriptToEvaluateOnNewDocument', {
        source: `
          // 1. navigator.webdriver — the #1 detection vector
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

          // 2. Chrome DevTools detection via window.chrome.csi / window.chrome.loadTimes
          //    (some bots break these, detection scripts check they exist)
          if (!window.chrome) window.chrome = {};
          if (!window.chrome.csi) window.chrome.csi = function() { return {}; };
          if (!window.chrome.loadTimes) window.chrome.loadTimes = function() { return {}; };

          // 3. Permissions API — headless Chrome returns inconsistent results
          const origQuery = window.navigator.permissions?.query;
          if (origQuery) {
            window.navigator.permissions.query = (params) =>
              params.name === 'notifications'
                ? Promise.resolve({ state: Notification.permission })
                : origQuery.call(navigator.permissions, params);
          }

          // 4. WebGL vendor/renderer — prevent fingerprint mismatch detection
          const getParameter = WebGLRenderingContext.prototype.getParameter;
          WebGLRenderingContext.prototype.getParameter = function(param) {
            if (param === 37445) return 'Intel Inc.';
            if (param === 37446) return 'Intel Iris OpenGL Engine';
            return getParameter.call(this, param);
          };
        `,
      }, (result) => {
        if (chrome.runtime.lastError) resolve(); // non-fatal
        else resolve(result);
      });
    });

    // Also patch the CURRENT document (addScriptToEvaluateOnNewDocument only applies to future navigations)
    try {
      await new Promise((resolve, reject) => {
        chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: `Object.defineProperty(navigator, 'webdriver', { get: () => undefined });`,
        }, () => resolve());
      });
    } catch {}

    // Clean up when tab closes
    chrome.tabs.onRemoved.addListener(function onRemoved(id) {
      if (id === tabId) {
        debuggerAttached.delete(tabId);
        chrome.tabs.onRemoved.removeListener(onRemoved);
      }
    });
  } catch (e) {
    // Already attached or can't attach — match case-insensitively to survive Chrome version changes
    if (/already attached/i.test(e.message)) debuggerAttached.add(tabId);
    else throw e;
  }
}

async function cdpSend(tabId, method, params = {}) {
  await ensureDebugger(tabId);
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

// Real click at exact coordinates via CDP.
async function cdpClick(tabId, x, y, modifiers = 0) {
  await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers });
  await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers });
}

// Real keyboard typing via CDP — types each character as a real keypress
async function cdpType(tabId, text) {
  for (const char of text) {
    await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', text: char, key: char, code: 'Key' + char.toUpperCase() });
    await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: char, code: 'Key' + char.toUpperCase() });
  }
}

// Real key press (Enter, ArrowDown, Escape, Backspace, etc.)
async function cdpKey(tabId, key, code, keyCode) {
  await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode });
  await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
}

// Scroll a specific element or the page
async function cdpScroll(tabId, x, y, deltaX, deltaY) {
  await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
}

// --- CDP event listeners for network/console monitoring ---
// Per-tab buffers for captured events
const networkLogs = new Map();  // tabId -> {requests: [], maxSize}
const consoleLogs = new Map();  // tabId -> {messages: [], maxSize}

/**
 * Enable CDP network event capture for a tab.
 * Stores requests in a Map keyed by requestId (deduped), with an insert-order
 * array for FIFO eviction when maxSize is reached.
 * @param {number} tabId - Tab to monitor
 * @param {number} [maxSize=500] - Maximum number of requests to keep
 */
async function enableNetworkCapture(tabId, maxSize = 500) {
  await ensureDebugger(tabId);
  networkLogs.set(tabId, { requestMap: new Map(), maxSize, insertOrder: [] });
  await cdpSend(tabId, 'Network.enable', {});

  chrome.debugger.onEvent.addListener(function handler(source, method, params) {
    if (source.tabId !== tabId) return;
    const log = networkLogs.get(tabId);
    if (!log) { chrome.debugger.onEvent.removeListener(handler); return; }

    if (method === 'Network.requestWillBeSent') {
      if (!log.requestMap.has(params.requestId)) {
        // Evict oldest entry if at capacity
        if (log.insertOrder.length >= log.maxSize) {
          const oldest = log.insertOrder.shift();
          log.requestMap.delete(oldest);
        }
        log.insertOrder.push(params.requestId);
      }
      log.requestMap.set(params.requestId, {
        requestId: params.requestId,
        url: params.request.url,
        method: params.request.method,
        type: params.type,
        timestamp: params.timestamp,
        headers: params.request.headers,
      });
    } else if (method === 'Network.responseReceived') {
      const req = log.requestMap.get(params.requestId);
      if (req) {
        req.status = params.response.status;
        req.statusText = params.response.statusText;
        req.mimeType = params.response.mimeType;
        req.responseHeaders = params.response.headers;
      }
    } else if (method === 'Network.loadingFinished') {
      const req = log.requestMap.get(params.requestId);
      if (req) req.size = params.encodedDataLength;
    }
  });
}

async function enableConsoleCapture(tabId, maxSize = 200) {
  await ensureDebugger(tabId);
  consoleLogs.set(tabId, { messages: [], maxSize });
  await cdpSend(tabId, 'Runtime.enable', {});

  chrome.debugger.onEvent.addListener(function handler(source, method, params) {
    if (source.tabId !== tabId) return;
    const log = consoleLogs.get(tabId);
    if (!log) { chrome.debugger.onEvent.removeListener(handler); return; }

    if (method === 'Runtime.consoleAPICalled') {
      log.messages.push({
        type: params.type,
        text: params.args.map(a => a.value ?? a.description ?? a.type).join(' '),
        timestamp: params.timestamp,
        stackTrace: params.stackTrace?.callFrames?.[0],
      });
      if (log.messages.length > log.maxSize) log.messages.shift();
    } else if (method === 'Runtime.exceptionThrown') {
      log.messages.push({
        type: 'error',
        text: params.exceptionDetails.text + (params.exceptionDetails.exception?.description ? ': ' + params.exceptionDetails.exception.description : ''),
        timestamp: params.timestamp,
      });
      if (log.messages.length > log.maxSize) log.messages.shift();
    }
  });
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
 * Capture a screenshot of a tab, resize, and return as base64 JPEG.
 * Pipeline: CDP Page.captureScreenshot → resize (native Go service or OffscreenCanvas fallback).
 * If CDP fails (e.g. chrome:// pages), falls back to captureVisibleTab which requires focusing.
 * @param {number} [tabId] - Tab to capture (defaults to active tab)
 * @param {number} [maxWidth=1280] - Maximum width in pixels for the resized image
 * @param {number} [quality=70] - JPEG quality (0-100)
 * @returns {{ base64: string, width: number, height: number, mimeType: string }}
 */
async function screenshot(tabId, maxWidth = 1280, quality = 70) {
  const tid = await resolveTab(tabId);

  // Try CDP first — captures without focusing the window
  try {
    const cdpResult = await cdpSend(tid, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: Math.min(quality + 10, 100),
    });
    const raw = cdpResult.data;
    let result;
    if (await checkNative()) {
      try {
        result = await resizeNative(raw, maxWidth, quality);
      } catch {
        nativeAvailable = false;
        result = await resizeLocal('data:image/jpeg;base64,' + raw, maxWidth, quality);
      }
    } else {
      result = await resizeLocal('data:image/jpeg;base64,' + raw, maxWidth, quality);
    }
    return { base64: result.data, width: result.width, height: result.height, mimeType: 'image/jpeg' };
  } catch {
    // CDP failed (e.g. chrome:// pages) — fall back to captureVisibleTab
  }

  // Fallback: captureVisibleTab (requires focusing)
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

    // --- CDP real-input commands ---
    case 'cdp_click': {
      const tid = await resolveTab(params.tabId);
      const modifiers = params.shift ? CDP_MOD_META : (params.modifiers || 0);
      await cdpClick(tid, params.x, params.y, modifiers);
      return { clicked: true, x: params.x, y: params.y, shift: !!params.shift };
    }

    case 'cdp_type': {
      const tid = await resolveTab(params.tabId);
      // Optionally clear first with select-all + delete
      if (params.clear) {
        await cdpKey(tid, 'a', 'KeyA', 65); // Ctrl+A — need modifier
        // Actually use Select All shortcut
        await cdpSend(tid, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: CDP_MOD_META });
        await cdpSend(tid, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
        await cdpKey(tid, 'Backspace', 'Backspace', 8);
        await new Promise(r => setTimeout(r, CDP_CLEAR_SETTLE_DELAY_MS));
      }
      await cdpType(tid, params.text);
      return { typed: params.text.length };
    }

    case 'cdp_key': {
      const tid = await resolveTab(params.tabId);
      const keyMap = {
        'Enter': { code: 'Enter', keyCode: 13 },
        'Escape': { code: 'Escape', keyCode: 27 },
        'ArrowDown': { code: 'ArrowDown', keyCode: 40 },
        'ArrowUp': { code: 'ArrowUp', keyCode: 38 },
        'Backspace': { code: 'Backspace', keyCode: 8 },
        'Tab': { code: 'Tab', keyCode: 9 },
      };
      const k = keyMap[params.key] || { code: params.key, keyCode: 0 };
      await cdpKey(tid, params.key, k.code, k.keyCode);
      return { pressed: params.key };
    }

    case 'cdp_scroll': {
      const tid = await resolveTab(params.tabId);
      await cdpScroll(tid, params.x || 600, params.y || 400, params.deltaX || 0, params.deltaY || 0);
      return { scrolled: true };
    }

    // --- Generic CDP passthrough ---
    case 'cdp': {
      const tid = await resolveTab(params.tabId);
      const result = await cdpSend(tid, params.method, params.params || {});
      return result;
    }

    // --- Network monitoring ---
    case 'network_enable': {
      const tid = await resolveTab(params.tabId);
      await enableNetworkCapture(tid, params.maxSize || 500);
      return { enabled: true, tabId: tid };
    }

    case 'network_get': {
      const tid = await resolveTab(params.tabId);
      const log = networkLogs.get(tid);
      if (!log) return { error: 'Network capture not enabled. Call network_enable first.', requests: [] };
      let requests = [...log.requestMap.values()];
      if (params.filter) {
        const f = params.filter.toLowerCase();
        requests = requests.filter(r =>
          r.url.toLowerCase().includes(f) ||
          (r.type || '').toLowerCase().includes(f) ||
          (r.method || '').toLowerCase().includes(f)
        );
      }
      return { count: requests.length, requests: requests.slice(-(params.limit || 100)) };
    }

    case 'network_get_body': {
      const tid = await resolveTab(params.tabId);
      const result = await cdpSend(tid, 'Network.getResponseBody', { requestId: params.requestId });
      return result;
    }

    case 'network_disable': {
      const tid = await resolveTab(params.tabId);
      networkLogs.delete(tid);
      try { await cdpSend(tid, 'Network.disable', {}); } catch {}
      return { disabled: true };
    }

    // --- Console monitoring ---
    case 'console_enable': {
      const tid = await resolveTab(params.tabId);
      await enableConsoleCapture(tid, params.maxSize || 200);
      return { enabled: true, tabId: tid };
    }

    case 'console_get': {
      const tid = await resolveTab(params.tabId);
      const log = consoleLogs.get(tid);
      if (!log) return { error: 'Console capture not enabled. Call console_enable first.', messages: [] };
      let messages = log.messages;
      if (params.type) {
        messages = messages.filter(m => m.type === params.type);
      }
      return { count: messages.length, messages: messages.slice(-(params.limit || 100)) };
    }

    case 'console_clear': {
      const tid = await resolveTab(params.tabId);
      const log = consoleLogs.get(tid);
      if (log) log.messages = [];
      return { cleared: true };
    }

    case 'console_disable': {
      const tid = await resolveTab(params.tabId);
      consoleLogs.delete(tid);
      try { await cdpSend(tid, 'Runtime.disable', {}); } catch {}
      return { disabled: true };
    }

    // --- Cookies ---
    case 'get_cookies': {
      const tid = await resolveTab(params.tabId);
      const result = await cdpSend(tid, 'Network.getCookies', params.urls ? { urls: params.urls } : {});
      return result;
    }

    case 'set_cookie': {
      const tid = await resolveTab(params.tabId);
      const result = await cdpSend(tid, 'Network.setCookie', {
        name: params.name, value: params.value, domain: params.domain,
        path: params.path || '/', secure: params.secure, httpOnly: params.httpOnly,
        sameSite: params.sameSite, expires: params.expires,
      });
      return result;
    }

    case 'delete_cookies': {
      const tid = await resolveTab(params.tabId);
      await cdpSend(tid, 'Network.deleteCookies', { name: params.name, domain: params.domain, path: params.path });
      return { deleted: true, name: params.name };
    }

    // --- Performance ---
    case 'get_performance': {
      const tid = await resolveTab(params.tabId);
      await cdpSend(tid, 'Performance.enable', {});
      const result = await cdpSend(tid, 'Performance.getMetrics', {});
      return result;
    }

    // --- Accessibility ---
    case 'get_accessibility_tree': {
      const tid = await resolveTab(params.tabId);
      const result = await cdpSend(tid, 'Accessibility.getFullAXTree', {
        depth: params.depth || 5,
      });
      // Trim to manageable size — full tree can be huge
      const nodes = (result.nodes || []).slice(0, params.maxNodes || 500).map(n => ({
        nodeId: n.nodeId,
        role: n.role?.value,
        name: n.name?.value,
        value: n.value?.value,
        description: n.description?.value,
        properties: (n.properties || []).reduce((acc, p) => { acc[p.name] = p.value?.value; return acc; }, {}),
        childIds: n.childIds,
      }));
      return { count: nodes.length, total: result.nodes?.length, nodes };
    }

    // --- Device emulation ---
    case 'emulate_device': {
      const tid = await resolveTab(params.tabId);
      if (params.disable) {
        await cdpSend(tid, 'Emulation.clearDeviceMetricsOverride', {});
        await cdpSend(tid, 'Emulation.setUserAgentOverride', { userAgent: '' });
        return { emulation: 'disabled' };
      }
      const overrides = {
        width: params.width || 375,
        height: params.height || 812,
        deviceScaleFactor: params.deviceScaleFactor || 2,
        mobile: params.mobile !== false,
      };
      await cdpSend(tid, 'Emulation.setDeviceMetricsOverride', overrides);
      if (params.userAgent) {
        await cdpSend(tid, 'Emulation.setUserAgentOverride', { userAgent: params.userAgent });
      }
      if (params.latitude !== undefined && params.longitude !== undefined) {
        await cdpSend(tid, 'Emulation.setGeolocationOverride', {
          latitude: params.latitude, longitude: params.longitude, accuracy: params.accuracy || 100,
        });
      }
      return { emulation: 'enabled', ...overrides };
    }

    // --- Network throttling ---
    case 'network_throttle': {
      const tid = await resolveTab(params.tabId);
      await ensureDebugger(tid);
      if (params.disable) {
        await cdpSend(tid, 'Network.emulateNetworkConditions', {
          offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
        });
        return { throttle: 'disabled' };
      }
      const presets = {
        'slow-3g': { latency: 2000, download: 50000, upload: 50000 },
        'fast-3g': { latency: 563, download: 180000, upload: 84375 },
        'offline': { latency: 0, download: 0, upload: 0, offline: true },
      };
      const preset = presets[params.preset];
      await cdpSend(tid, 'Network.enable', {});
      await cdpSend(tid, 'Network.emulateNetworkConditions', {
        offline: preset?.offline || params.offline || false,
        latency: params.latency ?? preset?.latency ?? 0,
        downloadThroughput: params.downloadThroughput ?? preset?.download ?? -1,
        uploadThroughput: params.uploadThroughput ?? preset?.upload ?? -1,
      });
      return { throttle: 'enabled', preset: params.preset };
    }

    // --- PDF generation ---
    case 'print_to_pdf': {
      const tid = await resolveTab(params.tabId);
      const result = await cdpSend(tid, 'Page.printToPDF', {
        landscape: params.landscape || false,
        printBackground: params.printBackground !== false,
        scale: params.scale || 1,
        paperWidth: params.paperWidth || 8.5,
        paperHeight: params.paperHeight || 11,
        marginTop: params.marginTop ?? 0.4,
        marginBottom: params.marginBottom ?? 0.4,
        marginLeft: params.marginLeft ?? 0.4,
        marginRight: params.marginRight ?? 0.4,
      });
      return { base64: result.data, mimeType: 'application/pdf' };
    }

    // --- DOM snapshot ---
    case 'dom_snapshot': {
      const tid = await resolveTab(params.tabId);
      const result = await cdpSend(tid, 'DOMSnapshot.captureSnapshot', {
        computedStyles: params.computedStyles || ['display', 'visibility', 'opacity', 'color', 'background-color', 'font-size'],
        includeDOMRects: params.includeDOMRects !== false,
        includePaintOrder: params.includePaintOrder || false,
      });
      return result;
    }

    // --- CSS coverage ---
    case 'css_coverage_start': {
      const tid = await resolveTab(params.tabId);
      await cdpSend(tid, 'CSS.enable', {});
      await cdpSend(tid, 'CSS.startRuleUsageTracking', {});
      return { started: true };
    }

    case 'css_coverage_stop': {
      const tid = await resolveTab(params.tabId);
      const result = await cdpSend(tid, 'CSS.stopRuleUsageTracking', {});
      const rules = result.ruleUsage || [];
      const used = rules.filter(r => r.used).length;
      return { total: rules.length, used, unused: rules.length - used, coverage: rules.length ? Math.round(used / rules.length * 100) : 0, rules };
    }

    // --- Page reload / stop ---
    case 'page_reload': {
      const tid = await resolveTab(params.tabId);
      await cdpSend(tid, 'Page.reload', {
        ignoreCache: params.ignoreCache || false,
      });
      return { reloaded: true };
    }

    // --- Storage (localStorage, sessionStorage) ---
    case 'get_storage': {
      const tid = await resolveTab(params.tabId);
      const storageType = params.type || 'local'; // 'local' or 'session'
      const result = await executeJsMain(tid,
        `return JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(${storageType}Storage))))`
      );
      return result;
    }

    // --- Detach debugger (cleanup) ---
    case 'cdp_detach': {
      const tid = await resolveTab(params.tabId);
      networkLogs.delete(tid);
      consoleLogs.delete(tid);
      debuggerAttached.delete(tid);
      try { await chrome.debugger.detach({ tabId: tid }); } catch {}
      return { detached: true };
    }

    default:
      throw new Error('Unknown action: ' + action);
  }
}

// --- Start ---
connect();
console.log('[turbo] Chrome Turbo MCP background started');
