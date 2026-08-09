// Serves dist/PolyFX/ so real PolyModLoader can install it as a custom mod
// URL while there's no public release/ URL yet (see README / plan A4).
// In PML, add `http://127.0.0.1:<port>` as a custom mod source — PML fetches
// manifest.json, then <version>/version.json and <version>/main.mod.js from
// exactly that base, same shape as the real CDN.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer, listen } from './static-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist', 'PolyFX');

const port = Number(process.env.PORT) || 8422;
const server = createStaticServer(distDir);
const actualPort = await listen(server, port);
console.log(`[serve-pml] serving ${distDir} at http://127.0.0.1:${actualPort}/`);
console.log(`[serve-pml] in PolyModLoader, add http://127.0.0.1:${actualPort} as a custom mod URL`);
console.log(`[serve-pml] run \`npm run build\` again (this server picks up changes on the next request, no restart needed)`);
