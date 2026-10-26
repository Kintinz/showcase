import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

export const CAPACITY_THRESHOLDS = Object.freeze({ warning: 500000000, high: 700000000, critical: 850000000, blocked: 950000000 });
function count(value) { if (!Number.isSafeInteger(value) || value < 0) throw Error('Capacity counters must be nonnegative safe integers.'); return value; }
export function capacityLevel(bytes) {
  count(bytes);
  for (const level of ['blocked', 'critical', 'high', 'warning']) if (bytes >= CAPACITY_THRESHOLDS[level]) return level;
  return 'normal';
}
export function createCapacityReport(sha, projects, bytes) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('Capacity report requires a commit SHA.');
  const rows = projects.map(project => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.slug)) throw Error('Invalid project slug.');
    return { slug: project.slug, fileCount: count(project.fileCount), sourceBytes: count(project.sourceBytes), previewBytes: count(project.previewBytes) };
  });
  const sum = key => count(rows.reduce((total, project) => total + project[key], 0));
  return {
    version: 1, sha, generatedAt: new Date().toISOString(), unit: 'decimal MB = 1000000 bytes',
    level: capacityLevel(bytes), thresholdsBytes: CAPACITY_THRESHOLDS,
    artifactBytes: bytes, projectCount: rows.length, fileCount: sum('fileCount'), sourceBytes: sum('sourceBytes'), previewBytes: sum('previewBytes'),
    repository: { status: 'unavailable', sizeKilobytes: null, reason: 'not-requested' },
    topProjects: [...rows].sort((a, b) => b.previewBytes - a.previewBytes || a.slug.localeCompare(b.slug)).slice(0, 10), projects: rows,
  };
}
export async function repositorySize(repository, token, fetcher = fetch) {
  const unknown = { status: 'unavailable', sizeKilobytes: null, reason: 'api-unavailable' };
  if (!repository) return { ...unknown, reason: 'not-requested' };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return unknown;
  try {
    const response = await fetcher(`https://api.github.com/repos/${repository.split('/').map(encodeURIComponent).join('/')}`, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return unknown;
    const data = await response.json();
    if (!Number.isSafeInteger(data.size) || data.size < 0) return unknown;
    return { status: 'available', sizeKilobytes: data.size, observedAt: new Date().toISOString() };
  } catch { return unknown; }
}
const mb = bytes => (bytes / 1000000).toFixed(2);
export async function writeCapacityReport(report, { file, output, summary, pagesPath, cacheSave = false, log = console.log } = {}) {
  const level = capacityLevel(report.artifactBytes);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(report, null, 2) + '\n');
  if (output) await appendFile(output, `report-path=${file}\n`);
  const labels = { normal: 'Bình thường', warning: 'Cảnh báo', high: 'Cảnh báo cao', critical: 'Gần giới hạn', blocked: 'Chặn triển khai' };
  const repository = report.repository.status === 'available' ? `${report.repository.sizeKilobytes} KB (GitHub API, tham khảo)` : 'Chưa lấy được; không coi là 0';
  const text = `### Dung lượng Showcase — ${labels[level]}\n\n| Chỉ số | Giá trị |\n|---|---:|\n| Dự án trong danh mục | ${report.projectCount} |\n| File đang dùng | ${report.fileCount} |\n| Source dự án đang dùng | ${mb(report.sourceBytes)} MB |\n| Preview JSON | ${mb(report.previewBytes)} MB |\n| Artifact Pages | ${mb(report.artifactBytes)} MB |\n| Repo GitHub | ${repository} |\n\nNgưỡng cảnh báo: 500 / 700 / 850 MB; chặn deploy từ 950 MB. Một MB = 1.000.000 byte. Dung lượng repo không phải phép đo riêng lịch sử Git.\n\n#### 10 dự án lớn nhất theo preview\n\n| Slug | File | Source (MB) | Preview (MB) |\n|---|---:|---:|---:|\n${report.topProjects.map(project => `| ${project.slug} | ${project.fileCount} | ${mb(project.sourceBytes)} | ${mb(project.previewBytes)} |`).join('\n') || '| Không có dự án | 0 | 0 | 0 |'}\n`;
  if (summary) await appendFile(summary, text);
  if (level !== 'normal') log(`::${level === 'blocked' ? 'error' : 'warning'} title=Showcase capacity::Artifact ${mb(report.artifactBytes)} MB; policy ${level}; deploy blocked at 950 MB.`);
  if (level === 'blocked') {
    const error = new Error('Artifact Pages đạt ngưỡng 950 MB. Dừng trước upload/deploy; source đã lưu trên GitHub, bản Pages hiện tại được giữ lại.');
    error.code = 'PAGES_CAPACITY_EXCEEDED'; throw error;
  }
  if (output && pagesPath) await appendFile(output, `path=${pagesPath}\ncache-save=${Boolean(cacheSave)}\n`);
}
