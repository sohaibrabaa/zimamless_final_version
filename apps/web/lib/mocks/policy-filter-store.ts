/**
 * Per-bank policy filter store backing `/banks/policy-filters` (GET/POST) and
 * `/banks/policy-filters/{id}` (PATCH — v3.1.0's edit/deactivate, D-12).
 *
 * JNB (K1) and LCB (K2) each get one seeded, permissive-but-real filter so
 * the marketplace feed has content the first time either bank persona opens
 * it, and so the checkpoint's two-bank scenario (maker at K1 creates and
 * gets approved, K2 makes a competing offer) doesn't first require a trip
 * through this screen. Editing/deactivating either is exactly this phase's
 * screen, exercised on real seeded rows rather than only on freshly created
 * ones.
 */
import type { PolicyFilterRecord } from "@/lib/marketplace/policy-filters";
import { ORG } from "./data";

let sequence = 0;
function nextId(): string {
  sequence += 1;
  return `0ef90000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function seed(): PolicyFilterRecord[] {
  return [
    {
      id: "0ef90000-0000-4000-8000-000000000001",
      bankOrganizationId: ORG.jnb,
      name: "Standard JOD invoice financing",
      isActive: true,
      minAmount: "1000.000",
      maxTenorDays: 120,
      minTrustScore: 40,
      maxRiskBand: "HIGH",
    },
    {
      id: "0ef90000-0000-4000-8000-000000000002",
      bankOrganizationId: ORG.lcb,
      name: "Broad appetite",
      isActive: true,
      minAmount: "500.000",
      maxRiskBand: "CRITICAL",
    },
  ];
}

let filters: PolicyFilterRecord[] = seed();

export function listFilters(bankOrganizationId: string): PolicyFilterRecord[] {
  return filters.filter((f) => f.bankOrganizationId === bankOrganizationId);
}

export function listActiveBankOrganizationIds(): string[] {
  return [...new Set(filters.filter((f) => f.isActive).map((f) => f.bankOrganizationId))];
}

export function findFilter(id: string): PolicyFilterRecord | undefined {
  return filters.find((f) => f.id === id);
}

/** The single active filter this bank uses for eligibility evaluation (first active one, if several). */
export function activeFilterFor(bankOrganizationId: string): PolicyFilterRecord | undefined {
  return filters.find((f) => f.bankOrganizationId === bankOrganizationId && f.isActive);
}

export function createFilter(
  bankOrganizationId: string,
  input: Omit<PolicyFilterRecord, "id" | "bankOrganizationId">
): PolicyFilterRecord {
  const record: PolicyFilterRecord = { ...input, id: nextId(), bankOrganizationId };
  filters = [...filters, record];
  return record;
}

export function updateFilter(
  id: string,
  bankOrganizationId: string,
  patch: Partial<Omit<PolicyFilterRecord, "id" | "bankOrganizationId">>
): PolicyFilterRecord | undefined {
  const filter = filters.find((f) => f.id === id && f.bankOrganizationId === bankOrganizationId);
  if (!filter) return undefined;
  Object.assign(filter, patch);
  return filter;
}

export function resetPolicyFilterMocks() {
  filters = seed();
  sequence = 0;
}
