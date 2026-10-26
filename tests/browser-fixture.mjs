// Isolated, local-only fixture. Never imported by the production Worker.
import { createApp } from '../worker/src/index.ts';
import { assets, serve } from '../scripts/dev.mjs';
import { seal, setCookie } from '../worker/src/auth.ts';
import path from 'node:path';
const user = { id: 42, login: 'demo-user' }, secret = 'local-browser-fixture-only-not-a-production-secret';
const files = new Map([
  ['catalog/landing-festival.json', JSON.stringify({ slug: 'landing-festival', name: 'Landing page mùa lễ hội', ownerId: 42, createdAt: '2026-10-26T08:00:00Z' })],
  ['catalog/hr-dashboard.json', JSON.stringify({ slug: 'hr-dashboard', name: 'Dashboard nhân sự', ownerId: 42, createdAt: '2026-10-25T08:00:00Z' })],
  ['catalog/other-user.json', JSON.stringify({ slug: 'other-user', name: 'Must not appear', ownerId: 7 })],
  ['projects/landing-festival/index.html', '<h1>Festival</h1>'], ['projects/hr-dashboard/index.html', '<h1>HR</h1>'],
]);
let sequence = 10, sha = String(sequence).padStart(40, '0'); const commits = new Map(), blobs = new Map();
const repo = {
  async identity() { return user; }, async permission() { return { permission: 'write' }; },
  async snapshot() { return { sha, tree: sha, entries: [...files.keys()].map(p => ({ path: p, type: 'blob', sha: p })) }; },
  async readJson(p) { const value = files.get(p); return value ? JSON.parse(value) : undefined; },
  async blob(bytes) { const id = crypto.randomUUID(); blobs.set(id, Buffer.from(bytes).toString()); return id; },
  async commit(snapshot, entries, message) { for (const e of entries) { if (e.sha === null) files.delete(e.path); else files.set(e.path, e.content ?? blobs.get(e.sha)); } sha = String(++sequence).padStart(40, '0'); commits.set(sha, { message }); return sha; },
  async getCommit(value) { return commits.get(value); }, async compare() { return { status: 'ahead' }; }, async runs() { return { workflow_runs: [] }; },
};
const env = { SESSION_SECRET: secret, GITHUB_OWNER: 'fixture', GITHUB_REPO: 'fixture', GITHUB_BRANCH: 'main', PREVIEW_BASE_URL: 'https://preview.example.test/showcase/', ASSETS: assets(path.resolve('admin')) };
const app = createApp(() => repo, async () => Response.json({ sha, projects: Object.fromEntries([...files].filter(([k]) => k.startsWith('catalog/')).map(([k, v]) => [k.slice(8, -5), JSON.parse(v).uploadId || 'fixture-upload'])) }));
serve(async req => {
  if (new URL(req.url).pathname === '/__fixture/login') {
    const value = await seal({ purpose: 'session', user, userToken: 'fixture-only', csrf: 'fixture-csrf', exp: Date.now() + 3600000 }, secret);
    return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': setCookie('__Host-showcase', value, 3600) } });
  }
  return app.fetch(req, env);
}, 4174);
