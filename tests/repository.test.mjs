import test from 'node:test';
import assert from 'node:assert/strict';
import { publishProject } from '../worker/src/publish.ts';
import { deleteProject } from '../worker/src/delete.ts';
import { projectStatus } from '../worker/src/status.ts';

const user = { id: 42, login: 'alice' };
function fakeRepo() {
  const repo = {
    files: new Map([['catalog/other.json', { slug: 'other', name: 'Other', ownerId: 7 }], ['projects/other/index.html', 'other']]),
    writes: [], attempts: 0, permissionValue: 'write', conflict: false,
    async permission() { return { permission: this.permissionValue }; },
    async snapshot() { return { sha: 'a'.repeat(40), tree: 'tree', entries: [...this.files].map(([path]) => ({ path, type: 'blob', sha: path })) }; },
    async readJson(path) { return this.files.get(path); },
    async blob(bytes) { return Buffer.from(bytes).toString('base64'); },
    async commit(snapshot, entries, message) {
      this.attempts++; if (this.conflict && this.attempts === 1) { this.files.set('catalog/concurrent.json', { slug: 'concurrent', ownerId: 7 }); const e = new Error('conflict'); e.status = 409; throw e; }
      this.writes.push({ entries, message }); for (const entry of entries) { if (entry.sha === null) this.files.delete(entry.path); else this.files.set(entry.path, entry.content ?? entry.sha); } return 'b'.repeat(40);
    },
  }; return repo;
}
test('publish records server owner and retries conflicting branch without losing other project', async () => {
  const repo = fakeRepo(); repo.conflict = true;
  const result = await publishProject(repo, user, { name: 'Demo', slug: 'demo', files: [{ path: 'index.html', bytes: new TextEncoder().encode('hi') }] });
  assert.equal(result.commitSha, 'b'.repeat(40)); assert.equal(repo.attempts, 2);
  const metadata = JSON.parse(repo.files.get('catalog/demo.json'));
  assert.equal(metadata.ownerId, 42); assert.equal(metadata.ownerLogin, 'alice');
  assert.ok(repo.files.has('catalog/concurrent.json')); assert.ok(repo.files.has('projects/other/index.html'));
});
test('publish rejects duplicate and revoked rights without commit', async () => {
  const repo = fakeRepo(); repo.files.set('catalog/demo.json', { ownerId: 42 });
  await assert.rejects(() => publishProject(repo, user, { name: 'x', slug: 'demo', files: [] }), e => e.status === 409);
  repo.permissionValue = 'read';
  await assert.rejects(() => publishProject(repo, user, { name: 'x', slug: 'new', files: [] }), e => e.status === 403);
  assert.equal(repo.writes.length, 0);
});
test('delete removes only owner source and metadata in one commit', async () => {
  const repo = fakeRepo(); repo.files.set('catalog/demo.json', { ownerId: 42 }); repo.files.set('projects/demo/index.html', 'hi'); repo.files.set('projects/demo/a.css', 'css');
  await deleteProject(repo, user, 'demo');
  assert.equal(repo.files.has('catalog/demo.json'), false); assert.equal(repo.files.has('projects/demo/index.html'), false); assert.equal(repo.files.has('projects/demo/a.css'), false);
  assert.ok(repo.files.has('projects/other/index.html')); assert.equal(repo.writes.length, 1);
});
test('delete enforces ownership even for admin, revoked rights and unknown owner', async () => {
  const repo = fakeRepo(); repo.permissionValue = 'admin';
  await assert.rejects(() => deleteProject(repo, user, 'other'), e => e.status === 403);
  repo.files.set('catalog/unknown.json', {});
  await assert.rejects(() => deleteProject(repo, user, 'unknown'), e => e.status === 403);
  repo.files.set('catalog/mine.json', { ownerId: 42 }); repo.permissionValue = 'read';
  await assert.rejects(() => deleteProject(repo, user, 'mine'), e => e.status === 403);
  assert.equal(repo.writes.length, 0);
});
test('delete conflict rechecks owner; missing slug returns 404', async () => {
  const repo = fakeRepo();
  await assert.rejects(() => deleteProject(repo, user, 'missing'), e => e.status === 404);
  repo.files.set('catalog/mine.json', { ownerId: 42 });
  repo.commit = async () => { repo.files.set('catalog/mine.json', { ownerId: 7 }); const e = new Error(); e.status = 409; throw e; };
  await assert.rejects(() => deleteProject(repo, user, 'mine'), e => e.status === 403);
});
function statusRepo() {
  return {
    async getCommit() { return { commit: { message: 'showcase:publish:demo:42:11111111-1111-4111-8111-111111111111' } }; },
    async compare() { return { status: 'ahead' }; },
    async runs() { return { workflow_runs: [{ head_sha: 'b'.repeat(40), status: 'completed', conclusion: 'success' }] }; },
  };
}
test('status requires deployed marker containing commit; newer success may contain older upload', async () => {
  const repo = statusRepo(), env = { PREVIEW_BASE_URL: 'https://preview.example/showcase/' };
  const marker = async () => Response.json({ sha: 'c'.repeat(40), projects: { demo: '11111111-1111-4111-8111-111111111111' } });
  assert.equal((await projectStatus(repo, user, 'b'.repeat(40), 'demo', env, marker)).state, 'ready');
  assert.equal((await projectStatus(repo, user, 'b'.repeat(40), 'demo', env, async () => new Response('', { status: 404 }))).state, 'deploying');
  await assert.rejects(() => projectStatus(repo, { id: 7 }, 'b'.repeat(40), 'demo', env, marker), e => e.status === 403);
});
test('delete ready requires new snapshot without slug; failure stays failure', async () => {
  const repo = statusRepo(), env = { PREVIEW_BASE_URL: 'https://preview.example/' };
  repo.getCommit = async () => ({ commit: { message: 'showcase:delete:demo:42' } });
  assert.equal((await projectStatus(repo, user, 'b'.repeat(40), 'demo', env, async () => Response.json({ sha: 'c'.repeat(40), projects: {} }))).state, 'ready');
  repo.runs = async () => ({ workflow_runs: [{ head_sha: 'b'.repeat(40), status: 'completed', conclusion: 'failure' }] });
  assert.equal((await projectStatus(repo, user, 'b'.repeat(40), 'demo', env, async () => new Response('', { status: 404 }))).state, 'failed');
});
test('original upload cannot become ready from another incarnation of the same slug', async () => {
  const repo = statusRepo(), env = { PREVIEW_BASE_URL: 'https://preview.example/' };
  const result = await projectStatus(repo, user, 'b'.repeat(40), 'demo', env, async () => Response.json({ sha: 'c'.repeat(40), slugs: ['demo'], projects: { demo: 'replacement-upload' } }));
  assert.equal(result.state, 'failed');
});
test('newer containing workflow keeps polling after original run failed', async () => {
  const repo = statusRepo(), env = { PREVIEW_BASE_URL: 'https://preview.example/' };
  repo.runs = async () => ({ workflow_runs: [
    { head_sha: 'c'.repeat(40), status: 'in_progress', conclusion: null },
    { head_sha: 'b'.repeat(40), status: 'completed', conclusion: 'failure' },
  ] });
  const result = await projectStatus(repo, user, 'b'.repeat(40), 'demo', env, async () => new Response('', { status: 404 }));
  assert.equal(result.state, 'deploying');
});
