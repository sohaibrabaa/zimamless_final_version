import {
  BuyerCandidate,
  isBlockingStatus,
  needsManualReview,
  requiresManualReviewStatus,
  resolutionStatusFor,
} from './buyer-policy';

/**
 * Buyer policy — including the phase's "never auto-select" definition-of-done
 * test (ZM-BUY-009).
 */

const candidate = (overrides: Partial<BuyerCandidate> = {}): BuyerCandidate => ({
  nationalEstablishmentNumber: '30000201',
  legalCompanyName: 'Amman Retail Group',
  companyType: 'LIMITED_LIABILITY',
  registryStatus: 'ACTIVE',
  governorate: 'Amman',
  matchSource: 'PLATFORM',
  buyerId: 'b1',
  ...overrides,
});

describe('buyer registry status policy (§7.4)', () => {
  it.each(['SUSPENDED', 'STRUCK_OFF'] as const)('blocks %s outright', (status) => {
    expect(isBlockingStatus(status)).toBe(true);
  });

  it('does NOT block UNDER_LIQUIDATION — LT-02 routes it to manual review', () => {
    // A company in liquidation can still owe money. Whether that receivable
    // is financeable is a judgement, not a rule, so it must reach a human
    // rather than being refused automatically.
    expect(isBlockingStatus('UNDER_LIQUIDATION')).toBe(false);
    expect(requiresManualReviewStatus('UNDER_LIQUIDATION')).toBe(true);
  });

  it('does not block ACTIVE', () => {
    expect(isBlockingStatus('ACTIVE')).toBe(false);
    expect(requiresManualReviewStatus('ACTIVE')).toBe(false);
  });

  it('sends UNKNOWN to manual review rather than treating it as fine', () => {
    expect(requiresManualReviewStatus('UNKNOWN')).toBe(true);
  });
});

describe('never auto-selects a buyer (ZM-BUY-009)', () => {
  /**
   * The definition-of-done test named in the phase file: "buyer never
   * auto-select test (100% name match still returns candidates only)".
   */
  it('a single exact match is still only a candidate', () => {
    const exact = [candidate({ legalCompanyName: 'Amman Retail Group' })];

    // Not ambiguous...
    expect(needsManualReview(exact)).toBe(false);
    // ...and still not selected. The search result is a list, and the
    // recorded status is never MATCHED — only /buyers/resolve, with the
    // supplier's explicit confirmation, can produce that.
    expect(resolutionStatusFor(exact, false)).not.toBe('MATCHED');
    expect(resolutionStatusFor(exact, false)).toBe('PARTIAL_MATCH');
  });

  it('the ambiguity check returns a flag, never a chosen candidate', () => {
    // Structural, not behavioural: needsManualReview has no way to express
    // a selection, so no future edit can make it start choosing one.
    const result = needsManualReview([candidate()]);
    expect(typeof result).toBe('boolean');
  });

  it('no search outcome is ever recorded as MATCHED', () => {
    const cases: [BuyerCandidate[], boolean][] = [
      [[], false],
      [[candidate()], false],
      [[candidate(), candidate({ nationalEstablishmentNumber: '30000202', buyerId: 'b2' })], true],
      [[candidate({ registryStatus: 'SUSPENDED' })], false],
      [[candidate({ registryStatus: 'UNDER_LIQUIDATION' })], true],
    ];
    for (const [candidates, review] of cases) {
      expect(resolutionStatusFor(candidates, review)).not.toBe('MATCHED');
    }
  });
});

describe('ambiguity routing (ZM-BUY-010)', () => {
  it('no results needs review', () => {
    expect(needsManualReview([])).toBe(true);
    expect(resolutionStatusFor([], true)).toBe('NOT_FOUND');
  });

  it('two different companies need review', () => {
    const two = [
      candidate(),
      candidate({ nationalEstablishmentNumber: '30000202', legalCompanyName: 'Amman Retail Ltd', buyerId: 'b2' }),
    ];
    expect(needsManualReview(two)).toBe(true);
    expect(resolutionStatusFor(two, true)).toBe('MANUAL_REVIEW');
  });

  it('the same company found twice is not ambiguous', () => {
    // One buyer reached through both the supplier's own relationships and
    // the platform index is one company, not a choice to be made.
    const duplicated = [
      candidate({ matchSource: 'OWN_RELATIONSHIP' }),
      candidate({ matchSource: 'PLATFORM' }),
    ];
    expect(needsManualReview(duplicated)).toBe(false);
  });

  it('a candidate needing review taints the whole result', () => {
    expect(needsManualReview([candidate({ registryStatus: 'UNDER_LIQUIDATION' })])).toBe(true);
  });

  it('records BLOCKED when every candidate is blocked', () => {
    const blocked = [candidate({ registryStatus: 'SUSPENDED' })];
    expect(resolutionStatusFor(blocked, false)).toBe('BLOCKED');
  });
});
