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

fs.mkdirSync(releaseDir, { recursive: true });
fs.rmSync(releaseVersionDir, { recursive: true, force: true });
fs.cpSync(distVersionDir, releaseVersionDir, { recursive: true });
fs.cpSync(path.join(root, 'src', 'pml', 'description.html'), path.join(releaseVersionDir, 'description.html'));
fs.copyFileSync(path.join(root, 'src', 'pml', 'manifest.json'), path.join(releaseDir, 'manifest.json'));

console.log(`[release] wrote ${path.relative(root, releaseVersionDir)} (other version folders untouched)`);
console.log('[release] commit and push this directory to publish an update.');
