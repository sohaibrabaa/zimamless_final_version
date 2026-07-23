"use client";

import { apiClient } from "@/lib/api/client";
import { useAsyncResource, type AsyncResource } from "@/lib/api/useAsyncResource";
import type { components } from "@/lib/api/generated/schema";
import { useSession } from "@/lib/session/SessionProvider";

export type Transaction = components["schemas"]["Transaction"];
export type TransactionSummary = components["schemas"]["TransactionSummary"];
export type Pagination = components["schemas"]["Pagination"];
export type Extraction = components["schemas"]["Extraction"];
export type VerificationRun = components["schemas"]["VerificationRun"];

/**
 * Optional fields read when present but never required, because the frozen
 * contract does not define them (Q-12). Declared as a widening of the
 * generated type rather than an edit to it — same pattern as
 * `ApplicationView` in Phase 2, so the generated schema stays the single
 * source of truth for everything the contract does say.
 *
 * `documents` in particular: the wizard uploads them and the detail screen
 * should list them, but `Transaction` carries no document array and there is
 * no `GET /transactions/{id}/documents`. Every screen degrades to "documents
 * are not listed here" if it never lands.
 */
export interface TransactionDocument {
  id?: string;
  documentType?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  uploadedAt?: string;
}

export type TransactionView = Transaction & {
  documents?: TransactionDocument[];
  declarationTemplateVersion?: string;
  submittedAt?: string;
};

export interface TransactionListResult {
  items: TransactionSummary[];
  pagination?: Pagination;
}

export function useTransactionList(
  page: number,
  pageSize: number,
  state?: components["schemas"]["TransactionState"]
): AsyncResource<TransactionListResult> {
  // Re-fetch on org switch for the same reason the Phase 2 screens do: the
  // active organization is client state, and the list is scoped to it
  // server-side via X-Organization-Id.
  const { activeOrganizationId, loading: sessionLoading } = useSession();

  return useAsyncResource<TransactionListResult>(
    async () => {
      const { data, error } = await apiClient.GET("/transactions", {
        params: { query: { page, pageSize, ...(state ? { state } : {}) } },
      });
      if (error) throw error;
      return { items: data?.items ?? [], pagination: data?.pagination };
    },
    [activeOrganizationId, page, pageSize, state ?? null],
    !sessionLoading && !!activeOrganizationId
  );
}

export function useTransaction(id: string | undefined): AsyncResource<TransactionView> {
  return useAsyncResource<TransactionView>(
    async () => {
      const { data, error } = await apiClient.GET("/transactions/{id}", {
        params: { path: { id: id ?? "" } },
      });
      if (error) throw error;
      return (data as TransactionView) ?? null;
    },
    [id],
    !!id
  );
}

export function useVerificationRun(
  id: string | undefined,
  enabled = true
): AsyncResource<VerificationRun> {
  return useAsyncResource<VerificationRun>(
    async () => {
      const { data, error } = await apiClient.GET("/transactions/{id}/verification", {
        params: { path: { id: id ?? "" } },
      });
      if (error) throw error;
      return data ?? null;
    },
    [id],
    !!id && enabled
  );
}

/**
 * OCR/QR extraction for an uploaded document.
 *
 * Extraction is asynchronous server-side, so this is not guaranteed to be
 * ready on first read. The hook exposes `reload` (via AsyncResource) and the
 * wizard offers an explicit "check again" control rather than polling on a
 * timer: a background poll that silently overwrites a form the supplier is
 * typing into is worse than a button they press when they are ready.
 */
export function useExtraction(documentId: string | undefined): AsyncResource<Extraction> {
  return useAsyncResource<Extraction>(
    async () => {
      const { data, error } = await apiClient.GET("/documents/{id}/extraction", {
        params: { path: { id: documentId ?? "" } },
      });
      if (error) throw error;
      return data ?? null;
    },
    [documentId],
    !!documentId
  );
}
