import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenStore, SavedConnection, REMEMBER_DAYS } from '../admin/assets/connection.js';

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}
function fixture() {
  const session = storage(), local = storage(); let time = 100000;
  const store = new TokenStore({ key: 'test-repo-token', session: () => session, local: () => local, now: () => time });
  return { store, session, local, advance: ms => { time += ms; } };
}
function fakeClient() {
  return {
    connectCalls: [], disconnected: 0, error: null,
    async connect(token) { this.connectCalls.push(token); if (this.error) throw this.error; return { user: { id: 42, login: 'alice' }, canPublish: true }; },
    disconnect() { this.disconnected++; },
    async catalog() { if (this.error) throw this.error; return []; },
    async publish() { if (this.error) throw this.error; return { state: 'saved' }; },
    async delete() { if (this.error) throw this.error; return { state: 'saved' }; },
    async status() { if (this.error) throw this.error; return { state: 'ready' }; },
    async statuses() { if (this.error) throw this.error; return []; },
  };
}
const error = status => Object.assign(new Error('Service error'), { status });

test('default connection survives reload within tab but is not stored persistently', () => {
  const { store, session, local } = fixture();
  assert.equal(store.save('session-token', false), true);
  assert.ok(session.getItem('test-repo-token')); assert.equal(local.getItem('test-repo-token'), null);
  assert.equal(store.load().token, 'session-token'); assert.equal(store.load().remember, false);
  const newTab = new TokenStore({ key: 'test-repo-token', session: () => storage(), local: () => local });
  assert.equal(newTab.load(), null);
});
test('remember on device expires after exactly thirty days; expired token is removed', () => {
  const { store, local, session, advance } = fixture();
  assert.equal(REMEMBER_DAYS, 30); store.save('remembered-token', true);
  assert.equal(session.getItem('test-repo-token'), null); assert.ok(local.getItem('test-repo-token'));
  advance(30 * 24 * 60 * 60 * 1000 - 1); assert.equal(store.load().token, 'remembered-token');
  advance(1); assert.equal(store.load(), null); assert.equal(local.getItem('test-repo-token'), null);
});
test('changing remember mode or account clears the previous token in the other storage', () => {
  const { store, local, session } = fixture();
  store.save('old-account', true); store.save('new-account', false);
  assert.equal(local.getItem('test-repo-token'), null); assert.ok(session.getItem('test-repo-token').includes('new-account'));
  store.save('other-account', true); assert.equal(session.getItem('test-repo-token'), null);
  assert.equal(store.clear(), true); assert.equal(store.load(), null);
});
test('malformed records are ignored; blocked storage does not break a connection', async () => {
  const { store, local } = fixture(); local.setItem('test-repo-token', '{not-json');
  assert.equal(store.load(), null); assert.equal(local.getItem('test-repo-token'), null);
  const blocked = () => { throw new Error('Storage blocked'); };
  const blockedStore = new TokenStore({ key: 'blocked', session: blocked, local: blocked });
  assert.equal(blockedStore.load(), null);
  const client = fakeClient(), connection = new SavedConnection(client, blockedStore);
  const result = await connection.connect('memory-only', true);
  assert.equal(result.account.user.id, 42); assert.equal(result.stored, false);
});
test('restore verifies GitHub again without extending the original thirty-day expiry', async () => {
  const { store, local, advance } = fixture(); store.save('restore-token', true);
  const original = local.getItem('test-repo-token'); advance(10000);
  const client = fakeClient(), connection = new SavedConnection(client, store);
  assert.equal((await connection.restore()).account.user.id, 42);
  assert.deepEqual(client.connectCalls, ['restore-token']); assert.equal(local.getItem('test-repo-token'), original);
});
test('401 on restore clears saved token and memory, while network and 403 errors preserve storage', async () => {
  for (const status of [401, 403, 503]) {
    const { store } = fixture(); store.save('saved-token', true);
    const client = fakeClient(); client.error = error(status); let invalidations = 0;
    const connection = new SavedConnection(client, store, () => invalidations++);
    await assert.rejects(() => connection.restore(), e => e.status === status);
    assert.equal(store.load() === null, status === 401); assert.equal(invalidations, status === 401 ? 1 : 0);
  }
});
test('401 during any connected operation clears storage; disconnect clears both remember modes', async () => {
  for (const method of ['catalog', 'publish', 'delete', 'status', 'statuses']) {
    const { store } = fixture(), client = fakeClient(); let invalidations = 0;
    const connection = new SavedConnection(client, store, () => invalidations++);
    await connection.connect('accepted-token', true); client.error = error(401);
    await assert.rejects(() => connection[method]({}), e => e.status === 401);
    assert.equal(store.load(), null); assert.equal(invalidations, 1); assert.equal(client.disconnected, 1);
  }
  const { store } = fixture(), client = fakeClient(), connection = new SavedConnection(client, store);
  await connection.connect('token', false); assert.equal(connection.disconnect(), true); assert.equal(store.load(), null);
});
test('tokens are only stored after successful authentication', async () => {
  const { store } = fixture(), client = fakeClient(); client.error = error(401);
  const connection = new SavedConnection(client, store);
  await assert.rejects(() => connection.connect('bad-token', true)); assert.equal(store.load(), null);
});
test('an old in-flight 401 cannot erase a newly connected account', async () => {
  const { store } = fixture(), client = fakeClient(); let rejectOld;
  client.catalog = () => new Promise((resolve, reject) => { rejectOld = reject; });
  let invalidations = 0; const connection = new SavedConnection(client, store, () => invalidations++);
  await connection.connect('old-account', true); const oldRequest = connection.catalog();
  await connection.connect('new-account', false); rejectOld(error(401));
  await assert.rejects(() => oldRequest);
  assert.equal(store.load().token, 'new-account'); assert.equal(invalidations, 0);
});
