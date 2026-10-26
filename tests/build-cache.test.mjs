import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, readdir, cp, rename, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { buildShowcase } from '../scripts/build-showcase.ts';

async function fixture() {
  await mkdir('.build', { recursive: true }); const root = await mkdtemp(path.resolve('.build/cache-test-'));
  for (const dir of ['admin', 'viewer', 'worker', 'scripts']) await cp(path.resolve(dir), path.join(root, dir), { recursive: true });
  await mkdir(path.join(root, 'catalog'));
  for (const slug of ['first', 'second']) {
    await mkdir(path.join(root, 'projects', slug, 'assets'), { recursive: true });
    await writeFile(path.join(root, 'projects', slug, 'index.html'), '<h1>Original</h1>');
    await writeFile(path.join(root, 'projects', slug, 'assets', 'style.css'), 'body{color:navy}');
    await writeFile(path.join(root, 'catalog', slug + '.json'), JSON.stringify({ slug, ownerId: 42, uploadId: '11111111-1111-4111-8111-111111111111' }));
  }
  await writeFile(path.join(root, '.gitignore'), '.build/\n');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('add', '.'); git('commit', '-qm', 'fixture');
  let number = 0;
  return { root, git, async build(cache = true) {
    const out = path.join(root, '.build', `out-${++number}`), stats = {};
    await mkdir(path.dirname(out), { recursive: true });
    await buildShowcase(root, out, git('rev-parse', 'HEAD'), { cacheDir: cache ? path.join(root, '.build', 'preview-cache') : undefined, stats });
    return { out, stats };
  } };
}
async function fileMap(dir, prefix = '') {
  const result = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) Object.assign(result, await fileMap(path.join(dir, entry.name), prefix + entry.name + '/'));
    else result[prefix + entry.name] = (await readFile(path.join(dir, entry.name))).toString('base64');
  }
  return result;
}
async function cacheFiles(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) result.push(...await cacheFiles(path.join(dir, entry.name)));
    else if (entry.name.endsWith('.json')) result.push(path.join(dir, entry.name));
  }
  return result;
}

test('cold/warm cache produces the same full artifact and only changed projects are repackaged', async () => {
  const f = await fixture(), cold = await f.build(), warm = await f.build(), uncached = await f.build(false);
  assert.equal(cold.stats.packaged, 2); assert.equal(warm.stats.cacheHits, 2); assert.equal(warm.stats.packaged, 0);
  for (const key of ['projectCount', 'fileCount', 'sourceBytes', 'previewBytes', 'artifactBytes']) assert.equal(warm.stats.capacity[key], uncached.stats.capacity[key]);
  assert.deepEqual(await fileMap(warm.out), await fileMap(uncached.out));
  assert.ok(warm.stats.artifactBytes > 0); assert.ok(warm.stats.elapsedMs >= 0);
  await writeFile(path.join(f.root, 'projects/first/index.html'), '<h1>Changed</h1>');
  f.git('add', '.'); f.git('commit', '-qm', 'change first');
  const changed = await f.build(); assert.equal(changed.stats.cacheHits, 1); assert.equal(changed.stats.packaged, 1);
  assert.deepEqual(await fileMap(changed.out), await fileMap((await f.build(false)).out));
  await rename(path.join(f.root, 'projects/first/assets/style.css'), path.join(f.root, 'projects/first/assets/theme.css'));
  f.git('add', '-A'); f.git('commit', '-qm', 'rename asset');
  const renamed = await f.build(); assert.equal(renamed.stats.cacheHits, 1);
  const files = JSON.parse(await readFile(path.join(renamed.out, 'previews/first.json'))).files;
  assert.ok(files['assets/theme.css']); assert.ok(!Object.hasOwn(files, 'assets/style.css'));
  await rename(path.join(f.root, 'projects/first/index.html'), path.join(f.root, 'removed-index.html'));
  f.git('add', '-A'); f.git('commit', '-qm', 'remove entry');
  await assert.rejects(() => f.build(), /index.html/);
});

test('fresh uploadId and deleted catalog are reflected despite cached source', async () => {
  const f = await fixture(); await f.build();
  const id = '22222222-2222-4222-8222-222222222222';
  await writeFile(path.join(f.root, 'catalog/first.json'), JSON.stringify({ slug: 'first', uploadId: id }));
  // Renaming a fixture catalog outside catalog simulates deletion without removing real user data.
  await rename(path.join(f.root, 'catalog/second.json'), path.join(f.root, 'removed-second.json'));
  f.git('add', '-A'); f.git('commit', '-qm', 'new identity and remove second');
  const built = await f.build(); assert.equal(built.stats.cacheHits, 1);
  assert.equal(JSON.parse(await readFile(path.join(built.out, 'previews/first.json'))).uploadId, id);
  assert.deepEqual(JSON.parse(await readFile(path.join(built.out, 'showcase-status.json'))).projects, { first: id });
  await assert.rejects(() => access(path.join(built.out, 'previews/second.json')));
  await assert.rejects(() => access(path.join(built.out, '.build')));
});

test('corrupt or tampered cache rebuilds from source rather than publishing cached substitutions', async () => {
  const f = await fixture(); await f.build();
  const entries = await cacheFiles(path.join(f.root, '.build/preview-cache'));
  assert.ok(entries.length > 0);
  for (const entry of entries) await writeFile(entry, '{broken');
  const broken = await f.build(); assert.equal(broken.stats.cacheHits, 0); assert.equal(broken.stats.packaged, 2);
  for (const entry of entries) {
    const cached = JSON.parse(await readFile(entry, 'utf8')); cached.files['index.html'] = Buffer.from('malicious replacement').toString('base64');
    await writeFile(entry, JSON.stringify(cached));
  }
  const tampered = await f.build(); assert.equal(tampered.stats.cacheHits, 0);
  assert.equal(Buffer.from(JSON.parse(await readFile(path.join(tampered.out, 'previews/first.json'))).files['index.html'], 'base64').toString(), '<h1>Original</h1>');
});

test('dirty/untracked source and packager changes never reuse stale packages', async () => {
  const f = await fixture(); await f.build();
  await writeFile(path.join(f.root, 'projects/first/assets/new.js'), 'console.log(1)');
  const dirty = await f.build(); assert.equal(dirty.stats.cacheHits, 0);
  assert.ok(JSON.parse(await readFile(path.join(dirty.out, 'previews/first.json'))).files['assets/new.js']);
  f.git('add', '.'); f.git('commit', '-qm', 'new asset'); await f.build();
  await writeFile(path.join(f.root, 'projects/first/assets/new.js'), 'console.log(2)');
  f.git('add', '.'); f.git('commit', '-qm', 'edit asset');
  const changed = await f.build(); assert.equal(changed.stats.cacheHits, 1);
  await writeFile(path.join(f.root, 'worker/src/package.ts'), '// packager version changed\n' + await readFile(path.join(f.root, 'worker/src/package.ts'), 'utf8'));
  f.git('add', '.'); f.git('commit', '-qm', 'validator change');
  const version = await f.build(); assert.equal(version.stats.cacheHits, 0);
});

test('checkout transformations, ignored source files and unavailable cache fall back safely', async () => {
  const f = await fixture(); await f.build();
  f.git('config', 'core.autocrlf', 'true');
  assert.equal((await f.build()).stats.cacheHits, 0);
  f.git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(f.root, '.gitattributes'), 'projects/** text eol=crlf\n');
  f.git('add', '.gitattributes'); f.git('commit', '-qm', 'checkout attributes');
  assert.equal((await f.build()).stats.cacheHits, 0);
  const other = await fixture(); await other.build();
  await writeFile(path.join(other.root, '.gitignore'), '.build/\nprojects/**/ignored.txt\n');
  await writeFile(path.join(other.root, 'projects/first/ignored.txt'), 'ignored but still packaged');
  const ignored = await other.build(); assert.equal(ignored.stats.cacheHits, 0);
  assert.ok(JSON.parse(await readFile(path.join(ignored.out, 'previews/first.json'))).files['ignored.txt']);
  const clean = await fixture();
  const blocked = path.join(clean.root, '.build/cache-is-file'); await mkdir(path.dirname(blocked), { recursive: true }); await writeFile(blocked, 'not a directory');
  const stats = {};
  await buildShowcase(clean.root, path.join(clean.root, '.build/blocked-out'), clean.git('rev-parse', 'HEAD'), { cacheDir: blocked, stats });
  assert.equal(stats.packaged, 2); assert.equal(stats.cacheMode, 'unavailable');
  await assert.rejects(() => buildShowcase(other.root, path.join(other.root, '.build/nested-out'), other.git('rev-parse', 'HEAD'), { cacheDir: path.join(other.root, '.build/nested-out/cache') }), /outside/);
});
