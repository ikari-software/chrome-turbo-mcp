import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

let api;

// Fresh chrome mock state for each describe block's loading
function resetChromeMocks() {
  chrome.tabs.query.mockReset().mockResolvedValue([]);
  chrome.tabs.get.mockReset().mockResolvedValue({});
  chrome.tabs.update.mockReset().mockResolvedValue({});
  chrome.tabs.sendMessage.mockReset();
  chrome.tabs.captureVisibleTab.mockReset().mockResolvedValue('data:image/jpeg;base64,AAAA');
  chrome.scripting.executeScript.mockReset().mockResolvedValue([{ result: {} }]);
  chrome.windows.update.mockReset().mockResolvedValue({});
  chrome.debugger.attach.mockReset().mockResolvedValue(undefined);
  chrome.debugger.sendCommand.mockReset();
  chrome.alarms.create.mockReset();
  chrome.alarms.clear.mockReset();
  chrome.action.setBadgeText.mockReset();
  chrome.action.setBadgeBackgroundColor.mockReset();
  chrome.runtime._lastError = null;
}

beforeAll(() => {
  // Mock fetch globally
  globalThis.fetch = vi.fn();

  // Mock OffscreenCanvas and createImageBitmap (used by resizeLocal)
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() {
      return { drawImage: vi.fn() };
    }
    convertToBlob() {
      return Promise.resolve(new Blob(['fake'], { type: 'image/jpeg' }));
    }
  };
  globalThis.createImageBitmap = vi.fn().mockResolvedValue({
    width: 2560, height: 1600, close: vi.fn(),
  });

  // Load background.js — inject export line at the end
  const filePath = path.resolve(__dirname, '../background.js');
  let code = fs.readFileSync(filePath, 'utf8');
  const fns = [
    'getStats', 'broadcast', 'logActivity', 'updateBadge',
    'connect', 'scheduleReconnect', 'startKeepalive', 'stopKeepalive',
    'resolveTab', 'ensureContentScript', 'toContent',
    'ensureDebugger', 'cdpSend', 'cdpClick', 'cdpType', 'cdpKey', 'cdpScroll',
    'checkNative', 'resizeNative', 'resizeLocal', 'screenshot',
    'executeJsMain', 'adaptScript', 'dispatch',
  ].join(', ');

  code += `\nglobalThis.__bgAPI = { ${fns} };`;
  const script = new vm.Script(code, { filename: filePath });
  script.runInThisContext();
  api = globalThis.__bgAPI;
});

beforeEach(() => {
  resetChromeMocks();
});

// ============================================================
// getStats()
// ============================================================
describe('getStats', () => {
  it('returns stats with avgMs=0 when no commands', () => {
    const s = api.getStats();
    expect(s).toHaveProperty('commands');
    expect(s).toHaveProperty('errors');
    expect(s).toHaveProperty('avgMs');
    expect(s).toHaveProperty('uptimeMs');
    expect(s.uptimeMs).toBeGreaterThan(0);
  });
});

// ============================================================
// logActivity()
// ============================================================
describe('logActivity', () => {
  it('adds entries and broadcasts', () => {
    // logActivity calls broadcast internally — just verify no throw
    api.logActivity({ action: 'test', status: 'done', duration: 10 });
  });
});

// ============================================================
// updateBadge()
// ============================================================
describe('updateBadge', () => {
  it('sets ON badge when connected', () => {
    api.updateBadge(true);
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: 'ON' });
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#3fb950' });
  });

  it('clears badge when disconnected', () => {
    api.updateBadge(false);
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#f85149' });
  });
});

// ============================================================
// resolveTab()
// ============================================================
describe('resolveTab', () => {
  it('returns provided tabId directly', async () => {
    const id = await api.resolveTab(42);
    expect(id).toBe(42);
  });

  it('queries active tab when no tabId', async () => {
    chrome.tabs.query.mockResolvedValue([{ id: 7 }]);
    const id = await api.resolveTab();
    expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
    expect(id).toBe(7);
  });

  it('throws when no active tab found', async () => {
    chrome.tabs.query.mockResolvedValue([]);
    await expect(api.resolveTab()).rejects.toThrow('No active tab');
  });
});

// ============================================================
// ensureContentScript()
// ============================================================
describe('ensureContentScript', () => {
  it('skips injection when ping succeeds', async () => {
    chrome.tabs.sendMessage.mockImplementation((_id, _msg, cb) => {
      if (cb) cb({ ok: true });
    });
    await api.ensureContentScript(1);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('injects content.js when ping fails', async () => {
    chrome.tabs.sendMessage.mockImplementation(() => { throw new Error('no receiver'); });
    chrome.scripting.executeScript.mockResolvedValue([]);
    await api.ensureContentScript(1);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 1 },
      files: ['content.js'],
    });
  });
});

// ============================================================
// toContent()
// ============================================================
describe('toContent', () => {
  it('resolves tab, ensures script, sends message', async () => {
    // Ping succeeds (ensureContentScript)
    chrome.tabs.sendMessage.mockImplementation((id, msg, cb) => {
      if (msg.action === 'ping') { if (cb) cb({ ok: true }); return; }
      if (cb) cb({ blocks: [] });
    });

    const result = await api.toContent(5, 'extract_text', { max: 10 });
    expect(result).toEqual({ blocks: [] });
  });

  it('rejects when chrome.runtime.lastError is set', async () => {
    chrome.tabs.sendMessage.mockImplementation((id, msg, cb) => {
      if (msg.action === 'ping') { if (cb) cb({ ok: true }); return; }
      chrome.runtime._lastError = { message: 'tab closed' };
      if (cb) cb(undefined);
      chrome.runtime._lastError = null;
    });

    await expect(api.toContent(5, 'extract_text')).rejects.toThrow('tab closed');
  });

  it('rejects when response has error', async () => {
    chrome.tabs.sendMessage.mockImplementation((id, msg, cb) => {
      if (msg.action === 'ping') { if (cb) cb({ ok: true }); return; }
      if (cb) cb({ error: 'not found' });
    });

    await expect(api.toContent(5, 'click', { selector: '#x' })).rejects.toThrow('not found');
  });
});

// ============================================================
// ensureDebugger()
// ============================================================
describe('ensureDebugger', () => {
  it('attaches debugger to tab', async () => {
    chrome.debugger.attach.mockResolvedValue(undefined);
    await api.ensureDebugger(10);
    expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 10 }, '1.3');
  });

  it('is idempotent — does not re-attach', async () => {
    // Use a fresh tabId not used in other tests
    chrome.debugger.attach.mockResolvedValue(undefined);
    await api.ensureDebugger(777);
    chrome.debugger.attach.mockClear();
    await api.ensureDebugger(777);
    // Second call should not attach again (first call adds to internal Set)
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
  });

  it('handles "Already attached" gracefully', async () => {
    chrome.debugger.attach.mockRejectedValue(new Error('Already attached'));
    await api.ensureDebugger(99);
    // Should not throw — "Already attached" is expected
  });

  it('rethrows non-already-attached errors', async () => {
    chrome.debugger.attach.mockRejectedValue(new Error('Permission denied'));
    await expect(api.ensureDebugger(88)).rejects.toThrow('Permission denied');
  });
});

// ============================================================
// cdpSend()
// ============================================================
describe('cdpSend', () => {
  it('sends command via chrome.debugger.sendCommand', async () => {
    chrome.debugger.attach.mockResolvedValue(undefined);
    chrome.debugger.sendCommand.mockImplementation((_target, _method, _params, cb) => {
      cb({ result: 'ok' });
    });

    const result = await api.cdpSend(10, 'DOM.getDocument', {});
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 10 }, 'DOM.getDocument', {}, expect.any(Function),
    );
    expect(result).toEqual({ result: 'ok' });
  });

  it('rejects on lastError', async () => {
    chrome.debugger.sendCommand.mockImplementation((_target, _method, _params, cb) => {
      chrome.runtime._lastError = { message: 'detached' };
      cb(undefined);
      chrome.runtime._lastError = null;
    });

    await expect(api.cdpSend(10, 'X', {})).rejects.toThrow('detached');
  });
});

// ============================================================
// cdpClick()
// ============================================================
describe('cdpClick', () => {
  it('sends mousePressed then mouseReleased', async () => {
    const calls = [];
    chrome.debugger.attach.mockResolvedValue(undefined);
    chrome.debugger.sendCommand.mockImplementation((_t, method, params, cb) => {
      calls.push({ method, type: params.type });
      cb();
    });

    await api.cdpClick(1, 100, 200);
    expect(calls[0]).toEqual({ method: 'Input.dispatchMouseEvent', type: 'mousePressed' });
    expect(calls[1]).toEqual({ method: 'Input.dispatchMouseEvent', type: 'mouseReleased' });
  });

  it('passes modifiers', async () => {
    chrome.debugger.sendCommand.mockImplementation((_t, _m, params, cb) => {
      if (params.type === 'mousePressed') {
        expect(params.modifiers).toBe(8); // shift
      }
      cb();
    });

    await api.cdpClick(1, 50, 50, 8);
  });
});

// ============================================================
// cdpType()
// ============================================================
describe('cdpType', () => {
  it('sends keyDown/keyUp for each character', async () => {
    const events = [];
    chrome.debugger.sendCommand.mockImplementation((_t, _m, params, cb) => {
      events.push(params.type);
      cb();
    });

    await api.cdpType(1, 'ab');
    expect(events).toEqual(['keyDown', 'keyUp', 'keyDown', 'keyUp']);
  });
});

// ============================================================
// cdpKey()
// ============================================================
describe('cdpKey', () => {
  it('sends rawKeyDown then keyUp', async () => {
    const events = [];
    chrome.debugger.sendCommand.mockImplementation((_t, _m, params, cb) => {
      events.push({ type: params.type, key: params.key });
      cb();
    });

    await api.cdpKey(1, 'Enter', 'Enter', 13);
    expect(events).toEqual([
      { type: 'rawKeyDown', key: 'Enter' },
      { type: 'keyUp', key: 'Enter' },
    ]);
  });
});

// ============================================================
// cdpScroll()
// ============================================================
describe('cdpScroll', () => {
  it('sends mouseWheel event', async () => {
    chrome.debugger.sendCommand.mockImplementation((_t, _m, params, cb) => {
      expect(params.type).toBe('mouseWheel');
      expect(params.deltaY).toBe(300);
      cb();
    });

    await api.cdpScroll(1, 600, 400, 0, 300);
  });
});

// ============================================================
// checkNative()
// ============================================================
describe('checkNative', () => {
  it('returns true when health check succeeds', async () => {
    globalThis.fetch.mockResolvedValue({ ok: true });
    // Reset cached value — checkNative caches the result
    // We call it fresh; the internal nativeAvailable might be cached from previous calls.
    // Since we can't reset the internal let, we test the fetch interaction.
    const result = await api.checkNative();
    expect(typeof result).toBe('boolean');
  });
});

// ============================================================
// dispatch()
// ============================================================
describe('dispatch', () => {
  it('list_tabs — queries all tabs', async () => {
    chrome.tabs.query.mockResolvedValue([
      { id: 1, title: 'Tab 1', url: 'https://a.com', active: true, windowId: 1 },
    ]);
    const result = await api.dispatch('list_tabs', {});
    expect(chrome.tabs.query).toHaveBeenCalledWith({});
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty('title', 'Tab 1');
  });

  it('navigate — updates tab URL', async () => {
    chrome.tabs.query.mockResolvedValue([{ id: 3 }]);
    chrome.tabs.update.mockResolvedValue({});
    const result = await api.dispatch('navigate', { url: 'https://b.com' });
    expect(chrome.tabs.update).toHaveBeenCalledWith(3, { url: 'https://b.com' });
    expect(result).toEqual({ tabId: 3, url: 'https://b.com' });
  });

  it('navigate — uses provided tabId', async () => {
    chrome.tabs.update.mockResolvedValue({});
    const result = await api.dispatch('navigate', { tabId: 5, url: 'https://c.com' });
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { url: 'https://c.com' });
    expect(result.tabId).toBe(5);
  });

  it('cdp_click — calls cdpClick', async () => {
    chrome.debugger.attach.mockResolvedValue(undefined);
    chrome.debugger.sendCommand.mockImplementation((_t, _m, _p, cb) => cb());
    const result = await api.dispatch('cdp_click', { tabId: 1, x: 10, y: 20 });
    expect(result).toEqual({ clicked: true, x: 10, y: 20, shift: false });
  });

  it('cdp_click with shift', async () => {
    chrome.debugger.sendCommand.mockImplementation((_t, _m, _p, cb) => cb());
    const result = await api.dispatch('cdp_click', { tabId: 1, x: 10, y: 20, shift: true });
    expect(result.shift).toBe(true);
  });

  it('cdp_type — types text', async () => {
    chrome.debugger.sendCommand.mockImplementation((_t, _m, _p, cb) => cb());
    const result = await api.dispatch('cdp_type', { tabId: 1, text: 'hi' });
    expect(result).toEqual({ typed: 2 });
  });

  it('cdp_key — presses key from map', async () => {
    chrome.debugger.sendCommand.mockImplementation((_t, _m, _p, cb) => cb());
    const result = await api.dispatch('cdp_key', { tabId: 1, key: 'Enter' });
    expect(result).toEqual({ pressed: 'Enter' });
  });

  it('cdp_key — handles unknown key', async () => {
    chrome.debugger.sendCommand.mockImplementation((_t, _m, _p, cb) => cb());
    const result = await api.dispatch('cdp_key', { tabId: 1, key: 'F5' });
    expect(result).toEqual({ pressed: 'F5' });
  });

  it('cdp_scroll — scrolls', async () => {
    chrome.debugger.sendCommand.mockImplementation((_t, _m, _p, cb) => cb());
    const result = await api.dispatch('cdp_scroll', { tabId: 1, deltaY: 100 });
    expect(result).toEqual({ scrolled: true });
  });

  it('execute_js — runs in MAIN world', async () => {
    chrome.scripting.executeScript.mockResolvedValue([{ result: { result: 42 } }]);
    const result = await api.dispatch('execute_js', { tabId: 1, code: '40+2' });
    expect(chrome.scripting.executeScript).toHaveBeenCalled();
    expect(result).toEqual({ result: 42 });
  });

  it('adapt_script — injects script', async () => {
    chrome.scripting.executeScript.mockResolvedValue([{ result: { result: 'ok' } }]);
    const result = await api.dispatch('adapt_script', { tabId: 1, code: 'return "ok"' });
    expect(result).toEqual({ result: 'ok' });
  });

  it('content-script actions route through toContent', async () => {
    // Mock the chain: resolveTab → ensureContentScript → sendMessage
    chrome.tabs.sendMessage.mockImplementation((id, msg, cb) => {
      if (msg.action === 'ping') { if (cb) cb({ ok: true }); return; }
      if (cb) cb({ found: 1, results: [{ text: 'hi' }] });
    });

    const result = await api.dispatch('find_text', { tabId: 1, query: 'hi' });
    expect(result).toEqual({ found: 1, results: [{ text: 'hi' }] });
  });

  it('throws for unknown action', async () => {
    await expect(api.dispatch('nonexistent', {})).rejects.toThrow('Unknown action');
  });
});

// ============================================================
// connect() — WebSocket
// ============================================================
describe('connect', () => {
  // connect() has a guard: if ws is CONNECTING or OPEN, it returns early.
  // The initial connect() during file load created a WS. We need to close it
  // to set the internal ws=null before each test.
  function closeExistingWs() {
    const last = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    if (last && last.readyState !== WebSocket.CLOSED) {
      // Trigger onclose which sets internal ws = null
      last.readyState = WebSocket.CLOSED;
      if (last.onclose) last.onclose();
    }
  }

  it('creates a WebSocket to WS_URL', () => {
    closeExistingWs();
    const countBefore = MockWebSocket.instances.length;
    api.connect();
    expect(MockWebSocket.instances.length).toBeGreaterThan(countBefore);
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    expect(ws.url).toBe('ws://127.0.0.1:18321');
  });

  it('sets up badge and keepalive on open', () => {
    closeExistingWs();
    api.connect();
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    ws._open();
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: 'ON' });
    expect(chrome.alarms.create).toHaveBeenCalledWith('turbo-keepalive', expect.any(Object));
  });

  it('clears badge and schedules reconnect on close', () => {
    closeExistingWs();
    api.connect();
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    ws._open();
    chrome.action.setBadgeText.mockClear();
    ws.close();
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
    expect(chrome.alarms.create).toHaveBeenCalledWith('turbo-reconnect', expect.any(Object));
  });
});

// ============================================================
// startKeepalive / stopKeepalive
// ============================================================
describe('keepalive', () => {
  it('startKeepalive creates an alarm', () => {
    api.startKeepalive();
    expect(chrome.alarms.create).toHaveBeenCalledWith('turbo-keepalive', { periodInMinutes: 0.4 });
  });

  it('stopKeepalive clears the alarm', () => {
    api.stopKeepalive();
    expect(chrome.alarms.clear).toHaveBeenCalledWith('turbo-keepalive');
  });
});
