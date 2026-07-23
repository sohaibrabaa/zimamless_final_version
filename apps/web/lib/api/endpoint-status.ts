/**
 * Per-endpoint mock/live promotion map — the code-level source of truth
 * mirrored (manually, on every change) to docs/coordination/ENDPOINT_STATUS.md
 * per Master Plan 3.4 #2. `lib/mocks/handlers.ts` reads this map and calls
 * MSW's passthrough() for `live` entries, so flipping one here genuinely
 * routes to the deployed API; every other entry stays mocked.
 *
 * Flip an entry to "live" only after the endpoint is recorded LIVE in
 * docs/coordination/DAILY_LOG.md AND the consuming screen has been
 * smoke-tested the same day (Master Plan 3.4 #4).
 *
 * The two-agent split that this rule was written for is retired — one engineer
 * now owns both sides — but the rule itself is not. Passing an integration test
 * proves the endpoint; it does not prove the screen that consumes it.
 *
 * `apps/web/test/live/` is what satisfies the second half: it renders the real
 * component against the real API over a real JWT (`npm run test:live`). An
 * entry moves to "live" when a test there covers it, and the note records
 * which file. Everything still reading "mock" is mocked because nothing has
 * exercised it that way yet — never because it is assumed to work.
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
  // /health is intentionally absent: it is served outside the /v1 prefix,
  // excluded from the frozen contract and from /docs-json, and so is not in
  // the generated client. It is infrastructure, not a contract endpoint, and
  // listing it here implied a promotion path it does not have.
  { method: "GET", path: "/auth/me", phase: 1, status: "live", notes: "demo flag (D-10) included. Promoted 2026-07-23 on test/live/transactions.live.spec.tsx — rendered through the real SessionProvider; activeOrganizationId is echoed only when the header names a real membership, which is the Phase 1 circularity bug" },
  { method: "POST", path: "/auth/context", phase: 1, status: "mock" },
  { method: "PATCH", path: "/auth/language", phase: 1, status: "mock" },

  { method: "POST", path: "/onboarding/register", phase: 2, status: "mock", notes: "v3.1.0 · supplier bootstrap form" },
  { method: "GET", path: "/onboarding/applications-list", phase: 2, status: "mock", notes: "v3.1.0 · supplier onboarding home + reviewer queue" },
  { method: "POST", path: "/onboarding/applications", phase: 2, status: "mock", notes: "no screen consumes it — bootstrap (D-04) covers the supplier path" },
  { method: "GET", path: "/onboarding/applications/{id}", phase: 2, status: "mock", notes: "reviewer application detail" },
  { method: "POST", path: "/onboarding/applications/{id}/submit", phase: 2, status: "mock", notes: "wizard step 4" },
  { method: "POST", path: "/onboarding/applications/{id}/bank-account", phase: 2, status: "mock", notes: "wizard step 4" },
  { method: "POST", path: "/onboarding/applications/{id}/consents", phase: 2, status: "mock", notes: "wizard step 3 · consent catalogue provisional (Q-09)" },
  { method: "GET", path: "/onboarding/applications/{id}/information-requests", phase: 2, status: "mock", notes: "info-request inbox (both portals)" },
  { method: "POST", path: "/onboarding/applications/{id}/respond", phase: 2, status: "mock", notes: "supplier response form" },
  { method: "POST", path: "/onboarding/applications/{id}/decide", phase: 2, status: "mock", notes: "reviewer decision form · reason-code catalogue provisional (Q-06)" },
  { method: "POST", path: "/government/lookup", phase: 2, status: "mock", notes: "handler exists; no screen triggers a manual lookup yet" },
  { method: "GET", path: "/government/requests/{id}", phase: 2, status: "mock", notes: "handler exists; source panel reads the application's list instead (Q-08)" },

  { method: "GET", path: "/buyers/search", phase: 3, status: "mock", notes: "wizard step 1 · candidate list, never pre-selected (ZM-BUY-009)" },
  { method: "POST", path: "/buyers/resolve", phase: 3, status: "mock", notes: "wizard step 1 · 409 BUYER_BLOCKED renders the blocked-buyer reason" },
  { method: "GET", path: "/buyers/{id}", phase: 3, status: "mock", notes: "handler exists; screens read the buyer off the transaction instead" },
  { method: "POST", path: "/documents/upload-url", phase: 3, status: "mock", notes: "wizard steps 2 and 3 · byte upload is skipped under MSW by design" },
  { method: "GET", path: "/documents/{id}/download-url", phase: 3, status: "mock", notes: "transaction detail · download link per attachment (Q-12 resolved). Requested on click, not on render — the URL lives ~2 minutes" },
  { method: "GET", path: "/documents/{id}/extraction", phase: 3, status: "mock", notes: "wizard step 2 · OCR/QR pre-fill and mismatch table" },
  { method: "GET", path: "/transactions", phase: 3, status: "live", notes: "supplier transaction list. Promoted 2026-07-23 — real rows rendered through useTransactionList inside the real SessionProvider, scoped server-side by the derived X-Organization-Id" },
  { method: "POST", path: "/transactions", phase: 3, status: "mock", notes: "wizard entry — creates the draft" },
  { method: "GET", path: "/transactions/{id}", phase: 3, status: "mock", notes: "transaction detail · floor stripped for bank callers" },
  { method: "PUT", path: "/transactions/{id}/invoice", phase: 3, status: "mock", notes: "wizard step 2" },
  { method: "PUT", path: "/transactions/{id}/buyer", phase: 3, status: "mock", notes: "wizard step 1" },
  { method: "PUT", path: "/transactions/{id}/minimum-amount", phase: 3, status: "mock", notes: "wizard step 4" },
  { method: "POST", path: "/transactions/{id}/declarations", phase: 3, status: "mock", notes: "wizard step 5 · template version \"1.0\", now server-validated against a catalogue (Q-13 resolved)" },
  { method: "POST", path: "/transactions/{id}/submit", phase: 3, status: "mock", notes: "wizard step 6 · 409 duplicate → blocked screen, reference is details.reviewReference (Q-11 resolved)" },
  { method: "GET", path: "/transactions/{id}/verification", phase: 3, status: "mock", notes: "verification panel on the transaction detail" },

  { method: "GET", path: "/transactions/{id}/risk", phase: 4, status: "mock", notes: "TrustScoreGauge/ComponentBars/FactorList on the supplier transaction detail and the bank underwriting view" },
  { method: "GET", path: "/admin/risk-models", phase: 4, status: "mock", notes: "handler not implemented — no admin screen this session, not B's Phase 4 scope" },
  { method: "POST", path: "/admin/risk-models", phase: 4, status: "mock", notes: "handler not implemented — no admin screen this session, not B's Phase 4 scope" },

  { method: "POST", path: "/transactions/{id}/listing", phase: 5, status: "mock", notes: "supplier listing-activation screen · requires a real ELIGIBLE transaction, moves it to OPEN_FOR_OFFERS" },
  { method: "GET", path: "/transactions/{id}/listing-current", phase: 5, status: "mock", notes: "v3.1.0 · supplier listing-activation screen + offer comparison screen" },
  { method: "GET", path: "/listings/{id}", phase: 5, status: "mock" },
  { method: "GET", path: "/listings/{id}/offers", phase: 5, status: "mock", notes: "role-split · offer comparison screen (supplier) and own-offer check (bank)" },
  { method: "GET", path: "/marketplace/eligible", phase: 5, status: "mock", notes: "bank marketplace feed · real per-bank policy-filter eligibility (ZM-MKT-002)" },
  { method: "GET", path: "/marketplace/listings/{id}", phase: 5, status: "mock", notes: "v3.1.0 · bank underwriting view, incl. the Phase 4 risk components" },
  { method: "GET", path: "/banks/policy-filters", phase: 5, status: "mock", notes: "policy-filter configuration screen" },
  { method: "POST", path: "/banks/policy-filters", phase: 5, status: "mock" },
  { method: "PATCH", path: "/banks/policy-filters/{id}", phase: 5, status: "mock", notes: "v3.1.0 · edit/deactivate (D-12)" },
  { method: "POST", path: "/listings/{id}/offers/create", phase: 5, status: "mock", notes: "offer form · server-computed commission/listing fee, floor check with generic rejection (ZM-MKT-012)" },
  { method: "GET", path: "/offers", phase: 5, status: "mock", notes: "v3.1.0 · my offers + approval queue (status filter)" },
  { method: "GET", path: "/offers/{id}", phase: 5, status: "mock", notes: "bank offer status detail" },
  { method: "PATCH", path: "/offers/{id}", phase: 5, status: "mock", notes: "offer revision, new version, prior retained immutably" },
  { method: "POST", path: "/offers/{id}/approve", phase: 5, status: "mock", notes: "approval queue · rejects self-approval server-side (SELF_APPROVAL_FORBIDDEN)" },
  { method: "POST", path: "/offers/{id}/withdraw", phase: 5, status: "mock", notes: "my offers · pre-acceptance, no penalty" },

  { method: "POST", path: "/offers/{id}/accept", phase: 6, status: "mock", demoCritical: true, notes: "acceptance modal · atomic-in-memory, idempotency-key replay-safe, ZM-SEL-001..008 enforced in marketplace-store.ts" },
  { method: "POST", path: "/listings/{id}/reject-all", phase: 6, status: "mock", notes: "reject-all flow on the offer comparison screen" },
  { method: "POST", path: "/transactions/{id}/contract", phase: 6, status: "mock", notes: "contract review screen · generate, gated by ZM-CON-006 pre-contract checks" },
  { method: "GET", path: "/transactions/{id}/contract", phase: 6, status: "mock", notes: "contract review screens (both portals)" },
  { method: "POST", path: "/contracts/{id}/sign", phase: 6, status: "mock", notes: "click-to-accept signing · FULLY_SIGNED only once both sides sign (ZM-CON-012)" },
  { method: "GET", path: "/transactions/{id}/conditions", phase: 6, status: "mock", notes: "conditions checklist" },
  { method: "POST", path: "/conditions/{id}/fulfil", phase: 6, status: "mock", notes: "conditions checklist · fulfil action" },

  { method: "POST", path: "/transactions/{id}/funding/mark-sent", phase: 7, status: "mock" },
  { method: "POST", path: "/transactions/{id}/funding/otp", phase: 7, status: "mock" },
  { method: "POST", path: "/transactions/{id}/funding/confirm", phase: 7, status: "mock" },
  { method: "GET", path: "/transactions/{id}/settlement", phase: 7, status: "mock" },
  { method: "POST", path: "/settlements/{id}/retry", phase: 7, status: "mock" },

  { method: "GET", path: "/transactions/{id}/payments", phase: 8, status: "live", notes: "Promoted 2026-07-23 on test/live/payments.live.spec.tsx — a real OVERDUE_UNCONFIRMED transaction rendered through PaymentTimeline in EN and AR. Derived balance (D-13); supplier payload has NO bankInternalNotes/evidence/reportedBy, asserted live" },
  { method: "POST", path: "/transactions/{id}/payments", phase: 8, status: "mock", notes: "derived balance (D-13); supplier payload has NO bankInternalNotes/evidence/reportedBy" },
  { method: "POST", path: "/transactions/{id}/confirm-status", phase: 8, status: "mock", notes: "the ONLY route to OVERDUE. 422 if PAID while a balance remains" },
  { method: "POST", path: "/transactions/{id}/close", phase: 8, status: "mock", notes: "idempotent; a second close keeps the original reason" },
  { method: "POST", path: "/transactions/{id}/recourse", phase: 8, status: "mock", notes: "v3.1.0 · BANK ONLY — a platform admin gets 403. Requires a CONFIRMED overdue; claim capped at the advance" },
  { method: "GET", path: "/recourse/{id}", phase: 8, status: "mock" },
  { method: "POST", path: "/recourse/{id}/status", phase: 8, status: "mock", notes: "a supplier may only move it to DISPUTED; SETTLED refused while a balance remains" },
  { method: "POST", path: "/transactions/{id}/disputes", phase: 8, status: "mock", notes: "pauses the maturity job entirely while open" },
  { method: "POST", path: "/disputes/{id}/resolve", phase: 8, status: "mock", notes: "records what the parties agreed; the platform does not adjudicate. resolutionNotes mandatory" },
  { method: "POST", path: "/offers/{id}/withdrawal-case", phase: 8, status: "mock", notes: "penalty RECORDED, never deducted (LT-12). applicable:null means a human decides" },
  { method: "POST", path: "/withdrawal-cases/{id}/decide", phase: 8, status: "mock", notes: "platform only; takes penaltyApplicable verbatim. Raises a REQUESTED relisting, not approved" },
  { method: "POST", path: "/transactions/{id}/fraud-review", phase: 8, status: "mock", notes: "freezes and concludes nothing; compliance is notified" },
  { method: "POST", path: "/fraud-cases/{id}/decide", phase: 8, status: "mock", notes: "compliance only (ZM-FRD-004) — the only confirmed status in the system" },
  { method: "GET", path: "/cases", phase: 8, status: "live", notes: "v3.1.0 · fraud cases EXCLUDED for a bank or supplier, not redacted — asserted live against real bank and supplier tokens. Promoted 2026-07-23 on test/live/cases.live.spec.tsx" },
  { method: "GET", path: "/admin/relisting-requests", phase: 8, status: "live", notes: "v3.1.0 · platform only. No screen consumes it yet — the ZM-REC-018 review desk is Phase 9, alongside POST approve. The seven checks report null when unrecorded, never omitted" },
  { method: "POST", path: "/transactions/{id}/relist-request", phase: 8, status: "mock", notes: "v3.1.0" },
  { method: "POST", path: "/transactions/{id}/cancel", phase: 8, status: "mock", notes: "v3.1.0" },
  { method: "GET", path: "/notifications", phase: 8, status: "live", notes: "v3.1.0 · scoped to recipient_user_id alone; no destination or gateway reference returned. Promoted 2026-07-23 on test/live/inbox.live.spec.tsx" },
  { method: "POST", path: "/notifications/{id}/manual-call", phase: 8, status: "mock", notes: "D-16 (Q-17) · additive. Platform staff incl. compliance. No screen consumes it yet — the operator call-log UI is Phase 9. Blank notes refused; previous notes kept in the audit entry" },
  { method: "POST", path: "/notifications/{id}/read", phase: 8, status: "live", notes: "v3.1.0 · sets DELIVERED — the only delivery the platform can honestly observe. Promoted 2026-07-23; 404 (not 403) for another user's notification asserted live" },

  { method: "GET", path: "/admin/settings", phase: 9, status: "mock" },
  { method: "PATCH", path: "/admin/settings", phase: 9, status: "mock" },
  { method: "GET", path: "/admin/commission-tiers", phase: 9, status: "mock" },
  { method: "POST", path: "/admin/commission-tiers", phase: 9, status: "mock" },
  { method: "GET", path: "/admin/audit-logs", phase: 9, status: "mock" },
  // GET /admin/relisting-requests was listed here as Phase 9 and is now served
  // and promoted under Phase 8 above. The duplicate is removed rather than
  // left: `isLive` takes the first match, so two rows for one endpoint means
  // editing the wrong one changes nothing and looks like it should.
  { method: "POST", path: "/admin/relisting-requests/{id}/approve", phase: 9, status: "mock", notes: "not served — the ZM-REC-018 review desk decides these, Phase 9" },
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
