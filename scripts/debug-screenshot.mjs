/**
 * Debug screenshot - check for errors
 */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const clientJs = await readFile(resolve(root, 'lib/client.js'), 'utf8');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"/>
<style>
:root {
  --dsw-alias-bg-base: #f7f8fa;
  --dsw-alias-label-primary: #1a1a1a;
}
body { margin: 0; padding: 20px; background: #f7f8fa; color: #1a1a1a; font-family: sans-serif; }
#root { width: 100%; height: 100vh; }
#error-log { position: fixed; top: 0; right: 0; background: yellow; padding: 10px; max-width: 400px; z-index: 9999; font-size: 12px; }
</style>
</head>
<body>
<div id="root"></div>
<div id="error-log"></div>

<script>
window.onerror = function(msg, url, line, col, error) {
  const log = document.getElementById('error-log');
  log.innerHTML += '<div>ERROR: ' + msg + ' at ' + url + ':' + line + '</div>';
  console.error('ERROR:', msg, error);
};
window.addEventListener('unhandledrejection', function(e) {
  const log = document.getElementById('error-log');
  log.innerHTML += '<div>REJECTION: ' + e.reason + '</div>';
  console.error('REJECTION:', e.reason);
});
</script>

<script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>

<script>
console.log('React loaded:', typeof React);
console.log('ReactDOM loaded:', typeof ReactDOM);

window.__ModuleLoader__ = {
  _m: new Map(),
  load(d) {
    console.log('ModuleLoader.load called for:', d.id);
    this._m.set(d.id, d);
    if (d.factory) {
      const require = (id) => {
        console.log('require called for:', id);
        if (id === 'react') return window.React;
        if (id === 'react-dom') return window.ReactDOM;
        if (id === 'react/jsx-runtime') return window.React;
        const mod = this._m.get(id);
        if (mod && mod.factory) {
          const result = d.factory(require);
          return result;
        }
        throw new Error('Unknown module: ' + id);
      };
      const result = d.factory(require);
      console.log('Factory result:', result);
      this._m.set(d.id + ':x', result);
    }
  },
  get(id) {
    console.log('ModuleLoader.get called for:', id);
    const result = this._m.get(id + ':x');
    console.log('ModuleLoader.get result:', result);
    return result;
  }
};

window.fetch = function(url) {
  console.log('fetch called:', url);
  if (url.includes('/create-status')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        branch: 'feature/zhangsan/2026-03-20-报表导出',
        head: 'abc123',
        dirty: false,
        inProgress: false,
        canUpdateMain: false,
        existingRequirement: null
      })
    });
  }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
};
</script>

<script>
console.log('Loading client.js, length:', ${clientJs.length});
try {
  ${clientJs}
  console.log('client.js loaded successfully');
} catch (e) {
  console.error('Failed to load client.js:', e);
  document.getElementById('error-log').innerHTML += '<div>LOAD ERROR: ' + e.message + '</div>';
}
</script>

<script>
console.log('Attempting to render...');
try {
  const ctx = window.__ModuleLoader__.get('@local/req-hub');
  console.log('Got context:', ctx);
  
  if (!ctx) {
    document.getElementById('error-log').innerHTML += '<div>NO CONTEXT</div>';
    throw new Error('No context returned from ModuleLoader');
  }
  
  const { CreateDirForm, DocsViewerContext } = ctx;
  console.log('CreateDirForm:', CreateDirForm);
  console.log('DocsViewerContext:', DocsViewerContext);
  
  if (!CreateDirForm) {
    document.getElementById('error-log').innerHTML += '<div>NO CreateDirForm</div>';
    throw new Error('No CreateDirForm in context');
  }
  
  const h = React.createElement;
  const root = ReactDOM.createRoot(document.getElementById('root'));
  
  const element = h(DocsViewerContext.Provider, 
    { value: { refreshTree: () => {}, refreshSelectedReq: () => {} } },
    h('div', { style: { padding: '20px' } },
      h(CreateDirForm, {
        workspaceId: 'ws-1',
        docsDir: 'docs',
        onClose: () => {},
        initialCreateBranch: false,
        refreshVersion: 0
      })
    )
  );
  
  console.log('Rendering element:', element);
  root.render(element);
  console.log('Render called successfully');
  
  document.getElementById('error-log').innerHTML += '<div>RENDER OK</div>';
} catch (e) {
  console.error('Render failed:', e);
  document.getElementById('error-log').innerHTML += '<div>RENDER ERROR: ' + e.message + '<br>' + e.stack + '</div>';
}
</script>
</body>
</html>`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });

page.on('console', msg => {
  console.log('BROWSER:', msg.text());
});

page.on('pageerror', err => {
  console.log('PAGE ERROR:', err.message);
});

await page.setContent(html, { waitUntil: 'networkidle', timeout: 10000 });
await page.waitForTimeout(2000);

const errorLog = await page.evaluate(() => document.getElementById('error-log').innerText);
console.log('\n=== Error Log ===');
console.log(errorLog);

await page.screenshot({ path: resolve(root, 'docs/debug-test.png'), fullPage: false });
console.log('\nScreenshot saved to docs/debug-test.png');

await browser.close();
