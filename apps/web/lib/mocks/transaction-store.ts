/**
 * In-memory transaction/buyer/document fixture store backing the Phase 3 MSW
 * handlers.
 *
 * Stateful for the same reason the Phase 2 store is: the phase-3 integration
 * checkpoint is a *sequence* — search buyer → resolve → upload e-invoice → OCR
 * pre-fill with a seeded mismatch → correct it (both values retained) → set
 * floor → declare → submit → ELIGIBLE, and then the same invoice from a second
 * supplier blocked by fingerprint. Static fixtures cannot demonstrate that the
 * duplicate check fires only on the *second* submission.
 *
 * Identities: buyers are copied verbatim from `db/seed/0100_seed_dev.sql`
 * (ids, establishment numbers, names, registry statuses) via `data.ts`, and
 * `data.spec.ts` fails if any of them drifts.
 *
 * **Invoice identities are Agent A's seeded values**, copied from
 * `db/seed/einvoices/` via `docs/specs/EINVOICE_QR.md` §7 — invoice numbers,
 * e-invoice identifiers, dates and amounts, including which file carries the
 * deliberate mismatch and what disagrees on it. This half shipped `MOCK-`
 * placeholders in Phase 3 because no seeded set existed yet, and flagged them
 * for reconciliation; the Phase 3 unification session did that reconciliation.
 */

import type { components } from "@/lib/api/generated/schema";
// The mock does its money arithmetic through the same decimal helpers the UI
// uses. Reimplementing it here — even correctly — would create a second money
// implementation in a codebase whose central rule is that there is exactly one.
import { compareMoney, subtractMoney } from "@/lib/money";
import { mockBuyers, ORG } from "./data";

type Buyer = components["schemas"]["Buyer"];
type BuyerCandidate = components["schemas"]["BuyerCandidate"];
type Invoice = components["schemas"]["Invoice"];
type InvoiceInput = components["schemas"]["InvoiceInput"];
type Transaction = components["schemas"]["Transaction"];
type TransactionState = components["schemas"]["TransactionState"];
type Extraction = components["schemas"]["Extraction"];
type VerificationRun = components["schemas"]["VerificationRun"];
type BuyerContactInput = components["schemas"]["BuyerContactInput"];

export interface MockDocument {
  id: string;
  transactionId: string | null;
  documentType: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
  /** Which seeded extraction profile this document produces, if any. */
  extractionProfile: ExtractionProfile | null;
}

export interface MockTransaction extends Transaction {
  organizationId: string;
  documents: MockDocument[];
  declarationTemplateVersion?: string;
  submittedAt?: string;
  verification?: VerificationRun;
  contact?: BuyerContactInput;
}

/** Buyer contact lives on the supplier↔buyer relationship, never on Buyer (ZM-BUY-005/008). */
interface MockRelationship {
  organizationId: string;
  buyerId: string;
  contact: BuyerContactInput;
}

// ---------------------------------------------------------------------------
// Buyers — the global directory, copied from the seed via data.ts
// ---------------------------------------------------------------------------

const buyers: Buyer[] = mockBuyers.map((b) => ({
  id: b.id,
  nationalEstablishmentNumber: b.nationalEstablishmentNo,
  legalCompanyName: b.legalCompanyName,
  registryStatus: b.registryStatus as Buyer["registryStatus"],
  governorate: b.governorate,
  registeredAddress: `${b.governorate}, Jordan`,
  registrationDate: "2015-06-01",
  lastVerifiedAt: "2026-07-20T09:14:00.000Z",
}));

export function searchBuyers(query: string): {
  candidates: BuyerCandidate[];
  requiresManualReview: boolean;
} {
  const q = query.trim().toLowerCase();
  const matches = buyers.filter(
    (b) =>
      (b.legalCompanyName ?? "").toLowerCase().includes(q) ||
      (b.nationalEstablishmentNumber ?? "").includes(q)
  );

  const candidates: BuyerCandidate[] = matches.map((b) => ({
    nationalEstablishmentNumber: b.nationalEstablishmentNumber,
    legalCompanyName: b.legalCompanyName,
    companyType: "LIMITED_LIABILITY",
    registryStatus: b.registryStatus,
    governorate: b.governorate,
  }));

  // ZM-BUY-010: ambiguity routes to manual review. Note that a *single* exact
  // match still comes back as a candidate list — the response has no "selected"
  // field to set, because ZM-BUY-009 forbids the platform choosing at all.
  return { candidates, requiresManualReview: candidates.length > 1 };
}

export function findBuyerById(id: string): Buyer | undefined {
  return buyers.find((b) => b.id === id);
}

export function findBuyerByEstablishmentNumber(no: string): Buyer | undefined {
  return buyers.find((b) => b.nationalEstablishmentNumber === no);
}

const relationships: MockRelationship[] = [];

export type ResolveResult =
  | { ok: true; buyer: Buyer }
  | { ok: false; error: "NOT_FOUND" | "BUYER_BLOCKED"; registryStatus?: string };

/**
 * `/buyers/resolve` — global dedup on national number, then create or link.
 *
 * 409 on SUSPENDED and STRUCK_OFF; UNDER_LIQUIDATION is *not* refused (LT-02
 * policy routes it to manual review instead), which is why the block list here
 * is two statuses and not three. Getting that wrong in the mock would teach the
 * UI to refuse a buyer the live API accepts.
 */
export function resolveBuyer(
  organizationId: string,
  nationalEstablishmentNumber: string,
  contact?: BuyerContactInput
): ResolveResult {
  const buyer = findBuyerByEstablishmentNumber(nationalEstablishmentNumber);
  if (!buyer) return { ok: false, error: "NOT_FOUND" };

  if (buyer.registryStatus === "SUSPENDED" || buyer.registryStatus === "STRUCK_OFF") {
    return { ok: false, error: "BUYER_BLOCKED", registryStatus: buyer.registryStatus };
  }

  if (contact) {
    const existing = relationships.find(
      (r) => r.organizationId === organizationId && r.buyerId === buyer.id
    );
    if (existing) existing.contact = contact;
    else relationships.push({ organizationId, buyerId: buyer.id!, contact });
  }

  return { ok: true, buyer };
}

// ---------------------------------------------------------------------------
// Documents and extraction
// ---------------------------------------------------------------------------

/**
 * Seeded extraction outcomes. The phase file requires a seeded e-invoice with
 * a **deliberate OCR-vs-entered mismatch**, and ZM-DOC-010 requires an
 * `UNPARSED` QR degrading to manual review rather than a guess. Both are
 * reachable here by file name, so a demo can produce either on purpose.
 */
export type ExtractionProfile = "CLEAN" | "MISMATCH" | "UNPARSED_QR";

/**
 * File-name markers selecting a profile. These match the real seeded file
 * names in `db/seed/einvoices/`, so uploading the actual PDF a demo would
 * use lands on the matching profile.
 */
export function profileForFileName(fileName: string): ExtractionProfile {
  const name = fileName.toLowerCase();
  if (name.includes("mismatch") || name.includes("0002")) return "MISMATCH";
  if (name.includes("unparsed") || name.includes("noqr")) return "UNPARSED_QR";
  return "CLEAN";
}

/**
 * `INV-2026-0001-alnoor-amman-retail.pdf` — the happy path, S1 → B1. Values
 * are the ones printed on the real seeded PDF and carried in its QR payload
 * (`EINVOICE_QR.md` §3): `JO|JO-EINV-20000101-0001|20000101|30000201|
 * 2026-05-10|12354.000|1704.000`.
 */
const CLEAN_FIELDS = {
  invoiceNumber: "INV-2026-0001",
  einvoiceIdentifier: "JO-EINV-20000101-0001",
  issueDate: "2026-05-10",
  dueDate: "2026-08-10",
  subtotalAmount: "10650.000",
  taxAmount: "1704.000",
  faceValue: "12354.000",
};

/**
 * `INV-2026-0002-alnoor-levant-mismatch.pdf` — the deliberate disagreement.
 *
 * The mismatch is on the **face value**: the page prints `24500.000` and the
 * QR payload carries `25000.000`. This half originally guessed a *tax*
 * mismatch on an invented invoice; the field matters, because the wizard's
 * comparison highlights a specific row and the demo walks the supplier
 * through resolving that row.
 */
const MISMATCH_FIELDS = {
  invoiceNumber: "INV-2026-0002",
  einvoiceIdentifier: "JO-EINV-20000101-0002",
  issueDate: "2026-05-18",
  dueDate: "2026-09-16",
  subtotalAmount: "21120.690",
  taxAmount: "3379.310",
  faceValue: "24500.000",
};

/** What the QR on the mismatch PDF actually carries. */
const MISMATCH_QR_FACE_VALUE = "25000.000";

/**
 * `INV-2026-0003` — the duplicate pair. The same invoice data is issued by
 * S1 (`-duplicate-a`) and S2 (`-duplicate-b`) against Aqaba Logistics, and
 * submitting the second must collide.
 */
const DUPLICATE_FIELDS = {
  invoiceNumber: "INV-2026-0003",
  einvoiceIdentifier: "JO-EINV-20000102-0003",
  issueDate: "2026-06-01",
  dueDate: "2026-09-01",
  subtotalAmount: "6000.000",
  taxAmount: "960.000",
  faceValue: "6960.000",
};

function extractionFor(documentId: string, profile: ExtractionProfile): Extraction {
  if (profile === "UNPARSED_QR") {
    return {
      documentId,
      ocr: { rawOutput: { engine: "mock-ocr", pages: 1 }, extractedFields: { ...CLEAN_FIELDS }, confidence: 0.91 },
      // ZM-DOC-010: the payload did not match a known schema. Nothing is
      // guessed from it, and `parsed: false` is what routes this to review.
      qr: { parsed: false, extractedFields: {}, validationStatus: "UNPARSED" },
      mismatches: [],
    };
  }

  if (profile === "MISMATCH") {
    // The deliberate discrepancy on the seeded `-levant-mismatch` PDF: OCR
    // reads the printed total 24500.000 while the QR payload carries
    // 25000.000. Both machine values are preserved; whichever the supplier
    // confirms is recorded *alongside* them, never over them (ZM-DOC-006).
    return {
      documentId,
      ocr: {
        rawOutput: { engine: "mock-ocr", pages: 1 },
        extractedFields: { ...MISMATCH_FIELDS },
        confidence: 0.78,
      },
      qr: {
        parsed: true,
        extractedFields: { ...MISMATCH_FIELDS, faceValue: MISMATCH_QR_FACE_VALUE },
        validationStatus: "VALID",
      },
      mismatches: [
        {
          field: "faceValue",
          ocrValue: MISMATCH_FIELDS.faceValue,
          qrValue: MISMATCH_QR_FACE_VALUE,
        },
      ],
    };
  }

  return {
    documentId,
    ocr: {
      rawOutput: { engine: "mock-ocr", pages: 1 },
      extractedFields: { ...CLEAN_FIELDS },
      confidence: 0.96,
    },
    qr: { parsed: true, extractedFields: { ...CLEAN_FIELDS }, validationStatus: "VALID" },
    mismatches: [],
  };
}

let documents: MockDocument[] = [];

export function createDocument(input: {
  documentType: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  subjectId?: string;
}): MockDocument {
  const doc: MockDocument = {
    id: nextId("d"),
    transactionId: input.subjectId ?? null,
    documentType: input.documentType,
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    uploadedAt: new Date().toISOString(),
    extractionProfile:
      input.documentType === "EINVOICE" ? profileForFileName(input.fileName) : null,
  };
  documents = [doc, ...documents];

  const transaction = input.subjectId ? findTransaction(input.subjectId) : undefined;
  if (transaction) transaction.documents = [doc, ...transaction.documents];

  return doc;
}

export function findDocument(id: string): MockDocument | undefined {
  return documents.find((d) => d.id === id);
}

export function extractionForDocument(id: string): Extraction | undefined {
  const doc = findDocument(id);
  if (!doc || doc.extractionProfile === null) return undefined;
  return extractionFor(doc.id, doc.extractionProfile);
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

let transactions: MockTransaction[] = [];
let sequence = 0;

function nextId(prefix: string): string {
  sequence += 1;
  return `0e${prefix}00000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

let referenceCounter = 1000;
function nextReference(): string {
  referenceCounter += 1;
  return `ZM-TXN-${referenceCounter}`;
}

export function createTransaction(organizationId: string): MockTransaction {
  const transaction: MockTransaction = {
    id: nextId("t"),
    organizationId,
    referenceNumber: nextReference(),
    state: "DRAFT",
    createdAt: new Date().toISOString(),
    documents: [],
  };
  transactions = [transaction, ...transactions];
  return transaction;
}

export function listTransactions(organizationId: string | null): MockTransaction[] {
  return organizationId
    ? transactions.filter((t) => t.organizationId === organizationId)
    : transactions;
}

export function findTransaction(id: string): MockTransaction | undefined {
  return transactions.find((t) => t.id === id);
}

/**
 * `PUT …/invoice`. The server recomputes `outstandingAmount` (phase file, A
 * tasks) — face value minus anything already paid — so the mock does the same
 * rather than echoing a client-supplied figure. Money is string arithmetic on
 * minor units here: this store must never introduce a float into a path whose
 * whole point is that money is never a JS number.
 */
export function setInvoice(id: string, input: InvoiceInput): MockTransaction | undefined {
  const transaction = findTransaction(id);
  if (!transaction) return undefined;

  const invoice: Invoice = {
    ...input,
    id: transaction.invoice?.id ?? nextId("i"),
    currency: "JOD",
    outstandingAmount: subtractMoney(input.faceValue, input.paidAmount ?? "0.000"),
  };

  transaction.invoice = invoice;
  transaction.invoiceNumber = input.invoiceNumber;
  transaction.faceValue = input.faceValue;
  transaction.outstandingAmount = invoice.outstandingAmount;
  transaction.dueDate = input.dueDate;
  return transaction;
}

export function linkBuyer(
  id: string,
  buyerId: string,
  contact?: BuyerContactInput
): MockTransaction | undefined {
  const transaction = findTransaction(id);
  const buyer = findBuyerById(buyerId);
  if (!transaction || !buyer) return undefined;

  transaction.buyer = buyer;
  transaction.buyerName = buyer.legalCompanyName;
  if (contact) {
    transaction.contact = contact;
    resolveBuyer(transaction.organizationId, buyer.nationalEstablishmentNumber!, contact);
  }
  return transaction;
}

export type MinimumAmountResult =
  | { ok: true; transaction: MockTransaction }
  | { ok: false; error: "NOT_FOUND" | "EXCEEDS_OUTSTANDING" | "NOT_POSITIVE" };

/** Validated ≤ outstanding and > 0 (phase file, A tasks — 422 otherwise). */
export function setMinimumAmount(id: string, amount: string): MinimumAmountResult {
  const transaction = findTransaction(id);
  if (!transaction) return { ok: false, error: "NOT_FOUND" };
  if (compareMoney(amount, "0.000") <= 0) return { ok: false, error: "NOT_POSITIVE" };

  const outstanding = transaction.outstandingAmount;
  if (outstanding && compareMoney(amount, outstanding) > 0) {
    return { ok: false, error: "EXCEEDS_OUTSTANDING" };
  }

  transaction.minimumAcceptableAmount = amount;
  return { ok: true, transaction };
}

export function setDeclarations(id: string, templateVersion: string): MockTransaction | undefined {
  const transaction = findTransaction(id);
  if (!transaction) return undefined;
  transaction.declarationTemplateVersion = templateVersion;
  return transaction;
}

// ---------------------------------------------------------------------------
// Submission: fingerprint, verification, state
// ---------------------------------------------------------------------------

/**
 * D-01's fingerprint: parties + invoice number + date + value + tax.
 *
 * Deliberately **excludes** the supplier, matching ZM-VER-001's "unique
 * platform-wide": the checkpoint case is the same invoice submitted by a
 * *second* supplier, which must collide. Keying on the supplier too would make
 * that case pass and quietly disable the whole check.
 */
export function fingerprint(transaction: MockTransaction): string | null {
  const invoice = transaction.invoice;
  const buyerNo = transaction.buyer?.nationalEstablishmentNumber;
  if (!invoice || !buyerNo) return null;
  return [
    buyerNo,
    invoice.invoiceNumber,
    invoice.issueDate,
    invoice.faceValue,
    invoice.taxAmount,
  ].join("|");
}

/** Fingerprints already held by a submitted, non-cancelled transaction. */
const ACTIVE_STATES: readonly TransactionState[] = [
  "SUBMITTED",
  "AUTOMATED_CHECKS",
  "UNDER_REVIEW",
  "INFORMATION_REQUIRED",
  "ELIGIBLE",
  "OPEN_FOR_OFFERS",
  "OFFER_ACCEPTED",
  "CONDITIONS_PENDING",
  "CONTRACTED",
  "READY_FOR_DISBURSEMENT",
  "FUNDING_CONFIRMATION_PENDING",
  "FUNDED",
  "PARTIALLY_PAID",
  "PAID",
  "FRAUD_REVIEW",
];

function findFingerprintCollision(candidate: MockTransaction): MockTransaction | undefined {
  const fp = fingerprint(candidate);
  if (!fp) return undefined;
  return transactions.find(
    (t) =>
      t.id !== candidate.id &&
      ACTIVE_STATES.includes(t.state as TransactionState) &&
      fingerprint(t) === fp
  );
}

export type SubmitResult =
  | { ok: true; transaction: MockTransaction }
  | { ok: false; error: "NOT_FOUND" }
  | { ok: false; error: "INVALID_STATE_TRANSITION" }
  | { ok: false; error: "INCOMPLETE"; missing: string[] }
  | { ok: false; error: "DUPLICATE"; reviewReference: string };

let reviewCounter = 500;

/**
 * The eight §8.5 checks, run against what the mock actually knows.
 *
 * Results are derived from the fixture's own state rather than hard-coded, so
 * the panel tells the truth about the transaction in front of it: correcting
 * the seeded mismatch really does turn OCR_CONSISTENCY from REVIEW to PASS.
 * A canned PASS list would make the whole panel decorative.
 */
function runVerification(transaction: MockTransaction): VerificationRun {
  const einvoice = transaction.documents.find((d) => d.documentType === "EINVOICE");
  const extraction = einvoice ? extractionForDocument(einvoice.id) : undefined;
  const invoice = transaction.invoice;

  // The seeded mismatch is on the face value (the QR says 25000.000, the page
  // prints 24500.000), so that is the field the consistency checks compare.
  const qrFaceValue = (extraction?.qr?.extractedFields as Record<string, unknown> | undefined)
    ?.faceValue;
  const ocrFaceValue = (extraction?.ocr?.extractedFields as Record<string, unknown> | undefined)
    ?.faceValue;

  const ocrConsistent =
    !invoice || ocrFaceValue === undefined || String(ocrFaceValue) === invoice.faceValue;
  const qrParsed = extraction?.qr?.parsed === true;
  const qrConsistent =
    !invoice || qrFaceValue === undefined || String(qrFaceValue) === invoice.faceValue;

  const dueDate = invoice?.dueDate ? new Date(`${invoice.dueDate}T00:00:00Z`) : null;
  const now = new Date();
  const daysToMaturity = dueDate
    ? Math.floor((dueDate.getTime() - now.getTime()) / 86_400_000)
    : null;
  // AS-07/AS-08: a past-due invoice is ineligible, and minimum tenor is 7 days.
  const tenorOk = daysToMaturity === null || daysToMaturity >= 7;

  const buyerEligible = transaction.buyer?.registryStatus === "ACTIVE";

  const checks: NonNullable<VerificationRun["checks"]> = [
    {
      checkType: "COMPLETENESS",
      result: invoice && transaction.buyer && einvoice ? "PASS" : "MISSING",
    },
    { checkType: "IDENTITY_MATCH", result: transaction.buyer ? "PASS" : "MISSING" },
    { checkType: "DUPLICATE", result: "PASS" },
    { checkType: "LOGIC", result: tenorOk ? "PASS" : "REVIEW" },
    {
      checkType: "ELIGIBILITY",
      result: buyerEligible ? "PASS" : "REVIEW",
      details: transaction.buyer?.registryStatus
        ? { buyerRegistryStatus: transaction.buyer.registryStatus }
        : undefined,
    },
    { checkType: "FILE_INTEGRITY", result: einvoice ? "PASS" : "MISSING" },
    {
      checkType: "OCR_CONSISTENCY",
      result: !extraction ? "NOT_APPLICABLE" : ocrConsistent ? "PASS" : "REVIEW",
      details: ocrConsistent
        ? undefined
        : { ocrValue: String(ocrFaceValue), confirmedValue: invoice?.faceValue },
    },
    {
      checkType: "QR_CONSISTENCY",
      // ZM-DOC-010: an unparsed QR is `UNPARSED`, not a failure. Nothing about
      // the supplier is implied by a payload we could not read.
      result: !extraction ? "NOT_APPLICABLE" : !qrParsed ? "UNPARSED" : qrConsistent ? "PASS" : "REVIEW",
      details: qrConsistent
        ? undefined
        : { qrValue: String(qrFaceValue), confirmedValue: invoice?.faceValue },
    },
  ];

  const anyFail = checks.some((c) => c.result === "FAIL");
  const anyReview = checks.some(
    (c) => c.result === "REVIEW" || c.result === "MISSING" || c.result === "UNPARSED"
  );

  return {
    id: nextId("v"),
    overallResult: anyFail ? "FAIL" : anyReview ? "REVIEW" : "PASS",
    checks,
  };
}

export function submitTransaction(id: string): SubmitResult {
  const transaction = findTransaction(id);
  if (!transaction) return { ok: false, error: "NOT_FOUND" };
  if (transaction.state !== "DRAFT") return { ok: false, error: "INVALID_STATE_TRANSITION" };

  const missing: string[] = [];
  if (!transaction.buyer) missing.push("buyer");
  if (!transaction.invoice) missing.push("invoice");
  if (!transaction.documents.some((d) => d.documentType === "EINVOICE")) missing.push("einvoice");
  if (!transaction.minimumAcceptableAmount) missing.push("minimumAcceptableAmount");
  if (!transaction.declarationTemplateVersion) missing.push("declarations");
  if (missing.length > 0) return { ok: false, error: "INCOMPLETE", missing };

  const collision = findFingerprintCollision(transaction);
  if (collision) {
    // ZM-VER-001: the collision blocks submission *and* opens a review record.
    // The transaction stays DRAFT — it is blocked, not rejected, and the
    // supplier keeps everything they entered.
    reviewCounter += 1;
    return { ok: false, error: "DUPLICATE", reviewReference: `ZM-DUP-${reviewCounter}` };
  }

  const verification = runVerification(transaction);
  transaction.verification = verification;
  transaction.submittedAt = new Date().toISOString();

  // §8.6: DRAFT → SUBMITTED → AUTOMATED_CHECKS → UNDER_REVIEW → ELIGIBLE.
  // SUBMITTED and AUTOMATED_CHECKS are transient inside the submit request and
  // never observable in a response, so the mock lands where the live API
  // actually answers — the same correction the Phase 2 store needed.
  transaction.state = verification.overallResult === "PASS" ? "ELIGIBLE" : "UNDER_REVIEW";

  return { ok: true, transaction };
}

export function verificationFor(id: string): VerificationRun | undefined {
  return findTransaction(id)?.verification;
}

/**
 * Phase 5's marketplace store is the only caller: listing activation moves
 * an `ELIGIBLE` transaction to `OPEN_FOR_OFFERS`, and the listing-outcome
 * table (§10.5) moves it back to `ELIGIBLE` when the listing closes with no
 * accepted offer. Kept as a narrow setter rather than exporting the mutable
 * array itself, matching this store's existing pattern of function-scoped
 * mutation.
 */
export function setTransactionState(id: string, state: TransactionState): MockTransaction | undefined {
  const transaction = findTransaction(id);
  if (!transaction) return undefined;
  transaction.state = state;
  return transaction;
}

/** Test/dev affordance: empty the store without a page reload. */
export function resetTransactionMocks() {
  transactions = [];
  documents = [];
  relationships.length = 0;
  sequence = 0;
  referenceCounter = 1000;
  reviewCounter = 500;
}

/**
 * Seeds a submitted transaction owned by Petra (S2) carrying the duplicate
 * pair's invoice identity, so the duplicate path is demonstrable from Al-Noor
 * (S1) in one step rather than requiring two full wizard runs. This mirrors
 * `INV-2026-0003-petra-aqaba-duplicate-b.pdf`, the half of the pair the
 * server seeds.
 */
export function seedDuplicateCounterpart(): MockTransaction {
  const existing = transactions.find((t) => t.organizationId === ORG.petra);
  if (existing) return existing;

  const transaction = createTransaction(ORG.petra);
  linkBuyer(transaction.id!, mockBuyers[0].id);
  setInvoice(transaction.id!, { ...DUPLICATE_FIELDS });
  transaction.state = "ELIGIBLE";
  return transaction;
}

/**
 * The seeded invoice identities, exported so tests assert against one source.
 * These are Agent A's real values from `db/seed/einvoices/` — the `MOCK-`
 * placeholders this half shipped in Phase 3 were reconciled away by the
 * Phase 3 unification session.
 */
export const INVOICE_FIXTURE = { ...CLEAN_FIELDS } as const;
export const MISMATCH_FIXTURE = { ...MISMATCH_FIELDS } as const;
/** What the QR on the mismatch PDF carries, where the page disagrees. */
export const MISMATCH_QR_FACE_VALUE_FIXTURE = MISMATCH_QR_FACE_VALUE;
export const DUPLICATE_FIXTURE = { ...DUPLICATE_FIELDS } as const;
