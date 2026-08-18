import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createStaticServer, listen } from '../static-server.mjs';
import { buildReport } from './report.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const appSrc = path.join(root, 'app_src');
const outRoot = path.join(__dirname, 'out');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const PRESETS = [
  { key: 'stock', value: 0, label: 'Stock (Off)' },
  { key: 'very-low', value: 5, label: 'Very Low' },
  { key: 'balanced', value: 1, label: 'Balanced' },
  { key: 'enhanced', value: 2, label: 'Enhanced' },
  { key: 'semi-real', value: 3, label: 'Semi-Real' },
  { key: 'photoreal', value: 4, label: 'Photoreal' },
];
const NIGHT_TOD = 7;
const TOD_OPTIONS = [
  { value: 0, key: 'default', label: 'Default' },
  { value: 1, key: 'dawn', label: 'Dawn' },
  { value: 2, key: 'morning', label: 'Morning' },
  { value: 3, key: 'noon', label: 'Noon' },
  { value: 4, key: 'afternoon', label: 'Afternoon' },
  { value: 5, key: 'golden-hour', label: 'Golden Hour' },
  { value: 6, key: 'sunset', label: 'Sunset' },
  { value: 7, key: 'night', label: 'Night' },
];

async function compareMode(dirA, dirB) {
  const a = JSON.parse(fs.readFileSync(path.join(dirA, 'perf.json'), 'utf8'));
  const b = JSON.parse(fs.readFileSync(path.join(dirB, 'perf.json'), 'utf8'));
  const outDir = path.join(outRoot, `compare-${path.basename(dirA)}-vs-${path.basename(dirB)}`);
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = buildReport(outDir, { mode: 'compare', a: { dir: path.relative(outDir, dirA), data: a }, b: { dir: path.relative(outDir, dirB), data: b } });
  console.log('Comparison report:', reportPath);
}

async function main() {
  if (flag('--compare')) {
    const idx = args.indexOf('--compare');
    const dirA = path.resolve(args[idx + 1]);
    const dirB = path.resolve(args[idx + 2]);
    await compareMode(dirA, dirB);
    return;
  }

  const headless = flag('--headless');
  const forceGpu = flag('--force-gpu');
  const label = opt('--label', new Date().toISOString().replace(/[:.]/g, '-'));
  const outDir = path.join(outRoot, label);
  fs.mkdirSync(outDir, { recursive: true });

  const server = createStaticServer(appSrc);
  const port = await listen(server, 0);
  console.log(`[shotbench] serving ${appSrc} at http://127.0.0.1:${port}/`);

  const browser = await chromium.launch({
    headless,
    args: headless ? ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'] : [],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });

  await context.route('https://vps.kodub.com/**', (route) => route.abort());
  await context.route('https://vps.kodub.com/v6/user**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: 'null' }));

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String((err && err.stack) || err)));

  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => typeof window.__PolyFX === 'object' && window.__PolyFX !== null, null, { timeout: 15000 });

  if (forceGpu) {
    await page.evaluate(() => {
      window.__PolyFX.caps = { isSoftware: false, rendererString: 'forced (shotbench --force-gpu)' };
      // A raw property write here gets silently overwritten a frame later by the AutoPerfGuard
      // PML-setting read in render() (which has no override to defer to otherwise) — same
      // reason setPresetOverride/setUnderglowOverride exist below instead of writing state
      // directly.
      window.__PolyFX.setPerfGuardOverride(0);
    });
  }

  const canvas = page.locator('#screen');
  const results = [];

  for (const preset of PRESETS) {
    await page.evaluate((v) => window.__PolyFX.setPresetOverride(v), preset.value);
    await page.waitForTimeout(preset.value === 0 ? 500 : 1800);
    const frameSamples = [];
    for (let i = 0; i < 20; i++) {
      frameSamples.push(await page.evaluate(() => window.__PolyFX.fps()));
      await page.waitForTimeout(50);
    }
    const fps = median(frameSamples);
    const state = await page.evaluate(() => window.__PolyFX.getState());
    const file = `${preset.key}.png`;
    await canvas.screenshot({ path: path.join(outDir, file), timeout: 60000 });
    console.log(`[shotbench] ${preset.label}: ${fps} fps (median of ${frameSamples.length}), guard=${state.guardStep}`);
    results.push({ key: preset.key, label: preset.label, file, fps, guardStep: state.guardStep, state });
  }

  await page.evaluate(() => window.__PolyFX.setPresetOverride(2));
  await page.evaluate((tod) => window.__PolyFX.setTimeOfDayOverride(tod), NIGHT_TOD);
  await page.waitForTimeout(1200);
  for (const [key, label, on] of [['underglow-off-night', 'Underglow off (night)', 0], ['underglow-on-night', 'Underglow on (night)', 1]]) {
    await page.evaluate((v) => window.__PolyFX.setUnderglowOverride(v), on);
    await page.waitForTimeout(600);
    const file = `${key}.png`;
    await canvas.screenshot({ path: path.join(outDir, file), timeout: 60000 });
    results.push({ key, label, file, fps: null, guardStep: null, state: null });
    console.log(`[shotbench] ${label}: captured`);
  }

  // AO's known bugs (overexposure from double sRGB encoding, and the half-res black-box
  // compositing bug) should show up as a visible difference between these two frames beyond "AO
  // added some contact shadows" — same preset, same camera, same lighting, only AO flipped.
  await page.evaluate((tod) => window.__PolyFX.setTimeOfDayOverride(tod), 0);
  await page.evaluate(() => window.__PolyFX.setPresetOverride(1));
  await page.waitForTimeout(600);
  for (const [key, label, on] of [['ao-off-balanced', 'AO off (Balanced)', 0], ['ao-on-balanced', 'AO on (Balanced)', 1]]) {
    await page.evaluate((v) => window.__PolyFX.setAoOverride(v), on);
    await page.waitForTimeout(600);
    const file = `${key}.png`;
    await canvas.screenshot({ path: path.join(outDir, file), timeout: 60000 });
    results.push({ key, label, file, fps: null, guardStep: null, state: null });
    console.log(`[shotbench] ${label}: captured`);
  }
  await page.evaluate(() => window.__PolyFX.setAoOverride(null));

  // God rays' threshold check runs against the full rendered frame with no depth/sky mask, so
  // anything bright enough counts as "light source material" for the ray march — not just the
  // sun. Measured directly (godrays-repro run): at the stock 0.84-0.9 threshold, the entire sky
  // dome crosses it, and so does the car's own windshield/rims — a ray walking from a windshield
  // pixel toward the sun re-samples nearby car geometry before ever reaching real sky, which is
  // the reported "duplicated car" ghosting. Sweep every Time of Day at Photoreal (the only preset
  // with godrays.samples this high) capturing the normal frame, the debugShowThreshold view, and
  // the whole-frame fraction of pixels crossing threshold — that fraction is the real regression
  // signal (a well-tuned threshold should isolate the sun disc, not paint the whole sky).
  const godraysDir = path.join(outDir, 'godrays-sweep');
  fs.mkdirSync(godraysDir, { recursive: true });
  await page.evaluate(() => window.__PolyFX.setPresetOverride(4)); // Photoreal
  const godraysResults = [];
  for (const tod of TOD_OPTIONS) {
    await page.evaluate((v) => window.__PolyFX.setTimeOfDayOverride(v), tod.value);
    await page.waitForTimeout(1000);

    const normalFile = `${tod.key}-normal.png`;
    await canvas.screenshot({ path: path.join(godraysDir, normalFile), timeout: 60000 });

    await page.evaluate(() => window.__PolyFX.toggleEffect('godraysDebug', true));
    await page.waitForTimeout(300);
    const debugFile = `${tod.key}-debug.png`;
    await canvas.screenshot({ path: path.join(godraysDir, debugFile), timeout: 60000 });
    await page.evaluate(() => window.__PolyFX.toggleEffect('godraysDebug', false));

    // A raw "is this pixel cyan-ish" color guess false-positives on ordinary sky blue (b>r and
    // g>r are both already true for a normal blue sky, debug tint or not) — diffing against the
    // normal frame captured moments earlier at identical camera/lighting is what actually
    // isolates pixels the debug shader touched. Reading the live #screen canvas via getImageData
    // in a later tick returns a blank buffer (no preserveDrawingBuffer), so both PNGs get loaded
    // as data URLs into fresh <img> elements instead of read from the canvas directly.
    const normalPngB64 = fs.readFileSync(path.join(godraysDir, normalFile)).toString('base64');
    const debugPngB64 = fs.readFileSync(path.join(godraysDir, debugFile)).toString('base64');
    const thresholdFraction = await page.evaluate(async ({ normalB64, debugB64 }) => {
      async function pixelsOf(b64) {
        const img = new Image();
        const loaded = new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
        img.src = `data:image/png;base64,${b64}`;
        await loaded;
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, c.width, c.height).data;
      }
      const [normalData, debugData] = await Promise.all([pixelsOf(normalB64), pixelsOf(debugB64)]);
      // debugShowThreshold does mix(base, vec3(0,3,3), over) — a real hit shifts blue/green up
      // and red down or flat relative to the same pixel in the normal frame; requiring that
      // specific direction (not just "any difference") rules out frame-to-frame noise (cloud
      // drift, SMAA jitter) as a false positive.
      let over = 0, total = 0;
      for (let i = 0; i < debugData.length; i += 4) {
        const dr = debugData[i] - normalData[i];
        const dg = debugData[i + 1] - normalData[i + 1];
        const db = debugData[i + 2] - normalData[i + 2];
        if ((db > 12 || dg > 12) && dr <= 4) over++;
        total++;
      }
      return total ? over / total : 0;
    }, { normalB64: normalPngB64, debugB64: debugPngB64 });

    const state = await page.evaluate(() => {
      const fx = window.__PolyFX;
      return { sunPosition: fx.godrays.material.uniforms.sunPosition.value, intensity: fx.godrays.material.uniforms.intensity.value, threshold: fx.godrays.material.uniforms.threshold.value };
    });

    console.log(`[shotbench] godrays @ ${tod.label}: sunPos=(${state.sunPosition.x.toFixed(2)},${state.sunPosition.y.toFixed(2)}) intensity=${state.intensity.toFixed(3)} threshold=${state.threshold} aboveThreshold=${(thresholdFraction * 100).toFixed(1)}% of frame`);
    godraysResults.push({ key: tod.key, label: tod.label, normalFile: `godrays-sweep/${normalFile}`, debugFile: `godrays-sweep/${debugFile}`, sunPosition: state.sunPosition, intensity: state.intensity, threshold: state.threshold, aboveThresholdFraction: thresholdFraction });
  }
  await page.evaluate(() => window.__PolyFX.setTimeOfDayOverride(null));
  await page.evaluate(() => window.__PolyFX.setPresetOverride(null));
  fs.writeFileSync(path.join(godraysDir, 'godrays.json'), JSON.stringify({ results: godraysResults }, null, 2));

  await browser.close();
  server.close();

  const perf = {
    label,
    capturedAt: new Date().toISOString(),
    headless,
    forceGpu,
    caveat: headless || forceGpu
      ? 'Captured under a software rasterizer (SwiftShader) — frame-time numbers are NOT representative of real GPU hardware. Run without --headless on real hardware for meaningful perf numbers.'
      : null,
    pageErrors,
    results,
  };
  fs.writeFileSync(path.join(outDir, 'perf.json'), JSON.stringify(perf, null, 2));

  const reportPath = buildReport(outDir, { mode: 'sweep', perf });
  console.log(`[shotbench] wrote ${outDir}`);
  console.log(`[shotbench] report: ${reportPath}`);
  if (pageErrors.length) {
    console.error(`[shotbench] ${pageErrors.length} page error(s) occurred — see perf.json`);
    process.exitCode = 1;
  }
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
