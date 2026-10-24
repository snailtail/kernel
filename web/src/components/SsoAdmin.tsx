import { useEffect, useState } from 'react';
import { api } from '../api';
import { askReason } from './Ask';
import { useTeams } from './Teams';
import type { SsoSettings } from '../api/types/admin';

/** Administration: OpenID Connect (Entra ID, Google, Keycloak, Authentik, Okta…) and Cloudflare Access (#41). */
export function SsoAdminSection() {
  const teams = useTeams();
  const [data, setData] = useState<{ sso: SsoSettings; cf_access: { enabled: boolean; team_domain: string; audience: string } } | null>(null);
  const [form, setForm] = useState<SsoSettings & { client_secret: string; roles: string; teamsMap: string } | null>(null);
  const [cf, setCf] = useState({ enabled: false, team_domain: '', audience: '' });
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    api.get<NonNullable<typeof data>>('/api/admin/sso').then((d) => {
      setData(d);
      setForm({ ...d.sso, client_secret: '', roles: d.sso.role_map.map((m) => `${m.group} = ${m.role}`).join('\n'), teamsMap: d.sso.team_map.map((m) => `${m.group} = ${m.team_id}`).join('\n') });
      setCf(d.cf_access ?? { enabled: false, team_domain: '', audience: '' });
    }, () => setData(null));
  }, []);
  if (!data || !form) return null;
  const save = async () => {
    const reason = await askReason('Single sign-on', form.enabled ? 'People will sign in with your identity provider; roles come from their groups.' : 'Single sign-on will be off.', { confirmLabel: 'Save' });
    if (!reason) return;
    const pairs = (text: string) => text.split('\n').map((l) => l.split('=').map((x) => x.trim())).filter(([g, v]) => g && v);
    try {
      await api.put('/api/admin/sso', {
        enabled: form.enabled, issuer: form.issuer, client_id: form.client_id, ...(form.client_secret ? { client_secret: form.client_secret } : {}),
        scopes: form.scopes, groups_claim: form.groups_claim, role_map: pairs(form.roles).map(([group, role]) => ({ group, role })),
        team_map: pairs(form.teamsMap).map(([group, team]) => ({ group, team_id: Number(team) || teams.find((t) => t.name === team)?.id })),
        default_role: form.default_role || null, local_login: form.local_login, label: form.label, trust_idp_mfa: form.trust_idp_mfa, mfa_acr_values: form.mfa_acr_values, trust_email_claim: !!form.trust_email_claim, reason,
      });
      setMessage('Saved.');
    } catch (err) {
      setMessage((err as Error).message);
    }
  };
  const saveCf = async () => {
    const reason = await askReason('Cloudflare Access', cf.enabled ? 'People who passed Cloudflare Access are signed in to their Kernel account (matched by e-mail).' : 'Cloudflare Access sign-in will be off.', { confirmLabel: 'Save' });
    if (!reason) return;
    try {
      await api.put('/api/admin/cf-access', { ...cf, reason });
      setMessage('Saved.');
    } catch (err) {
      setMessage((err as Error).message);
    }
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <section className="card">
      <h2>Single sign-on</h2>
      <p className="muted small">OpenID Connect with PKCE. Register Kernel at your provider with the redirect URL <span className="mono">{data.sso.redirect_uri}</span>. Roles come from groups; administrator only when a group is mapped to it.</p>
      <div className="form">
        <label className="check full"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Sign in with OpenID Connect</label>
        <label className="full">Issuer<input value={form.issuer} onChange={set('issuer')} placeholder="https://login.microsoftonline.com/<tenant>/v2.0" /></label>
        <label>Client id<input value={form.client_id} onChange={set('client_id')} /></label>
        <label>Client secret<input type="password" autoComplete="off" value={form.client_secret} onChange={set('client_secret')} placeholder={data.sso.has_secret ? '(unchanged)' : ''} /></label>
        <label>Groups claim<input value={form.groups_claim} onChange={set('groups_claim')} /></label>
        <label>Button text<input value={form.label} onChange={set('label')} /></label>
        <label className="full">Group = role, one per line<textarea rows={3} value={form.roles} onChange={set('roles')} placeholder={'kernel-admins = admin\nkernel-managers = manager\nservicedesk = analyst'} /></label>
        <label className="full">Group = team, one per line<textarea rows={2} value={form.teamsMap} onChange={set('teamsMap')} placeholder={'servicedesk = Service desk'} /></label>
        <label>People in no mapped group<select value={form.default_role ?? ''} onChange={(e) => setForm({ ...form, default_role: e.target.value || null })}><option value="">May not sign in</option><option value="viewer">Viewer</option><option value="analyst">Analyst</option></select></label>
        <label>Password sign-in<select value={form.local_login} onChange={(e) => setForm({ ...form, local_login: e.target.value as 'all' | 'admins' })}><option value="all">Still allowed for everyone</option><option value="admins">Administrators only (break-glass)</option></select></label>
        <label className="check full"><input type="checkbox" checked={!!form.trust_email_claim} onChange={(e) => setForm({ ...form, trust_email_claim: e.target.checked })} /> Trust email addresses the provider does not mark as verified (no email_verified claim)</label>
        {form.trust_email_claim && <p className="warn-box full">The self-service portal signs people in by their email, and new accounts are linked to people by it. Only turn this on if users can never set their own address at the provider. For Microsoft Entra, use a verified email claim or a single-tenant app instead.</p>}
        <label className="check full"><input type="checkbox" checked={form.trust_idp_mfa} onChange={(e) => setForm({ ...form, trust_idp_mfa: e.target.checked })} /> Accept the provider's second factor when the ID token proves it ("mfa" in amr, or one of these acr values); otherwise Kernel asks for its own</label>
        <label className="full">Accepted acr values<input value={(form.mfa_acr_values ?? []).join(', ')} onChange={(e) => setForm({ ...form, mfa_acr_values: e.target.value.split(/[\s,]+/).filter(Boolean) })} placeholder="e.g. urn:okta:loa:2fa:any" /></label>
        <div className="actions full"><button type="button" className="btn primary" onClick={save}>Save</button></div>
      </div>
      <h3>Cloudflare Access</h3>
      <p className="muted small">Behind Cloudflare Access, people are signed in to the Kernel account with the same e-mail, without a second login. Find the audience (AUD) tag on the Access application.</p>
      <div className="form">
        <label className="check full"><input type="checkbox" checked={cf.enabled} onChange={(e) => setCf({ ...cf, enabled: e.target.checked })} /> Sign in with Cloudflare Access</label>
        <label>Team domain<input value={cf.team_domain} onChange={(e) => setCf({ ...cf, team_domain: e.target.value })} placeholder="myteam.cloudflareaccess.com" /></label>
        <label>Audience tag<input value={cf.audience} onChange={(e) => setCf({ ...cf, audience: e.target.value })} /></label>
        <div className="actions full"><button type="button" className="btn primary" onClick={saveCf}>Save</button></div>
      </div>
      {message && <p className="hint-box small">{message}</p>}
    </section>
  );
}
