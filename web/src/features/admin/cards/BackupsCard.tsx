import { formatDate, relativeTime } from '../../../format';
import { useApi } from '../../../hooks';
import type { BackupStatus } from '../../../api/types/admin';

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} kB` : `${(bytes / 1048576).toFixed(1)} MB`;

export function BackupsCard() {
  const { data } = useApi<BackupStatus>('/api/admin/backups');
  if (!data) return null;
  return (
    <section className="card">
      <div className="section-head">
        <h2>Backups</h2>
        {data.configured && <span className={`badge ${data.healthy ? 'status-resolved' : 'major'}`}>{data.healthy ? 'Healthy' : 'Attention'}</span>}
      </div>
      {!data.configured ? (
        <p className="muted">No backup directory configured (KERNEL_BACKUP_DIR).</p>
      ) : (
        <>
          <dl className="kv">
            <dt>Last successful backup</dt>
            <dd>{data.last_success ? `${formatDate(data.last_success)} (${relativeTime(data.last_success)})` : 'Never'}</dd>
            {data.last_failure && (<><dt>Last failure</dt><dd className="warn">{formatDate(data.last_failure)}</dd></>)}
          </dl>
          {data.files && data.files.length > 0 && (
            <table className="table compact">
              <thead><tr><th>Dump</th><th>Retention</th><th>Size</th><th>Created</th></tr></thead>
              <tbody>
                {data.files.map((f) => (
                  <tr key={f.tier + f.name}>
                    <td className="mono">{f.name}</td>
                    <td>{f.tier}</td>
                    <td>{formatSize(f.size)}</td>
                    <td>{formatDate(f.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted small">Restore on the Docker host with <code>scripts/restore.sh</code>; use <code>--verify</code> to test a dump without downtime.</p>
        </>
      )}
    </section>
  );
}
