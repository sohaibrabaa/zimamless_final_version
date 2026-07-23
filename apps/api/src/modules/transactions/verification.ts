import { Money } from '../../common/money/money';

/**
 * The eight automated checks (§8.5), as pure functions.
 *
 * Kept free of the database and of Nest DI on purpose: these are the rules
 * the phase's definition-of-done tests assert, and rules that need a live
 * Postgres to exercise get tested shallowly or not at all. The service
 * gathers facts; this file decides what they mean.
 *
 * `check_result` values come from the frozen enum:
 *   PASS | FAIL | REVIEW | MISSING | UNPARSED | NOT_APPLICABLE
 *
 * The one that carries the most weight is `NOT_APPLICABLE`. A check that
 * could not run because its input is absent must not report PASS — a
 * missing QR code is not evidence that the QR agreed with anything. Nor
 * should it always report FAIL, which would make every invoice without an
 * optional document look adverse.
 */

export type CheckResult = 'PASS' | 'FAIL' | 'REVIEW' | 'MISSING' | 'UNPARSED' | 'NOT_APPLICABLE';

export type CheckType =
  | 'COMPLETENESS'
  | 'IDENTITY_MATCH'
  | 'DUPLICATE'
  | 'LOGIC'
  | 'ELIGIBILITY'
  | 'FILE_INTEGRITY'
  | 'OCR_CONSISTENCY'
  | 'QR_CONSISTENCY';

export interface CheckOutcome {
  checkType: CheckType;
  result: CheckResult;
  details: Record<string, unknown>;
}

export interface InvoiceFacts {
  invoiceNumber: string;
  einvoiceIdentifier: string;
  issueDate: string;
  dueDate: string;
  subtotalAmount: string;
  taxAmount: string;
  faceValue: string;
  paidAmount: string;
  outstandingAmount: string;
  currency: string;
}

export interface VerificationFacts {
  invoice: InvoiceFacts | null;
  buyer: {
    id: string;
    nationalEstablishmentNumber: string | null;
    legalCompanyName: string;
    registryStatus: string;
  } | null;
  supplier: {
    organizationId: string;
    nationalEstablishmentNumber: string | null;
    status: string;
    legalName: string;
  };
  declarationsRecorded: boolean;
  /** The mandatory electronic invoice (ZM-DOC-001). */
  electronicInvoiceDocument: {
    id: string;
    fileHash: string;
    /** Null when the stored object could not be read back at all. */
    storedHashMatches: boolean | null;
  } | null;
  ocr: {
    available: boolean;
    fields: Record<string, string>;
  } | null;
  qr: {
    /** VALID | INVALID | UNPARSED | UNAVAILABLE */
    validationStatus: string;
    fields: Record<string, string>;
  } | null;
  duplicate: {
    collided: boolean;
    existingTransactionId?: string;
  };
  /** "Now", from the injected TimeProvider — never a direct clock read. */
  now: Date;
  /** AS-08 minimum tenor, read from platform_settings. */
  minTenorDays: number;
}

/** Fields the supplier's confirmed invoice is compared against (ZM-DOC-005b). */
const COMPARED_FIELDS: readonly (keyof InvoiceFacts)[] = [
  'invoiceNumber',
  'einvoiceIdentifier',
  'issueDate',
  'dueDate',
  'subtotalAmount',
  'taxAmount',
  'faceValue',
];

export function runChecks(facts: VerificationFacts): CheckOutcome[] {
  return [
    completeness(facts),
    identityMatch(facts),
    duplicate(facts),
    transactionLogic(facts),
    partyEligibility(facts),
    fileIntegrity(facts),
    ocrConsistency(facts),
    qrConsistency(facts),
  ];
}

// ---------------------------------------------------------------------------
// 1. Completeness — required fields, documents, dates, values
// ---------------------------------------------------------------------------
function completeness(facts: VerificationFacts): CheckOutcome {
  const missing: string[] = [];

  if (!facts.invoice) missing.push('invoice');
  else {
    for (const field of COMPARED_FIELDS) {
      if (!facts.invoice[field]) missing.push(`invoice.${field}`);
    }
  }
  if (!facts.buyer) missing.push('buyer');
  if (!facts.declarationsRecorded) missing.push('declarations');
  // ZM-DOC-001: the electronic invoice is mandatory in V3 and a submission
  // without one cannot proceed.
  if (!facts.electronicInvoiceDocument) missing.push('electronicInvoiceDocument');

  return {
    checkType: 'COMPLETENESS',
    result: missing.length === 0 ? 'PASS' : 'MISSING',
    details: { missing },
  };
}

// ---------------------------------------------------------------------------
// 2. Identity match — supplier and buyer against the invoice content
// ---------------------------------------------------------------------------
function identityMatch(facts: VerificationFacts): CheckOutcome {
  const readings = { ...(facts.ocr?.fields ?? {}), ...(facts.qr?.fields ?? {}) };
  const details: Record<string, unknown> = {};
  const conflicts: string[] = [];

  const compare = (
    label: string,
    documentValue: string | undefined,
    expected: string | null,
  ): void => {
    if (!documentValue || !expected) return; // nothing to compare — see below
    details[label] = { document: documentValue, platform: expected };
    if (documentValue !== expected) conflicts.push(label);
  };

  compare(
    'supplierEstablishmentNumber',
    readings.sellerEstablishmentNumber,
    facts.supplier.nationalEstablishmentNumber,
  );
  compare(
    'buyerEstablishmentNumber',
    readings.buyerEstablishmentNumber,
    facts.buyer?.nationalEstablishmentNumber ?? null,
  );

  if (Object.keys(details).length === 0) {
    // Neither reading produced a party identifier, so there is nothing to
    // match against. NOT_APPLICABLE rather than PASS: reporting a pass here
    // would claim the parties were verified against the document when no
    // comparison happened at all.
    return {
      checkType: 'IDENTITY_MATCH',
      result: 'NOT_APPLICABLE',
      details: { reason: 'No party identifiers were extracted from the document.' },
    };
  }

  return {
    checkType: 'IDENTITY_MATCH',
    // A mismatch routes to review, not to rejection: OCR misreads a digit
    // often enough that treating it as proof of misrepresentation would
    // punish suppliers for the quality of their scanner.
    result: conflicts.length === 0 ? 'PASS' : 'REVIEW',
    details: { ...details, conflicts },
  };
}

// ---------------------------------------------------------------------------
// 3. Duplicate detection (ZM-VER-001)
// ---------------------------------------------------------------------------
function duplicate(facts: VerificationFacts): CheckOutcome {
  return {
    checkType: 'DUPLICATE',
    result: facts.duplicate.collided ? 'FAIL' : 'PASS',
    details: facts.duplicate.collided
      ? {
          collision: true,
          existingTransactionId: facts.duplicate.existingTransactionId ?? null,
        }
      : { collision: false },
  };
}

// ---------------------------------------------------------------------------
// 4. Transaction logic — maturity, amounts, currency, negatives
// ---------------------------------------------------------------------------
function transactionLogic(facts: VerificationFacts): CheckOutcome {
  if (!facts.invoice) {
    return {
      checkType: 'LOGIC',
      result: 'MISSING',
      details: { reason: 'No invoice has been supplied.' },
    };
  }

  const invoice = facts.invoice;
  const problems: string[] = [];

  if (invoice.currency !== 'JOD') problems.push('CURRENCY_NOT_JOD'); // ZM-INV-002

  let outstanding: Money | null = null;
  try {
    const face = Money.from(invoice.faceValue);
    const paid = Money.from(invoice.paidAmount);
    const tax = Money.from(invoice.taxAmount);
    const subtotal = Money.from(invoice.subtotalAmount);
    outstanding = Money.from(invoice.outstandingAmount);

    if (face.isNegative() || tax.isNegative() || subtotal.isNegative() || paid.isNegative()) {
      problems.push('NEGATIVE_AMOUNT');
    }
    // ZM-INV-001: outstanding = face - paid, and must be > 0 to be listed.
    if (!face.subtract(paid).equals(outstanding)) problems.push('OUTSTANDING_FORMULA_MISMATCH');
    if (!outstanding.isPositive()) problems.push('OUTSTANDING_NOT_POSITIVE');
    // The stated components should add up. A mismatch is not necessarily
    // fraud — rounding on the supplier's own system, or a discount line we
    // did not capture — so it is reported and reviewed rather than failed.
    if (!subtotal.add(tax).equals(face)) problems.push('COMPONENTS_DO_NOT_SUM');
  } catch {
    // Money.from() refuses anything that is not a 3-dp decimal string. The
    // DTO layer already rejects those, so reaching here means a value was
    // written by something other than the API — worth reporting rather
    // than throwing.
    problems.push('MALFORMED_AMOUNT');
  }

  const issue = Date.parse(`${invoice.issueDate}T00:00:00Z`);
  const due = Date.parse(`${invoice.dueDate}T00:00:00Z`);
  if (Number.isNaN(issue) || Number.isNaN(due)) {
    problems.push('MALFORMED_DATE');
  } else if (due < issue) {
    problems.push('DUE_BEFORE_ISSUE');
  }

  return {
    checkType: 'LOGIC',
    result: problems.length === 0 ? 'PASS' : 'REVIEW',
    details: { problems },
  };
}

// ---------------------------------------------------------------------------
// 5. Party eligibility — supplier and buyer status, maturity windows
// ---------------------------------------------------------------------------
function partyEligibility(facts: VerificationFacts): CheckOutcome {
  const problems: string[] = [];

  // The supplier must be through onboarding. APPROVED_CONDITIONAL is
  // deliberately excluded from financing (ZM-SON-011): a conditionally
  // approved supplier can see the platform but cannot raise money on it.
  if (facts.supplier.status !== 'ACTIVE') {
    problems.push(`SUPPLIER_NOT_ACTIVE:${facts.supplier.status}`);
  }

  if (!facts.buyer) {
    problems.push('BUYER_NOT_RESOLVED'); // ZM-BUY-003
  } else if (['SUSPENDED', 'STRUCK_OFF'].includes(facts.buyer.registryStatus)) {
    problems.push(`BUYER_BLOCKED:${facts.buyer.registryStatus}`);
  } else if (facts.buyer.registryStatus === 'UNDER_LIQUIDATION') {
    problems.push('BUYER_UNDER_LIQUIDATION'); // LT-02 — review, not a block
  }

  if (facts.invoice) {
    const due = Date.parse(`${facts.invoice.dueDate}T00:00:00Z`);
    if (!Number.isNaN(due)) {
      const daysToMaturity = Math.floor((due - facts.now.getTime()) / 86_400_000);
      // AS-07: a due date already in the past is ineligible for listing.
      if (daysToMaturity < 0) problems.push('PAST_DUE');
      // AS-08: minimum tenor to list. Read from platform_settings rather
      // than hard-coded, so the product owner can change it without a
      // deploy.
      else if (daysToMaturity < facts.minTenorDays) {
        problems.push(`BELOW_MIN_TENOR:${daysToMaturity}d<${facts.minTenorDays}d`);
      }
    }
  }

  return {
    checkType: 'ELIGIBILITY',
    result: problems.length === 0 ? 'PASS' : 'REVIEW',
    details: { problems },
  };
}

// ---------------------------------------------------------------------------
// 6. File integrity — hash, MIME, visible modification indicators
// ---------------------------------------------------------------------------
function fileIntegrity(facts: VerificationFacts): CheckOutcome {
  const document = facts.electronicInvoiceDocument;
  if (!document) {
    return {
      checkType: 'FILE_INTEGRITY',
      result: 'MISSING',
      details: { reason: 'No electronic invoice document is attached (ZM-DOC-001).' },
    };
  }
  if (document.storedHashMatches === null) {
    // The object could not be read back. That is an infrastructure fact,
    // not evidence about the file, and it must not be reported as a failed
    // integrity check — which routes to FRAUD_REVIEW.
    return {
      checkType: 'FILE_INTEGRITY',
      result: 'REVIEW',
      details: {
        reason: 'The stored file could not be read back for hashing.',
        documentId: document.id,
      },
    };
  }
  return {
    checkType: 'FILE_INTEGRITY',
    // A genuine hash mismatch means the stored bytes changed after upload.
    // This is the one check whose failure routes to FRAUD_REVIEW.
    result: document.storedHashMatches ? 'PASS' : 'FAIL',
    details: { documentId: document.id, recordedHash: document.fileHash },
  };
}

// ---------------------------------------------------------------------------
// 7. OCR consistency — extracted vs. supplier-confirmed values
// ---------------------------------------------------------------------------
function ocrConsistency(facts: VerificationFacts): CheckOutcome {
  if (!facts.ocr || !facts.ocr.available) {
    return {
      checkType: 'OCR_CONSISTENCY',
      result: 'UNPARSED',
      details: { reason: 'OCR did not produce a reading for this document.' },
    };
  }
  if (!facts.invoice) {
    return {
      checkType: 'OCR_CONSISTENCY',
      result: 'MISSING',
      details: { reason: 'No supplier-confirmed invoice to compare against.' },
    };
  }
  return compareReading('OCR_CONSISTENCY', facts.ocr.fields, facts.invoice);
}

// ---------------------------------------------------------------------------
// 8. QR consistency — QR vs. OCR vs. confirmed values
// ---------------------------------------------------------------------------
function qrConsistency(facts: VerificationFacts): CheckOutcome {
  if (!facts.qr) {
    return {
      checkType: 'QR_CONSISTENCY',
      result: 'UNPARSED',
      details: { reason: 'No QR reading was recorded.' },
    };
  }

  // The distinction that matters, carried through from the extraction
  // service: "there was no code on the page" is not the same finding as
  // "there was a code and we could not understand it".
  if (facts.qr.validationStatus === 'UNAVAILABLE') {
    return {
      checkType: 'QR_CONSISTENCY',
      result: 'NOT_APPLICABLE',
      details: { reason: 'The document carries no QR code.' },
    };
  }
  if (facts.qr.validationStatus === 'UNPARSED') {
    // ZM-DOC-010's degrade path, surfacing here as manual review.
    return {
      checkType: 'QR_CONSISTENCY',
      result: 'UNPARSED',
      details: { reason: 'A QR code was read but no known schema recognised it.' },
    };
  }
  if (facts.qr.validationStatus === 'INVALID') {
    return {
      checkType: 'QR_CONSISTENCY',
      result: 'REVIEW',
      details: { reason: 'The e-invoice validation adapter rejected the identifier.' },
    };
  }
  if (!facts.invoice) {
    return {
      checkType: 'QR_CONSISTENCY',
      result: 'MISSING',
      details: { reason: 'No supplier-confirmed invoice to compare against.' },
    };
  }

  const againstInvoice = compareReading('QR_CONSISTENCY', facts.qr.fields, facts.invoice);

  // ZM-DOC-008 asks for QR against OCR as well as against the confirmed
  // values, so a disagreement between the two machine readings is reported
  // even when both happen to differ from the supplier's entry in the same
  // way.
  const versusOcr: string[] = [];
  if (facts.ocr?.available) {
    for (const [field, value] of Object.entries(facts.qr.fields)) {
      const ocrValue = facts.ocr.fields[field];
      if (ocrValue && ocrValue !== value) versusOcr.push(field);
    }
  }

  const details = { ...againstInvoice.details, disagreesWithOcr: versusOcr };
  return {
    checkType: 'QR_CONSISTENCY',
    result: againstInvoice.result === 'PASS' && versusOcr.length > 0 ? 'REVIEW' : againstInvoice.result,
    details,
  };
}

/**
 * Compare one machine reading against the supplier's confirmed invoice.
 *
 * Only fields the reading actually produced are compared. A field the
 * machine did not read is not a mismatch — it is an absence, and counting
 * absences as disagreements would send every partially-readable scan to
 * review.
 */
function compareReading(
  checkType: CheckType,
  reading: Record<string, string>,
  invoice: InvoiceFacts,
): CheckOutcome {
  const mismatches: { field: string; extracted: string; confirmed: string }[] = [];
  let compared = 0;

  for (const field of COMPARED_FIELDS) {
    const extracted = reading[field];
    const confirmed = invoice[field];
    if (!extracted || !confirmed) continue;
    compared += 1;
    if (!valuesAgree(field, extracted, confirmed)) {
      mismatches.push({ field, extracted, confirmed });
    }
  }

  if (compared === 0) {
    return {
      checkType,
      result: 'NOT_APPLICABLE',
      details: { reason: 'The reading produced no fields comparable with the invoice.' },
    };
  }

  return {
    checkType,
    // A mismatch is a REVIEW, never a FAIL. ZM-VER-002: a failed check is
    // not by itself proof of anything, and the supplier is the one who
    // reconciles it.
    result: mismatches.length === 0 ? 'PASS' : 'REVIEW',
    details: { compared, mismatches },
  };
}

/**
 * Whether two readings of one field agree.
 *
 * Amounts are compared as decimals so "1600" and "1600.000" agree; they are
 * the same money written differently, and reporting that as a mismatch
 * would train reviewers to dismiss the check.
 */
function valuesAgree(field: keyof InvoiceFacts, a: string, b: string): boolean {
  if (['subtotalAmount', 'taxAmount', 'faceValue'].includes(field)) {
    try {
      return Money.from(normalizeMoneyString(a)).equals(Money.from(normalizeMoneyString(b)));
    } catch {
      return a.trim() === b.trim();
    }
  }
  return a.trim() === b.trim();
}

/** Pad a plain decimal to the 3-dp form `Money.from` requires. */
function normalizeMoneyString(value: string): string {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  const [whole, fraction = ''] = trimmed.split('.');
  return `${whole}.${(fraction + '000').slice(0, 3)}`;
}

/** The run's overall result, from its checks. */
export function overallResultOf(checks: readonly CheckOutcome[]): CheckResult {
  if (checks.some((c) => c.result === 'FAIL')) return 'FAIL';
  if (checks.some((c) => ['REVIEW', 'MISSING', 'UNPARSED'].includes(c.result))) return 'REVIEW';
  return 'PASS';
}
