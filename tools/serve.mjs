/**
 * Zero-dependency static file server for local play and smoke testing.
 *
 * Usage:
 *   node tools/serve.mjs [port]        # serves the repo root
 *   node tools/serve.mjs 8080 --site   # serves examples/site only
 *
 * The game page is at http://localhost:<port>/examples/site/  (or `/` with
 * --site).
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const args = process.argv.slice(2);
const siteOnly = args.includes('--site');
const portArg = args.find((a) => /^\d+$/.test(a));
const port = portArg ? Number(portArg) : 8080;
const root = siteOnly ? join(repoRoot, 'examples', 'site') : repoRoot;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ts': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const target = normalize(join(root, pathname));
    if (!target.startsWith(root + sep) && target !== root) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const info = await stat(target);
    if (info.isDirectory()) {
      res.writeHead(302, { location: pathname + '/' }).end();
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      // Pointer lock and modules work fine over localhost; this header just
      // keeps PHP-style sniffing out of the way.
      'x-content-type-options': 'nosniff',
    });
    createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
});

server.listen(port, () => {
  const base = siteOnly ? '/' : '/examples/site/';
  console.log(`serving ${root}`);
  console.log(`play at http://localhost:${port}${base}`);
});
