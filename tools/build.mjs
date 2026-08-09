// Builds PolyFX from the single src/ tree into two flavors:
//
//   1. dist/PolyFX/1.0.0/main.mod.js — the PolyModLoader flavor. A single,
//      fully self-contained bundle (esbuild inlines every relative import,
//      including the vendored three.js + addons) with NO import statements
//      left in the output. That's the actual fix for the PML loading bug:
//      PML's mod cache re-imports a cached mod from a blob URL (see
//      PolyModLoader.js's saveMod/loadMods), which has no base path to
//      resolve a relative import against — a multi-file mod breaks on every
//      launch after the first. A single file has nothing to resolve.
//
//   2. app_src/mod/polyfx_runtime.js — the direct-bundle-patch flavor used
//      for local dev against the unpacked game (app_src/main.bundle.js is
//      already hand-patched to call window.__PolyFX.render(...), matching
//      the same seam main.mod.js installs via PML mixins). index.html
//      already references this exact path/filename via an importmap that's
//      no longer needed now that this is a single bundled file, but is left
//      harmless if present.
//
// Run `node tools/build.mjs` (or `npm run build`). `--watch` rebuilds on
// change; otherwise output is minified unless `--dev` is passed.
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { stripGlslCommentsPlugin } from './strip-glsl-comments.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const watch = process.argv.includes('--watch');
const minify = !process.argv.includes('--dev') && !watch;

// Single source of truth for the current version: src/pml/manifest.json's
// latest["0.6.2"] pointer. PolyModLoader caches a mod per base URL and only
// re-fetches when the version folder name changes (see PolyModLoader.js's
// saveMod/loadMods) — bumping this one field is what actually forces
// PolyModLoader to stop serving a stale cached copy after a fix ships.
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src', 'pml', 'manifest.json'), 'utf8'));
const version = manifest.latest['0.6.2'];

const distRoot = path.join(root, 'dist', 'PolyFX');
const distVersionDir = path.join(distRoot, version);
const devModDir = path.join(root, 'app_src', 'mod');

// dist/PolyFX is disposable output, not append-only — wipe it fresh every
// build so a leftover folder from a previous version number can't get
// dragged into release/ (tools/release.mjs copies this whole tree).
fs.rmSync(distRoot, { recursive: true, force: true });
fs.mkdirSync(distVersionDir, { recursive: true });
fs.mkdirSync(devModDir, { recursive: true });

const common = {
  bundle: true,
  format: 'esm',
  target: 'esnext',
  legalComments: 'none',
  logLevel: 'info',
};

function copyMeta() {
  fs.copyFileSync(path.join(root, 'src', 'pml', 'manifest.json'), path.join(distRoot, 'manifest.json'));
  fs.copyFileSync(path.join(root, 'src', 'pml', 'version.json'), path.join(distVersionDir, 'version.json'));
  fs.copyFileSync(path.join(root, 'src', 'pml', 'icon.png'), path.join(distVersionDir, 'icon.png'));
}

const pmlBuildOpts = {
  ...common,
  entryPoints: [path.join(root, 'src', 'main.mod.js')],
  outfile: path.join(distVersionDir, 'main.mod.js'),
  minify,
  sourcemap: minify ? false : 'inline',
  // esbuild's minifier can't see inside template-literal shader strings, so
  // JS comments get stripped but GLSL ones (ours and the vendored three.js
  // addons') don't — only worth the extra pass on the published build.
  plugins: minify ? [stripGlslCommentsPlugin] : [],
};

const devBuildOpts = {
  ...common,
  entryPoints: [path.join(root, 'src', 'runtime.js')],
  outfile: path.join(devModDir, 'polyfx_runtime.js'),
  minify: false,
  sourcemap: 'inline',
};

async function reportSize(label, file) {
  const { size } = await fs.promises.stat(file);
  console.log(`[build] ${label}: ${(size / 1024).toFixed(1)} KiB -> ${path.relative(root, file)}`);
}

async function main() {
  copyMeta();

  if (watch) {
    const pmlCtx = await esbuild.context(pmlBuildOpts);
    const devCtx = await esbuild.context(devBuildOpts);
    await Promise.all([pmlCtx.watch(), devCtx.watch()]);
    console.log('[build] watching for changes...');
    return;
  }

  await esbuild.build(pmlBuildOpts);
  await esbuild.build(devBuildOpts);
  await reportSize('PML flavor', pmlBuildOpts.outfile);
  await reportSize('dev flavor', devBuildOpts.outfile);

  // Guard against the exact bug this rebuild fixes: the PML output must have
  // zero remaining relative imports (i.e. be truly self-contained).
  const bundled = await fs.promises.readFile(pmlBuildOpts.outfile, 'utf8');
  const badImport = /(?:^|\s)(?:import|export)[^;\n]*from\s*['"]\.\.?\//m.exec(bundled);
  if (badImport) {
    console.error('[build] FAILED: PML bundle still has a relative import:', badImport[0]);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
