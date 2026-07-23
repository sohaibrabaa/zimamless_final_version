"use client";

import { apiClient, ApiError } from "@/lib/api/client";
import { useAsyncResource, type AsyncResource } from "@/lib/api/useAsyncResource";
import type { components } from "@/lib/api/generated/schema";

export type Contract = components["schemas"]["Contract"];
export type OfferCondition = components["schemas"]["OfferCondition"];

/** Widens the declared `Contract` with the rendered document text and which side each signature belongs to (Q-15). */
export interface ContractFull extends Contract {
  transactionId?: string;
  bodyEn?: string;
  bodyAr?: string;
  signatures?: {
    organizationType?: "SUPPLIER" | "BANK";
    signerName?: string;
    signerCapacity?: string;
    status?: string;
    signedAt?: string;
  }[];
}

/** 404 (no contract generated yet) resolves to `null` — the normal pre-generation state, not an error. */
export function useContract(transactionId: string | undefined): AsyncResource<ContractFull | null> {
  return useAsyncResource<ContractFull | null>(
    async () => {
      try {
        const { data, error } = await apiClient.GET("/transactions/{id}/contract", {
          params: { path: { id: transactionId ?? "" } },
        });
        if (error) throw error;
        return (data as ContractFull) ?? null;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    [transactionId],
    !!transactionId
  );
}

export async function generateContract(transactionId: string): Promise<ContractFull> {
  const { data, error } = await apiClient.POST("/transactions/{id}/contract", {
    params: { path: { id: transactionId } },
  });
  if (error) throw error;
  return data as ContractFull;
}

export async function signContract(contractId: string): Promise<ContractFull> {
  const { data, error } = await apiClient.POST("/contracts/{id}/sign", {
    params: { path: { id: contractId } },
    body: { accepted: true },
  });
  if (error) throw error;
  return data as ContractFull;
}

export function useConditions(transactionId: string | undefined): AsyncResource<OfferCondition[]> {
  return useAsyncResource<OfferCondition[]>(
    async () => {
      const { data, error } = await apiClient.GET("/transactions/{id}/conditions", {
        params: { path: { id: transactionId ?? "" } },
      });
      if (error) throw error;
      return data ?? [];
    },
    [transactionId],
    !!transactionId
  );
}

export async function fulfilCondition(conditionId: string, notes?: string): Promise<void> {
  const { error } = await apiClient.POST("/conditions/{id}/fulfil", {
    params: { path: { id: conditionId } },
    body: { notes },
  });
  if (error) throw error;
}
