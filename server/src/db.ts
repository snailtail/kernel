import { readdir, readFile } from 'node:fs/promises';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import pg from 'pg';
import { config } from './config.js';

// Return DATE columns as 'YYYY-MM-DD' strings instead of local-midnight Date objects.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

/** Connection string for the runtime role, or the owner when no separate role is configured. */
export function runtimeUrl() {
  if (!config.appDbPassword) return config.databaseUrl;
  const u = new URL(config.databaseUrl);
  u.username = encodeURIComponent(config.appDbUser);
  u.password = encodeURIComponent(config.appDbPassword);
  return u.toString();
}

// Connections open lazily, so the role can be created by migrate() before the first query.
export const pool = new pg.Pool({ connectionString: runtimeUrl() });

export async function query<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []) {
  return pool.query<T>(sql, params);
}

const AFTER_COMMIT = Symbol('afterCommit');
type Hooked = { [AFTER_COMMIT]?: (() => void)[] };

/** Runs fn after the surrounding transaction commits (immediately when not in a transaction). */
export function afterCommit(db: unknown, fn: () => void) {
  const hooks = (db as Hooked)[AFTER_COMMIT];
  if (hooks) hooks.push(fn);
  else fn();
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const hooks: (() => void)[] = [];
  (client as Hooked)[AFTER_COMMIT] = hooks;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    delete (client as Hooked)[AFTER_COMMIT];
    for (const hook of hooks) {
      try {
        hook();
      } catch {
        // after-commit work (logging, metrics) must never fail the request
      }
    }
    return result;
  } catch (err) {
    delete (client as Hooked)[AFTER_COMMIT];
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** PostgreSQL SCRAM-SHA-256 password verifier (RFC 5802/7677), as stored in pg_authid. */
export function scramVerifier(password: string, iterations = 4096) {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/**
 * Creates or updates the least-privilege runtime role: data access only, read/insert-only on audit_log, no DDL,
 * no ownership (so it cannot disable the audit triggers). Idempotent; runs after every migration.
 */
export async function ensureAppRole(client: pg.PoolClient | pg.Client, user: string, password: string) {
  const role = client.escapeIdentifier(user);
  await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${client.escapeLiteral(user)}) THEN CREATE ROLE ${role}; END IF; END $$`);
  // A SCRAM verifier, not the password itself, so it never appears in PostgreSQL's statement log.
  await client.query(`ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${client.escapeLiteral(scramVerifier(password))}`);
  await client.query(`DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${role}', current_database()); END $$`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await client.query(`REVOKE CREATE ON SCHEMA public FROM ${role}`);
  await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC'); // default before PostgreSQL 15
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  await client.query(`REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM ${role}`);
  await client.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON schema_migrations FROM ${role}`);
}

/** Applies SQL files in migrations/ that have not been applied yet, in filename order (as the owner). */
export async function migrate(log: (msg: string) => void) {
  const owner = new pg.Client({ connectionString: config.databaseUrl });
  await owner.connect();
  try {
    await migrateWith(owner, log);
    if (config.appDbPassword) await ensureAppRole(owner, config.appDbUser, config.appDbPassword);
  } finally {
    await owner.end();
  }
}

async function migrateWith(client: pg.Client, log: (msg: string) => void) {
  const dir = new URL('../migrations/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  await client.query('BEGIN');
  try {
    // Serialise concurrent starts (several replicas) on the same database.
    await client.query('SELECT pg_advisory_xact_lock(4711)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      log(`Applying migration ${file}`);
      await client.query(await readFile(new URL(file, dir), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

export async function waitForDb(log: (msg: string) => void, attempts = 30) {
  for (let i = 1; ; i++) {
    try {
      const c = new pg.Client({ connectionString: config.databaseUrl });
      await c.connect();
      await c.end();
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      log(`Database not ready (${(err as Error).message}), retrying...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
