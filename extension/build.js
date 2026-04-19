#!/usr/bin/env node
// Build script: produces dist/chrome/ and dist/firefox/ from the single source extension.
// Chrome: uses service_worker for background
// Firefox: uses scripts array for background (event page)

const fs = require('fs');
const path = require('path');

const SRC = __dirname;
const DIST = path.join(SRC, 'dist');
const SHARED = ['background.js', 'content.js', 'popup.html', 'popup.js'];

function build() {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

  for (const target of ['chrome', 'firefox']) {
    const out = path.join(DIST, target);
    fs.mkdirSync(out, { recursive: true });

    // Copy shared files
    for (const f of SHARED) {
      const src = path.join(SRC, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(out, f));
      }
    }

    // Build target-specific manifest
    const m = JSON.parse(JSON.stringify(manifest));

    if (target === 'firefox') {
      // Firefox MV3: uses scripts array, not service_worker
      m.background = { scripts: ['background.js'] };
      // Add gecko settings
      m.browser_specific_settings = {
        gecko: {
          id: 'turbo-mcp@turbo.local',
          strict_min_version: '128.0',
        },
      };
      // Rename (drop "Chrome" prefix)
      m.name = 'Turbo MCP';
      m.action.default_title = 'Turbo MCP';
    }

    fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
    console.log(`${target}: ${out}`);
  }
}

build();
