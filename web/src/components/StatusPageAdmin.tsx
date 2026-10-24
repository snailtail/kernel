import { api } from '../api';
import { useApi } from '../hooks';
import { isManager, useSession } from '../session';
import { askReason } from './Ask';
import type { StatusSettings } from '../api/types/status';

/** Administration: the public page switch, with what it takes to reach it from outside. */
export function StatusPageAdmin() {
  const { user } = useSession();
  const { data, reload } = useApi<{ settings: StatusSettings }>('/api/status');
  if (!isManager(user) || !data) return null;
  const toggle = async () => {
    const reason = await askReason('Public status page', data.settings.public_enabled ? 'The public page will be turned off.' : 'Anyone who can reach /status will see the services and updates you publish.', { confirmLabel: 'Change setting' });
    if (!reason) return;
    await api.put('/api/admin/status-page', { public_enabled: !data.settings.public_enabled, title: data.settings.title, reason });
    reload();
  };
  return (
    <section className="card">
      <h2>Public status page</h2>
      <label className="check"><input type="checkbox" checked={data.settings.public_enabled} onChange={toggle} /> Publish a status page at <span className="mono">/status</span></label>
      <p className="muted small">It shows only services you make public (under a public name) and updates you publish. {data.settings.sign_up ? 'Visitors can sign up for email about public services (they confirm their address first).' : 'With outgoing mail configured, visitors can also sign up for email.'} If Kernel sits behind an access gateway such as Cloudflare Access, add a bypass for <span className="mono">/status</span>, <span className="mono">/status/*</span> and <span className="mono">/api/public/status</span>, or publish it on a separate host name.</p>
    </section>
  );
}
