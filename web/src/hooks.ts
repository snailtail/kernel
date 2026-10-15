import { useSearchParams } from 'react-router';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

/** Loads a GET endpoint and exposes the data together with a reload function. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(await api.get<T>(path));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    reload();
  }, [reload]);

  /** Refetch without the loading state, for live updates (#70): the page stays as it is until new data arrives. */
  const refresh = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api.get<T>(path));
    } catch {
      // keep what is shown; the next change or the fallback poll tries again
    }
  }, [path]);

  return { data, setData, error, loading, reload, refresh };
}

/** "+ New" links to a list page with ?new=1 (#102): opens its create form, then drops the parameter. */
export function useOpenOnNew(open: () => void) {
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (params.get('new') !== '1') return;
    open();
    const next = new URLSearchParams(params);
    next.delete('new');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
}

/**
 * The search box of a list page: typing is debounced into ?q= so the list can be shared, and the box follows ?q= when
 * something else changes it (a saved view, #110). It writes nothing until the user types, so it never undoes a view
 * applied while the page loads.
 */
export function useSearchText({ trim = false } = {}) {
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get('q') ?? '';
  const [q, setQ] = useState(fromUrl);
  useEffect(() => setQ(fromUrl), [fromUrl]);
  useEffect(() => {
    const value = trim ? q.trim() : q;
    if (value === fromUrl) return;
    const t = setTimeout(() => setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set('q', value);
      else next.delete('q');
      return next;
    }, { replace: true }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  return [q, setQ] as const;
}
