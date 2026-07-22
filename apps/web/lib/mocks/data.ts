/**
 * Placeholder mock identities for Phase 1. docs/specs/SEED_DATA.md (owned by
 * Agent A, drafted at Phase 2) is the eventual source of truth for the real
 * 3 banks / 3 suppliers / 6 buyers / 12 invoices identity set — once it
 * exists, replace these ids/names so the mock→live swap is visually
 * diff-able (Master Plan 3.4 #3). Tracked as a NEEDS FROM A in the daily log.
 */
import type { paths } from "@/lib/api/generated/schema";

type AuthMeResponse =
  paths["/auth/me"]["get"]["responses"]["200"]["content"]["application/json"];

export const mockUsers: Record<string, AuthMeResponse> = {
  "supplier-owner": {
    user: {
      id: "00000000-0000-0000-0000-000000000001",
      fullName: "Rania Al-Khatib",
      email: "rania@almashriq-trading.jo",
      phoneNumber: "+962790000001",
      preferredLanguage: "EN",
      mfaEnabled: false,
      status: "ACTIVE",
    },
    memberships: [
      {
        organizationId: "10000000-0000-0000-0000-000000000001",
        organizationName: "Al-Mashriq Trading Co.",
        organizationType: "SUPPLIER",
        roles: ["SUPPLIER_OWNER_ADMIN"],
        isAuthorizedSignatory: true,
      },
    ],
    activeOrganizationId: "10000000-0000-0000-0000-000000000001",
  },
  // Phase 2: two extra supplier personas so the APPROVED_CONDITIONAL and
  // ineligibility screens are directly reachable, rather than only via driving
  // a reviewer decision. Their organizationIds match the fixtures in
  // lib/mocks/onboarding-store.ts.
  "supplier-conditional": {
    user: {
      id: "00000000-0000-0000-0000-000000000004",
      fullName: "Yousef Barakat",
      email: "yousef@aqaba-marine.jo",
      phoneNumber: "+962790000004",
      preferredLanguage: "EN",
      mfaEnabled: false,
      status: "ACTIVE",
    },
    memberships: [
      {
        organizationId: "10000000-0000-0000-0000-000000000004",
        organizationName: "Aqaba Marine Supplies",
        organizationType: "SUPPLIER",
        roles: ["SUPPLIER_OWNER_ADMIN"],
        isAuthorizedSignatory: true,
      },
    ],
    activeOrganizationId: "10000000-0000-0000-0000-000000000004",
  },
  "supplier-ineligible": {
    user: {
      id: "00000000-0000-0000-0000-000000000005",
      fullName: "Huda Zaid",
      email: "huda@madaba-textiles.jo",
      phoneNumber: "+962790000005",
      preferredLanguage: "EN",
      mfaEnabled: false,
      status: "ACTIVE",
    },
    memberships: [
      {
        organizationId: "10000000-0000-0000-0000-000000000005",
        organizationName: "Madaba Textiles Est.",
        organizationType: "SUPPLIER",
        roles: ["SUPPLIER_OWNER_ADMIN"],
        isAuthorizedSignatory: true,
      },
    ],
    activeOrganizationId: "10000000-0000-0000-0000-000000000005",
  },
  "bank-admin": {
    user: {
      id: "00000000-0000-0000-0000-000000000002",
      fullName: "Omar Haddad",
      email: "omar.haddad@jordanfirstbank.jo",
      phoneNumber: "+962790000002",
      preferredLanguage: "EN",
      mfaEnabled: true,
      status: "ACTIVE",
    },
    memberships: [
      {
        organizationId: "20000000-0000-0000-0000-000000000001",
        organizationName: "Jordan First Bank",
        organizationType: "BANK",
        roles: ["BANK_ADMIN", "OFFER_APPROVER"],
        isAuthorizedSignatory: true,
      },
    ],
    activeOrganizationId: "20000000-0000-0000-0000-000000000001",
  },
  "platform-admin": {
    user: {
      id: "00000000-0000-0000-0000-000000000003",
      fullName: "Lina Nasser",
      email: "lina.nasser@zimmamless.jo",
      phoneNumber: "+962790000003",
      preferredLanguage: "EN",
      mfaEnabled: true,
      status: "ACTIVE",
    },
    memberships: [
      {
        organizationId: "30000000-0000-0000-0000-000000000001",
        organizationName: "Zimmamless Platform",
        organizationType: "PLATFORM",
        roles: ["SUPER_ADMIN", "PLATFORM_SUPPLIER_REVIEWER"],
        isAuthorizedSignatory: false,
      },
    ],
    activeOrganizationId: "30000000-0000-0000-0000-000000000001",
    demo: { timeMachineEnabled: true, currentOffsetDays: 0 },
  },
};

export const MOCK_SESSION_COOKIE = "zm_mock_persona";
export type MockPersonaKey = keyof typeof mockUsers;
