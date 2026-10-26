import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { validateSlug, unpackUpload, crc32 } from '../worker/src/package.ts';
import { canWrite, assertOwner } from '../worker/src/permissions.ts';
import { seal, unseal, requireWriteRequest } from '../worker/src/auth.ts';

export function zip(entries, method = 8) {
  const local = [], central = []; let offset = 0;
  for (const [name, text] of entries) {
    const n = Buffer.from(name), bytes = Buffer.from(text), packed = method === 8 ? deflateRawSync(bytes) : bytes;
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt16LE(method, 8);
    h.writeUInt32LE(crc32(bytes), 14); h.writeUInt32LE(packed.length, 18); h.writeUInt32LE(bytes.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc32(bytes), 16); c.writeUInt32LE(packed.length, 20); c.writeUInt32LE(bytes.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    local.push(h, n, packed); central.push(c, n); offset += h.length + n.length + packed.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

test('slug protects reserved routes and paths', () => {
  assert.equal(validateSlug('landing-v2'), 'landing-v2');
  for (const slug of ['../x', 'viewer', 'assets', 'API', '', 'a/b', 'a'.repeat(65)]) assert.throws(() => validateSlug(slug));
});
test('HTML normalizes entry; ZIP preserves relative assets and Unicode', async () => {
  const files = await unpackUpload(new File(['<h1>Demo</h1>'], 'demo.html'));
  assert.equal(files[0].path, 'index.html');
  const archive = zip([['index.html', '<link href="assets/a.css">'], ['assets/a.css', 'body{}'], ['ảnh đẹp.svg', '<svg/>']]);
  assert.equal((await unpackUpload(new File([archive], 'demo.zip'))).length, 3);
});
test('ZIP rejects traversal, duplicate paths, nested archive, missing entry and root asset URLs', async () => {
  for (const entries of [
    [['index.html', 'ok'], ['../evil.js', 'x']],
    [['index.html', 'x'], ['INDEX.html', 'x']],
    [['index.html', 'x'], ['a.zip', 'x']],
    [['folder/index.html', 'x']],
    [['index.html', '<img src="/assets/a.png">']],
    [['index.html', 'x'], ['.github/workflows/a.yml', 'x']],
  ]) await assert.rejects(() => unpackUpload(new File([zip(entries)], 'x.zip')));
});
test('compressed and expanded limits and checksum enforced', async () => {
  await assert.rejects(() => unpackUpload(new File(['x'.repeat(2 * 1024 * 1024 + 1)], 'x.html')));
  await assert.rejects(() => unpackUpload(new File([zip([['index.html', 'x'.repeat(11 * 1024 * 1024)]])], 'x.zip')));
  const bad = zip([['index.html', 'hello']], 0); bad[40] ^= 1;
  await assert.rejects(() => unpackUpload(new File([bad], 'x.zip')));
});
test('write permission and stable owner identity', () => {
  for (const p of ['write', 'maintain', 'admin']) assert.equal(canWrite({ permission: p }), true);
  for (const p of ['read', 'triage', 'none']) assert.equal(canWrite({ permission: p }), false);
  assert.doesNotThrow(() => assertOwner({ ownerId: 42 }, { id: 42, login: 'renamed' }));
  assert.throws(() => assertOwner({ ownerId: 42 }, { id: 7, login: 'admin' }));
  assert.throws(() => assertOwner({}, { id: 42 }));
});
test('encrypted sessions reject tampering, expiration and wrong purpose', async () => {
  const key = 'a'.repeat(40), token = await seal({ purpose: 'session', exp: Date.now() + 10000, user: { id: 42 } }, key);
  assert.equal((await unseal(token, key, 'session')).user.id, 42);
  await assert.rejects(() => unseal(token + 'x', key, 'session'));
  await assert.rejects(() => unseal(token, key, 'oauth'));
  await assert.rejects(() => unseal(token, 'b'.repeat(40), 'session'));
  const expired = await seal({ purpose: 'session', exp: Date.now() - 1000 }, key);
  await assert.rejects(() => unseal(expired, key, 'session'));
});
test('ZIP enforces 20-entry limit including folders', async () => {
  const entries = [['index.html', 'hello'], ...Array.from({ length: 20 }, (_, i) => [`a${i}.txt`, 'x'])];
  await assert.rejects(() => unpackUpload(new File([zip(entries)], 'x.zip')), e => e.status === 422);
});
test('mutations require same origin and CSRF token', () => {
  const req = (origin, csrf) => new Request('https://admin.example/api/publishes', { method: 'POST', headers: { Origin: origin, 'X-CSRF-Token': csrf } });
  assert.doesNotThrow(() => requireWriteRequest(req('https://admin.example', 'abc'), { csrf: 'abc' }));
  assert.throws(() => requireWriteRequest(req('https://evil.example', 'abc'), { csrf: 'abc' }));
  assert.throws(() => requireWriteRequest(req('https://admin.example', 'wrong'), { csrf: 'abc' }));
});
