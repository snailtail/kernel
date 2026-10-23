import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { redact, redactForModel, scan, validPersonnummer } from '../src/scanner.js';

const types = (t: string) => scan(t).map((f) => f.type);

describe('sensitive-data scanner (#61)', () => {
  const positives: [string, string][] = [
    ['aws-key', 'key AKIAIOSFODNN7EXAMPLE in the log'],
    ['aws-secret', 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
    ['azure-key', 'DefaultEndpointsProtocol=https;AccountName=x;AccountKey=Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4==;EndpointSuffix=core.windows.net'],
    ['azure-sas', 'https://x.blob.core.windows.net/c?sv=2022-11-02&sig=abcdEFGH1234%2Bijkl5678mnop'],
    ['gcp-key', 'AIzaSyA1234567890abcdefghijklmnopqrstuv'],
    ['github-token', 'ghp_' + 'a'.repeat(36)],
    ['github-token', 'github_pat_' + 'A1_'.repeat(10)],
    ['slack-token', 'xoxb-1234567890-abcdefghij'],
    ['slack-webhook', 'https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX'],
    ['kernel-token', 'kernel_pat_' + 'x'.repeat(43)],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['bearer-token', 'Authorization: Bearer abcdef0123456789abcdef'],
    ['bearer-token', 'authorization: bearer abcdef0123456789abcdef'],
    ['ai-key', 'Incorrect API key provided: sk-proj-AbCdEf0123456789XyZ0123'],
    ['ai-key', 'x-api-key: sk-ant-api03-AbCdEf0123456789XyZ0123'],
    ['password', 'Server=db;Password=MyPassword;Database=x'],
    ['url-password', 'postgres://kernel:s3cr3t-pw@db:5432/kernel'],
    ['password', 'password=hunter2'],
    ['password', 'Server=db;User Id=sa;Password=Pa55word;'],
    ['password', 'client_secret: "abc def"'],
    ['password', 'pwd: Summer2024!'],
    ['password', 'Back-off restarting failed container app (token=S3cr3t-DbPassw0rd!)'],
    ['password', 'auth_token: 9f8e7d6c5b4a'],
    ['password', 'refresh-token="abc"'],
    ['card-number', 'card 4111 1111 1111 1111 expired'],
    ['personal-identity-number', 'caller 19811218-9876'],
    ['personal-identity-number', 'samordningsnr 701063-2391'],
    ['email', 'mail anna.svensson@example.com'],
  ];
  for (const [type, text] of positives) test(`finds ${type}: ${text.slice(0, 40)}`, () => assert.ok(types(text).includes(type), JSON.stringify(scan(text))));

  test('finds a PEM private key, even unterminated', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----';
    assert.deepEqual(redact(`a ${pem} b`).text, 'a [REDACTED:private-key] b');
    assert.ok(redact('-----BEGIN PRIVATE KEY-----\nMIIE').text.startsWith('[REDACTED:private-key]'));
    assert.deepEqual(types('-----BEGIN CERTIFICATE-----\nMII\n-----END CERTIFICATE-----'), [], 'certificates are public');
  });

  const negatives = [
    'password: reset by the user',
    'password: reset done',
    'token=expired, retrying',
    'secret: none configured',
    'password = changed yesterday',
    'api_key=missing in request',
    'skip-this-step-because-it-is-long-enough',
    'the secret is to restart it',
    'order 4111 1111 1111 1112',
    'ticket 1234567890 and 811218-9875',
    'serial 19811318-9876',
    'version 2.4.10.1',
    'eyJ alone is not a token',
    'Bearer of bad news',
    'https://example.com/path?sig=short',
    'a timestamp 1700000000000',
  ];
  for (const text of negatives) test(`leaves alone: ${text}`, () => assert.deepEqual(types(text), [], JSON.stringify(scan(text))));

  test('personal identity numbers need a real date and checksum', () => {
    assert.equal(validPersonnummer('811218-9876'), true);
    assert.equal(validPersonnummer('811218-9875'), false);
    assert.equal(validPersonnummer('811318-9876'), false);
    assert.equal(validPersonnummer('701063-2391'), true, 'coordination number: day + 60');
  });

  test('redaction keeps the label and replaces only the secret', () => {
    assert.equal(redact('password=hunter2 and AKIAIOSFODNN7EXAMPLE').text, 'password=[REDACTED:password] and [REDACTED:aws-key]');
    assert.equal(redact('postgres://kernel:s3cr3t@db/x').text, 'postgres://kernel:[REDACTED:url-password]@db/x');
    assert.equal(redact('Authorization: Bearer abcdef0123456789abcdef').text, 'Authorization: Bearer [REDACTED:bearer-token]');
    assert.equal(redact('call 19811218-9876').text, 'call 19811218-9876', 'personal data is flagged, not redacted');
    assert.equal(redactForModel('call 19811218-9876, anna@example.com'), 'call [REDACTED:personal-identity-number], anna@example.com');
  });

  test('IP addresses only when asked for', () => {
    assert.deepEqual(types('host 10.1.2.3'), []);
    assert.deepEqual(scan('host 10.1.2.3', { ips: true }).map((f) => f.type), ['ip-address']);
  });

  test('all of a long text is scanned', () => {
    const text = 'x'.repeat(12 * 1024 * 1024) + ' AKIAIOSFODNN7EXAMPLE';
    assert.equal(redact(text).text.endsWith('[REDACTED:aws-key]'), true);
  });

  test('a finding across a chunk boundary is found once', () => {
    const text = 'x '.repeat(32 * 1024 - 5) + 'AKIAIOSFODNN7EXAMPLE' + ' y'.repeat(100);
    assert.equal(scan(text).filter((f) => f.type === 'aws-key').length, 1);
  });

  test('linear time: 1 MB of adversarial input in under 150 ms each', () => {
    const inputs = [
      'a'.repeat(1 << 20),
      'password='.repeat(120_000),
      '-----BEGIN '.repeat(95_000),
      ('1 '.repeat(10) + '- ').repeat(40_000),
      'eyJ' + 'a'.repeat(1 << 20),
      'x@'.repeat(500_000),
      'Bearer '.repeat(150_000),
      'http://a:'.repeat(110_000),
      '4'.repeat(1 << 20),
      'AKIA1 eyJa. Bearer x password: y 4111-1111 a@b.c '.repeat(22000),
    ];
    for (const input of inputs) {
      const t = process.hrtime.bigint();
      scan(input);
      const ms = Number(process.hrtime.bigint() - t) / 1e6;
      assert.ok(ms < 150, `${input.slice(0, 20)}…: ${ms.toFixed(0)} ms`);
    }
  });
});
