const frame = document.querySelector('#preview'), message = document.querySelector('#message');
const slug = new URL(location.href).searchParams.get('slug');
const valid = slug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 64 && !['viewer', 'assets', 'api', 'catalog', 'projects', 'admin', 'index', '404'].includes(slug);
function info(text) { message.textContent = text; message.hidden = !text; }
if (!valid) { info('Đường dẫn giao diện không hợp lệ.'); frame.hidden = true; }
else {
  const url = new URL(`../${slug}/`, location.href); frame.src = url.href;
  document.querySelector('#title').textContent = slug; document.title = `${slug} — Showcase`; document.querySelector('#open').href = url.href;
  for (const button of document.querySelectorAll('[data-width]')) button.addEventListener('click', () => { frame.style.width = button.dataset.width; for (const b of document.querySelectorAll('[data-width]')) b.setAttribute('aria-pressed', String(b === button)); });
  document.querySelector('#copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(url.href); info('Đã sao chép link giao diện.'); } catch { info('Hãy sao chép đường dẫn trên thanh địa chỉ.'); } });
  document.querySelector('#fullscreen').addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await frame.requestFullscreen(); } catch { info('Trình duyệt không cho phép toàn màn hình. Bạn có thể mở tab mới.'); } });
}
