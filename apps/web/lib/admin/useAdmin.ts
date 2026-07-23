"use client";

import { apiClient } from "@/lib/api/client";
import { useAsyncResource, type AsyncResource } from "@/lib/api/useAsyncResource";
import type { components } from "@/lib/api/generated/schema";

/**
 * The platform admin surface (Phase 9.4's screens).
 *
 * Settings are a `{ key: value }` record whose values are whatever JSON the
 * key holds — the server validates each key against the settings that
 * actually exist and refuses unknown ones with a 422, so this layer does not
 * maintain its own whitelist that could drift from the real one.
 */

export type AuditLog = components["schemas"]["AuditLog"];
export type CommissionTier = components["schemas"]["CommissionTier"];
export type Pagination = components["schemas"]["Pagination"];

export type PlatformSettings = Record<string, unknown>;

export function usePlatformSettings(): AsyncResource<PlatformSettings> {
  return useAsyncResource<PlatformSettings>(
    async () => {
      const { data, error } = await apiClient.GET("/admin/settings");
      if (error) throw error;
      return (data ?? {}) as PlatformSettings;
    },
    [],
    true
  );
}

/** PATCH one or more known keys. The server audits each key it changes. */
export async function patchPlatformSettings(patch: PlatformSettings): Promise<void> {
  const { error } = await apiClient.PATCH("/admin/settings", { body: patch });
  if (error) throw error;
}

export function useCommissionTiers(): AsyncResource<CommissionTier[]> {
  return useAsyncResource<CommissionTier[]>(
    async () => {
      const { data, error } = await apiClient.GET("/admin/commission-tiers");
      if (error) throw error;
      return (data ?? []) as CommissionTier[];
    },
    [],
    true
  );
}

export interface AuditLogsResult {
  items: AuditLog[];
  pagination?: Pagination;
}

export function useAuditLogs(
  page: number,
  pageSize: number,
  targetEntityId?: string
): AsyncResource<AuditLogsResult> {
  return useAsyncResource<AuditLogsResult>(
    async () => {
      const { data, error } = await apiClient.GET("/admin/audit-logs", {
        params: {
          query: {
            page,
            pageSize,
            ...(targetEntityId ? { targetEntityId } : {}),
          },
        },
      });
      if (error) throw error;
      return { items: data?.items ?? [], pagination: data?.pagination };
    },
    [page, pageSize, targetEntityId ?? ""],
    true
  );
}
