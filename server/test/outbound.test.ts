import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { blockedReason, checkedLookup, checkUrl, outboundFetch, OutboundBlockedError } from '../src/outbound.js';

test('blocks loopback, link-local, metadata and private addresses', () => {
  delete process.env.KERNEL_OUTBOUND_ALLOW;
  for (const ip of ['127.0.0.1', '169.254.169.254', '::1', 'fd00:ec2::254', '0.0.0.0', '::ffff:127.0.0.1', 'fe80::1']) {
    assert.match(blockedReason(ip) ?? '', /loopback|link-local|metadata|reserved/, ip);
  }
  for (const ip of ['10.1.2.3', '192.168.1.229', '172.20.0.1', 'fd12::1']) assert.match(blockedReason(ip) ?? '', /private/, ip);
  assert.equal(blockedReason('140.82.112.3'), null);
});

test('allowlist opens specific private ranges', () => {
  process.env.KERNEL_OUTBOUND_ALLOW = '192.168.1.0/24, 127.0.0.1';
  assert.equal(blockedReason('192.168.1.50'), null);
  assert.equal(blockedReason('127.0.0.1'), null);
  assert.match(blockedReason('192.168.2.1') ?? '', /private/);
  assert.match(blockedReason('169.254.169.254') ?? '', /metadata/);
  delete process.env.KERNEL_OUTBOUND_ALLOW;
});

test('rejects bad URLs up front', () => {
  assert.equal(checkUrl('ftp://example.com'), 'Only http(s) URLs are allowed');
  assert.match(checkUrl('http://localhost:8080/x') ?? '', /internal/);
  assert.match(checkUrl('https://user:pw@example.com') ?? '', /Credentials/);
  assert.match(checkUrl('http://[::1]/') ?? '', /loopback/);
  assert.equal(checkUrl('https://hooks.slack.com/services/x'), null);
});

test('blocks hosts that resolve to blocked addresses, and redirects into them', async () => {
  delete process.env.KERNEL_OUTBOUND_ALLOW;
  // A host name resolving to loopback is rejected at lookup time, i.e. for the address actually connected to.
  const err = await new Promise<Error | null>((resolve) => checkedLookup('localhost', {}, (e) => resolve(e)));
  assert.ok(err instanceof OutboundBlockedError);

  const server = createServer((req, res) => {
    if (req.url === '/redirect') res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' }).end();
    else res.writeHead(200).end('x'.repeat(5000));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.KERNEL_OUTBOUND_ALLOW = '127.0.0.1';
  try {
    const ok = await outboundFetch(`${base}/`, { maxBytes: 1000 });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.length <= 1000, 'body is capped');
    await assert.rejects(outboundFetch(`${base}/redirect`), OutboundBlockedError);
  } finally {
    server.close();
    delete process.env.KERNEL_OUTBOUND_ALLOW;
  }
});
