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
