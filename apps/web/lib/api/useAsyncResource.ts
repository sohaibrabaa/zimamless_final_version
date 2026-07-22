"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./client";

export interface AsyncResource<T> {
  data: T | null;
  loading: boolean;
  /** Localized message from the API's error envelope, or null. */
  error: string | null;
  /** Re-runs the fetch. Fire-and-forget: the hook's state is the result. */
  reload: () => void;
}

/**
 * Fetch-on-mount + manual reload, with a stale-response guard.
 *
 * Every screen needs the same three things — data, a loading flag, an error —
 * driven by an API call that re-runs when its inputs change. Centralizing it
 * means the one unavoidable `react-hooks/set-state-in-effect` suppression
 * lives in a single place with a single explanation instead of once per screen.
 *
 * The suppression is legitimate: fetching from the API *is* synchronization
 * with an external system, which is what effects are for, and there is no
 * derived-during-render alternative for a network call. Same reasoning as
 * lib/session/SessionProvider.tsx.
 *
 * `keys` identify the request (an id, a page number, a filter) and are
 * serialized rather than spread into a dependency array, because React's lint
 * rules require dependency arrays to be literals — a generic hook can't have
 * one. The fetcher itself is held in a ref so callers can define it inline
 * without memoizing.
 *
 * The stale guard matters specifically for the reviewer queue, which refetches
 * on every filter/page change: without it a slow first request can land after
 * a fast second one and repaint the previous filter's rows.
 *
 * `enabled: false` settles immediately as empty — used when a dependency (an
 * application id, a session) isn't available yet, so callers don't have to
 * special-case a permanent loading state.
 */
export function useAsyncResource<T>(
  fetcher: () => Promise<T | null>,
  keys: readonly unknown[],
  enabled = true
): AsyncResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const fetcherRef = useRef(fetcher);
  const requestRef = useRef(0);
  const keysKey = JSON.stringify(keys);

  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    const requestId = ++requestRef.current;

    if (!enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    // See the note above: a network call keyed off changing inputs is external
    // synchronization and has no render-time equivalent.
    setLoading(true);
    setError(null);

    fetcherRef
      .current()
      .then((result) => {
        if (requestId !== requestRef.current) return;
        setData(result);
      })
      .catch((err: unknown) => {
        if (requestId !== requestRef.current) return;
        setData(null);
        setError(err instanceof ApiError ? err.message : "UNKNOWN_ERROR");
      })
      .finally(() => {
        if (requestId === requestRef.current) setLoading(false);
      });
  }, [keysKey, enabled, reloadToken]);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  return { data, loading, error, reload };
}
