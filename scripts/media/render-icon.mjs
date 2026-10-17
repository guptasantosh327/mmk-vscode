// Renders media/icon.svg to media/icon.png (256×256), the Marketplace icon, with headless Chrome.
//   node scripts/media/render-icon.mjs      (CHROME=/path/to/chrome if it isn't in the macOS default place)
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connect, sleep, startChrome } from './chrome.mjs';

const root = resolve(import.meta.dirname, '../..');
const svg = readFileSync(join(root, 'media/icon.svg'), 'utf8');
const chrome = await startChrome();
try {
  const page = await connect(chrome.port);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 256, height: 256, deviceScaleFactor: 1, mobile: false });
  await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await page.send('Page.navigate', { url: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` });
  await sleep(500);
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 256, height: 256, scale: 1 } });
  writeFileSync(join(root, 'media/icon.png'), Buffer.from(data, 'base64'));
  page.close();
  console.log('wrote media/icon.png');
} finally {
  await chrome.stop();
}
