import { ShowcaseClient } from './client.js';
import { SavedConnection, TokenStore } from './connection.js';
import { config } from './config.js';
const $ = selector => document.querySelector(selector);
const tokenStore = new TokenStore({ key: `showcase-token:${config.owner}/${config.repo}:${config.branch}` });
const client = new SavedConnection(new ShowcaseClient(), tokenStore, () => resetConnection('Token không hợp lệ hoặc đã hết hạn. Vui lòng kết nối lại.'));
let me = null, projects = [], deleting = null, pending = [], polling = false;
let connectionVersion = 0, pollTimer = null, restoring = false;
function notice(text) { $('#notice').textContent = text; $('#notice').hidden = !text; }
function element(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
function showConnect() { if (restoring) return; $('#connect-error').textContent = ''; $('#connect-dialog').showModal(); }
function resetConnection(message = '') {
  connectionVersion++; clearTimeout(pollTimer); polling = false;
  me = null; projects = []; pending = []; deleting = null;
  $('#welcome').hidden = false; $('#open-upload').disabled = true;
  $('#upload-dialog').close(); $('#delete-dialog').close();
  $('#empty h3').textContent = 'Không gian cho ý tưởng đầu tiên';
  $('#empty p').textContent = 'Kết nối GitHub để xem và quản lý giao diện của bạn.';
  const button = element('button', 'button small secondary', 'Kết nối GitHub ↗'); button.type = 'button'; button.addEventListener('click', showConnect);
  $('#account').replaceChildren(button); render(); renderJobs(); notice(message);
}
async function copy(text, button) {
  try { await navigator.clipboard.writeText(text); const previous = button.textContent; button.textContent = 'Đã copy ✓'; setTimeout(() => { button.textContent = previous; }, 1800); }
  catch { notice('Không truy cập được clipboard. Bạn có thể mở giao diện và sao chép URL trên trình duyệt.'); }
}
function viewerUrl(slug) { return new URL(`viewer/?slug=${encodeURIComponent(slug)}`, me.previewBase).href; }
function render() {
  const query = $('#search').value.trim().toLocaleLowerCase('vi');
  const visible = projects.filter(p => `${p.name} ${p.slug}`.toLocaleLowerCase('vi').includes(query));
  $('#nav-count').textContent = projects.length; $('#total-count').textContent = projects.length;
  $('#projects').replaceChildren(); $('#empty').hidden = visible.length > 0;
  if (me) {
    $('#empty h3').textContent = query ? 'Chưa tìm thấy giao diện' : 'Không gian cho ý tưởng đầu tiên';
    $('#empty p').textContent = query ? 'Thử tìm bằng tên hoặc đường dẫn khác.' : 'Nhấn “Đăng giao diện” để thêm HTML hoặc ZIP của bạn.';
  }
  for (const project of visible) {
    const card = element('article', 'project-card'), art = element('div', 'project-art');
    art.append(element('span', '', '</>'), element('small', '', 'HTML / CSS / JS'));
    const body = element('div', 'project-body'), title = element('h3', '', project.name); title.title = project.name;
    body.append(title, element('p', 'project-path', `/${project.slug}/`));
    const actions = element('div', 'card-actions'), open = element('a', '', 'Xem giao diện ↗'); open.href = viewerUrl(project.slug); open.target = '_blank'; open.rel = 'noopener noreferrer';
    const copyButton = element('button', '', 'Copy link'); copyButton.type = 'button'; copyButton.addEventListener('click', () => copy(project.previewUrl, copyButton));
    const remove = element('button', 'delete', 'Xóa'); remove.type = 'button'; remove.disabled = !me.canPublish; remove.addEventListener('click', () => openDelete(project));
    actions.append(open, copyButton, remove); body.append(actions);
    const date = new Date(project.createdAt); body.append(element('div', 'card-date', Number.isNaN(date.getTime()) ? `Đăng bởi @${me.user.login}` : `Đã đăng ${date.toLocaleDateString('vi-VN')}`));
    card.append(art, body); $('#projects').append(card);
  }
}
async function refreshProjects() { const version = connectionVersion, loaded = await client.catalog(); if (!me || version !== connectionVersion) return; projects = loaded; render(); }
function savePending() { if (!me) return; try { sessionStorage.setItem(`showcase-jobs-${me.user.id}`, JSON.stringify(pending)); } catch { /* Progress remains available until this tab is closed. */ } }
function renderJobs() {
  $('#jobs').replaceChildren();
  const labels = { saved: 'Đã lưu thay đổi vào GitHub', queued: 'Đang chờ xuất bản', deploying: 'Đang xuất bản', ready: 'Đã hoàn tất', failed: 'Xuất bản chưa hoàn tất' };
  for (const job of pending) {
    const box = element('article', 'job'); box.dataset.state = job.state;
    box.append(element('strong', '', `${job.operation === 'delete' ? 'Xóa' : 'Đăng'} /${job.slug}/ — ${labels[job.state] || labels.queued}`));
    const text = job.state === 'ready' ? (job.operation === 'delete' ? 'Source đã xóa và bản xuất bản mới đã gỡ giao diện.' : 'Giao diện đã sẵn sàng để chia sẻ.') : job.error || (job.operation === 'delete' ? 'Source đã xóa khỏi phiên bản hiện tại. Đang chờ gỡ giao diện trên website.' : 'Source đã lưu. Link chỉ sẵn sàng khi quá trình xuất bản hoàn tất.');
    box.append(element('p', '', text)); const actions = element('div', 'job-actions');
    if (job.state === 'ready' && job.operation === 'publish') { const link = element('a', '', 'Mở giao diện ↗'); link.href = viewerUrl(job.slug); link.target = '_blank'; link.rel = 'noopener noreferrer'; actions.append(link); }
    const check = element('button', '', 'Kiểm tra lại'); check.type = 'button'; check.addEventListener('click', () => checkJob(job).then(renderJobs));
    const dismiss = element('button', '', 'Ẩn thông báo'); dismiss.type = 'button'; dismiss.addEventListener('click', () => { pending = pending.filter(p => p !== job); savePending(); renderJobs(); });
    actions.append(check, dismiss); box.append(actions); $('#jobs').append(box);
  }
}
async function checkJob(job) {
  const version = connectionVersion;
  try { const result = await client.status(job); if (version !== connectionVersion) return; Object.assign(job, result); if (job.state === 'ready') await refreshProjects(); }
  catch (error) { if (version !== connectionVersion) return; job.error = error.message; }
  savePending();
}
async function poll() {
  if (polling || !me) return; polling = true;
  const version = connectionVersion;
  try {
    const active = pending.filter(j => !['ready', 'failed'].includes(j.state));
    for (const job of active) { if (version !== connectionVersion || !me) break; await checkJob(job); }
    if (version === connectionVersion) renderJobs();
  } finally { if (version === connectionVersion) polling = false; }
  if (me && version === connectionVersion && pending.some(j => !['ready', 'failed'].includes(j.state))) pollTimer = setTimeout(poll, 12000);
}
function addJob(result) {
  pending = pending.filter(p => p.slug !== result.slug); pending.unshift(result); savePending(); renderJobs(); poll();
}
function openDelete(project) {
  deleting = project; $('#delete-form').reset(); $('#delete-error').textContent = ''; $('#delete-button').disabled = true;
  $('#delete-description').textContent = `Bạn đang xóa “${project.name}” tại /${project.slug}/. Giao diện khác sẽ được giữ nguyên.`;
  $('#delete-confirm').placeholder = project.slug; $('#delete-dialog').showModal();
}
$('#delete-confirm').addEventListener('input', () => { $('#delete-button').disabled = $('#delete-confirm').value !== deleting?.slug; });
$('#delete-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!deleting || $('#delete-confirm').value !== deleting.slug) return;
  $('#delete-button').disabled = true; $('#delete-error').textContent = '';
  try { const result = await client.delete(deleting.slug); $('#delete-dialog').close(); addJob(result); await refreshProjects(); }
  catch (error) { $('#delete-error').textContent = error.message; }
  finally { $('#delete-button').disabled = $('#delete-confirm').value !== deleting?.slug; }
});
$('#open-upload').addEventListener('click', () => { $('#upload-error').textContent = ''; $('#upload-dialog').showModal(); });
for (const close of document.querySelectorAll('[data-close]')) close.addEventListener('click', () => close.closest('dialog').close());
const fileInput = $('#file');
function fileInfo() { const file = fileInput.files[0]; $('#file-info').textContent = file ? `${file.name} · ${(file.size / 1024).toFixed(1)} KiB` : 'ZIP cần có index.html ở thư mục gốc.'; }
fileInput.addEventListener('change', fileInfo);
const drop = $('#dropzone');
drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('dragging'); });
drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
drop.addEventListener('drop', event => { event.preventDefault(); drop.classList.remove('dragging'); if (event.dataTransfer.files.length !== 1) { $('#upload-error').textContent = 'Mỗi lần chọn một HTML hoặc ZIP.'; return; } fileInput.files = event.dataTransfer.files; fileInfo(); });
$('#upload-form [name=slug]').addEventListener('input', event => { $('#url-preview').textContent = me ? new URL(`${encodeURIComponent(event.target.value)}/`, me.previewBase).href : ''; });
$('#upload-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#upload-error').textContent = ''; const file = fileInput.files[0];
  if (!file || file.size > 2 * 1024 * 1024 || !/\.(html?|zip)$/i.test(file.name)) { $('#upload-error').textContent = 'Chọn HTML hoặc ZIP không quá 2 MiB.'; return; }
  $('#publish-button').disabled = true; $('#publish-button').textContent = 'Đang kiểm tra và lưu…';
  try {
    const fields = new FormData(event.currentTarget);
    const result = await client.publish({ name: fields.get('name'), slug: fields.get('slug'), file });
    $('#upload-dialog').close(); $('#upload-form').reset(); fileInfo(); addJob(result); await refreshProjects();
  } catch (error) { $('#upload-error').textContent = error.message; }
  finally { $('#publish-button').disabled = false; $('#publish-button').textContent = 'Xuất bản giao diện ↗'; }
});
$('#search').addEventListener('input', render);
async function connected(account) {
  try {
    connectionVersion++;
    me = account; $('#welcome').hidden = true; $('#open-upload').disabled = !me.canPublish; notice('');
    $('#account').replaceChildren(element('span', 'avatar', me.user.login.slice(0, 1).toUpperCase()), element('span', 'account-name', '@' + me.user.login));
    const logout = element('button', 'button secondary small', 'Ngắt kết nối'); logout.addEventListener('click', () => { const cleared = client.disconnect(); $('#remember-token').checked = false; resetConnection(cleared ? '' : 'Trình duyệt chặn truy cập bộ nhớ. Hãy xóa dữ liệu trang nếu bạn đã từng ghi nhớ token trên thiết bị này.'); }); $('#account').append(logout);
    if (!me.canPublish) notice('Tài khoản hiện không có quyền ghi repo. Bạn có thể xem danh sách của mình; chức năng đăng và xóa đang bị khóa.');
    try { const saved = JSON.parse(sessionStorage.getItem(`showcase-jobs-${me.user.id}`) || '[]'); pending = Array.isArray(saved) ? saved.filter(j => /^[a-f0-9]{40}$/.test(j.commitSha) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(j.slug) && j.slug.length <= 64 && ['publish', 'delete'].includes(j.operation)) : []; } catch { pending = []; }
    await refreshProjects(); renderJobs(); poll();
  } catch (error) { notice(error.message); }
}
for (const button of document.querySelectorAll('[data-connect]')) button.addEventListener('click', showConnect);
$('#connect-form').addEventListener('submit', async event => {
  event.preventDefault(); const input = $('#github-token'); let token = input.value.trim(); input.value = '';
  $('#connect-button').disabled = true; $('#connect-error').textContent = '';
  try {
    const result = await client.connect(token, $('#remember-token').checked); token = ''; $('#connect-dialog').close(); await connected(result.account);
    if (!result.stored && me) notice([$('#notice').textContent, 'Trình duyệt không cho phép lưu kết nối. Bạn vẫn có thể dùng trong trang hiện tại; tải lại trang sẽ cần nhập token.'].filter(Boolean).join(' '));
  }
  catch (error) { $('#connect-error').textContent = error.message; }
  finally { token = ''; $('#connect-button').disabled = false; }
});
$('#connect-dialog').addEventListener('close', () => { $('#github-token').value = ''; });
render();
async function restoreConnection() {
  restoring = true; for (const button of document.querySelectorAll('[data-connect]')) button.disabled = true;
  try {
    const result = await client.restore();
    if (result) { $('#remember-token').checked = result.remember; await connected(result.account); }
  } catch (error) {
    notice(error.status === 401 ? 'Token đã hết hạn hoặc bị thu hồi. Vui lòng kết nối lại.' : `Chưa khôi phục được kết nối: ${error.message} Token đã lưu được giữ lại; bạn có thể tải lại trang để thử lại.`);
  } finally { restoring = false; for (const button of document.querySelectorAll('[data-connect]')) button.disabled = false; }
}
restoreConnection();
