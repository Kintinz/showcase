import test from 'node:test';
import assert from 'node:assert/strict';
import { ShowcaseClient } from '../admin/assets/client.js';
import { repositoryFixture } from './pages-fixture-repo.mjs';
const config = { owner: 'Kintinz', repo: 'showcase', branch: 'main', previewBase: 'https://kintinz.github.io/showcase/' };
function seed(count = 12) {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`catalog/project-${i}.json`, JSON.stringify({ slug: `project-${i}`, name: `Project ${i}`, ownerId: i % 2 ? 7 : 42 })]));
}

test('metadata reads are bounded and cached by immutable SHA, with fresh snapshots and isolated accounts', async () => {
  const fixture = repositoryFixture(seed()); let active = 0, peak = 0;
  const fetcher = async (...args) => {
    const blob = new URL(args[0]).pathname.includes('/git/blobs/');
    if (blob) { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); }
    try { return await fixture.fetcher(...args); } finally { if (blob) active--; }
  };
  const client = new ShowcaseClient(config, fetcher); await client.connect('fixture-token');
  assert.equal((await client.catalog()).length, 6); assert.equal(peak, 4);
  fixture.calls.length = 0; await client.catalog();
  assert.equal(fixture.calls.filter(c => c.route.includes('/git/blobs/')).length, 0);
  assert.ok(fixture.calls.some(c => c.route.includes('/git/ref/')));
  const result = await client.catalog(); result[0].name = 'mutated locally';
  assert.notEqual((await client.catalog())[0].name, 'mutated locally');
  const { PagesGitHub } = await import('../admin/assets/client.js');
  const writer = new PagesGitHub(config, 'fixture-token', fixture.fetcher), snapshot = await writer.snapshot();
  await writer.commit(snapshot, [{ path: 'catalog/project-2.json', mode: '100644', type: 'blob', content: JSON.stringify({ slug: 'project-2', name: 'Changed SHA', ownerId: 42 }) }], 'metadata change');
  fixture.calls.length = 0;
  assert.equal((await client.catalog()).find(p => p.slug === 'project-2').name, 'Changed SHA');
  assert.equal(fixture.calls.filter(c => c.route.includes('/git/blobs/')).length, 1);
  await client.delete('project-0'); assert.equal((await client.catalog()).length, 5);
  await client.publish({ name: 'New', slug: 'new', file: new File(['<h1>New</h1>'], 'new.html') });
  assert.ok((await client.catalog()).some(p => p.slug === 'new'));
  client.disconnect(); fixture.user = { id: 7, login: 'other' }; await client.connect('fixture-token'); fixture.calls.length = 0;
  assert.equal((await client.catalog()).length, 6);
  assert.ok(fixture.calls.some(c => c.route.includes('/git/blobs/')));
  fixture.revoked = true; await assert.rejects(() => client.catalog(), e => e.status === 401);
});

test('401 during workflow fetch is propagated even when status fallback handles API failures', async () => {
  const fixture = repositoryFixture(); let revokeWorkflow = false;
  const fetcher = async (url, options) => revokeWorkflow && new URL(url).pathname.endsWith('/runs') ? Response.json({}, { status: 401 }) : fixture.fetcher(url, options);
  const client = new ShowcaseClient(config, fetcher, async () => new Response('', { status: 404 }));
  await client.connect('fixture-token');
  const job = await client.publish({ name: 'Test', slug: 'test', file: new File(['<h1>x</h1>'], 'index.html') });
  revokeWorkflow = true;
  await assert.rejects(() => client.statuses([job]), e => e.status === 401);
});

test('oversized metadata remains readable without occupying the bounded cache', async () => {
  const fixture = repositoryFixture({ 'catalog/large.json': JSON.stringify({ slug: 'large', ownerId: 42, name: 'Large', extra: 'x'.repeat(70 * 1024) }) });
  const client = new ShowcaseClient(config, fixture.fetcher); await client.connect('fixture-token');
  await client.catalog(); fixture.calls.length = 0;
  assert.equal((await client.catalog())[0].slug, 'large');
  assert.equal(fixture.calls.filter(c => c.route.includes('/git/blobs/')).length, 1);
});

test('upload uses at most four blobs concurrently and commits nothing if a blob fails', async () => {
  const fixture = repositoryFixture(); let active = 0, peak = 0, failBlob = false;
  const fetcher = async (url, options) => {
    const blob = new URL(url).pathname.endsWith('/git/blobs');
    if (blob) { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); }
    try { if (blob && failBlob) return Response.json({}, { status: 503 }); return await fixture.fetcher(url, options); }
    finally { if (blob) active--; }
  };
  // Use shared publish operation with HTTP adapter to exercise the actual blob pipeline.
  const { PagesGitHub } = await import('../admin/assets/client.js');
  const { publishProject } = await import('../worker/src/publish.ts');
  const github = new PagesGitHub(config, 'fixture-token', fetcher), user = fixture.user;
  const files = Array.from({ length: 20 }, (_, i) => ({ path: i ? `file-${i}.txt` : 'index.html', bytes: new TextEncoder().encode('test') }));
  await publishProject(github, user, { name: 'Demo', slug: 'demo', files }); assert.equal(peak, 4);
  failBlob = true; fixture.calls.length = 0;
  await assert.rejects(() => publishProject(github, user, { name: 'Fail', slug: 'fail', files }));
  assert.equal(active, 0); assert.ok(!fixture.calls.some(c => c.method === 'POST' && c.route.endsWith('/git/commits')));
  assert.ok(!fixture.currentFiles().has('catalog/fail.json'));
});

test('batch status shares marker and workflows within a cycle, but not across cycles', async () => {
  const fixture = repositoryFixture(); let markers = 0, parses = 0;
  const client = new ShowcaseClient(config, fixture.fetcher, async () => { markers++; return { ok: true, async json() { parses++; return { sha: 'f'.repeat(40), projects: {} }; } }; });
  await client.connect('fixture-token'); const jobs = [];
  for (const slug of ['first', 'second']) jobs.push(await client.publish({ name: slug, slug, file: new File(['<h1>x</h1>'], 'index.html') }));
  fixture.calls.length = 0;
  const results = await client.statuses(jobs);
  assert.equal(results.length, 2); assert.ok(results.every(r => r.result.state === 'failed'));
  assert.equal(markers, 1); assert.equal(parses, 1); assert.equal(fixture.calls.filter(c => c.route === '/user').length, 1);
  await client.statuses(jobs); assert.equal(markers, 2);
  markers = 0;
  const waiting = new ShowcaseClient(config, fixture.fetcher, async () => { markers++; return new Response('', { status: 404 }); });
  await waiting.connect('fixture-token'); fixture.calls.length = 0;
  await waiting.statuses(jobs);
  assert.equal(markers, 1); assert.equal(fixture.calls.filter(c => c.route.endsWith('/runs')).length, 1);
  fixture.revoked = true; await assert.rejects(() => waiting.statuses(jobs), e => e.status === 401);
});
