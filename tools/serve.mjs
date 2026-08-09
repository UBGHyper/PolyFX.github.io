// `npm run dev` — serves app_src/ over http so the direct-bundle-patch flavor
// (app_src/mod/polyfx_runtime.js, built by tools/build.mjs) can be opened in
// a normal browser tab instead of only inside the packaged Electron app.
// Run `npm run build:watch` alongside this for live rebuilds.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer, listen } from './static-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const appSrc = path.join(root, 'app_src');

const port = Number(process.env.PORT) || 8420;
const server = createStaticServer(appSrc);
const actualPort = await listen(server, port);
console.log(`[dev] serving ${appSrc} at http://127.0.0.1:${actualPort}/`);
