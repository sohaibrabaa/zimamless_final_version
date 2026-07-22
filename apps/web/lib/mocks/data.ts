/**
 * Mock identities — the same people, organizations, ids and roles that
 * `db/seed/0100_seed_dev.sql` writes, per `docs/specs/GOV_DUMMY_DATA.md`.
 *
 * The point of the shared identity list (Master Plan 3.4 §3) is that a
 * screen shows the same names and numbers a minute after an endpoint is
 * flipped from mock to live. Any difference is then a real bug rather than a
 * fixture mismatch — which only works if these values are copied, not
 * invented. Role strings especially: the contract types `roles` as
 * `string[]`, so a divergence here is silent until it breaks against the
 * live API.
 *
 * Identities are frozen from Phase 2 (GOV_DUMMY_DATA.md §intro). Adding a
 * persona is fine; renaming or renumbering one breaks the seed diff.
 */
import type { paths } from "@/lib/api/generated/schema";

type AuthMeResponse =
  paths["/auth/me"]["get"]["responses"]["200"]["content"]["application/json"];

/** Organization ids, verbatim from the seed. */
export const ORG = {
  platform: "0e000000-0000-4000-8000-000000000001",
  alnoor: "0e000000-0000-4000-8000-000000000002",
  petra: "0e000000-0000-4000-8000-000000000003",
  jnb: "0e000000-0000-4000-8000-000000000004",
  lcb: "0e000000-0000-4000-8000-000000000005",
  cib: "0e000000-0000-4000-8000-000000000006",
} as const;

export const mockUsers: Record<string, AuthMeResponse> = {
  // S1 Al-Noor — the demo's protagonist (Master Plan 6.2).
  "supplier-owner": {
    user: {
      id: "0e100000-0000-4000-8000-000000000001",
      fullName: "Rania Haddad",
      email: "owner@alnoor.zimmamless.test",
      phoneNumber: "+962790000101",
      preferredLanguage: "EN",
      mfaEnabled: false,
      status: "ACTIVE",
    },
    memberships: [
      {
        organizationId: ORG.alnoor,
        organizationName: "Al-Noor Trading Company",
        organizationType: "SUPPLIER",
        roles: ["SUPPLIER_OWNER", "SUPPLIER_SIGNATORY"],
        isAuthorizedSignatory: true,
      },
    ],
    activeOrganizationId: ORG.alnoor,
  },
  "supplier-uploader": {
    user: {
      id: "0e100000-0000-4000-8000-000000000002",
      fullName: "Omar Khalil",
      email: "uploader@alnoor.zimmamless.test",
      phoneNumber: "+962790000102",
      preferredLanguage: "EN",
      mfaEnabled: false,
      status: "ACTIVE",
    },
    memberships: [
      {
        organizationId: ORG.alnoor,
        organizationName: "Al-Noor Trading Company",
        organizationType: "SUPPLIER",
        roles: ["SUPPLIER_UPLOADER"],
        isAuthorizedSignatory: false,
      },
    ],
    activeOrganizationId: ORG.alnoor,
  },

  // K1 Jordan National Bank. Maker and approver are different people at
  // every bank — ZM-ROL-002 separation is a DB CHECK, not just a UI rule.
  "bank-admin": {
    user: {
      id: "0e100000-0000-4000-8000-000000000004",
      fullName: "Layla Mansour",
      email: "admin@jnb.zimmamless.test",
      phoneNumber: "+962790000301",
      preferredLanguage: "EN",
      mfaEnabled: true,
      status: "ACTIVE",
    },
    memberships: [
      {
        organizationId: ORG.jnb,
        organizationName: "Jordan National Bank",
        organizationType: "BANK",
        roles: ["BANK_ADMIN"],
        isAuthorizedSignatory: true,
      },
    ],
    activeOrganizationId: ORG.jnb,
  },
  "bank-maker": {
    user: {
      id: "0e100000-0000-4000-8000-000000000005",
      fullName: "Tariq Odeh",
      email: "maker@jnb.zimmamless.test",
      phoneNumber: "+962790000302",
      preferredLanguage: "EN",
      mfaEnabled: false,
      status: "ACTIVE",
    },
    memberships: [
      {
        organizationId: ORG.jnb,
        organizationName: "Jordan National Bank",
        organizationType: "BANK",
        roles: ["BANK_OFFER_MAKER", "BANK_ANALYST"],
        isAuthorizedSignatory: false,
      },
    ],
    activeOrganizationId: ORG.jnb,
  },
  "bank-approver": {
    user: {
      id: "0e100000-0000-4000-8000-000000000006",
      fullName: "Nadia Rifai",
      email: "approver@jnb.zimmamless.test",
      phoneNumber: "+962790000303",
      preferredLanguage: "EN",
      mfaEnabled: true,
      status: "ACTIVE",
    },
    memberships: [
      {
        organizationId: ORG.jnb,
        organizationName: "Jordan National Bank",
        organizationType: "BANK",
        roles: ["BANK_OFFER_APPROVER"],
        isAuthorizedSignatory: false,
      },
    ],
    activeOrganizationId: ORG.jnb,
  },
  // K2 exists so INV-11 (bank A cannot see bank B) has a counterparty in the
  // mock world too, not only in the RLS suite.
  "bank-maker-lcb": {
    user: {
      id: "0e100000-0000-4000-8000-000000000008",
      fullName: "Huda Salameh",
      email: "maker@lcb.zimmamless.test",
      phoneNumber: "+962790000305",
      preferredLanguage: "EN",
      mfaEnabled: false,
      status: "ACTIVE",
    },
    memberships: [
      {
        organizationId: ORG.lcb,
        organizationName: "Levant Commercial Bank",
        organizationType: "BANK",
        roles: ["BANK_OFFER_MAKER"],
        isAuthorizedSignatory: false,
      },
    ],
    activeOrganizationId: ORG.lcb,
  },

  "platform-admin": {
    user: {
      id: "0e100000-0000-4000-8000-00000000000c",
      fullName: "Zaid Qasem",
      email: "admin@platform.zimmamless.test",
      phoneNumber: "+962790000001",
      preferredLanguage: "EN",
      mfaEnabled: true,
      status: "ACTIVE",
    },
    memberships: [
      {
        organizationId: ORG.platform,
        organizationName: "Zimmamless Platform",
        organizationType: "PLATFORM",
        roles: ["PLATFORM_SUPER_ADMIN", "PLATFORM_OPS_ADMIN"],
        isAuthorizedSignatory: false,
      },
    ],
    activeOrganizationId: ORG.platform,
    demo: { timeMachineEnabled: true, currentOffsetDays: 0 },
  },

  // The only role `POST /onboarding/applications/{id}/decide` accepts
  // (contract: "Reviewer decision (PLATFORM_SUPPLIER_REVIEWER)"). The
  // platform-admin persona above holds PLATFORM_SUPER_ADMIN, which is not
  // the same grant — without this persona the Phase 2 review queue could
  // only be read, never acted on. Seeded: db/seed/0100_seed_dev.sql L171.
  "platform-reviewer": {
    user: {
      id: "0e100000-0000-4000-8000-00000000000d",
      fullName: "Maha Darwish",
      email: "reviewer@platform.zimmamless.test",
      phoneNumber: "+962790000002",
      preferredLanguage: "EN",
      mfaEnabled: true,
      status: "ACTIVE",
    },
    memberships: [
      {
        organizationId: ORG.platform,
        organizationName: "Zimmamless Platform",
        organizationType: "PLATFORM",
        roles: ["PLATFORM_SUPPLIER_REVIEWER"],
        isAuthorizedSignatory: false,
      },
    ],
    activeOrganizationId: ORG.platform,
  },

  // Two memberships, one user. Without this persona OrgSwitcher never
  // renders and POST /auth/context is unreachable from the UI — and the
  // org-switch flow is a Phase 1 checkpoint item.
  "multi-org": {
    user: {
      id: "0e100000-0000-4000-8000-00000000000f",
      fullName: "Sara Yaseen",
      email: "multi@platform.zimmamless.test",
      phoneNumber: "+962790000004",
      preferredLanguage: "EN",
      mfaEnabled: false,
      status: "ACTIVE",
    },
    memberships: [
      {
        organizationId: ORG.platform,
        organizationName: "Zimmamless Platform",
        organizationType: "PLATFORM",
        roles: ["PLATFORM_SUPPORT"],
        isAuthorizedSignatory: false,
      },
      {
        organizationId: ORG.petra,
        organizationName: "Petra Industrial Supplies",
        organizationType: "SUPPLIER",
        roles: ["SUPPLIER_VIEWER"],
        isAuthorizedSignatory: false,
      },
    ],
    activeOrganizationId: ORG.platform,
  },
};

/**
 * Buyers are registry records, never platform users. B4–B6 carry the three
 * blocked registry statuses so the block-state screens (ZM-BUY 409s) can be
 * built without waiting for Phase 3.
 */
export const mockBuyers = [
  {
    id: "0e300000-0000-4000-8000-000000000001",
    nationalEstablishmentNo: "30000201",
    legalCompanyName: "Amman Retail Group",
    registryStatus: "ACTIVE",
    governorate: "Amman",
  },
  {
    id: "0e300000-0000-4000-8000-000000000002",
    nationalEstablishmentNo: "30000202",
    legalCompanyName: "Levant Construction Co.",
    registryStatus: "ACTIVE",
    governorate: "Amman",
  },
  {
    id: "0e300000-0000-4000-8000-000000000003",
    nationalEstablishmentNo: "30000203",
    legalCompanyName: "Aqaba Logistics Ltd",
    registryStatus: "ACTIVE",
    governorate: "Aqaba",
  },
  {
    id: "0e300000-0000-4000-8000-000000000004",
    nationalEstablishmentNo: "30000204",
    legalCompanyName: "Northern Textiles",
    registryStatus: "SUSPENDED",
    governorate: "Irbid",
  },
  {
    id: "0e300000-0000-4000-8000-000000000005",
    nationalEstablishmentNo: "30000205",
    legalCompanyName: "Desert Rose Trading",
    registryStatus: "STRUCK_OFF",
    governorate: "Amman",
  },
  {
    id: "0e300000-0000-4000-8000-000000000006",
    nationalEstablishmentNo: "30000206",
    legalCompanyName: "Capital Medical Supplies",
    registryStatus: "UNDER_LIQUIDATION",
    governorate: "Zarqa",
  },
] as const;

/**
 * Establishment numbers that make the dummy government adapter misbehave
 * deterministically (GOV_DUMMY_DATA.md §5). Listed here so mock screens can
 * offer them; the adapter itself is Agent A's, from Phase 2.
 */
export const FAILURE_INJECTION_KEYS = {
  "90000001": "UNAVAILABLE — source down, drives the SLA pause (INV-9)",
  "90000002": "NOT_FOUND — adverse but answered; not the same as unavailable",
  "90000003": "PARTIAL — half the fields, dataAvailabilityPct below 100",
  "90000004": "ERROR — HTTP 500 from the source",
  "90000005": "Success after a 6-second delay — timeout handling",
} as const;

export const MOCK_SESSION_COOKIE = "zm_mock_persona";
export type MockPersonaKey = keyof typeof mockUsers;
