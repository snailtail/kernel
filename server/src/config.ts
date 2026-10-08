function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const config = {
  port: Number(env('PORT', '8080')),
  host: env('HOST', '0.0.0.0'),
  databaseUrl: env('DATABASE_URL', 'postgres://kernel:kernel@localhost:5432/kernel'),
  // Used only on first start, when the users table is empty.
  adminPassword: process.env.KERNEL_ADMIN_PASSWORD,
  sessionDays: Number(env('KERNEL_SESSION_DAYS', '7')),
  // Sessions unused for this long expire (absolute lifetime is sessionDays).
  sessionIdleHours: Number(env('KERNEL_SESSION_IDLE_HOURS', '12')),
  /**
   * KERNEL_TRUST_PROXY: "true" trusts every proxy hop (only safe when Kernel is unreachable except through the proxy),
   * a number trusts that many hops, or a comma-separated list of proxy addresses/CIDRs (recommended).
   */
  trustProxy: ((v) => (!v || v === 'false' ? false : v === 'true' ? true : /^\d+$/.test(v) ? Number(v) : v.split(',').map((s) => s.trim())))(process.env.KERNEL_TRUST_PROXY) as boolean | number | string[],
  secureCookies: env('KERNEL_SECURE_COOKIES', 'false') === 'true',
  // MCP endpoint shown to users in Settings; defaults to the URL the UI is opened on.
  // Where the backup service writes dumps (mounted read only), used to report backup health.
  backupDir: process.env.KERNEL_BACKUP_DIR || null,
  // Public base URL of the web UI, used for links in webhook payloads.
  publicUrl: process.env.KERNEL_PUBLIC_URL || null,
  mcpUrl: process.env.KERNEL_MCP_URL || null,
  webDist: env('KERNEL_WEB_DIST', new URL('../../web/dist', import.meta.url).pathname),
};
