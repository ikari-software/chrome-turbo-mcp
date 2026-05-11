// TurboWeb MCP by ikari — Content Script
// Runs in every page. Handles DOM queries, spatial mapping, OCR, clicks, typing.
// Communicates with background.js via chrome.runtime messages.

(() => {
  'use strict';

  // --- Selector generation ---
  function sel(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const tid = el.getAttribute('data-testid');
    if (tid) return `[data-testid="${tid}"]`;
    const parts = [];
    let cur = el;
    for (let i = 0; i < 5 && cur && cur !== document.body && cur !== document.documentElement; i++) {
      let s = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
      const parent = cur.parentElement;
      if (parent) {
        const sibs = parent.children;
        if (sibs.length > 1) {
          const same = Array.from(sibs).filter(node => node.tagName === cur.tagName);
          if (same.length > 1) {
            const idx = same.indexOf(cur) + 1;
            s += ':nth-of-type(' + idx + ')';
          }
        }
      }
      parts.unshift(s);
      cur = parent;
    }
    return parts.join('>');
  }

  // --- Viewport info (included in many responses) ---
  function viewport() {
    return {
      w: window.innerWidth,
      h: window.innerHeight,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      pageW: document.documentElement.scrollWidth,
      pageH: document.documentElement.scrollHeight,
      dpr: window.devicePixelRatio,
    };
  }

  // --- Extract visible text with positions (DOM-based OCR) ---
  // Now supports: selector scope, region filter {rx,ry,rw,rh}, and max results
  function extractText({ selector, region, max = 500 } = {}) {
    const root = selector ? document.querySelector(selector) : document.body;
    if (!root) throw new Error('Element not found: ' + selector);

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const blocks = new Map();
    while (walker.nextNode()) {
      const p = walker.currentNode.parentElement;
      if (!blocks.has(p)) blocks.set(p, []);
      blocks.get(p).push(walker.currentNode.textContent.trim());
    }

    const out = [];
    for (const [el, texts] of blocks) {
      if (out.length >= max) break;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      // Region filter: skip if outside specified rectangle
      if (region) {
        const { rx, ry, rw, rh } = region;
        if (r.right < rx || r.left > rx + rw || r.bottom < ry || r.top > ry + rh) continue;
      }
      const text = texts.join(' ').trim();
      if (!text) continue;
      out.push({
        text: text.substring(0, 500),
        x: Math.round(r.x), y: Math.round(r.y),
        w: Math.round(r.width), h: Math.round(r.height),
        tag: el.tagName.toLowerCase(),
      });
    }
    return { viewport: viewport(), count: out.length, blocks: out };
  }

  // --- Find elements by visible text (like Cmd+F but structured) ---
  function findText({ query, max = 20, caseSensitive = false }) {
    if (!query) throw new Error('query is required');
    const q = caseSensitive ? query : query.toLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const t = caseSensitive ? node.textContent : node.textContent.toLowerCase();
        if (!t.includes(q)) return NodeFilter.FILTER_REJECT;
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    // Dedupe by parent element
    const seen = new Set();
    const out = [];
    while (walker.nextNode() && out.length < max) {
      const el = walker.currentNode.parentElement;
      if (seen.has(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      out.push({
        text: el.innerText.substring(0, 300),
        x: Math.round(r.x), y: Math.round(r.y),
        w: Math.round(r.width), h: Math.round(r.height),
        tag: el.tagName.toLowerCase(),
        selector: sel(el),
      });
    }
    return { query, found: out.length, results: out };
  }

  // --- Inspect: deep one-shot inspection of an element ---
  // Find by selector, coordinates, or text search. Returns everything useful in one call.
  function inspectElement({ selector, x, y, text: searchText, depth = 2 }) {
    let el;
    if (selector) {
      el = document.querySelector(selector);
    } else if (x !== undefined && y !== undefined) {
      el = document.elementFromPoint(x, y);
    } else if (searchText) {
      // Find first element containing this text
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(n) { return n.textContent.includes(searchText) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; }
      });
      if (walker.nextNode()) el = walker.currentNode.parentElement;
    }
    if (!el) throw new Error('Element not found');

    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);

    // Gather attributes
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = a.value.substring(0, 200);

    // Parent chain (compact)
    const parents = [];
    let cur = el.parentElement;
    for (let i = 0; i < 5 && cur && cur !== document.documentElement; i++) {
      const pr = cur.getBoundingClientRect();
      parents.push({
        tag: cur.tagName.toLowerCase(),
        id: cur.id || undefined,
        cls: (cur.className || '').toString().split(/\s+/).filter(c => c.length < 40).slice(0, 3).join(' ') || undefined,
        rect: { x: Math.round(pr.x), y: Math.round(pr.y), w: Math.round(pr.width), h: Math.round(pr.height) },
      });
      cur = cur.parentElement;
    }

    // Children summary (up to depth)
    function summarizeChildren(node, d) {
      if (d > depth) return null;
      const kids = [...node.children];
      if (!kids.length) return null;
      return kids.slice(0, 20).map(c => {
        const cr = c.getBoundingClientRect();
        const entry = {
          tag: c.tagName.toLowerCase(),
          text: (c.innerText || '').substring(0, 120).replace(/\n/g, ' '),
          rect: { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height) },
        };
        if (c.id) entry.id = c.id;
        const sub = summarizeChildren(c, d + 1);
        if (sub) entry.children = sub;
        return entry;
      });
    }

    // Nearby siblings
    const siblings = [];
    const parent = el.parentElement;
    if (parent) {
      const sibs = [...parent.children];
      const idx = sibs.indexOf(el);
      for (let i = Math.max(0, idx - 2); i < Math.min(sibs.length, idx + 3); i++) {
        if (sibs[i] === el) continue;
        const sr = sibs[i].getBoundingClientRect();
        siblings.push({
          tag: sibs[i].tagName.toLowerCase(),
          text: (sibs[i].innerText || '').substring(0, 100).replace(/\n/g, ' '),
          rect: { x: Math.round(sr.x), y: Math.round(sr.y), w: Math.round(sr.width), h: Math.round(sr.height) },
        });
      }
    }

    return {
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || '').substring(0, 1000),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      selector: sel(el),
      attrs,
      style: {
        display: cs.display, position: cs.position,
        bg: cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : undefined,
        border: cs.borderWidth !== '0px' ? `${cs.borderColor} ${cs.borderWidth}` : undefined,
        font: `${cs.fontSize} ${cs.fontWeight} ${cs.fontFamily.split(',')[0]}`,
      },
      parents,
      children: summarizeChildren(el, 0),
      siblings,
    };
  }

  // --- Interactive element map with spatial positions ---
  function getInteractiveMap() {
    const Q = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[onclick],[tabindex]:not([tabindex="-1"]),summary,[contenteditable="true"]';
    const els = document.querySelectorAll(Q);
    const items = [];

    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      // Skip offscreen
      if (r.bottom < 0 || r.top > window.innerHeight + 100) continue;
      if (r.right < 0 || r.left > window.innerWidth + 100) continue;

      const item = {
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().substring(0, 120),
        x: Math.round(r.x), y: Math.round(r.y),
        w: Math.round(r.width), h: Math.round(r.height),
        selector: sel(el),
      };

      // Enrich based on element type
      const role = el.getAttribute('role');
      if (role) item.role = role;
      const aria = el.getAttribute('aria-label');
      if (aria) item.ariaLabel = aria;
      if (el.tagName === 'A') item.href = el.href;
      if (el.tagName === 'INPUT') {
        item.inputType = el.type;
        item.value = el.value;
        item.name = el.name;
        if (el.placeholder) item.placeholder = el.placeholder;
        if (el.checked !== undefined) item.checked = el.checked;
      }
      if (el.tagName === 'SELECT') {
        item.value = el.value;
        item.options = [...el.options].slice(0, 20).map(o => ({ v: o.value, t: o.text, s: o.selected }));
      }
      if (el.tagName === 'TEXTAREA') {
        item.value = el.value;
        item.name = el.name;
      }
      if (el.disabled) item.disabled = true;

      items.push(item);
    }

    return { viewport: viewport(), elements: items };
  }

  // --- CSS selector query with positions ---
  function queryElements({ selector, limit = 50 }) {
    const els = document.querySelectorAll(selector);
    const out = [];
    let i = 0;
    for (const el of els) {
      if (i++ >= limit) break;
      const r = el.getBoundingClientRect();
      const attrs = {};
      for (const a of el.attributes) attrs[a.name] = a.value.substring(0, 200);
      out.push({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().substring(0, 300),
        x: Math.round(r.x), y: Math.round(r.y),
        w: Math.round(r.width), h: Math.round(r.height),
        attrs,
        selector: sel(el),
      });
    }
    return { viewport: viewport(), count: els.length, elements: out };
  }

  // --- Click ---
  function clickElement({ selector, x, y }) {
    let el;
    if (selector) {
      el = document.querySelector(selector);
      if (!el) throw new Error('Element not found: ' + selector);
    } else if (x !== undefined && y !== undefined) {
      el = document.elementFromPoint(x, y);
      if (!el) throw new Error(`No element at (${x}, ${y})`);
    } else {
      throw new Error('Provide selector or x,y coordinates');
    }

    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };

    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));

    return { clicked: sel(el), x: Math.round(cx), y: Math.round(cy) };
  }

  // --- Type text ---
  function typeText({ selector, text, clear = false, pressEnter = false }) {
    const el = selector ? document.querySelector(selector) : document.activeElement;
    if (!el) throw new Error('Element not found: ' + (selector || 'activeElement'));

    el.focus();

    if (clear) {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.select();
      } else {
        document.execCommand('selectAll');
      }
      document.execCommand('delete');
    }

    // insertText triggers proper input events (works with React, Vue, etc.)
    document.execCommand('insertText', false, text);

    if (pressEnter) {
      const enterOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
      el.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
      el.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
      el.dispatchEvent(new KeyboardEvent('keyup', enterOpts));
    }

    return { typed: text.length, element: sel(el) };
  }

  // --- Scroll ---
  function scrollPage({ x, y, selector, direction, amount }) {
    if (selector) {
      const el = document.querySelector(selector);
      if (!el) throw new Error('Element not found: ' + selector);
      el.scrollBy({ left: x || 0, top: y || 0, behavior: 'instant' });
    } else if (direction) {
      const dist = amount || window.innerHeight * 0.8;
      const map = { up: [0, -dist], down: [0, dist], left: [-dist, 0], right: [dist, 0] };
      const [dx, dy] = map[direction] || [0, 0];
      window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    } else {
      window.scrollBy({ left: x || 0, top: y || 0, behavior: 'instant' });
    }
    return { scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) };
  }

  // --- Get HTML (with depth/length limits) ---
  function getHTML({ selector, outer = false, maxDepth = 0, maxLength = 200000 }) {
    const el = selector ? document.querySelector(selector) : document.documentElement;
    if (!el) throw new Error('Element not found: ' + selector);

    let html;
    if (maxDepth > 0) {
      // Depth-limited HTML: truncate deeply nested content
      html = depthLimitedHTML(el, maxDepth, outer);
    } else {
      html = outer ? el.outerHTML : el.innerHTML;
    }
    const clamped = Math.min(Math.max(maxLength, 1000), 500000);
    return { html: html.substring(0, clamped), truncated: html.length > clamped, length: html.length };
  }

  function depthLimitedHTML(el, maxDepth, outer = false) {
    function recurse(node, depth) {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const tag = node.tagName.toLowerCase();
      const attrs = [...node.attributes].map(a => ` ${a.name}="${a.value.substring(0, 100)}"`).join('');

      if (depth >= maxDepth) {
        const childText = (node.textContent || '').trim();
        if (childText) {
          const childCount = node.children.length;
          return `<${tag}${attrs}>${childText.substring(0, 200)}${childCount > 0 ? ` [${childCount} children]` : ''}</${tag}>`;
        }
        return `<${tag}${attrs} />`;
      }

      const children = [...node.childNodes].map(c => recurse(c, depth + 1)).join('');
      return `<${tag}${attrs}>${children}</${tag}>`;
    }

    if (outer) return recurse(el, 0);
    return [...el.childNodes].map(c => recurse(c, 0)).join('');
  }

  // --- YAML Structure: semantic page representation ---
  // More logical than HTML, strips noise, shows structure + content + spatial info
  function getPageStructure({ selector, maxDepth = 6, visibleOnly = true, timeLimitMs = 5000 }) {
    const root = selector ? document.querySelector(selector) : document.body;
    if (!root) throw new Error('Element not found: ' + selector);

    const deadline = Date.now() + timeLimitMs;
    let timedOut = false;

    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'META', 'LINK', 'BR', 'HR']);
    const SEMANTIC = new Set(['HEADER', 'NAV', 'MAIN', 'ARTICLE', 'SECTION', 'ASIDE', 'FOOTER', 'FORM', 'DIALOG', 'TABLE']);
    const HEADING = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
    const INLINE = new Set(['SPAN', 'STRONG', 'EM', 'B', 'I', 'A', 'CODE', 'SMALL', 'SUB', 'SUP', 'MARK', 'ABBR', 'LABEL']);

    let lines = [];
    const vp = viewport();
    lines.push(`page:`);
    lines.push(`  title: ${JSON.stringify(document.title)}`);
    lines.push(`  url: ${JSON.stringify(location.href)}`);
    lines.push(`  viewport: {w: ${vp.w}, h: ${vp.h}}`);
    lines.push(`  scroll: {x: ${vp.scrollX}, y: ${vp.scrollY}}`);
    lines.push(`  content:`);

    function isVisible(el) {
      if (!visibleOnly) return true;
      const st = getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
    }

    function directText(el) {
      let text = '';
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const t = child.textContent.trim();
          if (t) text += (text ? ' ' : '') + t;
        }
      }
      return text;
    }

    function nodeType(el) {
      const tag = el.tagName;
      if (HEADING.has(tag)) return tag.toLowerCase();
      if (tag === 'P') return 'p';
      if (tag === 'A') return 'link';
      if (tag === 'IMG') return 'img';
      if (tag === 'BUTTON' || el.getAttribute('role') === 'button') return 'button';
      if (tag === 'INPUT') return 'input';
      if (tag === 'SELECT') return 'select';
      if (tag === 'TEXTAREA') return 'textarea';
      if (tag === 'TABLE') return 'table';
      if (tag === 'UL' || tag === 'OL') return 'list';
      if (tag === 'LI') return 'item';
      if (tag === 'FORM') return 'form';
      if (tag === 'VIDEO') return 'video';
      if (tag === 'AUDIO') return 'audio';
      if (tag === 'IFRAME') return 'iframe';
      if (SEMANTIC.has(tag)) return tag.toLowerCase();
      if (tag === 'DIV' || tag === 'SPAN') return null; // generic container
      return tag.toLowerCase();
    }

    function posStr(el) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 && r.height < 1) return '';
      return ` @${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    }

    function processNode(el, indent, depth) {
      if (timedOut) return;
      if (Date.now() > deadline) { timedOut = true; return; }
      if (depth > maxDepth) return;
      if (SKIP.has(el.tagName)) return;
      if (el.nodeType !== Node.ELEMENT_NODE) return;
      if (!isVisible(el)) return;

      const pad = '    ' + '  '.repeat(indent);
      const type = nodeType(el);
      const pos = posStr(el);
      const text = directText(el);
      const role = el.getAttribute('role');
      const ariaLabel = el.getAttribute('aria-label');

      // Determine what to output
      if (el.tagName === 'INPUT') {
        const attrs = [];
        if (el.type && el.type !== 'text') attrs.push(`type: ${el.type}`);
        if (el.name) attrs.push(`name: ${el.name}`);
        if (el.value) attrs.push(`value: ${JSON.stringify(el.value)}`);
        if (el.placeholder) attrs.push(`placeholder: ${JSON.stringify(el.placeholder)}`);
        if (el.checked) attrs.push('checked: true');
        if (el.disabled) attrs.push('disabled: true');
        lines.push(`${pad}- input: {${attrs.join(', ')}}${pos}`);
        return;
      }

      if (el.tagName === 'SELECT') {
        const opts = [...el.options].slice(0, 10).map(o => `${o.selected ? '*' : ''}${o.text}`).join(', ');
        lines.push(`${pad}- select: [${opts}]${pos}`);
        return;
      }

      if (el.tagName === 'TEXTAREA') {
        lines.push(`${pad}- textarea: ${JSON.stringify((el.value || '').substring(0, 100))}${pos}`);
        return;
      }

      if (el.tagName === 'IMG') {
        const alt = el.alt || '';
        lines.push(`${pad}- img: ${JSON.stringify(alt)}${pos}`);
        return;
      }

      if (el.tagName === 'A') {
        const href = el.getAttribute('href') || '';
        lines.push(`${pad}- link: ${JSON.stringify(text.substring(0, 100))} -> ${href.substring(0, 150)}${pos}`);
        // Don't recurse into links — text is enough
        return;
      }

      if (HEADING.has(el.tagName)) {
        lines.push(`${pad}- ${el.tagName.toLowerCase()}: ${JSON.stringify(text.substring(0, 200))}${pos}`);
        return;
      }

      if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') {
        lines.push(`${pad}- button: ${JSON.stringify(text.substring(0, 100))}${pos}`);
        return;
      }

      // For lists
      if (el.tagName === 'UL' || el.tagName === 'OL') {
        const items = [...el.querySelectorAll(':scope > li')];
        if (items.length > 0) {
          lines.push(`${pad}- list: (${items.length} items)${pos}`);
          items.slice(0, 20).forEach(li => {
            const liText = (li.textContent || '').trim().substring(0, 150);
            lines.push(`${pad}  - ${JSON.stringify(liText)}`);
          });
          return;
        }
      }

      // For tables — extract structure
      if (el.tagName === 'TABLE') {
        const rows = el.querySelectorAll('tr');
        lines.push(`${pad}- table: (${rows.length} rows)${pos}`);
        [...rows].slice(0, 15).forEach((row, i) => {
          const cells = [...row.querySelectorAll('th, td')].map(c => c.textContent.trim().substring(0, 50));
          lines.push(`${pad}  ${i === 0 ? 'header' : `row${i}`}: [${cells.join(' | ')}]`);
        });
        return;
      }

      // Generic containers: only output if they have semantic meaning or direct text
      const hasSemanticType = type && !INLINE.has(el.tagName);
      const hasContent = text.length > 0;
      const hasChildren = el.children.length > 0;

      if (hasSemanticType || (hasContent && !INLINE.has(el.tagName))) {
        if (hasChildren && depth < maxDepth) {
          const label = type || 'group';
          const roleStr = role ? ` [role=${role}]` : '';
          const ariaStr = ariaLabel ? ` "${ariaLabel}"` : '';
          const textStr = text && !hasChildren ? `: ${JSON.stringify(text.substring(0, 200))}` : '';
          lines.push(`${pad}- ${label}${roleStr}${ariaStr}${textStr}${pos}:`);
          for (const child of el.children) {
            processNode(child, indent + 1, depth + 1);
          }
        } else if (text) {
          const label = type || 'text';
          lines.push(`${pad}- ${label}: ${JSON.stringify(text.substring(0, 300))}${pos}`);
        }
      } else {
        // Transparent wrapper — just process children
        for (const child of el.children) {
          processNode(child, indent, depth);
        }
      }
    }

    for (const child of root.children) {
      processNode(child, 0, 0);
    }

    return { yaml: lines.join('\n'), viewport: vp, timedOut };
  }

  // --- Execute arbitrary JS in page context ---
  // Note: This runs in content script isolated world. For page-context JS,
  // background.js uses chrome.scripting.executeScript with world:'MAIN'.
  // This is a fallback for simpler expressions.
  function executeJS({ code }) {
    try {
      const result = eval(code);
      return { result: JSON.parse(JSON.stringify(result ?? null)) };
    } catch (e) {
      return { error: e.message, stack: e.stack };
    }
  }

  // --- Adapt: inject and run a custom script ---
  function injectScript({ code, returnVar }) {
    return new Promise((resolve) => {
      const script = document.createElement('script');
      const callbackName = '__turbo_cb_' + Date.now();
      const wrappedCode = `
        try {
          const __result = (function() { ${code} })();
          window.postMessage({ type: '${callbackName}', result: JSON.parse(JSON.stringify(__result ?? null)) }, '*');
        } catch(e) {
          window.postMessage({ type: '${callbackName}', error: e.message }, '*');
        }
      `;

      function listener(event) {
        if (event.data?.type === callbackName) {
          window.removeEventListener('message', listener);
          script.remove();
          resolve(event.data.error ? { error: event.data.error } : { result: event.data.result });
        }
      }
      window.addEventListener('message', listener);

      script.textContent = wrappedCode;
      (document.head || document.documentElement).appendChild(script);

      // Timeout fallback
      setTimeout(() => {
        window.removeEventListener('message', listener);
        script.remove();
        resolve({ error: 'Script execution timed out (10s)' });
      }, 10000);
    });
  }

  // --- Agent overlay -----------------------------------------------------
  // A tiny on-page UI (Shadow-DOM-isolated) that shows the human user what
  // the agent is doing in real time: a persistent badge in the top-right
  // identifying who's driving, an animated cursor that moves to click
  // targets with a sin-eased ease, a flash/highlight on the target, and a
  // toast with the agent's stated intent. None of this is visible to the
  // page itself (Shadow DOM, pointer-events: none).
  const overlay = (() => {
    let root = null;
    let cursor = null;
    let toastEl = null;
    let badge = null;
    let badgeTimer = null;
    let toastTimer = null;
    let idleFadeTimer = null;
    let cursorPos = { x: window.innerWidth / 2, y: -40 };
    // After this much agent inactivity the cursor and badge fade away so
    // they don't permanently obscure the page.
    const IDLE_FADE_MS = 45_000;

    function robotSVG(size = 14, color = '#d29922') {
      return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
        <rect x="3" y="5" width="10" height="8" rx="2"/>
        <line x1="8" y1="5" x2="8" y2="3"/>
        <circle cx="8" cy="2.5" r="0.7" fill="${color}"/>
        <circle cx="6" cy="9" r="0.9" fill="${color}"/>
        <circle cx="10" cy="9" r="0.9" fill="${color}"/>
      </svg>`;
    }

    function ensure() {
      if (root) return;
      // Don't render the overlay inside iframes — only the top frame.
      if (window.top !== window) return;

      const host = document.createElement('div');
      host.id = '__turbo_overlay_host';
      host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
      (document.body || document.documentElement).appendChild(host);

      const sr = host.attachShadow({ mode: 'closed' });

      const style = document.createElement('style');
      style.textContent = `
        :host, * { box-sizing: border-box; }
        .badge {
          position: fixed; top: 12px; right: 12px;
          display: flex; align-items: center; gap: 6px;
          padding: 5px 10px;
          background: rgba(13, 17, 23, 0.92);
          border: 1px solid #d29922;
          border-radius: 16px;
          color: #c9d1d9;
          font: 11px/1.2 'SF Mono', Menlo, monospace;
          backdrop-filter: blur(6px);
          opacity: 0;
          transition: opacity 200ms ease;
          max-width: 360px;
          pointer-events: none;
        }
        .badge.on { opacity: 1; }
        .badge .agent-name { color: #d29922; font-weight: 600; flex-shrink: 0; }
        .badge .label { color: #c9d1d9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .badge svg { flex-shrink: 0; }
        .cursor {
          position: fixed; top: 0; left: 0;
          width: 28px; height: 28px;
          transform: translate(-1000px, -1000px);
          will-change: transform;
          pointer-events: none;
          z-index: 10;
          opacity: 0;
          transition: opacity 200ms ease;
          filter: drop-shadow(0 4px 8px rgba(0,0,0,0.4));
        }
        .cursor.on { opacity: 1; }
        .cursor svg.pointer { width: 24px; height: 24px; }
        .cursor .robot {
          position: absolute;
          top: 14px; left: 16px;
          width: 22px; height: 22px;
          background: #d29922;
          border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          box-shadow: 0 2px 6px rgba(0,0,0,0.3);
          border: 1.5px solid #0d1117;
        }
        .cursor.click .pointer { animation: clickPulse 350ms ease-out; }
        @keyframes clickPulse {
          0%   { transform: scale(1); }
          40%  { transform: scale(0.78); }
          100% { transform: scale(1); }
        }
        .ripple {
          position: fixed;
          border: 3px solid var(--ripple-ring, #d29922);
          border-radius: 50%;
          pointer-events: none;
          animation: rippleAnim 600ms cubic-bezier(0.18, 0.7, 0.4, 1) forwards;
        }
        @keyframes rippleAnim {
          0%   { width: 14px;  height: 14px;  margin-left: -7px;   margin-top: -7px;  opacity: 1;   border-width: 3px; }
          100% { width: 130px; height: 130px; margin-left: -65px;  margin-top: -65px; opacity: 0;   border-width: 1px; }
        }
        .ripple-fill {
          position: fixed;
          border-radius: 50%;
          pointer-events: none;
          background: radial-gradient(circle, var(--ripple-fill, rgba(210, 153, 34, 0.55)), transparent 70%);
          animation: rippleFill 420ms ease-out forwards;
        }
        @keyframes rippleFill {
          0%   { width: 12px;  height: 12px;  margin-left: -6px;   margin-top: -6px;  opacity: 0.85; }
          100% { width: 70px;  height: 70px;  margin-left: -35px;  margin-top: -35px; opacity: 0;    }
        }
        .highlight {
          position: fixed;
          border: 2px solid var(--highlight-color, #d29922);
          border-radius: 4px;
          pointer-events: none;
          box-shadow: 0 0 18px var(--highlight-glow, rgba(210, 153, 34, 0.6));
          animation: highlightFade 1100ms ease-out forwards;
        }
        @keyframes highlightFade {
          0%   { opacity: 0.95; }
          100% { opacity: 0; }
        }
        /* Loupe: a glowing ring shown over each match during read-only
           scans (find_text, extract_text). Communicates "the agent looked
           here" even though no actual click happens. */
        .loupe {
          position: fixed;
          width: 64px; height: 64px;
          margin-left: -32px; margin-top: -32px;
          border: 3px solid #58a6ff;
          border-radius: 50%;
          background: radial-gradient(circle, rgba(88, 166, 255, 0.18), transparent 70%);
          box-shadow: 0 0 14px rgba(88, 166, 255, 0.55), inset 0 0 8px rgba(88, 166, 255, 0.4);
          pointer-events: none;
          animation: loupeIn 360ms ease-out forwards;
        }
        @keyframes loupeIn {
          0%   { opacity: 0;   transform: scale(0.55); }
          45%  { opacity: 1;   transform: scale(1.1);  }
          100% { opacity: 0;   transform: scale(1);    }
        }
        /* Scan-flash: a thin outline pulse drawn around every interactive
           element after get_interactive_map, so the user sees "the agent
           just enumerated everything you can click." */
        .scan-flash {
          position: fixed;
          border: 1.5px solid rgba(88, 166, 255, 0.85);
          border-radius: 3px;
          pointer-events: none;
          box-shadow: 0 0 6px rgba(88, 166, 255, 0.4);
          animation: scanFlashAnim 700ms ease-out forwards;
        }
        @keyframes scanFlashAnim {
          0%   { opacity: 0;   transform: scale(0.97); }
          25%  { opacity: 1;   transform: scale(1.02); }
          100% { opacity: 0;   transform: scale(1);    }
        }
        /* Failure shake + red tint: applied to the cursor when the tool
           returns an error. The wrapper carries the position transform
           via JS, so we shake the inner SVG instead to avoid clobbering
           the cursor's coordinates. */
        .cursor.error svg.pointer path { fill: #f85149; stroke: #4d1313; }
        .cursor.error .robot { background: #f85149; box-shadow: 0 0 10px rgba(248, 81, 73, 0.7); }
        .cursor.error svg.pointer { animation: shake 420ms ease-out; }
        @keyframes shake {
          0%, 100% { transform: translateX(0)  scale(1); }
          15%      { transform: translateX(-5px) scale(1); }
          30%      { transform: translateX(5px)  scale(1); }
          45%      { transform: translateX(-4px) scale(1); }
          60%      { transform: translateX(4px)  scale(1); }
          80%      { transform: translateX(-2px) scale(1); }
        }
        /* Camera flash for screenshot / turbo_snapshot — quick whitish
           pulse covering the whole viewport so the user can see the
           snapshot the agent just grabbed. */
        .camera-flash {
          position: fixed;
          inset: 0;
          background: rgba(255, 255, 255, 0.4);
          pointer-events: none;
          animation: cameraFlashAnim 320ms ease-out forwards;
        }
        @keyframes cameraFlashAnim {
          0%   { opacity: 0;    }
          20%  { opacity: 1;    }
          100% { opacity: 0;    }
        }
        /* Read sweep: a thin horizontal scanline that travels top→bottom
           in ~520ms, marking "the agent is reading the DOM". Used for
           get_html, page_yaml, dom_snapshot, get_accessibility_tree,
           query_elements, get_storage, get_cookies — anything that
           doesn't have a more specific visualisation. */
        .read-sweep {
          position: fixed;
          left: 0;
          width: 100vw;
          height: 3px;
          top: 0;
          background: linear-gradient(to right,
            transparent 0%,
            rgba(88, 166, 255, 0.6) 30%,
            rgba(88, 166, 255, 0.9) 50%,
            rgba(88, 166, 255, 0.6) 70%,
            transparent 100%);
          box-shadow: 0 0 12px rgba(88, 166, 255, 0.6);
          pointer-events: none;
          animation: readSweepAnim 520ms cubic-bezier(0.4, 0, 0.6, 1) forwards;
        }
        @keyframes readSweepAnim {
          0%   { top: 0;     opacity: 0; }
          15%  { opacity: 1;             }
          85%  { opacity: 1;             }
          100% { top: 100vh; opacity: 0; }
        }
        /* Network/console/storage indicator — small icon pulse near the
           agent badge so monitoring ops register as something even if
           there's no visible page change. */
        .data-pulse {
          position: fixed;
          top: 40px; right: 20px;
          width: 24px; height: 24px;
          border: 2px solid #3fb950;
          border-radius: 50%;
          pointer-events: none;
          animation: dataPulseAnim 600ms ease-out forwards;
        }
        @keyframes dataPulseAnim {
          0%   { transform: scale(0.5); opacity: 0; }
          40%  { transform: scale(1.1); opacity: 1; }
          100% { transform: scale(0.95); opacity: 0; }
        }
        .toast {
          position: fixed;
          bottom: 24px; left: 50%;
          transform: translateX(-50%) translateY(20px);
          padding: 8px 14px;
          background: rgba(13, 17, 23, 0.92);
          border: 1px solid #21262d;
          border-radius: 6px;
          color: #c9d1d9;
          font: 12px/1.3 'SF Mono', Menlo, monospace;
          opacity: 0;
          transition: opacity 200ms ease, transform 200ms ease;
          max-width: 80vw;
          backdrop-filter: blur(6px);
          pointer-events: none;
          font-style: italic;
        }
        .toast.on { opacity: 1; transform: translateX(-50%) translateY(0); }
        .toast .who { color: #d29922; font-weight: 600; font-style: normal; margin-right: 6px; }
      `;

      badge = document.createElement('div');
      badge.className = 'badge';
      badge.innerHTML = `
        ${robotSVG(14, '#d29922')}
        <span class="agent-name">Agent</span>
        <span class="label">idle</span>
      `;

      cursor = document.createElement('div');
      cursor.className = 'cursor';
      cursor.innerHTML = `
        <svg class="pointer" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M5 3 L5 19 L9.5 15 L11.6 21 L14.4 20 L12.3 14 L18 14 Z"
                fill="#fff" stroke="#0d1117" stroke-width="1.4" stroke-linejoin="round"/>
        </svg>
        <div class="robot">${robotSVG(13, '#0d1117')}</div>
      `;

      toastEl = document.createElement('div');
      toastEl.className = 'toast';

      sr.appendChild(style);
      sr.appendChild(badge);
      sr.appendChild(cursor);
      sr.appendChild(toastEl);

      root = sr;
    }

    function setBadge({ display, intent }) {
      ensure();
      if (!badge) return;
      badge.querySelector('.agent-name').textContent = display || 'Agent';
      badge.querySelector('.label').textContent = intent || 'working…';
      badge.classList.add('on');
      clearTimeout(badgeTimer);
      // Fade after a few seconds of inactivity so we don't permanently
      // obscure the page.
      badgeTimer = setTimeout(() => badge.classList.remove('on'), 7000);
    }

    function moveCursorTo(x, y, opts = {}) {
      ensure();
      if (!cursor) return Promise.resolve();
      const start = { ...cursorPos };
      const dx = x - start.x;
      const dy = y - start.y;
      const dist = Math.hypot(dx, dy);
      // Quadratic Bezier control point: midpoint of the straight line
      // pushed perpendicular to the motion direction so the cursor
      // travels along a gentle arc instead of a straight diagonal —
      // closer to how a human flicks the mouse than a robot's
      // shortest-path teleport. The perpendicular `(dy, -dx) / dist`
      // is the unit vector to the right of motion, so left→right hops
      // bow upward, top→bottom hops bow rightward, and so on. Curve
      // depth scales with sqrt(distance), capped at 80px.
      const bow = dist > 0 ? Math.min(80, Math.sqrt(dist) * 3) : 0;
      const perpX = dist > 0 ?  dy / dist : 0;
      const perpY = dist > 0 ? -dx / dist : 0;
      const midX = start.x + dx / 2 + perpX * bow;
      const midY = start.y + dy / 2 + perpY * bow;
      // Sin-eased motion: scale duration with sqrt(distance). Ensures
      // short hops feel snappy and long traversals feel deliberate.
      // ~1.5× faster than the original (147 / 12 / 600 vs 220 / 18 / 900).
      const duration = opts.instant ? 0 : Math.min(600, 147 + Math.sqrt(dist) * 12);
      const t0 = performance.now();
      cursor.classList.add('on');

      return new Promise((resolve) => {
        function step(now) {
          const t = duration === 0 ? 1 : Math.min(1, (now - t0) / duration);
          // 0.5 - 0.5*cos(πt) is a half-cosine (sin) ease in/out: starts
          // and ends slow, full speed at the midpoint. Feels like a
          // human moving the mouse.
          const eased = 0.5 - 0.5 * Math.cos(Math.PI * t);
          // Quadratic Bezier B(u) = (1-u)²·P0 + 2(1-u)u·P1 + u²·P2.
          const u = 1 - eased;
          const cx = u * u * start.x + 2 * u * eased * midX + eased * eased * x;
          const cy = u * u * start.y + 2 * u * eased * midY + eased * eased * y;
          // The pointer's hot-spot is at top-left; offset so the visible
          // tip lines up with (x, y).
          cursor.style.transform = `translate(${cx - 4}px, ${cy - 4}px)`;
          if (t < 1) requestAnimationFrame(step);
          else {
            cursorPos = { x, y };
            resolve();
          }
        }
        requestAnimationFrame(step);
      });
    }

    function clickPulse() {
      if (!cursor) return;
      cursor.classList.remove('click');
      // Force a reflow so the animation restarts.
      void cursor.offsetWidth;
      cursor.classList.add('click');
    }

    // actionPalette returns the colour scheme for visualising a given
    // action: orange for click, blue for type/key, green for scroll, red
    // for error fallback. Each tool category gets a glance-distinguishable
    // ripple/highlight tint so a watching user can tell what just
    // happened without reading the popup.
    function actionPalette(action) {
      switch (action) {
        case 'type_text': case 'cdp_type': case 'cdp_key':
          return { ring: '#58a6ff', fill: 'rgba(88, 166, 255, 0.55)',  glow: 'rgba(88, 166, 255, 0.55)' };
        case 'scroll': case 'cdp_scroll':
          return { ring: '#3fb950', fill: 'rgba(63, 185, 80, 0.45)',   glow: 'rgba(63, 185, 80, 0.5)'   };
        case 'navigate': case 'page_reload':
          return { ring: '#a371f7', fill: 'rgba(163, 113, 247, 0.5)',  glow: 'rgba(163, 113, 247, 0.55)' };
        case '__error':
          return { ring: '#f85149', fill: 'rgba(248, 81, 73, 0.55)',   glow: 'rgba(248, 81, 73, 0.6)'   };
        default: // click, cdp_click, anything unknown
          return { ring: '#d29922', fill: 'rgba(210, 153, 34, 0.55)',  glow: 'rgba(210, 153, 34, 0.6)'  };
      }
    }

    function flashAt(x, y, palette) {
      ensure();
      if (!root) return;
      const p = palette || actionPalette('click');
      // Stack a radial-gradient fill behind the stroked ring so the click
      // reads as a real "tap landed here" beat rather than just a fading
      // outline. Both elements are absolutely positioned at (x, y).
      const fill = document.createElement('div');
      fill.className = 'ripple-fill';
      fill.style.left = x + 'px';
      fill.style.top = y + 'px';
      fill.style.setProperty('--ripple-fill', p.fill);
      root.appendChild(fill);
      setTimeout(() => fill.remove(), 480);

      const ring = document.createElement('div');
      ring.className = 'ripple';
      ring.style.left = x + 'px';
      ring.style.top = y + 'px';
      ring.style.setProperty('--ripple-ring', p.ring);
      root.appendChild(ring);
      setTimeout(() => ring.remove(), 700);
    }

    function highlightRect(rect, palette) {
      ensure();
      if (!root || !rect) return;
      const p = palette || actionPalette('click');
      const h = document.createElement('div');
      h.className = 'highlight';
      h.style.left = (rect.left - 2) + 'px';
      h.style.top = (rect.top - 2) + 'px';
      h.style.width = (rect.width + 4) + 'px';
      h.style.height = (rect.height + 4) + 'px';
      h.style.setProperty('--highlight-color', p.ring);
      h.style.setProperty('--highlight-glow', p.glow);
      root.appendChild(h);
      setTimeout(() => h.remove(), 1200);
    }

    // Loupe: a circular spotlight shown over each match in read-only
    // scans like find_text. Communicates "the agent looked here" without
    // pretending a click happened.
    function loupeAt(x, y) {
      ensure();
      if (!root) return;
      const l = document.createElement('div');
      l.className = 'loupe';
      l.style.left = x + 'px';
      l.style.top = y + 'px';
      root.appendChild(l);
      setTimeout(() => l.remove(), 380);
    }

    // scanFlash: outline-pulse a list of element bboxes briefly. Used by
    // get_interactive_map so the user sees the agent enumerated every
    // interactive element on the page in a single perceptible beat.
    function scanFlash(items) {
      ensure();
      if (!root || !items) return;
      // Cap the simultaneous flashes so we don't spawn 500+ DOM nodes
      // when the page has a huge interactive map.
      const cap = Math.min(items.length, 80);
      for (let i = 0; i < cap; i++) {
        const el = items[i];
        if (!el || !el.w || !el.h) continue;
        const f = document.createElement('div');
        f.className = 'scan-flash';
        f.style.left = el.x + 'px';
        f.style.top = el.y + 'px';
        f.style.width = el.w + 'px';
        f.style.height = el.h + 'px';
        // Stagger by index so it sweeps left-to-right rather than firing
        // every outline at the exact same frame — feels less like a flash
        // bulb, more like a radar sweep.
        f.style.animationDelay = Math.min(280, i * 6) + 'ms';
        root.appendChild(f);
        setTimeout(() => f.remove(), 1100);
      }
    }

    // cameraFlash: viewport-wide white pulse, used when the agent takes
    // a screenshot. Reads as "snap" — a beat the user can register even
    // if the page itself didn't visibly change.
    function cameraFlash() {
      ensure();
      if (!root) return;
      const f = document.createElement('div');
      f.className = 'camera-flash';
      root.appendChild(f);
      setTimeout(() => f.remove(), 360);
    }

    // readSweep: a thin scanline travelling top→bottom across the
    // viewport. Used as the generic "agent is reading the page" cue for
    // any DOM-read tool that doesn't have a more specific visualisation
    // (get_html, page_yaml, dom_snapshot, get_accessibility_tree,
    // query_elements, get_storage, get_cookies, etc.).
    function readSweep() {
      ensure();
      if (!root) return;
      const s = document.createElement('div');
      s.className = 'read-sweep';
      root.appendChild(s);
      setTimeout(() => s.remove(), 560);
    }

    // dataPulse: a small green ring near the top-right corner, used when
    // the agent peeks at non-DOM state (network log, console messages,
    // cookies, storage). Doesn't move the cursor — these ops touch
    // browser state, not the page itself, so animating across the page
    // would be misleading.
    function dataPulse() {
      ensure();
      if (!root) return;
      const p = document.createElement('div');
      p.className = 'data-pulse';
      root.appendChild(p);
      setTimeout(() => p.remove(), 650);
    }

    // scanLoupe: animate the agent cursor across a sequence of result
    // bboxes (find_text, extract_text), placing a loupe at each. Caller
    // is responsible for capping the items list to avoid 30s scans.
    async function scanLoupe(items) {
      for (const it of items) {
        if (!it || typeof it.x !== 'number') continue;
        const cx = it.x + (it.w || 0) / 2;
        const cy = it.y + (it.h || 0) / 2;
        await moveCursorTo(cx, cy);
        loupeAt(cx, cy);
        // Short hold so the user can register what was looked at before
        // the cursor leaves for the next match.
        await new Promise((r) => setTimeout(r, 160));
      }
    }

    function showToast(text, who) {
      ensure();
      if (!toastEl) return;
      toastEl.innerHTML = (who ? `<span class="who">${escapeHtml(who)}</span>` : '') + escapeHtml(text);
      toastEl.classList.add('on');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('on'), 2800);
    }

    function escapeHtml(s) {
      return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function resolveTarget(action, params) {
      if (!params) return null;
      if (action === 'click' || action === 'cdp_click') {
        if (params.selector) {
          const el = document.querySelector(params.selector);
          if (el) {
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, bbox: r };
          }
        }
        if (typeof params.x === 'number' && typeof params.y === 'number') {
          return { x: params.x, y: params.y };
        }
      }
      if (action === 'type_text' && params.selector) {
        const el = document.querySelector(params.selector);
        if (el) {
          const r = el.getBoundingClientRect();
          return { x: r.left + Math.min(20, r.width / 4), y: r.top + r.height / 2, bbox: r, type: 'type' };
        }
      }
      if (action === 'cdp_type' && typeof document.activeElement?.getBoundingClientRect === 'function') {
        const r = document.activeElement.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: r.left + 14, y: r.top + r.height / 2, bbox: r, type: 'type' };
        }
      }
      if (action === 'inspect' && params.selector) {
        const el = document.querySelector(params.selector);
        if (el) {
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, bbox: r, type: 'inspect' };
        }
      }
      return null;
    }

    // Read-only ops that don't have a more specific visualisation in
    // resolveTarget / showResult. We render a generic "agent is reading
    // the page" sweep so the user sees *something* fire when these run —
    // otherwise the popup activity row is the only signal.
    const READ_SWEEP_ACTIONS = new Set([
      'get_html', 'page_yaml', 'get_page_structure',
      'dom_snapshot', 'get_accessibility_tree',
      'query_elements',
    ]);
    // Ops that touch browser state, not the page DOM. Visualised with a
    // small corner pulse rather than a page-wide sweep — animating across
    // the page would be misleading.
    const DATA_PULSE_ACTIONS = new Set([
      'get_cookies', 'set_cookie', 'delete_cookies',
      'get_storage',
      'network_get', 'network_enable', 'network_disable',
      'network_get_body', 'network_throttle',
      'console_get', 'console_enable', 'console_disable', 'console_clear',
      'get_performance', 'css_coverage_start', 'css_coverage_stop',
      'emulate_device', 'page_reload',
    ]);
    const CAMERA_FLASH_ACTIONS = new Set(['screenshot', 'turbo_snapshot']);

    async function showStart({ action, intent, clientLabel, clientType, params }) {
      try {
        const display = clientLabel ? clientLabel.split('/').pop() : 'agent';
        setBadge({ display, intent: intent || `${action}…` });
        if (intent) showToast(intent, display);

        const target = resolveTarget(action, params);
        if (target) {
          const palette = actionPalette(action);
          await moveCursorTo(target.x, target.y);
          if (target.type === 'type' || target.type === 'inspect') {
            highlightRect(target.bbox, palette);
          } else {
            // Default = click-style flash + bbox highlight.
            clickPulse();
            flashAt(target.x, target.y, palette);
            if (target.bbox) highlightRect(target.bbox, palette);
          }
        } else if (CAMERA_FLASH_ACTIONS.has(action)) {
          // turbo_snapshot also fires its element scan-flash via
          // showResult once the result comes back; the camera flash up
          // front is the "the agent just photographed the page" beat.
          cameraFlash();
        } else if (READ_SWEEP_ACTIONS.has(action)) {
          readSweep();
        } else if (DATA_PULSE_ACTIONS.has(action)) {
          dataPulse();
        }
      } catch (e) {
        // Overlay is non-critical; never throw upstream.
      } finally {
        // Reset the idle-fade clock on every overlay activity. After
        // IDLE_FADE_MS of nothing happening, the cursor + badge fade away
        // so the page isn't permanently overlaid.
        scheduleIdleFade();
      }
    }

    // showResult visualises the result of read-only tools that didn't
    // already place a cursor on the page during showStart: find_text and
    // extract_text get a moving loupe sweep, get_interactive_map gets a
    // scan-flash over every interactive element. Anything else is silent.
    async function showResult({ action, result }) {
      try {
        if (!result) return;
        if (action === 'find_text' && Array.isArray(result.results)) {
          // Cap so a 50-match find doesn't take 10 seconds to play out.
          await scanLoupe(result.results.slice(0, 6));
        } else if (action === 'extract_text' && Array.isArray(result.blocks)) {
          await scanLoupe(result.blocks.slice(0, 6));
        } else if (action === 'get_interactive_map' && Array.isArray(result.elements)) {
          scanFlash(result.elements);
        } else if (action === 'turbo_snapshot' && result.interactiveMap?.elements) {
          scanFlash(result.interactiveMap.elements);
        }
      } catch (e) {
        // Visualisation is non-critical.
      } finally {
        scheduleIdleFade();
      }
    }

    // showError flashes a red ripple at the current cursor position and
    // shakes the cursor — a glance-readable "that just failed" cue
    // without forcing the user to expand the popup activity row.
    function showError({ action, error }) {
      try {
        ensure();
        if (cursor) {
          cursor.classList.add('on');
          cursor.classList.add('error');
          setTimeout(() => cursor && cursor.classList.remove('error'), 600);
        }
        flashAt(cursorPos.x, cursorPos.y, actionPalette('__error'));
        const display = badge?.querySelector('.agent-name')?.textContent || 'agent';
        showToast('✗ ' + (error || 'tool failed'), display);
      } catch (e) {
        // Visualisation is non-critical.
      } finally {
        scheduleIdleFade();
      }
    }

    function scheduleIdleFade() {
      if (idleFadeTimer) clearTimeout(idleFadeTimer);
      idleFadeTimer = setTimeout(() => {
        if (cursor) {
          cursor.classList.remove('on');
          // Park the cursor off-screen so its next reveal feels like an
          // entrance rather than a teleport from its last spot.
          cursor.style.transform = 'translate(-1000px, -1000px)';
          cursorPos = { x: window.innerWidth / 2, y: -40 };
        }
        if (badge) badge.classList.remove('on');
      }, IDLE_FADE_MS);
    }

    return { showStart, showResult, showError };
  })();

  // --- Message router ---
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'ping') {
      sendResponse({ ok: true });
      return;
    }

    if (msg.action === '__turbo_overlay') {
      const payload = msg.payload || {};
      if (payload.kind === 'start') {
        // Resolve sendResponse only after the cursor has actually arrived
        // at the target. The background waits on this for click/type
        // actions so the visible click happens AT the cursor, not while
        // the cursor is still in flight. showStart kicks off the ripple
        // synchronously after arrival, so the ripple coincides with the
        // real DOM click that follows.
        overlay.showStart(payload).then(() => sendResponse({ ok: true }));
        return true; // async response
      }
      if (payload.kind === 'result') {
        // Visualise the result of read-only tools (loupe sweep / scan
        // flash). Fire-and-forget; the response can be sync.
        overlay.showResult(payload);
        sendResponse({ ok: true });
        return;
      }
      if (payload.kind === 'error') {
        overlay.showError(payload);
        sendResponse({ ok: true });
        return;
      }
      sendResponse({ ok: true });
      return;
    }

    const handlers = {
      extract_text: (p) => extractText(p),
      find_text: (p) => findText(p),
      inspect: (p) => inspectElement(p),
      get_interactive_map: () => getInteractiveMap(),
      query_elements: (p) => queryElements(p),
      click: (p) => clickElement(p),
      type_text: (p) => typeText(p),
      scroll: (p) => scrollPage(p),
      get_html: (p) => getHTML(p),
      get_page_structure: (p) => getPageStructure(p),
      execute_js_isolated: (p) => executeJS(p),
      inject_script: (p) => injectScript(p),
    };

    const handler = handlers[msg.action];
    if (!handler) {
      sendResponse({ error: 'Unknown action: ' + msg.action });
      return;
    }

    try {
      const result = handler(msg.params || {});
      if (result instanceof Promise) {
        result.then(r => sendResponse(r)).catch(e => sendResponse({ error: e.message }));
        return true; // async
      }
      sendResponse(result);
    } catch (e) {
      sendResponse({ error: e.message });
    }
  });
})();
