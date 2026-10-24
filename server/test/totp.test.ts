import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base32Decode, base32Encode, codeAt, verifyCode } from '../src/security/totp.js';

test('matches the RFC 6238 SHA-1 test vectors', () => {
  // Secret "12345678901234567890" (ASCII); RFC 6238 appendix B, truncated to 6 digits.
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(codeAt(secret, Math.floor(59 / 30)), '287082');
  assert.equal(codeAt(secret, Math.floor(1111111109 / 30)), '081804');
  assert.equal(codeAt(secret, Math.floor(1234567890 / 30)), '005924');
  assert.equal(codeAt(secret, Math.floor(2000000000 / 30)), '279037');
});

test('base32 round-trips and verification allows one step of drift', () => {
  const secret = base32Encode(Buffer.from('any secret bytes here'));
  assert.equal(base32Decode(secret).toString(), 'any secret bytes here');
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 30_000);
  assert.equal(verifyCode(secret, codeAt(secret, step), now), step);
  assert.equal(verifyCode(secret, codeAt(secret, step - 1), now), step - 1);
  assert.equal(verifyCode(secret, codeAt(secret, step - 3), now), null);
  assert.equal(verifyCode(secret, '12345', now), null);
});
