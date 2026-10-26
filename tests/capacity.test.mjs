import test from 'node:test';
import assert from 'node:assert/strict';
import { capacityLevel, createCapacityReport, repositorySize, writeCapacityReport } from '../scripts/capacity.mjs';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('decimal MB boundaries warn exactly at 500/700/850 and block exactly at 950', () => {
  for (const [bytes, level] of [[0, 'normal'], [499999999, 'normal'], [500000000, 'warning'], [699999999, 'warning'], [700000000, 'high'], [849999999, 'high'], [850000000, 'critical'], [949999999, 'critical'], [950000000, 'blocked'], [1000000000, 'blocked']]) assert.equal(capacityLevel(bytes), level);
  for (const value of [-1, NaN, Infinity, undefined, 1.2]) assert.throws(() => capacityLevel(value));
});

test('report totals use active projects, ranks top ten by preview and preserves unknown repository size', () => {
  const projects = Array.from({ length: 12 }, (_, i) => ({ slug: `project-${i}`, fileCount: i + 1, sourceBytes: (i + 1) * 3, previewBytes: (i + 1) * 4 }));
  const report = createCapacityReport('a'.repeat(40), projects, 500000000);
  assert.equal(report.level, 'warning'); assert.equal(report.projectCount, 12); assert.equal(report.fileCount, 78);
  assert.equal(report.sourceBytes, 234); assert.equal(report.previewBytes, 312);
  assert.equal(report.topProjects.length, 10); assert.equal(report.topProjects[0].slug, 'project-11');
  assert.equal(report.repository.status, 'unavailable'); assert.equal(report.repository.sizeKilobytes, null);
  assert.deepEqual(createCapacityReport('a'.repeat(40), [], 123).topProjects, []);
});

test('repository metadata request is constrained to GitHub and errors never become zero or leak token', async () => {
  let calls = 0;
  const available = await repositorySize('Kintinz/showcase', 'private-fixture-token', async (url, options) => {
    calls++; assert.equal(url, 'https://api.github.com/repos/Kintinz/showcase');
    assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer private-fixture-token');
    return Response.json({ size: 1024, unrelated: 'discarded' });
  });
  assert.equal(calls, 1); assert.equal(available.sizeKilobytes, 1024);
  assert.ok(!JSON.stringify(available).includes('private-fixture-token'));
  for (const fetcher of [async () => { throw Error('private-fixture-token'); }, async () => Response.json({}, { status: 403 }), async () => Response.json({ size: -1 }), async () => Response.json({ size: null })]) {
    const value = await repositorySize('Kintinz/showcase', 'private-fixture-token', fetcher);
    assert.equal(value.status, 'unavailable'); assert.equal(value.sizeKilobytes, null); assert.ok(!JSON.stringify(value).includes('private-fixture-token'));
  }
  assert.equal((await repositorySize('https://evil.example', '', async () => { throw Error('should not call'); })).status, 'unavailable');
  assert.equal((await repositorySize('Kintinz/showcase', '', async () => Response.json({ size: 0 }))).status, 'available');
});

test('blocked report remains downloadable, but emits no Pages output and fails before deploy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-capacity-'));
  const report = createCapacityReport('a'.repeat(40), [{ slug: 'large', fileCount: 1, sourceBytes: 1, previewBytes: 2 }], 950000000);
  const output = path.join(root, 'output.txt'), summary = path.join(root, 'summary.md'), file = path.join(root, 'report/capacity.json');
  const annotations = [];
  await assert.rejects(() => writeCapacityReport(report, { file, output, summary, pagesPath: path.join(root, 'pages'), log: text => annotations.push(text) }), error => error.code === 'PAGES_CAPACITY_EXCEEDED');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).level, 'blocked');
  const outputs = await readFile(output, 'utf8'); assert.match(outputs, /report-path=/); assert.doesNotMatch(outputs, /^path=/m);
  assert.match(await readFile(summary, 'utf8'), /950/);
  assert.match(annotations[0], /::error/);
  await access(file);
  const normal = createCapacityReport('a'.repeat(40), [], 100);
  const normalOutput = path.join(root, 'normal-output.txt');
  await writeCapacityReport(normal, { file: path.join(root, 'normal.json'), output: normalOutput, pagesPath: path.join(root, 'pages'), cacheSave: true });
  assert.match(await readFile(normalOutput, 'utf8'), /^path=/m);
  assert.match(await readFile(normalOutput, 'utf8'), /cache-save=true/);
});
