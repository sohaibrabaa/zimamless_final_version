import {
  CheckOutcome,
  VerificationFacts,
  overallResultOf,
  runChecks,
} from './verification';
import { outcomeOf } from './transaction-state';

/**
 * The eight automated checks (§8.5) and how their results route a
 * transaction (ZM-VER-002, AS-07, AS-08).
 */

const NOW = new Date('2026-06-15T09:00:00Z');

const facts = (overrides: Partial<VerificationFacts> = {}): VerificationFacts => ({
  invoice: {
    invoiceNumber: 'INV-2026-0001',
    einvoiceIdentifier: 'JO-EINV-20000101-0001',
    issueDate: '2026-05-10',
    dueDate: '2026-08-10',
    subtotalAmount: '10650.000',
    taxAmount: '1704.000',
    faceValue: '12354.000',
    paidAmount: '0.000',
    outstandingAmount: '12354.000',
    currency: 'JOD',
  },
  buyer: {
    id: 'b1',
    nationalEstablishmentNumber: '30000201',
    legalCompanyName: 'Amman Retail Group',
    registryStatus: 'ACTIVE',
  },
  supplier: {
    organizationId: 's1',
    nationalEstablishmentNumber: '20000101',
    status: 'ACTIVE',
    legalName: 'Al-Noor Trading Company',
  },
  declarationsRecorded: true,
  electronicInvoiceDocument: { id: 'd1', fileHash: 'abc', storedHashMatches: true },
  ocr: {
    available: true,
    fields: {
      invoiceNumber: 'INV-2026-0001',
      issueDate: '2026-05-10',
      faceValue: '12354.000',
      sellerEstablishmentNumber: '20000101',
      buyerEstablishmentNumber: '30000201',
    },
  },
  qr: {
    validationStatus: 'VALID',
    fields: {
      einvoiceIdentifier: 'JO-EINV-20000101-0001',
      faceValue: '12354.000',
      issueDate: '2026-05-10',
    },
  },
  duplicate: { collided: false },
  now: NOW,
  minTenorDays: 7,
  ...overrides,
});

const check = (checks: CheckOutcome[], type: string): CheckOutcome =>
  checks.find((c) => c.checkType === type)!;

describe('the eight automated checks', () => {
  it('runs all eight and records every result, not only failures', () => {
    const checks = runChecks(facts());
    expect(checks.map((c) => c.checkType).sort()).toEqual([
      'COMPLETENESS',
      'DUPLICATE',
      'ELIGIBILITY',
      'FILE_INTEGRITY',
      'IDENTITY_MATCH',
      'LOGIC',
      'OCR_CONSISTENCY',
      'QR_CONSISTENCY',
    ]);
  });

  it('a clean invoice passes everything and reaches ELIGIBLE', () => {
    const checks = runChecks(facts());
    expect(checks.every((c) => c.result === 'PASS')).toBe(true);
    expect(overallResultOf(checks)).toBe('PASS');
    expect(outcomeOf(checks)).toBe('ELIGIBLE');
  });
});

describe('completeness', () => {
  it('reports the mandatory electronic invoice when absent (ZM-DOC-001)', () => {
    const checks = runChecks(facts({ electronicInvoiceDocument: null }));
    expect(check(checks, 'COMPLETENESS').result).toBe('MISSING');
    expect(check(checks, 'COMPLETENESS').details.missing).toContain('electronicInvoiceDocument');
  });

  it('reports missing declarations', () => {
    const checks = runChecks(facts({ declarationsRecorded: false }));
    expect(check(checks, 'COMPLETENESS').details.missing).toContain('declarations');
  });

  it('reports an unresolved buyer (ZM-BUY-003)', () => {
    const checks = runChecks(facts({ buyer: null }));
    expect(check(checks, 'COMPLETENESS').details.missing).toContain('buyer');
  });
});

describe('duplicate detection (ZM-VER-001)', () => {
  it('fails on a collision', () => {
    const checks = runChecks(facts({ duplicate: { collided: true, existingTransactionId: 't9' } }));
    expect(check(checks, 'DUPLICATE').result).toBe('FAIL');
  });

  it('a duplicate alone does not mean fraud — it routes to review', () => {
    // ZM-VER-002. Only a file-integrity failure escalates to FRAUD_REVIEW;
    // submission is separately blocked with a 409 before the pipeline runs.
    const checks = runChecks(facts({ duplicate: { collided: true } }));
    expect(outcomeOf(checks)).toBe('UNDER_REVIEW');
  });
});

describe('transaction logic', () => {
  it('reports a broken outstanding formula (ZM-INV-001)', () => {
    const base = facts();
    const checks = runChecks(
      facts({ invoice: { ...base.invoice!, outstandingAmount: '9999.000' } }),
    );
    expect(check(checks, 'LOGIC').details.problems).toContain('OUTSTANDING_FORMULA_MISMATCH');
  });

  it('reports a non-JOD currency (ZM-INV-002)', () => {
    const base = facts();
    const checks = runChecks(facts({ invoice: { ...base.invoice!, currency: 'USD' } }));
    expect(check(checks, 'LOGIC').details.problems).toContain('CURRENCY_NOT_JOD');
  });

  it('reports components that do not sum', () => {
    const base = facts();
    const checks = runChecks(facts({ invoice: { ...base.invoice!, taxAmount: '1.000' } }));
    expect(check(checks, 'LOGIC').details.problems).toContain('COMPONENTS_DO_NOT_SUM');
  });

  it('reports a due date before the issue date', () => {
    const base = facts();
    const checks = runChecks(facts({ invoice: { ...base.invoice!, dueDate: '2026-05-01' } }));
    expect(check(checks, 'LOGIC').details.problems).toContain('DUE_BEFORE_ISSUE');
  });
});

describe('party eligibility', () => {
  it('AS-07: a past-due invoice is not eligible', () => {
    const base = facts();
    const checks = runChecks(facts({ invoice: { ...base.invoice!, dueDate: '2026-03-05' } }));
    expect(check(checks, 'ELIGIBILITY').details.problems).toContain('PAST_DUE');
    expect(outcomeOf(checks)).toBe('UNDER_REVIEW');
  });

  it('AS-08: below the minimum tenor is not eligible', () => {
    const base = facts();
    // Three days to maturity, against a seven-day floor.
    const checks = runChecks(facts({ invoice: { ...base.invoice!, dueDate: '2026-06-18' } }));
    const problems = check(checks, 'ELIGIBILITY').details.problems as string[];
    expect(problems.some((p) => p.startsWith('BELOW_MIN_TENOR'))).toBe(true);
  });

  it('exactly the minimum tenor is acceptable', () => {
    // "Now" is 2026-06-15T09:00Z and due dates are midnight UTC, so the
    // remaining tenor is counted in WHOLE days and rounds down: a due date
    // on the 23rd is 7d15h away and counts as 7. That conservative
    // direction is deliberate — the count never overstates how long a bank
    // has until maturity.
    const base = facts();
    const checks = runChecks(facts({ invoice: { ...base.invoice!, dueDate: '2026-06-23' } }));
    expect(check(checks, 'ELIGIBILITY').result).toBe('PASS');
  });

  it('one day short of the minimum tenor is refused', () => {
    const base = facts();
    const checks = runChecks(facts({ invoice: { ...base.invoice!, dueDate: '2026-06-22' } }));
    const problems = check(checks, 'ELIGIBILITY').details.problems as string[];
    expect(problems.some((p) => p.startsWith('BELOW_MIN_TENOR'))).toBe(true);
  });

  it('reads the tenor floor from settings rather than assuming seven days', () => {
    const base = facts();
    const checks = runChecks(
      facts({ invoice: { ...base.invoice!, dueDate: '2026-06-25' }, minTenorDays: 30 }),
    );
    const problems = check(checks, 'ELIGIBILITY').details.problems as string[];
    expect(problems.some((p) => p.startsWith('BELOW_MIN_TENOR'))).toBe(true);
  });

  it('blocks a suspended buyer', () => {
    const base = facts();
    const checks = runChecks(facts({ buyer: { ...base.buyer!, registryStatus: 'SUSPENDED' } }));
    expect(check(checks, 'ELIGIBILITY').details.problems).toContain('BUYER_BLOCKED:SUSPENDED');
  });

  it('sends a buyer under liquidation to review, not to a block (LT-02)', () => {
    const base = facts();
    const checks = runChecks(
      facts({ buyer: { ...base.buyer!, registryStatus: 'UNDER_LIQUIDATION' } }),
    );
    expect(check(checks, 'ELIGIBILITY').details.problems).toContain('BUYER_UNDER_LIQUIDATION');
    expect(check(checks, 'ELIGIBILITY').result).toBe('REVIEW');
  });

  it('a conditionally-approved supplier cannot raise finance (ZM-SON-011)', () => {
    const base = facts();
    const checks = runChecks(
      facts({ supplier: { ...base.supplier, status: 'APPROVED_CONDITIONAL' } }),
    );
    expect(check(checks, 'ELIGIBILITY').details.problems).toContain(
      'SUPPLIER_NOT_ACTIVE:APPROVED_CONDITIONAL',
    );
  });
});

describe('file integrity', () => {
  it('a changed stored file fails and escalates to fraud review', () => {
    const checks = runChecks(
      facts({ electronicInvoiceDocument: { id: 'd1', fileHash: 'abc', storedHashMatches: false } }),
    );
    expect(check(checks, 'FILE_INTEGRITY').result).toBe('FAIL');
    expect(outcomeOf(checks)).toBe('FRAUD_REVIEW');
  });

  it('an unreadable stored object is a review, not a fraud escalation', () => {
    // Infrastructure trouble is not evidence about the supplier's file.
    const checks = runChecks(
      facts({ electronicInvoiceDocument: { id: 'd1', fileHash: 'abc', storedHashMatches: null } }),
    );
    expect(check(checks, 'FILE_INTEGRITY').result).toBe('REVIEW');
    expect(outcomeOf(checks)).toBe('UNDER_REVIEW');
  });
});

describe('OCR and QR consistency (ZM-DOC-005b, ZM-DOC-008)', () => {
  it('flags a disagreement between OCR and the supplier-confirmed value', () => {
    const base = facts();
    const checks = runChecks(
      facts({ ocr: { available: true, fields: { ...base.ocr!.fields, faceValue: '24500.000' } } }),
    );
    expect(check(checks, 'OCR_CONSISTENCY').result).toBe('REVIEW');
  });

  it('treats an unpadded amount as agreement, not a mismatch', () => {
    // "12354" and "12354.000" are the same money. Reporting that as a
    // mismatch would train reviewers to dismiss the check.
    const base = facts();
    const checks = runChecks(
      facts({ ocr: { available: true, fields: { ...base.ocr!.fields, faceValue: '12354' } } }),
    );
    expect(check(checks, 'OCR_CONSISTENCY').result).toBe('PASS');
  });

  it('does not treat a field OCR simply missed as a mismatch', () => {
    const checks = runChecks(facts({ ocr: { available: true, fields: { invoiceNumber: 'INV-2026-0001' } } }));
    expect(check(checks, 'OCR_CONSISTENCY').result).toBe('PASS');
  });

  it('reports UNPARSED when OCR produced no reading', () => {
    const checks = runChecks(facts({ ocr: { available: false, fields: {} } }));
    expect(check(checks, 'OCR_CONSISTENCY').result).toBe('UNPARSED');
    expect(outcomeOf(checks)).toBe('UNDER_REVIEW');
  });

  describe('a missing QR is different from an unreadable one', () => {
    it('no code on the page is NOT_APPLICABLE and does not block eligibility', () => {
      const checks = runChecks(facts({ qr: { validationStatus: 'UNAVAILABLE', fields: {} } }));
      expect(check(checks, 'QR_CONSISTENCY').result).toBe('NOT_APPLICABLE');
      expect(outcomeOf(checks)).toBe('ELIGIBLE');
    });

    it('a code we could not understand is UNPARSED and routes to review', () => {
      const checks = runChecks(facts({ qr: { validationStatus: 'UNPARSED', fields: {} } }));
      expect(check(checks, 'QR_CONSISTENCY').result).toBe('UNPARSED');
      expect(outcomeOf(checks)).toBe('UNDER_REVIEW');
    });

    it('the two outcomes are distinguishable', () => {
      const absent = runChecks(facts({ qr: { validationStatus: 'UNAVAILABLE', fields: {} } }));
      const unreadable = runChecks(facts({ qr: { validationStatus: 'UNPARSED', fields: {} } }));
      expect(check(absent, 'QR_CONSISTENCY').result).not.toBe(
        check(unreadable, 'QR_CONSISTENCY').result,
      );
    });
  });

  it('reports a QR that disagrees with OCR even when both differ from the invoice', () => {
    const checks = runChecks(
      facts({
        ocr: { available: true, fields: { faceValue: '24500.000' } },
        qr: { validationStatus: 'VALID', fields: { faceValue: '25000.000' } },
      }),
    );
    expect((check(checks, 'QR_CONSISTENCY').details as { disagreesWithOcr: string[] }).disagreesWithOcr).toContain(
      'faceValue',
    );
  });

  it('a validator rejection routes to review', () => {
    const checks = runChecks(facts({ qr: { validationStatus: 'INVALID', fields: {} } }));
    expect(check(checks, 'QR_CONSISTENCY').result).toBe('REVIEW');
  });
});

describe('identity match', () => {
  it('flags a party identifier that disagrees with the platform record', () => {
    const base = facts();
    const checks = runChecks(
      facts({
        ocr: { available: true, fields: { ...base.ocr!.fields, buyerEstablishmentNumber: '30000209' } },
      }),
    );
    expect(check(checks, 'IDENTITY_MATCH').result).toBe('REVIEW');
    expect(check(checks, 'IDENTITY_MATCH').details.conflicts).toContain('buyerEstablishmentNumber');
  });

  it('is NOT_APPLICABLE rather than PASS when nothing could be compared', () => {
    // A pass here would claim the parties were verified against the
    // document when no comparison happened at all.
    const checks = runChecks(
      facts({ ocr: { available: true, fields: {} }, qr: { validationStatus: 'VALID', fields: {} } }),
    );
    expect(check(checks, 'IDENTITY_MATCH').result).toBe('NOT_APPLICABLE');
  });
});

describe('overall result and routing', () => {
  it('any FAIL makes the run FAIL', () => {
    expect(overallResultOf([{ checkType: 'DUPLICATE', result: 'FAIL', details: {} }])).toBe('FAIL');
  });

  it('a REVIEW without a FAIL makes the run REVIEW', () => {
    expect(
      overallResultOf([
        { checkType: 'LOGIC', result: 'PASS', details: {} },
        { checkType: 'ELIGIBILITY', result: 'REVIEW', details: {} },
      ]),
    ).toBe('REVIEW');
  });

  it('NOT_APPLICABLE does not spoil a pass', () => {
    expect(
      overallResultOf([
        { checkType: 'LOGIC', result: 'PASS', details: {} },
        { checkType: 'QR_CONSISTENCY', result: 'NOT_APPLICABLE', details: {} },
      ]),
    ).toBe('PASS');
  });

  it('only a file-integrity failure escalates to fraud review (ZM-VER-002)', () => {
    const nonIntegrityFailures: CheckOutcome[] = [
      { checkType: 'DUPLICATE', result: 'FAIL', details: {} },
      { checkType: 'LOGIC', result: 'FAIL', details: {} },
      { checkType: 'OCR_CONSISTENCY', result: 'FAIL', details: {} },
    ];
    for (const failure of nonIntegrityFailures) {
      expect(outcomeOf([failure])).toBe('UNDER_REVIEW');
    }
    const integrityFailure: CheckOutcome = {
      checkType: 'FILE_INTEGRITY',
      result: 'FAIL',
      details: {},
    };
    expect(outcomeOf([integrityFailure])).toBe('FRAUD_REVIEW');
  });
});
