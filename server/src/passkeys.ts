// Passkeys (WebAuthn, #75) with @simplewebauthn/server: passwordless sign-in, a second factor after the password,
// and step-up confirmation. User verification is required every time, so a passkey proves two factors (something the
// person has, unlocked by something they know or are). The relying party is bound to KERNEL_PUBLIC_URL.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { User } from './auth.js';
import { createSession, currentSessionHash } from './auth.js';
import { audit } from './audit.js';
import { config } from './config.js';
import { query, tx } from './db.js';
import { badRequest, HttpError, notFound, unauthorized } from './errors.js';
import { logger } from './log.js';

type Purpose = 'register' | 'login' | 'second_factor' | 'step_up';

function relyingParty() {
  if (!config.publicUrl) throw new HttpError(503, 'Passkeys need KERNEL_PUBLIC_URL (the address people use for Kernel)');
  const u = new URL(config.publicUrl);
  return { rpID: u.hostname, origin: u.origin };
}

async function saveChallenge(purpose: Purpose, challenge: string, userId: number | null) {
  await query("DELETE FROM webauthn_challenges WHERE expires_at < now()");
  await query('INSERT INTO webauthn_challenges (user_id, purpose, challenge) VALUES ($1, $2, $3)', [userId, purpose, challenge]);
}

/** The challenge named in the response's clientDataJSON, consumed (single use), if it was issued for this purpose. */
async function takeChallenge(purpose: Purpose, response: { response: { clientDataJSON: string } }, userId: number | null) {
  let challenge = '';
  try {
    challenge = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8')).challenge;
  } catch {
    throw badRequest('Not a passkey response');
  }
  const { rows } = await query(
    'DELETE FROM webauthn_challenges WHERE challenge = $1 AND purpose = $2 AND expires_at > now() AND user_id IS NOT DISTINCT FROM $3 RETURNING challenge',
    [challenge, purpose, userId],
  );
  if (!rows[0]) throw unauthorized('This passkey request has expired or was already used. Try again.');
  return rows[0].challenge as string;
}

// ---- Registering a passkey (signed in, after step-up) ----------------------------------------------------------------

export async function registrationOptions(user: User) {
  const { rpID } = relyingParty();
  const { rows } = await query('SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = $1', [user.id]);
  const options = await generateRegistrationOptions({
    rpName: 'Kernel', rpID, userName: user.username, userDisplayName: user.display_name,
    userID: new TextEncoder().encode(`kernel-user-${user.id}`),
    attestationType: 'none',
    excludeCredentials: rows.map((r) => ({ id: r.credential_id, transports: r.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  await saveChallenge('register', options.challenge, user.id);
  return options;
}

export async function register(user: User, response: RegistrationResponseJSON, name: string) {
  const { rpID, origin } = relyingParty();
  const expectedChallenge = await takeChallenge('register', response, user.id);
  let v;
  try {
    v = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
  } catch (err) {
    throw badRequest(`The passkey could not be verified: ${(err as Error).message}`);
  }
  if (!v.verified || !v.registrationInfo) throw badRequest('The passkey could not be verified');
  const { credential, credentialBackedUp } = v.registrationInfo;
  try {
    await tx(async (db) => {
      await db.query(
        'INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports, name, backed_up) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [user.id, credential.id, Buffer.from(credential.publicKey), credential.counter, credential.transports ?? [], name.slice(0, 100) || 'Passkey', credentialBackedUp],
      );
      await audit(db, { entity_type: 'user', entity_ref: `#${user.id}`, action: 'passkey_added', changes: { name, backed_up: credentialBackedUp } });
    });
  } catch (err: any) {
    if (err.code === '23505') throw badRequest('This passkey is already registered');
    throw err;
  }
  return listPasskeys(user);
}

export async function listPasskeys(user: User) {
  const { rows } = await query('SELECT id, name, backed_up, created_at, last_used_at FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at', [user.id]);
  return rows;
}

export async function removePasskey(user: User, id: number) {
  const { rowCount } = await query('DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2', [id, user.id]);
  if (!rowCount) throw notFound('Passkey not found');
  await audit(null, { entity_type: 'user', entity_ref: `#${user.id}`, action: 'passkey_removed', changes: { id } });
  return listPasskeys(user);
}

export async function hasPasskey(userId: number) {
  const { rows } = await query('SELECT 1 FROM webauthn_credentials WHERE user_id = $1 LIMIT 1', [userId]);
  return !!rows[0];
}

// ---- Using a passkey ---------------------------------------------------------------------------------------------

/** Options for sign-in (no user: the passkey names the account) or for a known user's second factor or step-up. */
export async function authenticationOptions(purpose: Exclude<Purpose, 'register'>, userId: number | null) {
  const { rpID } = relyingParty();
  const allow = userId ? (await query('SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = $1', [userId])).rows : [];
  if (userId && !allow.length) throw badRequest('No passkey is registered for this account');
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: allow.map((r) => ({ id: r.credential_id, transports: r.transports })) });
  await saveChallenge(purpose, options.challenge, userId);
  return options;
}

/**
 * Verifies an assertion and returns the user id. The signature counter must grow when the authenticator keeps one:
 * a counter that goes backwards suggests a cloned authenticator, and the passkey is refused.
 */
export async function verifyPasskey(purpose: Exclude<Purpose, 'register'>, response: AuthenticationResponseJSON, userId: number | null) {
  const { rpID, origin } = relyingParty();
  const expectedChallenge = await takeChallenge(purpose, response, userId);
  const { rows } = await query(
    `SELECT c.*, u.active FROM webauthn_credentials c JOIN users u ON u.id = c.user_id WHERE c.credential_id = $1 ${userId ? 'AND c.user_id = $2' : ''}`,
    userId ? [response.id, userId] : [response.id],
  );
  const cred = rows[0];
  if (!cred || !cred.active) throw unauthorized('This passkey is not registered');
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
      credential: { id: cred.credential_id, publicKey: new Uint8Array(cred.public_key), counter: Number(cred.counter), transports: cred.transports },
    });
  } catch (err) {
    const message = (err as Error).message;
    logger.warn({ event: { dataset: 'kernel.security', action: 'passkey.failed' }, err: message }, 'passkey verification failed');
    // The library refuses a counter that did not grow; that is the sign of a copied authenticator.
    if (/counter/i.test(message)) return cloneSuspected(cred);
    throw unauthorized('The passkey could not be verified');
  }
  if (!v.verified) throw unauthorized('The passkey could not be verified');
  const next = v.authenticationInfo.newCounter;
  if (Number(cred.counter) > 0 && next <= Number(cred.counter)) return cloneSuspected(cred);
  await query('UPDATE webauthn_credentials SET counter = $2, last_used_at = now() WHERE id = $1', [cred.id, next]);
  return cred.user_id as number;
}

async function cloneSuspected(cred: { id: number; user_id: number }): Promise<never> {
  await audit(null, { entity_type: 'user', entity_ref: `#${cred.user_id}`, action: 'passkey_clone_suspected', changes: { credential: cred.id } });
  throw unauthorized('This passkey looks copied (its counter went backwards) and was refused. Remove it and add it again.');
}

/** Passwordless sign-in: the passkey (with user verification) is both factors. */
export async function passkeyLogin(req: FastifyRequest, reply: FastifyReply, response: AuthenticationResponseJSON) {
  const userId = await verifyPasskey('login', response, null);
  await createSession(req, reply, userId, 'passkey', true);
  const { rows } = await query('SELECT username FROM users WHERE id = $1', [userId]);
  await audit(null, { entity_type: 'session', entity_ref: `#${userId}`, action: 'login', changes: { method: 'passkey' }, actor: { id: userId, name: rows[0].username } });
  return userId;
}

/** Step-up with a passkey instead of the password. */
export async function passkeyStepUp(req: FastifyRequest, user: User, response: AuthenticationResponseJSON) {
  await verifyPasskey('step_up', response, user.id);
  await query('UPDATE sessions SET reauth_at = now() WHERE token_hash = $1', [currentSessionHash(req)]);
}
