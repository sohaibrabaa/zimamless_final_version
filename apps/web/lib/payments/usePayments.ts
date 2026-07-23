"use client";

import { useRef } from "react";
import { apiClient, ApiError, idempotencyHeader } from "@/lib/api/client";
import { useAsyncResource, type AsyncResource } from "@/lib/api/useAsyncResource";
import type { components } from "@/lib/api/generated/schema";
import type { CaseType } from "./payments-domain";

export type BuyerPayment = components["schemas"]["BuyerPayment"];

/**
 * The payment history and the **derived** outstanding balance.
 *
 * The balance is computed server-side from the recorded payments on every read
 * (D-13/PA-06) — `invoices.outstandingAmount` froze at listing because it is
 * what the offer was priced against. Nothing here caches it, because a cached
 * derived balance is a balance that can disagree with the payments beside it.
 */
export interface PaymentHistory {
  payments: (BuyerPayment & { bankInternalNotes?: string; evidenceDocumentId?: string })[];
  outstandingAmount: string;
  overdueDays: number;
}

export function usePayments(transactionId: string | undefined): AsyncResource<PaymentHistory | null> {
  return useAsyncResource<PaymentHistory | null>(
    async () => {
      try {
        const { data, error } = await apiClient.GET("/transactions/{id}/payments", {
          params: { path: { id: transactionId ?? "" } },
        });
        if (error) throw error;
        return (data as PaymentHistory) ?? null;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    [transactionId],
    !!transactionId
  );
}

/** `POST /transactions/{id}/payments` — a bank reporting what the buyer paid. */
export function useReportPayment() {
  const keyRef = useRef<string | null>(null);

  async function report(
    transactionId: string,
    body: {
      amount: string;
      paymentDate: string;
      bankReference?: string;
      bankInternalNotes?: string;
    }
  ): Promise<void> {
    if (!keyRef.current) keyRef.current = crypto.randomUUID();
    const { error } = await apiClient.POST("/transactions/{id}/payments", {
      params: { path: { id: transactionId }, header: idempotencyHeader(keyRef.current) },
      body,
    });
    if (error) throw error;
    keyRef.current = null;
  }

  return { report };
}

/**
 * `POST /transactions/{id}/confirm-status`.
 *
 * The only route to `OVERDUE` in the product. Deliberately has no idempotency
 * key: this is a bank stating a fact, and re-stating it is not a duplicate
 * request to be replayed — it is the bank correcting itself, which must land.
 */
export async function confirmStatus(
  transactionId: string,
  body: { status: "PAID" | "PARTIALLY_PAID" | "OVERDUE"; notes?: string }
): Promise<void> {
  const { error } = await apiClient.POST("/transactions/{id}/confirm-status", {
    params: { path: { id: transactionId } },
    body,
  });
  if (error) throw error;
}

// ---------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------

export interface CaseSummary {
  id: string;
  type: CaseType;
  transactionId: string | null;
  status: string;
  amount: string | null;
  openedAt: string;
}

export function useCases(filters: { type?: CaseType } = {}): AsyncResource<CaseSummary[]> {
  const key = filters.type ?? "ALL";
  return useAsyncResource<CaseSummary[]>(
    async () => {
      const { data, error } = await apiClient.GET("/cases", {
        params: { query: filters.type ? { type: filters.type } : {} },
      });
      if (error) throw error;
      return ((data as { items?: CaseSummary[] })?.items ?? []) as CaseSummary[];
    },
    [key],
    true
  );
}

export type RecourseCase = components["schemas"]["RecourseCase"] & {
  transactionId?: string;
  remainingAmount?: string;
};

export async function initiateRecourse(
  transactionId: string,
  body: { reason: string; requestedAmount: string; notes?: string }
): Promise<RecourseCase> {
  const { data, error } = await apiClient.POST("/transactions/{id}/recourse", {
    params: { path: { id: transactionId } },
    body: body as never,
  });
  if (error) throw error;
  return data as RecourseCase;
}

export async function openDispute(
  transactionId: string,
  body: { disputeType: string; description: string; amount?: string }
): Promise<void> {
  const { error } = await apiClient.POST("/transactions/{id}/disputes", {
    params: { path: { id: transactionId } },
    body: body as never,
  });
  if (error) throw error;
}

// ---------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------

export interface NotificationItem {
  id: string;
  templateKey: string;
  subject: string;
  body: string;
  transactionId: string | null;
  read: boolean;
  queuedAt: string;
}

export interface Inbox {
  items: NotificationItem[];
  unreadCount: number;
}

export function useInbox(unreadOnly: boolean): AsyncResource<Inbox> {
  return useAsyncResource<Inbox>(
    async () => {
      const { data, error } = await apiClient.GET("/notifications", {
        params: { query: unreadOnly ? { unread: true } : {} },
      });
      if (error) throw error;
      const body = data as { items?: NotificationItem[]; unreadCount?: number } | undefined;
      return { items: body?.items ?? [], unreadCount: body?.unreadCount ?? 0 };
    },
    [String(unreadOnly)],
    true
  );
}

export async function markNotificationRead(id: string): Promise<void> {
  const { error } = await apiClient.POST("/notifications/{id}/read", {
    params: { path: { id } },
  });
  if (error) throw error;
}
