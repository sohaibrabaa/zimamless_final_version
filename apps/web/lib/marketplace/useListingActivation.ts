"use client";

import { apiClient } from "@/lib/api/client";
import { useAsyncResource, type AsyncResource } from "@/lib/api/useAsyncResource";
import { ApiError } from "@/lib/api/client";
import type { components } from "@/lib/api/generated/schema";

export type Listing = components["schemas"]["Listing"];

/**
 * `GET /transactions/{id}/listing-current` 404s when no listing has been
 * activated yet — that is the normal "not listed" state, not an error to
 * surface, so it resolves to `data: null` rather than populating `error`.
 */
export function useCurrentListing(transactionId: string | undefined): AsyncResource<Listing | null> {
  return useAsyncResource<Listing | null>(
    async () => {
      try {
        const { data, error } = await apiClient.GET("/transactions/{id}/listing-current", {
          params: { path: { id: transactionId ?? "" } },
        });
        if (error) throw error;
        return data ?? null;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    [transactionId],
    !!transactionId
  );
}

export async function activateListingForTransaction(transactionId: string): Promise<Listing | undefined> {
  const { data, error } = await apiClient.POST("/transactions/{id}/listing", {
    params: { path: { id: transactionId } },
  });
  if (error) throw error;
  return data;
}
