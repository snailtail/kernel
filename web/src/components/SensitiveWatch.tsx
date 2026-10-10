import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { api } from '../api';

// Sensitive data (#61): a warning while typing or pasting ("this looks like a password – Kernel will redact it"), and
// a notice after saving when the server did redact something. The check runs on the server's scanner, debounced, so
// web and server never disagree about what counts.

const LABEL: Record<string, string> = {
  'private-key': 'a private key', 'aws-key': 'an AWS access key', 'aws-secret': 'an AWS secret key', 'azure-key': 'an Azure key',
  'azure-sas': 'an Azure SAS signature', 'gcp-key': 'a Google API key', 'github-token': 'a GitHub token', 'slack-token': 'a Slack token',
  'slack-webhook': 'a Slack webhook URL', 'kernel-token': 'a Kernel API token', jwt: 'a JWT', 'bearer-token': 'a bearer token',
  'url-password': 'a password in a URL', password: 'a password', 'card-number': 'a card number',
  'personal-identity-number': 'a personal identity number', email: 'an email address', 'ip-address': 'an IP address',
};
const list = (types: string[]) => {
  const words = types.map((t) => LABEL[t] ?? t);
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0];
};
const first = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Pages where text is not record content (settings, administration with credentials Kernel stores encrypted).
const QUIET = /^\/(settings|admin|setup|security)/;

export function SensitiveWatch() {
  const location = useLocation();
  const [notice, setNotice] = useState<{ tone: 'warn' | 'info'; text: string } | null>(null);
  const timers = useRef(new WeakMap<EventTarget, number>());

  useEffect(() => {
    if (QUIET.test(location.pathname)) return;
    const check = async (el: HTMLTextAreaElement | HTMLInputElement) => {
      const text = el.value;
      if (text.length < 8) return;
      try {
        const r = await api.post<{ secrets: string[]; personal: string[]; action: 'redact' | 'block' }>('/api/sensitive/check', { text });
        if (r.secrets.length) {
          setNotice({ tone: 'warn', text: r.action === 'block'
            ? `${first(list(r.secrets))}? Kernel does not accept secrets in records – remove ${r.secrets.length > 1 ? 'them' : 'it'} before saving.`
            : `This looks like ${list(r.secrets)}. Kernel will replace ${r.secrets.length > 1 ? 'them' : 'it'} with [REDACTED] when you save.` });
        } else if (r.personal.length) {
          setNotice({ tone: 'info', text: `Contains ${list(r.personal)}. That's fine when it's needed; the record will be marked as holding personal data.` });
        }
      } catch {
        // the warning is a convenience; saving still applies the policy
      }
    };
    const onInput = (e: Event) => {
      const el = e.target as HTMLElement;
      const field = el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && (el.type === 'text' || el.type === 'url')) ? el : null;
      if (!field || field.closest('[data-no-scan]')) return;
      const prev = timers.current.get(field);
      if (prev) clearTimeout(prev);
      timers.current.set(field, window.setTimeout(() => check(field), e.type === 'paste' ? 50 : 800));
    };
    document.addEventListener('input', onInput);
    document.addEventListener('paste', onInput);
    return () => {
      document.removeEventListener('input', onInput);
      document.removeEventListener('paste', onInput);
    };
  }, [location.pathname]);

  useEffect(() => {
    const onRedacted = (e: Event) => {
      const types = (e as CustomEvent<string[]>).detail;
      setNotice({ tone: 'info', text: `Saved. Kernel removed ${list(types)} and stored [REDACTED] instead.` });
    };
    window.addEventListener('kernel:redacted', onRedacted);
    return () => window.removeEventListener('kernel:redacted', onRedacted);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 12_000);
    return () => clearTimeout(t);
  }, [notice]);

  if (!notice) return null;
  return (
    <div className={`sensitive-notice ${notice.tone}`} role="status" aria-live="polite">
      <span>{notice.text}</span>
      <button className="btn-link small" onClick={() => setNotice(null)} aria-label="Dismiss">Dismiss</button>
    </div>
  );
}
