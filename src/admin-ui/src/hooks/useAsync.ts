// Standardizes "load on mount + reload after a mutation" with loading/error state, replacing the
// repeated useEffect+useState+try/catch on every page. Guards against setState-after-unmount.
import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data: T | undefined;
  loading: boolean;
  error: unknown;
  reload: () => Promise<void>;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const alive = useRef(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const r = await fnRef.current();
      if (alive.current) setData(r);
    } catch (e) {
      if (alive.current) setError(e);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, loading, error, reload };
}
