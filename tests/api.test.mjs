import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../worker/src/index.ts';
import { seal } from '../worker/src/auth.ts';
const env = { SESSION_SECRET: 'x'.repeat(40), GITHUB_OWNER: 'Kintinz', GITHUB_REPO: 'showcase', GITHUB_BRANCH: 'main', PREVIEW_BASE_URL: 'https://kintinz.github.io/showcase/' };
const user = { id: 42, login: 'alice' };
const repo = {
  async identity() { return user; },
  async permission() { return { permission: 'write' }; },
  async snapshot() { return { sha: 'a'.repeat(40), entries: [{ path: 'catalog/mine.json', type: 'blob' }, { path: 'catalog/other.json', type: 'blob' }] }; },
  async readJson(path) { return path.includes('mine') ? { slug: 'mine', name: '<img onerror=evil()>', ownerId: 42 } : { slug: 'other', ownerId: 7 }; },
};
const app = createApp(() => repo);
async function request(path, options = {}) {
  const value = await seal({ purpose: 'session', user, userToken: 'secret', csrf: 'csrf', exp: Date.now() + 60000 }, env.SESSION_SECRET);
  return new Request('https://admin.example' + path, { ...options, headers: { Cookie: '__Host-showcase=' + value, ...options.headers } });
}
test('API requires session and never sends tokens to client', async () => {
  assert.equal((await app.fetch(new Request('https://admin.example/api/catalog'), env)).status, 401);
  const response = await app.fetch(await request('/api/me'), env), text = await response.text();
  assert.equal(response.status, 200); assert.ok(!text.includes('secret')); assert.ok(text.includes('csrf'));
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});
test('catalog is filtered server-side even with forged owner query', async () => {
  const response = await app.fetch(await request('/api/catalog?ownerId=7'), env), body = await response.json();
  assert.deepEqual(body.projects.map(p => p.slug), ['mine']);
});
test('API rejects direct mutation CSRF, removed rights, and fake identity', async () => {
  const req = await request('/api/projects/mine', { method: 'DELETE' });
  assert.equal((await app.fetch(req, env)).status, 403);
  const revoked = createApp(() => ({ ...repo, permission: async () => ({ permission: 'read' }) }));
  assert.equal((await revoked.fetch(await request('/api/projects/mine', { method: 'DELETE', headers: { Origin: 'https://admin.example', 'X-CSRF-Token': 'csrf' } }), env)).status, 403);
  const fake = createApp(() => ({ ...repo, identity: async () => ({ id: 7, login: 'other' }) }));
  assert.equal((await fake.fetch(await request('/api/me'), env)).status, 401);
});
test('oversize request and missing file rejected before any Git write', async () => {
  const headers = { Origin: 'https://admin.example', 'X-CSRF-Token': 'csrf', 'Content-Type': 'multipart/form-data; boundary=x', 'Content-Length': String(4 * 1024 * 1024) };
  assert.equal((await app.fetch(await request('/api/publishes', { method: 'POST', headers, body: '' }), env)).status, 413);
  const form = new FormData(); form.set('name', 'x'); form.set('slug', 'demo');
  assert.equal((await app.fetch(await request('/api/publishes', { method: 'POST', headers: { Origin: 'https://admin.example', 'X-CSRF-Token': 'csrf' }, body: form }), env)).status, 422);
});
test('same origin preview misconfiguration fails closed', async () => {
  const response = await app.fetch(await request('/api/me'), { ...env, PREVIEW_BASE_URL: 'https://admin.example/' });
  assert.equal(response.status, 503);
});
