import { createServer } from 'node:http';
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Local static preview, including direct deep links, 404s and video range requests.
const root = realpathSync(resolve(fileURLToPath(new URL('..', import.meta.url)), 'out'));
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const port = Number(option('--port') ?? process.env.PORT ?? 3000);
const host = option('--host') ?? '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid preview port.');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.ico': 'image/x-icon' };
const server = createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400); res.end(); return; }
  let file = resolve(root, '.' + pathname);
  if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
  if (existsSync(file) && statSync(file).isDirectory()) {
    if (!pathname.endsWith('/')) { res.writeHead(308, { Location: new URL(req.url, 'http://localhost').pathname + '/' + new URL(req.url, 'http://localhost').search }); res.end(); return; }
    file = resolve(file, 'index.html');
  }
  // Next 16 exports segment payloads as `__next.<seg>/<rest>/__PAGE__.txt` but
  // the client requests the flat `__next.<seg>.<rest>.__PAGE__.txt`; map one to
  // the other (hosts like Vercel do this rewrite themselves).
  if (!existsSync(file)) {
    const m = /^(.*\/)__next\.([^/]+)\.txt$/.exec(pathname);
    if (m) {
      const [first, ...rest] = m[2].split('.');
      if (rest.length) {
        const nested = resolve(root, '.' + m[1] + '__next.' + first + '/' + rest.join('/') + '.txt');
        if (nested.startsWith(root + sep)) file = nested;
      }
    }
  }
  let status = 200;
  if (!existsSync(file) || !statSync(file).isFile()) { file = resolve(root, '404.html'); status = 404; }
  if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
  const actual = realpathSync(file);
  if (!actual.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
  const size = statSync(actual).size;
  const headers = { 'Content-Type': mime[extname(actual)] ?? 'application/octet-stream', 'Content-Length': size, 'Accept-Ranges': 'bytes' };
  let start = 0, end = size - 1;
  if (status === 200 && req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    end = match[1] ? (match[2] ? Math.min(Number(match[2]), size - 1) : size - 1) : size - 1;
    if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${size}`; headers['Content-Length'] = end - start + 1;
  }
  res.writeHead(status, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(actual, { start, end }).on('error', () => res.destroy()).pipe(res);
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, host, () => console.log(`Leveret preview: http://${host}:${port}/`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
