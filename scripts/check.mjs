import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(name)); else if (/\.(js|mjs|ts)$/.test(name)) result.push(name);
  }
  return result;
}
for (const dir of ['admin', 'viewer', 'worker', 'scripts', 'tests']) {
  for (const name of await files(dir)) {
    const run = spawnSync(process.execPath, ['--check', name], { stdio: 'inherit' }); if (run.status !== 0) process.exit(run.status || 1);
  }
}
const run = spawnSync(process.execPath, ['--test', ...(await readdir('tests')).filter(n => n.endsWith('.test.mjs')).map(n => path.join('tests', n))], { stdio: 'inherit' });
process.exit(run.status === 0 ? 0 : run.status || 1);
