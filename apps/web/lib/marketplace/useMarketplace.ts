"use client";

import { apiClient } from "@/lib/api/client";
import { useAsyncResource, type AsyncResource } from "@/lib/api/useAsyncResource";
import type { components } from "@/lib/api/generated/schema";
import { useSession } from "@/lib/session/SessionProvider";

export type BankListingView = components["schemas"]["BankListingView"];
export type Pagination = components["schemas"]["Pagination"];

export interface EligibleListingsResult {
  items: BankListingView[];
  pagination?: Pagination;
}

/**
 * The bank marketplace feed (phase file B tasks — Phase 5 head start).
 *
 * Deliberately its own hook module, not shared with the supplier's
 * `lib/invoices/useTransactions.ts` or with any future underwriting-view
 * data fetch used elsewhere: the phase file's ownership guard is explicit
 * that the comparison screen (supplier) and the underwriting view (bank)
 * must not share a data-fetch layer, "prevents accidental floor/competitor
 * bleed via a shared cache." Splitting the hook files now, before either
 * screen has much in it, is cheaper than un-sharing them later.
 */
export function useEligibleListings(page: number, pageSize: number): AsyncResource<EligibleListingsResult> {
  const { activeOrganizationId, loading: sessionLoading } = useSession();

  return useAsyncResource<EligibleListingsResult>(
    async () => {
      const { data, error } = await apiClient.GET("/marketplace/eligible", {
        params: { query: { page, pageSize } },
      });
      if (error) throw error;
      return { items: data?.items ?? [], pagination: data?.pagination };
    },
    [activeOrganizationId, page, pageSize],
    !sessionLoading && !!activeOrganizationId
  );
}

export function useListing(listingId: string | undefined): AsyncResource<BankListingView> {
  return useAsyncResource<BankListingView>(
    async () => {
      const { data, error } = await apiClient.GET("/marketplace/listings/{id}", {
        params: { path: { id: listingId ?? "" } },
      });
      if (error) throw error;
      return data ?? null;
    },
    [listingId],
    !!listingId
  );
}
