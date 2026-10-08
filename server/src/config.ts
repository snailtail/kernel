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
  secureCookies: env('KERNEL_SECURE_COOKIES', 'false') === 'true',
  // MCP endpoint shown to users in Settings; defaults to the URL the UI is opened on.
  // Where the backup service writes dumps (mounted read only), used to report backup health.
  backupDir: process.env.KERNEL_BACKUP_DIR || null,
  // Public base URL of the web UI, used for links in webhook payloads.
  publicUrl: process.env.KERNEL_PUBLIC_URL || null,
  mcpUrl: process.env.KERNEL_MCP_URL || null,
  webDist: env('KERNEL_WEB_DIST', new URL('../../web/dist', import.meta.url).pathname),
};
