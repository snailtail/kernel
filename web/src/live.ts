// Live updates (#70): one Server-Sent Events stream per tab, shared by every component that follows something.
// The server sends only "this record changed" (kind and id, filtered by what you may see); components refetch through
// the normal API. Without a stream (proxy, limit, offline) they fall back to refetching every 30 seconds.
import { useEffect, useRef, useState } from 'react';
import { api } from './api';

export interface PresencePerson { name: string; editing: boolean }
interface Sub { topics: string[]; editing: string | null; onChange: () => void; onPresence?: (topic: string, people: PresencePerson[]) => void }

const subs = new Set<Sub>();
let source: EventSource | null = null;
let streamId: string | null = null;
let connected = false;
let signedOut = false;
let pushTimer: number | null = null;
let fallback: number | null = null;
let unseen = 0;
let baseTitle = document.title;

const topicsOf = () => [...new Set([...subs].flatMap((s) => s.topics))].slice(0, 50);
const matches = (s: Sub, kind: string, id: number) => s.topics.includes(`${kind}:${id}`) || s.topics.includes(`${kind}:*`);

/** Tells the server what this tab follows (debounced: navigation changes it in bursts). */
function push() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => {
    pushTimer = null;
    if (!streamId) return;
    const editing = [...subs].map((s) => s.editing).find(Boolean) ?? null;
    api.put(`/api/live/${streamId}`, { topics: topicsOf(), editing }).catch(() => {});
  }, 150);
}

function startFallback() {
  if (fallback) return;
  fallback = window.setInterval(() => { if (!connected && !document.hidden) subs.forEach((s) => s.onChange()); }, 30_000);
}

function connect() {
  if (source || signedOut || typeof EventSource === 'undefined') return startFallback();
  source = new EventSource('/api/live');
  source.addEventListener('hello', (e) => {
    const reconnected = streamId !== null;
    streamId = JSON.parse((e as MessageEvent).data).stream;
    connected = true;
    push();
    // Nothing is replayed after a reconnect: refetch what is on screen instead.
    if (reconnected) subs.forEach((s) => s.onChange());
  });
  source.addEventListener('change', (e) => {
    const { kind, id } = JSON.parse((e as MessageEvent).data);
    let hit = false;
    subs.forEach((s) => { if (matches(s, kind, id)) { hit = true; s.onChange(); } });
    if (hit && document.hidden) {
      unseen++;
      document.title = `(${unseen}) ${baseTitle}`;
    }
  });
  source.addEventListener('presence', (e) => {
    const { topic, people } = JSON.parse((e as MessageEvent).data);
    subs.forEach((s) => { if (s.topics.includes(topic)) s.onPresence?.(topic, people); });
  });
  source.addEventListener('closed', () => {
    signedOut = true;
    source?.close();
    source = null;
  });
  source.onerror = () => {
    connected = false;
    startFallback();
  };
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && unseen) {
    unseen = 0;
    document.title = baseTitle;
  } else if (document.hidden) baseTitle = document.title;
});

/** True while the focus is in a form field: the hint behind "… is editing". */
function useEditing() {
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    const update = () => {
      const el = document.activeElement as HTMLElement | null;
      setEditing(!!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['search', 'checkbox', 'radio'].includes((el as HTMLInputElement).type)) || el.isContentEditable) && !el.closest('.no-presence'));
    };
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', () => setTimeout(update, 0));
    return () => document.removeEventListener('focusin', update);
  }, []);
  return editing;
}

/**
 * Follows records ("problem:12") or lists ("problem:*"): onChange runs (debounced) when one of them changes. For a
 * single record, returns who else has it open.
 */
export function useLive(topics: (string | null | undefined)[], onChange: () => void, options: { presence?: boolean } = {}) {
  const list = topics.filter((t): t is string => !!t);
  const key = list.join(',');
  const callback = useRef(onChange);
  callback.current = onChange;
  const [people, setPeople] = useState<PresencePerson[]>([]);
  const editing = useEditing();
  const record = options.presence ? list.find((t) => !t.endsWith(':*')) ?? null : null;
  const sub = useRef<Sub | null>(null);

  useEffect(() => {
    if (!list.length) return;
    let timer: number | null = null;
    const s: Sub = {
      topics: list,
      editing: null,
      onChange: () => {
        if (timer) clearTimeout(timer);
        timer = window.setTimeout(() => callback.current(), 400);
      },
      onPresence: (topic, p) => { if (topic === record) setPeople(p); },
    };
    sub.current = s;
    subs.add(s);
    connect();
    push();
    return () => {
      subs.delete(s);
      sub.current = null;
      if (timer) clearTimeout(timer);
      setPeople([]);
      push();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!sub.current || !record) return;
    sub.current.editing = editing ? record : null;
    push();
  }, [editing, record]);

  return people;
}
