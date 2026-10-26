import { requirePermission } from './permissions.ts';
import { validateSlug, validatePath } from './package.ts';
import { fail } from './errors.ts';
import { mapLimit } from './parallel.ts';
export async function publishProject(github, user, input) {
  const slug = validateSlug(input.slug), name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 100) fail(422, 'INVALID_NAME', 'Tên giao diện từ 1 đến 100 ký tự.');
  const blobs = [], uploadId = crypto.randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    await requirePermission(github, user);
    const snapshot = await github.snapshot();
    if (snapshot.entries.some(e => e.path === `catalog/${slug}.json` || e.path === `projects/${slug}` || e.path.startsWith(`projects/${slug}/`))) fail(409, 'SLUG_EXISTS', 'Slug đã tồn tại. Hãy chọn đường dẫn khác.');
    if (!input.files.some(f => f.path === 'index.html')) fail(422, 'MISSING_ENTRY', 'Thiếu index.html.');
    if (!blobs.length) blobs.push(...await mapLimit(input.files, 4, async file => ({ path: `projects/${slug}/${validatePath(file.path)}`, mode: '100644', type: 'blob', sha: await github.blob(file.bytes) })));
    const metadata = { slug, name, ownerId: user.id, ownerLogin: user.login, uploadId, createdAt: new Date().toISOString() };
    try {
      const commitSha = await github.commit(snapshot, [...blobs, { path: `catalog/${slug}.json`, mode: '100644', type: 'blob', content: JSON.stringify(metadata, null, 2) }], `showcase:publish:${slug}:${user.id}:${uploadId}`);
      return { commitSha, slug, operation: 'publish', state: 'saved' };
    } catch (e) { if (e.status !== 409 || attempt === 2) throw e; }
  }
}
