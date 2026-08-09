// Guards against the class of bug found while building this: main.mod.js's
// mixin tokens must match, and must be positioned correctly within, what
// PolyModLoader's registerClassMixin actually operates on — the OWN source
// text of V.prototype.update (via Function.prototype.toString(), which per
// spec returns the method exactly as shipped, no reformatting), NOT the
// whole bundle file.
//
// Two distinct bugs happened here, and this test is written to catch both
// classes, not just the one that happened to get found first:
//   1. A token had prettifier-added whitespace that doesn't exist in the
//      real minified source — a straightforward "does this substring exist"
//      check catches this.
//   2. tokenEnd ("addMaterial(e){") was assumed to be the tail of update()'s
//      own body, but it's actually a SEPARATE SIBLING METHOD starting right
//      after update()'s closing brace. A whole-file `bundleText.indexOf(...)`
//      finds it fine — it's real text, just not inside the method PML is
//      actually looking within — so that check gave false confidence. Only
//      simulating PML's real method-scoped extraction (see
//      tools/game-bundle.mjs's simulatePmlMixins) catches this.
//
// Requires your own legitimately-extracted app.asar (see README's "local
// dev setup") — skips (not fails) if it isn't present, since it's gitignored
// and not something this repo can ship.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { extractAsar, verifyMixinTokens, simulatePmlMixins, root } from '../tools/game-bundle.mjs';

const asarPath = path.join(root, 'extracted', 'resources', 'app.asar');
const tmpDir = path.join(root, 'test', '.tmp-pristine-bundle');

test('mixin tokens exist, are correctly scoped, and produce valid JS', async (t) => {
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
    assert.equal(count, 1, `token "${name}" occurs ${count} times somewhere in the whole bundle file (expected exactly 1) — the game updated, or a token drifted out of sync. See src/main.mod.js.`);
  }

  // The real guard: replay PolyModLoader's actual mixin mechanism against
  // V.prototype.update's own isolated source text. Throws with a specific,
  // actionable message (not found / wrong order / regex mismatch) if
  // anything is wrong, exactly mirroring how PML itself would fail.
  const reconstructed = simulatePmlMixins(bundleText);
  const match = reconstructed.match(/^\s*(async\s+)?([\w$]+)\s*\(([^)]*)\)\s*{([\s\S]*)}$/);
  assert.ok(match, 'final reconstructed function must match PolyModLoader\'s own regex');
  const finalSource = `(function(${match[3].trim()}) {${match[4].trim()}})`;
  assert.doesNotThrow(() => new vm.Script(finalSource), 'the function PolyModLoader would install in place of update() must be syntactically valid JS');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
