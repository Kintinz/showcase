import { validateBundle, sandboxDocument } from './package.js';
const frame = document.querySelector('#preview'), message = document.querySelector('#message');
const slug = new URL(location.href).searchParams.get('slug');
const valid = slug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 64 && !['viewer', 'assets', 'previews', 'api', 'catalog', 'projects', 'admin', 'index', '404'].includes(slug);
let bundle;
function info(text) { message.textContent = text; message.hidden = !text; }
function display(file = 'index.html', hash = '') {
  frame.srcdoc = sandboxDocument(bundle, file);
  const url = new URL(location.href); if (file === 'index.html') url.searchParams.delete('file'); else url.searchParams.set('file', file); url.hash = hash;
  history.replaceState(null, '', url); document.querySelector('#open').href = url.href;
}
if (!valid) { info('Đường dẫn giao diện không hợp lệ.'); frame.hidden = true; }
else {
  document.querySelector('#title').textContent = slug; document.title = `${slug} — Showcase`;
  try {
    const response = await fetch(new URL(`../previews/${slug}.json`, location.href), { credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw Error('Không tìm thấy giao diện. Giao diện có thể chưa xuất bản xong hoặc đã bị xóa.');
    bundle = validateBundle(await response.json(), slug); display(new URL(location.href).searchParams.get('file') || 'index.html', location.hash);
  } catch (error) { info(error.message); frame.hidden = true; }
  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow || event.data?.type !== 'showcase:navigate' || typeof event.data.path !== 'string' || !bundle || !Object.hasOwn(bundle.files, event.data.path) || !/\.html?$/i.test(event.data.path)) return;
    display(event.data.path, typeof event.data.hash === 'string' ? event.data.hash : '');
  });
  for (const button of document.querySelectorAll('[data-width]')) button.addEventListener('click', () => { frame.style.width = button.dataset.width; for (const b of document.querySelectorAll('[data-width]')) b.setAttribute('aria-pressed', String(b === button)); });
  document.querySelector('#copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(location.href); info('Đã sao chép link giao diện.'); } catch { info('Hãy sao chép đường dẫn trên thanh địa chỉ.'); } });
  document.querySelector('#fullscreen').addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await frame.requestFullscreen(); } catch { info('Trình duyệt không cho phép toàn màn hình. Bạn có thể mở tab mới.'); } });
}
