import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { PagesGitHub, ShowcaseClient } from '../admin/assets/client.js';
import { mapLimit } from '../worker/src/parallel.ts';
import { repositoryFixture } from '../tests/pages-fixture-repo.mjs';

const config = { owner: 'Kintinz', repo: 'showcase', branch: 'main', previewBase: 'https://kintinz.github.io/showcase/' };
const upload = [];
for (const workers of [1, 4]) {
  const fixture = repositoryFixture(); let active = 0, peak = 0;
  const fetcher = async (...args) => {
    active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 5)); return await fixture.fetcher(...args); }
    finally { active--; }
  };
  const github = new PagesGitHub(config, 'fixture-token', fetcher), start = performance.now();
  await mapLimit(Array.from({ length: 20 }, () => new TextEncoder().encode('Small fixture file')), workers, bytes => github.blob(bytes));
  upload.push({ workers, requests: fixture.calls.length, peak, elapsedMs: Math.round(performance.now() - start) });
}
const fixture = repositoryFixture(); let markerRequests = 0;
const client = new ShowcaseClient(config, fixture.fetcher, async () => { markerRequests++; return new Response('', { status: 404 }); });
await client.connect('fixture-token'); const jobs = [];
for (let i = 0; i < 20; i++) jobs.push(await client.publish({ name: `Job ${i}`, slug: `job-${i}`, file: new File(['<h1>x</h1>'], 'index.html') }));
const polling = [];
for (const batch of [false, true]) {
  fixture.calls.length = 0; markerRequests = 0; const start = performance.now();
  if (batch) await client.statuses(jobs); else for (const job of jobs) await client.status(job);
  polling.push({ batch, jobs: jobs.length, githubRequests: fixture.calls.length, markerRequests, workflowRequests: fixture.calls.filter(c => c.route.endsWith('/runs')).length, elapsedMs: Math.round(performance.now() - start) });
}
const report = { environment: 'Disposable local fixture. Blob stage has artificial 5 ms delay per request, polling has no network delay. Not production timings.', upload, polling };
const out = path.resolve('.build', `operations-${Date.now()}.json`); await mkdir('.build', { recursive: true });
await writeFile(out, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); console.log(`Report: ${out}`);
