import { mkdir, readdir, readFile, writeFile, lstat, copyFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSlug, validatePath } from '../worker/src/package.ts';
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
export async function buildShowcase(root, out, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('A 40-character commit SHA is required.');
  await mkdir(out, { recursive: false });
  const projects = Object.create(null);
  for (const entry of await entriesOrEmpty(path.join(root, 'catalog'))) {
    if (!entry.isFile() || !/^[a-z0-9-]+\.json$/.test(entry.name)) throw Error('Invalid catalog entry.');
    const meta = JSON.parse(await readFile(path.join(root, 'catalog', entry.name), 'utf8')), slug = validateSlug(meta.slug);
    if (entry.name !== `${slug}.json`) throw Error('Catalog slug mismatch.');
    if (typeof meta.uploadId !== 'string' || !/^[a-f0-9-]{36}$/.test(meta.uploadId)) throw Error('Missing upload identity.');
    await lstat(path.join(root, 'projects', slug, 'index.html'));
    await copyTree(path.join(root, 'projects', slug), path.join(out, slug), true); projects[slug] = meta.uploadId;
  }
  await copyTree(path.join(root, 'viewer'), path.join(out, 'viewer'));
  await writeFile(path.join(out, 'showcase-status.json'), JSON.stringify({ sha, projects }));
  await writeFile(path.join(out, '.nojekyll'), '');
  await writeFile(path.join(out, 'index.html'), '<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>UI Showcase</title><body><h1>UI Showcase</h1><p>Mở đường dẫn giao diện đã được chia sẻ để xem bản thiết kế.</p></body></html>');
  return out;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd(), sha = process.env.GITHUB_SHA || process.argv[2];
  await mkdir(path.join(root, '.build'), { recursive: true });
  const out = path.join(root, '.build', `pages-${Date.now()}`);
  await buildShowcase(root, out, sha);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `path=${out}\n`);
  console.log(`Pages artifact: ${out}`);
}
