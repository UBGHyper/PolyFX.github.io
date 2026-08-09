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

export function findRendererAccessPath(bundleText) {
  const ast = acorn.parse(bundleText, { ecmaVersion: 'latest', sourceType: 'script' });
  let result = null;

  walk.ancestor(ast, {
    MethodDefinition(node, state, ancestors) {
      if (result || node.key?.name !== 'update' || node.value?.type !== 'FunctionExpression') return;
      const body = bundleText.slice(node.value.start, node.value.end);
      if (!body.includes(MIXIN_TOKENS.renderTokenStart)) return;

      let className = null;
      for (let i = ancestors.length - 1; i >= 0; i--) {
        if (ancestors[i].type === 'ClassDeclaration') { className = ancestors[i].id?.name ?? null; break; }
      }
      if (!className) throw new Error('renderer class is not a named ClassDeclaration — bundle format has changed');

      let moduleId = null;
      let factoryNode = null;
      for (let i = ancestors.length - 1; i >= 1; i--) {
        const candidate = ancestors[i];
        if ((candidate.type === 'FunctionExpression' || candidate.type === 'ArrowFunctionExpression') && candidate.params.length === 3) {
          const parent = ancestors[i - 1];
          if (parent.type === 'Property' && parent.value === candidate && !parent.computed) {
            moduleId = parent.key.type === 'Literal' ? parent.key.value : parent.key.name;
            factoryNode = candidate;
            break;
          }
        }
      }
      if (moduleId == null || !factoryNode) throw new Error('could not locate the enclosing webpack module factory for the renderer class');

      const requireParam = factoryNode.params[2]?.name;
      const factorySrc = bundleText.slice(factoryNode.start, factoryNode.end);
      const dCallMatch = factorySrc.match(new RegExp(`${requireParam}\\.d\\([^,]+,\\s*\\{([^}]*)\\}\\)`));
      if (!dCallMatch) throw new Error('could not find the module-exports-definer call in the renderer\'s module factory');

      let exportName = null;
      for (const pair of dCallMatch[1].split(',').map((p) => p.trim()).filter(Boolean)) {
        const pairMatch = pair.match(/^(\w+):\s*\(\)\s*=>\s*(\w+)$/);
        if (!pairMatch) continue;
        const [, name, alias] = pairMatch;
        if (alias === className || new RegExp(`(?<![\\w$])${alias}=${className}(?![\\w$])`).test(factorySrc)) { exportName = name; break; }
      }
      if (!exportName) throw new Error(`could not determine which export alias maps to class ${className}`);

      result = { moduleId, exportName, className };
    },
  });

  if (!result) throw new Error('update() method containing the render call not found — game bundle format has changed');
  return result;
}

const PML_RECONSTRUCT_REGEX = /^\s*(async\s+)?([\w$]+)\s*\(([^)]*)\)\s*{([\s\S]*)}$/;

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

export function patchBundle(bundleText) {
  const counts = verifyMixinTokens(bundleText);
  for (const [name, count] of Object.entries(counts)) {
    if (count !== 1) throw new Error(`mixin token "${name}" occurs ${count} times (expected 1) — game bundle format has drifted, see src/main.mod.js`);
  }

  let out = bundleText;

  out = out.replace(
    MIXIN_TOKENS.sunInsert,
    `${MIXIN_TOKENS.sunInsert}window.__PolyFX?.overrideSun?.((0,i.gn)(this,I,"f"));`,
  );

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
