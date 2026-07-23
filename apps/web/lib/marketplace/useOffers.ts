"use client";

import { apiClient } from "@/lib/api/client";
import { useAsyncResource, type AsyncResource } from "@/lib/api/useAsyncResource";
import type { components } from "@/lib/api/generated/schema";
import { useSession } from "@/lib/session/SessionProvider";
import type { OfferInputPayload } from "@/lib/marketplace/offer-domain";

export type Offer = components["schemas"]["Offer"];
export type Pagination = components["schemas"]["Pagination"];

/**
 * Widens the generated `Offer` type with the maker identity fields the
 * contract does not declare (Q-14) and the offer's own `transactionId`
 * (needed to reach the Phase 6 conditions/contract endpoints, which are
 * keyed by transaction, not by listing or offer). Both endpoints this hook
 * calls (`GET /offers`, `GET /offers/{id}`) are bank-scoped to the offer's
 * own organization, so carrying these extra fields past the typed response
 * never crosses a confidentiality boundary — see the note in
 * `lib/mocks/handlers.ts` next to where they are added.
 */
export interface OfferWithCreator extends Offer {
  createdByUserId?: string;
  createdByUserName?: string;
  transactionId?: string;
}

export type OfferInput = OfferInputPayload;

/**
 * This bank organization's own offers (`GET /offers`), any status. Backs
 * both "my offers" (no filter) and the approval queue
 * (`status=PENDING_INTERNAL_APPROVAL`) — the phase file lists them as
 * separate screens, but they are the same read with a different filter, and
 * splitting the fetch would risk the two screens disagreeing about an
 * offer's status after an approve/withdraw action on the other one.
 */
export function useBankOffers(status?: string): AsyncResource<{ items: OfferWithCreator[] }> {
  const { activeOrganizationId, loading: sessionLoading } = useSession();

  return useAsyncResource<{ items: OfferWithCreator[] }>(
    async () => {
      const { data, error } = await apiClient.GET("/offers", {
        params: { query: status ? { status } : {} },
      });
      if (error) throw error;
      return { items: (data?.items as OfferWithCreator[]) ?? [] };
    },
    [activeOrganizationId, status],
    !sessionLoading && !!activeOrganizationId
  );
}

/** `/listings/{id}/offers` — role-split server-side; the supplier comparison screen and a bank's own-offer check both use this same hook. */
export function useListingOffers(listingId: string | undefined): AsyncResource<Offer[]> {
  const { activeOrganizationId, loading: sessionLoading } = useSession();

  return useAsyncResource<Offer[]>(
    async () => {
      const { data, error } = await apiClient.GET("/listings/{id}/offers", {
        params: { path: { id: listingId ?? "" } },
      });
      if (error) throw error;
      return data ?? [];
    },
    [listingId, activeOrganizationId],
    !sessionLoading && !!listingId
  );
}

export function useOffer(offerId: string | undefined): AsyncResource<OfferWithCreator> {
  const { activeOrganizationId, loading: sessionLoading } = useSession();

  return useAsyncResource<OfferWithCreator>(
    async () => {
      const { data, error } = await apiClient.GET("/offers/{id}", {
        params: { path: { id: offerId ?? "" } },
      });
      if (error) throw error;
      return (data as OfferWithCreator) ?? null;
    },
    [offerId, activeOrganizationId],
    !sessionLoading && !!offerId
  );
}

export async function createOfferForListing(listingId: string, input: OfferInput) {
  const { data, error } = await apiClient.POST("/listings/{id}/offers/create", {
    params: { path: { id: listingId } },
    body: input,
  });
  if (error) throw error;
  return data;
}

export async function reviseOfferById(offerId: string, input: OfferInput) {
  const { error } = await apiClient.PATCH("/offers/{id}", {
    params: { path: { id: offerId } },
    body: input,
  });
  if (error) throw error;
}

export async function approveOfferById(offerId: string) {
  const { error } = await apiClient.POST("/offers/{id}/approve", {
    params: { path: { id: offerId } },
  });
  if (error) throw error;
}

export async function withdrawOfferById(offerId: string) {
  const { error } = await apiClient.POST("/offers/{id}/withdraw", {
    params: { path: { id: offerId } },
  });
  if (error) throw error;
}
