import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createStaticServer, listen } from '../tools/static-server.mjs';
import { root } from '../tools/game-bundle.mjs';

const appSrc = path.join(root, 'app_src');

test('preset Off never constructs any PolyFX rendering state', async (t) => {
  if (!fs.existsSync(path.join(appSrc, 'index.html'))) {
    t.skip(`no local app_src/ at ${appSrc} — see README's local dev setup to run this test`);
    return;
  }
  if (!fs.existsSync(path.join(appSrc, 'mod', 'polyfx_runtime.js'))) {
    t.skip('app_src/mod/polyfx_runtime.js not built — run `npm run build` first');
    return;
  }

  const server = createStaticServer(appSrc);
  const port = await listen(server, 0);
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'],
  });

  try {
    const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
    await context.route('**/vps.kodub.com/**', (route) => route.abort());
    const page = await context.newPage();

    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => typeof window.__PolyFX === 'object' && window.__PolyFX !== null, null, { timeout: 15000 });
    await page.waitForTimeout(2500);

    const state = await page.evaluate(() => ({
      composer: !!window.__PolyFX.composer,
      preset: window.__PolyFX.preset,
      sky: !!window.__PolyFX.sky,
      carLights: !!window.__PolyFX.carLights,
      underglow: !!window.__PolyFX.underglow,
      photo: !!window.__PolyFX.photo,
      panel: !!window.__PolyFX.panel,
    }));

    assert.equal(state.composer, false, 'composer must never be built while preset stays Off');
    assert.equal(state.preset, -1, 'preset must never be applied (stays at its unset constructor value) while Off');
    assert.equal(state.sky, false, 'sky system must never be built while preset stays Off');
    assert.equal(state.carLights, false, 'car lights must never be built while preset stays Off');
    assert.equal(state.underglow, false, 'underglow must never be built while preset stays Off');
    assert.equal(state.photo, false, 'photo mode must never be built while preset stays Off');
    assert.equal(state.panel, false, 'tuning panel must never be built while preset stays Off');
  } finally {
    await browser.close();
    server.close();
  }
});
