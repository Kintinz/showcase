import { base64, from64 } from './auth.ts';
import { HttpError, fail } from './errors.ts';
const encoder = new TextEncoder();
const jwt64 = bytes => base64(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
async function appJwt(env) {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) fail(503, 'NOT_CONFIGURED', 'Chưa cấu hình GitHub App key.');
  const pem = env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n');
  if (!pem.includes('BEGIN PRIVATE KEY')) fail(503, 'NOT_CONFIGURED', 'GitHub App key cần ở định dạng PKCS#8.');
  const key = await crypto.subtle.importKey('pkcs8', from64(pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000), unsigned = `${jwt64(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))}.${jwt64(encoder.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID })))}`;
  return `${unsigned}.${jwt64(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned))))}`;
}
export class GitHub {
  constructor(env, fetcher = fetch) {
    this.env = env; this.fetcher = fetcher;
    for (const k of ['GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_BRANCH']) if (!env[k]) fail(503, 'NOT_CONFIGURED', `Chưa cấu hình ${k}.`);
    this.root = `/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}`;
  }
  async request(path, options = {}, token) {
    const response = await this.fetcher(`https://api.github.com${path}`, { ...options, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token || await this.token()}`, 'User-Agent': 'showcase', 'X-GitHub-Api-Version': '2022-11-28', ...(options.body ? { 'Content-Type': 'application/json' } : {}) }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) { const error = new HttpError(response.status === 401 ? 503 : response.status === 403 ? 503 : response.status === 404 ? 404 : [409, 422].includes(response.status) ? 409 : 502, 'GITHUB_ERROR', `GitHub chưa thực hiện được yêu cầu (HTTP ${response.status}).`); error.githubStatus = response.status; throw error; }
    if (response.status === 204) return null; return response.json();
  }
  async token() {
    if (this.installationToken) return this.installationToken;
    if (!this.env.GITHUB_INSTALLATION_ID) fail(503, 'NOT_CONFIGURED', 'Chưa cấu hình GitHub App installation.');
    const result = await this.request(`/app/installations/${encodeURIComponent(this.env.GITHUB_INSTALLATION_ID)}/access_tokens`, { method: 'POST', body: JSON.stringify({ repositories: [this.env.GITHUB_REPO] }) }, await appJwt(this.env));
    this.installationToken = result.token; return result.token;
  }
  async identity(userToken) {
    try { return await this.request('/user', {}, userToken); } catch (e) { if (e.githubStatus === 401 || e.githubStatus === 403) fail(401, 'SESSION_EXPIRED', 'GitHub đã thu hồi phiên. Vui lòng đăng nhập lại.'); throw e; }
  }
  async permission(login) {
    try { return await this.request(`${this.root}/collaborators/${encodeURIComponent(login)}/permission`); } catch (e) { if (e.status === 404) return { permission: 'none' }; throw e; }
  }
  async snapshot() {
    const ref = await this.request(`${this.root}/git/ref/heads/${this.env.GITHUB_BRANCH.split('/').map(encodeURIComponent).join('/')}`);
    const commit = await this.getCommit(ref.object.sha), tree = await this.request(`${this.root}/git/trees/${commit.tree.sha}?recursive=1`);
    if (tree.truncated) fail(503, 'REPO_TOO_LARGE', 'Repo vượt giới hạn đọc cây file.');
    return { sha: ref.object.sha, tree: commit.tree.sha, entries: tree.tree };
  }
  async getCommit(sha) { return this.request(`${this.root}/git/commits/${sha}`); }
  async readJson(path, snapshot) {
    const entry = snapshot.entries.find(e => e.path === path && e.type === 'blob'); if (!entry) return undefined;
    const blob = await this.request(`${this.root}/git/blobs/${entry.sha}`);
    try { return JSON.parse(new TextDecoder().decode(from64(blob.content.replace(/\s/g, '')))); } catch { fail(503, 'INVALID_METADATA', 'Metadata repo không hợp lệ.'); }
  }
  async blob(bytes) { return (await this.request(`${this.root}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: base64(bytes), encoding: 'base64' }) })).sha; }
  async commit(snapshot, entries, message) {
    const tree = await this.request(`${this.root}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: snapshot.tree, tree: entries }) });
    const commit = await this.request(`${this.root}/git/commits`, { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [snapshot.sha] }) });
    await this.request(`${this.root}/git/refs/heads/${this.env.GITHUB_BRANCH.split('/').map(encodeURIComponent).join('/')}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
    return commit.sha;
  }
  async compare(base, head) { return this.request(`${this.root}/compare/${base}...${head}`); }
  async runs() { return this.request(`${this.root}/actions/workflows/pages.yml/runs?branch=${encodeURIComponent(this.env.GITHUB_BRANCH)}&per_page=20`); }
}
