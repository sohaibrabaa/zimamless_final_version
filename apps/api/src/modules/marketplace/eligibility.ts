import { Money } from '../../common/money/money';

/**
 * Policy-filter evaluation (ZM-MKT-003).
 *
 * A bank declares its appetite as a set of filters; the platform decides, per
 * listing, which banks may see it. The requirement is not just the decision
 * but the **record**: `bank_eligibility.rules_applied` must say which rules
 * were evaluated and what each one concluded, so that "why did bank C not see
 * this listing?" is answerable months later without re-deriving it from a
 * filter that may since have changed.
 *
 * So evaluation returns a trace, not a boolean. Every rule that ran appears
 * in the trace whether it passed or failed — a trace containing only failures
 * would leave "the amount rule was checked and passed" indistinguishable from
 * "the amount rule was never checked because the filter did not set one".
 *
 * Purity is deliberate: no database, no clock, no injected services. The
 * whole decision is a function of the filter and the listing facts, which is
 * what makes it testable at the boundary values that matter.
 */

export type EligibilityStatus = 'ELIGIBLE' | 'NOT_ELIGIBLE';

export type RiskBand = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** Ordered best-to-worst, so "max risk band" is a position in this list. */
const BAND_ORDER: readonly RiskBand[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export interface PolicyFilter {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly minAmount: Money | null;
  readonly maxAmount: Money | null;
  readonly minTenorDays: number | null;
  readonly maxTenorDays: number | null;
  readonly acceptedTransactionTypes: readonly string[] | null;
  readonly acceptedRecourseTypes: readonly string[] | null;
  readonly minTrustScore: number | null;
  readonly maxRiskBand: RiskBand | null;
  readonly sectorsInclude: readonly string[] | null;
  readonly sectorsExclude: readonly string[] | null;
  readonly governoratesInclude: readonly string[] | null;
  readonly buyerExcludeIds: readonly string[] | null;
  readonly supplierExcludeIds: readonly string[] | null;
}

/** The listing facts a filter can be evaluated against. */
export interface ListingFacts {
  readonly outstandingAmount: Money;
  readonly tenorDays: number;
  readonly trustScore: number | null;
  readonly riskBand: RiskBand | null;
  readonly supplierOrgId: string;
  readonly supplierSector: string | null;
  readonly supplierGovernorate: string | null;
  readonly buyerId: string | null;
}

export interface RuleResult {
  /** Stable identifier, safe to store and to key a translation from. */
  readonly rule: string;
  readonly passed: boolean;
  /** What the filter required, as configured. Operator-facing. */
  readonly expected: string;
  /** What the listing presented. Operator-facing. */
  readonly actual: string;
}

export interface EligibilityDecision {
  readonly status: EligibilityStatus;
  readonly rulesApplied: readonly RuleResult[];
  /** First failing rule, for the human-readable `reason` column. */
  readonly reason: string | null;
}

function rule(name: string, passed: boolean, expected: string, actual: string): RuleResult {
  return { rule: name, passed, expected, actual };
}

/**
 * Evaluates one filter against one listing.
 *
 * Rules whose filter field is null are **not evaluated and not recorded** —
 * an unset field is not a rule the bank declared, and recording it as a pass
 * would inflate the trace with rules nobody wrote.
 */
export function evaluateFilter(filter: PolicyFilter, facts: ListingFacts): EligibilityDecision {
  const results: RuleResult[] = [];

  if (filter.minAmount !== null) {
    results.push(
      rule(
        'MIN_AMOUNT',
        facts.outstandingAmount.greaterThanOrEqual(filter.minAmount),
        `>= ${filter.minAmount.toString()}`,
        facts.outstandingAmount.toString(),
      ),
    );
  }
  if (filter.maxAmount !== null) {
    results.push(
      rule(
        'MAX_AMOUNT',
        filter.maxAmount.greaterThanOrEqual(facts.outstandingAmount),
        `<= ${filter.maxAmount.toString()}`,
        facts.outstandingAmount.toString(),
      ),
    );
  }
  if (filter.minTenorDays !== null) {
    results.push(
      rule('MIN_TENOR', facts.tenorDays >= filter.minTenorDays,
        `>= ${filter.minTenorDays} days`, `${facts.tenorDays} days`),
    );
  }
  if (filter.maxTenorDays !== null) {
    results.push(
      rule('MAX_TENOR', facts.tenorDays <= filter.maxTenorDays,
        `<= ${filter.maxTenorDays} days`, `${facts.tenorDays} days`),
    );
  }

  if (filter.minTrustScore !== null) {
    // An unscored listing does NOT fail a trust-score rule. This is INV-9's
    // shape again one layer out: "we have no score yet" is an absence, and
    // excluding the bank on that basis would penalise the supplier for the
    // platform's own gap. The bank sees it and applies its own judgement.
    results.push(
      rule(
        'MIN_TRUST_SCORE',
        facts.trustScore === null || facts.trustScore >= filter.minTrustScore,
        `>= ${filter.minTrustScore}`,
        facts.trustScore === null ? 'not yet scored' : String(facts.trustScore),
      ),
    );
  }
  if (filter.maxRiskBand !== null) {
    const limit = BAND_ORDER.indexOf(filter.maxRiskBand);
    const actual = facts.riskBand === null ? -1 : BAND_ORDER.indexOf(facts.riskBand);
    results.push(
      rule(
        'MAX_RISK_BAND',
        facts.riskBand === null || actual <= limit,
        `no worse than ${filter.maxRiskBand}`,
        facts.riskBand ?? 'not yet scored',
      ),
    );
  }

  if (filter.sectorsInclude?.length) {
    results.push(
      rule(
        'SECTOR_INCLUDED',
        facts.supplierSector !== null && filter.sectorsInclude.includes(facts.supplierSector),
        `one of ${filter.sectorsInclude.join(', ')}`,
        facts.supplierSector ?? 'unknown',
      ),
    );
  }
  if (filter.sectorsExclude?.length) {
    results.push(
      rule(
        'SECTOR_NOT_EXCLUDED',
        facts.supplierSector === null || !filter.sectorsExclude.includes(facts.supplierSector),
        `not one of ${filter.sectorsExclude.join(', ')}`,
        facts.supplierSector ?? 'unknown',
      ),
    );
  }
  if (filter.governoratesInclude?.length) {
    results.push(
      rule(
        'GOVERNORATE_INCLUDED',
        facts.supplierGovernorate !== null
          && filter.governoratesInclude.includes(facts.supplierGovernorate),
        `one of ${filter.governoratesInclude.join(', ')}`,
        facts.supplierGovernorate ?? 'unknown',
      ),
    );
  }

  if (filter.supplierExcludeIds?.length) {
    results.push(
      rule(
        'SUPPLIER_NOT_EXCLUDED',
        !filter.supplierExcludeIds.includes(facts.supplierOrgId),
        'supplier not on the bank’s exclusion list',
        filter.supplierExcludeIds.includes(facts.supplierOrgId) ? 'excluded' : 'not excluded',
      ),
    );
  }
  if (filter.buyerExcludeIds?.length && facts.buyerId) {
    results.push(
      rule(
        'BUYER_NOT_EXCLUDED',
        !filter.buyerExcludeIds.includes(facts.buyerId),
        'buyer not on the bank’s exclusion list',
        filter.buyerExcludeIds.includes(facts.buyerId) ? 'excluded' : 'not excluded',
      ),
    );
  }

  const failed = results.find((r) => !r.passed);
  return {
    status: failed ? 'NOT_ELIGIBLE' : 'ELIGIBLE',
    rulesApplied: results,
    reason: failed ? `${failed.rule}: required ${failed.expected}, listing has ${failed.actual}` : null,
  };
}

/**
 * A bank's overall eligibility across all its active filters.
 *
 * Filters are **disjunctive**: a bank with a "small invoices" filter and a
 * "large invoices" filter is eligible for either, which is what a bank means
 * by running two appetites. Requiring all filters to pass would make the
 * second filter strictly narrow the first, so adding an appetite would remove
 * listings — the opposite of what the operator intended.
 *
 * A bank with **no active filters is eligible for everything**. That is the
 * honest reading of "I have declared no restrictions", and it makes the demo
 * path work without every bank first configuring a filter. It is recorded in
 * the trace as `NO_FILTERS_CONFIGURED` so the decision is never mistaken for
 * a filter that happened to pass.
 */
export function evaluateBank(
  filters: readonly PolicyFilter[],
  facts: ListingFacts,
): EligibilityDecision {
  const active = filters.filter((f) => f.isActive);

  if (active.length === 0) {
    return {
      status: 'ELIGIBLE',
      rulesApplied: [
        rule('NO_FILTERS_CONFIGURED', true, 'no declared restrictions', 'none configured'),
      ],
      reason: null,
    };
  }

  const decisions = active.map((filter) => ({ filter, decision: evaluateFilter(filter, facts) }));
  const passing = decisions.find((d) => d.decision.status === 'ELIGIBLE');

  // The trace records every filter that ran, tagged by filter, so an operator
  // can see which appetite admitted the listing and which did not.
  const rulesApplied = decisions.flatMap(({ filter, decision }) =>
    decision.rulesApplied.map((r) => ({ ...r, rule: `${filter.name}/${r.rule}` })),
  );

  if (passing) {
    return { status: 'ELIGIBLE', rulesApplied, reason: null };
  }
  return {
    status: 'NOT_ELIGIBLE',
    rulesApplied,
    reason: decisions.map((d) => `${d.filter.name} — ${d.decision.reason}`).join('; '),
  };
}
