import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
for (const v of ['iso','front','top','right']) {
  const svg = await fs.readFile(`artifacts/cad-smoke/${v}.svg`, 'utf8');
  await page.setContent(`<body style="margin:0">${svg}</body>`);
  await page.screenshot({ path: `artifacts/cad-smoke/${v}.png` });
}
await browser.close();
console.log('rasterized');
