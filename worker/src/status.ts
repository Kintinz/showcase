import { validateSlug } from './package.ts';
import { fail } from './errors.ts';
export function previewBase(env) {
  let base; try { base = new URL(env.PREVIEW_BASE_URL); } catch { fail(503, 'NOT_CONFIGURED', 'Chưa cấu hình PREVIEW_BASE_URL.'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) fail(503, 'NOT_CONFIGURED', 'Preview URL cần là URL HTTPS.');
  if (!base.pathname.endsWith('/')) base.pathname += '/'; return base;
}
export async function projectStatus(github, user, sha, value, env, fetcher = fetch) {
  if (!/^[a-f0-9]{40}$/.test(sha)) fail(422, 'INVALID_COMMIT', 'Commit không hợp lệ.');
  const slug = validateSlug(value), record = await github.getCommit(sha);
  const message = record.message || record.commit?.message || '';
  const match = /^showcase:(publish|delete):([a-z0-9-]+):(\d+)(?::([a-f0-9-]{36}))?$/.exec(message);
  if (!match || match[2] !== slug || Number(match[3]) !== user.id || (match[1] === 'publish' && !match[4])) fail(403, 'NOT_OWNER', 'Không được xem trạng thái thao tác này.');
  const result = { commitSha: sha, slug, operation: match[1], state: 'queued', previewUrl: new URL(`${slug}/`, previewBase(env)).href };
  try {
    const response = await fetcher(new URL(`showcase-status.json?t=${Date.now()}`, previewBase(env)), { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (response.ok) {
      const marker = await response.json();
      if (/^[a-f0-9]{40}$/.test(marker.sha) && marker.projects && typeof marker.projects === 'object' && !Array.isArray(marker.projects)) {
        const comparison = await github.compare(sha, marker.sha);
        if (['ahead', 'identical'].includes(comparison.status)) {
          const identity = Object.hasOwn(marker.projects, slug) ? marker.projects[slug] : undefined;
          if ((match[1] === 'publish' && identity === match[4]) || (match[1] === 'delete' && !identity)) return { ...result, state: 'ready' };
          return { ...result, state: 'failed', error: 'Giao diện đã được thay đổi bởi thao tác mới hơn.' };
        }
      }
    }
  } catch { /* A missing/unreachable marker is never proof of deployment. */ }
  let runs;
  try { runs = (await github.runs()).workflow_runs || []; } catch { return { ...result, state: 'queued', error: 'Chưa đọc được trạng thái xuất bản. Có thể kiểm tra lại.' }; }
  const exact = runs.find(r => r.head_sha === sha);
  // A later snapshot can still deploy this operation after its original run failed.
  for (const run of runs) {
    if (run.head_sha === sha || !/^[a-f0-9]{40}$/.test(run.head_sha) || (run.status === 'completed' && run.conclusion !== 'success')) continue;
    try {
      if (['ahead', 'identical'].includes((await github.compare(sha, run.head_sha)).status)) return { ...result, state: run.status === 'queued' ? 'queued' : 'deploying' };
    } catch { return { ...result, state: 'queued', error: 'Chưa xác minh được bản xuất bản mới hơn.' }; }
  }
  if (exact?.status === 'completed' && ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(exact.conclusion)) return { ...result, state: 'failed', error: 'Xuất bản thất bại. Source đã được lưu trong GitHub.' };
  if (exact?.status === 'in_progress' || exact?.conclusion === 'success') return { ...result, state: 'deploying' };
  return result;
}
