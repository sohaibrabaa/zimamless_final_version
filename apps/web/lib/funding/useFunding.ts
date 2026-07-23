"use client";

import { useRef } from "react";
import { apiClient, ApiError, idempotencyHeader } from "@/lib/api/client";
import { useAsyncResource, type AsyncResource } from "@/lib/api/useAsyncResource";
import type { components } from "@/lib/api/generated/schema";

export type Settlement = components["schemas"]["Settlement"];

/**
 * Widens the declared `Settlement` with the timeline fields the API returns
 * additively — when the bank said it sent, and when each payout stage
 * happened. The declared schema carries only `payoutCompletedAt`, which is
 * not enough to render "marked sent 3 hours ago, still unconfirmed", the one
 * thing an operator looking at this screen wants to know.
 */
export interface SettlementFull extends Settlement {
  transactionId?: string;
  providerName?: string;
  bankMarkedSentAt?: string | null;
  fundingReceivedAt?: string | null;
  payoutInitiatedAt?: string | null;
}

/** 404 (nothing marked sent yet) resolves to `null` — the normal state before funding, not an error. */
export function useSettlement(transactionId: string | undefined): AsyncResource<SettlementFull | null> {
  return useAsyncResource<SettlementFull | null>(
    async () => {
      try {
        const { data, error } = await apiClient.GET("/transactions/{id}/settlement", {
          params: { path: { id: transactionId ?? "" } },
        });
        if (error) throw error;
        return (data as SettlementFull) ?? null;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    [transactionId],
    !!transactionId
  );
}

/**
 * `POST /transactions/{id}/funding/mark-sent`.
 *
 * The idempotency key is minted once per *attempt* and held in a ref, exactly
 * as acceptance does: a network retry after a timeout must replay the first
 * result rather than create a second settlement for the same transfer. The
 * key is reset only after a success, so every retry of one attempt carries the
 * same key and a genuinely new attempt gets a new one.
 */
export function useMarkSent() {
  const keyRef = useRef<string | null>(null);

  /**
   * Returns nothing on purpose. The API does send the settlement back, but
   * the contract declares this response as `{ description: Marked }` with no
   * schema — so the body is additive and undeclared, and a screen that read it
   * would be depending on something the contract does not promise. The caller
   * reloads `GET /transactions/{id}/settlement`, which is declared, instead.
   */
  async function markSent(
    transactionId: string,
    body: { providerReference?: string; evidenceDocumentId?: string }
  ): Promise<void> {
    if (!keyRef.current) keyRef.current = crypto.randomUUID();
    const { error } = await apiClient.POST("/transactions/{id}/funding/mark-sent", {
      params: { path: { id: transactionId }, header: idempotencyHeader(keyRef.current) },
      body,
    });
    if (error) throw error;
    keyRef.current = null;
  }

  return { markSent };
}

export interface GeneratedOtp {
  otp: string;
  expiresAt: string;
  resendsRemaining: number;
}

/**
 * `POST /transactions/{id}/funding/otp` — the plaintext code, returned once.
 *
 * This function hands the code straight to its caller and keeps no copy. The
 * standing rule for the whole system is that OTP plaintext exists in exactly
 * two places: this one API response, and the memory of the single component
 * that displays it. So there is deliberately no cache here, no ref, no
 * `useState` in this hook, and nothing that would survive a re-render — and
 * emphatically no `localStorage`/`sessionStorage`, which would persist a live
 * credential to disk.
 *
 * There is also no idempotency key. Regeneration is a *deliberate* repeat
 * (the supplier never received the first code), and replaying a stored
 * response would hand back a code the server may already have superseded.
 * The server bounds it with `otp_max_resends` instead.
 */
export async function generateOtp(transactionId: string): Promise<GeneratedOtp> {
  const { data, error } = await apiClient.POST("/transactions/{id}/funding/otp", {
    params: { path: { id: transactionId } },
  });
  if (error) throw error;
  return data as GeneratedOtp;
}

export interface ConfirmResult {
  transactionState?: string;
  fundedAt?: string;
}

/** Raised when the server rejects a code. Carries the one detail it discloses. */
export class OtpRejected extends Error {
  constructor(readonly attemptsRemaining: number | null) {
    super("OTP_INVALID");
    this.name = "OtpRejected";
  }
}

/**
 * `POST /transactions/{id}/funding/confirm` — the supplier's half of INV-10.
 *
 * A 401 is translated into `OtpRejected` carrying `attemptsRemaining` and
 * nothing else. That is the entire contract of the failure: the server will
 * not say whether the code was wrong, expired, or already used, and this
 * layer must not reconstruct that distinction from status codes, timing, or
 * anything else. Every other error propagates untouched — a 409 on a
 * transaction in the wrong state is a genuinely different situation and
 * should read as one.
 *
 * The idempotency key is per attempt for the same reason as mark-sent: a
 * timeout on a *correct* code must not cost the supplier one of five
 * attempts when they retry.
 */
export function useFundingConfirmation() {
  const keyRef = useRef<string | null>(null);

  async function confirm(transactionId: string, otp: string): Promise<ConfirmResult> {
    if (!keyRef.current) keyRef.current = crypto.randomUUID();
    try {
      const { data, error } = await apiClient.POST("/transactions/{id}/funding/confirm", {
        params: { path: { id: transactionId }, header: idempotencyHeader(keyRef.current) },
        body: { otp },
      });
      if (error) throw error;
      keyRef.current = null;
      return data as ConfirmResult;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // A rejected code ends that attempt: the next try is a new request
        // and must not replay this one's stored 401.
        keyRef.current = null;
        // The contract declares `attemptsRemaining` at the top level of this
        // 401 (an inline schema, not the Error envelope); the API also leaves
        // it in `details` so the envelope stays uniform. Read the declared
        // position first and fall back, so this works either way.
        const remaining = err.body.attemptsRemaining ?? err.details?.attemptsRemaining;
        throw new OtpRejected(typeof remaining === "number" ? remaining : null);
      }
      throw err;
    }
  }

  return { confirm };
}

/** `POST /settlements/{id}/retry` — idempotent server-side; never double-pays (INV-13). */
export function useRetryPayout() {
  const keyRef = useRef<string | null>(null);

  async function retry(settlementId: string): Promise<void> {
    if (!keyRef.current) keyRef.current = crypto.randomUUID();
    const { error } = await apiClient.POST("/settlements/{id}/retry", {
      params: { path: { id: settlementId }, header: idempotencyHeader(keyRef.current) },
    });
    if (error) throw error;
    keyRef.current = null;
  }

  return { retry };
}

export type TransactionSummary = components["schemas"]["TransactionSummary"];

/** The funding queue for a portal — one call per state, since the API filters by a single state. */
export function useFundingQueue(states: readonly string[]): AsyncResource<TransactionSummary[]> {
  const key = states.join(",");
  return useAsyncResource<TransactionSummary[]>(
    async () => {
      const pages = await Promise.all(
        states.map(async (state) => {
          const { data, error } = await apiClient.GET("/transactions", {
            params: { query: { state: state as TransactionSummary["state"], pageSize: 50 } },
          });
          if (error) throw error;
          return data?.items ?? [];
        })
      );
      return pages.flat();
    },
    [key],
    states.length > 0
  );
}
