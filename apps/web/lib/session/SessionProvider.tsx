"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import { apiClient, configureApiClient, ApiError } from "@/lib/api/client";
import type { paths } from "@/lib/api/generated/schema";
import type { Locale } from "@/lib/i18n/locales";
import { getStoredPersona } from "@/lib/mocks/persona-store";

const MOCKING_ENABLED = process.env.NEXT_PUBLIC_API_MOCKING !== "disabled";

type AuthMe = paths["/auth/me"]["get"]["responses"]["200"]["content"]["application/json"];

interface SessionContextValue {
  session: Session | null;
  me: AuthMe | null;
  loading: boolean;
  error: string | null;
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

  const fetchMe = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: fetchError } = await apiClient.GET("/auth/me");
      if (fetchError) throw fetchError;
      setMe(data ?? null);
    } catch (err) {
      setMe(null);
      setError(err instanceof ApiError ? err.message : "Failed to load session.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    configureApiClient({
      getAccessToken: () => session?.access_token ?? null,
      getActiveOrganizationId: () => me?.activeOrganizationId ?? null,
      getLocale: () => locale,
      getMockPersona: MOCKING_ENABLED ? getStoredPersona : undefined,
    });
  }, [session, me, locale]);

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
    const onPersonaChange = () => fetchMe();
    window.addEventListener("zm:persona-changed", onPersonaChange);
    return () => window.removeEventListener("zm:persona-changed", onPersonaChange);
  }, [fetchMe]);

  const switchOrganization = useCallback(
    async (organizationId: string) => {
      const { error: switchError } = await apiClient.POST("/auth/context", {
        body: { organizationId },
      });
      if (switchError) throw switchError;
      await fetchMe();
    },
    [fetchMe]
  );

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setMe(null);
  }, []);

  const activeMembership = me?.memberships.find((m) => m.organizationId === me.activeOrganizationId);

  const value = useMemo<SessionContextValue>(
    () => ({ session, me, loading, error, activeMembership, switchOrganization, signOut, refetch: fetchMe }),
    [session, me, loading, error, activeMembership, switchOrganization, signOut, fetchMe]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within a SessionProvider");
  return ctx;
}
