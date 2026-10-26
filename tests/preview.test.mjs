import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFile, preserveFragment, validateBundle, sandboxDocument } from '../viewer/assets/package.js';
const files = { 'index.html': btoa('<h1>Hello</h1>'), 'pages/detail.html': btoa('detail'), 'assets/a.css': btoa('body{}') };
test('package resolver handles nested relative paths without escaping to executable origin', () => {
  assert.equal(resolveFile('../assets/a.css?v=1', 'pages/detail.html', files), 'assets/a.css');
  assert.equal(resolveFile('./detail.html#section', 'pages/index.html', files), 'pages/detail.html');
  assert.equal(resolveFile('./', 'index.html', files), 'index.html');
  assert.equal(resolveFile('../', 'pages/detail.html', files), 'index.html');
  for (const url of ['https://evil.example/a.js', 'javascript:alert(1)', '//evil.example/a', '../../../outside.html']) assert.equal(resolveFile(url, 'index.html', files), null);
});
test('blob resources retain SVG symbol/filter fragment', () => {
  assert.equal(preserveFragment('blob:null/id', 'filters.svg#blur'), 'blob:null/id#blur');
  assert.equal(preserveFragment('blob:null/id', 'icons.svg?v=1#check'), 'blob:null/id#check');
  assert.equal(preserveFragment('blob:null/id', 'photo.png'), 'blob:null/id');
});
test('bundle validation requires known entry and safe file map', () => {
  assert.equal(validateBundle({ version: 1, slug: 'demo', files }, 'demo').slug, 'demo');
  assert.throws(() => validateBundle({ version: 1, slug: 'other', files }, 'demo'));
  assert.throws(() => validateBundle({ version: 1, slug: 'demo', files: { '../escape.html': 'eA==' } }, 'demo'));
});
test('iframe bootstrap embeds only base64 payload, never interpolated uploaded script', () => {
  const source = '<script>parent.document.body.innerHTML="stolen"</script><img src=x onerror=alert(1)>';
  const html = sandboxDocument({ version: 1, slug: 'demo', files: { 'index.html': Buffer.from(source).toString('base64') } });
  assert.ok(!html.includes(source)); assert.ok(!html.includes('stolen')); assert.ok(html.includes('sandboxRuntime'));
});
