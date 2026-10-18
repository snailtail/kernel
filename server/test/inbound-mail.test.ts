import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MSGRAPH } from '../src/connector-mailbox.js';
import type { RunContext } from '../src/connectors.js';
import { newText, senderVerified } from '../src/inbound-mail.js';

const line = (v: string) => ({ key: 'authentication-results', line: `Authentication-Results: ${v}` });

test('a sender is verified only by the topmost Authentication-Results of the trusted server', () => {
  assert.equal(senderVerified([line('mx.test; dmarc=pass (p=reject) header.from=example.com')], 'anna@example.com', 'mx.test'), true);
  assert.equal(senderVerified([line('mx.test; spf=pass smtp.mailfrom=bounce@mail.example.com')], 'anna@example.com', 'mx.test'), true, 'aligned SPF (subdomain)');
  assert.equal(senderVerified([line('mx.test; dkim=pass header.d=example.com header.s=s1')], 'anna@sub.example.com', 'mx.test'), true, 'aligned DKIM');
  assert.equal(senderVerified([line('mx.test; spf=pass smtp.mailfrom=x@other.org')], 'anna@example.com', 'mx.test'), false, 'SPF for another domain');
  assert.equal(senderVerified([line('mx.test; dmarc=pass header.from=other.org')], 'anna@example.com', 'mx.test'), false, 'DMARC for another From');
  assert.equal(senderVerified([line('mx.test; dmarc=fail header.from=example.com'), line('mx.test; dmarc=pass header.from=example.com')], 'anna@example.com', 'mx.test'), false, 'a lower header the sender added');
  assert.equal(senderVerified([line('mx.evil; dmarc=pass header.from=example.com')], 'anna@example.com', 'mx.test'), false, 'another server');
  assert.equal(senderVerified([line('mx.test; dmarc=pass header.from=example.com')], 'anna@example.com', ''), false, 'nothing trusted');
  assert.equal(senderVerified([line('mx.test 1;\r\n\tdmarc=pass\r\n header.from=example.com')], 'anna@example.com', 'MX.TEST'), true, 'folded, with a version');
  // RFC 8601 §5: the receiving server adds its own header on top and removes forged ones with its authserv-id. Kernel
  // relies on that; a server that does not strip them lets a forged header on top through (docs/inbound-email.md).
  assert.equal(senderVerified([line('mx.test; dmarc=pass header.from=example.com'), line('mx.test; dmarc=fail header.from=example.com')], 'anna@example.com', 'mx.test'), true, 'a forged header on top is believed: the mail server must strip it');
  assert.equal(senderVerified([line('mx.test; dkim=pass header.d=notexample.com')], 'anna@example.com', 'mx.test'), false, 'alignment needs a dot: notexample.com is not example.com');
  assert.equal(senderVerified([line('mx.test; spf=pass smtp.mailfrom=b@example.com')], 'anna@support.example.com', 'mx.test'), true, 'relaxed alignment: the parent domain');
});

test('the quoted message below a reply is cut', () => {
  assert.equal(newText('Works now.\n\nOn Sat, 17 Oct 2026, Kernel <k@x> wrote:\n> old'), 'Works now.');
  assert.equal(newText('Tack!\r\n\r\nDen 17 okt. 2026 skrev Kernel <k@x>:\r\n> gammalt'), 'Tack!');
  assert.equal(newText('Done\n\nFrom: Kernel\nSent: Saturday\nTo: Anna\nSubject: INC1'), 'Done');
  assert.equal(newText('Done\n________________\nFrom: Kernel'), 'Done');
  assert.equal(newText('Answer\n> quoted\n> more'), 'Answer');
  assert.equal(newText('From: the logs it looks like the disk.\nNothing else.'), 'From: the logs it looks like the disk.\nNothing else.', 'a sentence starting with From: stays');
  assert.equal(newText('bell\u0007 and \u0000nul'), 'bell and nul');
});

test('Microsoft Graph: reads unread mail as MIME, marks it read and moves it; a failed delivery stays unread', async () => {
  const calls: string[] = [];
  const respond = (body: unknown, status = 200) => ({ status, ok: status < 300, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const ctx = {
    config: MSGRAPH.config.parse({ tenant_id: 'tenant', mailbox: 'support@example.com', processed_folder: 'Handled' }),
    secret: { client_id: 'app', client_secret: 's3cret' },
    privateAllow: [],
    request: async (url: string, init: { method?: string; body?: string } = {}) => {
      const u = new URL(url);
      calls.push(`${init.method ?? 'GET'} ${decodeURIComponent(u.pathname)}`);
      if (u.hostname === 'login.microsoftonline.com') {
        assert.match(init.body!, /client_secret=s3cret/);
        assert.match(init.body!, /scope=https%3A%2F%2Fgraph.microsoft.com%2F.default/);
        return respond({ access_token: 'tok' });
      }
      const path = decodeURIComponent(u.pathname).replace('/v1.0/users/support@example.com', '');
      if (path === '/mailFolders/inbox') return respond({ id: 'INBOX-ID' });
      if (path === '/mailFolders/Handled') return respond({}, 404);
      if (path === '/mailFolders') return respond({ value: [{ id: 'HANDLED-ID' }] });
      if (path === '/mailFolders/INBOX-ID/messages') {
        assert.equal(u.searchParams.get('$filter'), 'isRead eq false');
        return respond({ value: [{ id: 'm1' }, { id: 'm2' }] });
      }
      if (path.endsWith('/$value')) return respond(`Message-ID: <${path.split('/')[2]}@x>\r\nSubject: Hi\r\n\r\nBody`);
      if (init.method === 'PATCH') {
        assert.equal(init.body, '{"isRead":true}');
        return respond({});
      }
      if (path.endsWith('/move')) {
        assert.equal(init.body, '{"destinationId":"HANDLED-ID"}');
        return respond({});
      }
      return respond({}, 404);
    },
  } as unknown as RunContext;
  const delivered: string[] = [];
  const result = await MSGRAPH.receive!(ctx, async (raw) => {
    const text = raw.toString();
    if (text.includes('<m2@x>')) throw new Error('database down');
    delivered.push(text.split('\r\n')[0]);
  });
  assert.deepEqual(delivered, ['Message-ID: <m1@x>']);
  assert.deepEqual(result.warnings, ['Message m2: database down']);
  assert.ok(calls.includes('PATCH /v1.0/users/support@example.com/messages/m1'));
  assert.ok(calls.includes('POST /v1.0/users/support@example.com/messages/m1/move'));
  assert.ok(!calls.some((c) => c.includes('/messages/m2') && !c.endsWith('$value')), 'm2 is left unread for the next run');
});
