import { useEffect, useState } from 'react';
import { Link, NavLink } from 'react-router';
import { api } from '../api/client';
import { relativeTime } from '../format';
import { useApi } from '../hooks';
import { icons } from './Icons';
import type { NotificationList, NotificationSettings } from '../api/types/settings';

/** The bell in the sidebar: unread count, refreshed every minute and when the tab gets focus. */
export function NotificationBell() {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    const load = () => api.get<NotificationList>('/api/notifications?unread=true&limit=1').then((l) => setUnread(l.unread), () => {});
    load();
    const t = setInterval(load, 60_000);
    window.addEventListener('focus', load);
    window.addEventListener('kernel:notifications', load);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', load);
      window.removeEventListener('kernel:notifications', load);
    };
  }, []);
  return (
    <NavLink to="/notifications" className="help-link bell" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
      {icons.bell}Notifications{unread > 0 && <span className="bell-count">{unread > 99 ? '99+' : unread}</span>}
    </NavLink>
  );
}

const EVENT_LABEL: Record<string, string> = {
  assigned: 'Assigned', approval_needed: 'Approval', decision: 'Decision', sla_breach: 'SLA breached', sla_warning: 'SLA at risk', major_incident: 'Major incident', watched_update: 'Update', service_status: 'Service status', automation: 'Automation',
};

export function NotificationsPage() {
  const { data, setData } = useApi<NotificationList>('/api/notifications?limit=100');
  const read = async (body: object) => {
    setData(await api.post<NotificationList>('/api/notifications/read', body));
    window.dispatchEvent(new Event('kernel:notifications'));
  };
  if (!data) return null;
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Notifications</h1>
          <p className="muted">Assignments, approvals waiting for you, SLA warnings and updates on what you watch. Choose what also reaches you by email or chat in <Link to="/settings">Settings</Link>.</p>
        </div>
        {data.unread > 0 && <button className="btn" onClick={() => read({ all: true })}>Mark all as read</button>}
      </header>
      <section className="card flush">
        {data.notifications.length === 0 ? <p className="empty">Nothing yet.</p> : (
          <ul className="notification-list">
            {data.notifications.map((n) => (
              <li key={n.id} className={n.read_at ? '' : 'unread'}>
                <span className={`tag ev-${n.event}`}>{EVENT_LABEL[n.event] ?? n.event}</span>
                <Link to={n.url} onClick={() => !n.read_at && read({ ids: [n.id] })}>
                  <span className="mono small">{n.ref}</span> <strong>{n.title}</strong>
                  <div className="muted small">{n.summary}</div>
                </Link>
                <time className="muted small">{relativeTime(n.created_at)}</time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export function NotificationSettingsCard() {
  const { data, setData } = useApi<NotificationSettings>('/api/notifications/settings');
  const [chat, setChat] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!data) return null;
  const save = async (body: object) => {
    setError(null);
    try {
      setData(await api.put<NotificationSettings>('/api/notifications/settings', body));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section className="card">
      <h2>Notifications</h2>
      <p className="muted small">Everything appears under Notifications in Kernel. Choose what also reaches you outside it.</p>
      {!data.email_configured && <p className="hint-box">Email is not configured on this server (SMTP_URL), so only in-app and chat notifications are sent.</p>}
      {!data.address && <p className="hint-box">Your account has no email address; ask an administrator to add one.</p>}
      <label className="check"><input type="checkbox" checked={data.email} onChange={(e) => save({ email: e.target.checked })} /> Email me{data.address && <span className="muted small"> at {data.address}</span>}</label>
      <label className="check"><input type="checkbox" checked={data.digest} disabled={!data.email} onChange={(e) => save({ digest: e.target.checked })} /> One daily digest at 07:00 instead of separate emails</label>
      <table className="table compact notif-events">
        <thead><tr><th>When</th><th>Email</th><th>Chat</th></tr></thead>
        <tbody>
          {Object.entries(data.events).map(([k, e]) => (
            <tr key={k}>
              <td>{e.label}</td>
              <td><input type="checkbox" aria-label={`Email: ${e.label}`} checked={e.email} disabled={!data.email} onChange={(ev) => save({ events: { [k]: { email: ev.target.checked } } })} /></td>
              <td><input type="checkbox" aria-label={`Chat: ${e.label}`} checked={e.chat} disabled={!data.has_chat} onChange={(ev) => save({ events: { [k]: { chat: ev.target.checked } } })} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="rel-form" onSubmit={(e) => { e.preventDefault(); save({ chat_url: chat, chat_format: data.chat_format }).then(() => setChat('')); }}>
        <input type="url" placeholder={data.has_chat ? 'Chat webhook set – paste a new one to replace it' : 'Personal Slack or Teams workflow webhook (https://…)'} value={chat} onChange={(e) => setChat(e.target.value)} aria-label="Chat webhook" />
        <select value={data.chat_format} onChange={(e) => save({ chat_format: e.target.value })} aria-label="Chat format"><option value="slack">Slack</option><option value="teams_workflow">Teams workflow</option></select>
        <button className="btn" disabled={!chat}>Save</button>
        {data.has_chat && <button type="button" className="btn-link" onClick={() => save({ chat_url: '' })}>Remove</button>}
      </form>
      {error && <div className="error">{error}</div>}
    </section>
  );
}
