import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../core/config.js';

const TIERS = ['daily', 'weekly', 'monthly'] as const;
const STALE_HOURS = 36;

async function readStamp(file: string) {
  try {
    return (await readFile(file, 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

/** Reports what the backup service has written, so a broken backup is visible in the UI. */
export async function backupStatus() {
  const dir = config.backupDir;
  if (!dir) return { configured: false as const };
  const [lastSuccess, lastFailure] = await Promise.all([readStamp(join(dir, 'last-success')), readStamp(join(dir, 'last-failure'))]);
  const files: { tier: string; name: string; size: number; created_at: string }[] = [];
  for (const tier of TIERS) {
    const names = await readdir(join(dir, tier)).catch(() => [] as string[]);
    for (const name of names.filter((n) => n.endsWith('.dump'))) {
      const s = await stat(join(dir, tier, name));
      files.push({ tier, name, size: s.size, created_at: s.mtime.toISOString() });
    }
  }
  files.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const ageHours = lastSuccess ? (Date.now() - Date.parse(lastSuccess)) / 3_600_000 : null;
  const failedSinceSuccess = !!lastFailure && (!lastSuccess || lastFailure > lastSuccess);
  return {
    configured: true as const,
    last_success: lastSuccess,
    last_failure: lastFailure,
    healthy: ageHours !== null && ageHours < STALE_HOURS && !failedSinceSuccess,
    files,
  };
}
