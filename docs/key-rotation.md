# Encryption keys and rotation

Kernel uses one secret key for several things. Each use derives its own key from it with HKDF-SHA-256:

- **Stored secrets**: connector, webhook, event-source and provider credentials, chat URLs, TOTP secrets and the SSO client secret. These use AES-256-GCM.
- **The audit trail's hash chain**: HMAC-SHA-256, so someone with only database access cannot rewrite it.
- **Audit digests of personal data**: keyed, so short values cannot be guessed back.
- **Signed unsubscribe links.**

The key never comes from the database, so a dump or a backup alone reveals nothing.

## Configuration

| Variable | Meaning |
| --- | --- |
| `KERNEL_SECRET_KEY` | A single key with the id `k0`. This is the original setting and still enough on its own. |
| `KERNEL_SECRET_KEYS` | Additional keys as `id:secret` pairs separated by commas, e.g. `k1:…,k2:…`. |
| `KERNEL_SECRET_KEY_ID` | The active key for new data. Default: the last key in `KERNEL_SECRET_KEYS`, otherwise `k0`. |

Every key must be at least 32 random characters, for example from `openssl rand -base64 32`. Kernel refuses to start if the keyring is malformed or the active id is unknown.

All data records which key protects it:

- a stored secret starts with `v2:<id>:`;
- an audit entry has `key_id` and includes the key id in its HMAC;
- a digest reads `hmac-sha256:<id>:…`.

Anything written before key ids existed belongs to `k0`.

## Rotating

1. Generate a new key and add it to `KERNEL_SECRET_KEYS`, for example `k1:<new key>`. Keep every existing key in the keyring.
2. Restart Kernel, for example with `docker compose up -d`. New secrets, audit entries and links now use `k1`. Everything older can still be read with `k0`.
3. Re-encrypt the stored secrets under the new key:

   ```sh
   docker compose exec app node server/dist/rotate-keys.js
   ```

   The command is safe to run while Kernel serves requests. Each value is replaced in its own statement, and only if nobody changed it in the meantime. You can run it again at any time.
   Both steps leave an entry in the audit trail. A change of active key is recorded at start (`keys.active_changed`, from and to), and every re-encryption is recorded with its counts (`keys.secrets_reencrypted`).
4. Check **Security status → Encryption keys**. It shows which keys stored secrets and audit entries use.

## Removing an old key

You can remove a key only when no stored secret uses it, and either:

- no audit entry uses it, or
- you accept that those entries can no longer be verified.

The audit trail is append-only, so entries made with an old key keep needing that key. Normally you therefore **keep old keys in the keyring as verification-only keys**: they are never used for new data. If you remove a key that is still needed, the security status names it and audit verification reports which key is missing.

If you suspect a key has leaked:

1. Rotate as above.
2. Replace the secrets themselves at their sources (connector passwords, webhook secrets, provider API keys). They could have been decrypted with the leaked key.
3. Keep the old key for verifying the audit trail only.
