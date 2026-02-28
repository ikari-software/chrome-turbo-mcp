// Popup — connects to background for live status updates

const port = chrome.runtime.connect({ name: 'popup' });

port.onMessage.addListener((msg) => {
  switch (msg.type) {
    case 'status': renderStatus(msg); break;
    case 'activity': renderActivity(msg); break;
    case 'stats': renderStats(msg); break;
    case 'log-batch': msg.entries.forEach(e => renderActivity(e)); break;
  }
});

// Request current state
port.postMessage({ type: 'getState' });

// --- Render functions ---

function renderStatus(data) {
  const dot = document.getElementById('dot');
  const label = document.getElementById('status-label');
  const browsers = document.getElementById('browsers');

  dot.className = data.connected ? 'dot on pulse' : 'dot';
  label.textContent = data.connected ? `Connected` : 'Disconnected';
  browsers.textContent = data.connected ? (data.browsers || '').replace(/,/g, ' \u2022 ') : 'No browsers detected';
}

function renderActivity(data) {
  const log = document.getElementById('log');
  const empty = document.getElementById('empty-msg');
  if (empty) empty.remove();

  // Check if this is an update to an existing running entry
  if (data.id) {
    const existing = document.getElementById('entry-' + data.id);
    if (existing && data.status !== 'start') {
      updateEntry(existing, data);
      return;
    }
  }

  const entry = document.createElement('div');
  entry.className = 'entry' + (data.status === 'start' ? ' running' : '');
  if (data.id) entry.id = 'entry-' + data.id;

  const time = new Date(data.timestamp || Date.now()).toLocaleTimeString('en-GB', { hour12: false });

  entry.innerHTML = `
    <span class="time">${time}</span>
    <span class="action${data.error ? ' err' : ''}">${data.action}</span>
    ${data.status === 'start' ? '<div class="spinner"></div>' : `<span class="dur ${durClass(data)}">${durText(data)}</span>`}
  `;

  log.insertBefore(entry, log.firstChild);

  // Cap at 100 entries
  while (log.children.length > 100) log.removeChild(log.lastChild);
}

function updateEntry(el, data) {
  el.className = 'entry';
  const durEl = el.querySelector('.spinner') || el.querySelector('.dur');
  if (durEl) {
    const span = document.createElement('span');
    span.className = `dur ${durClass(data)}`;
    span.textContent = durText(data);
    durEl.replaceWith(span);
  }
  if (data.error) {
    const actionEl = el.querySelector('.action');
    if (actionEl) actionEl.className = 'action err';
  }
}

function durClass(data) {
  if (data.error) return 'err';
  if (data.duration < 200) return 'fast';
  if (data.duration > 2000) return 'slow';
  return '';
}

function durText(data) {
  if (data.error) return 'ERR';
  if (!data.duration && data.duration !== 0) return '-';
  if (data.duration < 1000) return data.duration + 'ms';
  return (data.duration / 1000).toFixed(1) + 's';
}

function renderStats(data) {
  document.getElementById('s-cmds').textContent = data.commands || 0;
  const errs = document.getElementById('s-errs');
  errs.textContent = data.errors || 0;
  errs.className = data.errors > 0 ? 'val warn' : 'val';
  document.getElementById('s-avg').textContent = data.avgMs ? Math.round(data.avgMs) : '-';
  document.getElementById('s-up').textContent = formatUptime(data.uptimeMs || 0);
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h + 'h' + (m % 60) + 'm';
}

// Refresh stats every second (for uptime counter)
setInterval(() => port.postMessage({ type: 'getStats' }), 1000);
