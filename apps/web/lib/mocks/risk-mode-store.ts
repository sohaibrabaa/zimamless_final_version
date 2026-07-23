// Dev convenience only, same pattern as persona-store.ts: lets the Phase 4
// checkpoint's first drill ("stop the ML container → recompute → rules-only
// score with a visible degraded flag", ZM-RSK-017) be demonstrated against
// MSW without a real ML service to actually stop. Read only when
// NEXT_PUBLIC_API_MOCKING is enabled.
//
// MSW's browser-mode resolvers run in the page's own JS realm (the service
// worker only relays the fetch event; matching and resolving happen on the
// main thread), so `lib/mocks/handlers.ts` reads this directly rather than
// through a header the way the persona picker does — there is no
// server-side counterpart for this flag to eventually replace, unlike the
// persona header, so a header here would be plumbing with no live analogue.
const STORAGE_KEY = "zm_mock_ml_mode";

export type RiskMode = "ml" | "rules-only";

export function getStoredRiskMode(): RiskMode {
  if (typeof window === "undefined") return "ml";
  return window.localStorage.getItem(STORAGE_KEY) === "rules-only" ? "rules-only" : "ml";
}

export function setStoredRiskMode(mode: RiskMode) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, mode);
  window.dispatchEvent(new CustomEvent("zm:risk-mode-changed"));
}
