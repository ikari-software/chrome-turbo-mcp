import { vi } from 'vitest';

// --- Event mock helper ---
function makeEvent() {
  const listeners = [];
  return {
    addListener: vi.fn((fn) => listeners.push(fn)),
    removeListener: vi.fn((fn) => {
      const idx = listeners.indexOf(fn);
      if (idx !== -1) listeners.splice(idx, 1);
    }),
    hasListeners: vi.fn(() => listeners.length > 0),
    _listeners: listeners,
    _fire(...args) { listeners.forEach(fn => fn(...args)); },
  };
}

// Export for tests that need to access event internals
globalThis.__makeEvent = makeEvent;

// --- Chrome API mock ---
globalThis.chrome = {
  runtime: {
    connect: vi.fn(() => ({
      onMessage: makeEvent(),
      onDisconnect: makeEvent(),
      postMessage: vi.fn(),
      name: 'popup',
    })),
    sendMessage: vi.fn(),
    onMessage: makeEvent(),
    onConnect: makeEvent(),
    get lastError() { return chrome.runtime._lastError; },
    set lastError(v) { chrome.runtime._lastError = v; },
    _lastError: null,
  },
  tabs: {
    query: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    sendMessage: vi.fn(),
    captureVisibleTab: vi.fn().mockResolvedValue('data:image/jpeg;base64,AAAA'),
    onActivated: makeEvent(),
    onRemoved: makeEvent(),
  },
  scripting: {
    executeScript: vi.fn().mockResolvedValue([{ result: {} }]),
  },
  windows: {
    update: vi.fn().mockResolvedValue({}),
  },
  debugger: {
    attach: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi.fn(),
  },
  alarms: {
    create: vi.fn(),
    clear: vi.fn(),
    onAlarm: makeEvent(),
  },
  action: {
    setBadgeText: vi.fn(),
    setBadgeBackgroundColor: vi.fn(),
  },
};

// --- MockWebSocket ---
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.send = vi.fn();
    this.close = vi.fn(() => {
      this.readyState = MockWebSocket.CLOSED;
      if (this.onclose) this.onclose();
    });
    MockWebSocket.instances.push(this);
  }

  _open() {
    this.readyState = MockWebSocket.OPEN;
    if (this.onopen) this.onopen();
  }

  _receive(data) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(data) });
  }

  _error() {
    if (this.onerror) this.onerror(new Event('error'));
  }
}
globalThis.WebSocket = MockWebSocket;
globalThis.MockWebSocket = MockWebSocket;

// --- CSS.escape polyfill ---
if (typeof CSS === 'undefined') globalThis.CSS = {};
if (!CSS.escape) {
  CSS.escape = (s) => String(s).replace(/([^\w-])/g, '\\$1');
}

// --- Window dimensions ---
Object.defineProperty(window, 'innerWidth', { value: 1280, writable: true, configurable: true });
Object.defineProperty(window, 'innerHeight', { value: 800, writable: true, configurable: true });
Object.defineProperty(window, 'devicePixelRatio', { value: 2, writable: true, configurable: true });
Object.defineProperty(window, 'scrollX', { value: 0, writable: true, configurable: true });
Object.defineProperty(window, 'scrollY', { value: 0, writable: true, configurable: true });

// --- Mock scrollBy ---
window.scrollBy = vi.fn();

// --- jsdom polyfills ---
// jsdom 26 doesn't implement innerText (returns undefined)
if (typeof HTMLElement.prototype.innerText === 'undefined') {
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    get() { return this.textContent; },
    set(v) { this.textContent = v; },
    configurable: true,
  });
}

// jsdom doesn't implement document.execCommand
if (typeof document.execCommand !== 'function') {
  document.execCommand = vi.fn().mockReturnValue(true);
}
