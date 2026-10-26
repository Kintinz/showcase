export function updateProgress(job, result, now = new Date().toISOString()) {
  delete job.error;
  Object.assign(job, result);
  if (job.state === 'ready' && !job.readyAt) job.readyAt = now;
}

export function progressText(job, now = Date.now()) {
  if (job.state === 'ready') {
    const date = new Date(job.readyAt);
    const label = job.operation === 'delete' ? 'Đã gỡ khỏi Pages' : 'Đã lên Pages';
    return Number.isNaN(date.getTime()) ? `${label}.` : `${label} lúc ${date.toLocaleTimeString('vi-VN')}, ngày ${date.toLocaleDateString('vi-VN')}.`;
  }
  if (job.state === 'failed') return `Triển khai thất bại: ${job.error || 'Kiểm tra GitHub Actions để xem chi tiết.'}`;
  const started = Date.parse(job.startedAt), seconds = Math.max(0, Math.floor((now - started) / 1000));
  return `${job.operation === 'delete' ? 'Đang chờ gỡ khỏi Pages…' : 'Đang triển khai lên Pages…'}${Number.isFinite(seconds) ? ` · Đã chờ ${seconds} giây` : ''}${job.error ? ` · ${job.error}` : ''}`;
}
