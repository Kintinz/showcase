import { GitHub } from './github.ts';
import { session, login, callback, requireWriteRequest, setCookie } from './auth.ts';
import { requirePermission, canWrite } from './permissions.ts';
import { unpackUpload, boundedBytes, LIMITS } from './package.ts';
import { publishProject } from './publish.ts';
import { deleteProject } from './delete.ts';
import { projectStatus, previewBase } from './status.ts';
import { fail } from './errors.ts';
function json(value, status = 200) { return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } }); }
function secure(response, previewOrigin) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff'); headers.set('Referrer-Policy', 'no-referrer'); headers.set('X-Frame-Options', 'DENY');
  headers.set('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src ${previewOrigin || "'none'"}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
async function authenticated(request, env, github) {
  const current = await session(request, env), identity = await github.identity(current.userToken);
  if (identity.id !== current.user?.id) fail(401, 'INVALID_IDENTITY', 'Không xác minh được tài khoản.');
  current.user = { id: identity.id, login: identity.login }; return current;
}
async function catalog(github, user) {
  const snapshot = await github.snapshot(), entries = snapshot.entries.filter(e => e.type === 'blob' && /^catalog\/[a-z0-9-]+\.json$/.test(e.path)), projects = [];
  // Sequential reads respect GitHub API limits; response only contains the current owner's records.
  for (const entry of entries) {
    const metadata = await github.readJson(entry.path, snapshot);
    if (metadata?.ownerId === user.id) projects.push(metadata);
  }
  return projects.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}
export function createApp(githubFactory = env => new GitHub(env), externalFetch = fetch) {
  return { async fetch(request, env) {
    let preview;
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/')) {
        if (!env.ASSETS) return secure(new Response('Static assets chưa được cấu hình.', { status: 503 }));
        const response = await env.ASSETS.fetch(request);
        try { preview = previewBase(env).origin; } catch { /* Static login UI remains available before setup. */ }
        return secure(response, preview);
      }
      preview = previewBase(env).origin;
      if (preview === url.origin) fail(503, 'ORIGIN_COLLISION', 'Origin xem phải khác origin quản trị.');
      let response;
      if (url.pathname === '/api/auth/login' && request.method === 'GET') response = await login(request, env);
      else if (url.pathname === '/api/auth/callback' && request.method === 'GET') response = await callback(request, env, externalFetch);
      else {
        const github = githubFactory(env), current = await authenticated(request, env, github);
        if (['POST', 'DELETE', 'PUT', 'PATCH'].includes(request.method)) requireWriteRequest(request, current);
        if (url.pathname === '/api/auth/logout' && request.method === 'POST') response = json({ ok: true });
        else if (url.pathname === '/api/me' && request.method === 'GET') response = json({ user: current.user, canPublish: canWrite(await github.permission(current.user.login)), repository: `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`, csrf: current.csrf, previewBase: previewBase(env).href });
        else if (url.pathname === '/api/catalog' && request.method === 'GET') {
          const projects = await catalog(github, current.user); response = json({ projects: projects.map(p => ({ ...p, previewUrl: new URL(`${p.slug}/`, previewBase(env)).href })) });
        } else if (url.pathname === '/api/publishes' && request.method === 'POST') {
          await requirePermission(github, current.user);
          const max = LIMITS.upload + 65536;
          if (Number(request.headers.get('Content-Length')) > max) fail(413, 'TOO_LARGE', 'Gói upload tối đa 2 MiB.');
          if (!request.headers.get('Content-Type')?.startsWith('multipart/form-data;') || !request.body) fail(422, 'INVALID_FORM', 'Gửi file bằng multipart/form-data.');
          const bytes = await boundedBytes(request.body, max);
          let form; try { form = await new Response(bytes, { headers: { 'Content-Type': request.headers.get('Content-Type') } }).formData(); } catch { fail(422, 'INVALID_FORM', 'Không đọc được form upload.'); }
          const files = await unpackUpload(form.get('file'));
          const result = await publishProject(github, current.user, { name: form.get('name'), slug: form.get('slug'), files });
          response = json({ ...result, statusUrl: `/api/publishes/${result.commitSha}?slug=${result.slug}`, previewUrl: new URL(`${result.slug}/`, previewBase(env)).href }, 202);
        } else if (/^\/api\/projects\/[^/]+$/.test(url.pathname) && request.method === 'DELETE') {
          const result = await deleteProject(github, current.user, decodeURIComponent(url.pathname.split('/').at(-1)));
          response = json({ ...result, statusUrl: `/api/publishes/${result.commitSha}?slug=${result.slug}`, previewUrl: new URL(`${result.slug}/`, previewBase(env)).href }, 202);
        } else if (/^\/api\/publishes\/[a-f0-9]{40}$/.test(url.pathname) && request.method === 'GET') response = json(await projectStatus(github, current.user, url.pathname.split('/').at(-1), url.searchParams.get('slug'), env, externalFetch));
        else fail(404, 'NOT_FOUND', 'Không tìm thấy API.');
        if (url.pathname === '/api/auth/logout') response.headers.append('Set-Cookie', setCookie('__Host-showcase', '', 0));
      }
      response.headers.set('Cache-Control', 'no-store'); return secure(response, preview);
    } catch (error) {
      return secure(json({ error: { code: error.code || 'SERVICE_ERROR', message: error.status ? error.message : 'Dịch vụ tạm thời không xử lý được yêu cầu. Vui lòng thử lại.' } }, error.status || 503), preview);
    }
  } };
}
export default createApp();
