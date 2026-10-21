import http from 'node:http';
import { readFile, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Readable } from 'node:stream';
const root = fileURLToPath(new URL('../', import.meta.url));
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8080);
// Binding to every interface (for example inside Docker) does not authorize
// arbitrary Host headers. Additional public origins must be explicit.
const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
if (!['0.0.0.0', '::'].includes(host))
  allowedHosts.add(new URL(`http://${host.includes(':') ? `[${host}]` : host}`).hostname);
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .filter(Boolean)
    .map((value) => {
      const url = new URL(value.trim());
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        throw new Error('ALLOWED_ORIGINS must contain comma-separated HTTP(S) origins.');
      return url.origin;
    })
);
const storage =
  process.env.STORAGE_MODE || (process.argv.includes('--local-db') ? 'local' : 'browser');
if (!['browser', 'local'].includes(storage))
  throw new Error('STORAGE_MODE must be browser or local.');
const filename = path.resolve(
  process.env.LOCAL_DB_PATH || path.join(root, '.data/quitsar.sqlite')
);
const local =
  storage === 'local' ? await (await import('./local-db.mjs')).openLocalDatabase(filename) : null;
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.md': 'text/plain; charset=utf-8'
};
const server = http
  .createServer(async (req, res) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const pathname = decodeURIComponent(url.pathname);
      if (local && pathname.startsWith('/api/')) {
        // Reject cross-site browser access and DNS rebinding against loopback servers.
        if (
          (req.headers['sec-fetch-site'] &&
            !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) ||
          (!allowedHosts.has(url.hostname) && !allowedOrigins.has(url.origin))
        ) {
          throw Object.assign(new Error('Cross-origin access is forbidden.'), { status: 403 });
        }
        const request = new Request(url, {
          method: req.method,
          headers: req.headers,
          ...(req.method !== 'GET' && req.method !== 'HEAD'
            ? { body: Readable.toWeb(req), duplex: 'half' }
            : {})
        });
        const result = await local.handle(request);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        res.end(JSON.stringify(result));
        return;
      }
      // Serve only app assets. Database files, source tooling, and configuration stay private.
      if (
        !['/', '/index.html', '/sw.js'].includes(pathname) &&
        !['/js/', '/styles/', '/assets/', '/banks/'].some((prefix) => pathname.startsWith(prefix))
      )
        throw new Error('Not a public asset');
      const parts = pathname.split('/');
      if (parts.some((p) => p === '..' || p.startsWith('.')) || pathname.includes('\\'))
        throw new Error('Invalid path');
      const target = path.resolve(
        root,
        '.' + pathname + (pathname.endsWith('/') ? 'index.html' : '')
      );
      if (
        !target.startsWith(root) ||
        (local && [filename, filename + '-wal', filename + '-shm'].includes(target))
      )
        throw new Error('Outside public files');
      // Reject symlinks before following them; inspect only the requested path, never list directories.
      let checked = root;
      for (const segment of path.relative(root, target).split(path.sep)) {
        checked = path.join(checked, segment);
        if ((await lstat(checked)).isSymbolicLink()) throw new Error('Symlinks are not served');
      }
      const body = await readFile(target);
      res.writeHead(200, {
        'Content-Type': mime[path.extname(target)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      });
      res.end(body);
    } catch (error) {
      if (local && req.url.startsWith('/api/')) {
        if (!error.status) console.error('Local database request failed:', error.message);
        res.writeHead(error.status || 500, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...(error.status === 429
            ? {
                'Retry-After': String(Math.max(1, Math.ceil((60000 - (Date.now() % 60000)) / 1000)))
              }
            : {})
        });
        res.end(
          JSON.stringify({
            error: error.status
              ? error.message
              : 'The server could not complete this request. Please try again.'
          })
        );
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found within this project.');
      }
    }
  })
  .listen(port, host, () =>
    console.log(
      `quitsar (${storage} storage): listening on ${host}:${server.address().port} (Ctrl+C to stop)`
    )
  );

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      local?.close();
      process.exit(0);
    });
    server.closeIdleConnections();
  });
}
