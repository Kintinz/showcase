import { cp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { buildShowcase } from './build-showcase.ts';

const workspace = path.resolve('.build', `build-cache-benchmark-${Date.now()}`), root = path.join(workspace, 'source');
await mkdir(root, { recursive: true });
for (const dir of ['admin', 'viewer', 'worker', 'scripts']) await cp(dir, path.join(root, dir), { recursive: true });
await mkdir(path.join(root, 'catalog')); await mkdir(path.join(root, 'projects'));
await writeFile(path.join(root, '.gitignore'), '.build/\n');
const git = (...args) => execFileSync('git', ['-c', 'user.name=Benchmark', '-c', 'user.email=benchmark@example.invalid', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git('init', '-q'); git('config', 'core.autocrlf', 'false');
async function hashArtifact(directory, hash = createHash('sha256'), prefix = '') {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) await hashArtifact(path.join(directory, entry.name), hash, prefix + entry.name + '/');
    else { hash.update(prefix + entry.name + '\0'); hash.update(await readFile(path.join(directory, entry.name))); }
  }
  return hash;
}
const sizes = (process.argv.find(arg => arg.startsWith('--sizes='))?.slice(8) || '100,1000').split(',').map(Number);
if (sizes.some(n => !Number.isInteger(n) || n < 1 || n > 5000) || sizes.some((n, i) => i && n <= sizes[i - 1])) throw Error('Sizes must be increasing positive integers up to 5000.');
const report = { environment: `${process.platform}, Node ${process.versions.node}, local Git checkout with autocrlf=false; 10 files/project, about 37 KiB/project; no Actions cache transfer, checkout or deployment time included.`, datasets: [] };
for (const count of sizes) {
  for (let i = 0; i < count; i++) {
    const slug = `project-${i}`, project = path.join(root, 'projects', slug); await mkdir(path.join(project, 'assets'), { recursive: true });
    await writeFile(path.join(project, 'index.html'), '<!doctype html><title>Build benchmark</title><h1>Synthetic project</h1>');
    for (let n = 1; n <= 9; n++) await writeFile(path.join(project, 'assets', `file-${n}.txt`), 'x'.repeat(4096) + n);
    await writeFile(path.join(root, 'catalog', slug + '.json'), JSON.stringify({ slug, ownerId: 42, uploadId: '11111111-1111-4111-8111-111111111111' }));
  }
  git('add', '.'); git('commit', '-qm', `dataset ${count}`);
  const cacheDir = path.join(root, '.build', `preview-cache-${count}`), builds = [];
  for (const scenario of ['no-cache', 'cold', 'warm', 'one-change']) {
    if (scenario === 'one-change') {
      await writeFile(path.join(root, 'projects/project-0/index.html'), '<!doctype html><title>Changed</title><h1>One changed project</h1>');
      git('add', '.'); git('commit', '-qm', 'one project changed');
    }
    const stats = {}, out = path.join(workspace, `pages-${count}-${scenario}`);
    await buildShowcase(root, out, git('rev-parse', 'HEAD'), { cacheDir: scenario === 'no-cache' ? undefined : cacheDir, stats });
    const row = { scenario, ...stats, artifactDigest: (await hashArtifact(out)).digest('hex') };
    builds.push(row); console.log(JSON.stringify({ projects: count, ...row }));
  }
  if (new Set(builds.slice(0, 3).map(b => b.artifactDigest)).size !== 1) throw Error('Cached and uncached artifacts differ.');
  report.datasets.push({ count, builds });
}
const file = path.join(workspace, 'report.json'); await writeFile(file, JSON.stringify(report, null, 2)); console.log(`Report: ${file}`);
