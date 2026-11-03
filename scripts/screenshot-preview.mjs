import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(__dirname, 'preview.html');

const scenarios = [
  { name: 'create-form', scene: 'create', theme: 'light', viewport: { width: 900, height: 600 } },
  { name: 'create-form', scene: 'create', theme: 'dark', viewport: { width: 900, height: 600 } },
  { name: 'create-form', scene: 'create', theme: 'light', viewport: { width: 400, height: 700 } },
  { name: 'create-form', scene: 'create', theme: 'dark', viewport: { width: 400, height: 700 } },
  { name: 'req-modal', scene: 'req', theme: 'light', viewport: { width: 900, height: 600 } },
  { name: 'req-modal', scene: 'req', theme: 'dark', viewport: { width: 900, height: 600 } },
  { name: 'req-modal', scene: 'req', theme: 'light', viewport: { width: 400, height: 700 } },
  { name: 'req-modal', scene: 'req', theme: 'dark', viewport: { width: 400, height: 700 } },
  { name: 'ws-modal', scene: 'ws', theme: 'light', viewport: { width: 900, height: 600 } },
  { name: 'ws-modal', scene: 'ws', theme: 'dark', viewport: { width: 900, height: 600 } },
  { name: 'ws-modal', scene: 'ws', theme: 'light', viewport: { width: 400, height: 700 } },
  { name: 'ws-modal', scene: 'ws', theme: 'dark', viewport: { width: 400, height: 700 } },
];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();

for (const scenario of scenarios) {
  const page = await context.newPage();
  await page.setViewportSize(scenario.viewport);
  
  await page.goto(`file:///${htmlPath.replace(/\\/g, '/')}`);
  await page.waitForTimeout(1000);
  
  // Check if page loaded correctly
  const hasPreview = await page.evaluate(() => typeof window.__ReqHubPreview__);
  if (hasPreview !== 'object') {
    console.error(`✗ Failed to load preview for ${scenario.name}-${scenario.theme}-${scenario.viewport.width}px`);
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.waitForTimeout(2000);
    if (errors.length > 0) {
      console.error('Errors:', errors.slice(0, 5));
    }
    
    // Take a debug screenshot
    await page.screenshot({ path: resolve(__dirname, '..', 'docs', `debug-${scenario.name}-${scenario.theme}.png`) });
    await page.close();
    continue;
  }
  
  // Set theme
  await page.evaluate((theme) => {
    document.body.setAttribute('data-theme', theme);
  }, scenario.theme);
  
  // Set scene
  await page.evaluate((scene) => {
    window.setScene(scene);
  }, scenario.scene);
  
  await page.waitForTimeout(500);
  
  const filename = `${scenario.name}-${scenario.theme}-${scenario.viewport.width}px.png`;
  await page.screenshot({ path: resolve(__dirname, '..', 'docs', filename) });
  console.log(`✓ ${filename}`);
  
  await page.close();
}

await browser.close();
console.log('Done.');
