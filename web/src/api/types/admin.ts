/** /api/admin/backups: whether backups run and the files kept per tier. */
export interface BackupStatus {
  configured: boolean;
  last_success?: string | null;
  last_failure?: string | null;
  healthy?: boolean;
  files?: { tier: string; name: string; size: number; created_at: string }[];
}
