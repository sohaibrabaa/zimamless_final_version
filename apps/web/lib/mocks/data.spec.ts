import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mockUsers, mockBuyers, ORG } from "./data";

/**
 * Fixture ↔ seed parity.
 *
 * The shared identity list only pays off if these fixtures really are the
 * seeded people. Phase 1 shipped with entirely invented names, org ids and —
 * worst of all — role strings, which the contract types as plain `string[]`,
 * so nothing failed until a screen met the live API. This test is the thing
 * that would have caught it: it reads the seed SQL and asserts every value a
 * fixture claims actually appears there.
 */

const repoRoot = join(__dirname, "..", "..", "..", "..");
const seedSql = readFileSync(join(repoRoot, "db/seed/0100_seed_dev.sql"), "utf8");

describe("mock fixtures match the database seed", () => {
  it("uses organization ids that exist in the seed", () => {
    for (const [slug, id] of Object.entries(ORG)) {
      expect(seedSql, `organization ${slug}`).toContain(id);
    }
  });

  it("uses user ids, names and emails that exist in the seed", () => {
    for (const [persona, me] of Object.entries(mockUsers)) {
      expect(seedSql, `${persona} id`).toContain(me.user.id!);
      expect(seedSql, `${persona} name`).toContain(me.user.fullName!);
      expect(seedSql, `${persona} email`).toContain(me.user.email!);
    }
  });

  it("uses role strings the seed actually grants", () => {
    const granted = new Set(seedSql.match(/'[A-Z]+_[A-Z_]+'/g)?.map((m) => m.slice(1, -1)) ?? []);
    for (const [persona, me] of Object.entries(mockUsers)) {
      for (const membership of me.memberships) {
        for (const role of membership.roles ?? []) {
          expect(granted, `${persona} holds ${role}`).toContain(role);
        }
      }
    }
  });

  it("keeps the multi-membership persona that makes the org switcher reachable", () => {
    // Without two memberships OrgSwitcher never renders, so POST
    // /auth/context is unreachable from the UI — and switching context is a
    // Phase 1 checkpoint item.
    const multi = Object.values(mockUsers).filter((u) => u.memberships.length >= 2);
    expect(multi.length).toBeGreaterThan(0);
  });

  it("covers both banks so cross-bank isolation has a counterparty", () => {
    const bankOrgs = new Set(
      Object.values(mockUsers)
        .flatMap((u) => u.memberships)
        .filter((m) => m.organizationType === "BANK")
        .map((m) => m.organizationId)
    );
    expect(bankOrgs.size).toBeGreaterThanOrEqual(2);
  });

  it("carries the three blocked buyer statuses the block-state screens need", () => {
    const statuses = new Set(mockBuyers.map((b) => b.registryStatus));
    expect(statuses).toContain("SUSPENDED");
    expect(statuses).toContain("STRUCK_OFF");
    expect(statuses).toContain("UNDER_LIQUIDATION");
    for (const buyer of mockBuyers) {
      expect(seedSql, `buyer ${buyer.legalCompanyName}`).toContain(buyer.nationalEstablishmentNo);
    }
  });
});
