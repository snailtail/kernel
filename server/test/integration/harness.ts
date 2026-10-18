// Starts Kernel against a throwaway PostgreSQL database for integration tests.
// Requires TEST_DATABASE_URL; the database is wiped on every run.
import type { AddressInfo } from 'node:net';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const skip = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set';

export const PASSWORD = 'correct horse battery';
export const USERS = {
  admin: 'admin',
  pm: 'problem_manager',
  analyst: 'analyst',
  analyst2: 'analyst',
  viewer: 'viewer',
  integration: 'integration',
} as const;

export interface Response<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export class Client {
  cookies = new Map<string, string>();
  get cookie() {
    return this.cookies.size ? [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') : undefined;
  }
  constructor(
    public base: string,
    public token?: string,
  ) {}

  async request<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response<T>> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie, 'X-Kernel-Request': '1' } : {}),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...headers,
      },
      // codeql[js/file-access-to-http] -- test client: fixture files are sent to the local test server on purpose
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [name, ...value] = pair.split('=');
      if (value.join('=')) this.cookies.set(name, value.join('='));
      else this.cookies.delete(name);
    }
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text; // CSV, Markdown…
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  get = <T = any>(path: string) => this.request<T>('GET', path);
  post = <T = any>(path: string, body: unknown = {}) => this.request<T>('POST', path, body);
  patch = <T = any>(path: string, body: unknown) => this.request<T>('PATCH', path, body);
  put = <T = any>(path: string, body: unknown) => this.request<T>('PUT', path, body);
  del = <T = any>(path: string) => this.request<T>('DELETE', path);
}

export interface Harness {
  base: string;
  routes: { method: string; url: string }[];
  login(user: keyof typeof USERS): Promise<Client>;
  tokenFor(user: keyof typeof USERS): Promise<string>;
  close(): Promise<void>;
}

/**
 * The database owner, for the few tests that act as an attacker with schema rights (disabling triggers…). Kernel
 * itself runs as the least-privilege role, as in production, so row-level security applies to it (#53).
 */
export async function ownerQuery(sql: string, params: unknown[] = []) {
  const pg = (await import('pg')).default;
  const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end();
  }
}

export async function startKernel(): Promise<Harness> {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL ??= 'warn';
  process.env.KERNEL_APP_DB_USER ??= 'kernel_app_test';
  process.env.KERNEL_APP_DB_PASSWORD ??= 'app role password for tests only';
  await ownerQuery('DROP SCHEMA IF EXISTS reporting CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const { pool, migrate } = await import('../../src/db.js');
  const { hashPassword } = await import('../../src/auth.js');
  const { buildApp } = await import('../../src/app.js');

  await migrate(() => {});
  const hash = await hashPassword(PASSWORD);
  for (const [username, role] of Object.entries(USERS)) {
    await pool.query('INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, $2, $3, $4)', [
      username,
      username.charAt(0).toUpperCase() + username.slice(1),
      hash,
      role,
    ]);
  }

  const app = await buildApp({ logLevel: 'warn', serveWeb: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const login = async (user: keyof typeof USERS) => {
    const client = new Client(base);
    const res = await client.post('/api/auth/login', { username: user, password: PASSWORD });
    if (res.status !== 200) throw new Error(`login ${user} failed: ${res.status}`);
    return client;
  };

  return {
    base,
    routes: app.kernelRoutes,
    login,
    async tokenFor(user) {
      const client = await login(user);
      return (await client.post('/api/tokens', { name: 'test', scopes: ['read', 'write', 'mcp'] })).body.token;
    },
    async close() {
      await app.close();
      await pool.end();
    },
  };
}
