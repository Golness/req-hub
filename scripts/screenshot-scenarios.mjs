import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(__dirname, 'screenshot-scenarios.html');

const scenes = [
  { id: 'scene-1', name: 'scenario-1-manual-create' },
  { id: 'scene-2', name: 'scenario-2-main-branch' },
  { id: 'scene-3', name: 'scenario-3-locate-invalid-branch' },
  { id: 'scene-4', name: 'scenario-4-browse-requirements' },
  { id: 'scene-5', name: 'scenario-5-switch-workspace' },
  { id: 'scene-6', name: 'scenario-6-existing-requirement' },
];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
await page.goto(`file:///${htmlPath.replace(/\\/g, '/')}`, { waitUntil: 'networkidle' });

for (const scene of scenes) {
  const el = page.locator(`#${scene.id}`);
  await el.screenshot({ path: resolve(__dirname, `../docs/${scene.name}.png`) });
  console.log(`✓ ${scene.name}.png`);
}

await browser.close();
console.log('Done.');
