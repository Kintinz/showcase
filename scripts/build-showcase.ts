import { mkdir, readdir, readFile, writeFile, lstat, copyFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSlug, validatePath, LIMITS } from '../worker/src/package.ts';
import { previewCache, artifactBytes } from './preview-cache.mjs';
import { createCapacityReport, repositorySize, writeCapacityReport } from './capacity.mjs';
async function copyTree(source, destination, validate = false, prefix = '') {
  const stat = await lstat(source); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Source directory must be a real directory.');
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) throw Error('Symlinks are forbidden.');
    if (entry.isDirectory()) await copyTree(path.join(source, entry.name), path.join(destination, entry.name), validate, relative + '/');
    else if (entry.isFile()) { if (validate) validatePath(relative); await copyFile(path.join(source, entry.name), path.join(destination, entry.name)); }
    else throw Error('Unsupported file type.');
  }
}
async function entriesOrEmpty(dir) { try { return await readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } }
async function packageProject(source) {
  const files = Object.create(null); let total = 0, count = 0;
  async function visit(directory, prefix = '') {
    const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Project directory must not be a symlink.');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) throw Error('Project symlinks are forbidden.');
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative + '/');
      else if (entry.isFile()) {
        validatePath(relative); const stat = await lstat(path.join(directory, entry.name));
        if (stat.size > LIMITS.file || (total += stat.size) > LIMITS.expanded || ++count > LIMITS.count) throw Error('Project exceeds upload limits.');
        files[relative] = (await readFile(path.join(directory, entry.name))).toString('base64');
      } else throw Error('Unsupported project file.');
    }
  }
  await visit(source); if (!Object.hasOwn(files, 'index.html')) throw Error('Project requires index.html.'); return files;
}
function browserModule(source) { return source.replace(/(['"])(\.\.?\/[^'"]+)\.ts\1/g, (_, quote, name) => `${quote}${name}.js${quote}`); }
export async function buildShowcase(root, out, sha, options = {}) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('A 40-character commit SHA is required.');
  root = path.resolve(root); out = path.resolve(out);
  const started = performance.now(), stats = { projects: 0, cacheHits: 0, packaged: 0, cacheInvalid: 0, cacheWritesFailed: 0 };
  const cache = await previewCache(root, out, sha, options.cacheDir, stats);
  await mkdir(out, { recursive: false });
  await copyTree(path.join(root, 'admin'), out);
  await mkdir(path.join(out, 'assets/core'), { recursive: true });
  for (const name of ['errors', 'package', 'permissions', 'parallel', 'publish', 'delete', 'status']) {
    await writeFile(path.join(out, 'assets/core', name + '.js'), browserModule(await readFile(path.join(root, 'worker/src', name + '.ts'), 'utf8')));
  }
  const clientPath = path.join(out, 'assets/client.js');
  await writeFile(clientPath, browserModule((await readFile(clientPath, 'utf8')).replaceAll('../../worker/src/', './core/')));
  await mkdir(path.join(out, 'previews'));
  const projects = Object.create(null), projectSizes = [];
  for (const entry of await entriesOrEmpty(path.join(root, 'catalog'))) {
    if (!entry.isFile() || !/^[a-z0-9-]+\.json$/.test(entry.name)) throw Error('Invalid catalog entry.');
    const meta = JSON.parse(await readFile(path.join(root, 'catalog', entry.name), 'utf8')), slug = validateSlug(meta.slug);
    if (entry.name !== `${slug}.json`) throw Error('Catalog slug mismatch.');
    if (typeof meta.uploadId !== 'string' || !/^[a-f0-9-]{36}$/.test(meta.uploadId)) throw Error('Missing upload identity.');
    stats.projects++;
    let files = await cache?.load(slug);
    if (files) stats.cacheHits++;
    else { files = await packageProject(path.join(root, 'projects', slug)); stats.packaged++; await cache?.save(slug, files); }
    const preview = JSON.stringify({ version: 1, slug, uploadId: meta.uploadId, files });
    await writeFile(path.join(out, 'previews', `${slug}.json`), preview);
    projectSizes.push({ slug, fileCount: Object.keys(files).length, sourceBytes: Object.values(files).reduce((total, encoded) => total + Buffer.byteLength(encoded, 'base64'), 0), previewBytes: Buffer.byteLength(preview) });
    // A direct project URL opens our trusted viewer, never raw uploaded HTML on this origin.
    await mkdir(path.join(out, slug));
    await writeFile(path.join(out, slug, 'index.html'), `<!doctype html><html lang="vi"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=../viewer/?slug=${slug}"><title>Showcase</title><a href="../viewer/?slug=${slug}">Mở giao diện</a></html>`);
    projects[slug] = meta.uploadId;
  }
  await copyTree(path.join(root, 'viewer'), path.join(out, 'viewer'));
  await writeFile(path.join(out, 'showcase-status.json'), JSON.stringify({ sha, projects }));
  await writeFile(path.join(out, '.nojekyll'), '');
  stats.artifactBytes = await artifactBytes(out); stats.elapsedMs = Math.round(performance.now() - started);
  stats.capacity = createCapacityReport(sha, projectSizes, stats.artifactBytes);
  if (options.stats) Object.assign(options.stats, stats);
  return out;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd(), sha = process.env.GITHUB_SHA || process.argv.slice(2).find(value => /^[a-f0-9]{40}$/.test(value));
  await mkdir(path.join(root, '.build'), { recursive: true });
  const stamp = Date.now(), out = path.join(root, '.build', `pages-${stamp}`);
  const stats = {};
  await buildShowcase(root, out, sha, { cacheDir: process.argv.includes('--cache') ? path.join(root, '.build/preview-cache') : undefined, stats });
  stats.capacity.repository = await repositorySize(process.env.GITHUB_REPOSITORY || process.argv.find(value => value.startsWith('--repository='))?.slice(13), process.env.GITHUB_TOKEN);
  await writeCapacityReport(stats.capacity, { file: path.join(root, '.build', `reports-${stamp}`, 'capacity.json'), output: process.env.GITHUB_OUTPUT, summary: process.env.GITHUB_STEP_SUMMARY, pagesPath: out, cacheSave: stats.cacheMode === 'git' && stats.packaged > 0 });
  console.log(`Pages artifact: ${out}`);
  console.log(`Build statistics: ${JSON.stringify({ ...stats, capacity: { ...stats.capacity, projects: undefined } })}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Showcase build\n\n| Projects | Cache hits | Packaged | Invalid cache | Bytes | Time (ms) | Mode |\n|---:|---:|---:|---:|---:|---:|---|\n| ${stats.projects} | ${stats.cacheHits} | ${stats.packaged} | ${stats.cacheInvalid} | ${stats.artifactBytes} | ${stats.elapsedMs} | ${stats.cacheMode} |\n`);
}
