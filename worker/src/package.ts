import { fail } from './errors.ts';
export const LIMITS = { upload: 2 * 1024 * 1024, expanded: 10 * 1024 * 1024, file: 2 * 1024 * 1024, count: 20 };
const allowed = /\.(html?|css|js|mjs|json|png|jpe?g|gif|webp|svg|ico|avif|woff2?|ttf|otf|txt)$/i;
export function validateSlug(slug) {
  if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 64 || ['viewer', 'assets', 'previews', 'api', 'catalog', 'projects', 'admin', 'index', '404'].includes(slug)) fail(422, 'INVALID_SLUG', 'Slug gồm chữ thường, số, dấu gạch ngang; tối đa 64 ký tự và không trùng đường dẫn hệ thống.');
  return slug;
}
export function validatePath(path) {
  if (!path || path.length > 240 || /[\\\x00-\x1f\x7f:#?%]/.test(path) || path.startsWith('/') || path.normalize('NFC') !== path || path.split('/').some(p => !p || p.startsWith('.') || p.trim() !== p) || !allowed.test(path)) fail(422, 'INVALID_PATH', `Đường dẫn hoặc loại file không được hỗ trợ: ${path}`);
  return path;
}
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) { crc ^= b; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export async function boundedBytes(stream, max) {
  const reader = stream.getReader(), parts = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > max) { await reader.cancel(); fail(413, 'TOO_LARGE', 'Dữ liệu vượt giới hạn dung lượng.'); } parts.push(value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let cursor = 0; for (const p of parts) { bytes.set(p, cursor); cursor += p.length; } return bytes;
}
function checkReferences(path, bytes) {
  if (!/\.(html?|css|js|mjs)$/i.test(path)) return;
  const text = new TextDecoder().decode(bytes);
  if (/(?:\b(?:src|href|action)\s*=\s*["']\/(?!\/)|url\(\s*["']?\/(?!\/)|(?:fetch|import)\s*\(\s*["']\/(?!\/))/i.test(text) || /<base\b/i.test(text)) fail(422, 'ROOT_REFERENCE', `${path}: dùng đường dẫn tài nguyên tương đối, không dùng /assets hoặc thẻ base.`);
}
async function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), files = [], seen = new Set();
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) if (view.getUint32(p, true) === 0x06054b50 && p + 22 + view.getUint16(p + 20, true) === bytes.length) { end = p; break; }
  if (end < 0) fail(422, 'INVALID_ZIP', 'Không đọc được ZIP.');
  const count = view.getUint16(end + 10, true), cdSize = view.getUint32(end + 12, true), cdStart = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count !== view.getUint16(end + 8, true) || count > LIMITS.count || cdStart + cdSize !== end) fail(422, 'ZIP_UNSUPPORTED', 'ZIP nhiều volume, ZIP64 hoặc quá nhiều file không được hỗ trợ.');
  let p = cdStart, total = 0; const ranges = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || view.getUint32(p, true) !== 0x02014b50) fail(422, 'INVALID_ZIP', 'ZIP lỗi cấu trúc.');
    const flags = view.getUint16(p + 8, true), method = view.getUint16(p + 10, true), crc = view.getUint32(p + 16, true), packed = view.getUint32(p + 20, true), size = view.getUint32(p + 24, true), nl = view.getUint16(p + 28, true), el = view.getUint16(p + 30, true), cl = view.getUint16(p + 32, true), offset = view.getUint32(p + 42, true), mode = view.getUint32(p + 38, true) >>> 16;
    if (p + 46 + nl + el + cl > end || flags & 1 || ![0, 8].includes(method) || (mode & 0xf000) === 0xa000 || view.getUint16(p + 34, true)) fail(422, 'ZIP_UNSUPPORTED', 'ZIP mã hóa, symlink hoặc định dạng nén không được hỗ trợ.');
    const rawName = bytes.slice(p + 46, p + 46 + nl); const name = new TextDecoder('utf-8', { fatal: true }).decode(rawName); p += 46 + nl + el + cl;
    if (size > LIMITS.file || (total += size) > LIMITS.expanded) fail(413, 'TOO_LARGE', 'ZIP vượt dung lượng giải nén cho phép.');
    if (offset + 30 > cdStart || view.getUint32(offset, true) !== 0x04034b50) fail(422, 'INVALID_ZIP', 'ZIP lỗi header.');
    const lnl = view.getUint16(offset + 26, true), lel = view.getUint16(offset + 28, true), start = offset + 30 + lnl + lel;
    if (start + packed > cdStart || view.getUint16(offset + 6, true) !== flags || view.getUint16(offset + 8, true) !== method || new TextDecoder().decode(bytes.slice(offset + 30, offset + 30 + lnl)) !== name || ranges.some(([a, b]) => offset < b && start + packed > a)) fail(422, 'INVALID_ZIP', 'ZIP có đường dẫn/header không nhất quán.');
    ranges.push([offset, start + packed]);
    if (name.endsWith('/')) { validatePath(name + 'directory.txt'); if (size) fail(422, 'INVALID_ZIP', 'Thư mục ZIP chứa dữ liệu không hợp lệ.'); continue; }
    validatePath(name); const key = name.toLowerCase(); if (seen.has(key)) fail(422, 'DUPLICATE_PATH', 'ZIP chứa tên file trùng.'); seen.add(key);
    let data = bytes.slice(start, start + packed);
    if (method === 8) data = await boundedBytes(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')), Math.min(size, LIMITS.file));
    if (data.length !== size || crc32(data) !== crc) fail(422, 'INVALID_ZIP', 'ZIP lỗi kích thước hoặc checksum.');
    checkReferences(name, data); files.push({ path: name, bytes: data });
  }
  if (p !== end || !files.some(f => f.path === 'index.html')) fail(422, 'MISSING_ENTRY', 'ZIP phải có index.html ở thư mục gốc.');
  return files;
}
export async function unpackUpload(file) {
  if (!file || typeof file.arrayBuffer !== 'function') fail(422, 'MISSING_FILE', 'Chọn file HTML hoặc ZIP.');
  if (!file.size || file.size > LIMITS.upload) fail(413, 'TOO_LARGE', 'File phải lớn hơn 0 và tối đa 2 MiB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (/\.html?$/i.test(file.name)) { checkReferences('index.html', bytes); return [{ path: 'index.html', bytes }]; }
  if (!/\.zip$/i.test(file.name)) fail(422, 'INVALID_FILE', 'Chỉ nhận HTML hoặc ZIP.');
  try { return await unzip(bytes); } catch (e) { if (e.status) throw e; fail(422, 'INVALID_ZIP', 'ZIP hỏng hoặc không được hỗ trợ.'); }
}
