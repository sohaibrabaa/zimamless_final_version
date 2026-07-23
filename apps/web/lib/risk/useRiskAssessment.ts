"use client";

import { apiClient } from "@/lib/api/client";
import { useAsyncResource, type AsyncResource } from "@/lib/api/useAsyncResource";
import type { RiskAssessment } from "./risk-presentation";

export function useRiskAssessment(
  transactionId: string | undefined,
  enabled = true
): AsyncResource<RiskAssessment> {
  return useAsyncResource<RiskAssessment>(
    async () => {
      const { data, error } = await apiClient.GET("/transactions/{id}/risk", {
        params: { path: { id: transactionId ?? "" } },
      });
      if (error) throw error;
      return data ?? null;
    },
    [transactionId],
    !!transactionId && enabled
  );
}
