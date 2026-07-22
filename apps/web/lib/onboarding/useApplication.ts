"use client";

import { apiClient } from "@/lib/api/client";
import { useAsyncResource, type AsyncResource } from "@/lib/api/useAsyncResource";
import type { components } from "@/lib/api/generated/schema";
import { useSession } from "@/lib/session/SessionProvider";

export type SupplierApplication = components["schemas"]["SupplierApplication"];
export type InformationRequest = components["schemas"]["InformationRequest"];

/**
 * Optional fields the frontend reads when present but never requires, because
 * the frozen contract doesn't define them yet (Q-05/Q-07/Q-08). Declared as a
 * widening of the generated type rather than an edit to it — the generated
 * schema stays the single source of truth for everything the contract does say,
 * and every screen degrades if these never land.
 */
export type ApplicationView = SupplierApplication & {
  slaPausedReason?: string;
  governmentRequests?: components["schemas"]["GovernmentRequest"][];
  organizationName?: string;
  nationalEstablishmentNumber?: string;
  professionLicenceNumber?: string;
  decisionNotes?: string;
};

/**
 * The supplier's own application, resolved through the D-05 list endpoint —
 * which is role-scoped server-side, so a supplier only ever gets their own.
 * There is no "get my application" endpoint in the contract; this is the
 * intended use of the list per D-05 ("supplier sees its own").
 */
export function useMyApplication(): AsyncResource<ApplicationView> {
  // `activeOrganizationId` comes from SessionProvider's own state, never from
  // `me.activeOrganizationId` — the live `/auth/me` only echoes back the
  // header the request already carried, so deriving it from the response is
  // circular and leaves the header unset (Phase 1 audit, kickoff §"What
  // changed in your tree"). Re-fetching when it changes is what makes the
  // org switcher actually reload this screen.
  const { me, activeOrganizationId, loading: sessionLoading } = useSession();

  return useAsyncResource<ApplicationView>(
    async () => {
      const { data, error } = await apiClient.GET("/onboarding/applications-list", {
        params: { query: { pageSize: 1 } },
      });
      if (error) throw error;
      return (data?.items?.[0] as ApplicationView | undefined) ?? null;
    },
    [activeOrganizationId],
    !sessionLoading && !!me && !!activeOrganizationId
  );
}

/** A single application by id — the reviewer detail screen. */
export function useApplication(id: string | undefined): AsyncResource<ApplicationView> {
  return useAsyncResource<ApplicationView>(
    async () => {
      const { data, error } = await apiClient.GET("/onboarding/applications/{id}", {
        params: { path: { id: id ?? "" } },
      });
      if (error) throw error;
      return data as ApplicationView;
    },
    [id],
    !!id
  );
}

export function useInformationRequests(
  applicationId: string | undefined
): AsyncResource<InformationRequest[]> {
  return useAsyncResource<InformationRequest[]>(
    async () => {
      const { data, error } = await apiClient.GET(
        "/onboarding/applications/{id}/information-requests",
        { params: { path: { id: applicationId ?? "" } } }
      );
      if (error) throw error;
      return data ?? [];
    },
    [applicationId],
    !!applicationId
  );
}
