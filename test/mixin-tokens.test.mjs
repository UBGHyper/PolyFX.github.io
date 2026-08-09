import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { extractAsar, verifyMixinTokens, simulatePmlMixins, findRendererAccessPath, root } from '../tools/game-bundle.mjs';
import { RENDERER_ACCESS } from '../src/mixin_tokens.js';

const asarPath = path.join(root, 'extracted', 'resources', 'app.asar');
const tmpDir = path.join(root, 'test', '.tmp-pristine-bundle');

test('MIXIN_TOKENS (dev-flavor patch) exist, are correctly scoped, and produce valid JS', async (t) => {
  if (!fs.existsSync(asarPath)) {
    t.skip(`no local app.asar at ${asarPath} — see README's local dev setup to run this test`);
    return;
  }

  await extractAsar(asarPath, tmpDir);
  const bundleText = fs.readFileSync(path.join(tmpDir, 'main.bundle.js'), 'utf8');

  const counts = verifyMixinTokens(bundleText);
  for (const [name, count] of Object.entries(counts)) {
    assert.equal(count, 1, `token "${name}" occurs ${count} times somewhere in the whole bundle file (expected exactly 1) — the game updated, or a token drifted out of sync. See src/mixin_tokens.js.`);
  }

  const reconstructed = simulatePmlMixins(bundleText);
  const match = reconstructed.match(/^\s*(async\s+)?([\w$]+)\s*\(([^)]*)\)\s*{([\s\S]*)}$/);
  assert.ok(match, 'final reconstructed function must match the expected method shape');
  const finalSource = `(function(${match[3].trim()}) {${match[4].trim()}})`;
  assert.doesNotThrow(() => new vm.Script(finalSource), 'the patched update() body must be syntactically valid JS');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('RENDERER_ACCESS (webpack module id + export name) matches the pristine bundle', async (t) => {
  if (!fs.existsSync(asarPath)) {
    t.skip(`no local app.asar at ${asarPath} — see README's local dev setup to run this test`);
    return;
  }

  await extractAsar(asarPath, tmpDir);
  const bundleText = fs.readFileSync(path.join(tmpDir, 'main.bundle.js'), 'utf8');

  const found = findRendererAccessPath(bundleText);
  assert.equal(found.moduleId, RENDERER_ACCESS.moduleId, 'renderer module id drifted — update RENDERER_ACCESS in src/mixin_tokens.js');
  assert.equal(found.exportName, RENDERER_ACCESS.exportName, 'renderer export name drifted — update RENDERER_ACCESS in src/mixin_tokens.js');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
