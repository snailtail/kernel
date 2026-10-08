import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../src/components/Markdown';

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

test('renders common Markdown', () => {
  const out = html('# Title\n\nSome **bold** and _italic_ with `code`.\n\n- [x] done\n- open\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---');
  assert.match(out, /<h3>Title<\/h3>/);
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<em>italic<\/em>/);
  assert.match(out, /<code>code<\/code>/);
  assert.match(out, /<input type="checkbox"[^>]*checked/);
  assert.match(out, /<td>2<\/td>/);
  assert.match(out, /<hr\/>/);
});

test('only safe links become links', () => {
  assert.match(html('[ok](https://example.com)'), /href="https:\/\/example.com"/);
  assert.match(html('[app](/problems/PRB1)'), /href="\/problems\/PRB1"/);
  for (const bad of ['javascript:alert(1)', '//evil.example/x', '/\\evil.example', 'data:text/html,x', 'JAVASCRIPT:alert(1)']) {
    const out = html(`[click](${bad})`);
    assert.doesNotMatch(out, /<a /, bad);
  }
});

test('raw HTML is shown as text, never rendered', () => {
  const out = html('<img src=x onerror=alert(1)> <script>alert(1)</script>');
  assert.doesNotMatch(out, /<img|<script/);
  assert.match(out, /&lt;script&gt;/);
});
