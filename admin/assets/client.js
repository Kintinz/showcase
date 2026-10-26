import { config as defaults } from './config.js';
import { publishProject } from '../../worker/src/publish.ts';
import { deleteProject } from '../../worker/src/delete.ts';
import { unpackUpload, validateSlug } from '../../worker/src/package.ts';
import { projectStatus } from '../../worker/src/status.ts';
import { fail, HttpError } from '../../worker/src/errors.ts';
import { mapLimit } from '../../worker/src/parallel.ts';

function encode(bytes) {
  let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(text);
}
function decode(text) { return Uint8Array.from(atob(text.replace(/\s/g, '')), c => c.charCodeAt(0)); }

export class PagesGitHub {
  #token;
  #metadata = new Map();
  #metadataBytes = 0;
  constructor(config, token, fetcher = fetch) {
    if (!token?.trim()) fail(401, 'MISSING_TOKEN', 'Nhập token GitHub cá nhân để kết nối.');
    this.#token = token.trim(); this.config = config; this.fetcher = fetcher.bind(globalThis);
    this.root = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
  }
  clear() { this.#token = ''; this.#metadata.clear(); this.#metadataBytes = 0; }
  #forgetMetadata(sha) { this.#metadataBytes -= this.#metadata.get(sha)?.bytes || 0; this.#metadata.delete(sha); }
  retainMetadata(entries) {
    const shas = new Set(entries.map(entry => entry.sha));
    for (const sha of this.#metadata.keys()) if (!shas.has(sha)) this.#forgetMetadata(sha);
  }
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
    return { sha: ref.object.sha, tree: commit.tree.sha, entries: tree.tree, byPath: new Map(tree.tree.map(entry => [entry.path, entry])) };
  }
  async getCommit(sha) { if (!/^[a-f0-9]{40}$/.test(sha)) fail(422, 'INVALID_COMMIT', 'Commit không hợp lệ.'); return this.request(`${this.root}/git/commits/${sha}`); }
  async readJson(path, snapshot) {
    const entry = snapshot.byPath ? snapshot.byPath.get(path) : snapshot.entries.find(e => e.path === path); if (!entry || entry.type !== 'blob') return undefined;
    if (this.#metadata.has(entry.sha)) return structuredClone(this.#metadata.get(entry.sha).value);
    const blob = await this.request(`${this.root}/git/blobs/${entry.sha}`);
    let metadata, bytes;
    try { bytes = decode(blob.content); metadata = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail(422, 'INVALID_METADATA', 'Metadata giao diện không hợp lệ.'); }
    if (this.#token && bytes.byteLength <= 64 * 1024 && /^catalog\/[a-z0-9-]+\.json$/.test(path)) {
      this.#forgetMetadata(entry.sha);
      while (this.#metadata.size >= 6000 || this.#metadataBytes + bytes.byteLength > 8 * 1024 * 1024) this.#forgetMetadata(this.#metadata.keys().next().value);
      this.#metadata.set(entry.sha, { value: metadata, bytes: bytes.byteLength }); this.#metadataBytes += bytes.byteLength;
    }
    return structuredClone(metadata);
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
    const user = await this.currentUser(), github = this.#github, snapshot = await github.snapshot();
    const entries = snapshot.entries.filter(e => e.type === 'blob' && /^catalog\/[a-z0-9-]+\.json$/.test(e.path));
    github.retainMetadata(entries);
    const projects = await mapLimit(entries, 4, async entry => {
      const metadata = await github.readJson(entry.path, snapshot);
      if (metadata?.ownerId !== user.id) return null;
      const slug = validateSlug(metadata.slug);
      if (entry.path !== `catalog/${slug}.json` || typeof metadata.name !== 'string') fail(422, 'INVALID_METADATA', 'Metadata giao diện không hợp lệ.');
      return { ...metadata, previewUrl: this.previewUrl(slug) };
    });
    if (github !== this.#github) fail(409, 'CONNECTION_CHANGED', 'Kết nối đã thay đổi. Thao tác cũ được dừng.');
    return projects.filter(Boolean).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
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
    const [outcome] = await this.statuses([job]);
    if (outcome.error) throw outcome.error;
    return outcome.result;
  }
  async statuses(jobs) {
    if (!jobs.length) return [];
    const user = await this.currentUser(), github = this.#github, cache = new Map(); let authenticationError;
    const memo = (key, operation) => {
      if (!cache.has(key)) cache.set(key, Promise.resolve().then(operation).catch(error => { if (error.status === 401) authenticationError = error; throw error; }));
      return cache.get(key);
    };
    const shared = {
      getCommit: sha => memo(`commit:${sha}`, () => github.getCommit(sha)),
      compare: (base, head) => memo(`compare:${base}:${head}`, () => github.compare(base, head)),
      runs: () => memo('runs', () => github.runs()),
    };
    const publicFetch = this.publicFetch.bind(globalThis);
    const markerFetch = async (...args) => {
      const response = await memo('marker', () => publicFetch(...args));
      return { ok: response.ok, json: () => memo('marker-json', () => response.json()) };
    };
    const results = await mapLimit(jobs, 4, async job => {
      try {
        const result = await projectStatus(shared, user, job.commitSha, job.slug, { PREVIEW_BASE_URL: this.config.previewBase }, markerFetch);
        return { job, result: { ...result, previewUrl: this.previewUrl(result.slug) } };
      } catch (error) { if (error.status === 401) throw error; return { job, error }; }
    });
    if (github !== this.#github) fail(409, 'CONNECTION_CHANGED', 'Kết nối đã thay đổi. Thao tác cũ được dừng.');
    if (authenticationError) throw authenticationError;
    return results;
  }
}
