// Guards two separate patching mechanisms against the same class of bug:
// tokens/module-ids drifting out of sync with the real game bundle.
//
//   - MIXIN_TOKENS (tested below) is used ONLY by the dev flavor
//     (tools/game-bundle.mjs's patchBundle, app_src/main.bundle.js — no
//     PolyModLoader involved). It edits the bundle's source TEXT once,
//     before the file is ever loaded, so the patched code keeps its
//     original closure naturally.
//   - RENDERER_ACCESS (also tested below) is used by the real PML flavor
//     (src/main.mod.js), which reaches the renderer class via the shared
//     webpack require function instead of PolyModLoader's own
//     registerClassMixin — see that file's header comment for why
//     registerClassMixin can't be used here at all (it reconstructs the
//     target method via toString()+eval(), which silently detaches it from
//     its own module's closure — private-field WeakMap access throws at
//     runtime, not at mixin-registration time). The actual renderer object
//     underneath (needed for window.__PolyFX.render(...)) is found at
//     runtime instead, via WeakMap.prototype.get — not statically pinned,
//     so there's nothing further to guard here for that part.
//
// Two distinct bugs happened with MIXIN_TOKENS specifically while building
// this, and simulatePmlMixins is written to catch both classes even though
// its own reconstruct-via-eval no longer matches what main.mod.js does at
// runtime — it's still a strong scoping check for MIXIN_TOKENS itself:
//   1. A token had prettifier-added whitespace that doesn't exist in the
//      real minified source — a straightforward "does this substring exist"
//      check catches this.
//   2. tokenEnd ("addMaterial(e){") was assumed to be the tail of update()'s
//      own body, but it's actually a SEPARATE SIBLING METHOD starting right
//      after update()'s closing brace. A whole-file `bundleText.indexOf(...)`
//      finds it fine — it's real text, just not inside the method — so that
//      check gave false confidence. Only simulating method-scoped extraction
//      (see tools/game-bundle.mjs's simulatePmlMixins) catches this.
//
// Requires your own legitimately-extracted app.asar (see README's "local
// dev setup") — skips (not fails) if it isn't present, since it's gitignored
// and not something this repo can ship.
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

  // Cheap first-pass sanity check — necessary but NOT sufficient (see the
  // header comment: this alone missed the sibling-method bug).
  const counts = verifyMixinTokens(bundleText);
  for (const [name, count] of Object.entries(counts)) {
    assert.equal(count, 1, `token "${name}" occurs ${count} times somewhere in the whole bundle file (expected exactly 1) — the game updated, or a token drifted out of sync. See src/mixin_tokens.js.`);
  }

  // The real guard: replay a method-scoped splice against V.prototype.update's
  // own isolated source text, the same span patchBundle() operates on.
  // Throws with a specific, actionable message (not found / wrong order /
  // regex mismatch) if anything is wrong.
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

  // main.mod.js can't reach the renderer class via a bare identifier — it's
  // declared in its own isolated webpack module closure (see
  // mixin_tokens.js). It reaches it instead via `i(<moduleId>).<exportName>`,
  // using the shared webpack require function confirmed reachable from
  // PolyModLoader's own eval() scope. If a game update reshuffles the module
  // id or export name, this must fail loudly instead of silently mis-resolving.
  const found = findRendererAccessPath(bundleText);
  assert.equal(found.moduleId, RENDERER_ACCESS.moduleId, 'renderer module id drifted — update RENDERER_ACCESS in src/mixin_tokens.js');
  assert.equal(found.exportName, RENDERER_ACCESS.exportName, 'renderer export name drifted — update RENDERER_ACCESS in src/mixin_tokens.js');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
