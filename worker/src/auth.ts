import { fail } from './errors.ts';
export function base64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(s); }
export function from64(text) { return Uint8Array.from(atob(text), c => c.charCodeAt(0)); }
const url64 = bytes => base64(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const decode64 = text => from64(text.replace(/-/g, '+').replace(/_/g, '/'));
async function key(secret) {
  if (!secret || secret.length < 32) fail(503, 'NOT_CONFIGURED', 'Chưa cấu hình SESSION_SECRET.');
  return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(secret), new TextEncoder().encode(JSON.stringify(value))));
  return `${url64(iv)}.${url64(cipher)}`;
}
export async function unseal(token, secret, purpose) {
  try {
    const [iv, cipher, extra] = (token || '').split('.'); if (!iv || !cipher || extra) throw Error();
    const value = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode64(iv) }, await key(secret), decode64(cipher))));
    if (value.purpose !== purpose || !Number.isFinite(value.exp) || value.exp <= Date.now()) throw Error(); return value;
  } catch { fail(401, 'SESSION_EXPIRED', 'Phiên không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.'); }
}
export function cookie(request, name) { return request.headers.get('Cookie')?.split(';').map(p => p.trim()).find(p => p.startsWith(name + '='))?.slice(name.length + 1); }
export function setCookie(name, value, seconds) { return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`; }
export function randomToken() { return url64(crypto.getRandomValues(new Uint8Array(24))); }
export async function session(request, env) { return unseal(cookie(request, '__Host-showcase'), env.SESSION_SECRET, 'session'); }
export function requireWriteRequest(request, current) {
  if (request.headers.get('Origin') !== new URL(request.url).origin || !current.csrf || request.headers.get('X-CSRF-Token') !== current.csrf) fail(403, 'CSRF', 'Yêu cầu không hợp lệ. Hãy tải lại trang.');
}
export async function login(request, env) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) fail(503, 'NOT_CONFIGURED', 'Chưa cấu hình GitHub App.');
  const state = randomToken(), url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', env.GITHUB_CLIENT_ID); url.searchParams.set('state', state); url.searchParams.set('redirect_uri', new URL('/api/auth/callback', request.url).href);
  const token = await seal({ purpose: 'oauth', state, exp: Date.now() + 600000 }, env.SESSION_SECRET);
  return new Response(null, { status: 302, headers: { Location: url.href, 'Set-Cookie': setCookie('__Host-showcase-oauth', token, 600) } });
}
export async function callback(request, env, fetcher = fetch) {
  const url = new URL(request.url), flow = await unseal(cookie(request, '__Host-showcase-oauth'), env.SESSION_SECRET, 'oauth');
  if (!url.searchParams.get('code') || flow.state !== url.searchParams.get('state')) fail(401, 'OAUTH_STATE', 'Không xác minh được đăng nhập GitHub.');
  const result = await fetcher('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code: url.searchParams.get('code'), redirect_uri: new URL('/api/auth/callback', request.url).href }) });
  const token = await result.json(); if (!result.ok || !token.access_token) fail(401, 'OAUTH_FAILED', 'GitHub từ chối đăng nhập.');
  const response = await fetcher('https://api.github.com/user', { headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'showcase' } });
  if (!response.ok) fail(401, 'OAUTH_FAILED', 'Không đọc được tài khoản GitHub.');
  const user = await response.json(); if (!Number.isSafeInteger(user.id) || !user.login) fail(401, 'OAUTH_FAILED', 'Danh tính GitHub không hợp lệ.');
  const exp = Date.now() + Math.min(3600, Number(token.expires_in) || 3600) * 1000;
  const value = await seal({ purpose: 'session', user: { id: user.id, login: user.login }, csrf: randomToken(), exp, userToken: token.access_token }, env.SESSION_SECRET);
  const headers = new Headers({ Location: '/' }); headers.append('Set-Cookie', setCookie('__Host-showcase', value, 3600)); headers.append('Set-Cookie', setCookie('__Host-showcase-oauth', '', 0));
  return new Response(null, { status: 302, headers });
}
