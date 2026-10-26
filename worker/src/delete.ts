import { requirePermission, assertOwner } from './permissions.ts';
import { validateSlug } from './package.ts';
import { fail } from './errors.ts';
export async function deleteProject(github, user, value) {
  const slug = validateSlug(value);
  for (let attempt = 0; attempt < 3; attempt++) {
    await requirePermission(github, user);
    const snapshot = await github.snapshot(), metadata = await github.readJson(`catalog/${slug}.json`, snapshot);
    if (!metadata) fail(404, 'NOT_FOUND', 'Không tìm thấy giao diện.');
    assertOwner(metadata, user);
    const entries = snapshot.entries.filter(e => e.type === 'blob' && (e.path === `catalog/${slug}.json` || e.path.startsWith(`projects/${slug}/`))).map(e => ({ path: e.path, mode: '100644', type: 'blob', sha: null }));
    try { const commitSha = await github.commit(snapshot, entries, `showcase:delete:${slug}:${user.id}`); return { commitSha, slug, operation: 'delete', state: 'saved' }; }
    catch (e) { if (e.status !== 409 || attempt === 2) throw e; }
  }
}
