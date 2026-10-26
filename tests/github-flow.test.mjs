import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../worker/src/index.ts';
import { GitHub } from '../worker/src/github.ts';
import { base64, seal } from '../worker/src/auth.ts';

test('HTTP integration: OAuth callback → publish → deployed identity → delete with real GitHub adapter', async () => {
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pem = base64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey)));
  const env = { SESSION_SECRET: 'x'.repeat(40), GITHUB_OWNER: 'owner', GITHUB_REPO: 'repo', GITHUB_BRANCH: 'main', GITHUB_APP_ID: '123', GITHUB_INSTALLATION_ID: '456', GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'client-secret', GITHUB_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${pem}\n-----END PRIVATE KEY-----`, PREVIEW_BASE_URL: 'https://preview.example/' };
  let tip = 'a'.repeat(40), seq = 100, effectivePermission = 'write'; const trees = new Map(), blobs = new Map(), commits = new Map(), calls = [];
  const sha = () => (++seq).toString(16).padStart(40, '0');
  trees.set('initial-tree', new Map()); commits.set(tip, { tree: { sha: 'initial-tree' }, message: 'initial' });
  async function transport(input, options = {}) {
    const url = new URL(input); const route = url.pathname; calls.push(route);
    if (url.hostname === 'preview.example') {
      const tree = trees.get(commits.get(tip).tree.sha), projects = {};
      for (const [p, id] of tree) if (p.startsWith('catalog/')) { const meta = JSON.parse(blobs.get(id)); projects[meta.slug] = meta.uploadId; }
      return Response.json({ sha: tip, projects });
    }
    if (route === '/login/oauth/access_token') return Response.json({ access_token: 'user-token', expires_in: 3600 });
    if (route === '/user') return Response.json({ id: 42, login: 'alice' });
    if (route === '/app/installations/456/access_tokens') {
      const jwt = options.headers.Authorization.slice(7).split('.'), decode = s => Buffer.from(s, 'base64url');
      assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', keys.publicKey, decode(jwt[2]), new TextEncoder().encode(jwt.slice(0, 2).join('.'))), true);
      assert.deepEqual(JSON.parse(options.body).repositories, ['repo']); return Response.json({ token: 'installation-token' });
    }
    if (route.endsWith('/collaborators/alice/permission')) return Response.json({ permission: effectivePermission });
    const root = '/repos/owner/repo';
    if (route === root + '/git/ref/heads/main') return Response.json({ object: { sha: tip } });
    if (route.startsWith(root + '/git/commits/')) return Response.json(commits.get(route.split('/').at(-1)));
    if (route.startsWith(root + '/git/trees/') && !options.method) return Response.json({ truncated: false, tree: [...trees.get(route.split('/').at(-1))].map(([path, sha]) => ({ path, sha, type: 'blob' })) });
    if (route.startsWith(root + '/git/blobs/') && !options.method) return Response.json({ content: Buffer.from(blobs.get(route.split('/').at(-1))).toString('base64') });
    if (route === root + '/git/blobs') { const body = JSON.parse(options.body), id = sha(); blobs.set(id, Buffer.from(body.content, 'base64').toString()); return Response.json({ sha: id }); }
    if (route === root + '/git/trees') {
      const body = JSON.parse(options.body), next = new Map(trees.get(body.base_tree));
      for (const entry of body.tree) { if (entry.sha === null) next.delete(entry.path); else if (entry.content !== undefined) { const id = sha(); blobs.set(id, entry.content); next.set(entry.path, id); } else next.set(entry.path, entry.sha); }
      const id = sha(); trees.set(id, next); return Response.json({ sha: id });
    }
    if (route === root + '/git/commits') { const body = JSON.parse(options.body), id = sha(); commits.set(id, { message: body.message, tree: { sha: body.tree }, parents: body.parents }); return Response.json({ sha: id }); }
    if (route === root + '/git/refs/heads/main') { const body = JSON.parse(options.body); assert.equal(body.force, false); tip = body.sha; return Response.json({ object: { sha: tip } }); }
    if (route.startsWith(root + '/compare/')) return Response.json({ status: 'identical' });
    throw Error('Unexpected mocked GitHub route ' + route);
  }
  const app = createApp(e => new GitHub(e, transport), transport);
  const flow = await seal({ purpose: 'oauth', state: 'challenge', exp: Date.now() + 10000 }, env.SESSION_SECRET);
  const callback = await app.fetch(new Request('https://admin.example/api/auth/callback?state=challenge&code=authcode', { headers: { Cookie: '__Host-showcase-oauth=' + flow } }), env);
  assert.equal(callback.status, 302);
  const cookie = callback.headers.getSetCookie().find(c => c.startsWith('__Host-showcase=')).split(';')[0];
  async function call(p, options = {}) { return app.fetch(new Request('https://admin.example' + p, { ...options, headers: { Cookie: cookie, ...options.headers } }), env); }
  const me = await (await call('/api/me')).json(); assert.equal(me.user.id, 42); assert.equal(me.canPublish, true);
  const form = new FormData(); form.set('name', 'Demo'); form.set('slug', 'demo'); form.set('ownerId', '7'); form.set('file', new File(['<h1>Hello</h1>'], 'demo.html'));
  const headers = { Origin: 'https://admin.example', 'X-CSRF-Token': me.csrf };
  const response = await call('/api/publishes', { method: 'POST', headers, body: form }); assert.equal(response.status, 202);
  const publication = await response.json(); assert.equal((await (await call(publication.statusUrl)).json()).state, 'ready');
  const catalog = await (await call('/api/catalog')).json(); assert.equal(catalog.projects.length, 1); assert.equal(catalog.projects[0].ownerId, 42);
  effectivePermission = 'read'; assert.equal((await call('/api/projects/demo', { method: 'DELETE', headers })).status, 403);
  effectivePermission = 'write'; const deletion = await call('/api/projects/demo', { method: 'DELETE', headers }); assert.equal(deletion.status, 202);
  assert.equal((await (await call((await deletion.json()).statusUrl)).json()).state, 'ready');
  assert.equal((await (await call('/api/catalog')).json()).projects.length, 0);
  assert.ok(calls.some(p => p.endsWith('/git/refs/heads/main')));
});
