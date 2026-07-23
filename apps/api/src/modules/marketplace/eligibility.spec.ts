import { Money } from '../../common/money/money';
import { evaluateBank, evaluateFilter, type ListingFacts, type PolicyFilter } from './eligibility';

const m = (s: string): Money => Money.from(s);

const facts = (over: Partial<ListingFacts> = {}): ListingFacts => ({
  outstandingAmount: m('12354.000'),
  tenorDays: 90,
  trustScore: 81,
  riskBand: 'LOW',
  supplierOrgId: '0e000000-0000-4000-8000-000000000002',
  supplierSector: 'MANUFACTURING',
  supplierGovernorate: 'AMMAN',
  buyerId: '0e300000-0000-4000-8000-000000000001',
  ...over,
});

const filter = (over: Partial<PolicyFilter> = {}): PolicyFilter => ({
  id: 'f1',
  name: 'Default appetite',
  isActive: true,
  minAmount: null,
  maxAmount: null,
  minTenorDays: null,
  maxTenorDays: null,
  acceptedTransactionTypes: null,
  acceptedRecourseTypes: null,
  minTrustScore: null,
  maxRiskBand: null,
  sectorsInclude: null,
  sectorsExclude: null,
  governoratesInclude: null,
  buyerExcludeIds: null,
  supplierExcludeIds: null,
  ...over,
});

describe('evaluateFilter — the rules_applied trace (ZM-MKT-003)', () => {
  it('records only rules the bank actually configured', () => {
    // An unset field is not a rule. Recording it as a pass would fill the
    // trace with rules nobody wrote and make the record useless for
    // answering "why did this bank not see the listing?".
    const decision = evaluateFilter(filter({ minAmount: m('1000.000') }), facts());
    expect(decision.rulesApplied.map((r) => r.rule)).toEqual(['MIN_AMOUNT']);
  });

  it('records passing rules too, not only failures', () => {
    // "The amount rule was checked and passed" must be distinguishable from
    // "the amount rule was never checked".
    const decision = evaluateFilter(
      filter({ minAmount: m('1000.000'), maxAmount: m('50000.000') }),
      facts(),
    );
    expect(decision.status).toBe('ELIGIBLE');
    expect(decision.rulesApplied).toHaveLength(2);
    expect(decision.rulesApplied.every((r) => r.passed)).toBe(true);
  });

  it('records what was expected and what was presented', () => {
    const decision = evaluateFilter(filter({ maxAmount: m('5000.000') }), facts());
    const [rule] = decision.rulesApplied;
    expect(rule.expected).toBe('<= 5000.000');
    expect(rule.actual).toBe('12354.000');
    expect(decision.reason).toContain('MAX_AMOUNT');
  });

  it('applies amount bounds inclusively at both ends', () => {
    expect(evaluateFilter(filter({ minAmount: m('12354.000') }), facts()).status)
      .toBe('ELIGIBLE');
    expect(evaluateFilter(filter({ maxAmount: m('12354.000') }), facts()).status)
      .toBe('ELIGIBLE');
    expect(evaluateFilter(filter({ minAmount: m('12354.001') }), facts()).status)
      .toBe('NOT_ELIGIBLE');
  });

  it('applies tenor bounds inclusively', () => {
    expect(evaluateFilter(filter({ minTenorDays: 90, maxTenorDays: 90 }), facts()).status)
      .toBe('ELIGIBLE');
    expect(evaluateFilter(filter({ maxTenorDays: 89 }), facts()).status).toBe('NOT_ELIGIBLE');
  });

  it('orders risk bands best-to-worst', () => {
    expect(evaluateFilter(filter({ maxRiskBand: 'MEDIUM' }), facts({ riskBand: 'LOW' })).status)
      .toBe('ELIGIBLE');
    expect(evaluateFilter(filter({ maxRiskBand: 'MEDIUM' }), facts({ riskBand: 'MEDIUM' })).status)
      .toBe('ELIGIBLE');
    expect(evaluateFilter(filter({ maxRiskBand: 'MEDIUM' }), facts({ riskBand: 'HIGH' })).status)
      .toBe('NOT_ELIGIBLE');
  });

  it('does NOT exclude a listing that has no score yet', () => {
    // INV-9's shape one layer out: "not yet scored" is an absence, not a bad
    // score. Excluding on it would penalise the supplier for the platform's
    // own gap, and the bank can apply its own judgement instead.
    const unscored = facts({ trustScore: null, riskBand: null });
    expect(evaluateFilter(filter({ minTrustScore: 90 }), unscored).status).toBe('ELIGIBLE');
    expect(evaluateFilter(filter({ maxRiskBand: 'LOW' }), unscored).status).toBe('ELIGIBLE');
  });

  it('still records the unscored rule in the trace', () => {
    const decision = evaluateFilter(
      filter({ minTrustScore: 90 }), facts({ trustScore: null }),
    );
    expect(decision.rulesApplied[0].actual).toBe('not yet scored');
  });

  it('honours sector include and exclude lists', () => {
    expect(evaluateFilter(filter({ sectorsInclude: ['RETAIL'] }), facts()).status)
      .toBe('NOT_ELIGIBLE');
    expect(evaluateFilter(filter({ sectorsInclude: ['MANUFACTURING'] }), facts()).status)
      .toBe('ELIGIBLE');
    expect(evaluateFilter(filter({ sectorsExclude: ['MANUFACTURING'] }), facts()).status)
      .toBe('NOT_ELIGIBLE');
  });

  it('honours supplier and buyer exclusion lists', () => {
    const supplierId = facts().supplierOrgId;
    expect(evaluateFilter(filter({ supplierExcludeIds: [supplierId] }), facts()).status)
      .toBe('NOT_ELIGIBLE');
    expect(evaluateFilter(filter({ buyerExcludeIds: [facts().buyerId!] }), facts()).status)
      .toBe('NOT_ELIGIBLE');
  });
});

describe('evaluateBank — across a bank’s filters', () => {
  it('treats a bank with no filters as eligible for everything', () => {
    const decision = evaluateBank([], facts());
    expect(decision.status).toBe('ELIGIBLE');
    // Recorded explicitly, so "no restrictions declared" is never mistaken
    // for "a filter happened to pass".
    expect(decision.rulesApplied[0].rule).toBe('NO_FILTERS_CONFIGURED');
  });

  it('ignores inactive filters', () => {
    const blocking = filter({ isActive: false, maxAmount: m('1.000') });
    expect(evaluateBank([blocking], facts()).status).toBe('ELIGIBLE');
  });

  it('is disjunctive — any passing filter admits the listing', () => {
    // Two appetites, one for small tickets and one for large. Requiring both
    // would mean adding an appetite REMOVES listings, which is the opposite
    // of what a bank means by configuring a second one.
    const small = filter({ id: 'a', name: 'Small', maxAmount: m('5000.000') });
    const large = filter({ id: 'b', name: 'Large', minAmount: m('10000.000') });
    expect(evaluateBank([small, large], facts()).status).toBe('ELIGIBLE');
  });

  it('is NOT_ELIGIBLE only when every filter fails', () => {
    const a = filter({ id: 'a', name: 'A', maxAmount: m('100.000') });
    const b = filter({ id: 'b', name: 'B', minTenorDays: 365 });
    const decision = evaluateBank([a, b], facts());
    expect(decision.status).toBe('NOT_ELIGIBLE');
    expect(decision.reason).toContain('A —');
    expect(decision.reason).toContain('B —');
  });

  it('tags each trace entry with the filter it came from', () => {
    const a = filter({ id: 'a', name: 'Small', maxAmount: m('100.000') });
    const b = filter({ id: 'b', name: 'Large', minAmount: m('999999.000') });
    const decision = evaluateBank([a, b], facts());
    expect(decision.rulesApplied.map((r) => r.rule)).toEqual([
      'Small/MAX_AMOUNT',
      'Large/MIN_AMOUNT',
    ]);
  });

  it('records the full trace even when the bank is eligible', () => {
    const decision = evaluateBank([filter({ minAmount: m('1.000') })], facts());
    expect(decision.rulesApplied).toHaveLength(1);
    expect(decision.reason).toBeNull();
  });
});
