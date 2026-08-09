// Guards PolyFX's core promise: with the graphics preset at "Off" (the
// default with no PolyModLoader present), render() must never touch the
// renderer/scene at all.
//
// This asserts the invariant directly (nothing in PolyFX ever got
// constructed) rather than comparing screenshots pixel-for-pixel. A pixel
// comparison was tried first and abandoned: the stock game's own sky/cloud
// shader is time-animated relative to wall-clock page-load time, so even two
// mod-ABSENT loads of the same scene produce different pixels in every
// region of the frame, including the sky — there is no stable baseline to
// diff against. Checking that _ensure() (which is what would build the
// composer, sky, car lights, underglow, etc. — see src/runtime.js) never ran
// is a strictly stronger guarantee anyway: it's the actual code path the
// screenshot comparison could only ever have been an indirect proxy for.
//
// Requires a local app_src/ (see README's local dev setup) — skips if
// missing, since it's gitignored and not something this repo can ship.
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
    // No PolyModLoader present -> window.polyModLoader is undefined ->
    // preset resolves to PRESET.OFF (0) every frame, by design (see
    // render()'s preset-resolution block in src/runtime.js).
    await page.waitForTimeout(2500);

    // Booleans only — some of these (composer, sky, ...) are complex
    // Three.js objects with circular references that would fail Playwright's
    // structured-clone return serialization if they ever turned out to be
    // non-null, obscuring a real failure behind a serialization error.
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
