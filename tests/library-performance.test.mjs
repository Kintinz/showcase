import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPage, PollScheduler } from '../admin/assets/library.js';

test('pagination renders 24 owned items, clamps after delete and searches all pages', () => {
  const items = Array.from({ length: 51 }, (_, i) => ({ name: `Giao diện ${i}`, slug: `project-${i}` }));
  assert.equal(projectPage(items, '', 1).items.length, 24);
  assert.equal(projectPage(items, '', 3).items.length, 3);
  assert.equal(projectPage(items.slice(0, 24), '', 3).page, 1);
  assert.equal(projectPage(items, 'project-50', 1).items[0].slug, 'project-50');
  assert.deepEqual(projectPage(items, 'missing', 5).items, []);
});

test('browser timer functions keep their native global receiver', async () => {
  const setTimer = function () { assert.equal(this, globalThis); return 1; };
  const clearTimer = function () { assert.equal(this, globalThis); };
  const scheduler = new PollScheduler({ run: async () => {}, hasWork: () => true, visible: () => true, setTimer, clearTimer });
  await scheduler.start(); scheduler.stop();
});

test('an in-flight cycle cannot restart polling after stop, or overlap a resume', async () => {
  let finish, calls = 0, timer, active = 0, peak = 0;
  const scheduler = new PollScheduler({ run: async () => { calls++; active++; peak = Math.max(peak, active); await new Promise(resolve => { finish = resolve; }); active--; }, hasWork: () => true, visible: () => true,
    setTimer: callback => { timer = callback; return 1; }, clearTimer: () => { timer = null; } });
  const first = scheduler.start(); scheduler.stop(); finish(); await first;
  assert.equal(timer, null);
  const second = scheduler.start(); await scheduler.start(); finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 3); assert.equal(peak, 1);
  scheduler.stop(); finish(); await second; assert.equal(timer, null);
});

test('polling backs off, pauses hidden tabs, resumes immediately and stops on logout', async () => {
  let visible = true, calls = 0, timer, delay;
  const scheduler = new PollScheduler({ run: async () => { calls++; }, hasWork: () => true, visible: () => visible,
    setTimer: (callback, ms) => { timer = callback; delay = ms; return 1; }, clearTimer: () => { timer = null; } });
  await scheduler.start(); assert.equal(calls, 1); assert.equal(delay, 12000);
  await timer(); assert.equal(delay, 20000);
  await timer(); assert.equal(delay, 30000);
  visible = false; scheduler.pause(); assert.equal(timer, null);
  await scheduler.start(); assert.equal(calls, 3);
  visible = true; await scheduler.start(); assert.equal(calls, 4); assert.equal(delay, 12000);
  scheduler.stop(); assert.equal(timer, null);
});
