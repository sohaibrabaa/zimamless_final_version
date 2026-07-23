import {
  BLOCK_CODES,
  INFO_CODES,
  POSITIVE_CODES,
  RISK_CODES,
} from './reason-codes';
import type { Maybe, RiskFacts } from './facts';

/**
 * The scoring engine: five components, a composite, a band, and — computed
 * on a separate track that shares no arithmetic with any of them —
 * `dataAvailabilityPct`.
 *
 * ## How INV-9 is enforced, mechanically
 *
 * A component is a list of weighted signals. Each signal is either
 * **evaluated** (we had the fact; it scored somewhere in 0..1) or
 * **unavailable** (we did not have the fact).
 *
 *     score = 100 × Σ(weight × points over EVALUATED) / Σ(weight over EVALUATED)
 *
 * The denominator is the evaluated weight, not the total weight. An
 * unavailable signal is removed from *both* sides of the division, so it is
 * arithmetically incapable of moving the result — not merely unlikely to.
 * Scoring an unavailable signal as zero would have kept it in the denominator
 * and quietly penalised the supplier for a registry outage, which is exactly
 * the defect ZM-RSK-005 names.
 *
 * Availability is then the ratio the score deliberately discards:
 *
 *     dataAvailabilityPct = 100 × Σ(weight over EVALUATED) / Σ(weight over ALL)
 *
 * The two numbers are computed from the same signal list by two functions
 * that share no code path, and the INV-9 paired-fixture test asserts the
 * property directly: identical facts, one with sources available and one
 * without, must produce **identical components** and a **lower availability**.
 *
 * Floating-point arithmetic is used freely here. That is not a violation of
 * hard rule 2 — these are dimensionless 0..100 indicators, not money. No
 * value produced by this file is ever added to, subtracted from, or compared
 * against a JOD amount.
 */

export type ComponentKey =
  | 'supplierVerification'
  | 'dataConfidence'
  | 'buyerProfile'
  | 'invoiceScore'
  | 'platformBehavior';

export const COMPONENT_KEYS: readonly ComponentKey[] = [
  'supplierVerification',
  'dataConfidence',
  'buyerProfile',
  'invoiceScore',
  'platformBehavior',
];

export interface EvaluatedSignal {
  readonly kind: 'EVALUATED';
  readonly key: string;
  readonly weight: number;
  /** 0 = worst observed, 1 = best observed. */
  readonly points: number;
  readonly codes: readonly string[];
}

export interface UnavailableSignal {
  readonly kind: 'UNAVAILABLE';
  readonly key: string;
  readonly weight: number;
  /** Always INFO_* — see `reason-codes.ts`. */
  readonly codes: readonly string[];
}

export type Signal = EvaluatedSignal | UnavailableSignal;

export function scored(
  key: string,
  weight: number,
  points: number,
  ...codes: string[]
): EvaluatedSignal {
  return { kind: 'EVALUATED', key, weight, points: clamp01(points), codes };
}

export function missing(key: string, weight: number, ...codes: string[]): UnavailableSignal {
  return { kind: 'UNAVAILABLE', key, weight, codes };
}

/**
 * Scores a `Maybe` in one step, so a caller cannot forget the unavailable
 * branch. `NOT_PUBLISHED` and `SOURCE_UNAVAILABLE` produce different INFO
 * codes because ZM-RSK-008 requires the distinction to survive to the UI —
 * "the registry does not publish this" and "the registry was down" are
 * different things to tell a banker.
 */
export function fromMaybe<T>(
  key: string,
  weight: number,
  fact: Maybe<T>,
  evaluate: (value: T) => { points: number; codes?: string[] },
): Signal {
  if (!fact.available) {
    return missing(
      key,
      weight,
      fact.reason === 'NOT_PUBLISHED'
        ? INFO_CODES.FIELD_NOT_PUBLISHED
        : INFO_CODES.GOVERNMENT_SOURCE_UNAVAILABLE,
    );
  }
  const { points, codes = [] } = evaluate(fact.value);
  return scored(key, weight, points, ...codes);
}

export interface ComponentResult {
  readonly key: ComponentKey;
  /** null when no signal in this component could be evaluated at all. */
  readonly score: number | null;
  readonly signals: readonly Signal[];
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Rounds a dimensionless indicator to a whole number.
 *
 * The repo bans `Math.round` because it is float rounding and money must
 * round half-up at 3 dp through `Money.round()`. That rule is right, and it
 * does not apply here: these are 0..100 indicators, not amounts. Nothing this
 * function returns is ever added to, compared against, or displayed as a JOD
 * value — the contract types every component and the composite as `integer`.
 *
 * Concentrated in one place with one suppression so the exemption is stated
 * once and reviewed once, rather than sprinkled as four inline disables that
 * each look like someone dodging the rule.
 */
function roundScore(n: number): number {
  // eslint-disable-next-line no-restricted-properties
  return Math.round(n);
}

/** The numerator/denominator rule described in the header comment. */
export function scoreComponent(key: ComponentKey, signals: readonly Signal[]): ComponentResult {
  let weighted = 0;
  let evaluatedWeight = 0;
  for (const signal of signals) {
    if (signal.kind !== 'EVALUATED') continue;
    weighted += signal.weight * signal.points;
    evaluatedWeight += signal.weight;
  }
  const score = evaluatedWeight === 0 ? null : roundScore((100 * weighted) / evaluatedWeight);
  return { key, score, signals };
}

/**
 * The availability track.
 *
 * Deliberately a separate function over the same signals, rather than a
 * second return value from `scoreComponent`. Keeping them apart is what lets
 * the INV-9 test assert that one moved and the other did not.
 */
export function dataAvailabilityPct(components: readonly ComponentResult[]): number {
  let total = 0;
  let evaluated = 0;
  for (const component of components) {
    for (const signal of component.signals) {
      total += signal.weight;
      if (signal.kind === 'EVALUATED') evaluated += signal.weight;
    }
  }
  if (total === 0) return 100;
  return roundScore((10000 * evaluated) / total) / 100;
}

// =====================================================================
// The five components (ZM-RSK-004)
// =====================================================================

export function supplierVerification(facts: RiskFacts): ComponentResult {
  const s = facts.supplier;
  const signals: Signal[] = [
    // From our own tables, so always evaluable.
    scored(
      'supplier.status',
      3,
      s.status === 'ACTIVE' ? 1 : 0,
      ...(s.status === 'ACTIVE' ? [POSITIVE_CODES.SUPPLIER_FULLY_VERIFIED] : []),
    ),
    fromMaybe('supplier.registryStatus', 3, s.registryStatus, (status) =>
      status === 'ACTIVE'
        ? { points: 1, codes: [POSITIVE_CODES.GOVERNMENT_VERIFIED] }
        : { points: 0 },
    ),
    fromMaybe('supplier.bankAccountVerified', 2, s.bankAccountVerified, (ok) => ({
      points: ok ? 1 : 0,
    })),
    fromMaybe('supplier.signatoryMatches', 2, s.signatoryMatches, (ok) => ({ points: ok ? 1 : 0 })),
    fromMaybe('supplier.taxStatusValid', 2, s.taxStatusValid, (ok) => ({ points: ok ? 1 : 0 })),
  ];
  return scoreComponent('supplierVerification', signals);
}

/**
 * Data confidence measures the STRENGTH of the sources behind the facts we
 * hold — not how many facts we hold. The count is availability's job.
 *
 * The difference matters: a supplier with two government-verified fields is
 * more confidently known than one with ten self-declared fields, and would
 * score higher here while scoring lower on availability. Merging the two
 * would hide that.
 */
export function dataConfidence(facts: RiskFacts): ComponentResult {
  const provenance = facts.supplier.provenance;
  const signals: Signal[] = [];

  if (provenance.length === 0) {
    signals.push(missing('data.provenance', 4, INFO_CODES.GOVERNMENT_SOURCE_UNAVAILABLE));
    signals.push(missing('data.freshness', 2, INFO_CODES.GOVERNMENT_SOURCE_UNAVAILABLE));
  } else {
    const governmentBacked = provenance.filter((p) => p.sourceKind === 'GOVERNMENT').length;
    signals.push(
      scored(
        'data.provenance',
        4,
        governmentBacked / provenance.length,
        ...(governmentBacked === provenance.length ? [POSITIVE_CODES.GOVERNMENT_VERIFIED] : []),
      ),
    );

    // Freshness decays linearly to zero at 180 days.
    const oldest = Math.max(...provenance.map((p) => p.ageDays));
    signals.push(
      scored(
        'data.freshness',
        2,
        1 - Math.min(oldest, 180) / 180,
        ...(oldest > 90 ? [RISK_CODES.STALE_GOVERNMENT_SNAPSHOT] : []),
      ),
    );
  }

  return scoreComponent('dataConfidence', signals);
}

export function buyerProfile(facts: RiskFacts): ComponentResult {
  const b = facts.buyer;
  const signals: Signal[] = [
    fromMaybe('buyer.registryStatus', 4, b.registryStatus, (status) => {
      if (status === 'ACTIVE') {
        return { points: 1, codes: [POSITIVE_CODES.BUYER_ACTIVE_REGISTRY] };
      }
      if (status === 'UNDER_LIQUIDATION') {
        return { points: 0, codes: [RISK_CODES.BUYER_UNDER_LIQUIDATION] };
      }
      // SUSPENDED / STRUCK_OFF are hard blockers handled by the rules engine;
      // they are scored at zero here as well so the component is honest even
      // when read on its own.
      return { points: 0, codes: [RISK_CODES.BUYER_NOT_IN_REGISTRY] };
    }),
    fromMaybe('buyer.companyAge', 2, b.companyAgeYears, (years) => ({
      points: Math.min(years, 10) / 10,
    })),
    fromMaybe('buyer.relationship', 2, b.priorTransactionsWithSupplier, (count) => ({
      points: Math.min(count, 10) / 10,
      codes:
        count >= 5
          ? [POSITIVE_CODES.ESTABLISHED_RELATIONSHIP]
          : count === 0
            ? [RISK_CODES.NEW_BUYER_RELATIONSHIP]
            : [],
    })),
    fromMaybe('buyer.paymentHistory', 3, b.onTimePaymentRatio, (ratio) => ({
      points: ratio,
      codes: ratio >= 0.9 ? [POSITIVE_CODES.BUYER_PAYMENT_HISTORY] : [],
    })),
  ];
  return scoreComponent('buyerProfile', signals);
}

export function invoiceScore(facts: RiskFacts): ComponentResult {
  const i = facts.invoice;
  const signals: Signal[] = [
    fromMaybe('invoice.completeness', 3, i.completenessRatio, (ratio) => ({ points: ratio })),
    scored(
      'invoice.uniqueness',
      4,
      i.duplicateCollision ? 0 : 1,
      ...(i.duplicateCollision ? [BLOCK_CODES.DUPLICATE_INVOICE] : []),
    ),
    scored(
      'invoice.evidence',
      3,
      i.electronicInvoiceAttached ? 1 : 0,
      ...(i.electronicInvoiceAttached ? [] : [BLOCK_CODES.NO_ELECTRONIC_INVOICE]),
    ),
    fromMaybe('invoice.fileIntegrity', 4, i.fileIntegrityOk, (ok) => ({
      points: ok ? 1 : 0,
      codes: ok ? [] : [BLOCK_CODES.FILE_INTEGRITY_FAILED],
    })),
    fromMaybe('invoice.ocrConsistency', 2, i.ocrConsistent, (ok) => ({
      points: ok ? 1 : 0,
      codes: ok ? [POSITIVE_CODES.OCR_MATCHES_ENTRY] : [RISK_CODES.OCR_MISMATCH],
    })),
    fromMaybe('invoice.qr', 2, i.qrStatus, (status) => {
      // UNAVAILABLE means the document carries no QR code at all, which is
      // normal for a paper-origin invoice and is not adverse. It is scored
      // neutrally rather than dropped, because we DID look — the absence is
      // an observation about the document, not a gap in our information.
      if (status === 'VALID') return { points: 1, codes: [POSITIVE_CODES.EINVOICE_QR_VALID] };
      if (status === 'UNAVAILABLE') return { points: 0.5 };
      if (status === 'UNPARSED') return { points: 0.4, codes: [RISK_CODES.QR_UNPARSED] };
      return { points: 0, codes: [RISK_CODES.QR_INVALID] };
    }),
    fromMaybe('invoice.tenor', 2, i.tenorDays, (days) => {
      if (days < i.minTenorDays) return { points: 0, codes: [RISK_CODES.SHORT_TENOR] };
      if (days > 180) return { points: 0.4, codes: [RISK_CODES.LONG_TENOR] };
      if (days > 120) return { points: 0.7 };
      return { points: 1 };
    }),
    scored(
      'invoice.paidStatus',
      1,
      i.partiallyPaid ? 0.5 : 1,
      ...(i.partiallyPaid ? [RISK_CODES.PARTIAL_PAYMENT_RECORDED] : []),
    ),
  ];
  return scoreComponent('invoiceScore', signals);
}

export function platformBehavior(facts: RiskFacts): ComponentResult {
  const p = facts.platform;
  const clean =
    p.disputeCount === 0 && p.duplicateReferralCount === 0 && p.recourseCount === 0;

  const signals: Signal[] = [
    // Every signal here reads our own tables, so none can be unavailable.
    // A supplier with no history is NOT penalised into the ground: a first
    // invoice scores mid-range, because "new" is not "bad".
    scored(
      'platform.history',
      2,
      Math.min(p.priorSubmittedCount, 5) / 5 * 0.5 + 0.5,
      ...(p.priorSubmittedCount === 0 ? [RISK_CODES.NO_PLATFORM_HISTORY] : []),
    ),
    scored(
      'platform.disputes',
      3,
      p.disputeCount === 0 ? 1 : Math.max(0, 1 - p.disputeCount / 3),
      ...(p.disputeCount > 0 ? [RISK_CODES.PRIOR_DISPUTE] : []),
    ),
    scored(
      'platform.duplicates',
      3,
      p.duplicateReferralCount === 0 ? 1 : Math.max(0, 1 - p.duplicateReferralCount / 2),
      ...(p.duplicateReferralCount > 0 ? [RISK_CODES.PRIOR_DUPLICATE_REFERRAL] : []),
    ),
    scored(
      'platform.recourse',
      2,
      p.recourseCount === 0 ? 1 : Math.max(0, 1 - p.recourseCount / 2),
      ...(p.recourseCount > 0 ? [RISK_CODES.PRIOR_RECOURSE] : []),
    ),
    ...(clean ? [scored('platform.clean', 1, 1, POSITIVE_CODES.CLEAN_PLATFORM_RECORD)] : []),
  ];
  return scoreComponent('platformBehavior', signals);
}

export function allComponents(facts: RiskFacts): ComponentResult[] {
  return [
    supplierVerification(facts),
    dataConfidence(facts),
    buyerProfile(facts),
    invoiceScore(facts),
    platformBehavior(facts),
  ];
}

// =====================================================================
// Composite and band
// =====================================================================

export type ComponentWeights = Readonly<Record<ComponentKey, number>>;

export const DEFAULT_WEIGHTS: ComponentWeights = {
  supplierVerification: 0.2,
  dataConfidence: 0.15,
  buyerProfile: 0.25,
  invoiceScore: 0.3,
  platformBehavior: 0.1,
};

/**
 * Weighted mean over components that produced a score.
 *
 * Renormalised over the components actually present, for the same reason the
 * component itself renormalises over evaluated signals: a component that
 * could not be scored must not drag the composite toward zero.
 */
export function compositeOf(
  components: readonly ComponentResult[],
  weights: ComponentWeights,
): number {
  let weighted = 0;
  let totalWeight = 0;
  for (const component of components) {
    if (component.score === null) continue;
    const weight = weights[component.key] ?? 0;
    weighted += weight * component.score;
    totalWeight += weight;
  }
  if (totalWeight === 0) return 0;
  return roundScore(weighted / totalWeight);
}

/**
 * The share of the composite the trained model is allowed to move.
 *
 * Deliberately a minority. The model is trained on synthetic data
 * (ZM-RSK-016) and its predictive validity on real Jordanian receivables is
 * unestablished, so letting it dominate a score a bank might rely on would
 * overstate what it knows. The rules carry the decision; the model adjusts it.
 */
export const DEFAULT_ML_WEIGHT = 0.25;

/**
 * Folds the model's risk probability into the rules composite.
 *
 * The model speaks in P(goes bad) and the score speaks in trust, so the
 * probability is inverted before blending. Applied BEFORE `capForBlockers` —
 * that ordering is what makes ZM-RSK-015 hold: whatever this returns, a hard
 * blocker still forces the final score under the CRITICAL threshold.
 */
export function blendWithModel(
  rulesComposite: number,
  riskProbability: number,
  mlWeight: number = DEFAULT_ML_WEIGHT,
): number {
  const weight = Math.min(1, Math.max(0, mlWeight));
  const modelScore = 100 * (1 - clamp01(riskProbability));
  return roundScore((1 - weight) * rulesComposite + weight * modelScore);
}

export type RiskBand = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface BandThresholds {
  readonly LOW: number;
  readonly MEDIUM: number;
  readonly HIGH: number;
}

/** AS-05: LOW ≥ 75, MEDIUM 50–74, HIGH 25–49, CRITICAL < 25. */
export const DEFAULT_BAND_THRESHOLDS: BandThresholds = { LOW: 75, MEDIUM: 50, HIGH: 25 };

export function bandOf(score: number, thresholds: BandThresholds = DEFAULT_BAND_THRESHOLDS): RiskBand {
  if (score >= thresholds.LOW) return 'LOW';
  if (score >= thresholds.MEDIUM) return 'MEDIUM';
  if (score >= thresholds.HIGH) return 'HIGH';
  return 'CRITICAL';
}

/**
 * Splits the codes a scoring pass accumulated into the three lists the
 * contract exposes.
 *
 * INFO codes are reported but are, by construction, attached only to
 * UNAVAILABLE signals — so their presence in `riskFactors` would be a
 * category error. They travel in their own list.
 */
export function collectCodes(components: readonly ComponentResult[]): {
  positiveFactors: string[];
  riskFactors: string[];
  infoFactors: string[];
} {
  const positive = new Set<string>();
  const risk = new Set<string>();
  const info = new Set<string>();

  for (const component of components) {
    for (const signal of component.signals) {
      for (const code of signal.codes) {
        if (code.startsWith('POS_')) positive.add(code);
        else if (code.startsWith('INFO_')) info.add(code);
        else risk.add(code);
      }
    }
  }
  return {
    positiveFactors: [...positive].sort(),
    riskFactors: [...risk].sort(),
    infoFactors: [...info].sort(),
  };
}
