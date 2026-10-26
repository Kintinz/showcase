import { fail } from './errors.ts';
export function canWrite(result) { return ['write', 'maintain', 'admin'].includes(result?.permission); }
export function assertOwner(metadata, user) {
  if (!metadata?.ownerId || metadata.ownerId !== user.id) fail(403, 'NOT_OWNER', 'Bạn chỉ được xóa giao diện do mình đăng tải.');
}
export async function requirePermission(github, user) {
  const result = await github.permission(user.login);
  if (!canWrite(result)) fail(403, 'NO_WRITE_ACCESS', 'Tài khoản không có quyền ghi vào repo này.');
  return result;
}
