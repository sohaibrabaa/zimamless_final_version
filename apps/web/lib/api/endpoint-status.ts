/**
 * Per-endpoint mock/live promotion map — the code-level source of truth
 * mirrored (manually, on every change) to docs/coordination/ENDPOINT_STATUS.md
 * per Master Plan 3.4 #2. MSW passes through to the real API for `live`
 * entries; every other entry stays mocked regardless of what's deployed.
 *
 * Flip an entry to "live" only after Agent A posts it LIVE in
 * docs/coordination/DAILY_LOG.md AND the consuming screen has been
 * smoke-tested the same day (Master Plan 3.4 #4).
 */

export type EndpointLifecycleStatus = "mock" | "live";

export interface EndpointStatusEntry {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  phase: number;
  status: EndpointLifecycleStatus;
  demoCritical?: boolean;
  notes?: string;
}

export const endpointStatus: EndpointStatusEntry[] = [
  { method: "GET", path: "/health", phase: 1, status: "mock" },
  { method: "GET", path: "/auth/me", phase: 1, status: "mock", notes: "demo flag (D-10) included" },
  { method: "POST", path: "/auth/context", phase: 1, status: "mock" },
  { method: "PATCH", path: "/auth/language", phase: 1, status: "mock" },

  { method: "POST", path: "/onboarding/register", phase: 2, status: "mock", notes: "v3.1.0 · supplier bootstrap form" },
  { method: "GET", path: "/onboarding/applications-list", phase: 2, status: "mock", notes: "v3.1.0 · supplier onboarding home + reviewer queue" },
  { method: "POST", path: "/onboarding/applications", phase: 2, status: "mock", notes: "no screen consumes it — bootstrap (D-04) covers the supplier path" },
  { method: "GET", path: "/onboarding/applications/{id}", phase: 2, status: "mock", notes: "reviewer application detail" },
  { method: "POST", path: "/onboarding/applications/{id}/submit", phase: 2, status: "mock", notes: "wizard step 4" },
  { method: "POST", path: "/onboarding/applications/{id}/bank-account", phase: 2, status: "mock", notes: "wizard step 4" },
  { method: "POST", path: "/onboarding/applications/{id}/consents", phase: 2, status: "mock", notes: "wizard step 3 · consent catalogue provisional (Q-05)" },
  { method: "GET", path: "/onboarding/applications/{id}/information-requests", phase: 2, status: "mock", notes: "info-request inbox (both portals)" },
  { method: "POST", path: "/onboarding/applications/{id}/respond", phase: 2, status: "mock", notes: "supplier response form" },
  { method: "POST", path: "/onboarding/applications/{id}/decide", phase: 2, status: "mock", notes: "reviewer decision form · reason-code catalogue provisional (Q-02)" },
  { method: "POST", path: "/government/lookup", phase: 2, status: "mock", notes: "handler exists; no screen triggers a manual lookup yet" },
  { method: "GET", path: "/government/requests/{id}", phase: 2, status: "mock", notes: "handler exists; source panel reads the application's list instead (Q-04)" },

  { method: "GET", path: "/buyers/search", phase: 3, status: "mock" },
  { method: "POST", path: "/buyers/resolve", phase: 3, status: "mock" },
  { method: "GET", path: "/buyers/{id}", phase: 3, status: "mock" },
  { method: "POST", path: "/documents/upload-url", phase: 3, status: "mock" },
  { method: "GET", path: "/documents/{id}/download-url", phase: 3, status: "mock" },
  { method: "GET", path: "/documents/{id}/extraction", phase: 3, status: "mock" },
  { method: "GET", path: "/transactions", phase: 3, status: "mock" },
  { method: "POST", path: "/transactions", phase: 3, status: "mock" },
  { method: "GET", path: "/transactions/{id}", phase: 3, status: "mock" },
  { method: "PUT", path: "/transactions/{id}/invoice", phase: 3, status: "mock" },
  { method: "PUT", path: "/transactions/{id}/buyer", phase: 3, status: "mock" },
  { method: "PUT", path: "/transactions/{id}/minimum-amount", phase: 3, status: "mock" },
  { method: "POST", path: "/transactions/{id}/declarations", phase: 3, status: "mock" },
  { method: "POST", path: "/transactions/{id}/submit", phase: 3, status: "mock" },
  { method: "GET", path: "/transactions/{id}/verification", phase: 3, status: "mock" },

  { method: "GET", path: "/transactions/{id}/risk", phase: 4, status: "mock" },
  { method: "GET", path: "/admin/risk-models", phase: 4, status: "mock" },
  { method: "POST", path: "/admin/risk-models", phase: 4, status: "mock" },

  { method: "POST", path: "/transactions/{id}/listing", phase: 5, status: "mock" },
  { method: "GET", path: "/transactions/{id}/listing-current", phase: 5, status: "mock", notes: "v3.1.0" },
  { method: "GET", path: "/listings/{id}", phase: 5, status: "mock" },
  { method: "GET", path: "/listings/{id}/offers", phase: 5, status: "mock", notes: "role-split" },
  { method: "GET", path: "/marketplace/eligible", phase: 5, status: "mock" },
  { method: "GET", path: "/marketplace/listings/{id}", phase: 5, status: "mock", notes: "v3.1.0" },
  { method: "GET", path: "/banks/policy-filters", phase: 5, status: "mock" },
  { method: "POST", path: "/banks/policy-filters", phase: 5, status: "mock" },
  { method: "PATCH", path: "/banks/policy-filters/{id}", phase: 5, status: "mock", notes: "v3.1.0" },
  { method: "POST", path: "/listings/{id}/offers/create", phase: 5, status: "mock" },
  { method: "GET", path: "/offers", phase: 5, status: "mock", notes: "v3.1.0" },
  { method: "GET", path: "/offers/{id}", phase: 5, status: "mock" },
  { method: "PATCH", path: "/offers/{id}", phase: 5, status: "mock" },
  { method: "POST", path: "/offers/{id}/approve", phase: 5, status: "mock" },
  { method: "POST", path: "/offers/{id}/withdraw", phase: 5, status: "mock" },

  { method: "POST", path: "/offers/{id}/accept", phase: 6, status: "mock", demoCritical: true },
  { method: "POST", path: "/listings/{id}/reject-all", phase: 6, status: "mock" },
  { method: "POST", path: "/transactions/{id}/contract", phase: 6, status: "mock" },
  { method: "GET", path: "/transactions/{id}/contract", phase: 6, status: "mock" },
  { method: "POST", path: "/contracts/{id}/sign", phase: 6, status: "mock" },
  { method: "GET", path: "/transactions/{id}/conditions", phase: 6, status: "mock" },
  { method: "POST", path: "/conditions/{id}/fulfil", phase: 6, status: "mock" },

  { method: "POST", path: "/transactions/{id}/funding/mark-sent", phase: 7, status: "mock" },
  { method: "POST", path: "/transactions/{id}/funding/otp", phase: 7, status: "mock" },
  { method: "POST", path: "/transactions/{id}/funding/confirm", phase: 7, status: "mock" },
  { method: "GET", path: "/transactions/{id}/settlement", phase: 7, status: "mock" },
  { method: "POST", path: "/settlements/{id}/retry", phase: 7, status: "mock" },

  { method: "GET", path: "/transactions/{id}/payments", phase: 8, status: "mock" },
  { method: "POST", path: "/transactions/{id}/payments", phase: 8, status: "mock" },
  { method: "POST", path: "/transactions/{id}/confirm-status", phase: 8, status: "mock" },
  { method: "POST", path: "/transactions/{id}/close", phase: 8, status: "mock" },
  { method: "POST", path: "/transactions/{id}/recourse", phase: 8, status: "mock", notes: "partly v3.1.0" },
  { method: "GET", path: "/recourse/{id}", phase: 8, status: "mock" },
  { method: "POST", path: "/recourse/{id}/status", phase: 8, status: "mock" },
  { method: "POST", path: "/transactions/{id}/disputes", phase: 8, status: "mock" },
  { method: "POST", path: "/disputes/{id}/resolve", phase: 8, status: "mock" },
  { method: "POST", path: "/offers/{id}/withdrawal-case", phase: 8, status: "mock" },
  { method: "POST", path: "/withdrawal-cases/{id}/decide", phase: 8, status: "mock" },
  { method: "POST", path: "/transactions/{id}/fraud-review", phase: 8, status: "mock" },
  { method: "POST", path: "/fraud-cases/{id}/decide", phase: 8, status: "mock" },
  { method: "GET", path: "/cases", phase: 8, status: "mock", notes: "v3.1.0" },
  { method: "POST", path: "/transactions/{id}/relist-request", phase: 8, status: "mock", notes: "v3.1.0" },
  { method: "POST", path: "/transactions/{id}/cancel", phase: 8, status: "mock", notes: "v3.1.0" },
  { method: "GET", path: "/notifications", phase: 8, status: "mock", notes: "v3.1.0" },
  { method: "POST", path: "/notifications/{id}/read", phase: 8, status: "mock", notes: "v3.1.0" },

  { method: "GET", path: "/admin/settings", phase: 9, status: "mock" },
  { method: "PATCH", path: "/admin/settings", phase: 9, status: "mock" },
  { method: "GET", path: "/admin/commission-tiers", phase: 9, status: "mock" },
  { method: "POST", path: "/admin/commission-tiers", phase: 9, status: "mock" },
  { method: "GET", path: "/admin/audit-logs", phase: 9, status: "mock" },
  { method: "GET", path: "/admin/relisting-requests", phase: 9, status: "mock", notes: "partly v3.1.0" },
  { method: "POST", path: "/demo/time-travel", phase: 9, status: "mock", demoCritical: true },
];

export function endpointKey(method: EndpointStatusEntry["method"], path: string): string {
  return `${method} ${path}`;
}

export function isLive(method: EndpointStatusEntry["method"], path: string): boolean {
  return endpointStatus.find((e) => e.method === method && e.path === path)?.status === "live";
}

export const mockedDemoCriticalEndpoints = endpointStatus.filter(
  (e) => e.demoCritical && e.status === "mock"
);
