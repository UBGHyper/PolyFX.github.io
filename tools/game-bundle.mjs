// Extracts PolyTrack's app.asar (your own legitimately-owned install — see
// README) into app_src/, and patches main.bundle.js with the same two seams
// main.mod.js installs via PolyModLoader mixins, for the direct-bundle-patch
// dev flavor (app_src/mod/, used by `npm run dev` / `npm run shots`).
//
// Exports the mixin tokens + patcher as plain functions so tools/test/*.mjs
// can verify them against a pristine extraction without going through PML at
// all — see that file for why exact-match matters: PolyModLoader's
// registerClassMixin calls `.toString()` on the live function object, which
// returns the literal source text as shipped (no reformatting), so a token
// with so much as an extra space silently fails to match.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { MIXIN_TOKENS } from '../src/mixin_tokens.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(__dirname, '..');

export { MIXIN_TOKENS };

export function verifyMixinTokens(bundleText) {
  const results = {};
  for (const [name, token] of Object.entries(MIXIN_TOKENS)) {
    results[name] = bundleText.split(token).length - 1;
  }
  return results;
}

// Finds V.prototype.update's OWN source text via a real parse — mirroring
// what PolyModLoader's registerClassMixin actually operates on
// (Function.prototype.toString() of the live method, not the whole bundle
// file). Identified by content (contains the render call), not by variable
// name ("V"), since minified names can shift between builds but this
// specific call site is what we're actually patching.
export function findUpdateMethodSource(bundleText) {
  const ast = acorn.parse(bundleText, { ecmaVersion: 'latest', sourceType: 'script' });
  let target = null;
  walk.simple(ast, {
    MethodDefinition(node) {
      if (target || node.key?.name !== 'update' || node.value?.type !== 'FunctionExpression') return;
      const body = bundleText.slice(node.value.start, node.value.end);
      if (body.includes(MIXIN_TOKENS.renderTokenStart)) target = node;
    },
  });
  if (!target) throw new Error('update() method containing the render call not found — game bundle format has changed');
  return bundleText.slice(target.start, target.end);
}

const PML_RECONSTRUCT_REGEX = /^\s*(async\s+)?([\w$]+)\s*\(([^)]*)\)\s*{([\s\S]*)}$/;

// Faithfully replays PolyModLoader's registerClassMixin for INSERT and
// REPLACEBETWEEN (see PolyModLoader.js) against the real, method-scoped
// source text — not a whole-file text splice like patchBundle() below. This
// is what actually caught the tokenEnd bug: patchBundle()'s whole-file
// approach "worked" because the text it was looking for genuinely exists
// in the file, just in the wrong method.
export function simulatePmlMixins(bundleText) {
  let funcStr = findUpdateMethodSource(bundleText);
  if (!PML_RECONSTRUCT_REGEX.test(funcStr)) {
    throw new Error('update() method source does not match PolyModLoader\'s own reconstruction regex before any mixin is applied');
  }

  function applyInsert(token, injected) {
    const idx = funcStr.indexOf(token);
    if (idx === -1) throw new Error(`INSERT token not found in update(): ${JSON.stringify(token)}`);
    funcStr = funcStr.slice(0, idx + token.length) + injected + funcStr.slice(idx + token.length);
    if (!PML_RECONSTRUCT_REGEX.test(funcStr)) throw new Error('INSERT: reconstructed function no longer matches PolyModLoader\'s regex');
  }

  function applyReplaceBetween(tokenStart, tokenEnd, injected) {
    const startIdx = funcStr.indexOf(tokenStart);
    const endIdx = funcStr.indexOf(tokenEnd);
    if (startIdx === -1) throw new Error(`REPLACEBETWEEN tokenStart not found in update(): ${JSON.stringify(tokenStart)}`);
    if (endIdx === -1) throw new Error(`REPLACEBETWEEN tokenEnd not found in update(): ${JSON.stringify(tokenEnd)}`);
    if (endIdx < startIdx) throw new Error('REPLACEBETWEEN tokenEnd occurs BEFORE tokenStart in update() — would splice the wrong span');
    const span = funcStr.substring(startIdx, endIdx + tokenEnd.length);
    funcStr = funcStr.split(span).join(injected);
    if (!PML_RECONSTRUCT_REGEX.test(funcStr)) throw new Error('REPLACEBETWEEN: reconstructed function no longer matches PolyModLoader\'s regex');
  }

  // Same two mixins as src/main.mod.js, applied in the same order (PML
  // applies mixins as each registerClassMixin call runs, so the second one
  // here operates on the output of the first — mirrored here too).
  applyInsert(MIXIN_TOKENS.sunInsert, 'window.__PolyFX?.overrideSun?.((0,i.gn)(this,I,"f"));');
  applyReplaceBetween(
    MIXIN_TOKENS.renderTokenStart,
    MIXIN_TOKENS.renderTokenEnd,
    `window.__PolyFX
    ? window.__PolyFX.render(
        (0,i.gn)(this,k,"f"),
        (0,i.gn)(this,E,"f"),
        (0,i.gn)(this,M,"f"),
        (0,i.gn)(this,x,"f"),
        (0,i.gn)(this,I,"f"),
      )
    : (0,i.gn)(this,k,"f").render(
        (0,i.gn)(this,E,"f"),
        (0,i.gn)(this,M,"f"),
      );
  }`,
  );

  return funcStr;
}

// Mirrors main.mod.js's two registerClassMixin calls as plain string
// surgery, for the flavor that doesn't go through PolyModLoader at all.
export function patchBundle(bundleText) {
  const counts = verifyMixinTokens(bundleText);
  for (const [name, count] of Object.entries(counts)) {
    if (count !== 1) throw new Error(`mixin token "${name}" occurs ${count} times (expected 1) — game bundle format has drifted, see src/main.mod.js`);
  }

  let out = bundleText;

  // (a) sun-direction override, right after the sun-position copy.
  out = out.replace(
    MIXIN_TOKENS.sunInsert,
    `${MIXIN_TOKENS.sunInsert}window.__PolyFX?.overrideSun?.((0,i.gn)(this,I,"f"));`,
  );

  // (b) route the render call through PolyFX when present. Replacement ends
  // with exactly one closing brace for update() itself — nothing needs to be
  // re-emitted afterward, the next method (addMaterial) was never consumed.
  const startIdx = out.indexOf(MIXIN_TOKENS.renderTokenStart);
  const endIdx = out.indexOf(MIXIN_TOKENS.renderTokenEnd, startIdx);
  const replacement = `window.__PolyFX
    ? window.__PolyFX.render(
        (0,i.gn)(this,k,"f"),
        (0,i.gn)(this,E,"f"),
        (0,i.gn)(this,M,"f"),
        (0,i.gn)(this,x,"f"),
        (0,i.gn)(this,I,"f"),
      )
    : (0,i.gn)(this,k,"f").render(
        (0,i.gn)(this,E,"f"),
        (0,i.gn)(this,M,"f"),
      );
  }`;
  out = out.slice(0, startIdx) + replacement + out.slice(endIdx + MIXIN_TOKENS.renderTokenEnd.length);

  return out;
}

export async function extractAsar(asarPath, destDir) {
  const { extractAll } = await import('@electron/asar');
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  extractAll(asarPath, destDir);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const asarIdx = args.indexOf('--asar');
  const asarPath = asarIdx >= 0 ? path.resolve(args[asarIdx + 1]) : null;

  if (cmd === 'setup') {
    if (!asarPath || !fs.existsSync(asarPath)) {
      console.error('Usage: node tools/game-bundle.mjs setup --asar <path-to-app.asar>');
      console.error('(Extract it from your own PolyTrack install\'s resources/app.asar.)');
      process.exitCode = 1;
      return;
    }
    const appSrc = path.join(root, 'app_src');
    console.log(`[game-bundle] extracting ${asarPath} -> ${appSrc}`);
    await extractAsar(asarPath, appSrc);

    const bundlePath = path.join(appSrc, 'main.bundle.js');
    const raw = fs.readFileSync(bundlePath, 'utf8');
    console.log('[game-bundle] patching main.bundle.js with the PolyFX render seam');
    fs.writeFileSync(bundlePath, patchBundle(raw));

    const indexPath = path.join(appSrc, 'index.html');
    let html = fs.readFileSync(indexPath, 'utf8');
    if (!html.includes('polyfx_runtime.js')) {
      html = html.replace('<head>', '<head><script type="module" src="./mod/polyfx_runtime.js"></script>');
      fs.writeFileSync(indexPath, html);
    }
    console.log('[game-bundle] done. Run `npm run build` then `npm run dev` or `npm run shots`.');
    return;
  }

  console.error('Usage: node tools/game-bundle.mjs setup --asar <path-to-app.asar>');
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  main();
}
