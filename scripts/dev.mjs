import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import app from '../worker/src/index.ts';
const root = path.resolve(import.meta.dirname, '..');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
export function assets(directory) {
  return { async fetch(request) {
    let name; try { name = decodeURIComponent(new URL(request.url).pathname); } catch { return new Response('Bad path', { status: 400 }); }
    if (name.endsWith('/')) name += 'index.html';
    const file = path.resolve(directory, '.' + name);
    if (!file.startsWith(path.resolve(directory) + path.sep)) return new Response('Forbidden', { status: 403 });
    try { return new Response(await readFile(file), { headers: { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' } }); }
    catch { return new Response('Not found', { status: 404 }); }
  } };
}
export function serve(handler, port) {
  const server = http.createServer(async (req, res) => {
    try {
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}) });
      const response = await handler(request); res.statusCode = response.status;
      for (const [key, value] of response.headers) if (key !== 'set-cookie') res.setHeader(key, value);
      const cookies = response.headers.getSetCookie(); if (cookies.length) res.setHeader('Set-Cookie', cookies);
      if (response.body) Readable.fromWeb(response.body).pipe(res); else res.end();
    } catch { res.writeHead(500); res.end('Local server error'); }
  });
  server.listen(port, '127.0.0.1', () => console.log(`Local UI: http://localhost:${port}`)); return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const env = { ...process.env, ASSETS: assets(path.join(root, 'admin')) };
  serve(req => app.fetch(req, env), 4173);
}
