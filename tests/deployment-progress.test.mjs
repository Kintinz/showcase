import test from 'node:test';
import assert from 'node:assert/strict';
import { progressText, updateProgress } from '../admin/assets/progress.js';

test('waiting duration starts at upload, with no premature ready claim', () => {
  const job = { operation: 'publish', state: 'queued', startedAt: '2026-10-26T07:30:00Z' };
  assert.match(progressText(job, Date.parse('2026-10-26T07:30:35Z')), /Đã chờ 35 giây/);
  assert.doesNotMatch(progressText(job), /Đã lên Pages/);
  assert.doesNotMatch(progressText({ state: 'queued' }), /NaN/);
});

test('first successful confirmation survives checks and reloads', () => {
  const job = { operation: 'publish', state: 'deploying' };
  updateProgress(job, { state: 'ready' }, '2026-10-26T07:31:25Z');
  assert.equal(job.readyAt, '2026-10-26T07:31:25Z');
  const restored = JSON.parse(JSON.stringify(job));
  updateProgress(restored, { state: 'ready' }, '2026-10-26T07:32:00Z');
  assert.equal(restored.readyAt, job.readyAt);
  assert.match(progressText(restored), /Đã lên Pages lúc/);
  assert.match(progressText({ ...restored, operation: 'delete' }), /Đã gỡ khỏi Pages lúc/);
});

test('failed deployment displays failure', () => {
  assert.equal(progressText({ state: 'failed', error: 'Build lỗi' }), 'Triển khai thất bại: Build lỗi');
});
