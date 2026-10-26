import { config as defaults } from './config.js';
import { publishProject } from '../../worker/src/publish.ts';
import { deleteProject } from '../../worker/src/delete.ts';
import { unpackUpload, validateSlug } from '../../worker/src/package.ts';
import { projectStatus } from '../../worker/src/status.ts';
import { fail, HttpError } from '../../worker/src/errors.ts';

function encode(bytes) {
  let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(text);
}
function decode(text) { return Uint8Array.from(atob(text.replace(/\s/g, '')), c => c.charCodeAt(0)); }

export class PagesGitHub {
  #token;
  constructor(config, token, fetcher = fetch) {
    if (!token?.trim()) fail(401, 'MISSING_TOKEN', 'Nhập token GitHub cá nhân để kết nối.');
    this.#token = token.trim(); this.config = config; this.fetcher = fetcher.bind(globalThis);
    this.root = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
  }
  clear() { this.#token = ''; }
  async request(route, options = {}) {
    if (!/^\/(?!\/)/.test(route) || /[\\\x00-\x20]/.test(route)) fail(422, 'INVALID_GITHUB_PATH', 'Chỉ được gửi yêu cầu tới GitHub API.');
    if (!this.#token) fail(401, 'DISCONNECTED', 'Vui lòng kết nối lại GitHub.');
    const url = new URL('https://api.github.com' + route);
    if (url.origin !== 'https://api.github.com') fail(422, 'INVALID_GITHUB_PATH', 'Chỉ được gửi yêu cầu tới GitHub API.');
    let response;
    try {
      response = await this.fetcher(url.href, {
        ...options, credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.#token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
        signal: AbortSignal.timeout(30000),
      });
    } catch { fail(503, 'GITHUB_UNREACHABLE', 'Không kết nối được GitHub. Kiểm tra mạng rồi thử lại.'); }
    if (!response.ok) {
      const status = [401, 403, 404].includes(response.status) ? response.status : [409, 422].includes(response.status) ? 409 : 502;
      const message = status === 401 ? 'Token không hợp lệ hoặc đã hết hạn. Hãy kết nối lại.' : status === 403 ? 'GitHub từ chối truy cập. Kiểm tra quyền repo, quyền của token hoặc hạn mức API.' : status === 404 ? 'Không tìm thấy repo hoặc tài nguyên; token có thể chưa được cấp quyền truy cập.' : status === 409 ? 'Không cập nhật được branch. Kiểm tra slug và quy tắc bảo vệ branch.' : 'GitHub tạm thời chưa xử lý được yêu cầu.';
      throw new HttpError(status, 'GITHUB_ERROR', message);
    }
    return response.status === 204 ? null : response.json();
  }
  async identity() {
    const user = await this.request('/user');
    if (!Number.isSafeInteger(user.id) || !user.login) fail(401, 'INVALID_IDENTITY', 'Không xác minh được tài khoản GitHub.');
    return { id: user.id, login: user.login };
  }
  async permission(login) {
    const identity = await this.identity();
    if (identity.login !== login) fail(401, 'IDENTITY_CHANGED', 'Tài khoản đã thay đổi. Hãy kết nối lại.');
    const repo = await this.request(this.root);
    return { permission: repo.permissions?.push === true ? 'write' : 'read' };
  }
  async snapshot() {
    const ref = await this.request(`${this.root}/git/ref/heads/${this.config.branch.split('/').map(encodeURIComponent).join('/')}`);
    const commit = await this.getCommit(ref.object.sha), tree = await this.request(`${this.root}/git/trees/${commit.tree.sha}?recursive=1`);
    if (tree.truncated) fail(503, 'REPO_TOO_LARGE', 'Repo quá lớn để tải đầy đủ danh mục.');
    return { sha: ref.object.sha, tree: commit.tree.sha, entries: tree.tree };
  }
  async getCommit(sha) { if (!/^[a-f0-9]{40}$/.test(sha)) fail(422, 'INVALID_COMMIT', 'Commit không hợp lệ.'); return this.request(`${this.root}/git/commits/${sha}`); }
  async readJson(path, snapshot) {
    const entry = snapshot.entries.find(e => e.path === path && e.type === 'blob'); if (!entry) return undefined;
    const blob = await this.request(`${this.root}/git/blobs/${entry.sha}`);
    try { return JSON.parse(new TextDecoder().decode(decode(blob.content))); } catch { fail(422, 'INVALID_METADATA', 'Metadata giao diện không hợp lệ.'); }
  }
  async blob(bytes) { return (await this.request(`${this.root}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: encode(bytes), encoding: 'base64' }) })).sha; }
  async commit(snapshot, entries, message) {
    const tree = await this.request(`${this.root}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: snapshot.tree, tree: entries }) });
    const commit = await this.request(`${this.root}/git/commits`, { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [snapshot.sha] }) });
    await this.request(`${this.root}/git/refs/heads/${this.config.branch.split('/').map(encodeURIComponent).join('/')}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
    return commit.sha;
  }
  async compare(base, head) { return this.request(`${this.root}/compare/${base}...${head}`); }
  async runs() { return this.request(`${this.root}/actions/workflows/pages.yml/runs?branch=${encodeURIComponent(this.config.branch)}&per_page=20`); }
}

export class ShowcaseClient {
  #github = null;
  #user = null;
  constructor(config = defaults, fetcher = fetch, publicFetch = fetch) { this.config = config; this.fetcher = fetcher; this.publicFetch = publicFetch; }
  disconnect() { this.#github?.clear(); this.#github = null; this.#user = null; }
  async connect(token) {
    this.disconnect(); const github = new PagesGitHub(this.config, token, this.fetcher);
    try {
      const user = await github.identity(), permission = await github.permission(user.login);
      this.#github = github; this.#user = user;
      return { user, canPublish: permission.permission === 'write', repository: `${this.config.owner}/${this.config.repo}`, previewBase: this.config.previewBase };
    } catch (error) { github.clear(); throw error; }
  }
  async currentUser() {
    if (!this.#github || !this.#user) fail(401, 'DISCONNECTED', 'Kết nối GitHub để tiếp tục.');
    const github = this.#github, user = this.#user, identity = await github.identity();
    if (github !== this.#github) fail(409, 'CONNECTION_CHANGED', 'Kết nối đã thay đổi. Thao tác cũ được dừng.');
    if (identity.id !== user.id) { this.disconnect(); fail(401, 'IDENTITY_CHANGED', 'Tài khoản đã thay đổi. Hãy kết nối lại.'); }
    this.#user = identity; return identity;
  }
  previewUrl(slug) { return new URL(`viewer/?slug=${encodeURIComponent(validateSlug(slug))}`, this.config.previewBase).href; }
  async catalog() {
    const user = await this.currentUser(), snapshot = await this.#github.snapshot(), projects = [];
    for (const entry of snapshot.entries.filter(e => e.type === 'blob' && /^catalog\/[a-z0-9-]+\.json$/.test(e.path))) {
      const metadata = await this.#github.readJson(entry.path, snapshot);
      if (metadata?.ownerId !== user.id) continue;
      const slug = validateSlug(metadata.slug);
      if (entry.path !== `catalog/${slug}.json` || typeof metadata.name !== 'string') fail(422, 'INVALID_METADATA', 'Metadata giao diện không hợp lệ.');
      projects.push({ ...metadata, previewUrl: this.previewUrl(slug) });
    }
    return projects.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }
  async publish({ name, slug, file }) {
    const user = await this.currentUser();
    if ((await this.#github.permission(user.login)).permission !== 'write') fail(403, 'NO_WRITE_ACCESS', 'Tài khoản không có quyền ghi repo.');
    const result = await publishProject(this.#github, user, { name, slug, files: await unpackUpload(file) });
    return { ...result, previewUrl: this.previewUrl(result.slug) };
  }
  async delete(slug) {
    const user = await this.currentUser(), result = await deleteProject(this.#github, user, slug);
    return { ...result, previewUrl: this.previewUrl(result.slug) };
  }
  async status(job) {
    const user = await this.currentUser();
    const result = await projectStatus(this.#github, user, job.commitSha, job.slug, { PREVIEW_BASE_URL: this.config.previewBase }, this.publicFetch);
    return { ...result, previewUrl: this.previewUrl(result.slug) };
  }
}
