/**
 * A small, self-contained seed for the Phase 5 head-start screens (marketplace
 * feed, bank underwriting view). This is deliberately **not** wired to the
 * Phase 3 transaction store: real listing activation
 * (`POST /transactions/{id}/listing`) — the fee obligation, the per-bank
 * eligibility evaluation, the deadline jobs — is Agent A's Phase 5 task and is
 * not built here. Two static listings exist so the two screens have real
 * content to render; the actual "supplier submits → listing activates → bank
 * sees it" pipeline is Phase 5's real deliverable, not this one.
 *
 * Identities are copied from the frozen lists (`GOV_DUMMY_DATA.md`,
 * `db/seed/0100_seed_dev.sql`) rather than invented, same discipline as every
 * other mock fixture in this codebase.
 */

import { computeRiskAssessment, type RiskInputs } from "@/lib/risk/risk-engine";
import type { components } from "@/lib/api/generated/schema";
import { mockBuyers } from "./data";

type Buyer = components["schemas"]["Buyer"];
type Invoice = components["schemas"]["Invoice"];
type BankListingView = components["schemas"]["BankListingView"];

interface MockListing {
  listingId: string;
  offerSubmissionDeadline: string;
  supplier: { legalName: string; nationalEstablishmentNumber: string; registryStatus: string };
  buyer: Buyer;
  invoice: Invoice;
  documents: { id: string; documentType: string }[];
  risk: RiskInputs;
}

const AMMAN_RETAIL: Buyer = {
  id: mockBuyers[0].id,
  nationalEstablishmentNumber: mockBuyers[0].nationalEstablishmentNo,
  legalCompanyName: mockBuyers[0].legalCompanyName,
  registryStatus: mockBuyers[0].registryStatus as Buyer["registryStatus"],
  governorate: mockBuyers[0].governorate,
};

const LEVANT_CONSTRUCTION: Buyer = {
  id: mockBuyers[1].id,
  nationalEstablishmentNumber: mockBuyers[1].nationalEstablishmentNo,
  legalCompanyName: mockBuyers[1].legalCompanyName,
  registryStatus: mockBuyers[1].registryStatus as Buyer["registryStatus"],
  governorate: mockBuyers[1].governorate,
};

const listings: MockListing[] = [
  {
    listingId: "0ef00000-0000-4000-8000-000000000001",
    offerSubmissionDeadline: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    supplier: {
      legalName: "Al-Noor Trading Company",
      nationalEstablishmentNumber: "20000101",
      registryStatus: "ACTIVE",
    },
    buyer: AMMAN_RETAIL,
    invoice: {
      id: "0ef10000-0000-4000-8000-000000000001",
      invoiceNumber: "INV-2026-0001",
      einvoiceIdentifier: "JO-EINV-20000101-0001",
      issueDate: "2026-05-10",
      dueDate: "2026-08-10",
      subtotalAmount: "10650.000",
      taxAmount: "1704.000",
      faceValue: "12354.000",
      outstandingAmount: "12354.000",
      currency: "JOD",
    },
    documents: [{ id: "0ef20000-0000-4000-8000-000000000001", documentType: "EINVOICE" }],
    risk: {
      buyerRegistryStatus: "ACTIVE",
      verificationOverallResult: "PASS",
      tenorDays: 30,
      priorDuplicateFlags: 0,
      sourceAvailability: { ccdAvailable: true, istdAvailable: true, gamAvailable: true },
      mlUsed: true,
    },
  },
  {
    listingId: "0ef00000-0000-4000-8000-000000000002",
    offerSubmissionDeadline: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
    supplier: {
      legalName: "Petra Industrial Supplies",
      nationalEstablishmentNumber: "20000102",
      registryStatus: "ACTIVE",
    },
    buyer: LEVANT_CONSTRUCTION,
    invoice: {
      id: "0ef10000-0000-4000-8000-000000000002",
      invoiceNumber: "INV-2026-0004",
      einvoiceIdentifier: "JO-EINV-20000102-0004",
      issueDate: "2026-05-22",
      dueDate: "2026-07-21",
      subtotalAmount: "8200.000",
      taxAmount: "1312.000",
      faceValue: "9512.000",
      outstandingAmount: "9512.000",
      currency: "JOD",
    },
    documents: [{ id: "0ef20000-0000-4000-8000-000000000002", documentType: "EINVOICE" }],
    // GAM partial for Petra, matching its Phase 2 fixture (GOV_DUMMY_DATA §2:
    // "CCD full, GAM partial") — dataAvailabilityPct is lower here, and the
    // ZM-RSK-005 drill is this row: identical components to the first
    // listing's shape, only the availability figure moves.
    risk: {
      buyerRegistryStatus: "ACTIVE",
      verificationOverallResult: "PASS",
      tenorDays: 12,
      priorDuplicateFlags: 0,
      sourceAvailability: { ccdAvailable: true, istdAvailable: true, gamAvailable: false },
      mlUsed: false,
      mlFallbackReason: "ML_SERVICE_UNAVAILABLE",
    },
  },
];

/**
 * `myOffer` is always absent. Offer creation (`POST /listings/{id}/offers/create`)
 * is not implemented — the offer form is a visual skeleton this session, not
 * a working submission — so there is never a stored offer for this to return.
 * The field stays on the response shape because the contract declares it;
 * leaving it structurally present now is what makes wiring the real create
 * flow in Phase 5 an addition rather than a shape change.
 */
function toBankListingView(listing: MockListing): BankListingView {
  return {
    listingId: listing.listingId,
    offerSubmissionDeadline: listing.offerSubmissionDeadline,
    supplier: listing.supplier,
    buyer: listing.buyer,
    invoice: listing.invoice,
    risk: computeRiskAssessment(listing.risk, new Date().toISOString()),
    documents: listing.documents,
    myOffer: undefined,
  };
}

export function listEligibleListings(): BankListingView[] {
  return listings.map(toBankListingView);
}

export function findListing(listingId: string): BankListingView | undefined {
  const listing = listings.find((l) => l.listingId === listingId);
  return listing ? toBankListingView(listing) : undefined;
}
