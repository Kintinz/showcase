import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { buildShowcase } from '../scripts/build-showcase.ts';
test('clean artifact contains only live projects, viewer and commit marker; no owners or secrets', async () => {
  await mkdir('.build', { recursive: true }); const root = await mkdtemp(path.resolve('.build/fixture-'));
  await mkdir(path.join(root, 'projects/demo/assets'), { recursive: true }); await mkdir(path.join(root, 'catalog')); await mkdir(path.join(root, 'viewer'));
  await writeFile(path.join(root, 'catalog/demo.json'), JSON.stringify({ slug: 'demo', ownerId: 42, uploadId: '11111111-1111-4111-8111-111111111111' }));
  await writeFile(path.join(root, 'projects/demo/index.html'), 'hello'); await writeFile(path.join(root, 'projects/demo/assets/a.css'), 'body{}');
  await writeFile(path.join(root, 'viewer/index.html'), 'viewer'); await writeFile(path.join(root, '.dev.vars'), 'SECRET');
  const out = path.join(root, 'out'); await buildShowcase(root, out, 'a'.repeat(40));
  assert.equal(await readFile(path.join(out, 'demo/index.html'), 'utf8'), 'hello');
  assert.deepEqual(JSON.parse(await readFile(path.join(out, 'showcase-status.json'), 'utf8')), { sha: 'a'.repeat(40), projects: { demo: '11111111-1111-4111-8111-111111111111' } });
  await assert.rejects(() => access(path.join(out, 'catalog'))); await assert.rejects(() => access(path.join(out, '.dev.vars')));
  await assert.rejects(() => buildShowcase(root, out, 'a'.repeat(40))); // never overwrite an old artifact
  await writeFile(path.join(root, 'catalog/demo.json'), JSON.stringify({ slug: '../escape' }));
  await assert.rejects(() => buildShowcase(root, path.join(root, 'bad-out'), 'a'.repeat(40)));
});
