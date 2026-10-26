import test from 'node:test';
import assert from 'node:assert/strict';
import { PagesGitHub, ShowcaseClient } from '../admin/assets/client.js';
import { repositoryFixture } from './pages-fixture-repo.mjs';
const config = { owner: 'Kintinz', repo: 'showcase', branch: 'main', previewBase: 'https://kintinz.github.io/showcase/' };
function transport(permission = true) {
  const calls = [];
  const fetcher = async (input, options = {}) => {
    calls.push({ url: String(input), options });
    const url = new URL(input);
    if (url.pathname === '/user') return Response.json({ id: 42, login: 'alice' });
    if (url.pathname === '/repos/Kintinz/showcase') return Response.json({ permissions: { push: permission } });
    throw Error('Unexpected request: ' + input);
  };
  return { calls, fetcher };
}
test('PAT adapter checks effective repo permission and only sends token to GitHub', async () => {
  const { calls, fetcher } = transport(); const github = new PagesGitHub(config, 'personal-token', fetcher);
  assert.equal((await github.identity()).id, 42);
  assert.equal((await github.permission('alice')).permission, 'write');
  assert.ok(calls.every(c => c.url.startsWith('https://api.github.com/') && c.options.headers.Authorization === 'Bearer personal-token'));
  assert.ok(calls.every(c => !('User-Agent' in c.options.headers) && c.options.credentials === 'omit'));
  await assert.rejects(() => github.request('https://evil.example/steal'), /GitHub/);
  await assert.rejects(() => github.request('//evil.example/steal'), /GitHub/);
});
test('connection exposes only public account state, token cleared on disconnect', async () => {
  const { fetcher } = transport(); const client = new ShowcaseClient(config, fetcher);
  const me = await client.connect('personal-token'); assert.equal(me.user.id, 42); assert.equal(me.canPublish, true);
  assert.ok(!JSON.stringify(client).includes('personal-token')); assert.ok(!JSON.stringify(me).includes('personal-token'));
  client.disconnect(); await assert.rejects(() => client.catalog(), e => e.status === 401);
});
test('readonly token connection does not grant upload and identity is rechecked', async () => {
  const { fetcher } = transport(false); const client = new ShowcaseClient(config, fetcher);
  assert.equal((await client.connect('read-token')).canPublish, false);
  await assert.rejects(() => client.publish({ name: 'Demo', slug: 'demo', file: new File(['x'], 'x.html') }), e => e.status === 403);
});
test('adapter surfaces revoked token and denied scopes without leaking token', async () => {
  for (const status of [401, 403]) {
    const github = new PagesGitHub(config, 'private-value', async () => new Response('{}', { status }));
    await assert.rejects(() => github.identity(), e => e.status === status && !e.message.includes('private-value'));
  }
});
test('browser native fetch receives its required global receiver', async () => {
  const browserFetch = async function () {
    if (this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    return Response.json({ id: 42, login: 'alice' });
  };
  const github = new PagesGitHub(config, 'test-token', browserFetch);
  assert.deepEqual(await github.identity(), { id: 42, login: 'alice' });
});
test('identity response from an old connection cannot disconnect a newly connected account', async () => {
  let delayOld = false, finishOld;
  const fetcher = async (url, options) => {
    if (new URL(url).pathname === '/user') {
      const old = options.headers.Authorization === 'Bearer old-token';
      if (old && delayOld) return new Promise(resolve => { finishOld = () => resolve(Response.json({ id: 42, login: 'old-user' })); });
      return Response.json(old ? { id: 42, login: 'old-user' } : { id: 43, login: 'new-user' });
    }
    return Response.json({ permissions: { push: true } });
  };
  const client = new ShowcaseClient(config, fetcher); await client.connect('old-token');
  delayOld = true; const pending = client.currentUser(); await client.connect('new-token'); finishOld();
  await assert.rejects(() => pending, e => e.status === 409);
  assert.equal((await client.currentUser()).id, 43);
});
test('Pages-only client publishes source, filters owner, checks deployment and deletes own files', async () => {
  const fixture = repositoryFixture({ 'catalog/other.json': JSON.stringify({ ownerId: 7, slug: 'other', name: 'Other' }), 'projects/other/index.html': 'keep me' });
  const client = new ShowcaseClient(config, fixture.fetcher, async () => Response.json(fixture.marker()));
  await client.connect('fixture-token');
  assert.equal((await client.catalog()).length, 0);
  const publish = await client.publish({ name: 'Demo', slug: 'demo', file: new File(['<h1>Hello</h1>'], 'demo.html') });
  assert.equal(publish.state, 'saved'); assert.equal((await client.status(publish)).state, 'ready');
  assert.equal((await client.catalog())[0].ownerId, 42);
  await assert.rejects(() => client.delete('other'), e => e.status === 403);
  fixture.write = false; await assert.rejects(() => client.delete('demo'), e => e.status === 403);
  fixture.write = true;
  const deletion = await client.delete('demo'); assert.equal((await client.status(deletion)).state, 'ready');
  assert.equal((await client.catalog()).length, 0); assert.ok(fixture.currentFiles().has('projects/other/index.html'));
  fixture.revoked = true; await assert.rejects(() => client.catalog(), e => e.status === 401);
});
