// Tiny static file server, no dependencies. Used by `npm run dev` (serves
// app_src/ for manual testing of the direct-bundle-patch flavor) and by
// tools/shotbench (serves app_src/ for the automated screenshot bench).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.track': 'application/octet-stream',
};

// Serves `rootDir`, falling back to `overlayDir` first for any request path
// that exists there (used to serve a freshly built dist/ mod on top of the
// otherwise-unpacked app_src/ tree without copying files around).
export function createStaticServer(rootDir, { overlayDir, overlayPrefix } = {}) {
  // path.join always returns OS-native separators; resolve the roots the
  // same way so a caller passing forward slashes on Windows doesn't fail
  // startsWith() against a backslash-joined filePath for every request.
  const resolvedRoot = path.resolve(rootDir);
  const resolvedOverlay = overlayDir ? path.resolve(overlayDir) : null;

  return http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let reqPath = decodeURIComponent(url.pathname);
      if (reqPath === '/') reqPath = '/index.html';

      let filePath = null;
      if (resolvedOverlay && overlayPrefix && reqPath.startsWith(overlayPrefix)) {
        const rel = reqPath.slice(overlayPrefix.length);
        const candidate = path.resolve(path.join(resolvedOverlay, rel));
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) filePath = candidate;
      }
      if (!filePath) filePath = path.resolve(path.join(resolvedRoot, reqPath));

      if (!filePath.startsWith(resolvedRoot) && !(resolvedOverlay && filePath.startsWith(resolvedOverlay))) {
        res.writeHead(403); res.end('forbidden'); return;
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404); res.end('not found: ' + reqPath); return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });
}

export function listen(server, port) {
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}
