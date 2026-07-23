import { known, unavailable, type RiskFacts } from './facts';
import {
  allComponents,
  bandOf,
  collectCodes,
  compositeOf,
  dataAvailabilityPct,
  DEFAULT_WEIGHTS,
  scoreComponent,
  scored,
  missing,
} from './scoring';
import { capForBlockers, hardBlockers, BLOCKED_SCORE_CEILING } from './rules-engine';
import { INFO_CODES, NON_SCORING_CODES } from './reason-codes';

/**
 * A fully-known, unremarkable transaction. Every test below starts here and
 * changes exactly one thing, so a failure names its own cause.
 */
function baseFacts(): RiskFacts {
  return {
    transactionId: '00000000-0000-4000-8000-000000000001',
    supplier: {
      organizationId: '0e000000-0000-4000-8000-000000000002',
      status: 'ACTIVE',
      registryStatus: known('ACTIVE'),
      bankAccountVerified: known(true),
      signatoryMatches: known(true),
      taxStatusValid: known(true),
      provenance: [
        { sourceKind: 'GOVERNMENT', ageDays: 10 },
        { sourceKind: 'GOVERNMENT', ageDays: 30 },
        { sourceKind: 'SELF_DECLARED', ageDays: 5 },
      ],
      unobtainedFieldCount: 0,
      expectedFieldCount: 3,
    },
    buyer: {
      registryStatus: known('ACTIVE'),
      companyAgeYears: known(8),
      priorTransactionsWithSupplier: known(6),
      onTimePaymentRatio: known(0.95),
    },
    invoice: {
      present: true,
      tenorDays: known(90),
      minTenorDays: 7,
      pastDue: false,
      completenessRatio: known(1),
      electronicInvoiceAttached: true,
      fileIntegrityOk: known(true),
      ocrConsistent: known(true),
      qrStatus: known('VALID'),
      duplicateCollision: false,
      partiallyPaid: false,
      declarationsRecorded: true,
    },
    platform: {
      priorSubmittedCount: 4,
      disputeCount: 0,
      duplicateReferralCount: 0,
      recourseCount: 0,
    },
  };
}

/**
 * The same transaction, with every GOVERNMENT-SOURCED fact unobtainable.
 *
 * Note what is NOT changed: the buyer is still the same buyer, the invoice is
 * still the same invoice. Nothing adverse has been learned. The only
 * difference is that the platform could not reach the sources.
 */
function sourcesDownFacts(): RiskFacts {
  const base = baseFacts();
  return {
    ...base,
    supplier: {
      ...base.supplier,
      registryStatus: unavailable('SOURCE_UNAVAILABLE'),
      bankAccountVerified: unavailable('SOURCE_UNAVAILABLE'),
      signatoryMatches: unavailable('SOURCE_UNAVAILABLE'),
      taxStatusValid: unavailable('SOURCE_UNAVAILABLE'),
      provenance: [],
      unobtainedFieldCount: 3,
    },
    buyer: {
      registryStatus: unavailable('SOURCE_UNAVAILABLE'),
      companyAgeYears: unavailable('SOURCE_UNAVAILABLE'),
      priorTransactionsWithSupplier: unavailable('SOURCE_UNAVAILABLE'),
      onTimePaymentRatio: unavailable('SOURCE_UNAVAILABLE'),
    },
  };
}

describe('INV-9 — government unavailability never reduces the score', () => {
  it('leaves every component identical when the sources are down', () => {
    const available = allComponents(baseFacts());
    const down = allComponents(sourcesDownFacts());

    // The paired-fixture assertion the phase file names as a Definition-of-
    // Done item. Identical facts, one pair with sources reachable and one
    // without: not "similar", not "within tolerance" — identical.
    for (const key of ['supplierVerification', 'invoiceScore', 'platformBehavior'] as const) {
      const a = available.find((c) => c.key === key)!;
      const b = down.find((c) => c.key === key)!;
      expect(b.score).toBe(a.score);
    }
  });

  it('reduces dataAvailabilityPct instead', () => {
    const available = dataAvailabilityPct(allComponents(baseFacts()));
    const down = dataAvailabilityPct(allComponents(sourcesDownFacts()));

    expect(available).toBe(100);
    expect(down).toBeLessThan(available);
  });

  it('does not lower the composite when sources are unreachable', () => {
    const availableComposite = compositeOf(allComponents(baseFacts()), DEFAULT_WEIGHTS);
    const downComposite = compositeOf(allComponents(sourcesDownFacts()), DEFAULT_WEIGHTS);

    // Renormalisation over scorable components is what makes this hold. If
    // an unscorable component were treated as zero, this would fail — which
    // is exactly the regression this test exists to catch.
    expect(downComposite).toBeGreaterThanOrEqual(availableComposite);
  });

  it('reports the outage as an INFO factor, never as a risk factor', () => {
    const { riskFactors, infoFactors } = collectCodes(allComponents(sourcesDownFacts()));

    expect(infoFactors).toContain(INFO_CODES.GOVERNMENT_SOURCE_UNAVAILABLE);
    for (const code of riskFactors) {
      expect(NON_SCORING_CODES.has(code)).toBe(false);
    }
  });

  it('distinguishes "not published" from "source down" in the code it emits', () => {
    // ZM-RSK-008: the distinction survives to the UI, so a banker is told
    // which of the two happened rather than a generic "unknown".
    const base = baseFacts();
    const notPublished = allComponents({
      ...base,
      buyer: { ...base.buyer, companyAgeYears: unavailable('NOT_PUBLISHED') },
    });
    expect(collectCodes(notPublished).infoFactors).toContain(INFO_CODES.FIELD_NOT_PUBLISHED);
  });

  it('drops an unavailable signal from the denominator, not just the numerator', () => {
    // The arithmetic claim in isolation. Scoring an unavailable signal as
    // zero would give 50; dropping it entirely gives 100.
    const result = scoreComponent('buyerProfile', [
      scored('a', 1, 1),
      missing('b', 1, INFO_CODES.GOVERNMENT_SOURCE_UNAVAILABLE),
    ]);
    expect(result.score).toBe(100);
  });

  it('scores a component as null rather than zero when nothing is knowable', () => {
    const result = scoreComponent('buyerProfile', [
      missing('a', 1, INFO_CODES.GOVERNMENT_SOURCE_UNAVAILABLE),
    ]);
    expect(result.score).toBeNull();
  });
});

describe('adverse findings DO reduce the score (ZM-RSK-007)', () => {
  it('separates "registry says struck off" from "registry did not answer"', () => {
    const base = baseFacts();
    const adverse = allComponents({
      ...base,
      buyer: { ...base.buyer, registryStatus: known('STRUCK_OFF') },
    });
    const silent = allComponents({
      ...base,
      buyer: { ...base.buyer, registryStatus: unavailable('SOURCE_UNAVAILABLE') },
    });

    const adverseScore = adverse.find((c) => c.key === 'buyerProfile')!.score!;
    const silentScore = silent.find((c) => c.key === 'buyerProfile')!.score!;

    // The whole product rests on these two numbers being different.
    expect(adverseScore).toBeLessThan(silentScore);
  });
});

describe('AS-05 band thresholds', () => {
  it.each([
    [100, 'LOW'],
    [75, 'LOW'],
    [74, 'MEDIUM'],
    [50, 'MEDIUM'],
    [49, 'HIGH'],
    [25, 'HIGH'],
    [24, 'CRITICAL'],
    [0, 'CRITICAL'],
  ])('scores %i as %s', (score, band) => {
    expect(bandOf(score)).toBe(band);
  });
});

describe('ZM-RSK-015 — the model cannot override a deterministic blocker', () => {
  it('caps a blocked transaction below the CRITICAL threshold', () => {
    const base = baseFacts();
    const blocked = { ...base, invoice: { ...base.invoice, duplicateCollision: true } };
    const blockers = hardBlockers(blocked);

    expect(blockers.length).toBeGreaterThan(0);
    // Even given a perfect model score, the cap is applied last.
    expect(bandOf(capForBlockers(100, blockers))).toBe('CRITICAL');
  });

  it('does not raise a low score just because it was blocked', () => {
    const blockers = hardBlockers({
      ...baseFacts(),
      invoice: { ...baseFacts().invoice, duplicateCollision: true },
    });
    expect(capForBlockers(5, blockers)).toBe(5);
    expect(capForBlockers(100, blockers)).toBe(BLOCKED_SCORE_CEILING);
  });

  it('never blocks because a source was unavailable', () => {
    // The most important negative in the file: an outage must not manufacture
    // a blocker, or INV-9 is defeated one layer up from the arithmetic.
    expect(hardBlockers(sourcesDownFacts())).toHaveLength(0);
  });

  it('blocks a struck-off buyer but not one under liquidation (LT-02)', () => {
    const base = baseFacts();
    const struck = hardBlockers({
      ...base,
      buyer: { ...base.buyer, registryStatus: known('STRUCK_OFF') },
    });
    const liquidating = hardBlockers({
      ...base,
      buyer: { ...base.buyer, registryStatus: known('UNDER_LIQUIDATION') },
    });

    expect(struck.map((b) => b.code)).toContain('BLOCK_BUYER_STRUCK_OFF');
    expect(liquidating).toHaveLength(0);
  });

  it('blocks a past-due invoice (AS-07) and a too-short tenor (AS-08)', () => {
    const base = baseFacts();
    expect(
      hardBlockers({ ...base, invoice: { ...base.invoice, pastDue: true } }).map((b) => b.code),
    ).toContain('BLOCK_INVOICE_PAST_DUE');
    expect(
      hardBlockers({ ...base, invoice: { ...base.invoice, tenorDays: known(3) } }).map(
        (b) => b.code,
      ),
    ).toContain('BLOCK_TENOR_TOO_SHORT');
  });
});

describe('the clean baseline', () => {
  it('scores well and reports no blockers', () => {
    const facts = baseFacts();
    const components = allComponents(facts);
    const composite = compositeOf(components, DEFAULT_WEIGHTS);

    expect(hardBlockers(facts)).toHaveLength(0);
    expect(composite).toBeGreaterThanOrEqual(75);
    expect(bandOf(composite)).toBe('LOW');
    expect(dataAvailabilityPct(components)).toBe(100);
  });

  it('produces every component as an integer in 0..100', () => {
    for (const component of allComponents(baseFacts())) {
      expect(component.score).not.toBeNull();
      expect(Number.isInteger(component.score)).toBe(true);
      expect(component.score!).toBeGreaterThanOrEqual(0);
      expect(component.score!).toBeLessThanOrEqual(100);
    }
  });

  it('does not penalise a supplier for having no platform history', () => {
    // "New" is not "bad" — a first-time supplier must be financeable.
    const base = baseFacts();
    const newcomer = allComponents({
      ...base,
      platform: { ...base.platform, priorSubmittedCount: 0 },
    });
    expect(newcomer.find((c) => c.key === 'platformBehavior')!.score!).toBeGreaterThan(50);
  });
});
