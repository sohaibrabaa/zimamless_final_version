"use client";

import { apiClient } from "@/lib/api/client";
import { useAsyncResource, type AsyncResource } from "@/lib/api/useAsyncResource";
import { useSession } from "@/lib/session/SessionProvider";
import type { PolicyFilterRecord } from "@/lib/marketplace/policy-filters";

export type PolicyFilterInput = Omit<PolicyFilterRecord, "id" | "bankOrganizationId">;

export function usePolicyFilters(): AsyncResource<PolicyFilterRecord[]> {
  const { activeOrganizationId, loading: sessionLoading } = useSession();

  return useAsyncResource<PolicyFilterRecord[]>(
    async () => {
      const { data, error } = await apiClient.GET("/banks/policy-filters", {});
      if (error) throw error;
      return (data as PolicyFilterRecord[]) ?? [];
    },
    [activeOrganizationId],
    !sessionLoading && !!activeOrganizationId
  );
}

export async function createPolicyFilter(input: PolicyFilterInput) {
  const { error } = await apiClient.POST("/banks/policy-filters", {
    body: input as never,
  });
  if (error) throw error;
}

export async function updatePolicyFilter(id: string, patch: Partial<PolicyFilterInput>) {
  const { error } = await apiClient.PATCH("/banks/policy-filters/{id}", {
    params: { path: { id } },
    body: patch as never,
  });
  if (error) throw error;
}
