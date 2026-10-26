import { cp, mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ShowcaseClient } from '../admin/assets/client.js';
import { repositoryFixture } from '../tests/pages-fixture-repo.mjs';
import { buildShowcase } from './build-showcase.ts';

const config = { owner: 'Kintinz', repo: 'showcase', branch: 'main', previewBase: 'https://kintinz.github.io/showcase/' };
const out = path.resolve('.build', `performance-${Date.now()}`), root = path.join(out, 'source');
await mkdir(root, { recursive: true });
for (const dir of ['admin', 'worker', 'viewer']) await cp(dir, path.join(root, dir), { recursive: true });
await mkdir(path.join(root, 'catalog'));
await mkdir(path.join(root, 'projects'));
async function bytes(dir) {
  let size = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) size += entry.isDirectory() ? await bytes(path.join(dir, entry.name)) : (await stat(path.join(dir, entry.name))).size;
  return size;
}
const report = { measuredAt: new Date().toISOString(), environment: 'Local in-memory GitHub HTTP fixture; no network delay; small HTML per project; times are not production estimates.', rows: [] };
for (const count of [100, 1000, 5000]) {
  const seed = {};
  for (let i = 0; i < count; i++) {
    const slug = `project-${i}`, metadata = { slug, name: `Project ${i}`, ownerId: i % 10 ? 7 : 42, uploadId: '11111111-1111-4111-8111-111111111111', createdAt: '2026-10-26T00:00:00Z' };
    seed[`catalog/${slug}.json`] = JSON.stringify(metadata);
    seed[`projects/${slug}/index.html`] = '<!doctype html><title>Performance fixture</title><h1>Small project</h1>';
  }
  const fixture = repositoryFixture(seed); let active = 0, peak = 0;
  const fetcher = async (...args) => { active++; peak = Math.max(peak, active); try { return await fixture.fetcher(...args); } finally { active--; } };
  const client = new ShowcaseClient(config, fetcher); await client.connect('fixture-token'); fixture.calls.length = 0;
  let start = performance.now(); const projects = await client.catalog();
  const coldMs = performance.now() - start, coldRequests = fixture.calls.length, coldPeak = peak;
  fixture.calls.length = 0; peak = 0; start = performance.now(); await client.catalog();
  const warmMs = performance.now() - start, warmRequests = fixture.calls.length;
  for (const [name, value] of Object.entries(seed)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), value);
  }
  const artifact = path.join(out, `pages-${count}`); start = performance.now();
  await buildShowcase(root, artifact, 'a'.repeat(40));
  const buildMs = performance.now() - start;
  const row = { totalProjects: count, ownedProjects: projects.length, coldRequests, warmRequests, coldPeak, coldMs: Math.round(coldMs), warmMs: Math.round(warmMs), buildMs: Math.round(buildMs), sourceBytes: await bytes(path.join(root, 'projects')), artifactBytes: await bytes(artifact) };
  report.rows.push(row); console.log(JSON.stringify(row));
}
await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(`Report: ${path.join(out, 'report.json')}`);
