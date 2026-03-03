#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn } from 'child_process';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { homedir, platform } from 'os';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WS_PORT = 18321;
const NATIVE_PORT = 18322;
const log = (msg: string) => process.stderr.write(`[chrome-turbo] ${msg}\n`);

// ─── Haiku preprocessing layer ───
// Auto-reads ANTHROPIC_API_KEY from env. Falls back gracefully if not set.

let anthropic: Anthropic | null = null;
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

function initHaiku() {
  const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!key) {
    log('No ANTHROPIC_API_KEY found — question-answering disabled (tools still work, just return raw data)');
    return;
  }
  anthropic = new Anthropic(); // auto-reads ANTHROPIC_API_KEY
  log('Haiku preprocessing enabled');
}

const DEFAULT_SYSTEM = 'You are a browser page analysis assistant. Answer concisely based on the provided page data. Include specific positions, selectors, and values when relevant. Be direct — no preamble.';

async function askHaiku(question: string, context: string, imageBase64?: string, systemPrompt?: string): Promise<string> {
  if (!anthropic) return `[Haiku unavailable — raw data follows]\n${context}`;

  const content: Anthropic.Messages.ContentBlockParam[] = [];
  if (imageBase64) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } });
  }
  content.push({ type: 'text', text: `Context data:\n${context.substring(0, 80000)}` });
  content.push({ type: 'text', text: `Question: ${question}` });

  const resp = await anthropic.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 1024,
    system: systemPrompt || DEFAULT_SYSTEM,
    messages: [{ role: 'user', content }],
  });

  return resp.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text').map(b => b.text).join('\n');
}

// If `question` is present, pipe raw result through Haiku
async function maybeAsk(rawData: any, question?: string, imageBase64?: string): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!question) return text(rawData);
  const ctx = typeof rawData === 'string' ? rawData : JSON.stringify(rawData, null, 2);
  const answer = await askHaiku(question, ctx, imageBase64);
  return { content: [{ type: 'text' as const, text: answer }] };
}

// Same but with a custom system prompt (for custom tools with baked-in context)
async function maybeAskWithSystem(rawData: any, question: string, systemPrompt: string, imageBase64?: string): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const ctx = typeof rawData === 'string' ? rawData : JSON.stringify(rawData, null, 2);
  const answer = await askHaiku(question, ctx, imageBase64, systemPrompt);
  return { content: [{ type: 'text' as const, text: answer }] };
}

// ─── Spawn native image processor if available ───

function spawnNative() {
  // Look for binary relative to project root
  const candidates = [
    resolve(__dirname, '..', 'bin', 'turbo-native'),
    resolve(__dirname, '..', 'native', 'turbo-native'),
  ];
  const bin = candidates.find(existsSync);
  if (!bin) {
    log('Native binary not found — screenshots will use JS fallback (still fast)');
    return;
  }
  const child = spawn(bin, ['--port', String(NATIVE_PORT)], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
  child.on('exit', (code) => log(`Native process exited (code ${code})`));
  process.on('exit', () => child.kill());
  log(`Native image processor started (port ${NATIVE_PORT})`);
}

// ─── WebSocket bridge to Chrome extension(s) ───
// Supports multiple browsers (Chrome, Arc, etc.) connected simultaneously.
// Each browser registers with its identity. Tab IDs are globally unique per browser.

interface BrowserConnection {
  ws: WebSocket;
  name: string;           // "Chrome", "Arc", etc.
  tabIds: Set<number>;    // known tab IDs for routing
}

const browsers: Map<WebSocket, BrowserConnection> = new Map();
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
let nextId = 0;

const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });
log(`WebSocket server on ws://127.0.0.1:${WS_PORT}`);

wss.on('connection', (ws) => {
  const conn: BrowserConnection = { ws, name: `browser-${browsers.size + 1}`, tabIds: new Set() };
  browsers.set(ws, conn);
  log(`Extension connected (${browsers.size} browser(s) total)`);

  ws.on('message', (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const p = pending.get(msg.id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    }
  });

  ws.on('close', () => {
    browsers.delete(ws);
    log(`Extension disconnected (${browsers.size} browser(s) remaining)`);
  });
});

function getOpenBrowsers(): BrowserConnection[] {
  return [...browsers.values()].filter(b => b.ws.readyState === WebSocket.OPEN);
}

// Send command to a specific browser connection
function sendTo(conn: BrowserConnection, action: string, params: Record<string, any>, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = String(++nextId);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout after ${timeoutMs}ms: ${action}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    conn.ws.send(JSON.stringify({ id, action, params }));
  });
}

// Smart send: if tabId is specified, route to the browser that owns it.
// For tabId-less commands, use the first available browser.
// For list_tabs, query ALL browsers and merge.
async function send(action: string, params: Record<string, any> = {}, timeoutMs = 30000): Promise<any> {
  const open = getOpenBrowsers();
  if (open.length === 0) {
    throw new Error('No browser extensions connected. Install the extension and ensure a browser is open.');
  }

  // list_tabs: query all browsers, merge, tag with browser name
  if (action === 'list_tabs') {
    const results = await Promise.all(open.map(async (conn, i) => {
      try {
        const tabs = await sendTo(conn, 'list_tabs', {}, timeoutMs);
        // Detect browser name from tab URLs/user agent and cache tab IDs
        const name = conn.name;
        return (tabs as any[]).map((t: any) => {
          conn.tabIds.add(t.id);
          return { ...t, browser: name };
        });
      } catch { return []; }
    }));
    // Detect browser names from first connection's tabs
    for (const conn of open) {
      try {
        const identity = await sendTo(conn, 'execute_js', { code: 'navigator.userAgent' }, 3000);
        const ua = identity?.result || '';
        if (ua.includes('Arc')) conn.name = 'Arc';
        else if (ua.includes('Chrome')) conn.name = 'Chrome';
        else if (ua.includes('Brave')) conn.name = 'Brave';
        else if (ua.includes('Edge')) conn.name = 'Edge';
      } catch { /* keep default name */ }
    }
    return results.flat();
  }

  // If tabId specified, find which browser owns it
  const tabId = params.tabId;
  if (tabId) {
    // Check cached tab ownership
    for (const conn of open) {
      if (conn.tabIds.has(tabId)) {
        return sendTo(conn, action, params, timeoutMs);
      }
    }
    // Not cached — try each browser, first success wins
    for (const conn of open) {
      try {
        const result = await sendTo(conn, action, params, timeoutMs);
        conn.tabIds.add(tabId);
        return result;
      } catch (e: any) {
        if (e.message?.includes('No tab') || e.message?.includes('Cannot access')) continue;
        throw e;
      }
    }
    throw new Error(`Tab ${tabId} not found in any connected browser`);
  }

  // No tabId — use first browser
  return sendTo(open[0], action, params, timeoutMs);
}

// ─── Helper: text response ───

function text(data: any): { content: Array<{ type: 'text'; text: string }> } {
  const s = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text' as const, text: s }] };
}

// ─── MCP Server ───

const mcp = new McpServer({
  name: 'chrome-turbo',
  version: '1.0.0',
});

// --- connection_status ---
mcp.registerTool(
  'connection_status',
  {
    description: 'Check if the Chrome extension is connected to the MCP server',
    inputSchema: z.object({}),
  },
  async () => {
    const open = getOpenBrowsers();
    return text({
      connected: open.length > 0,
      browsers: open.map(b => b.name),
      count: open.length,
      wsPort: WS_PORT,
    });
  },
);

// --- list_tabs ---
mcp.registerTool(
  'list_tabs',
  {
    description: 'List all open Chrome tabs with their IDs, titles, and URLs',
    inputSchema: z.object({}),
  },
  async () => text(await send('list_tabs')),
);

// --- navigate ---
mcp.registerTool(
  'navigate',
  {
    description: 'Navigate a tab to a URL. Omit tabId to use the active tab.',
    inputSchema: z.object({
      url: z.string().describe('URL to navigate to'),
      tabId: z.number().optional().describe('Tab ID (omit for active tab)'),
    }),
  },
  async ({ url, tabId }) => text(await send('navigate', { url, tabId })),
);

// --- screenshot ---
mcp.registerTool(
  'screenshot',
  {
    description: 'Take a screenshot of a tab. Returns a JPEG image scaled to maxWidth (default 1280px, NOT retina 3000px). Fast and compact.',
    inputSchema: z.object({
      tabId: z.number().optional().describe('Tab ID (omit for active tab)'),
      maxWidth: z.number().optional().describe('Max width in pixels (default 1280)'),
      quality: z.number().optional().describe('JPEG quality 1-100 (default 70)'),
    }),
  },
  async ({ tabId, maxWidth, quality }) => {
    const result = await send('screenshot', { tabId, maxWidth, quality });
    return {
      content: [
        { type: 'image' as const, data: result.base64, mimeType: result.mimeType },
        { type: 'text' as const, text: `${result.width}x${result.height} jpeg` },
      ],
    };
  },
);

// --- execute_js ---
mcp.registerTool(
  'execute_js',
  {
    description: 'Execute JavaScript in the page\'s MAIN world (not isolated). Full access to page globals, frameworks (React, Vue, etc.), and APIs. Returns the result. Code is auto-wrapped in a function, so bare `return` statements work.',
    inputSchema: z.object({
      code: z.string().describe('JavaScript code to execute. `return` works without needing an IIFE wrapper.'),
      tabId: z.number().optional().describe('Tab ID (omit for active tab)'),
    }),
  },
  async ({ code, tabId }) => text(await send('execute_js', { code, tabId })),
);

// --- adapt_script ---
mcp.registerTool(
  'adapt_script',
  {
    description: 'Inject and run a custom script in the page\'s MAIN world. Use persist=true to keep it running (e.g., MutationObservers, event listeners). Use persist=false to run once and get the result. This is the TURBO power tool — write task-specific scripts that automate work on the page.',
    inputSchema: z.object({
      code: z.string().describe('JavaScript code to inject. For persist=false, return a value. For persist=true, set up observers/listeners.'),
      tabId: z.number().optional().describe('Tab ID (omit for active tab)'),
      persist: z.boolean().optional().describe('Keep script in page (default false)'),
    }),
  },
  async ({ code, tabId, persist }) => text(await send('adapt_script', { code, tabId, persist })),
);

// --- extract_text (DOM-based OCR) ---
mcp.registerTool(
  'extract_text',
  {
    description: 'Fast DOM-based OCR: extract ALL visible text on the page with spatial positions (x, y, width, height). Instant — no image processing needed. Supports scoping by CSS selector or viewport region. Add `question` to get a concise Haiku-processed answer instead of raw data.',
    inputSchema: z.object({
      tabId: z.number().optional().describe('Tab ID (omit for active tab)'),
      selector: z.string().optional().describe('CSS selector to scope extraction to a subtree'),
      region: z.object({
        rx: z.number(), ry: z.number(), rw: z.number(), rh: z.number(),
      }).optional().describe('Only return text within this viewport rectangle {rx, ry, rw, rh}'),
      max: z.number().optional().describe('Max text blocks to return (default 500)'),
      question: z.string().optional().describe('If provided, Haiku preprocesses the data and returns a concise answer instead of raw JSON'),
    }),
  },
  async ({ tabId, selector, region, max, question }) => {
    const raw = await send('extract_text', { tabId, selector, region, max });
    return maybeAsk(raw, question);
  },
);

// --- find_text (search visible text) ---
mcp.registerTool(
  'find_text',
  {
    description: 'Search for visible text on the page (like Cmd+F). Returns matching elements with positions, text content, and CSS selectors. Add `question` for Haiku-processed answer.',
    inputSchema: z.object({
      query: z.string().describe('Text to search for'),
      tabId: z.number().optional().describe('Tab ID (omit for active tab)'),
      max: z.number().optional().describe('Max results (default 20)'),
      caseSensitive: z.boolean().optional().describe('Case sensitive search (default false)'),
      question: z.string().optional().describe('If provided, Haiku preprocesses the results and returns a concise answer'),
    }),
  },
  async ({ query, tabId, max, caseSensitive, question }) => {
    const raw = await send('find_text', { query, tabId, max, caseSensitive });
    return maybeAsk(raw, question);
  },
);

// --- inspect (deep element inspection) ---
mcp.registerTool(
  'inspect',
  {
    description: 'Deep one-shot inspection of an element. Find by CSS selector, coordinates, or text search. Returns element details, attributes, styles, parent chain, children, siblings. Add `question` for a concise Haiku-processed answer — e.g. inspect(text: "Field Group 15", question: "what is this and where?").',
    inputSchema: z.object({
      selector: z.string().optional().describe('CSS selector'),
      x: z.number().optional().describe('X coordinate (uses elementFromPoint)'),
      y: z.number().optional().describe('Y coordinate (uses elementFromPoint)'),
      text: z.string().optional().describe('Find first element containing this text'),
      depth: z.number().optional().describe('How deep to summarize children (default 2)'),
      tabId: z.number().optional().describe('Tab ID (omit for active tab)'),
      question: z.string().optional().describe('If provided, Haiku answers this question about the element instead of returning raw data'),
    }),
  },
  async ({ selector, x, y, text: searchText, depth, tabId, question }) => {
    const raw = await send('inspect', { selector, x, y, text: searchText, depth, tabId });
    return maybeAsk(raw, question);
  },
);

// --- describe (composite: screenshot + data → Haiku answer) ---
mcp.registerTool(
  'describe',
  {
    description: 'The ultimate one-call page understanding tool. Takes a screenshot, gathers spatial/text data, and sends everything to Haiku with your question. Returns a concise answer. Example: describe(question: "what is Field Group 15 and where is it on the PDF?"). This replaces the pattern of screenshot → inspect → extract_text → manual analysis.',
    inputSchema: z.object({
      question: z.string().describe('What do you want to know about the page?'),
      tabId: z.number().optional().describe('Tab ID (omit for active tab)'),
      selector: z.string().optional().describe('Scope data gathering to this CSS selector subtree'),
      includeScreenshot: z.boolean().optional().describe('Include a screenshot for visual analysis (default true)'),
    }),
  },
  async ({ question, tabId, selector, includeScreenshot }) => {
    // Gather data in parallel
    const tasks: Promise<any>[] = [];
    const useScreenshot = includeScreenshot !== false;

    if (useScreenshot) {
      tasks.push(send('screenshot', { tabId, maxWidth: 1280, quality: 60 }).catch(() => null));
    } else {
      tasks.push(Promise.resolve(null));
    }
    tasks.push(send('get_page_structure', { tabId, selector, maxDepth: 4 }).catch(() => null));
    tasks.push(send('get_interactive_map', { tabId }).catch(() => null));

    const [screenshot, structure, interactiveMap] = await Promise.all(tasks);

    // Build context string — compact, structured
    let context = '';
    if (structure?.yaml) context += structure.yaml + '\n\n';
    if (interactiveMap?.elements) {
      context += `Interactive elements (${interactiveMap.elements.length} total):\n`;
      context += JSON.stringify(interactiveMap.elements.slice(0, 50), null, 1) + '\n';
    }

    const imageData = screenshot?.base64 || undefined;
    const answer = await askHaiku(question, context, imageData);
    return { content: [{ type: 'text' as const, text: answer }] };
  },
);

// --- get_interactive_map ---
mcp.registerTool(
  'get_interactive_map',
  {
    description: 'Get ALL interactive elements (buttons, links, inputs, etc.) with their positions, text, selectors, and attributes. Spatial map for understanding page layout and available actions.',
    inputSchema: z.object({
      tabId: z.number().optional().describe('Tab ID (omit for active tab)'),
    }),
  },
  async ({ tabId }) => text(await send('get_interactive_map', { tabId })),
);

// --- query_elements ---
mcp.registerTool(
  'query_elements',
  {
    description: 'Query elements by CSS selector. Returns matching elements with positions, text, and attributes.',
    inputSchema: z.object({
      selector: z.string().describe('CSS selector'),
      tabId: z.number().optional().describe('Tab ID (omit for active tab)'),
      limit: z.number().optional().describe('Max elements to return (default 50)'),
    }),
  },
  async ({ selector, tabId, limit }) => text(await send('query_elements', { selector, tabId, limit })),
);

// --- click ---
mcp.registerTool(
  'click',
  {
    description: 'Click an element by CSS selector OR x,y coordinates. Dispatches mousedown, mouseup, click events.',
    inputSchema: z.object({
      selector: z.string().optional().describe('CSS selector of element to click'),
      x: z.number().optional().describe('X coordinate to click'),
      y: z.number().optional().describe('Y coordinate to click'),
      tabId: z.number().optional().describe('Tab ID (omit for active tab)'),
    }),
  },
  async ({ selector, x, y, tabId }) => text(await send('click', { selector, x, y, tabId })),
);

// --- type_text ---
mcp.registerTool(
  'type_text',
  {
    description: 'Type text into an element. Uses insertText command so it works with React, Vue, and other frameworks. Can clear existing text first.',
    inputSchema: z.object({
      text: z.string().describe('Text to type'),
      selector: z.string().optional().describe('CSS selector (omit for focused element)'),
      clear: z.boolean().optional().describe('Clear existing text first (default false)'),
      pressEnter: z.boolean().optional().describe('Press Enter after typing (default false)'),
      tabId: z.number().optional().describe('Tab ID (omit for active tab)'),
    }),
  },
  async ({ text: txt, selector, clear, pressEnter, tabId }) =>
    text(await send('type_text', { text: txt, selector, clear, pressEnter, tabId })),
);

// --- scroll ---
mcp.registerTool(
  'scroll',
  {
    description: 'Scroll the page or a specific element. Use direction (up/down/left/right) or pixel offsets.',
    inputSchema: z.object({
      direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('Scroll direction'),
      amount: z.number().optional().describe('Pixels to scroll (default ~80% viewport)'),
      x: z.number().optional().describe('Horizontal pixel offset'),
      y: z.number().optional().describe('Vertical pixel offset'),
      selector: z.string().optional().describe('Scroll within this element'),
      tabId: z.number().optional().describe('Tab ID (omit for active tab)'),
    }),
  },
  async ({ direction, amount, x, y, selector, tabId }) =>
    text(await send('scroll', { direction, amount, x, y, selector, tabId })),
);

// --- get_html ---
mcp.registerTool(
  'get_html',
  {
    description: 'Get the HTML of the page or a specific element. Supports depth limiting to avoid massive output.',
    inputSchema: z.object({
      selector: z.string().optional().describe('CSS selector (omit for full page)'),
      outer: z.boolean().optional().describe('Return outerHTML instead of innerHTML (default false)'),
      maxDepth: z.number().optional().describe('Max DOM depth to traverse. Deeper nodes get summarized. 0 = unlimited (default).'),
      maxLength: z.number().optional().describe('Max output length in chars (default 200000, max 500000)'),
      tabId: z.number().optional().describe('Tab ID (omit for active tab)'),
    }),
  },
  async ({ selector, outer, maxDepth, maxLength, tabId }) =>
    text(await send('get_html', { selector, outer, maxDepth, maxLength, tabId })),
);

// --- page_yaml (semantic structure) ---
mcp.registerTool(
  'page_yaml',
  {
    description: 'Get a YAML semantic structure of the page. Much more useful than raw HTML — strips styling noise, shows logical structure (headings, sections, forms, tables, lists, links, buttons, inputs) with spatial positions. Like what Claude Code uses internally. Compact and structure-aware.',
    inputSchema: z.object({
      selector: z.string().optional().describe('CSS selector for subtree (omit for full page)'),
      maxDepth: z.number().optional().describe('Max nesting depth (default 6)'),
      visibleOnly: z.boolean().optional().describe('Only include visible elements (default true)'),
      tabId: z.number().optional().describe('Tab ID (omit for active tab)'),
    }),
  },
  async ({ selector, maxDepth, visibleOnly, tabId }) =>
    text((await send('get_page_structure', { selector, maxDepth, visibleOnly, tabId })).yaml),
);

// --- turbo_snapshot (the killer combo tool) ---
mcp.registerTool(
  'turbo_snapshot',
  {
    description: 'TURBO: Screenshot + interactive element map in ONE call. Returns a scaled JPEG image AND a JSON spatial map of all interactive elements. The fastest way to understand a page.',
    inputSchema: z.object({
      tabId: z.number().optional().describe('Tab ID (omit for active tab)'),
      maxWidth: z.number().optional().describe('Screenshot max width (default 1280)'),
      quality: z.number().optional().describe('JPEG quality 1-100 (default 70)'),
    }),
  },
  async ({ tabId, maxWidth, quality }) => {
    const result = await send('turbo_snapshot', { tabId, maxWidth, quality });
    return {
      content: [
        { type: 'image' as const, data: result.screenshot.base64, mimeType: 'image/jpeg' },
        { type: 'text' as const, text: JSON.stringify(result.interactiveMap, null, 2) },
      ],
    };
  },
);

// --- cdp_click (real click via Chrome DevTools Protocol) ---
mcp.registerTool(
  'cdp_click',
  {
    description: 'Click at exact viewport coordinates using Chrome DevTools Protocol. Real OS-level click — works on MUI portals, dropdowns, and any element. Use when regular click tool fails on overlay/popup elements.',
    inputSchema: z.object({
      x: z.number().describe('X viewport coordinate'),
      y: z.number().describe('Y viewport coordinate'),
      shift: z.boolean().optional().describe('Hold Shift key during click (for multi-select)'),
      tabId: z.number().optional().describe('Tab ID (omit for active tab)'),
    }),
  },
  async ({ x, y, shift, tabId }) => text(await send('cdp_click', { x, y, shift, tabId })),
);

// --- cdp_type (real keyboard typing via CDP) ---
mcp.registerTool(
  'cdp_type',
  {
    description: 'Type text using real keyboard events via Chrome DevTools Protocol. Works with React, MUI, and any framework. Use clear=true to select-all and delete before typing.',
    inputSchema: z.object({
      text: z.string().describe('Text to type character by character'),
      clear: z.boolean().optional().describe('Select-all + delete before typing (default false)'),
      tabId: z.number().optional().describe('Tab ID (omit for active tab)'),
    }),
  },
  async ({ text: txt, clear, tabId }) => text(await send('cdp_type', { text: txt, clear, tabId })),
);

// --- cdp_key (single key press via CDP) ---
mcp.registerTool(
  'cdp_key',
  {
    description: 'Press a single key via CDP. Supports: Enter, Escape, ArrowDown, ArrowUp, Backspace, Tab.',
    inputSchema: z.object({
      key: z.string().describe('Key name: Enter, Escape, ArrowDown, ArrowUp, Backspace, Tab'),
      tabId: z.number().optional().describe('Tab ID (omit for active tab)'),
    }),
  },
  async ({ key, tabId }) => text(await send('cdp_key', { key, tabId })),
);

// --- cdp_scroll (scroll via CDP) ---
mcp.registerTool(
  'cdp_scroll',
  {
    description: 'Scroll at a specific viewport position using CDP mouse wheel events. Provide x,y for where to scroll, and deltaY for scroll amount (negative=up, positive=down).',
    inputSchema: z.object({
      x: z.number().optional().describe('X coordinate for scroll position (default 600)'),
      y: z.number().optional().describe('Y coordinate for scroll position (default 400)'),
      deltaX: z.number().optional().describe('Horizontal scroll amount'),
      deltaY: z.number().optional().describe('Vertical scroll amount (negative=up, positive=down)'),
      tabId: z.number().optional().describe('Tab ID (omit for active tab)'),
    }),
  },
  async ({ x, y, deltaX, deltaY, tabId }) => text(await send('cdp_scroll', { x, y, deltaX, deltaY, tabId })),
);

// ─── Custom Tools ───

interface CustomTool {
  name: string;
  description: string;
  code: string;
  params: Array<{ name: string; type: string; description: string; required?: boolean }>;
  systemPrompt?: string;
  createdAt: string;
}

function getConfigDir(): string {
  const p = platform();
  if (p === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'chrome-turbo-mcp');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'chrome-turbo-mcp');
}

const configDir = getConfigDir();
mkdirSync(configDir, { recursive: true });

const db = new Database(join(configDir, 'chrome-turbo.db'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 3000');

db.exec(`
  CREATE TABLE IF NOT EXISTS custom_tools (
    name        TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    code        TEXT NOT NULL,
    params      TEXT NOT NULL DEFAULT '[]',
    system_prompt TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

log(`Database: ${join(configDir, 'chrome-turbo.db')}`);

// Migrate from legacy JSON if the DB is empty
try {
  const count = (db.prepare('SELECT COUNT(*) as n FROM custom_tools').get() as any).n;
  if (count === 0) {
    const legacyPath = resolve(__dirname, '..', 'custom-tools.json');
    if (existsSync(legacyPath)) {
      const data: CustomTool[] = JSON.parse(readFileSync(legacyPath, 'utf8'));
      const insert = db.prepare(
        'INSERT OR IGNORE INTO custom_tools (name, description, code, params, system_prompt, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      );
      const migrate = db.transaction((tools: CustomTool[]) => {
        for (const t of tools) {
          insert.run(t.name, t.description, t.code, JSON.stringify(t.params), t.systemPrompt ?? null, t.createdAt);
        }
      });
      migrate(data);
      log(`Migrated ${data.length} custom tool(s) from legacy JSON`);
    }
  }
} catch (e: any) {
  log(`Migration check: ${e.message}`);
}

// Prepared statements — SQLite handles locking, no in-memory cache needed
const stmts = {
  upsert: db.prepare(
    'INSERT INTO custom_tools (name, description, code, params, system_prompt, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET description=excluded.description, code=excluded.code, params=excluded.params, system_prompt=excluded.system_prompt'
  ),
  get: db.prepare('SELECT * FROM custom_tools WHERE name = ?'),
  all: db.prepare('SELECT * FROM custom_tools ORDER BY created_at'),
  delete: db.prepare('DELETE FROM custom_tools WHERE name = ?'),
  count: db.prepare('SELECT COUNT(*) as n FROM custom_tools'),
};

function rowToTool(row: any): CustomTool {
  return {
    name: row.name,
    description: row.description,
    code: row.code,
    params: JSON.parse(row.params),
    systemPrompt: row.system_prompt ?? undefined,
    createdAt: row.created_at,
  };
}

function getTool(name: string): CustomTool | undefined {
  const row = stmts.get.get(name);
  return row ? rowToTool(row) : undefined;
}

function getAllTools(): CustomTool[] {
  return stmts.all.all().map(rowToTool);
}

function saveTool(tool: CustomTool): void {
  stmts.upsert.run(tool.name, tool.description, tool.code, JSON.stringify(tool.params), tool.systemPrompt ?? null, tool.createdAt);
}

function deleteTool(name: string): boolean {
  return stmts.delete.run(name).changes > 0;
}

function toolCount(): number {
  return (stmts.count.get() as any).n;
}

// --- create_tool ---
mcp.registerTool(
  'create_tool',
  {
    description: 'Create a reusable custom tool. The tool is saved to disk and persists across sessions. The code runs in the page context with access to a `params` object. Use `run_tool` to execute it later.',
    inputSchema: z.object({
      name: z.string().describe('Tool name (lowercase, no spaces — e.g. "get_field_info")'),
      description: z.string().describe('What the tool does'),
      code: z.string().describe('JavaScript code to execute in page context. Receives `params` object. Use `return` to return a value.'),
      params: z.array(z.object({
        name: z.string().describe('Parameter name'),
        type: z.enum(['string', 'number', 'boolean']).describe('Parameter type'),
        description: z.string().describe('What this parameter does'),
        required: z.boolean().optional().describe('Is this required? (default false)'),
      })).optional().describe('Tool parameters (in addition to tabId which is always available)'),
      systemPrompt: z.string().optional().describe('Baked-in context and instructions for Haiku when processing this tool\'s results. Saves tokens by not repeating domain knowledge on every call. Example: "This tool returns field group config from Hamlet PDF Mapper. A field group maps PDF checkboxes to data model fields. The data_source_id maps to a listing attribute."'),
    }),
  },
  async ({ name, description, code, params, systemPrompt }) => {
    const tool: CustomTool = {
      name,
      description,
      code,
      params: params || [],
      systemPrompt,
      createdAt: new Date().toISOString(),
    };
    saveTool(tool);
    log(`Custom tool created: ${name}`);
    return text({
      created: name,
      description,
      params: tool.params.map(p => p.name),
      usage: `run_tool(name: "${name}", args: {${tool.params.map(p => `${p.name}: ...`).join(', ')}})`,
    });
  },
);

// --- run_tool ---
mcp.registerTool(
  'run_tool',
  {
    description: 'Run a previously created custom tool by name. Pass arguments as a JSON object.',
    inputSchema: z.object({
      name: z.string().describe('Name of the custom tool to run'),
      args: z.record(z.any()).optional().describe('Arguments to pass to the tool (as JSON object)'),
      tabId: z.number().optional().describe('Tab ID (omit for active tab)'),
      question: z.string().optional().describe('If provided, Haiku processes the result and answers this question'),
    }),
  },
  async ({ name, args, tabId, question }) => {
    const tool = getTool(name);
    if (!tool) {
      const available = getAllTools().map(t => t.name);
      throw new Error(`Custom tool '${name}' not found. Available: ${available.join(', ') || 'none'}`);
    }
    const code = `(async function(params) { ${tool.code} })(${JSON.stringify(args || {})})`;
    const result = await send('execute_js', { code, tabId });

    // If tool has a baked-in systemPrompt, always run through Haiku
    // (question is optional extra — systemPrompt provides the baseline context)
    if (tool.systemPrompt) {
      const q = question || 'Analyze and summarize the result.';
      return maybeAskWithSystem(result, q, tool.systemPrompt);
    }
    return maybeAsk(result, question);
  },
);

// --- list_custom_tools ---
mcp.registerTool(
  'list_custom_tools',
  {
    description: 'List all saved custom tools with their descriptions and parameters.',
    inputSchema: z.object({}),
  },
  async () => {
    const all = getAllTools();
    const tools = all.map(t => ({
      name: t.name,
      description: t.description,
      params: t.params,
      hasSystemPrompt: !!t.systemPrompt,
      systemPromptPreview: t.systemPrompt?.substring(0, 100),
      createdAt: t.createdAt,
    }));
    return text({ count: tools.length, tools });
  },
);

// --- delete_tool ---
mcp.registerTool(
  'delete_tool',
  {
    description: 'Delete a custom tool by name.',
    inputSchema: z.object({
      name: z.string().describe('Name of the custom tool to delete'),
    }),
  },
  async ({ name }) => {
    if (!deleteTool(name)) throw new Error(`Custom tool '${name}' not found`);
    log(`Custom tool deleted: ${name}`);
    return text({ deleted: name, remaining: toolCount() });
  },
);

// ─── Start ───

initHaiku();
spawnNative();
const transport = new StdioServerTransport();
await mcp.connect(transport);
log('MCP server running (stdio)');
