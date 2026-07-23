export type Portal = "supplier" | "bank" | "platform";

const PORTAL_BY_ORG_TYPE: Record<string, Portal> = {
  SUPPLIER: "supplier",
  BANK: "bank",
  PLATFORM: "platform",
};

export function portalForOrgType(orgType: string | undefined): Portal | undefined {
  return orgType ? PORTAL_BY_ORG_TYPE[orgType] : undefined;
}

export interface NavItem {
  href: string;
  labelKey: string;
}

// Per brief §3 layout. Screens beyond "dashboard" are stubbed through
// later phases (Phase 2 onboarding, Phase 3 invoices, ...); each route
// still needs to exist so nav links resolve instead of 404ing.
export const portalNav: Record<Portal, NavItem[]> = {
  supplier: [
    { href: "dashboard", labelKey: "nav.dashboard" },
    { href: "onboarding", labelKey: "nav.onboarding" },
    { href: "invoices", labelKey: "nav.invoices" },
    { href: "offers", labelKey: "nav.offers" },
    { href: "contracts", labelKey: "nav.contracts" },
    { href: "funding", labelKey: "nav.funding" },
    { href: "payments", labelKey: "nav.payments" },
    { href: "notifications", labelKey: "nav.notifications" },
  ],
  bank: [
    { href: "dashboard", labelKey: "nav.dashboard" },
    { href: "marketplace", labelKey: "nav.marketplace" },
    { href: "listings", labelKey: "nav.listings" },
    { href: "offers", labelKey: "nav.offers" },
    { href: "funding", labelKey: "nav.funding" },
    { href: "payments", labelKey: "nav.payments" },
    { href: "notifications", labelKey: "nav.notifications" },
    { href: "recourse", labelKey: "nav.recourse" },
    { href: "settings/policy-filters", labelKey: "nav.policyFilters" },
  ],
  platform: [
    { href: "dashboard", labelKey: "nav.dashboard" },
    { href: "applications", labelKey: "nav.applications" },
    { href: "transactions", labelKey: "nav.transactions" },
    { href: "cases", labelKey: "nav.cases" },
    { href: "notifications", labelKey: "nav.notifications" },
    { href: "settings", labelKey: "nav.settings" },
    { href: "audit", labelKey: "nav.audit" },
  ],
};
