// Disposable browser test: fake token + in-memory GitHub, loopback only. Not in Pages artifact.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assets, serve } from '../scripts/dev.mjs';
import { buildShowcase } from '../scripts/build-showcase.ts';
import { repositoryFixture } from './pages-fixture-repo.mjs';

const sample = '<!doctype html><html lang="vi"><head><meta charset="utf-8"><link rel="stylesheet" href="assets/style.css"></head><body><h1>Giao diện test sandbox</h1><img src="assets/dot.svg" alt="Chấm xanh"><button id="counter">Đếm: 0</button><p id="isolation"></p><a href="pages/detail.html">Mở trang chi tiết</a><script src="assets/app.js"></script></body></html>';
const seed = {
  'catalog/fixture-demo.json': JSON.stringify({ ownerId: 42, name: 'Giao diện kiểm thử', slug: 'fixture-demo', uploadId: '11111111-1111-4111-8111-111111111111', createdAt: '2026-10-26T10:00:00Z' }),
  'projects/fixture-demo/index.html': sample,
  'projects/fixture-demo/assets/style.css': 'body{font-family:Arial;padding:30px;background:#eef8f1;color:#183b2b}h1{font-size:26px}button{display:block;padding:12px;margin:15px 0;background:#226348;color:white;border:0;border-radius:8px}',
  'projects/fixture-demo/assets/dot.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><circle cx="30" cy="30" r="25" fill="#36a875"/></svg>',
  'projects/fixture-demo/assets/app.js': 'let n=0;document.querySelector("#counter").onclick=()=>document.querySelector("#counter").textContent="Đếm: "+(++n);let blocked=false;try{parent.document.body}catch(e){blocked=true}document.querySelector("#isolation").textContent=blocked?"Đã chặn truy cập trang quản lý":"LỖI CÁCH LY";',
  'projects/fixture-demo/pages/detail.html': '<!doctype html><html lang="vi"><head><meta charset="utf-8"><link rel="stylesheet" href="../assets/style.css"></head><body><h1>Trang chi tiết</h1><a href="../index.html">Về trang đầu</a></body></html>',
  'catalog/other-user.json': JSON.stringify({ ownerId: 7, name: 'Không được hiển thị', slug: 'other-user', uploadId: '22222222-2222-4222-8222-222222222222' }),
  'projects/other-user/index.html': '<h1>Other user</h1>',
};
const fixture = repositoryFixture(seed);
await mkdir('.build', { recursive: true }); const out = path.resolve('.build', `pages-browser-${Date.now()}`);
await buildShowcase(process.cwd(), out, 'a'.repeat(40));
const clientPath = path.join(out, 'assets/client.js');
const bridge = `const fixtureFetch=(input,options)=>{const url=new URL(input);if(url.origin!=='https://api.github.com')throw Error('Fixture origin');return fetch('/__fixture/github'+url.pathname+url.search,options)};\n`;
await writeFile(clientPath, bridge + (await readFile(clientPath, 'utf8')).replace(/\bfetcher = fetch(?=[,)])/g, 'fetcher = fixtureFetch'));
const site = assets(out);
serve(async request => {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/__fixture/github/')) return fixture.fetcher('https://api.github.com/' + url.pathname.slice('/__fixture/github/'.length) + url.search, { method: request.method === 'GET' ? undefined : request.method, headers: request.headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text() });
  if (url.pathname === '/showcase/showcase-status.json') return Response.json(fixture.marker());
  const preview = /^\/showcase\/previews\/([a-z0-9-]+)\.json$/.exec(url.pathname);
  if (preview) { const bundle = fixture.bundle(preview[1]); return bundle ? Response.json(bundle) : new Response('Not found', { status: 404 }); }
  if (!url.pathname.startsWith('/showcase/')) return new Response(null, { status: 302, headers: { Location: '/showcase/' } });
  url.pathname = url.pathname.slice('/showcase'.length); return site.fetch(new Request(url, request));
}, 4175);
console.log('Disposable test token: fixture-token. Do not enter a real token in this fixture.');
