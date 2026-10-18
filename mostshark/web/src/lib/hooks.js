import { useCallback, useEffect, useRef, useState } from 'react';

/** Runs an async loader; exposes {data, error, loading, reload}. Ignores stale responses. */
export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const run = useCallback(async () => {
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fn();
      if (id === seq.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (id === seq.current) setState({ data: null, error, loading: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run };
}

export function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const h = setTimeout(() => setV(value), ms); return () => clearTimeout(h); }, [value, ms]);
  return v;
}

/** Unwraps a Supabase response, throwing the error object. */
export function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

/** PostgREST `or`/ilike filters break on , ( ) % * — strip them from user input. */
export function safeTerm(s = '') {
  return s.replace(/[,()%*\\]/g, ' ').trim();
}
