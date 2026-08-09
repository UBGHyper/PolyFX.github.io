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
