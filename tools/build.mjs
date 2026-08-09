import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { stripGlslCommentsPlugin } from './strip-glsl-comments.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const watch = process.argv.includes('--watch');
const minify = !process.argv.includes('--dev') && !watch;

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src', 'pml', 'manifest.json'), 'utf8'));
const version = manifest.latest['0.6.2'];

const distRoot = path.join(root, 'dist', 'PolyFX');
const distVersionDir = path.join(distRoot, version);
const devModDir = path.join(root, 'app_src', 'mod');

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

  const bundled = await fs.promises.readFile(pmlBuildOpts.outfile, 'utf8');
  const badImport = /(?:^|\s)(?:import|export)[^;\n]*from\s*['"]\.\.?\//m.exec(bundled);
  if (badImport) {
    console.error('[build] FAILED: PML bundle still has a relative import:', badImport[0]);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
