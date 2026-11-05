/**
 * npm run video:end-card — renders docs/video/end-card.html to docs/video/end-card.png (1920x1080)
 * with an installed browser (PLAYWRIGHT_CHANNEL, default msedge), so nothing is downloaded.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const dir = join(import.meta.dirname, '..', 'docs', 'video');
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(pathToFileURL(join(dir, 'end-card.html')).href);
  await page.screenshot({ path: join(dir, 'end-card.png') });
  console.log(`wrote ${join(dir, 'end-card.png')}`);
} finally {
  await browser.close();
}
