import assert from 'node:assert/strict';
import { test } from 'node:test';
import { htmlToMarkdown, looksLikeLog } from '../src/components/RichPaste';

test('formatted text from mail and wiki pages becomes Markdown, without scripts, styles or remote images', async () => {
  const md = await htmlToMarkdown(
    '<style>p{color:red}</style><h2>Outage</h2><p>Users see <b>timeouts</b> on <a href="https://shop.example">the shop</a>.</p>' +
      '<ul><li>since 10:02</li><li>EU only</li></ul><img src="https://tracker.example/pixel.gif"><script>alert(1)</script>' +
      '<table><tr><th>Host</th><th>CPU</th></tr><tr><td>web01</td><td>98%</td></tr></table><a href="javascript:alert(1)">bad</a>',
  );
  assert.match(md, /^## Outage/m);
  assert.match(md, /\*\*timeouts\*\*/);
  assert.match(md, /\[the shop\]\(https:\/\/shop\.example\)/);
  assert.match(md, /^- since 10:02/m);
  assert.match(md, /\| Host \| CPU \|/);
  assert.doesNotMatch(md, /tracker|alert|color:red|javascript:/);
});

test('log output is recognised, ordinary prose is not', () => {
  assert.ok(looksLikeLog('2026-10-09 10:00:01 INFO start\n2026-10-09 10:00:03 ERROR timeout\n'));
  assert.ok(looksLikeLog('java.lang.NullPointerException: x\n    at com.example.Foo.bar(Foo.java:12)\n    at com.example.Main.main(Main.java:3)'));
  assert.ok(!looksLikeLog('The shop is slow.\nCustomers complain since this morning.'));
  assert.ok(!looksLikeLog('one line only ERROR'));
});
