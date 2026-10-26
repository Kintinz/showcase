import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, access, cp } from 'node:fs/promises';
import path from 'node:path';
import { buildShowcase } from '../scripts/build-showcase.ts';
test('Pages artifact includes admin and sandbox bundles, never executable uploaded source or secrets', async () => {
  await mkdir('.build', { recursive: true }); const root = await mkdtemp(path.resolve('.build/fixture-'));
  await mkdir(path.join(root, 'projects/demo/assets'), { recursive: true }); await mkdir(path.join(root, 'catalog'));
  for (const dir of ['admin', 'viewer', 'worker']) await cp(path.resolve(dir), path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, 'catalog/demo.json'), JSON.stringify({ slug: 'demo', ownerId: 42, uploadId: '11111111-1111-4111-8111-111111111111' }));
  await writeFile(path.join(root, 'projects/demo/index.html'), 'hello'); await writeFile(path.join(root, 'projects/demo/assets/a.css'), 'body{}');
  await writeFile(path.join(root, '.dev.vars'), 'SECRET');
  const out = path.join(root, 'out'); await buildShowcase(root, out, 'a'.repeat(40));
  assert.ok((await readFile(path.join(out, 'index.html'), 'utf8')).includes('upload-form'));
  const entry = await readFile(path.join(out, 'demo/index.html'), 'utf8'); assert.ok(!entry.includes('hello')); assert.ok(entry.includes('../viewer/?slug=demo'));
  const bundle = JSON.parse(await readFile(path.join(out, 'previews/demo.json'), 'utf8'));
  assert.equal(Buffer.from(bundle.files['index.html'], 'base64').toString(), 'hello');
  assert.equal(Buffer.from(bundle.files['assets/a.css'], 'base64').toString(), 'body{}');
  assert.ok(!JSON.stringify(bundle).includes('ownerId'));
  await assert.rejects(() => access(path.join(out, 'demo/assets/a.css')));
  const client = await readFile(path.join(out, 'assets/client.js'), 'utf8');
  assert.ok(client.includes('./core/publish.js')); assert.ok(!client.includes('.ts\''));
  await assert.rejects(() => access(path.join(out, 'assets/core/auth.js')));
  assert.deepEqual(JSON.parse(await readFile(path.join(out, 'showcase-status.json'), 'utf8')), { sha: 'a'.repeat(40), projects: { demo: '11111111-1111-4111-8111-111111111111' } });
  await assert.rejects(() => access(path.join(out, 'catalog'))); await assert.rejects(() => access(path.join(out, '.dev.vars')));
  await assert.rejects(() => buildShowcase(root, out, 'a'.repeat(40))); // never overwrite an old artifact
  await writeFile(path.join(root, 'catalog/demo.json'), JSON.stringify({ slug: '../escape' }));
  await assert.rejects(() => buildShowcase(root, path.join(root, 'bad-out'), 'a'.repeat(40)));
});
