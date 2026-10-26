export function resolveFile(reference, from, files) {
  if (typeof reference !== 'string' || !reference || reference.startsWith('#') || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(reference)) return null;
  let name; try { name = decodeURIComponent(reference.split(/[?#]/)[0]); } catch { return null; }
  if (/[\\\x00-\x1f]/.test(name)) return null;
  const parts = from.split('/').slice(0, -1);
  for (const part of name.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  let path = parts.join('/'); if (reference.split(/[?#]/)[0].endsWith('/')) path = path ? path + '/index.html' : 'index.html';
  return Object.hasOwn(files, path) ? path : null;
}
export function preserveFragment(url, reference) { const hash = reference.indexOf('#'); return hash >= 0 ? url + reference.slice(hash) : url; }

export function validateBundle(bundle, slug) {
  if (bundle?.version !== 1 || bundle.slug !== slug || !bundle.files || typeof bundle.files !== 'object' || Array.isArray(bundle.files) || !Object.hasOwn(bundle.files, 'index.html')) throw Error('Gói giao diện không hợp lệ.');
  const entries = Object.entries(bundle.files), seen = new Set(); let total = 0;
  if (!entries.length || entries.length > 20) throw Error('Gói giao diện vượt giới hạn số file.');
  for (const [name, content] of entries) {
    if (!name || name.length > 240 || /[\\\x00-\x1f\x7f:#?%]/.test(name) || name.startsWith('/') || name.normalize('NFC') !== name || name.split('/').some(p => !p || p.startsWith('.') || p.trim() !== p) || seen.has(name.toLowerCase())) throw Error('Đường dẫn file không hợp lệ.');
    seen.add(name.toLowerCase());
    if (typeof content !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content) || content.length > 2796204 || (total += content.length) > 13981100) throw Error('Nội dung gói giao diện không hợp lệ.');
  }
  return bundle;
}

// Runs exclusively inside an iframe without allow-same-origin. It receives source, never credentials.
function sandboxRuntime(encoded, entry, resolveFile, preserveFragment) {
  const decode = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
  const bundle = JSON.parse(new TextDecoder().decode(decode(encoded))), files = bundle.files;
  const urls = new Map(), building = new Set();
  const types = { html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', txt: 'text/plain' };
  const text = name => new TextDecoder().decode(decode(files[name]));
  const mime = name => types[name.split('.').at(-1).toLowerCase()] || 'application/octet-stream';
  function resource(reference, from) { const name = resolveFile(reference, from, files); return name ? preserveFragment(asset(name), reference) : reference; }
  function css(source, from) {
    return source.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (_, a, b, c) => `url("${resource((a ?? b ?? c).trim(), from).replaceAll('"', '%22')}")`)
      .replace(/(@import\s+)(["'])([^"']+)\2/gi, (_, start, quote, name) => `${start}${quote}${resource(name, from)}${quote}`);
  }
  function javascript(source, from) {
    return source.replace(/(\b(?:import|export)\s+(?:[^;'"\n]*?\s+from\s*)?|\bimport\s*\(\s*)(["'])([^"']+)\2/g, (whole, start, quote, name) => {
      const local = resolveFile(name, from, files); return local ? `${start}${quote}${asset(local)}${quote}` : whole;
    });
  }
  function asset(name) {
    if (urls.has(name)) return urls.get(name);
    if (building.has(name)) throw Error('Gói có import CSS/JS vòng; hãy gộp các file này trước khi upload.');
    building.add(name); const type = mime(name);
    const data = type === 'text/css' ? css(text(name), name) : type === 'text/javascript' ? javascript(text(name), name) : decode(files[name]);
    const url = URL.createObjectURL(new Blob([data], { type })); urls.set(name, url); building.delete(name); return url;
  }
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, options) => {
    const name = typeof input === 'string' ? resolveFile(input, entry, files) : null;
    if (name) return new Response(decode(files[name]), { headers: { 'Content-Type': mime(name) } });
    return nativeFetch(input, options);
  };
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...args) { return nativeOpen.call(this, method, typeof url === 'string' ? resource(url, entry) : url, ...args); };
  function rewrite(node) {
    if (node.nodeType !== 1) return;
    for (const attribute of ['src', 'poster']) {
      if (node.hasAttribute(attribute)) { const before = node.getAttribute(attribute), after = resource(before, entry); if (before !== after) node.setAttribute(attribute, after); }
    }
    if (node.matches('link[href]')) { const before = node.getAttribute('href'), after = resource(before, entry); if (before !== after) node.setAttribute('href', after); }
    if (node.namespaceURI === 'http://www.w3.org/2000/svg' && ['use', 'image', 'feImage'].includes(node.localName)) {
      for (const attribute of ['href', 'xlink:href']) if (node.hasAttribute(attribute)) { const before = node.getAttribute(attribute), after = resource(before, entry); if (before !== after) node.setAttribute(attribute, after); }
    }
    if (node.hasAttribute('srcset') && !node.getAttribute('srcset').includes('data:')) {
      const before = node.getAttribute('srcset'), after = before.split(',').map(part => { const [url, ...descriptor] = part.trim().split(/\s+/); return [resource(url, entry), ...descriptor].join(' '); }).join(', ');
      if (before !== after) node.setAttribute('srcset', after);
    }
    if (node.hasAttribute('style')) { const before = node.getAttribute('style'), after = css(before, entry); if (before !== after) node.setAttribute('style', after); }
  }
  try {
    const doc = new DOMParser().parseFromString(text(entry), 'text/html');
    for (const element of doc.querySelectorAll('base,meta[http-equiv]')) element.remove();
    for (const element of doc.querySelectorAll('*')) rewrite(element);
    for (const style of doc.querySelectorAll('style')) style.textContent = css(style.textContent, entry);
    for (const script of doc.querySelectorAll('script:not([src])')) if (script.type === 'module') script.textContent = javascript(script.textContent, entry);
    document.open(); document.write('<!doctype html>' + doc.documentElement.outerHTML); document.close();
    document.addEventListener('click', event => {
      const link = event.target.closest?.('a[href]'); if (!link) return;
      const reference = link.getAttribute('href'), path = resolveFile(reference, entry, files);
      if (reference.startsWith('#')) { event.preventDefault(); document.getElementById(reference.slice(1))?.scrollIntoView(); return; }
      if (path && /\.html?$/i.test(path)) { event.preventDefault(); parent.postMessage({ type: 'showcase:navigate', path, hash: reference.includes('#') ? reference.slice(reference.indexOf('#')) : '' }, '*'); }
    });
    const observer = new MutationObserver(records => {
      try { for (const record of records) { if (record.type === 'attributes') rewrite(record.target); for (const node of record.addedNodes) { rewrite(node); for (const child of node.querySelectorAll?.('*') || []) rewrite(child); } } }
      catch { /* Initial package errors are reported; dynamic source owns its own runtime errors. */ }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href', 'srcset', 'poster', 'style'] });
  } catch (error) {
    document.open(); document.write('<!doctype html><html lang="vi"><body><p id="error"></p></body></html>'); document.close(); document.querySelector('#error').textContent = error.message;
  }
}

export function sandboxDocument(bundle, entry = 'index.html') {
  if (!Object.hasOwn(bundle.files, entry) || !/\.html?$/i.test(entry)) throw Error('Không tìm thấy trang trong gói giao diện.');
  const bytes = new TextEncoder().encode(JSON.stringify(bundle)); let payload = '';
  for (let i = 0; i < bytes.length; i += 8192) payload += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"></head><body><script>(${sandboxRuntime.toString()})(${JSON.stringify(btoa(payload))},${JSON.stringify(entry)},${resolveFile.toString()},${preserveFragment.toString()});<\/script></body></html>`;
}
