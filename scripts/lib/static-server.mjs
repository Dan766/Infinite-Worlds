/**
 * Dependency-free static file server.
 *
 * Used instead of `vite preview` for two reasons: it can mount the build at an
 * arbitrary nested path (which is exactly what `npm run verify:subpath` needs
 * to test), and binding to port 0 lets the OS pick a free port, so parallel
 * runs can never collide on a fixed port number.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.ktx2': 'image/ktx2',
  '.bin': 'application/octet-stream',
};

/**
 * Serve `rootDir` at `mountPath`.
 *
 * @param {string} rootDir directory to serve
 * @param {{ mountPath?: string }} options mount path, e.g. '/a/b/c/'
 * @returns {Promise<{ url: string, close: () => Promise<void> }>} base URL and shutdown
 */
export async function startStaticServer(rootDir, { mountPath = '/' } = {}) {
  const root = resolve(rootDir);
  if (!existsSync(root)) {
    throw new Error(`Cannot serve missing directory: ${root}. Run \`npm run build\` first.`);
  }

  const mount = mountPath.endsWith('/') ? mountPath : `${mountPath}/`;

  const server = createServer((req, res) => {
    const requestPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);

    if (!requestPath.startsWith(mount)) {
      res.writeHead(404).end('Not found');
      return;
    }

    let relative = requestPath.slice(mount.length);
    if (relative === '' || relative.endsWith('/')) relative += 'index.html';

    // Reject traversal outside the served root.
    const filePath = join(root, normalize(relative));
    if (!filePath.startsWith(root + sep) && filePath !== root) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404).end('Not found');
      return;
    }

    res.writeHead(200, {
      'content-type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(filePath).pipe(res);
  });

  await new Promise((resolvePromise) => {
    // Port 0: let the OS assign a free port, so runs never collide.
    server.listen(0, '127.0.0.1', resolvePromise);
  });

  const address = server.address();
  const url = `http://127.0.0.1:${address.port}${mount}`;

  return {
    url,
    close: () =>
      new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      }),
  };
}
