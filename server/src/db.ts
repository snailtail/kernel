import { readdir, readFile } from 'node:fs/promises';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import pg from 'pg';
import { config } from './config.js';
import { currentContext } from './context.js';

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

// Connections open lazily, so the role can be created by migrate() before the first query. The raw pool stays in
// this module: every statement goes through query() or tx(), which tell the database who is asking (#53).
const rawPool = new pg.Pool({ connectionString: runtimeUrl() });

/**
 * Row-level security reads kernel.viewer. It is set on a connection whenever the borrower's viewer differs from what
 * that connection last had, so a statement can never run with another request's viewer (and, at ~0.2 ms per round
 * trip, only changes cost one). Code outside this module cannot borrow a connection (test: no raw pool access).
 */
const viewerOf = new WeakMap<pg.PoolClient, string>();
async function borrow() {
  const client = await rawPool.connect();
  const viewer = currentContext().viewer;
  if (viewerOf.get(client) !== viewer) {
    // Parts of the viewer also go into their own settings, which the policies read inline without parsing.
    const [, uid = '', , teams = '', scoped = ''] = viewer.startsWith('u:') ? viewer.split(':') : [];
    await client.query(
      "SELECT set_config('kernel.viewer', $1, false), set_config('kernel.uid', $2, false), set_config('kernel.teams', $3, false), set_config('kernel.scoped', $4, false)",
      [viewer, uid, teams, scoped],
    );
    viewerOf.set(client, viewer);
  }
  return client;
}

export async function query<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []) {
  const client = await borrow();
  try {
    return await client.query<T>(sql, params);
  } finally {
    client.release();
  }
}

/** For code that takes a "db" argument outside a transaction: the same helper, never a raw connection. */
export const pool = {
  query: (sql: string, params?: unknown[]) => query(sql, params),
  end: () => rawPool.end(),
} as unknown as pg.Pool & pg.PoolClient;

const AFTER_COMMIT = Symbol('afterCommit');
const BEFORE_COMMIT = Symbol('beforeCommit');
type Hooked = { [AFTER_COMMIT]?: (() => void)[]; [BEFORE_COMMIT]?: (() => Promise<void>)[] };

/** Runs fn after the surrounding transaction commits (immediately when not in a transaction). */
export function afterCommit(db: unknown, fn: () => void) {
  const hooks = (db as Hooked)[AFTER_COMMIT];
  if (hooks) hooks.push(fn);
  else fn();
}

/**
 * Queues fn to run inside the surrounding transaction just before it commits; false when not in a transaction.
 * Lets short critical sections (the audit chain lock) be taken at the end instead of held through the whole work.
 */
export function beforeCommit(db: unknown, fn: () => Promise<void>): boolean {
  const hooks = (db as Hooked)[BEFORE_COMMIT];
  if (!hooks) return false;
  hooks.push(fn);
  return true;
}

/**
 * Runs fn under a savepoint. When it fails the savepoint is rolled back together with the before- and after-commit
 * work it queued, so a rolled-back audit entry is neither appended nor anchored.
 */
export async function savepoint<T>(db: { query: (sql: string) => Promise<unknown> }, name: string, fn: () => Promise<T>): Promise<T> {
  const hooked = db as Hooked;
  const before = hooked[BEFORE_COMMIT]?.length ?? 0;
  const after = hooked[AFTER_COMMIT]?.length ?? 0;
  await db.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await db.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    await db.query(`ROLLBACK TO SAVEPOINT ${name}`);
    hooked[BEFORE_COMMIT]?.splice(before);
    hooked[AFTER_COMMIT]?.splice(after);
    throw err;
  }
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await borrow();
  const hooks: (() => void)[] = [];
  const pending: (() => Promise<void>)[] = [];
  (client as Hooked)[AFTER_COMMIT] = hooks;
  (client as Hooked)[BEFORE_COMMIT] = pending;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    // In order; a hook may queue more.
    for (let i = 0; i < pending.length; i++) await pending[i]();
    await client.query('COMMIT');
    delete (client as Hooked)[AFTER_COMMIT];
    delete (client as Hooked)[BEFORE_COMMIT];
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
    delete (client as Hooked)[BEFORE_COMMIT];
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
  // Security events are added and read; only retention deletes them (#64).
  await client.query(`REVOKE UPDATE, TRUNCATE ON security_events FROM ${role}`);
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

/**
 * LISTEN on one dedicated connection outside the pool (#70), reconnecting after errors. The handler gets only the
 * notification payload; it must not trust it beyond ids, and reads anything else through query() as usual.
 */
export function listen(channel: string, handler: (payload: string) => void, log: (msg: string) => void = () => {}) {
  let client: pg.Client | null = null;
  let stopped = false;
  let delay = 1000;
  const connect = async () => {
    if (stopped) return;
    const c = new pg.Client({ connectionString: runtimeUrl() });
    c.on('notification', (n) => {
      if (n.channel === channel && n.payload) handler(n.payload);
    });
    c.on('error', (err) => {
      c.end().catch(() => {});
      if (client !== c) return; // a failed connect is retried below
      client = null;
      log(`Live updates: listener connection lost (${err.message}); reconnecting`);
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30_000);
    });
    try {
      await c.connect();
      await c.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
      client = c;
      delay = 1000;
    } catch (err) {
      c.end().catch(() => {});
      if (!stopped) setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30_000);
    }
  };
  void connect();
  return async () => {
    stopped = true;
    await client?.end().catch(() => {});
  };
}

/**
 * A connection as the database owner, for operator scripts that must change what the app role cannot (the audit
 * trail's one-time re-base). Never used while serving requests.
 */
export async function withOwner<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
