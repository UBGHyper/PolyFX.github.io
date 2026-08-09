// Builds and copies the PML flavor into release/ — the ONE directory in this
// repo meant to be committed and served by PolyModLoader's CDN
// (cdn.polymodloader.com/gh/<owner>/<repo>/<branch>/release). Kept separate
// from dist/ (gitignored, esbuild's normal output target) so ordinary
// `npm run build` iteration doesn't churn git on every rebuild — only
// `npm run release` touches this directory.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

execFileSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], { stdio: 'inherit' });

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src', 'pml', 'manifest.json'), 'utf8'));
const version = manifest.latest['0.6.2'];

const distVersionDir = path.join(root, 'dist', 'PolyFX', version);
const releaseDir = path.join(root, 'release');
const releaseVersionDir = path.join(releaseDir, version);

// Only ever touches release/manifest.json and release/<version>/ — every
// OTHER version folder is left completely alone. The CDN
// (cdn.polymodloader.com) caches per-file with its own TTL, independent of
// both this repo and PolyModLoader's own client-side cache: deleting an old
// version folder here can make the CDN's still-cached manifest.json point at
// a version whose files now 404, which is a strictly worse failure than
// whatever the old version's actual bug was. Old versions stay published
// forever once shipped — that's the tradeoff for a cache this far outside
// our control.
fs.mkdirSync(releaseDir, { recursive: true });
fs.rmSync(releaseVersionDir, { recursive: true, force: true });
fs.cpSync(distVersionDir, releaseVersionDir, { recursive: true });
fs.cpSync(path.join(root, 'src', 'pml', 'description.html'), path.join(releaseVersionDir, 'description.html'));
fs.copyFileSync(path.join(root, 'src', 'pml', 'manifest.json'), path.join(releaseDir, 'manifest.json'));

console.log(`[release] wrote ${path.relative(root, releaseVersionDir)} (other version folders untouched)`);
console.log('[release] commit and push this directory to publish an update.');
