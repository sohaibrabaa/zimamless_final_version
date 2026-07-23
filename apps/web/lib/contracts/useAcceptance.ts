"use client";

import { useRef } from "react";
import { apiClient, idempotencyHeader } from "@/lib/api/client";
import type { components } from "@/lib/api/generated/schema";

export type AcceptedOfferSnapshot = components["schemas"]["AcceptedOfferSnapshot"];

/** Widens the declared snapshot with the full breakdown + real conditions (Q-15). */
export interface AcceptedOfferSnapshotFull extends AcceptedOfferSnapshot {
  bankDiscountAmount?: string;
  bankFeesAmount?: string;
  otherDeductionsAmount?: string;
  expectedPayoutDate?: string;
  validUntil?: string;
  conditions?: {
    id?: string;
    conditionType?: string;
    title?: string;
    description?: string;
    isMandatory?: boolean;
    fulfilment?: string;
  }[];
}

/**
 * `POST /offers/{id}/accept` — atomic and irreversible. The idempotency key
 * is generated once per acceptance *attempt* (held in a ref) and reused
 * across retries of that same attempt, so a network retry after a timeout
 * replays the original result instead of risking a second lock — the whole
 * point of `ZM-SEL-002`'s idempotency requirement. `resetAttempt` starts a
 * fresh key, called when the confirmation modal is reopened for a
 * different offer or after a successful accept.
 */
export function useOfferAcceptance() {
  const keyRef = useRef<string | null>(null);

  function resetAttempt() {
    keyRef.current = null;
  }

  async function accept(offerId: string): Promise<AcceptedOfferSnapshotFull> {
    if (!keyRef.current) keyRef.current = crypto.randomUUID();
    const { data, error } = await apiClient.POST("/offers/{id}/accept", {
      params: { path: { id: offerId }, header: idempotencyHeader(keyRef.current) },
    });
    if (error) throw error;
    return data as AcceptedOfferSnapshotFull;
  }

  return { accept, resetAttempt };
}

export async function rejectAllOffers(listingId: string): Promise<void> {
  const { error } = await apiClient.POST("/listings/{id}/reject-all", {
    params: { path: { id: listingId } },
  });
  if (error) throw error;
}
