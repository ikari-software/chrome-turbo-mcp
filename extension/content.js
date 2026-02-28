// Chrome Turbo MCP — Content Script
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
        let idx = 0, count = 0;
        for (let j = 0; j < sibs.length; j++) {
          if (sibs[j].tagName === cur.tagName) {
            count++;
            if (sibs[j] === cur) idx = count;
          }
        }
        if (count > 1) s += ':nth-of-type(' + idx + ')';
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
  function getPageStructure({ selector, maxDepth = 6, visibleOnly = true }) {
    const root = selector ? document.querySelector(selector) : document.body;
    if (!root) throw new Error('Element not found: ' + selector);

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

    return { yaml: lines.join('\n'), viewport: vp };
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

  // --- Message router ---
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'ping') {
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
