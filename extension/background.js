// Chrome Turbo MCP — Background Service Worker
// WebSocket client → MCP server. Routes commands to content scripts or handles locally.

const WS_URL = 'ws://127.0.0.1:18321';
let ws = null;
let reconnectDelay = 500;

// --- Telemetry & popup communication ---
const stats = { commands: 0, errors: 0, totalMs: 0, startedAt: Date.now() };
const activityLog = []; // last 100 entries
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
  if (activityLog.length > 100) activityLog.shift();
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
    try { msg = JSON.parse(event.data); } catch { return; }

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
    // Small delay for script to initialize
    await new Promise(r => setTimeout(r, 50));
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

async function ensureDebugger(tabId) {
  if (debuggerAttached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggerAttached.add(tabId);
    // Clean up when tab closes
    chrome.tabs.onRemoved.addListener(function onRemoved(id) {
      if (id === tabId) {
        debuggerAttached.delete(tabId);
        chrome.tabs.onRemoved.removeListener(onRemoved);
      }
    });
  } catch (e) {
    // Already attached or can't attach
    if (e.message?.includes('Already attached')) debuggerAttached.add(tabId);
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

// Real click at exact coordinates via CDP. modifiers: 1=Alt, 2=Ctrl, 4=Meta, 8=Shift
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

// --- Screenshot with resize ---
// Tries native Go resizer first (http://127.0.0.1:18322), falls back to OffscreenCanvas
const NATIVE_URL = 'http://127.0.0.1:18322';
let nativeAvailable = null; // null = unknown, true/false = cached

async function checkNative() {
  if (nativeAvailable !== null) return nativeAvailable;
  try {
    const r = await fetch(NATIVE_URL + '/health', { signal: AbortSignal.timeout(200) });
    nativeAvailable = r.ok;
  } catch {
    nativeAvailable = false;
  }
  // Re-check every 30s
  setTimeout(() => { nativeAvailable = null; }, 30000);
  return nativeAvailable;
}

async function resizeNative(base64, maxWidth, quality) {
  const resp = await fetch(NATIVE_URL + '/resize-b64', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: base64, maxWidth, quality }),
    signal: AbortSignal.timeout(5000),
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

async function screenshot(tabId, maxWidth = 1280, quality = 70) {
  const tid = await resolveTab(tabId);
  const tab = await chrome.tabs.get(tid);
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tid, { active: true });
  await new Promise(r => setTimeout(r, 80));

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: 'jpeg',
    quality: Math.min(quality + 10, 100), // capture slightly higher, resizer compresses
  });

  let result;
  if (await checkNative()) {
    // Native Go resizer — ~5x faster than OffscreenCanvas
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

// --- Command dispatcher ---
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
      const modifiers = params.shift ? 8 : (params.modifiers || 0);
      await cdpClick(tid, params.x, params.y, modifiers);
      return { clicked: true, x: params.x, y: params.y, shift: !!params.shift };
    }

    case 'cdp_type': {
      const tid = await resolveTab(params.tabId);
      // Optionally clear first with select-all + delete
      if (params.clear) {
        await cdpKey(tid, 'a', 'KeyA', 65); // Ctrl+A — need modifier
        // Actually use Select All shortcut
        await cdpSend(tid, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 8 }); // 8 = Meta (Cmd on Mac)
        await cdpSend(tid, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
        await cdpKey(tid, 'Backspace', 'Backspace', 8);
        await new Promise(r => setTimeout(r, 50));
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

    default:
      throw new Error('Unknown action: ' + action);
  }
}

// --- Start ---
connect();
console.log('[turbo] Chrome Turbo MCP background started');
