export const REMEMBER_DAYS = 7;
const REMEMBER_MS = REMEMBER_DAYS * 24 * 60 * 60 * 1000;

export class TokenStore {
  #key;
  #session;
  #local;
  #now;
  constructor({ key, session = () => globalThis.sessionStorage, local = () => globalThis.localStorage, now = Date.now }) {
    this.#key = key; this.#session = session; this.#local = local; this.#now = now;
  }
  clear() {
    let removed = true;
    for (const getStorage of [this.#session, this.#local]) {
      try { getStorage().removeItem(this.#key); } catch { removed = false; }
    }
    return removed;
  }
  save(token, remember = false) {
    const cleared = this.clear();
    if (!cleared || typeof token !== 'string' || !token.trim()) return false;
    const record = { version: 1, token: token.trim(), remember: Boolean(remember), expiresAt: remember ? this.#now() + REMEMBER_MS : null };
    try { (remember ? this.#local : this.#session)().setItem(this.#key, JSON.stringify(record)); return true; }
    catch { return false; }
  }
  load() {
    for (const [getStorage, remember] of [[this.#session, false], [this.#local, true]]) {
      try {
        const storage = getStorage(), raw = storage.getItem(this.#key); if (!raw) continue;
        let record;
        try { record = JSON.parse(raw); } catch { storage.removeItem(this.#key); continue; }
        const valid = record?.version === 1 && typeof record.token === 'string' && record.token.trim() && record.remember === remember && (remember ? Number.isFinite(record.expiresAt) && record.expiresAt > this.#now() && record.expiresAt <= this.#now() + REMEMBER_MS : record.expiresAt === null);
        if (!valid) { storage.removeItem(this.#key); continue; }
        return record;
      } catch { /* Storage may be disabled; the app can still connect in memory. */ }
    }
    return null;
  }
}

export class SavedConnection {
  #client;
  #store;
  #onInvalid;
  #version = 0;
  constructor(client, store, onInvalid = () => {}) { this.#client = client; this.#store = store; this.#onInvalid = onInvalid; }
  #invalid(error, version) {
    if (error.status !== 401 || version !== this.#version) return;
    this.#version++;
    this.#store.clear(); this.#client.disconnect(); this.#onInvalid();
  }
  async connect(token, remember = false) {
    const version = ++this.#version;
    try {
      const account = await this.#client.connect(token);
      return { account, stored: this.#store.save(token, remember) };
    } catch (error) { this.#invalid(error, version); throw error; }
  }
  async restore() {
    const record = this.#store.load(); if (!record) return null;
    const version = ++this.#version;
    try { return { account: await this.#client.connect(record.token), remember: record.remember }; }
    catch (error) { this.#invalid(error, version); throw error; }
    finally { record.token = ''; }
  }
  disconnect() { this.#version++; this.#client.disconnect(); return this.#store.clear(); }
  async #run(operation) {
    const version = this.#version;
    try { return await operation(); } catch (error) { this.#invalid(error, version); throw error; }
  }
  catalog() { return this.#run(() => this.#client.catalog()); }
  publish(input) { return this.#run(() => this.#client.publish(input)); }
  delete(slug) { return this.#run(() => this.#client.delete(slug)); }
  status(job) { return this.#run(() => this.#client.status(job)); }
}
