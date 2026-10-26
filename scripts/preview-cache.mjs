import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, lstat, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import path from 'node:path';
import { validatePath, LIMITS } from '../worker/src/package.ts';

const digest = value => createHash('sha256').update(value).digest('hex');
function blobHash(bytes) { return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); }
function inside(parent, child) { const relative = path.relative(parent, child); return !relative.startsWith('..') && !path.isAbsolute(relative); }

export async function previewCache(root, out, sha, directory, stats) {
  if (!directory) { stats.cacheMode = 'disabled'; return null; }
  const dir = path.resolve(directory);
  if (!inside(path.join(root, '.build'), dir) || inside(out, dir) || inside(dir, out)) throw Error('Preview cache must be under .build and outside the Pages artifact.');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  let descriptors;
  try {
    let autocrlf = '';
    try { autocrlf = git('config', '--get', 'core.autocrlf').trim(); } catch { /* Unset means disabled. */ }
    if (autocrlf && autocrlf !== 'false') { stats.cacheMode = 'source-fallback'; return null; }
    if (path.resolve(git('rev-parse', '--show-toplevel').trim()) !== path.resolve(root) || git('rev-parse', 'HEAD').trim() !== sha || git('status', '--porcelain', '-z', '--untracked-files=all', '--ignored=matching', '--', 'projects').length) {
      stats.cacheMode = 'source-fallback'; return null;
    }
    descriptors = new Map();
    for (const record of git('ls-tree', '-r', '-z', 'HEAD', '--', 'projects').split('\0').filter(Boolean)) {
      const match = /^(\d+) (\w+) ([a-f0-9]{40})\tprojects\/([^/]+)\/(.+)$/s.exec(record);
      if (!match) { stats.cacheMode = 'source-fallback'; return null; }
      const [, mode, type, hash, slug, name] = match;
      if (type !== 'blob' || !['100644', '100755'].includes(mode)) { stats.cacheMode = 'source-fallback'; return null; }
      validatePath(name);
      if (!descriptors.has(slug)) descriptors.set(slug, []);
      descriptors.get(slug).push({ name, mode, hash });
    }
    const paths = [...descriptors].flatMap(([slug, entries]) => entries.map(entry => `projects/${slug}/${entry.name}`));
    if (paths.length) {
      const attributes = execFileSync('git', ['check-attr', '-z', '--stdin', 'text', 'eol', 'filter', 'ident', 'working-tree-encoding'], { cwd: root, input: paths.join('\0') + '\0', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).split('\0');
      for (let i = 2; i < attributes.length; i += 3) if (!['unspecified', 'unset'].includes(attributes[i])) { stats.cacheMode = 'source-fallback'; return null; }
    }
  } catch { stats.cacheMode = 'source-fallback'; return null; }
  let namespace;
  try {
    const code = await Promise.all(['scripts/build-showcase.ts', 'scripts/preview-cache.mjs', 'worker/src/package.ts', 'worker/src/errors.ts'].map(name => readFile(path.join(root, name))));
    namespace = path.join(dir, digest(Buffer.concat([Buffer.from(`preview-cache-v1:node-${process.versions.node.split('.')[0]}\0`), ...code])));
    await mkdir(namespace, { recursive: true });
    if ((await lstat(dir)).isSymbolicLink() || (await lstat(namespace)).isSymbolicLink()) throw Error('Cache symlink');
  } catch { stats.cacheMode = 'unavailable'; return null; }
  stats.cacheMode = 'git';

  function valid(files, entries) {
    if (!files || typeof files !== 'object' || Array.isArray(files) || !Object.hasOwn(files, 'index.html') || Object.keys(files).length !== entries.length || entries.length > LIMITS.count) return false;
    let total = 0;
    for (const entry of entries) {
      validatePath(entry.name); const encoded = files[entry.name];
      if (typeof encoded !== 'string') return false;
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded || bytes.length > LIMITS.file || (total += bytes.length) > LIMITS.expanded || blobHash(bytes) !== entry.hash) return false;
    }
    return true;
  }
  function location(slug) {
    const entries = descriptors.get(slug); if (!entries) return null;
    return { entries, fingerprint: digest(JSON.stringify({ slug, entries })), file: path.join(namespace, slug + '.json') };
  }
  return {
    async load(slug) {
      const item = location(slug); if (!item) return null;
      try {
        const stat = await lstat(item.file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw Error('Invalid cache file');
        const cached = JSON.parse(await readFile(item.file, 'utf8'));
        if (cached.version === 1 && cached.fingerprint !== item.fingerprint) return null;
        if (cached.version !== 1 || !valid(cached.files, item.entries)) throw Error('Invalid cache data');
        return cached.files;
      } catch (error) { if (error.code !== 'ENOENT') stats.cacheInvalid++; return null; }
    },
    async save(slug, files) {
      const item = location(slug); if (!item || !valid(files, item.entries)) return;
      try {
        const temporary = item.file + '.tmp';
        await writeFile(temporary, JSON.stringify({ version: 1, fingerprint: item.fingerprint, files })); await rename(temporary, item.file);
      } catch { stats.cacheWritesFailed++; }
    },
  };
}

export async function artifactBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) total += entry.isDirectory() ? await artifactBytes(path.join(directory, entry.name)) : (await lstat(path.join(directory, entry.name))).size;
  return total;
}
