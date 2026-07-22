"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import { apiClient, configureApiClient, ApiError } from "@/lib/api/client";
import type { paths } from "@/lib/api/generated/schema";
import type { Locale } from "@/lib/i18n/locales";
import { getStoredPersona } from "@/lib/mocks/persona-store";

const MOCKING_ENABLED = process.env.NEXT_PUBLIC_API_MOCKING !== "disabled";

/**
 * The active organization lives here, on the client.
 *
 * The server keeps no per-session org context: `GET /auth/me` only *echoes*
 * an `X-Organization-Id` that the request already carried, and
 * `POST /auth/context` validates a choice rather than storing it. So deriving
 * the header from `me.activeOrganizationId` is circular — without a locally
 * held id nothing is ever sent, `activeOrganizationId` comes back absent, and
 * every non-exempt endpoint 403s.
 */
const ACTIVE_ORG_STORAGE_KEY = "zm_active_org";

function readStoredOrg(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ACTIVE_ORG_STORAGE_KEY);
}

function writeStoredOrg(organizationId: string | null): void {
  if (typeof window === "undefined") return;
  if (organizationId) window.localStorage.setItem(ACTIVE_ORG_STORAGE_KEY, organizationId);
  else window.localStorage.removeItem(ACTIVE_ORG_STORAGE_KEY);
}

type AuthMe = paths["/auth/me"]["get"]["responses"]["200"]["content"]["application/json"];

interface SessionContextValue {
  session: Session | null;
  me: AuthMe | null;
  loading: boolean;
  error: string | null;
  activeOrganizationId: string | null;
  activeMembership: AuthMe["memberships"][number] | undefined;
  switchOrganization: (organizationId: string) => Promise<void>;
  signOut: () => Promise<void>;
  refetch: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: React.ReactNode;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [me, setMe] = useState<AuthMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeOrganizationId, setActiveOrganizationId] = useState<string | null>(null);

  // The request interceptor is registered once and must read the *current*
  // org id, not the one captured when it was configured. Every write goes
  // through selectOrganization() or the hydration effect below, so the ref
  // is never touched during render.
  const activeOrgRef = useRef<string | null>(null);

  const selectOrganization = useCallback((organizationId: string | null) => {
    activeOrgRef.current = organizationId;
    setActiveOrganizationId(organizationId);
    writeStoredOrg(organizationId);
  }, []);

  const fetchMe = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: fetchError } = await apiClient.GET("/auth/me");
      if (fetchError) throw fetchError;
      setMe(data ?? null);

      // Pick a default the first time, and heal a stored id that is no
      // longer a membership (revoked access, or a stale id from another
      // account on this browser).
      const memberships = data?.memberships ?? [];
      const stored = activeOrgRef.current ?? readStoredOrg();
      const valid = stored && memberships.some((m) => m.organizationId === stored) ? stored : null;
      const next = valid ?? data?.activeOrganizationId ?? memberships[0]?.organizationId ?? null;
      if (next !== activeOrgRef.current) selectOrganization(next);
    } catch (err) {
      setMe(null);
      setError(err instanceof ApiError ? err.message : "Failed to load session.");
    } finally {
      setLoading(false);
    }
  }, [selectOrganization]);

  useEffect(() => {
    configureApiClient({
      getAccessToken: () => session?.access_token ?? null,
      getActiveOrganizationId: () => activeOrgRef.current,
      getLocale: () => locale,
      getMockPersona: MOCKING_ENABLED ? getStoredPersona : undefined,
    });
  }, [session, locale]);

  useEffect(() => {
    // Hydration: localStorage is unavailable during SSR, so the first client
    // render starts at null and adopts the persisted choice here.
    const stored = readStoredOrg();
    activeOrgRef.current = stored;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveOrganizationId(stored);
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session || MOCKING_ENABLED) {
      // Synchronizing with an external system (Supabase auth state changing
      // → re-fetch /auth/me) is exactly what effects are for; there's no
      // derived-during-render alternative for a network call keyed off it.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchMe();
    } else {
      setMe(null);
      setLoading(false);
    }
  }, [session, fetchMe]);

  useEffect(() => {
    if (!MOCKING_ENABLED) return;
    const onPersonaChange = () => {
      // A different persona has different memberships; the stored org must
      // not leak across the switch.
      selectOrganization(null);
      void fetchMe();
    };
    window.addEventListener("zm:persona-changed", onPersonaChange);
    return () => window.removeEventListener("zm:persona-changed", onPersonaChange);
  }, [fetchMe, selectOrganization]);

  const switchOrganization = useCallback(
    async (organizationId: string) => {
      // Validate server-side first: a 403 here must not leave the client
      // pointing at an org the API will refuse on the next request.
      const { error: switchError } = await apiClient.POST("/auth/context", {
        body: { organizationId },
      });
      if (switchError) throw switchError;
      // The contract types this 200 as having no body, so the id we asked for
      // is the id that was accepted — reading a response body here would mean
      // casting past the generated types to an undocumented field.
      selectOrganization(organizationId);
      await fetchMe();
    },
    [fetchMe, selectOrganization]
  );

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setMe(null);
    selectOrganization(null);
  }, [selectOrganization]);

  const activeMembership = me?.memberships.find(
    (m) => m.organizationId === activeOrganizationId
  );

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      me,
      loading,
      error,
      activeOrganizationId,
      activeMembership,
      switchOrganization,
      signOut,
      refetch: fetchMe,
    }),
    [
      session,
      me,
      loading,
      error,
      activeOrganizationId,
      activeMembership,
      switchOrganization,
      signOut,
      fetchMe,
    ]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within a SessionProvider");
  return ctx;
}
